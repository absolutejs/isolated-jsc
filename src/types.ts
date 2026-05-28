/**
 * Public API surface for `@absolutejs/isolated-jsc`. Types only — no runtime
 * yet. Review this first, then we wire the Worker-backed v1 implementation
 * behind it.
 *
 * Shape mirrors `isolated-vm` so anyone porting from Node + isolated-vm gets
 * familiar ergonomics. Backends are swappable:
 *   v1 (now): Bun `Worker` per isolate, soft resource limits via
 *             setTimeout + bun:jsc.memoryUsage polling
 *   v2 (later): bun:ffi to a standalone libJSC build with hard limits +
 *               interrupt-driven CPU + microtask budgets
 *
 * Anything in this file is the durable contract. Anything in `./worker.ts`
 * (the v1 backend) is implementation detail that v2 will replace without
 * users noticing.
 */

import type { IsolatePolicyName, ResolvedIsolatePolicy } from "./policy";

/** Backend implementation selected for an {@link Isolate}. */
export type IsolateBackend = "ffi" | "worker";

/** Construction options for an {@link Isolate}. */
export type IsolateOptions = {
  /**
   * Product posture preset to apply before explicit options. Pass a preset
   * name for the built-in defaults, or a {@link ResolvedIsolatePolicy} from
   * {@link resolveIsolatePolicy} when you need overrides.
   *
   * Explicit `IsolateOptions` fields win over the preset, so
   * `createIsolate({ policy: "ai-tool", memoryLimit: 256 })` keeps the
   * AI-tool timeout/hardening defaults but raises the heap cap.
   */
  policy?: IsolatePolicyName | ResolvedIsolatePolicy;
  /**
   * Per-isolate defaults for {@link Script.run}, {@link Script.runWithMetrics},
   * {@link Callable.call}, and {@link Callable.callWithMetrics}. Call-level
   * options still win. Policy recipes populate this with their runtime
   * timeout and result-size limit.
   */
  defaultRunOptions?: Pick<RunOptions, "maxResultBytes" | "timeout">;
  /**
   * Hard cap on heap memory (MB). When the isolate's heap exceeds this, the
   * isolate is terminated and any in-flight `script.run` rejects with
   * {@link MemoryLimitError}. v1 enforces via polled
   * `bun:jsc.memoryUsage` (soft + millisecond-grained); v2 will enforce via
   * libJSC's heap settings (synchronous, on-allocate).
   *
   * Defaults to 256 MB. The Bun worker's cold-start heap is ~46 MB steady
   * state on Bun 1.3.x, but under load (parallel workers, busy host) the
   * watchdog occasionally measures transient spikes near ~140 MB before
   * JSC's GC settles. Caps below ~256 MB will sometimes fire the limit
   * during cold-start and the isolate self-terminates before user code
   * runs. Use small caps only when you've measured your specific
   * workload's actual heap profile under realistic load.
   */
  memoryLimit?: number;
  /**
   * Bootstrap script run once when the isolate spawns, before any user code.
   * Use this to expose host-provided globals via {@link Reference}s or to
   * install polyfills.
   */
  bootstrap?: string;
  /**
   * `onConsole` hook — if user code calls `console.log` etc inside the
   * isolate, where do those messages go? Defaults to dropping them silently
   * (untrusted code shouldn't pollute host logs). Pass a function to capture.
   */
  onConsole?: (level: "log" | "warn" | "error", args: unknown[]) => void;
  /**
   * Maximum number of console events to forward through `onConsole` for this
   * isolate. Extra entries are dropped and reflected in execution receipts.
   */
  maxConsoleEntries?: number;
  /**
   * Maximum JSON-encoded console payload bytes to forward through `onConsole`
   * for this isolate. Extra entries are dropped and reflected in receipts.
   */
  maxConsoleBytes?: number;
  /**
   * Strip host-capability globals from the sandbox. Default `true`. When on,
   * the sandbox cannot reach `fetch`, `Bun`, `process`, `Worker`,
   * `WebSocket`, `navigator`, host `postMessage`/`addEventListener`, etc.
   * via bare lookup, `this.X`, `globalThis.X`, or direct `eval(X)`.
   *
   * Documented residual: `(0, eval)('Bun')` and `new Function('return Bun')()`
   * still escape because indirect-eval and the Function constructor run in
   * the worker's real global scope. Removing them would break async
   * functions, class generators, and most async libraries. This will close
   * in the FFI rewrite (v2) where the sandbox has its own global object.
   *
   * Pure JS built-ins (Math, JSON, Date, Promise, Map, Set, …) and safe
   * Web primitives (URL, TextEncoder, crypto.{getRandomValues,randomUUID,subtle},
   * setTimeout, console) stay reachable.
   *
   * Set `false` to keep the v0.0.1 behaviour where the worker's full
   * globalThis is exposed (useful only for trusted code).
   */
  harden?: boolean;
  /**
   * When {@link harden} is on, names from the hardened list to keep
   * reachable anyway. Use sparingly — every entry is an unguarded
   * capability. Typical use: `['fetch']` for a sandbox that needs to make
   * HTTP calls but should otherwise be locked down.
   */
  unsafelyExposeGlobals?: string[];
  /**
   * Pick the backend explicitly.
   *
   * - `"auto"` (default): try FFI first (direct libJavaScriptCore via
   *   `bun:ffi`); fall back to the Worker backend if libJSC isn't reachable
   *   (Windows, Linux without `libjavascriptcoregtk` installed, etc).
   * - `"ffi"`: require FFI; throw {@link JscLibraryNotFoundError} if libJSC
   *   isn't available.
   * - `"worker"`: always use the Worker backend, even when FFI would work.
   *   Useful as an escape hatch.
   *
   * The FFI backend is strictly better when available: cold heap is ~300 KB
   * vs ~46 MB, the two T2 documented residuals (`(0, eval)('Bun')` and
   * `new Function('return Bun')()`) are closed via
   * `JSGlobalContextSetEvalEnabled`, timeouts use JSC's interrupt-driven
   * watchdog (the isolate keeps running after a TimeoutError), and value
   * marshalling skips the Worker postMessage clone path.
   */
  backend?: "auto" | "ffi" | "worker";
};

