import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { checkRateLimit } from "../middleware/rateLimit";
import { captureError } from "../services/errorTracking";

// ---------------------------------------------------------------------------
// /api/client-errors -- self-hosted client error reporting (owner ruling: no
// Sentry; free, data stays in-house). The SPA's global error reporter
// (frontend/src/lib/errorReporter.ts) batches uncaught errors and POSTs them
// here; the daily 02:00 cron (services/clientErrors.ts) mails IT a digest.
//
// TRUST BOUNDARY. The reporter runs in the user's browser, so everything in the
// body is attacker-controllable. Identity is therefore taken ONLY from the
// session (c.get("user") / companyContext) -- a userId/companyId in the body is
// ignored by schema. Sizes are capped at three layers: total payload (~16KB),
// events per batch, and per-field lengths (stack truncated to 4KB, not
// rejected -- a long stack is data loss, not an attack). The route is stripped
// of query strings + fragments server-side so a token- or data-carrying URL can
// never be stored even if a client forgets to.
//
// STORM COLLAPSE. One upsert per event on the (dedup_hash, day, user_id) unique
// key (mig 0151 / D1 126): the same error looping for one user all day is ONE
// row with a bumped count. dedup_hash = sha256(message + route + build_id).
//
// Raw env.DB (not Drizzle) deliberately: the vitest harness runs on isolated D1
// where the Drizzle/postgres path has no database, and the immediate neighbours
// this extends (audit.ts, systemHealth.ts, email.ts) are raw env.DB too. The
// SQL below is the dialect-shared subset (ON CONFLICT DO UPDATE + `?` binds)
// that runs identically on test D1 and the prod PG shim.
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

// Hard byte cap on the raw body. The reporter flushes at most 10 events of
// ~4.5KB worst case, but it retries nothing -- a cap breach is a broken or
// hostile client, and 413 is the honest answer.
const MAX_BODY_BYTES = 16 * 1024;
const MAX_STACK = 4096;
const MAX_MESSAGE = 500;
const MAX_ROUTE = 200;

// Per-user batch budget: the reporter sends at most one batch per 10s, so 60
// per 10 minutes is the ceiling of legitimate traffic even mid-storm; beyond
// that is a loop the client-side caps failed to contain. KV-backed, fail-open
// (same contract as every other checkRateLimit caller).
const RL_MAX = 60;
const RL_WINDOW_SEC = 600;

const eventSchema = z.object({
  message: z.string().min(1).max(4000),
  stack: z.string().max(64 * 1024).optional(),
  route: z.string().max(2000).optional(),
  buildId: z.string().max(64).optional(),
  userAgent: z.string().max(500).optional(),
  occurredAt: z.string().max(40).optional(),
});
// Unknown keys are stripped by zod -- a client-sent userId/companyId never
// reaches the insert even as a value to ignore.
const bodySchema = z.object({
  events: z.array(eventSchema).min(1).max(20),
});

// ISO-8601 UTC ("...Z") or nothing: the table's text timestamps sort
// lexicographically, so one row in "YYYY-MM-DD HH:MM:SS" format would corrupt
// every range scan. Anything else falls back to the server clock.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

