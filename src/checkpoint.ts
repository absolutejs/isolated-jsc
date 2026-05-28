import type {
  CheckpointOperation,
  CheckpointReceipt,
  CheckpointReceiptOptions,
  CheckpointReceiptSkippedCounts,
  CheckpointWithReceiptResult,
  Context,
  ContextCheckpoint,
  ContextCheckpointSkippedKey,
  CreateContextReceiptOptions,
  CreateContextWithReceiptResult,
  Isolate,
} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const validateContextCheckpoint = (
  checkpoint: ContextCheckpoint,
): Record<string, unknown> => {
  if (!isRecord(checkpoint)) {
    throw new TypeError("Context checkpoint must be an object");
  }
  if (checkpoint.schemaVersion !== 1) {
    throw new TypeError(
      `Unsupported context checkpoint schemaVersion: ${String(
        checkpoint.schemaVersion,
      )}`,
    );
  }
  if (checkpoint.backend !== "worker" && checkpoint.backend !== "ffi") {
    throw new TypeError("Context checkpoint backend must be worker or ffi");
  }
  if (!isRecord(checkpoint.data)) {
    throw new TypeError("Context checkpoint data must be an object");
  }
  if (
    typeof checkpoint.byteLength !== "number" ||
    !Number.isFinite(checkpoint.byteLength) ||
    checkpoint.byteLength < 0
  ) {
    throw new TypeError(
      "Context checkpoint byteLength must be a finite number",
    );
  }
  if (
    typeof checkpoint.included !== "number" ||
    !Number.isInteger(checkpoint.included) ||
    checkpoint.included < 0
  ) {
    throw new TypeError(
      "Context checkpoint included must be a non-negative integer",
    );
  }
  if (!Array.isArray(checkpoint.skipped)) {
    throw new TypeError("Context checkpoint skipped must be an array");
  }
  if (
    typeof checkpoint.skippedCount !== "number" ||
    !Number.isInteger(checkpoint.skippedCount) ||
    checkpoint.skippedCount < 0
  ) {
    throw new TypeError(
      "Context checkpoint skippedCount must be a non-negative integer",
    );
  }

  for (const [key, value] of Object.entries(checkpoint.data)) {
    try {
      structuredClone(value);
    } catch {
      throw new TypeError(
        `Context checkpoint data.${key} is not structured-cloneable`,
      );
    }
  }

  return checkpoint.data;
};

