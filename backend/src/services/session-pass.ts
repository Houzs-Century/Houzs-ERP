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
  const s = (env as { SESSION_SIGNING_KEY?: string } | undefined)?.SESSION_SIGNING_KEY;
  return typeof s === 'string' && s.length >= 16 ? s : null;
}

/** The authorization snapshot a pass carries. Extends the primitive's claims
 *  (which mandate `exp` and stamp `iat`). */
export interface SessionPassClaims extends SessionClaims {
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
  position_policy: PositionPolicyRow | null;
  position_capabilities: string[];
  origin: string | null;
  fp: string | null;
  sid: string | null;
}

/** Sign an AuthUser into a staff pass. Pure: no DB, no env — the caller has
 *  already loaded the user and resolved the secret. */
export async function issueSessionPass(
  user: AuthUser,
  secret: string,
  nowMs: number,
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
  token: string,
  nowMs: number,
): Promise<AuthUser | null> {
  const secret = sessionSigningSecret(env);
  if (!secret || !pass || !token) return null;
  const r = await verifySessionToken(pass, secret, nowMs);
  if (!r.ok) return null;
  const claims = r.claims as SessionPassClaims;
  if (claims.v !== SESSION_PASS_CLAIMS_VERSION) return null;
  if (!claims.sid || claims.sid !== (await sidFor(token))) return null;
  const iat = typeof claims.iat === 'number' ? claims.iat : 0;
  if (await passIsRevoked(env as Env, claims.uid, claims.sid, iat)) return null;
  return authUserFromPass(claims);
}
