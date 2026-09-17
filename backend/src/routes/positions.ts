import { Hono } from "hono";
import type { Env } from "../types";
import { PAGES, fullAccessMap, type AccessLevel } from "../services/pageAccess";
import { positionGrantsWildcard, resolvePositionPolicy } from "../services/positionPolicy";
import { loadPositionPolicyRow } from "../services/positionPolicyRows";
import { requirePermission, requirePermissionOrSalesDirector } from "../middleware/auth";
import { isSalesDirectorUser } from "../services/pmsAccess";
import { hasPermission } from "../services/permissions";
import { audit } from "../services/audit";
import { getDb } from "../db/client";
import { positions, users, departments } from "../db/schema";
import { and, asc, eq, sql } from "drizzle-orm";

// Positions = the staff org unit (department × position). Mirrors roles.ts but
// keyed on POSITION and using the 4-level page-access matrix (none/view/edit/
// full). Gated under users.read / users.manage — positions are a
// user-management concern, so no new permission verb is introduced.

const app = new Hono<{ Bindings: Env }>();

const slugify = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** GET /api/positions  (?department_id= to scope the invite-form dropdown) */
app.get("/", requirePermissionOrSalesDirector("users.read"), async (c) => {
  const db = getDb(c.env);
  const deptParam = c.req.query("department_id");
  const deptId = deptParam ? parseInt(deptParam, 10) : null;

  // Sales Director (dept-scoped admin, NOT a full users.read admin) → own-dept
  // positions only, mirroring GET /api/departments ("删掉别部门内容"). This also
  // scopes the member-form Position picker to the positions a Sales Director may
  // actually assign (invite/patch already reject cross-dept positions). A full
  // admin (users.read / `*`) is unaffected; no department assigned → -1 (empty).
  const user = c.get("user");
  const granted = user?.permissions_set ?? user?.permissions ?? [];
  const isFullAdmin =
    hasPermission(granted, "*") || hasPermission(granted, "users.read");
  const scopeDeptId =
    !isFullAdmin && isSalesDirectorUser(user) ? user?.department_id ?? -1 : null;
  const effectiveDeptId = scopeDeptId !== null ? scopeDeptId : deptId;

  const rows = await db
    .select({
      id: positions.id,
      department_id: positions.department_id,
      slug: positions.slug,
      name: positions.name,
      level: positions.level,
      sort_order: positions.sort_order,
      active: positions.active,
      department_name: departments.name,
      member_count: sql<number>`(SELECT COUNT(*) FROM ${users} WHERE ${users.position_id} = ${positions.id})`,
    })
    .from(positions)
    .leftJoin(departments, eq(departments.id, positions.department_id))
    .where(
      effectiveDeptId != null
        ? eq(positions.department_id, effectiveDeptId)
        : undefined,
    )
    .orderBy(asc(positions.sort_order), asc(positions.name));

  return c.json({
    positions: rows.map((r) => ({
      id: r.id,
      department_id: r.department_id,
      department_name: r.department_name,
      slug: r.slug,
      name: r.name,
      level: r.level,
      sort_order: r.sort_order,
      active: !!r.active,
      member_count: r.member_count ?? 0,
    })),
  });
});

/** POST /api/positions  Body: { department_id, name, slug?, level?, sort_order? } */
app.post("/", requirePermission("users.manage"), async (c) => {
  const body = await c.req.json<{
    department_id?: number;
    name: string;
    slug?: string;
    level?: number;
    sort_order?: number;
  }>();
  if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);
  const name = body.name.trim();
  const slug = (body.slug?.trim() || slugify(name)) || null;
  if (!slug) return c.json({ error: "could not derive a slug from name" }, 400);

  const db = getDb(c.env);
  const exists = await db
    .select({ id: positions.id })
    .from(positions)
    .where(eq(positions.slug, slug))
    .limit(1);
  if (exists.length > 0) {
    return c.json({ error: "A position with that slug already exists" }, 409);
  }

  const inserted = await db
    .insert(positions)
    .values({
      department_id: body.department_id ?? null,
      slug,
      name,
      level: body.level ?? 100,
      sort_order: body.sort_order ?? 100,
      active: 1,
    })
    .returning({ id: positions.id });

  await audit(c, {
    action: "position.create",
    entityType: "position",
    entityId: inserted[0]?.id,
    summary: `Created position "${name}"`,
    meta: { name, slug, department_id: body.department_id ?? null },
  });

  return c.json({ id: inserted[0]?.id, slug, name });
});

