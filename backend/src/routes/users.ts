import { Hono } from "hono";
import type { Env } from "../types";
import { createSession, generateToken, hashPassword, isoIn } from "../services/auth";
import { bustUserSessions } from "../services/sessionCache";
import { bustBannerForUser } from "../services/configCache";
import { validatePasswordStrength } from "../services/passwordStrength";
import {
  requirePermission,
  requirePermissionOrSalesDirector,
} from "../middleware/auth";
import { isSalesDirectorUser } from "../services/pmsAccess";
import { hasPermission } from "../services/permissions";
import { checkRateLimit } from "../middleware/rateLimit";
import { normalizePhone } from "../scm/shared/phone";
import { avatarCacheControl } from "../lib/avatar-cache";
import type { Context } from "hono";
import {
  sendEmail,
  publicUrl,
  inviteEmailHtml,
  resetEmailHtml,
  erpProductName,
} from "../services/email";
import { syncSalesRepFromUser } from "../services/salesTeam";
import { isPosPin, isPosPinPosition, setPosPinForUser } from "../services/posPin";
import { audit } from "../services/audit";
import { getBrandingForCompany, resolveCompanyCode } from "../services/branding";

async function activeCompanyEmailIdentity(
  env: Env,
  companyCodeVar: string | undefined,
): Promise<{ companyCode: string; productName: string }> {
  const companyCode = await resolveCompanyCode(env, companyCodeVar);
  const branding = await getBrandingForCompany(env, companyCode);
  return { companyCode, productName: erpProductName(branding) };
}
import { getDb } from "../db/client";
import { allowedCompanyIds } from "../scm/lib/companyScope";  import { targetWithinActorCompanies } from "./lib/actor-company-gate";
import {
  departments,
  invitations,
  password_resets,
  positions,
  project_brands,
  roles,
  sessions,
  user_brands,
  user_departments,
  users,
} from "../db/schema";
import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  AliasMailboxCollisionError,
  changePersonalMailboxAliasAtomically,
  closePersonalMailOnDisable,
  companyMailboxDomain,
  isPersonalAddressTaken,
  markMailHostPending,
  provisionPersonalMailbox,
  reopenPersonalMailbox,
  type PersonalMailboxAliasChange,
} from "../lib/mail-provision";

const app = new Hono<{ Bindings: Env }>();

function salesDirectorScope(
  c: Context<{ Bindings: Env }>,
  adminPerm: string,
): { scoped: boolean; deptId: number | null } {
  const user = c.get("user");
  const granted = user?.permissions_set ?? user?.permissions ?? [];
  if (hasPermission(granted, "*") || hasPermission(granted, adminPerm)) {
    return { scoped: false, deptId: null };
  }
  if (isSalesDirectorUser(user)) {
    return { scoped: true, deptId: user?.department_id ?? null };
  }
  return { scoped: false, deptId: null };
}

async function resolveDefaultRoleId(
  db: ReturnType<typeof getDb>,
): Promise<number | null> {
  const all = await db
    .select({ id: roles.id, name: roles.name, is_system: roles.is_system, permissions: roles.permissions })
    .from(roles)
    .orderBy(roles.id);
  if (all.length === 0) return null;
  const permCount = (p: string | null): number => {
    try {
      const arr = JSON.parse(p ?? "[]");
      return Array.isArray(arr) ? arr.length : 0;
    } catch {
      return 0;
    }
  };
  const preview = all.find((r) => (r.name ?? "").trim().toLowerCase() === "position preview");
  const zeroPerm = all.find((r) => !r.is_system && permCount(r.permissions) === 0);
  const nonSystem = all.find((r) => !r.is_system);
  return (preview ?? zeroPerm ?? nonSystem ?? all[0]).id;
}

const INVITE_TTL_SECONDS = 60 * 60 * 24 * 14;
const RESET_TTL_SECONDS = 60 * 60;

app.get("/", requirePermissionOrSalesDirector("users.read"), async (c) => {
  const brand = (c.req.query("brand") || "").trim();
  const department = (c.req.query("department") || "").trim();
  const search = (c.req.query("q") || c.req.query("search") || "").trim();
  const db = getDb(c.env);
  const manager = alias(users, "m");
  const inviter = alias(users, "ib");

  const conds: any[] = [];
  const scope = salesDirectorScope(c, "users.read");
  if (scope.scoped) {
    const me = c.get("user");
    if (scope.deptId != null) {
      conds.push(
        sql`(${users.department_id} = ${scope.deptId}
             OR EXISTS (SELECT 1 FROM ${user_departments} ud
                         WHERE ud.user_id = ${users.id}
                           AND ud.department_id = ${scope.deptId}))`,
      );
    } else {
      conds.push(sql`${users.id} = ${me.id}`);
    }
  }
  if (brand) {
    conds.push(
      sql`EXISTS (SELECT 1 FROM ${user_brands} ub
                   WHERE ub.user_id = ${users.id}
                     AND ub.brand = ${brand})`
    );
  }
  if (department) {
    conds.push(
      sql`EXISTS (SELECT 1 FROM ${departments} d2
                   WHERE d2.id = ${users.department_id}
                     AND d2.name ILIKE ${"%" + department + "%"})`
    );
  }
  if (search) {
    conds.push(
      sql`(${users.name} ILIKE ${"%" + search + "%"}
           OR ${users.email} ILIKE ${"%" + search + "%"})`
    );
  }

  const built = db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
      status_reason: users.status_reason,
      role_id: users.role_id,
      role_name: roles.name,
      manager_id: users.manager_id,
      manager_name: manager.name,
      manager_email: manager.email,
      department_id: users.department_id,
      department_name: departments.name,
      department_color: departments.color,
      division: users.division,
      position_id: users.position_id,
      position_name: positions.name,
      invited_at: users.invited_at,
      invited_by: users.invited_by,
      invited_by_name: inviter.name,
      invited_by_email: inviter.email,
      joined_at: users.joined_at,
      last_login_at: users.last_login_at,
      created_at: users.created_at,
      profile_pic_r2_key: users.profile_pic_r2_key,
      phone: users.phone,
      email_alias: users.email_alias,
      brands_concat: sql<string | null>`(
        SELECT string_agg(ub.brand, chr(31))
          FROM ${user_brands} ub
         WHERE ub.user_id = ${users.id}
      )`,
      department_ids_arr: sql<number[] | null>`(
        SELECT array_agg(ud.department_id)
          FROM ${user_departments} ud
         WHERE ud.user_id = ${users.id}
      )`,
      company_ids_arr: sql<number[] | null>`(
        SELECT array_agg(uc.company_id)
          FROM user_companies uc
         WHERE uc.user_id = ${users.id}
      )`,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.role_id))
    .leftJoin(manager, eq(manager.id, users.manager_id))
    .leftJoin(departments, eq(departments.id, users.department_id))
    .leftJoin(positions, eq(positions.id, users.position_id))
    .leftJoin(inviter, eq(inviter.id, users.invited_by))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(users.created_at));
  const rows = await (search ? built.limit(50) : built);

  const pgIntArray = (raw: unknown): number[] =>
    (Array.isArray(raw)
      ? raw
      : typeof raw === "string"
        ? raw.replace(/^\{|\}$/g, "").split(",")
        : []
    )
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n));
  const out = rows.map((r) => {
    const arr = pgIntArray(r.department_ids_arr);
    const extra = arr
      .map((d) => Number(d))
      .filter((d) => Number.isFinite(d) && d !== r.department_id)
      .sort((a, b) => a - b);
    const department_ids =
      r.department_id != null ? [r.department_id, ...extra] : extra;
    const companyArr = pgIntArray(r.company_ids_arr);
    const company_ids = companyArr
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    return {
      ...r,
      brands: r.brands_concat
        ? String(r.brands_concat).split("\x1f").filter(Boolean)
        : [],
      brands_concat: undefined,
      department_ids,
      department_ids_arr: undefined,
      company_ids,
      company_ids_arr: undefined,
    };
  });
  return c.json({ users: out });
});

