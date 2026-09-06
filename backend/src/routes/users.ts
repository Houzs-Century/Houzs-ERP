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
import {
  getBranding,
  getBrandingForCompany,
  resolveCompanyCode,
} from "../services/branding";

// Invite/reset emails carry the ACTIVE company's identity (the admin's top-bar
// pick): product name in the copy, From display name, and link hostname.
// Pre-multi-company (companyContext unset) this resolves HOUZS — unchanged.
async function activeCompanyEmailIdentity(
  env: Env,
  companyCodeVar: string | undefined,
): Promise<{ companyCode: string; productName: string }> {
  const companyCode = await resolveCompanyCode(env, companyCodeVar);
  const branding = await getBrandingForCompany(env, companyCode);
  return { companyCode, productName: erpProductName(branding) };
}
import { getDb } from "../db/client";
import { resolveDatabaseUrl } from "../db/pg";
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

// Auto-provision a member's PERSONAL Mail Center mailbox when their email_alias
// is set/changed to a company-domain address (owner: "成员设 alias 就自动建箱").
// Idempotent: ensures one email_addresses row (assigned to the user, active) +
// one email_address_access grant. Fires ONLY for an alias on the company's own
// verified domain — a personal gmail/etc. can't send/receive through our IMAP +
// Resend, so we never mint a dead mailbox. Raw SQL: the mail tables live outside
// the Drizzle schema (managed the same way in routes/mail-center.ts).
interface PersonalMailboxAliasChange {
  old_alias: string;
  old_mailbox_id: string | null;
  new_alias: string;
  // The canonical id resolved inside the same commit as users.email_alias.
  mailbox_id: string | null;
}

export class AliasMailboxCollisionError extends Error {
  constructor(readonly address: string) {
    super(`Mail alias ${address} is already assigned to another user`);
    this.name = "AliasMailboxCollisionError";
  }
}

async function companyMailboxDomain(env: Env): Promise<string> {
  const fallback = "houzscentury.com";
  try {
    const branding = await getBranding(env);
    return (branding.email.split("@")[1] || fallback).trim().toLowerCase();
  } catch {
    // Branding is optional during bootstrap. Provisioning writes below remain
    // fail-closed; this is only the established default-domain fallback.
    return fallback;
  }
}

