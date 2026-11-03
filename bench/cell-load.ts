/**
 * Cell load benchmark: throughput and tail latency when many locked-down
 * Worker isolates in one Bun process take requests at once.
 *
 * Run on AbsoluteJS patched Bun (lockdown()). Pin cores to model a host,
 * e.g. `taskset -c 0,1` for a 2-vCPU droplet:
 *
 *   bun bench/cell-load.ts <appBundle> [isolates=100] [seconds=10] [concurrency=1,8,32,128]
 *
 * appBundle is a classic script that sets `globalThis.__app` to anything with
 * `handle(request)`, as in bench/cell.ts. Requests pick a random isolate and
 * a random route among `/r0`..`/r29`, `/users/:id` and a validated POST.
 */
import { createIsolate, type Context, type Isolate } from "../src/index";

const bundlePath = process.argv[2];
if (!bundlePath)
  throw new Error(
    "usage: bun bench/cell-load.ts <appBundle> [isolates] [seconds] [concurrency list]",
  );
const isolateCount = Number(process.argv[3] ?? 100);
const seconds = Number(process.argv[4] ?? 10);
const levels = (process.argv[5] ?? "1,8,32,128").split(",").map(Number);

const appSource = `${await Bun.file(bundlePath).text()}\n;0;`;
const handlerSource = `async (kind, value) => {
  const request = kind === "post"
    ? new Request("http://app/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: value, qty: 2 }) })
    : new Request("http://app" + value);
  const response = await globalThis.__app.handle(request);
  await response.text();
  return response.status;
}`;

type Cell = {
  isolate: Isolate;
  context: Context;
  handle: Awaited<ReturnType<Context["compileCallable"]>>;
};
const cells: Cell[] = [];
for (let index = 0; index < isolateCount; index += 1) {
  const isolate = await createIsolate({
    backend: "worker",
    harden: true,
    memoryLimit: 64,
    requireLockdown: true,
  });
  const context = await isolate.createContext();
  await (
    await isolate.compileScript(appSource)
  ).run(context, { timeout: 10000 });
  const handle = await context.compileCallable(handlerSource);
  await handle.call(["get", "/r1"]);
  cells.push({ context, handle, isolate });
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
    ] ?? NaN
  );
};
const pick = <T>(items: T[]) =>
  items[Math.floor(Math.random() * items.length)]!;
const request = () => {
  const roll = Math.random();
  if (roll < 0.1) return ["post", "widget"];
  if (roll < 0.4) return ["get", `/users/${Math.floor(Math.random() * 1000)}`];
  return ["get", `/r${Math.floor(Math.random() * 30)}`];
};

console.log(
  `Bun ${Bun.version}, ${navigator.hardwareConcurrency} visible cores, ${isolateCount} isolates, ${seconds}s per level`,
);
console.log(
  `RSS ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB with every isolate warm\n`,
);
console.log(
  "| Concurrent requests | Requests/s | p50 (ms) | p99 (ms) | Errors |",
);
console.log("| --: | --: | --: | --: | --: |");
for (const concurrency of levels) {
  const latencies: number[] = [];
  let errors = 0;
  const deadline = performance.now() + seconds * 1000;
  const worker = async () => {
    while (performance.now() < deadline) {
      const started = performance.now();
      try {
        const status = await pick(cells).handle.call(request());
        if (status !== 200) errors += 1;
      } catch {
        errors += 1;
      }
      latencies.push(performance.now() - started);
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (performance.now() - started) / 1000;
  console.log(
    `| ${concurrency} | ${Math.round(latencies.length / elapsed)} | ${percentile(latencies, 50).toFixed(2)} | ${percentile(latencies, 99).toFixed(2)} | ${errors} |`,
  );
}

await Promise.all(cells.map((cell) => cell.isolate.dispose()));
