// @vitest-project light
//
// THE ALWAYS-HOLDS RULE on GET /staff/pickable — the roster a picker gets back
// must contain the CALLER and every id the screen already has to name, whatever
// narrowing was asked for.
//
// WHAT WENT WRONG (owner 2026-08-21, on HC-SO-2608-003, an order he raised
// himself minutes earlier). `?onlySales=1` narrows the roster to staff whose
// linked user has a position starting "Sales" or a department containing
// "sales" — correct, and it stays. But THREE screens then resolved a PERSON
// against that narrowed list, so all three failed for anyone the narrowing
// excludes:
//   1. New Sales Order could not find its own creator and offered a fake
//      "<name> (me)" option that is not a staff id;
//   2. the Payments "Collected By" default fell to blank;
//   3. the SO / SI / DR / consignment pickers labelled the order's stored
//      salesperson "(former staff)".
// One cause, three symptoms. These tests pin the union that closes it.
//
// The ROUTE cannot be exercised in this harness (scm rides Supabase Postgres) —
// same constraint staffCompanyScope.test.ts records — so the rule is pinned two
// ways: the pure composition below, using the REAL isSalesUser the route calls,
// and a structural check that every exit from the handler goes through it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  alwaysPickableStaffIds,
  unionAlwaysPickable,
  parseIncludeIds,
  MAX_INCLUDE_IDS,
} from "../src/scm/lib/staffCompanyScope";
import { isSalesUser } from "../src/services/pmsAccess";

/* A roster in staff_code order, shaped like the rows the route holds. The
   positions are the LIVE ones — positionAccessSnapshot.ts, generated from
   https://erp.houzscentury.com — so the Sales/non-Sales split here is the
   production split, not an invented one. */
type Row = Record<string, unknown>;
const OWNER: Row = { id: "st-owner", staff_code: "S001", name: "Owner", user_id: 1 };
const SALES_A: Row = { id: "st-sales-a", staff_code: "S002", name: "Sales A", user_id: 2 };
const SALES_B: Row = { id: "st-sales-b", staff_code: "S003", name: "Sales B", user_id: 3 };
const LOGISTICS: Row = { id: "st-logistics", staff_code: "S004", name: "Logistic Admin", user_id: 4 };
const ROSTER: Row[] = [OWNER, SALES_A, SALES_B, LOGISTICS];

const POSITIONS = new Map<number, { position_name: string; department_name: string }>([
  [1, { position_name: "Super Admin", department_name: "Management" }],
  [2, { position_name: "Sales Executive", department_name: "Sales Department" }],
  [3, { position_name: "Sales Person", department_name: "Sales Department" }],
  [4, { position_name: "Logistic Admin", department_name: "Operation Department" }],
]);

/** The route's onlySales narrowing, reproduced over the fixture with the real
 *  predicate. Deliberately NOT a copy of the rule — isSalesUser is imported. */
const narrowToSales = (rows: Row[]): Row[] =>
  rows.filter((r) => {
    const meta = POSITIONS.get(Number(r.user_id));
    if (!meta) return false;
    return isSalesUser({
      position_name: meta.position_name,
      department_name: meta.department_name,
      permissions_set: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the route builds the same partial AuthUser
    } as any);
  });

const idsOf = (rows: Row[]) => rows.map((r) => String(r.id));

describe("the narrowing itself is unchanged — it still hides office / admin / owner", () => {
  test("onlySales drops everyone whose position is not Sales", () => {
    // If this ever passes for the owner, the 2026-07-22 narrowing has been
    // widened for everybody, which is the thing the fix must NOT do.
    expect(idsOf(narrowToSales(ROSTER))).toEqual(["st-sales-a", "st-sales-b"]);
  });
});

describe("the caller is ALWAYS in the roster", () => {
  test("a non-Sales caller (the owner) survives the onlySales narrowing", () => {
    const always = alwaysPickableStaffIds(ROSTER, 1, []);
    const answer = unionAlwaysPickable(ROSTER, narrowToSales(ROSTER), always);
    expect(idsOf(answer)).toContain("st-owner");
  });

  test("and so does a caller in Operations, not just the owner", () => {
    const always = alwaysPickableStaffIds(ROSTER, 4, []);
    const answer = unionAlwaysPickable(ROSTER, narrowToSales(ROSTER), always);
    expect(idsOf(answer)).toContain("st-logistics");
  });

  test("nobody ELSE is let back in — the roster grows by the caller and no more", () => {
    const always = alwaysPickableStaffIds(ROSTER, 1, []);
    const answer = unionAlwaysPickable(ROSTER, narrowToSales(ROSTER), always);
    expect(idsOf(answer)).toEqual(["st-owner", "st-sales-a", "st-sales-b"]);
  });

  test("roster order (staff_code) is preserved and no id appears twice", () => {
    // A Sales caller is ALREADY in the narrowed set; unioning must not duplicate.
    const always = alwaysPickableStaffIds(ROSTER, 2, []);
    const answer = unionAlwaysPickable(ROSTER, narrowToSales(ROSTER), always);
    expect(idsOf(answer)).toEqual(["st-sales-a", "st-sales-b"]);
  });

  test("a caller with no active staff row contributes nothing — no id is invented", () => {
    const always = alwaysPickableStaffIds(ROSTER, 99, []);
    expect(always.size).toBe(0);
  });

  test("an unauthenticated / unresolvable caller id contributes nothing", () => {
    expect(alwaysPickableStaffIds(ROSTER, null, []).size).toBe(0);
  });
});