// Change the canonical alias and all DERIVED personal-mailbox ownership as one
// commit. A company-domain alias is guaranteed to resolve to one active mailbox
// owned by the user plus one self-grant before users.email_alias can change.
// An inbound-created, unowned mailbox may be claimed; a mailbox owned by another
// user is a hard collision and is never reassigned. The previous mailbox stays
// active and other users' grants survive when this user's ownership moves away.
export async function changePersonalMailboxAliasAtomically(
  env: Env,
  userId: number,
  previousAlias: string | null,
  nextAlias: string | null,
  displayName?: string | null,
): Promise<PersonalMailboxAliasChange | null> {
  const oldAddr = (previousAlias ?? "").trim().toLowerCase();
  const newAddr = (nextAlias ?? "").trim().toLowerCase();
  if (oldAddr === newAddr) return null;

  const domain = await companyMailboxDomain(env);
  const shouldProvision = !!newAddr && newAddr.endsWith(`@${domain}`);
  const now = new Date().toISOString();
  const candidateMailboxId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  let label = displayName?.trim() || null;
  if (displayName === undefined) {
    const user = await env.DB.prepare(`SELECT name FROM users WHERE id = ? LIMIT 1`)
      .bind(userId)
      .first<{ name: string | null }>();
    label = user?.name?.trim() || null;
  }

  const oldMailbox = await env.DB.prepare(
    `SELECT id FROM email_addresses
       WHERE lower(address) = ? AND assigned_user_id = ? LIMIT 1`,
  )
    .bind(oldAddr, userId)
    .first<{ id: string }>();

  if (resolveDatabaseUrl(env)) {
    // PostgreSQL path: one statement is one real transaction. Every mutating
    // CTE is gated by ready_user, so collision or concurrent alias drift writes
    // nothing. d1Compat.batch is intentionally not used on the PG path.
    const result = await env.DB.prepare(
      `WITH target_user AS (
         SELECT id, email_alias
           FROM users
          WHERE id = ? AND lower(COALESCE(email_alias, '')) = ?
          FOR UPDATE
       ), existing_new AS (
         SELECT ea.id, ea.assigned_user_id
           FROM email_addresses ea
          WHERE ? = 1 AND lower(ea.address) = ?
          FOR UPDATE
       ), can_commit AS (
         SELECT cu.id
           FROM target_user cu
          WHERE ? = 0
             OR NOT EXISTS (
               SELECT 1 FROM existing_new en
                WHERE en.assigned_user_id IS NOT NULL
                  AND en.assigned_user_id <> cu.id
             )
       ), inserted_new AS (
         INSERT INTO email_addresses
           (id, address, label, assigned_user_id, assigned_user_name,
            assigned_dept, assigned_position, active, created_at, created_by)
         SELECT ?, ?, ?, cc.id, ?, NULL, NULL, 1, ?, cc.id
           FROM can_commit cc
          WHERE ? = 1 AND NOT EXISTS (SELECT 1 FROM existing_new)
         ON CONFLICT DO NOTHING
         RETURNING id
       ), claimed_new AS (
         UPDATE email_addresses ea
            SET assigned_user_id = cc.id,
                assigned_user_name = ?,
                active = 1
           FROM can_commit cc
          WHERE ? = 1 AND lower(ea.address) = ?
            AND (ea.assigned_user_id IS NULL OR ea.assigned_user_id = cc.id)
         RETURNING ea.id
       ), final_new AS (
         SELECT id FROM inserted_new
         UNION
         SELECT id FROM claimed_new
       ), ready_user AS (
         SELECT cc.id
           FROM can_commit cc
          WHERE ? = 0 OR EXISTS (SELECT 1 FROM final_new)
       ), old_mailbox AS (
         SELECT ea.id
           FROM email_addresses ea
           JOIN ready_user ru ON ea.assigned_user_id = ru.id
          WHERE lower(ea.address) = ? AND ? <> ''
          FOR UPDATE
       ), inserted_grant AS (
         INSERT INTO email_address_access
           (id, address_id, user_id, created_at, created_by)
         SELECT ?, fn.id, ru.id, ?, ru.id
           FROM final_new fn CROSS JOIN ready_user ru
         ON CONFLICT (address_id, user_id) DO NOTHING
         RETURNING address_id
       ), deleted_grant AS (
         DELETE FROM email_address_access a
          USING old_mailbox om, ready_user ru
          WHERE a.address_id = om.id AND a.user_id = ru.id
          RETURNING a.address_id
       ), cleared_owner AS (
         UPDATE email_addresses ea
            SET assigned_user_id = NULL, assigned_user_name = NULL
           FROM old_mailbox om, ready_user ru
          WHERE ea.id = om.id AND ea.assigned_user_id = ru.id
          RETURNING ea.id
       ), updated_user AS (
         UPDATE users u
            SET email_alias = ?
           FROM ready_user ru
          WHERE u.id = ru.id
          RETURNING u.id
       )
       SELECT (SELECT id FROM target_user LIMIT 1) AS current_user_id,
              (SELECT id FROM can_commit LIMIT 1) AS eligible_user_id,
              (SELECT id FROM updated_user LIMIT 1) AS user_id,
              (SELECT id FROM old_mailbox LIMIT 1) AS old_mailbox_id,
              (SELECT id FROM final_new LIMIT 1) AS mailbox_id,
              (SELECT COUNT(*) FROM deleted_grant) AS grants_removed,
              (SELECT COUNT(*) FROM cleared_owner) AS owners_cleared,
              (SELECT COUNT(*) FROM inserted_grant) AS grants_inserted`
    )
      .bind(
        userId,
        oldAddr,
        shouldProvision ? 1 : 0,
        newAddr,
        shouldProvision ? 1 : 0,
        candidateMailboxId,
        newAddr,
        label,
        label,
        now,
        shouldProvision ? 1 : 0,
        label,
        shouldProvision ? 1 : 0,
        newAddr,
        shouldProvision ? 1 : 0,
        oldAddr,
        oldAddr,
        grantId,
        now,
        nextAlias,
      )
      .first<{
        current_user_id: number | null;
        eligible_user_id: number | null;
        user_id: number | null;
        old_mailbox_id: string | null;
        mailbox_id: string | null;
      }>();
    if (result?.current_user_id == null) {
      throw new Error("email alias changed concurrently; reload and try again");
    }
    if (result.eligible_user_id == null) {
      throw new AliasMailboxCollisionError(newAddr);
    }
    if (result.user_id == null || (shouldProvision && result.mailbox_id == null)) {
      throw new Error("mail alias provisioning could not be committed; reload and try again");
    }
    return {
      old_alias: oldAddr,
      old_mailbox_id: result.old_mailbox_id,
      new_alias: newAddr,
      mailbox_id: result.mailbox_id,
    };
  } else {
    // Native D1 path. Cloudflare D1 batch is transaction-bound: any statement
    // failure rolls the whole batch back. This branch is selected only when no
    // PG/HYPERDRIVE URL exists, so d1Compat.batch is never trusted here.
    const expectedUser = `EXISTS (
      SELECT 1 FROM users
       WHERE id = ? AND lower(COALESCE(email_alias, '')) = ?
    )`;
    const statements: D1PreparedStatement[] = [];
    if (shouldProvision) {
      // Existing unowned (inbound-created) mailboxes may be claimed. The guard
      // grant intentionally violates address_id NOT NULL for another owner's
      // mailbox, making D1 roll the entire batch back instead of taking it over.
      statements.push(
        env.DB.prepare(
          `INSERT INTO email_addresses
             (id, address, label, assigned_user_id, assigned_user_name,
              assigned_dept, assigned_position, active, created_at, created_by)
           SELECT ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?
            WHERE ${expectedUser}
           ON CONFLICT DO NOTHING`,
        ).bind(candidateMailboxId, newAddr, label, userId, label, now, userId, userId, oldAddr),
        env.DB.prepare(
          `INSERT INTO email_address_access
             (id, address_id, user_id, created_at, created_by)
           SELECT ?,
                  CASE
                    WHEN (ea.assigned_user_id IS NULL OR ea.assigned_user_id = ?)
                     AND ${expectedUser}
                    THEN ea.id
                    ELSE NULL
                  END,
                  ?, ?, ?
             FROM email_addresses ea
            WHERE lower(ea.address) = ?
           ON CONFLICT DO NOTHING`,
        ).bind(grantId, userId, userId, oldAddr, userId, now, userId, newAddr),
        env.DB.prepare(
          `UPDATE email_addresses
              SET assigned_user_id = ?, assigned_user_name = ?, active = 1
            WHERE lower(address) = ?
              AND (assigned_user_id IS NULL OR assigned_user_id = ?)
              AND ${expectedUser}`,
        ).bind(userId, label, newAddr, userId, userId, oldAddr),
      );
    }

    const revokeOffset = statements.length;
    statements.push(
      env.DB.prepare(
        `DELETE FROM email_address_access
          WHERE user_id = ?
            AND ? <> ''
            AND address_id IN (
              SELECT id FROM email_addresses
               WHERE lower(address) = ? AND assigned_user_id = ?
            )
            AND ${expectedUser}`,
      ).bind(userId, oldAddr, oldAddr, userId, userId, oldAddr),
      env.DB.prepare(
        `UPDATE email_addresses
            SET assigned_user_id = NULL, assigned_user_name = NULL
          WHERE ? <> '' AND lower(address) = ? AND assigned_user_id = ?
            AND ${expectedUser}`,
      ).bind(oldAddr, oldAddr, userId, userId, oldAddr),
      env.DB.prepare(
        `UPDATE users SET email_alias = ?
          WHERE id = ? AND lower(COALESCE(email_alias, '')) = ?`,
      ).bind(nextAlias, userId, oldAddr),
      env.DB.prepare(
        `SELECT id FROM email_addresses
          WHERE ? = 1 AND lower(address) = ? AND assigned_user_id = ?
          LIMIT 1`,
      ).bind(shouldProvision ? 1 : 0, newAddr, userId),
    );

    let results: D1Result[];
    try {
      results = await env.DB.batch(statements);
    } catch (error) {
      if (shouldProvision) {
        const collision = await env.DB.prepare(
          `SELECT assigned_user_id FROM email_addresses WHERE lower(address) = ? LIMIT 1`,
        )
          .bind(newAddr)
          .first<{ assigned_user_id: number | null }>();
        if (collision?.assigned_user_id != null && collision.assigned_user_id !== userId) {
          throw new AliasMailboxCollisionError(newAddr);
        }
      }
      throw error;
    }
    const updateResult = results[revokeOffset + 2];
    if (Number(updateResult?.meta?.changes ?? 0) !== 1) {
      throw new Error("email alias changed concurrently; reload and try again");
    }
    const mailboxResult = results[revokeOffset + 3];
    const finalMailboxId = shouldProvision
      ? ((mailboxResult?.results?.[0] as { id?: string } | undefined)?.id ?? null)
      : null;
    if (shouldProvision && !finalMailboxId) {
      throw new Error("mail alias provisioning committed without an owned mailbox");
    }
    return {
      old_alias: oldAddr,
      old_mailbox_id: oldMailbox?.id ?? null,
      new_alias: newAddr,
      mailbox_id: finalMailboxId,
    };
  }
}

