# Product Advancements

Date: 2026-05-28

Status: internal product research and implementation queue.

## Research Read

The market is moving in two directions at once:

1. **Managed or OS-level hard isolation** for fully adversarial code. Riza
   positions against `isolated-vm` / `vm2` by offloading execution behind an
   HTTP API. Recent agent-sandboxing work like Sandlock focuses on filesystem,
   network, IPC, and syscall policy with low startup overhead. WASM/WASI
   research around MCP tools focuses on safe execution plus runtime evidence of
   external-to-output exposure.
2. **Embeddable runtime primitives** for apps that cannot send every tenant
   script or AI tool call to a remote service or microVM. Bun has Workers and
   `bun:ffi`, but Bun documents Workers as experimental, especially around
   termination, and documents `bun:ffi` as experimental with known limitations.

That creates the product lane:

> `isolated-jsc` should become the Bun-native embedded execution layer with
> explicit policy, auditable capability use, and honest backend risk reporting.

## Current Product Strengths

- `isolated-vm`-shaped API for Bun/JSC.
- FFI backend closes Worker residuals and keeps isolates alive after timeouts.
- Worker fallback keeps local/dev/CI portability.
- TypeScript helper path.
- Capability broker with validation, timeout, concurrency, tenant context, and
  audit events.
- Release gate now includes package tests plus the browser example smoke.

## Product Gaps Worth Closing

### 1. Policy presets

Today users assemble sandbox posture from options and docs:

```ts
createIsolate({ backend: "ffi", memoryLimit: 128 });
```

Better product shape:

```ts
createIsolate({
  policy: "ai-tool" | "tenant-script" | "plugin" | "trusted",
});
```

Each preset should expand to:

- backend preference
- default timeout
- default memory limit
- hardening mode
- console behavior
- result/output size limits
- whether Worker fallback is allowed

Implementation notes:

- Add a pure `resolveIsolatePolicy(policy, overrides)` helper first.
- Keep raw options available so existing users are not locked into presets.
- Expose resolved policy metadata in doctor and metrics.
- Start with docs-only presets if API churn feels risky, then promote to API.

### 2. Execution receipts

Today `runWithMetrics()` returns `{ result, metrics }`. That is useful, but
agent/code-execution buyers increasingly need an auditable receipt.

Target shape:

```ts
const receipt = await script.runWithReceipt(context, {
  timeout: 500,
  tenant: "tenant_acme",
  purpose: "ai-tool-call",
});
```

Receipt fields:

- execution id
- backend
- policy
- timeout / memory limit
- start/end timestamps
- duration/cpu/heap metrics
- console summary and truncation flags
- capability calls made through brokers
- success/error status
- error name/message/code
- output size and truncation flags

Implementation notes:

- Build on `runWithMetrics()` and capability broker audit events.
- Do not log source code by default; make source hashing optional.
- Keep receipt generation pure and local. No telemetry export yet.

### 3. Output and console limits

Current resource controls are CPU-ish timeout and heap cap. Product users also
need output boundaries:

- `maxResultBytes`
- `maxConsoleBytes`
- `maxConsoleEntries`
- `onConsoleOverflow`

These prevent a tenant from returning or logging a giant payload that becomes a
host memory/logging problem after isolate execution succeeds.

Implementation notes:

- Start with console capture in Worker and FFI.
- Add a structured `ConsoleOverflowError` or a receipt flag rather than silently
  dropping data.
- For results, estimate structured-clone JSON size as a pragmatic first pass.

### 4. Capability manifests

The broker currently validates runtime inputs, which is good. The next product
step is a manifest that lets teams review what powers a sandboxed handler can
ask for before it runs.

Target shape:

```ts
const broker = createCapabilityBroker(
  {
    lookupOrder: defineCapabilityTool({
      description: "Read one order by id for the current tenant",
      risk: "read-only",
      timeoutMs: 250,
      validateInput,
      handler,
    }),
  },
  { context },
);

broker.manifest();
```

Manifest fields:

- tool name
- description
- risk level
- timeout
- concurrency
- input/output schema label or validator name

