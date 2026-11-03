import type { Change } from "@absolutejs/changelog";

export const change: Change = {
  detail:
    "A fetch handler's `env` could carry a `Reference` only as a top-level value, so a capability had to be a bare function (`env.query(...)`). An `env` value that is a plain object holding at least one `Reference` now arrives in the isolate as a frozen object of those functions, with any data beside them, so a host can offer `env.database.execute(statement, parameters)` and `env.database.kind`. Each function still calls back to the host as a `Reference` does.",
  kind: "added",
  summary: "Fetch handler env can hold objects of Reference capabilities",
  symbols: ["FetchHandlerOptions"],
};
