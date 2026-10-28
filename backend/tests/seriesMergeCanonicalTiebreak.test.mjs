/* Two tools, one fabric library, opposite directions.

   `normalize-fabric-codes` canonicalises a colour and merged six LAMB VELVET
   colours into the HYPHEN form on production on 2026-08-14, verified.
   `merge-duplicate-fabric-series` picks its winner by live references — the
   owner's ruling of 2026-08-11, 合并，按引用数多的那边 — and both sides of that
   pair carry ZERO live lines. On a 0–0 tie it fell through to "more colours",
   which kept the SPACE form. Applying it would have undone the colour merge,
   and the next colour run would have undone that: a loop with no fixed point.

   The owner's rule is not being changed. It decides first and still does. What
   is added is the tie-break his rule is silent about: when references tie, the
   side already spelled the way lib/fabric-code.mjs spells it wins. That is the
   rule the COLOUR merger has always had ("the row already carrying the
   canonical id wins outright"); the series merger never got it.

   A vitest file, not node:test: #2180 converted the seventeen node:test
   files because their runs contribute nothing to the merged coverage report,
   so twelve genuinely-tested modules read as untested. It runs in the light
   project, where it is MEASURED. */
import { test } from "vitest";
import assert from "node:assert/strict";
import { seriesToken } from "../scripts/lib/fabric-code.mjs";

/** The picker, exactly as merge-duplicate-fabric-series.mjs computes it. */
function decide(a, b, ra, rb, ca, cb) {
  const aCanon = seriesToken(a) === a, bCanon = seriesToken(b) === b;
  const aWins = ra !== rb ? ra > rb
    : aCanon !== bCanon ? aCanon
    : ca !== cb ? ca > cb
    : a.length <= b.length;
  return aWins ? { keep: a, drop: b } : { keep: b, drop: a };
}

test("the owner's rule decides first: more live references wins, canonical or not", () => {
  /* The non-canonical spelling holding the production lines still wins —
     moving the fewest live rows is the point, and this must not change. */
  assert.deepEqual(decide("LAMB VELVET", "LAMB-VELVET", 5, 0, 1, 9), { keep: "LAMB VELVET", drop: "LAMB-VELVET" });
  assert.deepEqual(decide("LAMB-VELVET", "LAMB VELVET", 0, 5, 9, 1), { keep: "LAMB VELVET", drop: "LAMB-VELVET" });
});

test("on a reference tie the canonical spelling wins, whichever side it is on", () => {
  /* The real numbers: 0 live lines both sides, space form 7 colours, hyphen 6.
     Colour count alone would have kept the space form. */
  assert.deepEqual(decide("LAMB VELVET", "LAMB-VELVET", 0, 0, 7, 6), { keep: "LAMB-VELVET", drop: "LAMB VELVET" });
  assert.deepEqual(decide("LAMB-VELVET", "LAMB VELVET", 0, 0, 6, 7), { keep: "LAMB-VELVET", drop: "LAMB VELVET" });
});

test("colour count still decides when neither side is canonical", () => {
  const r = decide("FABRIC HR805", "HR805 FABRIC", 0, 0, 9, 2);
  assert.equal(seriesToken("FABRIC HR805") === "FABRIC HR805", false, "premise: neither side is canonical");
  assert.equal(seriesToken("HR805 FABRIC") === "HR805 FABRIC", false, "premise: neither side is canonical");
  assert.equal(r.keep, "FABRIC HR805", "with no canonical side, the larger colour set wins as before");
});

test("this keeps the two tools pointing the same way", () => {
  /* The property that matters: whatever the series merger keeps on a tie must
     be what the colour canonicaliser would produce. Otherwise each run undoes
     the last, which is what was about to happen on production. */
  for (const [a, b] of [["LAMB VELVET", "LAMB-VELVET"], ["ARMANI J9226", "J9226"]]) {
    const { keep } = decide(a, b, 0, 0, 1, 1);
    assert.equal(seriesToken(keep), keep, `${keep} is kept but is not what fabric-code.mjs would write`);
  }
});
