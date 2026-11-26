import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import { audit } from "../services/audit";
import { getUserById } from "../services/auth";
import { usersHoldingPermission } from "../services/permissionHolders";
import { postPersonalNotice } from "../services/personalNotice";
import { jsonKeys, leakCheckPaths, SECRET_KEY, SENSITIVE_KEY } from "../services/mcp-access";
import {
  actionsEnabled,
  appLabel,
  createCode,
  getAuthRequest,
  getClient,
  hasMcpAccess,
  issueTokens,
  MCP_ADMIN_PERMISSION,
  randomToken,
  revokeToken,
  revokeUserTokens,
  setActionsEnabled,
  takeAuthRequest,
} from "../services/mcp-store";
import { isMcpAdmin, mcpAppRoutes, publicOrigin, readEndpoint } from "./mcp";

type HonoEnv = { Bindings: Env };
const app = new Hono<HonoEnv>();

const num = (r: Record<string, unknown>, k: string): number => Number(r[k] ?? 0);
const s = (r: Record<string, unknown>, k: string): string => (r[k] === null || r[k] === undefined ? "" : String(r[k]));
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

function denyUnlessAdmin(c: Context<HonoEnv>): Response | null {
  return isMcpAdmin(c.get("user")) ? null : c.json({ error: "Only the AI Connector admin can do that." }, 403);
}

const connectorUrl = (c: Context<HonoEnv>): string =>
  `${publicOrigin(c.req.header("x-forwarded-host"), (c.env as Env & { MCP_PUBLIC_ORIGIN?: string }).MCP_PUBLIC_ORIGIN || new URL(c.req.url).origin)}/api/mcp`;


app.get("/me", async (c) => {
  const u = c.get("user");
  const db = c.env.DB;
  const admin = isMcpAdmin(u);
  const allowed = await hasMcpAccess(db, u.id, admin);
  const pending = await db.prepare("SELECT id, created_at FROM mcp_access_requests WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").bind(u.id).first<Record<string, unknown>>();
  const apps = await db
    .prepare(
      `SELECT t.id, t.created_at, t.last_used_at, cl.client_name
         FROM mcp_tokens t LEFT JOIN mcp_oauth_clients cl ON cl.client_id = t.client_id
        WHERE t.user_id = ? AND t.revoked_at IS NULL AND t.refresh_expires_at > ? AND t.client_id <> 'mcpc_leak_check'
        ORDER BY t.created_at DESC`,
    )
    .bind(u.id, new Date().toISOString())
    .all<Record<string, unknown>>();
  return c.json({
    allowed,
    isAdmin: admin,
    pendingRequest: pending ? { id: s(pending, "id"), createdAt: iso(pending.created_at) } : null,
    connectorUrl: connectorUrl(c),
    apps: apps.results.map((r) => ({ tokenId: s(r, "id"), app: appLabel(s(r, "client_name")), connectedAt: iso(r.created_at), lastUsedAt: iso(r.last_used_at) })),
  });
});

app.post("/me/request", async (c) => {
  const u = c.get("user");
  const db = c.env.DB;
  if (await hasMcpAccess(db, u.id, isMcpAdmin(u))) return c.json({ ok: true, alreadyAllowed: true });
  const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
  const existing = await db.prepare("SELECT id FROM mcp_access_requests WHERE user_id = ? AND status = 'pending'").bind(u.id).first();
  if (existing) return c.json({ ok: true, alreadyRequested: true });
  const id = `mcpr_${randomToken(12)}`;
  await db
    .prepare("INSERT INTO mcp_access_requests (id, user_id, reason, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
    .bind(id, u.id, typeof body.reason === "string" ? body.reason.slice(0, 300) : null, new Date().toISOString())
    .run();
  await audit(c, { action: "ai_connector.request", entityType: "ai_connector", entityId: u.id, summary: `${u.name} asked for AI Connector access` });
  try {
    const [lit, wild] = await Promise.all([usersHoldingPermission(c.env, MCP_ADMIN_PERMISSION, {}), usersHoldingPermission(c.env, "*", {})]);
    const audience = [...new Set([...lit, ...wild].map(Number))].filter((n) => n > 0 && n !== u.id);
    if (audience.length) {
      await postPersonalNotice(c.env, {
        userIds: audience,
        category: "GENERAL",
        title: `${u.name} asked to use the AI Connector`,
        body: "Approve or reject on System > AI Connector (read-only access to the ERP from Claude / ChatGPT, with their own permissions).",
        source: "ai_connector",
      });
    }
  } catch (e) {
    console.error("[mcpAdmin] notify failed:", e);
  }
  return c.json({ ok: true, id });
});

app.post("/me/revoke", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { tokenId?: unknown };
  if (typeof body.tokenId !== "string") return c.json({ error: "tokenId required" }, 400);
  const n = await revokeToken(c.env.DB, body.tokenId, c.get("user").id);
  return c.json({ ok: true, revoked: n });
});