app.get("/:id/brands", requirePermission("users.read"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const db = getDb(c.env);
  const rows = await db
    .select({ brand: user_brands.brand })
    .from(user_brands)
    .where(eq(user_brands.user_id, id));
  return c.json({ brands: rows.map((r) => r.brand) });
});

app.put("/:id/brands", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  const body = await c.req.json<{ brands?: unknown }>();
  const incoming = Array.isArray(body.brands) ? body.brands : [];
  const requested = incoming
    .filter((x): x is string => typeof x === "string" && x.trim() !== "")
    .map((s) => s.trim());

  const db = getDb(c.env);
  const target = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (target.length === 0) return c.json({ error: "User not found" }, 404);

  let valid: string[] = [];
  if (requested.length > 0) {
    const r = await db
      .select({ name: project_brands.name })
      .from(project_brands)
      .where(inArray(project_brands.name, requested));
    const allowed = new Set(r.map((x) => x.name));
    valid = requested.filter((b) => allowed.has(b));
  }

  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM user_brands WHERE user_id = ?`).bind(id),
    ...valid.map((b) =>
      c.env.DB
        .prepare(`INSERT INTO user_brands (user_id, brand) VALUES (?, ?)`)
        .bind(id, b)
    ),
  ]);

  return c.json({ ok: true, brands: valid });
});

app.get("/:id/companies", requirePermission("users.read"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  try {
    const res = await c.env.DB.prepare(
      `SELECT company_id FROM user_companies WHERE user_id = ?`,
    )
      .bind(id)
      .all<{ company_id: number | string }>();
    const companyIds = (res.results ?? [])
      .map((r) => Number(r.company_id))
      .filter((n) => Number.isFinite(n));
    return c.json({ companies: companyIds });
  } catch {
    return c.json({ companies: [] });
  }
});

/**
 * SET a user's company grants (replace-set semantics). Validates the requested
 * ids against the canonical companies master (silent-drop unknowns), then
 * DELETE-then-INSERT `user_companies` in one batch. Returns the persisted set.
 *
 * NO-OP-SAFE: if `user_companies` / `companies` is absent (pre-0f) the query
 * throws and we swallow it, returning [] — the feature simply isn't active yet.
 *
 * Shared by PUT /:id/companies, POST /invite and PATCH /:id so the three write
 * paths never drift (see MEMORY: single logic layer / converge drifted copies).
 */
export async function setUserCompanies(
  c: Context<{ Bindings: Env }>,
  userId: number,
  companyIds: number[],
): Promise<number[]> {
  const requested = Array.from(
    new Set(
      companyIds
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  );
  try {
    let valid = requested;
    if (requested.length > 0) {
      const mine = allowedCompanyIds(c);
      if (mine === undefined) {
        const r = await c.env.DB.prepare(`SELECT id FROM companies`).all<{
          id: number | string;
        }>();
        const known = new Set((r.results ?? []).map((x) => Number(x.id)));
        valid = requested.filter((cid) => known.has(cid));
      } else {
        const known = new Set(mine);
        valid = requested.filter((cid) => known.has(cid));
      }
    }

    await c.env.DB.batch([
      c.env.DB
        .prepare(`DELETE FROM user_companies WHERE user_id = ?`)
        .bind(userId),
      ...valid.map((cid) =>
        c.env.DB
          .prepare(
            `INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)`,
          )
          .bind(userId, cid),
      ),
    ]);
    return valid;
  } catch {
    return [];
  }
}

app.put("/:id/companies", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  const body = await c.req.json<{ companies?: unknown }>();
  const incoming = Array.isArray(body.companies) ? body.companies : [];

  const db = getDb(c.env);
  const target = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (target.length === 0) return c.json({ error: "User not found" }, 404);

  const valid = await setUserCompanies(c, id, incoming as number[]);
  await bustBannerForUser(c.env, id);
  return c.json({ ok: true, companies: valid });
});

app.get("/:id/activity", requirePermission("users.read"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);

  try {
    const rows = await c.env.DB.prepare(
      `SELECT id, created_at, actor_id, actor_email, action, entity_type, entity_id, summary, meta, ip, request_id
         FROM audit_events
        WHERE actor_id = ? OR (entity_type = 'user' AND entity_id = ?)
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
      .bind(id, String(id), limit)
      .all();
    return c.json({ activity: rows.results });
  } catch {
    return c.json({ activity: [] });
  }
});


