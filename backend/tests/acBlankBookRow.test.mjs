// AutoCount's own empty rows, decided on the real rows the go-live reconcile
// reported. Every case here is a line that was actually on the 2026-09-08 11:55
// (Malaysia) offender list, or one that must NOT be — the two rows that look
// blank and are not are the reason this test exists at all.
//
// ARM 2 is the owner's ruling of 2026-09-08, and its cases are marked as such.
// He was told the standing convention first (never delete, only cancel) and
// ruled anyway: 「删掉啊 没写的也删掉 / 简单来说都要跟Autocount一样啊 你不懂吗？」
// The ruling widens what counts as nothing; it does NOT move the money
// boundary, and the cases below pin both halves.
import { describe, expect, it } from "vitest";

import { blankRowArm, isBlankBookRow, splitBlankBookRows } from "../scripts/lib/ac-blank-book-row.mjs";

/** The snapshot's decoded line shape, from lib/ac-scope.mjs `decodeSnapshot`. */
const line = (over = {}) => ({
  dtlKey: "1", seq: 16, itemKey: "", hasCode: false,
  qty: 0, unitPriceSen: 0, subTotalSen: 0, docSubTotalSen: 0, ...over,
});
/** The type's Desc2 map. Empty is the common case: the exporter carries a Desc2
 *  only for the lines that have one. */
const noDesc2 = new Map();

describe("arm 1 — a book row with nothing in its numeric columns", () => {
  it("HC-SO-001473 key 98858 — no code, no quantity, no money", () => {
    expect(isBlankBookRow(line({ dtlKey: "98858" }), null)).toBe(true);
  });

  it("HC-SO-000814 key 58981 — a build NOTE is still not a line", () => {
    // "LEG: FOLLOW DISPLAY" lives in Desc2. Arm 1 does not read it: an
    // instruction belongs on the sofa line's variants, not on a row of its own.
    expect(isBlankBookRow(line({ dtlKey: "58981" }), "LEG: FOLLOW DISPLAY")).toBe(true);
  });

  it("treats an ABSENT number the same as a zero", () => {
    expect(isBlankBookRow(line({ qty: null, unitPriceSen: null, subTotalSen: null }), null)).toBe(true);
  });
});

describe("arm 2 — the owner's 2026-09-08 ruling: a row the book describes NOTHING in", () => {
  it("HC-SO-011384 key 783795 — no item code, no description, no Desc2, no money, QUANTITY 4", () => {
    // The row he was shown. Before the ruling this answered false, on the
    // reasoning that the book was ordering four of something it did not name.
    expect(isBlankBookRow(line({ dtlKey: "783795", qty: 4 }), undefined)).toBe(true);
  });

  it("HC-DO-000806 key 104943 — the same shape on a delivery order", () => {
    expect(isBlankBookRow(line({ dtlKey: "104943", qty: 1 }), undefined)).toBe(true);
  });

  it("names which arm declared the row, so the listing can say why", () => {
    expect(blankRowArm(line({ dtlKey: "98858" }), null)).toBe("no-quantity");
    expect(blankRowArm(line({ dtlKey: "783795", qty: 4 }), null)).toBe("states-nothing");
    expect(blankRowArm(line({ itemKey: "X", hasCode: true, qty: 1 }), null)).toBe(null);
  });
});

