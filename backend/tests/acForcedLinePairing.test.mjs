// The pairing rule, decided on the shapes that actually appear in the migrated
// goods receipts and delivery orders. Every REFUSAL case here is one the rule
// must keep refusing: a wrong DtlKey makes AcSyncService append a line to the
// live account book instead of editing the one that changed (migration 0273),
// so "no key" is the safe answer and "a key" is the dangerous one.
import { describe, expect, it } from "vitest";

import { comparisonKey, foldErpUnits, pairDocument, planLineKeys } from "../scripts/lib/ac-forced-line-pairing.mjs";

const book = (over = {}) => ({
  dtlKey: 1, code: "BC-CB49", rawCode: "BC-CB49", qty: 1,
  unitPriceSen: 189900, subTotalSen: 189900, location: "HQ", desc2: null, ...over,
});
const erp = (over = {}) => ({ id: "a", code: "BC-CB49", qty: 1, suffixed: false, storedKey: null, ...over });

describe("the comparison key", () => {
  it("folds a book sofa to its MODEL", () => {
    // The book holds one line "DSL-8030 SOFA"; the sheet's ERP counterpart is
    // the "-1S" piece code standing in for the model.
    expect(comparisonKey({ code: "8030-1S", rawCode: "DSL-8030 SOFA", side: "book" }).key).toBe("SOFA 8030");
  });

  it("folds our compartment rows to the same MODEL", () => {
    expect(comparisonKey({ code: "8030-1A(LHF)", side: "erp" }).key).toBe("SOFA 8030");
    expect(comparisonKey({ code: "8030-CNR", side: "erp" }).key).toBe("SOFA 8030");
  });

  it("applies SOFA_MODEL_ALIAS — 5540 and 5537 are both 8030", () => {
    expect(comparisonKey({ code: "5540-1A(LHF)", side: "erp" }).key).toBe("SOFA 8030");
    expect(comparisonKey({ code: "5537-CNR", side: "erp" }).key).toBe("SOFA 8030");
    expect(comparisonKey({ code: "5536-1S", rawCode: "AMN-SF5536 SOFA", side: "book" }).key).toBe("SOFA 9058");
  });

  it("NEVER folds 5535 — it is its own model (the owner, 2026-09-07)", () => {
    // Folding it would turn a real finding into a clean one.
    expect(comparisonKey({ code: "5535-1A(LHF)", side: "erp" }).key).toBe("SOFA 5535");
  });

  it("leaves an accessory whose NAME contains SOFA as a plain code", () => {
    // "AMN-SOFA PILLOW" takes the loose /SOFA/ branch, but yields no model, so
    // it is compared as the accessory it is.
    expect(comparisonKey({ code: "SQUARE PILLOW", rawCode: "AMN-SOFA PILLOW", side: "book" }).key).toBe("SQUARE PILLOW");
  });
});

describe("folding our rows into units", () => {
  it("makes one unit per plain row", () => {
    const u = foldErpUnits([erp({ id: "a" }), erp({ id: "b", code: "BC-CB50" })]);
    expect(u.map((x) => x.key).sort()).toEqual(["BC-CB49", "BC-CB50"]);
    expect(u.every((x) => x.ids.length === 1)).toBe(true);
  });

  it("makes ONE unit from a sofa's compartments, quantity folded by MIN", () => {
    const u = foldErpUnits([
      erp({ id: "a", code: "8030-1A(LHF)", qty: 1 }),
      erp({ id: "b", code: "8030-CNR", qty: 1 }),
      erp({ id: "c", code: "8030-2A(RHF)", qty: 1 }),
    ]);
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ key: "SOFA 8030", qty: 1, ceiling: 1, uneven: false });
    expect(u[0].ids.sort()).toEqual(["a", "b", "c"]);
  });

  it("marks a build UNEVEN when the pieces disagree", () => {
    const u = foldErpUnits([erp({ id: "a", code: "8030-1A(LHF)", qty: 1 }), erp({ id: "b", code: "8030-CNR", qty: 2 })]);
    expect(u[0]).toMatchObject({ uneven: true, qty: 1, ceiling: 2 });
  });
});