app.put("/me/profile-pic", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
  const filename = c.req.query("name") || `profile-${Date.now()}.bin`;
  const contentType =
    c.req.header("content-type") || "application/octet-stream";
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ error: "Empty body" }, 400);
  if (buf.byteLength > 5 * 1024 * 1024) {
    return c.json({ error: "Image must be under 5 MB" }, 413);
  }

  const key = `user/${user.id}/${Date.now()}-${filename.replace(/[^\w.\-]+/g, "_")}`;
  await c.env.POD_BUCKET.put(key, buf, {
    httpMetadata: { contentType },
  });

  await c.env.DB.prepare(
    `UPDATE users SET profile_pic_r2_key = ? WHERE id = ?`,
  )
    .bind(key, user.id)
    .run();

  return c.json({ ok: true, profile_pic_r2_key: key });
});

app.delete("/me/profile-pic", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Your session has expired. Please sign in again." }, 401);
  await c.env.DB.prepare(
    `UPDATE users SET profile_pic_r2_key = NULL WHERE id = ?`,
  )
    .bind(user.id)
    .run();
  return c.json({ ok: true });
});

app.get("/:id/profile-pic", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Invalid ID." }, 400);
  const row = await c.env.DB.prepare(
    `SELECT profile_pic_r2_key FROM users WHERE id = ?`,
  )
    .bind(id)
    .first<{ profile_pic_r2_key: string | null }>();
  if (!row?.profile_pic_r2_key) {
    return c.json({ error: "No profile picture" }, 404);
  }
  const obj = await c.env.POD_BUCKET.get(row.profile_pic_r2_key);
  if (!obj) return c.json({ error: "Image missing" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);

  headers.set(
    "cache-control",
    avatarCacheControl(c.req.query("k"), row.profile_pic_r2_key),
  );
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(obj.body, { headers });
});

app.put("/:id/profile-pic", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "Invalid ID." }, 400);
  const filename = c.req.query("name") || `profile-${Date.now()}.bin`;
  const contentType = c.req.header("content-type") || "application/octet-stream";
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ error: "Empty body" }, 400);
  if (buf.byteLength > 5 * 1024 * 1024) {
    return c.json({ error: "Image must be under 5 MB" }, 413);
  }
  const key = `user/${id}/${Date.now()}-${filename.replace(/[^\w.\-]+/g, "_")}`;
  await c.env.POD_BUCKET.put(key, buf, { httpMetadata: { contentType } });
  const res = await c.env.DB.prepare(
    `UPDATE users SET profile_pic_r2_key = ? WHERE id = ?`,
  )
    .bind(key, id)
    .run();
  if (!res.meta.changes) return c.json({ error: "User not found" }, 404);
  return c.json({ ok: true, profile_pic_r2_key: key });
});

