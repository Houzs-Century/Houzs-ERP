// ----------------------------------------------------------------------------
// session-revocation — the "cancelled passes" board.
//
// A signed staff pass (session-pass.ts) is verified LOCALLY with no DB read, so
// nothing about a pass tells us whether the person was disabled, their role
// changed, or that device logged out AFTER the pass was signed. This board is
// what makes de-authorization instant instead of waiting out the 8h pass TTL.
//
// TWO LEVELS, because "log this one device out" and "revoke this person" are
// different blast radii:
//   • SID  (one session/device) — set on logout, so logging out on a phone does
//     NOT force the same user's desktop back onto the DB path.
//   • UID  (one user)           — set on a role/permission change or a disable,
//     which must void every device that person holds.
// Each stores a timestamp; a pass whose issued-at (iat) is OLDER than the
// timestamp is void. A pass minted AFTER the event (a fresh login, or a
// re-issue) has a newer iat and is honoured, so revocation self-clears without
// a delete.
//
// STORE: env.SESSION_CACHE, the same KV the session cache uses. TTL = pass TTL
// + 1h buffer — past that window every pass has expired on its own and the
// entry is dead weight.
//
// FAILS OPEN ON READ, on purpose. A KV blip must not lock everyone out; the
// middleware's DB fallback is the real safety net, and a genuine revocation is
// re-asserted on the next event. FAILS SILENT ON WRITE for the same reason a
// cache bust does — a revocation that could not be recorded is retried by the
// next mutation, and the pass expires in 8h regardless.
// ----------------------------------------------------------------------------
import type { Env } from '../types';

/** Pass TTL (8h, session-pass.ts) + 1h buffer. */
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
  } catch { /* best-effort — see header */ }
}

/** Void all of a user's passes from now (role change, disable). */
export async function revokeUser(env: Env, uid: number, nowMs: number): Promise<void> {
  if (!env.SESSION_CACHE) return;
  try {
    await env.SESSION_CACHE.put(uidKey(uid), String(nowMs), { expirationTtl: REVOKE_TTL_SECONDS });
  } catch { /* best-effort — see header */ }
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
