import { describe, expect, test } from "bun:test";
import {
  createCapabilityBroker,
  createIsolate,
  defineCapabilityTool,
  type Isolate,
} from "../src";

const sortedKeys = (value: Record<string, unknown>): string[] =>
  Object.keys(value).sort();

const expectReject = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("promise did not reject");
};

describe("versioned audit contracts", () => {
  test("capability manifest schema v1 has a stable full entry shape", () => {
    const broker = createCapabilityBroker(
      {
        lookupOrder: defineCapabilityTool({
          concurrency: 2,
          description: "Read one order by id",
          input: { name: "LookupOrderInput" },
          maxOutputBytes: 1024,
          output: "Order | null",
          redactAuditInput: () => "[redacted]",
          redactAuditOutput: () => "[redacted]",
          risk: "read-only",
          timeoutMs: 250,
          validateInput: (input) => input,
          validateOutput: (output) => output,
          handler: () => null,
        }),
      },
      { context: undefined },
    );

    const [entry] = broker.manifest();
    expect(entry?.schemaVersion).toBe(1);
    expect(sortedKeys(entry as Record<string, unknown>)).toEqual([
      "concurrency",
      "description",
      "hasInputValidator",
      "hasOutputValidator",
      "input",
      "maxOutputBytes",
      "name",
      "output",
      "redactsInput",
      "redactsOutput",
      "risk",
      "schemaVersion",
      "timeoutMs",
    ]);
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
  });

  test("capability manifest schema v1 has a stable minimal entry shape", () => {
    const broker = createCapabilityBroker(
      { ping: { handler: () => "pong" } },
      { context: undefined },
    );

    const [entry] = broker.manifest();
    expect(entry?.schemaVersion).toBe(1);
    expect(sortedKeys(entry as Record<string, unknown>)).toEqual([
      "hasInputValidator",
      "hasOutputValidator",
      "name",
      "redactsInput",
      "redactsOutput",
      "risk",
      "schemaVersion",
    ]);
  });

  test("success receipt schema v1 has a stable key set", async () => {
    let isolate: Isolate | undefined;
    try {
      isolate = await createIsolate({ backend: "worker", memoryLimit: 128 });
      const context = await isolate.createContext();
      const script = await isolate.compileScript("21 * 2");

      const { receipt, result } = await script.runWithReceipt(context, {
        capabilityEvents: [
          { durationMs: 3, status: "success", tool: "lookupOrder" },
        ],
        capabilityEventsDropped: 0,
        capabilityEventsTruncated: false,
        executionId: "contract_success",
        purpose: "contract-test",
        tenant: "tenant-a",
        timeout: 500,
      });

      expect(result).toBe(42);
      expect(receipt.schemaVersion).toBe(1);
      expect(sortedKeys(receipt as unknown as Record<string, unknown>)).toEqual(
        [
          "backend",
          "capabilityCalls",
          "capabilityCallsDropped",
          "capabilityCallsTruncated",
          "console",
          "durationMs",
          "endedAt",
          "executionId",
          "memoryLimitMb",
          "metrics",
          "outputBytes",
          "outputTruncated",
          "purpose",
          "schemaVersion",
          "startedAt",
          "status",
          "tenant",
          "timeoutMs",
        ],
      );
      expect(sortedKeys(receipt.console)).toEqual([
        "byteLimitExceeded",
        "bytes",
        "entries",
        "entryLimitExceeded",
        "truncated",
      ]);
      expect(JSON.parse(JSON.stringify(receipt))).toEqual(receipt);
    } finally {
      await isolate?.dispose();
    }
  });

  test("error receipt schema v1 has a stable key set", async () => {
    let isolate: Isolate | undefined;
    try {
      isolate = await createIsolate({ backend: "worker", memoryLimit: 128 });
      const context = await isolate.createContext();
      const script = await isolate.compileScript(
        `(() => { const e = new Error("boom"); e.name = "ContractError"; e.code = "CONTRACT_FAILURE"; throw e })()`,
      );

      const error = (await expectReject(
        script.runWithReceipt(context, {
          executionId: "contract_error",
          timeout: 500,
        }),
      )) as Error & {
        receipt?: Record<string, unknown> & {
          console: Record<string, unknown>;
          error?: Record<string, unknown>;
        };
      };

      const receipt = error.receipt;
      expect(receipt?.schemaVersion).toBe(1);
      expect(sortedKeys(receipt as Record<string, unknown>)).toEqual([
        "backend",
        "capabilityCalls",
        "console",
        "durationMs",
        "endedAt",
        "error",
        "executionId",
        "memoryLimitMb",
        "outputTruncated",
        "schemaVersion",
        "startedAt",
        "status",
        "timeoutMs",
      ]);
      expect(sortedKeys(receipt!.error!)).toEqual(["code", "message", "name"]);
      expect(JSON.parse(JSON.stringify(receipt))).toEqual(receipt);
    } finally {
      await isolate?.dispose();
    }
  });
});
