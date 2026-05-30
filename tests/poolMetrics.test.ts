/**
 * 0.10.0 — metrics, drain, warm on createIsolatePool + createHibernatingIsolatePool.
 * Tests verify counters + drain semantics. Heavy isolate work is exercised in
 * the existing pool.test.ts / hibernation.test.ts; here we focus on the new
 * surface shape.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  createIsolatePool,
  createHibernatingIsolatePool,
  type IsolatePool,
  type HibernatingIsolatePool,
} from "../src";

let pool: IsolatePool | HibernatingIsolatePool | null = null;
afterEach(async () => {
  if (pool) {
    await pool.dispose();
    pool = null;
  }
});

describe("IsolatePool.metrics + drain (0.10.0)", () => {
  test("metrics returns the snapshot shape", () => {
    pool = createIsolatePool({ maxSize: 4 });
    const m = (pool as IsolatePool).metrics();
    expect(m.at).toBeGreaterThan(0);
    expect(m.size).toBe(0);
    expect(m.inFlight).toBe(0);
    expect(m.spawns).toBe(0);
    expect(m.idleEvictions).toBe(0);
    expect(m.lruEvictions).toBe(0);
    expect(m.recycles).toBe(0);
    expect(m.draining).toBe(false);
  });

  test("spawns counter advances on first use of a key", async () => {
    pool = createIsolatePool();
    await (pool as IsolatePool).run("t1", async () => undefined);
    await (pool as IsolatePool).run("t2", async () => undefined);
    // Re-using "t1" should NOT bump spawns again.
    await (pool as IsolatePool).run("t1", async () => undefined);
    expect((pool as IsolatePool).metrics().spawns).toBe(2);
  });

  test("recycles counter advances when recycleAfter fires", async () => {
    pool = createIsolatePool({ recycleAfter: 2 });
    await (pool as IsolatePool).run("t1", async () => undefined);
    await (pool as IsolatePool).run("t1", async () => undefined);
    // The second call should hit `callCount >= recycleAfter` and trigger
    // a recycle. The recycle counter bumps; the next call spawns fresh.
    expect((pool as IsolatePool).metrics().recycles).toBe(1);
  });

  test("drain refuses new keys but cached keys keep working", async () => {
    pool = createIsolatePool();
    await (pool as IsolatePool).run("cached", async () => undefined);

    (pool as IsolatePool).drain();
    expect((pool as IsolatePool).metrics().draining).toBe(true);

    // Cached key still works.
    await expect(
      (pool as IsolatePool).run("cached", async () => "ok"),
    ).resolves.toBe("ok");

    // New key refused.
    await expect(
      (pool as IsolatePool).run("fresh", async () => "ok"),
    ).rejects.toThrow(/draining/);
  });
});

describe("HibernatingIsolatePool.metrics + drain + warm (0.10.0)", () => {
  test("metrics returns the full snapshot shape", () => {
    pool = createHibernatingIsolatePool({ maxSize: 8 });
    const m = (pool as HibernatingIsolatePool).metrics();
    expect(m.at).toBeGreaterThan(0);
    expect(m.active).toBe(0);
    expect(m.hibernated).toBe(0);
    expect(m.total).toBe(0);
    expect(m.inFlight).toBe(0);
    expect(m.hibernations).toBe(0);
    expect(m.wakes).toBe(0);
    expect(m.evictions).toBe(0);
    expect(m.bytesHibernated).toBe(0);
    expect(m.lastWakeMs).toBe(0);
    expect(m.draining).toBe(false);
  });

  test("warm() materializes an active context for a key", async () => {
    pool = createHibernatingIsolatePool({ hibernateAfterMs: 0 });
    await (pool as HibernatingIsolatePool).warm("tenant-1");
    expect((pool as HibernatingIsolatePool).stats().active).toBe(1);
  });

  test("drain refuses NEW keys but in-flight + existing keys keep working", async () => {
    pool = createHibernatingIsolatePool({ hibernateAfterMs: 0 });
    await (pool as HibernatingIsolatePool).warm("tenant-A");

    (pool as HibernatingIsolatePool).drain();
    expect((pool as HibernatingIsolatePool).metrics().draining).toBe(true);

    // Existing key still works.
    await expect(
      (pool as HibernatingIsolatePool).run("tenant-A", async () => "ok"),
    ).resolves.toBe("ok");

    // New key refused.
    await expect(
      (pool as HibernatingIsolatePool).run("tenant-B", async () => "ok"),
    ).rejects.toThrow(/draining/);
  });

  test("hibernate + wake bump the counters", async () => {
    pool = createHibernatingIsolatePool({ hibernateAfterMs: 0 });
    const p = pool as HibernatingIsolatePool;

    // Set up a tenant + run a single trivial callable to commit some
    // state into the context heap (so the hibernation checkpoint is
    // non-trivial).
    await p.run("tenant-1", async (ctx) => {
      const fn = await ctx.compileCallable("(args) => { this.x = args.v; return 1; }");
      await fn.call([{ v: 42 }]);
    });

    // Explicit hibernate.
    await p.hibernate("tenant-1");
    expect(p.metrics().hibernations).toBe(1);
    expect(p.metrics().bytesHibernated).toBeGreaterThan(0);
    expect(p.metrics().hibernated).toBe(1);
    expect(p.metrics().active).toBe(0);

    // Reading wakes it up.
    await p.run("tenant-1", async () => undefined);
    const post = p.metrics();
    expect(post.wakes).toBe(1);
    expect(post.lastWakeMs).toBeGreaterThanOrEqual(0);
    expect(post.active).toBe(1);
    expect(post.hibernated).toBe(0);
  });
});
