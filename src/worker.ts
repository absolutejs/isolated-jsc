/**
 * Worker-side entry point. Spawned by the host as a Bun `Worker`; from here on
 * we live in our own JSC VM with our own heap. We never `import` anything that
 * touches the host's filesystem / network beyond `bun:jsc` (debug primitives:
 * `memoryUsage`). User code added later via `compile` runs inside this worker,
 * but in a fresh function scope that doesn't see the worker's own module-scope
 * bindings.
 *
 * The host is responsible for terminating us on timeout, on isolate dispose,
 * or when we self-report a fatal (memory limit). We don't trust the host any
 * more than we have to — but we also don't try to defend against the host.
 * The host is in the same trust domain as the application itself.
 */

import { memoryUsage } from "bun:jsc";
import type {
  HostMessage,
  WireError,
  WireValue,
  WorkerEvent,
  WorkerInitMessage,
  WorkerMessage,
  WorkerReply,
} from "./protocol";

declare const self: Worker & {
  postMessage: (message: WorkerMessage) => void;
};

type CompiledScript = (sandbox: Record<string, unknown>) => unknown;

const contexts = new Map<number, Record<string, unknown>>();
const scripts = new Map<number, CompiledScript>();

let nextCallId = 1;
const pendingRefCalls = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: unknown) => void }
>();

let initialized = false;
let memoryLimitMb = 64;

// ─── Wire value rehydration ─────────────────────────────────────────────────

/** Turn a {@link WireValue} into the actual JS value to install on the
 * sandbox. Refs become async functions that round-trip to the host. */
const rehydrate = (wire: WireValue): unknown => {
  if (wire.kind === "value") return wire.value;
  if (wire.kind === "externalCopy") return wire.value;
  const { refId } = wire;
  return (...args: unknown[]): Promise<unknown> => {
    const callId = nextCallId++;
    return new Promise((resolve, reject) => {
      pendingRefCalls.set(callId, { resolve, reject });
      self.postMessage({
        type: "refCall",
        callId,
        refId,
        args,
      } satisfies WorkerEvent);
    });
  };
};

const wrapError = (error: unknown): WireError => {
  if (error instanceof Error) {
    const wire: WireError = {
      name: error.name,
      message: error.message,
    };
    // Only include stack if it's a non-empty string — Bun's structured
    // clone over postMessage rejects objects with undefined values on
    // some properties (silently — the message is dropped without an
    // error event). Build the object incrementally.
    if (typeof error.stack === "string" && error.stack.length > 0) {
      wire.stack = error.stack;
    }
    return wire;
  }
  return { name: "Error", message: String(error) };
};

// ─── Compile ────────────────────────────────────────────────────────────────

/**
 * Compile a script. We wrap the source as a top-level *script* (not as an
 * expression) so statements like `while`, `for`, and `function foo() {}`
 * work — and we use direct `eval()` inside a `with(sandbox)` block to get
 * the script's completion value back (the value of its last expression
 * statement, matching `vm.Script` and isolated-vm semantics).
 *
 * The user-script throw is caught *inside* the compiled wrapper and
 * surfaced as a `{ __isolatedJscThrow: error }` sentinel — not re-thrown
 * out of the eval. This is a workaround for a Bun bug (`bun test` mode):
 * when an eval inside a Bun worker throws, the worker's outgoing
 * postMessage channel goes silent for all subsequent messages. We
 * sidestep it by never letting the throw cross the eval boundary.
 *
 * Non-strict on purpose: `with` is forbidden under strict mode. User source
 * can opt into strict per-script by starting with `"use strict"`.
 */
const compile = (source: string): CompiledScript => {
  const wrapped = `
		return (function () {
			with (this) {
				try {
					return Promise.resolve(eval(${JSON.stringify(source)}))
						.catch(function (e) {
							return { __isolatedJscThrow: e };
						});
				} catch (e) {
					return { __isolatedJscThrow: e };
				}
			}
		}).call(sandbox);
	`;
  return new Function("sandbox", wrapped) as CompiledScript;
};

const isThrowSentinel = (
  value: unknown,
): value is { __isolatedJscThrow: unknown } =>
  value !== null && typeof value === "object" && "__isolatedJscThrow" in value;

// ─── Init ───────────────────────────────────────────────────────────────────

const installConsoleCapture = (): void => {
  const consoleAny = console as unknown as Record<
    string,
    ((...a: unknown[]) => void) | undefined
  >;
  for (const level of ["log", "warn", "error"] as const) {
    const original = consoleAny[level];
    consoleAny[level] = (...args: unknown[]): void => {
      try {
        self.postMessage({
          type: "console",
          level,
          args,
        } satisfies WorkerEvent);
      } catch {
        self.postMessage({
          type: "console",
          level,
          args: args.map((a) => {
            try {
              return JSON.parse(JSON.stringify(a));
            } catch {
              return String(a);
            }
          }),
        } satisfies WorkerEvent);
      }
      if (original !== undefined) original(...args);
    };
  }
};

