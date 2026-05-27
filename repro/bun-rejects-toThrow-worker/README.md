# Repro: `await expect(p).rejects.toThrow(...)` hangs on cross-Worker postMessage

Filed as [oven-sh/bun#31462](https://github.com/oven-sh/bun/issues/31462)
(2026-05-27). See [`../../UPSTREAM_ISSUES.md`](../../UPSTREAM_ISSUES.md)
for the workaround in this repo and the cleanup steps once it lands.

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
fix before deleting the workaround. Keep it around until #31462 closes;
delete then.
