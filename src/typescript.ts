import type { Callable, Context, Isolate, Script } from "./types";

export type TypeScriptLoader = "ts" | "tsx";
export type SourceFileLoader = "js" | "jsx" | "ts" | "tsx";

export type TranspileTypeScriptOptions = {
  /**
   * Bun loader used for the source. Use `"tsx"` / `"jsx"` when tenant/plugin
   * source may contain JSX syntax.
   */
  loader?: SourceFileLoader;
  /**
   * Bun transpilation target. Defaults to `"bun"` because isolate code runs
   * inside Bun/JavaScriptCore.
   */
  target?: "bun" | "browser" | "node";
};

export type SourceFileOptions = TranspileTypeScriptOptions & {
  /**
   * Override the loader inferred from the file extension.
   */
  loader?: SourceFileLoader;
};

const inferSourceFileLoader = (filePath: string | URL): SourceFileLoader => {
  const pathname =
    filePath instanceof URL ? filePath.pathname : filePath.toString();
  const cleanPath = pathname.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  if (cleanPath.endsWith(".tsx")) return "tsx";
  if (cleanPath.endsWith(".jsx")) return "jsx";
  if (cleanPath.endsWith(".mjs") || cleanPath.endsWith(".cjs")) return "js";
  if (cleanPath.endsWith(".js")) return "js";
  return "ts";
};

const sourceFileLabel = (filePath: string | URL): string =>
  filePath instanceof URL ? filePath.href : filePath.toString();

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
 * Read a real source file from disk. This is intentionally a tiny helper so
 * callers can keep tenant/plugin code in normal `.ts`, `.tsx`, `.js`, or
 * `.jsx` files with editor diagnostics, generics, and stack-friendly names.
 */
export const readSourceFile = async (filePath: string | URL): Promise<string> =>
  await Bun.file(filePath).text();

/**
 * Read and transpile a source file with Bun's native transpiler. The loader is
 * inferred from `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, or `.cjs` unless supplied.
 */
export const transpileSourceFile = async (
  filePath: string | URL,
  options: SourceFileOptions = {},
): Promise<string> => {
  const source = await readSourceFile(filePath);
  return transpileTypeScript(source, {
    ...options,
    loader: options.loader ?? inferSourceFileLoader(filePath),
  });
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

/**
 * Read a `.ts`, `.tsx`, `.js`, or `.jsx` file, transpile it with Bun, and
 * compile it as an isolate script.
 */
export const compileTypeScriptFile = async (
  isolate: Isolate,
  filePath: string | URL,
  options?: SourceFileOptions,
): Promise<Script> =>
  isolate.compileScript(await transpileSourceFile(filePath, options));

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

const callableDefaultExportSource = (
  compiledModule: string,
  filePath: string | URL,
): string => {
  const binding = "__isolatedJscDefaultExport";
  let body = compiledModule;
  const functionExport =
    /\bexport\s+default\s+(async\s+)?function(\s+\w+)?\s*\(/;
  if (functionExport.test(body)) {
    body = body.replace(
      functionExport,
      (_match, asyncPrefix = "", name = "") =>
        `const ${binding} = ${asyncPrefix}function${name}(`,
    );
  } else {
    const defaultExport = /\bexport\s+default\s+/;
    if (!defaultExport.test(body)) {
      throw new Error(
        `TypeScript callable file must export a default function: ${sourceFileLabel(filePath)}`,
      );
    }
    body = body.replace(defaultExport, `const ${binding} = `);
  }
  return `(() => {\n${body}\n;return ${binding};\n})()`;
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

/**
 * Read a source file whose default export is a function and transpile it into
 * the callable expression consumed by {@link Context.compileCallable}.
 */
export const transpileSourceFileCallable = async (
  filePath: string | URL,
  options?: SourceFileOptions,
): Promise<string> => {
  const compiled = await transpileSourceFile(filePath, options);
  return callableDefaultExportSource(compiled, filePath);
};

/**
 * Read a source file whose default export is a function, transpile it with Bun,
 * and compile that default export as a reusable isolate callable.
 *
 * Example file:
 *
 * ```ts
 * type Box<T> = { value: T };
 * export default function unwrap<T>(box: Box<T>): T {
 *   return box.value;
 * }
 * ```
 */
export const compileTypeScriptCallableFile = async (
  context: Context,
  filePath: string | URL,
  options?: SourceFileOptions,
): Promise<Callable> => {
  return context.compileCallable(
    await transpileSourceFileCallable(filePath, options),
  );
};
