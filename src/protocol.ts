/**
 * Wire protocol between the host (parent thread) and the worker (which owns
 * the isolated JSC heap). Not part of the public API — backends are
 * swappable, and v2 (FFI to libJSC) won't use postMessage at all.
 *
 * Every host-initiated op carries a numeric `id`; the worker replies with
 * matching `id`. Unsolicited worker → host messages (console output, fatal
 * resource breach, host-Reference call-through) carry a `type` discriminator
 * instead.
 */

export type WireValue =
  | { kind: "value"; value: unknown }
  | { kind: "ref"; refId: number }
  | { kind: "externalCopy"; value: unknown };

export type WireError = {
  name: string;
  message: string;
  stack?: string;
  /** Recursively serialized `error.cause`, when present. */
  cause?: WireError;
  /** Enumerable own properties beyond name/message/stack/cause. Lets custom
   * Error subclasses (FooError with `.code`, `.statusCode`, etc.) survive
   * the cross-boundary round trip. Values must be structured-cloneable;
   * non-clonable ones are dropped silently. */
  props?: Record<string, unknown>;
};

/** First message the host sends after spawning the worker. The worker waits
 * for this before processing any other op. */
export type WorkerInitMessage = {
  op: "init";
  memoryLimitMb: number;
  bootstrap?: string;
  captureConsole: boolean;
  /** Default `true` (harden on). When `false`, the worker keeps host-capability
   * globals (`fetch`, `Bun`, `process`, …) reachable from user code. */
  harden?: boolean;
  /** Names from `HARDEN_TARGETS` to keep reachable in the sandbox even when
   * `harden` is on. Use sparingly — each one re-opens a capability path. */
  unsafelyExposeGlobals?: string[];
};

// ─── Host → Worker ──────────────────────────────────────────────────────────

export type HostRequest =
  | { id: number; op: "compile"; source: string }
  | {
      id: number;
      op: "createContext";
      seed?: string;
      snapshot?: Record<string, unknown>;
    }
  | { id: number; op: "snapshotContext"; contextId: number }
  | {
      id: number;
      op: "setGlobal";
      contextId: number;
      name: string;
      value: WireValue;
    }
  | { id: number; op: "getGlobal"; contextId: number; name: string }
  | {
      id: number;
      op: "run";
      contextId: number;
      scriptId: number;
      withMetrics?: boolean;
    }
  | { id: number; op: "disposeContext"; contextId: number }
  | { id: number; op: "disposeScript"; scriptId: number }
  | { id: number; op: "heap" }
  | {
      /** Host's reply to a worker → host Reference call. */
      id: number;
      op: "refReply";
      callId: number;
      result?: WireValue;
      error?: WireError;
    };

export type HostMessage = WorkerInitMessage | HostRequest;

// ─── Worker → Host ──────────────────────────────────────────────────────────

/** Per-run telemetry returned when `withMetrics` is set on a `run` op. */
export type WireMetrics = {
  /** Wall-clock duration (ms) of script(sandbox) — inside the worker, not
   * including host-side message-passing overhead. */
  cpuMs: number;
  /** Heap size (bytes) measured immediately after the script returned.
   * Not the run's peak — a true peak would require continuous polling.
   * Useful for "did this run blow up?" detection. */
  heapBytes: number;
};

/** Reply to a HostRequest. */
export type WorkerReply =
  | {
      id: number;
      ok: true;
      result: WireValue | number | null;
      metrics?: WireMetrics;
    }
  | { id: number; ok: false; error: WireError; metrics?: WireMetrics };

/** Unsolicited message from the worker to the host. */
export type WorkerEvent =
  | { type: "ready" }
  | { type: "console"; level: "log" | "warn" | "error"; args: unknown[] }
  | {
      /** Isolate-side code invoked an exposed host Reference. */
      type: "refCall";
      callId: number;
      refId: number;
      args: unknown[];
    }
  | {
      /** Worker detected a fatal resource breach and is about to terminate. */
      type: "fatal";
      kind: "memory";
      observedBytes: number;
      memoryLimitMb: number;
    };

export type WorkerMessage = WorkerReply | WorkerEvent;
