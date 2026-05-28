import {
  createIsolate,
  validateContextCheckpoint,
} from "@absolutejs/isolated-jsc";

const isolate = await createIsolate({ backend: "auto", memoryLimit: 256 });

try {
  const turn1 = await isolate.createContext({
    seed: `
      this.messages = [];
      this.addMessage = function (role, content) {
        this.messages.push({ role, content });
        return this.messages.length;
      };
      this.scratch = "temporary trace data";
    `,
  });
  const add = await isolate.compileScript(`
    addMessage("user", "Can you summarize this order?");
    addMessage("assistant", "Yes. I can use the order tools.");
    messages.length;
  `);
  await add.run(turn1);

  // Capture a versioned checkpoint AND an audit receipt in one call. The
  // receipt mirrors the ExecutionReceipt envelope (executionId, durationMs,
  // startedAt/endedAt, optional purpose/tenant/policy) and aggregates
  // skipped-key reasons into counts.
  const { checkpoint, receipt: createReceipt } =
    await turn1.checkpointWithReceipt({
      exclude: ["scratch"],
      maxBytes: 64 * 1024,
      purpose: "turn-handoff",
      tenant: "tenant-a",
    });

  // Persist this JSON wherever your app stores tenant/session state.
  const persisted = JSON.stringify(checkpoint);
  const restoredCheckpoint = JSON.parse(persisted);
  validateContextCheckpoint(restoredCheckpoint);

  const { context: turn2, receipt: restoreReceipt } =
    await isolate.createContextWithReceipt({
      checkpoint: restoredCheckpoint,
      purpose: "turn-handoff",
      seed: `
        this.addMessage = function (role, content) {
          this.messages.push({ role, content });
          return this.messages.length;
        };
      `,
      tenant: "tenant-a",
    });
  const resume = await isolate.compileScript(`
    addMessage("assistant", "Checkpoint restored.");
    ({ messages, scratch: typeof scratch });
  `);

  console.log(
    JSON.stringify(
      {
        checkpoint: {
          byteLength: checkpoint.byteLength,
          included: checkpoint.included,
          skipped: checkpoint.skipped,
        },
        receipts: {
          create: {
            backend: createReceipt.backend,
            byteLength: createReceipt.byteLength,
            executionId: createReceipt.executionId,
            included: createReceipt.included,
            operation: createReceipt.operation,
            purpose: createReceipt.purpose,
            skippedCount: createReceipt.skippedCount,
            skippedReasons: createReceipt.skippedReasons,
            status: createReceipt.status,
            tenant: createReceipt.tenant,
          },
          restore: {
            backend: restoreReceipt.backend,
            byteLength: restoreReceipt.byteLength,
            executionId: restoreReceipt.executionId,
            included: restoreReceipt.included,
            operation: restoreReceipt.operation,
            sourceBackend: restoreReceipt.sourceBackend,
            status: restoreReceipt.status,
          },
        },
        resumed: await resume.run(turn2),
      },
      null,
      2,
    ),
  );
} finally {
  await isolate.dispose();
}
