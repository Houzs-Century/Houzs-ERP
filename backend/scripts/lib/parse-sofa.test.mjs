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
 * bracket attached to a code the library confirms. `docs/bugs/0705` carries the
 * evidence.
 *
 * IT DRIVES THE REAL INDEX, NOT A STUB, AND THAT IS THE WHOLE POINT. The first
 * version of these tests used an exact-match Set, which said the bracketed form
 * does NOT confirm. The real matcher strips brackets on rung 1 of its candidate
 * ladder, so in production it DOES — and the guard, written against the stub's
 * answer, never fired once against the live library (reconcile run
 * 34200092543 reported the same three phantom specials as the run before it).
 * `buildFabricColourIndex` is the same function `check-ac-erp-reconcile.mjs`
 * feeds from `scm.fabric_colours`, so a stub cannot drift from it again.
 */
import { buildFabricColourIndex } from "./fabric-colour-match.mjs";

const { findColour } = buildFabricColourIndex(
  [
    ["BO315", "BO315-21"], ["BO315", "BO315-22"], ["BO315", "BO315-23"], ["BO315", "BO315-25"],
    ["BO315", "BO315-26"], ["BO315", "BO315-32"], ["M2402", "M2402-5"], ["M2402", "M2402-19"],
    ["NX011", "NX011"], ["TR01", "TR01"], ["CH141", "CH141-12"], ["KN390", "KN390-2"],
  ].map(([fabric_id, colour_id]) => ({ fabric_id, colour_id, label: colour_id, active: true })),
);
/* Byte-identical to the reconcile's own knownColour. */
const knownColour = (c) => {
  const h = findColour(c);
  return h ? h.colour_id : null;
};

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

/* ── the colour label must stop where the colour stops ──────────────────────
 *
 * The floor writes a slash-separated Desc2 on most documents, and the colour
 * label is terminated by the next slash. Newer entries (SO-008xxx onward) use a
 * DOUBLE SPACE as the field separator and no slash at all, and `colour :` was
 * written to run to the end of the segment — so on those documents it swallowed
 * every field after it: the build, the specials, and the seat size.
 *
 * Two consequences, both measured on the committed 2026-09-08 snapshot:
 *   - the build vanished and the line fell to the bare `-1S` placeholder;
 *   - the book's own instructions vanished, so the reconcile reported the BOOK
 *     as asking for nothing while the ERP line carried the instruction — the
 *     "book blank" shape on the specials axis.
 *
 * Every string below is verbatim from that snapshot.
 */
test("the colour label stops at the field separator, so the BUILD survives it", () => {
  /* SO-009072 line 1. `1EL + C + 1 NA + 1ER` is the build; it sat inside the
     colour value and the line decoded to nothing at all. */
  const got = parseSofa("colour : HR805 -31 ( 30 inch )  1EL  + C + 1 NA + 1ER", "9058", false);
  assert.deepEqual(got.pieces, ["1A(LHF)", "CNR", "1NA", "1A(RHF)"]);
  assert.notEqual(got.conf, "low");

  /* SO-009073. Same shape, and the instruction after the build must survive
     too — the build is not the end of the segment either. */
  const b = parseSofa("colour : HR805-10 ( 28 inch )  1EL + 1 NA + L  wrap bottom to umbrella fabric", "5536", false);
  assert.deepEqual(b.pieces, ["1A(LHF)", "1NA", "L(RHF)"]);
  assert.ok(b.specials.some((s) => /wrap bottom to umbrella fabric/i.test(s)),
    `the instruction must survive, got ${JSON.stringify(b.specials)}`);
});

test("the colour label stops at the field separator, so the SPECIALS survive it", () => {
  /* SO-010121 / SO-010123 / SO-013384 / SO-013385 — the four PROCEEDED orders
     the 2026-09-08 reconcile reported with the book holding NO specials while
     the ERP line carried them. The book states them; the decoder ate them. */
  for (const [d2, model, want] of [
    ["31 inch  colour : tbc  wrap bottom to umbrella fabric", "8051", /wrap bottom to umbrella fabric/i],
    ["32 inch per seat  colour : B0315-5 Fosil  wrap bottom to umbrella fabric", "9028", /wrap bottom to umbrella fabric/i],
    ["Col : ZL -15 MISTY  fully cover replace the leg  Nilon bottom", "8030", /nilon bottom/i],
    ["Col : ZL-15 MISTY  Nilon bottom  fully cover with one layer back rest change 8030", "9028", /nilon bottom/i],
  ]) {
    const got = parseSofa(d2, model, false);
    assert.ok(got.specials.some((s) => want.test(s)),
      `${d2}: got ${JSON.stringify(got.specials)}`);
    /* And the colour must be the colour, not the colour plus everything after
       it — a value like "tbc  wrap bottom to umbrella fabric" resolves against
       no fabric library and reads as a colour DIFFERENCE against the ERP. */
    assert.ok(!/\s{2,}/.test(String(got.color ?? "")),
      `${d2}: the colour swallowed the tail — ${JSON.stringify(got.color)}`);
  }
});

