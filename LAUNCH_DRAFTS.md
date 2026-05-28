# Launch Drafts

Status: internal draft. Do not post yet.

Date: 2026-05-28

## Short Announcement Draft

Bun has a fast TypeScript runtime story, but teams running tenant scripts,
plugins, or AI-generated code still need a bounded execution layer that fits
Bun and JavaScriptCore.

`@absolutejs/isolated-jsc` is the missing `isolated-vm` layer for Bun: an
`isolated-vm`-shaped API on top of JavaScriptCore with `Isolate`, `Context`,
`Script`, `Reference`, `ExternalCopy`, timeouts, heap caps, per-run metrics,
TypeScript helpers, pools, and explicit host capability brokers.

It is intentionally honest about the boundary:

- Use the FFI backend for production Bun/JSC isolation where JavaScriptCore is
  available.
- Use the Worker fallback for portability, demos, local dev, CI, and hosts
  without libJSC.
- Add process, container, uid, seccomp, or network policy when a sandbox escape
  would expose meaningful host secrets.

The practical goal is simple: keep the host app in Bun, run untrusted
JavaScript/TypeScript in a bounded JSC isolate, and expose host powers only
through validated, audited capabilities.

## Technical Post Outline

Working title:

> The Missing `isolated-vm` Layer for Bun

### 1. The gap

- Bun runs TypeScript quickly and uses JavaScriptCore.
- Node `isolated-vm` is V8-specific, so it is not the native Bun answer.
- Teams still need bounded execution for AI snippets, tenant scripts, and
  plugins.
- The real question is not "how do I eval code"; it is "how do I run code
  without ambient host authority."

### 2. What existing options miss

- `eval` / `new Function`: no meaningful authority boundary.
- `node:vm`: useful context API, not a security mechanism for untrusted code.
- `vm2`: legacy proxy sandboxing, fragile for fully untrusted workloads.
- Node `isolated-vm`: right shape, wrong engine for Bun.
- Bun Workers: useful substrate, not a full capability product by itself.
- Process/container/microVM: strong isolation, higher startup/RSS/IPC cost.
- Hosted isolate platforms: strong products, but they change runtime and
  deployment shape.

### 3. The `isolated-jsc` shape

- `createIsolate({ memoryLimit })`
- `isolate.createContext()`
- `isolate.compileScript(source)`
- `script.run(context, { timeout })`
- `Reference` for host functions.
- `ExternalCopy` for explicit host value transfer.
- `runWithMetrics()` / `callWithMetrics()` for per-run telemetry.
- `compileTypeScript()` / `compileTypeScriptCallable()` for Bun-native TS
  workflows.

### 4. Why two backends

- FFI backend:
  - Direct JavaScriptCore integration.
  - Low cold heap.
  - Interrupt-driven timeout behavior.
  - Isolate survives timeout.
  - Eval / Function-constructor residuals closed.
- Worker fallback:
  - Always available in Bun.
  - Good for dev, demos, CI, Windows, and hosts without libJSC.
  - Timeout terminates the Worker isolate.
  - Residuals are documented; require OS boundaries for hostile workloads.

### 5. Capability brokering

- Never expose broad host objects.
- Pass named host tools through `Reference` or `createCapabilityBroker`.
- Validate inputs at the host boundary.
- Apply per-tool timeouts and concurrency.
- Capture audit events.
- Keep credentials and tenant secrets in the host, not in the isolate.

### 6. Security posture

- This is a defense-in-depth layer, not magic containment.
- For trusted tenant code or bounded customization, `auto` can be enough.
- For hostile-code production on macOS/Linux, require `ffi`.
- For arbitrary third-party code with high-value host secrets, compose with
  process/container/uid/seccomp/network policy.

### 7. Migration from Node `isolated-vm`

- Keep the same conceptual nouns.
- Convert globals/callbacks into explicit capabilities.
- Add timeouts and memory limits everywhere.
- Decide whether the workload needs FFI-only timeout recovery.
- Add regression tests for host authority, timeout behavior, memory overage, and
  error fidelity.

