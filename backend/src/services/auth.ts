import type { Env } from "../types";
import { parsePermissions } from "./permissions";
import { type AccessLevel } from "./pageAccess";
import { resolveMemberPageAccess } from "./memberPageAccess";
import {
  getCachedUser,
  setCachedUser,
  bustCachedUser,
  rememberSessionLiveness,
  forgetSessionLiveness,
  sessionLivenessFallback,
  isSessionFallbackEnabled,
  sessionFallbackTtlMs,
} from "./sessionCache";
import { applySalesJdOverride } from "./salesJdAccess";
import { issueSessionPass, sessionSigningSecret } from "./session-pass";
import { sidFor, revokeSession } from "./session-revocation";
import { positionGrantsWildcard } from "./positionPolicy";
import { policyRowFromDb, type PositionPolicyRow } from "./positionPolicyRows";


const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH = "SHA-256";
const KEY_BITS = 256;

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
    key,
    KEY_BITS
  );
  return `${bytesToB64(salt)}$${bytesToB64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored || !stored.includes("$")) return false;
  const [saltB64, hashB64] = stored.split("$");
  if (!saltB64 || !hashB64) return false;
  const salt = b64ToBytes(saltB64);
  const expected = b64ToBytes(hashB64);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
    key,
    KEY_BITS
  );
  const got = new Uint8Array(bits);
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ expected[i];
  return diff === 0;
}

/**
 * Constant-time string equality for shared-secret comparison (webhook
 * keys etc.). XOR-folds every byte so the comparison cost doesn't leak
 * how many leading characters matched. Length mismatch still returns
 * early — the secret lengths aren't sensitive here.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export function generateToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return bytesToB64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

/** "Remember me on this device" (owner 2026-09-02: "cant keep permanently?").
 *  A rolling window: the session lasts a year, and every request made with more
 *  than half of it spent pushes the expiry back to a full year again. A device
 *  in weekly use therefore never signs out; one nobody touches for a year does.
 *  Permanent in practice, self-cleaning in the abandoned case — and still
 *  revocable, since disabling the user or changing the password deletes their
 *  session rows outright. */
export const REMEMBER_TTL_SECONDS = 60 * 60 * 24 * 365;

export const AUTHZ_ENVELOPE_VERSION = 9;

export type SessionOrigin = "pos" | "field" | "password_change";
export const SESSION_ORIGIN_POS: SessionOrigin = "pos";
export const SESSION_ORIGIN_FIELD: SessionOrigin = "field";
export const SESSION_ORIGIN_PASSWORD_CHANGE: SessionOrigin = "password_change";
export const PASSWORD_CHANGE_SESSION_TTL_SECONDS = 30 * 60;

export interface AuthUser {
  id: number;
  email: string;
  name: string | null;
  email_alias?: string | null;
  role_id: number;
  role_name: string;
  position_id: number | null;
  position_name: string | null;
  position_policy?: PositionPolicyRow | null;
  status: string;
  permissions: string[];
  permissions_set: Set<string>;
  manager_id: number | null;
  scope_to_pic: boolean;
  department_id: number | null;
  department_name?: string | null;
  brand_scope: string[] | null;
  page_access: Record<string, AccessLevel>;
  position_capabilities?: string[];
  scm_l2_configured: boolean;
  authz_fingerprint?: string;
  session_origin?: string | null;
  joined_at?: string | null;
  last_login_at?: string | null;
  points_balance?: number;
  gifting_balance?: number;
  current_streak?: number;
  profile_pic_r2_key?: string | null;
}

/** Mint a session. `origin` defaults to undefined -> NULL = an ordinary
 *  office/desktop session that may price freely. Pass SESSION_ORIGIN_POS ONLY
 *  from the POS PIN door; see the SessionOrigin note above.
 *  `ttlSeconds` overrides the default 7-day lifetime — the owner-on-prod
 *  impersonation path (routes/users.ts) mints 1-hour sessions with it. */
export async function createSession(
  env: Env,
  userId: number,
  origin?: SessionOrigin,
  ttlSeconds: number = SESSION_TTL_SECONDS,
  renewSeconds: number | null = null,
): Promise<string> {
  const token = generateToken();
  const expires = isoIn(ttlSeconds);
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at, origin, renew_seconds) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(token, userId, expires, origin ?? null, renewSeconds)
    .run();
  return token;
}

async function renewRollingSession(
  env: Env,
  token: string,
  expiresAt: string | null,
  renewSeconds: number | null,
): Promise<void> {
  if (!renewSeconds || renewSeconds <= 0 || !expiresAt) return;
  const remainingMs = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(remainingMs)) return;
  if (remainingMs > (renewSeconds * 1000) / 2) return;
  try {
    await env.DB.prepare(`UPDATE sessions SET expires_at = ? WHERE token = ?`)
      .bind(isoIn(renewSeconds), token)
      .run();
  } catch (e) {
    console.warn("[auth] rolling session renewal failed", e);
  }
}

/**
 * Mint a signed staff pass for a session that was just created, or null.
 *
 * STAGE 2 of the signed-session rollout. Called from the login routes right
 * after createSession. It returns null — issuing nothing — when the signing
 * secret is unset (the feature is OFF; the deployment pays literally nothing,
 * not even a DB read) or the user cannot be loaded. When the secret IS set it
 * loads the full AuthUser ONCE and signs its authorization snapshot; a login is
 * rare, so this one read is not the per-request cost the pass exists to remove.
 *
 * The pass is returned ALONGSIDE the existing opaque token, never instead of
 * it. Nothing verifies the pass yet — stage 3 does. So this is inert on the
 * request path: a client that stores and sends the pass changes no server
 * behaviour until the middleware is taught to read it.
 */
export async function mintSessionPass(
  env: Env,
  token: string,
  nowMs: number,
): Promise<string | null> {
  if (!sessionSigningSecret(env)) return null;
  const user = await getUserBySession(env, token);
  if (!user) return null;
  return mintSessionPassFor(env, user, token, nowMs);
}

/**
 * The same pass for a user the caller has JUST read authoritatively for this
 * token — the auth middleware's DB path, which used to read the session a
 * second time here (KV + two joined reads per re-issue, HC-0002).
 */
export async function mintSessionPassFor(
  env: Env,
  user: AuthUser,
  token: string,
  nowMs: number,
): Promise<string | null> {
  const secret = sessionSigningSecret(env);
  if (!secret) return null;
  return issueSessionPass(user, secret, nowMs, await sidFor(token));
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
  await revokeSession(env, await sidFor(token), Date.now());
  await bustCachedUser(env, token);
  forgetSessionLiveness(token);
}

interface SessionAuthority {
  user_id: number;
  email: string;
  email_alias: string | null;
  name: string | null;
  status: string;
  expires_at: string | null;
  origin: string | null;
  renew_seconds?: number | null;
  role_id: number;
  position_id: number | null;
  department_id: number | null;
  manager_id: number | null;
  role_name: string;
  role_permissions: string;
  scope_to_pic: number | boolean;
  position_name: string | null;
  position_department_id: number | null;
  position_department_name: string | null;
  policy_cohort: string | null;
  policy_profile: string | null;
  policy_money: number | boolean | null;
  policy_config: number | boolean | null;
  policy_fleet: number | boolean | null;
  policy_duty: string | null;
  department_name: string | null;
}

interface AuthzComponent {
  kind: "brand" | "cap" | "page";
  owner_key: "role" | "self" | "manager" | "position";
  item_key: string;
  item_value: string;
}

function isExpiredSession(expiresAt: string | null): boolean {
  if (!expiresAt) return true;
  const expiresAtMs = Date.parse(expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

function buildAuthzFingerprint(
  authority: SessionAuthority,
  components: AuthzComponent[],
): string {
  return JSON.stringify({
    version: AUTHZ_ENVELOPE_VERSION,
    identity: [
      authority.user_id,
      authority.email,
      authority.email_alias,
      authority.name,
    ],
    role: [
      authority.role_id,
      authority.role_name,
      authority.role_permissions,
      Number(authority.scope_to_pic),
    ],
    position: [
      authority.position_id,
      authority.position_name,
      authority.position_department_id,
      authority.position_department_name,
      authority.policy_cohort ?? null,
      authority.policy_profile ?? null,
      Number(authority.policy_money ?? 0),
      Number(authority.policy_config ?? 0),
      Number(authority.policy_fleet ?? 0),
      authority.policy_duty ?? null,
    ],
    department: [authority.department_id, authority.department_name],
    brands_for: [authority.user_id, authority.manager_id],
    components: components.map((row) => [
      row.kind,
      row.owner_key,
      row.item_key,
      row.item_value,
    ]),
  });
}

function cachedIdentityMatches(
  cached: AuthUser,
  authority: SessionAuthority,
  authzFingerprint: string,
): boolean {
  return cached.id === authority.user_id
    && cached.email === authority.email
    && (cached.email_alias ?? null) === authority.email_alias
    && cached.name === authority.name
    && cached.status === "active"
    && cached.role_id === authority.role_id
    && cached.position_id === authority.position_id
    && cached.department_id === authority.department_id
    && cached.manager_id === authority.manager_id
    && cached.authz_fingerprint === authzFingerprint;
}

async function hydrateAuthUser(env: Env, row: any): Promise<AuthUser> {
  const scoped = !!row.scope_to_pic;
  const managerId: number | null = row.manager_id ?? null;
  const permissions = parsePermissions(row.role_permissions);
  const permissionsSet = new Set(permissions);
  const policyRow: PositionPolicyRow | null = policyRowFromDb({
    position_id: row.position_id,
    cohort: row.policy_cohort,
    profile: row.policy_profile,
    can_move_money: row.policy_money,
    can_write_config: row.policy_config,
    is_fleet: row.policy_fleet,
    duty: row.policy_duty,
  });
  // Position => '*' (owner 2026-07-20): a god-tier POSITION (Super Admin / Owner)
  // is a full super admin with NO roles.permissions grant — step 1 of merging role
  // + position onto ONE position-driven controller. Additive: it only ever ADDS
  // '*', so it can never strip a permission a role already grants. The injected '*'
  // then flows through the existing wildcard machinery — the page short-circuit
  // below (permissionsSet.has("*") -> fullAccessMap) and every requirePermission
  // site. Exact-name match lives in positionPolicy (never substring).
  if (!permissionsSet.has("*") && positionGrantsWildcard(row.position_name ?? null, policyRow)) {
    permissions.push("*");
    permissionsSet.add("*");
  }
  // brand_scope was the per-user brand allow-list for the project row-level ACL.
  // That ACL was removed (owner decision 2026-08-19), so nothing reads it any
  // more; it is left on the envelope as a vestigial null rather than reshaping
  // the signed-session claims contract in the same change.
  const brandScope: string[] | null = null;
  let roleRows: Array<{ page_key: string; level: string }> = [];
  if (!permissionsSet.has("*")) {
    const pageRows = await env.DB.prepare(
      `SELECT page_key, level FROM role_page_access WHERE role_id = ? ORDER BY page_key`,
    )
      .bind(row.role_id)
      .all<{ page_key: string; level: string }>();
    roleRows = pageRows.results ?? [];
  }
  const memberAccess = resolveMemberPageAccess({
    permissionsSet,
    positionId: row.position_id ?? null,
    positionName: row.position_name ?? null,
    departmentName: row.department_name ?? null,
    positionPolicy: policyRow,
    roleRows,
  });
  const pageAccess: Record<string, AccessLevel> = memberAccess.pageAccess;
  const scmL2Configured = memberAccess.scmL2Configured;

  // Actions matrix (owner 2026-08-22): the position's operational capability
  // rows ride the session envelope. A `*` caller skips the load — the guard
  // bypasses on the wildcard, so the rows would be dead weight on the hottest
  // path. Positionless users have none by definition.
  let positionCapabilities: string[] = [];
  if (row.position_id != null && !permissionsSet.has("*")) {
    const capRows = await env.DB.prepare(
      `SELECT capability FROM position_capabilities WHERE position_id = ? ORDER BY capability`,
    )
      .bind(row.position_id)
      .all<{ capability: string }>();
    positionCapabilities = (capRows.results ?? []).map((r) => r.capability);
  }

  return {
    id: row.id,
    email: row.email,
    email_alias: row.email_alias ?? null,
    name: row.name,
    role_id: row.role_id,
    role_name: row.role_name,
    position_id: row.position_id ?? null,
    position_name: row.position_name ?? null,
    status: row.status,
    permissions,
    permissions_set: permissionsSet,
    manager_id: managerId,
    scope_to_pic: scoped,
    department_id: row.department_id ?? null,
    department_name: row.department_name ?? null,
    brand_scope: brandScope,
    page_access: applySalesJdOverride(pageAccess, {
      permissions: permissionsSet,
      position_name: row.position_name ?? null,
      department_name: row.department_name ?? null,
      position_policy: policyRow,
    }),
    position_capabilities: positionCapabilities,
    position_policy: policyRow,
    scm_l2_configured: scmL2Configured,
    session_origin: row.origin ?? null,
    joined_at: row.joined_at ?? null,
    last_login_at: row.last_login_at ?? null,
    points_balance: row.points_balance ?? 0,
    gifting_balance: row.gifting_balance ?? 0,
    current_streak: row.current_streak ?? 0,
    profile_pic_r2_key: row.profile_pic_r2_key ?? null,
  };
}

export async function getUserBySession(env: Env, token: string): Promise<AuthUser | null> {
  const fallbackEnabled = isSessionFallbackEnabled(env);
  const fallbackTtlMs = fallbackEnabled
    ? sessionFallbackTtlMs(env)
    : 0;

  const settled = Promise.allSettled([
    getCachedUser(env, token),
    env.DB.prepare(
      `SELECT s.user_id, s.expires_at, s.origin, s.renew_seconds,
              u.email, u.email_alias, u.name,
              u.status, u.role_id, u.position_id, u.department_id, u.manager_id,
              r.name AS role_name, r.permissions AS role_permissions,
              r.scope_to_pic,
              p.name AS position_name,
              p.department_id AS position_department_id,
              pd.name AS position_department_name,
              pp.cohort AS policy_cohort, pp.profile AS policy_profile,
              pp.can_move_money AS policy_money, pp.can_write_config AS policy_config,
              pp.is_fleet AS policy_fleet, pp.duty AS policy_duty,
              d.name AS department_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN positions p ON p.id = u.position_id
       LEFT JOIN departments pd ON pd.id = p.department_id
       LEFT JOIN position_policy pp ON pp.position_id = u.position_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE s.token = ?`
    )
      .bind(token)
      .first<SessionAuthority>(),
    env.DB.prepare(
      `WITH principal AS (
         SELECT u.id AS user_id, u.role_id, u.manager_id, u.position_id
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ?
       )
       SELECT 'brand' AS kind, 'self' AS owner_key,
              ub.brand AS item_key, '' AS item_value
       FROM principal pr
       JOIN user_brands ub ON ub.user_id = pr.user_id
       UNION ALL
       SELECT 'brand' AS kind, 'manager' AS owner_key,
              ub.brand AS item_key, '' AS item_value
       FROM principal pr
       JOIN user_brands ub ON ub.user_id = pr.manager_id
       UNION ALL
       SELECT 'cap' AS kind, 'position' AS owner_key,
              pc.capability AS item_key, '' AS item_value
       FROM principal pr
       JOIN position_capabilities pc ON pc.position_id = pr.position_id
       UNION ALL
       SELECT 'page' AS kind, 'role' AS owner_key,
              rpa.page_key AS item_key, rpa.level AS item_value
       FROM principal pr
       JOIN role_page_access rpa ON rpa.role_id = pr.role_id
       ORDER BY kind, owner_key, item_key, item_value`
    )
      .bind(token)
      .all<AuthzComponent>(),
  ]);

  const [cachedResult, authorityResult, componentResult] = await settled;

  const cached: AuthUser | null =
    cachedResult.status === "fulfilled" ? cachedResult.value : null;

  if (authorityResult.status === "rejected" || componentResult.status === "rejected") {
    if (fallbackEnabled) {
      const fallback = sessionLivenessFallback(token, Date.now(), fallbackTtlMs);
      if (fallback) return fallback;
    }
    throw authorityResult.status === "rejected"
      ? authorityResult.reason
      : (componentResult as PromiseRejectedResult).reason;
  }

  const authority: SessionAuthority | null = authorityResult.value;
  const componentRows: D1Result<AuthzComponent> = componentResult.value;

  if (!authority) {
    forgetSessionLiveness(token);
    await bustCachedUser(env, token);
    return null;
  }

  if (authority.status !== "active" || isExpiredSession(authority.expires_at)) {
    forgetSessionLiveness(token);
    await deleteSession(env, token);
    return null;
  }

  await renewRollingSession(env, token, authority.expires_at, authority.renew_seconds ?? null);

  const authzFingerprint = buildAuthzFingerprint(
    authority,
    componentRows.results ?? [],
  );

  if (cached && cachedIdentityMatches(cached, authority, authzFingerprint)) {
    cached.session_origin = authority.origin;
    if (fallbackEnabled) rememberSessionLiveness(token, cached);
    return cached;
  }

  if (cached) {
    await bustCachedUser(env, token);
  }

  let row: any;
  try {
    row = await env.DB.prepare(
      `SELECT u.id, u.email, u.email_alias, u.name, u.role_id, u.status,
              u.manager_id, u.department_id, u.position_id, u.joined_at, u.last_login_at,
              u.points_balance, u.gifting_balance, u.current_streak,
              u.profile_pic_r2_key,
              r.name as role_name, r.permissions as role_permissions,
              r.scope_to_pic,
              p.name as position_name,
              pp.cohort as policy_cohort, pp.profile as policy_profile,
              pp.can_move_money as policy_money, pp.can_write_config as policy_config,
              pp.is_fleet as policy_fleet, pp.duty as policy_duty,
              d.name as department_name,
              s.expires_at, s.origin
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN positions p ON p.id = u.position_id
       LEFT JOIN position_policy pp ON pp.position_id = u.position_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE s.token = ?`
    )
      .bind(token)
      .first<any>();
  } catch (err) {
    if (fallbackEnabled) {
      const fallback = sessionLivenessFallback(token, Date.now(), fallbackTtlMs);
      if (fallback) return fallback;
    }
    throw err;
  }

  if (!row) {
    forgetSessionLiveness(token);
    await bustCachedUser(env, token);
    return null;
  }
  if (row.status !== "active" || isExpiredSession(row.expires_at)) {
    forgetSessionLiveness(token);
    await deleteSession(env, token);
    return null;
  }

  const user = await hydrateAuthUser(env, row);
  user.authz_fingerprint = authzFingerprint;
  await setCachedUser(env, token, user);
  if (fallbackEnabled) rememberSessionLiveness(token, user);
  return user;
}

export async function getUserById(env: Env, id: number): Promise<AuthUser | null> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.email_alias, u.name, u.role_id, u.status, u.manager_id,
            u.department_id, u.position_id,
            u.points_balance, u.gifting_balance, u.current_streak,
            u.profile_pic_r2_key,
            r.name as role_name, r.permissions as role_permissions,
            r.scope_to_pic,
            p.name as position_name,
              pp.cohort as policy_cohort, pp.profile as policy_profile,
              pp.can_move_money as policy_money, pp.can_write_config as policy_config,
              pp.is_fleet as policy_fleet, pp.duty as policy_duty,
            d.name as department_name
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN positions p ON p.id = u.position_id
     LEFT JOIN position_policy pp ON pp.position_id = u.position_id
     LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.id = ?`
  )
    .bind(id)
    .first<any>();
  if (!row) return null;
  return hydrateAuthUser(env, row);
}

/**
 * Sweep expired sessions opportunistically. Cheap; called from /me.
 */
export async function pruneExpiredSessions(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`)
    .bind(new Date().toISOString())
    .run();
}
