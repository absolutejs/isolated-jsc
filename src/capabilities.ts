import { Reference } from "./types";

export type CapabilityAuditStatus =
  | "start"
  | "success"
  | "error"
  | "rejected"
  | "timeout";

export type CapabilityAuditEvent<TContext = unknown> = {
  context: TContext;
  durationMs?: number;
  error?: Error;
  input: unknown;
  output?: unknown;
  status: CapabilityAuditStatus;
  tool: string;
};

export type CapabilityValidator<T> = (value: unknown) => T;

export type CapabilityTool<
  TInput = unknown,
  TOutput = unknown,
  TContext = unknown,
> = {
  concurrency?: number;
  handler: (input: TInput, context: TContext) => TOutput | Promise<TOutput>;
  validateInput?: CapabilityValidator<TInput>;
  validateOutput?: CapabilityValidator<TOutput>;
  timeoutMs?: number;
};

export type InferCapabilityInput<TTool> = TTool extends {
  validateInput: CapabilityValidator<infer TInput>;
}
  ? TInput
  : TTool extends CapabilityTool<infer TInput, any, any>
    ? TInput
    : unknown;

export type InferCapabilityOutput<TTool> = TTool extends {
  validateOutput: CapabilityValidator<infer TOutput>;
}
  ? TOutput
  : TTool extends CapabilityTool<any, infer TOutput, any>
    ? TOutput
    : unknown;

export type InferCapabilityContext<TTool> =
  TTool extends CapabilityTool<any, any, infer TContext> ? TContext : unknown;

type AnyCapabilityTool<TContext = unknown> = CapabilityTool<any, any, TContext>;

export type CapabilityBrokerCall<
  TTools extends Record<string, AnyCapabilityTool<any>>,
> = {
  <TToolName extends Extract<keyof TTools, string>>(
    tool: TToolName,
    input: InferCapabilityInput<TTools[TToolName]>,
  ): Promise<InferCapabilityOutput<TTools[TToolName]>>;
  (tool: string, input?: unknown): Promise<unknown>;
};

export type CapabilityBrokerFor<
  TTools extends Record<string, AnyCapabilityTool<any>>,
> = {
  call: CapabilityBrokerCall<TTools>;
  reference: Reference<(tool: unknown, input?: unknown) => Promise<unknown>>;
};

type ValidatedCapabilityTool<TInput, TOutput, TContext> = Omit<
  CapabilityTool<TInput, TOutput, TContext>,
  "handler" | "validateInput"
> & {
  handler: (input: TInput, context: TContext) => TOutput | Promise<TOutput>;
  validateInput: CapabilityValidator<TInput>;
};

export function defineCapabilityTool<TInput, TOutput, TContext = unknown>(
  tool: ValidatedCapabilityTool<TInput, TOutput, TContext>,
): CapabilityTool<TInput, TOutput, TContext>;
export function defineCapabilityTool<
  TInput = unknown,
  TOutput = unknown,
  TContext = unknown,
>(
  tool: CapabilityTool<TInput, TOutput, TContext>,
): CapabilityTool<TInput, TOutput, TContext>;
export function defineCapabilityTool(
  tool: AnyCapabilityTool,
): AnyCapabilityTool {
  return tool;
}

export type CapabilityBrokerOptions<TContext = unknown> = {
  context: TContext;
  defaultConcurrency?: number;
  defaultTimeoutMs?: number;
  onAudit?: (event: CapabilityAuditEvent<TContext>) => void;
};

export type CapabilityBroker = {
  call: (tool: string, input?: unknown) => Promise<unknown>;
  reference: Reference<(tool: unknown, input?: unknown) => Promise<unknown>>;
};

export class CapabilityError extends Error {
  readonly code: string;
  readonly tool: string;

  constructor(tool: string, code: string, message: string) {
    super(message);
    this.name = "CapabilityError";
    this.code = code;
    this.tool = tool;
  }
}

const now = () => performance.now();

const timeout = (tool: string, timeoutMs: number): Promise<never> =>
  new Promise((_, reject) => {
    setTimeout(() => {
      reject(
        new CapabilityError(
          tool,
          "CAPABILITY_TIMEOUT",
          `Capability "${tool}" exceeded ${timeoutMs} ms`,
        ),
      );
    }, timeoutMs);
  });

export const createCapabilityBroker = <
  TTools extends Record<string, AnyCapabilityTool<any>>,
  TContext = InferCapabilityContext<TTools[keyof TTools]>,
>(
  tools: TTools,
  options: CapabilityBrokerOptions<TContext>,
): CapabilityBrokerFor<TTools> => {
  const active = new Map<string, number>();

  const audit = (event: CapabilityAuditEvent<TContext>): void => {
    options.onAudit?.(event);
  };

  const call = async (toolName: string, input?: unknown): Promise<unknown> => {
    const tool = tools[toolName];
    if (tool === undefined) {
      const error = new CapabilityError(
        toolName,
        "CAPABILITY_NOT_FOUND",
        `Unknown capability "${toolName}"`,
      );
      audit({
        context: options.context,
        error,
        input,
        status: "rejected",
        tool: toolName,
      });
      throw error;
    }

    const limit = tool.concurrency ?? options.defaultConcurrency;
    const running = active.get(toolName) ?? 0;
    if (limit !== undefined && running >= limit) {
      const error = new CapabilityError(
        toolName,
        "CAPABILITY_CONCURRENCY_LIMIT",
        `Capability "${toolName}" exceeded concurrency limit ${limit}`,
      );
      audit({
        context: options.context,
        error,
        input,
        status: "rejected",
        tool: toolName,
      });
      throw error;
    }

    const started = now();
    active.set(toolName, running + 1);
    audit({ context: options.context, input, status: "start", tool: toolName });

    try {
      const parsedInput =
        tool.validateInput === undefined ? input : tool.validateInput(input);
      const run = Promise.resolve(tool.handler(parsedInput, options.context));
      const timeoutMs = tool.timeoutMs ?? options.defaultTimeoutMs;
      const rawOutput =
        timeoutMs === undefined
          ? await run
          : await Promise.race([run, timeout(toolName, timeoutMs)]);
      const output =
        tool.validateOutput === undefined
          ? rawOutput
          : tool.validateOutput(rawOutput);
      audit({
        context: options.context,
        durationMs: now() - started,
        input,
        output,
        status: "success",
        tool: toolName,
      });
      return output;
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error(String(caught));
      audit({
        context: options.context,
        durationMs: now() - started,
        error,
        input,
        status:
          error instanceof CapabilityError &&
          error.code === "CAPABILITY_TIMEOUT"
            ? "timeout"
            : "error",
        tool: toolName,
      });
      throw error;
    } finally {
      const next = (active.get(toolName) ?? 1) - 1;
      if (next <= 0) active.delete(toolName);
      else active.set(toolName, next);
    }
  };

  return {
    call: call as CapabilityBrokerFor<TTools>["call"],
    reference: new Reference((tool, input) => call(String(tool), input)),
  };
};
