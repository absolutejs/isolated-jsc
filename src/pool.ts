/**
 * `createIsolatePool` — a lazy, keyed pool of {@link Isolate}s.
 *
 * Use it when many independent workloads each want their own isolate (one per
 * tenant, per conversation, per session, per sandboxed-mutation name, …) and
 * you'd rather not roll the lifecycle yourself. The pool spawns lazily on
 * first use of a key, reuses across subsequent calls to the same key, evicts
 * idle keys when the size cap fills, recycles after a configured call count
 * to bound JSC heap creep, and survives isolate self-termination (timeout /
 * memory) by re-spawning transparently on the next call.
 *
 * Two callers already need this:
 *
 *   - `@absolutejs/sync`'s `sandboxedHandler` — one isolate per mutation name.
 *   - The future `@absolutejs/ai` `codeExecutionTool` — one isolate per
 *     conversation, so successive turns reuse JIT'd code + warm references.
 *
 * Both used to roll their own lazy-spawn-by-key map. This factors the pattern.
 */

import { createIsolate } from "./isolate";
import type { Isolate, IsolateOptions } from "./types";

export type IsolatePoolOptions = {
  /**
   * Per-isolate options passed to {@link createIsolate}. Same for every key
   * — a pool is "many isolates with the same shape." Use multiple pools
   * if you need different shapes (different memoryLimit / harden / etc).
   */
  isolate?: IsolateOptions;
  /**
   * Max number of distinct keys held at once. When the cap is full and a
   * new key arrives, the least-recently-used idle key is evicted (its
   * isolate is disposed). Default 32.
   */
  maxSize?: number;
  /**
   * If a key isn't used for this long, the pool disposes its isolate and
   * forgets the key. Default 60_000 ms. Set to `0` to disable idle
   * eviction (only the LRU cap recycles in that mode).
   */
  idleMs?: number;
  /**
   * Recycle an isolate after this many `run()` calls — dispose + respawn
   * on the next call. Bounds the per-context heap creep we documented in
   * sync's `sandbox.ts` (~2 MB residual per call). Default `Infinity`
   * (no recycle).
   */
  recycleAfter?: number;
  /**
   * Background sweep interval for idle eviction. Default 5000 ms. The
   * sweep only runs when the pool is non-empty.
   */
  sweepIntervalMs?: number;
};

/**
 * Operator-shaped metrics surfaced by {@link IsolatePool.metrics} (0.10.0+).
 * Counters + point-in-time fields a PaaS host scrapes on an interval to
 * attribute per-tenant cost and detect a runaway.
 */
export type IsolatePoolMetrics = {
  /** Date.now() when this snapshot was taken. */
  at: number;
  /** Active cached keys right now. */
  size: number;
  /** Active runs that haven't returned yet (sum of `inFlight` across entries). */
  inFlight: number;
  /** Cumulative spawns (first-use + post-recycle respawn) since pool start. */
  spawns: number;
  /** Cumulative idle-window evictions since pool start. */
  idleEvictions: number;
  /** Cumulative LRU evictions since pool start. */
  lruEvictions: number;
  /** Cumulative recycles since pool start (`run()` counts crossing `recycleAfter`). */
  recycles: number;
  /** True when the pool is draining (refusing new keys). */
  draining: boolean;
};

/** A keyed pool of isolates. */
export type IsolatePool = {
  /**
   * Get the isolate for `key`, run `fn` with it, and return whatever `fn`
   * returns. Spawns on first use of the key; subsequent calls to the same
   * key reuse the same isolate. Concurrent `run` calls to the same key
   * share the isolate but each gets its own Context (the body of `fn`
   * controls that).
   *
   * If the isolate self-terminated since the last call (timeout / memory),
   * the pool transparently respawns before invoking `fn`.
   */
  run: <R>(key: string, fn: (isolate: Isolate) => Promise<R>) => Promise<R>;
  /** Approximate active size — number of cached keys. */
  size: () => number;
  /**
   * Operator-shaped metrics — point-in-time + cumulative counters since
   * pool start. What a PaaS host scrapes for cost attribution. Added in
   * 0.10.0.
   */
  metrics: () => IsolatePoolMetrics;
  /**
   * Begin draining: refuse `run` on new keys (existing cached keys keep
   * working). For graceful shard shutdown — wait for `size()` to reach 0
   * then call `dispose()`. Added in 0.10.0.
   */
  drain: () => void;
  /** Dispose every isolate and stop the sweep. Idempotent. */
  dispose: () => Promise<void>;
};

type Entry = {
  /** A promise so concurrent `run`s share one spawn instead of racing. */
  isolate: Promise<Isolate>;
  lastUsed: number;
  callCount: number;
  inFlight: number;
  recycle: boolean;
};

