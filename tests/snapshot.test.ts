/**
 * Context seed + snapshot — T2.3. The "snapshot" is data-only (functions /
 * host References are skipped); seed carries the code half. Together they
 * let a caller fork a fresh context from a previous one's accumulated state.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createIsolate, type Isolate } from "../src";
import { resolveJscLibrary } from "../src/ffi/resolver";

const checkpointBackends = (
  resolveJscLibrary().kind === "found" ? ["worker", "ffi"] : ["worker"]
) as Array<"worker" | "ffi">;

let isolate: Isolate | null = null;
afterEach(async () => {
  await isolate?.dispose();
  isolate = null;
});

describe("createContext({ seed, snapshot })", () => {
  test("seed runs before the context is returned and its definitions are reachable", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext({
      // Phase-1 convention: assign onto `this` to persist into the sandbox.
      // `var double = …` would scope to the seed's eval frame only.
      seed: "this.double = function (x) { return x * 2 }",
    });
    const script = await isolate.compileScript("double(21)");
    expect(await script.run(context)).toBe(42);
  });

  test("seed can use globals (Math, JSON, console) just like a normal script", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext({
      seed: "this.PI_TIMES_TWO = Math.PI * 2",
    });
    const script = await isolate.compileScript("PI_TIMES_TWO");
    expect(await script.run(context)).toBe(Math.PI * 2);
  });

  test("snapshot data is installed before seed runs (seed can read snapshot state)", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext({
      snapshot: { base: 10 },
      seed: "this.doubled = base * 2",
    });
    const script = await isolate.compileScript("doubled");
    expect(await script.run(context)).toBe(20);
  });
});

describe("context.snapshot()", () => {
  test("captures structured-cloneable own properties only", async () => {
    isolate = await createIsolate();
    const a = await isolate.createContext({
      seed: `
        this.items = [1, 2, 3];
        this.nested = { a: { b: { c: 42 } } };
        this.n = 7;
      `,
    });
    const snap = await a.snapshot();
    expect(snap.items).toEqual([1, 2, 3]);
    expect(snap.nested).toEqual({ a: { b: { c: 42 } } });
    expect(snap.n).toBe(7);
  });

  test("skips functions, host References, and other non-clonable values", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext({
      seed: `
        this.data = 'kept';
        this.fn = function () { return 1 };
        this.sym = Symbol('s');
      `,
    });
    const snap = await context.snapshot();
    expect(snap.data).toBe("kept");
    expect("fn" in snap).toBe(false);
    expect("sym" in snap).toBe(false);
  });

  test("round-trip: snapshot one context, restore into another, accumulated state carries over", async () => {
    isolate = await createIsolate();
    const turn1 = await isolate.createContext({
      seed: `
        this.counter = 0;
        this.add = function (n) { this.counter += n; return this.counter };
      `,
    });
    const s1 = await isolate.compileScript("add(5); add(7)");
    expect(await s1.run(turn1)).toBe(12);
    const snap = await turn1.snapshot();
    expect(snap.counter).toBe(12);
    await turn1.dispose();

    // Turn 2: fresh context, same seed, restored state.
    const turn2 = await isolate.createContext({
      snapshot: snap,
      seed: "this.add = function (n) { this.counter += n; return this.counter }",
    });
    const s2 = await isolate.compileScript("add(100)");
    expect(await s2.run(turn2)).toBe(112);
    expect((await turn2.snapshot()).counter).toBe(112);
  });

  test("snapshot does NOT carry the `globalThis` self-reference", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const snap = await context.snapshot();
    expect("globalThis" in snap).toBe(false);
  });

  test("snapshot is independent of the source context after capture", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext({
      seed: "this.x = 1",
    });
    const snap = await context.snapshot();
    expect(snap.x).toBe(1);
    // Mutate via a new script.
    const s = await isolate.compileScript("this.x = 999");
    await s.run(context);
    expect((await context.snapshot()).x).toBe(999);
    // The earlier snap is unchanged.
    expect(snap.x).toBe(1);
  });
});

describe("context.checkpoint()", () => {
  test("returns versioned checkpoint metadata and restores via createContext", async () => {
    isolate = await createIsolate({ backend: "worker" });
    const context = await isolate.createContext({
      seed: `
        this.keep = { n: 21 };
        this.skip = function () { return 1 };
      `,
    });

    const checkpoint = await context.checkpoint();
    expect(checkpoint.schemaVersion).toBe(1);
    expect(checkpoint.backend).toBe("worker");
    expect(checkpoint.data.keep).toEqual({ n: 21 });
    expect(checkpoint.included).toBe(1);
    expect(checkpoint.byteLength).toBeGreaterThan(0);
    expect(checkpoint.skipped).toContainEqual({
      key: "skip",
      reason: "not-clonable",
    });

    const restored = await isolate.createContext({
      checkpoint,
      seed: "this.answer = keep.n * 2",
    });
    const script = await isolate.compileScript("answer");
    expect(await script.run(restored)).toBe(42);
  });

  test("include, exclude, and maxBytes report skipped-key reasons", async () => {
    isolate = await createIsolate({ backend: "worker" });
    const context = await isolate.createContext({
      seed: `
        this.a = "small";
        this.b = "also small";
        this.c = "x".repeat(200);
      `,
    });

    const filtered = await context.checkpoint({
      exclude: ["b"],
      include: ["a", "b", "c"],
      maxBytes: 40,
    });

    expect(filtered.data).toEqual({ a: "small" });
    expect(filtered.skipped).toEqual(
      expect.arrayContaining([
        { key: "b", reason: "excluded" },
        expect.objectContaining({ key: "c", reason: "over-max-bytes" }),
      ]),
    );
    expect(filtered.skippedCount).toBe(2);
  });

  test("restore validates checkpoint shape before seed runs", async () => {
    isolate = await createIsolate({ backend: "worker" });
    const invalid = {
      backend: "worker",
      byteLength: 2,
      data: {},
      included: 0,
      schemaVersion: 999,
      skipped: [],
      skippedCount: 0,
    };

    await expect(
      isolate.createContext({
        checkpoint: invalid as never,
        seed: "this.shouldNotRun = true",
      }),
    ).rejects.toThrow(/schemaVersion/);
  });

  test.each(checkpointBackends)(
    "checkpoint contract is stable on %s backend",
    async (backend) => {
      isolate = await createIsolate({ backend });
      const context = await isolate.createContext({
        seed: `
          this.counter = 40;
          this.keep = { label: "checkpoint" };
          this.skipFn = function () { return counter };
          this.large = "x".repeat(128);
        `,
      });
      const checkpoint = await context.checkpoint({
        include: ["counter", "keep", "skipFn", "large"],
        maxBytes: 80,
      });

      expect(checkpoint.schemaVersion).toBe(1);
      expect(checkpoint.backend).toBe(backend);
      expect(checkpoint.data.counter).toBe(40);
      expect(checkpoint.data.keep).toEqual({ label: "checkpoint" });
      expect(checkpoint.skipped).toEqual(
        expect.arrayContaining([
          { key: "skipFn", reason: "not-clonable" },
          expect.objectContaining({
            key: "large",
            reason: "over-max-bytes",
          }),
        ]),
      );

      const restored = await isolate.createContext({
        checkpoint,
        seed: "this.result = counter + 2",
      });
      const script = await isolate.compileScript("result");
      expect(await script.run(restored)).toBe(42);
    },
  );
});

describe("checkpoint receipts", () => {
  test.each(checkpointBackends)(
    "checkpointWithReceipt surfaces skip-reason counts and labels on %s",
    async (backend) => {
      isolate = await createIsolate({ backend });
      const context = await isolate.createContext({
        seed: `
          this.counter = 40;
          this.keep = { label: "checkpoint" };
          this.skipFn = function () { return counter };
          this.large = "x".repeat(128);
        `,
      });

      const { checkpoint, receipt } = await context.checkpointWithReceipt({
        include: ["counter", "keep", "skipFn", "large"],
        maxBytes: 80,
        purpose: "audit",
        tenant: "tenant-a",
      });

      expect(receipt.operation).toBe("create");
      expect(receipt.status).toBe("success");
      expect(receipt.backend).toBe(backend);
      expect(receipt.byteLength).toBe(checkpoint.byteLength);
      expect(receipt.included).toBe(checkpoint.included);
      expect(receipt.skippedCount).toBe(checkpoint.skippedCount);
      expect(receipt.skippedReasons.notClonable).toBeGreaterThanOrEqual(1);
      expect(receipt.skippedReasons.overMaxBytes).toBeGreaterThanOrEqual(1);
      expect(receipt.maxBytes).toBe(80);
      expect(receipt.includeCount).toBe(4);
      expect(receipt.purpose).toBe("audit");
      expect(receipt.tenant).toBe("tenant-a");
      expect(receipt.memoryLimitMb).toBeGreaterThan(0);
      expect(typeof receipt.executionId).toBe("string");
      expect(typeof receipt.durationMs).toBe("number");
    },
  );

  test.each(checkpointBackends)(
    "createContextWithReceipt records source backend and restored bytes on %s",
    async (backend) => {
      isolate = await createIsolate({ backend });
      const source = await isolate.createContext({
        seed: "this.kept = { count: 7 };",
      });
      const checkpoint = await source.checkpoint();
      await source.dispose();

      const { context, receipt } = await isolate.createContextWithReceipt({
        checkpoint,
        executionId: "restore_trace",
        purpose: "audit",
        seed: "this.result = kept.count * 6;",
      });

      expect(receipt.operation).toBe("restore");
      expect(receipt.status).toBe("success");
      expect(receipt.backend).toBe(backend);
      expect(receipt.sourceBackend).toBe(backend);
      expect(receipt.byteLength).toBe(checkpoint.byteLength);
      expect(receipt.included).toBe(checkpoint.included);
      expect(receipt.executionId).toBe("restore_trace");
      expect(receipt.purpose).toBe("audit");
      expect(receipt.skippedCount).toBe(0);
      expect(receipt.skippedReasons).toEqual({
        excluded: 0,
        notClonable: 0,
        overMaxBytes: 0,
      });

      const script = await isolate.compileScript("result");
      expect(await script.run(context)).toBe(42);
    },
  );

  test.each(checkpointBackends)(
    "createContextWithReceipt error path attaches receipt on %s",
    async (backend) => {
      isolate = await createIsolate({ backend });
      const broken = {
        backend: "worker" as const,
        byteLength: 5,
        data: { keep: 1 },
        included: 1,
        schemaVersion: 9 as unknown as 1,
        skipped: [],
        skippedCount: 0,
      };
      let receipt: unknown;
      try {
        await isolate.createContextWithReceipt({
          checkpoint: broken,
          purpose: "audit",
        });
      } catch (error) {
        receipt = (error as { receipt?: unknown }).receipt;
      }
      expect((receipt as { status: string }).status).toBe("error");
      expect((receipt as { operation: string }).operation).toBe("restore");
      expect((receipt as { backend: string }).backend).toBe(backend);
      expect((receipt as { sourceBackend: string }).sourceBackend).toBe(
        "worker",
      );
    },
  );
});
