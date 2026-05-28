import { describe, expect, test } from "bun:test";
import {
  createIsolate,
  resolveIsolatePolicy,
  ResultSizeError,
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

describe("resolveIsolatePolicy", () => {
  test("ai-tool defaults require FFI and tight resource limits", () => {
    const policy = resolveIsolatePolicy("ai-tool");

    expect(policy.name).toBe("ai-tool");
    expect(policy.isolate).toEqual({
      backend: "ffi",
      harden: true,
      memoryLimit: 128,
    });
    expect(policy.run.timeout).toBe(1000);
    expect(policy.recipe.run).toEqual({
      maxResultBytes: 65536,
      timeout: 1000,
    });
    expect(policy.recipe.console).toEqual({
      maxBytes: 16384,
      maxEntries: 32,
    });
    expect(policy.recipe.audit.maxEvents).toBe(100);
    expect(policy.recipe.broker).toEqual({
      defaultConcurrency: 8,
      defaultMaxOutputBytes: 65536,
      defaultTimeoutMs: 250,
    });
    expect(policy.recipe.pool).toEqual({
      idleMs: 60000,
      maxSize: 64,
      recycleAfter: 1000,
    });
    expect(policy.console.capture).toBe("host");
    expect(policy.fallback.allowWorker).toBe(false);
  });

  test("tenant-script defaults are portable but hardened", () => {
    const policy = resolveIsolatePolicy("tenant-script");

    expect(policy.isolate.backend).toBe("auto");
    expect(policy.isolate.harden).toBe(true);
    expect(policy.isolate.memoryLimit).toBe(256);
    expect(policy.run.timeout).toBe(5000);
    expect(policy.recipe.run.maxResultBytes).toBe(262144);
    expect(policy.recipe.audit.maxEvents).toBe(200);
    expect(policy.recipe.broker.defaultMaxOutputBytes).toBe(131072);
    expect(policy.recipe.pool.maxSize).toBe(128);
    expect(policy.fallback.allowWorker).toBe(true);
  });

  test("plugin defaults require FFI with explicit host powers", () => {
    const policy = resolveIsolatePolicy("plugin");

    expect(policy.isolate.backend).toBe("ffi");
    expect(policy.isolate.harden).toBe(true);
    expect(policy.isolate.memoryLimit).toBe(192);
    expect(policy.run.timeout).toBe(2000);
    expect(policy.recipe.broker.defaultConcurrency).toBe(4);
    expect(policy.recipe.console.maxBytes).toBe(32768);
    expect(policy.fallback.allowWorker).toBe(false);
  });

  test("trusted defaults optimize for operational controls over hardening", () => {
    const policy = resolveIsolatePolicy("trusted");

    expect(policy.isolate.backend).toBe("auto");
    expect(policy.isolate.harden).toBe(false);
    expect(policy.isolate.memoryLimit).toBe(512);
    expect(policy.run.timeout).toBe(30000);
    expect(policy.recipe.run.maxResultBytes).toBe(1048576);
    expect(policy.recipe.broker.defaultConcurrency).toBe(64);
    expect(policy.console.capture).toBe("drop");
  });

  test("overrides return a copy without mutating future resolutions", () => {
    const custom = resolveIsolatePolicy("ai-tool", {
      allowWorkerFallback: true,
      auditMaxEvents: 12,
      backend: "auto",
      brokerDefaultConcurrency: 3,
      brokerDefaultMaxOutputBytes: 4096,
      brokerDefaultTimeoutMs: 75,
      captureConsole: false,
      harden: false,
      maxConsoleBytes: 2048,
      maxConsoleEntries: 5,
      maxResultBytes: 8192,
      memoryLimit: 64,
      poolIdleMs: 1000,
      poolMaxSize: 2,
      poolRecycleAfter: 9,
      timeout: 250,
    });

    expect(custom.isolate).toEqual({
      backend: "auto",
      harden: false,
      memoryLimit: 64,
    });
    expect(custom.run.timeout).toBe(250);
    expect(custom.recipe).toEqual({
      audit: { maxEvents: 12 },
      broker: {
        defaultConcurrency: 3,
        defaultMaxOutputBytes: 4096,
        defaultTimeoutMs: 75,
      },
      console: { maxBytes: 2048, maxEntries: 5 },
      pool: { idleMs: 1000, maxSize: 2, recycleAfter: 9 },
      run: { maxResultBytes: 8192, timeout: 250 },
    });
    expect(custom.console.capture).toBe("drop");
    expect(custom.fallback.allowWorker).toBe(true);

    const fresh = resolveIsolatePolicy("ai-tool");
    expect(fresh.isolate.backend).toBe("ffi");
    expect(fresh.isolate.harden).toBe(true);
    expect(fresh.isolate.memoryLimit).toBe(128);
    expect(fresh.run.timeout).toBe(1000);
    expect(fresh.recipe.run).toEqual({
      maxResultBytes: 65536,
      timeout: 1000,
    });
    expect(fresh.recipe.audit.maxEvents).toBe(100);
    expect(fresh.recipe.broker.defaultConcurrency).toBe(8);
    expect(fresh.recipe.console.maxEntries).toBe(32);
    expect(fresh.recipe.pool.maxSize).toBe(64);
    expect(fresh.console.capture).toBe("host");
    expect(fresh.fallback.allowWorker).toBe(false);
  });
});

describe("createIsolate policy", () => {
  test("applies policy defaults while letting explicit isolate options win", async () => {
    const isolate = await createIsolate({
      backend: "worker",
      defaultRunOptions: { timeout: 1234 },
      memoryLimit: 256,
      policy: "trusted",
    });

    expect(isolate.backend).toBe("worker");
    expect(isolate.policy?.name).toBe("trusted");
    expect(isolate.options.memoryLimit).toBe(256);
    expect(isolate.defaultRunOptions.timeout).toBe(1234);

    await isolate.dispose();
  });

  test("uses policy run timeout as the per-isolate default", async () => {
    const policy = resolveIsolatePolicy("trusted", {
      memoryLimit: 256,
      timeout: 50,
    });
    const isolate = await createIsolate({ backend: "worker", policy });
    const context = await isolate.createContext();
    const script = await isolate.compileScript("while (true) {}");

    const err = await rejection(script.run(context));
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).timeoutMs).toBe(50);
    expect(isolate.isDisposed).toBe(true);
  });

  test("uses policy recipe max result bytes as the per-isolate default", async () => {
    const policy = resolveIsolatePolicy("trusted", {
      maxResultBytes: 8,
      memoryLimit: 256,
    });
    const isolate = await createIsolate({ backend: "worker", policy });
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`"this result is too large"`);

    const err = await rejection(script.run(context));

    expect(err).toBeInstanceOf(ResultSizeError);
    expect((err as ResultSizeError).maxResultBytes).toBe(8);
    expect(isolate.defaultRunOptions.maxResultBytes).toBe(8);
    await isolate.dispose();
  });

  test("preserves explicit console limits when applying policy defaults", async () => {
    const captured: unknown[][] = [];
    const isolate = await createIsolate({
      backend: "worker",
      maxConsoleEntries: 1,
      onConsole: (_level, args) => captured.push(args),
      policy: "tenant-script",
    });
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`
      console.log("first");
      console.log("second");
      1
    `);

    const { receipt } = await script.runWithReceipt(context);

    expect(captured).toEqual([["first"]]);
    expect(receipt.console.entryLimitExceeded).toBe(true);
    await isolate.dispose();
  });
});