/**
 * A V8-Isolate-equivalent: separate JavaScriptCore VM with its own heap. No
 * memory or value sharing with the host or with other isolates — values cross
 * the boundary via structured clone or {@link Reference} call-through.
 *
 * Disposing the isolate terminates its worker, frees its heap, and rejects any
 * pending operations. Holding a reference to a disposed isolate is safe but
 * every method on it will throw.
 */
export type Isolate = {
  /** Construction options the isolate was built with. */
  readonly options: Readonly<Required<Pick<IsolateOptions, "memoryLimit">>>;
  /** Runtime defaults applied when a run/call omits the corresponding option. */
  readonly defaultRunOptions: Readonly<
    Required<Pick<RunOptions, "timeout">> & Pick<RunOptions, "maxResultBytes">
  >;
  /** Resolved policy used to construct this isolate, when one was supplied. */
  readonly policy?: ResolvedIsolatePolicy;
  /** Backend selected for this isolate after `auto` resolution. */
  readonly backend: IsolateBackend;
  /** `true` once {@link dispose} has been called or the isolate self-died. */
  readonly isDisposed: boolean;

  /**
   * Compile a JS source string in the isolate's VM. Returns a {@link Script}
   * you can run any number of times against any {@link Context} from this
   * isolate. The compile happens on the isolate side — syntax errors throw
   * here as {@link CompileError}.
   */
  compileScript: (source: string) => Promise<Script>;

  /**
   * Create a fresh execution {@link Context} — a new global scope that shares
   * the isolate's VM but starts with the standard globals only (no leaked
   * host references, no leaked previous-script bindings).
   *
   * Optional {@link CreateContextOptions.seed} runs once before the context
   * returns (use for helper functions, classes, type-defining code that
   * every script in this context should be able to call). Optional
   * {@link CreateContextOptions.snapshot} restores data state captured
   * from a previous context's {@link Context.snapshot} — useful for
   * carrying accumulated state across context lifecycles (a fresh context
   * per turn of an AI conversation, for example, with each turn's data
   * state carried forward).
   */
  createContext: (options?: CreateContextOptions) => Promise<Context>;

  /**
   * Snapshot of the isolate's current heap usage in bytes (best-effort —
   * sampled via `bun:jsc.memoryUsage` in v1). Cheap; safe to call from
   * monitoring loops.
   */
  heapSizeBytes: () => Promise<number>;

  /**
   * Tear down: terminate the worker, free the heap, reject any pending
   * operations with {@link IsolateDisposedError}. Idempotent.
   */
  dispose: () => Promise<void>;
};

