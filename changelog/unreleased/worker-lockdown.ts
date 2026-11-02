import type { Change } from "@absolutejs/changelog";

export const change: Change = {
  detail:
    'With `harden` on, the Worker backend now calls `lockdown()` from `bun:jsc` when the running Bun provides it (AbsoluteJS patched Bun 1.4.4+absolute.2 and later). It runs after the worker has loaded what it needs and before any sandboxed code, and it removes the `Bun` global (which hardening cannot delete) and `ShadowRealm`, and makes every `import()` reject. That closes the two paths by which Worker-backend code reached host authority: indirect eval or the `Function` constructor returning `Bun`, and `import("node:child_process")`, `import("node:fs")` or `import("bun:ffi")`. `isolate.lockedDown` reports whether this isolate is locked down (always `true` on the FFI backend), and the new `requireLockdown: true` option throws `LockdownUnavailableError` instead of creating an unlocked Worker-backend isolate. On stock Bun nothing changes unless `requireLockdown` is set.',
  kind: "security",
  summary:
    "Worker-backend isolates lock down on patched Bun, closing the Bun-global and import() escapes",
};