app.post("/invite", requirePermissionOrSalesDirector("users.manage"), async (c) => {
  const me = c.get("user");
  const body = await c.req.json<{
    email: string;
    role_id: number;
    name?: string;
    department_id?: number | null;
    position_id?: number | null;
    manager_id?: number | null;
    phone?: string | null;
    company_ids?: number[];
    password?: string;
    pos_pin?: string;
    email_alias?: string | null;
  }>();

  const db = getDb(c.env);

  // Sales Director → department-scoped invite. The new member is FORCED into
  // the director's own department; a position from another department is
  // rejected; and the role is ALWAYS the baseline, whatever the client sent —
  // the rule PATCH /:id applies by deleting role_id (docs/bugs/0887). A Sales
  // Director with no department cannot invite (fail-closed).
  const inviteScope = salesDirectorScope(c, "users.manage");
  if (inviteScope.scoped) {
    if (inviteScope.deptId == null) {
      return c.json(
        { error: "You have no department assigned — ask an admin to set yours before inviting." },
        403,
      );
    }
    body.department_id = inviteScope.deptId;
    if (body.position_id) {
      const pos = await db
        .select({ id: positions.id, department_id: positions.department_id })
        .from(positions)
        .where(eq(positions.id, body.position_id))
        .limit(1);
      if (pos.length === 0) return c.json({ error: "Position not found" }, 404);
      if (pos[0].department_id && pos[0].department_id !== inviteScope.deptId) {
        return c.json(
          { error: "You can only assign positions within your own department." },
          403,
        );
      }
    }
    const def = await resolveDefaultRoleId(db);
    if (def == null) return c.json({ error: "No role available to assign" }, 500);
    body.role_id = def;
  }

  if (!body.email || !body.role_id) {
    return c.json({ error: "Please enter an email and choose a role." }, 400);
  }
  const email = body.email.toLowerCase().trim();
  const name = body.name?.trim() || null;

  const directPassword = body.password?.trim() || null;
  let passwordHash: string | null = null;
  if (directPassword) {
    const strength = validatePasswordStrength(directPassword, email);
    if (!strength.ok) return c.json({ error: strength.error }, 400);
    passwordHash = await hashPassword(directPassword);
  }
  const activate = !!passwordHash;

  const role = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(eq(roles.id, body.role_id))
    .limit(1);
  if (role.length === 0) return c.json({ error: "Role not found" }, 404);

  let departmentId = body.department_id ?? null;
  const positionId = body.position_id ?? null;
  const managerId = body.manager_id ?? null;
  let positionSlug: string | null = null;
  if (positionId) {
    const pos = await db
      .select({
        id: positions.id,
        department_id: positions.department_id,
        slug: positions.slug,
      })
      .from(positions)
      .where(eq(positions.id, positionId))
      .limit(1);
    if (pos.length === 0) return c.json({ error: "Position not found" }, 404);
    if (departmentId && pos[0].department_id && pos[0].department_id !== departmentId) {
      return c.json(
        { error: "Position does not belong to the selected department" },
        400,
      );
    }
    if (!departmentId && pos[0].department_id) departmentId = pos[0].department_id;
    positionSlug = pos[0].slug ?? null;
  }

  const posPin = body.pos_pin?.trim() || null;
  if (posPin) {
    if (!isPosPin(posPin)) {
      return c.json({ error: "POS PIN must be exactly 6 digits" }, 400);
    }
    if (!isPosPinPosition(positionSlug)) {
      return c.json(
        {
          error:
            "A POS PIN only works for a Sales position — pick one, or leave the PIN blank.",
        },
        400,
      );
    }
  }

  const existing = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing.length > 0 && existing[0].status === "active") {
    return c.json({ error: "A user with that email already exists" }, 409);
  }

  const requestedAlias = body.email_alias?.trim().toLowerCase() || undefined;
  if (requestedAlias) {
    const domain = await companyMailboxDomain(c.env);
    if (!/^[a-z0-9._-]+@/.test(requestedAlias) || !requestedAlias.endsWith(`@${domain}`)) {
      return c.json({ error: `The company email must be an address on @${domain}.` }, 400);
    }
    if (await isPersonalAddressTaken(c.env.DB, requestedAlias, existing[0]?.id ?? null)) {
      return c.json({ error: `${requestedAlias} is already used by someone else.` }, 409);
    }
  }

  let userId: number | null = existing.length > 0 ? existing[0].id : null;
  if (existing.length === 0) {
    const insertedUser = await db
      .insert(users)
      .values({
        email,
        name,
        role_id: body.role_id,
        department_id: departmentId,
        position_id: positionId,
        manager_id: managerId,
        phone: normalizePhone(body.phone),
        status: activate ? "active" : "invited",
        invited_by: me.id || null,
        ...(activate
          ? {
              password_hash: passwordHash,
              joined_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` as unknown as string,
            }
          : {
              invited_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` as unknown as string,
            }),
      })
      .returning({ id: users.id });
    userId = insertedUser[0]?.id ?? null;
  } else {
    await db
      .update(users)
      .set({
        ...(name ? { name } : {}),
        role_id: body.role_id,
        department_id: departmentId,
        position_id: positionId,
        manager_id: managerId,
        ...(body.phone !== undefined ? { phone: normalizePhone(body.phone) } : {}),
        status: activate ? "active" : "invited",
        invited_by: me.id || null,
        ...(activate
          ? {
              password_hash: passwordHash,
              joined_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` as unknown as string,
            }
          : {
              invited_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` as unknown as string,
            }),
      })
      .where(eq(users.email, email));
    await db
      .delete(invitations)
      .where(and(eq(invitations.email, email), isNull(invitations.accepted_at)));
  }

  const inviteCompanyIds = inviteScope.scoped
    ? [1]
    : Array.isArray(body.company_ids) && body.company_ids.length > 0
      ? body.company_ids
      : [1];
  if (userId) await setUserCompanies(c, userId, inviteCompanyIds);

  let emailAlias: string | null = null;
  if (userId) {
    try {
      emailAlias = await provisionPersonalMailbox(c.env, userId, requestedAlias);
    } catch (e) {
      console.error("[users] invite mailbox provisioning failed:", e);
    }
  }

  if (userId && departmentId != null) {
    await syncSalesRepFromUser(c.env, userId, me.id);
  }

  const posPinSet = posPin && userId ? await setPosPinForUser(c.env, userId, posPin) : false;

  if (activate) {
    await audit(c, {
      action: "user.create",
      entityType: "user",
      entityId: email,
      summary: `Created ${email} as ${role[0].name} (active — password set by admin)`,
      meta: {
        email,
        role_id: body.role_id,
        department_id: departmentId,
        position_id: positionId,
        manager_id: managerId,
        activated: true,
        pos_pin_set: posPin ? posPinSet : undefined,
      },
    });
    return c.json({
      active: true,
      email,
      email_alias: emailAlias,
      ...(posPin ? { pos_pin_set: posPinSet } : {}),
    });
  }

  const token = generateToken();
  const expires = isoIn(INVITE_TTL_SECONDS);
  const inserted = await db
    .insert(invitations)
    .values({
      email,
      role_id: body.role_id,
      token,
      invited_by: me.id || 0,
      expires_at: expires,
      department_id: departmentId,
      position_id: positionId,
      manager_id: managerId,
    })
    .returning({ id: invitations.id });
  const invitationId = inserted[0]?.id ?? null;

  const identity = await activeCompanyEmailIdentity(c.env, c.get("companyCode"));
  const invite_url = publicUrl(c.env, `/invite/${token}`, identity.companyCode);
  const sendResult = await sendEmail(c.env, {
    to: email,
    subject: `You're invited to ${identity.productName}`,
    html: inviteEmailHtml({
      link: invite_url,
      roleName: role[0].name,
      inviterName: me?.name || me?.email || "Your admin",
      expiresIn: "14 days",
      productName: identity.productName,
    }),
    purpose: "member_invite",
    refType: "invitation",
    refId: invitationId,
    companyCode: identity.companyCode,
  });

  await audit(c, {
    action: "user.invite",
    entityType: "user",
    entityId: email,
    summary: `Invited ${email} as ${role[0].name}`,
    meta: {
      email,
      role_id: body.role_id,
      department_id: departmentId,
      position_id: positionId,
      manager_id: managerId,
      email_status: sendResult.status,
      pos_pin_set: posPin ? posPinSet : undefined,
    },
  });

  return c.json({
    token,
    expires_at: expires,
    email,
    invite_url,
    email_sent: sendResult.status === "sent",
    email_status: sendResult.status,
    email_alias: emailAlias,
    ...(posPin ? { pos_pin_set: posPinSet } : {}),
  });
});

app.post(
  "/invitations/:id/resend",
  requirePermission("users.manage"),
  async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!id) return c.json({ error: "Invalid ID." }, 400);
    const me = c.get("user");

    const db = getDb(c.env);
    const rows = await db
      .select({
        id: invitations.id,
        email: invitations.email,
        token: invitations.token,
        expires_at: invitations.expires_at,
        accepted_at: invitations.accepted_at,
        role_name: roles.name,
      })
      .from(invitations)
      .innerJoin(roles, eq(roles.id, invitations.role_id))
      .where(eq(invitations.id, id))
      .limit(1);
    if (rows.length === 0) return c.json({ error: "Invitation not found" }, 404);
    const inv = rows[0];
    if (inv.accepted_at) {
      return c.json({ error: "Invitation was already accepted" }, 409);
    }
    if (inv.expires_at < new Date().toISOString()) {
      return c.json(
        { error: "Invitation has expired — issue a new one instead" },
        410
      );
    }

    const identity = await activeCompanyEmailIdentity(c.env, c.get("companyCode"));
    const invite_url = publicUrl(c.env, `/invite/${inv.token}`, identity.companyCode);
    const sendResult = await sendEmail(c.env, {
      to: inv.email,
      subject: `You're invited to ${identity.productName}`,
      html: inviteEmailHtml({
        link: invite_url,
        roleName: inv.role_name,
        inviterName: me?.name || me?.email || "Your admin",
        expiresIn: "14 days",
        productName: identity.productName,
      }),
      purpose: "member_invite",
      refType: "invitation",
      refId: inv.id,
      companyCode: identity.companyCode,
    });

    return c.json({
      ok: true,
      invite_url,
      email_sent: sendResult.status === "sent",
      email_status: sendResult.status,
    });
  }
);

