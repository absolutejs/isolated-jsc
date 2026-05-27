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

import { JSCallback, FFIType, ptr, type Pointer } from "bun:ffi";
import {
  CompileError,
  type Context,
  type CreateContextOptions,
  ExternalCopy,
  IsolateDisposedError,
  MemoryLimitError,
  Reference,
  type Isolate,
  type IsolateOptions,
  type RunOptions,
  type RunWithMetricsResult,
  type Script,
  TimeoutError,
} from "../types";
import { openJsc, type JscSymbols } from "./bindings";
import { hostToJs, jsToHost, makeJsString, readJsString } from "./values";

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
  nextContextId: number;
  nextScriptId: number;
  nextRefId: number;
  disposed: boolean;
  options: Required<Pick<IsolateOptions, "memoryLimit">>;
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
  const isObject = s.JSValueIsObject(ctx, value);

  let message = "unknown";
  let name = "Error";
  let stack: string | undefined;

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
  } else if (s.JSValueIsString(ctx, value)) {
    message = jsToHost(s, ctx, value) as string;
  }

  s.JSStringRelease(messageProp);
  s.JSStringRelease(nameProp);
  s.JSStringRelease(stackProp);

  const error = new Error(message);
  error.name = name;
  if (stack !== undefined) error.stack = stack;
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
  const probe = openJsc();
  if (!probe.ok) throw probe.error;
  const symbols = probe.symbols;

  const memoryLimit = options.memoryLimit ?? 128;
  const group = symbols.JSContextGroupCreate();

  const state: IsolateFfiState = {
    symbols,
    group,
    contexts: new Map(),
    scripts: new Map(),
    refs: new Map(),
    nextContextId: 1,
    nextScriptId: 1,
    nextRefId: 1,
    disposed: false,
    options: { memoryLimit },
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
  if (typeof options.bootstrap === "string" && options.bootstrap.length > 0) {
    const bootCtx = symbols.JSGlobalContextCreateInGroup(group, 0n);
    try {
      evalAndCheck(state, bootCtx, options.bootstrap, "<bootstrap>");
    } catch {
      // Bootstrap failures are silent (same as Worker backend).
    }
    symbols.JSGlobalContextRelease(bootCtx);
  }

  const isolate: Isolate = {
    options: state.options,
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
      if (options.harden !== false) {
        applyHarden(state, ctx, options.unsafelyExposeGlobals ?? []);
      }

      // Restore snapshot first so seed code can read it.
      if (opts?.snapshot !== undefined) {
        const global = symbols.JSContextGetGlobalObject(ctx);
        const exc = new BigUint64Array(1);
        for (const [name, value] of Object.entries(opts.snapshot)) {
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
      for (const ctx of state.contexts.values()) {
        symbols.JSGlobalContextRelease(ctx);
      }
      state.contexts.clear();
      symbols.JSContextGroupRelease(group);
      state.watchdogCallback?.close();
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
      const ctx = state.contexts.get(contextId);
      if (ctx === undefined) throw new IsolateDisposedError();
      const global = symbols.JSContextGetGlobalObject(ctx);
      const names = symbols.JSObjectCopyPropertyNames(ctx, global);
      const count = Number(symbols.JSPropertyNameArrayGetCount(names));
      const out: Record<string, unknown> = {};
      const exc = new BigUint64Array(1);
      for (let i = 0; i < count; i++) {
        const nameRef = symbols.JSPropertyNameArrayGetNameAtIndex(
          names,
          BigInt(i),
        );
        const name = readJsString(symbols, nameRef);
        // Skip globalThis self-reference (and any HARDEN_TARGETS we shadowed).
        if (name === "globalThis") continue;
        const value = symbols.JSObjectGetProperty(
          ctx,
          global,
          nameRef,
          BigInt(ptr(exc)),
        );
        if (value === 0n) continue;
        // Skip functions and other non-clonable values — same contract as
        // the Worker backend's snapshot.
        try {
          const host = jsToHost(symbols, ctx, value);
          if (typeof host === "function") continue;
          // structuredClone to catch un-clonable values
          structuredClone(host);
          out[name] = host;
        } catch {
          // not cloneable
        }
      }
      symbols.JSPropertyNameArrayRelease(names);
      return out;
    },

    async dispose(): Promise<void> {
      const ctx = state.contexts.get(contextId);
      if (ctx === undefined) return;
      state.contexts.delete(contextId);
      symbols.JSGlobalContextRelease(ctx);
    },
  };
  contextIdBrand.set(context, contextId);
  return context;
};

/** Stub for now — installs a JS function that always rejects. Wiring the
 * full JSClassCreate / deferred-promise bridge is the next FFI step.
 * Returning a function-shaped JSValue lets non-Reference tests pass
 * without crashing the type system. */
const makeReferenceFunction = (
  state: IsolateFfiState,
  ctx: bigint,
  ref: Reference<(...args: unknown[]) => unknown>,
): bigint => {
  // Allocate a refId so callers can later identify which Reference this
  // function represents (needed once we wire the callAsFunction callback).
  const refId = state.nextRefId++;
  state.refs.set(refId, ref.fn);
  // For now, install a JS-side stub that just throws — better than silently
  // returning undefined. Tests that use Reference will fail loudly with a
  // clear message until the callAsFunction wiring lands.
  return hostToJs(
    state.symbols,
    ctx,
    `[Reference id=${refId}; FFI backend Reference call-through not yet implemented; use backend: 'worker']`,
  );
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

    const timeoutMs = options.timeout ?? 1000;
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
    const cpuMs = performance.now() - startedAt;
    const heapBytes = await isolate.heapSizeBytes();
    return { value: jsToHost(state.symbols, ctx, result), cpuMs, heapBytes };
  };

  const script: Script = {
    isolate,

    async run(context: Context, options: RunOptions = {}): Promise<unknown> {
      const { value } = await runRaw(context, options);
      if (options.release === true) await script.dispose();
      return value;
    },

    async runWithMetrics(
      context: Context,
      options: RunOptions = {},
    ): Promise<RunWithMetricsResult> {
      const { value, cpuMs, heapBytes } = await runRaw(context, options);
      if (options.release === true) await script.dispose();
      return {
        result: value,
        metrics: { cpuMs: Math.round(cpuMs), heapBytes },
      };
    },

    async dispose(): Promise<void> {
      state.scripts.delete(scriptId);
    },
  };
  return script;
};