describe("a pairing the document FORCES", () => {
  it("stamps a line that is unique on (code, quantity)", () => {
    const r = pairDocument({ bookLines: [book({ dtlKey: 14576 })], erpRows: [erp({ id: "a" })], docNo: "DO-000004" });
    expect(r.stamps).toEqual([{ id: "a", dtlKey: 14576, key: "BC-CB49", forced: "unique" }]);
    expect(r.refusals).toEqual([]);
  });

  it("gives EVERY compartment row of a build the SAME key", () => {
    // composeEdit treats a build whose compartments disagree on the key as
    // having no identity at all.
    const r = pairDocument({
      bookLines: [book({ dtlKey: 892021, code: "8030-1S", rawCode: "DSL-8030 SOFA" })],
      erpRows: [erp({ id: "a", code: "8030-1A(LHF)" }), erp({ id: "b", code: "8030-CNR" })],
      docNo: "GGR-005202|PO-009583",
    });
    expect(r.stamps.map((s) => s.dtlKey)).toEqual([892021, 892021]);
  });

  it("stamps two INTERCHANGEABLE book lines — identical on every column the book states", () => {
    const r = pairDocument({
      bookLines: [book({ dtlKey: 10 }), book({ dtlKey: 11 })],
      erpRows: [erp({ id: "a" }), erp({ id: "b" })],
      docNo: "D",
    });
    expect(r.stamps).toHaveLength(2);
    expect(r.stamps.every((s) => s.forced === "interchangeable")).toBe(true);
    expect(new Set(r.stamps.map((s) => s.dtlKey))).toEqual(new Set([10, 11]));
  });

  it("derives the SAME assignment however the database ordered the rows", () => {
    // A plan that depends on an unordered SELECT is not reproducible — the flaw
    // the retired purchase-order half of backfill-ac-line-keys.mjs had.
    const bookLines = [book({ dtlKey: 11 }), book({ dtlKey: 10 })];
    const forward = [erp({ id: "a" }), erp({ id: "b" })];
    const reversed = [erp({ id: "b" }), erp({ id: "a" })];
    const run = (erpRows) =>
      pairDocument({ bookLines, erpRows, docNo: "D" }).stamps.map((s) => `${s.id}=${s.dtlKey}`).sort();
    expect(run(forward)).toEqual(["a=10", "b=11"]);
    expect(run(reversed)).toEqual(["a=10", "b=11"]);
  });

  it("keys a sofa build the same way however its compartments came back", () => {
    const bookLines = [
      book({ dtlKey: 10, code: "8030-1S", rawCode: "DSL-8030 SOFA" }),
      book({ dtlKey: 11, code: "8030-1S", rawCode: "DSL-8030 SOFA" }),
    ];
    const pieces = (ids) => ids.map((id, n) => erp({ id, code: n % 2 ? "8030-CNR" : "8030-1A(LHF)" }));
    const run = (ids) =>
      pairDocument({ bookLines, erpRows: pieces(ids), docNo: "D" }).stamps
        .map((s) => `${s.id}=${s.dtlKey}`).sort().join(",");
    // Two builds of one model on one document is ONE unit here, so this pairs
    // 2 book lines against 1 unit and must refuse — the point being that it
    // refuses IDENTICALLY whatever order the rows arrived in.
    expect(run(["a", "b"])).toBe(run(["b", "a"]));
  });
});

