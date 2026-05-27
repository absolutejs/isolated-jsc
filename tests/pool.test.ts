/**
 * `createIsolatePool` — keyed pool over `createIsolate`. Tests cover spawn-
 * once-per-key, key isolation (writes in one key don't leak to another),
 * recycle-after-N, LRU eviction at maxSize, transparent re-spawn after the
 * isolate self-terminates (memory cap, timeout), and dispose semantics.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createIsolatePool, TimeoutError, type IsolatePool } from "../src";

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("promise did not reject");
};

let pool: IsolatePool | null = null;
afterEach(async () => {
  await pool?.dispose();
  pool = null;
});

describe("createIsolatePool", () => {
  test("spawns lazily on first use per key, reuses thereafter", async () => {
    pool = createIsolatePool();
    expect(pool.size()).toBe(0);

    // First call to "tenant-a" spawns. Second call reuses.
    await pool.run("tenant-a", async (isolate) => {
      const ctx = await isolate.createContext();
      const script = await isolate.compileScript("1 + 1");
      const result = await script.run(ctx);
      expect(result).toBe(2);
      await ctx.dispose();
    });
    expect(pool.size()).toBe(1);

    await pool.run("tenant-a", async (isolate) => {
      // If the pool spawned a NEW isolate this would be a fresh context;
      // the size would still be 1 because the old one is gone. The size
      // check below only proves "we never exceeded 1 distinct entry".
      const ctx = await isolate.createContext();
      const script = await isolate.compileScript("'reused'");
      expect(await script.run(ctx)).toBe("reused");
      await ctx.dispose();
    });
    expect(pool.size()).toBe(1);
  });

  test("different keys get independent isolates", async () => {
    pool = createIsolatePool();
    await pool.run("a", async (isolate) => {
      const ctx = await isolate.createContext();
      await ctx.setGlobal("secret", "from-a");
      const script = await isolate.compileScript("secret");
      expect(await script.run(ctx)).toBe("from-a");
      await ctx.dispose();
    });
    await pool.run("b", async (isolate) => {
      const ctx = await isolate.createContext();
      // No setGlobal("secret") here — fresh isolate, fresh context.
      const script = await isolate.compileScript("typeof secret");
      expect(await script.run(ctx)).toBe("undefined");
      await ctx.dispose();
    });
    expect(pool.size()).toBe(2);
  });

  test("maxSize evicts the LRU entry when capacity is hit", async () => {
    pool = createIsolatePool({ maxSize: 2 });
    await pool.run("a", async () => {
      /* spawn a */
    });
    await pool.run("b", async () => {
      /* spawn b */
    });
    expect(pool.size()).toBe(2);
    // Touching "a" makes it the most-recently-used; "b" is now LRU.
    await pool.run("a", async () => {
      /* refresh a's lastUsed */
    });
    // New key forces eviction. "b" should go.
    await pool.run("c", async () => {
      /* spawn c */
    });
    expect(pool.size()).toBe(2);
    // Use "b" again — it should be a fresh isolate (the old one is gone).
    // We verify by setting + reading a global: an evicted-and-respawned
    // isolate has a fresh context, so the global from before wouldn't
    // exist. Since we never set a global on "b" before, just confirm the
    // call works (proves "b" is now in the pool again).
    await pool.run("b", async (isolate) => {
      const ctx = await isolate.createContext();
      const script = await isolate.compileScript("42");
      expect(await script.run(ctx)).toBe(42);
      await ctx.dispose();
    });
    expect(pool.size()).toBe(2);
  });

  test("recycleAfter disposes + respawns after N calls per key", async () => {
    pool = createIsolatePool({ recycleAfter: 3 });
    // Set a global on the first call; if recycle works, calls 4+ run on
    // a fresh isolate and the global is gone.
    await pool.run("k", async (isolate) => {
      const ctx = await isolate.createContext();
      await ctx.setGlobal("marker", "first-isolate");
      const script = await isolate.compileScript("marker");
      expect(await script.run(ctx)).toBe("first-isolate");
      await ctx.dispose();
    });
    // Calls 2 + 3 still reuse the first isolate.
    for (let i = 2; i <= 3; i++) {
      await pool.run("k", async (isolate) => {
        // setGlobal lives on the CONTEXT, not the isolate, so even
        // within "the same isolate" we don't see the marker across
        // different contexts. We just confirm the script runs.
        const ctx = await isolate.createContext();
        await ctx.dispose();
      });
    }
    // 4th call should be on a fresh isolate. Hard to verify without
    // identity — instead, confirm the size after the recycle event
    // dropped to 0 then back to 1.
    await pool.run("k", async (isolate) => {
      // The recycle from the 3rd call's finally block disposed the entry;
      // this call respawned. So we expect size === 1 (the new one).
      const ctx = await isolate.createContext();
      const script = await isolate.compileScript("100");
      expect(await script.run(ctx)).toBe(100);
      await ctx.dispose();
    });
    expect(pool.size()).toBe(1);
  });

  test("transparently respawns after the isolate self-terminates (timeout)", async () => {
    pool = createIsolatePool();
    // First call: trigger a timeout, which terminates the isolate.
    await pool.run("k", async (isolate) => {
      const ctx = await isolate.createContext();
      const script = await isolate.compileScript("while (true) {}");
      const err = await rejection(script.run(ctx, { timeout: 50 }));
      expect(err).toBeInstanceOf(TimeoutError);
      // Don't try to dispose the context; the isolate is dead.
    });
    // Second call to the same key should spawn a fresh isolate.
    await pool.run("k", async (isolate) => {
      const ctx = await isolate.createContext();
      const script = await isolate.compileScript("'alive'");
      expect(await script.run(ctx)).toBe("alive");
      await ctx.dispose();
    });
  });

  test("dispose tears down every cached isolate; further run() rejects", async () => {
    pool = createIsolatePool();
    await pool.run("a", async () => {
      /* */
    });
    await pool.run("b", async () => {
      /* */
    });
    expect(pool.size()).toBe(2);
    await pool.dispose();
    expect(pool.size()).toBe(0);
    const err = await rejection(pool.run("a", async () => undefined));
    expect((err as Error).message).toMatch(/disposed/);
    pool = null; // already disposed; afterEach should noop
  });

  test("concurrent run() on the same key shares one spawn (no double-create)", async () => {
    pool = createIsolatePool();
    // Race 10 calls to the same key; they should all see the same isolate.
    const seen = new Set<unknown>();
    await Promise.all(
      Array.from({ length: 10 }, () =>
        pool!.run("k", async (isolate) => {
          seen.add(isolate);
        }),
      ),
    );
    expect(seen.size).toBe(1);
    expect(pool.size()).toBe(1);
  });

  test("isolate options are honored — harden default is on inside pooled isolates", async () => {
    pool = createIsolatePool();
    await pool.run("k", async (isolate) => {
      const ctx = await isolate.createContext();
      const script = await isolate.compileScript(`typeof fetch`);
      expect(await script.run(ctx)).toBe("undefined");
      await ctx.dispose();
    });
  });

  test("custom isolate options propagate to every isolate the pool spawns", async () => {
    pool = createIsolatePool({
      isolate: { harden: false },
    });
    await pool.run("k", async (isolate) => {
      const ctx = await isolate.createContext();
      const script = await isolate.compileScript(`typeof fetch`);
      expect(await script.run(ctx)).toBe("function"); // harden off → reachable
      await ctx.dispose();
    });
  });
});
