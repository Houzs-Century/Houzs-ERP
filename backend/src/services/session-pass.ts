// ----------------------------------------------------------------------------
// session-pass — the APPLICATION layer over session-token: turn an AuthUser
// into a signed staff pass, and turn a verified pass back into an AuthUser.
//
// session-token.ts is the generic sign/verify primitive. THIS file knows what a
// Houzs session actually carries: the authorization envelope (role,
// permissions, page access, brand scope) that today costs two serialized DB
// reads on EVERY request. A pass carries a snapshot of that envelope so a
// request can rebuild the AuthUser locally, with no DB read, once stages 2-3
// wire it in.
//
// NO-OP WHEN UNKEYED. `sessionSigningSecret` returns null unless the owner has
// set SESSION_SIGNING_KEY. Null means the entire signed-pass path does nothing:
// login issues no pass, middleware verifies no pass, and the system runs
// EXACTLY as it did before. That is the property that lets every stage ship
// before the secret exists — the code is inert until the one action that turns
// it on. (CLAUDE.md: design around a blocker so it does not halt the rest.)
//
// WHAT IS AND IS NOT IN THE PASS. Everything that decides AUTHORIZATION is in:
// role, permissions, page_access, brand_scope, scope_to_pic, scm_l2_configured,
// org fields, status, session origin, the Title's policy row and capability
// grants (claims v2), and the authz fingerprint (stage 4 revocation compares
// against it).
//
// THE PASS IS VERSIONED (SESSION_PASS_CLAIMS_VERSION). v1 carried permissions
// and page_access but NOT position_policy / position_capabilities. Every rule
// that reads those off the AuthUser therefore saw "no policy row" on the fast
// path and fell back to its name-keyed default: moneyWriteDenial judged a
// Finance Executive by job title alone (only "Finance Manager" / "Super Admin"
// may move money by name) and refused every accounting WRITE of a full+money
// Title while every read worked — 2026-09-28, the first non-wildcard user to
// confirm a settlement row. The DB path carried the row and let the same
// person through, which is why no fixture ever saw it. A pass whose version is
// not the current one is refused by tryPassAuth, so the DB path re-mints it —
// one authoritative read per session at deploy, no re-login. Profile counters (points, streak, profile
// pic) are deliberately OUT — they are not authorization, they change often,
// and the handful of routes that read them can query them; baking them into a
// signed pass would only make the pass go stale for no security gain.
// ----------------------------------------------------------------------------
import type { AuthUser } from './auth';
import type { Env } from '../types';
import { signSessionToken, verifySessionToken, type SessionClaims } from './session-token';
import { passIsRevoked, sidFor } from './session-revocation';
import type { PositionPolicyRow } from './positionPolicyRows';

/** The claims shape this build mints and honours. Bump it whenever a field that
 *  decides authorization joins the pass: an older pass is then refused on the
 *  fast path and re-issued by the DB path, instead of authorizing with a hole. */
export const SESSION_PASS_CLAIMS_VERSION = 2;

/** 8 hours — one working day. A pass self-expires at the end of the day; the
 *  revocation list (stage 4) handles anything faster than that. Long enough
 *  that a shift never re-authorizes against the DB, short enough that a lost
 *  device is not a standing key. */
export const SESSION_PASS_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * The signing secret, or null when it is unset or too short to be safe.
 *
 * NULL DISABLES THE WHOLE FEATURE — see the file header. A key under 16 chars
 * is treated as unset rather than used, so a placeholder can never sign a real
 * pass by accident.
 */
export function sessionSigningSecret(env: unknown): string | null {
  // The cast admits undefined because callers really do pass it (the tests
  // assert sessionSigningSecret(undefined) is null) — the `?.` is load-bearing.
  const s = (env as { SESSION_SIGNING_KEY?: string } | undefined)?.SESSION_SIGNING_KEY;
  return typeof s === 'string' && s.length >= 16 ? s : null;
}

/** The authorization snapshot a pass carries. Extends the primitive's claims
 *  (which mandate `exp` and stamp `iat`). */
export interface SessionPassClaims extends SessionClaims {
  /** SESSION_PASS_CLAIMS_VERSION at issue time — see the file header. */
  v: number;
  uid: number;
  email: string;
  name: string | null;
  email_alias: string | null;
  role_id: number;
  role_name: string;
  position_id: number | null;
  position_name: string | null;
  department_id: number | null;
  department_name: string | null;
  manager_id: number | null;
  status: string;
  permissions: string[];
  page_access: Record<string, string>;
  brand_scope: string[] | null;
  scope_to_pic: boolean;
  scm_l2_configured: boolean;
  /** The Title's policy row (cohort / money / config / fleet / duty), null when
   *  the Title has none — exactly what hydrateAuthUser puts on the DB-path
   *  AuthUser, so moneyWriteDenial and friends decide the same way on both
   *  paths. Absent from v1 (see the header). */
  position_policy: PositionPolicyRow | null;
  /** The Title's operational capability grants (position_capabilities). Absent
   *  from v1, where hasPositionCapability failed closed on the fast path. */
  position_capabilities: string[];
  /** Session origin ('pos' | null). Republished by middleware exactly as the
   *  DB path does. */
  origin: string | null;
  /** authz_fingerprint at issue time. Stage 4 revocation compares against it so
   *  a role/permission change can invalidate outstanding passes. */
  fp: string | null;
  /** Session id — a hash of the opaque token (session-revocation.sidFor). The
   *  revocation board's SID level keys on this, so a logout voids just THIS
   *  device's pass and not the user's other devices. Null on a pass minted
   *  without a session (not a current path). */
  sid: string | null;
}

