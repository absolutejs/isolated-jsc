/**
 * Worker-side entry point. Spawned by the host as a Bun `Worker`; from here on
 * we live in our own JSC VM with our own heap. We never `import` anything that
 * touches the host's filesystem / network beyond `bun:jsc` (debug primitives:
 * `memoryUsage`).
 *
 * Hardening (T2.1): user-script `globalThis` is *not* the worker's `globalThis`.
 * We delete deletable host-capability globals (fetch, process, Worker, etc.)
 * from the worker's globalThis, save references to the things our own
 * infrastructure needs (postMessage, addEventListener, setInterval, etc.)
 * BEFORE deletion, and run user code in a `with(sandbox)` block whose sandbox
 * inherits from a frozen prototype carrying safe globals (Math, JSON, Promise,
 * URL, crypto, …) and `undefined` for everything dangerous. User code's
 * `globalThis` is the sandbox itself, so `globalThis.fetch`, `this.fetch`,
 * and bare `fetch` all resolve to `undefined`.
 *
 * Documented residual: `(0, eval)('Bun')` and `new Function('return Bun')()`
 * still escape because indirect eval / Function-constructor runs in the real
 * global scope and we can't take away `Function` without breaking everything
 * (async functions, class generators, etc.). That's v3 (FFI) territory.
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

// ─── Infrastructure capture ─────────────────────────────────────────────────
// Saved at module load, BEFORE anything else runs. Our infrastructure uses
// these instead of the live `self.X`, so we survive the hardening step
// (which deletes the same names from `globalThis`) and any user-code
// monkey-patching of replacements.

const postMessageToHost = self.postMessage.bind(self);
const addHostListener = self.addEventListener.bind(self);
const setIntervalSafe = setInterval;
const setTimeoutSafe = setTimeout;
const processExit = process.exit.bind(process);
const stderrWrite = process.stderr.write.bind(process.stderr);

// ─── State ──────────────────────────────────────────────────────────────────

type CompiledScript = (sandbox: Record<string, unknown>) => unknown;

const contexts = new Map<number, Record<string, unknown>>();
const scripts = new Map<number, CompiledScript>();
/** Callables: precompiled function expressions bound to a context.
 * Each entry holds the already-evaluated function value plus the
 * contextId it was compiled against. Per-call cost is
 * `fn.apply(undefined, args)`. When a context is disposed, all
 * callables bound to it are cleared too (so the host-side `.call()`
 * gets a clear "unknown callableId" error instead of silently
 * running against orphan state). */
const callables = new Map<
  number,
  { fn: (...args: unknown[]) => unknown; contextId: number }
>();

let nextCallId = 1;
const pendingRefCalls = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: unknown) => void }
>();

let initialized = false;
let memoryLimitMb = 64;
let sandboxPrototype: Record<string, unknown> | null = null;

// ─── Wire value rehydration ─────────────────────────────────────────────────

const rehydrate = (wire: WireValue): unknown => {
  if (wire.kind === "value") return wire.value;
  if (wire.kind === "externalCopy") return wire.value;
  const { refId } = wire;
  return (...args: unknown[]): Promise<unknown> => {
    const callId = nextCallId++;
    return new Promise((resolve, reject) => {
      pendingRefCalls.set(callId, { resolve, reject });
      postMessageToHost({
        type: "refCall",
        callId,
        refId,
        args,
      } satisfies WorkerEvent);
    });
  };
};

const STANDARD_ERROR_KEYS = new Set(["name", "message", "stack", "cause"]);

const wrapError = (error: unknown, depth = 0): WireError => {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }
  const wire: WireError = {
    name: error.name,
    message: error.message,
  };
  if (typeof error.stack === "string" && error.stack.length > 0) {
    wire.stack = error.stack;
  }
  // Walk the cause chain, but bound depth so a circular `cause: self` can't
  // loop forever.
  if (error.cause !== undefined && error.cause !== null && depth < 10) {
    wire.cause = wrapError(error.cause, depth + 1);
  }
  // Custom Error subclasses (FooError with `.code`, `.statusCode`, etc.)
  // carry instance data beyond name/message. Capture enumerable own props
  // that aren't standard Error keys, dropping anything not cloneable.
  const props: Record<string, unknown> = {};
  let hasProps = false;
  for (const key of Object.keys(error)) {
    if (STANDARD_ERROR_KEYS.has(key)) continue;
    const value = (error as unknown as Record<string, unknown>)[key];
    try {
      structuredClone(value);
      props[key] = value;
      hasProps = true;
    } catch {
      // skip non-clonable
    }
  }
  if (hasProps) wire.props = props;
  return wire;
};