const startMemoryWatchdog = (): void => {
  const memoryLimitBytes = memoryLimitMb * 1024 * 1024;
  setInterval((): void => {
    const usage = memoryUsage();
    if (usage.current > memoryLimitBytes) {
      self.postMessage({
        type: "fatal",
        kind: "memory",
        observedBytes: usage.current,
        memoryLimitMb,
      } satisfies WorkerEvent);
      // Give the message a tick to flush, then die. The host will also
      // terminate us on its side once it reads the fatal.
      setTimeout(() => process.exit(1), 5);
    }
  }, 50);
};

const handleInit = (message: WorkerInitMessage): void => {
  memoryLimitMb = message.memoryLimitMb;
  if (message.captureConsole) installConsoleCapture();
  // Pre-warm `eval`. Bun's worker drops the next outgoing postMessage if
  // it follows the worker's first ever eval-throw; running and catching
  // a throw here moves the first-eval-throw out of the user's path.
  try {
    new Function('return eval("throw new Error(\\"prewarm\\")")')();
  } catch {
    /* expected — that's the point */
  }
  if (typeof message.bootstrap === "string" && message.bootstrap.length > 0) {
    try {
      new Function(message.bootstrap)();
    } catch (error) {
      (console.error as (...a: unknown[]) => void)(
        "isolated-jsc bootstrap failed:",
        error,
      );
    }
  }
  startMemoryWatchdog();
  initialized = true;
  self.postMessage({ type: "ready" } satisfies WorkerEvent);
};

// ─── Dispatch ───────────────────────────────────────────────────────────────

const handleMessage = async (event: MessageEvent): Promise<void> => {
  const message = event.data as HostMessage;

  if (!initialized) {
    if ("op" in message && message.op === "init") {
      handleInit(message);
      return;
    }
    // Drop pre-init ops silently — the host shouldn't send these, and
    // replying with an error would race the ready signal.
    return;
  }

  if (message.op === "init") return; // duplicate init — ignore
  const request = message;

  if (request.op === "refReply") {
    const pending = pendingRefCalls.get(request.callId);
    if (pending === undefined) return;
    pendingRefCalls.delete(request.callId);
    if (request.error !== undefined) {
      const error = new Error(request.error.message);
      error.name = request.error.name;
      pending.reject(error);
      return;
    }
    pending.resolve(
      request.result === undefined ? undefined : rehydrate(request.result),
    );
    return;
  }

  try {
    const reply: WorkerReply = await (async (): Promise<WorkerReply> => {
      switch (request.op) {
        case "compile": {
          const fn = compile(request.source);
          scripts.set(request.id, fn);
          return { id: request.id, ok: true, result: request.id };
        }
        case "createContext": {
          const sandbox: Record<string, unknown> = Object.create(null);
          contexts.set(request.id, sandbox);
          return { id: request.id, ok: true, result: request.id };
        }
        case "setGlobal": {
          const sandbox = contexts.get(request.contextId);
          if (sandbox === undefined)
            throw new Error(`unknown contextId ${request.contextId}`);
          sandbox[request.name] = rehydrate(request.value);
          return { id: request.id, ok: true, result: null };
        }
        case "getGlobal": {
          const sandbox = contexts.get(request.contextId);
          if (sandbox === undefined)
            throw new Error(`unknown contextId ${request.contextId}`);
          return {
            id: request.id,
            ok: true,
            result: {
              kind: "value",
              value: sandbox[request.name],
            },
          };
        }
        case "run": {
          const script = scripts.get(request.scriptId);
          if (script === undefined)
            throw new Error(`unknown scriptId ${request.scriptId}`);
          const sandbox = contexts.get(request.contextId);
          if (sandbox === undefined)
            throw new Error(`unknown contextId ${request.contextId}`);
          const result = await script(sandbox);
          if (isThrowSentinel(result)) {
            // User script threw — re-throw here so the outer
            // catch turns it into an error reply. (The script
            // wrapper caught it inside the eval frame so the
            // throw never crosses an eval boundary in the worker.)
            throw result.__isolatedJscThrow;
          }
          return {
            id: request.id,
            ok: true,
            result: { kind: "value", value: result },
          };
        }
        case "disposeContext": {
          contexts.delete(request.contextId);
          return { id: request.id, ok: true, result: null };
        }
        case "disposeScript": {
          scripts.delete(request.scriptId);
          return { id: request.id, ok: true, result: null };
        }
        case "heap": {
          const usage = memoryUsage();
          return {
            id: request.id,
            ok: true,
            result: usage.current,
          };
        }
        default: {
          const exhaustive: never = request;
          throw new Error(`unknown op: ${JSON.stringify(exhaustive)}`);
        }
      }
    })();
    self.postMessage(reply);
  } catch (error) {
    self.postMessage({
      id: request.id,
      ok: false,
      error: wrapError(error),
    } satisfies WorkerReply);
  }
};

// Sync listener that punts to async — Bun's worker can drop subsequent
// messages if an async listener's returned promise rejects (even if all
// caught internally, the listener-return is still a promise the worker
// may attach to). Returning undefined from a sync listener avoids that.
self.addEventListener("message", (event: MessageEvent): void => {
  handleMessage(event).catch((err) => {
    process.stderr.write(
      `[worker] handleMessage rejected: ${(err as Error).message}\n${(err as Error).stack ?? ""}\n`,
    );
  });
});
