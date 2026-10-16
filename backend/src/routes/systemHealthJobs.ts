import { Hono } from "hono";
import { sql, type SQL } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { JOB_CADENCE_MIN, classifyJob, classifyQueue } from "../services/jobHealth";

// GET /api/admin/health/jobs and /queues. Mounted inside systemHealth.ts, so the
// IT pages gate there applies. Every read is system-wide counts with no row
// data, and each section is wrapped so a DB failure reads { ok: false, error }
// instead of blanking the page.
const app = new Hono<{ Bindings: Env }>();

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

app.get("/jobs", async (c) => {
  try {
    const rows = await getDb(c.env).execute<{
      job: string;
      started_at: string;
      status: "running" | "ok" | "error";
      error: string | null;
      duration_ms: number | null;
      runs_24h: number;
      failures_24h: number;
      median_ms: number | null;
      samples_7d: number;
    }>(sql`
      WITH last AS (
        SELECT DISTINCT ON (job) job, started_at, status, error, duration_ms
          FROM public.job_runs ORDER BY job, started_at DESC
      ), d24 AS (
        SELECT job, count(*)::int AS runs_24h, count(*) FILTER (WHERE status = 'error')::int AS failures_24h
          FROM public.job_runs WHERE started_at > now() - interval '24 hours' GROUP BY job
      ), d7 AS (
        SELECT job, percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::float8 AS median_ms, count(*)::int AS samples_7d
          FROM public.job_runs
         WHERE started_at > now() - interval '7 days' AND duration_ms IS NOT NULL GROUP BY job
      )
      SELECT l.job, l.started_at, l.status, left(l.error, 300) AS error, l.duration_ms,
             coalesce(d24.runs_24h, 0) AS runs_24h, coalesce(d24.failures_24h, 0) AS failures_24h,
             d7.median_ms, coalesce(d7.samples_7d, 0) AS samples_7d
        FROM last l LEFT JOIN d24 USING (job) LEFT JOIN d7 USING (job)`);

    const byJob = new Map(rows.map((r) => [r.job, r]));
    const names = [...new Set([...Object.keys(JOB_CADENCE_MIN), ...byJob.keys()])].sort();
    const now = Date.now();
    const data = names.map((job) => {
      const r = byJob.get(job);
      const cadenceMin = JOB_CADENCE_MIN[job] ?? null;
      const lastStart = iso(r?.started_at);
      const { verdict, reason } = classifyJob({
        cadenceMin,
        lastStartMs: lastStart ? Date.parse(lastStart) : null,
        lastStatus: r?.status ?? null,
        lastDurationMs: r?.duration_ms ?? null,
        median7dMs: r?.median_ms ?? null,
        samples7d: r?.samples_7d ?? 0,
        failures24h: r?.failures_24h ?? 0,
        nowMs: now,
      });
      return {
        job,
        cadence_min: cadenceMin,
        last_start: lastStart,
        last_status: r?.status ?? null,
        last_error: r?.error ?? null,
        duration_ms: r?.duration_ms ?? null,
        runs_24h: r?.runs_24h ?? 0,
        failures_24h: r?.failures_24h ?? 0,
        verdict,
        reason,
      };
    });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json({ ok: false, error: errMsg(e), data: [] });
  }
});