async function dedupHash(message: string, route: string, buildId: string): Promise<string> {
  const data = new TextEncoder().encode(`${message}\n${route}\n${buildId}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Pathname only -- no query string, no fragment, no origin. Privacy boundary:
 *  query strings routinely carry search terms, filters, and (in the reset/invite
 *  flows) tokens. */
function sanitizeRoute(raw: string | undefined): string {
  const r = (raw ?? "").split("?")[0].split("#")[0];
  return r.slice(0, MAX_ROUTE);
}

app.post("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const limited = await checkRateLimit(c, "client_errors", String(user.id), RL_MAX, RL_WINDOW_SEC);
  if (limited) return limited;

  const raw = await c.req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return c.json({ error: "Payload too large" }, 413);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const parsed = bodySchema.safeParse(parsedJson);
  if (!parsed.success) {
    return c.json({ error: "Invalid error report" }, 400);
  }

  // Identity comes from the session + companyContext, never the body.
  const userId = Number(user.id) || 0;
  const companyId = c.get("companyId") ?? null;

  const nowIso = new Date().toISOString();
  const day = nowIso.slice(0, 10);

  // Resolved once, outside the loop. c.executionCtx throws when the runtime
  // supplied none; the reporter is fire-and-forget either way.
  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined;
  }

  let stored = 0;
  for (const ev of parsed.data.events) {
    const message = ev.message.slice(0, MAX_MESSAGE);
    const route = sanitizeRoute(ev.route);
    const buildId = (ev.buildId ?? "").slice(0, 64);
    const stack = ev.stack ? ev.stack.slice(0, MAX_STACK) : null;
    const userAgent = ev.userAgent ? ev.userAgent.slice(0, 500) : null;
    const occurredAt = ev.occurredAt && ISO_RE.test(ev.occurredAt) ? ev.occurredAt : nowIso;
    const hash = await dedupHash(message, route, buildId);

    // Same-day same-user recurrence bumps the counter instead of inserting --
    // the storm collapse. stack/user_agent keep the FIRST occurrence's values
    // (the first capture is the cleanest; a loop's later frames add nothing).
    await c.env.DB.prepare(
      `INSERT INTO client_errors
         (occurred_at, day, user_id, company_id, route, message, stack, build_id, user_agent, dedup_hash, count, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (dedup_hash, day, user_id) DO UPDATE SET
         count = client_errors.count + 1,
         last_seen_at = excluded.last_seen_at`,
    )
      .bind(occurredAt, day, userId, companyId, route, message, stack, buildId, userAgent, hash, nowIso, nowIso)
      .run();
    stored++;

    // Mirror the SAME sanitized event to the error tracker so a white-screen
    // gets an alert in minutes instead of waiting for the 02:00 digest. INERT
    // until SENTRY_DSN is set — with no DSN this returns immediately.
    //
    // WHY THE RELAY GOES THROUGH HERE AND NOT THROUGH THE BROWSER. Sending
    // from the SPA would (a) bake a DSN into a public bundle, (b) hand the
    // ingest server every staff member's real IP address, and (c) create a
    // second payload path to audit. Relaying from the Worker means the ingest
    // server's only client is Cloudflare, and the values below are the ones
    // this route already sanitized and capped — the query string is gone, the
    // route is a pathname, identity is the session's numeric ids.
    captureError(
      c.env,
      new Error(message),
      {
        source: "browser",
        route,
        requestId: c.get("requestId"),
        userId,
        companyId,
        release: buildId || undefined,
        stack: stack ?? undefined,
      },
      waitUntil,
    );
  }

  return c.json({ success: true, stored });
});

// GET /summary?days=7 -- the System Health "Client Errors" panel. Super-admin
// only (matches /api/admin/health/ledger): this is IT diagnostics, and stacks +
// routes across every company are not for general staff eyes.
app.get("/summary", requirePermission("*"), async (c) => {
  const days = Math.min(Math.max(parseInt(c.req.query("days") || "7", 10) || 7, 1), 30);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const rows = await c.env.DB.prepare(
      `SELECT dedup_hash,
              MAX(message) AS message,
              MAX(route) AS route,
              MAX(build_id) AS build_id,
              SUM(count) AS n,
              COUNT(DISTINCT user_id) AS affected_users,
              MAX(last_seen_at) AS last_seen_at
         FROM client_errors
        WHERE last_seen_at >= ?
        GROUP BY dedup_hash
        ORDER BY n DESC
        LIMIT 50`,
    )
      .bind(cutoff)
      .all<{
        dedup_hash: string;
        message: string;
        route: string;
        build_id: string;
        n: number;
        affected_users: number;
        last_seen_at: string;
      }>();
    const data = (rows.results ?? []).map((r) => ({
      dedup_hash: r.dedup_hash,
      message: r.message,
      route: r.route,
      build_id: r.build_id,
      count: Number(r.n),
      affected_users: Number(r.affected_users),
      last_seen_at: r.last_seen_at,
    }));
    const totals = {
      errors: data.length,
      occurrences: data.reduce((s, r) => s + r.count, 0),
    };
    return c.json({ success: true, days, data, totals });
  } catch (e: any) {
    // The health page must stay readable even when the thing it monitors is
    // broken (systemHealth.ts contract).
    return c.json({ success: false, days, data: [], totals: { errors: 0, occurrences: 0 }, error: e?.message || "summary failed" });
  }
});

export default app;
