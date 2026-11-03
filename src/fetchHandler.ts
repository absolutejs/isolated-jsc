/**
 * Fetch-handler bridge: run a Web-standard `export default { fetch }` app in
 * an isolate and call it with host `Request`s.
 *
 * The app arrives as one CommonJS bundle (see {@link bundleFetchHandler}).
 * Each call copies the request (method, URL, headers, body bytes) into the
 * isolate, rebuilds a `Request` there, awaits
 * `handler.fetch(request, env, ctx)`, and copies the `Response` back.
 * Bodies are buffered and bounded in both directions.
 */
import { builtinModules } from "node:module";
import path from "node:path";
import type { Callable, Context, RunMetrics } from "./types";

/** Request and response bodies are capped at 1 MiB unless set otherwise. */
export const DEFAULT_FETCH_BODY_LIMIT_BYTES = 1024 * 1024;

const STATE_GLOBAL = "state";
const MODULE_GLOBAL = "__isolatedFetchApp";
const ENV_GLOBAL_PREFIX = "__isolatedFetchEnv";
const RESPONSE_TOO_LARGE = "FETCH_RESPONSE_TOO_LARGE";

export type FetchHandlerOptions = {
  /**
   * What the app receives as `env`. Each value is copied in as
   * {@link Context.setGlobal} would: structured-cloneable data, an
   * {@link ExternalCopy}, or a {@link Reference} (which becomes an async
   * function calling back to the host). The object is frozen.
   */
  env?: Record<string, unknown>;
  /** Largest request body accepted, in bytes. Default 1 MiB. */
  maxRequestBytes?: number;
  /** Largest response body returned, in bytes. Default 1 MiB. */
  maxResponseBytes?: number;
  /** Per-request timeout (ms). Defaults to the isolate's run timeout. */
  timeout?: number;
};

export type FetchCallOptions = {
  /** Overrides {@link FetchHandlerOptions.timeout} for this request. */
  timeout?: number;
};

export type FetchHandler = {
  readonly context: Context;
  /** Send a request to the app and return its response. */
  fetch: (request: Request, options?: FetchCallOptions) => Promise<Response>;
  /** Same as {@link FetchHandler.fetch}, with the request's run metrics. */
  fetchWithMetrics: (
    request: Request,
    options?: FetchCallOptions,
  ) => Promise<{ response: Response; metrics: RunMetrics }>;
  /** Release the compiled handler. The context stays usable. Idempotent. */
  dispose: () => Promise<void>;
};

/** A request or response body exceeded the handler's byte limit. */
export class FetchBodyTooLargeError extends Error {
  readonly direction: "request" | "response";
  readonly limitBytes: number;
  readonly observedBytes: number;
  constructor(
    direction: "request" | "response",
    limitBytes: number,
    observedBytes: number,
  ) {
    super(
      `The ${direction} body (${observedBytes} bytes) exceeded the ${limitBytes} byte limit`,
    );
    this.name = "FetchBodyTooLargeError";
    this.direction = direction;
    this.limitBytes = limitBytes;
    this.observedBytes = observedBytes;
  }
}

type WireResponse = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Uint8Array | null;
};

const loaderSource = (source: string, envKeys: string[]): string => {
  const envEntries = envKeys
    .map((key, index) => `${JSON.stringify(key)}: ${ENV_GLOBAL_PREFIX}${index}`)
    .join(", ");
  return `this.${MODULE_GLOBAL} = (() => {
  if (typeof Request !== "function" || typeof Response !== "function") {
    throw new TypeError("fetch handlers need Request and Response in the isolate; use the Worker backend");
  }
  const module = { exports: {} };
  (function (module, exports) {
${source}
  })(module, module.exports);
  const exported = module.exports;
  const handler = exported !== null && typeof exported === "object" && "default" in exported ? exported.default : exported;
  if (handler === null || handler === undefined || typeof handler.fetch !== "function") {
    throw new TypeError("the bundle's default export has no fetch(request, env, ctx) method");
  }
  return { env: Object.freeze({ ${envEntries} }), handler };
})();
0;`;
};

