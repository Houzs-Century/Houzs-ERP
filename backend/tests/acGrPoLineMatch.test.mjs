/* The transposition this matcher exists to refuse, taken from the live book.
 *
 * PO-009081 orders the SAME item code twice — two HOK-1030 (HF)(W) (Q) bed
 * frames, same quantity, same price — and two different goods receipts each
 * take one of them. The ONLY column that tells them apart is the build text:
 *
 *   POdtl 833538  Color: PC151-10 / Divan: 10"no leg / Gap:12"
 *   POdtl 833540  Color: PC151-12/ Divan: 10"no leg / Gap:12"
 *
 *   GRdtl 853738 (GR-004939)  Color: PC151-12/ Divan: 10"no leg / Gap:12"
 *   GRdtl 860498 (GR-004989)  Color: PC151-10 / Divan: 10"no leg / Gap:12"
 *
 * Read in document order, the FIRST receipt line pairs with the SECOND order
 * line. Anything that pairs by position gets both of these backwards and
 * credits one colour's delivery against the other — docs/bugs/0690, the named
 * defect class that bit three times on 2026-09-08.
 */
import { describe, it, expect } from "vitest";
import { matchGrLinesToPoLines } from "../scripts/lib/ac-gr-po-line-match.mjs";

/* The two order lines, in the order the book returns them. */
const PO_009081 = [
  { dtlKey: "833538", itemKey: "HOK-1030 (HF)(W) (Q)", qty: "1.0000", unitPrice: "0.0000" },
  { dtlKey: "833540", itemKey: "HOK-1030 (HF)(W) (Q)", qty: "1.0000", unitPrice: "0.0000" },
];
const DESC2 = new Map([
  ["833538", 'Color: PC151-10 / Divan: 10"no leg / Gap:12"'],
  ["833540", 'Color: PC151-12/ Divan: 10"no leg / Gap:12"'],
  ["853738", 'Color: PC151-12/ Divan: 10"no leg / Gap:12"'],
  ["860498", 'Color: PC151-10 / Divan: 10"no leg / Gap:12"'],
]);

/* The order document is keyed by whatever the receipt lines say they came
   from, so a case can name its own order without restating the map. */
const run = (grLines, poDoc = PO_009081, desc2 = DESC2) =>
  matchGrLinesToPoLines({
    grLines,
    poLinesByDoc: new Map([...new Set(grLines.map((g) => g.fromDocNo))].map((d) => [d, poDoc])),
    desc2,
  });

