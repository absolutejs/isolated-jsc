/**
 * `createHibernatingIsolatePool` — a keyed pool of isolate+context pairs that
 * can hibernate when idle and wake transparently on the next call.
 *
 * Built on top of {@link createIsolate} and the data-checkpoint primitives
 * shipped in 0.8.19+ (`context.checkpoint()` /
 * `isolate.createContext({ checkpoint })`). This is NOT a JavaScriptCore heap
 * pause/resume image — `SNAPSHOT_RESEARCH.md` says the public JSC C API
 * doesn't expose that primitive. Hibernation here is "serialize the data half,
 * drop the isolate, restore on next call." The seed code half is supplied by
 * the caller's `fn` (the same way the existing pool's `run(fn)` builds its
 * context).
 *
 * Compared to {@link createIsolatePool}:
 *
 *   - The shared resource here is a `Context`, not an `Isolate`. The pool
 *     manages context lifecycle so it can checkpoint + restore in one
 *     atomic operation.
 *   - When an active entry's idle clock exceeds `hibernateAfterMs`, the
 *     entry is hibernated: the context is checkpointed via
 *     `context.checkpoint()`, the checkpoint is stored, and the isolate is
 *     disposed. The entry slot stays in the pool so subsequent runs find
 *     it and wake.
 *   - When the next `run(key, fn)` lands on a hibernated entry, the pool
 *     creates a fresh isolate, calls
 *     `isolate.createContext({ checkpoint })` to seed it with the
 *     hibernated data, then runs `fn(context)`.
 *
 * This is the SB-7 substrate for the eventual {@link SB-6} hosted Cloud:
 * far more "tenant logical contexts" than physical isolates, because the
 * warm ones get serialized down to bytes when no one's calling them.
 *
 * @example
 * ```ts
 * const pool = createHibernatingIsolatePool({
 *   isolate: { backend: 'worker' },
 *   maxSize: 1000,            // up to 1000 (active OR hibernated) keys total
 *   hibernateAfterMs: 30_000, // idle 30s → hibernate
 * });
 *
 * const counter = await pool.run('tenant-42', async (context) => {
 *   const fn = await context.compileCallable(\`(args) => {
 *     this.count = (this.count || 0) + args.delta;
 *     return this.count;
 *   }\`);
 *   return await fn.call([{ delta: 1 }]);
 * });
 *
 * // Wait long enough for the sweeper to hibernate it ...
 * // The next run wakes the context with `count` restored from the checkpoint:
 * const next = await pool.run('tenant-42', async (context) => {
 *   const fn = await context.compileCallable(\`(args) => this.count + args.delta\`);
 *   return await fn.call([{ delta: 1 }]);
 * });
 * ```
 */

import { createIsolate } from "./isolate";
import type {
  Context,
  ContextCheckpoint,
  ContextCheckpointOptions,
  Isolate,
  IsolateOptions,
} from "./types";

/**
 * Pluggable storage for hibernated context checkpoints. The default
 * implementation is in-memory (one process). Pass a custom store for
 * persistent / shared hibernation (Redis, S3, local file cache, etc.).
 */
export type HibernationStore = {
  get: (
    key: string,
  ) => Promise<ContextCheckpoint | undefined> | ContextCheckpoint | undefined;
  put: (
    key: string,
    checkpoint: ContextCheckpoint,
  ) => Promise<void> | void;
  delete: (key: string) => Promise<void> | void;
};

/** Default in-memory hibernation store (one process). */
export const createInMemoryHibernationStore = (): HibernationStore => {
  const map = new Map<string, ContextCheckpoint>();
  return {
    delete: (key) => {
      map.delete(key);
    },
    get: (key) => map.get(key),
    put: (key, checkpoint) => {
      map.set(key, checkpoint);
    },
  };
};

