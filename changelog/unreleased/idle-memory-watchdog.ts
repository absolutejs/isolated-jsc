import type { Change } from "@absolutejs/changelog";

export const change: Change = {
  detail:
    "Every Worker-backend isolate checked its heap against `memoryLimit` every 50 ms, idle or not, so a process holding hundreds of idle isolates spent much of a core polling (300 idle isolates: 62% of a core on two cores). The check now runs every 50 ms while the isolate is busy and every second after it has been idle for a second. A host message or a sandboxed timer callback marks it busy and pulls the next check forward, so code that starts allocating after an idle spell is still stopped at the busy rate. 300 idle isolates now take 26% of a core; throughput under load is unchanged.",
  kind: "fixed",
  summary: "Idle Worker isolates no longer poll their heap every 50 ms",
};
