import { Hono } from "hono";
import type { Env } from "../types";
import {
  requirePermission,
  requirePermissionOrSalesDirector,
} from "../middleware/auth";
import { isSalesDirectorUser } from "../services/pmsAccess";
import { hasPermission } from "../services/permissions";
import { getDb } from "../db/client";
import { departments, users } from "../db/schema";
import { and, eq, sql } from "drizzle-orm";

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /api/departments
 * List departments + member counts. Anyone with users.read can see
 * them (same gate as the Members tab — department info is not
 * sensitive).
 */
app.get("/", requirePermissionOrSalesDirector("users.read"), async (c) => {
  const db = getDb(c.env);

  // Sales Director → sees ONLY his own department (owner: "删掉别部门内容").
  // A caller holding users.read / `*` is a full admin and sees every
  // department, unchanged. No department assigned → empty list.
  const user = c.get("user");
  const granted = user?.permissions_set ?? user?.permissions ?? [];
  const isFullAdmin = hasPermission(granted, "*") || hasPermission(granted, "users.read");
  const scopeDeptId =
    !isFullAdmin && isSalesDirectorUser(user) ? user?.department_id ?? -1 : null;

  const rows = await db
    .select({
      id: departments.id,
      name: departments.name,
      description: departments.description,
      color: departments.color,
      sort_order: departments.sort_order,
      created_at: departments.created_at,
      // Active-only member count, kept as a correlated subquery so
      // the row shape stays flat for the frontend.
      member_count: sql<number>`(
        SELECT COUNT(*) FROM ${users}
         WHERE ${users.department_id} = ${departments.id}
           AND ${users.status} = 'active'
      )`,
    })
    .from(departments)
    .where(scopeDeptId !== null ? eq(departments.id, scopeDeptId) : undefined)
    .orderBy(departments.sort_order, departments.name);
  return c.json({ departments: rows });
});

/**
 * POST /api/departments
 * Body: { name, description?, color? (6-char hex, no '#'), sort_order? }
 */
app.post("/", requirePermission("users.manage"), async (c) => {
  const body = await c.req.json<{
    name?: string;
    description?: string;
    color?: string;
    sort_order?: number;
  }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);

  const color = normaliseColor(body.color) ?? "64748b";

  const db = getDb(c.env);
  // Name is UNIQUE — fail fast on dupes (idempotent create plays
  // nicely with quick retries).
  const existing = await db
    .select({ id: departments.id })
    .from(departments)
    .where(eq(departments.name, name))
    .limit(1);
  if (existing.length > 0) {
    return c.json({ error: "A department with that name already exists" }, 409);
  }

  const inserted = await db
    .insert(departments)
    .values({
      name,
      description: body.description?.trim() || null,
      color,
      sort_order: body.sort_order ?? 0,
    })
    .returning({ id: departments.id });

  return c.json(
    {
      id: inserted[0]?.id,
      name,
      description: body.description?.trim() || null,
      color,
      sort_order: body.sort_order ?? 0,
      member_count: 0,
    },
    201
  );
});

/**
 * PATCH /api/departments/:id
 * Body: { name?, description?, color?, sort_order? }
 */
app.patch("/:id", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  const body = await c.req.json<{
    name?: string;
    description?: string;
    color?: string;
    sort_order?: number;
  }>();

  const set: Record<string, any> = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return c.json({ error: "name cannot be empty" }, 400);
    set.name = name;
  }
  if (body.description !== undefined) {
    set.description = body.description?.trim() || null;
  }
  if (body.color !== undefined) {
    const c2 = normaliseColor(body.color);
    if (!c2) return c.json({ error: "color must be a 6-char hex" }, 400);
    set.color = c2;
  }
  if (body.sort_order !== undefined) {
    set.sort_order = body.sort_order;
  }
  if (Object.keys(set).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  const db = getDb(c.env);
  const existing = await db
    .select({ id: departments.id })
    .from(departments)
    .where(eq(departments.id, id))
    .limit(1);
  if (existing.length === 0) return c.json({ error: "Not found" }, 404);

  await db.update(departments).set(set).where(eq(departments.id, id));
  return c.json({ ok: true });
});

/**
 * DELETE /api/departments/:id
 * ON DELETE SET NULL on users.department_id means existing members
 * just get un-assigned — no cascade needed here.
 */
app.delete("/:id", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  const db = getDb(c.env);
  const existing = await db
    .select({ id: departments.id })
    .from(departments)
    .where(eq(departments.id, id))
    .limit(1);
  if (existing.length === 0) return c.json({ error: "Not found" }, 404);

  // Un-assign members + positions first. positions.department_id is a NO-ACTION
  // FK, so a bare delete throws (500 "Something went wrong") whenever a
  // department still has positions. Null both so deletion always succeeds —
  // departments are "grouping only", so members/positions just become
  // unassigned (they survive; reassign as needed) rather than blocking.
  await c.env.DB.prepare(`UPDATE positions SET department_id = NULL WHERE department_id = ?`)
    .bind(id)
    .run();
  await c.env.DB.prepare(`UPDATE users SET department_id = NULL WHERE department_id = ?`)
    .bind(id)
    .run();
  await db.delete(departments).where(eq(departments.id, id));
  return c.json({ ok: true });
});

/** Accepts "#abc123", "abc123", or rejects anything else. Returns the
 *  normalised 6-char lower-case hex without the leading '#'. */
function normaliseColor(input: string | undefined | null): string | null {
  if (!input) return null;
  const v = String(input).trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(v)) return null;
  return v;
}

export default app;
