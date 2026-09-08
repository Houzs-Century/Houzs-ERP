/**
 * node --test backend/scripts/lib/sofa-desc2-match.test.mjs
 *
 * Zero dependencies, so it runs on a bare checkout — which is how
 * .github/workflows/working-agreement.yml runs it (`node --test
 * scripts/lib/*.test.mjs`, no `npm ci` in that job).
 *
 * WHAT THIS PINS. Every string below is REAL: the needles are copied out of
 * backend/scripts/data/sofa-compartment-corrections-2026-08.json, and every
 * `description2` was read off production (company 1, Houzs Century) on
 * 2026-09-04 with the read-only role. Nothing here is illustrative.
 *
 * Two halves, and the second is the important one:
 *
 *  1. the widening WORKS — the seven owner-approved builds prod run 33657082664
 *     skipped on 2026-09-02 are found, because the data file writes a line
 *     break as the two characters backslash-n where prod holds a real newline;
 *
 *  2. the widening STAYS HONEST — on a document that holds two builds it must
 *     never let one correction reach the other. HC-SO-012929 (a 26" three-piece
 *     and a separate 28" single-seater) and HC-SO-013164 (`2+C+2NA+C TABLE (W)`
 *     and `C TABLE(W)+2`) are both real two-build documents from that same
 *     file, and they are the ones worth breaking this on.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { desc2Contains, normaliseDesc2, selectBuildRows } from "./sofa-desc2-match.mjs";

/* ── the fixtures, exactly as prod holds them ──────────────────────────────
   `\n` in these literals is a REAL newline, which is the whole point: the
   needles further down write the same break as backslash-n. */
const SO_012107 = [{ item_code: "9058-1S", description2: "back rest change 8030 \nbottom wrap to Nilon \ncolour : AM275-7 " }];
const PO_009597 = [{ item_code: "8030-1S", description2: "28 inch per seat \nfully cover replace the leg \ncolour B0315-21 \nNilon bottom " }];
const SO_012828 = [{ item_code: "8030-1S", description2: "28 inch per seat \nfully cover replace the leg \ncolour B0315-21 \nNilon bottom" }];
const SO_008942 = [{ item_code: "9058-1S", description2: "colour  : MODENZA 05- DARK OLIVE \nchange the bottom fabric to Nilon \n30 inch per set" }];
const SO_012636 = [{ item_code: "8030-1S", description2: "Col: modenza 04: mustard \nNilon bottom " }];

/** Two builds on one document: the 26" three-piece, and a 28" single-seater the
 *  owner deliberately split off. Same colour, same bottom — they differ by the
 *  size and by the `1S/` the second one leads with. */
const SO_012929 = [
  { item_code: "9028-1S", description2: "Size:26”/Col:Modenza 02 Barley/Bottom wrap nylon" },
  { item_code: "9028-1S", description2: "1S/Size:28”/Col:Modenza 02 Barley/Bottom wrap nylon" },
  { item_code: "9028-1A(LHF)", description2: "Size:26”/Col:Modenza 02 Barley/Bottom wrap nylon" },
  { item_code: "9028-2A(RHF)", description2: "Size:26”/Col:Modenza 02 Barley/Bottom wrap nylon" },
];

/** Two builds on one document, and they share a 42-character tail. */
const SO_013164 = [
  { item_code: "8030-2A(LHF)", description2: "2+C+2NA+C TABLE (W)(28'INCH)/COL:BOO315-31/BOTTOM USE UMBRELLA FABRIC" },
  { item_code: "8030-CNR", description2: "2+C+2NA+C TABLE (W)(28'INCH)/COL:BOO315-31/BOTTOM USE UMBRELLA FABRIC" },
  { item_code: "8030-2NA", description2: "2+C+2NA+C TABLE (W)(28'INCH)/COL:BOO315-31/BOTTOM USE UMBRELLA FABRIC" },
  { item_code: "8030-Console", description2: "2+C+2NA+C TABLE (W)(28'INCH)/COL:BOO315-31/BOTTOM USE UMBRELLA FABRIC" },
  { item_code: "8030-1A(LHF)", description2: "C TABLE(W)+2(28'INCH)/COL:BOO315-31/BOTTOM USE UMBRELLA FABRIC" },
  { item_code: "8030-Console", description2: "C TABLE(W)+2(28'INCH)/COL:BOO315-31/BOTTOM USE UMBRELLA FABRIC" },
  { item_code: "8030-1A(RHF)", description2: "C TABLE(W)+2(28'INCH)/COL:BOO315-31/BOTTOM USE UMBRELLA FABRIC" },
];

/* ── the needles, exactly as the corrections file carries them ─────────────
   "\\n" in a JS literal is ONE backslash followed by n — two characters, not a
   line break. That is the defect this module exists for. */