describe("what it REFUSES, because a wrong key is worse than none", () => {
  it("refuses two book lines that DIFFER on price", () => {
    const r = pairDocument({
      bookLines: [book({ dtlKey: 10, unitPriceSen: 100 }), book({ dtlKey: 11, unitPriceSen: 200 })],
      erpRows: [erp({ id: "a" }), erp({ id: "b" })],
      docNo: "D",
    });
    expect(r.stamps).toEqual([]);
    expect(r.refusals[0].reason).toMatch(/NOT identical/);
  });

  it("refuses two book lines that differ only on Desc2", () => {
    const r = pairDocument({
      bookLines: [book({ dtlKey: 10, desc2: "PG100" }), book({ dtlKey: 11, desc2: "TAKEN" })],
      erpRows: [erp({ id: "a" }), erp({ id: "b" })],
      docNo: "D",
    });
    expect(r.stamps).toEqual([]);
  });

  it("refuses two book lines that differ only on LOCATION — KL is not PG", () => {
    const r = pairDocument({
      bookLines: [book({ dtlKey: 10, location: "HQ" }), book({ dtlKey: 11, location: "PG" })],
      erpRows: [erp({ id: "a" }), erp({ id: "b" })],
      docNo: "D",
    });
    expect(r.stamps).toEqual([]);
  });

  it("refuses when the counts disagree", () => {
    const r = pairDocument({
      bookLines: [book({ dtlKey: 10 })],
      erpRows: [erp({ id: "a" }), erp({ id: "b" })],
      docNo: "D",
    });
    expect(r.stamps).toEqual([]);
    expect(r.refusals[0].reason).toMatch(/not guessing which is which/);
  });

  it("refuses an UNEVEN sofa fold rather than picking a number", () => {
    const r = pairDocument({
      bookLines: [book({ dtlKey: 10, code: "8030-1S", rawCode: "DSL-8030 SOFA" })],
      erpRows: [erp({ id: "a", code: "8030-1A(LHF)", qty: 1 }), erp({ id: "b", code: "8030-CNR", qty: 2 })],
      docNo: "D",
    });
    expect(r.stamps).toEqual([]);
    expect(r.refusals[0].reason).toMatch(/uneven/);
  });

  it("refuses a row the book has no line for", () => {
    const r = pairDocument({ bookLines: [], erpRows: [erp({ id: "a" })], docNo: "D" });
    expect(r.stamps).toEqual([]);
    expect(r.refusals[0].reason).toMatch(/no line of this item/);
  });

  it("keeps the sofa and the accessory whose name contains SOFA apart", () => {
    // The book writes both as "... SOFA ..." strings; only the one that yields a
    // MODEL folds. A bucket string split on the first space would truncate both
    // to "DSL-8030" and pair the pillow against the sofa.
    const r = pairDocument({
      bookLines: [
        book({ dtlKey: 10, code: "8030-1S", rawCode: "DSL-8030 SOFA", qty: 1 }),
        book({ dtlKey: 11, code: "SQUARE PILLOW", rawCode: "AMN-SOFA PILLOW", qty: 1 }),
      ],
      erpRows: [
        erp({ id: "a", code: "8030-1A(LHF)" }),
        erp({ id: "b", code: "8030-CNR" }),
        erp({ id: "c", code: "SQUARE PILLOW" }),
      ],
      docNo: "D",
    });
    expect(r.refusals).toEqual([]);
    expect(r.stamps.sort((x, y) => (x.id > y.id ? 1 : -1))).toEqual([
      { id: "a", dtlKey: 10, key: "SOFA 8030", forced: "unique" },
      { id: "b", dtlKey: 10, key: "SOFA 8030", forced: "unique" },
      { id: "c", dtlKey: 11, key: "SQUARE PILLOW", forced: "unique" },
    ]);
  });

  it("keeps two DIFFERENT plain codes apart when one is a prefix of the other", () => {
    const r = pairDocument({
      bookLines: [
        book({ dtlKey: 10, code: "BC-CB49", rawCode: "BC-CB49", qty: 1 }),
        book({ dtlKey: 11, code: "BC-CB49 PLUS", rawCode: "BC-CB49 PLUS", qty: 1, unitPriceSen: 999 }),
      ],
      erpRows: [erp({ id: "a", code: "BC-CB49" }), erp({ id: "b", code: "BC-CB49 PLUS" })],
      docNo: "D",
    });
    expect(r.stamps.sort((x, y) => (x.id > y.id ? 1 : -1))).toEqual([
      { id: "a", dtlKey: 10, key: "BC-CB49", forced: "unique" },
      { id: "b", dtlKey: 11, key: "BC-CB49 PLUS", forced: "unique" },
    ]);
  });

  it("refuses when the QUANTITY differs, even though the code agrees", () => {
    const r = pairDocument({ bookLines: [book({ dtlKey: 10, qty: 2 })], erpRows: [erp({ id: "a", qty: 1 })], docNo: "D" });
    expect(r.stamps).toEqual([]);
  });
});

