/**
 * `@absolutejs/isolated-jsc` — JavaScriptCore-native sandbox for Bun.
 *
 * @see {@link createIsolate} for the entry point.
 * @see ./types.ts for the full public contract.
 */

export { createIsolate } from "./isolate";
export {
  CompileError,
  ExternalCopy,
  IsolateDisposedError,
  MemoryLimitError,
  Reference,
  TimeoutError,
} from "./types";
export type {
  Context,
  CreateIsolate,
  Isolate,
  IsolateOptions,
  RunOptions,
  Script,
} from "./types";