export const createIsolatePool = (
  options: IsolatePoolOptions = {},
): IsolatePool => {
  const isolateOptions = options.isolate ?? {};
  const maxSize = options.maxSize ?? 32;
  const idleMs = options.idleMs ?? 60_000;
  const recycleAfter = options.recycleAfter ?? Infinity;
  const sweepIntervalMs = options.sweepIntervalMs ?? 5_000;

  const entries = new Map<string, Entry>();
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  // 0.10.0 counters surfaced via metrics().
  let spawnsTotal = 0;
  let idleEvictionsTotal = 0;
  let lruEvictionsTotal = 0;
  let recyclesTotal = 0;
  let draining = false;

  const startSweepIfNeeded = (): void => {
    if (sweepTimer !== undefined || disposed) return;
    if (idleMs <= 0) return;
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of entries) {
        if (entry.inFlight > 0) continue;
        if (now - entry.lastUsed >= idleMs) {
          idleEvictionsTotal += 1;
          void disposeEntry(key, entry);
        }
      }
      if (entries.size === 0 && sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
    }, sweepIntervalMs);
    // Don't keep the host process alive solely for the sweep.
    if (typeof sweepTimer === "object" && sweepTimer !== null) {
      (sweepTimer as { unref?: () => void }).unref?.();
    }
  };

  const disposeEntry = async (key: string, entry: Entry): Promise<void> => {
    entries.delete(key);
    try {
      const isolate = await entry.isolate;
      await isolate.dispose();
    } catch {
      // Spawn failed or already disposed; either way, drop quietly.
    }
  };

  /** Drop the LRU idle entry to make room. Synchronous; the actual isolate
   * dispose is fire-and-forget (we only need the Map slot reclaimed). */
  const evictLruSyncIfNeeded = (): void => {
    if (entries.size < maxSize) return;
    let oldestKey: string | undefined;
    let oldestEntry: Entry | undefined;
    for (const [key, entry] of entries) {
      if (entry.inFlight > 0) continue;
      if (oldestEntry === undefined || entry.lastUsed < oldestEntry.lastUsed) {
        oldestKey = key;
        oldestEntry = entry;
      }
    }
    if (oldestKey !== undefined && oldestEntry !== undefined) {
      lruEvictionsTotal += 1;
      void disposeEntry(oldestKey, oldestEntry);
    }
    // If every entry is in-flight, the new acquire fails open: we exceed
    // maxSize temporarily. Better than blocking the caller; the next sweep
    // + next acquire restore the cap.
  };

  /** Synchronous lookup-or-insert. No awaits between `entries.get` and
   * `entries.set`, so concurrent callers can't both spawn — they all find
   * the same entry and await its `isolate` Promise. Isolate liveness is
   * re-checked inside `run()` after the await; if the isolate self-died
   * since insertion, we recurse. */
  const getOrCreateSync = (key: string): Entry => {
    const existing = entries.get(key);
    if (existing !== undefined) return existing;
    // 0.10.0: drain refuses NEW keys; cached ones keep working.
    if (draining) {
      throw new Error("isolate pool is draining; refused new key");
    }
    evictLruSyncIfNeeded();
    spawnsTotal += 1;
    const fresh: Entry = {
      isolate: createIsolate(isolateOptions),
      lastUsed: Date.now(),
      callCount: 0,
      inFlight: 0,
      recycle: false,
    };
    entries.set(key, fresh);
    startSweepIfNeeded();
    return fresh;
  };

  return {
    async run<R>(
      key: string,
      fn: (isolate: Isolate) => Promise<R>,
    ): Promise<R> {
      if (disposed) throw new Error("isolate pool has been disposed");
      // Sync insert so concurrent callers share one spawn.
      let entry = getOrCreateSync(key);
      entry.lastUsed = Date.now();
      entry.inFlight += 1;
      let isolate: Isolate;
      try {
        isolate = await entry.isolate;
      } catch (error) {
        entry.inFlight -= 1;
        entries.delete(key);
        throw error;
      }
      if (isolate.isDisposed) {
        // The isolate died between insertion and now (e.g. memory cap fired
        // in another concurrent call). Drop + retry once.
        entry.inFlight -= 1;
        entries.delete(key);
        return this.run(key, fn);
      }
      try {
        return await fn(isolate);
      } finally {
        entry.inFlight -= 1;
        entry.callCount += 1;
        entry.lastUsed = Date.now();
        if (entry.callCount >= recycleAfter || isolate.isDisposed) {
          entry.recycle = true;
        }
        if (entry.recycle && entry.inFlight === 0) {
          recyclesTotal += 1;
          void disposeEntry(key, entry);
        }
      }
    },
    size: () => entries.size,
    metrics: (): IsolatePoolMetrics => {
      let inFlight = 0;
      for (const entry of entries.values()) inFlight += entry.inFlight;
      return {
        at: Date.now(),
        draining,
        idleEvictions: idleEvictionsTotal,
        inFlight,
        lruEvictions: lruEvictionsTotal,
        recycles: recyclesTotal,
        size: entries.size,
        spawns: spawnsTotal,
      };
    },
    drain: () => {
      draining = true;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
      const snapshot = [...entries];
      entries.clear();
      await Promise.all(
        snapshot.map(async ([, entry]) => {
          try {
            const isolate = await entry.isolate;
            await isolate.dispose();
          } catch {
            // ignore
          }
        }),
      );
    },
  };
};
