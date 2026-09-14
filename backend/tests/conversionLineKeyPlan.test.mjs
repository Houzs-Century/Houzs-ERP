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
    expect(t).toEqual({ stamp: 2, already_correct: 0, disagrees: 1, no_source_key: 0, source_not_in_book: 0, ambiguous_in_book: 0 });
  });
});
