# Changelog

All notable changes to `@absolutejs/isolated-jsc` are documented here.

## 0.12.1 — 2026-07-17

### Added

- `AdaptiveHibernationPolicy.reconfigure()` validates a complete replacement
  configuration before atomically applying it, clamps the effective window,
  and clears partial evidence from the prior policy regime.
- `HibernatingIsolatePool.configureAdaptiveHibernation()` enables, replaces,
  or disables adaptation without replacing active contexts or deleting stored
  checkpoints. Transition hooks receive a `policy-reconfigured` event.

This is the hot control-plane seam: already-running pools can adopt new
governed bounds without a workload restart.

## 0.12.0 — 2026-07-17

### Added

- `createAdaptiveHibernationPolicy` converts repeated checkpoint residence,
  wake latency, and fresh-spawn latency observations into a bounded effective
  idle window. Repeated short-residence churn or wakes slower than fresh spawn
  back the window off; valuable long residence moves it earlier.
- `createHibernatingIsolatePool({ adaptiveHibernation })` applies that policy
  without changing fixed-window defaults. Metrics expose the current window,
  evidence score, adjustments, and reasons; transition hooks receive every
  applied policy adjustment.

The caller owns the hard minimum/maximum bounds. Adaptation cannot enable
hibernation when `hibernateAfterMs` is disabled and never moves outside those
bounds.

## 0.11.3 — 2026-07-17

### Fixed

- Fresh hibernating pools now discover checkpoints from persistent stores, so
  durable state actually survives a host process restart as the storage
  contract promises.
- Concurrent first calls for the same cold or persistently hibernated key now
  share one materialization instead of racing multiple isolate restores.

## 0.11.2 — 2026-07-17

### Fixed

- Exported `HibernatingPoolMetrics` from the package root. The public
  `pool.metrics()` method and changelog already promised this type, but the root
  declaration surface accidentally omitted it.

## 0.11.1 — 2026-07-17

### Added

- Hibernating-pool metrics now distinguish fresh materializations, successful
  hibernations, restore fallbacks, and hibernation failures, with the most
  recent spawn, hibernate, and wake durations.
- Transition events now carry checkpoint bytes and operation durations.

### Fixed

- Missing, unreadable, or incompatible stored checkpoints now fail safely to a
  fresh context instead of failing the tenant request or retaining bad state.

## 0.11.0 — 2026-05-30

### Added — OpenTelemetry tracing via @absolutejs/telemetry

Closes G2 (deep-research audit) for `createHibernatingIsolatePool`.

- **`HibernatingIsolatePoolOptions.tracerProvider?: TracerProvider`** —
  any `@opentelemetry/api`-compatible. Structural type via
  `@absolutejs/telemetry`; no peer-dep on `@opentelemetry/api`.
- **`isolated_jsc.run` span** per `pool.run(key, fn)`. Attributes:
  `abs.tenant` (the key), `isolated_jsc.woke_from_hibernation`
  (true on cold spawn AND on wake from hibernated), and
  `isolated_jsc.wake_ms` (when the entry actually woke from a
  hibernated checkpoint — the SLO-shaped signal customer SREs alert
  on). Status OK on success; ERROR + `recordException` on handler
  throw.
- The other pool methods (`hibernate`, `warm`, `dispose`, etc.) emit
  via the existing `onTransition` hook; OTel wiring stays focused on
  `run` so the customer trace has one span per work invocation.
- `@absolutejs/telemetry` added as a regular dep.
- Zero-cost when `tracerProvider` is omitted.

5 new tests in `tests/tracing.test.ts`: cold spawn / reuse / wake
from hibernation / handler throw / noop fallback.

## 0.10.0 - 2026-05-29

PaaS-substrate deepening. Backwards-compatible — new methods are
additive; existing call sites keep working.

### Added

- **`HibernatingIsolatePool.metrics()`** — operator-shaped snapshot for
  the PaaS host's metering loop. Point-in-time: `active`, `hibernated`,
  `total`, `inFlight`, `draining`. Cumulative counters since pool start:
  `hibernations`, `wakes`, `evictions`, `bytesHibernated`. Plus
  `lastWakeMs` as a coarse SLO signal — a wake taking seconds suggests
  checkpoint size blow-up or a slow store backend.
- **`HibernatingIsolatePool.drain()`** — refuse new keys (`run` /
  `warm` on an unknown key throws); active + hibernated entries keep
  serving existing callers. For graceful shard shutdown: drain, wait
  for `stats().total === 0`, then `dispose()`.
- **`HibernatingIsolatePool.warm(key)`** — materialize an active context
  ahead of expected work (wake from hibernation or spawn fresh) without
  invoking user code. Removes cold-start tail from a tenant's first
  request. Shares single-flight semantics with `run`.