const handlerSource = `async (method, url, headers, body, maxResponseBytes) => {
  const { env, handler } = ${MODULE_GLOBAL};
  const init = { headers, method };
  if (body !== null) init.body = body;
  const request = new Request(url, init);
  if (this.${STATE_GLOBAL} === undefined || this.${STATE_GLOBAL} === null) this.${STATE_GLOBAL} = {};
  const ctx = Object.freeze({
    state: this.${STATE_GLOBAL},
    waitUntil: (promise) => {
      Promise.resolve(promise).catch((error) => console.error("waitUntil promise rejected:", error));
    },
  });
  const response = await handler.fetch(request, env, ctx);
  if (!(response instanceof Response)) {
    throw new TypeError("fetch handler must return a Response, got " + (response === null ? "null" : typeof response));
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxResponseBytes) {
    const error = new RangeError("response body too large");
    error.code = "${RESPONSE_TOO_LARGE}";
    error.observedBytes = bytes.byteLength;
    throw error;
  }
  return {
    body: bytes.byteLength === 0 ? null : bytes,
    headers: [...response.headers],
    status: response.status,
    statusText: response.statusText,
  };
}`;

const responseOf = (wire: WireResponse): Response =>
  new Response(wire.body, {
    headers: wire.headers,
    status: wire.status,
    statusText: wire.statusText,
  });

/**
 * Load a fetch-handler app into `context` and return a host-side handler.
 *
 * `source` is a CommonJS bundle whose default export (or `module.exports`
 * itself) has `fetch(request, env, ctx)`. `ctx.state` is an object kept on the
 * context between requests, so `context.checkpoint({ include: ["state"] })`
 * captures it and a context restored from that checkpoint sees it again.
 * `ctx.waitUntil(promise)` lets work finish after the response; the isolate
 * keeps running it.
 *
 * Needs the Worker backend: the FFI backend's bare JavaScriptCore context
 * has no `Request` or `Response`.
 */
export const createFetchHandler = async (
  context: Context,
  source: string,
  options: FetchHandlerOptions = {},
): Promise<FetchHandler> => {
  const maxRequestBytes =
    options.maxRequestBytes ?? DEFAULT_FETCH_BODY_LIMIT_BYTES;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_FETCH_BODY_LIMIT_BYTES;
  const env = Object.entries(options.env ?? {});
  for (const [index, [, value]] of env.entries()) {
    await context.setGlobal(`${ENV_GLOBAL_PREFIX}${index}`, value);
  }
  const loader = await context.isolate.compileScript(
    loaderSource(
      source,
      env.map(([key]) => key),
    ),
  );
  await loader.run(context, { timeout: options.timeout });
  await loader.dispose();
  const callable: Callable = await context.compileCallable(handlerSource);

  const send = async (request: Request, callOptions: FetchCallOptions) => {
    const body =
      request.body === null
        ? null
        : new Uint8Array(await request.arrayBuffer());
    if (body !== null && body.byteLength > maxRequestBytes) {
      throw new FetchBodyTooLargeError(
        "request",
        maxRequestBytes,
        body.byteLength,
      );
    }
    try {
      const { metrics, result } = await callable.callWithMetrics(
        [
          request.method,
          request.url,
          [...request.headers],
          body,
          maxResponseBytes,
        ],
        { timeout: callOptions.timeout ?? options.timeout },
      );
      return { metrics, response: responseOf(result as WireResponse) };
    } catch (error) {
      const observed = (error as { code?: unknown; observedBytes?: unknown })
        .observedBytes;
      if (
        (error as { code?: unknown }).code === RESPONSE_TOO_LARGE &&
        typeof observed === "number"
      ) {
        throw new FetchBodyTooLargeError(
          "response",
          maxResponseBytes,
          observed,
        );
      }
      throw error;
    }
  };

  return {
    context,
    dispose: () => callable.dispose(),
    async fetch(request, callOptions = {}) {
      return (await send(request, callOptions)).response;
    },
    fetchWithMetrics: (request, callOptions = {}) => send(request, callOptions),
  };
};

export type BundleFetchHandlerOptions = {
  /** Minify the bundle. Default `true`. */
  minify?: boolean;
};

