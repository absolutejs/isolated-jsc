import { describe, expect, test } from "bun:test";
import {
  createIsolate,
  ExternalCopy,
  MemoryLimitError,
  Reference,
  TimeoutError,
} from "../src";

/**
 * Capture the rejection of a promise as a value. We do NOT use Bun-test's
 * `await expect(p).rejects.toThrow(...)`: that matcher hangs to test timeout
 * on cross-worker postMessage replies — see UPSTREAM_ISSUES.md for the
 * tracking Bun issues (#5602 + #14670 + #19130) and the cleanup steps once
 * one of them lands.
 */
const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("promise did not reject");
};

describe("createIsolate", () => {
  test("compiles and runs a trivial expression", async () => {
    // memoryLimit: 128 to comfortably clear the Bun-worker cold-start
    // heap (~46 MB on Bun 1.3.x). Memory caps below ~64 MB are now too
    // tight; documented in IsolateOptions.memoryLimit JSDoc.
    const isolate = await createIsolate({ memoryLimit: 128 });
    const context = await isolate.createContext();
    const script = await isolate.compileScript("1 + 2");
    const result = await script.run(context);
    expect(result).toBe(3);
    await isolate.dispose();
  });

  test("contexts are independent within an isolate", async () => {
    const isolate = await createIsolate();
    const a = await isolate.createContext();
    const b = await isolate.createContext();
    await a.setGlobal("x", "from-a");
    await b.setGlobal("x", "from-b");
    const readA = await isolate.compileScript("x");
    expect(await readA.run(a)).toBe("from-a");
    expect(await readA.run(b)).toBe("from-b");
    await isolate.dispose();
  });

  test("setGlobal then read back via script", async () => {
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    await context.setGlobal("greeting", "hello");
    const script = await isolate.compileScript('greeting + " world"');
    expect(await script.run(context)).toBe("hello world");
    await isolate.dispose();
  });

  test("Reference round-trips an async host call", async () => {
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    const log: string[] = [];
    const push = new Reference((message: unknown) => {
      log.push(String(message));
      return log.length;
    });
    await context.setGlobal("push", push);
    const script = await isolate.compileScript(
      '(async () => { const n = await push("hi"); return n; })()',
    );
    const result = await script.run(context);
    expect(result).toBe(1);
    expect(log).toEqual(["hi"]);
    await isolate.dispose();
  });

  test("ExternalCopy carries arbitrary plain-object data", async () => {
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    const data = new ExternalCopy({ rows: [1, 2, 3], total: 6 });
    await context.setGlobal("data", data);
    const script = await isolate.compileScript("data.rows.length");
    expect(await script.run(context)).toBe(3);
    await isolate.dispose();
  });

  test("script errors propagate as JS Errors", async () => {
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript(
      '(() => { throw new Error("boom"); })()',
    );
    const err = (await rejection(script.run(context))) as Error;
    expect(err.message).toBe("boom");
    await isolate.dispose();
  });

  test("timeout terminates a runaway script", async () => {
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript("while (true) {}");
    const err = await rejection(script.run(context, { timeout: 100 }));
    expect(err).toBeInstanceOf(TimeoutError);
    // Isolate is dead after timeout — v1 trade-off.
    expect(isolate.isDisposed).toBe(true);
  });

  test("dispose is idempotent and pending ops reject", async () => {
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    await isolate.dispose();
    await isolate.dispose(); // second call is a no-op
    expect(isolate.isDisposed).toBe(true);
    // Subsequent ops fail clean.
    const err = await rejection(context.setGlobal("x", 1));
    expect(err).toBeInstanceOf(Error);
  });

  test("heap usage is reported in bytes", async () => {
    // Default memoryLimit is 64 MB. Starting heap (built-ins + the
    // sandboxPrototype carrying ~100 safe globals) is in the low double-
    // digit MB on JSC. Assert against a generous ceiling — the point is
    // "the reading isn't junk", not "the cold start is small".
    const isolate = await createIsolate({ memoryLimit: 256 });
    const bytes = await isolate.heapSizeBytes();
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(256 * 1024 * 1024);
    await isolate.dispose();
  });
});

