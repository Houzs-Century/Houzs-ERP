// ---------------------------------------------------------------------------
// healthHub.ts — Houzs's 5-minute health report for the Houzs IT Hub.
//
// The hub's own check of /health only proves the Worker answers. This sends what
// it cannot see: a live database query, the email outbox backlog, background
// job health and AI failures by feature and model. The hub draws it on its
// System health page, so IT see a problem without anyone opening ours.
//
// Nothing here is measured twice: jobs, queues and the AI verdict come from the
// same functions the System Health page uses (healthMeasures.ts, jobHealth.ts,
// serviceHealth.ts), so the hub and the page always say the same thing.
//
// Payload and endpoint mirror the sister systems exactly (Hookka
// src/api/lib/hub-health.ts, Conts functions/_lib/systemHealth.ts):
// POST <IT_HUB_URL>/api/v1/sys/health, Bearer <company hub key>,
// { ok, time, db, counts, checks[], problems[] }. Sent from the */5 cron slot.
// No hub address or key => nothing is measured or sent, and nothing throws.
// ---------------------------------------------------------------------------
import { sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, type DB } from "../db/client";
import { aiServiceQuery, readJobs, readQueues, type JobRow, type QueueRow } from "./healthMeasures";
import { scrubError, serviceVerdict, type ServiceStats } from "./serviceHealth";
import { hubTarget } from "./itHub";

export const HEALTH_HUB_JOB = "health-hub";

export type HealthStatus = "ok" | "warning" | "critical" | "off";

export interface HealthCheck {
  key: string;
  label: string;
  value: string;
  status: HealthStatus;
  summary: string;
  detail?: string;
}

export interface HealthProblem {
  at: string;
  what: string;
  where: string | null;
  error: string | null;
}

export interface HubHealthReport {
  ok: boolean;
  time: string;
  db: { ok: boolean; latency_ms: number; error?: string };
  counts: Record<string, number>;
  checks: HealthCheck[];
  problems: HealthProblem[];
}

/** One feature x model over the last 24 h; "latest" is its newest call. */
export interface AiGroup {
  feature: string;
  model: string;
  total: number;
  failed: number;
  latestOk: boolean;
  latestStatus: number | null;
  latestError: string | null;
}

export interface AiFailedCall {
  at: string;
  feature: string;
  model: string;
  status: number | null;
  error: string | null;
}

const DAY_MS = 86_400_000;
const HUB_TIMEOUT_MS = 15_000;
const MAX_LINES = 10;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const lines = (all: string[]) => (all.length > 1 ? { detail: all.slice(1, MAX_LINES).join("; ") } : {});

/** Pure: what a failed AI call's HTTP status means (same wording as Hookka). */
export function aiFailureReason(status: number | null): string {
  if (status === 401 || status === 403) return "Key wrong, expired or not allowed";
  if (status === 404) return "Model not available";
  if (status === 400) return "Refused: out of credit, or a file it could not read";
  if (status === 429) return "Rate limit reached";
  if (status === 529) return "Anthropic overloaded";
  if (status && status >= 500) return `Anthropic error ${status}`;
  if (!status) return "Could not reach Anthropic";
  return `Answered ${status}`;
}

/** Pure: the email card. The backlog verdict is the Waiting queues panel's. */
export function emailCheck(outbox: QueueRow | undefined, hasKey: boolean): HealthCheck {
  const base = { key: "email", label: "Email" };
  if (!hasKey) return { ...base, value: "No key", status: "critical", summary: "RESEND_API_KEY is not set, so no email goes out." };
  if (!outbox) return { ...base, value: "—", status: "critical", summary: "Could not be checked." };
  if (!outbox.ok) return { ...base, value: "—", status: "critical", summary: "Could not be checked.", detail: scrubError(outbox.error) ?? undefined };
  const waiting = `${outbox.waiting} waiting, ${outbox.failed} failed in 24h`;
  if (outbox.verdict === "ok") return { ...base, value: "OK", status: "ok", summary: waiting };
  return { ...base, value: String(outbox.waiting + outbox.failed), status: outbox.verdict, summary: outbox.reason, detail: waiting };
}

/** Pure: the background jobs card, from the Background jobs panel's verdicts.
 *  This report's own job is left out: the hub knows when a report did not come. */
export function jobsCheck(jobs: JobRow[]): HealthCheck {
  const base = { key: "jobs", label: "Background jobs" };
  const watched = jobs.filter((j) => j.job !== HEALTH_HUB_JOB);
  const critical = watched.filter((j) => j.verdict === "critical");
  const warning = watched.filter((j) => j.verdict === "warning");
  if (!critical.length && !warning.length) {
    return { ...base, value: "Running", status: "ok", summary: `${plural(watched.length, "job")} on time` };
  }
  const all = [...critical, ...warning].map((j) => `${j.job}: ${j.reason}`);
  return {
    ...base,
    value: `${critical.length + warning.length} of ${watched.length}`,
    status: critical.length ? "critical" : "warning",
    summary: all[0]!,
    ...lines(all),
  };
}