const app = new Hono<{ Bindings: Env }>();

/**
 * Department-scoped Team admin decision for the current caller (owner 2026-07,
 * "Sales Director = department-scoped admin"). ADDITIVE on top of the existing
 * users.read / users.manage gates — it NEVER loosens what an admin already has:
 *
 *   • caller holds `*` or `adminPerm`  → { scoped: false } — full admin, UNCHANGED.
 *   • caller is a Sales Director (only) → { scoped: true, deptId: <their dept> }.
 *   • deptId === null (Sales Director with no department assigned) → they see
 *     ONLY themselves, never the whole org (fail-closed).
 *
 * A caller who is neither can't reach the handler — the route middleware
 * (requirePermissionOrSalesDirector) already 403'd them.
 */
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
  // Defensive: should be unreachable behind requirePermissionOrSalesDirector.
  return { scoped: false, deptId: null };
}

/**
 * Baseline role for a department-scoped (Sales Director) invite, whose UI hides
 * the Role picker. Mirrors the frontend InvitePanel default: prefer the neutral
 * "Position Preview" role (zero action-permissions — page visibility follows
 * the Position), then any zero-permission non-system role, then any non-system
 * role, then anything. Returns null only when the roles table is empty.
 */
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

const INVITE_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
const RESET_TTL_SECONDS = 60 * 60; // 1 hour — password reset should expire fast

/**
 * GET /api/users
 * List all team members. Requires users.read.
 *
 * Optional ?brand=<x> narrows the list to users with that brand in
 * their user_brands row set (mig 049). Used by the project PIC picker.
 *
 * Optional ?department=<name> narrows to users whose PRIMARY department
 * name matches case-insensitively (contains). Used by the project PIC +
 * Sales-attending pickers, which list all Sales-department members
 * regardless of brand (owner: Option A). Prod's dept is "Sales Department",
 * so the match is a substring (ILIKE %name%), not equality.
 */
