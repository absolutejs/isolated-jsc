/**
 * `@absolutejs/isolated-jsc` — JavaScriptCore-native sandbox for Bun.
 *
 * @see {@link createIsolate} for the entry point.
 * @see ./types.ts for the full public contract.
 */

export { createIsolate } from "./isolate";
export { createIsolatePool } from "./pool";
export { createIsolatedRunner, runIsolated, runIsolatedFile } from "./run";
export {
  CapabilityError,
  createCapabilityAuditBuffer,
  createCapabilityBroker,
  defineCapabilityTool,
} from "./capabilities";
export type {
  CapabilityAuditBuffer,
  CapabilityAuditBufferOptions,
  CapabilityAuditBufferSnapshot,
  CapabilityAuditEvent,
  CapabilityAuditRedactor,
  CapabilityAuditStatus,
  CapabilityBroker,
  CapabilityBrokerCall,
  CapabilityBrokerFor,
  CapabilityBrokerOptions,
  CapabilityManifestEntry,
  CapabilityRisk,
  CapabilitySchemaDescriptor,
  CapabilityTool,
  InferCapabilityContext,
  InferCapabilityInput,
  InferCapabilityOutput,
  CapabilityValidator,
} from "./capabilities";
export { JscLibraryNotFoundError, resolveJscLibrary } from "./ffi/resolver";
export type { JscFlavor, JscLibraryProbe } from "./ffi/resolver";
export {
  compileTypeScriptCallableFile,
  compileTypeScriptFile,
  compileTypeScript,
  compileTypeScriptCallable,
  readSourceFile,
  transpileSourceFile,
  transpileSourceFileCallable,
  transpileTypeScript,
} from "./typescript";
export {
  policyAuditOptions,
  policyBrokerOptions,
  policyConsoleOptions,
  policyRunOptions,
  policyRunnerOptions,
  resolveIsolatePolicy,
} from "./policy";
export type {
  IsolatePolicyRecipe,
  IsolatePolicyName,
  PolicyBrokerRecipeOptions,
  PolicyRunnerRecipeOptions,
  ResolvedIsolatePolicy,
  ResolveIsolatePolicyOverrides,
} from "./policy";
export type {
  SourceFileLoader,
  SourceFileOptions,
  TranspileTypeScriptOptions,
  TypeScriptLoader,
} from "./typescript";
export {
  CompileError,
  ExternalCopy,
  IsolateDisposedError,
  MemoryLimitError,
  Reference,
  ResultSizeError,
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
  ExecutionReceipt,
  ExecutionReceiptCapabilityEvent,
  ExecutionReceiptConsole,
  ExecutionReceiptError,
  ExecutionReceiptStatus,
  RunReceiptOptions,
  RunMetrics,
  RunOptions,
  RunWithMetricsResult,
  RunWithReceiptResult,
  Script,
} from "./types";
export type { IsolatePool, IsolatePoolOptions } from "./pool";
export type {
  CreateIsolatedRunnerOptions,
  IsolatedRunner,
  IsolatedRunnerCallOptions,
  IsolatedRunnerCallFileOptions,
  IsolatedRunnerCallWithMetricsOptions,
  IsolatedRunnerCallWithReceiptOptions,
  IsolatedRunnerPrecompileFileOptions,
  IsolatedRunnerPrecompileOptions,
  IsolatedRunnerRunFileOptions,
  IsolatedRunnerRunOptions,
  IsolatedRunnerRunWithMetricsOptions,
  IsolatedRunnerRunWithReceiptOptions,
  IsolatedRunnerStats,
  RunIsolatedFileOptions,
  RunIsolatedFileWithMetricsOptions,
  RunIsolatedFileWithReceiptOptions,
  RunIsolatedOptions,
  RunIsolatedWithMetricsOptions,
  RunIsolatedWithReceiptOptions,
} from "./run";
