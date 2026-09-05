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
