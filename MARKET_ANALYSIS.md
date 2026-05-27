# Market Analysis: Bun-native JavaScript Isolation

Date: 2026-05-27

## Thesis

`@absolutejs/isolated-jsc` should be positioned as the missing
`isolated-vm`-class primitive for Bun: an embeddable, JavaScriptCore-native
sandbox for AI code execution, tenant scripting, plugin evaluation, and
server-side customization.

The market already believes in isolates. Cloudflare Workers and Deno Deploy use
V8 isolates as their platform substrate, and Node users have `isolated-vm` for
process-local isolate-style embedding. Bun is different: it is JavaScriptCore
based, not V8 based, so the V8 ecosystem does not directly carry over.

## Market Map

| Option                               | Runtime             | What it solves                                                      | Pain point for Bun users                                                                                                        |
| ------------------------------------ | ------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Node `node:vm`                       | Node/V8 contexts    | Convenient evaluation contexts                                      | Node's own docs say it is not a security mechanism and should not run untrusted code.                                           |
| `vm2`                                | Node/V8 + proxies   | Higher-level in-process sandbox                                     | Same-process proxy sandboxing remains fragile; the project itself says completely untrusted code should use stronger isolation. |
| `isolated-vm`                        | Node/V8 isolates    | Embeddable V8 isolate API with memory/time tooling                  | V8-specific; does not give Bun/JSC users a native path.                                                                         |
| Cloudflare Workers / `workerd`       | V8 isolate platform | Production isolate platform, edge deployment, multi-tenant dispatch | Platform/runtime, not a small embeddable Bun package. Changes app architecture and API surface.                                 |
| Deno Deploy / Subhosting             | V8 isolate platform | Hosted isolate execution                                            | Hosted Deno/V8 path, not Bun/JSC embedding.                                                                                     |
| QuickJS / WASM engines               | QuickJS/WASM        | Portable sandbox-like evaluation                                    | Different JS engine semantics and weaker fit for Bun-native apps; usually slower bridge and less host integration.              |
| OS processes / containers / microVMs | Any                 | Strong isolation boundary                                           | Higher cold start, higher memory, IPC-heavy for per-request or per-tenant scripting.                                            |
| `@absolutejs/isolated-jsc`           | Bun/JavaScriptCore  | Embeddable JSC isolate-shaped API for Bun                           | Young library; needs stronger docs, benches, hardening proof, and clearer compatibility claims.                                 |

## Why Bun Is The Wedge

Bun's runtime docs state that Bun uses Apple's JavaScriptCore engine, while Node
and Chromium-based runtimes use V8. Bun also transpiles TypeScript and JSX on the
fly with its native transpiler. That gives Bun a fast app/runtime story, but not
a V8 isolate embedding story.

The TypeScript nuance matters for framing: do not say "Bun uses tsc." Bun's docs
recommend TypeScript compiler options for editor/type-checking compatibility,
but runtime execution uses Bun's native transpiler. The sharper claim is:

> Bun has a fast TypeScript runtime story, but no Bun-native equivalent of
> `isolated-vm` for embedders who need to run untrusted TypeScript/JavaScript
> inside a bounded heap with host capabilities explicitly brokered.

## Bun Positioning Proof

The strongest Bun-specific wedge is not generic sandboxing. It is the gap between Bun as a fast TypeScript application runtime and Bun as an embeddable runtime for untrusted user code.

| Bun workload                      | What teams try first                                                        | Why it hurts                                                             | isolated-jsc framing                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| AI tool/code execution            | Spawn Bun per snippet, containerize each run, or stay on Node `isolated-vm` | High cold start/IPC cost, split runtime stack, weak host-tool ergonomics | Keep the host app in Bun, run generated JS in a bounded JSC isolate, broker tools through `Reference`    |
| Tenant scripts and automations    | `new Function`, `node:vm`, plugin hooks, or external workers                | Ambient authority, unclear teardown, no per-tenant heap story            | One isolate/pool key per tenant with timeout, heap cap, metrics, and explicit capabilities               |
| User plugins                      | Run plugins inside the host process or force a separate service             | Plugins can see too much or require a runtime migration                  | Bun-native plugin evaluation with no ambient `Bun`, `process`, filesystem, network, or Worker by default |
| TypeScript-authored customization | Transpile with Bun, then run in-process without a real boundary             | Fast TS loading exists, but execution isolation is missing               | Let Bun own transpilation/type-check workflows; let isolated-jsc own bounded execution                   |
| Node migration                    | Keep the isolation workload on Node because `isolated-vm` is V8-only        | Two runtimes, duplicated deployment, no clean Bun port                   | Present `isolated-jsc` as the porting target for isolate-shaped APIs on JavaScriptCore                   |

This is the launch frame to keep repeating:

> Bun already makes TypeScript execution fast. `@absolutejs/isolated-jsc` makes untrusted TypeScript/JavaScript execution embeddable inside Bun.