app.get("/", requirePermissionOrSalesDirector("users.read"), async (c) => {
  const brand = (c.req.query("brand") || "").trim();
  const department = (c.req.query("department") || "").trim();
  // Optional server typeahead: ILIKE over name + email. Additive — no `q`
  // leaves the query, ordering and the full-list callers untouched. When
  // present we also cap the result set (the picker only renders a slice).
  const search = (c.req.query("q") || c.req.query("search") || "").trim();
  const db = getDb(c.env);
  const manager = alias(users, "m");
  const inviter = alias(users, "ib");

  const conds: any[] = [];
  // Sales Director → own-department scope only. A caller admitted purely as a
  // Sales Director sees ONLY members whose primary department is theirs OR who
  // are members of it (mig 0020 user_departments). No dept assigned → self only.
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
    // EXISTS-on-user_brands narrows the list without exploding rows
    // through a JOIN.
    conds.push(
      sql`EXISTS (SELECT 1 FROM ${user_brands} ub
                   WHERE ub.user_id = ${users.id}
                     AND ub.brand = ${brand})`
    );
  }
  if (department) {
    // Match the user's primary department by name, case-insensitively and
    // by substring so "Sales" matches the prod "Sales Department" row.
    conds.push(
      sql`EXISTS (SELECT 1 FROM ${departments} d2
                   WHERE d2.id = ${users.department_id}
                     AND d2.name ILIKE ${"%" + department + "%"})`
    );
  }
  if (search) {
    // Typeahead: match the query as a substring of name OR email. The term is
    // bound as a parameter (no injection) — same idiom as the department
    // filter above.
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
      // GROUP_CONCAT joins the user's brand allow-list in one round-trip.
      // Unit-separator (US, 0x1f) keeps multi-word brands ("MY SOFA
      // FACTORY") splittable client-side without ambiguity.
      brands_concat: sql<string | null>`(
        SELECT string_agg(ub.brand, chr(31))
          FROM ${user_brands} ub
         WHERE ub.user_id = ${users.id}
      )`,
      // Full department membership set (mig 0020). The primary department_id is
      // one of these; we re-add it below so legacy rows not yet backfilled are
      // still reported as members of their primary.
      department_ids_arr: sql<number[] | null>`(
        SELECT array_agg(ud.department_id)
          FROM ${user_departments} ud
         WHERE ud.user_id = ${users.id}
      )`,
      // Per-user company grants (Phase 0e — user_companies). Drives the Team
      // "Company" column + the edit/invite Company selector. Empty array = no
      // grant row → the user fail-opens to ALL companies (companyContext).
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
  // Bound the typeahead result set — the picker renders only a slice. No `q`
  // → no limit, so every full-list caller keeps receiving the whole directory.
  const rows = await (search ? built.limit(50) : built);

  // array_agg() can arrive as a JS array OR a Postgres array-literal string
  // ("{1,2}") depending on the driver path — coerce both (empty on null) so the
  // Company column + department "+N" never silently blank out.
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
    // Primary first, then any extra departments sorted — drives the "+N" UI.
    const arr = pgIntArray(r.department_ids_arr);
    const extra = arr
      .map((d) => Number(d))
      .filter((d) => Number.isFinite(d) && d !== r.department_id)
      .sort((a, b) => a - b);
    const department_ids =
      r.department_id != null ? [r.department_id, ...extra] : extra;
    // Company grants — normalise to a sorted number[] for the Company column.
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

/**
 * GET /api/users/:id/brands
 * Per-user brand allow-list (mig 049).
 */
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

/**
 * PUT /api/users/:id/brands
 * Body: { brands: string[] }  replace-set semantics, validated against
 * project_brands.name (silent-drop unknowns).
 */
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

  // Validate against the canonical brand list. Active OR inactive — an
  // archived brand still scopes existing projects until manually
  // removed; we just don't show it in the new picker.
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

/**
 * GET /api/users/:id/companies
 * Per-user company allow-list (Phase 0e — mirrors the brand allow-list).
 * NO-OP-SAFE: if the `user_companies` table is absent (pre-0f) the query
 * throws and we return an empty grant list rather than 500.
 */
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
    // user_companies not present yet (Phase 0f migration unapplied) — no grants.
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
    /* Validate against the companies the CALLER themselves holds — not against
       the whole master (silent-drop the rest).
       `users.manage` is a flat, global permission: it carries no company
       dimension, and this route has no self-guard (unlike PATCH /:id, which
       refuses `id === me.id` at :1426). Validating against `SELECT id FROM
       companies` therefore let any users.manage holder granted ONLY company 1
       call this on their OWN id with [1, 2]; companyContext re-reads
       user_companies on the very next request and would then accept
       `X-Company-Id: 2`. That is self-service cross-tenant escalation — it hands
       over the other company's entire book, read AND write.
       A grantor can only ever pass on what they hold. `allowedCompanyIds`
       degrades to `undefined` ONLY when the companies master is unreadable
       (pre-migration / cold-start), where we keep the previous whole-master
       behaviour so a single-company install still works; `[]` means the caller
       holds nothing and may therefore grant nothing. See the three-state
       sentinel in scm/lib/companyScope.ts. */
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
    // user_companies / companies not present yet (pre-0f) — no-op gracefully.
    return [];
  }
}

/**
 * PUT /api/users/:id/companies
 * Body: { companies: number[] }  replace-set semantics, validated against the
 * companies master (silent-drop unknowns). Mirrors PUT /:id/brands.
 * NO-OP-SAFE: if `user_companies` (or `companies`) is absent (pre-0f) we return
 * 200 with an empty list rather than 500 — the feature simply isn't active yet.
 */
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
  // Company grants drive the banner's companyCanSee filter — clear this user's
  // snapshot (both scopes) so a poll inside the 300s TTL cannot serve the old
  // company audience.
  await bustBannerForUser(c.env, id);
  return c.json({ ok: true, companies: valid });
});

/**
 * GET /api/users/:id/activity
 * Recent audit_events touching this member, newest first — powers the
 * change-history panel on the member detail page. Two angles in one query:
 * what the user DID (actor_id = id) and what was done TO them
 * (entity_type='user' AND entity_id = id). Read via raw SQL like routes/audit.ts
 * — audit_events has no Drizzle table in schema.ts. Never errors on a missing
 * table: if the ledger isn't there yet the panel just shows no history.
 */
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
    // Ledger absent or unreadable — degrade to empty rather than 500.
    return c.json({ activity: [] });
  }
});

// ── Profile pictures (mig 058) ─────────────────────────────────
// Image bytes live in R2 (POD_BUCKET); the DB row carries the key.
// Upload writes the user's own pic; GET streams the bytes back through
// the worker so <img> can display it via blob URL despite needing the
// bearer token — same pattern as award images and POD photos.

/**
 * PUT /api/users/me/profile-pic
 * Raw binary upload of the caller's own profile picture. The optional
 * `?name=` query carries the original filename so the R2 key keeps a
 * recognisable extension.
 */
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

/**
 * DELETE /api/users/me/profile-pic
 * Clears the caller's profile picture pointer. The R2 object is left
 * in place — orphans are cheap and keeping them allows undo via the
 * raw key if a user ever asks.
 */
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

