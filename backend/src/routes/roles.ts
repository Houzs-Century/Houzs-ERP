import { Hono } from "hono";
import type { Env } from "../types";
import { PERMISSIONS, isValidPermission, parsePermissions, droppedPermissions } from "../services/permissions";
import {
  PAGES,
  computeBackfillLevel,
  isDormantPageKey,
  isValidAccessLevel,
  isValidPageKey,
  type AccessLevel,
} from "../services/pageAccess";
import { requirePermission, requirePermissionOrSalesDirector } from "../middleware/auth";
import { audit } from "../services/audit";
import { getDb } from "../db/client";
import { roles, role_page_access, users } from "../db/schema";
import { eq, sql } from "drizzle-orm";

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /api/roles/permissions
 * Returns the permission catalog so the frontend can render the
 * permission picker. Anyone with roles.read can see this.
 */
app.get("/permissions", requirePermission("roles.read"), async (c) => {
  return c.json({ permissions: PERMISSIONS });
});

/**
 * GET /api/roles
 * Returns all roles + their permission arrays + member counts.
 *
 * Admitted for a Sales Director too (READ-ONLY, additive on top of roles.read):
 * the Team member-invite / edit forms render a Role picker sourced from this
 * list, and a dept-scoped Sales Director has no roles.read in the matrix
 * (positions get no backfill) so it 403'd — breaking the mobile Member form.
 * Roles are a global, non-sensitive lookup; the WRITE routes below stay
 * roles.manage-only, and a scoped invite/patch forces a baseline role
 * server-side (routes/users.ts) regardless of what the picker sends.
 */
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
      // Subquery for the member count keeps this single-round-trip.
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
      // The other half of the same answer. parsePermissions DISCARDS any stored
      // key this build does not declare, so a role row can carry keys that
      // decide nothing and the list looked identical to a clean one. Surfaced
      // here because Team > Roles is the one place a human looks at a role.
      unknown_permissions: droppedPermissions(r.permissions),
      is_system: !!r.is_system,
      scope_to_pic: !!r.scope_to_pic,
      member_count: r.member_count ?? 0,
      created_at: r.created_at,
    })),
  });
});

/**
 * POST /api/roles
 * Body: { name, description?, permissions: string[] }
 * Create a custom role.
 */
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

/**
 * PATCH /api/roles/:id
 * Body: { name?, description?, permissions? }
 * Update a custom role. System roles' permissions are locked.
 */
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

  // System roles: only description editable, never name or permissions.
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

/**
 * GET /api/roles/pages
 * Returns the page catalogue (key, label, partialMeaning, supportsPartial)
 * for the admin Page Access UI. Independent of role — same payload for
 * any caller with roles.read.
 */
app.get("/pages", requirePermission("roles.read"), async (c) => {
  return c.json({
    pages: PAGES.map((p) => ({
      key: p.key,
      label: p.label,
      partialMeaning: p.partialMeaning,
      supportsPartial: p.supportsPartial,
      parent: p.parent ?? null,
      // Class A — the key exists in PAGES but NOTHING reads it, so setting it
      // has never done anything. Same field, same source of truth, same seven
      // keys as /api/positions/pages: the catalogue is ONE array, so a cell
      // that lies in the Positions editor lies here identically. #709 greyed
      // Positions and flagged that this editor still rendered the seven as
      // settable. Purely descriptive — changes no level and no resolution
      // (pageAccess.DORMANT_PAGE_KEYS is read by nothing in the resolve path).
      dormant: isDormantPageKey(p.key),
    })),
  });
});

/**
 * GET /api/roles/:id/page-access
 * Returns the role's per-page access map. Pages without an explicit
 * `role_page_access` row fall back to the catalogue's backfill rule
 * computed against the role's current `permissions` JSON.
 */
