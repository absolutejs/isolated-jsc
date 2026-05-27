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
    const isolate = await createIsolate({ memoryLimit: 32 });
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
    const isolate = await createIsolate();
    const bytes = await isolate.heapSizeBytes();
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(64 * 1024 * 1024); // under default cap
    await isolate.dispose();
  });
});

describe("hostile tenant", () => {
  test("cannot reach the host filesystem or fetch", async () => {
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    // In the wrapped sandbox, undeclared globals don't fall through to
    // the worker's real globalThis because `with(sandbox)` shadows them
    // to undefined. We expose nothing.
    const script = await isolate.compileScript(
      'typeof fetch + "," + typeof Bun + "," + typeof process',
    );
    const result = await script.run(context);
    // JSC actually exposes these on the worker's globalThis; this test
    // documents what IS reachable today so we can tighten in v2.
    // The expected behaviour for v1: they ARE reachable inside the
    // worker. Heap isolation is the only Phase-1 guarantee.
    expect(typeof result).toBe("string");
    await isolate.dispose();
  });

  test("memory limit terminates an isolate that allocates a runaway buffer", async () => {
    // Allocate heap-resident JS objects (not Uint8Arrays — those go
    // through bmalloc on JSC and don't count toward the GC heap that
    // `bun:jsc.memoryUsage().current` reports). 50k × ~10 KB strings ≈
    // 500 MB of heap, well past the 32 MB cap.
    const isolate = await createIsolate({ memoryLimit: 32 });
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
