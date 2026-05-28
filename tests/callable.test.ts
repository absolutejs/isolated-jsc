/**
 * `Context.compileCallable` — precompiled function expressions for the
 * dispatch shape (compile once, call many times with different args).
 * Per-call cost is one `JSObjectCallAsFunction` (FFI) or one postMessage
 * (Worker) — no per-call eval, no per-call setGlobal. Covers both
 * backends via the ISOLATED_JSC_BACKEND env var the test runner sets.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { CompileError, createIsolate, Reference } from "../src";
import type { Isolate } from "../src";

let isolate: Isolate | undefined;
afterEach(async () => {
  await isolate?.dispose();
  isolate = undefined;
});

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("promise did not reject");
};

describe("Context.compileCallable", () => {
  test("compiles and calls a sync arrow function", async () => {
    isolate = await createIsolate();
    const ctx = await isolate.createContext();
    const fn = await ctx.compileCallable("(a, b) => a + b");
    expect(await fn.call([2, 3])).toBe(5);
    expect(await fn.call([10, 20])).toBe(30);
  });

  test("compiles and calls a sync function expression", async () => {
    isolate = await createIsolate();
    const ctx = await isolate.createContext();
    const fn = await ctx.compileCallable("function(x) { return x * x; }");
    expect(await fn.call([7])).toBe(49);
  });

  test("compiles and calls an async function (returns a Promise)", async () => {
    isolate = await createIsolate();
    const ctx = await isolate.createContext();
    const fn = await ctx.compileCallable("async (x) => { return x + 1; }");
    expect(await fn.call([41])).toBe(42);
  });

  test("returns objects + arrays via structured clone", async () => {
    isolate = await createIsolate();
    const ctx = await isolate.createContext();
    const fn = await ctx.compileCallable(
      "(name, n) => ({ greeting: 'hello ' + name, nums: [1, n, 3] })",
    );
    const result = (await fn.call(["world", 2])) as {
      greeting: string;
      nums: number[];
    };
    expect(result.greeting).toBe("hello world");
    expect(result.nums).toEqual([1, 2, 3]);
  });

  test("source that doesn't evaluate to a function throws CompileError", async () => {
    isolate = await createIsolate();
    const ctx = await isolate.createContext();
    const err = (await rejection(ctx.compileCallable("42"))) as Error;
    expect(err).toBeInstanceOf(CompileError);
    expect(err.message).toMatch(/must evaluate to a function/i);
  });

  test("syntax error in source throws CompileError", async () => {
    isolate = await createIsolate();
    const ctx = await isolate.createContext();
    const err = (await rejection(
      ctx.compileCallable("(a, b)( => a + b"),
    )) as Error;
    expect(err).toBeInstanceOf(CompileError);
  });

  test("user-thrown error propagates with message + name", async () => {
    isolate = await createIsolate();
    const ctx = await isolate.createContext();
    const fn = await ctx.compileCallable(
      "() => { const e = new Error('user error'); e.name = 'CustomError'; throw e; }",
    );
    const err = (await rejection(fn.call([]))) as Error;
    expect(err.message).toBe("user error");
    expect(err.name).toBe("CustomError");
  });

  test("Reference args bridge host fn calls (no global needed)", async () => {
    isolate = await createIsolate();
    const ctx = await isolate.createContext();
    const calls: Array<{ op: string; rest: unknown[] }> = [];
    const dispatch = new Reference(
      (op: unknown, ...rest: unknown[]): unknown => {
        calls.push({ op: op as string, rest });
        if (op === "add") return (rest[0] as number) + (rest[1] as number);
        if (op === "asyncDouble")
          return Promise.resolve((rest[0] as number) * 2);
        throw new Error(`unknown op ${String(op)}`);
      },
    );
    const fn = await ctx.compileCallable(
      `async (dispatch) => {
        const a = await dispatch('add', 2, 3);
        const b = await dispatch('asyncDouble', 10);
        return [a, b];
      }`,
    );
    const result = await fn.call([dispatch]);
    expect(result).toEqual([5, 20]);
    expect(calls).toEqual([
      { op: "add", rest: [2, 3] },
      { op: "asyncDouble", rest: [10] },
    ]);
  });

  test("reuses the isolate + context across many calls (functional)", async () => {
    isolate = await createIsolate();
    const ctx = await isolate.createContext();
    const fn = await ctx.compileCallable("(x) => x * 2");
    const results: number[] = [];
    for (let i = 0; i < 50; i++) {
      results.push((await fn.call([i])) as number);
    }
    expect(results).toEqual(Array.from({ length: 50 }, (_, i) => i * 2));
  });

  test("dispose releases the callable; subsequent calls reject", async () => {
    isolate = await createIsolate();
    const ctx = await isolate.createContext();
    const fn = await ctx.compileCallable("() => 42");
    expect(await fn.call([])).toBe(42);
    await fn.dispose();
    const err = (await rejection(fn.call([]))) as Error;
    expect(err).toBeInstanceOf(Error);
  });

  test("disposing the context also releases its callables", async () => {
    isolate = await createIsolate();
    const ctx = await isolate.createContext();
    const fn = await ctx.compileCallable("() => 'still here'");
    expect(await fn.call([])).toBe("still here");
    await ctx.dispose();
    // After context dispose, the callable's underlying function is gone.
    const err = (await rejection(fn.call([]))) as Error;
    expect(err).toBeInstanceOf(Error);
  });

  test("callWithMetrics returns cpuMs + heapBytes", async () => {
    isolate = await createIsolate();
    const ctx = await isolate.createContext();
    const fn = await ctx.compileCallable(
      "(n) => { let s = 0; for (let i = 0; i < n; i++) s += i; return s; }",
    );
    const { result, metrics } = await fn.callWithMetrics([1000]);
    expect(result).toBe(499500);
    expect(metrics.backend).toBe("worker");
    expect(metrics.cpuMs).toBeGreaterThanOrEqual(0);
    expect(metrics.heapBytes).toBeGreaterThan(0);
  });
});
