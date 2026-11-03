import type { Change } from "@absolutejs/changelog";

export const change: Change = {
  detail:
    'Code running on the Worker backend can load any module through dynamic `import()`, with no eval needed: `import("node:child_process")`, `import("node:fs")` and `import("bun:ffi")` all resolve inside a hardened isolate, on every Bun release up to and including 1.4.4. The `Bun` global also stays reachable through indirect eval and the `Function` constructor, because Bun defines it as non-configurable on Worker globals. Neither can be closed from inside the package. SECURITY.md and the README now say so, and recommend a process, container or microVM boundary around Worker-backend isolates that run code which may try to escape. No code changes.',
  kind: "security",
  summary:
    "Documents that the Worker backend does not contain dynamic import() or the Bun global",
};
