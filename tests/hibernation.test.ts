/**
 * `createHibernatingIsolatePool` — SB-7 substrate. The pool runs an
 * isolate+context pair per key, hibernates idle entries via
 * `context.checkpoint()`, and wakes them on the next call by passing the
 * checkpoint back through `isolate.createContext({ checkpoint })`. These
 * tests cover the happy path, single-flight wake, custom store routing,
 * stats accounting, LRU eviction, transition observability, and dispose.
 *
 * No real-clock dependencies — auto-hibernate is configured with a tiny
 * sweep interval and a small idle threshold so the suite stays fast.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  createHibernatingIsolatePool,
  createInMemoryHibernationStore,
  type ContextCheckpoint,
  type HibernatingIsolatePool,
  type HibernationEvent,
  type HibernationStore,
} from "../src";

const waitMs = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

let pool: HibernatingIsolatePool | null = null;
afterEach(async () => {
  await pool?.dispose();
  pool = null;
});

describe("createHibernatingIsolatePool", () => {
  test("spawns lazily on first use, runs fn(context), and reuses across calls", async () => {
    pool = createHibernatingIsolatePool({
      hibernateAfterMs: 0, // disable auto-hibernate for this test
    });
    expect(pool.stats()).toEqual({ active: 0, hibernated: 0, total: 0 });

    const first = await pool.run("tenant-a", async (context) => {
      const fn = await context.compileCallable(
        `(args) => {
          this.count = (this.count || 0) + args.delta;
          return this.count;
        }`,
      );
      return await fn.call([{ delta: 5 }]);
    });
    expect(first).toBe(5);
    expect(pool.stats()).toEqual({ active: 1, hibernated: 0, total: 1 });

    // Reuse — the context still has count=5 because we DIDN'T hibernate.
    const second = await pool.run("tenant-a", async (context) => {
      const fn = await context.compileCallable(
        `(args) => this.count + args.delta`,
      );
      return await fn.call([{ delta: 3 }]);
    });
    expect(second).toBe(8);
  });

  test("explicit hibernate captures state; next run restores it", async () => {
    pool = createHibernatingIsolatePool({ hibernateAfterMs: 0 });

    await pool.run("tenant-b", async (context) => {
      const fn = await context.compileCallable(
        `(args) => {
          this.score = args.value;
          this.label = args.label;
        }`,
      );
      await fn.call([{ label: "alpha", value: 42 }]);
    });
    expect(pool.stats()).toEqual({ active: 1, hibernated: 0, total: 1 });

    await pool.hibernate("tenant-b");
    expect(pool.stats()).toEqual({ active: 0, hibernated: 1, total: 1 });

    // Wake: read the values back without re-setting them.
    const result = await pool.run("tenant-b", async (context) => {
      const fn = await context.compileCallable(
        `() => ({ score: this.score, label: this.label })`,
      );
      return await fn.call([]);
    });
    expect(result).toEqual({ label: "alpha", score: 42 });
    expect(pool.stats()).toEqual({ active: 1, hibernated: 0, total: 1 });
  });

  test("auto-hibernate after the idle threshold elapses", async () => {
    pool = createHibernatingIsolatePool({
      hibernateAfterMs: 30,
      sweepIntervalMs: 15,
    });
    await pool.run("tenant-c", async (context) => {
      const fn = await context.compileCallable(`() => { this.x = 'hi' }`);
      await fn.call([]);
    });
    expect(pool.stats().active).toBe(1);

    // Wait for two sweeps + the idle window.
    await waitMs(80);
    expect(pool.stats()).toEqual({ active: 0, hibernated: 1, total: 1 });

    // The next call wakes — state must survive.
    const value = await pool.run("tenant-c", async (context) => {
      const fn = await context.compileCallable(`() => this.x`);
      return await fn.call([]);
    });
    expect(value).toBe("hi");
  });

  test("concurrent calls during wake share a single-flight resolve", async () => {
    pool = createHibernatingIsolatePool({ hibernateAfterMs: 0 });
    await pool.run("tenant-d", async (context) => {
      const fn = await context.compileCallable(`() => { this.n = 1 }`);
      await fn.call([]);
    });
    await pool.hibernate("tenant-d");
    expect(pool.stats().hibernated).toBe(1);

    // Two concurrent runs hitting the hibernated entry simultaneously
    // must NOT race-create two isolates. If they did, the entry's
    // increments wouldn't be coherent in the shared context. Each call
    // reads + writes the same `this.n` slot.
    const concurrent = await Promise.all([
      pool.run("tenant-d", async (context) => {
        const fn = await context.compileCallable(
          `(args) => { this.n += args.add; return this.n }`,
        );
        return await fn.call([{ add: 10 }]);
      }),
      pool.run("tenant-d", async (context) => {
        const fn = await context.compileCallable(
          `(args) => { this.n += args.add; return this.n }`,
        );
        return await fn.call([{ add: 100 }]);
      }),
    ]);
    // Both calls share the same context. Order isn't guaranteed but the
    // values must be 11 and 111 (or 101 and 111) — never 11 and 101.
    const sorted = [...concurrent].sort((a, b) => Number(a) - Number(b));
    expect(sorted[0]).toBe(11);
    expect(sorted[1]).toBe(111);
    expect(pool.stats()).toEqual({ active: 1, hibernated: 0, total: 1 });
  });

  test("custom HibernationStore routes get/put/delete", async () => {
    const events: Array<{ op: string; key: string }> = [];
    const inner = createInMemoryHibernationStore();
    const store: HibernationStore = {
      delete: async (key) => {
        events.push({ key, op: "delete" });
        return inner.delete(key);
      },
      get: async (key) => {
        events.push({ key, op: "get" });
        return inner.get(key);
      },
      put: async (key, checkpoint) => {
        events.push({ key, op: "put" });
        return inner.put(key, checkpoint);
      },
    };
    pool = createHibernatingIsolatePool({
      hibernateAfterMs: 0,
      hibernationStore: store,
    });
    await pool.run("tenant-e", async (context) => {
      const fn = await context.compileCallable(`() => { this.id = 'evt' }`);
      await fn.call([]);
    });
    await pool.hibernate("tenant-e");
    await pool.run("tenant-e", async (context) => {
      const fn = await context.compileCallable(`() => this.id`);
      const v = await fn.call([]);
      expect(v).toBe("evt");
    });
    expect(events).toEqual([
      { key: "tenant-e", op: "put" },
      { key: "tenant-e", op: "get" },
    ]);
  });

  test("falls back to a fresh context when a stored checkpoint is invalid", async () => {
    const events: HibernationEvent[] = [];
    let checkpoint: ContextCheckpoint | undefined;
    const store: HibernationStore = {
      delete: () => {
        checkpoint = undefined;
      },
      get: () => checkpoint,
      put: (_key, value) => {
        checkpoint = value;
      },
    };
    pool = createHibernatingIsolatePool({
      hibernateAfterMs: 0,
      hibernationStore: store,
      onTransition: (event) => events.push(event),
    });
    await pool.run("tenant-invalid", async (context) => {
      const fn = await context.compileCallable("() => { this.value = 42 }");
      await fn.call([]);
    });
    await pool.hibernate("tenant-invalid");
    checkpoint = { ...checkpoint!, schemaVersion: 999 as 1 };

    const restored = await pool.run("tenant-invalid", async (context) => {
      const fn = await context.compileCallable("() => this.value ?? 'fresh'");
      return fn.call([]);
    });

    expect(restored).toBe("fresh");
    expect(pool.metrics().restoreFallbacks).toBe(1);
    expect(pool.metrics().spawns).toBe(2);
    expect(events).toContainEqual({
      key: "tenant-invalid",
      reason: "checkpoint-invalid",
      type: "restore-fallback",
    });
  });

  test("LRU eviction drops oldest hibernated entries first when over maxSize", async () => {
    pool = createHibernatingIsolatePool({
      hibernateAfterMs: 0,
      maxSize: 2,
    });
    // Three keys; both first two get hibernated explicitly, then a third
    // pushes over the cap. The oldest hibernated should drop, not the
    // active one.
    for (const key of ["a", "b"]) {
      await pool.run(key, async (context) => {
        const fn = await context.compileCallable(`() => { this.k = 1 }`);
        await fn.call([]);
      });
      await pool.hibernate(key);
    }
    expect(pool.stats()).toEqual({ active: 0, hibernated: 2, total: 2 });

    // Use key "a" lightly so "b" is oldest, then add "c" — "b" should evict.
    // (Hibernated entries' lastUsed only updates on hibernate-time stamping,
    // so "a" and "b" have equal-ish timestamps; the sort is stable.)
    await waitMs(10);
    await pool.run("c", async (context) => {
      const fn = await context.compileCallable(`() => { this.k = 1 }`);
      await fn.call([]);
    });
    const after = pool.stats();
    // Total is 2 again (one was evicted to make room for "c").
    expect(after.total).toBe(2);
    expect(after.active).toBe(1);
    expect(after.hibernated).toBe(1);
  });

  test("onTransition fires for hibernate, wake, and evict", async () => {
    const events: HibernationEvent[] = [];
    pool = createHibernatingIsolatePool({
      hibernateAfterMs: 0,
      maxSize: 1,
      onTransition: (event) => events.push(event),
    });
    await pool.run("a", async (context) => {
      const fn = await context.compileCallable(`() => { this.v = 1 }`);
      await fn.call([]);
    });
    await pool.hibernate("a");
    await pool.run("b", async (context) => {
      // maxSize=1 → adding "b" should evict the hibernated "a"
      const fn = await context.compileCallable(`() => { this.v = 2 }`);
      await fn.call([]);
    });
    const types = events.map((event) => event.type);
    expect(types).toContain("hibernate");
    expect(types).toContain("evict");
  });

  test("dispose stops the sweeper and disposes active isolates", async () => {
    pool = createHibernatingIsolatePool({ hibernateAfterMs: 0 });
    await pool.run("a", async (context) => {
      const fn = await context.compileCallable(`() => 1`);
      await fn.call([]);
    });
    await pool.dispose();
    expect(pool.stats()).toEqual({ active: 0, hibernated: 0, total: 0 });
    await expect(
      pool.run(
        "a",
        async () => 1 as unknown as Awaited<ReturnType<typeof Promise.resolve>>,
      ),
    ).rejects.toThrow(/disposed/);
  });

  test("hibernating an in-flight key waits for the call to settle", async () => {
    pool = createHibernatingIsolatePool({ hibernateAfterMs: 0 });
    let resolveCall: (() => void) | null = null;
    const inflight = pool.run("a", async (context) => {
      const fn = await context.compileCallable(
        `(args) => { this.value = args.v; return args.v }`,
      );
      const result = await fn.call([{ v: 7 }]);
      await new Promise<void>((resolve) => {
        resolveCall = resolve;
      });
      return result;
    });
    // Let the call register before we kick off hibernation. Otherwise
    // hibernate may see entries empty and return as a no-op.
    await waitMs(50);
    expect(pool.stats().active).toBe(1);

    const hibernatePromise = pool.hibernate("a");
    await waitMs(20);
    // Still in-flight — hibernate must be waiting on inFlight to settle.
    expect(pool.stats().active).toBe(1);

    resolveCall!();
    await inflight;
    await hibernatePromise;
    expect(pool.stats()).toEqual({ active: 0, hibernated: 1, total: 1 });
  });

  test("hibernate is a no-op for unknown keys", async () => {
    pool = createHibernatingIsolatePool({ hibernateAfterMs: 0 });
    await pool.hibernate("never-existed");
    expect(pool.stats()).toEqual({ active: 0, hibernated: 0, total: 0 });
  });

  test("a store that loses the checkpoint falls back to fresh spawn (no throw)", async () => {
    // The store accepts put but always returns undefined on get. The pool
    // should treat the key as fresh instead of throwing.
    const store: HibernationStore = {
      delete: () => {},
      get: () => undefined,
      put: () => {},
    };
    pool = createHibernatingIsolatePool({
      hibernateAfterMs: 0,
      hibernationStore: store,
    });
    await pool.run("a", async (context) => {
      const fn = await context.compileCallable(`() => { this.v = 'first' }`);
      await fn.call([]);
    });
    await pool.hibernate("a");
    expect(pool.stats().hibernated).toBe(1);

    const result = await pool.run("a", async (context) => {
      const fn = await context.compileCallable(`() => this.v`);
      return await fn.call([]);
    });
    // Lost state → undefined. We must not throw.
    expect(result).toBeUndefined();
    expect(pool.stats().active).toBe(1);
  });

  test("checkpoint payload is forwarded to the store with schemaVersion: 1", async () => {
    let captured: ContextCheckpoint | undefined;
    const store: HibernationStore = {
      delete: () => {},
      get: () => captured,
      put: (_key, checkpoint) => {
        captured = checkpoint;
      },
    };
    pool = createHibernatingIsolatePool({
      hibernateAfterMs: 0,
      hibernationStore: store,
    });
    await pool.run("a", async (context) => {
      const fn = await context.compileCallable(
        `() => { this.persistent = 'yes'; this.counter = 7 }`,
      );
      await fn.call([]);
    });
    await pool.hibernate("a");
    expect(captured).toBeDefined();
    expect(captured!.schemaVersion).toBe(1);
    expect(captured!.data.persistent).toBe("yes");
    expect(captured!.data.counter).toBe(7);
    expect(captured!.byteLength).toBeGreaterThan(0);
    expect(captured!.included).toBeGreaterThanOrEqual(2);
  });
});
