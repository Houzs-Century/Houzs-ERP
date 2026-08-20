import { describe, expect, test } from "vitest";
import {
  lineTupleKey,
  docLineMultisetKey,
  lineMultisetMatchPct,
  isSiblingShape,
  dateGapDays,
  classifyDocPair,
  pairDuplicateCandidates,
  mrpInflationForBuckets,
} from "../scripts/lib/duplicate-docs-core.mjs";

// The 2990-PO-2606-023 / -024 incident, held still: same supplier, same date,
// same MAKOTO OLIVE x5 + BRONZE x5 at RM2,650/line — 023 never received, 024
// received AND shipped. The detector must (a) fingerprint them as
// LIKELY-DUPLICATE, (b) risk-rank the unexecuted-vs-executed shape FIRST, and
// (c) tell a Q-vs-K sibling buy apart from a duplicate.

const makoto = (code: string) => ({ itemCode: code, variantKey: "", qty: 5, unitPriceSen: 265000 });
const pair023 = {
  id: "023", docNo: "2990-PO-2606-023", date: "2026-06-24", executed: false,
  lines: [makoto("MAKOTO-OLIVE"), makoto("MAKOTO-BRONZE")],
};
const pair024 = {
  id: "024", docNo: "2990-PO-2606-024", date: "2026-06-24", executed: true,
  lines: [makoto("MAKOTO-OLIVE"), makoto("MAKOTO-BRONZE")],
};

describe("multiset fingerprint", () => {
  test("order-insensitive: the same lines in any order share one key", () => {
    expect(docLineMultisetKey([makoto("A"), makoto("B")]))
      .toBe(docLineMultisetKey([makoto("B"), makoto("A")]));
  });

  test("qty and price are part of the identity", () => {
    expect(docLineMultisetKey([makoto("A")]))
      .not.toBe(docLineMultisetKey([{ ...makoto("A"), qty: 4 }]));
    expect(docLineMultisetKey([makoto("A")]))
      .not.toBe(docLineMultisetKey([{ ...makoto("A"), unitPriceSen: 265001 }]));
  });

  test("match pct counts multiplicity against the larger side", () => {
    expect(lineMultisetMatchPct(pair023.lines, pair024.lines)).toBe(1);
    expect(lineMultisetMatchPct([makoto("A"), makoto("B")], [makoto("A")])).toBe(0.5);
    expect(lineMultisetMatchPct([], [])).toBe(0);
  });

  test("normalises code case/space so a hand-keyed twin still matches", () => {
    expect(lineTupleKey({ itemCode: " makoto-olive ", variantKey: "", qty: 5, unitPriceSen: 1 }))
      .toBe(lineTupleKey({ itemCode: "MAKOTO-OLIVE", variantKey: "", qty: 5, unitPriceSen: 1 }));
  });
});

describe("sibling shape (Q-vs-K legitimacy)", () => {
  test("same qty+price multiset with fully disjoint codes is a sibling", () => {
    expect(isSiblingShape(
      [{ itemCode: "ANGGN-Q", variantKey: "", qty: 10, unitPriceSen: 90000 }],
      [{ itemCode: "ANGGN-K", variantKey: "", qty: 10, unitPriceSen: 90000 }],
    )).toBe(true);
  });

  test("any shared code disqualifies the sibling shape", () => {
    expect(isSiblingShape(
      [makoto("MAKOTO-OLIVE"), makoto("X")],
      [makoto("MAKOTO-OLIVE"), makoto("Y")],
    )).toBe(false);
  });

  test("different qty/price multisets are not siblings", () => {
    expect(isSiblingShape(
      [{ itemCode: "A", variantKey: "", qty: 1, unitPriceSen: 1 }],
      [{ itemCode: "B", variantKey: "", qty: 2, unitPriceSen: 1 }],
    )).toBe(false);
  });
});

describe("pair classification + risk order", () => {
  test("the 023/024 shape classifies LIKELY-DUPLICATE at risk 0 (unexecuted twin of an executed doc)", () => {
    const { verdict, risk } = classifyDocPair({
      matchPct: 1, sibling: false, gapDays: 0, aExecuted: false, bExecuted: true,
    });
    expect(verdict).toBe("LIKELY-DUPLICATE");
    expect(risk).toBe(0);
  });

  test("both-executed duplicates rank second (physical double-execution needs eyes on goods)", () => {
    expect(classifyDocPair({ matchPct: 1, sibling: false, gapDays: 1, aExecuted: true, bExecuted: true }).risk).toBe(1);
  });

  test("an exact match OUTSIDE the window is not LIKELY-DUPLICATE", () => {
    expect(classifyDocPair({ matchPct: 1, sibling: false, gapDays: 9, aExecuted: false, bExecuted: true }).verdict)
      .toBe("NEEDS-EYES");
  });

  test("pairDuplicateCandidates finds 023/024 and sorts the unexecuted-of-executed first", () => {
    const sibling1 = { id: "s1", docNo: "PO-S1", date: "2026-06-24", executed: true, lines: [{ itemCode: "Q", variantKey: "", qty: 1, unitPriceSen: 5 }] };
    const sibling2 = { id: "s2", docNo: "PO-S2", date: "2026-06-25", executed: true, lines: [{ itemCode: "K", variantKey: "", qty: 1, unitPriceSen: 5 }] };
    const out = pairDuplicateCandidates([pair023, pair024, sibling1, sibling2], { windowDays: 3 });
    expect(out).toHaveLength(2);
    expect(out[0].verdict).toBe("LIKELY-DUPLICATE");
    expect([out[0].a.docNo, out[0].b.docNo].sort()).toEqual(["2990-PO-2606-023", "2990-PO-2606-024"]);
    expect(out[1].verdict).toBe("SIBLING-LEGIT");
  });

  test("far-apart or low-overlap pairs never surface", () => {
    const far = { ...pair024, id: "far", docNo: "PO-FAR", date: "2026-07-24" };
    expect(pairDuplicateCandidates([pair023, far], { windowDays: 3 })).toHaveLength(0);
  });

  test("dateGapDays is symmetric and null on garbage", () => {
    expect(dateGapDays("2026-06-24", "2026-06-26")).toBe(2);
    expect(dateGapDays("2026-06-26", "2026-06-24")).toBe(2);
    expect(dateGapDays(null, "2026-06-24")).toBeNull();
  });
});

describe("(I) MRP supply inflation from an unexecuted duplicate", () => {
  test("shortage hidden by the suspect = shortage without minus shortage with", () => {
    // The 023 shape: demand 6, stock 1, incoming 10 of which ALL 10 are the
    // suspect's phantom open qty -> with: no shortage; without: shortage 5.
    const [r] = mrpInflationForBuckets([{
      bucket: "2990 MAKOTO-OLIVE", demandQty: 6, stockQty: 1, supplyQty: 10, suspectOpenQty: 10,
    }]);
    expect(r.shortageWith).toBe(0);
    expect(r.shortageWithout).toBe(5);
    expect(r.shortageHiddenBySuspect).toBe(5);
  });

  test("a suspect whose bucket has surplus either way hides nothing", () => {
    const [r] = mrpInflationForBuckets([{
      bucket: "b", demandQty: 2, stockQty: 5, supplyQty: 4, suspectOpenQty: 4,
    }]);
    expect(r.shortageHiddenBySuspect).toBe(0);
  });
});