// One statement per queue, each returning waiting / failed / oldest_s. "failed"
// is failures in the last 24h, except the allocation queue's DEAD row, which is
// a standing stop (not an event) and counts while it exists.
const QUEUES: Array<{ name: string; label: string; query: SQL }> = [
  {
    name: "email_outbox",
    label: "Email outbox",
    // email_outbox has no updated_at, so a failure is dated by created_at.
    // company-scope: system-wide counts for IT health, no row data returned.
    query: sql`SELECT count(*) FILTER (WHERE status = 'pending')::int AS waiting,
                      count(*) FILTER (WHERE status = 'failed')::int AS failed,
                      extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'pending'))::int AS oldest_s
                 FROM public.email_outbox
                WHERE status = 'pending' OR (status = 'failed' AND created_at > now() - interval '24 hours')`,
  },
  {
    name: "autocount_outbox",
    label: "AutoCount write-back",
    // company-scope: system-wide counts for IT health, no row data returned.
    query: sql`SELECT count(*) FILTER (WHERE status = 'pending')::int AS waiting,
                      count(*) FILTER (WHERE status = 'failed')::int AS failed,
                      extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'pending'))::int AS oldest_s
                 FROM scm.autocount_outbox
                WHERE archived_at IS NULL
                  AND (status = 'pending' OR (status = 'failed' AND updated_at > now() - interval '24 hours'))`,
  },
  {
    name: "venture_portal_outbox",
    label: "Venture Portal feed",
    // company-scope: system-wide counts for IT health, no row data returned.
    query: sql`SELECT count(*) FILTER (WHERE status = 'pending')::int AS waiting,
                      count(*) FILTER (WHERE status = 'failed')::int AS failed,
                      extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'pending'))::int AS oldest_s
                 FROM scm.venture_portal_outbox
                WHERE status = 'pending' OR (status = 'failed' AND updated_at > now() - interval '24 hours')`,
  },
  {
    name: "sync_command",
    label: "Amendment commands (2990)",
    // SENT is in flight to 2990 and not finished, so it counts as waiting.
    // company-scope: system-wide counts for IT health, no row data returned.
    query: sql`SELECT count(*) FILTER (WHERE status IN ('PENDING', 'SENT'))::int AS waiting,
                      count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
                      extract(epoch FROM now() - min(created_at) FILTER (WHERE status IN ('PENDING', 'SENT')))::int AS oldest_s
                 FROM scm.sync_command
                WHERE status IN ('PENDING', 'SENT')
                   OR (status = 'FAILED' AND completed_at > now() - interval '24 hours')`,
  },
  {
    name: "stock_allocation_recompute_queue",
    label: "Stock allocation recompute",
    // company-scope: a single GLOBAL row with no company column.
    query: sql`SELECT count(*) FILTER (WHERE state = 'PENDING')::int AS waiting,
                      count(*) FILTER (WHERE state = 'DEAD')::int AS failed,
                      extract(epoch FROM now() - min(requested_at) FILTER (WHERE state = 'PENDING'))::int AS oldest_s
                 FROM scm.stock_allocation_recompute_queue`,
  },
  {
    name: "scan_jobs",
    label: "Document scans (OCR)",
    // A scan is waiting while queued or running; its failure status is 'error'.
    // company-scope: system-wide counts for IT health, no row data returned.
    query: sql`SELECT count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS waiting,
                      count(*) FILTER (WHERE status = 'error')::int AS failed,
                      extract(epoch FROM now() - min(created_at) FILTER (WHERE status IN ('queued', 'running')))::int AS oldest_s
                 FROM scm.scan_jobs
                WHERE status IN ('queued', 'running')
                   OR (status = 'error' AND updated_at > now() - interval '24 hours')`,
  },
];

app.get("/queues", async (c) => {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb(c.env);
  } catch (e) {
    const error = errMsg(e);
    return c.json({ ok: false, error, queues: [], failed_slip_scans: { ok: false, error } });
  }
  const queues = await Promise.all(
    QUEUES.map(async ({ name, label, query }) => {
      try {
        // An aggregate with no GROUP BY always returns exactly one row.
        const [r] = await db.execute<{ waiting: number; failed: number; oldest_s: number | null }>(query);
        const oldestWaitingMin = r.oldest_s == null ? null : Math.round(r.oldest_s / 60);
        const failed = r.failed;
        return {
          name,
          label,
          ok: true as const,
          waiting: r.waiting,
          failed,
          oldest_waiting_min: oldestWaitingMin,
          ...classifyQueue({ oldestWaitingMin, failed }),
        };
      } catch (e) {
        return { name, label, ok: false as const, error: errMsg(e) };
      }
    }),
  );

  // Failed order-slip scans, last 7 days. The Cloudflare dead-letter queue
  // houzs-scan-ocr-dlq cannot be read from the Worker (a queue is consumed, not
  // queried), so the scan rows marked 'error' are the readable record.
  let failedSlipScans: { ok: true; count_7d: number } | { ok: false; error: string };
  try {
    const [r] = await db.execute<{ n: number }>(
      // company-scope: system-wide count for IT health, no row data returned.
      sql`SELECT count(*)::int AS n FROM scm.scan_jobs
           WHERE document_type = 'SO' AND status = 'error' AND created_at > now() - interval '7 days'`,
    );
    failedSlipScans = { ok: true, count_7d: r.n };
  } catch (e) {
    failedSlipScans = { ok: false, error: errMsg(e) };
  }

  return c.json({ ok: true, queues, failed_slip_scans: failedSlipScans });
});

export default app;
