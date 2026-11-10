// Background-job failure alerts. Hourly (index.ts, job "job-alerts"): every job
// is classified exactly as the System Health "Background jobs" panel classifies
// it — readJobs() in healthMeasures.ts, the panel's own read — and a job whose
// verdict is critical (last run failed, missed its slot, or never finished)
// gets ONE notice to the IT-page holders per incident.
//
// Incident = from the alert until the job next runs ok. No new table: the
// notices themselves are the record. A job is alerted again only after it has
// had an ok run since its last alert (it recovered, then broke again) AND the
// cool-down has passed, so a job that flaps every five minutes cannot ring
// every hour.

import { sql } from "drizzle-orm";
import type { Env } from "../types";
import type { DB } from "../db/client";
import { getDb } from "../db/client";
import { readJobs, type JobRow } from "./healthMeasures";
import { usersOnDeskFor } from "./permissionHolders";
import { postPersonalNotice } from "./personalNotice";
import { scrubError } from "./serviceHealth";

export const JOB_ALERTS_JOB = "job-alerts";
export const JOB_ALERT_SOURCE = "job_alert";
export const JOB_ALERT_COOLDOWN_MS = 6 * 3600_000;
const TITLE_PREFIX = "Background job failing: ";

export const jobAlertTitle = (job: string) => `${TITLE_PREFIX}${job}`;
export const jobFromAlertTitle = (title: string) => (title.startsWith(TITLE_PREFIX) ? title.slice(TITLE_PREFIX.length) : null);

const toMs = (v: unknown): number | null => {
  if (v == null) return null;
  const n = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isNaN(n) ? null : n;
};

/** The jobs to alert now. `lastOkMs` = last ok run start per job, `lastAlertMs`
 *  = newest alert notice per job. Only a critical verdict alerts. */
export function pickJobAlerts(
  jobs: JobRow[],
  lastOkMs: ReadonlyMap<string, number>,
  lastAlertMs: ReadonlyMap<string, number>,
  nowMs: number,
): JobRow[] {
  return jobs.filter((j) => {
    if (j.verdict !== "critical") return false;
    const alerted = lastAlertMs.get(j.job);
    if (alerted == null) return true;
    const ok = lastOkMs.get(j.job);
    return ok != null && ok > alerted && nowMs - alerted >= JOB_ALERT_COOLDOWN_MS;
  });
}

export function jobAlertBody(j: JobRow): string {
  const scrubbed = scrubError(j.last_error);
  const err = scrubbed ? ` Last error: ${scrubbed}` : "";
  return `${j.reason}.${err} Open IT > System Health > Background jobs for the run log. ` +
    `You will hear about this job again only after it has run ok and then failed again.`;
}

async function readLastOk(db: DB): Promise<Map<string, number>> {
  const rows = await db.execute<{ job: string; at: string | Date | null }>(sql`
    SELECT job, max(started_at) AS at FROM public.job_runs WHERE status = 'ok' GROUP BY job`);
  const out = new Map<string, number>();
  for (const r of rows) { const t = toMs(r.at); if (t != null) out.set(r.job, t); }
  return out;
}

async function readLastAlerts(env: Env): Promise<Map<string, number>> {
  const r = await env.DB.prepare(
    `SELECT title, created_at FROM announcements WHERE source = ? ORDER BY created_at DESC LIMIT 1000`,
  ).bind(JOB_ALERT_SOURCE).all<{ title: string; created_at: string | Date }>();
  const out = new Map<string, number>();
  for (const row of r.results) {
    const job = jobFromAlertTitle(row.title);
    const t = toMs(row.created_at);
    if (job && t != null && t > (out.get(job) ?? -Infinity)) out.set(job, t);
  }
  return out;
}

export async function runJobFailureAlerts(env: Env, nowMs: number): Promise<{ critical: number; alerted: string[] }> {
  const db = getDb(env);
  const [jobs, lastOk, lastAlert] = await Promise.all([readJobs(db, nowMs), readLastOk(db), readLastAlerts(env)]);
  const due = pickJobAlerts(jobs, lastOk, lastAlert, nowMs);
  if (due.length) {
    const { userIds } = await usersOnDeskFor(env, "it.view", { companyId: null });
    for (const j of due) {
      await postPersonalNotice(env, { userIds, category: "WARNING", source: JOB_ALERT_SOURCE, title: jobAlertTitle(j.job), body: jobAlertBody(j) });
    }
  }
  return { critical: jobs.filter((j) => j.verdict === "critical").length, alerted: due.map((j) => j.job) };
}