const jsonByteSize = (value: unknown): number | undefined => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return undefined;
  }
};

const enforceResultSize = (
  value: unknown,
  maxResultBytes: number | undefined,
): void => {
  if (maxResultBytes === undefined) return;
  const observedBytes = jsonByteSize(value);
  if (observedBytes === undefined || observedBytes <= maxResultBytes) return;
  const error = new Error(
    `Result size (${observedBytes} bytes) exceeded the ${maxResultBytes} byte limit`,
  ) as Error & {
    code: string;
    maxResultBytes: number;
    observedBytes: number;
  };
  error.name = "ResultSizeError";
  error.code = "RESULT_SIZE_LIMIT";
  error.maxResultBytes = maxResultBytes;
  error.observedBytes = observedBytes;
  throw error;
};

// ─── Hardening (T2.1) ───────────────────────────────────────────────────────

/**
 * Host-capability globals we want gone from the sandbox. Some are deletable
 * from `globalThis` (clean removal); some (notably `Bun`) are non-configurable
 * and must be shadowed via the sandbox object. We do both: delete what's
 * deletable AND shadow every name on the sandbox prototype, belt-and-suspenders.
 */
const HARDEN_TARGETS = [
  // Network
  "fetch",
  "WebSocket",
  "EventSource",
  "XMLHttpRequest",
  // Subprocess / FS / process control
  "Bun",
  "process",
  "Deno",
  "require",
  // Threading / host comms
  "Worker",
  "MessageChannel",
  "BroadcastChannel",
  "postMessage",
  "addEventListener",
  "removeEventListener",
  "close",
  // Browser-side capabilities
  "navigator",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "serviceWorker",
] as const;

const hardenGlobals = (unsafelyExposeGlobals: string[]): void => {
  const g = globalThis as Record<string, unknown>;
  const exposed = new Set(unsafelyExposeGlobals);
  for (const name of HARDEN_TARGETS) {
    if (exposed.has(name)) continue;
    try {
      delete g[name];
    } catch {
      // Non-configurable (e.g. `Bun`). The sandbox-prototype shadow below
      // still hides it from bare identifier lookup, `this.X`, and
      // `globalThis.X`. Indirect-eval escape remains documented.
    }
  }
};

/**
 * Build the sandbox prototype. We DON'T inherit from globalThis — a
 * `with(sandbox)` block's scope chain falls through to the enclosing
 * function / module / global scope automatically, so safe built-ins like
 * `Math` / `JSON` / `Promise` resolve via that fallthrough at no heap cost.
 * Inheriting from globalThis instead duplicated JSC's globalThis structure
 * chain and pushed cold-start heap from ~12 MB to ~46 MB, breaking small
 * memoryLimit caps.
 *
 * The only OWN properties on the prototype are the non-deletable
 * `HARDEN_TARGETS` shadowed as `undefined`. Configurable targets (fetch,
 * process, …) were already removed by hardenGlobals from the worker's real
 * globalThis, so with-fallthrough finds them gone.
 */
const buildSandboxPrototype = (
  harden: boolean,
  unsafelyExposeGlobals: string[],
): Record<string, unknown> => {
  const proto = Object.create(null) as Record<string, unknown>;
  if (!harden) return proto;
  const exposed = new Set(unsafelyExposeGlobals);
  for (const name of HARDEN_TARGETS) {
    if (exposed.has(name)) continue;
    const desc = Object.getOwnPropertyDescriptor(globalThis, name);
    // Configurable targets: hardenGlobals deleted them from globalThis,
    // so with-fallthrough already returns undefined. The shadow here is
    // belt-and-suspenders for the `globalThis.fetch` / `this.fetch` paths
    // (where with-fallthrough doesn't apply — those are explicit lookups
    // on the sandbox itself or its inherited globalThis pointer).
    //
    // Non-configurable targets (Bun): hardenGlobals couldn't delete, so
    // the shadow is the ONLY line of defense. Both paths use the same
    // defineProperty call.
    if (desc === undefined) continue; // not present in this Bun build
    proto[name] = undefined;
  }
  return proto;
};

/** Shared across all contexts of this isolate. Closes `globalThis.X` and
 * `this.X` escapes for non-deletable globals (Bun) while letting
 * `globalThis.JSON` / `this.Math.PI` keep working. We use Object.create on
 * globalThis (not a Proxy) because Proxy's `get` trap can't lie about
 * non-configurable + non-writable properties of the target — and `Bun`,
 * `globalThis` itself, and a few others on the worker's globalThis fall in
 * that bucket. The own-property shadow on an Object.create wrapper sidesteps
 * the invariant since the shadow is on a DIFFERENT object from the target. */