/** Pure: every other waiting queue (the email outbox has its own card). */
export function queuesCheck(queues: QueueRow[]): HealthCheck {
  const base = { key: "queues", label: "Waiting queues" };
  const others = queues.filter((q) => q.name !== "email_outbox");
  const unreadable = others.filter((q): q is Extract<QueueRow, { ok: false }> => !q.ok);
  const read = others.filter((q): q is Extract<QueueRow, { ok: true }> => q.ok);
  const bad = read.filter((q) => q.verdict !== "ok");
  const all = [
    ...bad.filter((q) => q.verdict === "critical").map((q) => `${q.label}: ${q.reason}`),
    ...bad.filter((q) => q.verdict === "warning").map((q) => `${q.label}: ${q.reason}`),
    ...unreadable.map((q) => `${q.label}: could not be checked`),
  ];
  if (!all.length) {
    const waiting = read.reduce((a, q) => a + q.waiting, 0);
    return { ...base, value: "OK", status: "ok", summary: `${waiting} waiting across ${plural(read.length, "queue")}` };
  }
  const critical = bad.some((q) => q.verdict === "critical") || unreadable.length > 0;
  return { ...base, value: String(all.length), status: critical ? "critical" : "warning", summary: all[0]!, ...lines(all) };
}

/** Pure: the AI card. The verdict is the Services panel's "AI (Anthropic)" row;
 *  the lines name each feature and model whose newest call failed. */
export function aiCheck(stats: ServiceStats, groups: AiGroup[], hasKey: boolean, nowMs: number): HealthCheck {
  const base = { key: "ai", label: "AI" };
  if (!hasKey) return { ...base, value: "No key", status: "critical", summary: "ANTHROPIC_API_KEY is not set, so every AI call fails." };
  const v = serviceVerdict(stats, nowMs);
  if (stats.attempts24h === 0) return { ...base, value: "Idle", status: "ok", summary: "No AI calls in 24h" };
  const failing = groups
    .filter((g) => !g.latestOk)
    .map((g) => `${g.feature}, ${g.model}: ${g.failed} of ${g.total} failed in 24h. ${g.latestStatus != null ? aiFailureReason(g.latestStatus) : scrubError(g.latestError) ?? aiFailureReason(null)}`);
  const models = [...new Set(groups.map((g) => g.model))].sort().join(", ");
  if (v.verdict === "ok") {
    return {
      ...base,
      value: "Working",
      status: "ok",
      summary: `${plural(stats.attempts24h, "call")} in 24h${stats.failures24h ? `, ${stats.failures24h} failed but working since` : ""}`,
      ...(models ? { detail: `Models: ${models}` } : {}),
    };
  }
  const all = failing.length ? failing : [`${stats.failures24h} of ${stats.attempts24h} calls failed in 24h${v.note ? ` (${v.note})` : ""}`];
  return { ...base, value: v.verdict === "critical" ? "Problem" : "Check", status: v.verdict, summary: all[0]!, ...lines(all) };
}

/** Pure: newest first, failed AI calls and jobs whose last run failed. */
export function healthProblems(aiCalls: AiFailedCall[], jobs: JobRow[]): HealthProblem[] {
  const ai = aiCalls.map((c) => ({
    at: c.at,
    what: "AI call failed",
    where: `${c.feature}, ${c.model}`,
    error: c.status != null ? aiFailureReason(c.status) : scrubError(c.error),
  }));
  const failedJobs = jobs
    .filter((j) => j.job !== HEALTH_HUB_JOB && j.last_status === "error" && j.last_start)
    .map((j) => ({ at: j.last_start!, what: "Background job failed", where: j.job, error: scrubError(j.last_error) }));
  return [...ai, ...failedJobs].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_LINES);
}

/** Pure: the report from what was measured. A part that could not be measured
 *  arrives as a ready-made "could not be checked" card, never as a gap. */
export function buildHealthReport(m: {
  nowMs: number;
  db: HubHealthReport["db"];
  checks: HealthCheck[];
  problems: HealthProblem[];
  counts: Record<string, number>;
}): HubHealthReport {
  return {
    ok: m.db.ok && !m.checks.some((c) => c.status === "critical"),
    time: new Date(m.nowMs).toISOString(),
    db: m.db,
    counts: m.counts,
    checks: m.checks,
    problems: m.problems,
  };
}

const unchecked = (key: string, label: string): HealthCheck => ({ key, label, value: "—", status: "critical", summary: "Could not be checked." });
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

