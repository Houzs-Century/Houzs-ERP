import test from "node:test";
import assert from "node:assert/strict";

import {
  compartmentOf,
  moneyOfRows,
  pairRowsToPieces,
  planCopyMoney,
  seatHeightToWrite,
  splitBuildCopies,
} from "./sofa-build-plan.mjs";

/* Every fixture below is a row as it stands on prod (company 1, 2026-09-04),
   read with the read-only DSN — not an invented shape. */

const WANT_8030_3 = ["8030-1A(LHF)", "8030-1NA", "8030-1A(RHF)"];

test("HC-SO-013384: two identical 1S lines are two sofas, not one build", () => {
  const rows = [
    { id: "ade292ec", code: "8030-1S", qty: 1, unit_price_sen: 800000, total: 800000 },
    { id: "68958b94", code: "8030-1S", qty: 1, unit_price_sen: 0, total: 0 },
  ];
  const got = splitBuildCopies(rows, WANT_8030_3);
  assert.equal(got.ok, true);
  assert.equal(got.copies.length, 2, "two placeholder lines are two sofas");
  assert.deepEqual(got.copies.map((c) => c.map((r) => r.id)), [["ade292ec"], ["68958b94"]]);
});

test("the old shape would have made ONE sofa of those two lines", () => {
  /* This is the defect, written as a test so it cannot come back: pairing the
     two rows straight onto the piece list consumes both and inserts one more. */
  const rows = [
    { id: "ade292ec", code: "8030-1S" },
    { id: "68958b94", code: "8030-1S" },
  ];
  const { pairs } = pairRowsToPieces(rows, WANT_8030_3);
  assert.deepEqual(pairs.map((p) => p.row?.id ?? null), ["ade292ec", "68958b94", null]);
  // ...which is why splitBuildCopies runs FIRST, and each copy is paired alone.
  for (const copy of splitBuildCopies(rows, WANT_8030_3).copies) {
    const { pairs: p2, surplus } = pairRowsToPieces(copy, WANT_8030_3);
    assert.deepEqual(p2.map((p) => p.row?.id ?? null), [copy[0].id, null, null]);
    assert.deepEqual(surplus, []);
  }
});

test("one placeholder is one sofa, and already-correct pieces stay with it", () => {
  const rows = [
    { id: "L1", code: "9028-1S", total: 668000, unit_price_sen: 668000, qty: 1 },
    { id: "L4", code: "9028-1A(LHF)", total: 0, unit_price_sen: 0, qty: 1 },
    { id: "L5", code: "9028-2A(RHF)", total: 0, unit_price_sen: 0, qty: 1 },
  ];
  const got = splitBuildCopies(rows, ["9028-1S", "9028-1A(LHF)", "9028-2A(RHF)"]);
  assert.equal(got.ok, true);
  assert.equal(got.copies.length, 1);
  assert.equal(got.copies[0].length, 3);
});

test("a build with no placeholder at all is still one sofa (re-run stays inert)", () => {
  const rows = [
    { id: "a", code: "8030-1A(LHF)" },
    { id: "b", code: "8030-1NA" },
    { id: "c", code: "8030-1A(RHF)" },
  ];
  const got = splitBuildCopies(rows, WANT_8030_3);
  assert.equal(got.ok, true);
  assert.equal(got.copies.length, 1);
  const { pairs, surplus } = pairRowsToPieces(rows, WANT_8030_3);
  assert.deepEqual(pairs.map((p) => p.row.id), ["a", "b", "c"]);
  assert.deepEqual(surplus, []);
});

test("REFUSES several placeholders mixed with already-correct pieces", () => {
  const rows = [
    { id: "p1", code: "8030-1S" },
    { id: "p2", code: "8030-1S" },
    { id: "ok", code: "8030-1NA" },
  ];
  const got = splitBuildCopies(rows, WANT_8030_3);
  assert.equal(got.ok, false);
  assert.match(got.why, /not written down anywhere/);
});

test("HC-SO-013384 money: the priced line leads its own sofa, the other is free", () => {
  const priced = [{ id: "L1", code: "8030-1S", qty: 1, unit_price_sen: 800000, total: 800000 }];
  const free = [{ id: "L2", code: "8030-1S", qty: 1, unit_price_sen: 0, total: 0 }];
  const a = planCopyMoney(priced), b = planCopyMoney(free);
  assert.equal(a.ok, true);
  assert.equal(a.lead.id, "L1");
  assert.equal(a.price, 800000);
  assert.equal(a.total, 800000);
  assert.equal(b.ok, true);
  assert.equal(b.price, 0);
  assert.equal(b.total, 0);
  // the document total is the sum of the two, unchanged
  assert.equal(a.total + b.total, moneyOfRows([...priced, ...free]).total);
});

test("HC-PO-009024: a PO line carries its price in unit_price_sen and 0 in the total column", () => {
  /* Measured: all 289 company-1 sofa lines on scm.purchase_order_items have
     line_total_sen = 0. Asserting on that column alone passed vacuously AND
     refused this build by comparing 0 against a recomputed unit x qty. */
  const rows = [{ id: "po", code: "9050-1S", qty: 1, unit_price_sen: 95000, total: 0 }];
  const got = planCopyMoney(rows);
  assert.equal(got.ok, true, got.ok ? "" : got.why);
  assert.equal(got.price, 95000, "the price rides the first piece");
  assert.equal(got.total, 0, "and the total column keeps the value it had");
  assert.deepEqual(got.before, { total: 0, charged: 95000 });
});

test("REFUSES a sofa whose price is spread over more than one line", () => {
  const rows = [
    { id: "a", code: "8030-1S", qty: 1, unit_price_sen: 400000, total: 400000 },
    { id: "b", code: "8030-1S", qty: 1, unit_price_sen: 400000, total: 400000 },
  ];
  const got = planCopyMoney(rows);
  assert.equal(got.ok, false);
  assert.match(got.why, /money would move/);
});

test("seat: bare inches are written, a centimetre reading is not", () => {
  assert.deepEqual(seatHeightToWrite("30"), { write: true, value: "30", why: "inches" });
  assert.equal(seatHeightToWrite("24").write, true);
  assert.equal(seatHeightToWrite(null).write, false);
  assert.equal(seatHeightToWrite("").write, false);
  const cm = seatHeightToWrite("60cm");
  assert.equal(cm.write, false, "HC-SO-003295 says 60cm and seatHeight holds inches");
  assert.equal(cm.value, null);
  assert.match(cm.why, /not a number of inches/);
  assert.equal(seatHeightToWrite('30"').write, false);
});

test("compartmentOf", () => {
  assert.equal(compartmentOf("8030-1A(LHF)"), "1A(LHF)");
  assert.equal(compartmentOf("9058-CNR"), "CNR");
  assert.equal(compartmentOf("STOOL"), "");
});
