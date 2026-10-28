import { describe, expect, test } from "vitest";
import {
  isProductCostViewer,
  isDirectorUser,
  isFinanceViewer,
  financeHiddenForUser,
  getPmsAccess,
  getPmsRole,
} from "../src/services/pmsAccess";
import { canViewScmProductCost, canViewScmFinance } from "../src/scm/lib/houzs-perms";
import type { AuthUser } from "../src/services/auth";

/* Owner 2026-07-17, shown that his 2026-06-13 red line ("Only Purchasing +
   Finance see cost") was not in force because Purchasing is in no cost cohort:
   "那就是采购、Finance，还有 Sales Director 啊？"

   The cost question rode `project_finance_viewer`, which answers "are you a PMS
   DIRECTOR". Two questions, one flag — so restoring Purchasing to the cost
   cohort by widening that flag would ALSO have handed him every project's
   financials and made him a director. These lock BOTH halves: that Purchasing
   gains cost, and that he gains nothing else. The second is the acceptance
   test — widening a gate is the direction that leaks. */

function user(over: {
  id?: number;
  position_name?: string | null;
  department_name?: string | null;
  perms?: string[];
}): AuthUser {
  const perms = over.perms ?? [];
  return {
    id: over.id ?? 1,
    email: "t@test.local",
    name: "t",
    role_id: 1,
    role_name: "r",
    position_id: 1,
    position_name: over.position_name ?? null,
    status: "active",
    permissions: perms,
    permissions_set: new Set(perms),
    manager_id: null,
    scope_to_pic: false,
    department_id: null,
    department_name: over.department_name ?? null,
    brand_scope: null,
    page_access: {},
    scm_l2_configured: false,
  } as AuthUser;
}

const purchasing = user({ position_name: "Purchasing", department_name: "Operation Department" });

describe("product-cost cohort", () => {
  test("Purchasing sees cost — the restoration", () => {
    expect(isProductCostViewer(purchasing)).toBe(true);
  });

  test("Purchasing gains NOTHING ELSE — no PMS financials, not a director", () => {
    // The whole reason this is its own flag. If any of these flip, the change
    // has handed Purchasing the PMS project financials the owner never asked for.
    expect(isDirectorUser(purchasing)).toBe(false);
    expect(isFinanceViewer(purchasing)).toBe(false);
    expect(financeHiddenForUser(purchasing)).toBe(true);

    const access = getPmsAccess(purchasing, { pic_id: null });
    expect(getPmsRole(purchasing, { pic_id: null })).toBe("PURCHASING");
    expect(access.canFinancial).toBe(false);
    expect(access.canRental).toBe(false);
    expect(access.canPayment).toBe(false);
    expect(access.canSensitive).toBe(false);
    expect(access.canEdit).toBe(false);
    expect(access.sections).toEqual(["BOOTH_LAYOUT", "SETUP_DISMANTLE"]);

    // Even as the PIC of the project — PIC is per-project, not a title, and it
    // must not become a back door to the financial snapshot either.
    expect(getPmsAccess(purchasing, { pic_id: purchasing.id }).canFinancial).toBe(false);
  });

  test("a Sales Executive still gains nothing — the cohort did not widen sideways", () => {
    const sales = user({ position_name: "Sales Executive", department_name: "Sales Department" });
    expect(isProductCostViewer(sales)).toBe(false);
    expect(isDirectorUser(sales)).toBe(false);
  });

  test("the `*` wildcard is unaffected — it sees cost, as it always did", () => {
    const owner = user({ position_name: "Owner", department_name: "Management", perms: ["*"] });
    expect(isProductCostViewer(owner)).toBe(true);
    expect(isDirectorUser(owner)).toBe(true);
  });

  test("Sales Director + Finance Manager keep cost — the ruling's other two names", () => {
    expect(isProductCostViewer(user({ position_name: "Sales Director" }))).toBe(true);
    expect(isProductCostViewer(user({ position_name: "Finance Manager" }))).toBe(true);
    // Strict superset: every director is a cost viewer, by construction.
    expect(isProductCostViewer(user({ position_name: "Super Admin" }))).toBe(true);
  });

  test("the LIVE prod purchasing row matches by exact name + rename alias, but a substring rename does NOT inject", () => {
    // The live prod position is "Procurement/Purchasing" (positionAccessSnapshot.ts
    // id 13); "Purchasing" is kept as the documented pre-rename alias. Both must
    // keep cost so the ruling stays in force for the real row.
    expect(isProductCostViewer(user({ position_name: "Procurement/Purchasing" }))).toBe(true);
    expect(isProductCostViewer(user({ position_name: "Purchasing" }))).toBe(true);
    // Owner-approved hardening 2026-07-18 (harden/position-name-matchers): the
    // matcher was tightened from /\bPurchasing\b/i to an EXACT normalised-name
    // set because position names are owner-editable free text. A future rename
    // that merely CONTAINS "Purchasing" must no longer inherit cost — that
    // substring convenience was the injection hole.
    expect(isProductCostViewer(user({ position_name: "Purchasing Assistant" }))).toBe(false);
    expect(isProductCostViewer(user({ position_name: "Test Purchasing" }))).toBe(false);
    // ...and the real row is still not a director.
    expect(isDirectorUser(user({ position_name: "Procurement/Purchasing" }))).toBe(false);
  });

  test("no position / no user → no cost (fails closed)", () => {
    expect(isProductCostViewer(user({ position_name: null }))).toBe(false);
    expect(isProductCostViewer(null)).toBe(false);
    expect(isProductCostViewer(undefined)).toBe(false);
  });
});