app.post("/:id/resend-invite", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const me = c.get("user");

  const db = getDb(c.env);
  const urows = await db
    .select({ email: users.email, status: users.status })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (urows.length === 0) return c.json({ error: "Member not found" }, 404);
  const member = urows[0];
  if (member.status === "active") {
    return c.json({ error: "This member has already joined" }, 409);
  }

  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      token: invitations.token,
      expires_at: invitations.expires_at,
      role_name: roles.name,
    })
    .from(invitations)
    .innerJoin(roles, eq(roles.id, invitations.role_id))
    .where(and(eq(invitations.email, member.email), isNull(invitations.accepted_at)))
    .orderBy(desc(invitations.id))
    .limit(1);
  if (rows.length === 0) {
    return c.json({ error: "No pending invitation for this member" }, 404);
  }
  const inv = rows[0];
  if (inv.expires_at < new Date().toISOString()) {
    return c.json(
      { error: "Invitation has expired — issue a new one instead" },
      410
    );
  }

  const identity = await activeCompanyEmailIdentity(c.env, c.get("companyCode"));
  const invite_url = publicUrl(c.env, `/invite/${inv.token}`, identity.companyCode);
  const sendResult = await sendEmail(c.env, {
    to: inv.email,
    subject: `You're invited to ${identity.productName}`,
    html: inviteEmailHtml({
      link: invite_url,
      roleName: inv.role_name,
      inviterName: me?.name || me?.email || "Your admin",
      expiresIn: "14 days",
      productName: identity.productName,
    }),
    purpose: "member_invite",
    refType: "invitation",
    refId: inv.id,
    companyCode: identity.companyCode,
  });

  return c.json({
    ok: true,
    invite_url,
    email_sent: sendResult.status === "sent",
    email_status: sendResult.status,
  });
});