let globalThisShadow: object | null = null;
const buildGlobalThisShadow = (
  harden: boolean,
  unsafelyExposeGlobals: string[],
): object => {
  if (!harden) return globalThis;
  const exposed = new Set(unsafelyExposeGlobals);
  const shadow = Object.create(globalThis);
  for (const name of HARDEN_TARGETS) {
    if (exposed.has(name)) continue;
    const desc = Object.getOwnPropertyDescriptor(globalThis, name);
    if (desc === undefined) continue;
    Object.defineProperty(shadow, name, {
      value: undefined,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  return shadow;
};

const newSandbox = (): Record<string, unknown> => {
  const sandbox = Object.create(sandboxPrototype) as Record<string, unknown>;
  // `sandbox.globalThis` = the Proxy so `globalThis.X` and `this.X` resolve
  // through it. Bare identifiers fall through to outer scope without hitting
  // the Proxy. defineProperty because the inherited `globalThis` slot from
  // the worker's globalThis is non-writable.
  Object.defineProperty(sandbox, "globalThis", {
    value: globalThisShadow,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  return sandbox;
};

// ─── Compile ────────────────────────────────────────────────────────────────

/**
 * Compile user source. We wrap in an async-aware `(function () { with (this)
 * { return eval(...); } }).call(sandbox)` so:
 *
 * - statements like `while`, `for`, `function foo() {}` work (eval's grammar
 *   accepts scripts, not just expressions);
 * - the with-block makes the sandbox the lookup root for bare identifiers;
 * - `this` inside the wrapper is the sandbox, so `this.X` resolves there;
 * - the script's completion value (vm.Script-style) is what comes back.
 *
 * Non-strict on purpose: `with` is forbidden under strict mode. User source
 * can opt into strict per-script by starting with `"use strict"` (which only
 * binds the user's own block).
 */
const compile = (source: string): CompiledScript => {
  const wrapped = `return (function () { with (this) { return eval(${JSON.stringify(source)}); } }).call(sandbox);`;
  return new Function("sandbox", wrapped) as CompiledScript;
};

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
        postMessageToHost({
          type: "console",
          level,
          args,
        } satisfies WorkerEvent);
      } catch {
        postMessageToHost({
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
  setIntervalSafe((): void => {
    const usage = memoryUsage();
    if (usage.current > memoryLimitBytes) {
      postMessageToHost({
        type: "fatal",
        kind: "memory",
        observedBytes: usage.current,
        memoryLimitMb,
      } satisfies WorkerEvent);
      setTimeoutSafe(() => processExit(1), 5);
    }
  }, 50);
};

const handleInit = (message: WorkerInitMessage): void => {
  memoryLimitMb = message.memoryLimitMb;
  if (message.captureConsole) installConsoleCapture();
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
  // Harden order: build the prototype, then delete from the real globalThis.
  // The prototype uses Object.create(globalThis) so it inherits live; we
  // only place shadow `undefined` properties for the names we want hidden.
  // Doing the proto-build before delete also documents that the proto sees
  // the un-hardened set when needed (harden: false).
  const harden = message.harden !== false;
  const unsafelyExposeGlobals = message.unsafelyExposeGlobals ?? [];
  sandboxPrototype = buildSandboxPrototype(harden, unsafelyExposeGlobals);
  globalThisShadow = buildGlobalThisShadow(harden, unsafelyExposeGlobals);
  if (harden) {
    hardenGlobals(unsafelyExposeGlobals);
  }
  startMemoryWatchdog();
  initialized = true;
  postMessageToHost({ type: "ready" } satisfies WorkerEvent);
};

// ─── Dispatch ───────────────────────────────────────────────────────────────

const handleMessage = async (event: MessageEvent): Promise<void> => {
  const message = event.data as HostMessage;

  if (!initialized) {
    if ("op" in message && message.op === "init") {
      handleInit(message);
      return;
    }
    return;
  }

  if (message.op === "init") return;
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
        case "compileCallable": {
          const sandbox = contexts.get(request.contextId);
          if (sandbox === undefined)
            throw new Error(`unknown contextId ${request.contextId}`);
          // Evaluate the source as a function expression inside the
          // sandbox's with-scope so the function's [[Scope]] captures
          // the context's globals (console, Promise, user-set globals).
          // Per-call invocation then runs against that scope.
          const compiledExpr = new Function(
            "sandbox",
            `return (function () { with (this) { return eval(${JSON.stringify(`(${request.source})`)}); } }).call(sandbox);`,
          );
          const value = compiledExpr(sandbox);
          if (typeof value !== "function") {
            throw new TypeError(
              `compileCallable source must evaluate to a function; got ${typeof value}`,
            );
          }
          callables.set(request.id, {
            contextId: request.contextId,
            fn: value as (...args: unknown[]) => unknown,
          });
          return { id: request.id, ok: true, result: request.id };
        }
        case "createContext": {
          const sandbox = newSandbox();
          // Restore snapshot first so seed code can read accumulated state.
          if (request.snapshot !== undefined) {
            for (const [name, value] of Object.entries(request.snapshot)) {
              sandbox[name] = value;
            }
          }
          // Then run seed code so it can define functions on top of the
          // restored data. Seed runs through compile() so it sees the
          // sandbox the same way a normal script does.
          if (request.seed !== undefined) {
            const seedFn = compile(request.seed);
            await seedFn(sandbox);
          }
          contexts.set(request.id, sandbox);
          return { id: request.id, ok: true, result: request.id };
        }
        case "snapshotContext": {
          const sandbox = contexts.get(request.contextId);
          if (sandbox === undefined)
            throw new Error(`unknown contextId ${request.contextId}`);
          // Iterate OWN properties only (the prototype carries the
          // hardened-undefined shadows and the inherited globalThis chain;
          // neither belongs in user data). For each own property, attempt
          // a structured-clone round-trip; if it throws (function, host
          // Reference, etc.), skip silently.
          const snapshot: Record<string, unknown> = {};
          for (const name of Object.getOwnPropertyNames(sandbox)) {
            if (name === "globalThis") continue;
            const value = (sandbox as Record<string, unknown>)[name];
            try {
              // structuredClone is the contract test for cloneability;
              // we keep the original value (not the clone) so identity
              // is preserved for the host's structured clone over postMessage.
              structuredClone(value);
              snapshot[name] = value;
            } catch {
              // not cloneable — skip
            }
          }
          return {
            id: request.id,
            ok: true,
            result: { kind: "value", value: snapshot },
          };
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
          const wantMetrics = request.withMetrics === true;
          const startedAt = wantMetrics ? Date.now() : 0;
          const result = await script(sandbox);
          enforceResultSize(result, request.maxResultBytes);
          const reply: WorkerReply = {
            id: request.id,
            ok: true,
            result: { kind: "value", value: result },
          };
          if (wantMetrics) {
            reply.metrics = {
              cpuMs: Date.now() - startedAt,
              heapBytes: memoryUsage().current,
            };
          }
          return reply;
        }
        case "call": {
          const callable = callables.get(request.callableId);
          if (callable === undefined)
            throw new Error(`unknown callableId ${request.callableId}`);
          const wantMetrics = request.withMetrics === true;
          const startedAt = wantMetrics ? Date.now() : 0;
          const argValues = request.args.map((a) => rehydrate(a));
          const result = await callable.fn(...argValues);
          enforceResultSize(result, request.maxResultBytes);
          const reply: WorkerReply = {
            id: request.id,
            ok: true,
            result: { kind: "value", value: result },
          };
          if (wantMetrics) {
            reply.metrics = {
              cpuMs: Date.now() - startedAt,
              heapBytes: memoryUsage().current,
            };
          }
          return reply;
        }
        case "disposeContext": {
          contexts.delete(request.contextId);
          // Cascade: drop any callables bound to this context so a
          // later `.call()` reports a clean "unknown callableId"
          // instead of silently invoking against an orphan sandbox.
          for (const [callableId, callable] of callables) {
            if (callable.contextId === request.contextId) {
              callables.delete(callableId);
            }
          }
          return { id: request.id, ok: true, result: null };
        }
        case "disposeScript": {
          scripts.delete(request.scriptId);
          return { id: request.id, ok: true, result: null };
        }
        case "disposeCallable": {
          callables.delete(request.callableId);
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
    postMessageToHost(reply);
  } catch (error) {
    postMessageToHost({
      id: request.id,
      ok: false,
      error: wrapError(error),
    } satisfies WorkerReply);
  }
};

addHostListener("message", (event: MessageEvent): void => {
  handleMessage(event).catch((err) => {
    stderrWrite(
      `[worker] handleMessage rejected: ${(err as Error).message}\n${(err as Error).stack ?? ""}\n`,
    );
  });
});
