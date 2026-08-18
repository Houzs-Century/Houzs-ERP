import type { Env } from "../types";
import { generateToken, isoIn } from "./auth";
import { cleanPhone } from "./autocount";
import { normalizePhone } from "../scm/shared/phone";
import {
  assrCustomerStatus,
  type AssrStageColor,
} from "../scm/shared/assr-stage-labels";

// Per-case tokenised tracking. Three flows produce a token:
//   1. Customer hits /track, enters ASSR number + phone → server
//      verifies the pair matches, issues a 30-min token.
//   2. Staff hits the "Copy portal link" button on a case → server
//      issues a PERMANENT token (shareable via WhatsApp without the
//      customer having to type anything; Nick 2026-07-07 — links must
//      keep working forever, mig 0076 extended the existing ones).
//   3. Staff hits "Sales Portal Link" — same permanent per-case token
//      but source='sales'; the portal renders the salesperson
//      variant (full stage progress, comments attributed to sales).
//
// In all flows the token grants access to ONE case only. The
// middleware resolves the token to an `assr_id` which scopes every
// subsequent portal API query.

export const CUSTOMER_TTL_SECONDS = 60 * 30;            // 30 minutes
// Staff/sales links never expire. Stored as a far-future ISO stamp so
// the existing `expires_at > now` reads keep working without a schema
// change (expires_at is NOT NULL).
//
// The unbounded lifetime is a product decision, not an oversight: the
// link is pasted into WhatsApp and the customer reopens it months
// later to check their case (Nick 2026-07-07, mig 0076). A TTL would
// break that flow for everyone to contain the rare forwarded link, and
// the token is 192-bit CSPRNG scoped to one assr_id, so there is
// nothing enumerable to bound. The answer to a leaked link is
// revokeCaseTokens() below (mig 0126 revoked_at) -- permanent by
// default, killable on demand.
export const PERMANENT_EXPIRES_AT = "9999-12-31T23:59:59.000Z";

export type TrackSource = "customer" | "staff" | "sales";

export interface TrackedCase {
  assr_id: number;
  source: TrackSource;
  verified_phone: string | null;
}

// ── Token issuance ──────────────────────────────────────────

async function issueToken(
  env: Env,
  assrId: number,
  source: TrackSource,
  verifiedPhone: string | null,
  expiresAt: string
): Promise<string> {
  const token = generateToken(24);
  await env.DB.prepare(
    `INSERT INTO case_track_tokens (token, assr_id, source, verified_phone, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(token, assrId, source, verifiedPhone, expiresAt)
    .run();
  return token;
}

/**
 * Compare two phone strings as the SAME NUMBER regardless of how either side
 * was written.
 *
 * This used to be `cleanPhone(a) !== cleanPhone(b)`, and cleanPhone only
 * strips `+ & - space`. That reconciles punctuation and nothing else, so it
 * could not see across the country-code boundary:
 *
 *     customer types  "012-345 6789"  -> cleanPhone -> "0123456789"
 *     case stores     "+60123456789"  -> cleanPhone -> "60123456789"
 *                                                       ^^ never equal
 *
 * A Malaysian writing their own number writes the leading `0`; the API stores
 * E.164. So the public tracking form rejected the customer's own number and
 * answered "No matching case", which reads as "we have no record of you"
 * rather than "you typed it in the wrong format" — and there is no format
 * hint on the form, because there was not supposed to be a wrong one.
 *
 * normalizePhone() is the module that already knows this mapping (drop the
 * `0`, prepend `60`, keep an explicit `+xx` country code untouched). Running
 * BOTH sides through it makes the comparison format-blind in both directions,
 * which matters because rows written before the normalising write paths
 * existed still hold the local `0…` form.
 *
 * Falls back to cleanPhone equality when normalizePhone declines a value
 * (too short, non-numeric): a legacy row we cannot normalise must still match
 * itself, so this can only ever ADD matches, never remove one that worked.
 */
export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (na !== null && nb !== null) return na === nb;
  const ca = cleanPhone(a);
  return ca !== "" && ca === cleanPhone(b);
}

/**
 * Public /track entry. Returns { token, assr_id } on success or null
 * if the case number / phone pair doesn't match any case. The phone is
 * compared with phonesMatch(), which is blind to BOTH punctuation and the
 * local-`0` / `+60` split — see that function for why cleanPhone alone was
 * not enough.
 */
export async function verifyAndIssueCustomerToken(
  env: Env,
  assrNo: string,
  phone: string
): Promise<{ token: string; assr_id: number; assr_no: string } | null> {
  const asNum = assrNo.trim();
  const cleaned = cleanPhone(phone);
  if (!asNum || !cleaned) return null;

  const row = await env.DB.prepare(
    `SELECT id, phone FROM assr_cases WHERE assr_no = ?`
  )
    .bind(asNum)
    .first<{ id: number; phone: string | null }>();
  if (!row) return null;
  if (!row.phone) return null;
  if (!phonesMatch(row.phone, phone)) return null;

  // The token records the phone in its canonical form when we have one, so a
  // later audit of who opened a case reads consistently no matter how the
  // customer typed it. Falls back to the punctuation-stripped form.
  const stamped = normalizePhone(phone) ?? cleaned;
  const token = await issueToken(env, row.id, "customer", stamped, isoIn(CUSTOMER_TTL_SECONDS));
  return { token, assr_id: row.id, assr_no: asNum };
}

/**
 * Staff-generated token for sharing with a customer directly.
 * Idempotent: if an unexpired staff token already exists for this
 * case, returns it instead of minting a new one. Prevents the staff
 * UI from generating a fresh URL every time the dispatcher reopens
 * the case panel.
 */
export async function issueStaffToken(env: Env, assrId: number): Promise<string> {
  // `revoked_at IS NULL` is what makes revocation a rotation rather
  // than a permanent lockout: without it the reuse branch would hand
  // back the very token that was just killed, so the button would
  // return a dead link forever.
  const existing = await env.DB.prepare(
    `SELECT token FROM case_track_tokens
      WHERE assr_id = ? AND source = 'staff'
        AND revoked_at IS NULL
        AND expires_at > datetime('now')
      ORDER BY created_at DESC
      LIMIT 1`
  )
    .bind(assrId)
    .first<{ token: string }>();
  if (existing) return existing.token;
  return issueToken(env, assrId, "staff", null, PERMANENT_EXPIRES_AT);
}

/**
 * Sales-portal token — same shape as the staff token but the portal
 * renders the salesperson variant for it. Idempotent per case for
 * the same reason issueStaffToken is.
 */
export async function issueSalesToken(env: Env, assrId: number): Promise<string> {
  // Excludes revoked rows for the same reason issueStaffToken does.
  const existing = await env.DB.prepare(
    `SELECT token FROM case_track_tokens
      WHERE assr_id = ? AND source = 'sales'
        AND revoked_at IS NULL
        AND expires_at > datetime('now')
      ORDER BY created_at DESC
      LIMIT 1`
  )
    .bind(assrId)
    .first<{ token: string }>();
  if (existing) return existing.token;
  return issueToken(env, assrId, "sales", null, PERMANENT_EXPIRES_AT);
}

/**
 * Read-only lookup — returns the current staff token for this case
 * (or null). Used by the staff UI on panel-open so the existing
 * portal link displays without requiring the user to click anything.
 */
export async function getActiveStaffToken(env: Env, assrId: number): Promise<string | null> {
  // A revoked link must stop displaying in the staff panel too -- the
  // panel is where someone copies it from, so showing a dead token
  // here would just re-share it.
  const row = await env.DB.prepare(
    `SELECT token FROM case_track_tokens
      WHERE assr_id = ? AND source = 'staff'
        AND revoked_at IS NULL
        AND expires_at > datetime('now')
      ORDER BY created_at DESC
      LIMIT 1`
  )
    .bind(assrId)
    .first<{ token: string }>();
  return row?.token ?? null;
}

// ── Resolution ──────────────────────────────────────────────

export async function resolveTrackToken(
  env: Env,
  token: string
): Promise<TrackedCase | null> {
  // An empty token must never reach the lookup: `WHERE token = ''`
  // would match any row a bad mint left with a blank token, and this
  // is the gate for an unauthenticated surface.
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT assr_id, source, verified_phone, expires_at, revoked_at
       FROM case_track_tokens WHERE token = ?`
  )
    .bind(token)
    .first<{
      assr_id: number;
      source: TrackSource;
      verified_phone: string | null;
      expires_at: string;
      revoked_at: string | null;
    }>();
  if (!row) return null;
  // Revoked is checked before expiry and the row is kept, not deleted:
  // staff need to see that the link existed and when it was killed,
  // and the expiry branch below would delete the evidence.
  if (row.revoked_at) return null;
  if (row.expires_at < new Date().toISOString()) {
    // Expired — opportunistic cleanup.
    await env.DB.prepare(`DELETE FROM case_track_tokens WHERE token = ?`)
      .bind(token)
      .run();
    return null;
  }
  return {
    assr_id: row.assr_id,
    source: row.source,
    verified_phone: row.verified_phone,
  };
}

