import { Hono } from "hono";
import type { Env } from "../types";
import {
  CONFIG_CACHE_TTL_SECONDS,
  configCacheKeyUrl,
  configCacheMatch,
  configCachePut,
} from "../services/configCache";
import { allowedCompanyIds, usersInCompaniesSql } from "../scm/lib/companyScope";

const app = new Hono<{ Bindings: Env }>();

/**
 * "Active in the last N seconds" threshold. Two full frontend heartbeat
 * intervals (60s each, see frontend usePresence HEARTBEAT_MS) so a user
 * who just missed one beat (e.g. tab switched, request retried) still
 * appears online.
 */
const ACTIVE_WINDOW_SECONDS = 120;

/**
 * "Recently here" tier for the who's-online popover: quiet for more than the
 * active window but less than this shows as "away"; past it the user drops
 * off entirely. Heartbeats only fire from VISIBLE tabs, so "away" in practice
 * means the tab is hidden/idle.
 */
const AWAY_WINDOW_SECONDS = 900;

/**
 * POST /api/presence/heartbeat
 *
 * Bumps the current user's last_seen_at to now. Called by every open
 * browser tab on a 60-second interval (and once on mount). Service
 * accounts (id=0) are skipped — presence is for real humans only.
 *
 * Body (optional): { path: "/scm/sales-orders" } — the SPA pathname the tab
 * is on, stored to users.last_path so the who's-online popover can deep-link
 * each teammate's location. Old clients send no body; COALESCE keeps the
 * previous value so a missing/invalid path never blanks it.
 */
app.post("/heartbeat", async (c) => {
  const me = c.get("user");
  if (!me || me.id === 0) return c.json({ ok: true });
  let path: string | null = null;
  try {
    const body = await c.req.json<{ path?: unknown }>();
    if (
      typeof body?.path === "string" &&
      body.path.startsWith("/") &&
      body.path.length <= 300
    ) {
      path = body.path;
    }
  } catch {
    // No / non-JSON body — pre-rollout clients. Heartbeat still counts.
  }
  await c.env.DB.prepare(
    `UPDATE users SET last_seen_at = datetime('now'), last_path = COALESCE(?, last_path) WHERE id = ?`
  )
    .bind(path, me.id)
    .run();
  return c.json({ ok: true });
});

/**
 * GET /api/presence
 *
 * Returns everyone whose last_seen_at is within the active window, plus an
 * `away` tier (quiet for 2–15 min) for the who's-online popover. The current
 * user is included with a flag so the UI can mark "(you)" without doing a
 * separate /me lookup; consumers that don't want self filter on it.
 */
