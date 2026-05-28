import { describe, expect, test } from "bun:test";
import {
  createIsolatedRunner,
  Reference,
  resolveIsolatePolicy,
  runIsolated,
  TimeoutError,
} from "../src";

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("promise did not reject");
};

describe("runIsolated", () => {
  test("runs a one-shot script and returns the bare result", async () => {
    const result = await runIsolated<number>("1 + 2", { backend: "worker" });

    expect(result).toBe(3);
  });

  test("installs globals before running source", async () => {
    const result = await runIsolated<number>("input.n * 2", {
      backend: "worker",
      globals: { input: { n: 21 } },
    });

    expect(result).toBe(42);
  });

  test("supports Reference globals", async () => {
    const calls: string[] = [];
    const result = await runIsolated<number>(
      '(async () => await log("hello"))()',
      {
        backend: "worker",
        globals: {
          log: new Reference((message: unknown) => {
            calls.push(String(message));
            return calls.length;
          }),
        },
      },
    );

    expect(result).toBe(1);
    expect(calls).toEqual(["hello"]);
  });

  test("returns metrics when requested", async () => {
    const result = await runIsolated<number>("1 + 1", {
      backend: "worker",
      withMetrics: true,
    });

    expect(result.result).toBe(2);
    expect(result.metrics.backend).toBe("worker");
    expect(result.metrics.heapBytes).toBeGreaterThan(0);
  });

  test("returns receipt when requested", async () => {
    const result = await runIsolated<number>("input.n + 1", {
      backend: "worker",
      globals: { input: { n: 41 } },
      run: { executionId: "run_isolated_receipt", tenant: "tenant-a" },
      withReceipt: true,
    });

    expect(result.result).toBe(42);
    expect(result.receipt).toMatchObject({
      backend: "worker",
      executionId: "run_isolated_receipt",
      schemaVersion: 1,
      status: "success",
      tenant: "tenant-a",
    });
  });

  test("uses policy run timeout by default", async () => {
    const err = await rejection(
      runIsolated("while (true) {}", {
        backend: "worker",
        policy: resolveIsolatePolicy("trusted", {
          memoryLimit: 256,
          timeout: 50,
        }),
      }),
    );

    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).timeoutMs).toBe(50);
  });
});

