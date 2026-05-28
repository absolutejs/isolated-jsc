import { createIsolate } from "./isolate";
import { createIsolatePool, type IsolatePoolOptions } from "./pool";
import type {
  Callable,
  Context,
  CreateContextOptions,
  Isolate,
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

export type IsolatedRunnerCallOptions = {
  /**
   * Pool key. Use tenant/session/conversation ids to reuse the same isolate
   * and compiled callable across related executions. Defaults to `"default"`.
   */
  key?: string;
  /**
   * Context options used when the callable is first compiled for this key/name.
   */
  context?: CreateContextOptions;
  /**
   * Globals installed when the callable is first compiled for this key/name.
   * Dynamic inputs should usually be passed via `args`.
   */
  globals?: Record<string, unknown>;
  run?: RunOptions;
  withMetrics?: boolean;
};

export type IsolatedRunnerCallWithMetricsOptions = IsolatedRunnerCallOptions & {
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
  call: {
    <T = unknown>(
      name: string,
      source: string,
      args: unknown[],
      options: IsolatedRunnerCallWithMetricsOptions,
    ): Promise<RunWithMetricsResult<T>>;
    <T = unknown>(
      name: string,
      source: string,
      args?: unknown[],
      options?: IsolatedRunnerCallOptions,
    ): Promise<T>;
  };
  size: () => number;
  dispose: () => Promise<void>;
};

type CallableSlot = {
  callable: Callable;
  context: Context;
  isolate: Isolate;
  source: string;
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
  const callables = new Map<string, CallableSlot>();

  const installGlobals = async (
    context: Context,
    globals: Record<string, unknown> | undefined,
  ): Promise<void> => {
    if (globals === undefined) return;
    for (const [name, value] of Object.entries(globals)) {
      await context.setGlobal(name, value);
    }
  };

  const disposeSlot = async (slot: CallableSlot | undefined): Promise<void> => {
    if (slot === undefined) return;
    try {
      await slot.callable.dispose();
    } catch {
      // The isolate may already have died; pool disposal owns the final tear-down.
    }
    try {
      await slot.context.dispose();
    } catch {
      // Same as above.
    }
  };

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
      await installGlobals(context, globals);

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

  const call = async <T = unknown>(
    name: string,
    source: string,
    args: unknown[] = [],
    callOptions: IsolatedRunnerCallOptions = {},
  ): Promise<T | RunWithMetricsResult<T>> => {
    const key = callOptions.key ?? "default";
    const cacheKey = `${key}\0${name}`;
    const contextOptions = callOptions.context ?? defaultContext;
    const globals =
      defaultGlobals === undefined && callOptions.globals === undefined
        ? undefined
        : { ...(defaultGlobals ?? {}), ...(callOptions.globals ?? {}) };
    const callableRunOptions =
      defaultRun === undefined && callOptions.run === undefined
        ? undefined
        : { ...(defaultRun ?? {}), ...(callOptions.run ?? {}) };

    return pool.run(key, async (isolate) => {
      let slot = callables.get(cacheKey);
      if (
        slot === undefined ||
        slot.isolate !== isolate ||
        isolate.isDisposed ||
        slot.source !== source
      ) {
        await disposeSlot(slot);
        const context = await isolate.createContext(contextOptions);
        await installGlobals(context, globals);
        const callable = await context.compileCallable(source);
        slot = { callable, context, isolate, source };
        callables.set(cacheKey, slot);
      }

      try {
        if (callOptions.withMetrics === true) {
          const result = await slot.callable.callWithMetrics(
            args,
            callableRunOptions,
          );
          return result as RunWithMetricsResult<T>;
        }
        return (await slot.callable.call(args, callableRunOptions)) as T;
      } finally {
        if (isolate.isDisposed) {
          callables.delete(cacheKey);
        }
      }
    });
  };

  return {
    run: run as IsolatedRunner["run"],
    call: call as IsolatedRunner["call"],
    size: () => pool.size(),
    async dispose() {
      const slots = [...callables.values()];
      callables.clear();
      await Promise.all(slots.map((slot) => disposeSlot(slot)));
      await pool.dispose();
    },
  };
};
