import type { Env } from "../types";
import type { AuthUser } from "./auth";

// KV-backed cache for the hydrated session user. Every authenticated request
// currently runs a 3-table JOIN (sessions+users+roles) + a page-access load +
// (for scoped users) a brands query. Caching the assembled AuthUser per session
// token removes those round-trips on the hot path — the single biggest latency
// win available (pattern from Hookka's rbac KV cache).
//
// Safety: this is a pure optimization layer. Every op is wrapped so any KV
// miss/error/absence falls straight through to the DB path — worst case is
// today's behaviour. The binding is OPTIONAL, so the vitest suite (no KV bound)
// exercises the fallback and must stay green.
//
// Freshness: 60s TTL for the hydrated permission/page/brand envelope and
// display-only fields. Session validity plus every DB value that shapes authz
// (user/mail identity, role permissions/scope, page rows, position/department
// identity, the user+manager brand sets, and the code policy revision) is
// fingerprinted authoritatively on every request.
// A mismatch rehydrates immediately, so KV invalidation is only an efficiency
// aid and can never extend revoked access.

const TTL_SECONDS = 60;
const keyFor = (token: string) => `sess:${token}`;

export async function getCachedUser(env: Env, token: string): Promise<AuthUser | null> {
  if (!env.SESSION_CACHE) return null;
  try {
    const raw = await env.SESSION_CACHE.get(keyFor(token));
    if (!raw) return null;
    const u = JSON.parse(raw) as AuthUser;
    // Set does not survive JSON — rebuild the O(1) permission lookup mirror.
    u.permissions_set = new Set(u.permissions ?? []);
    return u;
  } catch {
    return null; // any cache trouble → caller falls back to the DB
  }
}

export async function setCachedUser(env: Env, token: string, user: AuthUser): Promise<void> {
  if (!env.SESSION_CACHE) return;
  try {
    await env.SESSION_CACHE.put(keyFor(token), JSON.stringify(user), {
      expirationTtl: TTL_SECONDS,
    });
  } catch {
    /* non-fatal: next request just re-reads from the DB */
  }
}

export async function bustCachedUser(env: Env, token: string): Promise<void> {
  if (!env.SESSION_CACHE) return;
  try {
    await env.SESSION_CACHE.delete(keyFor(token));
  } catch {
    /* non-fatal */
  }
}

// Bust the cached user for EVERY live session of a user. Disable / password
// reset / role change delete session ROWS in bulk (DELETE ... WHERE user_id=?)
// but bypass deleteSession(), so the per-token `sess:<token>` cache entries
// would otherwise survive until TTL. Call this BEFORE the bulk delete (it reads
// the live tokens), then bust each key to avoid retaining useless KV entries.
// `exceptToken` keeps the caller's own session cached (self password-change
// revokes only the others). Best-effort: an invalidation failure affects cache
// efficiency only; getUserBySession still rejects deleted/disabled sessions via
// its authoritative D1 gate.
export async function bustUserSessions(env: Env, userId: number, exceptToken?: string): Promise<void> {
  if (!env.SESSION_CACHE) return;
  try {
    const rows = await env.DB.prepare(`SELECT token FROM sessions WHERE user_id = ?`)
      .bind(userId)
      .all<{ token: string }>();
    for (const r of rows.results ?? []) {
      if (exceptToken && r.token === exceptToken) continue;
      await env.SESSION_CACHE.delete(keyFor(r.token));
    }
  } catch {
    /* non-fatal */
  }
}

// ── Bounded liveness fallback — OFF unless SESSION_FALLBACK_ENABLED="true" ──
// This Houzs DB layer has recurring brief blips (cold-start 503, Supavisor
// pooler hiccups). getUserBySession validates EVERY request against the DB, so
// a blip made the authoritative read throw and logged the whole company out
// until it cleared — pure fail-closed. The trade this offers, for an
// invite-only ERP of a few dozen users: a BOUNDED (<= TTL) revocation delay in
// exchange for availability. On a DB-read FAILURE during session validation we
// may re-serve the LAST result the DB authoritatively confirmed "active" for
// this token, but ONLY while that result is younger than the configured TTL;
// otherwise we still fail closed.
//
// IT IS A SECURITY-RELEVANT RELAXATION, SO IT IS A SWITCH, AND THE SWITCH IS
// OFF BY DEFAULT (owner requirement, approved 2026-07-22). When it is off the
// code path is not taken at all: getUserBySession neither consults the fallback
// nor records liveness, so a DB read failure fails closed exactly as it did
// before this mechanism existed, and the map stays empty. See
// isSessionFallbackEnabled below and the wrangler.toml [vars] comment for the
// operator instructions.
//
// Why a per-isolate in-memory Map — not KV, and not the SESSION_CACHE envelope:
//   - It must help precisely WHEN THE DB IS UNREACHABLE, so it must add no new
//     awaited round-trip on the failure path — a Map read is synchronous.
//   - The rule is "younger than TTL since the last SUCCESSFUL read". Only a
//     per-read timestamp expresses that. KV's expirationTtl is stamped at WRITE
//     time, and the SESSION_CACHE envelope is NOT rewritten on the fast path
//     (cache-hit + fingerprint match), so neither one's age tracks liveness.
//   - It is written ONLY after an authoritative read confirmed the session is
//     live, so its size is bounded by the count of active sessions (dozens) and
//     an unknown/invalid token can never populate it.
// It is a pure availability aid: it can only ever re-serve a session the DB most
// recently CONFIRMED active, and only inside the TTL window. Every authoritative
// revocation forgets the entry (see getUserBySession + deleteSession), so once
// the DB is reachable again a revoked session is rejected immediately — the
// delay is capped at the TTL and only occurs while the DB stays down.

