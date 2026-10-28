import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  isFleetPosition,
  policyFromRow,
  positionGrantsWildcard,
  resolvePositionPolicy,
} from "../src/services/positionPolicy";
import {
  POSITION_POLICY_SEED,
  policyRowFromDb,
  validatePolicyRow,
  type PositionPolicyRow,
} from "../src/services/positionPolicyRows";
import {
  getPmsRole,
  isDirectorUser,
  isProductCostViewer,
  isSalesDirectorUser,
  isSalesUser,
} from "../src/services/pmsAccess";
import { isCrewScopedUser, isDefectReviewerPosition, salesDirectorMayAttach } from "../src/services/projectGates";
import type { AuthUser } from "../src/services/auth";

/* Roles & Permissions review part B (2026-09-16): a Title's cohort / profile /
 * flags now come from a `position_policy` ROW keyed by position_id, with the
 * name-keyed sets in positionPolicy.ts as the fallback. The seed is meant to be
 * yesterday's behaviour by id, so these cases pin:
 *   1. every seeded row resolves BYTE-IDENTICALLY to what its production name
 *      resolved to through the name rule (page map, scm flag, flags, wildcard);
 *   2. the PG migration and the D1 mirror carry exactly the seed's tuples;
 *   3. the validator refuses the row shapes the resolver could not honour. */

const HERE = dirname(fileURLToPath(import.meta.url));
const PG_MIGRATION = resolve(HERE, "../src/db/migrations-pg/20260916T1600_position_policy.sql");
const D1_MIRROR = resolve(HERE, "../src/db/migrations/155_position_policy.sql");
const PG_DUTY_MIGRATION = resolve(HERE, "../src/db/migrations-pg/20260916T1800_position_policy_duty.sql");
const D1_DUTY_MIRROR = resolve(HERE, "../src/db/migrations/157_position_policy_duty.sql");

function rowOf(entry: (typeof POSITION_POLICY_SEED)[number], positionId = 999): PositionPolicyRow {
  return {
    position_id: positionId,
    cohort: entry.cohort,
    profile: entry.profile,
    can_move_money: entry.can_move_money,
    can_write_config: entry.can_write_config,
    is_fleet: entry.is_fleet,
    duty: entry.duty,
  };
}

/** An AuthUser-shaped caller: by NAME (no row) or by ROW (name blanked, so a
 *  regex could not be what answered). */
function callerByName(entry: (typeof POSITION_POLICY_SEED)[number], perms: string[] = []): AuthUser {
  return {
    id: 7,
    position_name: entry.name,
    department_name: entry.department,
    permissions: perms,
    permissions_set: new Set(perms),
  } as unknown as AuthUser;
}
function callerByRow(entry: (typeof POSITION_POLICY_SEED)[number], perms: string[] = []): AuthUser {
  return {
    id: 7,
    position_name: "Renamed Title",
    department_name: null,
    position_policy: rowOf(entry),
    permissions: perms,
    permissions_set: new Set(perms),
  } as unknown as AuthUser;
}

