/**
 * Cell density benchmark: what each extra locked-down Worker isolate costs
 * inside one Bun process (a "cell" in PAAS's isolate sandbox plan).
 *
 * Run on AbsoluteJS patched Bun (1.4.4+absolute.2 or later), which has
 * lockdown(); every isolate here requires it, as tenant isolates will.
 *
 *   bun bench/cell.ts [maxIsolates=200] [rssCeilingMb=6144]
 *
 * Reports: process RSS at increasing isolate counts and the marginal RSS per
 * isolate; cold create (isolate + context + handler, until it first answers)
 * p50/p95; warm call p50/p95 across all live isolates; and wake (dispose,
 * then recreate from a data checkpoint and answer) p50/p95.
 */
import { createIsolate, type Context, type Isolate } from "../src/index";

const maxIsolates = Number(process.argv[2] ?? 200);
const rssCeiling = Number(process.argv[3] ?? 6144) * 1024 * 1024;
const steps = [0, 1, 5, 10, 25, 50, 100, 200, 400, 800].filter(
  (n) => n <= maxIsolates,
);

// A small fetch-style app: module state on the context, plus a handler
// compiled once and called per request.
const appSource = `this.state ??= { hits: 0, routes: Array.from({ length: 50 }, (_, i) => "/r" + i) }; 0;`;
const handlerSource = `(path) => {
  this.state.hits += 1;
  return { status: this.state.routes.includes(path) ? 200 : 404, hits: this.state.hits };
}`;

type Cell = {
  isolate: Isolate;
  context: Context;
  handle: Awaited<ReturnType<Context["compileCallable"]>>;
};

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
    ] ?? NaN
  );
};
const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
const settledRss = async () => {
  Bun.gc(true);
  await Bun.sleep(250);
  Bun.gc(true);
  return process.memoryUsage().rss;
};

type Checkpoint = Awaited<ReturnType<Context["checkpoint"]>>;
const startApp = async (checkpoint?: Checkpoint): Promise<Cell> => {
  const isolate = await createIsolate({
    backend: "worker",
    harden: true,
    memoryLimit: 64,
    requireLockdown: true,
  });
  const context = await isolate.createContext(
    checkpoint ? { checkpoint } : undefined,
  );
  await (
    await isolate.compileScript(appSource)
  ).run(context, { timeout: 1000 });
  const handle = await context.compileCallable(handlerSource);
  await handle.call(["/r7"]);
  return { context, handle, isolate };
};

const isolate0 = await createIsolate({
  backend: "worker",
  requireLockdown: true,
});
if (!isolate0.lockedDown)
  throw new Error("isolates are not locked down; run on patched Bun");
await isolate0.dispose();

console.log(`Bun ${Bun.version}, ${navigator.hardwareConcurrency} cores`);
const baseline = await settledRss();
const cells: Cell[] = [];
const cold: number[] = [];
const rows: { count: number; rss: number }[] = [{ count: 0, rss: baseline }];

for (const target of steps.slice(1)) {
  while (cells.length < target) {
    const started = performance.now();
    cells.push(await startApp());
    cold.push(performance.now() - started);
  }
  const rss = await settledRss();
  rows.push({ count: target, rss });
  if (rss > rssCeiling) {
    console.log(`stopping at ${target}: RSS ${mb(rss)} MB passed the ceiling`);
    break;
  }
}

const warm: number[] = [];
for (let round = 0; round < 5; round += 1) {
  for (const cell of cells) {
    const started = performance.now();
    await cell.handle.call(["/r7"]);
    warm.push(performance.now() - started);
  }
}

const wake: number[] = [];
const wakeCount = Math.min(cells.length, 50);
for (let index = 0; index < wakeCount; index += 1) {
  const cell = cells[index]!;
  const checkpoint = await cell.context.checkpoint({ include: ["state"] });
  await cell.isolate.dispose();
  const started = performance.now();
  cells[index] = await startApp(checkpoint);
  wake.push(performance.now() - started);
}

console.log("\n| Isolates | RSS (MB) | Marginal per isolate (MB) |");
console.log("| --: | --: | --: |");
for (const [index, row] of rows.entries()) {
  const previous = rows[index - 1];
  const marginal = previous
    ? mb((row.rss - previous.rss) / (row.count - previous.count))
    : "";
  console.log(`| ${row.count} | ${mb(row.rss)} | ${marginal} |`);
}
const last = rows.at(-1)!;
console.log(
  `\nAverage per isolate at ${last.count}: ${mb((last.rss - baseline) / last.count)} MB over a ${mb(baseline)} MB baseline`,
);
const line = (name: string, values: number[]) =>
  console.log(
    `${name}: p50 ${percentile(values, 50).toFixed(1)} ms, p95 ${percentile(values, 95).toFixed(1)} ms (n=${values.length})`,
  );
line("Cold create to first answer", cold);
line("Warm call", warm);
line("Wake from checkpoint to first answer", wake);

await Promise.all(cells.map((cell) => cell.isolate.dispose()));
