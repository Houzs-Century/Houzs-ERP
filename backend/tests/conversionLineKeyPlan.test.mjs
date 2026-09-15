/* docs/bugs/0897 — a delivery order or goods receipt line takes the AutoCount
 * line key the book's own DocTransfer pairs it with, by SOURCE line, never by
 * position or item code. */
import { describe, expect, test } from "vitest";
import {
  IS_REFUSAL,
  IS_WRITE,
  KEY_OUTCOMES,
  planDocumentKeys,
  runSelfTest,
  tallyOutcomes,
} from "../scripts/lib/conversion-line-key-plan.mjs";

/* HC-DO-2609-096 as the book holds it on 2026-09-14: DSL-8030 SOFA 930287 from
   SO line 758395, AMN-SOFA PILLOW 930289 from 758396. */
const BOOK = [
  { toDtlKey: 930287, fromDtlKey: 758395 },
  { toDtlKey: 930289, fromDtlKey: 758396 },
];

describe("planDocumentKeys", () => {
  test("the self-test passes, so the scripts that run it will plan", () => {
    expect(runSelfTest()).toEqual([]);
  });

  test("a sofa's pieces and its pillow each take the line their source line fed", () => {
    const { rows, unclaimedBookLines } = planDocumentKeys([
      { id: "piece-1", linkedKey: null, sourceKey: "758395" },
      { id: "piece-2", linkedKey: null, sourceKey: 758395 },
      { id: "pillow", linkedKey: null, sourceKey: 758396 },
    ], BOOK);
    expect(rows).toEqual([
      { id: "piece-1", outcome: "stamp", dtlKey: 930287, sourceKey: 758395 },
      { id: "piece-2", outcome: "stamp", dtlKey: 930287, sourceKey: 758395 },
      { id: "pillow", outcome: "stamp", dtlKey: 930289, sourceKey: 758396 },
    ]);
    expect(unclaimedBookLines).toEqual([]);
  });

  /* The drain's old check compared item codes, which a conversion copies from
     the SOURCE line. Nothing here reads a code, so a book spelling that differs
     from ours cannot refuse a correct pairing. */
  test("item codes play no part", () => {
    const { rows } = planDocumentKeys([{ id: "a", linkedKey: null, sourceKey: 758396, itemCode: "AKEMI BASTION MATT (Q)" }], BOOK);
    expect(rows[0].outcome).toBe("stamp");
  });

  test("a key already there is confirmed, and a different one is reported and left", () => {
    const { rows } = planDocumentKeys([
      { id: "right", linkedKey: 930289, sourceKey: 758396 },
      { id: "wrong", linkedKey: 930289, sourceKey: 758395 },
    ], BOOK);
    expect(rows.map((r) => r.outcome)).toEqual(["already_correct", "disagrees"]);
  });

  test("no source, a source the document does not hold, and one source on two lines are not written", () => {
    const { rows, unclaimedBookLines } = planDocumentKeys([
      { id: "free-gift", linkedKey: null, sourceKey: null },
      { id: "elsewhere", linkedKey: null, sourceKey: 111 },
      { id: "split", linkedKey: null, sourceKey: 758395 },
    ], [...BOOK, { toDtlKey: 930290, fromDtlKey: 758395 }]);
    expect(rows.map((r) => r.outcome)).toEqual(["no_source_key", "source_not_in_book", "ambiguous_in_book"]);
    expect(rows.every((r) => !IS_WRITE.has(r.outcome))).toBe(true);
    /* No ERP row claimed any book line, so all three are reported as unclaimed. */
    expect(unclaimedBookLines).toEqual([930287, 930289, 930290]);
  });

  test("the outcome sets are consistent and the tally names every outcome", () => {
    for (const o of [...IS_WRITE, ...IS_REFUSAL]) expect(KEY_OUTCOMES).toContain(o);
    const t = tallyOutcomes([{ outcome: "stamp" }, { outcome: "stamp" }, { outcome: "disagrees" }]);
    expect(t).toEqual({ stamp: 2, already_correct: 0, disagrees: 1, no_source_key: 0, source_not_in_book: 0, ambiguous_in_book: 0, stamp_merged: 0 });
  });
});