function ordinarySession(c: Context<HonoEnv>): boolean {
  return !c.get("sessionOrigin");
}

app.get("/consent/:id", async (c) => {
  if (!ordinarySession(c)) return c.json({ error: "Sign in with your own staff account to connect an AI app." }, 403);
  const req = await getAuthRequest(c.env.DB, c.req.param("id"));
  if (!req) return c.json({ error: "This connect request has expired. Start again from the AI app." }, 404);
  const cl = await getClient(c.env.DB, req.clientId);
  const u = c.get("user");
  return c.json({
    app: appLabel(cl?.clientName ?? ""),
    clientName: cl?.clientName ?? "AI app",
    redirectHost: (() => {
      try {
        return new URL(req.redirectUri).host;
      } catch {
        return "";
      }
    })(),
    user: { name: u.name, email: u.email },
    allowed: await hasMcpAccess(c.env.DB, u.id, isMcpAdmin(u)),
  });
});

app.post("/consent/:id", async (c) => {
  if (!ordinarySession(c)) return c.json({ error: "Sign in with your own staff account to connect an AI app." }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { decision?: unknown };
  const u = c.get("user");
  const allow = body.decision === "allow";
  if (allow && !(await hasMcpAccess(c.env.DB, u.id, isMcpAdmin(u)))) return c.json({ error: "AI Connector is not turned on for your account yet." }, 403);
  const req = await takeAuthRequest(c.env.DB, c.req.param("id"));
  if (!req) return c.json({ error: "This connect request has expired. Start again from the AI app." }, 404);
  const back = new URL(req.redirectUri);
  if (req.state) back.searchParams.set("state", req.state);
  if (!allow) {
    back.searchParams.set("error", "access_denied");
    return c.json({ redirect: back.toString() });
  }
  const code = await createCode(c.env.DB, { clientId: req.clientId, userId: u.id, redirectUri: req.redirectUri, codeChallenge: req.codeChallenge });
  back.searchParams.set("code", code);
  const cl = await getClient(c.env.DB, req.clientId);
  await audit(c, { action: "ai_connector.connect", entityType: "ai_connector", entityId: u.id, summary: `${u.name} connected ${appLabel(cl?.clientName ?? "")}` });
  return c.json({ redirect: back.toString() });
});


app.get("/admin/overview", async (c) => {
  const denied = denyUnlessAdmin(c);
  if (denied) return denied;
  const db = c.env.DB;
  const nowIso = new Date().toISOString();
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  const [requests, connected, allowed, calls, staff, stats, actionsOn] = await Promise.all([
    db
      .prepare(
        `SELECT r.id, r.user_id, r.reason, r.created_at, u.name, u.email, p.name AS position_name
           FROM mcp_access_requests r JOIN users u ON u.id = r.user_id LEFT JOIN positions p ON p.id = u.position_id
          WHERE r.status = 'pending' ORDER BY r.created_at`,
      )
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT t.id, t.user_id, t.created_at, t.last_used_at, cl.client_name, u.name, p.name AS position_name
           FROM mcp_tokens t JOIN users u ON u.id = t.user_id
           LEFT JOIN mcp_oauth_clients cl ON cl.client_id = t.client_id
           LEFT JOIN positions p ON p.id = u.position_id
          WHERE t.revoked_at IS NULL AND t.refresh_expires_at > ? AND t.client_id <> 'mcpc_leak_check'
          ORDER BY t.last_used_at DESC NULLS LAST, t.created_at DESC`,
      )
      .bind(nowIso)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT a.user_id, a.approved_at, u.name, p.name AS position_name
           FROM mcp_access a JOIN users u ON u.id = a.user_id LEFT JOIN positions p ON p.id = u.position_id
          ORDER BY u.name`,
      )
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT k.id, k.user_id, k.tool, k.target, k.status, k.ok, k.note, k.ms, k.created_at, u.name, cl.client_name
           FROM mcp_calls k JOIN users u ON u.id = k.user_id LEFT JOIN mcp_oauth_clients cl ON cl.client_id = k.client_id
          ORDER BY k.created_at DESC LIMIT 100`,
      )
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT u.id, u.name, p.name AS position_name FROM users u LEFT JOIN positions p ON p.id = u.position_id
          WHERE u.status = 'active' AND u.id NOT IN (SELECT user_id FROM mcp_access) ORDER BY u.name`,
      )
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM mcp_calls WHERE created_at > ?) AS calls_24h,
                (SELECT COUNT(*) FROM mcp_calls WHERE created_at > ? AND ok = 0) AS refused_24h,
                (SELECT COUNT(DISTINCT user_id) FROM mcp_tokens WHERE revoked_at IS NULL AND refresh_expires_at > ? AND client_id <> 'mcpc_leak_check') AS people`,
      )
      .bind(dayAgo, dayAgo, nowIso)
      .first<Record<string, unknown>>(),
    actionsEnabled(db),
  ]);
  const pos = (r: Record<string, unknown>) => s(r, "position_name") || "—";
  return c.json({
    connectorUrl: connectorUrl(c),
    actionsEnabled: actionsOn,
    stats: { connectedPeople: num(stats ?? {}, "people"), callsToday: num(stats ?? {}, "calls_24h"), refusedToday: num(stats ?? {}, "refused_24h"), waiting: requests.results.length },
    requests: requests.results.map((r) => ({ id: s(r, "id"), userId: num(r, "user_id"), name: s(r, "name"), position: pos(r), reason: s(r, "reason"), createdAt: iso(r.created_at) })),
    connected: connected.results.map((r) => ({ tokenId: s(r, "id"), userId: num(r, "user_id"), name: s(r, "name"), position: pos(r), app: appLabel(s(r, "client_name")), connectedAt: iso(r.created_at), lastUsedAt: iso(r.last_used_at) })),
    allowed: allowed.results.map((r) => ({ userId: num(r, "user_id"), name: s(r, "name"), position: pos(r), approvedAt: iso(r.approved_at) })),
    calls: calls.results.map((r) => ({ id: s(r, "id"), userId: num(r, "user_id"), name: s(r, "name"), app: appLabel(s(r, "client_name")), tool: s(r, "tool"), target: s(r, "target"), status: num(r, "status"), ok: num(r, "ok") === 1, note: s(r, "note"), ms: num(r, "ms"), at: iso(r.created_at) })),
    staff: staff.results.map((r) => ({ userId: num(r, "id"), name: s(r, "name"), position: pos(r) })),
  });
});

async function grant(c: Context<HonoEnv>, userId: number): Promise<void> {
  await c.env.DB
    .prepare("INSERT INTO mcp_access (user_id, approved_by, approved_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING")
    .bind(userId, c.get("user").id, new Date().toISOString())
    .run();
}

app.post("/admin/requests/:id/:decision", async (c) => {
  const denied = denyUnlessAdmin(c);
  if (denied) return denied;
  const decision = c.req.param("decision");
  if (decision !== "approve" && decision !== "reject") return c.json({ error: "decision must be approve or reject" }, 400);
  const db = c.env.DB;
  const r = await db
    .prepare("UPDATE mcp_access_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending' RETURNING user_id")
    .bind(decision === "approve" ? "approved" : "rejected", c.get("user").id, new Date().toISOString(), c.req.param("id"))
    .first<Record<string, unknown>>();
  if (!r) return c.json({ error: "Request not found or already decided." }, 404);
  const userId = num(r, "user_id");
  if (decision === "approve") await grant(c, userId);
  await audit(c, { action: `ai_connector.${decision}`, entityType: "ai_connector", entityId: userId, summary: `AI Connector request ${decision}d` });
  return c.json({ ok: true });
});

app.post("/admin/access", async (c) => {
  const denied = denyUnlessAdmin(c);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { userId?: unknown };
  const userId = Number(body.userId);
  if (!Number.isInteger(userId) || userId <= 0) return c.json({ error: "userId required" }, 400);
  const u = await getUserById(c.env, userId);
  if (!u || u.status !== "active") return c.json({ error: "User not found or inactive." }, 404);
  await grant(c, userId);
  await c.env.DB.prepare("UPDATE mcp_access_requests SET status = 'approved', decided_by = ?, decided_at = ? WHERE user_id = ? AND status = 'pending'").bind(c.get("user").id, new Date().toISOString(), userId).run();
  await audit(c, { action: "ai_connector.grant", entityType: "ai_connector", entityId: userId, summary: `AI Connector turned on for ${u.name}` });
  return c.json({ ok: true });
});

app.delete("/admin/access/:userId", async (c) => {
  const denied = denyUnlessAdmin(c);
  if (denied) return denied;
  const userId = Number(c.req.param("userId"));
  if (!Number.isInteger(userId) || userId <= 0) return c.json({ error: "userId required" }, 400);
  await c.env.DB.prepare("DELETE FROM mcp_access WHERE user_id = ?").bind(userId).run();
  const revoked = await revokeUserTokens(c.env.DB, userId);
  await audit(c, { action: "ai_connector.remove", entityType: "ai_connector", entityId: userId, summary: `AI Connector removed (${revoked} connection(s) cut)` });
  return c.json({ ok: true, revoked });
});

app.post("/admin/revoke", async (c) => {
  const denied = denyUnlessAdmin(c);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { tokenId?: unknown; userId?: unknown };
  let n = 0;
  if (typeof body.tokenId === "string") n = await revokeToken(c.env.DB, body.tokenId, null);
  else if (Number.isInteger(Number(body.userId)) && Number(body.userId) > 0) n = await revokeUserTokens(c.env.DB, Number(body.userId));
  else return c.json({ error: "tokenId or userId required" }, 400);
  await audit(c, { action: "ai_connector.disconnect", entityType: "ai_connector", entityId: typeof body.tokenId === "string" ? body.tokenId : Number(body.userId), summary: `Disconnected ${n} AI connection(s)` });
  return c.json({ ok: true, revoked: n });
});

app.post("/admin/actions", async (c) => {
  const denied = denyUnlessAdmin(c);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
  await setActionsEnabled(c.env.DB, body.enabled);
  await audit(c, { action: "ai_connector.actions", entityType: "ai_connector", entityId: c.get("user").id, summary: `AI actions (meetings, email) turned ${body.enabled ? "on" : "off"}` });
  return c.json({ ok: true, actionsEnabled: body.enabled });
});


export type LeakRow = { path: string; outcome: "opened" | "refused" | "error"; status: number; hidden: string[]; sensitive: string[] };
const LEAK_CLIENT_ID = "mcpc_leak_check";
const LEAK_PAGE = 20;
const LEAK_PARALLEL = 4;

export function analyseBody(path: string, status: number, isError: boolean, body: unknown, removed: string[]): LeakRow {
  if (status === 401 || status === 403) return { path, outcome: "refused", status, hidden: [], sensitive: [] };
  if (isError) return { path, outcome: "error", status, hidden: [], sensitive: [] };
  const keys = [...jsonKeys(body)];
  return { path, outcome: "opened", status, hidden: removed, sensitive: keys.filter((k) => SENSITIVE_KEY.test(k) && !SECRET_KEY.test(k)).sort() };
}

app.post("/admin/leak-check", async (c) => {
  const denied = denyUnlessAdmin(c);
  if (denied) return denied;
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as { userId?: unknown; offset?: unknown };
  const userId = Number(body.userId);
  const offset = Math.max(0, Number(body.offset) || 0);
  const u = Number.isInteger(userId) && userId > 0 ? await getUserById(c.env, userId) : null;
  if (!u) return c.json({ error: "User not found" }, 404);
  if (isMcpAdmin(u)) return c.json({ error: "Admins see everything — pick a staff account." }, 400);
  if (u.status !== "active") return c.json({ error: "That account is inactive." }, 400);
  if (!(await hasMcpAccess(db, userId, false))) return c.json({ error: "Turn on AI Connector for this account first (it needs access to be checked)." }, 400);

  await db
    .prepare("INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, 'Leak check', '[]', ?) ON CONFLICT (client_id) DO NOTHING")
    .bind(LEAK_CLIENT_ID, new Date().toISOString())
    .run();
  const paths = leakCheckPaths(mcpAppRoutes());
  const page = paths.slice(offset, offset + LEAK_PAGE);
  const tok = await issueTokens(db, userId, LEAK_CLIENT_ID);
  const rows: LeakRow[] = [];
  try {
    for (let i = 0; i < page.length; i += LEAK_PARALLEL) {
      const chunk = page.slice(i, i + LEAK_PARALLEL);
      // eslint-disable-next-line no-await-in-loop -- bounded fan-out: 4 in-process reads at a time, so one check never floods the DB pool
      const got = await Promise.all(
        chunk.map(async (path) => {
          try {
            const r = await readEndpoint(c, tok.accessToken, path, { limit: 5, page: 1 }, null, []);
            return analyseBody(path, r.status, !!r.result.isError, r.body, r.removed);
          } catch {
            return { path, outcome: "error" as const, status: 500, hidden: [], sensitive: [] };
          }
        }),
      );
      rows.push(...got);
    }
  } finally {
    await revokeToken(db, tok.tokenId, null);
  }
  if (offset === 0) await audit(c, { action: "ai_connector.leak_check", entityType: "ai_connector", entityId: userId, summary: `Leak check run as ${u.name} over ${paths.length} endpoints` });
  return c.json({ person: u.name, position: u.position_name, total: paths.length, offset, next: offset + page.length, done: offset + page.length >= paths.length, rows });
});

export default app;
