/**
 * THE SHOP-FLOOR SHORTHAND, PINNED.
 *
 * `parse-sofa.mjs` turns an AutoCount Desc2 string into ERP compartments, and
 * almost every arm in it is an owner ruling written down. This file pins the
 * two he gave on 2026-09-05, because they are the pair that had already been
 * decoded the WRONG way round on a live document:
 *
 *   「1ELT 就是L来的」  the slip token `1ELT` IS the chaise, `L`
 *   「1Abox 是1NALT」   the piece `1ABOX` is spelled `1NALT` on a slip
 *
 * On 2026-08-10 `(1 ELT / T + NA +2ER)` was read as `1ABOX(LHF) + 1NA +
 * 2A(RHF)` — from the SPELLING, with no rule behind it — and
 * fix-modenza-label-and-5526-pieces.mjs minted `5526-1ABOX(LHF)` so that
 * reading could be written onto HC-SO-000814 and HC-PO-000254. The two tokens
 * are not interchangeable, and the third test below is why the mistake was
 * possible at all: on the REAL string the parser answers nothing, so there was
 * no decoder output to contradict the guess.
 *
 * Zero dependencies — `node --test scripts/lib/*.test.mjs` runs this on a bare
 * checkout, which is what .github/workflows/working-agreement.yml does.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseSofa } from "./parse-sofa.mjs";

test("1ELT is the chaise L, sided by position (owner 2026-09-05)", () => {
  const got = parseSofa('[ (1 ELT + NA + 2ER) (28") / COL: J9883-1-1 PAMA]', "5526", false);
  assert.deepEqual(got.pieces, ["L(LHF)", "1NA", "2A(RHF)"]);
  assert.equal(got.conf, "high");
  assert.equal(got.size, "28");
  /* A bare `L` in the same position reaches the same piece — 1ELT is a
     spelling of it, not a piece of its own. */
  assert.deepEqual(parseSofa('[ (L + NA + 2ER) (28") ]', "5526", false).pieces, got.pieces);
});

test("1ABOX is what 1NALT decodes to — a DIFFERENT token from 1ELT", () => {
  const got = parseSofa('[ (1NALT + NA + 2ER) (28") ]', "5526", false);
  assert.deepEqual(got.pieces, ["1ABOX(LHF)", "1NA", "2A(RHF)"]);
  assert.equal(got.conf, "high");
  /* The right-hand spelling is the mirror. */
  assert.deepEqual(parseSofa('[ (2EL + NA + 1NART) (28") ]', "5526", false).pieces.at(-1), "1ABOX(RHF)");
});

test("the real HC-SO-000814 text decodes to NOTHING, which is why a data file corrects it", () => {
  /* Byte-for-byte what scm.mfg_sales_order_items.description2 holds, measured
     on prod 2026-09-05. The stray `/ T` splits the structure across segments,
     so the parser refuses rather than guessing — and a build it refuses is a
     build somebody has to answer by hand, in
     scripts/data/sofa-compartment-corrections-*.json. */
  const got = parseSofa('[ (1 ELT / T + NA +2ER) (28") / COL: J9883-1-1 PAMA]', "5526", false);
  assert.deepEqual(got.pieces, []);
  assert.equal(got.conf, "low");
  /* It still reads the attributes it CAN read. */
  assert.equal(got.size, "28");
  assert.equal(got.color, "J9883-1-1 PAMA");
});

/* ── the mill's own name for a shade is not a special order ─────────────────
 * Measured over all 1,979 distinct sofa Desc2 in the committed 2026-09-08
 * snapshot: 49 of them carry a bracketed word right after a fabric code that
 * the rider rule turned into a SPECIAL ORDER. 48 are the mill's name for the
 * shade — PEARL, FOSSIL, SAND, DARK GREY — and 1 is a real instruction,
 * "(PLS FOLLOW DRAWING)". Seven of the 48 reached the owner's go-live backlog
 * as "the book states a special this line does not carry".
 *
 * `knownColour` is the LIVE fabric library, so the guard only ever fires on a
 * bracket attached to a code the library confirms. The stub below stands in
 * for it; docs/bugs/0703 carries the evidence.
 */