describe("the id the screen already has to name — ?include=", () => {
  test("the order's stored salesperson comes back even when onlySales hides them", () => {
    // This IS the "(former staff)" bug: st-logistics is on the document, is a
    // sitting employee, and the narrowing removes them.
    const always = alwaysPickableStaffIds(ROSTER, 2, ["st-logistics"]);
    const answer = unionAlwaysPickable(ROSTER, narrowToSales(ROSTER), always);
    expect(idsOf(answer)).toContain("st-logistics");
  });

  test("an id that names NO roster row adds nothing — (former staff) still means gone", () => {
    const always = alwaysPickableStaffIds(ROSTER, 2, ["st-departed"]);
    const answer = unionAlwaysPickable(ROSTER, narrowToSales(ROSTER), always);
    expect(idsOf(answer)).not.toContain("st-departed");
    expect(idsOf(answer)).toEqual(["st-sales-a", "st-sales-b"]);
  });

  test("include cannot enumerate — it only ever echoes ids the caller passed", () => {
    const always = alwaysPickableStaffIds(ROSTER, null, ["st-sales-a"]);
    const answer = unionAlwaysPickable(ROSTER, [], always);
    expect(idsOf(answer)).toEqual(["st-sales-a"]);
  });
});

describe("parseIncludeIds", () => {
  test("empty / absent is an empty list, never a refusal", () => {
    expect(parseIncludeIds(undefined)).toEqual([]);
    expect(parseIncludeIds("")).toEqual([]);
    expect(parseIncludeIds("  ")).toEqual([]);
  });

  test("splits, trims and de-duplicates", () => {
    expect(parseIncludeIds(" a , b ,a, ,b ")).toEqual(["a", "b"]);
  });

  test("past the cap it REFUSES rather than truncating", () => {
    // A silent truncation is the "(former staff)" bug in a smaller hat: the id
    // that got cut is the one the screen needed.
    const many = Array.from({ length: MAX_INCLUDE_IDS + 1 }, (_, i) => `id-${i}`).join(",");
    expect(parseIncludeIds(many)).toBeNull();
    const atCap = Array.from({ length: MAX_INCLUDE_IDS }, (_, i) => `id-${i}`).join(",");
    expect(parseIncludeIds(atCap)).toHaveLength(MAX_INCLUDE_IDS);
  });
});

describe("no exit from GET /pickable can bypass the rule", () => {
  /* The pure rule can be perfect and the bug still return, because the way it
     came back would be a NEW narrowing branch returning `scoped` directly. The
     handler funnels every exit through one `answer()` helper; this pins that,
     so adding a branch that answers on its own fails here instead of on the
     owner's screen. */
  const source = readFileSync(
    path.join(__dirname, "..", "src", "scm", "routes", "staff.ts"),
    "utf8",
  );
  const handler = (() => {
    const start = source.indexOf('staff.get("/pickable"');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\nstaff.get(", start + 1);
    return source.slice(start, end === -1 ? source.length : end);
  })();

  test("the handler still exists and still narrows on onlySales", () => {
    expect(handler).toContain('c.req.query("onlySales") === "1"');
    expect(handler).toContain("isSalesUser(");
  });

  test("every roster-shaped response goes through answer()", () => {
    /* Serialising a roster means calling toStaffRowsWithDerivedRoles. Inside
       this handler that is allowed exactly once — inside `answer`. */
    const serialisations = handler.match(/toStaffRowsWithDerivedRoles\(/g) ?? [];
    expect(serialisations).toHaveLength(1);
    expect(handler).toContain("unionAlwaysPickable(rows, narrowed, alwaysIds)");
  });

  test("fail-closed stays closed — no self / include union when the company gate blanks", () => {
    expect(handler).toContain("failClosed");
    expect(handler).toMatch(/failClosed\s*\n?\s*\?\s*new Set<string>\(\)/);
  });
});