- **`IsolatePool.metrics()`** — same shape pattern for the non-hibernating
  pool. Counters: `spawns`, `idleEvictions`, `lruEvictions`, `recycles`.
  Point-in-time: `size`, `inFlight`, `draining`.
- **`IsolatePool.drain()`** — same semantic on the simpler pool.
- **`HibernatingPoolMetrics` + `IsolatePoolMetrics`** types exported.

### Why this matters for the PaaS

`createHibernatingIsolatePool` is the multi-tenant economics primitive
("10k logical tenants, ~50 hot at any moment"). Pre-0.10 there was no
operator-shaped read — host could only sample `stats()`. 0.10's
`metrics()` feeds `@absolutejs/metering` directly: `bytesHibernated` is
storage cost, `wakes × lastWakeMs` is wake-latency tail risk,
`evictions` rate flags hot/cold churn. `drain()` matches the
`@absolutejs/runtime` drain pattern so a shard shutdown is symmetric
across both layers. `warm()` is the predictive pre-fetch path —
useful when the host knows ahead of time (cron, scheduled handler,
deploy promotion) that a tenant's context will be needed.

## 0.9.0 - 2026-05-29

### Added

- **`createHibernatingIsolatePool`** — SB-7 substrate for the eventual
  hosted Cloud bet. A keyed pool of isolate+context pairs that
  hibernates idle entries via the existing `context.checkpoint()` data
  primitive and wakes them transparently on the next call by passing
  the checkpoint back through `isolate.createContext({ checkpoint })`.
  Far more "tenant logical contexts" than physical isolates, because
  warm ones get serialized down to bytes when no one's calling them.
  Options: `maxSize` (active + hibernated cap, default 100),
  `hibernateAfterMs` (idle-trigger, default 60_000), `sweepIntervalMs`
  (default 5_000), `hibernationStore` (pluggable; default in-memory),
  `checkpointOptions` (forwarded to `context.checkpoint`),
  `onTransition` (observability hook for `hibernate`/`wake`/`evict`).
  `pool.run(key, fn)` resolves an active context (waking from a
  hibernated checkpoint or spawning fresh as needed) and atomically
  claims an in-flight slot before returning, so a concurrent
  `pool.hibernate(key)` can't race in between. `pool.stats()` returns
  `{ active, hibernated, total }`. Concurrent wakes share a
  single-flight promise — N callers don't spawn N isolates. LRU
  eviction at `maxSize` drops hibernated entries before active ones.
  Stores that lose the checkpoint between hibernate and wake fall back
  to fresh-spawn instead of throwing. 12 new tests; not a heap
  pause/resume image (per `SNAPSHOT_RESEARCH.md`).
- **`createInMemoryHibernationStore`** — the default backing store.
  Exported separately so consumers can wrap it for observability
  (route every `get`/`put`/`delete` through their metrics sink) or
  layer caches in front of a persistent store.

### Exports

- `createHibernatingIsolatePool`, `createInMemoryHibernationStore` and
  types `HibernatingIsolatePool`, `HibernatingIsolatePoolOptions`,
  `HibernatingPoolStats`, `HibernationEvent`, `HibernationStore`.

## 0.8.21 - 2026-05-28

### Added

- Added `context.checkpointWithReceipt(options)` and `isolate.createContextWithReceipt(options)` returning versioned `CheckpointReceipt` envelopes alongside the underlying checkpoint or restored context.
- Receipts carry `schemaVersion: 1`, `backend`, `operation: "create" | "restore"`, `executionId`, `startedAt`/`endedAt`/`durationMs`, `byteLength`, `included`, `skippedCount`, aggregated `skippedReasons` (`excluded`, `notClonable`, `overMaxBytes`), and optional `maxBytes`, `includeCount`, `excludeCount`, `sourceBackend`, `policy`, `purpose`, and `tenant` labels.
- Errors during checkpoint create or restore rethrow with the receipt attached at `error.receipt`, mirroring `script.runWithReceipt` and `callable.callWithReceipt`.
- Contract tests lock the schema-v1 checkpoint receipt key sets for create (full + minimal) and restore (success + error).
- Backend parity tests cover skip-reason counts, restore metadata, and the error receipt on Worker and FFI when available.

## 0.8.20 - 2026-05-28

### Added

- Added `validateContextCheckpoint()` and runtime restore validation so malformed persisted checkpoints fail before seed code runs.
- Added backend parity tests for checkpoint metadata, skip reasons, byte limits, and restore behavior on Worker and FFI when available.
- Added a runnable checkpoint persistence/resume example via `bun run example:checkpoint`.

## 0.8.19 - 2026-05-28

### Added

- Added explicit `context.checkpoint(options)` data checkpoints with `schemaVersion`, backend, byte length, included count, skipped count, and per-key skip reasons.
- Added `createContext({ checkpoint })` restore support alongside the existing `snapshot` restore path.
- Added checkpoint controls for `maxBytes`, `include`, and `exclude`.

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