The proof obligations behind that frame are:

- Reproducible local benchmarks against Worker, process-spawn, and optional Node `isolated-vm` baselines.
- A migration guide for teams that know the `isolated-vm` API shape but want to move the host runtime to Bun.
- A security model that explains when in-process JSC isolation is enough and when to compose it with process, container, uid, or network boundaries.
- A TypeScript recipe that uses Bun for transpilation and `tsc --noEmit` for type-checking, without implying Bun uses `tsc` at runtime.

## Pain Points To Speak To

1. **AI-generated code execution**

   - Developers want "run this code" tools for agents without spinning a
     container for every snippet.
   - Needs: timeout, heap cap, console capture, host tool references,
     cancellation, per-run metrics, clear teardown.

2. **Tenant scripting**

   - SaaS products want customer-authored workflows, formulas, transforms, and
     policy snippets.
   - Needs: per-tenant heap isolation, scoped host capabilities, pooling, audit
     logs, deterministic error reporting.

3. **Plugin evaluation**

   - Build tools, data tools, and internal platforms need to execute third-party
     plugin code with fewer privileges than the host process.
   - Needs: no ambient `Bun`, `process`, filesystem, spawn, network, or Worker
     access unless explicitly exposed.

4. **Bun adoption blocker**

   - Node apps using `isolated-vm` cannot move this workload to Bun.
   - Existing options either leave Bun, leave the process, or leave JSC.

5. **Operational economics**
   - Containers and microVMs are defensible for hostile-code security, but they
     are too heavy for high-frequency, low-latency in-process customization.
   - The target buyer wants a middle tier: stronger than `node:vm`/proxy
     sandboxing, lighter than containers, native to Bun.

## Positioning

Primary message:

> `@absolutejs/isolated-jsc` is the Bun-native isolation layer for teams that
> need to run untrusted JavaScript without leaving JavaScriptCore.

Secondary messages:

- "The missing `isolated-vm` for Bun."
- "Cloudflare-style isolate ergonomics, embeddable inside a Bun server."
- "Broker host tools explicitly; expose no ambient Bun/process/filesystem by
  default."
- "For serious hostile-code isolation, compose with process/container
  boundaries. For tenant scripts and AI tools inside Bun, start here."

Avoid overclaiming:

- Do not claim browser/Cloudflare-grade tenant security.
- Do not claim strict memory accounting beyond current backend guarantees.
- Do not say Bun uses `tsc` at runtime.
- Do not imply this replaces containers for adversarial code with high-value
  secrets in-process.

## Progress

- 2026-05-27: Fixed the callable reuse test to use the current default memory
  limit instead of a stale 64 MB cap. This keeps the worker backend test suite
  aligned with the documented 256 MB worker default and makes the suite green
  again.
- 2026-05-27: Shipped the benchmark proof pack in `BENCHMARKS.md` with FFI,
  Worker, Bun process-spawn, and optional Node `isolated-vm` baselines.
- 2026-05-27: Added TypeScript execution helpers that use Bun native
  transpilation before compiling scripts/callables for isolate execution.
- 2026-05-27: Added capability broker primitives for named host tools with
  validation hooks, timeouts, concurrency limits, tenant context, and audit events.

## Current Product Gaps

Highest leverage dev work before a stronger public push:

1. **Package ergonomics**
   - Improve install detection and error messages for Linux JSC packages.
   - Add `isolated-jsc doctor`.
   - Add a tiny `bun run examples/agent-tool.ts` demo.

## Recommended Next Release

Target: `@absolutejs/isolated-jsc@0.7.0`

Theme: "Bun-native isolate proof pack"

Ship:

- `BENCHMARKS.md` with reproducible scripts and competitor baselines.
- `SECURITY.md` with honest threat model and hardening guidance.
- `MIGRATING_FROM_ISOLATED_VM.md`.
- TypeScript execution helpers.
- Capability broker primitives for named host tools.
- One agent-tool demo that mirrors how `@absolutejs/sync` uses
  `sandboxedHandler`.

## Sources Checked

- Bun runtime docs: https://bun.com/docs/runtime
- Bun TypeScript docs: https://bun.com/docs/runtime/typescript
- Node `vm` docs: https://nodejs.org/api/vm.html
- `isolated-vm` npm metadata: https://www.npmjs.com/package/isolated-vm
- vm2 repository/security disclaimer: https://github.com/patriksimek/vm2
- Cloudflare Workers isolate docs:
  https://developers.cloudflare.com/workers/reference/how-workers-works/
- Deno docs / Deno Deploy positioning: https://docs.deno.com/ and
  https://deno.com/deploy/
- npm metadata checked locally on 2026-05-27:
  - `isolated-vm@6.1.2`
  - `vm2@3.11.5`
  - `workerd@1.20260527.1`
  - `quickjs-emscripten@0.32.0`
  - `@webcontainer/api@1.6.4`
