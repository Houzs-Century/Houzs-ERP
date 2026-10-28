import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";

// Read-only view over the audit_events ledger (writes happen via
// services/audit.ts at the mutation sites). Owner/admin only — the trail
// exposes who changed roles, permissions, finance and user access.
const app = new Hono<{ Bindings: Env }>();

// Allow-list of sort keys -> columns (keeps sort_by from injecting SQL).
const SORT_MAP: Record<string, string> = {
  created_at: "created_at",
  action: "action",
  actor_id: "actor_id",
  entity_type: "entity_type",
  id: "id",
};

app.get("/", requirePermission("settings.manage"), async (c) => {
  const action = c.req.query("action");
  const entityType = c.req.query("entity_type");
  const entityId = c.req.query("entity_id");
  const actorId = c.req.query("actor_id");
  const page = Math.max(parseInt(c.req.query("page") || "1", 10), 1);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const where: string[] = [];
  const binds: unknown[] = [];
  if (action) {
    where.push("action LIKE ?");
    binds.push(`${action}%`); // prefix match: "role." catches role.update etc.
  }
  if (entityType) {
    where.push("entity_type = ?");
    binds.push(entityType);
  }
  if (entityId) {
    where.push("entity_id = ?");
    binds.push(entityId);
  }
  if (actorId) {
    where.push("actor_id = ?");
    binds.push(parseInt(actorId, 10));
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const sortExpr = SORT_MAP[c.req.query("sort_by") || ""] || "created_at";
  const sortDir =
    (c.req.query("sort_dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const orderBy = `ORDER BY ${sortExpr} ${sortDir}, id DESC`;

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM audit_events ${whereSql}`,
  )
    .bind(...binds)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT id, created_at, actor_id, actor_email, action, entity_type, entity_id, summary, meta, ip, request_id
       FROM audit_events ${whereSql} ${orderBy} LIMIT ? OFFSET ?`,
  )
    .bind(...binds, perPage, offset)
    .all();

  return c.json({
    data: rows.results,
    page,
    per_page: perPage,
    total: total?.count || 0,
  });
});

export default app;
