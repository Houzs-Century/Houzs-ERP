// Contractor calendar share links — the unguessable token behind each
// contractor's public, no-login calendar. Modeled on services/caseTracking.ts:
// mint (get-or-create), resolve, revoke, and read-the-current-one for the admin
// panel. The token IS the credential; `revoked_at` is the kill switch for a
// leaked link. The token grants a read of exactly ONE contractor's confirmed
// schedule — the contractor NAME lives on the token row, never in the request.
import type { Env } from "../types";
import { generateToken } from "./auth";

/**
 * The current live token for a contractor, or null. Used by the admin panel so
 * the existing link shows without minting a new one — and so a revoked link
 * stops displaying where it would be copied from.
 */
export async function getActiveShareToken(env: Env, contractor: string): Promise<string | null> {
  const name = contractor.trim();
  if (!name) return null;
  const row = await env.DB.prepare(
    `SELECT token FROM contractor_share_tokens
      WHERE contractor = ? AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(name)
    .first<{ token: string }>();
  return row?.token ?? null;
}

/**
 * Get-or-create: reuse the contractor's live token if one exists, otherwise mint
 * a fresh 192-bit one. Idempotent, so repeated "copy link" clicks don't litter
 * the table with dead tokens.
 */
export async function issueShareToken(
  env: Env,
  contractor: string,
  userId: number | null
): Promise<string> {
  const name = contractor.trim();
  const existing = await getActiveShareToken(env, name);
  if (existing) return existing;
  const token = generateToken(24);
  await env.DB.prepare(
    `INSERT INTO contractor_share_tokens (token, contractor, created_by)
     VALUES (?, ?, ?)`
  )
    .bind(token, name, userId)
    .run();
  return token;
}

/**
 * Kill every live link for a contractor. "Regenerate" = revoke then issue, so a
 * leaked link dies the moment the office presses it. Returns void: a revoked
 * count would only invite the wrong "revoked 0 = 404" branch (revoking a
 * never-shared contractor is a legitimate no-op).
 */
export async function revokeShareTokens(env: Env, contractor: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE contractor_share_tokens SET revoked_at = datetime('now')
      WHERE contractor = ? AND revoked_at IS NULL`
  )
    .bind(contractor.trim())
    .run();
}

/**
 * Resolve a token to the contractor NAME it grants a read of, or null when the
 * token is empty, unknown, or revoked. Revoked is folded into the null answer on
 * purpose — a leaked link must not learn that it once worked. The empty-token
 * guard matters because this is the gate for an unauthenticated surface.
 */
export async function resolveShareToken(env: Env, token: string): Promise<string | null> {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT contractor, revoked_at FROM contractor_share_tokens WHERE token = ?`
  )
    .bind(token)
    .first<{ contractor: string; revoked_at: string | null }>();
  if (!row) return null;
  if (row.revoked_at) return null;
  return row.contractor;
}
