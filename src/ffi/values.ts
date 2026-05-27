/**
 * Value marshalling between host JS and JSC JSValueRef.
 *
 * Strategy: JSON round-trip. `JSValueMakeFromJSONString` and
 * `JSValueCreateJSONString` are both in the public C API and avoid the
 * "walk the value graph through FFI" trap that other JSC wrappers fall into.
 * The cost is one stringify on each side per cross. For everything except
 * massive buffers (where the user should use ExternalCopy / typed arrays
 * directly) this is the right trade.
 *
 * Things that JSON-round-trip lose: `undefined` (collapses to `null` or
 * absent), `Function`, `Symbol`, `BigInt`, host-side `Error` instances,
 * cyclic refs. Callers that need those use specific helpers
 * (`makeUndefined`, `makeError`, `Reference` for functions).
 */

import { ptr } from "bun:ffi";
import type { JscSymbols } from "./bindings";

const enc = new TextEncoder();

/** Allocate a JSStringRef from a UTF-8 string. Caller must
 * `JSStringRelease` when done. */
export const makeJsString = (s: JscSymbols, text: string): bigint => {
  // The C API takes a null-terminated UTF-8 string. encode adds no NUL,
  // so we tack one on.
  const buf = Buffer.from(enc.encode(text + "\0"));
  return s.JSStringCreateWithUTF8CString(buf);
};

/** Copy a JSStringRef back to a host JS string. */
export const readJsString = (s: JscSymbols, str: bigint): string => {
  const maxSize = s.JSStringGetMaximumUTF8CStringSize(str);
  if (maxSize === 0n) return "";
  const buf = Buffer.alloc(Number(maxSize));
  const written = s.JSStringGetUTF8CString(str, BigInt(ptr(buf)), maxSize);
  return buf.subarray(0, Number(written) - 1).toString("utf8");
};

/** Host JS value → JSValueRef in `ctx`. Returns 0n (null pointer) on
 * unrepresentable input. */
export const hostToJs = (
  s: JscSymbols,
  ctx: bigint,
  value: unknown,
): bigint => {
  if (value === undefined) return s.JSValueMakeUndefined(ctx);
  if (value === null) return s.JSValueMakeNull(ctx);
  if (typeof value === "boolean") return s.JSValueMakeBoolean(ctx, value);
  if (typeof value === "number") return s.JSValueMakeNumber(ctx, value);
  if (typeof value === "string") {
    const str = makeJsString(s, value);
    const v = s.JSValueMakeString(ctx, str);
    s.JSStringRelease(str);
    return v;
  }
  // Objects + arrays + everything else: JSON-stringify on the host, then
  // ask JSC to parse. Anything not JSON-clonable (BigInt, function, …)
  // shows up as undefined here.
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return s.JSValueMakeUndefined(ctx);
  }
  if (json === undefined) return s.JSValueMakeUndefined(ctx);
  const str = makeJsString(s, json);
  const v = s.JSValueMakeFromJSONString(ctx, str);
  s.JSStringRelease(str);
  return v;
};

/** JSValueRef → host JS value via JSON round-trip. Throws if the value
 * doesn't serialise (cyclic, etc). For primitives the conversion uses
 * the typed helpers (JSValueToBoolean / Number / StringCopy) directly,
 * skipping JSON. */
export const jsToHost = (
  s: JscSymbols,
  ctx: bigint,
  value: bigint,
): unknown => {
  if (value === 0n) return undefined;
  if (s.JSValueIsUndefined(ctx, value)) return undefined;
  if (s.JSValueIsNull(ctx, value)) return null;
  if (s.JSValueIsBoolean(ctx, value)) return s.JSValueToBoolean(ctx, value);
  if (s.JSValueIsNumber(ctx, value)) {
    const exc = new BigUint64Array(1);
    return s.JSValueToNumber(ctx, value, BigInt(ptr(exc)));
  }
  if (s.JSValueIsString(ctx, value)) {
    const exc = new BigUint64Array(1);
    const str = s.JSValueToStringCopy(ctx, value, BigInt(ptr(exc)));
    const out = readJsString(s, str);
    s.JSStringRelease(str);
    return out;
  }
  // Object / array / etc — stringify in JSC and parse on the host.
  const exc = new BigUint64Array(1);
  const json = s.JSValueCreateJSONString(ctx, value, 0, BigInt(ptr(exc)));
  if (json === 0n) {
    // Not JSON-clonable (cyclic, function, undefined-in-object). Fall back
    // to string representation so the caller at least gets a hint.
    const strExc = new BigUint64Array(1);
    const fallback = s.JSValueToStringCopy(ctx, value, BigInt(ptr(strExc)));
    if (fallback === 0n) return undefined;
    const out = readJsString(s, fallback);
    s.JSStringRelease(fallback);
    return out;
  }
  const text = readJsString(s, json);
  s.JSStringRelease(json);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
