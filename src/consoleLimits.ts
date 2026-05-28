import { estimateResultBytes } from "./resultLimits";

export type ConsoleLimitSnapshot = {
  bytes: number;
  byteLimitExceeded: boolean;
  entries: number;
  entryLimitExceeded: boolean;
};

export type ConsoleLimitState = ConsoleLimitSnapshot & {
  maxBytes?: number;
  maxEntries?: number;
};

export const createConsoleLimitState = (options: {
  maxBytes?: number;
  maxEntries?: number;
}): ConsoleLimitState => ({
  byteLimitExceeded: false,
  bytes: 0,
  entries: 0,
  entryLimitExceeded: false,
  maxBytes: options.maxBytes,
  maxEntries: options.maxEntries,
});

export const snapshotConsoleLimits = (
  state: ConsoleLimitState | undefined,
): ConsoleLimitSnapshot => ({
  byteLimitExceeded: state?.byteLimitExceeded ?? false,
  bytes: state?.bytes ?? 0,
  entries: state?.entries ?? 0,
  entryLimitExceeded: state?.entryLimitExceeded ?? false,
});

export const consoleDelta = (
  start: ConsoleLimitSnapshot | undefined,
  end: ConsoleLimitSnapshot | undefined,
): ConsoleLimitSnapshot => {
  const from = start ?? snapshotConsoleLimits(undefined);
  const to = end ?? snapshotConsoleLimits(undefined);
  return {
    byteLimitExceeded: to.byteLimitExceeded && !from.byteLimitExceeded,
    bytes: Math.max(0, to.bytes - from.bytes),
    entries: Math.max(0, to.entries - from.entries),
    entryLimitExceeded: to.entryLimitExceeded && !from.entryLimitExceeded,
  };
};

export const recordConsoleEvent = (
  state: ConsoleLimitState,
  args: unknown[],
): boolean => {
  const bytes = estimateResultBytes(args) ?? 0;
  if (state.maxEntries !== undefined && state.entries + 1 > state.maxEntries) {
    state.entryLimitExceeded = true;
    return false;
  }
  if (state.maxBytes !== undefined && state.bytes + bytes > state.maxBytes) {
    state.byteLimitExceeded = true;
    return false;
  }
  state.entries += 1;
  state.bytes += bytes;
  return true;
};
