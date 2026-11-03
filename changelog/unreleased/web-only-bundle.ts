import type { Change } from "@absolutejs/changelog";

export const change: Change = {
  detail:
    "Bun's browser target quietly replaces `fs`, `path` and other Node built-ins with stubs, so an app that used them bundled cleanly and failed at runtime inside the isolate. `bundleFetchHandler` now refuses them up front: any `node:` or `bun:` import, the `bun` module, a bare Node built-in with no installed npm package of that name (a real `events` or `buffer` package is still fine), and native `.node` addons. It reports every such import at once, with the file that made it, as `FetchHandlerBundleError` (`problems: string[]`). An Elysia 2 app still bundles and runs unchanged.",
  kind: "changed",
  summary:
    "bundleFetchHandler refuses Bun and Node APIs instead of bundling browser stubs",
  symbols: ["bundleFetchHandler", "FetchHandlerBundleError"],
};
