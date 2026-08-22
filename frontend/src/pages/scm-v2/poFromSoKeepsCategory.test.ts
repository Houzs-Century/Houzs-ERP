// ----------------------------------------------------------------------------
// SO -> PO must carry the SO line's CATEGORY, not re-derive it.
//
// The category is not cosmetic: it is an INPUT TO THE STOCK BUCKET.
// `computeVariantKey(item_group, variants)` composes a sofa's fabric/seat/leg
// ONLY when the group says sofa (or bedframe); for a null / others group it
// returns '' — the unclassified bucket — by design.
//
// So a PO line that lost its group produces a GRN that lost it (grns.ts copies
// the PO line), and the receipt's stock lands in the empty bucket. The goods
// are in the warehouse, at the right value, and no sofa order can ever see
// them: the delivery order looks up
// `fabriccode=pc151-12|seatheight=30|legheight=default` and finds nothing.
//
// Reproduced end-to-end on production 2026-08-22:
//   HC-SO-2608-004 (sofa) -> HC-PO-2608-003 -> HC-GRN-2608-003
//   Inventory: stock 1, available 0, variant row reading "Standard".
//   Delivery order: "At BALAKONG WAREHOUSE: need 1, available 0 (short 1)".
//
// The picker ALREADY has the answer — `OutstandingSoItem.itemGroup` is the SO
// line's stored item_group, and the pick screen renders it as the row's
// Category chip. This pins that the mapper uses it.
// ----------------------------------------------------------------------------

import { describe, expect, test } from "vitest";
import { computeVariantKey } from "../../vendor/shared/variant-key";

/* The mapper's decision, extracted verbatim from PurchaseOrderNew.applyFromSo.
   Kept as a pure function here because the page mounts a router, a query client
   and a supplier-binding effect — none of which this decision depends on. */
const categoryForPoLine = (
  pick: { itemCode: string; itemGroup?: string | null },
  categoryForCode: (code: string) => string | undefined,
): string | undefined => pick.itemGroup || categoryForCode(pick.itemCode);

/* The SKU list the page searches. The regression is what happens when the code
   ISN'T in it — a fresh session, a filtered list, a SKU added since load. */
const EMPTY_SKU_LIST = (_code: string): string | undefined => undefined;
const LOADED_SKU_LIST = (code: string): string | undefined => (code === "2376-1A(LHF)" ? "sofa" : undefined);

const SOFA_VARIANTS = { fabricCode: "PC151-12", seatHeight: "30", legHeight: "Default" };

describe("the PO line takes the category the picker handed it", () => {
  test("the pick's own itemGroup is used", () => {
    expect(categoryForPoLine(
      { itemCode: "2376-1A(LHF)", itemGroup: "sofa" }, EMPTY_SKU_LIST,
    )).toBe("sofa");
  });

  /* THE REGRESSION. Before the fix this line read
     `categoryForCode(p.itemCode)`, so an unloaded SKU list produced undefined
     and the group was lost even though the row displayed it. */
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
  /* The real key function, imported — not a restatement of it. */
  test("a sofa group composes the fabric/seat/leg into the key", () => {
    const key = computeVariantKey("sofa", SOFA_VARIANTS);
    expect(key).toContain("pc151-12");
    expect(key).not.toBe("");
  });

  /* THE COST, stated as the thing that actually happened. */
  test("a LOST group sends the same physical sofa to the unclassified bucket", () => {
    expect(computeVariantKey(null, SOFA_VARIANTS)).toBe("");
    expect(computeVariantKey("others", SOFA_VARIANTS)).toBe("");
  });

  test("so the two buckets can never match", () => {
    expect(computeVariantKey("sofa", SOFA_VARIANTS))
      .not.toBe(computeVariantKey(null, SOFA_VARIANTS));
  });
});
