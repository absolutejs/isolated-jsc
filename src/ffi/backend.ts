/**
 * FFI-backed `Isolate` implementation. Calls libJavaScriptCore directly via
 * `bun:ffi` — no Worker, no message-passing. Replaces the v0.1 Worker
 * backend on platforms where libJSC is reachable (macOS always; Linux
 * with libjavascriptcoregtk installed). Same public API surface.
 *
 * Phase 1 (this file): core eval path + value marshalling + harden +
 * watchdog (CPU + heap). References use a JSClassCreate-backed function
 * with private data carrying a refId; the host side maintains the lookup
 * table. Snapshot reads sandbox own-property names via
 * `JSObjectCopyPropertyNames` and JSON-round-trips each.
 *
 * Eval boundary trade-off vs Worker: timeouts here use
 * `JSContextGroupSetExecutionTimeLimit`, which throws a
 * `TerminationException` *into the script's stack*. The isolate keeps
 * running — strictly better than v1's "the whole isolate dies on timeout."
 *
 * Hardening trade-off: `JSGlobalContextSetEvalEnabled(ctx, false, msg)`
 * closes the two T2 documented residuals (`(0, eval)('Bun')` and `new
 * Function('return Bun')()`) at the cost of disabling eval/Function entirely
 * for that context. We disable when `harden !== false`.
 */

import {
  JSCallback,
  FFIType,
  ptr,
  read,
  toArrayBuffer,
  type Pointer,
} from "bun:ffi";
import {
  type Callable,
  CompileError,
  type Context,
  type ContextCheckpoint,
  type ContextCheckpointOptions,
  type ContextCheckpointSkippedKey,
  type CreateContextOptions,
  ExternalCopy,
  IsolateDisposedError,
  MemoryLimitError,
  Reference,
  type Isolate,
  type IsolateOptions,
  type RunReceiptOptions,
  type RunOptions,
  type RunWithMetricsResult,
  type RunWithReceiptResult,
  type Script,
  TimeoutError,
} from "../types";
import { openJsc, type JscSymbols } from "./bindings";
import { hostToJs, jsToHost, makeJsString, readJsString } from "./values";
import { applyIsolatePolicyOptions } from "../policy";
import type { ResolvedIsolatePolicy } from "../policy";
import {
  attachReceipt,
  createErrorReceipt,
  createSuccessReceipt,
} from "../receipt";
import { enforceResultSize } from "../resultLimits";
import {
  checkpointWithReceipt,
  createContextWithReceipt,
  validateContextCheckpoint,
} from "../checkpoint";

const encodedBytes = (value: unknown): number | undefined => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return undefined;
  }
};

const createDataCheckpoint = (
  backend: ContextCheckpoint["backend"],
  entries: Iterable<[string, unknown]>,
  options?: ContextCheckpointOptions,
): ContextCheckpoint => {
  const data: Record<string, unknown> = {};
  const skipped: ContextCheckpointSkippedKey[] = [];
  let byteLength = encodedBytes(data) ?? 2;

  for (const [name, value] of entries) {
    if (name === "globalThis") continue;
    if (options?.include !== undefined && !options.include.includes(name)) {
      skipped.push({ key: name, reason: "excluded" });
      continue;
    }
    if ((options?.exclude ?? []).includes(name)) {
      skipped.push({ key: name, reason: "excluded" });
      continue;
    }
    try {
      structuredClone(value);
    } catch {
      skipped.push({ key: name, reason: "not-clonable" });
      continue;
    }
    const nextData = { ...data, [name]: value };
    const nextBytes = encodedBytes(nextData);
    if (nextBytes === undefined) {
      skipped.push({ key: name, reason: "not-clonable" });
      continue;
    }
    if (options?.maxBytes !== undefined && nextBytes > options.maxBytes) {
      skipped.push({ key: name, reason: "over-max-bytes", bytes: nextBytes });
      continue;
    }
    data[name] = value;
    byteLength = nextBytes;
  }

  return {
    backend,
    byteLength,
    data,
    included: Object.keys(data).length,
    schemaVersion: 1,
    skipped,
    skippedCount: skipped.length,
  };
};

// Same HARDEN_TARGETS the Worker backend uses (T2.1).
const HARDEN_TARGETS = [
  "fetch",
  "WebSocket",
  "EventSource",
  "XMLHttpRequest",
  "Bun",
  "process",
  "Deno",
  "require",
  "Worker",
  "MessageChannel",
  "BroadcastChannel",
  "postMessage",
  "addEventListener",
  "removeEventListener",
  "close",
  "navigator",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "serviceWorker",
] as const;

const NUL = "\0";

/** Per-isolate state held in closures across all the per-Isolate methods. */
type IsolateFfiState = {
  symbols: JscSymbols;
  group: bigint;
  /** Map context id → JSGlobalContextRef (the global context within the group). */
  contexts: Map<number, bigint>;
  /** Map script id → compiled JSString (we re-eval each time; JSC doesn't
   * have a public "compiled script" surface, just `JSEvaluateScript`). */
  scripts: Map<number, { source: string; sourceUrl: string }>;
  /** Refs: map refId → host fn for the Reference call-through machinery. */
  refs: Map<number, (...args: unknown[]) => unknown>;
  /** JSCallbacks for each Reference's `callAsFunction` — kept alive for the
   * isolate's lifetime; closed on dispose to free the C-side thunks. */
  referenceCallbacks: JSCallback[];
  /** Callables: precompiled function expressions bound to a context.
   * Each entry holds the JSValueRef of the function (protected via
   * `JSValueProtect` so it survives across calls). Per-call invocation
   * goes through `JSObjectCallAsFunction` — no eval, no setGlobal. */
  callables: Map<number, { ctx: bigint; fnValue: bigint }>;
  nextContextId: number;
  nextScriptId: number;
  nextRefId: number;
  nextCallableId: number;
  disposed: boolean;
  options: Required<Pick<IsolateOptions, "memoryLimit">>;
  defaultRunOptions: Required<Pick<RunOptions, "timeout">> &
    Pick<RunOptions, "maxResultBytes">;
  policy: ResolvedIsolatePolicy | undefined;
  memoryLimitBytes: number;
  /** Set the watchdog observed before terminating; surfaced as the
   * MemoryLimitError observedBytes on the next caller. */
  lastMemorySnapshot: number;
  watchdogCallback: JSCallback | null;
  /** Per-isolate flag the watchdog flips on memory overage. The next eval
   * we initiate checks this and converts the TerminationException into a
   * MemoryLimitError so callers see the right error type. */
  memoryOverage: boolean;
};

