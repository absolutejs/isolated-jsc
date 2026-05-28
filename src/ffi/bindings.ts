/**
 * `bun:ffi` shape for the JavaScriptCore C API. Symbols come from one of:
 *
 * - `/System/Library/Frameworks/JavaScriptCore.framework/JavaScriptCore` (macOS)
 * - `libjavascriptcoregtk-4.1.so.0` / `libjavascriptcoregtk-6.0.so.1` (Linux)
 *
 * The {@link openJsc} function resolves the library (via `resolver.ts`),
 * opens it once per process, and returns a strongly-typed `symbols` bag.
 *
 * All `JSValueRef` / `JSObjectRef` / `JSStringRef` / `JSContextRef` /
 * `JSGlobalContextRef` / `JSContextGroupRef` / `JSClassRef` are opaque
 * pointers — `FFIType.u64` on the wire, `bigint | null` in TypeScript.
 *
 * Lifetime rules (cribbed from JavaScriptCore.framework documentation):
 *   - Refcounted: `*ContextGroup`, `*GlobalContext`, `*String`, `*Class`.
 *     Retain on acquire from C land if you'll outlive the caller; release
 *     when done. We retain nothing on the way in (callbacks already own
 *     their values) and release once on cleanup.
 *   - Garbage-collected: `JSValueRef`, `JSObjectRef`. They need
 *     `JSValueProtect` to survive across calls into the host; unprotect
 *     when done. The {@link IsolateFfi} keeps a small "long-lived" set
 *     and protects only those.
 */

import { dlopen, FFIType, JSCallback } from "bun:ffi";
import {
  JscLibraryNotFoundError,
  resolveJscLibrary,
  type JscLibraryProbe,
} from "./resolver";

/** All JSC opaque-pointer types collapse to this in TS-land. */
export type JscPointer = bigint;