export type HibernatingIsolatePoolOptions = {
  /** Per-isolate options passed to {@link createIsolate}. */
  isolate?: IsolateOptions;
  /**
   * Max total entries (active + hibernated). When exceeded, LRU entries
   * are dropped — hibernated checkpoints first, then active contexts.
   * Default 100.
   */
  maxSize?: number;
  /**
   * Auto-hibernate an active entry that's been idle for this many ms.
   * Set to `0` to disable auto-hibernation (only explicit
   * `pool.hibernate(key)` and the LRU evictor will hibernate then).
   * Default 60_000 (1 minute).
   */
  hibernateAfterMs?: number;
  /**
   * Background sweep interval. Default 5_000 ms. Sweeps run only when
   * the pool is non-empty and are unrefed so they don't keep the
   * process alive.
   */
  sweepIntervalMs?: number;
  /** Pluggable storage. Default in-memory (one process). */
  hibernationStore?: HibernationStore;
  /** Options forwarded to `context.checkpoint(options)` on hibernation. */
  checkpointOptions?: ContextCheckpointOptions;
  /**
   * Optional hook called whenever an entry's state changes. Useful for
   * observability — e.g. log every hibernate/wake to a metrics sink.
   * Errors thrown by the hook are caught + ignored.
   */
  onTransition?: (event: HibernationEvent) => void;
};

export type HibernationEvent =
  | { type: "wake"; key: string; from: "hibernated" }
  | { type: "hibernate"; key: string; byteLength: number }
  | { type: "evict"; key: string; from: "active" | "hibernated" };

export type HibernatingPoolStats = {
  active: number;
  hibernated: number;
  total: number;
};

export type HibernatingIsolatePool = {
  /**
   * Resolve the context for `key` (waking from a hibernated checkpoint if
   * needed, or spawning fresh if the key has never been seen) and run
   * `fn(context)` with it. Concurrent runs on the same key share the same
   * context via a wake-once promise.
   */
  run: <R>(key: string, fn: (context: Context) => Promise<R>) => Promise<R>;
  /**
   * Force-hibernate the entry for `key` now. No-op if the key is unknown,
   * already hibernated, or currently in-flight (we wait for inFlight to
   * settle before hibernating).
   */
  hibernate: (key: string) => Promise<void>;
  /** Snapshot of the pool's current state. */
  stats: () => HibernatingPoolStats;
  /** Dispose every active isolate. Does NOT delete hibernated checkpoints
   * from the store — those persist (so a shared store survives process
   * restart). To purge, pass a store whose `delete` clears state and
   * call it externally. */
  dispose: () => Promise<void>;
};

type ActiveEntry = {
  state: "active";
  isolate: Isolate;
  context: Context;
  lastUsed: number;
  inFlight: number;
  /**
   * Set while a hibernation is being applied to this entry. New `run`
   * callers should wait for this to clear before reading the context;
   * the entry will have transitioned to "hibernated" by then.
   */
  hibernating: Promise<void> | null;
};

type HibernatedEntry = {
  state: "hibernated";
  lastUsed: number;
  /**
   * Set while a wake is in flight. Concurrent `run` callers share the
   * single wake instead of racing to create N isolates.
   */
  waking: Promise<ActiveEntry> | null;
};

type Entry = ActiveEntry | HibernatedEntry;

