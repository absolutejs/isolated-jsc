# Changelog

All notable changes to `@absolutejs/isolated-jsc` are documented here.

## 0.8.18 - 2026-05-28

### Added

- Added file-based TypeScript/source helpers so scripts and default-export callables can live in real `.ts`, `.tsx`, `.js`, or `.jsx` files instead of string literals: `readSourceFile()`, `transpileSourceFile()`, `compileTypeScriptFile()`, `transpileSourceFileCallable()`, and `compileTypeScriptCallableFile()`.
- Added `runIsolatedFile()` and runner methods `runFile()`, `precompileFile()`, and `callFile()` for one-shot and pooled file-backed execution.

## 0.8.17 - 2026-05-28

### Added

- Added `SNAPSHOT_RESEARCH.md`, documenting why JavaScriptCore's public C API supports data checkpoints but not a V8-style heap pause/resume snapshot.

### Changed

- Tightened README and type docs to frame `Context.snapshot()` as a data checkpoint, not a JSC heap image.

## 0.8.16 - 2026-05-28

### Added

- Added policy recipe helper builders: `policyAuditOptions()`, `policyBrokerOptions()`, `policyConsoleOptions()`, `policyRunOptions()`, and `policyRunnerOptions()` return copy-safe option objects for wiring recipes into audit buffers, capability brokers, isolates, one-shot runs, and runners.

## 0.8.15 - 2026-05-28

### Added

- Added packaged policy recipes to resolved policies, covering recommended result limits, console limits, audit buffer caps, capability broker caps, and runner pool settings for `ai-tool`, `tenant-script`, `plugin`, and `trusted`.
- Policy-created isolates now inherit the recipe `maxResultBytes` as a default run option, while per-call `maxResultBytes` overrides still win.

## 0.8.14 - 2026-05-28

### Changed

- Expanded broker redaction examples in the README and agent-tool demo to show default redactors, per-tool overrides, masked emails, opaque token redaction, and processor trace redaction.

## 0.8.13 - 2026-05-28

### Added

- Added contract tests for `schemaVersion: 1` capability manifest entries and execution receipts so future audit-surface shape changes are intentional.

## 0.8.12 - 2026-05-28

### Added

- Added `schemaVersion: 1` to capability manifest entries and execution receipts so applications can parse and persist these audit surfaces against an explicit stable schema version.

## 0.8.11 - 2026-05-28

### Fixed

- Preserved host `Reference` error metadata on the FFI backend, including capability `code`, `tool`, and output-size fields when synchronous throws or async rejections cross through JavaScriptCore and execution receipts.

## 0.8.10 - 2026-05-28

### Fixed

- Preserved enumerable host `Reference` error properties, including capability `code`, when errors cross into sandbox code and back into execution receipts.

## 0.8.9 - 2026-05-28

### Added

- Added capability output size limits. Tools now support `maxOutputBytes`, brokers support `defaultMaxOutputBytes`, manifests show the effective cap, and oversized host-tool outputs reject with `CapabilityError` code `CAPABILITY_OUTPUT_SIZE_LIMIT` before returning to sandbox code.

## 0.8.8 - 2026-05-28

### Fixed

- Made `createCapabilityAuditBuffer().receiptOptions()` expose lazy dropped/truncated values so receipts observe the final audit count after sandbox execution completes.

## 0.8.7 - 2026-05-28

### Added

- Added `createCapabilityAuditBuffer({ maxEvents })` for bounded capability audit collection. Receipts now support optional `capabilityCallsDropped` and `capabilityCallsTruncated` metadata so apps can prove audit events were capped instead of retaining unbounded arrays.

## 0.8.6 - 2026-05-28

### Added

- Added capability audit redaction hooks. Brokers now support default `redactAuditInput` / `redactAuditOutput` callbacks, tools can override them per capability, and manifests report whether each capability redacts audited inputs or outputs.

## 0.8.5 - 2026-05-28

### Fixed

