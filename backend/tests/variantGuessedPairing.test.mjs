/* The reconcile reported four fabric colours on two delivery orders as an exact
 * SWAP for two days (docs/bugs/0689, then 0709). Nothing had swapped them: the
 * ERP rows carried no AutoCount line number, so the checker had to GUESS which
 * of our rows answers which of the book's, and a guess between two rows that
 * differ only in colour produces a "swap" half the time.
 *
 * `foldGuessedPairing` is that declaration, applied to the variant axes — the
 * document-level reconcile already made it on the item-code axis as
 * `same-goods`. These tests pin the three clauses that keep it from swallowing
 * a real difference, because a column that turns differences into "not work" is
 * exactly the shape of docs/bugs/0668, where a hand-typed label printed 30 real
 * gaps as owner decisions.
 *
 * PROVED RED on the unfixed tree: with clause 1 (two unkeyed rows) removed,
 * "one keyed row leaves the bucket forced" fails; with clause 3 (equal
 * multisets) removed, "a bucket whose sets differ keeps every difference" and
 * "an ERP blank is not a transposition" fail.
 */
import { describe, it, expect } from "vitest";

import {
  AGREE, DIFFER, ERP_BLANK, NO_LINE_KEY, FOLDABLE_AXES, foldGuessedPairing,
} from "../scripts/lib/variant-reconcile.mjs";

/** One entry, shaped the way check-ac-erp-reconcile.mjs builds it. */
const entry = (bucket, keyed, axes) => ({ bucket, keyed, axes });

/** A colour cell: what the verdict was, and the two canonical identities. */
const colour = (verdict, bookId, erpId) => ({ verdict, bookId, erpId, detail: "" });

const verdicts = (es, axis = "colour") => es.map((e) => e.axes[axis].verdict);

