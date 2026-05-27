/**
 * `@absolutejs/isolated-jsc` — JavaScriptCore-native sandbox for Bun.
 *
 * @see {@link createIsolate} for the entry point.
 * @see ./types.ts for the full public contract.
 */

export { createIsolate } from "./isolate";
export { createIsolatePool } from "./pool";
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
  CreateContextOptions,
  CreateIsolate,
  Isolate,
  IsolateOptions,
  RunMetrics,
  RunOptions,
  RunWithMetricsResult,
  Script,
} from "./types";
export type { IsolatePool, IsolatePoolOptions } from "./pool";