/**
 * GET /api/users/:id/profile-pic
 * Streams the user's profile pic bytes from R2. Any authed user can
 * view any other authed user's pic — the data is "this is what so-and-so
 * looks like", not sensitive. 404 when no pic is set.
 */
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

  // Measured 2026-08-01: /team fetches one per member (43, ~1s each behind the
  // connection limit); a flat max-age=300 re-fetched all past 5 min. Avatar.tsx
  // sends the R2 key as ?k= so a matching url pins — see lib/avatar-cache.ts.
  headers.set(
    "cache-control",
    avatarCacheControl(c.req.query("k"), row.profile_pic_r2_key),
  );
  // nosniff: block MIME-sniffing the server content-type into html/svg (parity: mail-center INLINE_SAFE).
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(obj.body, { headers });
});

/**
 * PUT /api/users/:id/profile-pic  (admin)
 * Upload/replace another member's avatar. Mirrors /me/profile-pic but is
 * keyed on the path id and gated on users.manage.
 */
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

/**
 * POST /api/users/invite
 * Body: { email, role_id }
 * Creates a placeholder user (status='invited') and a fresh invitation
 * token. Returns the token so the caller can copy it into a chat / email.
 */
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
    // Per-company grants for the new member (Phase 0e). Omitted / empty →
    // defaults to [1] (Houzs) so a new user is NEVER left with zero grants
    // (zero rows would fail-open to ALL companies). Full-admin only; a
    // Sales-Director-scoped invite ignores this and is forced to Houzs.
    company_ids?: number[];
    // When provided, the admin is setting an initial password and the account
    // is created ACTIVE — no invite link / accept step. The member signs in
    // with email + this password and can change it later.
    password?: string;
    // 6-digit POS tablet PIN, for a member being created into a SALES position.
    // The email+password above is the DESKTOP credential; the POS has no
    // password field at all (pos.2990shome.com is name-pick + PIN), so without
    // this a new salesperson was created with no way to sign into the tablet
    // until an admin went back and used Members → Set PIN.
    pos_pin?: string;
  }>();

  const db = getDb(c.env);

  // Sales Director → department-scoped invite. The new member is FORCED into
  // the director's own department; a position from another department is
  // rejected; and — since the scoped invite UI hides the Role picker — a
  // baseline role is defaulted server-side when none is supplied. A Sales
  // Director with no department cannot invite (fail-closed).
  const inviteScope = salesDirectorScope(c, "users.manage");
  if (inviteScope.scoped) {
    if (inviteScope.deptId == null) {
      return c.json(
        { error: "You have no department assigned — ask an admin to set yours before inviting." },
        403,
      );
    }
    // Force the member's department; ignore any client-supplied value.
    body.department_id = inviteScope.deptId;
    // A position must belong to the director's own department.
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
    // Default the role when the scoped UI didn't send one.
    if (!body.role_id) {
      const def = await resolveDefaultRoleId(db);
      if (def == null) return c.json({ error: "No role available to assign" }, 500);
      body.role_id = def;
    }
  }

  if (!body.email || !body.role_id) {
    return c.json({ error: "Please enter an email and choose a role." }, 400);
  }
  const email = body.email.toLowerCase().trim();
  const name = body.name?.trim() || null;

  // Direct-provision path: admin sets the password now → active account.
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

  // Org dimensions (mig 094). If a position is given, validate it and default
  // the department from it when the department wasn't passed explicitly.
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

  // POS PIN — validated BEFORE the user is created, so a bad PIN never leaves a
  // half-provisioned member behind. The sales-position rule is not cosmetic:
  // /api/pos/pin-login refuses any other position, so a PIN stored against one
  // would be a credential that can never sign in.
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

  // Create or refresh the placeholder user. Name is preset here ("the
  // Position concept") so the invitee lands with their identity already
  // set; they can still adjust it when accepting.
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
        // Stored E.164 so a staff number is comparable and dialable no matter
        // how it was typed. normalizePhone keeps an explicit +xx country code
        // and assumes Malaysia only for a bare local number; it returns null
        // for input too short to be a phone, and that null is the same "no
        // phone" the trim path produced.
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
    // Re-invite — bump role and reset invited_at, drop any old token.
    // Only overwrite the name when a new one was supplied.
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

  // Write the member's company grants (Phase 0e). The placeholder user row
  // exists in BOTH the invite-token and direct-activate paths, and accept-invite
  // only promotes it (never re-creates), so grants set here persist. Default =
  // [1] (Houzs) when the admin didn't pick one — a new user must never land with
  // zero grants (that fail-opens to ALL companies). A Sales-Director-scoped
  // invite may not set companies, so it is forced to Houzs.
  const inviteCompanyIds = inviteScope.scoped
    ? [1]
    : Array.isArray(body.company_ids) && body.company_ids.length > 0
      ? body.company_ids
      : [1];
  if (userId) await setUserCompanies(c, userId, inviteCompanyIds);

  // Keep the Sales Team roster in lockstep at CREATE time too — not just on the
  // later department-change PATCH. A member invited straight into a Sales
  // department otherwise never gets a sales_reps row (the roster is what the PMS
  // "Sales Attending" picker and the SO salesperson list read), so the picker
  // showed "No Sales Persons found" for a floor full of Sales staff. sync is
  // idempotent and gated on the department NAME containing "sales", so this is a
  // no-op for every non-Sales invite and never duplicates an existing rep. Runs
  // for both the direct-activate and the token-invite placeholder — an invited
  // rep is created up front so the picker lists them the moment they're onboarded.
  if (userId && departmentId != null) {
    await syncSalesRepFromUser(c.env, userId, me.id);
  }

  // POS tablet PIN. The scm.staff row this keys off is created by the
  // sync_user_to_staff trigger on the users INSERT above (mig 0066), so it
  // exists by now — but a false result (no staff row) is reported rather than
  // swallowed, because the member would otherwise look provisioned and still
  // be unable to sign into the tablet.
  const posPinSet = posPin && userId ? await setPosPinForUser(c.env, userId, posPin) : false;

  // Admin set a password → the account is live now; no invite token/email.
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
      ...(posPin ? { pos_pin_set: posPinSet } : {}),
    });
  }

  // Issue a fresh invitation token.
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

  // Email the invitation. The link is built server-side from
  // PUBLIC_APP_URL so it always carries the canonical domain no matter
  // which origin the admin's browser is on. sendEmail() never throws —
  // when the channel/key is off we still hand back the link for
  // copy-paste, and the UI shows the delivery status.
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
    ...(posPin ? { pos_pin_set: posPinSet } : {}),
  });
});

