import { createIsolate } from "./isolate";
import { createIsolatePool, type IsolatePoolOptions } from "./pool";
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

export type CreateIsolatedRunnerOptions = IsolateOptions & {
  /**
   * Pool controls for the reusable runner. `isolate` is derived from the
   * top-level options so policy/backend/memory defaults stay in one place.
   */
  pool?: Omit<IsolatePoolOptions, "isolate">;
  /**
   * Context defaults applied to every run unless a call overrides them.
   */
  context?: CreateContextOptions;
  /**
   * Globals installed for every run. Per-call globals override by name.
   */
  globals?: Record<string, unknown>;
  /**
   * Run defaults applied when the call omits `run`.
   */
  run?: RunOptions;
};

export type IsolatedRunnerRunOptions = {
  /**
   * Pool key. Use tenant/session/conversation ids to reuse the same isolate
   * across related executions. Defaults to `"default"`.
   */
  key?: string;
  context?: CreateContextOptions;
  globals?: Record<string, unknown>;
  run?: RunOptions;
  withMetrics?: boolean;
};

export type IsolatedRunnerRunWithMetricsOptions = IsolatedRunnerRunOptions & {
  withMetrics: true;
};

export type IsolatedRunner = {
  run: {
    <T = unknown>(
      source: string,
      options: IsolatedRunnerRunWithMetricsOptions,
    ): Promise<RunWithMetricsResult<T>>;
    <T = unknown>(
      source: string,
      options?: IsolatedRunnerRunOptions,
    ): Promise<T>;
  };
  size: () => number;
  dispose: () => Promise<void>;
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

export const createIsolatedRunner = (
  options: CreateIsolatedRunnerOptions = {},
): IsolatedRunner => {
  const {
    context: defaultContext,
    globals: defaultGlobals,
    pool: poolOptions,
    run: defaultRun,
    ...isolateOptions
  } = options;
  const pool = createIsolatePool({
    ...(poolOptions ?? {}),
    isolate: isolateOptions,
  });

  const run = async <T = unknown>(
    source: string,
    runOptions: IsolatedRunnerRunOptions = {},
  ): Promise<T | RunWithMetricsResult<T>> => {
    const key = runOptions.key ?? "default";
    const contextOptions = runOptions.context ?? defaultContext;
    const globals =
      defaultGlobals === undefined && runOptions.globals === undefined
        ? undefined
        : { ...(defaultGlobals ?? {}), ...(runOptions.globals ?? {}) };
    const scriptRunOptions =
      defaultRun === undefined && runOptions.run === undefined
        ? undefined
        : { ...(defaultRun ?? {}), ...(runOptions.run ?? {}) };

    return pool.run(key, async (isolate) => {
      const context = await isolate.createContext(contextOptions);
      if (globals !== undefined) {
        for (const [name, value] of Object.entries(globals)) {
          await context.setGlobal(name, value);
        }
      }

      const script = await isolate.compileScript(source);
      try {
        if (runOptions.withMetrics === true) {
          const result = await script.runWithMetrics(context, scriptRunOptions);
          return result as RunWithMetricsResult<T>;
        }
        return (await script.run(context, scriptRunOptions)) as T;
      } finally {
        await script.dispose();
        await context.dispose();
      }
    });
  };

  return {
    run: run as IsolatedRunner["run"],
    size: () => pool.size(),
    dispose: () => pool.dispose(),
  };
};
