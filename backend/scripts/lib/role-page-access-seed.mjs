// ---------------------------------------------------------------------------
// role-page-access-seed.mjs — the resolvers and the verification logic behind
// scripts/seed-role-page-access.mjs, split out so a test can import them (the
// script itself connects to a database at import time).
//
// WHY THE VERIFY LOGIC LIVES HERE. On the 2026-10-20 production apply the seed
// WROTE 24 roles x 50 keys correctly, but its own verify() reported 116
// failures: the fresh connection's role_id -> rows lookup found nothing, every
// role resolved to "none" and the check failed against a table that was right.
// Step 2 (old vs new per member) "passed" only because both sides had been
// computed from the same empty rows. So the two rules below are the whole point:
//   1. a short or empty re-read is its own loud failure with counts, never a
//      silent empty lookup (readStoredRows), and
//   2. a lookup that finds no stored rows for a role FAILS the comparison
//      instead of comparing a thing with itself (checkStoredAgainstPlan).
// ---------------------------------------------------------------------------
import { PAGES, resolvePositionAccessFromRows } from "../../src/services/pageAccess.ts";
import { resolveMemberPageAccess } from "../../src/services/memberPageAccess.ts";
import { applySalesJdOverride } from "../../src/services/salesJdAccess.ts";
import { parsePermissions } from "../../src/services/permissions.ts";
import { policyRowFromDb } from "../../src/services/positionPolicyRows.ts";

// Money / stock pages — the ones the plan says MUST be zero-diff. Printed on
// their own line per role so a reviewer can see them without reading the map.
export const MONEY_STOCK_KEYS = [
  "scm.finance", "scm.finance.accounting", "scm.finance.outstanding",
  "scm.warehouse", "scm.warehouse.inventory", "scm.warehouse.adjustments",
  "scm.warehouse.transfers", "scm.warehouse.stock_take",
];

export const PAGE_KEYS = PAGES.map((p) => p.key);

/** Stable string form of a page-access map over the full catalogue, for
 *  deep-equality and shape assertions (keys printed in catalogue order). */
export const shapeOf = (map) => JSON.stringify(PAGE_KEYS.map((k) => [k, map[k] ?? "none"]));