describe("position_policy seed — each row is its production name, by id", () => {
  test("the seed names the production Titles once each (23 on 2026-09-16)", () => {
    const slugs = POSITION_POLICY_SEED.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.length).toBe(23);
  });

  for (const entry of POSITION_POLICY_SEED) {
    test(`${entry.name} (${entry.slug}): row resolves as the name did`, () => {
      const input = { position_name: entry.name, department_name: entry.department };
      const byName = resolvePositionPolicy(input, null);
      const row = rowOf(entry);
      const byRow = resolvePositionPolicy(input, row);

      // Wildcard: the god rows are exactly the GOD_POSITIONS names.
      expect(positionGrantsWildcard(entry.name, null)).toBe(entry.cohort === "god");
      expect(positionGrantsWildcard(entry.name, row)).toBe(entry.cohort === "god");

      if (entry.cohort === "god") {
        // A god Title never reaches the resolver at hydration (auth.ts injects
        // `*` first); a direct call answers the unrestricted map either way.
        expect(byRow.cohort).toBe("full");
        return;
      }
      expect(byRow.cohort).toBe(byName.cohort);
      expect(byRow.pageAccess).toEqual(byName.pageAccess);
      expect(byRow.scmConfigured).toBe(byName.scmConfigured);
      expect(byRow.flags).toEqual(byName.flags);
      // Fleet: the row carries what FLEET_POSITIONS said by name.
      expect(isFleetPosition(entry.name, row)).toBe(isFleetPosition(entry.name, null));
    });
  }

  test("a row decides even when the name would have said otherwise", () => {
    // A renamed Title keeps its restriction: that is the whole point of the row.
    const renamed = { position_name: "Warehouse Crew JB (temp)", department_name: "Operation Department" };
    const storekeeperRow = rowOf(POSITION_POLICY_SEED.find((e) => e.slug === "storekeeper")!);
    const byRow = resolvePositionPolicy(renamed, storekeeperRow);
    const storekeeperByName = resolvePositionPolicy({ position_name: "Storekeeper", department_name: "Operation Department" }, null);
    expect(byRow.cohort).toBe("restricted");
    expect(byRow.pageAccess).toEqual(storekeeperByName.pageAccess);
    // And a Sales-department Title moved to full by its row is full.
    const fullRow: PositionPolicyRow = { position_id: 1, cohort: "full", profile: null, can_move_money: false, can_write_config: false, is_fleet: false };
    expect(resolvePositionPolicy({ position_name: "Sales Coordinator", department_name: "Sales Department" }, fullRow).cohort).toBe("full");
    // God by row, not by name.
    expect(positionGrantsWildcard("Deputy MD", { ...fullRow, cohort: "god" })).toBe(true);
  });

  test("a row with a profile the code does not know falls back to the name rule (never a lockout)", () => {
    const bad = { position_id: 1, cohort: "restricted", profile: "night_shift", can_move_money: false, can_write_config: false, is_fleet: false } as unknown as PositionPolicyRow;
    expect(policyFromRow(bad)).toBeNull();
    const resolved = resolvePositionPolicy({ position_name: "Unclassified Clerk", department_name: null }, bad);
    expect(resolved.cohort).toBe("full");
  });
});

describe("position_policy migrations carry exactly the seed", () => {
  const seedTuples = POSITION_POLICY_SEED.map((e) =>
    [e.slug, e.cohort, e.profile, e.can_move_money ? 1 : 0, e.can_write_config ? 1 : 0, e.is_fleet ? 1 : 0].join("|"),
  ).sort();

  test("the Postgres migration's VALUES list", () => {
    const sql = readFileSync(PG_MIGRATION, "utf8");
    const tuples = [...sql.matchAll(/\('([a-z_-]+)',\s*'(\w+)',\s*(NULL|'\w+'),\s*(\d),\s*(\d),\s*(\d)\)/g)].map((m) =>
      [m[1], m[2], m[3] === "NULL" ? null : m[3].slice(1, -1), Number(m[4]), Number(m[5]), Number(m[6])].join("|"),
    );
    expect(tuples.sort()).toEqual(seedTuples);
    expect(sql).toMatch(/^-- REVERSAL:/m);
  });

  test("the D1 mirror's per-slug INSERTs", () => {
    const sql = readFileSync(D1_MIRROR, "utf8");
    const tuples: string[] = [];
    for (const m of sql.matchAll(/SELECT id, '(\w+)', (NULL|'\w+'), (\d), (\d), (\d) FROM positions WHERE slug IN \(([^)]+)\)/g)) {
      const profile = m[2] === "NULL" ? null : m[2].slice(1, -1);
      for (const slug of m[6].split(",").map((x) => x.trim().replace(/^'|'$/g, "")))
        tuples.push([slug, m[1], profile, Number(m[3]), Number(m[4]), Number(m[5])].join("|"));
    }
    expect(tuples.sort()).toEqual(seedTuples);
  });
});

