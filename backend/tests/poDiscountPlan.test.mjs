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

import { currencyVerdict, planDocument, readBookDiscounts, repairPopulation } from "../scripts/lib/po-discount-plan.mjs";

/** Every document is MYR at rate 1 unless a case says otherwise — the shape the
 *  book has on 9,390 of its 9,412 purchase orders. */
const hdrs = (over = {}) => {
  const m = new Map();
  for (const [d, h] of Object.entries({ "PO-1": {}, "PO-IN": {}, "PO-OUT": {}, ...over })) {
    m.set(d, { docNo: d, currency: "MYR", rate: 1, ...h });
  }
  return m;
};

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
    const r = readBookDiscounts(lines, new Set(["PO-1"]), hdrs());
    expect(r.byDoc.size).toBe(0);
    expect(r.skipped).toHaveLength(3);
    expect(r.whole.lines).toBe(0);
  });

  it("counts a real discount and ignores a line that already agrees", () => {
    const lines = new Map([["PO-1", [
      { dtlKey: 1, itemKey: "X", qty: 1, unitPriceSen: 188000, subTotalSen: 141000 },
      { dtlKey: 2, itemKey: "Y", qty: 2, unitPriceSen: 50000, subTotalSen: 100000 },
    ]]]);
    const r = readBookDiscounts(lines, new Set(["PO-1"]), hdrs());
    expect(r.whole).toMatchObject({ lines: 1, sen: 47000 });
    expect(r.inScope).toMatchObject({ docs: 1, lines: 1, sen: 47000 });
    expect([...r.byDoc.get("PO-1").keys()]).toEqual(["1"]);
  });

  it("separates the whole book from the migrated scope", () => {
    const lines = new Map([
      ["PO-IN", [{ dtlKey: 1, itemKey: "X", qty: 1, unitPriceSen: 188000, subTotalSen: 141000 }]],
      ["PO-OUT", [{ dtlKey: 2, itemKey: "Y", qty: 1, unitPriceSen: 100000, subTotalSen: 75000 }]],
    ]);
    const r = readBookDiscounts(lines, new Set(["PO-IN"]), hdrs());
    expect(r.whole).toMatchObject({ lines: 2, sen: 47000 + 25000 });
    expect(r.inScope).toMatchObject({ docs: 1, lines: 1, sen: 47000 });
    expect(r.skipped).toEqual([]);
  });
});

// ── the currency gate ────────────────────────────────────────────────────────
// Added 2026-09-07, after this repair took RM 13,068.55 off HC-PO-009335 on a
// false premise. That document is denominated in CHINESE YUAN at 0.619380; the
// snapshot carried the MYR figures and the ERP holds the CNY ones, so the gap
// between them looked like a 38.06% line discount and was written as one. The
// book states DiscountAmt = 0.00 on every line of it.
// 34,334.90 x 0.61938 = 21,266.35 — the discount WAS the rate.
// Ledger: docs/bugs/0665-*.md.
describe("currency: a rate is not a discount, and the difference is unknowable from a total", () => {
  const cnyLine = [{ dtlKey: 851335, itemKey: "JM-CL JAC WP MP (K)", qty: 240, unitPriceSen: 6854, subTotalSen: 1018855 }];

  it("REFUSES an in-scope document that is not the local currency, and plans nothing for it", () => {
    const r = readBookDiscounts(
      new Map([["PO-009335", cnyLine]]),
      new Set(["PO-009335"]),
      hdrs({ "PO-009335": { currency: "CNY", rate: 0.61938 } }),
    );
    expect(r.byDoc.size).toBe(0);
    expect(r.inScope).toMatchObject({ docs: 0, lines: 0, sen: 0 });
    expect(r.currencyRefused).toHaveLength(1);
    expect(r.currencyRefused[0]).toMatchObject({ docNo: "PO-009335", kind: "foreign" });
    expect(r.currencyRefused[0].why).toContain("CNY");
    // The whole-book description still counts it. Hiding a refused document
    // from the totals would make the refusal invisible in the very number a
    // reader uses to sanity-check the run.
    expect(r.whole).toMatchObject({ lines: 1 });
  });

  it("REFUSES the local currency at a rate that is not 1", () => {
    const r = readBookDiscounts(
      new Map([["PO-009335", cnyLine]]),
      new Set(["PO-009335"]),
      hdrs({ "PO-009335": { currency: "MYR", rate: 0.61938 } }),
    );
    expect(r.byDoc.size).toBe(0);
    expect(r.currencyRefused[0]).toMatchObject({ kind: "foreign" });
  });

  it("REFUSES a snapshot that carries no currency — an absent column is not 'MYR'", () => {
    // A cut made before the exporter carried CurrencyCode decodes these as null.
    // Reading that as the local currency is the original defect, restated.
    const r = readBookDiscounts(
      new Map([["PO-009335", cnyLine]]),
      new Set(["PO-009335"]),
      new Map([["PO-009335", { docNo: "PO-009335", currency: null, rate: null }]]),
    );
    expect(r.byDoc.size).toBe(0);
    expect(r.currencyRefused[0]).toMatchObject({ kind: "unknown" });
  });

  it("lets an MYR document at rate 1 through untouched", () => {
    const r = readBookDiscounts(
      new Map([["PO-1", [{ dtlKey: 1, itemKey: "X", qty: 1, unitPriceSen: 188000, subTotalSen: 141000 }]]]),
      new Set(["PO-1"]),
      hdrs(),
    );
    expect(r.currencyRefused).toEqual([]);
    expect(r.inScope).toMatchObject({ docs: 1, lines: 1, sen: 47000 });
  });

  it("does not gate a document the migration never carried", () => {
    // Out of scope is out of scope: a foreign PO nobody imported is not a
    // refusal to report, it is simply not this script's business.
    const r = readBookDiscounts(
      new Map([["PO-OUT", cnyLine]]),
      new Set(["PO-IN"]),
      hdrs({ "PO-OUT": { currency: "CNY", rate: 0.61938 } }),
    );
    expect(r.currencyRefused).toEqual([]);
    expect(r.byDoc.size).toBe(0);
  });

  it("REFUSES to run at all when the headers are not passed", () => {
    // Required, not optional: a caller must not be able to reach the discount
    // rule without the currency beside it.
    expect(() => readBookDiscounts(new Map(), new Set(), undefined)).toThrow(/currency/i);
  });

  it("currencyVerdict names the three answers", () => {
    expect(currencyVerdict({ currency: "MYR", rate: 1 }).kind).toBe("local");
    expect(currencyVerdict({ currency: "myr", rate: 1.0000000001 }).kind).toBe("local");
    expect(currencyVerdict({ currency: "CNY", rate: 0.61938 }).kind).toBe("foreign");
    expect(currencyVerdict({ currency: "", rate: null }).kind).toBe("unknown");
    expect(currencyVerdict(undefined).kind).toBe("unknown");
  });
});

