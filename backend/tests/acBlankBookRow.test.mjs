// AutoCount's own empty rows, decided on the real rows the go-live reconcile
// reported. Every case here is a line that was actually on the 2026-09-08 11:55
// (Malaysia) offender list, or one that must NOT be — the two rows that look
// blank and are not are the reason this test exists at all.
import { describe, expect, it } from "vitest";

import { isBlankBookRow, splitBlankBookRows } from "../scripts/lib/ac-blank-book-row.mjs";

/** The snapshot's decoded line shape, from lib/ac-scope.mjs `decodeSnapshot`. */
const line = (over = {}) => ({
  dtlKey: "1", seq: 16, itemKey: "", hasCode: false,
  qty: 0, unitPriceSen: 0, subTotalSen: 0, ...over,
});

describe("a book row the ERP cannot hold", () => {
  it("HC-SO-001473 key 98858 — no code, no quantity, no money", () => {
    expect(isBlankBookRow(line({ dtlKey: "98858" }))).toBe(true);
  });

  it("HC-SO-000814 key 58981 — a build NOTE is still not a line", () => {
    // "LEG: FOLLOW DISPLAY" lives in Desc2, which this rule does not read: an
    // instruction belongs on the sofa line's variants, not on a row of its own.
    expect(isBlankBookRow(line({ dtlKey: "58981" }))).toBe(true);
  });

  it("treats an ABSENT number the same as a zero", () => {
    expect(isBlankBookRow(line({ qty: null, unitPriceSen: null, subTotalSen: null }))).toBe(true);
  });
});

describe("the rows that look blank and are NOT", () => {
  it("HC-SO-011384 key 783795 — no item code, QUANTITY 4: the book orders four of something it does not name", () => {
    expect(isBlankBookRow(line({ dtlKey: "783795", qty: 4 }))).toBe(false);
  });

  it("HC-SO-000102 key 15971 — \"DELIVERY FEE \", no item code, RM 50.00 of real money", () => {
    expect(isBlankBookRow(line({ dtlKey: "15971", itemKey: "DELIVERY FEE ", qty: 1, unitPriceSen: 5000, subTotalSen: 5000 }))).toBe(false);
  });

  it("HC-DO-001604 key 199273 — a text-only DISPOSE row carrying RM 150.00", () => {
    expect(isBlankBookRow(line({ dtlKey: "199273", itemKey: "* DISPOSE 3S L SHAPE SOFA + CONSOLE TABLE", qty: 1, unitPriceSen: 15000, subTotalSen: 15000 }))).toBe(false);
  });

  it("a CODED line is never blank, whatever its numbers", () => {
    // HC-DO-002544 key 282775: HB109NL at quantity 0. A product line at zero is
    // a product line — the delivery note records it and the ERP holds it.
    expect(isBlankBookRow(line({ dtlKey: "282775", itemKey: "HB109NL", hasCode: true }))).toBe(false);
  });

  it("an annotation carrying money in the AMOUNT only is not blank", () => {
    // Guards the half of the rule a zero UnitPrice would otherwise swallow.
    expect(isBlankBookRow(line({ subTotalSen: 15000 }))).toBe(false);
  });

  it("refuses a missing line rather than calling it blank", () => {
    expect(isBlankBookRow(null)).toBe(false);
    expect(isBlankBookRow(undefined)).toBe(false);
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
    const { lines, blank } = splitBlankBookRows(doc);
    expect(lines.map((l) => l.dtlKey)).toEqual(["150901", "150902", "150904", "150905"]);
    expect(blank.map((l) => l.dtlKey)).toEqual(["150906", "150907"]);
  });

  it("moves nothing on a document that has no blank row", () => {
    const doc = [line({ itemKey: "X", hasCode: true, qty: 1 })];
    expect(splitBlankBookRows(doc).blank).toEqual([]);
    expect(splitBlankBookRows(doc).lines).toHaveLength(1);
  });
});
