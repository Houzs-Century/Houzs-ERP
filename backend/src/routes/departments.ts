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
import { normaliseCode } from "../services/documentRefs";
import { bumpConfigVersion } from "../services/configCache";

const app = new Hono<{ Bindings: Env }>();

async function codeTakenBy(db: ReturnType<typeof getDb>, code: string): Promise<number | null> {
  const rows = await db
    .select({ id: departments.id })
    .from(departments)
    .where(sql`upper(${departments.code}) = ${code}`)
    .limit(1);
  return rows.length > 0 ? rows[0].id : null;
}

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
      code: departments.code,
      lead_user_id: departments.lead_user_id,
      headcount_target: departments.headcount_target,
      created_at: departments.created_at,
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

app.post("/", requirePermission("users.manage"), async (c) => {
  const body = await c.req.json<{
    name?: string;
    description?: string;
    color?: string;
    sort_order?: number;
    code?: string | null;
  }>();
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);

  const color = normaliseColor(body.color) ?? "64748b";
  const codeGiven = body.code != null && String(body.code).trim() !== "";
  const code = codeGiven ? normaliseCode(body.code) : null;
  if (codeGiven && !code) return c.json({ error: "code must be 2–4 letters (e.g. OPS, FIN)" }, 400);

  const db = getDb(c.env);
  const existing = await db
    .select({ id: departments.id })
    .from(departments)
    .where(eq(departments.name, name))
    .limit(1);
  if (existing.length > 0) {
    return c.json({ error: "A department with that name already exists" }, 409);
  }
  if (code && (await codeTakenBy(db, code)) != null) {
    return c.json({ error: `Code ${code} is already used by another department` }, 409);
  }

  const inserted = await db
    .insert(departments)
    .values({
      name,
      description: body.description?.trim() || null,
      color,
      sort_order: body.sort_order ?? 0,
      code,
    })
    .returning({ id: departments.id });

  return c.json(
    {
      id: inserted[0]?.id,
      name,
      description: body.description?.trim() || null,
      color,
      sort_order: body.sort_order ?? 0,
      code,
      member_count: 0,
    },
    201
  );
});

app.patch("/:id", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  const body = await c.req.json<{
    name?: string;
    description?: string;
    color?: string;
    sort_order?: number;
    lead_user_id?: number | null;
    headcount_target?: number | null;
    code?: string | null;
  }>();

  const set: Record<string, any> = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return c.json({ error: "name cannot be empty" }, 400);
    set.name = name;
  }
  if (body.code !== undefined) {
    if (body.code == null || String(body.code).trim() === "") {
      set.code = null;
    } else {
      const code = normaliseCode(body.code);
      if (!code) return c.json({ error: "code must be 2–4 letters (e.g. OPS, FIN)" }, 400);
      const holder = await codeTakenBy(getDb(c.env), code);
      if (holder != null && holder !== id) {
        return c.json({ error: `Code ${code} is already used by another department` }, 409);
      }
      set.code = code;
    }
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
  if (body.lead_user_id !== undefined) {
    if (body.lead_user_id === null) {
      set.lead_user_id = null;
    } else {
      const leadId = Number(body.lead_user_id);
      if (!Number.isInteger(leadId) || leadId <= 0) {
        return c.json({ error: "lead_user_id must be a user id or null" }, 400);
      }
      const leadRow = await getDb(c.env)
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, leadId))
        .limit(1);
      if (leadRow.length === 0) return c.json({ error: "lead_user_id is not a known user" }, 400);
      set.lead_user_id = leadId;
    }
  }
  if (body.headcount_target !== undefined) {
    if (body.headcount_target === null) {
      set.headcount_target = null;
    } else {
      const target = Number(body.headcount_target);
      if (!Number.isInteger(target) || target < 0) {
        return c.json({ error: "headcount_target must be a non-negative whole number or null" }, 400);
      }
      set.headcount_target = target;
    }
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

  await c.env.DB.prepare(`UPDATE positions SET department_id = NULL WHERE department_id = ?`)
    .bind(id)
    .run();
  await c.env.DB.prepare(`UPDATE users SET department_id = NULL WHERE department_id = ?`)
    .bind(id)
    .run();
  await db.delete(departments).where(eq(departments.id, id));
  await bumpConfigVersion(c.env, "banner");
  return c.json({ ok: true });
});

function normaliseColor(input: string | undefined | null): string | null {
  if (!input) return null;
  const v = String(input).trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(v)) return null;
  return v;
}

export default app;
