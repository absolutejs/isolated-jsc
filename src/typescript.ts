import type { Callable, Context, Isolate, Script } from "./types";

export type TypeScriptLoader = "ts" | "tsx";

export type TranspileTypeScriptOptions = {
  /**
   * Bun loader used for the source. Use `"tsx"` when tenant/plugin source may
   * contain JSX syntax.
   */
  loader?: TypeScriptLoader;
  /**
   * Bun transpilation target. Defaults to `"bun"` because isolate code runs
   * inside Bun/JavaScriptCore.
   */
  target?: "bun" | "browser" | "node";
};

/**
 * Transpile TypeScript with Bun's native transpiler before sending source to
 * the isolate. This does not type-check; run `tsc --noEmit` separately when
 * you need diagnostics.
 */
export const transpileTypeScript = (
  source: string,
  options: TranspileTypeScriptOptions = {},
): string => {
  const transpiler = new Bun.Transpiler({
    loader: options.loader ?? "ts",
    target: options.target ?? "bun",
  });
  return transpiler.transformSync(source);
};

/**
 * Transpile TypeScript and compile it as an isolate script.
 */
export const compileTypeScript = async (
  isolate: Isolate,
  source: string,
  options?: TranspileTypeScriptOptions,
): Promise<Script> =>
  isolate.compileScript(transpileTypeScript(source, options));

const transpileCallableExpression = (
  source: string,
  options?: TranspileTypeScriptOptions,
): string => {
  const marker = "export default ";
  const compiled = transpileTypeScript(`export default (${source});`, options)
    .trim()
    .replace(/;\s*$/, "");
  if (!compiled.startsWith(marker)) {
    throw new Error("Bun failed to transpile TypeScript callable expression");
  }
  return compiled.slice(marker.length);
};

/**
 * Transpile a TypeScript function expression and compile it as a reusable
 * callable. The export wrapper keeps Bun's transpiler from dropping a bare
 * arrow function expression, then we pass the resulting function expression to
 * Context.compileCallable.
 */
export const compileTypeScriptCallable = async (
  context: Context,
  source: string,
  options?: TranspileTypeScriptOptions,
): Promise<Callable> => {
  return context.compileCallable(transpileCallableExpression(source, options));
};
