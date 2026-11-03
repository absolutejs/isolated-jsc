import type { Change } from "@absolutejs/changelog";

export const change: Change = {
  detail:
    'On the Worker backend, `metrics.cpuMs` was `Date.now()` around the run, so time spent awaiting a host `Reference` or a timer was reported as CPU, rounded to whole milliseconds. It is now the isolate thread\'s CPU time (user + system, from `process.threadCpuUsage`) at microsecond precision, so a run that waits 300 ms on the host reports under a millisecond of CPU. Two fields are new: `wallMs`, the run\'s wall-clock duration, and `cpuSource`, `"thread"` when `cpuMs` is thread CPU time or `"wall"` when it is wall time (the FFI backend, or a runtime without `process.threadCpuUsage`). Runs that overlap on one isolate are each charged while they overlap.',
  kind: "changed",
  summary:
    "metrics.cpuMs is the isolate thread's CPU time, not wall time; adds wallMs and cpuSource",
  symbols: ["RunMetrics"],
};