/** PATCH /api/positions/:id  Body: { name?, department_id?, level?, sort_order?, active? } */
app.patch("/:id", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  const db = getDb(c.env);
  const row = await db
    .select({ id: positions.id })
    .from(positions)
    .where(eq(positions.id, id))
    .limit(1);
  if (row.length === 0) return c.json({ error: "Position not found" }, 404);

  const body = await c.req.json<{
    name?: string;
    department_id?: number | null;
    level?: number;
    sort_order?: number;
    active?: boolean;
  }>();

  const set: Record<string, unknown> = {};
  if (body.name !== undefined) set.name = body.name.trim();
  if (body.department_id !== undefined) set.department_id = body.department_id;
  if (body.level !== undefined) set.level = body.level;
  if (body.sort_order !== undefined) set.sort_order = body.sort_order;
  if (body.active !== undefined) set.active = body.active ? 1 : 0;
  if (Object.keys(set).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  await db.update(positions).set(set).where(eq(positions.id, id));
  await audit(c, {
    action: "position.update",
    entityType: "position",
    entityId: id,
    summary: `Updated position #${id}`,
    meta: { changed: Object.keys(set) },
  });
  return c.json({ ok: true });
});

/** DELETE /api/positions/:id  Refuses if any user still holds it. */
app.delete("/:id", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  const db = getDb(c.env);
  const row = await db
    .select({ id: positions.id })
    .from(positions)
    .where(eq(positions.id, id))
    .limit(1);
  if (row.length === 0) return c.json({ error: "Position not found" }, 404);

  const inUse = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(users)
    .where(eq(users.position_id, id));
  const count = inUse[0]?.count ?? 0;
  if (count > 0) {
    return c.json(
      { error: `Position is in use by ${count} user(s) — reassign them first` },
      409,
    );
  }

  await db.delete(positions).where(eq(positions.id, id));
  await audit(c, {
    action: "position.delete",
    entityType: "position",
    entityId: id,
    summary: `Deleted position #${id}`,
  });
  return c.json({ ok: true });
});

/**
 * GET /api/positions/:id/page-access
 * The pages a Title's members see, as login resolves them: the Title's
 * position_policy row (or, with no row, the name rule), owner tier = full on
 * every page. Read-only — the cohort is edited on Roles & Permissions › Titles.
 * (Until 2026-09-17 this answered from the dropped position_page_access
 * matrix, which login had not read since 2026-07-18.)
 */
app.get("/:id/page-access", requirePermission("users.read"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const db = getDb(c.env);

  const posRow = await db
    .select({ id: positions.id, name: positions.name, department_name: departments.name })
    .from(positions)
    .leftJoin(departments, eq(departments.id, positions.department_id))
    .where(eq(positions.id, id))
    .limit(1);
  if (posRow.length === 0) return c.json({ error: "Position not found" }, 404);

  const policyRow = await loadPositionPolicyRow(c.env, id);
  const resolved = positionGrantsWildcard(posRow[0].name, policyRow)
    ? fullAccessMap()
    : resolvePositionPolicy(
        { position_name: posRow[0].name, department_name: posRow[0].department_name ?? null },
        policyRow,
      ).pageAccess;

  const out: Record<string, { level: AccessLevel; explicit: boolean }> = {};
  for (const p of PAGES) out[p.key] = { level: resolved[p.key] ?? "none", explicit: false };

  return c.json({ position_id: id, page_access: out, orphan_rows: [] });
});

export default app;