const N_012107 = "back rest change 8030 \\nbottom wrap to N";
const N_009597 = "28 inch per seat \\nfully cover replace t";
const N_008942 = "colour  : MODENZA 05- DARK OLIVE \\nchang";
const N_012636 = "Col: modenza 04: mustard \\nNilon bottom";
const N_012929 = "Size:26”/Col:Modenza 02 Barley/Bottom wr";
const N_013164 = "2+C+2NA+C TABLE(28'INCH)/COL:BOO315-31/B";

test("the needle really is written with a backslash, not a newline", () => {
  assert.equal(N_012107.includes("\\n"), true, "the fixture stopped reproducing the defect");
  assert.equal(N_012107.includes("\n"), false);
  assert.equal(SO_012107[0].description2.includes("\n"), true);
  // and this is why a plain `includes` could not find it
  assert.equal(SO_012107[0].description2.includes(N_012107), false);
});

test("a written backslash-n finds a real newline — the six builds run 33657082664 skipped", () => {
  for (const [label, rows, needle] of [
    ["HC-SO-012107 / HC-PO-009781", SO_012107, N_012107],
    ["HC-PO-009597", PO_009597, N_009597],
    ["HC-SO-012828", SO_012828, N_009597],
    ["HC-SO-008942", SO_008942, N_008942],
    ["HC-SO-012636", SO_012636, N_012636],
  ]) {
    const got = selectBuildRows(rows, needle);
    assert.equal(got.verdict, "normalised", `${label}: ${got.how}`);
    assert.equal(got.rows.length, 1, label);
  }
});

test("a trailing space on one side of the pair does not split the pair", () => {
  // HC-PO-009597 ends "Nilon bottom " and HC-SO-012828 ends "Nilon bottom".
  assert.notEqual(PO_009597[0].description2, SO_012828[0].description2);
  assert.equal(normaliseDesc2(PO_009597[0].description2), normaliseDesc2(SO_012828[0].description2));
});

test("the doubled space inside `colour  :` is not signal", () => {
  assert.equal(desc2Contains(SO_008942[0].description2, N_008942), true);
  assert.equal(desc2Contains(SO_008942[0].description2, "colour : MODENZA 05- DARK OLIVE"), true);
});

test("an exact match still behaves exactly as before", () => {
  const got = selectBuildRows(SO_012929, N_012929);
  assert.equal(got.verdict, "exact");
  assert.equal(got.rows.length, 3);
  assert.deepEqual(got.rows.map((r) => r.item_code), ["9028-1S", "9028-1A(LHF)", "9028-2A(RHF)"]);
});

test("TWO BUILDS: the 26\" needle never reaches the 28\" single-seater", () => {
  const got = selectBuildRows(SO_012929, N_012929);
  const reached = got.rows.map((r) => r.description2);
  assert.equal(reached.every((d) => d.includes("26")), true);
  assert.equal(reached.some((d) => d.includes("28")), false, "the correction leaked onto the other build");
});

test("TWO BUILDS: a needle common to both is AMBIGUOUS and returns nothing", () => {
  // Real text, both builds carry it — colour and bottom are shared, only the
  // size differs. A matcher that "helpfully" picked one would rewrite the wrong
  // sofa, so it must hand back nothing at all.
  const got = selectBuildRows(SO_012929, "Col:Modenza 02 Barley/Bottom wr");
  assert.equal(got.verdict, "ambiguous");
  assert.deepEqual(got.rows, []);
  assert.equal(got.texts.length, 2);
});

test("TWO BUILDS: ambiguity that only appears once we normalise is caught too", () => {
  // The needle uses a smart apostrophe where prod uses a straight one, so it
  // matches NOTHING exactly and BOTH builds after normalising. This is the case
  // the widening itself creates, and it is the one that must refuse.
  const needle = "(28’INCH)/COL:BOO315-31/B";
  assert.equal(SO_013164.some((r) => r.description2.includes(needle)), false);
  const got = selectBuildRows(SO_013164, needle);
  assert.equal(got.verdict, "ambiguous");
  assert.deepEqual(got.rows, []);
  assert.equal(got.texts.length, 2);
});

test("TWO BUILDS: a genuinely different text is still NOT matched", () => {
  // Prod holds `2+C+2NA+C TABLE (W)(28'INCH)`; the file's needle has no ` (W)`.
  // That is a real difference in the slip, not an encoding artefact, so the
  // matcher must keep saying it cannot find the build rather than guess.
  const got = selectBuildRows(SO_013164, N_013164);
  assert.equal(got.verdict, "none");
  assert.deepEqual(got.rows, []);
});

test("normalising never deletes a space or a piece separator", () => {
  // `1+2` and `1 + 2` are different builds; `2NA` and `2 NA` are different too.
  assert.notEqual(normaliseDesc2("1+2(28'INCH)"), normaliseDesc2("1 + 2(28'INCH)"));
  assert.equal(normaliseDesc2("C TABLE(W)+2"), "C TABLE(W)+2");
  assert.equal(normaliseDesc2("2+C+2NA+C TABLE (W)"), "2+C+2NA+C TABLE (W)");
});