describe("matchGrLinesToPoLines", () => {
  it("pairs on the build text, not on position — PO-009081 is a transposition", () => {
    const { pairs, refused } = run([
      { docNo: "GR-004939", dtlKey: "853738", itemKey: "HOK-1030 (HF)(W) (Q)", fromDocNo: "PO-009081" },
      { docNo: "GR-004989", dtlKey: "860498", itemKey: "HOK-1030 (HF)(W) (Q)", fromDocNo: "PO-009081" },
    ]);
    expect(refused).toEqual([]);
    /* The whole point: the FIRST receipt line takes the SECOND order line. */
    expect(pairs.map((p) => [p.grDtlKey, p.poDtlKey])).toEqual([
      ["853738", "833540"],
      ["860498", "833538"],
    ]);
  });

  it("takes the only line of its item code without needing build text at all", () => {
    const { pairs, refused } = run(
      [{ docNo: "GR-004940", dtlKey: "853761", itemKey: "AMN-LONG PILLOW", fromDocNo: "PO-009024" }],
      [{ dtlKey: "829692", itemKey: "AMN-LONG PILLOW", qty: "5.0000", unitPrice: "0.0000" }],
      new Map(),
    );
    expect(refused).toEqual([]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].poDtlKey).toBe("829692");
    expect(pairs[0].how).toMatch(/only line of its item code/);
  });

  it("REFUSES when two order lines are indistinguishable — a coin flip is not a reading", () => {
    /* PO-009024's two AMN-SF9050 lines differ only by a leading space. */
    const same = 'bottom to Nilon 30 inch , all adjustable arm rest colour :GD2502# 18- GREY';
    const { pairs, refused } = run(
      [{ docNo: "GR-004982", dtlKey: "859119", itemKey: "AMN-SF9050 SOFA", fromDocNo: "PO-009024" }],
      [
        { dtlKey: "829688", itemKey: "AMN-SF9050 SOFA", qty: "1.0000", unitPrice: "0.0000" },
        { dtlKey: "829690", itemKey: "AMN-SF9050 SOFA", qty: "1.0000", unitPrice: "0.0000" },
      ],
      new Map([["829688", ` ${same}`], ["829690", same], ["859119", same]]),
    );
    expect(pairs).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(refused[0].grDtlKey).toBe("859119");
    expect(refused[0].why).toMatch(/2 order lines? carry this item code/);
  });

  it("REFUSES when the receipt line's build text matches none of the candidates", () => {
    const { pairs, refused } = run(
      [{ docNo: "GR-004940", dtlKey: "853759", itemKey: "AMN-SF9050 SOFA", fromDocNo: "PO-009024" }],
      [
        { dtlKey: "829688", itemKey: "AMN-SF9050 SOFA", qty: "1.0000", unitPrice: "0.0000" },
        { dtlKey: "829690", itemKey: "AMN-SF9050 SOFA", qty: "1.0000", unitPrice: "0.0000" },
      ],
      new Map([["829688", "bottom to Nilon"], ["829690", "bottom to Nilon"],
               ["853759", "bottom to Nilon 1EFL+1NA+CNR+1EFR"]]),
    );
    expect(pairs).toEqual([]);
    expect(refused[0].why).toMatch(/build text/);
  });

  it("REFUSES a receipt line whose item code is not on the order at all", () => {
    const { pairs, refused } = run([
      { docNo: "GR-004939", dtlKey: "853738", itemKey: "SOMETHING-ELSE", fromDocNo: "PO-009081" },
    ]);
    expect(pairs).toEqual([]);
    expect(refused[0].why).toMatch(/no line of this item code/);
  });

  it("REFUSES when the book names a purchase order the snapshot does not hold", () => {
    /* Called directly: `run` registers whatever order the lines name, and this
       case is about an order the snapshot does NOT hold. */
    const { pairs, refused } = matchGrLinesToPoLines({
      grLines: [{ docNo: "GR-004939", dtlKey: "853738", itemKey: "HOK-1030 (HF)(W) (Q)", fromDocNo: "PO-999999" }],
      poLinesByDoc: new Map([["PO-009081", PO_009081]]),
      desc2: DESC2,
    });
    expect(pairs).toEqual([]);
    expect(refused[0].why).toMatch(/not in the snapshot/);
  });

  it("REFUSES both sides when two receipt lines land on ONE order line", () => {
    /* Same build text on both receipt lines and only one candidate carrying it:
       a partial receipt would be legitimate, but so would a mis-read, and this
       matcher may not tell them apart. Refuse both rather than pick. */
    const { pairs, refused } = run(
      [
        { docNo: "GR-A", dtlKey: "1", itemKey: "X", fromDocNo: "PO-009081" },
        { docNo: "GR-B", dtlKey: "2", itemKey: "X", fromDocNo: "PO-009081" },
      ],
      [
        { dtlKey: "10", itemKey: "X", qty: "1.0000", unitPrice: "0.0000" },
        { dtlKey: "11", itemKey: "X", qty: "1.0000", unitPrice: "0.0000" },
      ],
      new Map([["10", "RED"], ["11", "BLUE"], ["1", "RED"], ["2", "RED"]]),
    );
    expect(pairs).toEqual([]);
    expect(refused).toHaveLength(2);
    expect(refused[0].why).toMatch(/same order line/);
  });

  it("compares build text on content, not on spacing or case", () => {
    const { pairs } = run(
      [{ docNo: "GR-X", dtlKey: "5", itemKey: "X", fromDocNo: "PO-009081" }],
      [
        { dtlKey: "10", itemKey: "X", qty: "1.0000", unitPrice: "0.0000" },
        { dtlKey: "11", itemKey: "X", qty: "1.0000", unitPrice: "0.0000" },
      ],
      new Map([["10", "col: PC151-10"], ["11", "col: PC151-12"], ["5", "  COL:   pc151-12  "]]),
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].poDtlKey).toBe("11");
  });
});
