import { ResultSizeError } from "./types";

export const estimateResultBytes = (value: unknown): number | undefined => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return undefined;
  }
};

export const enforceResultSize = (
  value: unknown,
  maxResultBytes: number | undefined,
): void => {
  if (maxResultBytes === undefined) return;
  const observedBytes = estimateResultBytes(value);
  if (observedBytes === undefined || observedBytes <= maxResultBytes) return;
  throw new ResultSizeError(maxResultBytes, observedBytes);
};
