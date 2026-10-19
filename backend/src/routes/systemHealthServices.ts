import { Hono } from "hono";
import { sql, type SQL } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, type DB } from "../db/client";
import { todayMyt } from "../scm/lib/my-time";
import { scrubError, serviceVerdict } from "../services/serviceHealth";

// ---------------------------------------------------------------------------
// GET /api/admin/health/services (DEV-35): one row per outside service, built
// ONLY from what the ERP already records. Mounted inside systemHealth.ts, so
// the IT pages gate applies. Every count here is system-wide on purpose: this
// is "is Resend / AutoCount / APNs up", not anyone's business data, and no row
// content leaves except a scrubbed error string.
// ---------------------------------------------------------------------------

type Status = "ok" | "warning" | "critical" | "not_tracked" | "not_tracked_yet" | "unknown";

export type ServiceRow = {
  key: string;
  name: string;
  status: Status;
  ok: boolean;
  error?: string;
  note: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  attempts_24h: number | null;
  failures_24h: number | null;
};

type Agg = {
  last_success_at: unknown;
  last_failure_at: unknown;
  last_error: unknown;
  attempts_24h: number | null;
  failures_24h: number | null;
};

const iso = (v: unknown): string | null => {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};

const empty = (key: string, name: string): ServiceRow => ({
  key, name, status: "unknown", ok: true, note: null,
  last_success_at: null, last_failure_at: null, last_error: null,
  attempts_24h: null, failures_24h: null,
});

type PgError = { code?: string; message?: string; cause?: { code?: string; message?: string } };

// Drizzle wraps the driver error ("Failed query: <sql>"), so the Postgres code
// and the useful message may sit on `cause`.
const isMissingTable = (e: PgError | null): boolean =>
  e?.code === "42P01" || e?.cause?.code === "42P01";

