// The pairing rule, decided on the shapes that actually appear in the migrated
// goods receipts and delivery orders. Every REFUSAL case here is one the rule
// must keep refusing: a wrong DtlKey makes AcSyncService append a line to the
// live account book instead of editing the one that changed (migration 0273),
// so "no key" is the safe answer and "a key" is the dangerous one.
import { describe, expect, it } from "vitest";

import { comparisonKey, foldErpUnits, pairDocument, planLineKeys, resolveErpSource } from "../scripts/lib/ac-forced-line-pairing.mjs";

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

describe("two sofas of ONE model on one document — the build text decides", () => {
  // Measured on production 2026-09-08 (plan run 34209494838): 25 of the 44
  // refused sales orders were refused as "the book has 2 such line(s), we have
  // 1", which is arithmetic, not ambiguity. The customer bought two 8030s; the
  // ERP holds both builds' compartments and the fold made them one unit.
  const sofa = (id, code, desc2) => erp({ id, code, qty: 1, desc2 });
  const bookSofa = (dtlKey, desc2, over = {}) =>
    book({ dtlKey, code: "8030-1S", rawCode: "DSL-8030 SOFA", qty: 1, desc2, ...over });

  it("splits one model into two units when every row states a build text", () => {
    const u = foldErpUnits([
      sofa("a", "8030-1A(LHF)", "2L+C (30INCH)"),
      sofa("b", "8030-L(RHF)", "2L+C (30INCH)"),
      sofa("c", "8030-1S", "1S (28INCH)"),
    ]);
    expect(u).toHaveLength(2);
    expect(u.map((x) => x.key)).toEqual(["SOFA 8030", "SOFA 8030"]);
    expect(u.map((x) => x.ids.join("+")).sort()).toEqual(["a+b", "c"]);
  });

  it("does NOT split when any row of that model has no build text", () => {
    // A partial split would invent a build boundary out of a blank column.
    const u = foldErpUnits([
      sofa("a", "8030-1A(LHF)", "2L+C (30INCH)"),
      sofa("b", "8030-L(RHF)", null),
    ]);
    expect(u).toHaveLength(1);
    expect(u[0].ids).toEqual(["a", "b"]);
  });

  it("stamps each build with the book line stating the SAME text", () => {
    const r = pairDocument({
      docNo: "SO-013164",
      bookLines: [bookSofa(900, "1S (28INCH)", { unitPriceSen: 100 }), bookSofa(901, "2L+C (30INCH)", { unitPriceSen: 200 })],
      erpRows: [
        sofa("a", "8030-1A(LHF)", "2L+C (30inch)"),
        sofa("b", "8030-L(RHF)", "2L+C (30inch)"),
        sofa("c", "8030-1S", "1S (28inch)"),
      ],
    });
    expect(r.refusals).toEqual([]);
    // Every compartment of one build carries ONE key — composeEdit's condition.
    expect(r.stamps.filter((s) => s.dtlKey === 901).map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(r.stamps.filter((s) => s.dtlKey === 900).map((s) => s.id)).toEqual(["c"]);
    expect(r.stamps.every((s) => s.forced === "build text")).toBe(true);
  });

  it("REFUSES when the two builds' texts do not match the book's one-to-one", () => {
    // The prices differ, so the interchangeable clause cannot rescue it either.
    // A wrong DtlKey edits somebody else's line in a live account book.
    const r = pairDocument({
      docNo: "SO-013164",
      bookLines: [bookSofa(900, "1S (28INCH)", { unitPriceSen: 100 }), bookSofa(901, "2L+C (30INCH)", { unitPriceSen: 200 })],
      erpRows: [
        sofa("a", "8030-1A(LHF)", "SOMETHING ELSE"),
        sofa("b", "8030-L(RHF)", "SOMETHING ELSE"),
        sofa("c", "8030-1S", "1S (28inch)"),
      ],
    });
    expect(r.stamps).toEqual([]);
    expect(r.refusals[0].reason).toMatch(/NOT identical/);
  });

  it("keeps refusing when the fold cannot split, and SAYS how many texts we hold", () => {
    const r = pairDocument({
      docNo: "SO-007822",
      bookLines: [bookSofa(900, "A"), bookSofa(901, "B")],
      erpRows: [sofa("a", "8030-1A(LHF)", null), sofa("b", "8030-L(RHF)", null)],
    });
    expect(r.stamps).toEqual([]);
    expect(r.refusals[0].reason).toMatch(/we have 1 .*0 distinct build text/);
  });

  it("leaves a caller that passes NO build text bit-for-bit unchanged", () => {
    // The goods-receipt and delivery-order lanes pass none, and their guarantee
    // must not move because a sibling lane started passing one.
    const u = foldErpUnits([erp({ id: "a", code: "8030-1A(LHF)" }), erp({ id: "b", code: "8030-CNR" })]);
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ key: "SOFA 8030", qty: 1, uneven: false, desc2: null });
  });
});