test("a colour whose own name contains a wide gap is NOT truncated", () => {
  /* SO-006112, verbatim. The tail after the gap is more of the colour, not a
     build and not an instruction, so the value must survive whole — this is the
     regression the narrowing above could have caused. */
  const got = parseSofa("822 COMER / COL- BEETEX     HARRING 8371 04#COFFEE", "822", false);
  assert.match(String(got.color), /HARRING 8371 04#COFFEE/i);
});
test("a label followed by its own build in brackets is a TITLE — the bracket wins", () => {
  /* Owner 2026-08-10: 「2R(1+1) 就是 1A+1A」. The rule was already here; the
     `$` anchor meant it only fired when the bracket ENDED the segment, so
     every live spelling missed it and the label was counted as pieces ON TOP
     of the build it names. Three PROCEEDED company-1 orders read one whole
     seat larger than the book ordered on 2026-09-08 — SO-009335 (MRS ONG,
     IN_PRODUCTION), SO-010458 (JACK GUN, READY_TO_SHIP) and SO-011114
     (TAN RU YI, IN_PRODUCTION). Every string below is verbatim from the
     committed book snapshot. */

  // SO-009335 DtlKey 639683 — trailing residue after the bracket.
  assert.deepEqual(
    parseSofa("2 seater ( 1EL + 1 ER)  change bottom to Nilon  75 cm per seat  colour : B0315-27", "8050", false).pieces,
    ["1A(LHF)", "1A(RHF)"],
  );

  // SO-010458 DtlKey 722365 — a SIZE bracket after the build bracket.
  assert.deepEqual(
    parseSofa("3S (2+1)(32'Inch)/Col:BO315-21", "8051", false).pieces,
    ["2A(LHF)", "1A(RHF)"],
  );

  // SO-011114 DtlKey 764705 — a SIZE bracket BEFORE the build bracket.
  assert.deepEqual(
    parseSofa("3S(28'Inch)(2+1)/Col:BOO315-22/BackRest change to 5540", "9058", false).pieces,
    ["2A(LHF)", "1A(RHF)"],
  );

  /* The seat size and the colour must not move: taking the size bracket out
     is for the title test ONLY, and `o.size` is read from the raw Desc2. */
  const so10458 = parseSofa("3S (2+1)(32'Inch)/Col:BO315-21", "8051", false);
  assert.equal(so10458.size, "32");
  assert.equal(so10458.color, "BO315-21");
});

test("the title rule refuses a bracket that is not the whole build", () => {
  /* A size bracket is DIGITS plus an optional unit. "(1R)" starts with a digit
     too, and treating it as a size cost `(1R+1NA)30"+C+(1R)32"` its second arm
     when this was first written — measured over the committed book. */
  assert.deepEqual(
    parseSofa('BO315-24 (SAND)/(1R+1NA)30"+C+(1R)32"', "9058", false).pieces,
    ["1A(LHF)", "1NA", "CNR", "1A(RHF)"],
  );

  /* The owner's own example still decodes the way he stated it. */
  assert.deepEqual(parseSofa("2R(1+1)", "9058", false).pieces, ["1A(LHF)", "1A(RHF)"]);

  /* Guarded to brackets holding a '+', so a LABELLED bracket keeps its label. */
  assert.deepEqual(
    parseSofa("4S (corner)+L", "9058", false).pieces,
    ["2A(LHF)", "2NA", "CNR", "L(RHF)"],
  );

  /* A trailing DIGIT means the tail may be a real piece rather than residue,
     so the rule stands down and today's reading is kept unchanged. Dropping a
     piece silently is worse than leaving a line for a human. */
  assert.deepEqual(
    parseSofa("3S (2+1) 1S", "9058", false).pieces,
    ["3S", "2S", "1S", "1S"],
  );
});