/** The caller context for a member, built from one authority row. */
export function memberCtx(u) {
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
export const baseWithRows = (ctx, roleRows) =>
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
export const finalWithRows = (ctx, roleRows) =>
  applySalesJdOverride(baseWithRows(ctx, roleRows), {
    permissions: ctx.permissions,
    position_name: ctx.positionName,
    department_name: ctx.departmentName,
    position_policy: ctx.positionPolicy,
  });

/** A member's resolved scm_l2_configured under the given rows — a NON-page
 *  output that must also be a no-op across the seed (the title-less path could
 *  otherwise flip it; see memberPageAccess.ts). */
export const scmL2WithRows = (ctx, roleRows) =>
  resolveMemberPageAccess({
    permissionsSet: ctx.permissions,
    positionId: ctx.positionId,
    positionName: ctx.positionName,
    departmentName: ctx.departmentName,
    positionPolicy: ctx.positionPolicy,
    roleRows,
  }).scmL2Configured;

/** role_page_access rows grouped by role. The key is coerced with Number() here
 *  and at every lookup (rowsForRole) so a driver that hands one column back as
 *  a string and another as a number cannot turn every lookup into a miss. */
export function groupStoredByRole(stored) {
  const byRole = new Map();
  for (const r of stored) {
    const id = Number(r.role_id);
    if (!byRole.has(id)) byRole.set(id, []);
    byRole.get(id).push({ page_key: r.page_key, level: r.level });
  }
  return byRole;
}

/** The stored rows for a role, or undefined when there are none. */
export const rowsForRole = (storedByRole, roleId) => storedByRole.get(Number(roleId));

/** How many rows the seed was supposed to leave behind: one per catalogue page
 *  for every planned role. */
export const expectedRowCount = (plans) => plans.length * PAGE_KEYS.length;

/** How many of the rows read back are ones the seed wrote (a planned role, a
 *  catalogue page). Rows for other roles or retired page keys are not counted:
 *  they cannot make a short read of the seeded roles look whole. */
function coveredRowCount(stored, plans) {
  const planned = new Set(plans.map((pl) => Number(pl.role.id)));
  const keys = new Set(PAGE_KEYS);
  const seen = new Set();
  for (const r of stored) {
    if (planned.has(Number(r.role_id)) && keys.has(r.page_key)) seen.add(`${Number(r.role_id)}|${r.page_key}`);
  }
  return seen.size;
}

/**
 * Read role_page_access back and prove the read is WHOLE before anything is
 * compared with it. `read` runs the SELECT on the fresh connection. A short or
 * empty read is retried (read-after-commit visibility on a fresh pooled
 * connection), then fails with the counts it saw instead of resolving every role
 * to "none".
 */
export async function readStoredRows({ read, plans, attempts = 5, delayMs = 500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const expected = expectedRowCount(plans);
  let last = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await read();
    const covered = coveredRowCount(last, plans);
    if (covered >= expected) return last;
    if (attempt < attempts) {
      log(`fresh re-read saw ${covered} of ${expected} seeded rows (attempt ${attempt}/${attempts}) — retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
  const roles = new Set(last.map((r) => Number(r.role_id)));
  const sample = last[0];
  throw new Error(
    `fresh re-read saw ${last.length} role_page_access row(s) over ${roles.size} role(s) `
    + `(${coveredRowCount(last, plans)} of them seeded rows), expected ${expected} `
    + `(${plans.length} roles x ${PAGE_KEYS.length} keys) after ${attempts} attempts`
    + (sample ? `; first row role_id=${JSON.stringify(sample.role_id)} (${typeof sample.role_id})` : ""),
  );
}

/**
 * The comparison half of verify(), over rows already read and proven whole.
 *   1. each planned role's stored rows round-trip to its planned base (money /
 *      stock pages named separately);
 *   2. each active member's NEW resolution (stored rows) equals their OLD one
 *      (live policy, roleRows=[]) — the end-to-end no-op, applySalesJdOverride
 *      and scm_l2_configured included.
 * A role or member whose stored rows cannot be found is a FAILURE: comparing
 * "no rows" with "no rows" would pass vacuously.
 */
export function checkStoredAgainstPlan({ plans, stored, members }) {
  const problems = [];
  const storedByRole = groupStoredByRole(stored);

  for (const pl of plans) {
    const rows = rowsForRole(storedByRole, pl.role.id);
    if (!rows || rows.length < PAGE_KEYS.length) {
      problems.push(`role ${pl.role.id} "${pl.role.name}": found ${rows ? rows.length : 0} stored row(s), expected ${PAGE_KEYS.length}`);
      continue;
    }
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

  let checked = 0;
  for (const m of members) {
    const rows = rowsForRole(storedByRole, m.role_id);
    if (!rows || rows.length === 0) {
      problems.push(`member #${m.id} (role ${m.role_id}): no stored rows found for the member's role — cannot compare OLD with NEW`);
      continue;
    }
    const ctx = memberCtx(m);
    const oldFinal = finalWithRows(ctx, []);
    const newFinal = finalWithRows(ctx, rows);
    if (shapeOf(oldFinal) !== shapeOf(newFinal)) {
      problems.push(`member #${m.id} (role ${m.role_id}): NEW page access differs from OLD`);
    }
    // scm_l2_configured is a non-page output that must also not move — on the
    // title-less path a seed of scm.*=none rows could otherwise flip it and
    // make scmAreaGuard start enforcing.
    const oldScmL2 = scmL2WithRows(ctx, []);
    const newScmL2 = scmL2WithRows(ctx, rows);
    if (oldScmL2 !== newScmL2) {
      problems.push(`member #${m.id} (role ${m.role_id}): scm_l2_configured changed ${oldScmL2} -> ${newScmL2}`);
    }
    checked += 1;
  }

  return { problems, checked };
}
