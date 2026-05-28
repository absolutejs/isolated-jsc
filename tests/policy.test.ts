import { describe, expect, test } from "bun:test";
import { resolveIsolatePolicy } from "../src";

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
    expect(policy.console.capture).toBe("host");
    expect(policy.fallback.allowWorker).toBe(false);
  });

  test("tenant-script defaults are portable but hardened", () => {
    const policy = resolveIsolatePolicy("tenant-script");

    expect(policy.isolate.backend).toBe("auto");
    expect(policy.isolate.harden).toBe(true);
    expect(policy.isolate.memoryLimit).toBe(256);
    expect(policy.run.timeout).toBe(5000);
    expect(policy.fallback.allowWorker).toBe(true);
  });

  test("plugin defaults require FFI with explicit host powers", () => {
    const policy = resolveIsolatePolicy("plugin");

    expect(policy.isolate.backend).toBe("ffi");
    expect(policy.isolate.harden).toBe(true);
    expect(policy.isolate.memoryLimit).toBe(192);
    expect(policy.run.timeout).toBe(2000);
    expect(policy.fallback.allowWorker).toBe(false);
  });

  test("trusted defaults optimize for operational controls over hardening", () => {
    const policy = resolveIsolatePolicy("trusted");

    expect(policy.isolate.backend).toBe("auto");
    expect(policy.isolate.harden).toBe(false);
    expect(policy.isolate.memoryLimit).toBe(512);
    expect(policy.run.timeout).toBe(30000);
    expect(policy.console.capture).toBe("drop");
  });

  test("overrides return a copy without mutating future resolutions", () => {
    const custom = resolveIsolatePolicy("ai-tool", {
      allowWorkerFallback: true,
      backend: "auto",
      captureConsole: false,
      harden: false,
      memoryLimit: 64,
      timeout: 250,
    });

    expect(custom.isolate).toEqual({
      backend: "auto",
      harden: false,
      memoryLimit: 64,
    });
    expect(custom.run.timeout).toBe(250);
    expect(custom.console.capture).toBe("drop");
    expect(custom.fallback.allowWorker).toBe(true);

    const fresh = resolveIsolatePolicy("ai-tool");
    expect(fresh.isolate.backend).toBe("ffi");
    expect(fresh.isolate.harden).toBe(true);
    expect(fresh.isolate.memoryLimit).toBe(128);
    expect(fresh.run.timeout).toBe(1000);
    expect(fresh.console.capture).toBe("host");
    expect(fresh.fallback.allowWorker).toBe(false);
  });
});
