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

function rowOf(entry: (typeof POSITION_POLICY_SEED)[number], positionId = 999): PositionPolicyRow {
  return {
    position_id: positionId,
    cohort: entry.cohort,
    profile: entry.profile,
    can_move_money: entry.can_move_money,
    can_write_config: entry.can_write_config,
    is_fleet: entry.is_fleet,
  };
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
  test("unknown cohort, missing flags, and a D1 0/1 row all read as intended", () => {
    expect(validatePolicyRow(1, { ...base, cohort: "admin" }).ok).toBe(false);
    expect(validatePolicyRow(1, { cohort: "full" }).ok).toBe(true);
    expect(validatePolicyRow(1, { cohort: "full", can_move_money: "yes" }).ok).toBe(false);
    const fromDb = policyRowFromDb({ position_id: 16, cohort: "restricted", profile: "driver_helper", can_move_money: 0, can_write_config: 0, is_fleet: 1 });
    expect(fromDb).toEqual({ position_id: 16, cohort: "restricted", profile: "driver_helper", can_move_money: false, can_write_config: false, is_fleet: true });
    expect(policyRowFromDb({ position_id: 16, cohort: null })).toBeNull();
    expect(policyRowFromDb(null)).toBeNull();
  });
});
