import { describe, expect, it } from "vitest";
import { correctionChanges, displayValue, localPhone } from "./scan-correction-detail";

describe("displayValue", () => {
  it("renders phones in local form, matches by value or code, deposit as money, empty as (blank)", () => {
    expect(localPhone("+60123456789")).toBe("0123456789");
    expect(displayValue("phones", ["+60123456789", "012-345 6789"])).toBe("0123456789, 0123456789");
    expect(displayValue("phones", [])).toBe("(blank)");
    expect(displayValue("bankMatch", { value: "Maybank", confidence: 1, reason: "x" })).toBe("Maybank");
    expect(displayValue("skuMatch", { code: "BF-100" })).toBe("BF-100");
    expect(displayValue("specialsMatch", [{ code: "S1" }, { code: "S2" }])).toBe("S1, S2");
    expect(displayValue("depositRm", 1500)).toBe("RM 1,500.00");
    expect(displayValue("depositRm", null)).toBe("(blank)");
    expect(displayValue("city", "  ")).toBe("(blank)");
  });
});

describe("correctionChanges", () => {
  const line = (raw: string, sku: string, qty: number) => ({ rawText: raw, skuMatch: { code: sku }, qtyGuess: qty });
  it("lists header and paired line changes, line numbered; null without a baseline", () => {
    const extracted = { city: "Klang", depositRm: 500, lines: [line("a", "A1", 1), line("b", "B1", 1)] };
    const baseline = { ...extracted, city: "Kelang" };
    const corrected = { city: "Shah Alam", depositRm: 1500, lines: [line("a", "A1", 1), line("b", "B2", 3)] };
    expect(correctionChanges(extracted, corrected, baseline)).toEqual([
      { field: "City", before: "Kelang", after: "Shah Alam" },
      { field: "Deposit", before: "RM 500.00", after: "RM 1,500.00" },
      { field: "Line 2 Product code", before: "B1", after: "B2" },
      { field: "Line 2 Qty", before: "1", after: "3" },
    ]);
    expect(correctionChanges(extracted, corrected, null)).toBeNull();
  });

  it("names each removed and added line when the line count changed", () => {
    const extracted = {
      lines: [line("matt q", "MATT-Q", 1), line("matt s", "MATT-S", 2), line("protector", "PROT-S", 2)],
    };
    const operatorLine = { rawText: "", skuMatch: { code: "PROT-SS" }, qtyGuess: 1 };
    const corrected = { lines: [line("matt q", "MATT-Q", 1), operatorLine] };
    expect(correctionChanges(extracted, corrected, extracted)).toEqual([
      { field: "Line removed", before: "MATT-S, qty 2", after: "(none)" },
      { field: "Line removed", before: "PROT-S, qty 2", after: "(none)" },
      { field: "Line added", before: "(none)", after: "PROT-SS, qty 1" },
    ]);
  });
});