const LIB = new Set([
  "BO315-26", "BO315-25", "BO315-21", "BO315-22", "BO315-23", "M2402-5", "M2402-19", "NX011", "TR01",
  "CH141-12", "BO315-32", "HARRING GD8371",
]);
const knownColour = (t) => (LIB.has(String(t).trim().toUpperCase()) ? String(t).trim().toUpperCase() : null);

test("a bracketed trade name after a library-confirmed code is the COLOUR, not a special", () => {
  for (const [d2, colour] of [
    ['BO315-26 (YELLOW)/28"/2L', "BO315-26"],
    ['BO315-25 (FOSSIL)/28"/3S', "BO315-25"],
    ['NX011 (BEIGE)/30"/2L', "NX011"],
    ['BO315-21(PEARL)/3S/35"', "BO315-21"],
    ['M2402-19(DARK GREY)/3RR/60cm', "M2402-19"],
    ['M2402-5 (Light Brown)/28"/2S', "M2402-5"],
    ['CH141-12 (METAL)/28"/2L', "CH141-12"],
    ['BO315-32 (DEEP GREY)/35"/1S', "BO315-32"],
    ['TR01 (RUMMA) / 2S / 60cm', "TR01"],
  ]) {
    for (const recl of [false, true]) {
      const got = parseSofa(d2, "9028", recl, { knownColour });
      assert.equal(got.color, colour, `${d2} colour`);
      assert.deepEqual(got.specials, [], `${d2} specials (recl=${recl})`);
    }
  }
});

test("a bracketed INSTRUCTION is still a special — the guard is a name test, not a bracket test", () => {
  /* Real book strings that carry BOTH on one line: the shade name has to go
     and the request beside it has to stay. If an assertion here ever goes red
     the guard has widened into dropping real requests, which builds a sofa
     wrong — the expensive direction. */
  for (const [d2, model, survives] of [
    ['BO315-21 (PEARL)/30"/2S ( PLS FOLLOW THE INSTRUCTION )', "9028", /FOLLOW/i],
    ['BO315-22 (FEATHER)/32"/2L(Replace to 9028 headrest)', "9028", /headrest/i],
    ['BO315-23 (BEIGE)/32"/2L (No armrest)', "8030", /armrest/i],
  ]) {
    const got = parseSofa(d2, model, false, { knownColour });
    assert.ok(
      got.specials.some((s) => survives.test(s)),
      `${d2}: the instruction must survive, got ${JSON.stringify(got.specials)}`,
    );
    assert.ok(
      !got.specials.some((s) => /^(PEARL|FEATHER|BEIGE)$/i.test(String(s).replace(/\s+/g, ""))),
      `${d2}: the shade name must not be a special, got ${JSON.stringify(got.specials)}`,
    );
  }
});

test('"25 X 40INCH" is a stool FOOTPRINT, not a seat size', () => {
  /* SO-011756. The book states a stool's length by its width; the seat-size
     axis has nothing to copy, and the ERP's own 30" is not a difference the
     book can settle. Reading 40 off it put a phantom on the go-live tally and
     would have written a length onto a build instruction. */
  const got = parseSofa("STOOL(25 X 40INCH)/COL:KN390-2", "5535", false);
  assert.equal(got.size, null);
  assert.equal(got.color, "KN390-2");
  assert.deepEqual(got.pieces, ["STOOL"]);
});

test('a seat size written with a unit is still read — the footprint guard is narrow', () => {
  assert.equal(parseSofa('HR805-90/28"/3S', "9050", false).size, "28");
  assert.equal(parseSofa('Size:30"/Col:CHINO-01', "5535", false).size, "30");
  assert.equal(parseSofa('TBC/28"/1R+1R', "8030", false).size, "28");
  assert.equal(parseSofa('[ 2EL(28") + STOOL(28")(NO BACK CUSHION) / COL: X', "5526", false).size, "28");
  assert.equal(parseSofa('TR01 (RUMMA) / 2S / 60cm', "9028", false, { knownColour }).size, "24");
});
