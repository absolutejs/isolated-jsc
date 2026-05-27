import { afterEach, describe, expect, test } from "bun:test";
import {
  compileTypeScript,
  compileTypeScriptCallable,
  createIsolate,
  Reference,
  transpileTypeScript,
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
});
