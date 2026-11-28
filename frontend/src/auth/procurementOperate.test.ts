import { describe, it, expect } from "vitest";
import { canOperateGoodsReceipts, canOperatePurchaseInvoices, canOperatePurchaseOrders } from "./salesAccess";
import type { AccessLevel } from "../types";

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

describe("purchase invoice operate gate mirrors the backend area guard", () => {
  it("refuses every level below edit", () => {
    for (const level of ["none", "view"] as AccessLevel[]) {
      expect(canOperatePurchaseInvoices(noPerms, pageAccessOf(level))).toBe(false);
    }
  });

  it("allows edit and full", () => {
    for (const level of ["edit", "full"] as AccessLevel[]) {
      expect(canOperatePurchaseInvoices(noPerms, pageAccessOf(level))).toBe(true);
    }
  });

  it("Owner / IT (`*`) always passes, at any matrix level", () => {
    for (const level of rank) {
      expect(canOperatePurchaseInvoices(wildcard, pageAccessOf(level))).toBe(true);
    }
  });

  it("reads scm.procurement.pi, and PO / GRN edit rights do not lend it", () => {
    const poAndGrn = (page: string) =>
      (page === "scm.procurement.po" || page === "scm.procurement.grn" ? "edit" : "view") as AccessLevel;
    expect(canOperatePurchaseInvoices(noPerms, poAndGrn)).toBe(false);
    const onlyPi = (page: string) => (page === "scm.procurement.pi" ? "edit" : "view") as AccessLevel;
    expect(canOperatePurchaseInvoices(noPerms, onlyPi)).toBe(true);
    expect(canOperatePurchaseOrders(noPerms, onlyPi)).toBe(false);
  });
});
