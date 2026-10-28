import { Hono } from "hono";
import type { Env } from "../types";
import { checkRateLimit, clientIp } from "../middleware/rateLimit";

// Public customer-satisfaction survey. Accessed via a one-off token;
// no login required. Mounted OUTSIDE the /api/* auth middleware so
// external customers can reach it — the token is the only gate, so
// expiry is enforced on every read AND every write (see isExpired).

const app = new Hono<{ Bindings: Env }>();

/**
 * The token is 128-bit and unguessable, but this route echoes back
 * assr_no / customer_name / doc_no, so a leaked link is a standing PII
 * disclosure. Fail CLOSED: a row with no expires_at is treated as
 * expired, not as "never expires".
 *
 * That inverts what mig 015 documented ("null = never expires"), and
 * on its own it would retire every legacy token at once. mig 0126
 * backfills them to created_at + 90d first, and deploy.yml runs
 * pg-migrate BEFORE wrangler deploy, so the rows are stamped by the
 * time this code is live. After that a NULL can only mean a mint path
 * that forgot to set a TTL — which is the exact bug being fixed here,
 * and must not be readable.
 *
 * An unparseable stamp is expired for the same reason: on an
 * unauthenticated surface, "I cannot tell" has to resolve to "no".
 */
function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return true;
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return true;
  return t < Date.now();
}

// ── Get public case info for the survey screen ────────────────
app.get("/:token", async (c) => {
  // This route had no limiter at all while /api/track — the sibling
  // public surface — has had one since day one. Same shape and per-IP
  // like track's, but note the limiter fails OPEN when KV is unbound
  // and is explicitly not a security boundary: the token check above
  // is what protects the data, this only slows bulk probing.
  const limited = await checkRateLimit(c, "survey_read", clientIp(c), 30, 900);
  if (limited) return limited;

  const token = c.req.param("token");
  const row = await c.env.DB.prepare(
    `SELECT t.token, t.submitted_at, t.expires_at,
            a.assr_no, a.customer_name, a.doc_no, a.complained_date,
            a.satisfaction_rating, a.satisfaction_notes
       FROM assr_survey_tokens t
       JOIN assr_cases a ON a.id = t.assr_id
      WHERE t.token = ?`
  )
    .bind(token)
    .first<{
      token: string;
      submitted_at: string | null;
      expires_at: string | null;
      assr_no: string;
      customer_name: string | null;
      doc_no: string;
      complained_date: string | null;
      satisfaction_rating: number | null;
      satisfaction_notes: string | null;
    }>();
  // Unknown and expired deliberately share one response so the token
  // space cannot be probed for which cases exist. This 404 has always
  // said "not found or expired" — as of now that is true.
  if (!row) return c.json({ error: "Survey not found or expired" }, 404);
  if (isExpired(row.expires_at)) {
    return c.json({ error: "Survey not found or expired" }, 404);
  }

  return c.json({
    already_submitted: !!row.submitted_at,
    assr_no: row.assr_no,
    customer_name: row.customer_name,
    doc_no: row.doc_no,
    complained_date: row.complained_date,
    existing_rating: row.satisfaction_rating,
    existing_notes: row.satisfaction_notes,
  });
});

// ── Submit the survey ─────────────────────────────────────────
app.post("/:token", async (c) => {
  // company-scope: capability token, not a session. The bearer resolves through assr_survey_tokens to ONE assr_id (:104-109) and every write below binds THAT id (:127, :140) or the token itself (:133) — never a route param. A stronger scope than a company predicate. Verified 2026-08-19.
  const limited = await checkRateLimit(c, "survey_submit", clientIp(c), 20, 900);
  if (limited) return limited;

  const token = c.req.param("token");
  // A malformed body threw raw before reaching the rating check, which
  // surfaced as a 500 on a public route rather than the 400 below.
  const body = await c.req
    .json<{ rating?: number; notes?: string }>()
    .catch(() => ({}) as { rating?: number; notes?: string });

  if (!body.rating || body.rating < 1 || body.rating > 5) {
    return c.json({ error: "Rating must be 1–5" }, 400);
  }
  // Cap free-text like every other portal write path.
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 2000) || null : null;

  const tok = await c.env.DB.prepare(
    `SELECT t.assr_id, t.submitted_at, t.expires_at
       FROM assr_survey_tokens t
      WHERE t.token = ?`
  )
    .bind(token)
    .first<{ assr_id: number; submitted_at: string | null; expires_at: string | null }>();
  if (!tok) return c.json({ error: "Survey not found" }, 404);
  // The GET is what leaks, but this is the path that WRITES
  // satisfaction_rating onto the case — an expired token must not be
  // able to move a KPI a year after the fact.
  if (isExpired(tok.expires_at)) {
    return c.json({ error: "Survey not found or expired" }, 404);
  }
  if (tok.submitted_at) return c.json({ error: "Survey already submitted" }, 409);

  // Write the rating back onto the case, mark the token as used, and
  // log to the case timeline so Service Admins see the feedback.
  await c.env.DB.prepare(
    `UPDATE assr_cases
        SET satisfaction_rating = ?, satisfaction_notes = ?, updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(body.rating, notes, tok.assr_id)
    .run();

  await c.env.DB.prepare(
    `UPDATE assr_survey_tokens SET submitted_at = datetime('now') WHERE token = ?`
  )
    .bind(token)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO assr_activity (assr_id, action, from_value, to_value, note, user_id)
     VALUES (?, 'survey_submitted', NULL, ?, ?, NULL)`
  )
    .bind(tok.assr_id, String(body.rating), notes)
    .run();

  return c.json({ ok: true });
});

export default app;