/** Walk the changes a watchdog cares about and decide whether to terminate.
 * Called by JSC on every JIT timeslice during long-running script execution.
 * Returns `true` to terminate. */
const buildWatchdog = (state: IsolateFfiState): JSCallback =>
  new JSCallback(
    (_ctx: Pointer, _userData: Pointer): boolean => {
      // JSC fires this callback when the execution time limit is reached;
      // returning `true` terminates the script. We sample heap stats here
      // to distinguish "CPU timeout" vs "memory overage" downstream — the
      // caller checks `state.memoryOverage` after the throw and converts
      // to MemoryLimitError if set. Either way, we always terminate when
      // the callback fires.
      try {
        const ctx0 = state.contexts.values().next().value ?? 0n;
        if (ctx0 !== 0n) {
          const statsObj = state.symbols.JSGetMemoryUsageStatistics(ctx0);
          if (statsObj !== 0n) {
            // Pull `heapCapacity` (the right field — `heapSize` stays 0 in
            // practice; `heapCapacity` tracks JSC's reserved heap memory,
            // which is what we want to cap). Plus `extraMemorySize` for
            // off-heap allocations.
            const stats = jsToHost(state.symbols, ctx0, statsObj) as
              | { heapCapacity?: number; extraMemorySize?: number }
              | undefined;
            const heapBytes =
              (stats?.heapCapacity ?? 0) + (stats?.extraMemorySize ?? 0);
            state.lastMemorySnapshot = heapBytes;
            if (heapBytes > state.memoryLimitBytes) {
              state.memoryOverage = true;
            }
          }
        }
      } catch {
        // Snapshot failure — we still terminate, just without a memory
        // verdict; surfaces as TimeoutError to the caller.
      }
      return true;
    },
    {
      args: [FFIType.pointer, FFIType.pointer],
      returns: FFIType.bool,
    },
  );

const STANDARD_ERROR_KEYS = new Set(["name", "message", "stack", "cause"]);

const setObjectProperty = (
  s: JscSymbols,
  ctx: bigint,
  object: bigint,
  name: string,
  value: unknown,
): void => {
  const propName = makeJsString(s, name);
  const exc = new BigUint64Array(1);
  s.JSObjectSetProperty(
    ctx,
    object,
    propName,
    hostToJs(s, ctx, value),
    0,
    BigInt(ptr(exc)),
  );
  s.JSStringRelease(propName);
};

const makeErrorObject = (
  s: JscSymbols,
  ctx: bigint,
  error: unknown,
): bigint => {
  const message = error instanceof Error ? error.message : String(error);
  const messageJs = makeJsString(s, message);
  const messageValue = s.JSValueMakeString(ctx, messageJs);
  s.JSStringRelease(messageJs);
  const argsBuf = new BigUint64Array([messageValue]);
  const innerExc = new BigUint64Array(1);
  const errObj = s.JSObjectMakeError(
    ctx,
    1n,
    BigInt(ptr(argsBuf)),
    BigInt(ptr(innerExc)),
  );
  if (error instanceof Error) {
    setObjectProperty(s, ctx, errObj, "name", error.name);
    for (const key of Object.keys(error)) {
      if (STANDARD_ERROR_KEYS.has(key)) continue;
      const value = (error as unknown as Record<string, unknown>)[key];
      try {
        structuredClone(value);
        setObjectProperty(s, ctx, errObj, key, value);
      } catch {
        // skip non-clonable
      }
    }
  }
  return errObj;
};

/** Install undefined-shadows on the new context's globalThis for HARDEN_TARGETS.
 * Plus disable eval/Function via JSGlobalContextSetEvalEnabled to close the
 * indirect-eval and Function-constructor escapes. */
const applyHarden = (
  state: IsolateFfiState,
  ctx: bigint,
  unsafelyExposeGlobals: string[],
): void => {
  const s = state.symbols;
  const exposed = new Set(unsafelyExposeGlobals);
  const global = s.JSContextGetGlobalObject(ctx);
  const exc = new BigUint64Array(1);
  for (const name of HARDEN_TARGETS) {
    if (exposed.has(name)) continue;
    const propName = makeJsString(s, name);
    s.JSObjectSetProperty(
      ctx,
      global,
      propName,
      s.JSValueMakeUndefined(ctx),
      0, // attributes = none (writable, configurable, enumerable)
      BigInt(ptr(exc)),
    );
    s.JSStringRelease(propName);
  }
  // The big T3 win — close the indirect-eval / Function-constructor escapes.
  const msg = makeJsString(s, "eval disabled in isolated-jsc sandbox");
  s.JSGlobalContextSetEvalEnabled(ctx, false, msg);
  s.JSStringRelease(msg);
};

/** Read `error.message` / `name` / `stack` off a JSValueRef that we know
 * is an Error. Used to convert JSC exceptions into host Errors. */
