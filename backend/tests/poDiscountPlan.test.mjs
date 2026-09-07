// The PO line-discount repair, decided on planted data.
//
// This is the money case. `repair-po-line-discount.mjs` writes `discount_sen`,
// `line_total_sen` and the header totals on LIVE purchase orders, and every
// interesting thing it does is a REFUSAL — a decomposed sofa group, a quantity
// the ERP already disagrees about, a book amount larger than qty x unit price.
// None of those can be exercised against production without first creating the
// damage there, so each is planted here and the planner is required to catch it.
//
// The precedent this bar comes from is in the same family: a repair written to
// undo the jsonb double-encoding COE reproduced that exact bug on 7 production
// rows, and its row count reported 7 of 7.
import { describe, expect, it } from "vitest";

import { planDocument, readBookDiscounts } from "../scripts/lib/po-discount-plan.mjs";

/** PO-009948's real line, from the book: 1 x RM 1,880.00 totalled at RM 1,410.00. */
const want = (over = {}) => new Map([
  ["9001", { dtlKey: "9001", item: "AK-ARMOUR MATT (K)", qty: 1, unitSen: 188000, bookSen: 141000, undiscSen: 188000, ...over }],
]);

const doc = (lines, over = {}) => ({
  acNo: "PO-009948", poId: "po-uuid", poNumber: "HC-PO-2608-001",
  hdrSubtotal: 188000, hdrTotal: 188000, lines, ...over,
});

const line = (over = {}) => ({
  itemId: "item-1", dtlKey: "9001", itemCode: "AK-ARMOUR MATT (K)",
  qty: 1, unitSen: 188000, discountSen: 0, lineTotalSen: 188000, receivedQty: 0, ...over,
});

describe("the worked example, end to end", () => {
  it("writes the discount, the line total AND the header — not one of the three", () => {
    const p = planDocument({ wantByKey: want(), doc: doc([line()]) });
    expect(p.refusals).toEqual([]);
    expect(p.writes).toHaveLength(1);
    expect(p.writes[0]).toMatchObject({
      discountSen: 47000,      // 1,880.00 - 1,410.00, exactly 25%
      lineTotalSen: 141000,    // AutoCount's own amount, copied
      wasDiscount: 0,
      wasLineTotal: 188000,
    });
    // The app's own invariant: line_total = qty*unit - discount.
    expect(p.writes[0].qty * p.writes[0].unitSen - p.writes[0].discountSen).toBe(p.writes[0].lineTotalSen);
    expect(p.header).toMatchObject({ subtotalSen: 141000, totalSen: 141000, wasSubtotal: 188000, wasTotal: 188000 });
  });

  it("never touches the unit price — AutoCount's own UnitPrice IS the undiscounted figure", () => {
    const p = planDocument({ wantByKey: want(), doc: doc([line()]) });
    expect(p.writes[0].unitSen).toBe(188000);
  });

  it("re-sums the header over EVERY line, not only the discounted ones", () => {
    // recomputePoTotals (mfg-purchase-orders.ts:2798) sums all lines. A header
    // built from the discounted ones alone would erase the rest of the order.
    const other = line({ itemId: "item-2", dtlKey: "9002", unitSen: 50000, lineTotalSen: 50000 });
    const p = planDocument({ wantByKey: want(), doc: doc([line(), other], { hdrSubtotal: 238000, hdrTotal: 238000 }) });
    expect(p.plannedSubtotal).toBe(141000 + 50000);
    expect(p.header.totalSen).toBe(191000);
  });

  it("is idempotent — a second run plans nothing", () => {
    const already = line({ discountSen: 47000, lineTotalSen: 141000 });
    const p = planDocument({ wantByKey: want(), doc: doc([already], { hdrSubtotal: 141000, hdrTotal: 141000 }) });
    expect(p.writes).toEqual([]);
    expect(p.header).toBeNull();
    expect(p.refusals).toEqual([]);
  });
});