describe("position_policy duty — the project-page and crew answers by ROW equal the name rule", () => {
  // The one seeded duty that is NOT what the name rule gave: the regex
  // /^Purchasing$/ never matched the renamed "Procurement/Purchasing", so that
  // Title has resolved to OTHER on projects since the rename while the
  // product-cost check (which carries the alias) still admitted it. The row
  // restores the documented PMS PURCHASING role; no active member on 2026-09-16.
  const KNOWN_ROLE_DIFFERENCE: Record<string, "PURCHASING"> = { purchasing: "PURCHASING" };
  for (const entry of POSITION_POLICY_SEED) {
    test(`${entry.name}: pmsAccess / projectGates agree row vs name`, () => {
      // Owner-tier Titles carry `*` at hydration (positionGrantsWildcard), so
      // both callers get it — the name rule alone never saw a bare god name.
      const perms = entry.cohort === "god" ? ["*"] : [];
      const byName = callerByName(entry, perms);
      const byRow = callerByRow(entry, perms);
      const project = { pic_id: 7 };
      const other = { pic_id: 99 };
      const expectedRole = (p: { pic_id: number }) => KNOWN_ROLE_DIFFERENCE[entry.slug] ?? getPmsRole(byName, p);
      expect(getPmsRole(byRow, project), "PMS role as PIC").toBe(expectedRole(project));
      expect(getPmsRole(byRow, other), "PMS role not PIC").toBe(expectedRole(other));
      expect(isDirectorUser(byRow), "director").toBe(isDirectorUser(byName));
      expect(isSalesUser(byRow), "sales").toBe(isSalesUser(byName));
      expect(isSalesDirectorUser(byRow), "sales director").toBe(isSalesDirectorUser(byName));
      expect(isProductCostViewer(byRow), "cost viewer").toBe(isProductCostViewer(byName));
      expect(isCrewScopedUser(byRow), "crew scoped").toBe(isCrewScopedUser(byName));
      expect(isDefectReviewerPosition(byRow), "defect reviewer").toBe(isDefectReviewerPosition(byName));
      expect(salesDirectorMayAttach("Filled Floor Plan", "Renamed Title", rowOf(entry)), "floor plan attach").toBe(
        salesDirectorMayAttach("Filled Floor Plan", entry.name, null),
      );
    });
  }

  test("a renamed Title keeps its job by row: Storekeeper Supervisor stays the defect reviewer", () => {
    const sup = POSITION_POLICY_SEED.find((e) => e.slug === "storekeeper_supervisor")!;
    expect(isDefectReviewerPosition(callerByRow(sup))).toBe(true);
    expect(isDefectReviewerPosition({ position_name: "Warehouse Crew KL", position_policy: null })).toBe(false);
    const crew = POSITION_POLICY_SEED.find((e) => e.slug === "warehouse_crew_kl")!;
    expect(isCrewScopedUser(callerByRow(crew))).toBe(true);
    expect(isCrewScopedUser(callerByRow(sup))).toBe(false);
  });

  test("duty answers: logistic edits projects, purchasing sees cost, management is a director", () => {
    const base = POSITION_POLICY_SEED.find((e) => e.slug === "hr_manager")!;
    const withDuty = (duty: PositionPolicyRow["duty"]): AuthUser =>
      ({ ...callerByRow(base), position_policy: { ...rowOf(base), duty } }) as AuthUser;
    expect(getPmsRole(withDuty("logistic"), { pic_id: null })).toBe("LOGISTIC");
    expect(getPmsRole(withDuty("purchasing"), { pic_id: null })).toBe("PURCHASING");
    expect(isProductCostViewer(withDuty("purchasing"))).toBe(true);
    expect(isProductCostViewer(withDuty("other"))).toBe(false);
    expect(getPmsRole(withDuty("management"), { pic_id: null })).toBe("DIRECTOR");
    expect(isDirectorUser(withDuty("finance"))).toBe(true);
    expect(getPmsRole(withDuty("helper"), { pic_id: null })).toBe("DRIVER");
    expect(isCrewScopedUser(withDuty("helper"))).toBe(true);
    expect(isCrewScopedUser(withDuty("driver"))).toBe(false);
  });
});