const errorFromJsValue = (s: JscSymbols, ctx: bigint, value: bigint): Error => {
  const exc = new BigUint64Array(1);
  const messageProp = makeJsString(s, "message");
  const nameProp = makeJsString(s, "name");
  const stackProp = makeJsString(s, "stack");
  const codeProp = makeJsString(s, "code");
  const maxOutputBytesProp = makeJsString(s, "maxOutputBytes");
  const observedBytesProp = makeJsString(s, "observedBytes");
  const toolProp = makeJsString(s, "tool");
  const isObject = s.JSValueIsObject(ctx, value);

  let message = "unknown";
  let name = "Error";
  let stack: string | undefined;
  let code: string | undefined;
  let maxOutputBytes: number | undefined;
  let observedBytes: number | undefined;
  let tool: string | undefined;

  if (isObject) {
    const msgVal = s.JSObjectGetProperty(
      ctx,
      value,
      messageProp,
      BigInt(ptr(exc)),
    );
    if (msgVal !== 0n && s.JSValueIsString(ctx, msgVal)) {
      message = jsToHost(s, ctx, msgVal) as string;
    } else {
      // Object without message property — stringify the whole thing as fallback.
      message = (jsToHost(s, ctx, value) as string) ?? "unknown";
    }
    const nameVal = s.JSObjectGetProperty(
      ctx,
      value,
      nameProp,
      BigInt(ptr(exc)),
    );
    if (nameVal !== 0n && s.JSValueIsString(ctx, nameVal)) {
      name = jsToHost(s, ctx, nameVal) as string;
    }
    const stackVal = s.JSObjectGetProperty(
      ctx,
      value,
      stackProp,
      BigInt(ptr(exc)),
    );
    if (stackVal !== 0n && s.JSValueIsString(ctx, stackVal)) {
      stack = jsToHost(s, ctx, stackVal) as string;
    }
    const codeVal = s.JSObjectGetProperty(
      ctx,
      value,
      codeProp,
      BigInt(ptr(exc)),
    );
    if (codeVal !== 0n && s.JSValueIsString(ctx, codeVal)) {
      code = jsToHost(s, ctx, codeVal) as string;
    }
    const toolVal = s.JSObjectGetProperty(
      ctx,
      value,
      toolProp,
      BigInt(ptr(exc)),
    );
    if (toolVal !== 0n && s.JSValueIsString(ctx, toolVal)) {
      tool = jsToHost(s, ctx, toolVal) as string;
    }
    const maxOutputBytesVal = s.JSObjectGetProperty(
      ctx,
      value,
      maxOutputBytesProp,
      BigInt(ptr(exc)),
    );
    if (maxOutputBytesVal !== 0n && s.JSValueIsNumber(ctx, maxOutputBytesVal)) {
      maxOutputBytes = jsToHost(s, ctx, maxOutputBytesVal) as number;
    }
    const observedBytesVal = s.JSObjectGetProperty(
      ctx,
      value,
      observedBytesProp,
      BigInt(ptr(exc)),
    );
    if (observedBytesVal !== 0n && s.JSValueIsNumber(ctx, observedBytesVal)) {
      observedBytes = jsToHost(s, ctx, observedBytesVal) as number;
    }
  } else if (s.JSValueIsString(ctx, value)) {
    message = jsToHost(s, ctx, value) as string;
  }

  s.JSStringRelease(messageProp);
  s.JSStringRelease(nameProp);
  s.JSStringRelease(stackProp);
  s.JSStringRelease(codeProp);
  s.JSStringRelease(maxOutputBytesProp);
  s.JSStringRelease(observedBytesProp);
  s.JSStringRelease(toolProp);

  const error = new Error(message);
  error.name = name;
  if (stack !== undefined) error.stack = stack;
  if (code !== undefined) {
    (error as Error & { code?: string }).code = code;
  }
  if (tool !== undefined) {
    (error as Error & { tool?: string }).tool = tool;
  }
  if (maxOutputBytes !== undefined) {
    (error as Error & { maxOutputBytes?: number }).maxOutputBytes =
      maxOutputBytes;
  }
  if (observedBytes !== undefined) {
    (error as Error & { observedBytes?: number }).observedBytes = observedBytes;
  }
  return error;
};

/** Run JSEvaluateScript and translate any exception out-param into a thrown
 * host Error. Returns the JSValueRef result, or throws. */
const evalAndCheck = (
  state: IsolateFfiState,
  ctx: bigint,
  source: string,
  sourceUrl: string,
): bigint => {
  const s = state.symbols;
  const jsSource = makeJsString(s, source);
  const jsUrl = sourceUrl !== "" ? makeJsString(s, sourceUrl) : 0n;
  const exc = new BigUint64Array(1);
  const result = s.JSEvaluateScript(
    ctx,
    jsSource,
    0n,
    jsUrl,
    1,
    BigInt(ptr(exc)),
  );
  s.JSStringRelease(jsSource);
  if (jsUrl !== 0n) s.JSStringRelease(jsUrl);
  if (exc[0] !== 0n) {
    // If the watchdog flipped memory-overage, surface as MemoryLimitError
    // (the JSC exception will be "JavaScript execution terminated" — useful
    // info but the wrong type for our caller).
    if (state.memoryOverage) {
      state.memoryOverage = false;
      throw new MemoryLimitError(
        state.options.memoryLimit,
        state.lastMemorySnapshot,
      );
    }
    const error = errorFromJsValue(s, ctx, exc[0]!);
    // Detect the watchdog's CPU-timeout termination message.
    if (
      error.name === "Error" &&
      typeof error.message === "string" &&
      error.message.includes("execution terminated")
    ) {
      throw new TimeoutError(0); // timeout MS unknown from JSC's side
    }
    throw error;
  }
  return result;
};

