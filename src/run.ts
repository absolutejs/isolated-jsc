import { createIsolate } from "./isolate";
import type {
  CreateContextOptions,
  IsolateOptions,
  RunOptions,
  RunWithMetricsResult,
} from "./types";

export type RunIsolatedOptions = IsolateOptions & {
  /**
   * Options for the fresh context used by this one-shot run.
   */
  context?: CreateContextOptions;
  /**
   * Host values to install on the context before the script runs. Values use
   * the same boundary rules as {@link Context.setGlobal}: primitives,
   * structured-cloneable data, {@link Reference}, and {@link ExternalCopy}.
   */
  globals?: Record<string, unknown>;
  /**
   * Per-run options. If omitted, policy/defaultRunOptions still apply.
   */
  run?: RunOptions;
  /**
   * Return `{ result, metrics }` instead of the bare result.
   */
  withMetrics?: boolean;
};

export type RunIsolatedWithMetricsOptions = RunIsolatedOptions & {
  withMetrics: true;
};

export async function runIsolated<T = unknown>(
  source: string,
  options: RunIsolatedWithMetricsOptions,
): Promise<RunWithMetricsResult<T>>;
export async function runIsolated<T = unknown>(
  source: string,
  options?: RunIsolatedOptions,
): Promise<T>;
export async function runIsolated<T = unknown>(
  source: string,
  options: RunIsolatedOptions = {},
): Promise<T | RunWithMetricsResult<T>> {
  const {
    context: contextOptions,
    globals,
    run,
    withMetrics,
    ...isolateOptions
  } = options;
  const isolate = await createIsolate(isolateOptions);
  try {
    const context = await isolate.createContext(contextOptions);
    if (globals !== undefined) {
      for (const [name, value] of Object.entries(globals)) {
        await context.setGlobal(name, value);
      }
    }

    const script = await isolate.compileScript(source);
    if (withMetrics === true) {
      const result = await script.runWithMetrics(context, run);
      return result as RunWithMetricsResult<T>;
    }
    return (await script.run(context, run)) as T;
  } finally {
    await isolate.dispose();
  }
}
