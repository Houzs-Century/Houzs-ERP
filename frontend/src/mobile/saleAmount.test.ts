/* Regression: the phone "Log sale" prompt used parseFloat, so "12,000" logged
   RM 12. The prompt now uses the shared money parser. */
import { describe, expect, test } from "vitest";
import { saleAmountRm, validateSaleAmount } from "./saleAmount";

describe("Log sale amount", () => {
  test("a thousands comma is read as grouping, not as the end of the number", () => {
    expect(validateSaleAmount("12,000")).toBeNull();
    expect(saleAmountRm("12,000")).toBe(12000);
    expect(saleAmountRm("1,234,567.89")).toBe(1234567.89);
    expect(saleAmountRm("RM 12,000.50")).toBe(12000.5);
    expect(saleAmountRm("5000")).toBe(5000);
  });

  test("ambiguous shapes are refused with a visible message, never guessed", () => {
    for (const bad of ["1,20", "12,00", "1.200,50", "12.000.00", "12k", "abc"]) {
      expect(validateSaleAmount(bad), bad).toEqual(expect.any(String));
      expect(() => saleAmountRm(bad)).toThrow();
    }
  });

  test("zero, blank and negative are refused", () => {
    for (const bad of ["", "   ", "0", "0.00", "-50"]) {
      expect(validateSaleAmount(bad), bad).toEqual(expect.any(String));
    }
  });

  test("more than two decimals is refused rather than rounded", () => {
    expect(validateSaleAmount("12.345")).toMatch(/decimal/);
  });
});
