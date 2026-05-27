import { afterEach, describe, expect, test } from "bun:test";
import {
  CapabilityError,
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
  });

  test("rejects unknown tools", async () => {
    const broker = createCapabilityBroker({}, { context: undefined });
    const error = await expectError(broker.call("missing"));
    expect(error).toBeInstanceOf(CapabilityError);
    expect((error as CapabilityError).code).toBe("CAPABILITY_NOT_FOUND");
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
    const fn = await context.compileCallable(
      `async (tools, value) => await tools("double", value)`,
    );
    expect(await fn.call([broker.reference, 21])).toBe(42);
  });
});
