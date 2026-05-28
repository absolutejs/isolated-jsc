# Changelog

All notable changes to `@absolutejs/isolated-jsc` are documented here.

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
