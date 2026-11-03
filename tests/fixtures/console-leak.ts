// Spawned by smoke.test.ts: sandboxed code tries every console path to the
// process's stdout. The host prints only its own lines, so any other output
// came from the isolate.
import { createIsolate } from "../../src";

const captured: string[] = [];
const capture = process.argv[2] === "capture";
const isolate = await createIsolate({
  backend: "worker",
  ...(capture
    ? {
        onConsole: (level: string, args: unknown[]) =>
          captured.push(`${level}:${args.join(" ")}`),
      }
    : {}),
});
const context = await isolate.createContext();
const script = await isolate.compileScript(`
  console.log("leak-log"); console.info("leak-info"); console.debug("leak-debug");
  console.warn("leak-warn"); console.error("leak-error"); console.dir({ leak: "dir" });
  console.table([1]); console.trace("leak-trace"); console.assert(false, "leak-assert");
  try { console.write("leak-write\\n"); } catch {}
  try { console._stdout.write("leak-stdout\\n"); } catch {}
  try { new console.Console(console._stdout).log("leak-console"); } catch {}
  try { globalThis.console = { log() {} }; } catch {}
  try { Object.getPrototypeOf(console).log?.("leak-proto"); } catch {}
  1
`);
await script.run(context, { timeout: 2000 });
await Bun.sleep(100);
await isolate.dispose();
process.stdout.write(`HOST ${JSON.stringify(captured)}\n`);
