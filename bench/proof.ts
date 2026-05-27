import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIsolate, Reference } from "../src";
import type { IsolateOptions } from "../src";

type Metric = {
  name: string;
  notes?: string;
  unit: "bytes" | "ms" | "status";
  value: number | string;
};

type RuntimeResult = {
  metrics: Metric[];
  runtime: string;
};

const iterations = Number(process.env.ITERATIONS ?? 100);
const coldIterations = Number(process.env.COLD_ITERATIONS ?? 10);

const now = () => performance.now();

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[index]!;
};

const mean = (values: number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const summarize = (
  name: string,
  values: number[],
  unit: "bytes" | "ms",
  notes?: string,
): Metric[] => [
  {
    name: `${name} mean`,
    notes,
    unit,
    value: Number(mean(values).toFixed(3)),
  },
  {
    name: `${name} p50`,
    notes,
    unit,
    value: Number(percentile(values, 50).toFixed(3)),
  },
  {
    name: `${name} p95`,
    notes,
    unit,
    value: Number(percentile(values, 95).toFixed(3)),
  },
];

const timed = async <T>(
  run: () => Promise<T>,
): Promise<{ ms: number; result: T }> => {
  const start = now();
  const result = await run();
  return { ms: now() - start, result };
};

const benchIsolatedJsc = async (
  backend: IsolateOptions["backend"],
): Promise<RuntimeResult> => {
  const metrics: Metric[] = [];
  const cold: number[] = [];

  for (let i = 0; i < coldIterations; i++) {
    const { ms, result: isolate } = await timed(() =>
      createIsolate({ backend, memoryLimit: 512 }),
    );
    cold.push(ms);
    await isolate.dispose();
  }
  metrics.push(...summarize("cold isolate", cold, "ms"));

  const isolate = await createIsolate({ backend, memoryLimit: 512 });
  const ctx = await isolate.createContext();
  const fn = await ctx.compileCallable("(x) => x * 2");
  const warm: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const { ms, result } = await timed(() => fn.call([i]));
    if (result !== i * 2) {
      throw new Error(`${backend} callable returned ${String(result)}`);
    }
    warm.push(ms);
  }
  metrics.push(...summarize("warm callable", warm, "ms"));

  const calls: number[] = [];
  const host = new Reference((x: unknown) => Number(x) + 1);
  const hostFn = await ctx.compileCallable("async (host, x) => await host(x)");
  for (let i = 0; i < iterations; i++) {
    const { ms, result } = await timed(() => hostFn.call([host, i]));
    if (result !== i + 1) {
      throw new Error(`${backend} host call returned ${String(result)}`);
    }
    calls.push(ms);
  }
  metrics.push(...summarize("host call", calls, "ms"));

  metrics.push({
    name: "heap after warm calls",
    unit: "bytes",
    value: await isolate.heapSizeBytes(),
  });

  const timeoutIsolate = await createIsolate({ backend, memoryLimit: 512 });
  const timeoutCtx = await timeoutIsolate.createContext();
  const runaway = await timeoutIsolate.compileScript("while (true) {}");
  const timeoutStart = now();
  try {
    await runaway.run(timeoutCtx, { timeout: 50 });
    metrics.push({
      name: "timeout recovery",
      unit: "status",
      value: "failed: runaway completed",
    });
  } catch {
    const elapsed = now() - timeoutStart;
    const survivesTimeout = backend === "ffi";
    let recovered = false;
    if (survivesTimeout) {
      const check = await timeoutIsolate.compileScript("1 + 1");
      recovered = (await check.run(timeoutCtx)) === 2;
    } else {
      recovered = timeoutIsolate.isDisposed;
    }
    metrics.push({
      name: "timeout recovery",
      notes: `${Number(elapsed.toFixed(3))} ms elapsed; ${
        survivesTimeout ? "isolate survives" : "worker isolate terminates"
      }`,
      unit: "status",
      value: recovered ? "ok" : "failed",
    });
  } finally {
    await timeoutIsolate.dispose();
  }

  await isolate.dispose();
  return { metrics, runtime: `isolated-jsc ${backend}` };
};

const spawnBun = (
  source: string,
  timeoutMs = 1000,
): Promise<{ ms: number; ok: boolean; timedOut: boolean }> =>
  new Promise((resolve) => {
    const start = now();
    const child = spawn(process.execPath, ["-e", source], { stdio: "ignore" });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ ms: now() - start, ok: false, timedOut: true });
    }, timeoutMs);
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ms: now() - start, ok: code === 0, timedOut: false });
    });
  });