describe("the roll-up counts every FORCED kind", () => {
  it("counts build-text stamps in their own total, so the three sum to stampedRows", () => {
    // It printed `undefined` in plan run 34210216732 because the field was
    // never initialised — a report that cannot count its own work.
    const out = planLineKeys({
      bookByDoc: new Map([[
        "D1",
        [
          book({ dtlKey: 900, code: "8030-1S", rawCode: "DSL-8030 SOFA", desc2: "1S (28INCH)", unitPriceSen: 100 }),
          book({ dtlKey: 901, code: "8030-1S", rawCode: "DSL-8030 SOFA", desc2: "2L+C (30INCH)", unitPriceSen: 200 }),
        ],
      ]]),
      erpByDoc: new Map([[
        "D1",
        [
          erp({ id: "a", code: "8030-1A(LHF)", desc2: "2L+C (30inch)" }),
          erp({ id: "b", code: "8030-L(RHF)", desc2: "2L+C (30inch)" }),
          erp({ id: "c", code: "8030-1S", desc2: "1S (28inch)" }),
        ],
      ]]),
    });
    const { stampedRows, forcedUnique, forcedInterchangeable, forcedBuildText } = out.totals;
    expect(forcedBuildText).toBe(3);
    expect(forcedUnique + forcedInterchangeable + forcedBuildText).toBe(stampedRows);
  });
});

/* ── THE SOURCE-DOCUMENT PARTITION — what the INVOICE lanes need ────────────
 * A migrated invoice's lines are built from OUR delivery order / goods receipt
 * and the migration carried only the OUTSTANDING population, so the ERP holds a
 * deliberate SUBSET of the book's invoice lines: measured on the committed
 * snapshot, 131 of 192 in-scope purchase invoices bill at least one line whose
 * purchase order the migration never carried (lib/ac-chain-line-grain.mjs).
 *
 * Bucketed on (item, quantity) alone that reads as ambiguity — "the book has 2
 * such lines, we have 1" — and every one of those lines is refused for a reason
 * that is SCOPE, not doubt.
 *
 * The book states the discriminator itself. `IVDTL.FromDocNo` / `PIDTL.FromDocNo`
 * name the delivery order / goods receipt each invoice line was raised from, and
 * our own row knows which of ours it came from. Pairing inside that partition is
 * still the book's own key, never a position and never a resemblance.
 *
 * IT IS ALL-OR-NOTHING PER DOCUMENT, on purpose. If either side leaves one row's
 * source unstated the partition is off and the rule is exactly what it was — the
 * goods-receipt and delivery-order lanes pass no source at all and are pinned
 * bit-for-bit below.
 */
