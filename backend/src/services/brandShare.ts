// Brand calendar share links — the unguessable token behind each brand's
// public, no-login calendar. Same three moves as services/contractorShare.ts
// (mint get-or-create, resolve, revoke) over `brand_share_tokens`. The token IS
// the credential; `revoked_at` is the kill switch. The token grants a read of
// exactly ONE brand's confirmed events — the brand NAME lives on the token row,
// never in the request, and the public route filters `projects.brand` by it.
import type { Env } from "../types";
import { generateToken } from "./auth";

export async function getActiveBrandShareToken(env: Env, brand: string): Promise<string | null> {
  const name = brand.trim();
  if (!name) return null;
  const row = await env.DB.prepare(
    `SELECT token FROM brand_share_tokens
      WHERE brand = ? AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(name)
    .first<{ token: string }>();
  return row?.token ?? null;
}

/** Get-or-create: repeated "copy link" clicks reuse the live token. */
export async function issueBrandShareToken(env: Env, brand: string, userId: number | null): Promise<string> {
  const name = brand.trim();
  const existing = await getActiveBrandShareToken(env, name);
  if (existing) return existing;
  const token = generateToken(24);
  await env.DB.prepare(
    `INSERT INTO brand_share_tokens (token, brand, created_by)
     VALUES (?, ?, ?)`
  )
    .bind(token, name, userId)
    .run();
  return token;
}

/** Kill every live link for a brand. "Regenerate" = revoke, then copy again. */
export async function revokeBrandShareTokens(env: Env, brand: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE brand_share_tokens SET revoked_at = datetime('now')
      WHERE brand = ? AND revoked_at IS NULL`
  )
    .bind(brand.trim())
    .run();
}

/**
 * Resolve a token to the brand NAME it grants a read of, or null when empty,
 * unknown, or revoked. Revoked folds into null on purpose — a leaked link must
 * not learn that it once worked.
 */
export async function resolveBrandShareToken(env: Env, token: string): Promise<string | null> {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT brand, revoked_at FROM brand_share_tokens WHERE token = ?`
  )
    .bind(token)
    .first<{ brand: string; revoked_at: string | null }>();
  if (!row) return null;
  if (row.revoked_at) return null;
  return row.brand;
}
