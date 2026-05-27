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

## Current Product Gaps

Highest leverage dev work before a stronger public push:

1. **Market proof bench**

   - Bench `isolated-jsc` FFI vs Worker backend vs Node `isolated-vm` vs
     `child_process` for:
     - cold isolate/context creation
     - warm compiled callable
     - host function call round trip
     - heap footprint
     - timeout recovery
   - Publish results in repo and docs.

2. **Bun migration guide**

   - "Moving from Node `isolated-vm` to Bun `isolated-jsc`."
   - Map `Isolate`, `Context`, `Script`, `Reference`, `ExternalCopy`,
     timeouts, metrics, and unsupported differences.

3. **Security model doc**

   - Threat model table: trusted plugin, semi-trusted tenant script,
     arbitrary hostile code.
   - Explicit backend differences.
   - Hardening checklist: separate process, uid/container, network egress
     policy, secret broker, rate limits, max concurrency.

4. **TypeScript execution story**

   - Add first-class helper for pre-transpiling TypeScript through Bun before
     isolate execution, with source maps and diagnostics policy.
   - Keep `tsc --noEmit` as type-checking guidance, not runtime framing.

5. **Capability broker primitives**

   - Standard helper for defining host tools with:
     - schema validation
     - timeout per tool call
     - concurrency limits
     - structured audit log
     - optional tenant context injection

6. **Package ergonomics**
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
- TypeScript execution helper or documented recipe.
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