export const createIsolateFfi = async (
  options: IsolateOptions = {},
): Promise<Isolate> => {
  const effectiveOptions = applyIsolatePolicyOptions(options);
  const probe = openJsc();
  if (!probe.ok) throw probe.error;
  const symbols = probe.symbols;

  const memoryLimit = effectiveOptions.memoryLimit ?? 128;
  const group = symbols.JSContextGroupCreate();

  const state: IsolateFfiState = {
    symbols,
    group,
    contexts: new Map(),
    scripts: new Map(),
    refs: new Map(),
    referenceCallbacks: [],
    callables: new Map(),
    nextContextId: 1,
    nextScriptId: 1,
    nextRefId: 1,
    nextCallableId: 1,
    disposed: false,
    options: { memoryLimit },
    defaultRunOptions: {
      maxResultBytes: effectiveOptions.defaultRunOptions?.maxResultBytes,
      timeout: effectiveOptions.defaultRunOptions?.timeout ?? 1000,
    },
    policy: effectiveOptions.policy,
    memoryLimitBytes: memoryLimit * 1024 * 1024,
    lastMemorySnapshot: 0,
    watchdogCallback: null,
    memoryOverage: false,
  };

  // We register the watchdog ONCE per isolate. The default timeout is
  // effectively "no limit" until a Script.run sets one; each Script.run
  // updates the limit just before evaluating.
  state.watchdogCallback = buildWatchdog(state);
  symbols.JSContextGroupSetExecutionTimeLimit(
    group,
    1e9, // effectively unlimited; per-run limit is set per Script.run
    BigInt(state.watchdogCallback.ptr ?? 0),
    0n,
  );

  // Run bootstrap once in a synthetic context at the worker module level
  // — same as Worker backend's bootstrap. We create a throwaway ctx,
  // eval, throw it away.
  if (
    typeof effectiveOptions.bootstrap === "string" &&
    effectiveOptions.bootstrap.length > 0
  ) {
    const bootCtx = symbols.JSGlobalContextCreateInGroup(group, 0n);
    try {
      evalAndCheck(state, bootCtx, effectiveOptions.bootstrap, "<bootstrap>");
    } catch {
      // Bootstrap failures are silent (same as Worker backend).
    }
    symbols.JSGlobalContextRelease(bootCtx);
  }

  const isolate: Isolate = {
    options: state.options,
    defaultRunOptions: state.defaultRunOptions,
    policy: state.policy,
    backend: "ffi",
    get isDisposed(): boolean {
      return state.disposed;
    },

    async compileScript(source: string): Promise<Script> {
      if (state.disposed) throw new IsolateDisposedError();
      // JSCheckScriptSyntax against the first context (or a temp one).
      const ctx =
        state.contexts.values().next().value ??
        symbols.JSGlobalContextCreateInGroup(group, 0n);
      const jsSource = makeJsString(symbols, source);
      const exc = new BigUint64Array(1);
      const ok = symbols.JSCheckScriptSyntax(
        ctx,
        jsSource,
        0n,
        1,
        BigInt(ptr(exc)),
      );
      symbols.JSStringRelease(jsSource);
      if (!ok) {
        const excValue = exc[0] ?? 0n;
        const error =
          excValue !== 0n ? errorFromJsValue(symbols, ctx, excValue) : null;
        throw new CompileError(error?.message ?? "syntax error", source);
      }
      const scriptId = state.nextScriptId++;
      state.scripts.set(scriptId, {
        source,
        sourceUrl: `<script:${scriptId}>`,
      });
      return makeFfiScript(state, isolate, scriptId);
    },

    async createContext(opts?: CreateContextOptions): Promise<Context> {
      if (state.disposed) throw new IsolateDisposedError();
      const id = state.nextContextId++;
      const ctx = symbols.JSGlobalContextCreateInGroup(group, 0n);
      state.contexts.set(id, ctx);

      // Hardening: install undefined shadows + disable eval. Default on.
      if (effectiveOptions.harden !== false) {
        applyHarden(state, ctx, effectiveOptions.unsafelyExposeGlobals ?? []);
      }

      // Restore checkpoint/snapshot first so seed code can read it.
      const restoredData =
        opts?.checkpoint === undefined
          ? opts?.snapshot
          : validateContextCheckpoint(opts.checkpoint);
      if (restoredData !== undefined) {
        const global = symbols.JSContextGetGlobalObject(ctx);
        const exc = new BigUint64Array(1);
        for (const [name, value] of Object.entries(restoredData)) {
          const propName = makeJsString(symbols, name);
          const jsValue = hostToJs(symbols, ctx, value);
          symbols.JSObjectSetProperty(
            ctx,
            global,
            propName,
            jsValue,
            0,
            BigInt(ptr(exc)),
          );
          symbols.JSStringRelease(propName);
        }
      }

      // Then seed code so it can build on snapshot values.
      if (opts?.seed !== undefined) {
        evalAndCheck(state, ctx, opts.seed, `<seed:${id}>`);
      }

      return makeFfiContext(state, isolate, id);
    },

    createContextWithReceipt(opts) {
      return createContextWithReceipt(isolate, opts);
    },

    async heapSizeBytes(): Promise<number> {
      if (state.disposed) return 0;
      const ctx =
        state.contexts.values().next().value ??
        symbols.JSGlobalContextCreateInGroup(group, 0n);
      const stats = symbols.JSGetMemoryUsageStatistics(ctx);
      if (stats === 0n) return 0;
      const data = jsToHost(symbols, ctx, stats) as
        | {
            heapCapacity?: number;
            extraMemorySize?: number;
          }
        | undefined;
      return (data?.heapCapacity ?? 0) + (data?.extraMemorySize ?? 0);
    },

    async dispose(): Promise<void> {
      if (state.disposed) return;
      state.disposed = true;
      // Clear the execution time limit so JSC doesn't keep the watchdog
      // running against a freed callback.
      symbols.JSContextGroupClearExecutionTimeLimit(group);
      // Unprotect every callable's function value so the heap can be
      // reclaimed. Safe to do before context release; JSValueUnprotect
      // just decrements the protection count.
      for (const callable of state.callables.values()) {
        symbols.JSValueUnprotect(callable.ctx, callable.fnValue);
      }
      state.callables.clear();
      for (const ctx of state.contexts.values()) {
        symbols.JSGlobalContextRelease(ctx);
      }
      state.contexts.clear();
      symbols.JSContextGroupRelease(group);
      state.watchdogCallback?.close();
      // Free C-side thunks for every Reference callback. After this point
      // any leftover JS-land reference to one of these functions would
      // segfault if invoked — but the contexts are gone, so they can't be.
      for (const cb of state.referenceCallbacks) cb.close();
      state.referenceCallbacks.length = 0;
    },
  };

  return isolate;
};

const contextIdBrand = new WeakMap<Context, number>();
const contextIdOf = (context: Context): number => {
  const id = contextIdBrand.get(context);
  if (id === undefined)
    throw new Error("context is not from this implementation");
  return id;
};