/**
 * POST /api/users/invitations/:id/resend
 * Re-send the invitation email for a still-pending invite. Keeps the
 * same token (the link already shared stays valid); only the email is
 * fired again.
 */
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

/**
 * POST /api/users/:id/resend-invite
 * Re-send the pending invitation email for a member who hasn't joined
 * yet, keyed by the member's USER id (the Members grid works with user
 * ids, not invitation ids). Resolves the member's still-pending
 * invitation by email and reuses the same token + email path as
 * /invitations/:id/resend — no new token, no new email system.
 */
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

  // Newest still-pending invitation for this member's email (same token
  // stays valid — we only re-fire the email).
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

/**
 * PATCH /api/users/:id
 * Body: { role_id?, status?, manager_id?, department_id? }
 * Update a team member's role, enable/disable, reassign manager or
 * department.
 */
app.patch("/:id", requirePermissionOrSalesDirector("users.manage"), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const me = c.get("user");
  if (!id) return c.json({ error: "Invalid ID." }, 400);

  // Block self-modification of own role/status to avoid lockout.
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
    // Per-company grants (Phase 0e) — replace-set. Full-admin (users.manage)
    // only; stripped for a dept-scoped Sales Director below, same as role/dept.
    company_ids?: number[];
    // Admin-set/reset password (users.manage). Hashed; never stored plaintext.
    password?: string;
  }>();

  const db = getDb(c.env);

  // Current primary department doubles as an existence check (the membership
  // reconciliation below can run with an otherwise-empty column update).
  const current = await db
    .select({
      id: users.id,
      email: users.email,
      email_alias: users.email_alias,
      name: users.name,
      department_id: users.department_id,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (current.length === 0) return c.json({ error: "User not found" }, 404);

  // Sales Director (dept-scoped admin, not a full users.manage admin): may EDIT
  // basic details + ENABLE/DISABLE members of their OWN department only. They
  // cannot touch a member outside their dept, nor change role / position /
  // department / manager / password (those stay full-admin only). #424 grants
  // view+invite; this adds edit+disable within the same department scope.
  const dirScope = salesDirectorScope(c, "users.manage");
  if (dirScope.scoped) {
    // Editability must mirror the LIST scope (GET / above): a member appears in
    // a Sales Director's list when their PRIMARY department is the director's
    // OR they are a secondary member of it (mig 0020 user_departments). The gate
    // used to accept the primary department only, so a member visible in the list
    // (via user_departments) was NOT editable — 404. Accept user_departments
    // membership too so list-visibility and edit-scope agree.
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
      return c.json({ error: "User not found" }, 404); // out-of-dept → indistinguishable
    }
    // A dept-scoped Sales Director may only touch basic details + enable/disable.
    // STRIP (not 403) the privileged fields so an edit-form resubmit that carries
    // the member's unchanged role/dept still saves the name/phone/status — the
    // director simply cannot change role / position / department / manager /
    // password. Those stay full-admin only.
    delete body.role_id;
    delete body.position_id;
    delete body.department_id;
    delete body.department_ids;
    delete body.manager_id;
    delete body.company_ids;
    delete body.password;
    // Login identity is an ACCOUNT-TAKEOVER vector (change the email, then run
    // forgot-password to seize the account), so the login email + alias are
    // full-admin only too — strip them from a dept-scoped director's edit.
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

  // Reason note tracks WHY an account was disabled. Re-enabling clears it;
  // otherwise an explicit reason is stored when provided.
  if (body.status === "active") {
    set.status_reason = null;
  } else if (body.status_reason !== undefined) {
    set.status_reason = body.status_reason?.trim() || null;
  }

  // Org-chart division — free-text sub-grouping within a department (mig 0021).
  if (body.division !== undefined) {
    set.division = body.division?.trim() || null;
  }

  // Admin sets / resets the member's password. Validated + hashed; an empty
  // value is ignored (so saving the panel without touching it keeps the old one).
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
      // Cycle check: walk the prospective manager's chain — if this user
      // is anywhere in it, the assignment would create a loop.
      let cursor: number | null = mgr;
      const seen = new Set<number>();
      while (cursor != null) {
        if (cursor === id) {
          return c.json(
            { error: "Cycle detected — that user reports to you (directly or indirectly)" },
            400
          );
        }
        if (seen.has(cursor)) break; // defensive — existing bad data
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
      // Keep department in lockstep with the position when the patch didn't
      // set one explicitly.
      if (body.department_id === undefined && pos[0].department_id) {
        set.department_id = pos[0].department_id;
      }
    }
  }

  // Personal info — editable from the Edit Member panel.
  if (body.name !== undefined) {
    set.name = body.name?.trim() || null;
  }
  if (body.phone !== undefined) {
    set.phone = normalizePhone(body.phone);
  }
  // The member's outward Mail Center alias. Normalised lowercase; empty → null.
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

  // Multi-department membership (mig 0020). When department_ids is provided we
  // replace-set the join table; otherwise we just keep the primary in sync.
  // Validate each id against departments (silent-drop unknowns, like brands).
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

    // Reconcile against the primary. If a primary is set (this patch or the
    // existing one), force it into the set; if the primary was cleared, promote
    // the first of the set to primary so the two never drift apart.
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

  // Company grants (Phase 0e) — replace-set when the edit carries company_ids.
  // A company-only edit is a valid change, so it counts toward the guard below.
  const hasCompanyChange = Array.isArray(body.company_ids);

  if (Object.keys(set).length === 0 && finalDeptIds === null && !hasCompanyChange) {
    return c.json({ error: "No fields to update" }, 400);
  }

  // Alias ownership is derived data in the mail tables. Atomically revoke the
  // previous assignment/self-grant AND change users.email_alias so neither half
  // can commit without the other.
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
  }
  // The atomic helper already wrote users.email_alias together with the mail
  // entitlement rows. Keep the remaining Drizzle update from writing it again.
  if (body.email_alias !== undefined) delete set.email_alias;

  if (Object.keys(set).length > 0) {
    const result = await db.update(users).set(set).where(eq(users.id, id));
    if (!result.count) return c.json({ error: "User not found" }, 404);
  }

  // Apply the membership change.
  if (finalDeptIds !== null) {
    await db.delete(user_departments).where(eq(user_departments.user_id, id));
    if (finalDeptIds.length > 0) {
      await db
        .insert(user_departments)
        .values(finalDeptIds.map((d) => ({ user_id: id, department_id: d })));
    }
  } else if ("department_id" in set) {
    if (set.department_id != null) {
      // Primary changed (directly or via position lockstep) — keep it present
      // in the membership table, preserving any extras already there.
      await db
        .insert(user_departments)
        .values({ user_id: id, department_id: set.department_id })
        .onConflictDoNothing();
    } else if (current[0].department_id != null) {
      // Primary cleared — drop just that membership, leave extras intact.
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

  // Apply the company grants (Phase 0e) — replace-set via the shared helper.
  let finalCompanyIds: number[] | null = null;
  if (hasCompanyChange) {
    finalCompanyIds = await setUserCompanies(c, id, body.company_ids as number[]);
  }

  // If we disabled a user, revoke their sessions. Bust the cached-user entries
  // BEFORE the delete (reads the live tokens) so a disabled user can't ride a
  // still-cached session for up to 60s.
  if (body.status === "disabled") {
    await bustUserSessions(c.env, id);
    await db.delete(sessions).where(eq(sessions.user_id, id));
  } else if (set.role_id != null) {
    // Role change keeps the sessions alive but leaves the cached AuthUser's
    // permissions stale for up to 60s. Bust the caches so the next request
    // re-hydrates the new role/permissions.
    await bustUserSessions(c.env, id);
  }

  // Keep the Sales Team roster in lockstep with the user's PRIMARY department.
  // Department change → create / unarchive / archive the linked sales_reps row.
  // No-op for non-Sales departments and already-consistent users. Multi-dept
  // membership is orthogonal — sync stays keyed on the single primary.
  if (body.department_id !== undefined || set.department_id !== undefined) {
    await syncSalesRepFromUser(c.env, id, me.id);
  }

  // The announcements banner filters by department_id / position_id / company
  // grants (userCanSee / companyCanSee), and its KV snapshot now lives 300s
  // (> the 60s poll) — so any edit that moves THIS user between audiences must
  // clear their banner (BOTH scopes), or a poll would serve up to 5 minutes of
  // stale targeting. Session bust alone does not cover this: it fires only on
  // disable / role change, while a dept-only / position-only / company-only
  // edit changes targeting without touching the session. Covers every such
  // field in ONE place. Best-effort (bustBannerForUser swallows KV trouble).
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

/**
 * DELETE /api/users/:id[?hard=1]
 *
 * Default (no `?hard=1`): soft-delete — status='disabled', sessions
 * revoked, default-driver clears. Preserves FK references in trips,
 * sales, etc. This is the right call for established users.
 *
 * `?hard=1`: true hard delete. Cleans up CASCADE-safe rows manually
 * for tables that lack ON DELETE CASCADE (sessions, invitations,
 * driver_clock_entries, lorry_incidents, etc.), then `DELETE FROM
 * users`. If a non-cascading FK reference remains (e.g. sales_entries
 * created_by, trips driver_user_id), the FK constraint trips and we
 * return a helpful message naming what blocks the delete. Use this
 * for never-used test accounts. For users with real activity, use
 * the soft-delete (Disable) path instead.
 */
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

  // Revoke sessions (any path). Bust the cached-user entries BEFORE the delete
  // (reads the live tokens) so a deleted/disabled user can't ride a still-cached
  // session for up to 60s.
  await bustUserSessions(c.env, id);
  // A deleted/disabled user leaves the audience — clear their banner snapshot
  // (both scopes) so nothing rides the 300s TTL after they are gone.
  await bustBannerForUser(c.env, id);
  await db.delete(sessions).where(eq(sessions.user_id, id));

  // Hard-delete path — either explicit ?hard=1 or never-joined user.
  if (hard || target.status === "invited") {
    // Best-effort cleanup of tables whose FK to users(id) is missing
    // ON DELETE CASCADE/SET NULL, so the final DELETE doesn't trip.
    // Tables that already cascade (project_reads, password_resets,
    // user_brands) are not touched here — SQLite handles them.
    await db.delete(invitations).where(eq(invitations.email, target.email));
    // NO lorries cleanup here. `lorries.default_driver_user_id` does NOT exist
    // in production — `0000_baseline.sql:126` and `schema.pg.ts:311` both still
    // declare it, but the live table (public AND scm) has no such column, and
    // this statement was the ONLY one in this block not wrapped in safeExec.
    // It therefore raised `column "default_driver_user_id" does not exist` on
    // EVERY delete, which index.ts:385 folds into the operator's generic
    // "Something went wrong processing that request." Nothing is lost by
    // dropping it: the block exists to clear non-cascading FKs before the final
    // DELETE, and `public.user_companies` (ON DELETE CASCADE) is now the ONLY
    // foreign key referencing users at all. Driver records live in scm.drivers
    // and are deactivated by the trg_sync_user_to_tms trigger.
    // Be defensive — only run these if the tables exist on the deployed schema.
    // SQLite's "no such table" errors get swallowed for tables that haven't
    // shipped yet (cron-only / future migrations).
    const safeExec = async (sql: string) => {
      try { await c.env.DB.prepare(sql).bind(id).run(); } catch {}
    };
    // Audit / chat / activity — historically tied to a user_id but the user
    // record is the source of truth. If you hard-delete, the audit is lost.
    await safeExec(`DELETE FROM project_activity WHERE user_id = ?`);
    await safeExec(`DELETE FROM project_reads WHERE user_id = ?`);
    // Engagement (Houzs Points + Awards + Idea boxes). Hard-deleting a user
    // wipes their ledger; this is what the caller is asking for.
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

  // Soft-delete (default for joined users).
  await db.update(users).set({ status: "disabled" }).where(eq(users.id, id));

  // The lorries default-driver clear that used to sit here is gone for the same
  // reason as in the hard-delete block above: the column does not exist in
  // production, so this raised on every soft-delete too. scm.drivers is the
  // live driver record and trg_sync_user_to_tms deactivates it off this very
  // status change.

  await audit(c, {
    action: "user.disable",
    entityType: "user",
    entityId: id,
    summary: `Disabled user ${target.email} (#${id})`,
    meta: { email: target.email, role: target.role_name },
  });

  return c.json({ ok: true, action: "disabled" });
});

/**
 * GET /api/users/invitations
 * Pending invitations.
 */
app.get("/invitations", requirePermissionOrSalesDirector("users.read"), async (c) => {
  const db = getDb(c.env);
  const inviter = alias(users, "ib");
  // Sales Director → only pending invites into his own department (invitations
  // carry department_id, set at invite time). No dept assigned → none.
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
      // Latest delivery outcome from email_log so the UI can show
      // "emailed" vs an amber "not sent" without a schema change.
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

/**
 * DELETE /api/users/invitations/:id
 * Revoke a pending invitation.
 */
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

  // Also clean up the placeholder user if they never accepted.
  await db
    .delete(users)
    .where(and(eq(users.email, inv[0].email), eq(users.status, "invited")));
  await db.delete(invitations).where(eq(invitations.id, id));

  return c.json({ ok: true });
});

/**
 * POST /api/users/:id/impersonate
 * OWNER-ONLY (wildcard `*`) view-as: mints a SHORT-LIVED (1 hour) session for
 * the target member so the owner can open the portal exactly as that user
 * sees it (the local Portal Viewer passes it to the app via #login-as, which
 * stores it session-only). Deliberately NOT granted to plain users.manage
 * holders — impersonation is strictly the owner's review tool. Every use is
 * audited with the target identity.
 */
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

  // Inserted directly (not createSession) so the 7-day default TTL doesn't
  // apply — a view-as token dies after an hour.
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

  // Per-TARGET cap: 3 admin-issued links per 15 min, whoever sends them. Keyed
  // on the recipient (not the admin) so the bulk action and two admins working
  // the same list still cannot flood one person's inbox. Fails OPEN when KV is
  // unbound — same posture as every other limiter here; this bounds nuisance,
  // it is not the authorization gate (requirePermission above is).
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
    // Invited users haven't set a password yet — the existing invitation
    // flow handles first-time setup. Steering admins at the right tool.
    return c.json(
      { error: "User is still invited — resend the invitation instead." },
      400
    );
  }

  // Invalidate any prior unconsumed reset tokens for this user.
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

  // NOTE: no session revocation here, by design (see the header). Sending a
  // link must be a no-op on the account. Redemption revokes the sessions —
  // routes/auth.ts POST /reset/:token already does bustUserSessions + DELETE
  // FROM sessions after writing the new hash, which is the correct moment: the
  // password has actually changed by then.

  // Fire the email. sendEmail() never throws — it returns a status, and a
  // disabled channel or missing API key comes back as "skipped". Surface that
  // status so the UI can say "not sent, check Settings, Email" instead of
  // claiming success. The token is NOT returned; the mailbox is the only place
  // it lands.
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

  // WHO sent it, TO WHOM, WHEN (audit rows are timestamped), and whether the
  // mail actually left. `requested_by` on the password_resets row carries the
  // same admin id, so the trail survives even if the audit log is trimmed.
  // The token is deliberately absent from both — an audit log that records a
  // live credential is a credential store.
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

/**
 * POST /api/users/:id/totp/disable
 * Admin recovery path for a user who lost their authenticator (and their
 * backup codes). Clears their 2FA so they can sign in with password alone and
 * re-enroll. The self-service disable (with a code) lives in routes/totp.ts.
 */
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

  // Staging-flag door keeps the ordinary 7-day session (test-account hopping);
  // the owner door mints a short-lived 1-hour session instead.
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