/** Per-context construction options. */
export type CreateContextOptions = {
  /**
   * JS source that runs once before the context is returned. Use to define
   * helper functions, classes, types, or anything else every script in
   * this context should be able to reference. Runs inside the context's
   * sandbox, with all the usual hardening applied.
   *
   * **Persisting bindings.** The seed runs through the same `with(this) {
   * eval(source) }` wrapper as a normal `script.run()`, so `var X = …`
   * declarations scope to the eval frame and DON'T persist into the
   * sandbox after the seed returns. To persist a binding, assign onto
   * `this` (which is the sandbox) directly:
   *
   * ```js
   * // ❌ doesn't persist
   * var double = (x) => x * 2;
   *
   * // ✅ persists to the sandbox
   * this.double = (x) => x * 2;
   * this.lib = { a: 1, b: 2 };
   * ```
   *
   * (This is a Phase-1 quirk of the with-eval design; the FFI rewrite, Phase
   * 2, will use a real fresh global object where `var` declarations land
   * naturally.)
   */
  seed?: string;
  /**
   * Structured-cloneable own properties to install on the new context's
   * sandbox before it's returned. Pair with {@link Context.snapshot} to
   * carry accumulated data state across context lifecycles.
   */
  snapshot?: Record<string, unknown>;
};

/** An execution context within an {@link Isolate} — a fresh global scope. */
export type Context = {
  readonly isolate: Isolate;
  /**
   * Compile a function expression in this context and return a {@link
   * Callable}. `source` must evaluate to a function (arrow or `function`
   * expression). Per-call cost is just one JSC `JSObjectCallAsFunction`
   * (FFI backend) or one postMessage (Worker backend) — no per-call
   * eval, no per-call `setGlobal`. Use this in preference to
   * {@link Script} for the per-tenant / per-call dispatch shape: compile
   * once at registration, call many times with different args.
   *
   * @example
   * const fn = await ctx.compileCallable('(args, ctx) => args.n * 2');
   * const result = await fn.call([{ n: 21 }, {}]);  // 42
   *
   * @example // Pass a Reference as an arg (host call-back, no global needed):
   * const dispatch = new Reference((op, ...rest) => actions[op](...rest));
   * const fn = await ctx.compileCallable(
   *   '(args, dispatch) => dispatch("insert", "users", args)'
   * );
   * await fn.call([{ name: 'alex' }, dispatch]);
   */
  compileCallable: (source: string) => Promise<Callable>;
  /**
   * Set a global on this context's `globalThis`. Value must be a primitive,
   * a {@link Reference}, or an {@link ExternalCopy} — naked host objects
   * will throw (they'd cross the heap boundary).
   */
  setGlobal: (name: string, value: unknown) => Promise<void>;
  /** Read a global. Returns the value via structured clone. */
  getGlobal: (name: string) => Promise<unknown>;
  /**
   * Capture the context's structured-cloneable own properties (the "data
   * state"). Functions, host {@link Reference}s, and other non-clonable
   * values are excluded. Pair with {@link CreateContextOptions.snapshot}
   * to derive a new context from this one's accumulated state.
   *
   * Note: this is NOT a JSC heap snapshot. JavaScriptCore's public C API does
   * not expose a stable serializer for a whole JSGlobalContextRef,
   * JSContextGroupRef, call stack, closure graph, pending promise state, or
   * JIT/profile state. This is an "extract the data and re-derive a new
   * context from it" operation. The {@link CreateContextOptions.seed} carries
   * the code half.
   */
  snapshot: () => Promise<Record<string, unknown>>;
  /** Dispose just this context (the isolate stays alive). */
  dispose: () => Promise<void>;
};

/** Options for {@link Script.run}. */
export type RunOptions = {
  /**
   * Max wall-clock time (ms) for this run. After the timeout the worker is
   * terminated and the promise rejects with {@link TimeoutError}. v1 has
   * millisecond accuracy via setTimeout; v2 will use JSC's interrupt API
   * for sub-millisecond + tight-loop accuracy.
   *
   * Defaults to 1000 ms.
   */
  timeout?: number;
  /**
   * Maximum JSON-encoded result size in bytes. When set, successful script or
   * callable results larger than this reject with {@link ResultSizeError}
   * instead of being returned to host application code.
   */
  maxResultBytes?: number;
  /**
   * Whether to release the script after this run. `true` is a hint to the
   * GC; the script is also released when the isolate is disposed.
   */
  release?: boolean;
};

