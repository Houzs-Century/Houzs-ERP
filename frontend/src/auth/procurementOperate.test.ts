import { describe, it, expect } from "vitest";
import { canOperateGoodsReceipts, canOperatePurchaseOrders } from "./salesAccess";
import type { AccessLevel } from "../types";

/**
 * The mobile module list renders its "+" on the presence of an `onNew` callback
 * alone, and `MobileConvertWizard` imports no auth of its own — so withholding
 * `onNew` is the ONLY thing that keeps a convert wizard away from someone who
 * may not write. `MobileApp` gated the DO and SI targets and then fell through
 * to a literal `: true` for the other two, which are GRN and PO. A view-level
 * holder of either was offered the "+", filled in the whole wizard, and hit a
 * 403 from the area guard at the end of it.
 *
 * These pin the two new gates to the backend rule they mirror
 * (`scm/middleware/area-guard`: `edit` on the area for POST/PATCH/PUT/DELETE).
 */
const rank: AccessLevel[] = ["none", "view", "edit", "full"];
const pageAccessOf = (level: AccessLevel) => () => level;
const noPerms = () => false;
const wildcard = (p: string) => p === "*";

describe("procurement operate gates mirror the backend area guard", () => {
  it("refuses every level below edit", () => {
    for (const level of ["none", "view"] as AccessLevel[]) {
      expect(canOperatePurchaseOrders(noPerms, pageAccessOf(level))).toBe(false);
      expect(canOperateGoodsReceipts(noPerms, pageAccessOf(level))).toBe(false);
    }
  });

  it("allows edit and full", () => {
    for (const level of ["edit", "full"] as AccessLevel[]) {
      expect(canOperatePurchaseOrders(noPerms, pageAccessOf(level))).toBe(true);
      expect(canOperateGoodsReceipts(noPerms, pageAccessOf(level))).toBe(true);
    }
  });

  it("Owner / IT (`*`) always passes, at any matrix level", () => {
    for (const level of rank) {
      expect(canOperatePurchaseOrders(wildcard, pageAccessOf(level))).toBe(true);
      expect(canOperateGoodsReceipts(wildcard, pageAccessOf(level))).toBe(true);
    }
  });

  it("each gate reads its OWN area, not the other's", () => {
    const onlyPo = (page: string) => (page === "scm.procurement.po" ? "edit" : "view") as AccessLevel;
    expect(canOperatePurchaseOrders(noPerms, onlyPo)).toBe(true);
    expect(canOperateGoodsReceipts(noPerms, onlyPo)).toBe(false);
  });
});