Implementation notes:

- Keep it non-breaking by making metadata optional.
- This directly supports docs, audits, UI display, and future MCP-style tool
  descriptions.

### 5. Backend health and fallback telemetry

`auto` is convenient, but production teams need to know when they unexpectedly
fell back to Worker.

Advancements:

- `createIsolate({ backend: "auto", onBackendSelected })`
- expose `isolate.backend`
- include backend in `RunMetrics` and future receipts
- doctor command emits machine-readable JSON with `--json`

Implementation notes:

- `doctor --json` is likely the fastest valuable addition.
- `isolate.backend` is a small API improvement with high operational value.

### 6. Fresh-isolate execution helper

Many AI/code-execution use cases want no state reuse:

```ts
await runIsolated(source, {
  policy: "ai-tool",
  timeout: 500,
  memoryLimit: 128,
});
```

Implementation notes:

- Build on `createIsolate`, `createContext`, `compileScript`, `run`, `dispose`.
- Always dispose in `finally`.
- Offer `runIsolatedTypeScript()` as a thin helper later.
- This is easy to explain and hard to misuse.

### 7. FFI capability parity checks

FFI is the production recommendation, so tests should assert parity for all
core user-facing APIs:

- `Context.setGlobal`
- `Context.getGlobal`
- `Context.snapshot`
- `Context.compileCallable`
- `Reference`
- `ExternalCopy`
- `runWithMetrics`
- TypeScript helpers
- pool integration

Implementation notes:

- Existing tests cover much of this, but the suite still reads as split between
  Worker-default tests and FFI-special tests.
- Add a backend matrix test helper for API parity.

## Prioritized Implementation Queue

### P0: Small API wins

1. Add `isolate.backend`.
2. Add `doctor --json`.
3. Add backend to `RunMetrics`.

Why now:

- Improves production observability immediately.
- Low risk.
- Supports later receipts/policy work.

### P1: Policy + receipts foundation

1. Add `resolveIsolatePolicy()`.
2. Add optional policy presets to `createIsolate`.
3. Add `runWithReceipt()` for scripts and callables.

Why now:

- Moves from raw primitive to product.
- Aligns with agent sandboxing research around auditable execution.
- Makes launch claims easier to prove.

### P2: Output boundaries

1. Add console entry/byte limits.
2. Add result byte limits.
3. Add truncation metadata to receipts.

Why now:

- Resource control is incomplete without output control.
- It is easy for tenants to abuse logs/results without escaping the sandbox.

### P3: Capability productization

1. Add optional tool metadata. **Done in 0.8.1.**
2. Add `broker.manifest()`. **Done in 0.8.1.**
3. Add manifest example and docs. **Done in 0.8.1.**

Why now:

- Makes host powers reviewable.
- Helps future MCP/agent integration.

### P4: OS-boundary integration

Do not build a container platform yet. First build the seam:

- document `runIsolated` inside process/container boundaries
- expose receipt fields useful to a supervisor
- keep policy vocabulary compatible with future seccomp/network integration

Why later:

- It is a larger product surface.
- The current embedded Bun/JSC lane is still the differentiator.

## Recommended Next PR

Start with P0:

- `isolate.backend`
- backend in metrics
- `isolated-jsc doctor --json`

This gives users and examples a way to prove whether they are on FFI or Worker
without scraping text output. It also lays the metadata foundation for receipts.

Acceptance criteria:

- Public `Isolate` type has readonly `backend: "ffi" | "worker"`.
- Worker and FFI implementations set it correctly.
- `RunMetrics` includes `backend`.
- Doctor supports human output by default and JSON output with `--json`.
- Unit tests cover both backends where available.
- README and SECURITY mention backend observability.

## Sources Checked

- Bun FFI docs: https://bun.com/docs/runtime/ffi
- Bun Workers docs: https://bun.sh/docs/runtime/workers
- Riza comparison page: https://riza.io/compare/isolated-vm-alternative
- Sandlock paper: https://arxiv.org/abs/2605.26298
- MCP-SandboxScan paper: https://arxiv.org/abs/2601.01241
