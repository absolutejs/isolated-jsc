import {
  compileTypeScriptCallable,
  createCapabilityAuditBuffer,
  createCapabilityBroker,
  createIsolate,
  defineCapabilityTool,
} from "@absolutejs/isolated-jsc";

type TenantContext = {
  id: string;
  plan: "free" | "pro";
};

type OrderLookup = {
  id: string;
};

type OrderRecord = {
  cardLast4: string;
  id: string;
  customerEmail: string;
  status: string;
  totalUsd: number;
};

type ChargeInput = {
  cardToken: string;
  orderId: string;
};

type ChargeResult = {
  authorizationId: string;
  cardLast4: string;
  chargedUsd: number;
  processorTraceId: string;
};

const tenant: TenantContext = {
  id: "tenant_acme",
  plan: "pro",
};

const orders = new Map<string, OrderRecord>([
  [
    "ord_123",
    {
      cardLast4: "4242",
      customerEmail: "ada@example.com",
      id: "ord_123",
      status: "shipped",
      totalUsd: 129,
    },
  ],
]);

const redactEmail = (email: string): string => {
  const [name, domain] = email.split("@");
  if (name === undefined || domain === undefined) return "[email redacted]";
  return `${name.slice(0, 2)}***@${domain}`;
};

const redactOrder = (order: OrderRecord | null): unknown => {
  if (order === null) return null;
  return {
    cardLast4: order.cardLast4,
    customerEmail: redactEmail(order.customerEmail),
    id: order.id,
    status: order.status,
  };
};

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

const requireChargeInput = (input: unknown): ChargeInput => {
  if (input === null || typeof input !== "object") {
    throw new Error("chargeCard input must be an object");
  }
  const { cardToken, orderId } = input as {
    cardToken?: unknown;
    orderId?: unknown;
  };
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new Error("chargeCard input requires a string orderId");
  }
  if (typeof cardToken !== "string" || !cardToken.startsWith("tok_")) {
    throw new Error("chargeCard input requires an opaque card token");
  }
  return { cardToken, orderId };
};

const audit = createCapabilityAuditBuffer<TenantContext>({ maxEvents: 100 });

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
      redactAuditOutput: (output) => redactOrder(output as OrderRecord | null),
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
    chargeCard: defineCapabilityTool<ChargeInput, ChargeResult, TenantContext>({
      description: "Charge the saved card token for one tenant order",
      input: "ChargeInput",
      maxOutputBytes: 1_024,
      output: "ChargeResult",
      redactAuditInput: (input) => ({
        cardToken: "[token redacted]",
        orderId: (input as { orderId?: unknown }).orderId,
      }),
      redactAuditOutput: (output) => {
        const charge = output as ChargeResult;
        return {
          authorizationId: charge.authorizationId,
          cardLast4: charge.cardLast4,
          chargedUsd: charge.chargedUsd,
          processorTraceId: "[trace redacted]",
        };
      },
      risk: "write",
      timeoutMs: 100,
      validateInput: requireChargeInput,
      handler: async ({ cardToken, orderId }) => {
        const order = orders.get(orderId);
        if (order === undefined) {
          throw new Error("cannot charge an unknown order");
        }
        await Bun.sleep(2);
        return {
          authorizationId: `auth_${orderId}`,
          cardLast4: cardToken.slice(-4),
          chargedUsd: order.totalUsd,
          processorTraceId: `trace_${crypto.randomUUID()}`,
        };
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
    onAudit: audit.onAudit,
    redactAuditInput: () => "[input redacted by default]",
    redactAuditOutput: () => "[output redacted by default]",
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
    ): Promise<{ charge: unknown; order: unknown; summary: unknown }> => {
      const order = await tools("lookupOrder", { id: orderId });
      const charge = await tools("chargeCard", {
        cardToken: "tok_live_customer_4242",
        orderId,
      });
      const summary = await tools(
        "summarize",
        "Customer asked for the current shipping state and total."
      );
      return { charge, order, summary };
    }`,
  );

  const { result, metrics } = await agent.callWithMetrics(
    [broker.reference, "ord_123"],
    { timeout: 500 },
  );

  console.log(
    JSON.stringify(
      { result, metrics, manifest: broker.manifest(), audit: audit.snapshot() },
      null,
      2,
    ),
  );
} finally {
  await isolate.dispose();
}