/** Per-run telemetry returned by {@link Script.runWithMetrics}. */
export type RunMetrics = {
  /** Backend that executed this run. Useful when `backend: "auto"` is used. */
  backend: IsolateBackend;
  /**
   * Wall-clock duration (ms) of the script body inside the worker — does
   * NOT include host-side message-passing overhead. Use for "how
   * expensive was the user's script?" not "how long did the round trip
   * take?". Sub-millisecond runs round to 0.
   */
  cpuMs: number;
  /**
   * Heap size (bytes) measured immediately after the script returned.
   * NOT the run's peak — a true peak would require continuous polling
   * during execution. Useful for "did this run blow up?" detection and
   * for usage-based billing approximations.
   */
  heapBytes: number;
};

/** Result returned by {@link Script.runWithMetrics}. */
export type RunWithMetricsResult<T = unknown> = {
  result: T;
  metrics: RunMetrics;
};

export type ExecutionReceiptStatus = "success" | "error";

export type ExecutionReceiptCapabilityEvent = {
  durationMs?: number;
  status: string;
  tool: string;
};

export type ExecutionReceiptError = {
  code?: string;
  message: string;
  name: string;
};

export type ExecutionReceiptConsole = {
  byteLimitExceeded: boolean;
  bytes: number;
  entries: number;
  entryLimitExceeded: boolean;
  truncated: boolean;
};

export type ExecutionReceipt = {
  backend: IsolateBackend;
  capabilityCalls: ExecutionReceiptCapabilityEvent[];
  capabilityCallsDropped?: number;
  capabilityCallsTruncated?: boolean;
  console: ExecutionReceiptConsole;
  durationMs: number;
  endedAt: string;
  error?: ExecutionReceiptError;
  executionId: string;
  memoryLimitMb: number;
  metrics?: RunMetrics;
  outputBytes?: number;
  outputTruncated: boolean;
  policy?: IsolatePolicyName;
  purpose?: string;
  schemaVersion: 1;
  startedAt: string;
  status: ExecutionReceiptStatus;
  tenant?: string;
  timeoutMs: number;
};

export type RunReceiptOptions = RunOptions & {
  /**
   * Optional ID for correlating receipts with an app/request log. A random
   * `crypto.randomUUID()` value is used when omitted.
   */
  executionId?: string;
  /**
   * Capability audit events captured by a broker during this execution.
   * Prefer `createCapabilityAuditBuffer({ maxEvents })` and spread its
   * `receiptOptions()` here so receipts stay bounded.
   */
  capabilityEvents?: readonly ExecutionReceiptCapabilityEvent[];
  /** Number of capability audit events dropped before receipt creation. */
  capabilityEventsDropped?: number | (() => number);
  /** Whether capability audit events were truncated before receipt creation. */
  capabilityEventsTruncated?: boolean | (() => boolean);
  /**
   * User/application labels copied into the receipt for review workflows.
   */
  purpose?: string;
  tenant?: string;
};

export type RunWithReceiptResult<T = unknown> = {
  receipt: ExecutionReceipt;
  result: T;
};

/**
 * A precompiled function bound to a specific {@link Context}. Use
 * {@link Context.compileCallable} to create one. Per-call cost is one
 * `JSObjectCallAsFunction` (FFI) or one postMessage (Worker) — no
 * per-call eval, no per-call setGlobal.
 *
 * For the dispatch shape where you call the same handler many times
 * with different args, this is much cheaper than re-evaluating a
 * `Script` per call (which is essentially "ship args via setGlobal,
 * eval the source"). For ad-hoc one-off scripts, prefer {@link Script}.
 */
export type Callable = {
  readonly context: Context;
  /**
   * Call the precompiled function. `args` are passed in order as the
   * function's positional parameters. Each may be a primitive, a
   * {@link Reference} (installed inline as a callable on the JSC
   * side — no global pollution), an {@link ExternalCopy}, or a plain
   * structured-cloneable value. The return value is structure-cloned
   * back; rejected Promises throw their rejection.
   */
  call: (args: unknown[], options?: RunOptions) => Promise<unknown>;
  /**
   * Same as {@link call} but resolves with `{ result, metrics }`.
   * Failures still reject with the original error; metrics are only
   * attached to successful calls.
   */
  callWithMetrics: (
    args: unknown[],
    options?: RunOptions,
  ) => Promise<RunWithMetricsResult>;
  /**
   * Same as {@link callWithMetrics} but includes a local execution receipt.
   * On failure, the original error is rethrown with `.receipt` attached.
   */
  callWithReceipt: (
    args: unknown[],
    options?: RunReceiptOptions,
  ) => Promise<RunWithReceiptResult>;
  /** Release the function reference. Idempotent. */
  dispose: () => Promise<void>;
};

