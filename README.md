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

`@absolutejs/isolated-jsc` fills that gap. See [ISSUES_WILL_CLOSE.md](./ISSUES_WILL_CLOSE.md) for the upstream issues this library _closes_ and [UPSTREAM_ISSUES.md](./UPSTREAM_ISSUES.md) for the upstream Bun bugs this library _works around_ (with cleanup instructions for when each is fixed).

## What ships today (v0.0.1, Phase 1)

A Bun-`Worker`-backed isolate with:

- **Heap isolation.** Each `Isolate` runs in its own Bun Worker → its own JSC VM → its own GC heap. No memory sharing with the host or with peer isolates.
- **`isolated-vm`-shaped API.** `Isolate`, `Context`, `Script`, `Reference`, `ExternalCopy`. Port-friendly.
- **Wall-clock timeouts.** `script.run(context, { timeout: 500 })` — millisecond accuracy, enforced from the host via `Worker.terminate()`. v1 trade-off: timeout terminates the entire isolate (pool at the app layer if you need to recycle).
- **Memory limits.** Soft cap polled every 50 ms via `bun:jsc.memoryUsage()`. Breach posts a fatal and self-terminates; the host rejects pending ops with `MemoryLimitError`.
- **Host-callable `Reference`s.** Expose host functions to the isolate. Calls round-trip via async message-passing (await on the isolate side).
- **`ExternalCopy`** for marking large host-side values for cheap pass-through.
- **Optional console capture.** `onConsole` hook to route isolate `console.log` calls back to the host (default: dropped, so untrusted code can't pollute host logs).

### What it ISN'T (v1 honest limits)

- **Not a full security boundary against adversarial code.** A determined attacker inside the worker can still reach `Bun` / `fetch` / `process` because those globals exist on the worker's `globalThis`. v1's contract is _heap isolation_ + _resource limits_, suitable for trusted-tenant scripting, AI agents under supervision, and plugin sandboxing. Adversarial AI-generated code needs Phase 2 (below).
- **CPU enforcement is millisecond-grained.** A worker doing a tight infinite loop blocks its own event loop until the host-side timer terminates it. No interrupt-driven preemption.
- **No prototype-pollution boundary within an isolate.** Multiple contexts in one isolate share JS prototypes. Use one isolate per tenant.

## What's planned (Phase 2, deferred)

A `bun:ffi` binding to a standalone `libJavaScriptCore` build. Will replace the Worker backend transparently — same API.

| Capability                   | Phase 1 (now)               | Phase 2 (planned)                            |
| ---------------------------- | --------------------------- | -------------------------------------------- |
| Heap isolation               | ✅ via Worker               | ✅ via separate JSC VM                       |
| CPU timeout                  | ms via `Worker.terminate()` | µs via `JSC::VM::interrupt()`                |
| Memory cap                   | polled 50ms (soft)          | enforced on-allocate (hard)                  |
| Host globals (`fetch`, etc.) | reachable inside worker     | not reachable — empty global object          |
| Prototype isolation          | one isolate per tenant      | per-context, even within an isolate          |
| Synchronous Reference calls  | not supported (use `await`) | supported via `Atomics.wait` + shared memory |

Phase 1 is enough for most use cases — AI agents, plugin sandboxing, multi-tenant scripting where the tenant trust level is "known user, not adversarial." Phase 2 is when you need Cloudflare-Workers-style hostile-code hardening.

## API

```ts
import {
  createIsolate,
  Reference,
  ExternalCopy,
  type Isolate,
  type Context,
  type Script,
} from "@absolutejs/isolated-jsc";

// Create an isolate (one per untrusted tenant).
const isolate: Isolate = await createIsolate({
  memoryLimit: 64, // MB; default 64
  bootstrap: "var foo = 1", // optional — runs once in the worker
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

await isolate.dispose();
```

### Errors

- `TimeoutError` — wall-clock budget elapsed.
- `MemoryLimitError` — heap exceeded the configured cap.
- `IsolateDisposedError` — operation on a disposed isolate.
- `CompileError` — syntax error in script source.

## Install

```bash
bun add @absolutejs/isolated-jsc
```

Requires Bun ≥ 1.3.

## Tests

```bash
bun install
bun test
```

11 tests covering compile, run, contexts, `Reference` call-through, `ExternalCopy`, timeout, memory cap, dispose idempotency, host-reachability documentation, and a hostile-tenant memory-bomb stress test.

## Related

- [`@absolutejs/sync`](https://github.com/absolutejs/sync) — reactive sync engine. Will eventually use this library to sandbox per-tenant mutation handlers in the hosted PaaS.
- [Bun docs: `bun:jsc`](https://bun.sh/docs/api/utils#bun-jsc) — the JSC primitives this library builds on.
- [`isolated-vm`](https://github.com/laverdet/isolated-vm) — the V8/Node equivalent this library mirrors (we owe Andrew Laverdet the API shape).

## License

CC BY-NC 4.0. Commercial licensing available — contact `l@nagy.vc`.
