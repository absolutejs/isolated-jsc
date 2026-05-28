/**
 * FFI backend tests — the strictly-better parts of T3 that the Worker
 * backend can't deliver:
 *
 * 1. **Tiny cold heap** (~300 KB vs Worker's ~46 MB).
 * 2. **Closed T2 residuals** — `(0, eval)('Bun')` and `new Function(...)`
 *    are blocked entirely (eval disabled per-context).
 * 3. **Isolate survives timeout** — the script gets a `TerminationException`,
 *    the isolate keeps running, the NEXT script runs fine.
 * 4. **Cross-platform fallback** — `backend: 'worker'` always works as
 *    an escape hatch.
 *
 * Pinned to FFI via `backend: 'ffi'` in each test (and the test script
 * sets `ISOLATED_JSC_BACKEND=auto` so the resolver runs).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createIsolate, type Isolate, TimeoutError } from "../../src";
import { resolveJscLibrary } from "../../src/ffi/resolver";

const ffiAvailable = resolveJscLibrary().kind === "found";

// Skip the entire FFI test suite if this machine can't find libJSC.
// (CI without libjavascriptcoregtk-4.1 installed; Windows; etc.)
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

describeIfFfi("FFI backend — strictly-better-than-Worker properties", () => {
  test("cold heap is tiny vs Worker (~300 KB, not ~46 MB)", async () => {
    isolate = await createIsolate({ backend: "ffi", memoryLimit: 256 });
    expect(isolate.backend).toBe("ffi");
    const bytes = await isolate.heapSizeBytes();
    expect(bytes).toBeGreaterThan(0);
    // Worker backend baseline is ~46 MB. The FFI cold heap is in the
    // hundreds-of-KB range. Assert well under a megabyte — gives JSC
    // room to vary across libJSC builds without flaking.
    expect(bytes).toBeLessThan(1024 * 1024);
  });

  test("closes T2 residual #1: `(0, eval)('Bun')` no longer escapes", async () => {
    isolate = await createIsolate({ backend: "ffi" });
    const context = await isolate.createContext();
    const script = await isolate.compileScript("(0, eval)('Bun')");
    const err = await rejection(script.run(context));
    // FFI uses JSGlobalContextSetEvalEnabled(ctx, false, msg) — eval is
    // disabled entirely, so indirect eval throws our installed message.
    expect((err as Error).message).toMatch(/eval disabled/i);
  });

  test("closes T2 residual #2: `new Function('return Bun')()` no longer escapes", async () => {
    isolate = await createIsolate({ backend: "ffi" });
    const context = await isolate.createContext();
    const script = await isolate.compileScript(
      "(new Function('return Bun'))()",
    );
    const err = await rejection(script.run(context));
    // Function constructor goes through the same eval path; same message.
    expect((err as Error).message).toMatch(/eval disabled/i);
  });

  test("isolate survives timeout — next script runs on the same isolate", async () => {
    isolate = await createIsolate({ backend: "ffi" });
    const context = await isolate.createContext();
    const runaway = await isolate.compileScript("while(true){}");
    const err = await rejection(runaway.run(context, { timeout: 100 }));
    expect(err).toBeInstanceOf(TimeoutError);
    // The Worker backend would have terminated the isolate. FFI keeps it
    // alive — JSC's watchdog throws a TerminationException into the
    // script's stack, isolate process keeps running.
    expect(isolate.isDisposed).toBe(false);
    const fresh = await isolate.compileScript("1 + 2");
    expect(await fresh.run(context)).toBe(3);
  });

  test("bare identifier shadows still close: typeof fetch / Bun / process", async () => {
    isolate = await createIsolate({ backend: "ffi" });
    const context = await isolate.createContext();
    const script = await isolate.compileScript(
      "typeof fetch + ',' + typeof Bun + ',' + typeof process",
    );
    // Bare-identifier reads in JSC go through the global object, which
    // we've populated with undefined for HARDEN_TARGETS. Result: all three
    // resolve to undefined.
    expect(await script.run(context)).toBe("undefined,undefined,undefined");
  });

  test("safe globals stay reachable: Math, JSON, Promise", async () => {
    isolate = await createIsolate({ backend: "ffi" });
    const context = await isolate.createContext();
    // Note: URL / TextEncoder / WebSocket are Web APIs that are only
    // present in the *browser-side* WebKitGTK build, not the standalone
    // JSC API. The Worker-backed v1 sees them because Bun's worker
    // globalThis exposes Web APIs; the FFI backend talks to bare JSC
    // and gets only the ECMAScript-spec built-ins. Documented limit.
    const script = await isolate.compileScript(
      "Math.PI + ',' + typeof JSON.stringify + ',' + typeof Promise",
    );
    expect(await script.run(context)).toBe(`${Math.PI},function,function`);
  });

  test("`harden: false` re-enables eval (full v0 behaviour)", async () => {
    isolate = await createIsolate({ backend: "ffi", harden: false });
    const context = await isolate.createContext();
    const script = await isolate.compileScript("eval('1 + 2')");
    expect(await script.run(context)).toBe(3);
  });

  test("setGlobal + getGlobal round-trip values", async () => {
    isolate = await createIsolate({ backend: "ffi" });
    const context = await isolate.createContext();
    await context.setGlobal("greeting", "hello");
    await context.setGlobal("data", { items: [1, 2, 3], total: 6 });
    expect(await context.getGlobal("greeting")).toBe("hello");
    expect(await context.getGlobal("data")).toEqual({
      items: [1, 2, 3],
      total: 6,
    });
    const script = await isolate.compileScript("greeting + ' ' + data.total");
    expect(await script.run(context)).toBe("hello 6");
  });

  test("runWithMetrics returns cpuMs + heapBytes", async () => {
    isolate = await createIsolate({ backend: "ffi" });
    const context = await isolate.createContext();
    const script = await isolate.compileScript(
      "(() => { let n = 0; for (let i = 0; i < 1_000_000; i++) n += i; return n })()",
    );
    const { result, metrics } = await script.runWithMetrics(context);
    expect(typeof result).toBe("number");
    expect(metrics.backend).toBe("ffi");
    expect(metrics.cpuMs).toBeGreaterThan(0);
    expect(metrics.heapBytes).toBeGreaterThan(0);
  });

  test("backend: 'worker' bypasses FFI and uses the Worker backend", async () => {
    // Should work even without libJSC reachable; the Worker path is
    // self-contained.
    isolate = await createIsolate({ backend: "worker", memoryLimit: 256 });
    expect(isolate.backend).toBe("worker");
    const context = await isolate.createContext();
    const script = await isolate.compileScript("1 + 1");
    expect(await script.run(context)).toBe(2);
    // Worker cold heap is ~46 MB; FFI is ~300 KB. Quick discriminator:
    const bytes = await isolate.heapSizeBytes();
    expect(bytes).toBeGreaterThan(10 * 1024 * 1024);
  });
});

describe("resolveJscLibrary", () => {
  test("returns a useful probe result on this machine", () => {
    const probe = resolveJscLibrary();
    // Either "found" (with a real path) or "not-found" (with a hint
    // pointing at the right package). Both are valid; we just assert
    // the shape is non-empty.
    if (probe.kind === "found") {
      expect(probe.path.length).toBeGreaterThan(0);
      expect(["macos-framework", "gtk-4.1", "gtk-6.0"]).toContain(probe.flavor);
    } else {
      expect(probe.checked.length).toBeGreaterThan(0);
      expect(probe.installHint.length).toBeGreaterThan(0);
    }
  });
});
