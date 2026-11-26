
import { describe, expect, test } from "vitest";
import { computeVariantKey } from "../../vendor/shared/variant-key";

const categoryForPoLine = (
  pick: { itemCode: string; itemGroup?: string | null },
  categoryForCode: (code: string) => string | undefined,
): string | undefined => pick.itemGroup || categoryForCode(pick.itemCode);

const EMPTY_SKU_LIST = (_code: string): string | undefined => undefined;
const LOADED_SKU_LIST = (code: string): string | undefined => (code === "2376-1A(LHF)" ? "sofa" : undefined);

const SOFA_VARIANTS = { fabricCode: "PC151-12", seatHeight: "30", legHeight: "Default" };

describe("the PO line takes the category the picker handed it", () => {
  test("the pick's own itemGroup is used", () => {
    expect(categoryForPoLine(
      { itemCode: "2376-1A(LHF)", itemGroup: "sofa" }, EMPTY_SKU_LIST,
    )).toBe("sofa");
  });

  test("an unloaded SKU list does NOT lose the category", () => {
    const derivedOnly = EMPTY_SKU_LIST("2376-1A(LHF)");
    expect(derivedOnly).toBeUndefined();

    expect(categoryForPoLine(
      { itemCode: "2376-1A(LHF)", itemGroup: "sofa" }, EMPTY_SKU_LIST,
    )).toBe("sofa");
  });

  test("the SKU list is still the fallback when the pick carries nothing", () => {
    expect(categoryForPoLine(
      { itemCode: "2376-1A(LHF)", itemGroup: null }, LOADED_SKU_LIST,
    )).toBe("sofa");
    expect(categoryForPoLine(
      { itemCode: "2376-1A(LHF)", itemGroup: "" }, LOADED_SKU_LIST,
    )).toBe("sofa");
  });

  test("both empty stays undefined rather than inventing a group", () => {
    expect(categoryForPoLine(
      { itemCode: "NOPE", itemGroup: null }, EMPTY_SKU_LIST,
    )).toBeUndefined();
  });
});

describe("why the category decides where the stock lands", () => {
  test("a sofa group composes the fabric/seat/leg into the key", () => {
    const key = computeVariantKey("sofa", SOFA_VARIANTS);
    expect(key).toContain("pc151-12");
    expect(key).not.toBe("");
  });

  test("a LOST group sends the same physical sofa to the unclassified bucket", () => {
    expect(computeVariantKey(null, SOFA_VARIANTS)).toBe("");
    expect(computeVariantKey("others", SOFA_VARIANTS)).toBe("");
  });

  test("so the two buckets can never match", () => {
    expect(computeVariantKey("sofa", SOFA_VARIANTS))
      .not.toBe(computeVariantKey(null, SOFA_VARIANTS));
  });
});