const makeFfiContext = (
  state: IsolateFfiState,
  isolate: Isolate,
  contextId: number,
): Context => {
  const { symbols } = state;

  const context: Context = {
    isolate,

    async compileCallable(source: string): Promise<Callable> {
      const ctx = state.contexts.get(contextId);
      if (ctx === undefined) throw new IsolateDisposedError();
      // Evaluate the source as a function expression. The wrapping
      // arrow forces the source into expression position (so a `function
      // (){}` declaration becomes a function value, not a declaration)
      // and asserts it actually evaluates to a function. SyntaxErrors
      // and the "not a function" TypeError both get wrapped as
      // CompileError so callers can branch on compile-time issues.
      let fnValue: bigint;
      try {
        fnValue = evalAndCheck(
          state,
          ctx,
          `((__src) => { if (typeof __src !== 'function') { throw new TypeError('compileCallable source must evaluate to a function; got ' + typeof __src); } return __src; })(${source})`,
          "<compileCallable>",
        );
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === "SyntaxError" ||
            error.name === "TypeError" ||
            error.message.includes("SyntaxError") ||
            error.message.includes("must evaluate to a function"))
        ) {
          throw new CompileError(error.message, source);
        }
        throw error;
      }
      // Protect the JSValueRef so JSC's GC keeps it alive until we
      // explicitly unprotect on dispose. Without this, the function
      // would be collected after the eval frame returned.
      symbols.JSValueProtect(ctx, fnValue);
      const callableId = state.nextCallableId++;
      state.callables.set(callableId, { ctx, fnValue });
      return makeFfiCallable(state, context, callableId);
    },

    async setGlobal(name: string, value: unknown): Promise<void> {
      const ctx = state.contexts.get(contextId);
      if (ctx === undefined) throw new IsolateDisposedError();
      const global = symbols.JSContextGetGlobalObject(ctx);
      const propName = makeJsString(symbols, name);
      const exc = new BigUint64Array(1);

      let jsValue: bigint;
      if (value instanceof Reference) {
        // For now: install a thin JS function that throws "Reference not
        // yet supported on FFI backend". Wiring the JSClassCreate /
        // JSObjectMakeFunctionWithCallback + JSCallback + DeferredPromise
        // chain is the next FFI step; we land this first so non-Reference
        // tests pass.
        const fn = makeReferenceFunction(state, ctx, value);
        jsValue = fn;
      } else if (value instanceof ExternalCopy) {
        jsValue = hostToJs(symbols, ctx, value.value);
      } else {
        jsValue = hostToJs(symbols, ctx, value);
      }

      symbols.JSObjectSetProperty(
        ctx,
        global,
        propName,
        jsValue,
        0,
        BigInt(ptr(exc)),
      );
      symbols.JSStringRelease(propName);
    },

    async getGlobal(name: string): Promise<unknown> {
      const ctx = state.contexts.get(contextId);
      if (ctx === undefined) throw new IsolateDisposedError();
      const global = symbols.JSContextGetGlobalObject(ctx);
      const propName = makeJsString(symbols, name);
      const exc = new BigUint64Array(1);
      const value = symbols.JSObjectGetProperty(
        ctx,
        global,
        propName,
        BigInt(ptr(exc)),
      );
      symbols.JSStringRelease(propName);
      return jsToHost(symbols, ctx, value);
    },

    async snapshot(): Promise<Record<string, unknown>> {
      return (await this.checkpoint()).data;
    },

    async checkpoint(
      options?: ContextCheckpointOptions,
    ): Promise<ContextCheckpoint> {
      const ctx = state.contexts.get(contextId);
      if (ctx === undefined) throw new IsolateDisposedError();
      const global = symbols.JSContextGetGlobalObject(ctx);
      const names = symbols.JSObjectCopyPropertyNames(ctx, global);
      const count = Number(symbols.JSPropertyNameArrayGetCount(names));
      const entries: Array<[string, unknown]> = [];
      const skipped: ContextCheckpointSkippedKey[] = [];
      const exc = new BigUint64Array(1);
      for (let i = 0; i < count; i++) {
        const nameRef = symbols.JSPropertyNameArrayGetNameAtIndex(
          names,
          BigInt(i),
        );
        const name = readJsString(symbols, nameRef);
        if (name === "globalThis") continue;
        if ((HARDEN_TARGETS as readonly string[]).includes(name)) continue;
        if (options?.include !== undefined && !options.include.includes(name)) {
          entries.push([name, undefined]);
          continue;
        }
        if ((options?.exclude ?? []).includes(name)) {
          entries.push([name, undefined]);
          continue;
        }
        const value = symbols.JSObjectGetProperty(
          ctx,
          global,
          nameRef,
          BigInt(ptr(exc)),
        );
        if (value === 0n) continue;
        if (
          symbols.JSValueIsObject(ctx, value) &&
          symbols.JSObjectIsFunction(ctx, value)
        ) {
          skipped.push({ key: name, reason: "not-clonable" });
          continue;
        }
        try {
          const host = jsToHost(symbols, ctx, value);
          if (host === undefined && !symbols.JSValueIsUndefined(ctx, value)) {
            skipped.push({ key: name, reason: "not-clonable" });
            continue;
          }
          if (typeof host === "function") {
            skipped.push({ key: name, reason: "not-clonable" });
            continue;
          }
          entries.push([name, host]);
        } catch {
          skipped.push({ key: name, reason: "not-clonable" });
        }
      }
      symbols.JSPropertyNameArrayRelease(names);
      const checkpoint = createDataCheckpoint("ffi", entries, options);
      return {
        ...checkpoint,
        skipped: [...skipped, ...checkpoint.skipped],
        skippedCount: skipped.length + checkpoint.skippedCount,
      };
    },

    checkpointWithReceipt(options) {
      return checkpointWithReceipt(context, options);
    },

    async dispose(): Promise<void> {
      const ctx = state.contexts.get(contextId);
      if (ctx === undefined) return;
      // Unprotect every callable bound to this context — the underlying
      // JSGlobalContextRelease would invalidate them anyway, but
      // unprotecting explicitly lets us drop the callables map entry
      // cleanly so a later dispose() doesn't try to unprotect a freed
      // context.
      for (const [callableId, callable] of state.callables) {
        if (callable.ctx === ctx) {
          symbols.JSValueUnprotect(ctx, callable.fnValue);
          state.callables.delete(callableId);
        }
      }
      state.contexts.delete(contextId);
      symbols.JSGlobalContextRelease(ctx);
    },
  };
  contextIdBrand.set(context, contextId);
  return context;
};

/**
 * Per-call invocation for a {@link Callable}. Packs the args (handling
 * References, ExternalCopies, and plain values) into a JSValueRef array,
 * sets the per-call execution time limit, calls
 * `JSObjectCallAsFunction(fn, thisObj=null, argc, argv, exception)`, and
 * unwraps any returned Promise via the existing pump loop.
 *
 * No per-call eval, no per-call `setGlobal`. The function value itself
 * was compiled (and `JSValueProtect`ed) once at `compileCallable` time.
 */
