import { afterEach, describe, expect, test } from "bun:test";
import {
  CapabilityError,
  createCapabilityAuditBuffer,
  createCapabilityBroker,
  createIsolate,
  defineCapabilityTool,
  type CapabilityAuditEvent,
} from "../src";
import type { Isolate } from "../src";

let isolate: Isolate | undefined;
afterEach(async () => {
  await isolate?.dispose();
  isolate = undefined;
});

const expectError = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("promise did not reject");
};

const asObject = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object") {
    throw new Error("expected object input");
  }
  return value as Record<string, unknown>;
};

describe("createCapabilityBroker", () => {
  test("bounds retained audit events for receipt-safe buffers", () => {
    const buffer = createCapabilityAuditBuffer<{ tenantId: string }>({
      maxEvents: 2,
    });
    const event = (
      tool: string,
      status: CapabilityAuditEvent<{ tenantId: string }>["status"],
    ): CapabilityAuditEvent<{ tenantId: string }> => ({
      context: { tenantId: "tenant-a" },
      input: undefined,
      status,
      tool,
    });

    buffer.onAudit(event("one", "start"));
    buffer.onAudit(event("one", "success"));
    buffer.onAudit(event("two", "start"));

    expect(buffer.events.map((item) => item.status)).toEqual([
      "start",
      "success",
    ]);
    expect(buffer.dropped).toBe(1);
    expect(buffer.truncated).toBe(true);
    expect(buffer.snapshot()).toMatchObject({
      dropped: 1,
      truncated: true,
    });
    const receiptOptions = buffer.receiptOptions();
    expect(receiptOptions.capabilityEventsDropped()).toBe(1);
    expect(receiptOptions.capabilityEventsTruncated()).toBe(true);

    buffer.clear();
    expect(buffer.events).toHaveLength(0);
    expect(buffer.dropped).toBe(0);
    expect(buffer.truncated).toBe(false);
  });

  test("allows zero retained audit events", () => {
    const buffer = createCapabilityAuditBuffer({ maxEvents: 0 });
    buffer.onAudit({
      context: undefined,
      input: "secret",
      status: "start",
      tool: "lookup",
    });
    expect(buffer.events).toHaveLength(0);
    expect(buffer.dropped).toBe(1);
    const receiptOptions = buffer.receiptOptions();
    expect(receiptOptions.capabilityEvents).toEqual([]);
    expect(receiptOptions.capabilityEventsDropped()).toBe(1);
    expect(receiptOptions.capabilityEventsTruncated()).toBe(true);
  });

  test("dispatches validated tools through a Reference", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const audit: CapabilityAuditEvent<{ tenantId: string }>[] = [];
    const broker = createCapabilityBroker(
      {
        add: defineCapabilityTool<
          { a: number; b: number },
          number,
          { tenantId: string }
        >({
          validateInput: (input) => {
            const object = asObject(input);
            return {
              a: Number(object.a),
              b: Number(object.b),
            };
          },
          validateOutput: (output) => Number(output),
          handler: ({ a, b }, ctx) => {
            expect(ctx.tenantId).toBe("tenant-a");
            return a + b;
          },
        }),
      },
      {
        context: { tenantId: "tenant-a" },
        onAudit: (event) => audit.push(event),
      },
    );
    await context.setGlobal("tools", broker.reference);
    const script = await isolate.compileScript(
      `(async () => await tools("add", { a: 20, b: 22 }))()`,
    );
    expect(await script.run(context)).toBe(42);
    expect(audit.map((event) => event.status)).toEqual(["start", "success"]);
    expect(audit[1]?.tool).toBe("add");
    expect(audit[1]?.output).toBe(42);
    const direct = await broker.call("add", { a: 1, b: 2 });
    const typedDirect: number = direct;
    expect(typedDirect).toBe(3);
  });

  test("rejects unknown tools", async () => {
    const broker = createCapabilityBroker({}, { context: undefined });
    const error = await expectError(broker.call("missing"));
    expect(error).toBeInstanceOf(CapabilityError);
    expect((error as CapabilityError).code).toBe("CAPABILITY_NOT_FOUND");
  });

  test("exposes a serializable manifest for reviewable host powers", () => {
    const broker = createCapabilityBroker(
      {
        lookupOrder: defineCapabilityTool<
          { id: string },
          { id: string; status: string } | null,
          { tenantId: string }
        >({
          concurrency: 2,
          description: "Read one order by id for the current tenant",
          input: { name: "LookupOrderInput" },
          output: "Order | null",
          risk: "read-only",
          timeoutMs: 250,
          validateInput: (input) => {
            const object = asObject(input);
            return { id: String(object.id) };
          },
          validateOutput: (output) => output as { id: string; status: string },
          handler: ({ id }) => ({ id, status: "paid" }),
        }),
        writeAudit: {
          handler: () => "ok",
        },
      },
      { context: { tenantId: "tenant-a" } },
    );

    expect(broker.manifest()).toEqual([
      {
        concurrency: 2,
        description: "Read one order by id for the current tenant",
        hasInputValidator: true,
        hasOutputValidator: true,
        input: { name: "LookupOrderInput" },
        name: "lookupOrder",
        output: "Order | null",
        redactsInput: false,
        redactsOutput: false,
        risk: "read-only",
        timeoutMs: 250,
      },
      {
        hasInputValidator: false,
        hasOutputValidator: false,
        name: "writeAudit",
        redactsInput: false,
        redactsOutput: false,
        risk: "unknown",
      },
    ]);
    expect(JSON.parse(JSON.stringify(broker.manifest()))).toEqual(
      broker.manifest(),
    );
  });

  test("redacts capability audit inputs and outputs", async () => {
    const audit: CapabilityAuditEvent<{ tenantId: string }>[] = [];
    const broker = createCapabilityBroker(
      {
        lookupSecret: defineCapabilityTool<
          { token: string },
          { token: string; value: string },
          { tenantId: string }
        >({
          input: "LookupSecretInput",
          output: "SecretLookup",
          redactAuditInput: (input) => {
            const object = asObject(input);
            return { token: String(object.token).slice(0, 3) + "..." };
          },
          redactAuditOutput: () => ({ value: "[redacted]" }),
          validateInput: (input) => {
            const object = asObject(input);
            return { token: String(object.token) };
          },
          handler: ({ token }) => ({ token, value: "customer-secret" }),
        }),
      },
      {
        context: { tenantId: "tenant-a" },
        onAudit: (event) => audit.push(event),
      },
    );

    expect(await broker.call("lookupSecret", { token: "sk_live_123" })).toEqual(
      {
        token: "sk_live_123",
        value: "customer-secret",
      },
    );
    expect(broker.manifest()[0]).toMatchObject({
      name: "lookupSecret",
      redactsInput: true,
      redactsOutput: true,
    });
    expect(audit).toHaveLength(2);
    expect(audit[0]?.input).toEqual({ token: "sk_..." });
    expect(audit[1]?.input).toEqual({ token: "sk_..." });
    expect(audit[1]?.output).toEqual({ value: "[redacted]" });
  });

  test("uses broker-level audit redaction for rejections", async () => {
    const audit: CapabilityAuditEvent[] = [];
    const broker = createCapabilityBroker(
      {
        fail: {
          validateInput: () => {
            throw new Error("nope");
          },
          handler: () => "unreachable",
        },
      },
      {
        context: undefined,
        onAudit: (event) => audit.push(event),
        redactAuditInput: () => "[input redacted]",
      },
    );

    const error = await expectError(broker.call("fail", { token: "secret" }));
    expect(error.message).toBe("nope");
    expect(audit.map((event) => event.status)).toEqual(["start", "error"]);
    expect(audit.every((event) => event.input === "[input redacted]")).toBe(
      true,
    );

    const missing = await expectError(
      broker.call("missing", { token: "secret" }),
    );
    expect(missing).toBeInstanceOf(CapabilityError);
    expect(audit.at(-1)?.input).toBe("[input redacted]");
  });

  test("enforces per-tool timeout", async () => {
    const audit: CapabilityAuditEvent[] = [];
    const broker = createCapabilityBroker(
      {
        slow: {
          timeoutMs: 10,
          handler: () =>
            new Promise((resolve) => setTimeout(() => resolve("late"), 50)),
        },
      },
      { context: undefined, onAudit: (event) => audit.push(event) },
    );
    const error = await expectError(broker.call("slow"));
    expect(error).toBeInstanceOf(CapabilityError);
    expect((error as CapabilityError).code).toBe("CAPABILITY_TIMEOUT");
    expect(audit.map((event) => event.status)).toEqual(["start", "timeout"]);
  });

  test("enforces concurrency limits", async () => {
    let release!: () => void;
    const broker = createCapabilityBroker(
      {
        once: {
          concurrency: 1,
          handler: () =>
            new Promise((resolve) => {
              release = () => resolve("done");
            }),
        },
      },
      { context: undefined },
    );
    const first = broker.call("once");
    const second = await expectError(broker.call("once"));
    expect(second).toBeInstanceOf(CapabilityError);
    expect((second as CapabilityError).code).toBe(
      "CAPABILITY_CONCURRENCY_LIMIT",
    );
    release();
    expect(await first).toBe("done");
  });

  test("can be passed as an inline Reference argument to callables", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const broker = createCapabilityBroker(
      {
        double: defineCapabilityTool<number, number, undefined>({
          validateInput: (input) => Number(input),
          handler: (input) => input * 2,
        }),
      },
      { context: undefined },
    );
    const direct = await broker.call("double", 21);
    const typedDirect: number = direct;
    expect(typedDirect).toBe(42);
    const fn = await context.compileCallable(
      `async (tools, value) => await tools("double", value)`,
    );
    expect(await fn.call([broker.reference, 21])).toBe(42);
  });
});
