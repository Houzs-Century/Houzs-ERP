import { describe, expect, it } from "vitest";
import { installmentFromInputs } from "./AdvancesPage";

describe("installmentFromInputs", () => {
  it("lump sum is null regardless of the amount", () => {
    expect(installmentFromInputs("lump", 60000, "", "")).toBeNull();
  });

  it("split into N months is ceil(amount / N)", () => {
    expect(installmentFromInputs("split", 50000, "5", "")).toBe(10000);
    expect(installmentFromInputs("split", 50000, "3", "")).toBe(16667);
    expect(installmentFromInputs("split", 100000, "1", "")).toBe(100000);
  });

  it("split rejects a non-positive or non-integer month count", () => {
    expect(installmentFromInputs("split", 50000, "0", "")).toBe("Enter how many months (1 or more).");
    expect(installmentFromInputs("split", 50000, "", "")).toBe("Enter how many months (1 or more).");
    expect(installmentFromInputs("split", 50000, "2.5", "")).toBe("Enter how many months (1 or more).");
  });

  it("fixed monthly converts RM to sen", () => {
    expect(installmentFromInputs("fixed", 100000, "", "200")).toBe(20000);
    expect(installmentFromInputs("fixed", 100000, "", "150.50")).toBe(15050);
  });

  it("fixed rejects an empty, zero, or over-the-advance amount", () => {
    expect(installmentFromInputs("fixed", 100000, "", "")).toBe("Enter the monthly repayment.");
    expect(installmentFromInputs("fixed", 100000, "", "0")).toBe("Enter the monthly repayment.");
    expect(installmentFromInputs("fixed", 50000, "", "600")).toBe("The monthly repayment can't be more than the advance.");
  });
});
