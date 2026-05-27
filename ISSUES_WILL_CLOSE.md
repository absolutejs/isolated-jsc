# Issues this library addresses

Tracking the upstream / community pain points `@absolutejs/isolated-jsc` is
built to address. When we ship, mention this library on each one so the people
who filed them can find it.

## Bun core — open issues with no committed timeline

These are the gaps in Bun's runtime that `@absolutejs/isolated-jsc` fills.

### [oven-sh/bun#6617](https://github.com/oven-sh/bun/issues/6617) — Support sandboxing permissions

- Filed: **2026-01-09**
- Status: **open**, no committed timeline
- Label: `enhancement`
- What they want: a way to restrict what executed JS can do (filesystem, network, etc).
- What we ship: per-isolate heap separation + per-isolate global scope + opt-in capability passing via `Reference`. No filesystem / network access unless host explicitly grants it.

### [oven-sh/bun#23653](https://github.com/oven-sh/bun/issues/23653) — Package isolation on a Next.js app: `Can't resolve './out/isolated_vm'`

- Filed: **2025-12-04**
- Status: **open**
- Labels: `bug`, `bun install`
- What they hit: `isolated-vm` is V8-specific (V8's `HasCustomHostObject` symbol); Bun uses JavaScriptCore, so the native binding fails to load even after install succeeds. Confirmed by us — we reproduced this exact symbol error on both `isolated-vm@5.0.4` and `^6.1.2` against Bun 1.3.14.
- What we ship: a JSC-native sandbox with an `isolated-vm`-shaped API surface (`Isolate`, `Context`, `Script`, `Reference`, `ExternalCopy`), so users porting from Node + isolated-vm get familiar ergonomics.

### [oven-sh/bun#25929](https://github.com/oven-sh/bun/issues/25929) — Bun as a secure sandbox runtime for AI agent code execution

- Filed: **2026-04-20**
- Status: **open**
- What they want: a Bun-native way to run untrusted AI-generated code with hard resource limits + heap isolation. The single largest growing use case for runtime sandboxing in 2026.
- What we ship: exactly this. The Worker-backed v1 already serves trusted-tenant cases; the libJSC-FFI v2 (future) will harden it for fully adversarial AI-generated code.

## Bugs we hit during v0 development (worth filing on Bun)

We hit these building v0; each forced a workaround we should remove once Bun
fixes the underlying issue.

### Bun 1.3.14 — `bun test` + `await expect(promise).rejects.toThrow(...)` starves cross-worker message delivery

- Reproduced: 2026-05-26 on Bun 1.3.14, JSC build.
- Symptom: when a test uses `await expect(promise).rejects.toThrow(X)` and
  the promise is one that resolves via a cross-worker `postMessage` reply,
  the host's worker message queue stops flushing while the await is parked.
  The worker logs show `postMessage` returns successfully; the host never
  receives the message until either (a) the test's overall timer fires
  (terminating the worker — too late) or (b) we replace the matcher.
- Reduced repro: ~30 lines, see `tests/repro/bun-rejects-toThrow.txt` (TODO
  — extract from our `tests/smoke.test.ts` history).
- Our workaround: a `rejection(promise)` helper that uses plain
  `try`/`catch` instead. Works in 100% of cases the matcher silently hangs.
- Not reproducible: outside `bun test` (standalone Bun scripts deliver the
  same messages in ~1 ms). Specific to the test-runner host loop's
  scheduling decisions while parked on the matcher.

### Bun 1.3.14 — eval-throw inside a worker silently breaks the outgoing message channel under some host wait patterns

- Reproduced: 2026-05-26 on Bun 1.3.14.
- Symptom: if user code passed to `new Function(...)` throws _through an
  `eval()`_ and the host is parked on `setTimeout(timeoutMs)` (single long
  timer), the worker's subsequent outgoing `postMessage`s never arrive.
- Our workaround: in the compiled wrapper, catch the user-script throw
  inside the eval frame and return a `{ __isolatedJscThrow: error }`
  sentinel; never let the throw cross the eval boundary inside the worker.
  The host's run loop already polls for completion in short intervals (the
  same code path as the `expect.rejects` workaround above) so this combined
  with the sentinel keeps the channel healthy.

## Related Bun bugs we don't fix but should be aware of

These are sandbox-adjacent issues where the failure is in Bun core, not in user
code. We can't fix them from a library — but they're context for anyone landing
on this repo expecting full sandbox parity with isolated-vm.

- [oven-sh/bun#24069](https://github.com/oven-sh/bun/issues/24069) — Crash through uncaught exception in a JS VM (Worker, runtime crash class)
- [oven-sh/bun#15661](https://github.com/oven-sh/bun/issues/15661) — Cannot run Bun within macOS sandbox (different layer — OS-level sandbox + Bun)
- [oven-sh/bun#28220](https://github.com/oven-sh/bun/issues/28220) — `bun run` fails with `CouldntReadCurrentDirectory` when ancestor dirs aren't readable (sandbox-adjacent)

## When we ship

- Comment on #6617, #23653, #25929 with a link to the v0.0.1 release + a one-line
  description of how this library addresses the request.
- Open a separate Bun issue _thanking_ the team and offering to upstream the
  JSC bindings once they stabilize, in case they want to add `bun:isolate`
  natively.
