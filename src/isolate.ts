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
  CompileError,
  type Context,
  ExternalCopy,
  type Isolate,
  type IsolateOptions,
  IsolateDisposedError,
  MemoryLimitError,
  Reference,
  type RunOptions,
  type Script,
  TimeoutError,
} from "./types";
import type {
  HostMessage,
  HostRequest,
  WireValue,
  WorkerEvent,
  WorkerMessage,
} from "./protocol";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
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

const onWorkerMessage = (state: IsolateState, message: WorkerMessage): void => {
  if ("type" in message) {
    handleEvent(state, message);
    return;
  }
  const pending = state.pending.get(message.id);
  if (pending === undefined) return;
  state.pending.delete(message.id);
  if (message.ok) {
    pending.resolve(message.result);
    return;
  }
  const error = new Error(message.error.message);
  error.name = message.error.name;
  if (message.error.stack !== undefined) error.stack = message.error.stack;
  pending.reject(error);
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

export const createIsolate = async (
  options: IsolateOptions = {},
): Promise<Isolate> => {
  const memoryLimit = options.memoryLimit ?? 64;
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
    onConsole: options.onConsole,
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
    bootstrap: options.bootstrap,
    captureConsole: options.onConsole !== undefined,
  } satisfies HostMessage);

  await ready;

  const isolate: Isolate = {
    options: state.options,
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

    async createContext(): Promise<Context> {
      const id = state.nextId++;
      await send<number>(state, { id, op: "createContext" });
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

    async dispose(): Promise<void> {
      const id = state.nextId++;
      await send<null>(state, { id, op: "disposeContext", contextId });
    },
  };
  contextIds.set(context, contextId);
  return context;
};

const makeScript = (
  state: IsolateState,
  isolate: Isolate,
  scriptId: number,
): Script => ({
  isolate,

  async run(context: Context, options: RunOptions = {}): Promise<unknown> {
    const timeoutMs = options.timeout ?? 1000;
    const id = state.nextId++;

    const runPromise = send<WireValue>(state, {
      id,
      op: "run",
      contextId: contextIdOf(context),
      scriptId,
    });
    // Pre-attach a noop handler so the loser of the race below doesn't
    // surface as an unhandled rejection when the timeout wins (and
    // failAllPending later rejects runPromise on worker.terminate()).
    runPromise.catch(() => {});

    // We deliberately poll instead of using a single `setTimeout(timeoutMs)`:
    // when the host parks on one long timer, Bun (1.3.x) sometimes won't
    // deliver pending worker messages until the timer fires — so quick
    // replies appear to "vanish" until after the timeout, then race-lose.
    // A short-interval poll keeps the event loop hot enough for messages
    // to flow normally and only fires the TimeoutError on actual overrun.
    let poller: ReturnType<typeof setInterval> | undefined;
    const deadline = Date.now() + timeoutMs;
    try {
      const wire = await Promise.race([
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
      if (options.release === true) await this.dispose();
      return fromWire(wire);
    } finally {
      if (poller !== undefined) clearInterval(poller);
    }
  },

  async dispose(): Promise<void> {
    const id = state.nextId++;
    if (state.disposed) return;
    await send<null>(state, { id, op: "disposeScript", scriptId });
  },
});
