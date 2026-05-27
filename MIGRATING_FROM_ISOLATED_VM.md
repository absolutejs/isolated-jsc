# Migrating From Node `isolated-vm` To Bun `isolated-jsc`

Date: 2026-05-27

`@absolutejs/isolated-jsc` is for teams that already understand why
`isolated-vm` exists, but want the host application to run on Bun and
JavaScriptCore instead of Node and V8.

It is not a drop-in native binding for `isolated-vm`. It is an
`isolated-vm`-shaped Bun API with the same core nouns: `Isolate`, `Context`,
`Script`, `Reference`, and `ExternalCopy`.

## Runtime Difference

| Concern        | Node `isolated-vm`               | Bun `@absolutejs/isolated-jsc`                                      |
| -------------- | -------------------------------- | ------------------------------------------------------------------- |
| JS engine      | V8                               | JavaScriptCore                                                      |
| Host runtime   | Node                             | Bun                                                                 |
| Install path   | Native V8 addon                  | Bun package using JSC FFI when available, Worker fallback otherwise |
| Isolation unit | V8 isolate                       | JSC-backed isolate abstraction                                      |
| Primary wedge  | In-process V8 isolation for Node | In-process JSC isolation for Bun                                    |

`isolated-vm` cannot be the Bun answer because it is V8-specific. Bun uses
JavaScriptCore, so code that depends on V8 native symbols needs a different
implementation path.

## API Mapping

| `isolated-vm` concept              | `isolated-jsc` equivalent                | Migration note                                                                |
| ---------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------- |
| `new ivm.Isolate({ memoryLimit })` | `await createIsolate({ memoryLimit })`   | Creation is async because the backend may probe JSC or start a Worker.        |
| `isolate.createContext()`          | `await isolate.createContext()`          | Same high-level shape.                                                        |
| `isolate.compileScript(source)`    | `await isolate.compileScript(source)`    | Returns a `Script` with `run()` and `runWithMetrics()`.                       |
| `script.run(context, opts)`        | `await script.run(context, { timeout })` | Use millisecond wall-clock timeouts.                                          |
| `context.global.set(name, value)`  | `await context.setGlobal(name, value)`   | Globals are explicit context operations.                                      |
| `new ivm.Reference(fn)`            | `new Reference(fn)`                      | Host functions can be passed as args or installed as globals.                 |
| `new ivm.ExternalCopy(value)`      | `new ExternalCopy(value)`                | Use to mark host values intended for copy/pass-through.                       |
| `apply` / `applySync` style calls  | `Reference` calls from isolate code      | Prefer `await hostFn(...)` inside isolate code for portable backend behavior. |
| Compiled function dispatch         | `await context.compileCallable(source)`  | Compile a function expression once, then call it many times with `call()`.    |

## Basic Port

Node `isolated-vm` style:

```ts
import ivm from "isolated-vm";

const isolate = new ivm.Isolate({ memoryLimit: 128 });
const context = await isolate.createContext();
const script = await isolate.compileScript("1 + 1");
const result = await script.run(context, { timeout: 100 });
```

Bun `isolated-jsc` style:

```ts
import { createIsolate } from "@absolutejs/isolated-jsc";

const isolate = await createIsolate({ memoryLimit: 128 });
const context = await isolate.createContext();
const script = await isolate.compileScript("1 + 1");
const result = await script.run(context, { timeout: 100 });

await isolate.dispose();
```

The main mechanical change is that isolate creation is async and disposal is an
explicit part of the lifecycle.

## Host Functions

When porting host callbacks, model them as explicit capabilities. Do not expose
host objects broadly.

```ts
import { createIsolate, Reference } from "@absolutejs/isolated-jsc";

const isolate = await createIsolate({ memoryLimit: 128 });
const context = await isolate.createContext();

const query = new Reference(async (tenantId: string, sql: string) => {
  return await db.queryForTenant(tenantId, sql);
});

await context.setGlobal("query", query);

const script = await isolate.compileScript(`
  await query("tenant_123", "select count(*) from events")
`);

const rows = await script.run(context, { timeout: 500 });
```

For hot paths, prefer `compileCallable()` so you compile once and dispatch many
times:

```ts
const handler = await context.compileCallable(`
  async (tool, input) => {
    const normalized = String(input).trim();
    return await tool("normalize", normalized);
  }
`);

const tool = new Reference(async (op: string, value: string) => {
  if (op === "normalize") return value.toLowerCase();
  throw new Error(`unknown tool: ${op}`);
});

const result = await handler.call([tool, " Hello "], { timeout: 250 });
```

## TypeScript

Bun already has a fast TypeScript runtime story, but isolate execution should
receive JavaScript source. The recommended migration path is:

1. Use Bun's transpilation path for tenant/plugin TypeScript before isolate
   execution.
2. Use `tsc --noEmit` for editor and CI type-checking.
3. Run the emitted JavaScript in `isolated-jsc` with explicit `Reference`
   capabilities.

Do not frame this as "Bun uses `tsc` at runtime." Bun's runtime transpiler and
TypeScript's type checker are separate parts of the workflow.

## Backend Differences

`createIsolate({ backend: "auto" })` is the default. It uses the FFI backend
when JavaScriptCore is reachable and falls back to the Worker backend otherwise.

| Behavior                       | FFI backend                       | Worker backend                                  |
| ------------------------------ | --------------------------------- | ----------------------------------------------- |
| JSC dependency                 | Requires system/bundled libJSC    | Always available in Bun                         |
| Cold heap                      | Small JSC heap                    | One Bun Worker per isolate                      |
| Timeout recovery               | Isolate survives timeout          | Worker isolate terminates and must be respawned |
| Direct/indirect eval hardening | Eval disabled per context         | Hardened globals, with documented residuals     |
| Best use                       | Production Bun/JSC isolation path | Portable fallback and development path          |

If your Node `isolated-vm` architecture assumes an isolate survives timeouts,
pin or require the FFI backend. If you can tolerate respawn-on-timeout, the
Worker backend is a useful fallback.

## Security Migration Checklist

- Treat `Reference` values as the only authority bridge into the host.
- Keep tenant secrets outside the isolate; broker access through scoped host
  functions.
- Set a timeout on every untrusted execution.
- Set a memory limit per isolate.
- Use one isolate or pool key per tenant when state must not cross tenants.
- Capture metrics with `runWithMetrics()` / `callWithMetrics()` where billing,
  abuse detection, or debugging matter.
- Compose with process, container, uid, or network boundaries for arbitrary
  hostile code with high-value host secrets.

## Known Non-Goals

- It does not make Bun run V8 addons.
- It does not claim Cloudflare-grade multi-tenant platform isolation.
- It does not remove the need for OS/process isolation for fully adversarial
  code.
- It does not promise exact `isolated-vm` method parity.

## Suggested Porting Order

1. Replace isolate/context/script construction first.
2. Convert globals and callbacks into explicit `Reference` capabilities.
3. Move hot dispatch paths to `context.compileCallable()`.
4. Add timeout and memory limits everywhere.
5. Decide whether your workload requires FFI-only timeout recovery or can use
   Worker fallback.
6. Add regression tests for host authority, timeout behavior, memory overage,
   and error fidelity.

## Related Docs

- [README](./README.md)
- [BENCHMARKS](./BENCHMARKS.md)
- [MARKET_ANALYSIS](./MARKET_ANALYSIS.md)