describe("createIsolatedRunner", () => {
  test("reuses isolates by key through the pooled runner", async () => {
    const runner = createIsolatedRunner({
      backend: "worker",
      pool: { idleMs: 0 },
    });
    try {
      expect(runner.size()).toBe(0);

      const first = await runner.run<number>("1 + 1");
      expect(runner.size()).toBe(1);

      const second = await runner.run<number>("2 + 2");
      expect(runner.size()).toBe(1);

      const other = await runner.run<number>("3 + 3", { key: "other" });

      expect(first).toBe(2);
      expect(second).toBe(4);
      expect(other).toBe(6);
      expect(runner.size()).toBe(2);
    } finally {
      await runner.dispose();
    }
  });

  test("merges default and per-call globals", async () => {
    const runner = createIsolatedRunner({
      backend: "worker",
      globals: { a: 1, b: 2 },
      pool: { idleMs: 0 },
    });
    try {
      const result = await runner.run<number>("a + b + c", {
        globals: { b: 20, c: 3 },
      });

      expect(result).toBe(24);
    } finally {
      await runner.dispose();
    }
  });

  test("returns metrics and honors default run options", async () => {
    const runner = createIsolatedRunner({
      backend: "worker",
      pool: { idleMs: 0 },
      run: { timeout: 50 },
    });
    try {
      const measured = await runner.run<number>("1 + 1", {
        withMetrics: true,
      });
      expect(measured.result).toBe(2);
      expect(measured.metrics.backend).toBe("worker");

      const err = await rejection(runner.run("while (true) {}"));
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).timeoutMs).toBe(50);
    } finally {
      await runner.dispose();
    }
  });

  test("runner returns receipts for source runs and cached callables", async () => {
    const runner = createIsolatedRunner({
      backend: "worker",
      pool: { idleMs: 0 },
    });
    try {
      const runReceipt = await runner.run<number>("input.n * 2", {
        globals: { input: { n: 21 } },
        run: { executionId: "runner_run_receipt" },
        withReceipt: true,
      });
      expect(runReceipt.result).toBe(42);
      expect(runReceipt.receipt.executionId).toBe("runner_run_receipt");

      const callReceipt = await runner.call<number>(
        "double",
        "(n) => n * 2",
        [12],
        {
          run: { executionId: "runner_call_receipt" },
          withReceipt: true,
        },
      );
      expect(callReceipt.result).toBe(24);
      expect(callReceipt.receipt.executionId).toBe("runner_call_receipt");
    } finally {
      await runner.dispose();
    }
  });

  test("rejects after dispose", async () => {
    const runner = createIsolatedRunner({ backend: "worker" });
    await runner.dispose();

    const err = await rejection(runner.run("1 + 1"));

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("isolate pool has been disposed");
  });

  test("caches compiled callables by key and name", async () => {
    const runner = createIsolatedRunner({
      backend: "worker",
      pool: { idleMs: 0 },
    });
    try {
      const source = `(() => {
        const compiles = 1;
        return (n) => ({ n: n * 2, compiles });
      })()`;

      const first = await runner.call<{ n: number; compiles: number }>(
        "double",
        source,
        [2],
      );
      const second = await runner.call<{ n: number; compiles: number }>(
        "double",
        source,
        [3],
      );
      const other = await runner.call<{ n: number; compiles: number }>(
        "double",
        source,
        [4],
        { key: "other" },
      );

      expect(first).toEqual({ n: 4, compiles: 1 });
      expect(second).toEqual({ n: 6, compiles: 1 });
      expect(other).toEqual({ n: 8, compiles: 1 });
      expect(runner.size()).toBe(2);
    } finally {
      await runner.dispose();
    }
  });

  test("recompiles cached callable when source changes", async () => {
    const runner = createIsolatedRunner({
      backend: "worker",
      pool: { idleMs: 0 },
    });
    try {
      const first = await runner.call<number>("math", "(n) => n * 2", [5]);
      const second = await runner.call<number>("math", "(n) => n * 3", [5]);

      expect(first).toBe(10);
      expect(second).toBe(15);
      expect(runner.size()).toBe(1);
    } finally {
      await runner.dispose();
    }
  });

  test("callable runner supports metrics and Reference args", async () => {
    const runner = createIsolatedRunner({
      backend: "worker",
      pool: { idleMs: 0 },
    });
    const calls: string[] = [];
    const log = new Reference((value: unknown) => {
      calls.push(String(value));
      return calls.length;
    });
    try {
      const measured = await runner.call<number>(
        "logAndCount",
        "async (log, value) => await log(value)",
        [log, "hello"],
        { withMetrics: true },
      );

      expect(measured.result).toBe(1);
      expect(measured.metrics.backend).toBe("worker");
      expect(calls).toEqual(["hello"]);
    } finally {
      await runner.dispose();
    }
  });

  test("precompiles callable cache before the first call", async () => {
    const runner = createIsolatedRunner({
      backend: "worker",
      globals: { offset: 10 },
      pool: { idleMs: 0 },
    });
    try {
      await runner.precompile("offsetAdd", "(n) => n + offset");
      expect(runner.size()).toBe(1);

      const result = await runner.call<number>(
        "offsetAdd",
        "(n) => n + offset",
        [32],
      );

      expect(result).toBe(42);
      expect(runner.size()).toBe(1);
    } finally {
      await runner.dispose();
    }
  });

  test("reports runner pool and callable cache stats", async () => {
    const runner = createIsolatedRunner({
      backend: "worker",
      pool: { idleMs: 0 },
    });
    try {
      expect(runner.stats()).toEqual({
        callableCacheSize: 0,
        callablesByKey: {},
        poolSize: 0,
      });

      await runner.precompile("double", "(n) => n * 2", { key: "tenant-a" });
      await runner.precompile("triple", "(n) => n * 3", { key: "tenant-a" });
      await runner.precompile("double", "(n) => n * 2", { key: "tenant-b" });

      expect(runner.stats()).toEqual({
        callableCacheSize: 3,
        callablesByKey: {
          "tenant-a": 2,
          "tenant-b": 1,
        },
        poolSize: 2,
      });

      await runner.dispose();

      expect(runner.stats()).toEqual({
        callableCacheSize: 0,
        callablesByKey: {},
        poolSize: 0,
      });
    } finally {
      await runner.dispose();
    }
  });

  test("precompile uses key-specific callable caches", async () => {
    const runner = createIsolatedRunner({
      backend: "worker",
      pool: { idleMs: 0 },
    });
    try {
      await runner.precompile("double", "(n) => n * 2", { key: "tenant-a" });
      await runner.precompile("double", "(n) => n * 2", { key: "tenant-b" });

      expect(runner.size()).toBe(2);
      expect(
        await runner.call<number>("double", "(n) => n * 2", [21], {
          key: "tenant-a",
        }),
      ).toBe(42);
      expect(
        await runner.call<number>("double", "(n) => n * 2", [12], {
          key: "tenant-b",
        }),
      ).toBe(24);
    } finally {
      await runner.dispose();
    }
  });

  test("precompile rejects invalid callable source", async () => {
    const runner = createIsolatedRunner({
      backend: "worker",
      pool: { idleMs: 0 },
    });
    try {
      const err = await rejection(runner.precompile("bad", "42"));

      expect(err).toBeInstanceOf(Error);
      expect(runner.size()).toBe(1);
    } finally {
      await runner.dispose();
    }
  });
});
