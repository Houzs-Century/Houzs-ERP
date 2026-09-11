/* Which GOODS-RECEIPT LINE did this purchase-invoice line bill?
 *
 * Every fixture below is VERBATIM from the committed book cut
 * (ac-convert-edges.json.gz + ac-reconcile-truth.json.gz, the 2026-09-08 cuts),
 * found by scanning for the shape rather than invented to make a point: a
 * receipt carrying several lines of ONE item code, where the invoice line the
 * book raised off it is NOT the first of them.
 *
 * ── THE TRAP, IN THE BOOK'S OWN DATA ──────────────────────────────────────
 * GR-000032 carries two NK-1045 (Q) bed frames. They differ only in build text:
 *
 *   GRdtl 41242   DIVAN: 8" NO LEG / COL: SF-AT-1 / GAP: 12 INCHES
 *   GRdtl 41244   DIVAN: 8"+4" LEG / COL: SF-AT-8 / MATT GAP: 12"
 *
 * PI-000654's line 41251 bills the SECOND one. Anything pairing by position
 * takes the first and bills one colour's receipt against another — the class
 * docs/bugs/0690 names, and the same failure docs/bugs/0730 records on the
 * sibling edge, where a position implementation failed 6 of 8 cases.
 *
 * PI-000632 is the sharper one: FOUR candidate lines on GR-000017, two of them
 * the same model with the same gap and only the colour different
 * (PC151-03 against PC151-02). Position, quantity and item code all fail to
 * separate those; only the build text does.
 *
 * ── PROVED RED ────────────────────────────────────────────────────────────
 * `POSITION_MATCHER` below is the naive implementation this module exists to
 * refuse — take the Nth candidate. The last describe block runs the SAME
 * fixtures through it and asserts it gets them WRONG, so the evidence that
 * position pairing fails lives in the suite rather than in a commit message
 * somebody has to trust.
 */
import { describe, it, expect } from "vitest";
import { matchPiLinesToGrLines } from "../scripts/lib/ac-pi-gr-line-match.mjs";

/* ── GR-000032: two NK-1045 (Q), the invoice bills the second ────────────── */
const GR_000032 = [
  { dtlKey: "41242", itemKey: "NK-1045 (Q)" },
  { dtlKey: "41244", itemKey: "NK-1045 (Q)" },
];
/* ── GR-000017: four NB-KHJ21(Q), two of them near-identical builds ──────── */
const GR_000017 = [
  { dtlKey: "41323", itemKey: "NB-KHJ21(Q)" },
  { dtlKey: "41325", itemKey: "NB-KHJ21(Q)" },
  { dtlKey: "41327", itemKey: "NB-KHJ21(Q)" },
  { dtlKey: "52781", itemKey: "NB-KHJ21(Q)" },
];

const DESC2 = new Map([
  // GR-000032
  ["41242", 'DIVAN: 8" NO LEG / COL: SF-AT-1 / GAP: 12 INCHES'],
  ["41244", 'DIVAN: 8"+4" LEG / COL: SF-AT-8 / MATT GAP: 12"'],
  ["41251", 'DIVAN: 8"+4" LEG / COL: SF-AT-8 / MATT GAP: 12"'],   // PI-000654 line
  // GR-000017
  ["41323", 'HC0261 COL(CUSHION): PC 151-02 / COL(PANEL): PC 151-12 / MATT GAP: 12"'],
  ["41325", 'HC0202 DIVAN: 8"+4" LEG / COL:PC151-03 / MATT GAP: 12 INCHES'],
  ["41327", 'HC0202 DIVAN:8"+4" LEG / COL:PC151-02 / MATT GAP: 12 INCHES'],
  ["52781", 'DIVAN: 8" NO LEG / COL: PC151-04 / MATT GAP: 12 INCHES'],
  ["41421", 'HC0202 DIVAN: 8"+4" LEG / COL:PC151-03 / MATT GAP: 12 INCHES'], // PI-000632 line
]);

const BOOK = new Map([["GR-000032", GR_000032], ["GR-000017", GR_000017]]);

const run = (piLines, grLinesByDoc = BOOK, desc2 = DESC2) =>
  matchPiLinesToGrLines({ piLines, grLinesByDoc, desc2 });

describe("matchPiLinesToGrLines", () => {
  it("pairs on the build text, not on position — GR-000032 is a transposition", () => {
    const { pairs, refused } = run([
      { docNo: "PI-000654", dtlKey: "41251", itemKey: "NK-1045 (Q)", fromDocNo: "GR-000032" },
    ]);
    expect(refused).toEqual([]);
    // The SECOND receipt line, not the first.
    expect(pairs.map((p) => [p.piDtlKey, p.grDtlKey])).toEqual([["41251", "41244"]]);
  });

  it("separates two builds that differ only by colour — GR-000017 has four candidates", () => {
    const { pairs, refused } = run([
      { docNo: "PI-000632", dtlKey: "41421", itemKey: "NB-KHJ21(Q)", fromDocNo: "GR-000017" },
    ]);
    expect(refused).toEqual([]);
    expect(pairs[0].grDtlKey).toBe("41325");   // PC151-03, not the PC151-02 beside it
  });

  it("takes the only line of its item code without needing build text at all", () => {
    const { pairs, refused } = run(
      [{ docNo: "PI-000700", dtlKey: "90001", itemKey: "AMN-LONG PILLOW", fromDocNo: "GR-000032" }],
      new Map([["GR-000032", [{ dtlKey: "41299", itemKey: "AMN-LONG PILLOW" }]]]),
      new Map(),
    );
    expect(refused).toEqual([]);
    expect(pairs[0].grDtlKey).toBe("41299");
  });

  it("compares build text on CONTENT — spacing and case are not a different build", () => {
    const { pairs } = run(
      [{ docNo: "PI-000654", dtlKey: "X1", itemKey: "NK-1045 (Q)", fromDocNo: "GR-000032" }],
      BOOK,
      new Map([...DESC2, ["X1", '  divan: 8"+4"   leg / col: sf-at-8 / matt gap: 12"  ']]),
    );
    expect(pairs[0].grDtlKey).toBe("41244");
  });
});

