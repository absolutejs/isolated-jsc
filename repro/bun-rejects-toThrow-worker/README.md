# Repro: `await expect(p).rejects.toThrow(...)` hangs on cross-Worker postMessage

Filed as [oven-sh/bun#31462](https://github.com/oven-sh/bun/issues/31462)
(2026-05-27), since **closed as a duplicate of the umbrella issue
[oven-sh/bun#5602](https://github.com/oven-sh/bun/issues/5602)**. #5602 is
closed-as-completed upstream, but the fix has not yet reached a stable Bun
release — this repro still hangs on 1.3.14 (verified 2026-06-16). See
[`../../UPSTREAM_ISSUES.md`](../../UPSTREAM_ISSUES.md) for the workaround and
cleanup steps.

## Run

```bash
bun install
bun test --timeout 2000
```

Expected: both tests pass in milliseconds.
Actual: the first (`try/catch`) passes; the second (`expect.rejects.toThrow`)
hangs to the 2000 ms test timeout.

## Why this exists in-tree

If the upstream bug is fixed and someone removes the `rejection()` helper
from `tests/smoke.test.ts`, this repro is the fastest way to confirm the
fix before deleting the workaround. The trigger is a **passing run here on a
stable Bun**, not the GitHub issue state (the issue is already closed while
the bug still reproduces). Re-run on each Bun upgrade; delete once both tests
pass in milliseconds.