describe("the ruling did NOT widen these — the rows that look blank and are NOT", () => {
  it("HC-SO-000102 key 15971 — \"DELIVERY FEE \", no item code, RM 50.00 of real money", () => {
    expect(isBlankBookRow(line({ dtlKey: "15971", itemKey: "DELIVERY FEE ", qty: 1, unitPriceSen: 5000, subTotalSen: 5000, docSubTotalSen: 5000 }), null)).toBe(false);
  });

  it("HC-DO-001604 key 199273 — a text-only DISPOSE row carrying RM 150.00", () => {
    expect(isBlankBookRow(line({ dtlKey: "199273", itemKey: "* DISPOSE 3S L SHAPE SOFA + CONSOLE TABLE", qty: 1, unitPriceSen: 15000, subTotalSen: 15000, docSubTotalSen: 15000 }), null)).toBe(false);
  });

  it("MONEY is the boundary the ruling does not move — a quantity row carrying money stays a finding", () => {
    expect(isBlankBookRow(line({ qty: 4, unitPriceSen: 0, subTotalSen: 15000 }), null)).toBe(false);
    expect(isBlankBookRow(line({ qty: 4, unitPriceSen: 15000, subTotalSen: 0 }), null)).toBe(false);
    // ... and money in the DOCUMENT's own currency counts, on a document whose
    // local amount rounded to zero. Arm 2 is the wider arm, so it is the
    // narrower test.
    expect(isBlankBookRow(line({ qty: 4, docSubTotalSen: 15000 }), null)).toBe(false);
  });

  it("a DESCRIPTION with a quantity is not nothing — the book named something", () => {
    // itemKey carries the Description when ItemCode is blank
    // (export-ac-reconcile-truth.mjs:239), so this is how a described row looks.
    expect(isBlankBookRow(line({ itemKey: "COMPENSATION", qty: 4 }), null)).toBe(false);
  });

  it("a BUILD TEXT with a quantity is not nothing either", () => {
    expect(isBlankBookRow(line({ qty: 4 }), "LEG: FOLLOW DISPLAY")).toBe(false);
  });

  it("a CODED line is never blank, whatever its numbers", () => {
    // HC-DO-002544 key 282775: HB109NL at quantity 0. A product line at zero is
    // a product line — the delivery note records it and the ERP holds it.
    expect(isBlankBookRow(line({ dtlKey: "282775", itemKey: "HB109NL", hasCode: true }), null)).toBe(false);
  });

  it("an annotation carrying money in the AMOUNT only is not blank", () => {
    // Guards the half of the rule a zero UnitPrice would otherwise swallow.
    expect(isBlankBookRow(line({ subTotalSen: 15000 }), null)).toBe(false);
  });

  it("refuses a missing line rather than calling it blank", () => {
    expect(isBlankBookRow(null, null)).toBe(false);
    expect(isBlankBookRow(undefined, null)).toBe(false);
  });
});

describe("the Desc2 argument is REQUIRED, so a caller that did not look cannot answer", () => {
  it("isBlankBookRow throws when called with one argument", () => {
    expect(() => isBlankBookRow(line({ qty: 4 }))).toThrow(/build text is required/);
  });

  it("splitBlankBookRows throws when handed no Desc2 map", () => {
    expect(() => splitBlankBookRows([line()])).toThrow(/Desc2 map/);
  });
});

describe("splitBlankBookRows", () => {
  it("keeps document order on both sides and moves only the blank rows", () => {
    // HC-SO-002294 as the book holds it: four coded lines then two empty rows.
    const doc = [
      line({ dtlKey: "150901", itemKey: "AK-ARMOUR MATT (K)", hasCode: true, qty: 1, unitPriceSen: 498800, subTotalSen: 498800 }),
      line({ dtlKey: "150902", itemKey: "HOK-2009(A) (K)", hasCode: true, qty: 1 }),
      line({ dtlKey: "150904", itemKey: "AK-SLEEP ESSENTIAL 7 HOLES", hasCode: true, qty: 2 }),
      line({ dtlKey: "150905", itemKey: "AERO-MP (K)", hasCode: true, qty: 1 }),
      line({ dtlKey: "150906" }),
      line({ dtlKey: "150907" }),
    ];
    const { lines, blank } = splitBlankBookRows(doc, noDesc2);
    expect(lines.map((l) => l.dtlKey)).toEqual(["150901", "150902", "150904", "150905"]);
    expect(blank.map((l) => l.dtlKey)).toEqual(["150906", "150907"]);
  });

  it("reads each row's OWN Desc2 out of the map", () => {
    const doc = [line({ dtlKey: "a", qty: 4 }), line({ dtlKey: "b", qty: 4 })];
    const desc2 = new Map([["a", "LEG: FOLLOW DISPLAY"]]);
    const { lines, blank } = splitBlankBookRows(doc, desc2);
    expect(lines.map((l) => l.dtlKey)).toEqual(["a"]);
    expect(blank.map((l) => l.dtlKey)).toEqual(["b"]);
  });

  it("moves nothing on a document that has no blank row", () => {
    const doc = [line({ itemKey: "X", hasCode: true, qty: 1 })];
    expect(splitBlankBookRows(doc, noDesc2).blank).toEqual([]);
    expect(splitBlankBookRows(doc, noDesc2).lines).toHaveLength(1);
  });
});
