import type { IsolateOptions, RunOptions } from "./types";

export type IsolatePolicyName =
  | "ai-tool"
  | "tenant-script"
  | "plugin"
  | "trusted";

export type ResolvedIsolatePolicy = {
  name: IsolatePolicyName;
  description: string;
  isolate: Pick<IsolateOptions, "backend" | "harden" | "memoryLimit">;
  run: Required<Pick<RunOptions, "timeout">>;
  console: {
    capture: "drop" | "host";
  };
  fallback: {
    allowWorker: boolean;
    productionNote: string;
  };
};

export type ResolveIsolatePolicyOverrides = {
  backend?: IsolateOptions["backend"];
  harden?: IsolateOptions["harden"];
  memoryLimit?: IsolateOptions["memoryLimit"];
  timeout?: RunOptions["timeout"];
  captureConsole?: boolean;
  allowWorkerFallback?: boolean;
};

const policyDefaults = {
  "ai-tool": {
    console: { capture: "host" },
    description:
      "Model-generated or user-requested code with tight runtime, heap, and audit expectations.",
    fallback: {
      allowWorker: false,
      productionNote:
        "Require FFI in production and compose with an OS boundary when generated code can reach valuable host secrets.",
    },
    isolate: { backend: "ffi", harden: true, memoryLimit: 128 },
    name: "ai-tool",
    run: { timeout: 1000 },
  },
  "tenant-script": {
    console: { capture: "host" },
    description:
      "Customer-authored workflow, transform, formula, or policy code with explicit host capabilities.",
    fallback: {
      allowWorker: true,
      productionNote:
        "Prefer FFI for hostile tenants; Worker fallback is acceptable for trusted tenants or when an outer process/container boundary owns blast-radius control.",
    },
    isolate: { backend: "auto", harden: true, memoryLimit: 256 },
    name: "tenant-script",
    run: { timeout: 5000 },
  },
  plugin: {
    console: { capture: "host" },
    description:
      "Third-party plugin code where host powers should be explicit and reviewable.",
    fallback: {
      allowWorker: false,
      productionNote:
        "Require FFI for untrusted plugins; keep package manager, filesystem, network, and process powers behind brokered host tools.",
    },
    isolate: { backend: "ffi", harden: true, memoryLimit: 192 },
    name: "plugin",
    run: { timeout: 2000 },
  },
  trusted: {
    console: { capture: "drop" },
    description:
      "Trusted application code that needs cancellation, pooling, or heap accounting more than a hostile-code boundary.",
    fallback: {
      allowWorker: true,
      productionNote:
        "Use for trusted code only; hardening is off and host globals may be reachable.",
    },
    isolate: { backend: "auto", harden: false, memoryLimit: 512 },
    name: "trusted",
    run: { timeout: 30000 },
  },
} as const satisfies Record<IsolatePolicyName, ResolvedIsolatePolicy>;

const clonePolicy = (policy: ResolvedIsolatePolicy): ResolvedIsolatePolicy => ({
  console: { ...policy.console },
  description: policy.description,
  fallback: { ...policy.fallback },
  isolate: { ...policy.isolate },
  name: policy.name,
  run: { ...policy.run },
});

export const resolveIsolatePolicy = (
  name: IsolatePolicyName,
  overrides: ResolveIsolatePolicyOverrides = {},
): ResolvedIsolatePolicy => {
  const base = clonePolicy(policyDefaults[name]);

  if (overrides.backend !== undefined) base.isolate.backend = overrides.backend;
  if (overrides.harden !== undefined) base.isolate.harden = overrides.harden;
  if (overrides.memoryLimit !== undefined) {
    base.isolate.memoryLimit = overrides.memoryLimit;
  }
  if (overrides.timeout !== undefined) base.run.timeout = overrides.timeout;
  if (overrides.captureConsole !== undefined) {
    base.console.capture = overrides.captureConsole ? "host" : "drop";
  }
  if (overrides.allowWorkerFallback !== undefined) {
    base.fallback.allowWorker = overrides.allowWorkerFallback;
  }

  return base;
};
