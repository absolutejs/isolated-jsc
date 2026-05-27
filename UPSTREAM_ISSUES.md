# Upstream issues blocking us

Bugs in dependencies (Bun, mostly) that this project has working
**workarounds** for. Each entry has:

1. The upstream issue/PR link(s) that track the bug.
2. Where in _this_ codebase the workaround lives.
3. What to do here once the upstream fix lands.

If you're touching one of these workarounds, check whether the upstream
issue has been closed first — the workaround may already be deletable.

---

## Bun: `await expect(promise).rejects.toThrow(...)` hangs to timeout

**Symptom we hit:** any `bun test` using `await expect(p).rejects.toThrow(X)`
where `p` resolves/rejects via cross-`Worker` `postMessage` _appears_ to
never receive the reply — the test sits idle until its test timeout fires,
even though instrumentation shows the worker's `postMessage` was called
milliseconds after the test started. Same code runs in ~1 ms outside
`bun test`, or inside `bun test` if you replace the matcher with plain
`try` / `catch`.

This isn't actually a Worker bug — it's the matcher itself failing to
drive the event loop while parked. The PostgreSQL and Bun-shell flavours
linked below have the same root cause.

**Upstream:**

- **[oven-sh/bun#31462](https://github.com/oven-sh/bun/issues/31462)** — "`bun:test`: `await expect(promise).rejects.toThrow()` hangs to timeout when promise resolves via cross-Worker postMessage" — **open**, filed by us 2026-05-27. Worker-flavoured repro lives at [`repro/bun-rejects-toThrow-worker/`](./repro/bun-rejects-toThrow-worker/).
- **[oven-sh/bun#5602](https://github.com/oven-sh/bun/issues/5602)** — "Fix `expect().rejects.toThrow()`" — **open** since 2023-09-17, labelled `bug`, `bun:test`. The tracking umbrella. No RoboBun activity; eight community comments confirming the bug across years.
- **[oven-sh/bun#14670](https://github.com/oven-sh/bun/issues/14670)** — "Timeout in test when expecting promise from bun shell to throw" — **open** since 2024-10-18, labelled `bug`, `bun:test`, `shell`, **`confirmed bug`**. Same symptom against `$\`bad-command\``. No comments; the team applied the `confirmed bug` label without discussion.
- **[oven-sh/bun#19130](https://github.com/oven-sh/bun/issues/19130)** — "`bun test` hangs up in timeout with PostgreSQL and `expect->toThrow()`" — **open** since 2025-04-19. Exact same hang pattern against a PostgreSQL handle. Multiple users confirming; `@robobun` was pinged 2026-04-08 — no response.
- **[oven-sh/bun#23420](https://github.com/oven-sh/bun/issues/23420)** — "Matchers under `expect().resolves` and `expect().rejects` should return a promise but return `undefined` instead" — **open** since 2025-10-10. Adjacent matcher gap; landing this likely lands #5602 too.

**Workaround in this codebase:**

- `tests/smoke.test.ts` — the `rejection(promise)` helper at the top of
  the file: plain `try`/`catch` that returns the caught error. Tests
  assert via `expect(err).toBeInstanceOf(...)` / `expect(err.message)…`
  on the captured value instead of `await expect(p).rejects.toThrow(...)`.

**Cleanup once the upstream fix ships in a stable Bun release:**

1. Run the standalone repro at [`repro/bun-rejects-toThrow-worker/`](./repro/bun-rejects-toThrow-worker/):
   ```bash
   cd repro/bun-rejects-toThrow-worker && bun install && bun test --timeout 2000
   ```
   Both tests should pass in milliseconds. If they do, the fix is in.
2. Delete the `rejection()` helper from `tests/smoke.test.ts`.
3. Replace each `const err = await rejection(p); expect(err)...` site with
   `await expect(p).rejects.toThrow(...)`. Currently three call sites
   (`script errors propagate`, `timeout terminates`, `memory limit
terminates`) plus the `dispose is idempotent` test.
4. Re-run `bun test` — should be green, ~400 ms.
5. Delete the [`repro/`](./repro/) directory.
6. Comment on #31462 (and whichever of #5602 / #14670 / #19130 / #23420
   closed it) linking the deleted workaround.

---

## Notes on bugs we _didn't_ end up needing workarounds for

While building v0 I added two more workarounds that turned out to be
**unnecessary** — they were downstream symptoms of the bug above, not
separate bugs. Removed in commit-after-initial; documenting so they don't
get re-introduced:

- A throw-sentinel wrapper around user-script `eval` to catch throws
  inside the eval frame and return a `{__isolatedJscThrow}` sentinel
  rather than letting the throw cross the eval boundary. Once tests
  stopped using `expect.rejects.toThrow`, plain throws propagated fine.
- A bootstrap-time `eval("throw …")` to "pre-warm" the worker's eval
  path. Pure cargo cult — the assumed first-eval-throw fragility doesn't
  exist; there is no first-eval-throw fragility in JSC.

If a future change makes either feel necessary again: first verify with
plain `try`/`catch` tests that the underlying behaviour is actually broken
before re-adding the workaround.