// ── the population ───────────────────────────────────────────────────────────
// Added 2026-09-08, after the reconcile found PO-009770 — RM 18,525.00 in the
// ERP against the book's RM 13,893.75, all 15 lines discounted at 75% — sixteen
// hours after an APPLY run that reported "89 of 89 written" and was, for its own
// population, complete. The scope is the OUTSTANDING purchase orders; PO-009770
// stopped being outstanding when its goods arrived, and our wrong copy of it did
// not move. docs/bugs/0693-*.md.
describe("the population a repair walks is what the ERP HOLDS", () => {
  it("plans a document the ERP holds even though the outstanding scope no longer names it", () => {
    const lines = new Map([
      ["PO-IN", [{ dtlKey: 1, itemKey: "X", qty: 1, unitPriceSen: 188000, subTotalSen: 141000 }]],
      // held by the ERP, dropped out of scope since it was imported
      ["PO-OUT", [{ dtlKey: 2, itemKey: "Y", qty: 1, unitPriceSen: 100000, subTotalSen: 75000 }]],
    ]);
    const scopeOnly = readBookDiscounts(lines, new Set(["PO-IN"]), hdrs());
    expect(scopeOnly.byDoc.has("PO-OUT")).toBe(false);

    const { population, counts } = repairPopulation(new Set(["PO-IN"]), ["PO-IN", "PO-OUT"]);
    expect(counts).toMatchObject({ inScope: 1, erpHeld: 2, heldButOutOfScope: 1, inScopeButNotHeld: 0 });
    const r = readBookDiscounts(lines, population, hdrs());
    expect(r.byDoc.has("PO-OUT")).toBe(true);
    expect(r.inScope).toMatchObject({ docs: 2, lines: 2, sen: 47000 + 25000 });
  });

  it("keeps an in-scope document the ERP does NOT hold, so its absence stays reportable", () => {
    // Dropping it would silently delete the "in scope but absent from the ERP"
    // report, which is the only thing that says a document never arrived.
    const { population, counts } = repairPopulation(new Set(["PO-IN", "PO-MISSING"]), ["PO-IN"]);
    expect(population.has("PO-MISSING")).toBe(true);
    expect(counts).toMatchObject({ inScope: 2, erpHeld: 1, heldButOutOfScope: 0, inScopeButNotHeld: 1 });
  });

  it("trims and ignores blanks in what the database hands back", () => {
    const { population } = repairPopulation(new Set(), [" PO-A ", "", null, "PO-A"]);
    expect([...population]).toEqual(["PO-A"]);
  });
});