app.patch("/:id", requirePermissionOrSalesDirector("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const me = c.get("user");
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  if (id === me.id) {
    return c.json({ error: "You cannot modify your own role or status" }, 400);
  }

  const body = await c.req.json<{
    role_id?: number;
    status?: string;
    manager_id?: number | null;
    department_id?: number | null;
    department_ids?: number[];
    position_id?: number | null;
    division?: string | null;
    name?: string | null;
    phone?: string | null;
    email?: string;
    email_alias?: string | null;
    status_reason?: string | null;
    company_ids?: number[];
    password?: string;
  }>();

  const db = getDb(c.env);

  const current = await db
    .select({
      id: users.id,
      email: users.email,
      email_alias: users.email_alias,
      name: users.name,
      department_id: users.department_id,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (current.length === 0) return c.json({ error: "User not found" }, 404);

  const dirScope = salesDirectorScope(c, "users.manage");
  if (dirScope.scoped) {
    let inDirScope = current[0].department_id === dirScope.deptId;
    if (!inDirScope && dirScope.deptId != null) {
      const secondary = await db
        .select({ userId: user_departments.user_id })
        .from(user_departments)
        .where(
          and(
            eq(user_departments.user_id, id),
            eq(user_departments.department_id, dirScope.deptId),
          ),
        )
        .limit(1);
      inDirScope = secondary.length > 0;
    }
    if (!inDirScope) {
      return c.json({ error: "User not found" }, 404);
    }
    delete body.role_id;
    delete body.position_id;
    delete body.department_id;
    delete body.department_ids;
    delete body.manager_id;
    delete body.company_ids;
    delete body.password;
    delete body.email;
    delete body.email_alias;
  }

  const set: Record<string, any> = {};

  if (body.role_id != null) {
    const role = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.id, body.role_id))
      .limit(1);
    if (role.length === 0) return c.json({ error: "Role not found" }, 404);
    set.role_id = body.role_id;
  }

  if (body.status != null) {
    if (!["active", "disabled"].includes(body.status)) {
      return c.json({ error: "status must be active or disabled" }, 400);
    }
    set.status = body.status;
  }

  if (body.status === "active") {
    set.status_reason = null;
  } else if (body.status_reason !== undefined) {
    set.status_reason = body.status_reason?.trim() || null;
  }

  if (body.division !== undefined) {
    set.division = body.division?.trim() || null;
  }

  if (body.password) {
    const strength = validatePasswordStrength(body.password, current[0].email);
    if (!strength.ok) return c.json({ error: strength.error }, 400);
    set.password_hash = await hashPassword(body.password);
  }

  if (body.manager_id !== undefined) {
    if (body.manager_id === null) {
      set.manager_id = null;
    } else {
      const mgr = parseInt(String(body.manager_id), 10);
      if (!mgr) return c.json({ error: "Please choose a valid manager." }, 400);
      if (mgr === id) return c.json({ error: "Cannot report to yourself" }, 400);
      let cursor: number | null = mgr;
      const seen = new Set<number>();
      while (cursor != null) {
        if (cursor === id) {
          return c.json(
            { error: "Cycle detected — that user reports to you (directly or indirectly)" },
            400
          );
        }
        if (seen.has(cursor)) break;
        seen.add(cursor);
        const mgrRow = await db
          .select({ manager_id: users.manager_id })
          .from(users)
          .where(eq(users.id, cursor))
          .limit(1);
        if (mgrRow.length === 0) return c.json({ error: "Manager not found" }, 404);
        cursor = mgrRow[0].manager_id;
      }
      set.manager_id = mgr;
    }
  }

  if (body.department_id !== undefined) {
    if (body.department_id === null) {
      set.department_id = null;
    } else {
      const dept = parseInt(String(body.department_id), 10);
      if (!dept) return c.json({ error: "Please choose a valid department." }, 400);
      const exists = await db
        .select({ id: departments.id })
        .from(departments)
        .where(eq(departments.id, dept))
        .limit(1);
      if (exists.length === 0) return c.json({ error: "Department not found" }, 404);
      set.department_id = dept;
    }
  }

  if (body.position_id !== undefined) {
    if (body.position_id === null) {
      set.position_id = null;
    } else {
      const posId = parseInt(String(body.position_id), 10);
      if (!posId) return c.json({ error: "Please choose a valid position." }, 400);
      const pos = await db
        .select({ id: positions.id, department_id: positions.department_id })
        .from(positions)
        .where(eq(positions.id, posId))
        .limit(1);
      if (pos.length === 0) return c.json({ error: "Position not found" }, 404);
      set.position_id = posId;
      if (body.department_id === undefined && pos[0].department_id) {
        set.department_id = pos[0].department_id;
      }
    }
  }

  if (body.name !== undefined) {
    set.name = body.name?.trim() || null;
  }
  if (body.phone !== undefined) {
    set.phone = normalizePhone(body.phone);
  }
  if (body.email_alias !== undefined) {
    set.email_alias = body.email_alias?.trim().toLowerCase() || null;
  }
  if (body.email !== undefined) {
    const em = String(body.email).toLowerCase().trim();
    if (!em || !em.includes("@")) {
      return c.json({ error: "Invalid email" }, 400);
    }
    const clash = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, em))
      .limit(1);
    if (clash.length && clash[0].id !== id) {
      return c.json({ error: "A user with that email already exists" }, 409);
    }
    set.email = em;
  }

  let finalDeptIds: number[] | null = null;
  if (Array.isArray(body.department_ids)) {
    const requested = [
      ...new Set(
        body.department_ids
          .map((x) => parseInt(String(x), 10))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    ];
    if (requested.length > 0) {
      const found = await db
        .select({ id: departments.id })
        .from(departments)
        .where(inArray(departments.id, requested));
      const allowed = new Set(found.map((d) => d.id));
      finalDeptIds = requested.filter((d) => allowed.has(d));
    } else {
      finalDeptIds = [];
    }

    const primaryDept =
      "department_id" in set
        ? (set.department_id as number | null)
        : current[0].department_id;
    if (primaryDept != null) {
      if (!finalDeptIds.includes(primaryDept)) finalDeptIds.unshift(primaryDept);
    } else if (finalDeptIds.length > 0) {
      set.department_id = finalDeptIds[0];
    }
  }

  const hasCompanyChange = Array.isArray(body.company_ids);

  if (Object.keys(set).length === 0 && finalDeptIds === null && !hasCompanyChange) {
    return c.json({ error: "No fields to update" }, 400);
  }

  const auditedSet = { ...set };
  let personalMailboxAliasChange: PersonalMailboxAliasChange | null = null;
  if (body.email_alias !== undefined) {
    try {
      personalMailboxAliasChange = await changePersonalMailboxAliasAtomically(
        c.env,
        id,
        current[0].email_alias ?? null,
        (set.email_alias as string | null | undefined) ?? null,
        body.name !== undefined ? (body.name?.trim() || null) : current[0].name,
      );
    } catch (error) {
      if (error instanceof AliasMailboxCollisionError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
    if (personalMailboxAliasChange?.mailbox_id) await markMailHostPending(c.env.DB, personalMailboxAliasChange.mailbox_id);
  }
  if (body.email_alias !== undefined) delete set.email_alias;

  if (Object.keys(set).length > 0) {
    const result = await db.update(users).set(set).where(eq(users.id, id));
    if (!result.count) return c.json({ error: "User not found" }, 404);
  }

  if (finalDeptIds !== null) {
    await db.delete(user_departments).where(eq(user_departments.user_id, id));
    if (finalDeptIds.length > 0) {
      await db
        .insert(user_departments)
        .values(finalDeptIds.map((d) => ({ user_id: id, department_id: d })));
    }
  } else if ("department_id" in set) {
    if (set.department_id != null) {
      await db
        .insert(user_departments)
        .values({ user_id: id, department_id: set.department_id })
        .onConflictDoNothing();
    } else if (current[0].department_id != null) {
      await db
        .delete(user_departments)
        .where(
          and(
            eq(user_departments.user_id, id),
            eq(user_departments.department_id, current[0].department_id),
          ),
        );
    }
  }

  let finalCompanyIds: number[] | null = null;
  if (hasCompanyChange) {
    finalCompanyIds = await setUserCompanies(c, id, body.company_ids as number[]);
  }

  if (body.status === "disabled") {
    await bustUserSessions(c.env, id);
    await db.delete(sessions).where(eq(sessions.user_id, id));
    await closePersonalMailOnDisable(c.env.DB, id);
  } else if (set.role_id != null) {
    await bustUserSessions(c.env, id);
  }
  if (body.status === "active" && current[0].status === "disabled") {
    await reopenPersonalMailbox(c.env.DB, id);
  }

  if (body.department_id !== undefined || set.department_id !== undefined) {
    await syncSalesRepFromUser(c.env, id, me.id);
  }

  const bannerTargetingChanged =
    "department_id" in set || "division" in set ||
    "position_id" in set ||
    "role_id" in set ||
    "status" in set ||
    finalDeptIds !== null ||
    hasCompanyChange;
  if (bannerTargetingChanged) {
    await bustBannerForUser(c.env, id);
  }

  const changedKeys = [
    ...Object.keys(auditedSet),
    ...(finalDeptIds !== null ? ["department_ids"] : []),
    ...(finalCompanyIds !== null ? ["company_ids"] : []),
  ];
  await audit(c, {
    action: "user.update",
    entityType: "user",
    entityId: id,
    summary: `Updated user #${id} (${changedKeys.join(", ")})`,
    meta: {
      changed: auditedSet,
      ...(personalMailboxAliasChange
        ? { personal_mailbox_alias_change: personalMailboxAliasChange }
        : {}),
      ...(finalDeptIds !== null ? { department_ids: finalDeptIds } : {}),
      ...(finalCompanyIds !== null ? { company_ids: finalCompanyIds } : {}),
    },
  });

  return c.json({ ok: true });
});

app.delete("/:id", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const me = c.get("user");
  const hard = c.req.query("hard") === "1";
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  if (id === me.id) return c.json({ error: "You cannot delete yourself" }, 400);

  const db = getDb(c.env);
  const row = await db
    .select({
      id: users.id,
      email: users.email,
      status: users.status,
      role_name: roles.name,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.role_id))
    .where(eq(users.id, id))
    .limit(1);
  if (row.length === 0) return c.json({ error: "User not found" }, 404);
  const target = row[0];

  if (target.role_name === "Owner") {
    const owners = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.role_id))
      .where(and(eq(roles.name, "Owner"), eq(users.status, "active")));
    if ((owners[0]?.count ?? 0) <= 1) {
      return c.json({ error: "Cannot remove the last Owner" }, 400);
    }
  }

  await bustUserSessions(c.env, id);
  await bustBannerForUser(c.env, id);
  await db.delete(sessions).where(eq(sessions.user_id, id));
  await closePersonalMailOnDisable(c.env.DB, id);

  if (hard || target.status === "invited") {
    await db.delete(invitations).where(eq(invitations.email, target.email));
    const safeExec = async (sql: string) => {
      try { await c.env.DB.prepare(sql).bind(id).run(); } catch {}
    };
    await safeExec(`DELETE FROM project_activity WHERE user_id = ?`);
    await safeExec(`DELETE FROM project_reads WHERE user_id = ?`);
    await safeExec(`DELETE FROM point_transactions WHERE user_id = ? OR counterparty_user_id = ?`);
    await safeExec(`DELETE FROM user_streak_weeks WHERE user_id = ?`);
    await safeExec(`DELETE FROM award_redemptions WHERE user_id = ?`);

    try {
      await db.delete(users).where(eq(users.id, id));
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? "");
      if (/FOREIGN KEY|SQLITE_CONSTRAINT/i.test(msg)) {
        return c.json(
          {
            error:
              "Cannot hard-delete: this user is referenced by trips, sales entries, or other records. Disable the user instead (soft-delete) to preserve those rows.",
            detail: msg,
          },
          400,
        );
      }
      throw e;
    }
    await audit(c, {
      action: "user.delete",
      entityType: "user",
      entityId: id,
      summary: `Hard-deleted user ${target.email} (#${id})`,
      meta: { email: target.email, role: target.role_name, hard: true },
    });
    return c.json({ ok: true, action: "deleted" });
  }

  await db.update(users).set({ status: "disabled" }).where(eq(users.id, id));


  await audit(c, {
    action: "user.disable",
    entityType: "user",
    entityId: id,
    summary: `Disabled user ${target.email} (#${id})`,
    meta: { email: target.email, role: target.role_name },
  });

  return c.json({ ok: true, action: "disabled" });
});

