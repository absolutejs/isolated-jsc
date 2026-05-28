import { afterEach, describe, expect, test } from "bun:test";
import {
  compileTypeScript,
  compileTypeScriptCallable,
  compileTypeScriptCallableFile,
  compileTypeScriptFile,
  createIsolate,
  Reference,
  runIsolatedFile,
  transpileTypeScript,
  transpileSourceFileCallable,
  createIsolatedRunner,
} from "../src";
import type { Isolate } from "../src";

let isolate: Isolate | undefined;
afterEach(async () => {
  await isolate?.dispose();
  isolate = undefined;
});

describe("TypeScript helpers", () => {
  test("transpileTypeScript uses Bun's transpiler without type-checking", () => {
    const js = transpileTypeScript("const n: number = 41;\nn + 1");
    expect(js).toContain("const n = 41");
    expect(js).toContain("n + 1");
    expect(js).not.toContain(": number");
  });

  test("compileTypeScript compiles and runs typed script source", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await compileTypeScript(
      isolate,
      "const input: number = 20;\ninput + 22",
    );
    expect(await script.run(context)).toBe(42);
  });

  test("compileTypeScriptFile compiles and runs real typed files", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    await context.setGlobal("input", { n: 21 });
    const script = await compileTypeScriptFile(
      isolate,
      `${import.meta.dir}/fixtures/typed-script.ts`,
    );
    expect(await script.run(context)).toBe(42);
  });

  test("compileTypeScriptCallable compiles typed function expressions", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const fn = await compileTypeScriptCallable(
      context,
      "(name: string): string => name.trim().toUpperCase()",
    );
    expect(await fn.call([" alex "])).toBe("ALEX");
  });

  test("compileTypeScriptCallable supports host References", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const calls: unknown[][] = [];
    const tool = new Reference((op: unknown, value: unknown) => {
      calls.push([op, value]);
      if (op === "double") return Number(value) * 2;
      throw new Error(`unknown op ${String(op)}`);
    });
    const fn = await compileTypeScriptCallable(
      context,
      "async (tool: (op: string, value: number) => Promise<number>, n: number): Promise<number> => await tool('double', n)",
    );
    expect(await fn.call([tool, 21])).toBe(42);
    expect(calls).toEqual([["double", 21]]);
  });

  test("compileTypeScriptCallableFile compiles a default-export generic function", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const fn = await compileTypeScriptCallableFile(
      context,
      `${import.meta.dir}/fixtures/generic-callable.ts`,
    );
    expect(await fn.call([{ value: "typed file" }])).toBe("typed file");
  });

  test("compileTypeScriptCallableFile supports raw JavaScript files", async () => {
    isolate = await createIsolate();
    const context = await isolate.createContext();
    const fn = await compileTypeScriptCallableFile(
      context,
      `${import.meta.dir}/fixtures/raw-callable.js`,
    );
    expect(await fn.call([{ items: [1, 2, 3] }])).toBe(3);
  });

  test("transpileSourceFileCallable returns a callable expression", async () => {
    const source = await transpileSourceFileCallable(
      `${import.meta.dir}/fixtures/generic-callable.ts`,
    );
    expect(source).toContain("__isolatedJscDefaultExport");
    expect(source).not.toContain("export default");
  });

  test("runIsolatedFile runs a real typed script file", async () => {
    const result = await runIsolatedFile<number>(
      `${import.meta.dir}/fixtures/typed-script.ts`,
      {
        backend: "worker",
        globals: { input: { n: 21 } },
      },
    );
    expect(result).toBe(42);
  });

  test("runner file helpers run and cache default-export callable files", async () => {
    const runner = createIsolatedRunner({ backend: "worker" });
    try {
      await runner.precompileFile(
        "unwrap",
        `${import.meta.dir}/fixtures/generic-callable.ts`,
      );
      const result = await runner.callFile<string>(
        "unwrap",
        `${import.meta.dir}/fixtures/generic-callable.ts`,
        [{ value: "cached" }],
      );
      expect(result).toBe("cached");
      expect(runner.stats().callableCacheSize).toBe(1);
    } finally {
      await runner.dispose();
    }
  });
});
