import { describe, expect, test } from "bun:test";
import * as jsc from "bun:jsc";
import {
  createIsolate,
  ExternalCopy,
  LockdownUnavailableError,
  MemoryLimitError,
  Reference,
  TimeoutError,
} from "../src";

/**
 * Capture the rejection of a promise as a value. We do NOT use Bun-test's
 * `await expect(p).rejects.toThrow(...)`: that matcher hangs to test timeout
 * on cross-worker postMessage replies — see UPSTREAM_ISSUES.md for the
 * tracking Bun issues (#5602 + #14670 + #19130) and the cleanup steps once
 * one of them lands.
 */
/** Patched Bun 1.4.4+absolute.2 and later provide lockdown() in bun:jsc. */
const runtimeHasLockdown =
  typeof (jsc as { lockdown?: unknown }).lockdown === "function";

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("promise did not reject");
};

describe("createIsolate", () => {
  test("compiles and runs a trivial expression", async () => {
    const isolate = await createIsolate({ memoryLimit: 128 });
    expect(isolate.backend).toBe("worker");
    const context = await isolate.createContext();
    const script = await isolate.compileScript("1 + 2");
    const result = await script.run(context);
    expect(result).toBe(3);
    await isolate.dispose();
  });

  test("contexts are independent within an isolate", async () => {
    const isolate = await createIsolate();
    const a = await isolate.createContext();
    const b = await isolate.createContext();
    await a.setGlobal("x", "from-a");
    await b.setGlobal("x", "from-b");
    const readA = await isolate.compileScript("x");
    expect(await readA.run(a)).toBe("from-a");
    expect(await readA.run(b)).toBe("from-b");
    await isolate.dispose();
  });

  test("setGlobal then read back via script", async () => {
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    await context.setGlobal("greeting", "hello");
    const script = await isolate.compileScript('greeting + " world"');
    expect(await script.run(context)).toBe("hello world");
    await isolate.dispose();
  });

  test("Reference round-trips an async host call", async () => {
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    const log: string[] = [];
    const push = new Reference((message: unknown) => {
      log.push(String(message));
      return log.length;
    });
    await context.setGlobal("push", push);
    const script = await isolate.compileScript(
      '(async () => { const n = await push("hi"); return n; })()',
    );
    const result = await script.run(context);
    expect(result).toBe(1);
    expect(log).toEqual(["hi"]);
    await isolate.dispose();
  });

  test("ExternalCopy carries arbitrary plain-object data", async () => {
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    const data = new ExternalCopy({ rows: [1, 2, 3], total: 6 });
    await context.setGlobal("data", data);
    const script = await isolate.compileScript("data.rows.length");
    expect(await script.run(context)).toBe(3);
    await isolate.dispose();
  });

  test("script errors propagate as JS Errors", async () => {
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript(
      '(() => { throw new Error("boom"); })()',
    );
    const err = (await rejection(script.run(context))) as Error;
    expect(err.message).toBe("boom");
    await isolate.dispose();
  });

  test("timeout terminates a runaway script", async () => {
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript("while (true) {}");
    const err = await rejection(script.run(context, { timeout: 100 }));
    expect(err).toBeInstanceOf(TimeoutError);
    // Isolate is dead after timeout — v1 trade-off.
    expect(isolate.isDisposed).toBe(true);
  });

  test("dispose is idempotent and pending ops reject", async () => {
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    await isolate.dispose();
    await isolate.dispose(); // second call is a no-op
    expect(isolate.isDisposed).toBe(true);
    // Subsequent ops fail clean.
    const err = await rejection(context.setGlobal("x", 1));
    expect(err).toBeInstanceOf(Error);
  });

  test("heap usage is reported in bytes", async () => {
    // Default memoryLimit is 256 MB. Assert against that ceiling — the point
    // is "the reading isn't junk", not "the cold start is small".
    const isolate = await createIsolate({ memoryLimit: 256 });
    expect(isolate.backend).toBe("worker");
    const bytes = await isolate.heapSizeBytes();
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(256 * 1024 * 1024);
    await isolate.dispose();
  });

  test("worker heap accounting excludes host and peer runtime allocation", async () => {
    const isolate = await createIsolate({ memoryLimit: 16 });
    const context = await isolate.createContext();
    await Bun.sleep(100);
    const script = await isolate.compileScript("21 * 2");
    expect(await script.run(context)).toBe(42);
    expect(await isolate.heapSizeBytes()).toBeLessThan(16 * 1024 * 1024);
    await isolate.dispose();
  });
});