- Preserved explicit `maxConsoleEntries` and `maxConsoleBytes` when applying policy presets.

## 0.8.4 - 2026-05-28

### Added

- Added console output boundaries: `maxConsoleEntries` and `maxConsoleBytes` limit forwarded `onConsole` events, and execution receipts now include console entry/byte counts plus overflow flags.

## 0.8.3 - 2026-05-28

### Added

- Added `maxResultBytes` run option for scripts, callables, one-shot execution, and reusable runners. Oversized successful outputs now reject with `ResultSizeError` before application code accepts them.

## 0.8.2 - 2026-05-28

### Added

- Added execution receipts for scripts, callables, one-shot `runIsolated()`, and reusable runners. Receipts include execution id, backend, policy, tenant/purpose labels, timing, timeout/memory settings, output size, metrics on success, error summary on failure, and capability-call summaries.

## 0.8.1 - 2026-05-28

### Added

- Added capability manifests: `defineCapabilityTool()` now accepts optional review metadata and `broker.manifest()` returns a serializable list of declared host powers for audits, docs, and agent/tool UIs.

## 0.8.0 - 2026-05-28

### Added

- Added backend observability: every isolate now exposes `isolate.backend`, per-run metrics include `metrics.backend`, and `isolated-jsc doctor --json` emits machine-readable backend/JSC probe details.
- Added `resolveIsolatePolicy()` with `ai-tool`, `tenant-script`, `plugin`, and `trusted` presets, plus `createIsolate({ policy })` support that applies preset isolate options and default run timeouts.
- Added `runIsolated()` for one-shot policy-aware execution with optional globals, context options, run options, and metrics.
- Added `createIsolatedRunner()` for pooled policy-aware execution keyed by tenant, session, or conversation, including `runner.precompile()` and `runner.call()` for cached compiled callables plus `runner.stats()` for pool/cache observability.

## 0.7.3 - 2026-05-27

### Changed

- Added this changelog to the package repo and linked it from the README.
- Added `CHANGELOG.md` to published package files so npm tarballs include release history.

## 0.7.2 - 2026-05-27

### Added

- Added typed direct calls for capability brokers: `broker.call("tool", input)` now infers the known tool output type from the tool map.
- Exported `CapabilityBrokerCall` and `CapabilityBrokerFor` for users who want to name the typed broker surface.

### Changed

- Kept unknown or dynamic tool names on a fallback `Promise<unknown>` path so runtime behavior and sandbox `Reference` usage remain unchanged.
- Updated README and AbsoluteJS docs examples to show the typed `defineCapabilityTool()` plus typed `broker.call()` flow.

## 0.7.1 - 2026-05-27

### Added

- Added `defineCapabilityTool()` so validator-returned input types flow into capability handlers without handler-side casts.
- Added `InferCapabilityInput`, `InferCapabilityOutput`, and `InferCapabilityContext` helper types.

### Changed

- Updated the agent-tool example and capability tests to use typed capability definitions.

## 0.7.0 - 2026-05-27

### Added

- Added the benchmark proof pack covering the FFI backend, Worker backend, Bun process-spawn baseline, and optional Node `isolated-vm` baseline.
- Added Bun-focused market analysis and positioning for teams that need an `isolated-vm`-shaped runtime on JavaScriptCore.
- Added a migration guide for moving Node `isolated-vm` workloads to Bun with `@absolutejs/isolated-jsc`.
- Added expanded security guidance for backend choice, Worker residuals, resource limits, and deployment hardening.
- Added TypeScript execution helpers for scripts and reusable callables before isolate execution.
- Added the capability broker for named host tools with validation hooks, timeout, concurrency, tenant context, and audit events.
- Added the doctor CLI bin for backend/JSC diagnostics and platform install hints.
- Added the runnable agent-tool example combining TypeScript callables, brokered tools, tenant context, metrics, and audit events.

### Changed

- Normalized package metadata for the public npm release.