async function measure(
  db: DB,
  key: string,
  name: string,
  query: SQL,
  opts: { extraNote?: (a: Agg & Record<string, unknown>) => string | null; missingTable?: string } = {},
): Promise<ServiceRow> {
  const row = empty(key, name);
  try {
    const a = await db.get<Agg & Record<string, unknown>>(query);
    row.last_success_at = iso(a.last_success_at);
    row.last_failure_at = iso(a.last_failure_at);
    row.last_error = scrubError(a.last_error);
    row.attempts_24h = Number(a.attempts_24h ?? 0);
    row.failures_24h = Number(a.failures_24h ?? 0);
    const v = serviceVerdict(
      {
        lastSuccessAt: row.last_success_at,
        lastFailureAt: row.last_failure_at,
        attempts24h: row.attempts_24h,
        failures24h: row.failures_24h,
      },
      Date.now(),
    );
    row.status = v.verdict;
    row.note = [v.note, opts.extraNote?.(a)].filter(Boolean).join(" · ") || null;
  } catch (caught) {
    const e = (caught ?? null) as PgError | null;
    if (opts.missingTable && isMissingTable(e)) {
      row.status = "not_tracked_yet";
      row.note = opts.missingTable;
      return row;
    }
    row.ok = false;
    row.error = scrubError(e?.cause?.message || e?.message || String(caught)) ?? "query failed";
  }
  return row;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/services", async (c) => {
  const db = getDb(c.env);
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const pushCutoffDay = todayMyt(-1);

  const services = await Promise.all([
    // execution_logs.started_at is text, always written by toISOString()
    // (services/logger.ts), so a text compare against an ISO cutoff is exact.
    // SKIPPED is neither a success nor a failure.
    measure(db, "autocount_pull", "AutoCount pulls",
      // company-scope: system-wide IT health aggregates plus one scrubbed error string
      sql`SELECT
            max(started_at) FILTER (WHERE status = 'SYNCED') AS last_success_at,
            max(started_at) FILTER (WHERE status = 'FAILED') AS last_failure_at,
            (SELECT message FROM execution_logs WHERE status = 'FAILED'
              ORDER BY started_at DESC LIMIT 1) AS last_error,
            count(*) FILTER (WHERE status IN ('SYNCED', 'FAILED') AND started_at >= ${cutoff})::int AS attempts_24h,
            count(*) FILTER (WHERE status = 'FAILED' AND started_at >= ${cutoff})::int AS failures_24h
          FROM execution_logs`),

    // Terminal rows only: 'sent' at sent_at, 'failed' at updated_at. A pending
    // row with last_error is a retry or a wait, not a failure.
    measure(db, "autocount_writeback", "AutoCount write-back",
      // company-scope: system-wide IT health aggregates plus one scrubbed error string
      sql`SELECT
            max(sent_at) FILTER (WHERE status = 'sent') AS last_success_at,
            max(updated_at) FILTER (WHERE status = 'failed') AS last_failure_at,
            (SELECT last_error FROM scm.autocount_outbox WHERE status = 'failed'
              ORDER BY updated_at DESC LIMIT 1) AS last_error,
            count(*) FILTER (WHERE (status = 'sent' AND sent_at >= ${cutoff})
                               OR (status = 'failed' AND updated_at >= ${cutoff}))::int AS attempts_24h,
            count(*) FILTER (WHERE status = 'failed' AND updated_at >= ${cutoff})::int AS failures_24h
          FROM scm.autocount_outbox`),

    // email_log, not email_outbox: the log has one timestamped row per attempt,
    // the outbox's 'failed' rows carry no failure time. created_at is ISO text
    // (0098 default). 'skipped' (channel off, no address) is not an attempt.
    measure(db, "email", "Email (Resend)",
      // company-scope: system-wide IT health aggregates plus one scrubbed error string
      sql`SELECT
            max(created_at) FILTER (WHERE status = 'sent') AS last_success_at,
            max(created_at) FILTER (WHERE status = 'error') AS last_failure_at,
            (SELECT error FROM email_log WHERE status = 'error'
              ORDER BY created_at DESC NULLS LAST LIMIT 1) AS last_error,
            count(*) FILTER (WHERE status IN ('sent', 'error') AND created_at >= ${cutoff})::int AS attempts_24h,
            count(*) FILTER (WHERE status = 'error' AND created_at >= ${cutoff})::int AS failures_24h
          FROM email_log`),

    measure(db, "whatsapp", "WhatsApp (Seampify)",
      // company-scope: system-wide IT health aggregates plus one scrubbed error string
      sql`SELECT
            max(created_at) FILTER (WHERE success) AS last_success_at,
            max(created_at) FILTER (WHERE NOT success) AS last_failure_at,
            (SELECT coalesce(error, 'HTTP ' || http_code::text) FROM scm.wa_message_log
              WHERE NOT success ORDER BY created_at DESC LIMIT 1) AS last_error,
            count(*) FILTER (WHERE created_at >= ${cutoff})::int AS attempts_24h,
            count(*) FILTER (WHERE NOT success AND created_at >= ${cutoff})::int AS failures_24h
          FROM scm.wa_message_log`),

    // APNs keeps per-device state only: a MYT date stamp on success, and a
    // last_error with no time on failure. So failures cannot be placed in the
    // 24 h window; the note counts live devices carrying an error instead.
    // ponytail: success time is the start of the MYT day; an events table
    // would give real times if this ever needs to be exact.
    measure(db, "push", "iPhone notifications (APNs)",
      sql`SELECT
            (max(last_reminder_sent_on) || 'T00:00:00+08:00') AS last_success_at,
            NULL AS last_failure_at,
            (SELECT last_error FROM push_devices WHERE disabled_at IS NULL AND last_error IS NOT NULL
              ORDER BY last_seen_at DESC NULLS LAST LIMIT 1) AS last_error,
            count(*) FILTER (WHERE last_reminder_sent_on >= ${pushCutoffDay})::int AS attempts_24h,
            0 AS failures_24h,
            count(*) FILTER (WHERE disabled_at IS NULL AND last_error IS NOT NULL)::int AS devices_with_error
          FROM push_devices`,
      {
        extraNote: (a) => {
          const n = Number(a.devices_with_error ?? 0);
          return n > 0 ? `${n} device(s) carry an untimed send error` : null;
        },
      }),

    measure(db, "venture_portal", "Venture Portal",
      // company-scope: system-wide IT health aggregates plus one scrubbed error string
      sql`SELECT
            max(sent_at) FILTER (WHERE status = 'sent') AS last_success_at,
            max(updated_at) FILTER (WHERE status = 'failed') AS last_failure_at,
            (SELECT last_error FROM scm.venture_portal_outbox WHERE status = 'failed'
              ORDER BY updated_at DESC LIMIT 1) AS last_error,
            count(*) FILTER (WHERE (status = 'sent' AND sent_at >= ${cutoff})
                               OR (status = 'failed' AND updated_at >= ${cutoff}))::int AS attempts_24h,
            count(*) FILTER (WHERE status = 'failed' AND updated_at >= ${cutoff})::int AS failures_24h
          FROM scm.venture_portal_outbox`),

    // The table arrives with the AI usage work; until then this row says so.
    measure(db, "ai", "AI (Anthropic)",
      // company-scope: system-wide IT health aggregates plus one scrubbed error string
      sql`SELECT
            max(created_at) FILTER (WHERE ok) AS last_success_at,
            max(created_at) FILTER (WHERE NOT ok) AS last_failure_at,
            (SELECT error FROM public.ai_usage_events WHERE NOT ok
              ORDER BY created_at DESC LIMIT 1) AS last_error,
            count(*) FILTER (WHERE created_at >= ${cutoff})::int AS attempts_24h,
            count(*) FILTER (WHERE NOT ok AND created_at >= ${cutoff})::int AS failures_24h
          FROM public.ai_usage_events`,
      { missingTable: "AI calls are not recorded yet." }),
  ]);

  services.push({
    ...empty("mail_inbox_sync", "Mail-inbox sync"),
    status: "not_tracked",
    note: "Runs as a GitHub Action; its results are not stored in the ERP.",
  });

  return c.json({ ok: true, time: new Date().toISOString(), services });
});

export default app;