app.get("/:id/page-access", requirePermission("roles.read"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const db = getDb(c.env);

  const roleRow = await db
    .select({ permissions: roles.permissions })
    .from(roles)
    .where(eq(roles.id, id))
    .limit(1);
  if (roleRow.length === 0) return c.json({ error: "Role not found" }, 404);

  const permsSet = new Set(parsePermissions(roleRow[0].permissions));

  const rows = await db
    .select({ page_key: role_page_access.page_key, level: role_page_access.level })
    .from(role_page_access)
    .where(eq(role_page_access.role_id, id));

  const explicit: Record<string, AccessLevel> = {};
  for (const r of rows) {
    if (isValidPageKey(r.page_key) && isValidAccessLevel(r.level)) {
      explicit[r.page_key] = r.level;
    }
  }

  const out: Record<string, { level: AccessLevel; explicit: boolean }> = {};
  for (const p of PAGES) {
    if (explicit[p.key]) {
      out[p.key] = { level: explicit[p.key], explicit: true };
    } else {
      out[p.key] = { level: computeBackfillLevel(p.key, permsSet), explicit: false };
    }
  }

  return c.json({ role_id: id, page_access: out });
});

/**
 * PATCH /api/roles/:id/page-access
 * Body: { entries: Array<{ page_key, level }> }
 * Upserts one or more (page_key, level) rows for the role.
 *
 * System roles (Owner / IT Admin) hold the `*` wildcard which
 * short-circuits matrix lookups, but we still allow writes for
 * audit-log visibility — they just have no behavioural effect.
 */
app.patch("/:id/page-access", requirePermission("roles.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  const body = await c.req.json<{
    entries: Array<{ page_key: string; level: string }>;
  }>();
  if (!body || !Array.isArray(body.entries) || body.entries.length === 0) {
    return c.json({ error: "entries[] is required" }, 400);
  }

  const cleaned: Array<{ page_key: string; level: AccessLevel }> = [];
  for (const e of body.entries) {
    if (!isValidPageKey(e.page_key)) {
      return c.json({ error: `Unknown page_key: ${e.page_key}` }, 400);
    }
    if (!isValidAccessLevel(e.level)) {
      return c.json({ error: `Invalid level: ${e.level}` }, 400);
    }
    cleaned.push({ page_key: e.page_key, level: e.level });
  }

  const db = getDb(c.env);
  const roleRow = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.id, id))
    .limit(1);
  if (roleRow.length === 0) return c.json({ error: "Role not found" }, 404);

  // Upsert on the (role_id, page_key) PK. Done in a loop because the
  // matrix payload is at most 13 rows so this is fine.
  for (const e of cleaned) {
    await c.env.DB.prepare(
      `INSERT INTO role_page_access (role_id, page_key, level, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(role_id, page_key) DO UPDATE SET
         level = excluded.level, updated_at = excluded.updated_at`,
    )
      .bind(id, e.page_key, e.level)
      .run();
  }

  await audit(c, {
    action: "role.page_access.update",
    entityType: "role",
    entityId: id,
    summary: `Updated page access for role #${id} (${cleaned.length} page(s))`,
    meta: { entries: cleaned },
  });

  return c.json({ ok: true, written: cleaned.length });
});

/**
 * DELETE /api/roles/:id
 * Delete a custom role. Refuses if any user still holds it.
 */
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

  // The page-access matrix FK (role_page_access.role_id) was ON DELETE CASCADE
  // in the schema, but the D1->PG load dropped it to NO ACTION — so a bare
  // delete throws once a role has any saved matrix row. Clear children first
  // (same cutover fix as departments/positions).
  await c.env.DB.prepare(`DELETE FROM role_page_access WHERE role_id = ?`)
    .bind(id)
    .run();

  await db.delete(roles).where(eq(roles.id, id));
  await audit(c, {
    action: "role.delete",
    entityType: "role",
    entityId: id,
    summary: `Deleted role #${id}`,
  });
  return c.json({ ok: true });
});

export default app;