/**
 * The app imports something an isolate cannot provide: a Bun or Node API, or
 * a native addon. `problems` lists each import and the file that made it.
 */
export class FetchHandlerBundleError extends Error {
  readonly problems: string[];
  constructor(entrypoint: string, problems: string[]) {
    super(
      `${entrypoint} cannot run in an isolate, which provides Web APIs only:\n${problems
        .map((problem) => `  - ${problem}`)
        .join("\n")}`,
    );
    this.name = "FetchHandlerBundleError";
    this.problems = problems;
  }
}

const REJECTED_NAMESPACE = "isolate-rejected";
const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nodeBuiltins = builtinModules.filter(
  (name) => !name.startsWith("_") && !name.includes(":"),
);
const BUILTIN_SPECIFIER = new RegExp(
  `^(?:${nodeBuiltins.map(escapeRegExp).join("|")})(?:/.*)?$`,
);

/** A bare builtin name (`events`, `buffer`) is fine when the app installed
 * an npm package by that name: that is real code, not Bun's browser stub. */
const installedPackage = (specifier: string, importer: string) => {
  const name = specifier.split("/")[0] ?? specifier;
  try {
    return path.isAbsolute(
      Bun.resolveSync(`${name}/package.json`, path.dirname(importer)),
    );
  } catch {
    return false;
  }
};

/**
 * Bundle a fetch-handler app for {@link createFetchHandler}: one CommonJS
 * file with every dependency inlined, built for Web APIs only. `import.meta`
 * is defined away (`import.meta.url` becomes `file:///app/index.js`), since
 * the bundle runs as a script, not a module.
 *
 * Bun's browser target would quietly replace `fs`, `path` and other Node
 * built-ins with stubs that fail at runtime, so the bundle refuses them up
 * front: any `node:` or `bun:` import, the `bun` module, a bare Node
 * built-in with no installed package of that name, and native `.node`
 * addons. It reports every such import at once
 * ({@link FetchHandlerBundleError}). Bundling can run the app's macros: do it
 * where you would run the app's own build, never in a trusted process.
 */
export const bundleFetchHandler = async (
  entrypoint: string,
  options: BundleFetchHandlerOptions = {},
): Promise<string> => {
  const problems = new Set<string>();
  const relative = (file: string) =>
    path.relative(path.dirname(path.resolve(entrypoint)), file) || file;
  const reject = (problem: string) => {
    problems.add(problem);
    return { namespace: REJECTED_NAMESPACE, path: problem };
  };
  const build = await Bun.build({
    define: {
      "import.meta": "{}",
      "import.meta.url": '"file:///app/index.js"',
    },
    entrypoints: [entrypoint],
    format: "cjs",
    minify: options.minify ?? true,
    plugins: [
      {
        name: "isolate-web-apis-only",
        setup(builder) {
          builder.onResolve({ filter: /^(?:node:|bun:|bun$)/ }, (args) =>
            reject(
              `${args.path}, imported by ${relative(args.importer)}, is a Bun or Node API`,
            ),
          );
          builder.onResolve({ filter: BUILTIN_SPECIFIER }, (args) =>
            installedPackage(args.path, args.importer)
              ? undefined
              : reject(
                  `${args.path}, imported by ${relative(args.importer)}, is a Node built-in`,
                ),
          );
          builder.onLoad({ filter: /\.node$/ }, (args) => {
            problems.add(`${relative(args.path)} is a native addon`);
            return { contents: "", loader: "js" };
          });
          builder.onLoad(
            { filter: /.*/, namespace: REJECTED_NAMESPACE },
            () => ({ contents: "", loader: "js" }),
          );
        },
      },
    ],
    target: "browser",
    throw: false,
  });
  if (problems.size > 0)
    throw new FetchHandlerBundleError(entrypoint, [...problems]);
  const [output] = build.outputs;
  if (!build.success || output === undefined) {
    const messages = build.logs.map((log) => String(log.message ?? log));
    throw new Error(
      `Could not bundle ${entrypoint} as a fetch handler:\n${messages.join("\n")}`,
    );
  }
  return output.text();
};
