// The SALES-ORDER line-discount repair, decided on planted data.
//
// This is the money case, and it writes on live customer orders. Every
// interesting thing the planner does is a REFUSAL — a decomposed sofa group, a
// quantity the ERP already disagrees about, goods that have already left the
// warehouse, a book amount larger than qty x unit price. None of those can be
// exercised against production without first creating the damage there, so each
// is planted here and the planner is required to catch it. Same bar, same
// reasons, as tests/poDiscountPlan.test.mjs.
import { describe, expect, it } from "vitest";

import { currencyVerdict } from "../scripts/lib/ac-scope.mjs";
import { planSoDocument, readBookSoDiscounts } from "../scripts/lib/so-discount-plan.mjs";

const hdrs = (over = {}) => {
  const m = new Map();
  for (const [d, h] of Object.entries({ "SO-1": {}, "SO-IN": {}, "SO-OUT": {}, ...over })) {
    m.set(d, { docNo: d, currency: "MYR", rate: 1, ...h });
  }
  return m;
};

/** HC-SO-000021's real first line, from the book: 1 x RM 9,298.00 amounting to RM 9,099.00. */
const want = (over = {}) => new Map([
  ["13555", { dtlKey: "13555", item: "DL-D.ULTIMATE SANTUARY (K)", qty: 1, unitSen: 929800, bookSen: 909900, undiscSen: 929800, ...over }],
]);
const doc = (over = {}) => ({
  acNo: "SO-000021", docNo: "HC-SO-000021", hdrTotal: 929800,
  lines: [{ itemId: "i1", dtlKey: "13555", itemCode: "DUNLOPILLO DS ULTIMATE SANCTUARY MATT MATT (K)", qty: 1, unitSen: 929800, discountSen: 0, totalSen: 929800, deliveredQty: 0 }],
  ...over,
});

describe("HC-SO-000021, the order this was written for", () => {
  it("writes the discount, the line amount and the header together", () => {
    const p = planSoDocument({ wantByKey: want(), doc: doc() });
    expect(p.refusals).toEqual([]);
    expect(p.writes).toHaveLength(1);
    expect(p.writes[0]).toMatchObject({ discountSen: 19900, lineTotalSen: 909900, wasLineTotal: 929800 });
    // The header must move with the line: a line amount written alone is
    // recomputed away by the next UI edit (mfg-sales-orders.ts:4251).
    expect(p.header).toMatchObject({ docNo: "HC-SO-000021", totalSen: 909900, wasTotal: 929800 });
  });

  it("plans NOTHING on a second run", () => {
    const already = doc({ lines: [{ itemId: "i1", dtlKey: "13555", itemCode: "X", qty: 1, unitSen: 929800, discountSen: 19900, totalSen: 909900, deliveredQty: 0 }], hdrTotal: 909900 });
    const p = planSoDocument({ wantByKey: want(), doc: already });
    expect(p.writes).toEqual([]);
    expect(p.header).toBe(null);
  });
});

describe("the refusals", () => {
  it("REFUSES a decomposed sofa group rather than subtracting the discount once per compartment", () => {
    const p = planSoDocument({
      wantByKey: want({ item: "DSL-8050 SOFA" }),
      doc: doc({ lines: [
        { itemId: "a", dtlKey: "13555", itemCode: "8050-1A(R)(LHF)", qty: 1, unitSen: 929800, discountSen: 0, totalSen: 929800, deliveredQty: 0 },
        { itemId: "b", dtlKey: "13555", itemCode: "8050-1A(R)(RHF)", qty: 1, unitSen: 929800, discountSen: 0, totalSen: 929800, deliveredQty: 0 },
      ] }),
    });
    expect(p.writes).toEqual([]);
    expect(p.refusals[0]).toMatch(/2 ERP line\(s\) share this AutoCount key and 2 of them carry a price/);
  });

  it("REFUSES when the ERP's own qty x unit price is not the book's, so a price gap cannot hide inside a discount", () => {
    const p = planSoDocument({
      wantByKey: want(),
      doc: doc({ lines: [{ itemId: "i1", dtlKey: "13555", itemCode: "X", qty: 2, unitSen: 929800, discountSen: 0, totalSen: 1859600, deliveredQty: 0 }] }),
    });
    expect(p.writes).toEqual([]);
    expect(p.refusals[0]).toMatch(/quantity or price difference, NOT a discount/);
  });

  it("REFUSES a book amount ABOVE qty x unit price — that is a surcharge", () => {
    const p = planSoDocument({ wantByKey: want({ bookSen: 999900 }), doc: doc() });
    expect(p.writes).toEqual([]);
    expect(p.refusals[0]).toMatch(/surcharge, not a discount/);
  });

  it("REFUSES a line whose goods have already been delivered", () => {
    const p = planSoDocument({
      wantByKey: want(),
      doc: doc({ lines: [{ itemId: "i1", dtlKey: "13555", itemCode: "X", qty: 1, unitSen: 929800, discountSen: 0, totalSen: 929800, deliveredQty: 1 }] }),
    });
    expect(p.writes).toEqual([]);
    expect(p.refusals[0]).toMatch(/already been delivered/);
  });

  it("REFUSES a book line the ERP has no row for, instead of inventing one", () => {
    const p = planSoDocument({ wantByKey: want({ dtlKey: "99999" }), doc: doc() });
    // wantByKey is keyed by the map key, so re-key it the way the reader does.
    const p2 = planSoDocument({ wantByKey: new Map([["99999", { dtlKey: "99999", item: "Z", qty: 1, unitSen: 100, bookSen: 50, undiscSen: 100 }]]), doc: doc() });
    expect(p.writes).toHaveLength(1); // the map key still says 13555
    expect(p2.writes).toEqual([]);
    expect(p2.refusals[0]).toMatch(/the ERP has no line carrying that AutoCount key/);
  });
});