app.get("/", async (c) => {
  const me = c.get("user");
  // SQLite stores as "YYYY-MM-DD HH:MM:SS" with no timezone marker;
  // strip the trailing 'Z' so the string comparison works.
  const cutoffAt = (windowSeconds: number) =>
    new Date(Date.now() - windowSeconds * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
  const activeCutoff = cutoffAt(ACTIVE_WINDOW_SECONDS);
  const awayCutoff = cutoffAt(AWAY_WINDOW_SECONDS);

  // Company scope: presence is the who's-online roster, and the roster a caller
  // may see is their OWN granted companies (allowedCompanyIds), not the active
  // one — an owner granted both switches organisation and still expects to see
  // both (owner 2026-08-19, docs/TENANT-ISOLATION-ROOT-FIX.md §6.3). Mirrors the
  // three-way allowedCompaniesSql semantics, over the users population:
  //   • UNRESOLVED (undefined) -> "" no filter (legacy / companies-master blip);
  //   • RESTRICTED TO NOTHING ([]) -> match nothing, same fail-closed as the rest
  //     of the system for a caller whose grants all point at inactive companies;
  //   • granted a set -> users in that set (usersInCompaniesSql also keeps
  //     zero-grant users visible, exactly as companyContext hands them every
  //     company — so this does NOT decide the §6.1 zero-grant question).
  const rawAllowed = allowedCompanyIds(c);
  const scopeIds = (rawAllowed ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  const companyFilter =
    rawAllowed === undefined ? "" : scopeIds.length === 0 ? " AND 1=0" : usersInCompaniesSql(scopeIds, "u");
  // The cache entry MUST be keyed on that company set — the row set is no longer
  // identical for every caller. A single shared `scope=all` key would serve one
  // company's roster to the other straight off the edge cache, which is the leak
  // this scoping exists to close.
  const scopeTag = rawAllowed === undefined ? "co=all" : scopeIds.length === 0 ? "co=none" : `co=${scopeIds.join("-")}`;

  // SHARED cache on the EDGE tier (caches.default), NOT KV — shared WITHIN a
  // company scope (scopeTag above), not across. presence is polled from every
  // open tab of every user on a 60s cadence, so uncached this was one
  // users-JOIN-roles query per user per minute, all competing for the Hyperdrive
  // connection pool; under pressure some turned into the GET /api/presence 500s
  // the client-error check surfaced.
  //
  // Why the edge cache and not KV: a first miss on a KV key is NEGATIVE-cached at
  // the edge for up to 60s, so a 15s-TTL KV entry is never read back before it
  // expires (verified live 2026-08-02: KV stayed 100% miss at 3/6/9s). The edge
  // cache is read-your-write within the same colo, so a short shared TTL actually
  // hits. Per-colo scope is fine — the win is collapsing concurrent same-colo
  // polls off the DB pool. The active/away split still re-runs per request
  // against the LIVE activeCutoff, so tiering stays correct off cached rows; only
  // someone who became active in the last 15s waits a beat to appear.
  type PresenceRow = {
    id: number; email: string | null; name: string | null; role_id: number | null;
    role_name: string | null; last_seen_at: string | null; last_path?: string | null;
  };

  const cacheKeyUrl = configCacheKeyUrl(
    new URL(c.req.url).origin,
    "presence",
    scopeTag,
    1, // no version bump: the 15s TTL is the only freshness lever presence needs
  );

  let rowList: PresenceRow[] | null = null;
  if (cacheKeyUrl) {
    const hit = await configCacheMatch(cacheKeyUrl);
    if (hit) {
      try { rowList = (await hit.json()) as PresenceRow[]; } catch { rowList = null; }
    }
  }
  c.header("x-presence-cache", rowList !== null ? "hit" : (cacheKeyUrl ? "miss" : "bypass"));

  if (rowList === null) {
    const rows = await c.env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.role_id, r.name as role_name, u.last_seen_at, u.last_path
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.last_seen_at IS NOT NULL
         AND u.last_seen_at >= ?
         AND u.status = 'active'${companyFilter}
       ORDER BY u.last_seen_at DESC`
    )
      .bind(awayCutoff)
      .all<PresenceRow>();
    rowList = rows.results ?? [];
    // Off the response path — the fill landing is not needed to answer THIS
    // request. configCachePut is a colo-local ~ms write; waitUntil keeps even
    // that off the critical path. Same shape as announcements/banner.
    if (cacheKeyUrl) {
      const fill = configCachePut(
        cacheKeyUrl,
        JSON.stringify(rowList),
        CONFIG_CACHE_TTL_SECONDS.presence,
      );
      try { c.executionCtx.waitUntil(fill); } catch { void fill; }
    }
  }
  const rows = { results: rowList };

  const toMember = (r: any) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    role_id: r.role_id,
    role_name: r.role_name,
    last_seen_at: r.last_seen_at,
    last_path: r.last_path ?? null,
    is_self: me ? r.id === me.id : false,
  });

  // Same "YYYY-MM-DD HH:MM:SS" shape on both sides, so the string compare
  // that already orders the SQL works for the tier split too.
  const all = (rows.results || []).map(toMember);
  const active = all.filter(
    (r: { last_seen_at: string }) => r.last_seen_at >= activeCutoff
  );
  const away = all.filter(
    (r: { last_seen_at: string }) => r.last_seen_at < activeCutoff
  );

  return c.json({
    active,
    away,
    count: active.length,
    window_seconds: ACTIVE_WINDOW_SECONDS,
    away_window_seconds: AWAY_WINDOW_SECONDS,
  });
});

export default app;
