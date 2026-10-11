import type { Env } from "../types";
import { parsePermissions } from "./permissions";
import {
  loadPageAccessForRole,
  fullAccessMap,
  type AccessLevel,
  type PageAccessMeta,
} from "./pageAccess";
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
import { isScopedProjectUser } from "./projectAcl";
import { applySalesJdOverride } from "./salesJdAccess";
import { resolvePositionPolicy, positionGrantsWildcard } from "./positionPolicy";

// ── Crypto helpers ────────────────────────────────────────
// PBKDF2 via Web Crypto — built into Workers, no WASM needed.

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
  // constant-time compare
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

// ── Token helpers ────────────────────────────────────────
// 32 random bytes → URL-safe base64. Used for both session and
// invitation tokens.
export function generateToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return bytesToB64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

// ── Session helpers ──────────────────────────────────────
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// Bump whenever code changes the meaning/resolution of an AuthUser permission
// envelope without a corresponding DB value changing. Including this revision
// in the per-request fingerprint makes every pre-policy cache entry stale on
// its first request after deploy instead of waiting for KV TTL.
export const AUTHZ_ENVELOPE_VERSION = 1;

/* Session ORIGIN (mig 0120) — the DOOR a session was minted at. It is NOT a
   property of the person: the same salesperson simultaneously holds a 'pos'
   session on the showroom tablet and an origin-less one on their own phone,
   both for the SAME public.users row. That is precisely why the POS pricing
   envelope (scm/routes/mfg-sales-orders.ts isPosTabletCaller) cannot be
   derived from the user, their position, or their scm.staff role — only from
   the session.

   WHY IT IS UNFORGEABLE: the value is chosen server-side by whichever route
   calls createSession, and stored on the session row. It never appears in a
   request, so a caller can no more assert its origin than it can assert its
   own user_id. Holding a 'pos' session requires passing the PIN gate at
   /api/pos/pin-login; a client cannot opt OUT of one either, because omitting
   something it never sent changes nothing. This is the property the
   self-asserted `X-Client` header it replaced never had.

   `undefined` (every non-POS door) stores NULL, which reads as not-POS — the
   pre-migration behaviour, and the safe direction. Keep this a closed union:
   a new origin must be a deliberate edit here, not a string a route invents. */
export type SessionOrigin = "pos";
export const SESSION_ORIGIN_POS: SessionOrigin = "pos";

