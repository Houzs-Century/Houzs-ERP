import { describe, expect, test } from "vitest";
import {
  staffCompanyIds,
  staffRowInActiveCompany,
  filterStaffToCompany,
  type StaffScopeRow,
} from "../src/scm/lib/staffCompanyScope";

// The salesperson arm of the cross-company picker-leak class. GET /staff/pickable
// derives each scm.staff row's company from Team grants (public.user_companies)
// so the salesperson dropdown offers only the ACTIVE company's people. These pin
// the pure derivation rule both directions — the route can't be exercised in this
// harness (scm rides Supabase Postgres), matching dpOrdersScope.test.ts.
//
// Company ids are resolved from companies.code at runtime; the fixtures use the
// prod values HOUZS = 1, 2990 = 2, but nothing here hardcodes them beyond the
// fixture (the rule takes them as arguments).
const HOUZS = 1;
const H2990 = 2;
const SYSTEM_STAFF_ID = "00000000-0000-4000-8000-000000000001";
const ids = { active: HOUZS, houzs: HOUZS, mirror: H2990 };

// A roster covering every branch of the rule.
const houzsOnly: StaffScopeRow = { id: "s-houzs", user_id: 101 }; // grant {HOUZS}
const bothGranted: StaffScopeRow = { id: "s-both", user_id: 102 }; // grant {HOUZS,2990}
const h2990Only: StaffScopeRow = { id: "s-2990", user_id: 103 }; // grant {2990}
const linkedNoGrant: StaffScopeRow = { id: "s-ungranted", user_id: 104 }; // 0 grants
const mirrored: StaffScopeRow = { id: "s-mirror-2990", user_id: null }; // unlinked import
const systemRow: StaffScopeRow = { id: SYSTEM_STAFF_ID, user_id: null }; // Houzs seed

const roster = [houzsOnly, bothGranted, h2990Only, linkedNoGrant, mirrored, systemRow];

// user_id -> granted company ids. user 104 is deliberately ABSENT = zero grants.
const grants = new Map<number, number[]>([
  [101, [HOUZS]],
  [102, [HOUZS, H2990]],
  [103, [H2990]],
]);

const idsFor = (active: number) => ({ active, houzs: HOUZS, mirror: H2990 });

describe("staffCompanyIds — per-row company attribution", () => {
  test("a LINKED user's company set is exactly their grants (both = both)", () => {
    expect(staffCompanyIds(houzsOnly, grants, ids, SYSTEM_STAFF_ID)).toEqual([HOUZS]);
    expect(staffCompanyIds(bothGranted, grants, ids, SYSTEM_STAFF_ID)).toEqual([HOUZS, H2990]);
    expect(staffCompanyIds(h2990Only, grants, ids, SYSTEM_STAFF_ID)).toEqual([H2990]);
  });

  test("a LINKED user with ZERO grants defaults to the HOUZS base — NOT all companies", () => {
    // The load-bearing decision: mirroring companyContext's fail-open here would
    // put an ungranted user in BOTH pickers and re-open the leak.
    expect(staffCompanyIds(linkedNoGrant, grants, ids, SYSTEM_STAFF_ID)).toEqual([HOUZS]);
  });

  test("an UNLINKED (user_id NULL) row is attributed to the 2990 mirror source", () => {
    expect(staffCompanyIds(mirrored, grants, ids, SYSTEM_STAFF_ID)).toEqual([H2990]);
  });

  test("the seeded system row is a HOUZS artifact despite user_id NULL", () => {
    expect(staffCompanyIds(systemRow, grants, ids, SYSTEM_STAFF_ID)).toEqual([HOUZS]);
  });

  test("returns a fresh array — a caller cannot mutate the grant map through it", () => {
    const out = staffCompanyIds(bothGranted, grants, ids, SYSTEM_STAFF_ID);
    out.push(999);
    expect(grants.get(102)).toEqual([HOUZS, H2990]);
  });
});

describe("filterStaffToCompany — active HOUZS", () => {
  const out = filterStaffToCompany(roster, grants, idsFor(HOUZS), SYSTEM_STAFF_ID);
  const idsOut = out.map((r) => r.id);

  test("shows HOUZS-granted, both-granted, ungranted(->HOUZS) and the system row", () => {
    expect(idsOut).toContain(houzsOnly.id);
    expect(idsOut).toContain(bothGranted.id);
    expect(idsOut).toContain(linkedNoGrant.id);
    expect(idsOut).toContain(systemRow.id);
  });

  test("HIDES the 2990-only salesperson and the 2990 mirror row", () => {
    expect(idsOut).not.toContain(h2990Only.id);
    expect(idsOut).not.toContain(mirrored.id);
  });
});

describe("filterStaffToCompany — active 2990", () => {
  const out = filterStaffToCompany(roster, grants, idsFor(H2990), SYSTEM_STAFF_ID);
  const idsOut = out.map((r) => r.id);

  test("shows 2990-granted, both-granted and the 2990 mirror row", () => {
    expect(idsOut).toContain(h2990Only.id);
    expect(idsOut).toContain(bothGranted.id);
    expect(idsOut).toContain(mirrored.id);
  });

  test("HIDES the Houzs-only salesperson, the ungranted(->HOUZS) user and the system row", () => {
    expect(idsOut).not.toContain(houzsOnly.id);
    expect(idsOut).not.toContain(linkedNoGrant.id);
    expect(idsOut).not.toContain(systemRow.id);
  });
});

describe("the both-granted user appears in EACH company's picker", () => {
  test("both directions include the both-granted salesperson", () => {
    expect(staffRowInActiveCompany(bothGranted, grants, idsFor(HOUZS), SYSTEM_STAFF_ID)).toBe(true);
    expect(staffRowInActiveCompany(bothGranted, grants, idsFor(H2990), SYSTEM_STAFF_ID)).toBe(true);
  });
});

describe("fail-closed edges", () => {
  test("an active company nobody is granted yields an EMPTY list, never all rows", () => {
    // Route resolves the active company from the master; if it somehow resolves
    // to a company no row belongs to, the derivation matches nothing (never dumps
    // the roster). The route's own three-state gate is what returns [] on an
    // UNRESOLVED active company — this covers the resolved-but-foreign case.
    const out = filterStaffToCompany(roster, grants, idsFor(999), SYSTEM_STAFF_ID);
    expect(out).toEqual([]);
  });

  test("when HOUZS is unresolvable, ungranted linked rows and the system row hide (fail closed)", () => {
    const noHouzs = { active: HOUZS, houzs: undefined, mirror: H2990 };
    expect(staffCompanyIds(linkedNoGrant, grants, noHouzs, SYSTEM_STAFF_ID)).toEqual([]);
    expect(staffCompanyIds(systemRow, grants, noHouzs, SYSTEM_STAFF_ID)).toEqual([]);
    expect(staffRowInActiveCompany(linkedNoGrant, grants, noHouzs, SYSTEM_STAFF_ID)).toBe(false);
  });

  test("when 2990 is unresolvable, unlinked mirror rows hide (fail closed)", () => {
    const noMirror = { active: H2990, houzs: HOUZS, mirror: undefined };
    expect(staffCompanyIds(mirrored, grants, noMirror, SYSTEM_STAFF_ID)).toEqual([]);
    expect(staffRowInActiveCompany(mirrored, grants, noMirror, SYSTEM_STAFF_ID)).toBe(false);
  });
});
