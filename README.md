# @absolutejs/isolated-jsc

> JavaScriptCore-native sandbox for Bun. Heap-isolated execution for untrusted code, with an `isolated-vm`-shaped API.

```ts
import { createIsolate, Reference } from "@absolutejs/isolated-jsc";

const isolate = await createIsolate({ memoryLimit: 64 });
const context = await isolate.createContext();

await context.setGlobal(
  "log",
  new Reference((msg) => console.log("[tenant]", msg)),
);

const script = await isolate.compileScript('await log("hello"); 1 + 1');
const result = await script.run(context, { timeout: 500 });
// result === 2

await isolate.dispose();
```

## Why this exists

Bun has no equivalent to Node's [`isolated-vm`](https://github.com/laverdet/isolated-vm). The Node library is V8-specific — it links against V8's `HasCustomHostObject` ABI symbol — and Bun uses [JavaScriptCore](https://trac.webkit.org/wiki/JavaScriptCore), not V8. So `bun install isolated-vm` succeeds, then `import` fails with `undefined symbol: HasCustomHostObject`.

This leaves an entire category of applications stranded on Node:

- **AI agent code execution.** Anthropic's `code_execution`, the OpenAI Code Interpreter, every "run this LLM-generated snippet" tool — these all need a heap-isolated runtime with hard resource limits. ([oven-sh/bun#25929](https://github.com/oven-sh/bun/issues/25929))
- **Multi-tenant scripting.** Cloudflare-Workers-style "your customer wrote some JS, run it scoped to their account."
- **Build-time evaluation of untrusted plugins.** ([oven-sh/bun#23653](https://github.com/oven-sh/bun/issues/23653))
- **General sandboxing permissions.** ([oven-sh/bun#6617](https://github.com/oven-sh/bun/issues/6617))

`@absolutejs/isolated-jsc` fills that gap. See [BUN_POSITIONING.md](./BUN_POSITIONING.md) for the Bun-focused strategic frame, [ISSUES_WILL_CLOSE.md](./ISSUES_WILL_CLOSE.md) for the upstream issues this library _closes_, and [UPSTREAM_ISSUES.md](./UPSTREAM_ISSUES.md) for the upstream Bun bugs this library _works around_ (with cleanup instructions for when each is fixed). See [MIGRATING_FROM_ISOLATED_VM.md](./MIGRATING_FROM_ISOLATED_VM.md) for the Node `isolated-vm` to Bun migration path. See [SECURITY.md](./SECURITY.md) for the threat model and hardening guidance. See [CHANGELOG.md](./CHANGELOG.md) for release notes.

## Quick answers

**Why not Node `isolated-vm`?** It is the right shape for Node/V8, but Bun is JavaScriptCore. `isolated-jsc` ports the isolate-shaped API to Bun/JSC instead of trying to load a V8 addon.

**Why not just use Bun Workers?** Workers are the portable substrate and the fallback backend. This package adds the sandbox product layer: hardened globals, heap limits, timeouts, metrics, error fidelity, TypeScript helpers, pools, and explicit host capability brokers.

**When should I require FFI?** Require `backend: "ffi"` for hostile-code production paths on macOS or Linux where JavaScriptCore is available. Use `backend: "auto"` for portable defaults, demos, and CI. Add process/container/uid/network boundaries whenever a sandbox escape would expose meaningful host secrets.

## What ships today (v0.8.0)

`@absolutejs/isolated-jsc` runs on two interchangeable backends behind one API:

- **FFI backend (default when libJSC is reachable)** — talks to `libJavaScriptCore` directly via `bun:ffi`. Cold heap ~300 KB, CPU timeouts use JSC's interrupt-driven watchdog (the isolate keeps running after a TimeoutError), and `(0, eval)('X')` / `new Function('return X')()` are blocked entirely via `JSGlobalContextSetEvalEnabled`. Available on macOS (system framework) + Linux with `libjavascriptcoregtk-4.1-0` or `libjavascriptcoregtk-6.0-1` installed.

- **Worker backend (fallback)** — one Bun `Worker` per isolate. Cold heap ~46 MB, timeout terminates the whole isolate. Always available (no system dependency). Default on Windows and any Linux without libJSC.

The two share every public type. Pick explicitly with `createIsolate({ backend: 'ffi' | 'worker' | 'auto' })`, or let `'auto'` (the default) probe for libJSC and fall back to Worker. Both backends:

- **Heap isolation.** Each `Isolate` runs in its own Bun Worker → its own JSC VM → its own GC heap. No memory sharing with the host or with peer isolates.
- **`isolated-vm`-shaped API.** `Isolate`, `Context`, `Script`, `Reference`, `ExternalCopy`. Port-friendly.
- **Wall-clock timeouts.** `script.run(context, { timeout: 500 })` — millisecond accuracy, enforced from the host via `Worker.terminate()`. v1 trade-off: timeout terminates the entire isolate (pool at the app layer if you need to recycle).
- **Memory limits.** Soft cap polled every 50 ms via `bun:jsc.memoryUsage()`. Breach posts a fatal and self-terminates; the host rejects pending ops with `MemoryLimitError`.
- **Hardened sandbox by default (T2.1, new in 0.1).** Host-capability globals — `fetch`, `Bun`, `process`, `Worker`, `WebSocket`, host `postMessage` / `addEventListener`, `navigator`, storage, … — are stripped from the sandbox. User code can't reach them via bare lookup, `globalThis.X`, `this.X`, or direct `eval('X')`. Pure JS built-ins (Math, JSON, Promise, the typed-array suite) and safe Web primitives (URL, TextEncoder, Web Crypto, setTimeout, console) stay reachable. Opt out per-isolate via `harden: false` for trusted code, or expose specific capabilities via `unsafelyExposeGlobals: ['fetch']`.
- **Host-callable `Reference`s.** Expose host functions to the isolate. Worker backend: calls always round-trip via async message-passing (use `await` on the isolate side). FFI backend (0.3+): sync host fns return their value directly through a per-Reference `JSCallback`. Async (Promise-returning) host fns work too on FFI (0.4+) — the runner alternately yields to Bun's event loop and drains JSC's microtask queue until the promise settles, bounded by `Script.run`'s `timeout`.
- **`ExternalCopy`** for marking large host-side values for cheap pass-through.
- **Optional bounded console capture.** `onConsole` routes isolate `console.log` calls back to the host. `maxConsoleEntries` and `maxConsoleBytes` bound forwarded logs, and receipts report overflow.
- **First-class isolate pool (T2.2, new in 0.1).** `createIsolatePool({ isolate, maxSize, idleMs, recycleAfter })` returns a keyed pool — lazy spawn per key, reuse across calls, LRU eviction at cap, transparent re-spawn after isolate self-termination, configurable post-N-call recycle to bound JSC heap creep. Replaces the bespoke per-tenant lookup-or-spawn map every consumer rolls.
- **Context seed + snapshot (T2.3, new in 0.1).** `createContext({ seed, snapshot })` runs setup code (assign onto `this`) and restores cloneable data state from a previous `context.snapshot()`. Pair them to fork a fresh context from a prior one's accumulated state (the AI-agent-across-turns pattern).
- **Error fidelity (T2.4, new in 0.1).** Errors thrown inside the isolate round-trip with `error.cause` (recursively) and enumerable own properties intact. Custom Error subclasses' instance data (`HttpError` with `.statusCode`, etc.) survives. `instanceof` doesn't work across the boundary; use `.name` / `.code` checks.
- **Per-run telemetry (T2.4, new in 0.1).** `script.runWithMetrics(ctx, opts)` returns `{ result, metrics: { backend, cpuMs, heapBytes } }` for billing / dashboards / per-call monitoring. Plain `run()` still returns the bare value.
- **Execution receipts.** `script.runWithReceipt()`, `callable.callWithReceipt()`, `runIsolated(..., { withReceipt: true })`, and runner receipt modes return local audit records with execution id, backend, policy, resource settings, timing, output size, and capability-call summaries.
- **Result size limits.** Pass `maxResultBytes` in run options to reject oversized successful outputs with `ResultSizeError` before application code accepts them.
- **Console output limits.** Pass `maxConsoleEntries` / `maxConsoleBytes` when creating an isolate to drop excess captured console events and surface overflow flags in receipts.
- **Backend observability.** `isolate.backend` reports the resolved backend (`"ffi"` or `"worker"`), `runWithMetrics()` / `callWithMetrics()` include `metrics.backend`, and `isolated-jsc doctor --json` emits machine-readable backend probe details.
- **Policy presets.** `createIsolate({ policy: "ai-tool" | "tenant-script" | "plugin" | "trusted" })` applies standardized isolate/run defaults; `resolveIsolatePolicy(name, overrides?)` returns the same policy object when you need to inspect or override it first.
- **One-shot execution.** `runIsolated(source, { policy, globals, context, run, withMetrics })` covers request/response paths that do not need to manage isolate lifecycle directly.
- **Reusable runners.** `createIsolatedRunner({ policy, globals, pool })` reuses isolates by key for hot tenant/session/conversation paths. Use `runner.run()` for fresh-context source execution, `runner.precompile()` to warm callables, `runner.call()` to compile once per key/name and call repeatedly, and `runner.stats()` to inspect pool/cache size.

### Bun sandboxing decision guide

| Use case                                                                         | Choose                                                               | Why                                                                                                                                   |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Local development, demos, CI smoke tests, or platforms without libJSC            | `backend: "auto"`                                                    | Uses FFI when available and Worker when it is not, so the same code runs everywhere.                                                  |
| Production untrusted code on macOS or Linux where you can install JavaScriptCore | `backend: "ffi"`                                                     | Lowest cold heap, interrupt-driven CPU timeouts, isolate survives timeouts, and eval / Function-constructor residuals are closed.     |
| Production untrusted code on Windows or hosts without system JavaScriptCore      | Worker fallback behind a process/container boundary                  | Worker keeps heap isolation and resource caps, but hostile workloads should not share host secrets or broad network/file permissions. |
| User plugins that need explicit host powers                                      | FFI plus `Reference` / capability broker                             | Keep the sandbox global small and expose only validated, audited host tools.                                                          |
| High-value secrets, arbitrary third-party code, or network-adjacent workloads    | FFI plus process, container, uid, seccomp, and network egress policy | JavaScript isolation is one layer; OS isolation still owns blast-radius control.                                                      |
| Trusted app code that only needs cancellation or tenant-level pooling            | Worker or FFI pool                                                   | Security posture matters less; optimize for deployment reach and operational simplicity.                                              |

Rule of thumb: use `backend: "ffi"` for hostile-code production paths, `backend: "auto"` for portable defaults, and add OS/process isolation whenever sandbox escape would expose meaningful host secrets.

### What it ISN'T (honest limits per backend)

| Path                                                           | FFI backend                                                        | Worker backend                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------- |
| `fetch(url)` (bare)                                            | **undefined**                                                      | **undefined**                           |
| `Bun.spawn(...)` (bare)                                        | **undefined**                                                      | **undefined**                           |
| `globalThis.fetch` / `globalThis.Bun`                          | **undefined**                                                      | **undefined**                           |
| `this.Bun`                                                     | **undefined**                                                      | **undefined**                           |
| `eval('Bun')` (direct)                                         | **blocks** (eval disabled per-context)                             | **undefined**                           |
| `(0, eval)('Bun')` (indirect)                                  | **blocks**                                                         | reachable — documented residual         |
| `new Function('return Bun')()`                                 | **blocks**                                                         | reachable — documented residual         |
| `Math.PI` / `JSON.stringify` / `Promise` / `crypto.randomUUID` | reachable                                                          | reachable                               |
| `URL` / `TextEncoder` / `WebSocket`                            | **not present** (JSC API only, no Web APIs)                        | reachable (Bun Worker exposes Web APIs) |
| Cold heap                                                      | ~300 KB                                                            | ~46 MB                                  |
| Timeout behaviour                                              | TerminationException thrown into script; **isolate keeps running** | isolate dies, must respawn              |
| Memory cap                                                     | watchdog-polled `heapCapacity`; terminates on overage              | polled 50 ms; terminates whole isolate  |
| Sync host fns via Reference                                    | **supported** (direct return)                                      | always wrapped in `await`               |
| Async (`Promise`) host fns via Reference                       | **supported** (0.4+) — pumped to settlement, bounded by `timeout`  | supported via `await`                   |
| Prototype isolation across contexts                            | one isolate per tenant                                             | one isolate per tenant                  |

### Installation note for the FFI backend

- **macOS**: zero install. JavaScriptCore is a system framework at `/System/Library/Frameworks/JavaScriptCore.framework`.
- **Linux** (Debian / Ubuntu): `sudo apt install libjavascriptcoregtk-4.1-0` (8 MB / 31 MB installed).
- **Linux** (Fedora): `sudo dnf install webkit2gtk4.1`.
- **Linux with Playwright already installed**: we accept Playwright's bundled `libjavascriptcoregtk-6.0.so.1` — no extra install.
- **Windows**: not supported (no system JSC, no realistic distribution path). `createIsolate({ backend: 'auto' })` falls back to Worker automatically; `backend: 'ffi'` throws `JscLibraryNotFoundError`.

## API

```ts
import {
  createCapabilityBroker,
  defineCapabilityTool,
  compileTypeScriptCallable,
  createIsolate,
  createIsolatedRunner,
  resolveIsolatePolicy,
  runIsolated,
  Reference,
  ExternalCopy,
  type Isolate,
  type Context,
  type Script,
} from "@absolutejs/isolated-jsc";

// Create an isolate (one per untrusted tenant).
const isolate: Isolate = await createIsolate({
  memoryLimit: 256, // MB; default 256
  bootstrap: "var foo = 1", // optional — runs once in the worker
  maxConsoleEntries: 100,
  maxConsoleBytes: 64_000,
  onConsole: (level, args) => console.log(`[iso/${level}]`, ...args),
});

// One or more contexts (fresh global scopes) per isolate.
const context: Context = await isolate.createContext();

// Expose a host function callable from inside the isolate.
const dbQuery = new Reference(async (sql: string) => {
  return await myDb.query(sql); // host-side call, tenant-scoped
});
await context.setGlobal("db", dbQuery);

// Compile + run.
const script: Script = await isolate.compileScript(`
	(async () => {
		const rows = await db('SELECT * FROM users');
		return rows.length;
	})()
`);

const count = await script.run(context, { timeout: 500 });
// count === number of rows

// TypeScript source: transpiled with Bun before execution in the isolate.
const handler = await compileTypeScriptCallable(
  context,
  "async (name: string): Promise<string> => name.trim().toUpperCase()",
);
await handler.call([" alex "]); // "ALEX"

type TenantContext = { id: string };
type LookupOrderInput = { id: string };
type Order = { id: string; status: string };

const broker = createCapabilityBroker(
  {
    lookupOrder: defineCapabilityTool<
      LookupOrderInput,
      Order | null,
      TenantContext
    >({
      description: "Read one order by id for the current tenant",
      risk: "read-only",
      input: { name: "LookupOrderInput" },
      output: "Order | null",
      timeoutMs: 250,
      validateInput: (input) => {
        if (input === null || typeof input !== "object") {
          throw new Error("lookupOrder input must be an object");
        }
        const id = (input as { id?: unknown }).id;
        if (typeof id !== "string") {
          throw new Error("lookupOrder input requires a string id");
        }
        return { id };
      },
      handler: async ({ id }, tenant) => await lookupOrder(tenant.id, id),
    }),
  },
  { context: { id: "tenant_123" } },
);

// Host-side direct calls are typed from the tool map.
const order = await broker.call("lookupOrder", { id: "ord_123" });
//    ^? Order | null

// Reviewable capability manifest for docs, audits, and agent/tool UIs.
broker.manifest();
// [{
//   name: "lookupOrder",
//   description: "Read one order by id for the current tenant",
//   risk: "read-only",
//   input: { name: "LookupOrderInput" },
//   output: "Order | null",
//   timeoutMs: 250,
//   hasInputValidator: true,
//   hasOutputValidator: false
// }]

// Sandbox calls still use an untrusted-code-safe Reference.
await context.setGlobal("tools", broker.reference);

// Policy presets standardize both isolate construction and default run timeout.
const policy = resolveIsolatePolicy("ai-tool", { timeout: 750 });
const policyIsolate = await createIsolate({ policy });
const policyContext = await policyIsolate.createContext();
const policyScript = await policyIsolate.compileScript("1 + 1");
await policyScript.run(policyContext);
await policyIsolate.dispose();

// One-shot execution for request/response paths.
const oneShot = await runIsolated<number>("input.n * 2", {
  policy: resolveIsolatePolicy("ai-tool", { timeout: 750 }),
  globals: { input: { n: 21 } },
});
// oneShot === 42

const measured = await runIsolated<number>("input.n + 1", {
  policy: "tenant-script",
  globals: { input: { n: 41 } },
  withMetrics: true,
});
// measured.result === 42; measured.metrics.backend === "ffi" | "worker"

const receipted = await runIsolated<number>("input.n + 1", {
  policy: "tenant-script",
  globals: { input: { n: 41 } },
  run: {
    executionId: "exec_123",
    maxResultBytes: 16_384,
    purpose: "ai-tool-call",
    tenant: "tenant_123",
  },
  withReceipt: true,
});
// receipted.result === 42
// receipted.receipt.status === "success"
// receipted.receipt.backend === "ffi" | "worker"

// Reusable runner for repeated request/response paths.
const runner = createIsolatedRunner({
  policy: "tenant-script",
  globals: { tools: broker.reference },
  pool: { maxSize: 64, idleMs: 60_000, recycleAfter: 1_000 },
});

const tenantResult = await runner.run<number>("input.n * 2", {
  key: "tenant_123",
  globals: { input: { n: 21 } },
});
// tenantResult === 42

await runner.precompile(
  "scoreFormula",
  "(input) => input.base * 2 + input.bonus",
  { key: "tenant_123" },
);

const callableResult = await runner.call<number>(
  "scoreFormula",
  "(input) => input.base * 2 + input.bonus",
  [{ base: 20, bonus: 2 }],
  { key: "tenant_123" },
);
// callableResult === 42
// runner.stats() === { poolSize: 1, callableCacheSize: 1, callablesByKey: { tenant_123: 1 } }

await runner.dispose();
await isolate.dispose();
```

### Errors

- `TimeoutError` — wall-clock budget elapsed.
- `MemoryLimitError` — heap exceeded the configured cap.
- `ResultSizeError` — successful output exceeded `maxResultBytes`.
- `IsolateDisposedError` — operation on a disposed isolate.
- `CompileError` — syntax error in script source.

## Install

```bash
bun add @absolutejs/isolated-jsc
```

Requires Bun ≥ 1.3.

## Doctor

```bash
bunx @absolutejs/isolated-jsc
bunx @absolutejs/isolated-jsc --json
# or, from this repo:
bun src/doctor.ts
```

The doctor prints Bun/platform details, FFI backend availability, JavaScriptCore flavor/path when found, checked library paths when missing, and the install hint for the current platform. Pass `--json` for machine-readable CI or deployment checks.

## Examples

```bash
bun run example:agent-tool
```

The agent-tool example combines TypeScript callable compilation, a capability broker, tenant context, tool timeouts, audit events, and per-call metrics.

## Benchmarks

```bash
bun run bench:proof
```

This writes `BENCHMARKS.md` with local measurements for the FFI backend, Worker backend, Bun process-spawn baseline, and Node `isolated-vm` when that optional native package is installed in the Node environment.

## Tests

```bash
bun install
bun test
```

The test suite covers compile/run, contexts, `Reference` call-through, `ExternalCopy`, timeout, memory caps, dispose idempotency, pool behavior, TypeScript helpers, capability brokers, FFI behavior, host-reachability documentation, and hostile-tenant stress cases.

## Release checks

```bash
bun run check:release
```

The release check runs the package typecheck, build, unit tests, agent-tool example, and the browser smoke in the sibling `../examples/isolated-jsc` app. Keep the `absolutejs/examples` repo checked out next to this package repo when cutting releases so the demo path is covered before publish.

## Related

- [`@absolutejs/sync`](https://github.com/absolutejs/sync) — reactive sync engine. Will eventually use this library to sandbox per-tenant mutation handlers in the hosted PaaS.
- [Bun docs: `bun:jsc`](https://bun.sh/docs/api/utils#bun-jsc) — the JSC primitives this library builds on.
- [`isolated-vm`](https://github.com/laverdet/isolated-vm) — the V8/Node equivalent this library mirrors (we owe Andrew Laverdet the API shape).

## License

CC BY-NC 4.0. Commercial licensing available — contact `l@nagy.vc`.
