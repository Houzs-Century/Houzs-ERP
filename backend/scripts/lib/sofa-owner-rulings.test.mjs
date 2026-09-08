/**
 * THE OWNER'S RULINGS, AND THE FOUR WAYS READING THEM COULD GO WRONG.
 *
 * `sofa-owner-rulings.mjs` exists so the reconcile stops reporting a build the
 * owner has already decided as an open difference (docs/bugs/0714). The danger
 * of that fix is entirely in the other direction: a lookup that is too eager
 * marks a line DECIDED that nobody decided, and a decided line does not lock,
 * which OPENS a migrated order that does not match anything. So every test here
 * is about the lookup REFUSING:
 *
 *   · a ruling for another document must not reach this one;
 *   · a ruling for another BUILD on the same document must not reach this line;
 *   · two rulings reaching one line and disagreeing must yield NOTHING;
 *   · a `_held` build — one the operator deliberately did not write — must not
 *     be indexed at all.
 *
 * The one positive test is that the needle is matched the way
 * lib/sofa-desc2-match.mjs matches it, so a slip re-keyed with a curly quote or
 * a doubled space still finds its ruling. That normalisation was bought at full
 * price on 2026-09-02: seven owner-approved builds silently dropped.
 *
 * Zero dependencies: `node --test scripts/lib/*.test.mjs` runs this on a bare
 * checkout, which is what .github/workflows/working-agreement.yml does.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { bagKey, buildRulingIndex, rulingFor } from "./sofa-owner-rulings.mjs";
import { readCorrectionsDoc } from "./sofa-corrections-source.mjs";

const BUILDS = [
  {
    docs: ["HC-SO-013327", "HC-PO-009900"], model: "8069",
    pieces: ["1A(LHF)", "2A(RHF)", "1B(RHF)"],
    desc2Match: "Col : HR805-20", why: "photo: the slip draws three boxes",
  },
  {
    docs: ["HC-SO-013164"], model: "8030", pieces: ["2S", "CNR"],
    desc2Match: "2+C+2NA+C TABLE(28'INCH)", why: "photo A",
  },
  {
    docs: ["HC-SO-013164"], model: "8030", pieces: ["1S"],
    desc2Match: "C TABLE(W)+2(28'INCH)", why: "photo B",
  },
];

const IDX = buildRulingIndex(BUILDS);

test("a ruling reaches only the documents it names", () => {
  const hit = rulingFor(IDX, { erpDocNo: "HC-SO-013327", model: "8069", bookDesc2: "Col : HR805-20 Nilon bottom" });
  assert.equal(hit.verdict, "one");
  assert.deepEqual(hit.ruling.pieces, ["1A(LHF)", "2A(RHF)", "1B(RHF)"]);

  const other = rulingFor(IDX, { erpDocNo: "HC-SO-999999", model: "8069", bookDesc2: "Col : HR805-20 Nilon bottom" });
  assert.equal(other.verdict, "none", "a ruling must never reach a document it does not name");
  assert.equal(other.ruling, null);
});

test("a ruling for the other build on the same document does NOT reach this line", () => {
  /* HC-SO-013164 carries two builds whose needles are the pair
     lib/sofa-desc2-match.mjs measured as the case that must keep refusing to
     see itself in the other. */
  const a = rulingFor(IDX, { erpDocNo: "HC-SO-013164", model: "8030", bookDesc2: "2+C+2NA+C TABLE(28'INCH) COL: X" });
  assert.equal(a.verdict, "one");
  assert.deepEqual(a.ruling.pieces, ["2S", "CNR"]);

  const b = rulingFor(IDX, { erpDocNo: "HC-SO-013164", model: "8030", bookDesc2: "C TABLE(W)+2(28'INCH) COL: X" });
  assert.equal(b.verdict, "one");
  assert.deepEqual(b.ruling.pieces, ["1S"], "the second build's own ruling, not the first's");

  const neither = rulingFor(IDX, { erpDocNo: "HC-SO-013164", model: "8030", bookDesc2: "3S(28 INCH) COL: X" });
  assert.equal(neither.verdict, "none", "a third build on the document is governed by no ruling at all");
});

