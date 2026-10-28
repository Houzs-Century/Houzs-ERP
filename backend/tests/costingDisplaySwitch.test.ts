// ----------------------------------------------------------------------------
// cost-display switch — the ACCEPTANCE suite for fix/cost-display-backend-gate.
//
// The bug: the frontend's build-time COSTING_DISPLAY_ENABLED hid only the FE
// cost/margin COLUMN, while the backend gate canViewScmFinance had no matching
// term and kept SHIPPING cost/margin to every finance viewer — a two-rule split.
// The fix makes the backend env var COSTING_DISPLAY_ENABLED the AUTHORITATIVE
// switch, ANDed into BOTH the gate (canViewScmFinance — the single chokepoint the
// ~9 SCM sales routes strip through) AND the scm.finance.view capability the FE
// reads. This suite pins:
//   ON  (var absent / "true")  → behaviour UNCHANGED (finance viewers see cost).
//   OFF ("false")              → cost withheld from EVERYONE, on the gate AND the
//                                 capability, WITHOUT moving the finance cohort or
//                                 the separate product-cost path.
// ----------------------------------------------------------------------------

import { describe, expect, test } from "vitest";
import { canViewScmFinance } from "../src/scm/lib/houzs-perms";
import { isCostingDisplayEnabled } from "../src/scm/lib/costing-enabled";
import {
  resolveCapabilities,
  type CapabilityCaller,
  type CapabilityKey,
} from "../src/services/capabilities";

type Role = { position_name?: string | null; permissions?: string[] };

/** The HouzsUserSource + env shim canViewScmFinance now reads: the stashed
 *  houzsUser (position + granted keys) AND the worker env (the switch var). */
function ctx(u: Role | null, env: { COSTING_DISPLAY_ENABLED?: string } = {}) {
  return {
    get: (_k: "houzsUser") =>
      u === null
        ? undefined
        : { position_name: u.position_name ?? null, permissions_set: new Set(u.permissions ?? []) },
    env,
  } as Parameters<typeof canViewScmFinance>[0];
}

// Every cohort that sees cost when the switch is ON: the three director
// positions (isFinanceViewer) plus the `*` owner. Sales is the negative control.
const FINANCE_POSITIONS = ["Sales Director", "Finance Manager", "Super Admin"];
const OWNER: Role = { position_name: "Owner", permissions: ["*"] };
const SALES: Role = { position_name: "Sales Executive" };
const OFF = { COSTING_DISPLAY_ENABLED: "false" };

describe("cost-display switch — isCostingDisplayEnabled parse (default ON)", () => {
  test("absent / non-false = ON — a missing var can never silently hide cost", () => {
    expect(isCostingDisplayEnabled(undefined)).toBe(true);
    expect(isCostingDisplayEnabled(null)).toBe(true);
    expect(isCostingDisplayEnabled({})).toBe(true);
    expect(isCostingDisplayEnabled({ COSTING_DISPLAY_ENABLED: "true" })).toBe(true);
    expect(isCostingDisplayEnabled({ COSTING_DISPLAY_ENABLED: "" })).toBe(true);
    expect(isCostingDisplayEnabled({ COSTING_DISPLAY_ENABLED: "yes" })).toBe(true);
  });
  test("only the exact string 'false' (case/space tolerant) = OFF", () => {
    for (const raw of ["false", " false ", "FALSE", "False"]) {
      expect(isCostingDisplayEnabled({ COSTING_DISPLAY_ENABLED: raw })).toBe(false);
    }
  });
});

describe("cost-display switch — the gate (canViewScmFinance)", () => {
  test("ON (var absent) — UNCHANGED: finance viewers + owner see cost, sales do not", () => {
    for (const pos of FINANCE_POSITIONS) expect(canViewScmFinance(ctx({ position_name: pos }))).toBe(true);
    expect(canViewScmFinance(ctx(OWNER))).toBe(true);
    expect(canViewScmFinance(ctx(SALES))).toBe(false);
  });

  test("ON (var 'true') — identical to absent", () => {
    const on = { COSTING_DISPLAY_ENABLED: "true" };
    for (const pos of FINANCE_POSITIONS) expect(canViewScmFinance(ctx({ position_name: pos }, on))).toBe(true);
    expect(canViewScmFinance(ctx(OWNER, on))).toBe(true);
    expect(canViewScmFinance(ctx(SALES, on))).toBe(false);
  });

  test("OFF ('false') — cost withheld from EVERYONE, finance viewers + owner INCLUDED", () => {
    for (const pos of FINANCE_POSITIONS) expect(canViewScmFinance(ctx({ position_name: pos }, OFF))).toBe(false);
    expect(canViewScmFinance(ctx(OWNER, OFF))).toBe(false);
    expect(canViewScmFinance(ctx(SALES, OFF))).toBe(false);
  });
});

describe("cost-display switch — the capability the FE reads (scm.finance.view)", () => {
  const financeViewer: CapabilityCaller = { position_name: "Finance Manager", permissions: [] };

  test("ON — scm.finance.view granted to a finance viewer (default + explicit true)", () => {
    expect(resolveCapabilities(financeViewer)["scm.finance.view"]).toBe(true);
    expect(resolveCapabilities(financeViewer, { costingDisplayEnabled: true })["scm.finance.view"]).toBe(true);
  });

  test("OFF — scm.finance.view dropped, and it is the ONLY capability that moves", () => {
    const on = resolveCapabilities(financeViewer, { costingDisplayEnabled: true });
    const off = resolveCapabilities(financeViewer, { costingDisplayEnabled: false });
    expect(on["scm.finance.view"]).toBe(true);
    expect(off["scm.finance.view"]).toBe(false);
    // The finance-viewer COHORT and every other answer are untouched — the switch
    // is a global display toggle, not a change to WHO is a finance viewer.
    for (const k of Object.keys(on) as CapabilityKey[]) {
      if (k === "scm.finance.view") continue;
      expect(off[k]).toBe(on[k]);
    }
  });

  test("OFF — product cost (scm.productCost.view) does NOT ride the display switch", () => {
    // Purchasing is in the product-cost cohort but not the finance cohort; the
    // switch must leave SKU cost entry/display alone (else flipping it off would
    // strand the column an admin needs to flip it back on).
    const purchasing: CapabilityCaller = {
      position_name: "Procurement/Purchasing",
      department_name: "Purchasing",
      permissions: [],
    };
    expect(resolveCapabilities(purchasing, { costingDisplayEnabled: false })["scm.productCost.view"]).toBe(
      resolveCapabilities(purchasing, { costingDisplayEnabled: true })["scm.productCost.view"],
    );
  });
});
