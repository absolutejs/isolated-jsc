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

/** Construction options for an {@link Isolate}. */
export type IsolateOptions = {
  /**
   * Hard cap on heap memory (MB). When the isolate's heap exceeds this, the
   * isolate is terminated and any in-flight `script.run` rejects with
   * {@link MemoryLimitError}. v1 enforces via polled
   * `bun:jsc.memoryUsage` (soft + millisecond-grained); v2 will enforce via
   * libJSC's heap settings (synchronous, on-allocate).
   *
   * Defaults to 64 MB.
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
   */
  createContext: () => Promise<Context>;

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

/** An execution context within an {@link Isolate} — a fresh global scope. */
export type Context = {
  readonly isolate: Isolate;
  /**
   * Set a global on this context's `globalThis`. Value must be a primitive,
   * a {@link Reference}, or an {@link ExternalCopy} — naked host objects
   * will throw (they'd cross the heap boundary).
   */
  setGlobal: (name: string, value: unknown) => Promise<void>;
  /** Read a global. Returns the value via structured clone. */
  getGlobal: (name: string) => Promise<unknown>;
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
   * Whether to release the script after this run. `true` is a hint to the
   * GC; the script is also released when the isolate is disposed.
   */
  release?: boolean;
};

/** A compiled JS script that can be run inside a {@link Context}. */
export type Script = {
  readonly isolate: Isolate;
  /**
   * Execute against the given context. Resolves with the script's return
   * value via structured clone. Rejects with a JS error thrown by the script,
   * or {@link TimeoutError} / {@link MemoryLimitError} on resource breaches.
   */
  run: (context: Context, options?: RunOptions) => Promise<unknown>;
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
