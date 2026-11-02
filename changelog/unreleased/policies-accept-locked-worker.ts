import type { Change } from "@absolutejs/changelog";

export const change: Change = {
  detail:
    'The `ai-tool` and `plugin` policies used to require the FFI backend, so they failed wherever libJavaScriptCore was not installed. They now resolve to `backend: "auto"` with `requireLockdown: true`: FFI when the library is reachable, otherwise a Worker only when the runtime can lock it down, and `LockdownUnavailableError` on a stock Bun without libJavaScriptCore (where they threw `JscLibraryNotFoundError` before). `fallback.allowWorker` is now `true` for both. The `tenant-script` policy is unchanged and leaves `requireLockdown` unset; pass `requireLockdown: true` through `resolveIsolatePolicy` for tenants you do not trust.',
  kind: "changed",
  summary:
    "ai-tool and plugin policies accept a locked-down Worker when FFI is unavailable",
};