app.get("/invitations", requirePermissionOrSalesDirector("users.read"), async (c) => {
  const db = getDb(c.env);
  const inviter = alias(users, "ib");
  const scope = salesDirectorScope(c, "users.read");
  const inviteConds: any[] = [isNull(invitations.accepted_at)];
  if (scope.scoped) {
    inviteConds.push(
      scope.deptId != null
        ? eq(invitations.department_id, scope.deptId)
        : sql`1 = 0`,
    );
  }
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role_id: invitations.role_id,
      role_name: roles.name,
      token: invitations.token,
      expires_at: invitations.expires_at,
      created_at: invitations.created_at,
      accepted_at: invitations.accepted_at,
      invited_by_email: inviter.email,
      email_status: sql<string | null>`(
        SELECT el.status FROM email_log el
         WHERE el.ref_type = 'invitation' AND el.ref_id = ${invitations.id}
         ORDER BY el.id DESC LIMIT 1
      )`,
      emailed_at: sql<string | null>`(
        SELECT el.created_at FROM email_log el
         WHERE el.ref_type = 'invitation' AND el.ref_id = ${invitations.id}
           AND el.status = 'sent'
         ORDER BY el.id DESC LIMIT 1
      )`,
    })
    .from(invitations)
    .innerJoin(roles, eq(roles.id, invitations.role_id))
    .leftJoin(inviter, eq(inviter.id, invitations.invited_by))
    .where(and(...inviteConds))
    .orderBy(desc(invitations.created_at));
  return c.json({
    invitations: rows.map((r) => ({
      ...r,
      invite_url: publicUrl(c.env, `/invite/${r.token}`),
    })),
  });
});

app.delete("/invitations/:id", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  const db = getDb(c.env);
  const inv = await db
    .select({ email: invitations.email })
    .from(invitations)
    .where(eq(invitations.id, id))
    .limit(1);
  if (inv.length === 0) return c.json({ error: "Invitation not found" }, 404);

  await db
    .delete(users)
    .where(and(eq(users.email, inv[0].email), eq(users.status, "invited")));
  await db.delete(invitations).where(eq(invitations.id, id));

  return c.json({ ok: true });
});

app.post("/:id/impersonate", requirePermission("users.manage"), async (c) => {
  const me = c.get("user");
  const granted = me?.permissions_set ?? me?.permissions ?? [];
  if (!hasPermission(granted, "*")) {
    return c.json({ error: "Owner only" }, 403);
  }
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  const db = getDb(c.env);
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, status: users.status })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (rows.length === 0) return c.json({ error: "User not found" }, 404);   const gate = await targetWithinActorCompanies(c, id); if (!gate.ok) return c.json(gate.body, 403);
  if (rows[0].status !== "active") {
    return c.json({ error: "User is not active — only active members can be viewed as" }, 400);
  }

  const token = generateToken();
  const expires = isoIn(60 * 60);
  await c.env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`
  )
    .bind(token, id, expires)
    .run();

  await audit(c, {
    action: "user.impersonate",
    entityType: "user",
    entityId: rows[0].email,
    summary: `View-as session minted for ${rows[0].email} (expires in 1h)`,
    meta: { target_user_id: id, expires_at: expires },
  });

  return c.json({
    token,
    expires_at: expires,
    user_id: rows[0].id,
    name: rows[0].name,
    email: rows[0].email,
  });
});

/**
 * POST /api/users/:id/reset-password
 * Admin-triggered "send reset link". THE ACCOUNT IS NOT TOUCHED — no hash, no
 * status, no session change; only redeeming the link changes anything. It must
 * NOT return the token either: the link is a credential and goes to the
 * mailbox, never to the admin who pressed the button. Both of those are
 * deliberate removals, not omissions — the full reasoning, the owner's wording
 * and the account-takeover primitive they closed are in
 * docs/modules/team-members.md section 5. Rate-limited on the TARGET.
 */
app.post("/:id/reset-password", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);   const gate = await targetWithinActorCompanies(c, id); if (!gate.ok) return c.json(gate.body, 403);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const me = c.get("user");

  const limited = await checkRateLimit(c, "admin-reset", String(id), 3, 900);
  if (limited) return limited;

  const db = getDb(c.env);
  const targetRow = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (targetRow.length === 0) return c.json({ error: "User not found" }, 404);
  const target = targetRow[0];

  if (target.status === "invited") {
    return c.json(
      { error: "User is still invited — resend the invitation instead." },
      400
    );
  }

  await db
    .update(password_resets)
    .set({ consumed_at: sql`to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')` as unknown as string })
    .where(
      and(eq(password_resets.user_id, id), isNull(password_resets.consumed_at))
    );

  const token = generateToken();
  const expiresAt = isoIn(RESET_TTL_SECONDS);
  await db.insert(password_resets).values({
    user_id: id,
    token,
    requested_by: me?.id || null,
    expires_at: expiresAt,
  });


  const identity = await activeCompanyEmailIdentity(c.env, c.get("companyCode"));
  const link = publicUrl(c.env, `/reset/${token}`, identity.companyCode);
  const name = (target.name || target.email.split("@")[0]).split(" ")[0];
  const sendResult = await sendEmail(c.env, {
    to: target.email,
    subject: `Reset your ${identity.productName} password`,
    html: resetEmailHtml({
      name,
      link,
      expiresIn: "1 hour",
      requestedBy: me?.name || me?.email || "Your admin",
      productName: identity.productName,
    }),
    purpose: "password_reset",
    refType: "user",
    refId: id,
    companyCode: identity.companyCode,
  });

  await audit(c, {
    action: "user.reset_password",
    entityType: "user",
    entityId: id,
    summary: `Sent password reset link to ${target.email} (#${id})`,
    meta: { email: target.email, email_status: sendResult.status },
  });

  return c.json({
    ok: true,
    expires_at: expiresAt,
    email: target.email,
    email_sent: sendResult.status === "sent",
    email_status: sendResult.status,
  });
});