describe("the refusals — each one planted, each one required to fire", () => {
  it("REFUSES a decomposed group rather than subtracting the discount once per piece", () => {
    // A sofa line becomes one ERP row per compartment, all sharing the AutoCount
    // DtlKey. Two priced rows would take RM 470.00 off twice.
    const p = planDocument({
      wantByKey: want(),
      doc: doc([line({ itemId: "a" }), line({ itemId: "b" })]),
    });
    expect(p.writes).toEqual([]);
    expect(p.refusals).toHaveLength(1);
    expect(p.refusals[0]).toMatch(/2 ERP line\(s\) share this AutoCount key and 2 of them carry a price/);
  });

  it("ACCEPTS a decomposed group whose extra pieces carry no price — only the lead is priced", () => {
    const p = planDocument({
      wantByKey: want(),
      doc: doc([line({ itemId: "lead" }), line({ itemId: "piece2", unitSen: 0, lineTotalSen: 0 })]),
    });
    expect(p.refusals).toEqual([]);
    expect(p.writes.map((w) => w.itemId)).toEqual(["lead"]);
  });

  it("REFUSES a quantity or price the ERP already disagrees about, instead of hiding it in a discount", () => {
    const p = planDocument({ wantByKey: want(), doc: doc([line({ qty: 2, lineTotalSen: 376000 })]) });
    expect(p.writes).toEqual([]);
    expect(p.refusals[0]).toMatch(/quantity or price difference, NOT a discount/);
  });

  it("REFUSES a surcharge — a book amount larger than qty x unit price", () => {
    const p = planDocument({
      wantByKey: want({ bookSen: 200000 }),
      doc: doc([line()]),
    });
    expect(p.writes).toEqual([]);
    expect(p.refusals[0]).toMatch(/surcharge, not a discount/);
  });

  it("REFUSES a book line the ERP has no counterpart for", () => {
    const p = planDocument({ wantByKey: want(), doc: doc([line({ dtlKey: "9999" })]) });
    expect(p.writes).toEqual([]);
    expect(p.refusals[0]).toMatch(/the ERP has no line carrying that AutoCount key/);
  });

  it("a refused line leaves the rest of the document alone", () => {
    const two = new Map([...want(), ["9002", { dtlKey: "9002", item: "AK-BASTION MATT (Q)", qty: 1, unitSen: 100000, bookSen: 75000, undiscSen: 100000 }]]);
    const good = line({ itemId: "ok", dtlKey: "9002", unitSen: 100000, lineTotalSen: 100000 });
    const p = planDocument({ wantByKey: two, doc: doc([line({ itemId: "a" }), line({ itemId: "b" }), good], { hdrSubtotal: 476000, hdrTotal: 476000 }) });
    expect(p.refusals).toHaveLength(1);
    expect(p.writes.map((w) => w.itemId)).toEqual(["ok"]);
    // the two refused rows keep their own (wrong) totals in the header sum
    expect(p.plannedSubtotal).toBe(188000 + 188000 + 75000);
  });
});

describe("the owner's blank rule: 空白不覆盖", () => {
  it("SKIPS a book line missing its amount instead of reading it as RM 0.00", () => {
    // Reading a blank as zero would manufacture a 100% discount out of an
    // absent export column — the mirror of copy-never-compute.
    const lines = new Map([["PO-1", [
      { dtlKey: 1, itemKey: "X", qty: 1, unitPriceSen: 100000, subTotalSen: null },
      { dtlKey: 2, itemKey: "Y", qty: 1, unitPriceSen: null, subTotalSen: 75000 },
      { dtlKey: 3, itemKey: "Z", qty: null, unitPriceSen: 100000, subTotalSen: 75000 },
    ]]]);
    const r = readBookDiscounts(lines, new Set(["PO-1"]));
    expect(r.byDoc.size).toBe(0);
    expect(r.skipped).toHaveLength(3);
    expect(r.whole.lines).toBe(0);
  });

  it("counts a real discount and ignores a line that already agrees", () => {
    const lines = new Map([["PO-1", [
      { dtlKey: 1, itemKey: "X", qty: 1, unitPriceSen: 188000, subTotalSen: 141000 },
      { dtlKey: 2, itemKey: "Y", qty: 2, unitPriceSen: 50000, subTotalSen: 100000 },
    ]]]);
    const r = readBookDiscounts(lines, new Set(["PO-1"]));
    expect(r.whole).toMatchObject({ lines: 1, sen: 47000 });
    expect(r.inScope).toMatchObject({ docs: 1, lines: 1, sen: 47000 });
    expect([...r.byDoc.get("PO-1").keys()]).toEqual(["1"]);
  });

  it("separates the whole book from the migrated scope", () => {
    const lines = new Map([
      ["PO-IN", [{ dtlKey: 1, itemKey: "X", qty: 1, unitPriceSen: 188000, subTotalSen: 141000 }]],
      ["PO-OUT", [{ dtlKey: 2, itemKey: "Y", qty: 1, unitPriceSen: 100000, subTotalSen: 75000 }]],
    ]);
    const r = readBookDiscounts(lines, new Set(["PO-IN"]));
    expect(r.whole).toMatchObject({ lines: 2, sen: 47000 + 25000 });
    expect(r.inScope).toMatchObject({ docs: 1, lines: 1, sen: 47000 });
    expect(r.skipped).toEqual([]);
  });
});
