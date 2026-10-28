import assert from "node:assert/strict";
import test from "node:test";

import { OUT_OF_FINGERPRINT, fingerprintFields, fingerprintOf, seatOf } from "./po-so-dedication-read.mjs";

/* A row shaped like the purchase-order side of readPair's SELECT. */
const poRow = () => ({
  id: "po-item-1",
  item_group: "sofa",
  item_code: "9050-1NA",
  qty: 1,
  unit_price_sen: 0,
  line_total_sen: 0,
  so_item_id: null,
  variants: { seatHeight: "30", colourLabel: "MODENZA 05" },
  received_qty: 0,
  description2: "all adjustable arm rest",
});

test("seatOf reads variants.seatHeight and treats blank as absent", () => {
  assert.equal(seatOf({ seatHeight: "30" }), "30");
  assert.equal(seatOf({ seatHeight: 30 }), "30");
  assert.equal(seatOf({ seatHeight: "" }), null);
  assert.equal(seatOf({}), null);
  assert.equal(seatOf(null), null);
});

test("identity and the pointer being decided stay OUT of the fingerprint", () => {
  /* This is the rule the whole widening rests on: if `id` were compared, two
     physically identical compartments would never be indistinguishable and the
     bucket could never be settled. */
  for (const k of ["id", "line_no", "so_item_id", "seat", "fingerprint"]) {
    assert.ok(OUT_OF_FINGERPRINT.has(k), `${k} must be excluded`);
  }
  const names = fingerprintFields(poRow()).map(([k]) => k);
  assert.deepEqual(names.filter((n) => OUT_OF_FINGERPRINT.has(n)), []);
});

test("two rows differing ONLY in an excluded column are indistinguishable", () => {
  const a = { ...poRow(), id: "po-item-1", so_item_id: null };
  const b = { ...poRow(), id: "po-item-2", so_item_id: "so-item-9" };
  assert.equal(fingerprintOf(a), fingerprintOf(b));
});

test("one differing column - anywhere - separates them again", () => {
  const base = poRow();
  for (const [k, v] of [
    ["qty", 2],
    ["received_qty", 1],
    ["unit_price_sen", 12345],
    ["line_total_sen", 12345],
    ["item_code", "9050-CNR"],
    ["description2", "all adjustable arm rest "],
    ["variants", { seatHeight: "30", colourLabel: "MODENZA 04" }],
  ]) {
    assert.notEqual(
      fingerprintOf(base),
      fingerprintOf({ ...base, [k]: v }),
      `${k} must be compared`,
    );
  }
});

test("keys are sorted, so key ORDER can never make two agreeing rows disagree", () => {
  const a = { item_code: "X", qty: 1, description2: "d" };
  const b = { description2: "d", qty: 1, item_code: "X" };
  assert.equal(fingerprintOf(a), fingerprintOf(b));
  assert.deepEqual(fingerprintFields(a).map(([k]) => k), ["description2", "item_code", "qty"]);
});

test("null and undefined are one value; objects are stringified", () => {
  assert.deepEqual(fingerprintFields({ a: null, b: undefined, c: { z: 1 } }), [
    ["a", null],
    ["b", null],
    ["c", '{"z":1}'],
  ]);
});

test("fingerprintOf is exactly the stringified field list the probe diffs", () => {
  /* probe-dedication-bucket-diff.mjs reports which COLUMN differs by walking
     fingerprintFields. If that ever stopped being the same data the planner
     compares as fingerprintOf, the probe would name a column the planner never
     looked at. */
  const r = poRow();
  assert.equal(fingerprintOf(r), JSON.stringify(fingerprintFields(r)));
});

test("the extraction preserved the exact string the inline version produced", () => {
  /* Pinned literal, so moving this code out of repair-po-so-item-dedication.mjs
     cannot silently change what "indistinguishable" means. */
  assert.equal(
    fingerprintOf(poRow()),
    '[["description2","all adjustable arm rest"],["item_code","9050-1NA"],["item_group","sofa"],'
      + '["line_total_sen","0"],["qty","1"],["received_qty","0"],["unit_price_sen","0"],'
      + '["variants","{\\"seatHeight\\":\\"30\\",\\"colourLabel\\":\\"MODENZA 05\\"}"]]',
  );
});