describe("the duty migrations carry exactly the seed", () => {
  const seedDuties = Object.fromEntries(POSITION_POLICY_SEED.map((e) => [e.slug, e.duty]));
  const parse = (sql: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const m of sql.matchAll(/SET duty = '(\w+)'\s+WHERE position_id IN \(SELECT id FROM (?:public\.)?positions WHERE slug IN \(([^)]+)\)\)/g)) {
      for (const slug of m[2].split(",").map((x) => x.trim().replace(/^'|'$/g, ""))) out[slug] = m[1];
    }
    return out;
  };
  for (const [label, file] of [["Postgres", PG_DUTY_MIGRATION], ["D1 mirror", D1_DUTY_MIRROR]] as const) {
    test(`${label}: every non-other seed duty is set, nothing else is`, () => {
      const sql = readFileSync(file, "utf8");
      const fromSql = parse(sql);
      const expected = Object.fromEntries(Object.entries(seedDuties).filter(([, d]) => d !== "other"));
      expect(fromSql).toEqual(expected);
      if (label === "Postgres") expect(sql).toMatch(/^-- REVERSAL:/m);
    });
  }
});

describe("validatePolicyRow refuses what the resolver could not honour", () => {
  const base = { cohort: "full", profile: null, can_move_money: false, can_write_config: false, is_fleet: false };
  test("accepts each seed row", () => {
    for (const e of POSITION_POLICY_SEED) {
      const v = validatePolicyRow(1, { ...rowOf(e) });
      expect(v.ok, e.slug).toBe(true);
    }
  });
  test("restricted needs a known profile; sales needs director|rep; full/god carry none", () => {
    expect(validatePolicyRow(1, { ...base, cohort: "restricted" }).ok).toBe(false);
    expect(validatePolicyRow(1, { ...base, cohort: "restricted", profile: "rep" }).ok).toBe(false);
    expect(validatePolicyRow(1, { ...base, cohort: "sales", profile: "storekeeper" }).ok).toBe(false);
    expect(validatePolicyRow(1, { ...base, cohort: "full", profile: "rep" }).ok).toBe(false);
    expect(validatePolicyRow(1, { ...base, cohort: "sales", profile: "director" }).ok).toBe(true);
  });
  test("fleet only on restricted; money/config only on full (god implies both)", () => {
    expect(validatePolicyRow(1, { ...base, is_fleet: true }).ok).toBe(false);
    expect(validatePolicyRow(1, { ...base, cohort: "sales", profile: "rep", can_move_money: true }).ok).toBe(false);
    const god = validatePolicyRow(1, { ...base, cohort: "god" });
    expect(god.ok && god.row.can_move_money && god.row.can_write_config).toBe(true);
  });
  test("duty: unknown refused, absent reads as other, owner tier is always management", () => {
    expect(validatePolicyRow(1, { ...base, duty: "janitor" }).ok).toBe(false);
    const absent = validatePolicyRow(1, { ...base });
    expect(absent.ok && absent.row.duty).toBe("other");
    const god = validatePolicyRow(1, { ...base, cohort: "god", duty: "warehouse" });
    expect(god.ok && god.row.duty).toBe("management");
    const fromOldDb = policyRowFromDb({ position_id: 3, cohort: "full", profile: null, can_move_money: 1, can_write_config: 0, is_fleet: 0 });
    expect(fromOldDb?.duty).toBe("other");
  });

  test("unknown cohort, missing flags, and a D1 0/1 row all read as intended", () => {
    expect(validatePolicyRow(1, { ...base, cohort: "admin" }).ok).toBe(false);
    expect(validatePolicyRow(1, { cohort: "full" }).ok).toBe(true);
    expect(validatePolicyRow(1, { cohort: "full", can_move_money: "yes" }).ok).toBe(false);
    const fromDb = policyRowFromDb({ position_id: 16, cohort: "restricted", profile: "driver_helper", can_move_money: 0, can_write_config: 0, is_fleet: 1 });
    expect(fromDb).toEqual({ position_id: 16, cohort: "restricted", profile: "driver_helper", can_move_money: false, can_write_config: false, is_fleet: true, duty: "other" });
    expect(policyRowFromDb({ position_id: 16, cohort: null })).toBeNull();
    expect(policyRowFromDb(null)).toBeNull();
  });
});
