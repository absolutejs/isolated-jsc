import { describe, expect, test } from "bun:test";

type Reply = { id: number; ok: boolean; result?: unknown; error?: string };

// Long-lived RPC client: one persistent worker, one persistent message
// listener routing replies to per-call promise resolvers. The exact shape
// used by isolated-jsc, comlink, jest-worker, and vitest's worker pool.
class WorkerClient {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  constructor(private worker: Worker) {
    worker.addEventListener("message", (e) => {
      const reply = e.data as Reply;
      const p = this.pending.get(reply.id);
      if (p === undefined) return;
      this.pending.delete(reply.id);
      if (reply.ok) p.resolve(reply.result);
      else p.reject(new Error(reply.error ?? "unknown"));
    });
  }
  call(op: string): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op });
    });
  }
}

describe("rejects.toThrow vs cross-worker postMessage", () => {
  // PASSES — try/catch sees the rejection in ~1 ms.
  test("try/catch on a failing op after successful ops", async () => {
    const w = new WorkerClient(
      new Worker(new URL("./worker.ts", import.meta.url).href),
    );
    expect(await w.call("a")).toBe("a");
    expect(await w.call("b")).toBe("b");
    let caught: unknown = null;
    try {
      await w.call("fail");
    } catch (e) {
      caught = e;
    }
    expect((caught as Error)?.message).toBe("boom");
  });

  // HANGS — `expect.rejects.toThrow` never sees the reply. Worker
  // instrumentation (add `console.error` before `postMessage`) confirms
  // the reply was posted within microseconds; the host just never wakes up.
  // Times out at the test's overall timeout (5000 ms here).
  test("await expect(p).rejects.toThrow on the same failing op", async () => {
    const w = new WorkerClient(
      new Worker(new URL("./worker.ts", import.meta.url).href),
    );
    expect(await w.call("a")).toBe("a");
    expect(await w.call("b")).toBe("b");
    await expect(w.call("fail")).rejects.toThrow("boom");
  });
});