const makeFfiCallable = (
  state: IsolateFfiState,
  context: Context,
  callableId: number,
): Callable => {
  const runRaw = async (
    args: unknown[],
    options: RunOptions,
  ): Promise<{ value: unknown; cpuMs: number; heapBytes: number }> => {
    const slot = state.callables.get(callableId);
    if (slot === undefined) {
      throw new Error(`unknown callable ${callableId}; was it disposed?`);
    }
    const { ctx, fnValue } = slot;
    if (state.contexts.get(contextIdOf(context)) === undefined) {
      throw new IsolateDisposedError();
    }
    const s = state.symbols;

    const timeoutMs = options.timeout ?? state.defaultRunOptions.timeout;
    s.JSContextGroupSetExecutionTimeLimit(
      state.group,
      timeoutMs / 1000,
      BigInt(state.watchdogCallback?.ptr ?? 0),
      0n,
    );

    // Pack args. References become JSObjectMakeFunctionWithCallback
    // wrappers (same path as setGlobal for References); ExternalCopies
    // unwrap their inner value; everything else goes through hostToJs.
    const argRefs = new BigUint64Array(args.length);
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      if (a instanceof Reference) {
        argRefs[i] = makeReferenceFunction(state, ctx, a);
      } else if (a instanceof ExternalCopy) {
        argRefs[i] = hostToJs(s, ctx, a.value);
      } else {
        argRefs[i] = hostToJs(s, ctx, a);
      }
    }

    const excOut = new BigUint64Array(1);
    const startedAt = performance.now();
    const result = s.JSObjectCallAsFunction(
      ctx,
      fnValue,
      0n, // thisObject = null
      BigInt(args.length),
      args.length === 0 ? 0n : BigInt(ptr(argRefs)),
      BigInt(ptr(excOut)),
    );

    // Exception handling mirrors evalAndCheck (line ~268). If excOut is
    // non-zero, the call threw — re-throw the JS error on the host side.
    if (excOut[0] !== 0n) {
      if (state.memoryOverage) {
        state.memoryOverage = false;
        throw new MemoryLimitError(
          state.options.memoryLimit,
          state.lastMemorySnapshot,
        );
      }
      const error = errorFromJsValue(s, ctx, excOut[0]!);
      if (
        error.name === "Error" &&
        typeof error.message === "string" &&
        error.message.includes("execution terminated")
      ) {
        throw new TimeoutError(timeoutMs);
      }
      throw error;
    }

    const value = await unwrapResultPromise(state, ctx, result, timeoutMs);
    const cpuMs = performance.now() - startedAt;
    const heapBytes = await context.isolate.heapSizeBytes();
    return { cpuMs, heapBytes, value };
  };

  const callable: Callable = {
    context,
    async call(args: unknown[], options: RunOptions = {}): Promise<unknown> {
      const maxResultBytes =
        options.maxResultBytes ?? state.defaultRunOptions.maxResultBytes;
      const { value } = await runRaw(args, options);
      enforceResultSize(value, maxResultBytes);
      return value;
    },
    async callWithMetrics(
      args: unknown[],
      options: RunOptions = {},
    ): Promise<RunWithMetricsResult> {
      const maxResultBytes =
        options.maxResultBytes ?? state.defaultRunOptions.maxResultBytes;
      const { value, cpuMs, heapBytes } = await runRaw(args, options);
      enforceResultSize(value, maxResultBytes);
      return {
        metrics: { backend: "ffi", cpuMs: Math.round(cpuMs), heapBytes },
        result: value,
      };
    },
    async callWithReceipt(
      args: unknown[],
      options: RunReceiptOptions = {},
    ): Promise<RunWithReceiptResult> {
      const timeoutMs =
        options.timeout ?? context.isolate.defaultRunOptions.timeout;
      const base = {
        isolate: context.isolate,
        options,
        startedAt: new Date(),
        startedMs: performance.now(),
        timeoutMs,
      };
      try {
        const { result, metrics } = await callable.callWithMetrics(
          args,
          options,
        );
        const receipt = createSuccessReceipt(base, result, metrics);
        return { receipt, result };
      } catch (error) {
        throw attachReceipt(error, createErrorReceipt(base, error));
      }
    },
    async dispose(): Promise<void> {
      const slot = state.callables.get(callableId);
      if (slot === undefined) return;
      state.symbols.JSValueUnprotect(slot.ctx, slot.fnValue);
      state.callables.delete(callableId);
    },
  };
  return callable;
};

/**
 * Build a JS function that JSC will invoke our `JSCallback` for. Each
 * Reference gets its own `JSCallback` — captures the host fn in its closure,
 * so there's no need for the JSClassCreate / `JSObjectGetPrivate` round-trip.
 * The cost is one `JSCallback` alloc per Reference, which is fine for any
 * sane number of References (the existing test suites use single-digit
 * counts; even an AI tool that registers N tools per turn is tens).
 *
 * Calling convention:
 *
 *   - **Synchronous host fns** return immediately; result goes back via the
 *     normal `JSValueRef` return.
 *   - **Promise-returning host fns** are wrapped in `JSObjectMakeDeferredPromise`:
 *     we return the promise to JS-land, then await the host promise and
 *     call its `resolve` / `reject` when it settles. JSC drains microtasks
 *     between `JSEvaluateScript` boundaries, so a JS `await` will wake the
 *     continuation correctly IF the host promise settles synchronously
 *     within the callback (which is the common case for in-process work).
 *     Async settling that requires the JS event loop to spin during
 *     `JSEvaluateScript` is **not** supported in 0.3 — see the JSDoc on
 *     {@link Reference} for the documented limit.
 *
 *   - Host fn throws → exception out-param is populated with a JSValueRef
 *     wrapping the host error; user code sees a thrown JS Error.
 */