// ── Revocation ──────────────────────────────────────────────

/**
 * Kill every live portal link for a case. The answer to "that
 * WhatsApp link went to the wrong group" -- before this the only
 * remedy was hand-editing case_track_tokens.
 *
 * Revokes ALL sources at once (staff, sales, and any in-flight 30-min
 * customer session) rather than taking a source argument: a link that
 * leaked was forwarded, and nobody revoking in a hurry knows which of
 * the three the recipient is holding. Killing one and leaving the
 * others open would be a half-remedy that reads as a whole one.
 *
 * Returns void, deliberately. A revoked-count is available and honest
 * here (d1-compat populates meta.changes from postgres.js's `.count`
 * for non-RETURNING writes), but exposing it would invite the caller to
 * branch on it -- and the obvious branch, "revoked 0 links so 404", is
 * wrong: a case whose links were never generated, or were revoked
 * twice, is a legitimate no-op and not a failure. Success/throw is the
 * whole contract, so there is no count to misread.
 */
export async function revokeCaseTokens(env: Env, assrId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE case_track_tokens
        SET revoked_at = datetime('now')
      WHERE assr_id = ?
        AND revoked_at IS NULL`
  )
    .bind(assrId)
    .run();
}

// ── Status mapping (customer-facing, server-authoritative) ──

/**
 * What the customer's portal calls this stage.
 *
 * THE WORDS ARE NOT HERE ANY MORE. This used to be a hand-written switch, and
 * being hand-written in a layer the print route and the frontend could not
 * reach is exactly why four more copies grew and why this one — the only
 * CUSTOMER-facing copy — was the one that never learned `voided` and rendered
 * the raw database slug. The table now lives in scm/shared/assr-stage-labels.ts,
 * mirrored to frontend/src/vendor/scm/lib, where every surface can reach it and
 * where check-shared-mirrors.mjs --strict referees the two copies.
 *
 * Kept as a named export because portal.ts calls it three times and the name
 * says what it is for: the answer for a CUSTOMER, not the app's wording.
 */
export function customerStatusFor(stage: string | null | undefined): {
  label: string;
  color: AssrStageColor;
} {
  return assrCustomerStatus(stage);
}
