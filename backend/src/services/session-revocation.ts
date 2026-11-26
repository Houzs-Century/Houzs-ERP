import type { Env } from '../types';

const REVOKE_TTL_SECONDS = 9 * 60 * 60;

const sidKey = (sid: string) => `sess:revoked-sid:${sid}`;
const uidKey = (uid: number) => `sess:revoked-uid:${uid}`;

/** A stable, non-reversible id for a session, derived from its opaque token, so
 *  the raw token is never a KV key. SHA-256, first 24 hex chars — collision-safe
 *  at this scale and cheap. */
export async function sidFor(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < 12; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/** Void one session's passes from now (logout). */
export async function revokeSession(env: Env, sid: string, nowMs: number): Promise<void> {
  if (!env.SESSION_CACHE) return;
  try {
    await env.SESSION_CACHE.put(sidKey(sid), String(nowMs), { expirationTtl: REVOKE_TTL_SECONDS });
  } catch { }
}

/** Void all of a user's passes from now (role change, disable). */
export async function revokeUser(env: Env, uid: number, nowMs: number): Promise<void> {
  if (!env.SESSION_CACHE) return;
  try {
    await env.SESSION_CACHE.put(uidKey(uid), String(nowMs), { expirationTtl: REVOKE_TTL_SECONDS });
  } catch { }
}

/**
 * Is a pass issued at `iatMs` for this user/session revoked? Reads both levels.
 * FAILS OPEN (returns false) on any KV error — the middleware's DB fallback is
 * the safety net, and locking the company out on a KV hiccup is the worse
 * outcome. A revoked pass is only honoured until the KV read succeeds again,
 * which is seconds.
 */
export async function passIsRevoked(
  env: Env,
  uid: number,
  sid: string | null,
  iatMs: number,
): Promise<boolean> {
  if (!env.SESSION_CACHE) return false;
  try {
    const [u, s] = await Promise.all([
      env.SESSION_CACHE.get(uidKey(uid)),
      sid ? env.SESSION_CACHE.get(sidKey(sid)) : Promise.resolve(null),
    ]);
    const uAt = u ? Number(u) : 0;
    const sAt = s ? Number(s) : 0;
    return (uAt > 0 && iatMs < uAt) || (sAt > 0 && iatMs < sAt);
  } catch {
    return false;
  }
}
