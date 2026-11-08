import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { readJobs, readQueues } from "../services/healthMeasures";
import { HEALTH_HUB_JOB } from "../services/healthHub";
import { hubTarget } from "../services/itHub";
import { scrubError } from "../services/serviceHealth";

// GET /api/admin/health/jobs, /queues and /hub-report. Mounted inside
// systemHealth.ts, so the IT pages gate there applies. Every read is
// system-wide counts with no row data, and each section is wrapped so a DB
// failure reads { ok: false, error } instead of blanking the page. The
// measuring lives in services/healthMeasures.ts, shared with the IT Hub report.
const app = new Hono<{ Bindings: Env }>();

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

app.get("/jobs", async (c) => {
  try {
    const data = await readJobs(getDb(c.env), Date.now());
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json({ ok: false, error: errMsg(e), data: [] });
  }
});

app.get("/queues", async (c) => {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb(c.env);
  } catch (e) {
    const error = errMsg(e);
    return c.json({ ok: false, error, queues: [], failed_slip_scans: { ok: false, error } });
  }
  const queues = await readQueues(db);

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

// The 5-minute health report to the IT Hub (services/healthHub.ts): whether it
// is set up here, and when it last went through or failed, from its job_runs
// rows. "configured" is read from this Worker's env now, so it is never stale.
app.get("/hub-report", async (c) => {
  const configured = hubTarget(c.env) !== null;
  try {
    const [r] = await getDb(c.env).execute<{
      last_success_at: string | null;
      last_failure_at: string | null;
      last_error: string | null;
    }>(sql`
      SELECT max(started_at) FILTER (WHERE status = 'ok') AS last_success_at,
             max(started_at) FILTER (WHERE status = 'error') AS last_failure_at,
             (SELECT left(error, 300) FROM public.job_runs
               WHERE job = ${HEALTH_HUB_JOB} AND status = 'error'
               ORDER BY started_at DESC LIMIT 1) AS last_error
        FROM public.job_runs
       WHERE job = ${HEALTH_HUB_JOB}`);
    return c.json({
      ok: true,
      configured,
      last_success_at: iso(r?.last_success_at),
      last_failure_at: iso(r?.last_failure_at),
      last_error: scrubError(r?.last_error),
    });
  } catch (e) {
    return c.json({ ok: false, configured, error: errMsg(e) });
  }
});

export default app;
