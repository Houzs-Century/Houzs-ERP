import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

// Allow-list of frontend sort keys → SQL expressions. Keeps `sort_by`
// from injecting arbitrary SQL.
const SORT_MAP: Record<string, string> = {
  started_at: "started_at",
  ended_at: "ended_at",
  type: "type",
  status: "status",
  message: "message",
  request_id: "request_id",
  id: "id",
};

app.get("/", requirePermission("logs.read"), async (c) => {
  const type = c.req.query("type");
  const status = c.req.query("status");
  const page = parseInt(c.req.query("page") || "1", 10);
  const perPage = Math.min(parseInt(c.req.query("per_page") || "50", 10), 200);
  const offset = (page - 1) * perPage;

  const where: string[] = [];
  const binds: any[] = [];
  if (type) {
    where.push("type LIKE ?");
    binds.push(`%${type}%`);
  }
  if (status) {
    where.push("status = ?");
    binds.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const sortBy = c.req.query("sort_by") || "";
  const sortDir =
    (c.req.query("sort_dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortExpr = SORT_MAP[sortBy] || "id";
  // `id` tiebreaker keeps pagination stable when the sorted column has
  // duplicates.
  const orderBy = `ORDER BY ${sortExpr} ${sortDir}, id DESC`;

  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM execution_logs ${whereSql}`
  )
    .bind(...binds)
    .first<{ count: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT * FROM execution_logs ${whereSql} ${orderBy} LIMIT ? OFFSET ?`
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
