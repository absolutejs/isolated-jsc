import type {
  ExecutionReceipt,
  ExecutionReceiptCapabilityEvent,
  ExecutionReceiptError,
  Isolate,
  RunMetrics,
  RunReceiptOptions,
} from "./types";
import type { ConsoleLimitSnapshot } from "./consoleLimits";
import { consoleDelta } from "./consoleLimits";
import { estimateResultBytes } from "./resultLimits";

const receiptError = (error: unknown): ExecutionReceiptError => {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      code: typeof code === "string" ? code : undefined,
      message: error.message,
      name: error.name,
    };
  }
  return { message: String(error), name: "Error" };
};

const randomExecutionId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `exec_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

const capabilityCalls = (
  events: readonly ExecutionReceiptCapabilityEvent[] | undefined,
): ExecutionReceiptCapabilityEvent[] =>
  (events ?? []).map((event) => ({
    durationMs: event.durationMs,
    status: event.status,
    tool: event.tool,
  }));

const resolveOption = <T>(value: T | (() => T) | undefined): T | undefined =>
  typeof value === "function" ? (value as () => T)() : value;

export type ReceiptBase = {
  consoleStart?: ConsoleLimitSnapshot;
  consoleEnd?: () => ConsoleLimitSnapshot;
  isolate: Isolate;
  options: RunReceiptOptions;
  startedAt: Date;
  startedMs: number;
  timeoutMs: number;
};

export const createSuccessReceipt = (
  base: ReceiptBase,
  result: unknown,
  metrics: RunMetrics,
): ExecutionReceipt => {
  const endedAt = new Date();
  const console = consoleDelta(base.consoleStart, base.consoleEnd?.());
  const receipt: ExecutionReceipt = {
    backend: base.isolate.backend,
    capabilityCalls: capabilityCalls(base.options.capabilityEvents),
    console: {
      ...console,
      truncated: console.byteLimitExceeded || console.entryLimitExceeded,
    },
    durationMs: Math.round(performance.now() - base.startedMs),
    endedAt: endedAt.toISOString(),
    executionId: base.options.executionId ?? randomExecutionId(),
    memoryLimitMb: base.isolate.options.memoryLimit,
    metrics,
    outputBytes: estimateResultBytes(result),
    outputTruncated: false,
    startedAt: base.startedAt.toISOString(),
    status: "success",
    timeoutMs: base.timeoutMs,
  };
  if (base.isolate.policy?.name !== undefined) {
    receipt.policy = base.isolate.policy.name;
  }
  const capabilityEventsDropped = resolveOption(
    base.options.capabilityEventsDropped,
  );
  if (capabilityEventsDropped !== undefined) {
    receipt.capabilityCallsDropped = capabilityEventsDropped;
  }
  const capabilityEventsTruncated = resolveOption(
    base.options.capabilityEventsTruncated,
  );
  if (capabilityEventsTruncated !== undefined) {
    receipt.capabilityCallsTruncated = capabilityEventsTruncated;
  }
  if (base.options.purpose !== undefined)
    receipt.purpose = base.options.purpose;
  if (base.options.tenant !== undefined) receipt.tenant = base.options.tenant;
  return receipt;
};

export const createErrorReceipt = (
  base: ReceiptBase,
  error: unknown,
): ExecutionReceipt => {
  const endedAt = new Date();
  const console = consoleDelta(base.consoleStart, base.consoleEnd?.());
  const receipt: ExecutionReceipt = {
    backend: base.isolate.backend,
    capabilityCalls: capabilityCalls(base.options.capabilityEvents),
    console: {
      ...console,
      truncated: console.byteLimitExceeded || console.entryLimitExceeded,
    },
    durationMs: Math.round(performance.now() - base.startedMs),
    endedAt: endedAt.toISOString(),
    error: receiptError(error),
    executionId: base.options.executionId ?? randomExecutionId(),
    memoryLimitMb: base.isolate.options.memoryLimit,
    outputTruncated: false,
    startedAt: base.startedAt.toISOString(),
    status: "error",
    timeoutMs: base.timeoutMs,
  };
  if (base.isolate.policy?.name !== undefined) {
    receipt.policy = base.isolate.policy.name;
  }
  const capabilityEventsDropped = resolveOption(
    base.options.capabilityEventsDropped,
  );
  if (capabilityEventsDropped !== undefined) {
    receipt.capabilityCallsDropped = capabilityEventsDropped;
  }
  const capabilityEventsTruncated = resolveOption(
    base.options.capabilityEventsTruncated,
  );
  if (capabilityEventsTruncated !== undefined) {
    receipt.capabilityCallsTruncated = capabilityEventsTruncated;
  }
  if (base.options.purpose !== undefined)
    receipt.purpose = base.options.purpose;
  if (base.options.tenant !== undefined) receipt.tenant = base.options.tenant;
  return receipt;
};

export const attachReceipt = <TError>(
  error: TError,
  receipt: ExecutionReceipt,
): TError => {
  if (
    error !== null &&
    (typeof error === "object" || typeof error === "function")
  ) {
    (error as TError & { receipt?: ExecutionReceipt }).receipt = receipt;
    return error;
  }
  const wrapped = new Error(String(error)) as Error & {
    receipt?: ExecutionReceipt;
  };
  wrapped.receipt = receipt;
  return wrapped as TError;
};