async function readAi(db: DB, cutoffIso: string) {
  const stats = await db.get<{ last_success_at: unknown; last_failure_at: unknown; attempts_24h: number | null; failures_24h: number | null }>(aiServiceQuery(cutoffIso));
  const groups = await db.execute<{
    feature: string; model: string; total: number; failed: number;
    latest_ok: boolean; latest_status: number | null; latest_error: string | null;
  }>(sql`
    -- company-scope: system-wide IT health aggregates, no row data returned
    SELECT feature, model, count(*)::int AS total, count(*) FILTER (WHERE NOT ok)::int AS failed,
           (array_agg(ok ORDER BY created_at DESC))[1] AS latest_ok,
           (array_agg(http_status ORDER BY created_at DESC))[1] AS latest_status,
           (array_agg(left(error, 300) ORDER BY created_at DESC))[1] AS latest_error
      FROM public.ai_usage_events
     WHERE created_at >= ${cutoffIso}
     GROUP BY feature, model`);
  const failed = await db.execute<{ created_at: string; feature: string; model: string; http_status: number | null; error: string | null }>(sql`
    -- company-scope: system-wide IT health, feature / model / status only
    SELECT created_at, feature, model, http_status, left(error, 300) AS error
      FROM public.ai_usage_events
     WHERE NOT ok AND created_at >= ${cutoffIso}
     ORDER BY created_at DESC LIMIT ${MAX_LINES}`);
  return {
    stats: {
      lastSuccessAt: iso(stats.last_success_at),
      lastFailureAt: iso(stats.last_failure_at),
      attempts24h: Number(stats.attempts_24h ?? 0),
      failures24h: Number(stats.failures_24h ?? 0),
    } satisfies ServiceStats,
    groups: [...groups].map((g): AiGroup => ({
      feature: g.feature, model: g.model, total: Number(g.total), failed: Number(g.failed),
      latestOk: g.latest_ok === true, latestStatus: g.latest_status == null ? null : Number(g.latest_status), latestError: g.latest_error,
    })),
    failed: [...failed].map((f): AiFailedCall => ({
      at: iso(f.created_at) ?? String(f.created_at), feature: f.feature, model: f.model,
      status: f.http_status == null ? null : Number(f.http_status), error: f.error,
    })),
  };
}

/** Measures with whatever still works: a failed part becomes a red card. Never throws. */
export async function measureHealthForHub(env: Env, nowMs: number): Promise<HubHealthReport> {
  let db: DB | null = null;
  try {
    db = getDb(env);
  } catch {
    console.error("[health-hub] no database binding");
  }

  const t0 = Date.now();
  let dbState: HubHealthReport["db"];
  try {
    if (!db) throw new Error("no database");
    await db.execute(sql`SELECT 1 AS x`);
    dbState = { ok: true, latency_ms: Date.now() - t0 };
  } catch {
    // Driver messages can name tables or hosts, so they stay out of the report.
    console.error("[health-hub] database check failed");
    dbState = { ok: false, latency_ms: Date.now() - t0, error: "Did not answer a live query" };
  }

  let jobs: JobRow[] = [];
  let queues: QueueRow[] = [];
  let ai: Awaited<ReturnType<typeof readAi>> | null = null;
  const checks: HealthCheck[] = [];
  const counts: Record<string, number> = {};

  try {
    if (!db) throw new Error("no database");
    queues = await readQueues(db);
    const outbox = queues.find((q) => q.name === "email_outbox");
    if (outbox?.ok) counts.email_waiting = outbox.waiting;
    checks.push(emailCheck(outbox, !!env.RESEND_API_KEY));
    checks.push(queuesCheck(queues));
  } catch {
    console.error("[health-hub] queues could not be read");
    checks.push(unchecked("email", "Email"), unchecked("queues", "Waiting queues"));
  }
  try {
    if (!db) throw new Error("no database");
    jobs = await readJobs(db, nowMs);
    checks.push(jobsCheck(jobs));
    counts.jobs_failing = jobs.filter((j) => j.job !== HEALTH_HUB_JOB && j.verdict !== "ok").length;
  } catch {
    console.error("[health-hub] job runs could not be read");
    checks.push(unchecked("jobs", "Background jobs"));
  }
  try {
    if (!db) throw new Error("no database");
    ai = await readAi(db, new Date(nowMs - DAY_MS).toISOString());
    checks.push(aiCheck(ai.stats, ai.groups, !!env.ANTHROPIC_API_KEY, nowMs));
    counts.ai_calls_24h = ai.stats.attempts24h;
    counts.ai_failures_24h = ai.stats.failures24h;
  } catch {
    console.error("[health-hub] AI calls could not be read");
    checks.push(unchecked("ai", "AI"));
  }

  return buildHealthReport({ nowMs, db: dbState, checks, problems: healthProblems(ai?.failed ?? [], jobs), counts });
}

/** The 5-minute cron job. Not set up => { sent: false }, nothing measured, nothing
 *  thrown. A hub that refuses throws, so job_runs records the failure and the
 *  System Health page shows it. */
export async function sendHealthReportToHub(env: Env, nowMs: number): Promise<{ sent: false } | { sent: true; ok: boolean; checks: number }> {
  const target = hubTarget(env);
  if (!target) return { sent: false };
  const report = await measureHealthForHub(env, nowMs);
  const res = await fetch(`${target.base}/api/v1/sys/health`, {
    method: "POST",
    headers: { Authorization: `Bearer ${target.key}`, "Content-Type": "application/json" },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`hub answered HTTP ${res.status}: ${scrubError((await res.text()).slice(0, 200)) ?? ""}`);
  return { sent: true, ok: report.ok, checks: report.checks.length };
}
