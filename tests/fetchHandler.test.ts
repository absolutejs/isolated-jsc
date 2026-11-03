import * as jsc from "bun:jsc";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  bundleFetchHandler,
  createFetchHandler,
  createIsolate,
  FetchBodyTooLargeError,
  FetchHandlerBundleError,
  Reference,
  type Isolate,
} from "../src";

const runtimeHasLockdown =
  typeof (jsc as { lockdown?: unknown }).lockdown === "function";

/** Capture a rejection as a value (see smoke.test.ts for why not .rejects). */
const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("promise did not reject");
};

const echoApp = `
module.exports = {
  default: {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname === "/echo") {
        const body = new Uint8Array(await request.arrayBuffer());
        return new Response(body, {
          headers: { "x-method": request.method, "x-agent": request.headers.get("user-agent") ?? "" },
          status: 201,
          statusText: "Echoed",
        });
      }
      if (url.pathname === "/count") {
        ctx.state.hits = (ctx.state.hits ?? 0) + 1;
        return Response.json({ hits: ctx.state.hits });
      }
      if (url.pathname === "/env") return Response.json({ region: env.region, user: await env.lookup(7) });
      if (url.pathname === "/capability") {
        const rows = await env.database.execute("select 1", [2]);
        let reassigned = "kept";
        try { env.database.execute = () => "hijacked"; } catch { reassigned = "refused"; }
        return Response.json({ frozen: Object.isFrozen(env.database), kind: env.database.kind, reassigned, rows });
      }
      if (url.pathname === "/later") {
        ctx.waitUntil(env.record("after"));
        return new Response("sent");
      }
      if (url.pathname === "/big") return new Response("x".repeat(2048));
      if (url.pathname === "/bun") return Response.json({ bun: (0, eval)("typeof Bun") });
      if (url.pathname === "/not-a-response") return { status: 200 };
      return new Response("missing", { status: 404 });
    },
  },
};`;

let isolate: Isolate | undefined;
afterEach(async () => {
  await isolate?.dispose();
  isolate = undefined;
});

const start = async (
  source = echoApp,
  options: Parameters<typeof createFetchHandler>[2] = {},
) => {
  isolate = await createIsolate({ backend: "worker" });
  const context = await isolate.createContext();
  return createFetchHandler(context, source, options);
};

