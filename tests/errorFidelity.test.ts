/**
 * T2.4: error fidelity + per-run telemetry.
 *
 * Error wire preserves `error.cause` (recursive) and enumerable own
 * properties — so custom Error subclasses (FooError with `.code`,
 * `.statusCode`, etc.) survive the cross-boundary round trip with their
 * instance data intact. `name` is preserved too, so callers can do
 * `err.name === 'FooError'` even though `instanceof FooError` won't work
 * across the boundary (we don't have the constructor on the host).
 *
 * `script.runWithMetrics(ctx)` returns `{ result, metrics: { cpuMs,
 * heapBytes } }`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createIsolate, type Isolate } from "../src";

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

describe("error fidelity", () => {
  test("preserves error.name across the boundary", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript(
      "(() => { const e = new Error('boom'); e.name = 'CustomError'; throw e })()",
    );
    const err = (await rejection(script.run(context))) as Error;
    expect(err.name).toBe("CustomError");
    expect(err.message).toBe("boom");
  });

  test("preserves error.cause (single level)", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`
      (() => {
        const inner = new Error('inner reason');
        inner.name = 'InnerError';
        const outer = new Error('outer wrap', { cause: inner });
        throw outer;
      })()
    `);
    const err = (await rejection(script.run(context))) as Error & {
      cause?: Error;
    };
    expect(err.message).toBe("outer wrap");
    expect(err.cause).toBeInstanceOf(Error);
    expect(err.cause?.message).toBe("inner reason");
    expect(err.cause?.name).toBe("InnerError");
  });

  test("preserves error.cause chain (multi-level)", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`
      (() => {
        const a = new Error('a');
        const b = new Error('b', { cause: a });
        const c = new Error('c', { cause: b });
        throw c;
      })()
    `);
    const err = (await rejection(script.run(context))) as Error & {
      cause?: Error & { cause?: Error };
    };
    expect(err.message).toBe("c");
    expect(err.cause?.message).toBe("b");
    expect(err.cause?.cause?.message).toBe("a");
  });

  test("preserves enumerable own properties (custom Error-subclass instance data)", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`
      (() => {
        const e = new Error('forbidden');
        e.name = 'HttpError';
        e.statusCode = 403;
        e.code = 'PERMISSION_DENIED';
        e.details = { who: 'alice', what: 'tasks.write' };
        throw e;
      })()
    `);
    const err = (await rejection(script.run(context))) as Error & {
      statusCode?: number;
      code?: string;
      details?: { who: string; what: string };
    };
    expect(err.name).toBe("HttpError");
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("PERMISSION_DENIED");
    expect(err.details).toEqual({ who: "alice", what: "tasks.write" });
  });

  test("circular cause chain is bounded (no infinite recursion)", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`
      (() => {
        const e = new Error('self');
        e.cause = e;
        throw e;
      })()
    `);
    // Should not hang. The wrapError walks at most 10 levels.
    const err = (await rejection(script.run(context))) as Error;
    expect(err.message).toBe("self");
  });
});

describe("script.runWithMetrics", () => {
  test("returns { result, metrics: { cpuMs, heapBytes } } on success", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript("1 + 2");
    const { result, metrics } = await script.runWithMetrics(context);
    expect(result).toBe(3);
    expect(typeof metrics.cpuMs).toBe("number");
    expect(metrics.cpuMs).toBeGreaterThanOrEqual(0);
    expect(typeof metrics.heapBytes).toBe("number");
    expect(metrics.heapBytes).toBeGreaterThan(0);
  });

  test("cpuMs reflects actual run time (busy loop ~> measurable)", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`
      (() => {
        let n = 0;
        for (let i = 0; i < 5_000_000; i++) n += i;
        return n;
      })()
    `);
    const { metrics } = await script.runWithMetrics(context, {
      timeout: 5000,
    });
    expect(metrics.cpuMs).toBeGreaterThan(0);
    expect(metrics.cpuMs).toBeLessThan(5000);
  });

  test("rejection on a failing run still rejects (metrics are not attached on errors)", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript(
      "(() => { throw new Error('oops') })()",
    );
    const err = (await rejection(script.runWithMetrics(context))) as Error;
    expect(err.message).toBe("oops");
  });

  test("plain run() still returns the bare value (back-compat)", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript("'plain'");
    const result = await script.run(context);
    expect(result).toBe("plain"); // not { result: 'plain', metrics: ... }
  });
});