const SYMBOL_SHAPE = {
  // ─── Context group / global context lifecycle ────────────────────────────
  JSContextGroupCreate: { args: [], returns: FFIType.u64 },
  JSContextGroupRelease: { args: [FFIType.u64], returns: FFIType.void },
  JSGlobalContextCreateInGroup: {
    args: [FFIType.u64, FFIType.u64],
    returns: FFIType.u64,
  },
  JSGlobalContextRelease: { args: [FFIType.u64], returns: FFIType.void },
  JSContextGetGlobalObject: {
    args: [FFIType.u64],
    returns: FFIType.u64,
  },

  // ─── Hardening hooks (free wins from T3) ─────────────────────────────────
  JSGlobalContextSetEvalEnabled: {
    args: [FFIType.u64, FFIType.bool, FFIType.u64],
    returns: FFIType.void,
  },
  JSContextGroupSetExecutionTimeLimit: {
    args: [FFIType.u64, FFIType.f64, FFIType.u64, FFIType.u64],
    returns: FFIType.void,
  },
  JSContextGroupClearExecutionTimeLimit: {
    args: [FFIType.u64],
    returns: FFIType.void,
  },

  // ─── String marshalling ──────────────────────────────────────────────────
  JSStringCreateWithUTF8CString: {
    args: [FFIType.cstring],
    returns: FFIType.u64,
  },
  JSStringRelease: { args: [FFIType.u64], returns: FFIType.void },
  JSStringGetMaximumUTF8CStringSize: {
    args: [FFIType.u64],
    returns: FFIType.u64,
  },
  JSStringGetUTF8CString: {
    args: [FFIType.u64, FFIType.u64, FFIType.u64],
    returns: FFIType.u64,
  },

  // ─── Eval ────────────────────────────────────────────────────────────────
  JSEvaluateScript: {
    args: [
      FFIType.u64, // ctx
      FFIType.u64, // script (JSString)
      FFIType.u64, // thisObject (JSObjectRef or null)
      FFIType.u64, // sourceURL (JSString or null)
      FFIType.i32, // startingLineNumber
      FFIType.u64, // exception out (JSValueRef*)
    ],
    returns: FFIType.u64,
  },
  JSCheckScriptSyntax: {
    args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.i32, FFIType.u64],
    returns: FFIType.bool,
  },

  // ─── Value predicates + conversion ───────────────────────────────────────
  JSValueGetType: {
    args: [FFIType.u64, FFIType.u64],
    returns: FFIType.i32, // JSType enum
  },
  JSValueIsUndefined: {
    args: [FFIType.u64, FFIType.u64],
    returns: FFIType.bool,
  },
  JSValueIsNull: {
    args: [FFIType.u64, FFIType.u64],
    returns: FFIType.bool,
  },
  JSValueIsBoolean: {
    args: [FFIType.u64, FFIType.u64],
    returns: FFIType.bool,
  },
  JSValueIsNumber: {
    args: [FFIType.u64, FFIType.u64],
    returns: FFIType.bool,
  },
  JSValueIsString: {
    args: [FFIType.u64, FFIType.u64],
    returns: FFIType.bool,
  },
  JSValueIsObject: {
    args: [FFIType.u64, FFIType.u64],
    returns: FFIType.bool,
  },
  JSValueMakeUndefined: {
    args: [FFIType.u64],
    returns: FFIType.u64,
  },
  JSValueMakeNull: { args: [FFIType.u64], returns: FFIType.u64 },
  JSValueMakeBoolean: {
    args: [FFIType.u64, FFIType.bool],
    returns: FFIType.u64,
  },
  JSValueMakeNumber: {
    args: [FFIType.u64, FFIType.f64],
    returns: FFIType.u64,
  },
  JSValueMakeString: {
    args: [FFIType.u64, FFIType.u64],
    returns: FFIType.u64,
  },
  JSValueToBoolean: {
    args: [FFIType.u64, FFIType.u64],
    returns: FFIType.bool,
  },
  JSValueToNumber: {
    args: [FFIType.u64, FFIType.u64, FFIType.u64],
    returns: FFIType.f64,
  },
  JSValueToStringCopy: {
    args: [FFIType.u64, FFIType.u64, FFIType.u64],
    returns: FFIType.u64,
  },
  JSValueMakeFromJSONString: {
    args: [FFIType.u64, FFIType.u64],
    returns: FFIType.u64,
  },
  JSValueCreateJSONString: {
    args: [FFIType.u64, FFIType.u64, FFIType.u32, FFIType.u64],
    returns: FFIType.u64,
  },
  JSValueProtect: {
    args: [FFIType.u64, FFIType.u64],
    returns: FFIType.void,
  },
  JSValueUnprotect: {
    args: [FFIType.u64, FFIType.u64],
    returns: FFIType.void,
  },

  // ─── Object access ───────────────────────────────────────────────────────
  JSObjectGetProperty: {
    args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
    returns: FFIType.u64,
  },
  JSObjectSetProperty: {
    args: [
      FFIType.u64, // ctx
      FFIType.u64, // object
      FFIType.u64, // propertyName (JSString)
      FFIType.u64, // value
      FFIType.u32, // attributes (JSPropertyAttributes)
      FFIType.u64, // exception
    ],
    returns: FFIType.void,
  },
  JSObjectMake: {
    args: [FFIType.u64, FFIType.u64, FFIType.u64],
    returns: FFIType.u64,
  },
  JSObjectMakeFunctionWithCallback: {
    args: [FFIType.u64, FFIType.u64, FFIType.u64],
    returns: FFIType.u64,
  },
  JSObjectIsFunction: {
    args: [FFIType.u64, FFIType.u64],
    returns: FFIType.bool,
  },
  JSObjectCallAsFunction: {
    args: [
      FFIType.u64, // ctx
      FFIType.u64, // function
      FFIType.u64, // thisObject
      FFIType.u64, // argumentCount
      FFIType.u64, // arguments[]
      FFIType.u64, // exception
    ],
    returns: FFIType.u64,
  },

  // ─── GC / stats / deferred promise / class machinery ────────────────────
  JSGarbageCollect: { args: [FFIType.u64], returns: FFIType.void },
  JSGetMemoryUsageStatistics: {
    args: [FFIType.u64],
    returns: FFIType.u64,
  },
  JSObjectMakeError: {
    args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
    returns: FFIType.u64,
  },
  JSObjectMakeDeferredPromise: {
    args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
    returns: FFIType.u64,
  },
  JSObjectGetPrivate: {
    args: [FFIType.u64],
    returns: FFIType.u64,
  },
  JSObjectSetPrivate: {
    args: [FFIType.u64, FFIType.u64],
    returns: FFIType.bool,
  },
  JSClassRelease: {
    args: [FFIType.u64],
    returns: FFIType.void,
  },
  // We allocate the JSClassDefinition C struct ourselves and pass its pointer.
  // The struct's `callAsFunction` and `finalize` callbacks let us bind the
  // Reference identity (via JSObjectMake's privateData) to a host fn lookup.
  JSClassCreate: {
    args: [FFIType.u64],
    returns: FFIType.u64,
  },
  JSObjectGetPropertyAtIndex: {
    args: [FFIType.u64, FFIType.u64, FFIType.u32, FFIType.u64],
    returns: FFIType.u64,
  },
  JSObjectCopyPropertyNames: {
    args: [FFIType.u64, FFIType.u64],
    returns: FFIType.u64,
  },
  JSPropertyNameArrayGetCount: {
    args: [FFIType.u64],
    returns: FFIType.u64,
  },
  JSPropertyNameArrayGetNameAtIndex: {
    args: [FFIType.u64, FFIType.u64],
    returns: FFIType.u64,
  },
  JSPropertyNameArrayRelease: {
    args: [FFIType.u64],
    returns: FFIType.void,
  },
} as const;

export type JscSymbols = ReturnType<
  typeof dlopen<typeof SYMBOL_SHAPE>
>["symbols"];

/** Process-wide singleton: open libJSC once and reuse. */
let openedLib: {
  symbols: JscSymbols;
  flavor: JscLibraryProbe extends { kind: "found"; flavor: infer F }
    ? F
    : never;
  path: string;
} | null = null;

export const openJsc = ():
  | { ok: true; symbols: JscSymbols; path: string; flavor: string }
  | { ok: false; error: JscLibraryNotFoundError } => {
  if (openedLib !== null) {
    return {
      ok: true,
      symbols: openedLib.symbols,
      path: openedLib.path,
      flavor: openedLib.flavor,
    };
  }
  const probe = resolveJscLibrary();
  if (probe.kind === "not-found") {
    return {
      ok: false,
      error: new JscLibraryNotFoundError(probe.checked, probe.installHint),
    };
  }
  try {
    const lib = dlopen(probe.path, SYMBOL_SHAPE);
    openedLib = {
      symbols: lib.symbols,
      path: probe.path,
      flavor: probe.flavor as never,
    };
    return {
      ok: true,
      symbols: lib.symbols,
      path: probe.path,
      flavor: probe.flavor,
    };
  } catch (error) {
    return {
      ok: false,
      error: new JscLibraryNotFoundError(
        [probe.path],
        `dlopen(${probe.path}) failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
};

/** Re-export so the backend can construct callbacks for host functions. */
export { JSCallback };
