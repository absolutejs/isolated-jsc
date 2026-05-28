/**
 * Host-side implementation of {@link createIsolate}. Owns the {@link Worker}
 * that runs the isolate, multiplexes ops onto the wire, tracks pending
 * promises by id, and enforces wall-clock timeouts via `setTimeout` +
 * `worker.terminate()`.
 *
 * Trade-off (v1, will revisit in v2): a timeout terminates the entire
 * isolate. CPU enforcement is millisecond-granular; for sub-ms or
 * tight-loop accuracy use v2 (FFI to libJSC). For now: if you need a fresh
 * isolate after timeout, pool them at the application layer.
 */

import {
  type Callable,
  CompileError,
  type Context,
  type CreateContextOptions,
  ExternalCopy,
  type Isolate,
  type IsolateOptions,
  IsolateDisposedError,
  MemoryLimitError,
  Reference,
  type RunReceiptOptions,
  type RunOptions,
  type RunWithMetricsResult,
  type RunWithReceiptResult,
  type Script,
  TimeoutError,
} from "./types";
import type { ResolvedIsolatePolicy } from "./policy";
import type {
  HostMessage,
  HostRequest,
  WireValue,
  WorkerEvent,
  WorkerMessage,
} from "./protocol";
import { applyIsolatePolicyOptions } from "./policy";
import {
  attachReceipt,
  createErrorReceipt,
  createSuccessReceipt,
} from "./receipt";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  /** Optional out-channel — when set, onWorkerMessage stores the reply's
   * metrics here before resolving. Used by `runWithMetrics`; ignored by
   * every other op. */
  metricsOut?: { current?: { cpuMs: number; heapBytes: number } };
};

/** Brand: Context → worker-side contextId. Declared up here so the closure in
 * {@link makeContext} can write to it before {@link contextIdOf} is read. */
const contextIds = new WeakMap<Context, number>();
const contextIdOf = (context: Context): number => {
  const id = contextIds.get(context);
  if (id === undefined)
    throw new Error("context is not from this implementation");
  return id;
};

type IsolateState = {
  worker: Worker;
  options: Required<Pick<IsolateOptions, "memoryLimit">>;
  disposed: boolean;
  disposedError: Error | null;
  pending: Map<number, Pending>;
  nextId: number;
  refs: Map<number, (...args: unknown[]) => unknown>;
  nextRefId: number;
  onConsole: IsolateOptions["onConsole"];
  defaultRunOptions: Required<Pick<RunOptions, "timeout">>;
  policy: ResolvedIsolatePolicy | undefined;
};

/** Build the URL of the worker entrypoint relative to this module. Resolves
 * to `worker.ts` in development (when sources are run directly via Bun) and
 * to `worker.js` when consumed from the published `dist/` bundle. Bun's
 * `Worker` constructor accepts both. */
const workerUrl: URL = (() => {
  const here = import.meta.url;
  if (here.endsWith(".ts")) return new URL("./worker.ts", here);
  return new URL("./worker.js", here);
})();

const failAllPending = (state: IsolateState, error: Error): void => {
  state.disposedError = error;
  for (const pending of state.pending.values()) pending.reject(error);
  state.pending.clear();
};

/** Convert a host-side value into a {@link WireValue}. Refs are interned
 * into the isolate's ref table; ExternalCopy unwraps its `.value`. */
const toWire = (state: IsolateState, value: unknown): WireValue => {
  if (value instanceof Reference) {
    const refId = state.nextRefId++;
    state.refs.set(refId, value.fn);
    return { kind: "ref", refId };
  }
  if (value instanceof ExternalCopy) {
    return { kind: "externalCopy", value: value.value };
  }
  return { kind: "value", value };
};

const fromWire = (wire: WireValue): unknown => {
  if (wire.kind === "externalCopy") return wire.value;
  if (wire.kind === "ref") {
    // A ref returned *from* the worker shouldn't normally happen — the
    // worker only sends `value` kinds back. Treat as opaque.
    return undefined;
  }
  return wire.value;
};

