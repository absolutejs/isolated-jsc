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

  const checkpoint = await turn1.checkpoint({
    exclude: ["scratch"],
    maxBytes: 64 * 1024,
  });

  // Persist this JSON wherever your app stores tenant/session state.
  const persisted = JSON.stringify(checkpoint);
  const restoredCheckpoint = JSON.parse(persisted);
  validateContextCheckpoint(restoredCheckpoint);

  const turn2 = await isolate.createContext({
    checkpoint: restoredCheckpoint,
    seed: `
      this.addMessage = function (role, content) {
        this.messages.push({ role, content });
        return this.messages.length;
      };
    `,
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
        resumed: await resume.run(turn2),
      },
      null,
      2,
    ),
  );
} finally {
  await isolate.dispose();
}