describe("hostile tenant", () => {
  test("hardened sandbox: fetch / Bun / process / Worker unreachable via every path that's blockable", async () => {
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`({
      bareFetch: typeof fetch,
      bareBun: typeof Bun,
      bareProcess: typeof process,
      bareWorker: typeof Worker,
      bareWebSocket: typeof WebSocket,
      barePostMessage: typeof postMessage,
      globalThisFetch: typeof globalThis.fetch,
      globalThisBun: typeof globalThis.Bun,
      thisBun: typeof this.Bun,
      directEvalBun: typeof eval('Bun'),
    })`);
    const result = (await script.run(context)) as Record<string, string>;
    expect(result.bareFetch).toBe("undefined");
    expect(result.bareBun).toBe("undefined");
    expect(result.bareProcess).toBe("undefined");
    expect(result.bareWorker).toBe("undefined");
    expect(result.bareWebSocket).toBe("undefined");
    expect(result.barePostMessage).toBe("undefined");
    expect(result.globalThisFetch).toBe("undefined");
    expect(result.globalThisBun).toBe("undefined");
    expect(result.thisBun).toBe("undefined");
    expect(result.directEvalBun).toBe("undefined");
    await isolate.dispose();
  });

  test("hardened sandbox: safe globals (Math, JSON, Promise, URL, crypto, console, …) stay reachable", async () => {
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`({
      math: typeof Math.PI,
      json: typeof JSON.stringify({}),
      promise: typeof Promise.resolve(1).then,
      url: new URL('https://x/y').pathname,
      crypto: typeof crypto.randomUUID,
      setTimeout: typeof setTimeout,
      textEncoder: new TextEncoder().encode('a').length,
      console: typeof console.log,
    })`);
    const result = (await script.run(context)) as Record<string, unknown>;
    expect(result.math).toBe("number");
    expect(result.json).toBe("string");
    expect(result.promise).toBe("function");
    expect(result.url).toBe("/y");
    expect(result.crypto).toBe("function");
    expect(result.setTimeout).toBe("function");
    expect(result.textEncoder).toBe(1);
    expect(result.console).toBe("function");
    await isolate.dispose();
  });

  test("documented residual: (0, eval)('Bun') and new Function('return Bun')() still escape", async () => {
    // Indirect-eval and the Function constructor run in the worker's real
    // global scope, which still has Bun (non-configurable). This is v3
    // (FFI rewrite) territory — documented in IsolateOptions.harden.
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`({
      indirectEval: typeof (0, eval)('Bun'),
      functionCtor: typeof (new Function('return Bun'))(),
    })`);
    const result = (await script.run(context)) as Record<string, string>;
    expect(result.indirectEval).toBe("object");
    expect(result.functionCtor).toBe("object");
    await isolate.dispose();
  });

  test("harden: false restores v0.0.1 behaviour (fetch / Bun / process reachable)", async () => {
    const isolate = await createIsolate({ harden: false });
    const context = await isolate.createContext();
    const script = await isolate.compileScript(
      `typeof fetch + ',' + typeof Bun + ',' + typeof process`,
    );
    const result = await script.run(context);
    expect(result).toBe("function,object,object");
    await isolate.dispose();
  });

  test("unsafelyExposeGlobals lets specific capabilities through while keeping the rest sealed", async () => {
    const isolate = await createIsolate({
      unsafelyExposeGlobals: ["fetch"],
    });
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`({
      fetch: typeof fetch,
      Bun: typeof Bun,
      process: typeof process,
    })`);
    const result = (await script.run(context)) as Record<string, string>;
    expect(result.fetch).toBe("function");
    expect(result.Bun).toBe("undefined");
    expect(result.process).toBe("undefined");
    await isolate.dispose();
  });

  test("memory limit terminates an isolate that allocates a runaway buffer", async () => {
    // Allocate heap-resident JS objects (not Uint8Arrays — those go
    // through bmalloc on JSC and don't count toward the GC heap that
    // `bun:jsc.memoryUsage().current` reports). 50k × ~10 KB strings ≈
    // 500 MB of heap, well past the 128 MB cap. We use 128 (not 32) to
    // clear the worker's ~46 MB cold-start baseline.
    const isolate = await createIsolate({ memoryLimit: 128 });
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`
			(async () => {
				const buckets = [];
				for (let i = 0; i < 50000; i++) {
					buckets.push({ k: i, v: 'x'.repeat(10000) });
					if (i % 200 === 0) await new Promise(r => setTimeout(r, 1));
				}
				return buckets.length;
			})()
		`);
    const err = await rejection(script.run(context, { timeout: 5000 }));
    expect(err).toBeInstanceOf(MemoryLimitError);
    expect(isolate.isDisposed).toBe(true);
  }, 10_000);
});
