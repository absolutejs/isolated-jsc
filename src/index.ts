/**
 * `@absolutejs/isolated-jsc` — JavaScriptCore-native sandbox for Bun.
 *
 * @see {@link createIsolate} for the entry point.
 * @see ./types.ts for the full public contract.
 */

export { createIsolate } from "./isolate";
export { createIsolatePool } from "./pool";
export { createIsolatedRunner, runIsolated } from "./run";
export {
  CapabilityError,
  createCapabilityBroker,
  defineCapabilityTool,
} from "./capabilities";
export type {
  CapabilityAuditEvent,
  CapabilityAuditStatus,
  CapabilityBroker,
  CapabilityBrokerCall,
  CapabilityBrokerFor,
  CapabilityBrokerOptions,
  CapabilityTool,
  InferCapabilityContext,
  InferCapabilityInput,
  InferCapabilityOutput,
  CapabilityValidator,
} from "./capabilities";
export { JscLibraryNotFoundError, resolveJscLibrary } from "./ffi/resolver";
export type { JscFlavor, JscLibraryProbe } from "./ffi/resolver";
export {
  compileTypeScript,
  compileTypeScriptCallable,
  transpileTypeScript,
} from "./typescript";
export { resolveIsolatePolicy } from "./policy";
export type {
  IsolatePolicyName,
  ResolvedIsolatePolicy,
  ResolveIsolatePolicyOverrides,
} from "./policy";
export type {
  TranspileTypeScriptOptions,
  TypeScriptLoader,
} from "./typescript";
export {
  CompileError,
  ExternalCopy,
  IsolateDisposedError,
  MemoryLimitError,
  Reference,
  TimeoutError,
} from "./types";
export type {
  Callable,
  Context,
  CreateContextOptions,
  CreateIsolate,
  Isolate,
  IsolateBackend,
  IsolateOptions,
  RunMetrics,
  RunOptions,
  RunWithMetricsResult,
  Script,
} from "./types";
export type { IsolatePool, IsolatePoolOptions } from "./pool";
export type {
  CreateIsolatedRunnerOptions,
  IsolatedRunner,
  IsolatedRunnerRunOptions,
  IsolatedRunnerRunWithMetricsOptions,
  RunIsolatedOptions,
  RunIsolatedWithMetricsOptions,
} from "./run";
