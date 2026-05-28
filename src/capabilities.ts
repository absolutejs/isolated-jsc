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

export type CapabilityAuditBufferOptions = {
  /**
   * Maximum audit events retained in memory. Extra events are dropped and
   * reported through `dropped` / `truncated` and `receiptOptions()`.
   */
  maxEvents?: number;
};

export type CapabilityAuditBufferSnapshot<TContext = unknown> = {
  dropped: number;
  events: CapabilityAuditEvent<TContext>[];
  truncated: boolean;
};

export type CapabilityAuditBuffer<TContext = unknown> = {
  readonly dropped: number;
  readonly events: readonly CapabilityAuditEvent<TContext>[];
  readonly truncated: boolean;
  clear: () => void;
  onAudit: (event: CapabilityAuditEvent<TContext>) => void;
  receiptOptions: () => {
    capabilityEvents: readonly CapabilityAuditEvent<TContext>[];
    capabilityEventsDropped: () => number;
    capabilityEventsTruncated: () => boolean;
  };
  snapshot: () => CapabilityAuditBufferSnapshot<TContext>;
};

export type CapabilityValidator<T> = (value: unknown) => T;
export type CapabilityAuditRedactor<TContext = unknown> = (
  value: unknown,
  context: TContext,
  tool: string,
) => unknown;

export type CapabilityRisk =
  | "read-only"
  | "read-write"
  | "network"
  | "filesystem"
  | "exec"
  | "unknown";

export type CapabilitySchemaDescriptor =
  | string
  | {
      description?: string;
      name?: string;
    };

export type CapabilityManifestEntry = {
  concurrency?: number;
  description?: string;
  hasInputValidator: boolean;
  hasOutputValidator: boolean;
  input?: CapabilitySchemaDescriptor;
  name: string;
  output?: CapabilitySchemaDescriptor;
  redactsInput?: boolean;
  redactsOutput?: boolean;
  risk: CapabilityRisk;
  timeoutMs?: number;
};

export type CapabilityTool<
  TInput = unknown,
  TOutput = unknown,
  TContext = unknown,
> = {
  concurrency?: number;
  description?: string;
  handler: (input: TInput, context: TContext) => TOutput | Promise<TOutput>;
  input?: CapabilitySchemaDescriptor;
  output?: CapabilitySchemaDescriptor;
  redactAuditInput?: CapabilityAuditRedactor<TContext>;
  redactAuditOutput?: CapabilityAuditRedactor<TContext>;
  risk?: CapabilityRisk;
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
  manifest: () => CapabilityManifestEntry[];
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
  redactAuditInput?: CapabilityAuditRedactor<TContext>;
  redactAuditOutput?: CapabilityAuditRedactor<TContext>;
};

export type CapabilityBroker = {
  call: (tool: string, input?: unknown) => Promise<unknown>;
  manifest: () => CapabilityManifestEntry[];
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
const REDACTION_FAILED = "[audit redaction failed]";

export const createCapabilityAuditBuffer = <TContext = unknown>(
  options: CapabilityAuditBufferOptions = {},
): CapabilityAuditBuffer<TContext> => {
  const configuredMax = Math.floor(options.maxEvents ?? 100);
  const maxEvents =
    Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 0;
  const events: CapabilityAuditEvent<TContext>[] = [];
  let dropped = 0;

  const snapshot = (): CapabilityAuditBufferSnapshot<TContext> => ({
    dropped,
    events: [...events],
    truncated: dropped > 0,
  });

  return {
    get dropped() {
      return dropped;
    },
    get events() {
      return events;
    },
    get truncated() {
      return dropped > 0;
    },
    clear: () => {
      events.length = 0;
      dropped = 0;
    },
    onAudit: (event) => {
      if (events.length >= maxEvents) {
        dropped += 1;
        return;
      }
      events.push(event);
    },
    receiptOptions: () => ({
      capabilityEvents: events,
      capabilityEventsDropped: () => dropped,
      capabilityEventsTruncated: () => dropped > 0,
    }),
    snapshot,
  };
};

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
  const redact = (
    redactor: CapabilityAuditRedactor<TContext> | undefined,
    value: unknown,
    toolName: string,
  ): unknown => {
    if (redactor === undefined) return value;
    try {
      return redactor(value, options.context, toolName);
    } catch {
      return REDACTION_FAILED;
    }
  };

  const auditInput = (
    toolName: string,
    tool?: AnyCapabilityTool<TContext>,
    input?: unknown,
  ): unknown =>
    redact(tool?.redactAuditInput ?? options.redactAuditInput, input, toolName);

  const auditOutput = (
    toolName: string,
    tool: AnyCapabilityTool<TContext>,
    output: unknown,
  ): unknown =>
    redact(
      tool.redactAuditOutput ?? options.redactAuditOutput,
      output,
      toolName,
    );

  const manifest = (): CapabilityManifestEntry[] =>
    Object.entries(tools).map(([name, tool]) => {
      const entry: CapabilityManifestEntry = {
        hasInputValidator: tool.validateInput !== undefined,
        hasOutputValidator: tool.validateOutput !== undefined,
        name,
        redactsInput:
          tool.redactAuditInput !== undefined ||
          options.redactAuditInput !== undefined,
        redactsOutput:
          tool.redactAuditOutput !== undefined ||
          options.redactAuditOutput !== undefined,
        risk: tool.risk ?? "unknown",
      };
      if (tool.concurrency !== undefined) entry.concurrency = tool.concurrency;
      if (tool.description !== undefined) entry.description = tool.description;
      if (tool.input !== undefined) entry.input = tool.input;
      if (tool.output !== undefined) entry.output = tool.output;
      if (tool.timeoutMs !== undefined) entry.timeoutMs = tool.timeoutMs;
      return entry;
    });

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
        input: auditInput(toolName, undefined, input),
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
        input: auditInput(toolName, tool, input),
        status: "rejected",
        tool: toolName,
      });
      throw error;
    }

    const started = now();
    const redactedInput = auditInput(toolName, tool, input);
    active.set(toolName, running + 1);
    audit({
      context: options.context,
      input: redactedInput,
      status: "start",
      tool: toolName,
    });

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
        input: redactedInput,
        output: auditOutput(toolName, tool, output),
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
        input: redactedInput,
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
    manifest,
    reference: new Reference((tool, input) => call(String(tool), input)),
  };
};
