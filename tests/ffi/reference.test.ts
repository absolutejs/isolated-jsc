/**
 * FFI backend Reference call-through — new in 0.3.
 *
 * Each Reference gets its own `JSCallback` (closure-captures the host fn).
 * Sync host fns return their value directly; Promise-returning host fns
 * are wrapped in `JSObjectMakeDeferredPromise`. JSC drains microtasks
 * between top-level `JSEvaluateScript` calls, so async user code that
 * awaits a Reference call resolves synchronously (the common case).
 *
 * Documented limit (in `Reference` JSDoc): host fns that themselves
 * need real async settling (setTimeout, real I/O) won't unwrap on FFI —
 * fall back to `backend: 'worker'` for those.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createIsolate, Reference, type Isolate } from "../../src";
import { resolveJscLibrary } from "../../src/ffi/resolver";

const ffiAvailable = resolveJscLibrary().kind === "found";
const describeIfFfi = ffiAvailable ? describe : describe.skip;

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("promise did not reject");
};

let isolate: Isolate | null = null;
afterEach(async () => {
  await isolate?.dispose();
  isolate = null;
});

describeIfFfi("FFI Reference call-through", () => {
  test("sync host fn: bare call returns value, log captures args", async () => {
    isolate = await createIsolate({ backend: "ffi" });
    const context = await isolate.createContext();
    const log: string[] = [];
    const push = new Reference((msg: unknown) => {
      log.push(String(msg));
      return log.length;
    });
    await context.setGlobal("push", push);
    const script = await isolate.compileScript(
      "push('a') + push('b') + push('c')",
    );
    expect(await script.run(context)).toBe(6); // 1 + 2 + 3
    expect(log).toEqual(["a", "b", "c"]);
  });

  test("sync host fn: user code awaits the Reference (same shape as Worker tests)", async () => {
    isolate = await createIsolate({ backend: "ffi" });
    const context = await isolate.createContext();
    const log: string[] = [];
    const push = new Reference((msg: unknown) => {
      log.push(String(msg));
      return log.length;
    });
    await context.setGlobal("push", push);
    const script = await isolate.compileScript(
      "(async () => { const n = await push('hi'); return n })()",
    );
    expect(await script.run(context)).toBe(1);
    expect(log).toEqual(["hi"]);
  });

  test("host fn throws: user code sees a thrown JS Error", async () => {
    isolate = await createIsolate({ backend: "ffi" });
    const context = await isolate.createContext();
    const failing = new Reference(() => {
      throw new Error("boom");
    });
    await context.setGlobal("failing", failing);
    const script = await isolate.compileScript(
      "(() => { try { failing(); return 'no throw' } catch (e) { return e.message } })()",
    );
    expect(await script.run(context)).toBe("boom");
  });

  test("multiple References on one context don't interfere", async () => {
    isolate = await createIsolate({ backend: "ffi" });
    const context = await isolate.createContext();
    await context.setGlobal(
      "double",
      new Reference((x: unknown) => (x as number) * 2),
    );
    await context.setGlobal(
      "square",
      new Reference((x: unknown) => (x as number) ** 2),
    );
    const script = await isolate.compileScript("double(3) + square(4)");
    expect(await script.run(context)).toBe(22); // 6 + 16
  });

  test("Promise-returning host fns settle through the FFI pump (0.4+)", async () => {
    // 0.4 added a polling loop that alternately yields to Bun's event
    // loop (so host-side `.then` continuations fire and queue JSC
    // microtasks) and runs a no-op JSEvaluateScript (so JSC drains its
    // microtask queue). Sync-resolving Promises settle on the first
    // read; async ones — setTimeout, real I/O — settle on a later cycle.
    isolate = await createIsolate({ backend: "ffi" });
    const context = await isolate.createContext();
    await context.setGlobal(
      "syncAsyncRef",
      new Reference(() => Promise.resolve(42)),
    );
    await context.setGlobal(
      "trueAsyncRef",
      new Reference(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(7), 5);
          }),
      ),
    );
    const sync = await isolate.compileScript(
      "(async () => await syncAsyncRef())()",
    );
    expect(await sync.run(context)).toBe(42);

    const async = await isolate.compileScript(
      "(async () => await trueAsyncRef())()",
    );
    expect(await async.run(context)).toBe(7);
  });

  test("async host fns that exceed the timeout surface TimeoutError", async () => {
    // The pump is bounded by Script.run({ timeout }). A host fn that
    // never settles (or settles after the deadline) must throw
    // TimeoutError — not hang.
    isolate = await createIsolate({ backend: "ffi" });
    const context = await isolate.createContext();
    await context.setGlobal(
      "hang",
      new Reference(() => new Promise(() => {})),
    );
    const script = await isolate.compileScript(
      "(async () => await hang())()",
    );
    const err = (await rejection(script.run(context, { timeout: 100 }))) as {
      name: string;
    };
    expect(err.name).toBe("TimeoutError");
  });

  test("References work in pooled isolates", async () => {
    // Quick integration check: the pool primitive (T2.2) over FFI
    // backend (T3) with References (this PR).
    const { createIsolatePool } = await import("../../src");
    const pool = createIsolatePool({
      isolate: { backend: "ffi" },
      maxSize: 4,
    });
    try {
      const result = await pool.run("tenant-a", async (iso) => {
        const ctx = await iso.createContext();
        await ctx.setGlobal(
          "add",
          new Reference(
            (a: unknown, b: unknown) => (a as number) + (b as number),
          ),
        );
        const script = await iso.compileScript("add(2, 3)");
        return await script.run(ctx);
      });
      expect(result).toBe(5);
    } finally {
      await pool.dispose();
    }
  });
});