/* docs/bugs/0915 — HC-GRN-2609-008 as production held it on 2026-09-15. The ERP
   receives DSL-SQUARE PILLOW x3 as ONE row from purchase line 907143; the book
   split that transfer over 928497 x2 and 928499 x1, and holds 928501 x2 from
   907145 beside them. */
const GRN008 = [
  { toDtlKey: 928497, fromDtlKey: 907143, qty: 2, transferredOn: 0 },
  { toDtlKey: 928499, fromDtlKey: 907143, qty: 1, transferredOn: 0 },
  { toDtlKey: 928501, fromDtlKey: 907145, qty: 2, transferredOn: 0 },
];

describe("one ERP row over a transfer the book split", () => {
  test("HC-GRN-2609-008: the x3 row takes the first line, and the x1 line is left unclaimed to be zeroed", () => {
    const { rows, unclaimedBookLines } = planDocumentKeys([
      { id: "pillow-3", linkedKey: null, sourceKey: 907143, qty: 3 },
      { id: "pillow-2", linkedKey: 928501, sourceKey: 907145, qty: 2 },
    ], GRN008);
    expect(rows).toEqual([
      { id: "pillow-3", outcome: "stamp_merged", dtlKey: 928497, sourceKey: 907143 },
      { id: "pillow-2", outcome: "already_correct", dtlKey: 928501, sourceKey: 907145 },
    ]);
    expect(IS_WRITE.has("stamp_merged")).toBe(true);
    expect(unclaimedBookLines).toEqual([928499]);
  });

  test("CONTROL: without quantities (the drain passes none) the split is refused as before", () => {
    const { rows } = planDocumentKeys([{ id: "pillow-3", linkedKey: null, sourceKey: 907143 }], GRN008.map(({ toDtlKey, fromDtlKey }) => ({ toDtlKey, fromDtlKey })));
    expect(rows[0].outcome).toBe("ambiguous_in_book");
  });

  test("CONTROL: quantities that do not add up, two rows on the source, or a line held downstream still refuse", () => {
    const short = planDocumentKeys([{ id: "a", linkedKey: null, sourceKey: 907143, qty: 2 }], GRN008).rows[0].outcome;
    const two = planDocumentKeys([
      { id: "a", linkedKey: null, sourceKey: 907143, qty: 2 },
      { id: "b", linkedKey: null, sourceKey: 907143, qty: 1 },
    ], GRN008).rows.map((r) => r.outcome);
    const held = planDocumentKeys([{ id: "a", linkedKey: null, sourceKey: 907143, qty: 3 }],
      GRN008.map((b) => (b.toDtlKey === 928499 ? { ...b, transferredOn: 1 } : b))).rows[0].outcome;
    expect([short, ...two, held]).toEqual(["ambiguous_in_book", "ambiguous_in_book", "ambiguous_in_book", "ambiguous_in_book"]);
  });
});

/* docs/bugs/0919 — after retire-book-only-conversion-lines zeroed 928499, the
   book holds HC-GRN-2609-008's pillows as 928497 x3 and 928499 x0. */
describe("a book line retired to zero", () => {
  test("HC-GRN-2609-008 after the retire: the keyed row reads as already correct, not ambiguous", () => {
    const { rows, unclaimedBookLines } = planDocumentKeys([{ id: "pillow-3", linkedKey: 928497, sourceKey: 907143, qty: 3 }], [
      { toDtlKey: 928497, fromDtlKey: 907143, qty: 3, transferredOn: 0 },
      { toDtlKey: 928499, fromDtlKey: 907143, qty: 0, transferredOn: 0 },
    ]);
    expect(rows).toEqual([{ id: "pillow-3", outcome: "already_correct", dtlKey: 928497, sourceKey: 907143 }]);
    expect(unclaimedBookLines).toEqual([]);
  });

  test("CONTROL: without quantities a zero line is not recognised, and the split is refused as before", () => {
    const { rows } = planDocumentKeys([{ id: "pillow-3", linkedKey: 928497, sourceKey: 907143 }], [
      { toDtlKey: 928497, fromDtlKey: 907143 },
      { toDtlKey: 928499, fromDtlKey: 907143 },
    ]);
    expect(rows[0].outcome).toBe("ambiguous_in_book");
  });
});