const benchProcessSpawn = async (): Promise<RuntimeResult> => {
  const cold: number[] = [];
  for (let i = 0; i < coldIterations; i++) {
    const result = await spawnBun("1 + 1");
    if (!result.ok) throw new Error("process spawn baseline failed");
    cold.push(result.ms);
  }
  const timeout = await spawnBun("while (true) {}", 50);
  return {
    metrics: [
      ...summarize("cold process", cold, "ms", "bun subprocess per execution"),
      {
        name: "timeout recovery",
        notes: `${Number(timeout.ms.toFixed(3))} ms elapsed; process killed`,
        unit: "status",
        value: timeout.timedOut ? "ok" : "failed",
      },
    ],
    runtime: "process spawn",
  };
};

const benchNodeIsolatedVm = async (): Promise<RuntimeResult> => {
  const script = join(tmpdir(), `isolated-jsc-node-ivm-${process.pid}.mjs`);
  writeFileSync(
    script,
    `import ivm from "isolated-vm";
const iterations = ${iterations};
const coldIterations = ${coldIterations};
const now = () => performance.now();
const cold = [];
for (let i = 0; i < coldIterations; i++) {
  const start = now();
  const isolate = new ivm.Isolate({ memoryLimit: 512 });
  await isolate.createContext();
  cold.push(now() - start);
}
const isolate = new ivm.Isolate({ memoryLimit: 512 });
const context = await isolate.createContext();
const jail = context.global;
await jail.set("global", jail.derefInto());
const script = await isolate.compileScript("global.fn = function(x) { return x * 2; }");
await script.run(context);
const fn = await jail.get("fn", { reference: true });
const warm = [];
for (let i = 0; i < iterations; i++) {
  const start = now();
  const result = await fn.apply(undefined, [i], {
    arguments: { copy: true },
    result: { copy: true }
  });
  if (result !== i * 2) throw new Error("bad isolated-vm result");
  warm.push(now() - start);
}
console.log(JSON.stringify({ cold, warm }));
`,
  );

  const node = process.env.NODE_BIN ?? "node";
  return new Promise((resolve) => {
    const child = spawn(node, [script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("exit", (code) => {
      if (code !== 0) {
        resolve({
          metrics: [
            {
              name: "status",
              notes: err.includes("ERR_MODULE_NOT_FOUND")
                ? "skipped: install isolated-vm under Node to enable this baseline"
                : err.trim() ||
                  "Install isolated-vm under Node to enable this baseline.",
              unit: "status",
              value: "skipped",
            },
          ],
          runtime: "node isolated-vm",
        });
        return;
      }
      const parsed = JSON.parse(out) as { cold: number[]; warm: number[] };
      resolve({
        metrics: [
          ...summarize("cold isolate", parsed.cold, "ms"),
          ...summarize("warm callable", parsed.warm, "ms"),
        ],
        runtime: "node isolated-vm",
      });
    });
  });
};

const cleanCell = (value: unknown): string =>
  String(value).replaceAll("\n", "<br>").replaceAll("|", "\\|");

const renderMarkdown = (results: RuntimeResult[]): string => {
  const lines = [
    "# Benchmark Proof Pack",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    `Iterations: ${iterations} warm, ${coldIterations} cold`,
    "",
    "| Runtime | Metric | Value | Unit | Notes |",
    "| --- | --- | ---: | --- | --- |",
  ];
  for (const result of results) {
    for (const metric of result.metrics) {
      lines.push(
        `| ${cleanCell(result.runtime)} | ${cleanCell(
          metric.name,
        )} | ${cleanCell(metric.value)} | ${cleanCell(
          metric.unit,
        )} | ${cleanCell(metric.notes ?? "")} |`,
      );
    }
  }
  lines.push(
    "",
    "## Notes",
    "",
    "- Cold timings include backend startup and library loading. Compare p50 and p95 together before drawing conclusions from a single outlier.",
    "- The FFI backend keeps the isolate usable after a timeout. The Worker backend and process-spawn baseline recover by terminating the execution container.",
    "- The Node isolated-vm baseline is optional because it requires the native package to be installed in a Node environment.",
    "",
    "## Reproduce",
    "",
    "```bash",
    "bun run bench:proof",
    "```",
    "",
  );
  return lines.join("\n");
};

const main = async () => {
  const results: RuntimeResult[] = [];
  for (const backend of ["ffi", "worker"] as const) {
    try {
      results.push(await benchIsolatedJsc(backend));
    } catch (error) {
      results.push({
        metrics: [
          {
            name: "status",
            notes: (error as Error).message,
            unit: "status",
            value: "skipped",
          },
        ],
        runtime: `isolated-jsc ${backend}`,
      });
    }
  }
  results.push(await benchProcessSpawn());
  results.push(await benchNodeIsolatedVm());

  const markdown = renderMarkdown(results);
  writeFileSync("BENCHMARKS.md", markdown);
  console.log(markdown);
};

await main();