describe("the source-document partition", () => {
  it("pairs our line against the book line raised from the SAME source document", () => {
    // The book bills the same item at the same quantity from two receipts; the
    // migration carried only GR-A. Without the partition this is "the book has
    // 2 such lines, we have 1" and both are refused.
    const r = pairDocument({
      docNo: "PI-1",
      bookLines: [
        book({ dtlKey: 11, sourceDoc: "GR-A", unitPriceSen: 1000, subTotalSen: 1000 }),
        book({ dtlKey: 22, sourceDoc: "GR-B", unitPriceSen: 2000, subTotalSen: 2000 }),
      ],
      erpRows: [erp({ id: "a", sourceDoc: "GR-A" })],
    });
    expect(r.refusals).toEqual([]);
    expect(r.stamps).toEqual([{ id: "a", dtlKey: 11, key: "BC-CB49", forced: "source document" }]);
    // The line we never carried is an UNMATCHED BOOK LINE, not a refusal.
    expect(r.unmatchedBookLines).toEqual([{ key: "BC-CB49", lines: 1 }]);
  });

  it("still REFUSES two book lines from the SAME source that we hold one of", () => {
    // The partition narrows; it never invents. Inside one receipt the two lines
    // are as indistinguishable as they ever were.
    const r = pairDocument({
      docNo: "PI-2",
      bookLines: [
        book({ dtlKey: 11, sourceDoc: "GR-A", unitPriceSen: 1000, subTotalSen: 1000 }),
        book({ dtlKey: 22, sourceDoc: "GR-A", unitPriceSen: 2000, subTotalSen: 2000 }),
      ],
      erpRows: [erp({ id: "a", sourceDoc: "GR-A" })],
    });
    expect(r.stamps).toEqual([]);
    expect(r.refusals[0].reason).toMatch(/the book has 2 such line\(s\), we have 1/);
  });

  it("is OFF when one of OUR rows states no source, and refuses as it did before", () => {
    const r = pairDocument({
      docNo: "PI-3",
      bookLines: [
        book({ dtlKey: 11, sourceDoc: "GR-A", unitPriceSen: 1000, subTotalSen: 1000 }),
        book({ dtlKey: 22, sourceDoc: "GR-B", unitPriceSen: 2000, subTotalSen: 2000 }),
      ],
      erpRows: [erp({ id: "a", sourceDoc: null })],
    });
    expect(r.stamps).toEqual([]);
    expect(r.refusals[0].reason).toMatch(/the book has 2 such line\(s\), we have 1/);
  });

  it("is OFF when one BOOK line states no source", () => {
    const r = pairDocument({
      docNo: "PI-4",
      bookLines: [
        book({ dtlKey: 11, sourceDoc: "GR-A", unitPriceSen: 1000, subTotalSen: 1000 }),
        book({ dtlKey: 22, sourceDoc: null, unitPriceSen: 2000, subTotalSen: 2000 }),
      ],
      erpRows: [erp({ id: "a", sourceDoc: "GR-A" })],
    });
    expect(r.stamps).toEqual([]);
    expect(r.refusals[0].reason).toMatch(/the book has 2 such line\(s\), we have 1/);
  });

  it("is OFF for a sofa whose compartment rows disagree about where they came from", () => {
    // A fold that cannot state ONE source must not be allowed to state a
    // pairing either — the same argument `uneven` makes about quantity.
    const r = pairDocument({
      docNo: "PI-5",
      bookLines: [
        book({ dtlKey: 11, code: "8030-1S", rawCode: "DSL-8030 SOFA", sourceDoc: "GR-A", unitPriceSen: 1000, subTotalSen: 1000 }),
        book({ dtlKey: 22, code: "8030-1S", rawCode: "DSL-8030 SOFA", sourceDoc: "GR-B", unitPriceSen: 2000, subTotalSen: 2000 }),
      ],
      erpRows: [
        erp({ id: "a", code: "8030-1A(LHF)", sourceDoc: "GR-A" }),
        erp({ id: "b", code: "8030-CNR", sourceDoc: "GR-B" }),
      ],
    });
    expect(r.stamps).toEqual([]);
    expect(r.refusals[0].reason).toMatch(/the book has 2 such line\(s\), we have 1/);
  });

  it("carries the source onto the folded unit when every compartment agrees", () => {
    const u = foldErpUnits([
      erp({ id: "a", code: "8030-1A(LHF)", sourceDoc: "GR-A" }),
      erp({ id: "b", code: "8030-CNR", sourceDoc: "GR-A" }),
    ]);
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ key: "SOFA 8030", sourceDoc: "GR-A" });
  });

  it("leaves a caller that passes NO source bit-for-bit unchanged", () => {
    // The goods-receipt and delivery-order lanes pass none. Two identical book
    // lines and two units still pair as INTERCHANGEABLE, exactly as today.
    const r = pairDocument({
      docNo: "GR-1",
      bookLines: [book({ dtlKey: 11 }), book({ dtlKey: 22 })],
      erpRows: [erp({ id: "a" }), erp({ id: "b" })],
    });
    expect(r.refusals).toEqual([]);
    expect(r.stamps.map((s) => s.forced)).toEqual(["interchangeable", "interchangeable"]);
  });

  it("counts source-document stamps in the roll-up, so the four sum to stampedRows", () => {
    const out = planLineKeys({
      bookByDoc: new Map([["PI-6", [
        book({ dtlKey: 11, sourceDoc: "GR-A", unitPriceSen: 1000, subTotalSen: 1000 }),
        book({ dtlKey: 22, sourceDoc: "GR-B", unitPriceSen: 2000, subTotalSen: 2000 }),
      ]]]),
      erpByDoc: new Map([["PI-6", [erp({ id: "a", sourceDoc: "GR-A" })]]]),
    });
    const { stampedRows, forcedUnique, forcedInterchangeable, forcedBuildText, forcedSourceDoc } = out.totals;
    expect(forcedSourceDoc).toBe(1);
    expect(forcedUnique + forcedInterchangeable + forcedBuildText + forcedSourceDoc).toBe(stampedRows);
  });
});

/* Our invoice line reaches TWO parents — a sales invoice line knows its
 * delivery order AND the sales order behind it; a purchase invoice line knows
 * its goods receipt AND that receipt's purchase order. The BOOK names exactly
 * one. Which of ours it means is decided by the book's own list, never by
 * preferring one join over the other. */
describe("which of our parents the book is talking about", () => {
  it("takes the one parent the book's invoice actually names", () => {
    expect(resolveErpSource(["GR-004909", "PO-009017"], new Set(["GR-004909", "GR-004914"]))).toBe("GR-004909");
  });

  it("refuses when the book names BOTH of our parents", () => {
    // The invoice bills the receipt AND the order behind it. Which one this row
    // answers is not stated, so the document falls back to the old rule.
    expect(resolveErpSource(["GR-004909", "PO-009017"], new Set(["GR-004909", "PO-009017"]))).toBeNull();
  });

  it("refuses when the book names NEITHER", () => {
    expect(resolveErpSource(["GR-004909", "PO-009017"], new Set(["GR-005169"]))).toBeNull();
  });

  it("treats a blank or absent parent as no parent at all", () => {
    expect(resolveErpSource([null, "  ", "GR-004909"], new Set(["GR-004909"]))).toBe("GR-004909");
    expect(resolveErpSource([null, ""], new Set(["GR-004909"]))).toBeNull();
  });

  it("is not confused by the same parent arriving twice", () => {
    expect(resolveErpSource(["GR-A", "GR-A"], new Set(["GR-A"]))).toBe("GR-A");
  });
});
