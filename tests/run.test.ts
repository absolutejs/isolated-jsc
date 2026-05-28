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

  test("rejects after dispose", async () => {
    const runner = createIsolatedRunner({ backend: "worker" });
    await runner.dispose();

    const err = await rejection(runner.run("1 + 1"));

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("isolate pool has been disposed");
  });
});