const randomCheckpointId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `chk_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

const summarizeSkipped = (
  skipped: readonly ContextCheckpointSkippedKey[],
): CheckpointReceiptSkippedCounts => {
  const counts: CheckpointReceiptSkippedCounts = {
    excluded: 0,
    notClonable: 0,
    overMaxBytes: 0,
  };
  for (const entry of skipped) {
    if (entry.reason === "excluded") counts.excluded++;
    else if (entry.reason === "not-clonable") counts.notClonable++;
    else if (entry.reason === "over-max-bytes") counts.overMaxBytes++;
  }
  return counts;
};

const errorToReceiptError = (
  error: unknown,
): NonNullable<CheckpointReceipt["error"]> => {
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

type BaseReceiptInput = {
  backend: ContextCheckpoint["backend"];
  durationMs: number;
  endedAt: Date;
  executionId: string;
  isolate: Isolate;
  operation: CheckpointOperation;
  startedAt: Date;
};

const buildBaseReceipt = (
  input: BaseReceiptInput,
  options: { purpose?: string; tenant?: string; maxBytes?: number } | undefined,
): CheckpointReceipt => {
  const receipt: CheckpointReceipt = {
    backend: input.backend,
    byteLength: 0,
    durationMs: input.durationMs,
    endedAt: input.endedAt.toISOString(),
    executionId: input.executionId,
    included: 0,
    memoryLimitMb: input.isolate.options.memoryLimit,
    operation: input.operation,
    schemaVersion: 1,
    skippedCount: 0,
    skippedReasons: { excluded: 0, notClonable: 0, overMaxBytes: 0 },
    startedAt: input.startedAt.toISOString(),
    status: "success",
  };
  if (input.isolate.policy?.name !== undefined) {
    receipt.policy = input.isolate.policy.name;
  }
  if (options?.purpose !== undefined) receipt.purpose = options.purpose;
  if (options?.tenant !== undefined) receipt.tenant = options.tenant;
  if (options?.maxBytes !== undefined) receipt.maxBytes = options.maxBytes;
  return receipt;
};

const attachCheckpointReceipt = <TError>(
  error: TError,
  receipt: CheckpointReceipt,
): TError => {
  if (
    error !== null &&
    (typeof error === "object" || typeof error === "function")
  ) {
    (error as TError & { receipt?: CheckpointReceipt }).receipt = receipt;
    return error;
  }
  const wrapped = new Error(String(error)) as Error & {
    receipt?: CheckpointReceipt;
  };
  wrapped.receipt = receipt;
  return wrapped as TError;
};

export const checkpointWithReceipt = async (
  context: Context,
  options?: CheckpointReceiptOptions,
): Promise<CheckpointWithReceiptResult> => {
  const startedAt = new Date();
  const startedMs = performance.now();
  const executionId = options?.executionId ?? randomCheckpointId();
  const {
    executionId: _ignored,
    purpose,
    tenant,
    ...checkpointOptions
  } = options ?? {};
  void _ignored;
  try {
    const checkpoint = await context.checkpoint(checkpointOptions);
    const endedAt = new Date();
    const durationMs = Math.round(performance.now() - startedMs);
    const receipt = buildBaseReceipt(
      {
        backend: checkpoint.backend,
        durationMs,
        endedAt,
        executionId,
        isolate: context.isolate,
        operation: "create",
        startedAt,
      },
      { purpose, tenant, maxBytes: checkpointOptions.maxBytes },
    );
    receipt.byteLength = checkpoint.byteLength;
    receipt.included = checkpoint.included;
    receipt.skippedCount = checkpoint.skippedCount;
    receipt.skippedReasons = summarizeSkipped(checkpoint.skipped);
    if (checkpointOptions.include !== undefined) {
      receipt.includeCount = checkpointOptions.include.length;
    }
    if (checkpointOptions.exclude !== undefined) {
      receipt.excludeCount = checkpointOptions.exclude.length;
    }
    return { checkpoint, receipt };
  } catch (error) {
    const endedAt = new Date();
    const durationMs = Math.round(performance.now() - startedMs);
    const receipt = buildBaseReceipt(
      {
        backend: context.isolate.backend,
        durationMs,
        endedAt,
        executionId,
        isolate: context.isolate,
        operation: "create",
        startedAt,
      },
      { purpose, tenant, maxBytes: checkpointOptions.maxBytes },
    );
    receipt.status = "error";
    receipt.error = errorToReceiptError(error);
    if (checkpointOptions.include !== undefined) {
      receipt.includeCount = checkpointOptions.include.length;
    }
    if (checkpointOptions.exclude !== undefined) {
      receipt.excludeCount = checkpointOptions.exclude.length;
    }
    throw attachCheckpointReceipt(error, receipt);
  }
};

export const createContextWithReceipt = async (
  isolate: Isolate,
  options?: CreateContextReceiptOptions,
): Promise<CreateContextWithReceiptResult> => {
  const startedAt = new Date();
  const startedMs = performance.now();
  const executionId = options?.executionId ?? randomCheckpointId();
  const {
    executionId: _ignored,
    purpose,
    tenant,
    ...contextOptions
  } = options ?? {};
  void _ignored;
  try {
    const context = await isolate.createContext(contextOptions);
    const endedAt = new Date();
    const durationMs = Math.round(performance.now() - startedMs);
    const receipt = buildBaseReceipt(
      {
        backend: isolate.backend,
        durationMs,
        endedAt,
        executionId,
        isolate,
        operation: "restore",
        startedAt,
      },
      { purpose, tenant },
    );
    if (contextOptions.checkpoint !== undefined) {
      receipt.byteLength = contextOptions.checkpoint.byteLength;
      receipt.included = contextOptions.checkpoint.included;
      receipt.sourceBackend = contextOptions.checkpoint.backend;
    } else if (contextOptions.snapshot !== undefined) {
      receipt.included = Object.keys(contextOptions.snapshot).length;
    }
    return { context, receipt };
  } catch (error) {
    const endedAt = new Date();
    const durationMs = Math.round(performance.now() - startedMs);
    const receipt = buildBaseReceipt(
      {
        backend: isolate.backend,
        durationMs,
        endedAt,
        executionId,
        isolate,
        operation: "restore",
        startedAt,
      },
      { purpose, tenant },
    );
    receipt.status = "error";
    receipt.error = errorToReceiptError(error);
    if (options?.checkpoint !== undefined) {
      receipt.byteLength = options.checkpoint.byteLength ?? 0;
      receipt.included = options.checkpoint.included ?? 0;
      receipt.sourceBackend = options.checkpoint.backend;
    } else if (options?.snapshot !== undefined) {
      receipt.included = Object.keys(options.snapshot).length;
    }
    throw attachCheckpointReceipt(error, receipt);
  }
};
