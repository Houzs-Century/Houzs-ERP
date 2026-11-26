import { Hono } from "hono";
import type { Env } from "../types";
import { PERMISSIONS, isValidPermission, parsePermissions, droppedPermissions } from "../services/permissions";
import {
  PAGES,
  isValidPageKey,
  isRetiredPageKey,
  isDormantPageKey,
  isValidPositionLevel,
} from "../services/pageAccess";
import { requirePermission, requirePermissionOrSalesDirector } from "../middleware/auth";
import { audit } from "../services/audit";
import { bustUserSessions } from "../services/sessionCache";
import { getDb } from "../db/client";
import { roles, users, role_page_access } from "../db/schema";
import { eq, sql } from "drizzle-orm";

const app = new Hono<{ Bindings: Env }>();

app.get("/permissions", requirePermission("roles.read"), async (c) => {
  return c.json({ permissions: PERMISSIONS });
});

app.get("/", requirePermissionOrSalesDirector("roles.read"), async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({
      id: roles.id,
      name: roles.name,
      description: roles.description,
      permissions: roles.permissions,
      is_system: roles.is_system,
      scope_to_pic: roles.scope_to_pic,
      created_at: roles.created_at,
      member_count: sql<number>`(SELECT COUNT(*) FROM ${users} WHERE ${users.role_id} = ${roles.id})`,
    })
    .from(roles)
    .orderBy(sql`${roles.is_system} DESC`, roles.name);

  return c.json({
    roles: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      permissions: parsePermissions(r.permissions),
      unknown_permissions: droppedPermissions(r.permissions),
      is_system: !!r.is_system,
      scope_to_pic: !!r.scope_to_pic,
      member_count: r.member_count ?? 0,
      created_at: r.created_at,
    })),
  });
});

app.post("/", requirePermission("roles.manage"), async (c) => {
  const body = await c.req.json<{
    name: string;
    description?: string;
    permissions?: string[];
    scope_to_pic?: boolean;
  }>();
  if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);

  const perms = (body.permissions || []).filter(isValidPermission);
  const name = body.name.trim();

  const db = getDb(c.env);
  const exists = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, name))
    .limit(1);
  if (exists.length > 0) {
    return c.json({ error: "A role with that name already exists" }, 409);
  }

  const inserted = await db
    .insert(roles)
    .values({
      name,
      description: body.description?.trim() || null,
      permissions: JSON.stringify(perms),
      is_system: 0,
      scope_to_pic: body.scope_to_pic ? 1 : 0,
    })
    .returning({ id: roles.id });

  await audit(c, {
    action: "role.create",
    entityType: "role",
    entityId: inserted[0]?.id,
    summary: `Created role "${name}"`,
    meta: { name, permissions: perms, scope_to_pic: !!body.scope_to_pic },
  });

  return c.json({
    id: inserted[0]?.id,
    name,
    description: body.description?.trim() || null,
    permissions: perms,
    is_system: false,
    scope_to_pic: !!body.scope_to_pic,
    member_count: 0,
  });
});

