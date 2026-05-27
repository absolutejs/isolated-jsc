# Security Model

Date: 2026-05-27

`@absolutejs/isolated-jsc` is a Bun-native isolation layer for running
untrusted or semi-trusted JavaScript with bounded heap, execution timeouts, and
explicit host capabilities.

This document is intentionally conservative. It describes what the package is
useful for, what it does not claim, and how to compose it with stronger
boundaries when the code is fully adversarial.

## Short Version

Use `isolated-jsc` when you need a middle tier between `new Function` /
`node:vm`-style evaluation and one-container-per-execution infrastructure.

Good fits:

- Tenant formulas, transforms, workflow steps, and policy snippets.
- AI-generated code/tools where host capabilities are explicitly brokered.
- Plugin evaluation where the plugin should not inherit ambient Bun/process
  authority.
- Bun apps migrating a Node `isolated-vm` workload to JavaScriptCore.

Use process/container/microVM isolation as well when arbitrary hostile code can
target high-value host secrets, the local filesystem, private network access, or
kernel/runtime escape paths.

## Threat Model

| Workload                                          | Recommended boundary                                                           | Why                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Trusted internal plugin                           | `isolated-jsc` with `harden: true`, timeout, memory limit                      | Reduces accidental authority and runaway-code risk.                                              |
| Semi-trusted tenant script                        | One isolate or pool key per tenant, explicit `Reference` capabilities, metrics | Keeps tenant state separated and host access brokered.                                           |
| AI-generated snippet                              | Fresh or pooled isolate, short timeout, low capability surface, audit logs     | Controls resource use and makes host tool calls explicit.                                        |
| Arbitrary hostile code with host secrets nearby   | `isolated-jsc` plus process/container/uid/network boundary                     | In-process isolation alone is not the right final boundary for high-value adversarial workloads. |
| Code that needs filesystem/network/process access | Brokered host tool API, not ambient globals                                    | Every capability should be intentionally scoped and logged.                                      |

## Backend Guarantees

`createIsolate({ backend: "auto" })` is the default. It uses the FFI backend
when a JavaScriptCore library is reachable and falls back to the Worker backend
otherwise.

| Concern                                     | FFI backend                                              | Worker backend                                                      |
| ------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| Runtime boundary                            | Direct JavaScriptCore context through `bun:ffi`          | One Bun Worker per isolate                                          |
| Heap isolation                              | Separate JSC heap                                        | Separate Worker/JSC heap                                            |
| Timeout behavior                            | JSC interrupt; isolate survives and can run again        | Worker is terminated; isolate must be respawned                     |
| Memory limit                                | Watchdog-polled JSC heap capacity; terminates on overage | Watchdog-polled `bun:jsc.memoryUsage`; terminates Worker on overage |
| Ambient `Bun`, `process`, `fetch`, `Worker` | Undefined under hardening                                | Undefined on blockable lookup paths under hardening                 |
| Direct `eval("Bun")`                        | Blocks when hardening is enabled                         | Undefined under hardening                                           |
| Indirect `(0, eval)("Bun")`                 | Blocks when hardening is enabled                         | Documented residual: reaches Worker global                          |
| `new Function("return Bun")()`              | Blocks when hardening is enabled                         | Documented residual: reaches Worker global                          |
| Web APIs                                    | Bare JSC APIs only; many Web APIs absent                 | Bun Worker Web APIs may exist unless hardened/blocked               |

For hostile-code work where the residuals matter, require the FFI backend:

```ts
const isolate = await createIsolate({
  backend: "ffi",
  harden: true,
  memoryLimit: 256,
});
```

If `backend: "ffi"` cannot find JavaScriptCore, creation throws instead of
silently falling back.

## Capability Model

The safest pattern is to expose no ambient authority. Put every host operation
behind a narrow `Reference`.

```ts
import { createIsolate, Reference } from "@absolutejs/isolated-jsc";

const isolate = await createIsolate({
  backend: "auto",
  harden: true,
  memoryLimit: 256,
});

const context = await isolate.createContext();

const tools = new Reference(async (name: string, input: unknown) => {
  if (name === "lookupOrder") {
    return await lookupOrderForTenant(input);
  }
  throw new Error(`unknown tool: ${name}`);
});

await context.setGlobal("tools", tools);

const script = await isolate.compileScript(`
  await tools("lookupOrder", { id: "ord_123" })
`);

const result = await script.run(context, { timeout: 500 });
```

Rules of thumb:

