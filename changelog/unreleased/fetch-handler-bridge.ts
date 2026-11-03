import type { Change } from "@absolutejs/changelog";

export const change: Change = {
  detail:
    '`createFetchHandler(context, source, options)` loads a Web-standard app (a CommonJS bundle whose default export has `fetch(request, env, ctx)`) into a Worker-backend context and returns a host-side handler: `handler.fetch(request)` copies the request in, rebuilds a `Request` inside the isolate, awaits the app, and returns a host `Response`. `env` takes data and `Reference` capabilities; `ctx.state` persists on the context between requests and is captured by `context.checkpoint({ include: ["state"] })`; `ctx.waitUntil` lets work finish after the response. Bodies are buffered and capped at 1 MiB each way by default (`maxRequestBytes`, `maxResponseBytes`), and `FetchBodyTooLargeError` reports which side overflowed. `handler.fetchWithMetrics` adds the request\'s run metrics. `bundleFetchHandler(entrypoint)` builds that bundle with `Bun.build`, every dependency inlined, Web APIs only, and `import.meta` defined away. An Elysia 2 app runs through it unchanged.',
  kind: "added",
  summary:
    "createFetchHandler and bundleFetchHandler: run fetch(request, env, ctx) apps in an isolate",
  symbols: [
    "createFetchHandler",
    "bundleFetchHandler",
    "FetchBodyTooLargeError",
    "DEFAULT_FETCH_BODY_LIMIT_BYTES",
    "FetchHandler",
    "FetchHandlerOptions",
    "FetchCallOptions",
    "BundleFetchHandlerOptions",
  ],
};
