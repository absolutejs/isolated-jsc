import { describe, expect, test } from "bun:test";
import {
  createCapabilityBroker,
  createIsolate,
  defineCapabilityTool,
  type CheckpointReceipt,
  type ContextCheckpoint,
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

  test("checkpoint create receipt schema v1 has a stable full key set", async () => {
    let isolate: Isolate | undefined;
    try {
      isolate = await createIsolate({ backend: "worker", memoryLimit: 128 });
      const context = await isolate.createContext({
        seed: "this.scratch = 'temporary'; this.kept = { count: 1 };",
      });
      const { checkpoint, receipt } = await context.checkpointWithReceipt({
        exclude: ["scratch"],
        executionId: "contract_checkpoint_create",
        include: ["kept", "scratch"],
        maxBytes: 64 * 1024,
        purpose: "contract-test",
        tenant: "tenant-a",
      });

      expect(checkpoint.schemaVersion).toBe(1);
      expect(receipt.schemaVersion).toBe(1);
      expect(receipt.operation).toBe("create");
      expect(sortedKeys(receipt as unknown as Record<string, unknown>)).toEqual(
        [
          "backend",
          "byteLength",
          "durationMs",
          "endedAt",
          "excludeCount",
          "executionId",
          "includeCount",
          "included",
          "maxBytes",
          "memoryLimitMb",
          "operation",
          "purpose",
          "schemaVersion",
          "skippedCount",
          "skippedReasons",
          "startedAt",
          "status",
          "tenant",
        ],
      );
      expect(sortedKeys(receipt.skippedReasons)).toEqual([
        "excluded",
        "notClonable",
        "overMaxBytes",
      ]);
      expect(JSON.parse(JSON.stringify(receipt))).toEqual(receipt);
    } finally {
      await isolate?.dispose();
    }
  });

  test("checkpoint create receipt schema v1 has a stable minimal key set", async () => {
    let isolate: Isolate | undefined;
    try {
      isolate = await createIsolate({ backend: "worker", memoryLimit: 128 });
      const context = await isolate.createContext({
        seed: "this.kept = 1;",
      });
      const { receipt } = await context.checkpointWithReceipt();

      expect(receipt.schemaVersion).toBe(1);
      expect(receipt.operation).toBe("create");
      expect(sortedKeys(receipt as unknown as Record<string, unknown>)).toEqual(
        [
          "backend",
          "byteLength",
          "durationMs",
          "endedAt",
          "executionId",
          "included",
          "memoryLimitMb",
          "operation",
          "schemaVersion",
          "skippedCount",
          "skippedReasons",
          "startedAt",
          "status",
        ],
      );
    } finally {
      await isolate?.dispose();
    }
  });

  test("createContextWithReceipt schema v1 has a stable restore key set", async () => {
    let isolate: Isolate | undefined;
    try {
      isolate = await createIsolate({ backend: "worker", memoryLimit: 128 });
      const source = await isolate.createContext({
        seed: "this.kept = { count: 2 };",
      });
      const checkpoint = await source.checkpoint();
      await source.dispose();

      const { context, receipt } = await isolate.createContextWithReceipt({
        checkpoint,
        executionId: "contract_checkpoint_restore",
        purpose: "contract-test",
        tenant: "tenant-a",
      });

      expect(receipt.schemaVersion).toBe(1);
      expect(receipt.operation).toBe("restore");
      expect(sortedKeys(receipt as unknown as Record<string, unknown>)).toEqual(
        [
          "backend",
          "byteLength",
          "durationMs",
          "endedAt",
          "executionId",
          "included",
          "memoryLimitMb",
          "operation",
          "purpose",
          "schemaVersion",
          "skippedCount",
          "skippedReasons",
          "sourceBackend",
          "startedAt",
          "status",
          "tenant",
        ],
      );
      expect(receipt.sourceBackend).toBe("worker");
      expect(JSON.parse(JSON.stringify(receipt))).toEqual(receipt);
      await context.dispose();
    } finally {
      await isolate?.dispose();
    }
  });

  test("createContextWithReceipt restore failure carries an error receipt", async () => {
    let isolate: Isolate | undefined;
    try {
      isolate = await createIsolate({ backend: "worker", memoryLimit: 128 });
      const broken: ContextCheckpoint = {
        backend: "worker",
        byteLength: 7,
        data: { keep: 1 },
        included: 1,
        schemaVersion: 2 as unknown as 1,
        skipped: [],
        skippedCount: 0,
      };

      const error = (await expectReject(
        isolate.createContextWithReceipt({
          checkpoint: broken,
          executionId: "contract_checkpoint_restore_error",
          purpose: "contract-test",
        }),
      )) as Error & { receipt?: CheckpointReceipt };

      expect(error.receipt?.schemaVersion).toBe(1);
      expect(error.receipt?.status).toBe("error");
      expect(error.receipt?.operation).toBe("restore");
      expect(error.receipt?.sourceBackend).toBe("worker");
      expect(sortedKeys(error.receipt!.error!)).toEqual([
        "code",
        "message",
        "name",
      ]);
    } finally {
      await isolate?.dispose();
    }
  });
});