/** Sign an AuthUser into a staff pass. Pure: no DB, no env — the caller has
 *  already loaded the user and resolved the secret. */
export async function issueSessionPass(
  user: AuthUser,
  secret: string,
  nowMs: number,
  /** The session id from `sidFor(token)`, or null. REQUIRED (never optional):
   *  it DECIDES whether a logout can void this pass, and an absent sid silently
   *  makes the pass un-revocable-by-device. Pass explicit null only where there
   *  is genuinely no session. */
  sid: string | null,
): Promise<string> {
  const claims: SessionPassClaims = {
    exp: nowMs + SESSION_PASS_TTL_MS,
    v: SESSION_PASS_CLAIMS_VERSION,
    sid,
    uid: user.id,
    email: user.email,
    name: user.name,
    email_alias: user.email_alias ?? null,
    role_id: user.role_id,
    role_name: user.role_name,
    position_id: user.position_id,
    position_name: user.position_name,
    department_id: user.department_id,
    department_name: user.department_name ?? null,
    manager_id: user.manager_id,
    status: user.status,
    permissions: user.permissions,
    page_access: user.page_access as Record<string, string>,
    brand_scope: user.brand_scope,
    scope_to_pic: user.scope_to_pic,
    scm_l2_configured: user.scm_l2_configured,
    position_policy: user.position_policy ?? null,
    position_capabilities: user.position_capabilities ?? [],
    origin: user.session_origin ?? null,
    fp: user.authz_fingerprint ?? null,
  };
  return signSessionToken(claims, secret, nowMs);
}

/**
 * Rebuild an AuthUser from a verified pass's claims — the inverse of
 * issueSessionPass, for stage-3 middleware. `permissions_set` is reconstructed
 * because a Set does not serialize. Profile counters are absent (see header);
 * anything that needs them queries the DB, exactly as it would for a fresh
 * AuthUser that predates them.
 */
export function authUserFromPass(claims: SessionPassClaims): AuthUser {
  return {
    id: claims.uid,
    email: claims.email,
    name: claims.name,
    email_alias: claims.email_alias,
    role_id: claims.role_id,
    role_name: claims.role_name,
    position_id: claims.position_id,
    position_name: claims.position_name,
    status: claims.status,
    permissions: claims.permissions,
    permissions_set: new Set(claims.permissions),
    manager_id: claims.manager_id,
    scope_to_pic: claims.scope_to_pic,
    department_id: claims.department_id,
    department_name: claims.department_name,
    brand_scope: claims.brand_scope,
    page_access: claims.page_access as AuthUser['page_access'],
    scm_l2_configured: claims.scm_l2_configured,
    position_policy: claims.position_policy ?? null,
    position_capabilities: claims.position_capabilities,
    authz_fingerprint: claims.fp ?? undefined,
    session_origin: claims.origin,
  };
}

/**
 * The request-path entry point (stage 3): turn a signed pass into an AuthUser
 * with NO database read, or return null so the caller falls back to the DB
 * session path.
 *
 * Returns null on ANY doubt, and every one of these is a SAFE fall-through to
 * the authoritative DB path — which is exactly why the whole feature turns off
 * by simply not setting the secret:
 *   • no secret set  → the feature is off;
 *   • no pass sent   → a legacy client, or a request before stage-3 rollout;
 *   • bad / expired signature;
 *   • an older claims shape (SESSION_PASS_CLAIMS_VERSION) — re-minted by the
 *     DB path with the fields the old shape lacked;
 *   • the pass is on the revocation board (logged out, or the user's authz
 *     changed after it was issued).
 * The caller (middleware/auth.ts) then runs the existing getUserBySession path,
 * so a revoked or unverifiable pass never grants access — it only ever SKIPS
 * the DB when it is genuinely valid and current.
 */
export async function tryPassAuth(
  env: unknown,
  pass: string,
  /** The opaque session token from the request's Authorization header. The pass
   *  must belong to THIS token, so a lifted pass presented with another token is
   *  rejected. REQUIRED (never optional): it DECIDES whether the pass is bound
   *  to the caller. */
  token: string,
  nowMs: number,
): Promise<AuthUser | null> {
  const secret = sessionSigningSecret(env);
  if (!secret || !pass || !token) return null;
  const r = await verifySessionToken(pass, secret, nowMs);
  if (!r.ok) return null;
  const claims = r.claims as SessionPassClaims;
  // VERSION: a pass minted under an older claims shape is not honoured — it
  // authorized with fields missing (v1: no Title policy, no capabilities). The
  // DB path re-reads the envelope and mints a current pass, so the caller pays
  // one authoritative read and nothing else changes for them.
  if (claims.v !== SESSION_PASS_CLAIMS_VERSION) return null;
  // BINDING: sid is the hash of the token the pass was minted for. A pass whose
  // sid does not match this request's token — a stolen or mismatched pass — is
  // refused and falls back to the DB path, where the token itself is validated.
  // A pass with no sid is not trusted on the fast path either.
  if (!claims.sid || claims.sid !== (await sidFor(token))) return null;
  const iat = typeof claims.iat === 'number' ? claims.iat : 0;
  if (await passIsRevoked(env as Env, claims.uid, claims.sid, iat)) return null;
  return authUserFromPass(claims);
}
