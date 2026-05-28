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
import {
  createCapabilityAuditBuffer,
  createIsolate,
  Reference,
  ResultSizeError,
  type Isolate,
} from "../src";

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
    expect(metrics.backend).toBe("worker");
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
    expect(metrics.backend).toBe("worker");
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

  test("runWithReceipt returns result plus audit metadata on success", async () => {
    isolate = await createIsolate({ policy: "tenant-script" });
    const context = await isolate.createContext();
    const script = await isolate.compileScript("input.n * 2");
    await context.setGlobal("input", { n: 21 });

    const { result, receipt } = await script.runWithReceipt(context, {
      capabilityEvents: [
        { durationMs: 3, status: "success", tool: "lookupOrder" },
      ],
      executionId: "exec_test_success",
      purpose: "ai-tool-call",
      tenant: "tenant-a",
      timeout: 500,
    });

    expect(result).toBe(42);
    expect(receipt).toMatchObject({
      backend: "worker",
      capabilityCalls: [
        { durationMs: 3, status: "success", tool: "lookupOrder" },
      ],
      executionId: "exec_test_success",
      memoryLimitMb: 256,
      outputTruncated: false,
      policy: "tenant-script",
      purpose: "ai-tool-call",
      schemaVersion: 1,
      status: "success",
      tenant: "tenant-a",
      timeoutMs: 500,
    });
    expect(receipt.metrics?.backend).toBe("worker");
    expect(receipt.outputBytes).toBeGreaterThan(0);
    expect(Date.parse(receipt.startedAt)).not.toBeNaN();
    expect(Date.parse(receipt.endedAt)).not.toBeNaN();
  });

  test("runWithReceipt reports bounded capability audit truncation", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript("1");
    const audit = createCapabilityAuditBuffer({ maxEvents: 1 });
    audit.onAudit({
      context: undefined,
      input: undefined,
      status: "start",
      tool: "lookupOrder",
    });
    audit.onAudit({
      context: undefined,
      durationMs: 1,
      input: undefined,
      status: "success",
      tool: "lookupOrder",
    });

    const { receipt } = await script.runWithReceipt(context, {
      ...audit.receiptOptions(),
      executionId: "exec_bounded_capability_audit",
    });

    expect(receipt.capabilityCalls).toEqual([
      { status: "start", tool: "lookupOrder" },
    ]);
    expect(receipt.capabilityCallsDropped).toBe(1);
    expect(receipt.capabilityCallsTruncated).toBe(true);
  });

  test("runWithReceipt attaches receipt to thrown errors", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`throw new Error("boom")`);

    const err = (await rejection(
      script.runWithReceipt(context, {
        executionId: "exec_test_error",
        timeout: 500,
      }),
    )) as Error & { receipt?: { status: string; error?: { name: string } } };

    expect(err.message).toBe("boom");
    expect(err.receipt?.status).toBe("error");
    expect(err.receipt?.error?.name).toBe("Error");
  });

  test("runWithReceipt preserves host Reference error codes in receipts", async () => {
    isolate = await createIsolate({ backend: "worker" });
    const context = await isolate.createContext();
    await context.setGlobal(
      "failing",
      new Reference(() => {
        const error = new Error("capability rejected") as Error & {
          code?: string;
        };
        error.name = "CapabilityError";
        error.code = "CAPABILITY_OUTPUT_SIZE_LIMIT";
        throw error;
      }),
    );
    const script = await isolate.compileScript(`(async () => await failing())()`);

    const err = (await rejection(
      script.runWithReceipt(context, {
        executionId: "reference_error_code",
      }),
    )) as Error & { code?: string; receipt?: { error?: { code?: string } } };

    expect(err.name).toBe("CapabilityError");
    expect(err.code).toBe("CAPABILITY_OUTPUT_SIZE_LIMIT");
    expect(err.receipt?.error?.code).toBe("CAPABILITY_OUTPUT_SIZE_LIMIT");
  });

  test("maxResultBytes rejects oversized script results", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`"x".repeat(128)`);

    const err = (await rejection(
      script.runWithReceipt(context, {
        executionId: "oversized_result",
        maxResultBytes: 16,
      }),
    )) as ResultSizeError & { receipt?: { error?: { code?: string } } };

    expect(err).toBeInstanceOf(ResultSizeError);
    expect(err.code).toBe("RESULT_SIZE_LIMIT");
    expect(err.maxResultBytes).toBe(16);
    expect(err.observedBytes).toBeGreaterThan(16);
    expect(err.receipt?.error?.code).toBe("RESULT_SIZE_LIMIT");
  });

  test("runWithReceipt reports console entry overflow", async () => {
    const captured: unknown[][] = [];
    isolate = await createIsolate({
      maxConsoleEntries: 1,
      onConsole: (_level, args) => captured.push(args),
    });
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`
      console.log("first");
      console.log("second");
      42
    `);

    const { result, receipt } = await script.runWithReceipt(context);

    expect(result).toBe(42);
    expect(captured).toEqual([["first"]]);
    expect(receipt.console.entries).toBe(1);
    expect(receipt.console.entryLimitExceeded).toBe(true);
    expect(receipt.console.byteLimitExceeded).toBe(false);
    expect(receipt.console.truncated).toBe(true);
  });

  test("runWithReceipt reports console byte overflow", async () => {
    const captured: unknown[][] = [];
    isolate = await createIsolate({
      maxConsoleBytes: 8,
      onConsole: (_level, args) => captured.push(args),
    });
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`
      console.log("this message is too large");
      42
    `);

    const { result, receipt } = await script.runWithReceipt(context);

    expect(result).toBe(42);
    expect(captured).toEqual([]);
    expect(receipt.console.entries).toBe(0);
    expect(receipt.console.bytes).toBe(0);
    expect(receipt.console.byteLimitExceeded).toBe(true);
    expect(receipt.console.entryLimitExceeded).toBe(false);
    expect(receipt.console.truncated).toBe(true);
  });
});