export interface AuthUser {
  id: number;
  email: string;
  name: string | null;
  /** The member's outward Mail Center alias (users.email_alias, mig 0039). Lets
   *  the member compose/reply FROM their own address in the Mail Center. null
   *  when none assigned. */
  email_alias?: string | null;
  role_id: number;
  role_name: string;
  /** Position = department×position org unit (mig 094). When set, page_access is
   *  resolved from resolvePositionPolicy (services/positionPolicy.ts) at session
   *  load — the single page-access source for a positioned user; the old 4-level
   *  position_page_access matrix is NO LONGER read for them (see hydrateAuthUser
   *  below). When null, the user falls back to the legacy role matrix during the
   *  transition. */
  position_id: number | null;
  position_name: string | null;
  status: string;
  permissions: string[];
  /** O(1) lookup mirror of `permissions`. Hydrated once at session
   *  load so every `requirePermission` middleware call is a Set hit
   *  instead of a linear array scan. */
  permissions_set: Set<string>;
  /** Who this user reports to. Drives project-level ACL when scope_to_pic=1. */
  manager_id: number | null;
  /** Role flag — if true, project endpoints filter to pic_id IN (self, manager). */
  scope_to_pic: boolean;
  /** Department membership — drives the brand allow-list below. */
  department_id: number | null;
  /** Department NAME (departments.name via u.department_id). STABLE ORG FIELD
   *  used by the code-keyed Sales access model (see services/pmsAccess.ts
   *  isSalesUser) — matched case-insensitively on "sales" because prod names
   *  the dept "Sales Department" while the seed is "Sales" (same rule as
   *  salesTeam.syncSalesRepFromUser). Hydrated once per session alongside
   *  position_name; null when the user has no department assigned. Optional so
   *  hand-built AuthUser literals (tests, SERVICE_USER) don't need to set it. */
  department_name?: string | null;
  /**
   * Brand allow-list for scoped users — null when the role isn't
   * scope_to_pic (admins, ops, finance). Empty array when the user is
   * scoped but their department has no brands assigned — that user
   * sees no projects until an admin configures the dept.
   */
  brand_scope: string[] | null;
  /**
   * Per-page access map. Hydrated from `role_page_access` (mig 073) +
   * fallback to `computeBackfillLevel` for any page without an explicit
   * row. Drives the `requirePageAccess` middleware on gated routes and
   * the frontend `usePageAccess` hook. Phase 1 wires Sales only; other
   * pages migrate in follow-up slices.
   */
  page_access: Record<string, AccessLevel>;
  /**
   * True iff this user's resolved page access explicitly configures an `scm*`
   * area. For a positioned user this is `policy.scmConfigured` from
   * resolvePositionPolicy (services/positionPolicy.ts); for a positionless user
   * it means AT LEAST ONE explicit `scm*` row in role_page_access. Drives the
   * SAFE L2 SCM write-gate rollout: a user with NO explicit SCM config is NOT
   * enforced by `scmAreaGuard` and falls back to the coarse `scm.access`
   * umbrella (allow), so no current SCM user is locked out before the matrix is
   * configured. Only users WITH explicit SCM config get per-area enforcement.
   * Owner (`*`) bypasses the guard entirely, so this stays false for them.
   */
  scm_l2_configured: boolean;
  /**
   * Stable fingerprint of every DB value that shapes this cached authorization
   * envelope. getUserBySession recomputes it from authoritative tables on every
   * request, so permission/page/org/brand revocations do not wait for KV TTL or
   * best-effort invalidation. Optional for pre-deploy KV entries and hand-built
   * AuthUser test fixtures; a missing value is treated as stale.
   */
  authz_fingerprint?: string;
  /**
   * Origin of the SESSION this user was loaded from — 'pos' or null (mig
   * 0120, see SessionOrigin above). It rides AuthUser ONLY because AuthUser is
   * what the per-token KV cache serialises; the cache is keyed by token, so
   * this is cached at exactly the right granularity and never bleeds between a
   * person's devices. It is NOT a fact about the user.
   *
   * DO NOT read this field to gate anything: inside /api/scm/* the SCM auth
   * bridge overwrites `user` wholesale with a pinned system staff row, so it
   * is not even reachable there. Read the `sessionOrigin` context var that
   * middleware/auth republishes — that is the one channel the bridge leaves
   * alone.
   *
   * Null on any AuthUser not built from a session row (getUserById, the
   * SERVICE_USER literal) and on any session cached by a pre-0120 isolate —
   * all of which read as not-POS, the safe direction. Optional so hand-built
   * AuthUser literals don't need to set it.
   */
  session_origin?: string | null;
  joined_at?: string | null;
  last_login_at?: string | null;
  // Houzs Points (mig 055) — small per-user counters.
  points_balance?: number;
  gifting_balance?: number;
  current_streak?: number;
  // Profile picture (mig 058) — R2 key inside POD_BUCKET.
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
): Promise<string> {
  const token = generateToken();
  const expires = isoIn(ttlSeconds);
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at, origin) VALUES (?, ?, ?, ?)`
  )
    .bind(token, userId, expires, origin ?? null)
    .run();
  return token;
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
  // Bust the cached user immediately so logout / forced-expiry takes effect now
  // rather than waiting out the 60s TTL. Also forget the in-memory liveness
  // fallback so a same-isolate logout cannot be re-served during a DB blip
  // (cross-isolate entries are still bounded by the fallback TTL).
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
  department_name: string | null;
}

interface AuthzComponent {
  kind: "page" | "brand";
  owner_key: "role" | "self" | "manager";
  item_key: string;
  item_value: string;
}

function isExpiredSession(expiresAt: string | null): boolean {
  if (!expiresAt) return true;
  const expiresAtMs = Date.parse(expiresAt);
  // A malformed expiry must fail closed. Treating it as live would turn bad
  // data into an unbounded session.
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

function buildAuthzFingerprint(
  authority: SessionAuthority,
  components: AuthzComponent[],
): string {
  // The query orders all collection rows. JSON is intentional here: this is a
  // deterministic equality token, not a secret or a client-controlled value,
  // so hashing would add CPU/async overhead without improving authorization.
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

// Builds the AuthUser shape from the row returned by the SELECT below
// + a follow-up brand fetch when the user is scoped.
//
// Brand allow-list is per-person via user_brands (mig 049). Effective
// scope is the UNION of the user's own brands plus their direct
// manager's brands — the same one-hop rule used for pic_ids. This
// lets a Sales Director set brands once at their level and have their
// reps inherit visibility automatically; a rep can still hold extra
// brands directly if they specialise outside the manager's coverage.
async function hydrateAuthUser(env: Env, row: any): Promise<AuthUser> {
  const scoped = !!row.scope_to_pic;
  const managerId: number | null = row.manager_id ?? null;
  const permissions = parsePermissions(row.role_permissions);
  const permissionsSet = new Set(permissions);
  // Position => '*' (owner 2026-07-20): a god-tier POSITION (Super Admin / Owner)
  // is a full super admin with NO roles.permissions grant — step 1 of merging role
  // + position onto ONE position-driven controller. Additive: it only ever ADDS
  // '*', so it can never strip a permission a role already grants. The injected '*'
  // then flows through the existing wildcard machinery — the page short-circuit
  // below (permissionsSet.has("*") -> fullAccessMap) and every requirePermission
  // site. Exact-name match lives in positionPolicy (never substring).
  if (!permissionsSet.has("*") && positionGrantsWildcard(row.position_name ?? null)) {
    permissions.push("*");
    permissionsSet.add("*");
  }
  // Owner 2026-07-15 — hydrate the brand allow-list not only for `scope_to_pic`
  // roles but for the whole code-keyed project-scoped cohort (isScopedProjectUser
  // = scope_to_pic OR a non-director Sales user). Some Sales positions lack the
  // scope_to_pic flag; without brands the project list's PIC arm can't match and
  // they'd fall back to attendee-only. Classify off the STABLE ORG FIELDS
  // already on `row` (position_name / department_name) + the parsed permissions.
  const brandScoped = isScopedProjectUser({
    scope_to_pic: scoped,
    permissions_set: permissionsSet,
    position_name: row.position_name ?? null,
    department_name: row.department_name ?? null,
  } as AuthUser);
  let brandScope: string[] | null = null;
  if (brandScoped) {
    const ids = managerId ? [row.id, managerId] : [row.id];
    // env.DB (not getDb): auth must keep working on the D1 fallback used by
    // the test suite and the rollback path, where no DATABASE_URL is bound.
    // DISTINCT dedups brands listed on both the rep and the manager.
    const placeholders = ids.map(() => "?").join(", ");
    const res = await env.DB.prepare(
      `SELECT DISTINCT brand FROM user_brands WHERE user_id IN (${placeholders})`
    )
      .bind(...ids)
      .all<{ brand: string }>();
    brandScope = (res.results ?? []).map((r) => r.brand);
  }
  // Page-access SOURCE (owner-directed 2026-07-18, services/positionPolicy.ts):
  // ONE authoritative policy for ALL 17 positions — the old matrix + a separate
  // sales rule are BOTH gone for a positioned user.
  //   - `*` wildcard              → fullAccessMap() (UNCHANGED — never narrowed).
  //   - positioned, non-`*` user  → resolvePositionPolicy(), not position_page_access:
  //       · cohort "restricted" → the owner's explicit whitelist. Its explicit
  //         scm* rows set `explicitScm` through the SAME resolver the table used,
  //         so the area-guard enforces the whitelist's `none` denials (a
  //         Storekeeper can VIEW inventory but every stock write 403s).
  //       · cohort "sales" → the sales whitelist (prod rows + SALES_JD leaves),
  //         resolved in-policy — FOLDED IN, no longer deferred to the matrix. The
  //         scm.sales row sets `explicitScm` TRUE, so the delivery/invoices `view`
  //         caps stay enforced at the area-guard exactly as before. Proven
  //         byte-identical to the old matrix + applySalesJdOverride resolution
  //         (positionPolicy.test.ts). applySalesJdOverride still composes below,
  //         now IDEMPOTENT for positioned sales — load-bearing only for the
  //         positionless Sales-department fallback the policy cannot reach.
  //       · cohort "full" (everyone else / unclassified) → fullAccessMap()
  //         (owner's interim "暂时都可以看到系统里的所有内容"; fail-OPEN — an
  //         unclassified position lands here, never on a lockout).
  //   - positionless non-`*` user → the legacy role matrix (transition fallback,
  //     unchanged — a positionless user never reaches the position policy).
  //
  // `scmMeta.explicitScm` drives AuthUser.scm_l2_configured. It is FALSE on the
  // full + `*` branches (a full map needs no per-area enforcement — same as `*`),
  // TRUE for a restricted whitelist that configured scm* areas, and TRUE for sales
  // (the scm.sales row) — the same signal a Sales position carries today.
  const scmMeta: PageAccessMeta = { explicitScm: false };
  let pageAccess: Record<string, AccessLevel>;
  if (permissionsSet.has("*")) {
    pageAccess = fullAccessMap();
  } else if (row.position_id != null) {
    // ALL 17 positioned cohorts resolve HERE now — full, restricted, AND sales.
    // The policy is the single page-access source; the legacy position matrix is
    // no longer read for a positioned user. (loadPageAccessForPosition survives
    // only for the positionless role-matrix fallback below.)
    const policy = resolvePositionPolicy({
      position_name: row.position_name ?? null,
      department_name: row.department_name ?? null,
    });
    pageAccess = policy.pageAccess;
    scmMeta.explicitScm = policy.scmConfigured;
  } else {
    pageAccess = await loadPageAccessForRole(env, row.role_id, permissionsSet, scmMeta);
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
    // Sales JD override composes over the resolved map. Since the fold, the
    // positioned sales cohort ALREADY carries these SALES_JD levels from the
    // policy, so this is now IDEMPOTENT for them (re-spreading the same values).
    // It is retained for the ONE case the position policy cannot reach: a user in
    // a Sales DEPARTMENT with no position_id, hydrated from the legacy role matrix
    // just above — for whom this is still the sole source of the JD levels. No-op
    // for `*` and for anyone outside the Sales cohort, so it stays safe on every
    // non-`*` branch. The old operationJdAccess override is GONE (2026-07-18):
    // under default-full the operation cohort is full anyway, and for the
    // restricted Storekeeper / Supervisor it was WRONG — it granted warehouse-write
    // edit the owner's manual denies them.
    page_access: applySalesJdOverride(pageAccess, {
      permissions: permissionsSet,
      position_name: row.position_name ?? null,
      department_name: row.department_name ?? null,
    }),
    scm_l2_configured: scmMeta.explicitScm,
    // sessions.origin — present only on the getUserBySession row (that SELECT
    // already joins `sessions`, so this costs no extra round-trip). getUserById
    // has no session, so `row.origin` is absent there and this lands null =
    // not-POS.
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
  // The bounded DB-outage liveness fallback is OFF unless SESSION_FALLBACK_ENABLED
  // is "true" (see sessionCache.ts). Resolved ONCE here and used as the guard on
  // every fallback site below, so with the switch off neither
  // sessionLivenessFallback nor rememberSessionLiveness is called at all: a DB
  // read failure fails closed exactly as it did before the fallback existed, and
  // no per-isolate liveness state accumulates. forgetSessionLiveness stays
  // UNGUARDED on purpose — it only ever removes state, so entries recorded while
  // the switch was on are still dropped by an authoritative revocation after it
  // is turned off.
  const fallbackEnabled = isSessionFallbackEnabled(env);
  const fallbackTtlMs = fallbackEnabled
    ? sessionFallbackTtlMs(env)
    : 0; /* unused while disabled */

  // The KV value caches expensive permission/page/brand hydration, but is not
  // authoritative for session validity or authorization. Pair it with two
  // indexed DB reads so identity and every authz dependency are current on the
  // next request, even when a best-effort KV bust fails or is delayed. Run all
  // reads in parallel so a cache hit costs max(KV, DB), not KV + DB latency.
  //
  // allSettled, NOT all: `Promise.all` rejects the instant the FIRST input
  // rejects and abandons the others still in flight. On the DB-outage path that
  // is exactly what happens — the DB reads reject while the KV read is still
  // pending, and the function returns from the bounded fallback below with a
  // live KV operation left dangling. In workerd that op then settles outside the
  // request that started it (in tests, outside the isolated-storage frame, which
  // is what "Failed to pop isolated storage stack frame" reports). Settling all
  // three keeps the same parallelism and the same max(KV, DB) latency while
  // guaranteeing no storage promise outlives this call.
  const settled = Promise.allSettled([
    getCachedUser(env, token),
    env.DB.prepare(
      `SELECT s.user_id, s.expires_at, s.origin,
              u.email, u.email_alias, u.name,
              u.status, u.role_id, u.position_id, u.department_id, u.manager_id,
              r.name AS role_name, r.permissions AS role_permissions,
              r.scope_to_pic,
              p.name AS position_name,
              p.department_id AS position_department_id,
              pd.name AS position_department_name,
              d.name AS department_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN positions p ON p.id = u.position_id
       LEFT JOIN departments pd ON pd.id = p.department_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE s.token = ?`
    )
      .bind(token)
      .first<SessionAuthority>(),
    // One stable, cross-database result set captures collection-valued authz
    // dependencies without PostgreSQL-only aggregation or a page×brand join.
    env.DB.prepare(
      `WITH principal AS (
         SELECT u.id AS user_id, u.role_id, u.manager_id
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ?
       )
       SELECT 'page' AS kind, 'role' AS owner_key,
              rpa.page_key AS item_key, rpa.level AS item_value
       FROM principal pr
       JOIN role_page_access rpa ON rpa.role_id = pr.role_id
       UNION ALL
       SELECT 'brand' AS kind, 'self' AS owner_key,
              ub.brand AS item_key, '' AS item_value
       FROM principal pr
       JOIN user_brands ub ON ub.user_id = pr.user_id
       UNION ALL
       SELECT 'brand' AS kind, 'manager' AS owner_key,
              ub.brand AS item_key, '' AS item_value
       FROM principal pr
       JOIN user_brands ub ON ub.user_id = pr.manager_id
       ORDER BY kind, owner_key, item_key, item_value`
    )
      .bind(token)
      .all<AuthzComponent>(),
  ]);

  // The two DB reads above are the AUTHORITATIVE session-validity check. If they
  // THROW, the DB layer is unreachable (cold-start 503, Supavisor hiccup) — the
  // session is not proven invalid. With the fallback switch ON, re-serve this
  // token iff the DB most recently CONFIRMED it active within the TTL; with the
  // switch OFF (the default) we never look, and fail closed. Only the two DB
  // results gate that decision, so a cache-layer problem can never be mistaken
  // for a DB outage.
  const [cachedResult, authorityResult, componentResult] = await settled;

  // getCachedUser swallows its own errors and resolves null, so a rejection here
  // is not expected; treat one as a cache miss rather than a session failure.
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
    // Session row is gone — an authoritative revoke. Forget the fallback entry
    // so a subsequent DB blip can never re-serve it.
    forgetSessionLiveness(token);
    await bustCachedUser(env, token);
    return null;
  }

  if (authority.status !== "active" || isExpiredSession(authority.expires_at)) {
    forgetSessionLiveness(token);
    await deleteSession(env, token);
    return null;
  }

  const authzFingerprint = buildAuthzFingerprint(
    authority,
    componentRows.results ?? [],
  );

  if (cached && cachedIdentityMatches(cached, authority, authzFingerprint)) {
    // Session origin belongs to the authoritative row. Re-publish it so an
    // old cache payload can never decide the request's origin.
    cached.session_origin = authority.origin;
    // The DB just CONFIRMED this session active — record it so a later DB blip
    // can re-serve it for up to the fallback TTL. Only while the switch is on;
    // off means no state is accumulated at all.
    if (fallbackEnabled) rememberSessionLiveness(token, cached);
    return cached;
  }

  if (cached) {
    // A role/org assignment changed while invalidation was unavailable. Do not
    // grant the stale permission envelope; rebuild it below.
    await bustCachedUser(env, token);
  }

  // The session/user could change between the authority read and hydration.
  // This read runs only AFTER the authoritative validity reads above succeeded,
  // but a transient DB failure here still gets the same bounded-fallback
  // treatment rather than logging the caller out mid-blip.
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
              d.name as department_name,
              s.expires_at, s.origin
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN positions p ON p.id = u.position_id
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

  // Re-check the full row before caching it.
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
  // Authoritatively hydrated + confirmed active — record for the bounded blip
  // fallback, but only when the switch is on.
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
            d.name as department_name
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN positions p ON p.id = u.position_id
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