- Prefer `createCapabilityBroker()` for named host tools that need validation, per-tool timeouts, concurrency limits, tenant context injection, and audit events.
- Pass `Reference` functions, not raw host objects.
- Validate every input at the host boundary.
- Put authorization checks inside the host capability, not inside tenant code.
- Add per-tool timeouts and concurrency limits around slow host operations.
- Log tool name, tenant id, duration, and error status.
- Avoid `unsafelyExposeGlobals` unless the code is trusted and the capability
  is intentionally broad.

## Hardening Defaults

`harden` defaults to `true`.

With hardening enabled, host-capability globals such as `fetch`, `Bun`,
`process`, `Worker`, `WebSocket`, host `postMessage` / `addEventListener`,
`navigator`, and storage are stripped from the sandbox where the backend can
block them.

Safe JavaScript built-ins remain reachable: `Math`, `JSON`, `Date`, `Promise`,
`Map`, `Set`, typed arrays, and similar language-level primitives.

Set `harden: false` only for trusted code:

```ts
const isolate = await createIsolate({
  harden: false,
});
```

Use `unsafelyExposeGlobals` sparingly. Every exposed global is an unguarded
capability.

```ts
const isolate = await createIsolate({
  unsafelyExposeGlobals: ["fetch"],
});
```

Prefer a scoped `Reference` over exposing `fetch` directly, especially for
tenant or AI-generated code.

## Resource Controls

Always set a timeout for untrusted execution:

```ts
await script.run(context, { timeout: 500 });
```

Always set a memory limit appropriate to the backend and workload:

```ts
const isolate = await createIsolate({ memoryLimit: 256 });
```

Notes:

- The default memory limit is 256 MB.
- Very low limits can fail during Worker cold start because the Worker backend
  has a larger baseline heap.
- Memory enforcement is watchdog-polled, not a formal proof that allocation can
  never exceed the limit between samples.
- Timeout enforcement is wall-clock based.
- On Worker backend timeout or memory overage, the isolate is disposed and must
  be respawned.
- On FFI backend timeout, the isolate survives and can continue running later.

Use `runWithMetrics()` and `callWithMetrics()` where abuse detection, billing,
or operational debugging matters.

## Tenant Isolation Checklist

- Use one isolate or pool key per tenant when tenant state must not mix.
- Do not store host secrets inside the isolate.
- Do not place database clients, API clients, filesystem handles, or tokens
  directly in globals.
- Broker each host operation through a scoped `Reference`.
- Validate all data crossing from isolate to host.
- Set timeout and memory limits for every execution.
- Dispose or recycle isolates after errors, high memory growth, or a fixed
  number of calls.
- Capture logs through `onConsole` and attach tenant/run ids.
- Rate-limit tenant executions and host capability calls.
- Add regression tests for denied globals, timeout behavior, memory overage, and
  capability authorization.

## Deployment Hardening

For stronger hostile-code posture, compose `isolated-jsc` with platform
boundaries:

- Run the host service as a low-privilege user.
- Keep secrets out of environment variables visible to the execution process
  when possible.
- Use container, microVM, or process boundaries for high-risk tenants.
- Disable or restrict network egress at the process/container level.
- Put filesystem access behind a broker, or mount only a scratch directory.
- Enforce max concurrency per tenant and per process.
- Restart worker processes on suspicious crashes or memory growth.
- Keep Bun, JavaScriptCore/WebKitGTK, and the host OS patched.

## What This Does Not Claim

`isolated-jsc` does not claim:

- Browser/Cloudflare-grade multi-tenant platform isolation.
- Kernel, container, or process isolation.
- That in-process isolation is enough for arbitrary hostile code near
  high-value host secrets.
- Exact parity with Node `isolated-vm`.
- Perfect memory accounting under every JSC allocation path.
- That exposing ambient globals is safe for untrusted code.

## Reporting Security Issues

Do not file a public issue for a suspected vulnerability.

Send a private report to `l@nagy.vc` with:

- A minimal reproduction.
- Bun version, OS, and backend (`ffi`, `worker`, or `auto`).
- Whether `harden` was enabled.
- Any exposed globals or host `Reference` capabilities.
- Expected vs actual behavior.

## Related Docs

- [README](./README.md)
- [MIGRATING_FROM_ISOLATED_VM](./MIGRATING_FROM_ISOLATED_VM.md)
- [BENCHMARKS](./BENCHMARKS.md)
- [MARKET_ANALYSIS](./MARKET_ANALYSIS.md)