test("the model narrows a ruling: a bedframe line on the same document is not reached", () => {
  const wrong = rulingFor(IDX, { erpDocNo: "HC-SO-013327", model: "9058", bookDesc2: "Col : HR805-20 Nilon bottom" });
  assert.equal(wrong.verdict, "none");
});

test("two rulings that reach one line and DISAGREE yield nothing — never a choice", () => {
  const clashing = buildRulingIndex([
    { docs: ["HC-SO-000001"], model: "8030", pieces: ["1S"], desc2Match: "COL: X" },
    { docs: ["HC-SO-000001"], model: "8030", pieces: ["2S", "CNR"], desc2Match: "COL: X" },
  ]);
  const hit = rulingFor(clashing, { erpDocNo: "HC-SO-000001", model: "8030", bookDesc2: "COL: X and more" });
  assert.equal(hit.verdict, "ambiguous");
  assert.equal(hit.ruling, null, "an ambiguous lookup must hand back NO piece list");
});

test("two rulings that reach one line and AGREE are not ambiguous", () => {
  const same = buildRulingIndex([
    { docs: ["HC-SO-000002"], model: "8030", pieces: ["1S", "CNR"], desc2Match: "COL: X" },
    { docs: ["HC-SO-000002"], model: "8030", pieces: ["CNR", "1S"], desc2Match: "COL: X" },
  ]);
  const hit = rulingFor(same, { erpDocNo: "HC-SO-000002", model: "8030", bookDesc2: "COL: X" });
  assert.equal(hit.verdict, "one", "piece ORDER is not a disagreement — the build is a multiset");
});

test("the needle survives a re-keyed slip: curly quotes, doubled spaces, written \\n", () => {
  const idx = buildRulingIndex([
    { docs: ["HC-SO-000003"], model: "8030", pieces: ["1S"], desc2Match: "Size:30\\nCol: MODENZA 05- DARK" },
  ]);
  const hit = rulingFor(idx, {
    erpDocNo: "HC-SO-000003", model: "8030",
    bookDesc2: "Size:30\nCol:  MODENZA 05‐ DARK OLIVE",
  });
  assert.equal(hit.verdict, "one", "a real newline, a doubled space and a U+2010 dash are all noise");
});

test("a _held build is never indexed — the ERP does not carry it", () => {
  const doc = {
    corrections: [{ docs: ["HC-SO-000004"], model: "8030", pieces: ["1S"] }],
    _held: [{ docs: ["HC-SO-000005"], model: "8030", pieces: ["2S"], why: "the drawing is unreadable" }],
  };
  const { builds, held } = readCorrectionsDoc(doc, "test.json");
  assert.equal(held.length, 1, "the loader still surfaces held builds for the operator's log");
  const idx = buildRulingIndex(builds);
  assert.equal(rulingFor(idx, { erpDocNo: "HC-SO-000004", model: "8030" }).verdict, "one");
  assert.equal(
    rulingFor(idx, { erpDocNo: "HC-SO-000005", model: "8030" }).verdict, "none",
    "a build deliberately NOT written must never mark a line decided",
  );
});

test("an entry with no pieces is not a ruling", () => {
  const idx = buildRulingIndex([{ docs: ["HC-SO-000006"], model: "8030", pieces: [] }]);
  assert.equal(rulingFor(idx, { erpDocNo: "HC-SO-000006", model: "8030" }).verdict, "none");
});

test("bagKey is order- and case-insensitive, which is what tells two rulings apart", () => {
  assert.equal(bagKey(["CNR", "1s"]), bagKey(["1S", "cnr"]));
  assert.notEqual(bagKey(["1S"]), bagKey(["2S"]));
});
