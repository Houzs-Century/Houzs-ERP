import { Hono } from "hono";
import type { Env } from "../types";

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

  // SHARED cache. The away-window row set is IDENTICAL for every caller — the
  // query does not read `me` at all (is_self is derived per request from the
  // rows below). presence is polled from every open tab of every user on a 60s
  // cadence, so uncached this was one users-JOIN-roles query per user per
  // minute, all competing for the Hyperdrive connection pool; under pressure
  // some of those turned into the GET /api/presence 500s the client-error check
  // surfaced (a KV hit needs no DB connection, so it also removes that failure
  // mode). 15s TTL collapses the whole fleet's polls into ~4 DB reads/min
  // regardless of headcount, and 15s of staleness is invisible against a 120s
  // active / 900s away window. The active/away split still re-runs per request
  // against the LIVE activeCutoff, so a teammate who just went quiet is tiered
  // correctly off the cached rows — only someone who became active in the last
  // 15s waits a beat to appear.
  const PRESENCE_CACHE_KEY = "presence:list:v1";
  const PRESENCE_CACHE_TTL_SECONDS = 15;
  type PresenceRow = {
    id: number; email: string | null; name: string | null; role_id: number | null;
    role_name: string | null; last_seen_at: string | null; last_path?: string | null;
  };

  let rowList: PresenceRow[] | null = null;
  try {
    const cached = await c.env.SESSION_CACHE?.get(PRESENCE_CACHE_KEY);
    if (cached) rowList = JSON.parse(cached) as PresenceRow[];
  } catch {
    /* fall through to the live query */
  }
  c.header("x-presence-cache", rowList !== null ? "hit" : (c.env.SESSION_CACHE ? "miss" : "bypass"));

  if (rowList === null) {
    const rows = await c.env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.role_id, r.name as role_name, u.last_seen_at, u.last_path
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.last_seen_at IS NOT NULL
         AND u.last_seen_at >= ?
         AND u.status = 'active'
       ORDER BY u.last_seen_at DESC`
    )
      .bind(awayCutoff)
      .all<PresenceRow>();
    rowList = rows.results ?? [];
    // Not awaited on the response path — the fill landing is not needed to
    // answer THIS request. Same waitUntil-with-floating-fallback shape as
    // announcements/banner and /auth/me.
    if (c.env.SESSION_CACHE) {
      const list = rowList;
      const fill = (async () => {
        try {
          await c.env.SESSION_CACHE!.put(PRESENCE_CACHE_KEY, JSON.stringify(list), {
            expirationTtl: PRESENCE_CACHE_TTL_SECONDS,
          });
        } catch {
          /* non-fatal: the next miss refills */
        }
      })();
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
