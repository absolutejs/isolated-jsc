# Bun Positioning: The Missing `isolated-vm` Layer

Date: 2026-05-28

## Summary

Bun already has a strong TypeScript application-runtime story: `.ts` files run
without a build step, Bun ships its own Worker implementation, and `bun:jsc`
exposes JavaScriptCore utilities. What Bun does not yet expose is an
embeddable, `isolated-vm`-class primitive for running untrusted JavaScript or
TypeScript inside a bounded heap with explicit host capabilities.

That is the market lane for `@absolutejs/isolated-jsc`.

The one-line frame:

> Bun makes TypeScript execution fast. `@absolutejs/isolated-jsc` makes
> untrusted TypeScript/JavaScript execution embeddable inside Bun.

## Why Bun Users Feel This Gap

The demand is already visible in Bun's own issue tracker:

- `oven-sh/bun#6617` asks for sandboxing permissions so Bun can run user
  scripts with restricted filesystem/network authority.
- `oven-sh/bun#25929` asks for secure Bun execution for AI-agent generated code,
  specifically to prevent file reads, unauthorized network calls, and process
  spawning.
- `oven-sh/bun#23653` shows the migration trap: teams try to bring
  `isolated-vm` into Bun projects, then hit native packaging/runtime failure
  because `isolated-vm` is a Node/V8 addon, not a JavaScriptCore solution.

The user pain is not "how do I eval code." That is easy. The pain is:

- Run generated code without giving it ambient `Bun`, `process`, filesystem,
  network, Worker, or shell authority.
- Bound runtime with timeouts and heap limits.
- Keep host apps in Bun instead of running a separate Node service just for
  `isolated-vm`.
- Broker host tools intentionally, with validation, timeouts, concurrency, and
  audit hooks.
- Keep latency and memory below the cost of process/container/microVM isolation
  for every small tenant script or AI tool call.

## What Existing Options Solve

