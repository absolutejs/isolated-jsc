import {
  compileTypeScriptCallable,
  createCapabilityBroker,
  createIsolate,
  defineCapabilityTool,
  type CapabilityAuditEvent,
} from "@absolutejs/isolated-jsc";

type TenantContext = {
  id: string;
  plan: "free" | "pro";
};

type OrderLookup = {
  id: string;
};

type OrderRecord = {
  id: string;
  status: string;
  totalUsd: number;
};

const tenant: TenantContext = {
  id: "tenant_acme",
  plan: "pro",
};

const orders = new Map<string, OrderRecord>([
  [
    "ord_123",
    {
      id: "ord_123",
      status: "shipped",
      totalUsd: 129,
    },
  ],
]);

const requireOrderLookup = (input: unknown): OrderLookup => {
  if (input === null || typeof input !== "object") {
    throw new Error("lookupOrder input must be an object");
  }
  const id = (input as { id?: unknown }).id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("lookupOrder input requires a string id");
  }
  return { id };
};

const audit: CapabilityAuditEvent<TenantContext>[] = [];

const broker = createCapabilityBroker(
  {
    lookupOrder: defineCapabilityTool<
      OrderLookup,
      OrderRecord | null,
      TenantContext
    >({
      concurrency: 2,
      description: "Read one order by id for the current tenant",
      input: "OrderLookup",
      output: "OrderRecord | null",
      redactAuditInput: (input) => ({ id: (input as { id?: unknown }).id }),
      redactAuditOutput: (output) => {
        if (output === null) return null;
        const order = output as OrderRecord;
        return { id: order.id, status: order.status };
      },
      risk: "read-only",
      timeoutMs: 100,
      validateInput: requireOrderLookup,
      handler: async ({ id }, context) => {
        if (context.plan === "free") {
          throw new Error("lookupOrder requires pro plan");
        }
        await Bun.sleep(2);
        return orders.get(id) ?? null;
      },
    }),
    summarize: defineCapabilityTool<string, string, TenantContext>({
      description: "Summarize caller-provided text",
      input: "string",
      output: "string",
      redactAuditInput: () => "[text redacted]",
      risk: "read-only",
      timeoutMs: 100,
      validateInput: (input) => String(input),
      handler: (text) => text.split(/\s+/).slice(0, 8).join(" "),
    }),
  },
  {
    context: tenant,
    defaultTimeoutMs: 250,
    onAudit: (event) => audit.push(event),
  },
);

const isolate = await createIsolate({
  memoryLimit: 256,
  onConsole: (level, args) => {
    console[level]("[agent]", ...args);
  },
});

try {
  const context = await isolate.createContext();
  const agent = await compileTypeScriptCallable(
    context,
    `async (
      tools: (name: string, input: unknown) => Promise<unknown>,
      orderId: string,
    ): Promise<{ order: unknown; summary: unknown }> => {
      const order = await tools("lookupOrder", { id: orderId });
      const summary = await tools(
        "summarize",
        "Customer asked for the current shipping state and total."
      );
      return { order, summary };
    }`,
  );

  const { result, metrics } = await agent.callWithMetrics(
    [broker.reference, "ord_123"],
    { timeout: 500 },
  );

  console.log(
    JSON.stringify(
      { result, metrics, manifest: broker.manifest(), audit },
      null,
      2,
    ),
  );
} finally {
  await isolate.dispose();
}
