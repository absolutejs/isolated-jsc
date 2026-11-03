import type { Change } from "@absolutejs/changelog";

export const change: Change = {
  detail:
    "A hardened Worker-backend isolate shared the Worker's real `console`, so sandboxed code could print to the host process's stdout: `console.log` printed even when `onConsole` captured it, uncaptured methods (`info`, `debug`, `dir`, `table`, `trace`) always printed, and Bun's `console.write`, `console._stdout` and `console.Console` wrote there directly. Anything that reads the host's stdout as structured output, such as a log or metering pipeline, could be fed lines that looked like its own. Hardened isolates now get a frozen replacement `console`: `log`, `info` and `debug` go to `onConsole` as `log`, `warn` and `error` keep their level, every other method does nothing, and nothing reaches stdout. Without `onConsole`, output is dropped, as `IsolateOptions.onConsole` always documented. Isolates with `harden: false` keep printing as before.",
  kind: "security",
  summary: "Sandboxed code can no longer print to the host process's stdout",
};
