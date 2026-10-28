import { describe, expect, it } from "vitest";
import { legNumber, planSupplierLegFill, spellLeg } from "../scripts/lib/supplier-sofa-leg-plan.mjs";
import { pieceSuffix } from "../scripts/lib/parse-sofa.mjs";

/* The real shape, taken from production 2026-09-11: a purchase line with a
   linked sales line, nothing received, and a supplier who states the leg. */
const pair = (over = {}) => ({
  poItemId: "po-item-1",
  soItemId: "so-item-1",
  soDocNo: "HC-SO-013258",
  itemCode: "9058-1A(LHF)",
  supplierLeg: 1,
  poLeg: null,
  soLeg: null,
  receivedQty: 0,
  grnLines: 0,
  doLines: 0,
  soReadyQty: 0,
  soAllocatedBatch: null,
  ...over,
});
const doc = (pairs) => [{ poNumber: "HC-PO-010160", supplierDoc: "SO-2609-092", ourPoRef: "PO-010160", pairs }];

describe("spelling", () => {
  it("writes the height the way every other row on production spells it", () => {
    /* `6"` 347 rows, `2"` 118, `1"` 38, and the bare number nowhere — measured
       2026-09-11 across purchase, sales and goods-received sofa lines. A bare
       `6` would open a second spelling of one height, and a second stock bucket
       with it. */
    expect(spellLeg(6)).toBe('6"');
    expect(spellLeg("1")).toBe('1"');
  });

  it("reads a height as a number, so 1 and 1\" are one inch", () => {
    expect(legNumber("1\"")).toBe(1);
    expect(legNumber(1)).toBe(1);
    expect(legNumber("Default")).toBeNull();
    expect(legNumber(null)).toBeNull();
  });
});

describe("planSupplierLegFill", () => {
  it("fills a blank leg on both the purchase and the sales line", () => {
    const { writes, holds } = planSupplierLegFill(doc([pair()]));
    expect(holds).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      poNumber: "HC-PO-010160", itemCode: "9058-1A(LHF)", legHeight: '1"',
      poItemId: "po-item-1", soItemId: "so-item-1", soDocNo: "HC-SO-013258",
    });
  });

  it("says nothing where the supplier states no leg", () => {
    const { writes, holds, agreed } = planSupplierLegFill(doc([pair({ supplierLeg: null })]));
    expect([writes.length, holds.length, agreed]).toEqual([0, 0, 0]);
  });

  it("counts a line that already carries the height as agreed, and writes nothing", () => {
    const { writes, agreed } = planSupplierLegFill(doc([pair({ poLeg: '1"', soLeg: '1"' })]));
    expect(writes).toEqual([]);
    expect(agreed).toBe(1);
  });

  it("fills only the side that is blank", () => {
    const { writes } = planSupplierLegFill(doc([pair({ poLeg: '1"' })]));
    expect(writes[0].poItemId).toBeNull();
    expect(writes[0].soItemId).toBe("so-item-1");
  });

  it("supersedes the Default placeholder, because it is not a pick", () => {
    /* `backfill-sofa-leg-default` wrote "Default" so the field would not read
       "Select…"; it is the same word that stranded the docs/bugs/0722 lines. */
    const { writes, holds } = planSupplierLegFill(doc([pair({ poLeg: "Default", soLeg: "Default" })]));
    expect(holds).toEqual([]);
    expect(writes[0].legHeight).toBe('1"');
  });

  it("HOLDS a height somebody actually picked, rather than overwriting it", () => {
    const { writes, holds } = planSupplierLegFill(doc([pair({ poLeg: '6"' })]));
    expect(writes).toEqual([]);
    expect(holds[0].why).toMatch(/the purchase line states 6"/);
  });

  /* THE 0722 GATE. Each of these pins the line where it is, because a lot,
     movement or allocation already exists under the blank-leg identity. */
  const moved = [
    ["goods received against the purchase line", { receivedQty: 2 }, /2 already received/],
    ["a goods-received line", { grnLines: 1 }, /1 goods-received line/],
    ["a delivery line off the sales line", { doLines: 1 }, /1 delivery line/],
    ["stock allocated to the sales line", { soReadyQty: 1 }, /1 piece\(s\) of stock already allocated/],
    ["a batch allocated to the sales line", { soAllocatedBatch: "B-2609-01" }, /stock batch B-2609-01 allocated/],
  ];
  for (const [what, over, why] of moved) {
    it(`HOLDS when there is ${what}`, () => {
      const { writes, holds } = planSupplierLegFill(doc([pair(over)]));
      expect(writes).toEqual([]);
      expect(holds).toHaveLength(1);
      expect(holds[0].why).toMatch(why);
      expect(holds[0].why).toMatch(/docs\/bugs\/0722/);
    });
  }

  it("writes the ones it can and holds the ones it cannot, on one document", () => {
    const { writes, holds } = planSupplierLegFill(doc([
      pair(),
      pair({ poItemId: "po-item-2", soItemId: "so-item-2", itemCode: "9058-1NA", receivedQty: 1 }),
    ]));
    expect(writes.map((w) => w.itemCode)).toEqual(["9058-1A(LHF)"]);
    expect(holds.map((h) => h.itemCode)).toEqual(["9058-1NA"]);
  });

  it("fills a purchase line with no sales line behind it", () => {
    const { writes } = planSupplierLegFill(doc([pair({ soItemId: null, soDocNo: null, soLeg: null })]));
    expect(writes[0].poItemId).toBe("po-item-1");
    expect(writes[0].soItemId).toBeNull();
  });
});

describe("pieceSuffix", () => {
  it("folds the supplier's CSL onto our CONSOLE", () => {
    /* Owner 2026-09-11: 「CSL 就是 console」. Without the fold, HC-PO-009986 and
       HC-PO-010145 read as DIFFERENT PIECES — the "costs money" bucket — on two
       sofas that agree, which is what run 34563471672 reported AFTER the
       corrections had landed. */
    expect(pieceSuffix("5540-CSL")).toBe("CONSOLE");
    expect(pieceSuffix("8030-CONSOLE")).toBe("CONSOLE");
  });

  it("leaves every other piece alone, hand included", () => {
    expect(pieceSuffix("9058-1A(LHF)")).toBe("1A(LHF)");
    expect(pieceSuffix("5535-L(RHF)")).toBe("L(RHF)");
    expect(pieceSuffix("STOOL")).toBe("STOOL");
  });
});