const makeReferenceFunction = (
  state: IsolateFfiState,
  ctx: bigint,
  ref: Reference<(...args: unknown[]) => unknown>,
): bigint => {
  const s = state.symbols;
  const refId = state.nextRefId++;
  state.refs.set(refId, ref.fn);

  // Write a host error into the JSC exception out-param so user code sees
  // a thrown Error rather than a silent undefined return.
  const writeException = (
    ctxArg: bigint,
    excPtr: bigint,
    error: unknown,
  ): void => {
    if (excPtr === 0n) return;
    const errObj = makeErrorObject(s, ctxArg, error);
    // Write the error JSObjectRef into the 8 bytes at excPtr. JSC reads
    // the out-param immediately after the callback returns, so a
    // synchronous write here is what surfaces the throw to user code.
    try {
      const buffer = toArrayBuffer(Number(excPtr) as unknown as Pointer, 0, 8);
      new BigUint64Array(buffer)[0] = errObj;
    } catch (writeErr) {
      if (process.env.ISOJSC_DEBUG === "1") {
        // eslint-disable-next-line no-console
        console.error("[isolated-jsc] writeException failed:", writeErr);
      }
    }
  };

  // Read `argc` JSValueRef pointers from `argv` (each 8 bytes).
  const readArgs = (argc: bigint, argv: bigint): bigint[] => {
    const n = Number(argc);
    if (n === 0 || argv === 0n) return [];
    const out: bigint[] = [];
    // Bun's `read.u64` types its first arg as the opaque `Pointer`; in
    // practice it accepts a number address. Cast through `unknown`.
    const base = Number(argv) as unknown as Pointer;
    for (let i = 0; i < n; i++) {
      out.push(read.u64(base, i * 8));
    }
    return out;
  };

  // The actual JSC callback. Synchronous from JSC's POV.
  const callback = new JSCallback(
    (
      cbCtx: Pointer,
      _fn: Pointer,
      _thisObj: Pointer,
      argc: bigint,
      argv: bigint,
      excPtr: bigint,
    ): bigint => {
      const ctxArg = BigInt(cbCtx as unknown as number);
      try {
        const jsArgs = readArgs(argc, argv);
        const hostArgs = jsArgs.map((v) => jsToHost(s, ctxArg, v));
        const result = ref.fn(...hostArgs);
        // Promise-returning host fn → wrap with DeferredPromise.
        if (
          result !== null &&
          typeof result === "object" &&
          typeof (result as Promise<unknown>).then === "function"
        ) {
          const resolveOut = new BigUint64Array(1);
          const rejectOut = new BigUint64Array(1);
          const innerExc = new BigUint64Array(1);
          const promise = s.JSObjectMakeDeferredPromise(
            ctxArg,
            BigInt(ptr(resolveOut)),
            BigInt(ptr(rejectOut)),
            BigInt(ptr(innerExc)),
          );
          const resolveFn = resolveOut[0]!;
          const rejectFn = rejectOut[0]!;
          (result as Promise<unknown>).then(
            (settled) => {
              const settledJs = hostToJs(s, ctxArg, settled);
              const argsBuf = new BigUint64Array([settledJs]);
              const callExc = new BigUint64Array(1);
              s.JSObjectCallAsFunction(
                ctxArg,
                resolveFn,
                0n,
                1n,
                BigInt(ptr(argsBuf)),
                BigInt(ptr(callExc)),
              );
            },
            (err) => {
              const errJs = makeErrorObject(s, ctxArg, err);
              const argsBuf = new BigUint64Array([errJs]);
              const callExc = new BigUint64Array(1);
              s.JSObjectCallAsFunction(
                ctxArg,
                rejectFn,
                0n,
                1n,
                BigInt(ptr(argsBuf)),
                BigInt(ptr(callExc)),
              );
            },
          );
          return promise;
        }
        // Synchronous host fn: marshall result and return immediately.
        return hostToJs(s, ctxArg, result);
      } catch (error) {
        writeException(ctxArg, excPtr, error);
        return s.JSValueMakeUndefined(ctxArg);
      }
    },
    {
      args: [
        FFIType.pointer,
        FFIType.pointer,
        FFIType.pointer,
        FFIType.u64,
        FFIType.u64,
        FFIType.u64,
      ],
      returns: FFIType.u64,
    },
  );

  // Track the callback so we can close() it on isolate dispose. Otherwise
  // each Reference leaks its thunk allocation for the process lifetime.
  state.referenceCallbacks.push(callback);

  // Bun's `JSCallback.ptr` is a number (function pointer); JSC expects a
  // void* — pass as bigint via u64.
  const nameJs = makeJsString(s, `[isolatedJsc Reference #${refId}]`);
  const cbPtr = callback.ptr;
  if (cbPtr === null || cbPtr === undefined) {
    s.JSStringRelease(nameJs);
    throw new Error("JSCallback failed to allocate");
  }
  const fn = s.JSObjectMakeFunctionWithCallback(ctx, nameJs, BigInt(cbPtr));
  s.JSStringRelease(nameJs);
  return fn;
};

/** Counter for unique global names used by the Promise-unwrap helper.
 * Module-scope so the names stay unique across all isolates (cheap; just
 * an int). The names are written into the sandbox global object, so they
 * could theoretically collide with user code; the `__isolatedJsc_` prefix
 * makes a real collision very unlikely. */
let unwrapCounter = 0;

/** If `value` is a JS Promise, drive it to settlement and return the
 * resolved value (or throw the rejection). Sync-settling Promises
 * resolve on the first read; async-settling ones (Promise-returning
 * host fns that hit Bun's microtask queue via `.then`, setTimeout, real
 * I/O) are pumped by alternately yielding to Bun's event loop (so the
 * host's `.then` continuations fire and queue JSC microtasks via
 * `JSObjectCallAsFunction(resolve, …)`) and running a no-op
 * `JSEvaluateScript` (so JSC drains its microtask queue).
 *
 * Bounded by `deadlineMs` — if the promise hasn't settled by then,
 * throws {@link TimeoutError}. The caller (`Script.run`) passes its own
 * `timeout` so the bound matches the user's wall-clock expectation.
 *
 * In 0.3 this used to throw "Promise can't unwrap synchronously" after
 * the first read — that error is gone in 0.4. */