describe("rows that already carry a key", () => {
  it("never overwrites one, and reports a DISAGREEMENT", () => {
    const r = pairDocument({
      bookLines: [book({ dtlKey: 14576 })],
      erpRows: [erp({ id: "a", storedKey: 99999 })],
      docNo: "D",
    });
    expect(r.stamps).toEqual([]);
    expect(r.audits).toEqual([{ id: "a", stored: 99999, derived: 14576 }]);
  });

  it("says nothing when the stored key AGREES", () => {
    const r = pairDocument({
      bookLines: [book({ dtlKey: 14576 })],
      erpRows: [erp({ id: "a", storedKey: 14576 })],
      docNo: "D",
    });
    expect(r.stamps).toEqual([]);
    expect(r.audits).toEqual([]);
  });
});

describe("AutoCount's own empty rows", () => {
  it("counts a codeless book row, and never lets it refuse a document", () => {
    const r = pairDocument({
      bookLines: [book({ dtlKey: 10 }), book({ dtlKey: 11, code: "", rawCode: "", qty: 0 })],
      erpRows: [erp({ id: "a" })],
      docNo: "D",
    });
    expect(r.blankBookRows).toBe(1);
    expect(r.stamps).toHaveLength(1);
    expect(r.refusals).toEqual([]);
  });
});

describe("the whole plan", () => {
  it("makes the three counts SUM to the denominator, even when a refused bucket holds a keyed row", () => {
    // Two ERP rows in one bucket the book has only one line for: the bucket is
    // refused, but one of its rows already carries a key. Summing the refusal
    // buckets would count that row twice and the parts would not add up to 2.
    const out = planLineKeys({
      bookByDoc: new Map([["D1", [book({ dtlKey: 10 })]]]),
      erpByDoc: new Map([["D1", [erp({ id: "a", storedKey: 10 }), erp({ id: "b" })]]]),
    });
    const { erpRows, stampedRows, alreadyKeyed, refusedRows } = out.totals;
    expect(stampedRows + alreadyKeyed + refusedRows).toBe(erpRows);
    expect({ erpRows, stampedRows, alreadyKeyed, refusedRows }).toEqual({
      erpRows: 2, stampedRows: 0, alreadyKeyed: 1, refusedRows: 1,
    });
  });


  it("rolls up, and refuses a document the book does not state", () => {
    const out = planLineKeys({
      bookByDoc: new Map([["D1", [book({ dtlKey: 10 })]]]),
      erpByDoc: new Map([
        ["D1", [erp({ id: "a" })]],
        ["D2", [erp({ id: "b" })]],
      ]),
    });
    expect(out.totals).toMatchObject({
      documents: 2,
      erpRows: 2,
      stampedRows: 1,
      refusedRows: 1,
      documentsNoBook: 1,
      documentsFullyStamped: 1,
      forcedUnique: 1,
    });
    expect(out.stamps).toEqual([{ id: "a", dtlKey: 10, key: "BC-CB49", forced: "unique" }]);
  });
});
