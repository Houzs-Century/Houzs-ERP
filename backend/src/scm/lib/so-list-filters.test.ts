import { describe, expect, it } from "vitest";
import { effectiveStatusFilter, isRangeNotSatisfiable } from "./so-list-filters";


describe("effectiveStatusFilter", () => {
  it("treats the All tab (all / ALL / '' / whitespace) as NO status filter", () => {
    for (const v of ["all", "ALL", "All", "aLl", "", "   "]) {
      expect(effectiveStatusFilter(v)).toBeUndefined();
    }
  });

  it("treats a missing param as no filter", () => {
    expect(effectiveStatusFilter(undefined)).toBeUndefined();
    expect(effectiveStatusFilter(null)).toBeUndefined();
  });

  it("passes a real status through unchanged (exact match preserved)", () => {
    for (const v of ["CONFIRMED", "READY_TO_SHIP", "DELIVERED", "CANCELLED", "DRAFT"]) {
      expect(effectiveStatusFilter(v)).toBe(v);
    }
  });

  it("passes the OTHER sentinel through so the Other pill still opens", () => {
    expect(effectiveStatusFilter("OTHER")).toBe("OTHER");
  });

  it("trims surrounding whitespace but keeps the real value", () => {
    expect(effectiveStatusFilter("  CONFIRMED  ")).toBe("CONFIRMED");
  });
});

describe("isRangeNotSatisfiable", () => {
  it("recognises the PGRST103 code", () => {
    expect(isRangeNotSatisfiable({ code: "PGRST103" })).toBe(true);
  });

  it("recognises the message, case-insensitively", () => {
    expect(isRangeNotSatisfiable({ message: "Requested range not satisfiable" })).toBe(true);
    expect(isRangeNotSatisfiable({ message: "requested RANGE NOT SATISFIABLE for..." })).toBe(true);
  });

  it("is false for an absent error (the happy path)", () => {
    expect(isRangeNotSatisfiable(null)).toBe(false);
    expect(isRangeNotSatisfiable(undefined)).toBe(false);
  });

  it("is false for any OTHER PostgREST error — those must still surface as 500", () => {
    expect(isRangeNotSatisfiable({ code: "PGRST116", message: "no rows" })).toBe(false);
    expect(isRangeNotSatisfiable({ code: "42501", message: "permission denied for schema scm" })).toBe(false);
    expect(isRangeNotSatisfiable({ message: "column mfg_sales_orders.foo does not exist" })).toBe(false);
  });
});
