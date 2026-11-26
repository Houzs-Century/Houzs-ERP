import { Hono } from "hono";
import type { Env } from "../types";
import { allowedCompanyIds } from "../scm/lib/companyScope";
import {
  CONFIG_CACHE_TTL_SECONDS,
  configCacheKeyUrl,
  configCacheMatch,
  configCachePut,
} from "../services/configCache";

const app = new Hono<{ Bindings: Env }>();

const ACTIVE_WINDOW_SECONDS = 120;

const AWAY_WINDOW_SECONDS = 900;

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
  }
  await c.env.DB.prepare(
    `UPDATE users SET last_seen_at = datetime('now'), last_path = COALESCE(?, last_path) WHERE id = ?`
  )
    .bind(path, me.id)
    .run();
  return c.json({ ok: true });
});

app.get("/", async (c) => {
  const me = c.get("user");
  const cutoffAt = (windowSeconds: number) =>
    new Date(Date.now() - windowSeconds * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
  const activeCutoff = cutoffAt(ACTIVE_WINDOW_SECONDS);
  const awayCutoff = cutoffAt(AWAY_WINDOW_SECONDS);

  type PresenceRow = {
    id: number; email: string | null; name: string | null; role_id: number | null;
    role_name: string | null; last_seen_at: string | null; last_path?: string | null;
  };

  /* Owner decision 2026-08-19: presence is scoped by the same thing everything
     else is — the companies this caller is GRANTED, not the one their switcher
     happens to sit on. */
  const presenceCos = allowedCompanyIds(c);
  const presenceCoSql =
    presenceCos === undefined
      ? ""
      : ` AND EXISTS (SELECT 1 FROM user_companies uc WHERE uc.user_id = u.id AND uc.company_id IN (${
          presenceCos.length ? presenceCos.map((n) => Number(n)).join(",") : "-1"
        }))`;
  const scopeKey =
    presenceCos === undefined
      ? "scope=all"
      : `scope=co:${[...presenceCos].sort((a, b) => a - b).join(",")}`;
  const cacheKeyUrl = configCacheKeyUrl(
    new URL(c.req.url).origin,
    "presence",
    scopeKey,
    1,
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
         AND u.status = 'active'${presenceCoSql}
       ORDER BY u.last_seen_at DESC`
    )
      .bind(awayCutoff)
      .all<PresenceRow>();
    rowList = rows.results ?? [];
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
