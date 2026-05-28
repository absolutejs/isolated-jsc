import { describe, expect, test } from "bun:test";
import {
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