describe("createFetchHandler", () => {
  test("round-trips method, headers, a binary body, status and response headers", async () => {
    const handler = await start();
    const body = new Uint8Array([0, 1, 2, 250, 255]);
    const response = await handler.fetch(
      new Request("http://app/echo", {
        body,
        headers: { "user-agent": "probe" },
        method: "PUT",
      }),
    );
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Echoed");
    expect(response.headers.get("x-method")).toBe("PUT");
    expect(response.headers.get("x-agent")).toBe("probe");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    expect((await handler.fetch(new Request("http://app/nope"))).status).toBe(
      404,
    );
  });

  test("passes env data and Reference capabilities", async () => {
    const handler = await start(echoApp, {
      env: {
        lookup: new Reference((id: unknown) => ({
          id,
          name: `user ${String(id)}`,
        })),
        region: "nyc1",
      },
    });
    const response = await handler.fetch(new Request("http://app/env"));
    expect(await response.json()).toEqual({
      region: "nyc1",
      user: { id: 7, name: "user 7" },
    });
  });

  test("passes an object of Reference capabilities as a frozen env object", async () => {
    const calls: unknown[] = [];
    const handler = await start(echoApp, {
      env: {
        database: {
          execute: new Reference((statement: unknown, parameters: unknown) => {
            calls.push([statement, parameters]);
            return [{ ok: 1 }];
          }),
          kind: "postgres",
        },
      },
    });
    const response = await handler.fetch(new Request("http://app/capability"));
    expect(await response.json()).toEqual({
      frozen: true,
      kind: "postgres",
      reassigned: "kept",
      rows: [{ ok: 1 }],
    });
    expect(calls).toEqual([["select 1", [2]]]);
  });

  test("keeps ctx.state between requests and in a checkpoint", async () => {
    const handler = await start();
    await handler.fetch(new Request("http://app/count"));
    const second = await handler.fetch(new Request("http://app/count"));
    expect(await second.json()).toEqual({ hits: 2 });
    const checkpoint = await handler.context.checkpoint({
      include: ["state"],
    });
    const restored = await handler.context.isolate.createContext({
      checkpoint,
    });
    const again = await createFetchHandler(restored, echoApp);
    const third = await again.fetch(new Request("http://app/count"));
    expect(await third.json()).toEqual({ hits: 3 });
  });

  test("ctx.waitUntil work finishes after the response", async () => {
    const recorded: string[] = [];
    const handler = await start(echoApp, {
      env: {
        record: new Reference(async (value: unknown) => {
          await Bun.sleep(50);
          recorded.push(String(value));
        }),
      },
    });
    const response = await handler.fetch(new Request("http://app/later"));
    expect(await response.text()).toBe("sent");
    const deadline = Date.now() + 2000;
    while (recorded.length === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(recorded).toEqual(["after"]);
  });

  test("bounds request and response bodies", async () => {
    const handler = await start(echoApp, {
      maxRequestBytes: 16,
      maxResponseBytes: 1024,
    });
    const tooBig = await rejection(
      handler.fetch(
        new Request("http://app/echo", {
          body: "x".repeat(17),
          method: "POST",
        }),
      ),
    );
    expect(tooBig).toBeInstanceOf(FetchBodyTooLargeError);
    expect((tooBig as FetchBodyTooLargeError).direction).toBe("request");
    const bigResponse = await rejection(
      handler.fetch(new Request("http://app/big")),
    );
    expect(bigResponse).toBeInstanceOf(FetchBodyTooLargeError);
    expect((bigResponse as FetchBodyTooLargeError).direction).toBe("response");
    expect((bigResponse as FetchBodyTooLargeError).observedBytes).toBe(2048);
  });

  test("rejects a bundle without fetch and a handler that returns a non-Response", async () => {
    isolate = await createIsolate({ backend: "worker" });
    const missing = await rejection(
      createFetchHandler(
        await isolate.createContext(),
        "module.exports = { default: {} };",
      ),
    );
    expect(String(missing)).toContain("has no fetch(request, env, ctx)");
    const handler = await createFetchHandler(
      await isolate.createContext(),
      echoApp,
    );
    const wrong = await rejection(
      handler.fetch(new Request("http://app/not-a-response")),
    );
    expect(String(wrong)).toContain("must return a Response");
  });

  test("reports CPU and wall time per request", async () => {
    const handler = await start();
    const { metrics, response } = await handler.fetchWithMetrics(
      new Request("http://app/count"),
    );
    expect(response.status).toBe(200);
    expect(metrics.cpuSource).toBe("thread");
    expect(metrics.cpuMs).toBeGreaterThanOrEqual(0);
    expect(metrics.wallMs).toBeGreaterThanOrEqual(0);
  });

  test.skipIf(!runtimeHasLockdown)(
    "a locked-down handler cannot reach Bun",
    async () => {
      isolate = await createIsolate({
        backend: "worker",
        requireLockdown: true,
      });
      const handler = await createFetchHandler(
        await isolate.createContext(),
        echoApp,
      );
      const response = await handler.fetch(new Request("http://app/bun"));
      expect(await response.json()).toEqual({ bun: "undefined" });
    },
  );
});

describe("bundleFetchHandler", () => {
  test("bundles a TypeScript app that uses import.meta into a script the isolate runs", async () => {
    const source = await bundleFetchHandler(
      join(import.meta.dir, "fixtures/fetch-app.ts"),
    );
    expect(source).not.toContain("import.meta");
    const handler = await start(source, { env: { greeting: "hi" } });
    const response = await handler.fetch(new Request("http://app/hello"));
    expect(await response.json()).toEqual({ base: "file:", greeting: "hi" });
  });

  test("refuses Bun and Node APIs instead of bundling browser stubs, listing every import", async () => {
    const error = await rejection(
      bundleFetchHandler(
        join(import.meta.dir, "fixtures/fetch-app-host-apis.ts"),
      ),
    );
    expect(error).toBeInstanceOf(FetchHandlerBundleError);
    const { problems } = error as FetchHandlerBundleError;
    expect(problems).toHaveLength(3);
    expect(problems).toContain(
      "node:fs, imported by fetch-app-host-apis.ts, is a Bun or Node API",
    );
    expect(problems).toContain(
      "path, imported by fetch-app-host-apis.ts, is a Node built-in",
    );
    expect(problems).toContain(
      "bun, imported by fetch-app-host-apis.ts, is a Bun or Node API",
    );
  });

  test("reports why an app does not bundle", async () => {
    const error = await rejection(
      bundleFetchHandler(join(import.meta.dir, "fixtures/does-not-exist.ts")),
    );
    expect(String(error)).toContain("Could not bundle");
  });
});