describe("hostile tenant", () => {
  test("hardened sandbox: fetch / Bun / process / Worker unreachable via every path that's blockable", async () => {
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`({
      bareFetch: typeof fetch,
      bareBun: typeof Bun,
      bareProcess: typeof process,
      bareWorker: typeof Worker,
      bareWebSocket: typeof WebSocket,
      barePostMessage: typeof postMessage,
      globalThisFetch: typeof globalThis.fetch,
      globalThisBun: typeof globalThis.Bun,
      thisBun: typeof this.Bun,
      directEvalBun: typeof eval('Bun'),
    })`);
    const result = (await script.run(context)) as Record<string, string>;
    expect(result.bareFetch).toBe("undefined");
    expect(result.bareBun).toBe("undefined");
    expect(result.bareProcess).toBe("undefined");
    expect(result.bareWorker).toBe("undefined");
    expect(result.bareWebSocket).toBe("undefined");
    expect(result.barePostMessage).toBe("undefined");
    expect(result.globalThisFetch).toBe("undefined");
    expect(result.globalThisBun).toBe("undefined");
    expect(result.thisBun).toBe("undefined");
    expect(result.directEvalBun).toBe("undefined");
    await isolate.dispose();
  });

  test("hardened sandbox: safe globals (Math, JSON, Promise, URL, crypto, console, …) stay reachable", async () => {
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`({
      math: typeof Math.PI,
      json: typeof JSON.stringify({}),
      promise: typeof Promise.resolve(1).then,
      url: new URL('https://x/y').pathname,
      crypto: typeof crypto.randomUUID,
      setTimeout: typeof setTimeout,
      textEncoder: new TextEncoder().encode('a').length,
      console: typeof console.log,
    })`);
    const result = (await script.run(context)) as Record<string, unknown>;
    expect(result.math).toBe("number");
    expect(result.json).toBe("string");
    expect(result.promise).toBe("function");
    expect(result.url).toBe("/y");
    expect(result.crypto).toBe("function");
    expect(result.setTimeout).toBe("function");
    expect(result.textEncoder).toBe(1);
    expect(result.console).toBe("function");
    await isolate.dispose();
  });

  test("indirect eval, the Function constructor and import() reach host authority only without lockdown()", async () => {
    // On stock Bun these run in the worker's real global, where Bun is
    // non-configurable, and import() loads any module. Patched Bun's
    // lockdown() closes both; see SECURITY.md.
    const isolate = await createIsolate();
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`(async () => ({
      indirectEval: (0, eval)('typeof Bun'),
      functionCtor: (new Function('return typeof Bun'))(),
      shadowRealm: typeof ShadowRealm,
      importChildProcess: await import('node:child_process').then(
        (m) => typeof m.spawnSync,
        (error) => error.name + ': ' + error.message,
      ),
      importFfi: await import('bun:ffi').then(
        (m) => typeof m.dlopen,
        (error) => error.name + ': ' + error.message,
      ),
    }))()`);
    const result = (await script.run(context)) as Record<string, string>;
    if (runtimeHasLockdown) {
      const rejected =
        "TypeError: import() is disabled in this realm by lockdown()";
      expect(isolate.lockedDown).toBe(true);
      expect(result).toEqual({
        indirectEval: "undefined",
        functionCtor: "undefined",
        shadowRealm: "undefined",
        importChildProcess: rejected,
        importFfi: rejected,
      });
    } else {
      expect(isolate.lockedDown).toBe(false);
      expect(result.indirectEval).toBe("object");
      expect(result.functionCtor).toBe("object");
      expect(result.importChildProcess).toBe("function");
    }
    await isolate.dispose();
  });

  test("requireLockdown refuses an isolate the runtime cannot lock down", async () => {
    if (runtimeHasLockdown) {
      const isolate = await createIsolate({ requireLockdown: true });
      expect(isolate.lockedDown).toBe(true);
      await isolate.dispose();
    } else {
      const error = await rejection(createIsolate({ requireLockdown: true }));
      expect(error).toBeInstanceOf(LockdownUnavailableError);
      expect((error as LockdownUnavailableError).reason).toBe("runtime");
    }
    const unhardened = await rejection(
      createIsolate({ requireLockdown: true, unsafelyExposeGlobals: ["Bun"] }),
    );
    expect(unhardened).toBeInstanceOf(LockdownUnavailableError);
    expect((unhardened as LockdownUnavailableError).reason).toBe("unhardened");
  });

  test("lockdown() leaves the sandbox's host references and limits working", async () => {
    const isolate = await createIsolate({ memoryLimit: 64 });
    const context = await isolate.createContext();
    await context.setGlobal(
      "double",
      new Reference((n: unknown) => Number(n) * 2),
    );
    const script = await isolate.compileScript(`(async () => ({
      viaHost: await double(21),
      response: await new Response('ok').text(),
    }))()`);
    expect(await script.run(context)).toEqual({ viaHost: 42, response: "ok" });
    const loop = await isolate.compileScript("for (;;) {}");
    expect(await rejection(loop.run(context, { timeout: 100 }))).toBeInstanceOf(
      TimeoutError,
    );
  });

  test("harden: false restores v0.0.1 behaviour (fetch / Bun / process reachable)", async () => {
    const isolate = await createIsolate({ harden: false });
    const context = await isolate.createContext();
    const script = await isolate.compileScript(
      `typeof fetch + ',' + typeof Bun + ',' + typeof process`,
    );
    const result = await script.run(context);
    expect(result).toBe("function,object,object");
    await isolate.dispose();
  });

  test("unsafelyExposeGlobals lets specific capabilities through while keeping the rest sealed", async () => {
    const isolate = await createIsolate({
      unsafelyExposeGlobals: ["fetch"],
    });
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`({
      fetch: typeof fetch,
      Bun: typeof Bun,
      process: typeof process,
    })`);
    const result = (await script.run(context)) as Record<string, string>;
    expect(result.fetch).toBe("function");
    expect(result.Bun).toBe("undefined");
    expect(result.process).toBe("undefined");
    await isolate.dispose();
  });

  test("sandboxed code cannot print to the process's stdout, with or without capture", async () => {
    const fixture = new URL("./fixtures/console-leak.ts", import.meta.url)
      .pathname;
    for (const mode of ["drop", "capture"]) {
      const child = Bun.spawn([process.execPath, fixture, mode], {
        stderr: "pipe",
        stdout: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      await child.exited;
      expect(stderr).not.toContain("leak");
      const lines = stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      const captured = JSON.parse(lines[0]!.replace(/^HOST /, "")) as string[];
      expect(captured).toEqual(
        mode === "capture"
          ? [
              "log:leak-log",
              "log:leak-info",
              "log:leak-debug",
              "warn:leak-warn",
              "error:leak-error",
            ]
          : [],
      );
    }
  }, 20_000);

  test("memory limit terminates an isolate that allocates a runaway buffer", async () => {
    // Allocate heap-resident JS objects (not Uint8Arrays — those go
    // through bmalloc on JSC and don't count toward the GC heap that
    // `bun:jsc.heapSize()` reports). 50k × ~10 KB strings ≈
    // 500 MB of heap, well past the 128 MB cap.
    const isolate = await createIsolate({ memoryLimit: 128 });
    const context = await isolate.createContext();
    const script = await isolate.compileScript(`
			(async () => {
				const buckets = [];
				for (let i = 0; i < 50000; i++) {
					buckets.push({ k: i, v: 'x'.repeat(10000) });
					if (i % 200 === 0) await new Promise(r => setTimeout(r, 1));
				}
				return buckets.length;
			})()
		`);
    const err = await rejection(script.run(context, { timeout: 5000 }));
    expect(err).toBeInstanceOf(MemoryLimitError);
    expect(isolate.isDisposed).toBe(true);
  }, 10_000);

  test("memory limit still stops a timer that allocates after the isolate went idle", async () => {
    // The heap check slows to once a second when idle; a tenant timer must
    // pull it back to the busy rate rather than allocate for a full second.
    const isolate = await createIsolate({ memoryLimit: 128 });
    const context = await isolate.createContext();
    await Bun.sleep(1500);
    const script = await isolate.compileScript(`
			globalThis.buckets = [];
			setTimeout(function grow() {
				for (let i = 0; i < 200; i++) buckets.push({ v: 'x'.repeat(10000) });
				setTimeout(grow, 1);
			}, 1);
			0
		`);
    await script.run(context, { timeout: 1000 });
    const started = Date.now();
    while (!isolate.isDisposed && Date.now() - started < 5000)
      await Bun.sleep(20);
    expect(isolate.isDisposed).toBe(true);
  }, 10_000);
});