/* The WIRE half of the same ruling — added 2026-07-17 (fix/purchasing-margin).
   #699 moved the SCREEN to the cost cohort. #673, merged 26 minutes later,
   added a payload strip on the DIRECTOR gate (canViewScmFinance) at the three
   PRODUCT_FINANCE_KEYS sites. Both are on main; together they told Purchasing
   he could see cost and then deleted cost_price_sen from his payload — the
   ruling was dead again, in the identical restrictive-and-silent way #699
   existed to end. These pin screen and wire to ONE question, and pin that the
   MARGIN gate did NOT move with it. */

/** Minimal HouzsUserSource — the shim the scm gates read the REAL caller from
 *  (inside /api/scm/* the `user` context is a pinned system row with no
 *  position, so houzsUser is the only place the position survives). */
function ctx(u: AuthUser | null) {
  return {
    get: (_k: "houzsUser") =>
      u === null
        ? undefined
        : { position_name: u.position_name, permissions_set: u.permissions_set },
  } as Parameters<typeof canViewScmProductCost>[0];
}

describe("product-cost cohort — the wire agrees with the screen", () => {
  test("Purchasing's payload KEEPS cost_price_sen — the strip no longer contradicts #699", () => {
    // The whole bug: this was false while the FE said true, so the Cost column
    // rendered blank for the one function the ruling named.
    expect(canViewScmProductCost(ctx(purchasing))).toBe(true);
  });

  test("the MARGIN gate did NOT move — Purchasing is still not a finance viewer", () => {
    // The acceptance test for this PR. canViewScmFinance gates SO_FINANCE_KEYS,
    // the /reports listing and sales-analysis's customer-level + company-wide
    // margin. The owner ruled on SKU cost; widening this is what would leak.
    expect(canViewScmFinance(ctx(purchasing))).toBe(false);
  });

  test("directors keep cost on the wire — the cohort only ever widened by Purchasing", () => {
    for (const pos of ["Sales Director", "Finance Manager", "Super Admin", "Procurement/Purchasing"]) {
      expect(canViewScmProductCost(ctx(user({ position_name: pos })))).toBe(true);
    }
    const owner = user({ position_name: "Owner", perms: ["*"] });
    expect(canViewScmProductCost(ctx(owner))).toBe(true);
    expect(canViewScmFinance(ctx(owner))).toBe(true);
  });

  test("a Sales Executive gets no cost on the wire either", () => {
    const sales = user({ position_name: "Sales Executive", department_name: "Sales Department" });
    expect(canViewScmProductCost(ctx(sales))).toBe(false);
    expect(canViewScmFinance(ctx(sales))).toBe(false);
  });

  test("no houzsUser → no cost (fails closed, same as canViewScmFinance)", () => {
    expect(canViewScmProductCost(ctx(null))).toBe(false);
    expect(canViewScmFinance(ctx(null))).toBe(false);
  });

  test("wire and screen answer the SAME question — pinned so they cannot drift again", () => {
    // isProductCostViewer is what /auth/me's product_cost_viewer flag is computed
    // from AND what the strip now asks. If these ever disagree, the bug this
    // file documents has come back.
    for (const pos of [
      "Purchasing", "Test Purchasing", "Sales Director", "Finance Manager",
      "Super Admin", "Sales Executive", "Logistics", "Driver", null,
    ]) {
      const u = user({ position_name: pos });
      expect(canViewScmProductCost(ctx(u))).toBe(isProductCostViewer(u));
    }
  });
});