| Option                                     | Good fit                                                | Why it is not the Bun answer                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new Function` / direct `eval`             | Trusted configuration snippets                          | No meaningful authority boundary. User code sees whatever the host global exposes.                                                                                  |
| Node `node:vm`                             | Convenience contexts for trusted or semi-trusted code   | Node's docs explicitly say it is not a security mechanism for untrusted code. It is also Node/V8, not Bun/JSC.                                                      |
| `vm2`                                      | Legacy Node plugin systems with carefully bounded trust | Proxy-based same-process sandboxing is fragile; the project recommends stronger boundaries for completely untrusted code.                                           |
| Node `isolated-vm`                         | Mature isolate-shaped API for Node users                | It is a V8 addon. It does not make Bun expose V8 isolates, and its own README says it is in maintenance mode.                                                       |
| Bun `Worker`                               | Portable separate-thread execution in Bun               | Workers share runtime-level I/O capabilities and are documented as experimental around termination. They are a useful substrate, not a complete capability sandbox. |
| OS process                                 | Stronger blast-radius boundary than in-process JS       | Higher startup cost, higher RSS, serialized IPC, and more operational surface for high-frequency scripts.                                                           |
| Container / gVisor / Firecracker           | Hostile arbitrary code with high-value host secrets     | Correct for hard isolation, too heavy as the default per-request embedding primitive.                                                                               |
| QuickJS / WASM JS engines                  | Portable isolated interpreter workloads                 | Different engine semantics from Bun/JSC and a weaker host integration story for Bun applications.                                                                   |
| Cloudflare Workers / workerd / Deno Deploy | Hosted or platform isolate execution                    | Excellent platforms, but they change the runtime and deployment model instead of embedding in a Bun server.                                                         |

## Where `isolated-jsc` Fits

`@absolutejs/isolated-jsc` should be presented as the middle tier:

- Stronger than `eval`, `new Function`, `node:vm`, or proxy sandboxing.
- Lighter and more embeddable than a process/container per script.
- Native to Bun and JavaScriptCore instead of Node and V8.
- Honest about when OS isolation is still required.

The product is intentionally two-layered:

| Backend         | Use it for                                                     | Tradeoff                                                                                                   |
| --------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| FFI / libJSC    | Production Bun/JSC isolation where JavaScriptCore is available | Best cold heap, eval disabling, sync host references, isolate survives timeouts; requires libJSC on Linux. |
| Worker fallback | Local dev, CI, demos, Windows, and hosts without libJSC        | Always available in Bun; timeouts terminate the Worker isolate and Worker residuals stay documented.       |

This lets the default path be portable while the production recommendation stays
clear: use FFI where hostile-code isolation matters, and compose it with
process/container/uid/seccomp/network policy when a sandbox escape would expose
meaningful host secrets.

## The Bun-Specific Story

Do say:

- Bun uses JavaScriptCore, so V8-native isolate packages are not the native
  answer.
- Bun can run TypeScript directly, and `@absolutejs/isolated-jsc` can compile
  tenant TypeScript into bounded isolate execution.
- Bun Workers are useful but not a full untrusted-code permissions model.
- The best Bun answer is a JavaScriptCore-native isolate layer plus explicit
  host capability brokering.

Do not say:

- "Bun uses `tsc` at runtime." It does not. Use `tsc --noEmit` for type-checking
  and Bun's transpilation/runtime path for execution.
- "`isolated-jsc` replaces containers." It does not. It reduces the need to
  containerize every small script, and it composes with OS isolation for hostile
  workloads.
- "Worker fallback is equivalent to FFI." It is not. It is the portability
  backend and a useful development/default path.

## Buyer Pain Points

### AI code execution

Agent platforms need to run model-generated snippets. The failure modes are
obvious: runaway loops, heap blowups, accidental file reads, network calls,
shell/process access, and host-tool misuse.

`isolated-jsc` frame: run the snippet in a bounded JSC isolate, expose only
named tools through `Reference` or `createCapabilityBroker`, and capture metrics
for abuse detection and billing.

### Tenant scripting

SaaS products want customer-authored transforms, formulas, policy checks,
workflow steps, and webhooks without deploying a custom service per customer.

`isolated-jsc` frame: one isolate or pool key per tenant, scoped host
capabilities, timeout, heap cap, per-run metrics, and deterministic teardown.

### Plugin evaluation

Build tools and internal platforms want plugins, but the host should not grant
ambient filesystem, network, process, or package-manager access to every plugin.

`isolated-jsc` frame: plugins get pure JS by default and must ask through
audited host capabilities for anything privileged.

### Node-to-Bun migration

Teams already using `isolated-vm` know the architecture they want, but the V8
addon does not become a Bun/JSC primitive.

`isolated-jsc` frame: port the isolate-shaped concepts: `Isolate`, `Context`,
`Script`, `Reference`, `ExternalCopy`, timeout, memory cap, and explicit
capabilities.

## Objection Handling

**"Why not wait for Bun permissions?"**

Bun-level permissions would be valuable, but they are runtime policy for a Bun
process. `isolated-jsc` is an embedding API: create many tenant isolates inside
one Bun app, pass host functions intentionally, pool them, and collect per-run
metrics.

**"Why not just use Workers?"**

Workers are the right portable substrate, and the fallback backend uses them.
But an untrusted-code product needs more: hardened globals, memory limits,
timeout semantics, pooled lifecycle, error fidelity, console capture, TypeScript
helpers, and explicit capability brokers.

**"Why not use Node `isolated-vm`?"**

Use it if the host runtime is Node and V8. If the host runtime is Bun and
JavaScriptCore, the native implementation path is different.

**"Is this secure enough for arbitrary hostile code?"**

Use FFI plus OS/process isolation when the host has high-value secrets or broad
network/filesystem authority. The correct claim is defense in depth, not magic
in-process containment.

## Launch Copy

Primary:

> The missing `isolated-vm` layer for Bun.

Expanded:

> Run untrusted JavaScript and TypeScript inside a bounded JavaScriptCore
> isolate, from a Bun host, with explicit capability brokering instead of
> ambient `Bun`/`process` access.

Technical:

> `@absolutejs/isolated-jsc` gives Bun apps an `isolated-vm`-shaped API on top
> of JavaScriptCore: `Isolate`, `Context`, `Script`, `Reference`, `ExternalCopy`,
> timeouts, heap caps, metrics, TypeScript helpers, and capability brokers.

Honest security:

> Use FFI for production Bun/JSC isolation, Worker fallback for portability, and
> compose with process/container boundaries for fully adversarial code.

## Sources Checked

- Bun Workers documentation: https://bun.com/docs/runtime/workers
- Bun TypeScript documentation: https://bun.com/docs/runtime/typescript
- Bun `bun:jsc` utilities: https://bun.com/docs/runtime/utils
- Node `node:vm` documentation: https://nodejs.org/api/vm.html
- `isolated-vm` repository: https://github.com/laverdet/isolated-vm
- `vm2` repository: https://github.com/patriksimek/vm2
- Bun sandboxing permissions issue: https://github.com/oven-sh/bun/issues/6617
- Bun `isolated-vm` package isolation issue:
  https://github.com/oven-sh/bun/issues/23653
- Bun AI-agent sandboxing issue: https://github.com/oven-sh/bun/issues/25929