/** A compiled JS script that can be run inside a {@link Context}. */
export type Script = {
  readonly isolate: Isolate;
  /**
   * Execute against the given context. Resolves with the script's return
   * value via structured clone. Rejects with a JS error thrown by the script,
   * or {@link TimeoutError} / {@link MemoryLimitError} on resource breaches.
   *
   * For per-call telemetry (CPU ms + heap bytes) use {@link runWithMetrics}.
   */
  run: (context: Context, options?: RunOptions) => Promise<unknown>;
  /**
   * Same as {@link run} but resolves with `{ result, metrics }`. Failures
   * still reject with the original error; the metrics are only attached
   * to successful runs.
   */
  runWithMetrics: (
    context: Context,
    options?: RunOptions,
  ) => Promise<RunWithMetricsResult>;
  /**
   * Same as {@link runWithMetrics} but includes a local execution receipt.
   * On failure, the original error is rethrown with `.receipt` attached.
   */
  runWithReceipt: (
    context: Context,
    options?: RunReceiptOptions,
  ) => Promise<RunWithReceiptResult>;
  dispose: () => Promise<void>;
};

/**
 * A host-side function exposed to the isolate. The isolate calls it via
 * message-passing; arguments and return value are structure-cloned. Use this
 * to give the isolate controlled access to host capabilities (a `fetch`
 * implementation that goes through your rate limiter, a `db.query` bridge
 * that enforces tenant scoping, etc).
 *
 * Reference calls are asynchronous in v1 (cross-thread message-passing has no
 * synchronous path without Atomics.wait + SharedArrayBuffer, which is a v2
 * concern). Inside the isolate, call `await log('hello')` — Reference is
 * installed as an async function on the isolate side, not as an object with
 * `applySync` like classic isolated-vm.
 *
 * @example
 * const log = new Reference((msg: string) => console.log('[tenant]', msg));
 * await context.setGlobal('log', log);
 * // Inside the isolate: await log('hello');
 */
export class Reference<F extends (...args: unknown[]) => unknown> {
  readonly fn: F;
  constructor(fn: F) {
    this.fn = fn;
  }
}

/**
 * A host-side value pre-serialised for cheap repeated passes into the
 * isolate. Use this for large constants you reference multiple times.
 *
 * @example
 * const schema = new ExternalCopy({ fields: [...] });
 * await context.setGlobal('schema', schema);
 */
export class ExternalCopy<T> {
  readonly value: T;
  constructor(value: T) {
    this.value = value;
  }
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/** A script's wall-clock budget elapsed before it completed. */
export class TimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Script exceeded the ${timeoutMs} ms timeout`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** The isolate's heap exceeded its memory limit and it was terminated. */
export class MemoryLimitError extends Error {
  readonly memoryLimitMb: number;
  readonly observedBytes: number;
  constructor(memoryLimitMb: number, observedBytes: number) {
    super(
      `Isolate heap (${observedBytes} bytes) exceeded the ${memoryLimitMb} MB limit`,
    );
    this.name = "MemoryLimitError";
    this.memoryLimitMb = memoryLimitMb;
    this.observedBytes = observedBytes;
  }
}

/** A result exceeded the caller's configured output byte limit. */
export class ResultSizeError extends Error {
  readonly code = "RESULT_SIZE_LIMIT";
  readonly maxResultBytes: number;
  readonly observedBytes: number;
  constructor(maxResultBytes: number, observedBytes: number) {
    super(
      `Result size (${observedBytes} bytes) exceeded the ${maxResultBytes} byte limit`,
    );
    this.name = "ResultSizeError";
    this.maxResultBytes = maxResultBytes;
    this.observedBytes = observedBytes;
  }
}

/** The isolate was disposed; the operation can never complete. */
export class IsolateDisposedError extends Error {
  constructor() {
    super("Isolate has been disposed");
    this.name = "IsolateDisposedError";
  }
}

/** Compile-time syntax error in the script source. */
export class CompileError extends Error {
  readonly source: string;
  constructor(message: string, source: string) {
    super(`Compile error: ${message}`);
    this.name = "CompileError";
    this.source = source;
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a fresh isolate. Returns a promise because the underlying Worker
 * needs to spawn + load its bootstrap before the isolate is usable.
 *
 * @example
 * const isolate = await createIsolate({ memoryLimit: 32 });
 * const context = await isolate.createContext();
 * const script = await isolate.compileScript('1 + 1');
 * const result = await script.run(context); // 2
 * await isolate.dispose();
 */
export type CreateIsolate = (options?: IsolateOptions) => Promise<Isolate>;
