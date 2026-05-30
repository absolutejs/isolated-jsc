/**
 * 0.11.0 OTel integration for the hibernating isolate pool.
 * Captures spans emitted by `pool.run(key, fn)` and verifies attributes
 * + lifecycle (fresh spawn vs wake from hibernation).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  ABS_ATTRS,
  createNoopSpan,
  type Span,
  type Tracer,
  type TracerProvider,
} from "@absolutejs/telemetry";
import {
  createHibernatingIsolatePool,
  type HibernatingIsolatePool,
} from "../src";

type CapturedSpan = {
  name: string;
  attrs: Record<string, unknown>;
  status?: { code: number };
  exception?: unknown;
  ended: boolean;
};

const makeCapturingTracerProvider = () => {
  const spans: CapturedSpan[] = [];
  const makeSpan = (record: CapturedSpan): Span => {
    const noop = createNoopSpan();
    return {
      ...noop,
      end: () => {
        record.ended = true;
      },
      isRecording: () => !record.ended,
      recordException: (exception) => {
        record.exception = exception;
      },
      setAttribute: ((key: string, value: unknown) => {
        record.attrs[key] = value;
        return makeSpan(record);
      }) as Span["setAttribute"],
      setStatus: ((status) => {
        record.status = status;
        return makeSpan(record);
      }) as Span["setStatus"],
    };
  };
  const tracer: Tracer = {
    startActiveSpan: ((name, optionsOrFn, maybeFn) => {
      const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
      const record: CapturedSpan = { attrs: {}, ended: false, name };
      spans.push(record);
      return (fn as (s: Span) => unknown)(makeSpan(record));
    }) as Tracer["startActiveSpan"],
    startSpan: (name, options) => {
      const record: CapturedSpan = {
        attrs: { ...(options?.attributes ?? {}) },
        ended: false,
        name,
      };
      spans.push(record);
      return makeSpan(record);
    },
  };
  const provider: TracerProvider = { getTracer: () => tracer };
  return { provider, spans };
};

let pool: HibernatingIsolatePool | null = null;
afterEach(async () => {
  await pool?.dispose();
  pool = null;
});

describe("isolated-jsc 0.11.0 — OTel via @absolutejs/telemetry", () => {
  test("pool.run emits isolated_jsc.run span on first (cold-spawn) use", async () => {
    const { provider, spans } = makeCapturingTracerProvider();
    pool = createHibernatingIsolatePool({
      hibernateAfterMs: 0,
      tracerProvider: provider,
    });
    await pool.run("tenant-A", async () => {
      // no-op handler
    });
    const span = spans.find((s) => s.name === "isolated_jsc.run");
    expect(span).toBeDefined();
    expect(span!.attrs[ABS_ATTRS.tenant]).toBe("tenant-A");
    // First use = cold spawn = "woke from hibernation" attribute is true
    // (we use the same flag to signal "this run needed a wake/spawn").
    expect(span!.attrs["isolated_jsc.woke_from_hibernation"]).toBe(true);
    expect(span!.status?.code).toBe(1);
    expect(span!.ended).toBe(true);
  });

  test("second run on same key emits span with woke=false (reused active)", async () => {
    const { provider, spans } = makeCapturingTracerProvider();
    pool = createHibernatingIsolatePool({
      hibernateAfterMs: 0,
      tracerProvider: provider,
    });
    await pool.run("tenant-A", async () => {});
    await pool.run("tenant-A", async () => {});
    const runs = spans.filter((s) => s.name === "isolated_jsc.run");
    expect(runs).toHaveLength(2);
    expect(runs[0]!.attrs["isolated_jsc.woke_from_hibernation"]).toBe(true);
    expect(runs[1]!.attrs["isolated_jsc.woke_from_hibernation"]).toBe(false);
  });

  test("hibernate + re-run emits span with woke=true + wake_ms", async () => {
    const { provider, spans } = makeCapturingTracerProvider();
    pool = createHibernatingIsolatePool({
      hibernateAfterMs: 0,
      tracerProvider: provider,
    });
    await pool.run("tenant-A", async () => {});
    await pool.hibernate("tenant-A");
    await pool.run("tenant-A", async () => {});
    const runs = spans.filter((s) => s.name === "isolated_jsc.run");
    expect(runs).toHaveLength(2);
    expect(runs[1]!.attrs["isolated_jsc.woke_from_hibernation"]).toBe(true);
    expect(runs[1]!.attrs["isolated_jsc.wake_ms"]).toBeDefined();
    expect(typeof runs[1]!.attrs["isolated_jsc.wake_ms"]).toBe("number");
  });

  test("handler throw records exception + ERROR status", async () => {
    const { provider, spans } = makeCapturingTracerProvider();
    pool = createHibernatingIsolatePool({
      hibernateAfterMs: 0,
      tracerProvider: provider,
    });
    await expect(
      pool.run("tenant-A", async () => {
        throw new Error("handler boom");
      }),
    ).rejects.toThrow("handler boom");
    const span = spans.find((s) => s.name === "isolated_jsc.run");
    expect(span!.status?.code).toBe(2);
    expect(span!.exception).toBeInstanceOf(Error);
    expect(span!.ended).toBe(true);
  });

  test("without tracerProvider, pool still works (noop)", async () => {
    pool = createHibernatingIsolatePool({ hibernateAfterMs: 0 });
    const result = await pool.run("tenant-A", async () => 42);
    expect(result).toBe(42);
  });
});
