import type { ContextCheckpoint } from "./types";

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
