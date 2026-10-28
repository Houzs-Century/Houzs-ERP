// The own-barcode rule for Houzs POS labels: 200 + running number + check
// digit, validated, and the bar pattern a label prints.
import { describe, expect, test } from "vitest";
import { ean13CheckDigit, ean13Modules, ean13Svg, internalEan13, isInternalEan13, isValidEan13 } from "./ean13";

describe("ean13", () => {
  test("check digit matches GS1's worked examples", () => {
    expect(ean13CheckDigit("400638133393")).toBe(1);
    expect(ean13CheckDigit("590123412345")).toBe(7);
    expect(isValidEan13("4006381333931")).toBe(true);
    expect(isValidEan13("4006381333932")).toBe(false);
    expect(isValidEan13("40063813339")).toBe(false);
  });

  test("an internal barcode is 200 + nine digits + check, and only those count as internal", () => {
    const c = internalEan13(1);
    /* 2·1 + 1·3 = 5 over the twelve digits, so the check digit is 5. */
    expect(c).toBe("2000000000015");
    expect(isInternalEan13(c)).toBe(true);
    expect(isInternalEan13("4006381333931")).toBe(false);
    expect(internalEan13(123456789)).toMatch(/^200123456789\d$/);
    expect(() => internalEan13(0)).toThrow();
    expect(() => internalEan13(1_000_000_000)).toThrow();
  });

  test("the bar pattern is 95 modules with the three guards in place", () => {
    const m = ean13Modules("4006381333931");
    expect(m).toHaveLength(95);
    expect(m.slice(0, 3)).toBe("101");
    expect(m.slice(45, 50)).toBe("01010");
    expect(m.slice(92)).toBe("101");
    expect(() => ean13Modules("4006381333932")).toThrow();
  });

  test("the svg carries the digits under the bars when asked", () => {
    const svg = ean13Svg("2000000000015", { module: 2, height: 60, showText: true });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain(">000000<");
    expect(svg).toContain(">000015<");
    expect(ean13Svg("2000000000015", { module: 2, height: 60, showText: false })).not.toContain("<text");
  });
});