// ── The switch (env var, the repo's established mechanism for an ops toggle:
// AUTOCOUNT_SYNC_DISABLED / COSTING_DISPLAY_ENABLED / HOUZS_OWNS_2990 all work
// this way, parsed by a one-function helper with a documented default). It
// deliberately is NOT a DB row (the D8 no-deploy kill switch): this decision is
// made ON THE PATH WHERE THE DATABASE IS UNREACHABLE, so a DB-backed switch
// could not be read at the only moment it matters. ──────────────────────────

/** Default when SESSION_FALLBACK_TTL_MS is unset/invalid. 60s, not a law. */
export const SESSION_FALLBACK_DEFAULT_TTL_MS = 60_000;
/** Clamp: below this the fallback cannot cover a real blip; above it the
 *  revocation delay stops being "bounded" in any useful sense. */
export const SESSION_FALLBACK_MIN_TTL_MS = 1_000;
export const SESSION_FALLBACK_MAX_TTL_MS = 300_000;

/** The env shape the switch reads — satisfied structurally by the worker `Env`
 *  and by a test literal. */
export interface SessionFallbackEnv {
  SESSION_FALLBACK_ENABLED?: string;
  SESSION_FALLBACK_TTL_MS?: string;
}

/** Whether the bounded liveness fallback may run at all. FAIL-CLOSED: OFF
 *  unless the var is explicitly "true" (case/space tolerant). An absent,
 *  empty, misspelt or garbage value is OFF, so no environment can acquire a
 *  relaxed revocation rule by accident — the opposite polarity to
 *  isCostingDisplayEnabled, whose absence-default is ON because absence there
 *  must not HIDE data. Here absence must not RELAX a security control. */
export function isSessionFallbackEnabled(
  env: SessionFallbackEnv | null | undefined,
): boolean {
  return (env?.SESSION_FALLBACK_ENABLED ?? "").trim().toLowerCase() === "true";
}

/** How long a DB-confirmed liveness entry may be re-served during an outage.
 *  Same clamped-with-default shape the app_settings numeric knobs use
 *  (agents/collection-agent.ts chaseThresholdDays): anything non-finite or out
 *  of range falls back to the default rather than failing the request. */
export function sessionFallbackTtlMs(
  env: SessionFallbackEnv | null | undefined,
): number {
  const n = Number(env?.SESSION_FALLBACK_TTL_MS);
  if (
    !Number.isFinite(n) ||
    n < SESSION_FALLBACK_MIN_TTL_MS ||
    n > SESSION_FALLBACK_MAX_TTL_MS
  ) {
    return SESSION_FALLBACK_DEFAULT_TTL_MS;
  }
  return Math.floor(n);
}

interface SessionLivenessEntry {
  user: AuthUser;
  ts: number;
}

const sessionLiveness = new Map<string, SessionLivenessEntry>();

// Counts consultations of sessionLivenessFallback. Incremented on the outage
// path only (never on the hot path), and read by the suite to prove that with
// the switch OFF the fallback is not consulted at all — "off" means the branch
// is not entered, not that its answer is discarded.
let sessionLivenessConsultations = 0;

/** Record a session an authoritative DB read just confirmed active. `now` is
 *  injectable for deterministic tests; production always uses the real clock. */
export function rememberSessionLiveness(
  token: string,
  user: AuthUser,
  now: number = Date.now(),
): void {
  sessionLiveness.set(token, { user, ts: now });
}

/** Drop a session the DB authoritatively reported gone / disabled / expired, so
 *  a later DB blip can never re-serve it from the fallback. */
export function forgetSessionLiveness(token: string): void {
  sessionLiveness.delete(token);
}

/** Consulted ONLY when the authoritative session read FAILED (DB unreachable)
 *  AND the switch is on. Returns the last DB-confirmed AuthUser iff it is
 *  younger than `ttlMs`; a stale entry is evicted and null returned so the
 *  caller fails closed. */
export function sessionLivenessFallback(
  token: string,
  now: number = Date.now(),
  ttlMs: number = SESSION_FALLBACK_DEFAULT_TTL_MS,
): AuthUser | null {
  sessionLivenessConsultations += 1;
  const entry = sessionLiveness.get(token);
  if (!entry) return null;
  if (now - entry.ts >= ttlMs) {
    sessionLiveness.delete(token);
    return null;
  }
  return entry.user;
}

/** Test-only: clear the per-isolate fallback map for isolation between cases. */
export function __resetSessionLivenessForTest(): void {
  sessionLiveness.clear();
  sessionLivenessConsultations = 0;
}

/** Test-only observability. `consultations` proves whether the fallback was
 *  reached at all; `size` proves whether liveness was recorded at all. Both
 *  must stay 0 for a whole request cycle when the switch is off. */
export function __sessionLivenessStatsForTest(): {
  consultations: number;
  size: number;
} {
  return { consultations: sessionLivenessConsultations, size: sessionLiveness.size };
}
