#!/usr/bin/env node
// ---------------------------------------------------------------------------
// seed-role-page-access.mjs — the NO-OP cutover seed for the RBAC rebuild.
//
// WHAT. Populates public.role_page_access with one explicit row per (role, page)
// so that, after the seed, every member's resolved page_access is BYTE-IDENTICAL
// to what login produced before the table existed. It is the materialisation of
// today's behaviour into the table PR2's matrix edits.
//
// WHY A SCRIPT AND NOT PURE SQL. The current page access is produced by the
// position policy (positionPolicy.ts — restricted whitelists, the sales
// whitelist, the money-write carve-out) and the permission backfill
// (pageAccess.ts). Reproducing all of that in SQL would be a SECOND
// implementation of the policy that must stay in sync forever — the one thing
// positionPolicy.ts refuses to allow. So this computes each role's rows with the
// REAL functions (resolveMemberPageAccess, the same resolver login uses) and
// upserts the result. Fidelity is by construction: the seed IS login's own
// output.
//
// HOW THE SEED IS KEYED. role_page_access is keyed by ROLE; today's access is
// keyed by POSITION (for a titled member). So the seed is only a true no-op if
// every active member of a role resolves to the SAME page access today. This
// script PROVES that per role: it computes each active member's base map and, if
// a role's members disagree, it REFUSES to seed (a human must split the role
// first). On 2026-10-20 prod every role was uniform.
//
// ORDERING IS SAFE EITHER WAY. hydrateAuthUser falls back to the live policy for
// any role with NO rows (memberPageAccess.ts), so running this before OR after
// the code deploys is a no-op; it only moves each role from "resolved live" to
// "resolved from an identical stored row". The envelope-version bump + the
// fingerprint's page arm bust every affected session on the next request.
//
// MODE=plan (default) reads in a READ ONLY transaction and writes nothing.
// MODE=apply requires CONFIRM=seed-role-page-access, writes every role's rows in
// ONE transaction, then re-reads on a FRESH connection and asserts the SHAPE:
// resolvePositionAccessFromRows(stored rows) equals the computed base for every
// role and page, and each active member's NEW resolution equals their OLD one
// (money/stock pages included). Refuses if any role's members diverge.
//
// RE-RUN: idempotent. Every row is an upsert keyed on (role_id, page_key), so a
// second run rewrites the same levels and the shape re-read finds 0 differences.
// A role whose live resolution has since changed is simply re-seeded to the new
// (still-uniform) value; a role that has become non-uniform makes the run refuse
// rather than pick one member's access for the rest.
//
// Run under tsx (TS imports): npx tsx scripts/seed-role-page-access.mjs
// ---------------------------------------------------------------------------
import postgres from "postgres";
import { PAGES, resolvePositionAccessFromRows } from "../src/services/pageAccess.ts";
import { resolveMemberPageAccess } from "../src/services/memberPageAccess.ts";
import { applySalesJdOverride } from "../src/services/salesJdAccess.ts";
import { parsePermissions } from "../src/services/permissions.ts";
import { policyRowFromDb } from "../src/services/positionPolicyRows.ts";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE ?? "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM_PHRASE = "seed-role-page-access";
if (MODE !== "plan" && MODE !== "apply") { console.error(`MODE must be plan or apply, got ${MODE}`); process.exit(2); }
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM=${CONFIRM_PHRASE} — refusing to write.`);
  process.exit(2);
}

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const out = (m) => console.log(m);

// Money / stock pages — the ones the plan says MUST be zero-diff. Printed on
// their own line per role so a reviewer can see them without reading the map.
const MONEY_STOCK_KEYS = [
  "scm.finance", "scm.finance.accounting", "scm.finance.outstanding",
  "scm.warehouse", "scm.warehouse.inventory", "scm.warehouse.adjustments",
  "scm.warehouse.transfers", "scm.warehouse.stock_take",
];

const PAGE_KEYS = PAGES.map((p) => p.key);
/** Stable string form of a page-access map over the full catalogue, for
 *  deep-equality and shape assertions (keys printed in catalogue order). */
const shapeOf = (map) => JSON.stringify(PAGE_KEYS.map((k) => [k, map[k] ?? "none"]));

/** The caller context for a member, built from one authority row. */
function memberCtx(u) {
  const permissions = new Set(parsePermissions(u.role_permissions));
  const positionPolicy = policyRowFromDb({
    position_id: u.position_id,
    cohort: u.cohort,
    profile: u.profile,
    can_move_money: u.can_move_money,
    can_write_config: u.can_write_config,
    is_fleet: u.is_fleet,
    duty: u.duty,
  });
  return {
    permissions,
    positionId: u.position_id ?? null,
    positionName: u.position_name ?? null,
    departmentName: u.user_department_name ?? null,
    positionPolicy,
  };
}

/** A member's BASE page access (pre-applySalesJdOverride) under the given rows —
 *  roleRows=[] reproduces the live policy / backfill (today's behaviour). */
const baseWithRows = (ctx, roleRows) =>
  resolveMemberPageAccess({
    permissionsSet: ctx.permissions,
    positionId: ctx.positionId,
    positionName: ctx.positionName,
    departmentName: ctx.departmentName,
    positionPolicy: ctx.positionPolicy,
    roleRows,
  }).pageAccess;

/** A member's FINAL page access = base + applySalesJdOverride (what login
 *  attaches to AuthUser.page_access). */
const finalWithRows = (ctx, roleRows) =>
  applySalesJdOverride(baseWithRows(ctx, roleRows), {
    permissions: ctx.permissions,
    position_name: ctx.positionName,
    department_name: ctx.departmentName,
    position_policy: ctx.positionPolicy,
  });

async function buildPlan(sql) {
  const roles = await sql`SELECT id, name, permissions, is_system FROM roles ORDER BY id`;
  if (roles.length === 0) throw new Error("no roles — a plan over nothing is not a verdict");

  const members = await sql`
    SELECT u.role_id, r.permissions AS role_permissions,
           u.position_id, p.name AS position_name,
           d.name AS user_department_name,
           pp.cohort, pp.profile, pp.can_move_money, pp.can_write_config, pp.is_fleet, pp.duty
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN positions p ON p.id = u.position_id
    LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN position_policy pp ON pp.position_id = u.position_id
    WHERE u.status = 'active'
    ORDER BY u.role_id`;

  const existing = await sql`SELECT role_id, page_key, level FROM role_page_access ORDER BY role_id, page_key`;
  const existingByRole = new Map();
  for (const r of existing) {
    if (!existingByRole.has(r.role_id)) existingByRole.set(r.role_id, new Map());
    existingByRole.get(r.role_id).set(r.page_key, r.level);
  }

  const membersByRole = new Map();
  for (const m of members) {
    if (!membersByRole.has(m.role_id)) membersByRole.set(m.role_id, []);
    membersByRole.get(m.role_id).push(m);
  }

  const plans = [];
  const conflicts = [];
  for (const role of roles) {
    const mine = membersByRole.get(role.id) ?? [];
    let base;
    if (mine.length > 0) {
      // Each active member resolves BASE under the live policy (roleRows=[]). All
      // must agree, or the role cannot be a single row set without changing
      // someone's access.
      const seen = new Map(); // shape -> { ctx, count }
      for (const m of mine) {
        const ctx = memberCtx(m);
        const b = baseWithRows(ctx, []);
        const key = shapeOf(b);
        if (!seen.has(key)) seen.set(key, { ctx, base: b, count: 0 });
        seen.get(key).count += 1;
      }
      if (seen.size > 1) {
        conflicts.push({
          role,
          variants: [...seen.values()].map((v) => ({ count: v.count, position: v.ctx.positionName })),
        });
        continue;
      }
      base = [...seen.values()][0].base;
    } else {
      // No active member: seed the title-less default (permission backfill, or
      // fullAccessMap for a '*' role). Nothing reads it today; PR4 deletes
      // several of these roles.
      base = baseWithRows(
        { permissions: new Set(parsePermissions(role.permissions)), positionId: null, positionName: null, departmentName: null, positionPolicy: null },
        [],
      );
    }

    const prior = existingByRole.get(role.id) ?? new Map();
    const changes = [];
    for (const k of PAGE_KEYS) {
      const to = base[k] ?? "none";
      const from = prior.get(k);
      if (from !== to) changes.push({ page_key: k, from: from ?? "(none-row)", to });
    }
    plans.push({ role, memberCount: mine.length, base, changes });
  }

  return { roles, plans, conflicts, memberTotal: members.length, existingCount: existing.length };
}

function report(p) {
  log(`roles: ${p.roles.length}; active members: ${p.memberTotal}; existing role_page_access rows: ${p.existingCount}   MODE=${MODE}`);
  if (p.conflicts.length) {
    log(`CONFLICT — ${p.conflicts.length} role(s) whose active members resolve to DIFFERENT page access today; refusing to seed them:`);
    for (const c of p.conflicts) {
      out(`  CONFLICT\trole ${c.role.id} "${c.role.name}": ${c.variants.map((v) => `${v.count}x via ${v.position ?? "(no position)"}`).join(" vs ")}`);
    }
  }
  for (const pl of p.plans) {
    const money = MONEY_STOCK_KEYS.map((k) => `${k.replace("scm.", "")}=${pl.base[k] ?? "none"}`).join(" ");
    out(`  role ${pl.role.id} "${pl.role.name}" (${pl.memberCount} active): ${pl.changes.length} key change(s); money/stock: ${money}`);
    for (const ch of pl.changes.slice(0, 60)) out(`      ${ch.page_key}\t${ch.from}\t->\t${ch.to}`);
  }
}

async function applyPlan(sql, p) {
  if (p.conflicts.length) {
    throw new Error(`${p.conflicts.length} role(s) have divergent members — refusing to apply. Split those roles first; the seed must never pick one member's access for the rest.`);
  }
  await sql.begin(async (tx) => {
    let n = 0;
    for (const pl of p.plans) {
      for (const k of PAGE_KEYS) {
        const level = pl.base[k] ?? "none";
        await tx`
          INSERT INTO role_page_access (role_id, page_key, level, updated_at)
          VALUES (${pl.role.id}, ${k}, ${level}, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
          ON CONFLICT (role_id, page_key)
          DO UPDATE SET level = excluded.level,
                        updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;
        n += 1;
      }
    }
    log(`applied: ${n} rows across ${p.plans.length} roles (one transaction)`);
  });
}

async function verify(p) {
  const fresh = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  try {
    const problems = [];

    // 1. Stored rows round-trip to the computed base, for every role and page.
    const stored = await fresh`SELECT role_id, page_key, level FROM role_page_access ORDER BY role_id, page_key`;
    const storedByRole = new Map();
    for (const r of stored) {
      if (!storedByRole.has(r.role_id)) storedByRole.set(r.role_id, []);
      storedByRole.get(r.role_id).push({ page_key: r.page_key, level: r.level });
    }
    for (const pl of p.plans) {
      const rows = storedByRole.get(pl.role.id) ?? [];
      const resolved = resolvePositionAccessFromRows(rows);
      if (shapeOf(resolved) !== shapeOf(pl.base)) {
        problems.push(`role ${pl.role.id} "${pl.role.name}": stored rows resolve to a DIFFERENT shape than the planned base`);
      }
      for (const k of MONEY_STOCK_KEYS) {
        if ((resolved[k] ?? "none") !== (pl.base[k] ?? "none")) {
          problems.push(`role ${pl.role.id} "${pl.role.name}": money/stock page ${k} is "${resolved[k]}", planned "${pl.base[k]}"`);
        }
      }
    }

    // 2. Every active member's NEW resolution (stored rows) equals their OLD one
    //    (live policy, roleRows=[]) — the end-to-end no-op, applySalesJdOverride
    //    included.
    const members = await fresh`
      SELECT u.id, u.role_id, r.permissions AS role_permissions,
             u.position_id, p.name AS position_name, d.name AS user_department_name,
             pp.cohort, pp.profile, pp.can_move_money, pp.can_write_config, pp.is_fleet, pp.duty
      FROM users u
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN positions p ON p.id = u.position_id
      LEFT JOIN departments d ON d.id = u.department_id
      LEFT JOIN position_policy pp ON pp.position_id = u.position_id
      WHERE u.status = 'active'`;
    let checked = 0;
    for (const m of members) {
      const ctx = memberCtx(m);
      const oldFinal = finalWithRows(ctx, []);
      const newFinal = finalWithRows(ctx, storedByRole.get(m.role_id) ?? []);
      if (shapeOf(oldFinal) !== shapeOf(newFinal)) {
        problems.push(`member #${m.id} (role ${m.role_id}): NEW resolution differs from OLD`);
      }
      checked += 1;
    }

    if (problems.length) {
      problems.forEach((x) => log(`VERIFY FAIL: ${x}`));
      throw new Error(`${problems.length} verification failures`);
    }
    log(`VERIFY OK (fresh connection) — every role's stored rows round-trip to the planned base, money/stock pages match, and all ${checked} active members resolve byte-identically to before.`);
  } finally { await fresh.end(); }
}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
try {
  const p = await sql.begin("read only", (tx) => buildPlan(tx));
  report(p);
  if (!APPLY) {
    log(`MODE=plan — nothing written. Re-run with MODE=apply CONFIRM=${CONFIRM_PHRASE} to write.`);
  } else {
    await applyPlan(sql, p);
    await verify(p);
  }
} finally { await sql.end(); }
