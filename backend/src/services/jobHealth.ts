// Verdicts for the System Health "Background jobs" and "Queues" panels.
// Pure functions, so the thresholds are tested without a database.

export type Verdict = "ok" | "warning" | "critical";

const DAY = 24 * 60;

/** How often each job named in scheduled() (index.ts) is expected to start, in
 *  minutes. Jobs gated to one hour of a sub-daily slot (scan-so-warm,
 *  push-reminders, fair-reconcile) count as daily, or they would read as missed
 *  every night. AutoCount pulls only run while the sync kill switch is off. */
export const JOB_CADENCE_MIN: Record<string, number> = {
  keepwarm: 5,
  "email-outbox": 5,
  "so-pull": 5,
  "amendment-cmd": 5,
  "ac-writeback": 5,
  "vp-feed": 5,
  "vp-catalogue": 5,
  "ac-relink-sweep": 5,
  "ac-delivery-dates": 5,
  "so-allocation": 5,
  "mrp-snapshot": 15,
  "procurement-overview": 15,
  "vp-reconcile": 30,
  "assr-alerts": 30,
  "ann-escalation": 30,
  "lead-time-schedule": 30,
  "agent-heartbeat": 30,
  "slip-reaper": 30,
  "threepl-bills": 30,
  "scan-so-warm": DAY,
  "push-reminders": DAY,
  "fair-reconcile": DAY,
  sla: DAY,
  "do-mirror": DAY,
  "po-docs-pull": DAY,
  "po-pull": DAY,
  "ac-snapshot-so": DAY,
  "ac-snapshot-po": DAY,
  "assr-digest": DAY,
  "proj-reminders": DAY,
  "client-errors": DAY,
  "idempotency-sweep": DAY,
  "ar-aging-refresh": DAY,
  "job-runs-retention": DAY,
  "failed-logins-retention": DAY,
  "stock-close": DAY,
  "supplier-price-apply": DAY,
  "deliver-due": DAY,
  "scan-so-distill": 7 * DAY,
};

/** Sub-daily: 2.5 cadences. Daily or longer: the cadence plus 2 hours (26h for
 *  a daily job). */
export function missedAfterMin(cadenceMin: number): number {
  return cadenceMin >= DAY ? cadenceMin + 120 : cadenceMin * 2.5;
}

export interface JobFacts {
  cadenceMin: number | null; // null = not in the catalogue, so no missed rule
  lastStartMs: number | null; // null = no run recorded in the retention window
  lastStatus: "running" | "ok" | "error" | null;
  lastDurationMs: number | null;
  median7dMs: number | null;
  samples7d: number;
  failures24h: number;
  nowMs: number;
}

export function classifyJob(f: JobFacts): { verdict: Verdict; reason: string } {
  if (f.lastStartMs == null) {
    return { verdict: "warning", reason: "No run recorded in the last 14 days" };
  }
  if (f.lastStatus === "error") return { verdict: "critical", reason: "Last run failed" };
  const agoMin = (f.nowMs - f.lastStartMs) / 60000;
  if (f.cadenceMin != null && agoMin > missedAfterMin(f.cadenceMin)) {
    return f.lastStatus === "running"
      ? { verdict: "critical", reason: `Last run never finished (started ${fmtMin(agoMin)} ago)` }
      : { verdict: "critical", reason: `Missed: last start ${fmtMin(agoMin)} ago, expected every ${fmtMin(f.cadenceMin)}` };
  }
  if (
    f.lastDurationMs != null && f.median7dMs != null && f.median7dMs > 0 &&
    f.samples7d >= 20 && f.lastDurationMs > 3 * f.median7dMs
  ) {
    return { verdict: "warning", reason: `Slow: last run took over 3x its 7-day median` };
  }
  if (f.failures24h > 0) {
    return { verdict: "warning", reason: `${f.failures24h} failed run(s) in 24h; last run ok` };
  }
  return { verdict: "ok", reason: "" };
}

export function classifyQueue(q: { oldestWaitingMin: number | null; failed: number }): {
  verdict: Verdict;
  reason: string;
} {
  const age = q.oldestWaitingMin ?? 0;
  if (age > 120) return { verdict: "critical", reason: `Oldest waiting item is ${fmtMin(age)} old` };
  if (age > 30) return { verdict: "warning", reason: `Oldest waiting item is ${fmtMin(age)} old` };
  if (q.failed > 0) return { verdict: "warning", reason: `${q.failed} failed or dead` };
  return { verdict: "ok", reason: "" };
}

function fmtMin(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / DAY)} d`;
}