const send = <T>(state: IsolateState, request: HostRequest): Promise<T> => {
  if (state.disposed) {
    return Promise.reject(state.disposedError ?? new IsolateDisposedError());
  }
  return new Promise<T>((resolve, reject) => {
    state.pending.set(request.id, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    state.worker.postMessage(request satisfies HostMessage);
  });
};

/** Variant of {@link send} that also captures `metrics` from the worker reply.
 * Used by `runWithMetrics`. */
const sendWithMetrics = <T>(
  state: IsolateState,
  request: HostRequest,
): Promise<{ result: T; metrics?: { cpuMs: number; heapBytes: number } }> => {
  if (state.disposed) {
    return Promise.reject(state.disposedError ?? new IsolateDisposedError());
  }
  return new Promise((resolve, reject) => {
    const metricsOut: { current?: { cpuMs: number; heapBytes: number } } = {};
    state.pending.set(request.id, {
      resolve: (result) =>
        resolve({ result: result as T, metrics: metricsOut.current }),
      reject,
      metricsOut,
    });
    state.worker.postMessage(request satisfies HostMessage);
  });
};

/** Rebuild a host-side Error from the wire shape. Custom Error subclasses
 * can't be reconstructed (we don't have their constructors); we approximate
 * by setting `.name` and copying the captured own properties. instanceof
 * checks for user-defined subclasses won't work across the boundary — use
 * `.name === 'FooError'` or `.code === '40001'` etc. instead. */
const rebuildError = (wire: {
  name: string;
  message: string;
  stack?: string;
  cause?: { name: string; message: string; stack?: string; cause?: unknown };
  props?: Record<string, unknown>;
}): Error => {
  const error = new Error(wire.message);
  error.name = wire.name;
  if (wire.stack !== undefined) error.stack = wire.stack;
  if (wire.cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = rebuildError(
      wire.cause as Parameters<typeof rebuildError>[0],
    );
  }
  if (wire.props !== undefined) {
    for (const [key, value] of Object.entries(wire.props)) {
      (error as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return error;
};

const onWorkerMessage = (state: IsolateState, message: WorkerMessage): void => {
  if ("type" in message) {
    handleEvent(state, message);
    return;
  }
  const pending = state.pending.get(message.id);
  if (pending === undefined) return;
  state.pending.delete(message.id);
  if (message.ok) {
    if (pending.metricsOut !== undefined && message.metrics !== undefined) {
      pending.metricsOut.current = message.metrics;
    }
    pending.resolve(message.result);
    return;
  }
  pending.reject(rebuildError(message.error));
};

const handleEvent = (state: IsolateState, event: WorkerEvent): void => {
  switch (event.type) {
    case "ready":
      // init ack — pending init promise (id 0) is fulfilled elsewhere
      return;
    case "console":
      if (state.onConsole !== undefined)
        state.onConsole(event.level, event.args);
      return;
    case "refCall": {
      const fn = state.refs.get(event.refId);
      const reply = (ok: boolean, value: unknown, error?: Error): void => {
        const reqId = state.nextId++;
        state.worker.postMessage({
          id: reqId,
          op: "refReply",
          callId: event.callId,
          result: ok ? { kind: "value", value } : undefined,
          error:
            error === undefined
              ? undefined
              : {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                },
        } satisfies HostMessage);
      };
      if (fn === undefined) {
        reply(false, undefined, new Error(`unknown refId ${event.refId}`));
        return;
      }
      (async (): Promise<void> => {
        try {
          const result = await fn(...event.args);
          reply(true, result);
        } catch (error) {
          reply(
            false,
            undefined,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      })();
      return;
    }
    case "fatal": {
      const error = new MemoryLimitError(
        event.memoryLimitMb,
        event.observedBytes,
      );
      state.disposed = true;
      failAllPending(state, error);
      void state.worker.terminate();
      return;
    }
  }
};

/**
 * Worker-backed {@link Isolate}. The original v0 implementation; one Bun
 * Worker per Isolate, all comms through `postMessage`. Public
 * {@link createIsolate} picks this when the user passes `backend: 'worker'`
 * or when libJSC isn't reachable.
 */
export const createIsolateWorker = async (
  options: IsolateOptions = {},
): Promise<Isolate> => {
  const effectiveOptions = applyIsolatePolicyOptions(options);
  const memoryLimit = effectiveOptions.memoryLimit ?? 256;
  const worker = new Worker(workerUrl.href, { type: "module" });

  const state: IsolateState = {
    worker,
    options: { memoryLimit },
    disposed: false,
    disposedError: null,
    pending: new Map(),
    nextId: 1,
    refs: new Map(),
    nextRefId: 1,
    onConsole: effectiveOptions.onConsole,
    defaultRunOptions: {
      timeout: effectiveOptions.defaultRunOptions?.timeout ?? 1000,
    },
    policy: effectiveOptions.policy,
  };

  // Use `onmessage`/`onerror` setters (not addEventListener) — Bun's Worker
  // only auto-refs the parent for delivery when these properties are set;
  // addEventListener listeners can silently miss messages after the first
  // async op completes. (Discovered the hard way; see ISSUES_WILL_CLOSE.md.)
  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: unknown) => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  worker.onmessage = (event: MessageEvent): void => {
    const message = event.data as WorkerMessage;
    // Intercept the one-shot ready signal first.
    if (
      "type" in message &&
      message.type === "ready" &&
      readyResolve !== null
    ) {
      const r = readyResolve;
      readyResolve = null;
      readyReject = null;
      r();
      return;
    }
    onWorkerMessage(state, message);
  };
  worker.onerror = (event: ErrorEvent): void => {
    const error = new Error(
      `isolate worker errored: ${event.message ?? "unknown"}`,
    );
    if (readyReject !== null) {
      const r = readyReject;
      readyResolve = null;
      readyReject = null;
      r(error);
      return;
    }
    state.disposed = true;
    failAllPending(state, error);
  };

  worker.postMessage({
    op: "init",
    memoryLimitMb: memoryLimit,
    bootstrap: effectiveOptions.bootstrap,
    captureConsole: effectiveOptions.onConsole !== undefined,
    harden: effectiveOptions.harden !== false,
    unsafelyExposeGlobals: effectiveOptions.unsafelyExposeGlobals,
  } satisfies HostMessage);

  await ready;

  const isolate: Isolate = {
    options: state.options,
    defaultRunOptions: state.defaultRunOptions,
    policy: state.policy,
    backend: "worker",
    get isDisposed(): boolean {
      return state.disposed;
    },

    async compileScript(source: string): Promise<Script> {
      const id = state.nextId++;
      try {
        await send<number>(state, {
          id,
          op: "compile",
          source,
        });
      } catch (error) {
        // Distinguish compile-time syntax errors from anything else.
        if (
          error instanceof Error &&
          (error.name === "SyntaxError" ||
            error.message.includes("SyntaxError"))
        ) {
          throw new CompileError(error.message, source);
        }
        throw error;
      }
      return makeScript(state, isolate, id);
    },

    async createContext(options?: CreateContextOptions): Promise<Context> {
      const id = state.nextId++;
      await send<number>(state, {
        id,
        op: "createContext",
        seed: options?.seed,
        snapshot: options?.snapshot,
      });
      return makeContext(state, isolate, id);
    },

    async heapSizeBytes(): Promise<number> {
      const id = state.nextId++;
      return send<number>(state, { id, op: "heap" });
    },

    async dispose(): Promise<void> {
      if (state.disposed) return;
      state.disposed = true;
      failAllPending(state, new IsolateDisposedError());
      await state.worker.terminate();
    },
  };

  return isolate;
};

const makeContext = (
  state: IsolateState,
  isolate: Isolate,
  contextId: number,
): Context => {
  const context: Context = {
    isolate,

    async compileCallable(source: string): Promise<Callable> {
      const id = state.nextId++;
      try {
        await send<null>(state, {
          id,
          op: "compileCallable",
          contextId,
          source,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === "SyntaxError" ||
            error.message.includes("SyntaxError") ||
            error.name === "TypeError")
        ) {
          throw new CompileError(error.message, source);
        }
        throw error;
      }
      return makeCallable(state, context, id);
    },

    async setGlobal(name: string, value: unknown): Promise<void> {
      const id = state.nextId++;
      await send<null>(state, {
        id,
        op: "setGlobal",
        contextId,
        name,
        value: toWire(state, value),
      });
    },

    async getGlobal(name: string): Promise<unknown> {
      const id = state.nextId++;
      const wire = await send<WireValue>(state, {
        id,
        op: "getGlobal",
        contextId,
        name,
      });
      return fromWire(wire);
    },

    async snapshot(): Promise<Record<string, unknown>> {
      const id = state.nextId++;
      const wire = await send<WireValue>(state, {
        id,
        op: "snapshotContext",
        contextId,
      });
      const value = fromWire(wire);
      if (value === null || typeof value !== "object") return {};
      return value as Record<string, unknown>;
    },

    async dispose(): Promise<void> {
      const id = state.nextId++;
      await send<null>(state, { id, op: "disposeContext", contextId });
    },
  };
  contextIds.set(context, contextId);
  return context;
};

/** Shared timeout-race machinery. Bun 1.3.x sometimes doesn't deliver
 * pending worker messages while the host parks on a single long
 * setTimeout, so we poll instead — keeps the event loop hot enough for
 * messages to flow normally. */
const raceWithTimeout = async <T>(
  state: IsolateState,
  runPromise: Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  runPromise.catch(() => {});
  let poller: ReturnType<typeof setInterval> | undefined;
  const deadline = Date.now() + timeoutMs;
  try {
    return await Promise.race([
      runPromise,
      new Promise<never>((_, reject) => {
        poller = setInterval(
          () => {
            if (Date.now() >= deadline) {
              const error = new TimeoutError(timeoutMs);
              if (!state.disposed) {
                state.disposed = true;
                failAllPending(state, error);
                void state.worker.terminate();
              }
              reject(error);
            }
          },
          Math.min(25, Math.max(1, Math.floor(timeoutMs / 10))),
        );
      }),
    ]);
  } finally {
    if (poller !== undefined) clearInterval(poller);
  }
};

const makeScript = (
  state: IsolateState,
  isolate: Isolate,
  scriptId: number,
): Script => {
  const dispose = async (): Promise<void> => {
    const id = state.nextId++;
    if (state.disposed) return;
    await send<null>(state, { id, op: "disposeScript", scriptId });
  };

  return {
    isolate,

    async run(context: Context, options: RunOptions = {}): Promise<unknown> {
      const timeoutMs = options.timeout ?? state.defaultRunOptions.timeout;
      const id = state.nextId++;
      const wire = await raceWithTimeout<WireValue>(
        state,
        send(state, {
          id,
          op: "run",
          contextId: contextIdOf(context),
          scriptId,
        }),
        timeoutMs,
      );
      if (options.release === true) await dispose();
      return fromWire(wire);
    },

    async runWithMetrics(context: Context, options: RunOptions = {}) {
      const timeoutMs = options.timeout ?? state.defaultRunOptions.timeout;
      const id = state.nextId++;
      const { result, metrics } = await raceWithTimeout<{
        result: WireValue;
        metrics?: { cpuMs: number; heapBytes: number };
      }>(
        state,
        sendWithMetrics(state, {
          id,
          op: "run",
          contextId: contextIdOf(context),
          scriptId,
          withMetrics: true,
        }),
        timeoutMs,
      );
      if (options.release === true) await dispose();
      // metrics is always populated on a successful withMetrics=true run;
      // fall back to zeros only if the worker reply was malformed.
      return {
        result: fromWire(result),
        metrics: {
          ...(metrics ?? { cpuMs: 0, heapBytes: 0 }),
          backend: "worker",
        },
      };
    },

    async runWithReceipt(
      context: Context,
      options: RunReceiptOptions = {},
    ): Promise<RunWithReceiptResult> {
      const timeoutMs = options.timeout ?? state.defaultRunOptions.timeout;
      const base = {
        isolate,
        options,
        startedAt: new Date(),
        startedMs: performance.now(),
        timeoutMs,
      };
      try {
        const { result, metrics } = await this.runWithMetrics(context, options);
        const receipt = createSuccessReceipt(base, result, metrics);
        return { receipt, result };
      } catch (error) {
        throw attachReceipt(error, createErrorReceipt(base, error));
      }
    },

    dispose,
  };
};

const makeCallable = (
  state: IsolateState,
  context: Context,
  callableId: number,
): Callable => {
  const dispose = async (): Promise<void> => {
    if (state.disposed) return;
    const id = state.nextId++;
    await send<null>(state, { id, op: "disposeCallable", callableId });
  };

  return {
    context,

    async call(args: unknown[], options: RunOptions = {}): Promise<unknown> {
      const timeoutMs = options.timeout ?? state.defaultRunOptions.timeout;
      const id = state.nextId++;
      const wire = await raceWithTimeout<WireValue>(
        state,
        send(state, {
          id,
          op: "call",
          callableId,
          args: args.map((a) => toWire(state, a)),
        }),
        timeoutMs,
      );
      return fromWire(wire);
    },

    async callWithMetrics(
      args: unknown[],
      options: RunOptions = {},
    ): Promise<RunWithMetricsResult> {
      const timeoutMs = options.timeout ?? state.defaultRunOptions.timeout;
      const id = state.nextId++;
      const { result, metrics } = await raceWithTimeout<{
        result: WireValue;
        metrics?: { cpuMs: number; heapBytes: number };
      }>(
        state,
        sendWithMetrics(state, {
          id,
          op: "call",
          callableId,
          args: args.map((a) => toWire(state, a)),
          withMetrics: true,
        }),
        timeoutMs,
      );
      return {
        metrics: {
          ...(metrics ?? { cpuMs: 0, heapBytes: 0 }),
          backend: "worker",
        },
        result: fromWire(result),
      };
    },

    async callWithReceipt(
      args: unknown[],
      options: RunReceiptOptions = {},
    ): Promise<RunWithReceiptResult> {
      const timeoutMs = options.timeout ?? state.defaultRunOptions.timeout;
      const base = {
        isolate: context.isolate,
        options,
        startedAt: new Date(),
        startedMs: performance.now(),
        timeoutMs,
      };
      try {
        const { result, metrics } = await this.callWithMetrics(args, options);
        const receipt = createSuccessReceipt(base, result, metrics);
        return { receipt, result };
      } catch (error) {
        throw attachReceipt(error, createErrorReceipt(base, error));
      }
    },

    dispose,
  };
};

/**
 * Create an {@link Isolate}. Picks a backend based on `options.backend`
 * (default: `"auto"` — FFI if libJSC is reachable, Worker otherwise).
 *
 * The FFI backend (when reachable):
 * - Cold heap ~300 KB vs ~46 MB on the Worker backend.
 * - Closes the two T2 documented residuals (`(0, eval)('Bun')`, `new Function(...)`).
 * - Interrupt-driven timeouts that keep the isolate alive afterwards.
 * - libJavaScriptCore via `bun:ffi` — no Worker, no message-passing overhead.
 *
 * The Worker backend stays the only supported path on Windows, on Linux
 * machines without `libjavascriptcoregtk` installed, and any time the user
 * pins `backend: 'worker'` explicitly.
 */
export const createIsolate = async (
  options: IsolateOptions = {},
): Promise<Isolate> => {
  const appliedOptions = applyIsolatePolicyOptions(options);
  // Order: explicit option > env var > policy default > "auto". The env var
  // (`ISOLATED_JSC_BACKEND`) is useful for pinning the backend in test
  // suites and for ops scripts that need consistent behaviour across
  // machines with / without libJSC installed.
  const envBackend = process.env.ISOLATED_JSC_BACKEND as
    | "auto"
    | "ffi"
    | "worker"
    | undefined;
  const envBackendOverride =
    envBackend === "auto" || envBackend === "ffi" || envBackend === "worker"
      ? envBackend
      : undefined;
  const backend =
    options.backend ?? envBackendOverride ?? appliedOptions.backend ?? "auto";
  const backendOptions = { ...appliedOptions, backend };

  if (backend === "worker") {
    return createIsolateWorker(backendOptions);
  }

  // Both "ffi" and "auto" try FFI first. Dynamic import so non-Bun runtimes
  // (or environments where `bun:ffi` would crash on load) can still use
  // the Worker backend without crashing at module load.
  try {
    const { createIsolateFfi } = await import("./ffi/backend");
    return await createIsolateFfi(backendOptions);
  } catch (error) {
    if (backend === "ffi") throw error;
    if (appliedOptions.policy?.fallback.allowWorker === false) throw error;
    // "auto": silently fall back to Worker.
    return createIsolateWorker(backendOptions);
  }
};
