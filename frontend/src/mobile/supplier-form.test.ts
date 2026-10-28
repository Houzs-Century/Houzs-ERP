/* The phone's supplier form per caller (owner 2026-09-30). Pinned against the
   REAL FORM_SUPPLIERS: a purchaser gets no Finance field on new or edit and no
   code on edit; Finance gets the form as it is. */
import { describe, expect, it } from "vitest";
import { FORM_SUPPLIERS } from "./MobileModuleList";
import { supplierFormFor } from "./supplier-form";
import { SUPPLIER_FINANCE_BODY_KEYS } from "../vendor/shared/supplier-finance-fields";

const keys = (mode: "new" | "edit", finance: boolean) => supplierFormFor(FORM_SUPPLIERS, finance, mode).fields.map((f) => f.key);

describe("supplierFormFor", () => {
  it("the real form carries Finance fields today — the thing this filters", () => {
    expect(FORM_SUPPLIERS.fields.map((f) => f.key)).toEqual(expect.arrayContaining(["code", "creditLimitSen", "businessRegNo", "tinNumber"]));
  });

  it("a purchaser creates with the code and without the Finance part", () => {
    const k = keys("new", false);
    expect(k).toContain("code");
    for (const f of SUPPLIER_FINANCE_BODY_KEYS) expect(k).not.toContain(f);
    expect(k).toEqual(expect.arrayContaining(["name", "paymentTerms", "currency"]));
  });

  it("a purchaser edits without the code and without the Finance part", () => {
    const k = keys("edit", false);
    expect(k).not.toContain("code");
    for (const f of SUPPLIER_FINANCE_BODY_KEYS) expect(k).not.toContain(f);
  });

  it("Finance gets the form as it is", () => {
    expect(supplierFormFor(FORM_SUPPLIERS, true, "edit")).toBe(FORM_SUPPLIERS);
    expect(supplierFormFor(FORM_SUPPLIERS, true, "new")).toBe(FORM_SUPPLIERS);
  });
});