export const createHibernatingIsolatePool = (
  options: HibernatingIsolatePoolOptions = {},
): HibernatingIsolatePool => {
  const isolateOptions = options.isolate ?? {};
  const maxSize = options.maxSize ?? 100;
  const hibernateAfterMs = options.hibernateAfterMs ?? 60_000;
  const sweepIntervalMs = options.sweepIntervalMs ?? 5_000;
  const store = options.hibernationStore ?? createInMemoryHibernationStore();
  const checkpointOptions = options.checkpointOptions;
  const onTransition = options.onTransition;

  const entries = new Map<string, Entry>();
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  const emit = (event: HibernationEvent): void => {
    if (onTransition === undefined) return;
    try {
      onTransition(event);
    } catch {
      // Hook errors are observational only; swallow.
    }
  };

  const stats = (): HibernatingPoolStats => {
    let active = 0;
    let hibernated = 0;
    for (const entry of entries.values()) {
      if (entry.state === "active") active += 1;
      else hibernated += 1;
    }
    return { active, hibernated, total: entries.size };
  };

  const evictLruIfNeeded = (): void => {
    if (entries.size < maxSize) return;
    // Prefer dropping hibernated entries (cheap; only the checkpoint) over
    // active ones (require dispose). Within each band, drop oldest.
    const hibernated: Array<[string, HibernatedEntry]> = [];
    const active: Array<[string, ActiveEntry]> = [];
    for (const [key, entry] of entries) {
      if (entry.state === "hibernated" && entry.waking === null) {
        hibernated.push([key, entry]);
      } else if (entry.state === "active" && entry.inFlight === 0) {
        active.push([key, entry]);
      }
    }
    hibernated.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    active.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const target = entries.size - (maxSize - 1);
    let evicted = 0;
    for (const [key] of hibernated) {
      if (evicted >= target) break;
      entries.delete(key);
      void Promise.resolve(store.delete(key)).catch(() => {});
      emit({ from: "hibernated", key, type: "evict" });
      evicted += 1;
    }
    for (const [key, entry] of active) {
      if (evicted >= target) break;
      entries.delete(key);
      void disposeActiveEntry(entry).catch(() => {});
      emit({ from: "active", key, type: "evict" });
      evicted += 1;
    }
  };

  const disposeActiveEntry = async (entry: ActiveEntry): Promise<void> => {
    try {
      await entry.context.dispose();
    } catch {
      /* ignore */
    }
    try {
      await entry.isolate.dispose();
    } catch {
      /* ignore */
    }
  };

  const hibernateActive = async (
    key: string,
    entry: ActiveEntry,
  ): Promise<void> => {
    // Capture checkpoint. If checkpoint throws (e.g. data not clone-able),
    // drop the entry entirely rather than pretending we hibernated.
    let checkpoint: ContextCheckpoint;
    try {
      checkpoint = await entry.context.checkpoint(checkpointOptions);
    } catch {
      entries.delete(key);
      await disposeActiveEntry(entry);
      emit({ from: "active", key, type: "evict" });
      return;
    }
    try {
      await store.put(key, checkpoint);
    } catch {
      // Storage failed — drop without leaving a half-hibernated marker.
      entries.delete(key);
      await disposeActiveEntry(entry);
      emit({ from: "active", key, type: "evict" });
      return;
    }
    await disposeActiveEntry(entry);
    const hibernated: HibernatedEntry = {
      lastUsed: entry.lastUsed,
      state: "hibernated",
      waking: null,
    };
    entries.set(key, hibernated);
    emit({ byteLength: checkpoint.byteLength, key, type: "hibernate" });
  };

  const startSweepIfNeeded = (): void => {
    if (sweepTimer !== undefined || disposed) return;
    if (hibernateAfterMs <= 0) return;
    sweepTimer = setInterval(() => {
      if (disposed) return;
      const now = Date.now();
      for (const [key, entry] of entries) {
        if (entry.state !== "active") continue;
        if (entry.inFlight > 0) continue;
        if (entry.hibernating !== null) continue;
        if (now - entry.lastUsed < hibernateAfterMs) continue;
        const promise = hibernateActive(key, entry);
        entry.hibernating = promise;
        promise.finally(() => {
          // Entry may have been replaced by a hibernated marker; clearing
          // the field on the old object is harmless either way.
          entry.hibernating = null;
        });
      }
      if (entries.size === 0 && sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
    }, sweepIntervalMs);
    if (typeof sweepTimer === "object" && sweepTimer !== null) {
      (sweepTimer as { unref?: () => void }).unref?.();
    }
  };

  const spawnFresh = async (
    key: string,
    claim: boolean,
  ): Promise<ActiveEntry> => {
    const isolate = await createIsolate(isolateOptions);
    const context = await isolate.createContext();
    const entry: ActiveEntry = {
      context,
      hibernating: null,
      // Claim before publishing — closes the race where a concurrent
      // hibernate() could see inFlight=0 and start hibernating the
      // context this call is about to use.
      inFlight: claim ? 1 : 0,
      isolate,
      lastUsed: Date.now(),
      state: "active",
    };
    entries.set(key, entry);
    startSweepIfNeeded();
    return entry;
  };

  const wakeFromHibernation = async (
    key: string,
    claim: boolean,
  ): Promise<ActiveEntry> => {
    const checkpoint = await store.get(key);
    if (checkpoint === undefined) {
      // The store lost the checkpoint between hibernate and wake. Treat
      // the key as fresh — better than throwing.
      return spawnFresh(key, claim);
    }
    const isolate = await createIsolate(isolateOptions);
    const context = await isolate.createContext({ checkpoint });
    const entry: ActiveEntry = {
      context,
      hibernating: null,
      inFlight: claim ? 1 : 0,
      isolate,
      lastUsed: Date.now(),
      state: "active",
    };
    entries.set(key, entry);
    emit({ from: "hibernated", key, type: "wake" });
    // The store keeps the checkpoint until next hibernate overwrites it
    // (cheap, and survives a crash mid-run if the store is persistent).
    startSweepIfNeeded();
    return entry;
  };

  /**
   * Resolve `key` to an active entry and ATOMICALLY increment its
   * `inFlight` counter before returning. Atomicity is what closes the
   * race where a concurrent `hibernate(key)` could see `inFlight === 0`
   * between this function resolving and the caller's first chance to
   * bump the counter.
   */
  const resolveAndClaim = async (key: string): Promise<ActiveEntry> => {
    if (disposed) throw new Error("hibernating isolate pool has been disposed");
    const existing = entries.get(key);
    if (existing === undefined) {
      evictLruIfNeeded();
      return spawnFresh(key, true);
    }
    if (existing.state === "active") {
      if (existing.hibernating !== null) {
        // Wait for the in-flight hibernation, then recurse — the entry
        // will be hibernated or evicted.
        await existing.hibernating.catch(() => {});
        return resolveAndClaim(key);
      }
      existing.inFlight += 1;
      return existing;
    }
    // Hibernated — single-flight wake. Each concurrent caller still needs
    // its own claim, so the shared waking promise resolves to the entry
    // and we bump on resolution.
    let promise: Promise<ActiveEntry>;
    if (existing.waking !== null) {
      promise = existing.waking;
    } else {
      promise = wakeFromHibernation(key, false);
      existing.waking = promise;
    }
    const entry = await promise;
    entry.inFlight += 1;
    return entry;
  };

  return {
    async run<R>(
      key: string,
      fn: (context: Context) => Promise<R>,
    ): Promise<R> {
      // resolveAndClaim atomically increments inFlight, so a concurrent
      // hibernate(key) cannot race in between resolution and our use of
      // the context.
      const entry = await resolveAndClaim(key);
      entry.lastUsed = Date.now();
      try {
        return await fn(entry.context);
      } finally {
        entry.inFlight -= 1;
        entry.lastUsed = Date.now();
      }
    },

    async hibernate(key) {
      const entry = entries.get(key);
      if (entry === undefined) return;
      if (entry.state === "hibernated") return;
      if (entry.hibernating !== null) {
        await entry.hibernating.catch(() => {});
        return;
      }
      // Wait until in-flight calls settle. We're racing them, not preempting.
      while (entry.inFlight > 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const promise = hibernateActive(key, entry);
      entry.hibernating = promise;
      try {
        await promise;
      } finally {
        entry.hibernating = null;
      }
    },

    stats,

    async dispose() {
      if (disposed) return;
      disposed = true;
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
      const snapshot = [...entries.values()];
      entries.clear();
      await Promise.all(
        snapshot.map(async (entry) => {
          if (entry.state === "active") {
            await disposeActiveEntry(entry);
          }
        }),
      );
    },
  };
};