const unwrapResultPromise = async (
  state: IsolateFfiState,
  ctx: bigint,
  value: bigint,
  deadlineMs: number,
): Promise<unknown> => {
  const s = state.symbols;
  if (value === 0n || !s.JSValueIsObject(ctx, value)) {
    return jsToHost(s, ctx, value);
  }
  const id = ++unwrapCounter;
  const stashName = `__isolatedJsc_promise_${id}`;
  const stateName = `__isolatedJsc_state_${id}`;
  const global = s.JSContextGetGlobalObject(ctx);
  const stashKey = makeJsString(s, stashName);
  const setExc = new BigUint64Array(1);
  s.JSObjectSetProperty(ctx, global, stashKey, value, 0, BigInt(ptr(setExc)));
  s.JSStringRelease(stashKey);

  type ParsedState = {
    done: boolean;
    ok: boolean;
    value?: unknown;
    error?: string;
    notPromise?: boolean;
  };

  // Read eval that ALSO deletes the state global when done — folds the
  // 0.4 finally-cleanup eval into the read eval (no separate cleanup
  // pass). For pump iterations (not done yet), the state global stays
  // alive so the next read can find it; on the final read the delete
  // fires inline. Saves one JSEvaluateScript per call.
  const readState = (): ParsedState => {
    const stateRef = evalAndCheck(
      state,
      ctx,
      `(() => { const _s = JSON.stringify(${stateName}); if (${stateName} && ${stateName}.done) { delete globalThis['${stateName}']; } return _s; })()`,
      `<unwrap-read-${id}>`,
    );
    const stateJson = jsToHost(s, ctx, stateRef) as string;
    return JSON.parse(stateJson) as ParsedState;
  };

  // Setup eval deletes the stash global at the end — .then() captures
  // the Promise via the call, so we don't need stashName afterwards.
  // (For non-Promise inline values we also clear it, copying into state.)
  evalAndCheck(
    state,
    ctx,
    `if (${stashName} && typeof ${stashName}.then === 'function') {
      var ${stateName} = { done: false };
      ${stashName}.then(
        (v) => { ${stateName} = { done: true, ok: true, value: v }; },
        (e) => { ${stateName} = { done: true, ok: false, error: e && e.message ? e.message : String(e) }; },
      );
    } else {
      var ${stateName} = { done: true, ok: true, value: ${stashName}, notPromise: true };
    }
    delete globalThis['${stashName}'];`,
    `<unwrap-setup-${id}>`,
  );
  let parsed = readState();
  if (parsed.notPromise === true) return parsed.value;

  // Pump until done. Each cycle has two yield modes:
  //
  //   FAST: `await new Promise(queueMicrotask)`. Drains Bun's microtask
  //   queue (so host-side `.then` continuations queued from already-
  //   settled host promises fire — they call
  //   `JSObjectCallAsFunction(resolve, …)`, resolving the in-VM
  //   deferred promise). Cheap (~0.05 ms). Covers Promise.resolve(x)
  //   host fns and any host fn that settles without libuv I/O.
  //
  //   SLOW: `await new Promise(r => setTimeout(r, 0))`. Yields to
  //   libuv so real I/O can complete. Used as a fallback when the
  //   microtask yield wasn't enough.
  //
  // After either yield we go straight to `readState()` (no separate
  // no-op eval). JSC drains its microtask queue at the START of every
  // `JSEvaluateScript`, so `readState`'s eval already fires the in-VM
  // .then handlers before its `JSON.stringify` body runs — capturing
  // the post-drain state in one eval instead of two.
  const deadlineAbs = Date.now() + deadlineMs;
  while (!parsed.done) {
    if (Date.now() >= deadlineAbs) {
      // State global is still alive; best-effort delete so a hung
      // promise doesn't leak a global indefinitely. The Promise itself
      // is held by JSC's .then internal state, not by us.
      try {
        evalAndCheck(
          state,
          ctx,
          `delete globalThis['${stateName}'];`,
          `<unwrap-cleanup-${id}>`,
        );
      } catch {
        // ignore — about to throw TimeoutError anyway.
      }
      throw new TimeoutError(deadlineMs);
    }

    // Fast yield first.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    parsed = readState();
    if (parsed.done) break;

    // Slow fallback — yield to the event loop for I/O.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    parsed = readState();
  }
  if (!parsed.ok) {
    throw new Error(parsed.error ?? "promise rejected with unknown error");
  }
  return parsed.value;
};

const makeFfiScript = (
  state: IsolateFfiState,
  isolate: Isolate,
  scriptId: number,
): Script => {
  const runRaw = async (
    context: Context,
    options: RunOptions,
  ): Promise<{ value: unknown; cpuMs: number; heapBytes: number }> => {
    const script = state.scripts.get(scriptId);
    if (script === undefined)
      throw new Error(`unknown script ${scriptId}; was it disposed?`);
    const ctx = state.contexts.get(contextIdOf(context));
    if (ctx === undefined) throw new IsolateDisposedError();

    const timeoutMs = options.timeout ?? state.defaultRunOptions.timeout;
    // JSC's time limit is in seconds (double). Update before each eval.
    state.symbols.JSContextGroupSetExecutionTimeLimit(
      state.group,
      timeoutMs / 1000,
      BigInt(state.watchdogCallback?.ptr ?? 0),
      0n,
    );

    const startedAt = performance.now();
    let result: bigint;
    try {
      result = evalAndCheck(state, ctx, script.source, script.sourceUrl);
    } catch (error) {
      // TimeoutError got the timeout from evalAndCheck (which doesn't know
      // the ms). Patch it here.
      if (error instanceof TimeoutError) {
        throw new TimeoutError(timeoutMs);
      }
      throw error;
    }
    // If the script returned a Promise, unwrap it. Sync-settling Promises
    // resolve on the first read (JSC drains microtasks between successive
    // JSEvaluateScript calls). Async-settling Promises — host fns that hit
    // Bun's microtask queue via `.then`, setTimeout, real I/O — are pumped
    // by alternately yielding to Bun's event loop and running a no-op eval.
    // The wall-clock bound matches the user's `timeout`.
    const value = await unwrapResultPromise(state, ctx, result, timeoutMs);
    const cpuMs = performance.now() - startedAt;
    const heapBytes = await isolate.heapSizeBytes();
    return { value, cpuMs, heapBytes };
  };

  const script: Script = {
    isolate,

    async run(context: Context, options: RunOptions = {}): Promise<unknown> {
      const maxResultBytes =
        options.maxResultBytes ?? state.defaultRunOptions.maxResultBytes;
      const { value } = await runRaw(context, options);
      enforceResultSize(value, maxResultBytes);
      if (options.release === true) await script.dispose();
      return value;
    },

    async runWithMetrics(
      context: Context,
      options: RunOptions = {},
    ): Promise<RunWithMetricsResult> {
      const maxResultBytes =
        options.maxResultBytes ?? state.defaultRunOptions.maxResultBytes;
      const { value, cpuMs, heapBytes } = await runRaw(context, options);
      enforceResultSize(value, maxResultBytes);
      if (options.release === true) await script.dispose();
      return {
        result: value,
        metrics: { backend: "ffi", cpuMs: Math.round(cpuMs), heapBytes },
      };
    },

    async runWithReceipt(
      context: Context,
      options: RunReceiptOptions = {},
    ): Promise<RunWithReceiptResult> {
      const timeoutMs = options.timeout ?? isolate.defaultRunOptions.timeout;
      const base = {
        isolate,
        options,
        startedAt: new Date(),
        startedMs: performance.now(),
        timeoutMs,
      };
      try {
        const { result, metrics } = await script.runWithMetrics(
          context,
          options,
        );
        const receipt = createSuccessReceipt(base, result, metrics);
        return { receipt, result };
      } catch (error) {
        throw attachReceipt(error, createErrorReceipt(base, error));
      }
    },

    async dispose(): Promise<void> {
      state.scripts.delete(scriptId);
    },
  };
  return script;
};