describe("foldGuessedPairing", () => {
  it("folds the production case: two unkeyed rows of one item, colours transposed", () => {
    /* DO-011496: two TRION (A) (HB STR)-(K) at quantity 1, book PC151-02 and
       PC151-03, ERP PC151-03 and PC151-02. Measured on reconcile run
       34206269750, 2026-09-08 16:45 +08. */
    const es = [
      entry("DO-011496|TRION (A) (HB STR)-(K)|1", false, { colour: colour(DIFFER, "PC151|PC151-02", "PC151|PC151-03") }),
      entry("DO-011496|TRION (A) (HB STR)-(K)|1", false, { colour: colour(DIFFER, "PC151|PC151-03", "PC151|PC151-02") }),
    ];
    const out = foldGuessedPairing(es);
    expect(out).toEqual({ folded: 2, buckets: 1 });
    expect(verdicts(es)).toEqual([NO_LINE_KEY, NO_LINE_KEY]);
    for (const e of es) expect(e.axes.colour.detail).toMatch(/NO AutoCount line key/);
  });

  it("names both sides' set in the detail, so the reader can check the claim", () => {
    const es = [
      entry("b", false, { colour: colour(DIFFER, "PC151|PC151-08", "PC151|PC151-06") }),
      entry("b", false, { colour: colour(DIFFER, "PC151|PC151-06", "PC151|PC151-08") }),
    ];
    foldGuessedPairing(es);
    expect(es[0].axes.colour.detail).toContain("PC151|PC151-06, PC151|PC151-08");
  });

  it("ONE keyed row leaves the bucket FORCED — the last row is settled by elimination", () => {
    const es = [
      entry("b", true, { colour: colour(AGREE, "X", "X") }),
      entry("b", false, { colour: colour(DIFFER, "A", "B") }),
      entry("b", false, { colour: colour(DIFFER, "B", "A") }),
    ];
    /* Two of the three are unkeyed, so this one DOES fold. */
    expect(foldGuessedPairing(es).folded).toBe(2);

    const forced = [
      entry("c", true, { colour: colour(DIFFER, "A", "B") }),
      entry("c", false, { colour: colour(DIFFER, "B", "A") }),
    ];
    expect(foldGuessedPairing(forced)).toEqual({ folded: 0, buckets: 0 });
    expect(verdicts(forced)).toEqual([DIFFER, DIFFER]);
  });

  it("a bucket whose two sets DIFFER keeps every one of its differences", () => {
    /* A PARTIAL cover is not a cover. The ERP holds PC151-02 twice where the
       book orders one of each: one customer really is getting the wrong fabric,
       and no pairing can make that true or false. */
    const es = [
      entry("b", false, { colour: colour(DIFFER, "PC151-02", "PC151-02") }),
      entry("b", false, { colour: colour(DIFFER, "PC151-03", "PC151-02") }),
    ];
    expect(foldGuessedPairing(es)).toEqual({ folded: 0, buckets: 0 });
    expect(verdicts(es)).toEqual([DIFFER, DIFFER]);
  });

  it("an ERP blank is not a transposition — the sets cannot be equal", () => {
    const es = [
      entry("b", false, { colour: colour(ERP_BLANK, "A", null) }),
      entry("b", false, { colour: colour(DIFFER, "B", "A") }),
    ];
    expect(foldGuessedPairing(es).folded).toBe(0);
    expect(verdicts(es)).toEqual([ERP_BLANK, DIFFER]);
  });

  it("a single row in a bucket cannot be transposed with anything", () => {
    const es = [entry("b", false, { colour: colour(DIFFER, "A", "B") })];
    expect(foldGuessedPairing(es)).toEqual({ folded: 0, buckets: 0 });
    expect(verdicts(es)).toEqual([DIFFER]);
  });

  it("rows in DIFFERENT buckets are not candidates for each other", () => {
    /* Different products, so the pairing never had a choice to make between
       them — this is the cross-product pairing the fallback CAN still do, and
       folding it would hide a genuinely wrong colour. */
    const es = [
      entry("doc|FENRIR-(Q)|1", false, { colour: colour(DIFFER, "A", "B") }),
      entry("doc|CODY-(Q)|1", false, { colour: colour(DIFFER, "B", "A") }),
    ];
    expect(foldGuessedPairing(es)).toEqual({ folded: 0, buckets: 0 });
    expect(verdicts(es)).toEqual([DIFFER, DIFFER]);
  });

  it("folds every scalar axis, and NEVER compartments or specials", () => {
    expect(FOLDABLE_AXES).toEqual(["colour", "divan", "gap", "leg", "totalHeight", "seat"]);
    expect(FOLDABLE_AXES).not.toContain("compartments");
    expect(FOLDABLE_AXES).not.toContain("specials");

    /* DO-011446, same run: gap 10" against 12" and T.Heights 22" against 24",
       both ways round, on one refused VICTORIA-(SS) bucket. */
    const es = [
      entry("DO-011446|VICTORIA-(SS)|1", false, {
        gap: { verdict: DIFFER, bookId: "10", erpId: "12", detail: "" },
        totalHeight: { verdict: DIFFER, bookId: "22", erpId: "24", detail: "" },
        compartments: { verdict: DIFFER, bookId: null, erpId: null, detail: "" },
      }),
      entry("DO-011446|VICTORIA-(SS)|1", false, {
        gap: { verdict: DIFFER, bookId: "12", erpId: "10", detail: "" },
        totalHeight: { verdict: DIFFER, bookId: "24", erpId: "22", detail: "" },
        compartments: { verdict: DIFFER, bookId: null, erpId: null, detail: "" },
      }),
    ];
    expect(foldGuessedPairing(es).folded).toBe(4);
    expect(verdicts(es, "gap")).toEqual([NO_LINE_KEY, NO_LINE_KEY]);
    expect(verdicts(es, "totalHeight")).toEqual([NO_LINE_KEY, NO_LINE_KEY]);
    expect(verdicts(es, "compartments")).toEqual([DIFFER, DIFFER]);
  });

  it("an axis that applies to only SOME rows of a bucket is left alone", () => {
    /* A bag over an axis half the bucket does not have is not a bag over the
       bucket, so it cannot prove anything about the pairing. */
    const es = [
      entry("b", false, { colour: colour(DIFFER, "A", "B") }),
      entry("b", false, {}),
    ];
    expect(foldGuessedPairing(es).folded).toBe(0);
  });

  it("TOTAL PRESERVATION: only DIFFER moves, and only into NO_LINE_KEY", () => {
    const es = [
      entry("b", false, { colour: colour(DIFFER, "A", "B") }),
      entry("b", false, { colour: colour(DIFFER, "B", "A") }),
      entry("b", false, { colour: colour(AGREE, "C", "C") }),
      entry("b", false, { colour: colour(AGREE, "D", "D") }),
    ];
    /* The four bags are {A,B,C,D} both sides, so the two DIFFERs fold and the
       two AGREEs are untouched — a fold never invents or destroys a row. */
    const before = es.length;
    const out = foldGuessedPairing(es);
    expect(out.folded).toBe(2);
    expect(es.length).toBe(before);
    expect(verdicts(es).filter((v) => v === NO_LINE_KEY)).toHaveLength(2);
    expect(verdicts(es).filter((v) => v === AGREE)).toHaveLength(2);
    expect(verdicts(es).filter((v) => v === DIFFER)).toHaveLength(0);
  });

  it("is idempotent — a second fold finds nothing left to move", () => {
    const es = [
      entry("b", false, { colour: colour(DIFFER, "A", "B") }),
      entry("b", false, { colour: colour(DIFFER, "B", "A") }),
    ];
    expect(foldGuessedPairing(es).folded).toBe(2);
    expect(foldGuessedPairing(es)).toEqual({ folded: 0, buckets: 0 });
  });
});