### 8. Close

- Bun already makes TypeScript execution fast.
- `@absolutejs/isolated-jsc` makes untrusted JavaScript/TypeScript execution
  embeddable inside Bun.
- Link to README, SECURITY, MIGRATING_FROM_ISOLATED_VM, BENCHMARKS, and the
  browser example.

## GitHub Issue Response Drafts

These are saved for later. Do not post until the package, docs, and example
story are final.

### `oven-sh/bun#6617` - sandboxing permissions

Draft:

> I hit the same product need while building tenant-script and AI-tool execution
> on Bun: run user code without ambient filesystem, network, `Bun`, `process`,
> Worker, or shell authority, while still allowing explicitly brokered host
> capabilities.
>
> I have been working on `@absolutejs/isolated-jsc`, a Bun/JavaScriptCore-native
> isolation layer with an `isolated-vm`-shaped API. It supports bounded isolates,
> wall-clock timeouts, heap caps, hardened globals, host `Reference`s,
> TypeScript helpers, per-run metrics, and capability brokers for validated host
> tools.
>
> It is not a replacement for a first-party Bun permissions model. The framing
> is complementary: runtime permissions would be valuable at the Bun process
> layer; `isolated-jsc` is an embedding API for many tenant isolates inside one
> Bun app. For hostile workloads with high-value host secrets, the docs still
> recommend composing with process/container/uid/network boundaries.
>
> Repo: https://github.com/absolutejs/isolated-jsc

### `oven-sh/bun#23653` - `isolated-vm` migration trap

Draft:

> This failure mode is the core reason I built `@absolutejs/isolated-jsc`.
> `isolated-vm` is the right API shape for a lot of Node workloads, but it is a
> V8 native addon. Bun is JavaScriptCore, so even if install succeeds, the native
> runtime path is not a Bun/JSC solution.
>
> `@absolutejs/isolated-jsc` ports the isolate-shaped concepts to Bun:
> `Isolate`, `Context`, `Script`, `Reference`, `ExternalCopy`, timeouts, memory
> caps, metrics, TypeScript helpers, and explicit host capability brokers.
>
> It is not a drop-in binary replacement for `isolated-vm`; it is the migration
> target when the host runtime is Bun and the isolation workload needs to move
> off Node/V8.
>
> Migration guide: https://github.com/absolutejs/isolated-jsc/blob/main/MIGRATING_FROM_ISOLATED_VM.md
> Repo: https://github.com/absolutejs/isolated-jsc

### `oven-sh/bun#25929` - AI-agent code execution

Draft:

> This is exactly the workload `@absolutejs/isolated-jsc` is aimed at:
> executing AI-generated JavaScript/TypeScript inside a bounded Bun/JSC isolate
> without giving the generated code ambient access to `Bun`, `process`,
> filesystem, network, Workers, or shell APIs.
>
> The package gives Bun apps an `isolated-vm`-shaped API plus the AI-tooling
> pieces we needed in practice:
>
> - wall-clock timeouts
> - heap caps
> - per-run metrics
> - console capture
> - TypeScript callable helpers
> - host `Reference`s
> - capability brokers with validation, per-tool timeouts, concurrency, tenant
>   context, and audit events
>
> Security framing is intentionally conservative. Use the FFI backend for
> production Bun/JSC isolation where JavaScriptCore is available, use Worker
> fallback for portability, and compose with OS/process/container boundaries
> when arbitrary hostile code could reach meaningful host secrets.
>
> Repo: https://github.com/absolutejs/isolated-jsc
> Security docs: https://github.com/absolutejs/isolated-jsc/blob/main/SECURITY.md

## Private Checklist Before Posting

- Confirm latest npm version and README package links.
- Confirm `bun run check:release` passes from a fresh checkout.
- Confirm `examples/isolated-jsc` smoke passes from a fresh checkout.
- Confirm docs deploy includes `isolated-jsc for Bun`.
- Re-read each draft for overclaiming.
- Replace "I have been working on" with team/product voice if posting from an
  organization account.