app.post("/:id/totp/disable", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);   const gate = await targetWithinActorCompanies(c, id); if (!gate.ok) return c.json(gate.body, 403);
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  const db = getDb(c.env);
  const row = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (row.length === 0) return c.json({ error: "User not found" }, 404);

  await c.env.DB.prepare(
    `UPDATE users
        SET totp_enabled = 0, totp_secret = NULL,
            totp_enrolled_at = NULL, totp_backup_codes = NULL
      WHERE id = ?`,
  )
    .bind(id)
    .run();

  await audit(c, {
    action: "user.totp.admin_disable",
    entityType: "user",
    entityId: id,
    summary: `Admin cleared 2FA for ${row[0].email} (#${id})`,
    meta: { email: row[0].email },
  });

  return c.json({ ok: true });
});

app.post("/:id/require-password-change", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const gate = await targetWithinActorCompanies(c, id);
  if (!gate.ok) return c.json(gate.body, 403);

  const target = await c.env.DB.prepare(`SELECT id, email, status FROM users WHERE id = ?`)
    .bind(id)
    .first<{ id: number; email: string; status: string }>();
  if (!target) return c.json({ error: "User not found" }, 404);
  if (target.status === "invited") {
    return c.json({ error: "User is still invited and has no password yet." }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE users SET password_change_required_at = datetime('now') WHERE id = ?`,
  )
    .bind(id)
    .run();
  await bustUserSessions(c.env, id);
  const ended = await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();
  const sessionsEnded = Number(ended.meta?.changes ?? 0);

  await audit(c, {
    action: "user.require_password_change",
    entityType: "user",
    entityId: id,
    summary: `Required a new password at next sign-in for ${target.email} (#${id}); ended ${sessionsEnded} session(s)`,
    meta: { email: target.email, sessions_ended: sessionsEnded },
  });

  return c.json({ ok: true, sessions_ended: sessionsEnded });
});

app.delete("/:id/require-password-change", requirePermission("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!id) return c.json({ error: "Invalid ID." }, 400);
  const gate = await targetWithinActorCompanies(c, id);
  if (!gate.ok) return c.json(gate.body, 403);

  const target = await c.env.DB.prepare(`SELECT id, email FROM users WHERE id = ?`)
    .bind(id)
    .first<{ id: number; email: string }>();
  if (!target) return c.json({ error: "User not found" }, 404);

  await c.env.DB.prepare(`UPDATE users SET password_change_required_at = NULL WHERE id = ?`)
    .bind(id)
    .run();

  await audit(c, {
    action: "user.require_password_change.clear",
    entityType: "user",
    entityId: id,
    summary: `Cleared the required password change for ${target.email} (#${id})`,
    meta: { email: target.email },
  });

  return c.json({ ok: true });
});

// ── Impersonation ────────────────────────────────────────────────────────────
// THE app.post("/:id/impersonate") BELOW IS DEAD — the earlier registration in
// this file shadows it, so the two-door design it implements never runs, while
// GET /impersonation-enabled (unshadowed) still advertises the staging door.
// LEFT AS IS on purpose; it is the owner's decision which door is correct.
// Read docs/modules/team-members.md section 4 before touching either one.

const hasWildcard = (
  u: { permissions_set?: Set<string>; permissions: string[] } | undefined,
): boolean => !!u && hasPermission(u.permissions_set ?? u.permissions, "*");

app.get("/impersonation-enabled", requirePermission("users.manage"), (c) =>
  c.json({
    enabled: c.env.IMPERSONATION_ENABLED === "true" || hasWildcard(c.get("user")),
  }),
);

app.post("/:id/impersonate", requirePermission("users.manage"), async (c) => {
  const viaStagingFlag = c.env.IMPERSONATION_ENABLED === "true";
  if (!viaStagingFlag && !hasWildcard(c.get("user"))) {
    return c.json({ error: "Not found" }, 404);
  }
  const id = Number(c.req.param("id"));
  const me = c.get("user");
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid user id" }, 400);
  if (me && me.id === id) return c.json({ error: "You are already this user" }, 400);

  const db = getDb(c.env);
  const row = await db
    .select({ id: users.id, email: users.email, status: users.status })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!row.length) return c.json({ error: "User not found" }, 404);
  if (row[0].status !== "active") return c.json({ error: "Account is disabled" }, 403);

  const token = await createSession(c.env, id, undefined, viaStagingFlag ? undefined : 60 * 60);

  await audit(c, {
    action: "user.impersonate",
    entityType: "user",
    entityId: id,
    summary: `Impersonation session minted for ${row[0].email} (#${id})`,
    meta: { email: row[0].email, via: viaStagingFlag ? "staging_flag" : "owner_wildcard" },
  });

  return c.json({ token, user_id: id });
});

export default app;