test("smart quotes, primes and dashes are the same character as their ASCII twin", () => {
  assert.equal(normaliseDesc2("Size:26”"), normaliseDesc2('SIZE:26"'));
  assert.equal(normaliseDesc2("30’Inch"), normaliseDesc2("30'INCH"));
  assert.equal(normaliseDesc2("MODENZA 05– DARK"), normaliseDesc2("modenza 05- dark"));
});

test("a correction with no desc2Match takes the whole document", () => {
  const got = selectBuildRows(SO_012636, null);
  assert.equal(got.verdict, "all");
  assert.equal(got.rows.length, 1);
});

test("an empty document, and a blank needle, are answered not thrown", () => {
  assert.equal(selectBuildRows([], N_012107).verdict, "none");
  assert.equal(selectBuildRows(SO_012636, "   ").verdict, "none");
  assert.equal(selectBuildRows(undefined, N_012107).verdict, "none");
  assert.equal(desc2Contains(null, N_012107), false);
});

test("a null description2 is not a match for anything", () => {
  const got = selectBuildRows([{ item_code: "8030-1S", description2: null }], N_009597);
  assert.equal(got.verdict, "none");
});

/* ── SELECTION BY LINE KEY ───────────────────────────────────────────────────
 * A build whose ERP rows do NOT carry the book's text cannot be reached by any
 * needle, however wide — there is nothing on the row to match. Two of the last
 * six sales-order differences are exactly that, and widening a needle until it
 * hits is how a correction lands on the neighbouring build.
 *
 * `linked_ac_dtlkey` is the AutoCount line's own identity, stamped on every ERP
 * row that came out of it (src/scm/lib/autocount-line-keys.ts:155 — "Every ERP
 * row behind this AutoCount line gets the SAME key"). Selecting on it is
 * identity, not resemblance, and it cannot reach a neighbouring build even when
 * the two texts are byte-identical.
 *
 * A key that matches NOTHING is a REFUSAL, never a fallback to the text: a key
 * we cannot find means the key we were given is wrong, and answering with the
 * text would be the guess this whole module exists to refuse.
 */
const KEYED = [
  { item_code: "2379-1S", description2: null, linked_ac_dtlkey: "358016" },
  { item_code: "2379-1S", description2: null, linked_ac_dtlkey: "358017" },
];

test("LINE KEY: the build is the rows carrying that AutoCount DtlKey", () => {
  const got = selectBuildRows(KEYED, null, undefined, { dtlKey: "358016" });
  assert.equal(got.verdict, "line-key");
  assert.equal(got.rows.length, 1);
  assert.equal(got.rows[0].linked_ac_dtlkey, "358016");
});

test("LINE KEY: a number and its own string spelling are the same key", () => {
  assert.equal(selectBuildRows(KEYED, null, undefined, { dtlKey: 358017 }).rows.length, 1);
  assert.equal(
    selectBuildRows([{ linked_ac_dtlkey: 358017 }], null, undefined, { dtlKey: "358017" }).rows.length,
    1,
  );
});

test("LINE KEY: several rows of ONE build all come back — a sofa is one book line", () => {
  const rows = [
    { item_code: "9028-2S", linked_ac_dtlkey: "775621" },
    { item_code: "9028-1S", linked_ac_dtlkey: "775621" },
    { item_code: "9028-1S", linked_ac_dtlkey: "775999" },
  ];
  const got = selectBuildRows(rows, null, undefined, { dtlKey: "775621" });
  assert.equal(got.verdict, "line-key");
  assert.equal(got.rows.length, 2);
});

test("LINE KEY: a key no row carries REFUSES rather than falling back to the text", () => {
  const got = selectBuildRows(SO_012636, "Col: modenza 04: mustard", undefined, { dtlKey: "999999" });
  assert.equal(got.verdict, "key-missing");
  assert.equal(got.rows.length, 0);
});

test("LINE KEY: identity beats the text — the needle is not consulted at all", () => {
  /* Both rows carry a text the needle matches; only one carries the key. */
  const rows = [
    { item_code: "8030-1S", description2: "Col: modenza 04: mustard", linked_ac_dtlkey: "1" },
    { item_code: "8030-1S", description2: "Col: modenza 04: mustard", linked_ac_dtlkey: "2" },
  ];
  const got = selectBuildRows(rows, "Col: modenza 04: mustard", undefined, { dtlKey: "2" });
  assert.equal(got.verdict, "line-key");
  assert.equal(got.rows.length, 1);
  assert.equal(got.rows[0].linked_ac_dtlkey, "2");
});

test("LINE KEY: a blank key is no key — the needle decides, as it always did", () => {
  assert.equal(selectBuildRows(SO_012636, "Col: modenza 04: mustard", undefined, { dtlKey: "" }).verdict, "exact");
  assert.equal(selectBuildRows(SO_012636, "Col: modenza 04: mustard", undefined, {}).verdict, "exact");
  assert.equal(selectBuildRows(SO_012636, "Col: modenza 04: mustard", undefined, { dtlKey: null }).verdict, "exact");
});