describe("what it REFUSES, because a blank beats a wrong link", () => {
  it("refuses when the book names several source documents on one line", () => {
    const { pairs, refused } = run([
      { docNo: "PI-1", dtlKey: "41251", itemKey: "NK-1045 (Q)", fromDocNo: "GR-000032, GR-000033" },
    ]);
    expect(pairs).toEqual([]);
    expect(refused[0].why).toMatch(/names 2 source documents/);
  });

  it("refuses a source that is not a goods receipt we hold — a PURCHASE ORDER cannot be a grn_item", () => {
    const { pairs, refused } = run([
      { docNo: "PI-1", dtlKey: "41251", itemKey: "NK-1045 (Q)", fromDocNo: "PO-009736" },
    ]);
    expect(pairs).toEqual([]);
    expect(refused[0].why).toMatch(/not a goods receipt in the snapshot/);
  });

  it("refuses when the build text singles out nobody", () => {
    const { pairs, refused } = run(
      [{ docNo: "PI-1", dtlKey: "Y1", itemKey: "NK-1045 (Q)", fromDocNo: "GR-000032" }],
      BOOK,
      new Map([...DESC2, ["Y1", "SOMETHING NOBODY WROTE"]]),
    );
    expect(pairs).toEqual([]);
    expect(refused[0].why).toMatch(/matches none of them/);
  });

  it("refuses when the invoice line carries no build text to tell them apart", () => {
    const { pairs, refused } = run(
      [{ docNo: "PI-1", dtlKey: "Z1", itemKey: "NK-1045 (Q)", fromDocNo: "GR-000032" }],
      BOOK,
      DESC2,   // Z1 is absent, so there is no build text for it
    );
    expect(pairs).toEqual([]);
    expect(refused[0].why).toMatch(/carries no build text/);
  });

  it("refuses BOTH when two invoice lines read as the same receipt line", () => {
    /* Billing one receipt line twice is the expensive direction, so a clash
       withdraws the pairs it already made rather than keeping one of them. */
    const { pairs, refused } = run(
      [
        { docNo: "PI-1", dtlKey: "A1", itemKey: "SOLO", fromDocNo: "GR-000032" },
        { docNo: "PI-1", dtlKey: "A2", itemKey: "SOLO", fromDocNo: "GR-000032" },
      ],
      new Map([["GR-000032", [{ dtlKey: "41500", itemKey: "SOLO" }]]]),
      new Map(),
    );
    expect(pairs).toEqual([]);
    expect(refused).toHaveLength(2);
    expect(refused[0].why).toMatch(/both read as the same receipt line/);
  });

  it("refuses when the receipt carries no line of that item code", () => {
    const { pairs, refused } = run([
      { docNo: "PI-1", dtlKey: "41251", itemKey: "NOT-ON-THIS-RECEIPT", fromDocNo: "GR-000032" },
    ]);
    expect(pairs).toEqual([]);
    expect(refused[0].why).toMatch(/no line of this item code/);
  });
});

/* ── THE RED PROOF ─────────────────────────────────────────────────────────
 * The naive implementation, and the assertion that it gets the book's own two
 * transpositions WRONG. If someone ever "simplifies" the matcher back to
 * position, the block above goes red — and this block, which pins that position
 * is wrong, is the reason why. */
const POSITION_MATCHER = ({ piLines, grLinesByDoc }) =>
  piLines.map((p, i) => {
    const rec = grLinesByDoc.get(String(p.fromDocNo).toUpperCase()) ?? [];
    const cands = rec.filter((x) => x.itemKey === p.itemKey);
    return { piDtlKey: String(p.dtlKey), grDtlKey: cands[i]?.dtlKey ?? cands[0]?.dtlKey ?? null };
  });

describe("position pairing is WRONG, and here is the proof on the book's own rows", () => {
  it("GR-000032: position takes 41242, the book says 41244", () => {
    const line = [{ docNo: "PI-000654", dtlKey: "41251", itemKey: "NK-1045 (Q)", fromDocNo: "GR-000032" }];
    expect(POSITION_MATCHER({ piLines: line, grLinesByDoc: BOOK })[0].grDtlKey).toBe("41242");
    expect(run(line).pairs[0].grDtlKey).toBe("41244");
  });

  it("GR-000017: position takes 41323, the book says 41325", () => {
    const line = [{ docNo: "PI-000632", dtlKey: "41421", itemKey: "NB-KHJ21(Q)", fromDocNo: "GR-000017" }];
    expect(POSITION_MATCHER({ piLines: line, grLinesByDoc: BOOK })[0].grDtlKey).toBe("41323");
    expect(run(line).pairs[0].grDtlKey).toBe("41325");
  });
});
