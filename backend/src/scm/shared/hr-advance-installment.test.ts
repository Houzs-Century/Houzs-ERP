import { describe, expect, test } from "vitest";
import { advanceInstallmentForMonth, advanceRemainingAfterMonth } from "./hr-advance-installment";

const A = "2026-09"; // advance given September 2026

describe("advanceInstallmentForMonth", () => {
  test("lump sum: whole amount in its own month, nothing before or after", () => {
    expect(advanceInstallmentForMonth(A, null, 50000, "2026-08")).toBe(0);
    expect(advanceInstallmentForMonth(A, null, 50000, "2026-09")).toBe(50000);
    expect(advanceInstallmentForMonth(A, null, 50000, "2026-10")).toBe(0);
  });

  test("split into N months, exact: 500 / 5 = 100 each for 5 months then 0", () => {
    const by = ["2026-09", "2026-10", "2026-11", "2026-12", "2027-01"].map((m) => advanceInstallmentForMonth(A, 10000, 50000, m));
    expect(by).toEqual([10000, 10000, 10000, 10000, 10000]);
    expect(advanceInstallmentForMonth(A, 10000, 50000, "2027-02")).toBe(0);
  });

  test("split into N months, remainder: 500 / 3 -> 167, 167, 166", () => {
    // ceil(50000/3) = 16667; months take 16667, 16667, then the 16666 left.
    const by = ["2026-09", "2026-10", "2026-11"].map((m) => advanceInstallmentForMonth(A, 16667, 50000, m));
    expect(by).toEqual([16667, 16667, 16666]);
    expect(by.reduce((s, x) => s + x, 0)).toBe(50000);
    expect(advanceInstallmentForMonth(A, 16667, 50000, "2026-12")).toBe(0);
  });

  test("fixed monthly RM150 on a RM500 advance -> 150, 150, 150, 50", () => {
    const by = ["2026-09", "2026-10", "2026-11", "2026-12"].map((m) => advanceInstallmentForMonth(A, 15000, 50000, m));
    expect(by).toEqual([15000, 15000, 15000, 5000]);
    expect(by.reduce((s, x) => s + x, 0)).toBe(50000);
    expect(advanceInstallmentForMonth(A, 15000, 50000, "2027-01")).toBe(0);
  });

  test("before the advance starts -> 0", () => {
    expect(advanceInstallmentForMonth(A, 10000, 50000, "2026-01")).toBe(0);
  });

  test("after it is fully repaid -> 0", () => {
    expect(advanceInstallmentForMonth(A, 10000, 50000, "2028-06")).toBe(0);
  });

  test("the installment schedule always sums to exactly the amount", () => {
    for (const [amount, inst] of [
      [50000, 10000],
      [50000, 16667],
      [50000, 15000],
      [12345, 1000],
      [99999, 33333],
      [7, 2],
    ] as const) {
      let total = 0;
      // Walk far past the end of any schedule.
      for (let i = 0; i < 240; i++) {
        const m = `${2026 + Math.floor((8 + i) / 12)}-${String(((8 + i) % 12) + 1).padStart(2, "0")}`;
        total += advanceInstallmentForMonth(A, inst, amount, m);
      }
      expect(total).toBe(amount);
    }
  });

  test("a single-month installment >= the amount behaves like a lump sum", () => {
    expect(advanceInstallmentForMonth(A, 60000, 50000, "2026-09")).toBe(50000);
    expect(advanceInstallmentForMonth(A, 60000, 50000, "2026-10")).toBe(0);
  });
});

describe("advanceRemainingAfterMonth", () => {
  test("lump sum: fully owed before its month, nothing owed after", () => {
    expect(advanceRemainingAfterMonth(A, null, 50000, "2026-08")).toBe(50000);
    expect(advanceRemainingAfterMonth(A, null, 50000, "2026-09")).toBe(0);
    expect(advanceRemainingAfterMonth(A, null, 50000, "2026-10")).toBe(0);
  });

  test("fixed monthly RM150 on RM500: balance falls 350, 200, 50, 0", () => {
    const by = ["2026-09", "2026-10", "2026-11", "2026-12"].map((m) => advanceRemainingAfterMonth(A, 15000, 50000, m));
    expect(by).toEqual([35000, 20000, 5000, 0]);
  });

  test("this month's deduction plus the remaining-after equals the balance coming in", () => {
    // Coming into November the balance is 50000 - 2*15000 = 20000; 15000 comes
    // off, 5000 is left — the two parts reconstruct the opening balance.
    const thisMonth = advanceInstallmentForMonth(A, 15000, 50000, "2026-11");
    const after = advanceRemainingAfterMonth(A, 15000, 50000, "2026-11");
    expect(thisMonth + after).toBe(20000);
  });
});