app.patch("/:id", requirePermission("roles.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  const db = getDb(c.env);
  const row = await db
    .select({ id: roles.id, is_system: roles.is_system })
    .from(roles)
    .where(eq(roles.id, id))
    .limit(1);
  if (row.length === 0) return c.json({ error: "Role not found" }, 404);

  const body = await c.req.json<{
    name?: string;
    description?: string;
    permissions?: string[];
    scope_to_pic?: boolean;
  }>();

  if (row[0].is_system) {
    if (body.name !== undefined || body.permissions !== undefined) {
      return c.json(
        { error: "System roles cannot be renamed or have permissions changed" },
        400
      );
    }
  }

  const set: Record<string, any> = {};
  if (body.name !== undefined) set.name = body.name.trim();
  if (body.description !== undefined) {
    set.description = body.description?.trim() || null;
  }
  if (body.permissions !== undefined) {
    set.permissions = JSON.stringify(body.permissions.filter(isValidPermission));
  }
  if (body.scope_to_pic !== undefined) {
    set.scope_to_pic = body.scope_to_pic ? 1 : 0;
  }
  if (Object.keys(set).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  await db.update(roles).set(set).where(eq(roles.id, id));
  await audit(c, {
    action: "role.update",
    entityType: "role",
    entityId: id,
    summary: `Updated role #${id}`,
    meta: { changed: Object.keys(set), permissions: body.permissions },
  });
  return c.json({ ok: true });
});

app.delete("/:id", requirePermission("roles.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  const db = getDb(c.env);
  const row = await db
    .select({ id: roles.id, is_system: roles.is_system })
    .from(roles)
    .where(eq(roles.id, id))
    .limit(1);
  if (row.length === 0) return c.json({ error: "Role not found" }, 404);
  if (row[0].is_system) {
    return c.json({ error: "System roles cannot be deleted" }, 400);
  }

  const inUse = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(users)
    .where(eq(users.role_id, id));
  const count = inUse[0]?.count ?? 0;
  if (count > 0) {
    return c.json(
      { error: `Role is in use by ${count} user(s) — reassign them first` },
      409
    );
  }

  await db.delete(roles).where(eq(roles.id, id));
  await audit(c, {
    action: "role.delete",
    entityType: "role",
    entityId: id,
    summary: `Deleted role #${id}`,
  });
  return c.json({ ok: true });
});

app.get("/page-access", requirePermission("roles.read"), async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({
      role_id: role_page_access.role_id,
      page_key: role_page_access.page_key,
      level: role_page_access.level,
    })
    .from(role_page_access);

  const byRole = new Map<number, Record<string, string>>();
  for (const r of rows) {
    if (!isValidPageKey(r.page_key) || isRetiredPageKey(r.page_key)) continue;
    const m = byRole.get(r.role_id) ?? {};
    m[r.page_key] = r.level;
    byRole.set(r.role_id, m);
  }

  const roleRows = await db.select({ id: roles.id }).from(roles);

  return c.json({
    pages: PAGES.filter((p) => !isRetiredPageKey(p.key)).map((p) => ({
      key: p.key,
      label: p.label,
      parent: p.parent ?? null,
      dormant: isDormantPageKey(p.key),
    })),
    roles: roleRows.map((r) => ({
      role_id: r.id,
      has_rows: byRole.has(r.id),
      levels: byRole.get(r.id) ?? {},
    })),
  });
});

app.patch("/:id/page-access", requirePermission("roles.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  const db = getDb(c.env);
  const row = await db
    .select({ id: roles.id, is_system: roles.is_system, permissions: roles.permissions })
    .from(roles)
    .where(eq(roles.id, id))
    .limit(1);
  if (row.length === 0) return c.json({ error: "Role not found" }, 404);
  if (row[0].is_system || parsePermissions(row[0].permissions).includes("*")) {
    return c.json(
      { error: "System roles see every page and cannot have their page access changed" },
      400,
    );
  }

  const body = await c.req.json<{ entries?: Array<{ pageKey?: string; level?: string }> }>();
  const entries = body.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return c.json(
      { error: "entries is required (the role's full page-access set)" },
      400,
    );
  }

  const wanted = new Map<string, string>();
  for (const e of entries) {
    const pageKey = e?.pageKey;
    const level = e?.level;
    if (typeof pageKey !== "string" || !isValidPageKey(pageKey) || isRetiredPageKey(pageKey)) {
      return c.json({ error: `Unknown page: ${String(pageKey)}` }, 400);
    }
    if (typeof level !== "string" || !isValidPositionLevel(level)) {
      return c.json({ error: `Invalid level for ${pageKey}: ${String(level)}` }, 400);
    }
    wanted.set(pageKey, level);
  }

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  await db.transaction(async (tx) => {
    await tx.delete(role_page_access).where(eq(role_page_access.role_id, id));
    await tx.insert(role_page_access).values(
      [...wanted].map(([page_key, level]) => ({
        role_id: id,
        page_key,
        level,
        created_at: now,
        updated_at: now,
      })),
    );
  });

  const members = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role_id, id));
  for (const m of members) await bustUserSessions(c.env, m.id);

  await audit(c, {
    action: "role.page_access.update",
    entityType: "role",
    entityId: id,
    summary: `Updated page access for role #${id} (${wanted.size} pages)`,
    meta: { pages: wanted.size, members: members.length },
  });

  return c.json({ ok: true, pages: wanted.size, members: members.length });
});

export default app;
