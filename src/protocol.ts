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
};

/** First message the host sends after spawning the worker. The worker waits
 * for this before processing any other op. */
export type WorkerInitMessage = {
  op: "init";
  memoryLimitMb: number;
  bootstrap?: string;
  captureConsole: boolean;
};

// ─── Host → Worker ──────────────────────────────────────────────────────────

export type HostRequest =
  | { id: number; op: "compile"; source: string }
  | { id: number; op: "createContext" }
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

/** Reply to a HostRequest. */
export type WorkerReply =
  | { id: number; ok: true; result: WireValue | number | null }
  | { id: number; ok: false; error: WireError };

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