describe("reading the book", () => {
  it("counts the three real HC-SO-000021 lines and their RM 976.00", () => {
    const lines = new Map([["SO-1", [
      { dtlKey: 13555, itemKey: "DL-D.ULTIMATE SANTUARY (K)", qty: 1, unitPriceSen: 929800, subTotalSen: 909900 },
      { dtlKey: 13556, itemKey: "DL-ECO COMFORT LATEX PILLOW", qty: 2, unitPriceSen: 59800, subTotalSen: 59800 },
      { dtlKey: 13557, itemKey: "DL-MP(K)", qty: 1, unitPriceSen: 35800, subTotalSen: 17900 },
    ]]]);
    const r = readBookSoDiscounts(lines, new Set(["SO-1"]), hdrs(), currencyVerdict);
    expect(r.inPopulation).toMatchObject({ docs: 1, lines: 3, sen: 19900 + 59800 + 17900 });
    expect(r.inPopulation.sen).toBe(97600); // RM 976.00, the reconcile's own difference
  });

  it("SKIPS a book line missing its amount instead of reading it as RM 0.00", () => {
    const lines = new Map([["SO-1", [
      { dtlKey: 1, itemKey: "X", qty: 1, unitPriceSen: 100000, subTotalSen: null },
      { dtlKey: 2, itemKey: "Y", qty: 1, unitPriceSen: null, subTotalSen: 75000 },
      { dtlKey: 3, itemKey: "Z", qty: null, unitPriceSen: 100000, subTotalSen: 75000 },
    ]]]);
    const r = readBookSoDiscounts(lines, new Set(["SO-1"]), hdrs(), currencyVerdict);
    expect(r.byDoc.size).toBe(0);
    expect(r.skipped).toHaveLength(3);
    expect(r.whole.lines).toBe(0);
  });

  it("separates the whole book from the population", () => {
    const lines = new Map([
      ["SO-IN", [{ dtlKey: 1, itemKey: "X", qty: 1, unitPriceSen: 188000, subTotalSen: 141000 }]],
      ["SO-OUT", [{ dtlKey: 2, itemKey: "Y", qty: 1, unitPriceSen: 100000, subTotalSen: 75000 }]],
    ]);
    const r = readBookSoDiscounts(lines, new Set(["SO-IN"]), hdrs(), currencyVerdict);
    expect(r.whole).toMatchObject({ lines: 2, sen: 47000 + 25000 });
    expect(r.inPopulation).toMatchObject({ docs: 1, lines: 1, sen: 47000 });
  });

  it("REFUSES a non-MYR document rather than reading an exchange rate as a discount", () => {
    // docs/bugs/0665: RM 13,068.55 came off a live CNY purchase order this way.
    const lines = new Map([["SO-1", [{ dtlKey: 1, itemKey: "X", qty: 1, unitPriceSen: 188000, subTotalSen: 141000 }]]]);
    const r = readBookSoDiscounts(lines, new Set(["SO-1"]), hdrs({ "SO-1": { currency: "CNY", rate: 0.61938 } }), currencyVerdict);
    expect(r.byDoc.size).toBe(0);
    expect(r.currencyRefused).toHaveLength(1);
    expect(r.whole.lines).toBe(1); // still described, never hidden from the book total
  });

  it("needs the headers, and says why", () => {
    expect(() => readBookSoDiscounts(new Map(), new Set(), null, currencyVerdict)).toThrow(/currency/);
  });
});
