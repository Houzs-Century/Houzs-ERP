import test from "node:test";
import assert from "node:assert/strict";

import {
  compartmentOf,
  moneyOfRows,
  pairRowsToPieces,
  planCopyMoney,
  seatHeightToWrite,
  splitBuildCopies,
  supersededBy,
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

test("REFUSES a document that does not divide evenly into sofas", () => {
  const rows = [
    { id: "p1", code: "8030-1S" },
    { id: "p2", code: "8030-1S" },
    { id: "ok", code: "8030-1NA" },
  ];
  const got = splitBuildCopies(rows, WANT_8030_3);
  assert.equal(got.ok, false);
  assert.match(got.why, /does not divide evenly/);
});

test("HC-PO-009024 after the SO carry: two lines that are ALREADY the first piece", () => {
  /* The SO half of the correction ran first and its downstream carry set both
     PO lines to 9050-1A(LHF). Neither is a placeholder any more, and the
     placeholders-only rule refused the build and left the purchase order half
     corrected — measured on prod, run 33891638140. */
  const want = ["9050-1A(LHF)", "9050-1NA", "9050-CNR", "9050-1A(RHF)"];
  const rows = [
    { id: "49671284", code: "9050-1A(LHF)", qty: 1, unit_price_sen: 95000, total: 0 },
    { id: "29315341", code: "9050-1A(LHF)", qty: 1, unit_price_sen: 95000, total: 0 },
  ];
  const got = splitBuildCopies(rows, want);
  assert.equal(got.ok, true, got.ok ? "" : got.why);
  assert.equal(got.copies.length, 2);
  assert.deepEqual(got.copies.map((c) => c.map((r) => r.id)), [["49671284"], ["29315341"]]);
  for (const c of got.copies) {
    const m = planCopyMoney(c);
    assert.equal(m.ok, true, m.ok ? "" : m.why);
    assert.equal(m.price, 95000, "each sofa keeps its own 95000");
    assert.equal(m.total, 0);
  }
});

test("a piece the build uses TWICE does not read as two sofas", () => {
  /* HC-SO-011008 is 1A+1NA+CNR+1NA+1A — one sofa with two 1NA rows. */
  const want = ["9058-1A(LHF)", "9058-1NA", "9058-CNR", "9058-1NA", "9058-1A(RHF)"];
  const rows = [
    { id: "a", code: "9058-1A(LHF)" },
    { id: "b", code: "9058-1NA" },
    { id: "c", code: "9058-CNR" },
    { id: "d", code: "9058-1NA" },
    { id: "e", code: "9058-1A(RHF)" },
  ];
  const got = splitBuildCopies(rows, want);
  assert.equal(got.ok, true);
  assert.equal(got.copies.length, 1, "two 1NA rows are the build's own two, not two sofas");
});

test("two whole sofas already written stay two, and each keeps its own rows", () => {
  const rows = [
    { id: "a1", code: "8030-1A(LHF)" }, { id: "a2", code: "8030-1A(LHF)" },
    { id: "b1", code: "8030-1NA" }, { id: "b2", code: "8030-1NA" },
    { id: "c1", code: "8030-1A(RHF)" }, { id: "c2", code: "8030-1A(RHF)" },
  ];
  const got = splitBuildCopies(rows, WANT_8030_3);
  assert.equal(got.ok, true);
  assert.equal(got.copies.length, 2);
  assert.deepEqual(got.copies.map((c) => c.map((r) => r.id).sort()), [["a1", "b1", "c1"], ["a2", "b2", "c2"]]);
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

/* ── A MODEL CHANGE MUST NOT MOVE A COMPARTMENT ONTO ANOTHER ROW ────────────
   Fixtures are prod rows read by the read-only probe run 34187267757
   (company 1, 2026-09-08), in the id order the applier reads them. Every one of
   those purchase-order rows carries a so_item_id dedication to the sales-order
   row with the SAME code, which is what bound-mode readiness reads - so the row
   a compartment lands on is its identity, and position is not. */

test("HC-PO-009550: 9058 -> 8030 keeps every compartment on its own row", () => {
  const rows = [
    { id: "po1", code: "9058-2A(RHF)" },
    { id: "po2", code: "9058-CNR" },
    { id: "po3", code: "9058-1A(LHF)" },
  ];
  const want = ["8030-1A(LHF)", "8030-CNR", "8030-2A(RHF)"];
  const { pairs, surplus } = pairRowsToPieces(rows, want);
  assert.deepEqual(pairs.map((p) => p.row.id), ["po3", "po2", "po1"]);
  assert.deepEqual(surplus, []);
  for (const p of pairs) assert.equal(compartmentOf(p.row.code), compartmentOf(p.want));
});

test("HC-PO-009712: 8030 -> 5535, all three rows in a different order, all three stay put", () => {
  const rows = [
    { id: "k1", code: "8030-CNR" },
    { id: "k2", code: "8030-2A(RHF)" },
    { id: "k3", code: "8030-1A(LHF)" },
  ];
  const { pairs } = pairRowsToPieces(rows, ["5535-1A(LHF)", "5535-CNR", "5535-2A(RHF)"]);
  assert.deepEqual(pairs.map((p) => p.row.id), ["k3", "k1", "k2"]);
});

test("the positional fallback is what this replaces, and it was wrong here", () => {
  /* Written as the defect so it cannot come back: dealing the same rows out in
     document order puts 2A(RHF) where 1A(LHF) belongs. */
  const rows = [
    { id: "po1", code: "9058-2A(RHF)" },
    { id: "po2", code: "9058-CNR" },
    { id: "po3", code: "9058-1A(LHF)" },
  ];
  const positional = ["8030-1A(LHF)", "8030-CNR", "8030-2A(RHF)"].map((w, i) => ({ want: w, row: rows[i] }));
  const moved = positional.filter((p) => compartmentOf(p.row.code) !== compartmentOf(p.want));
  assert.equal(moved.length, 2, "two of three compartments would have changed row");
});

test("an exact code still wins over a compartment match", () => {
  const rows = [
    { id: "old", code: "9058-CNR" },
    { id: "new", code: "8030-CNR" },
  ];
  const { pairs, surplus } = pairRowsToPieces(rows, ["8030-CNR"]);
  assert.equal(pairs[0].row.id, "new");
  assert.deepEqual(surplus.map((r) => r.id), ["old"]);
});

test("a codeless piece is never paired on an empty compartment", () => {
  const rows = [{ id: "x", code: "STOOL" }, { id: "y", code: "DIVAN ONLY" }];
  const { pairs } = pairRowsToPieces(rows, ["STOOL", "8030-CNR"]);
  assert.equal(pairs[0].row.id, "x", "exact code");
  /* `DIVAN ONLY` has no compartment, so it reaches 8030-CNR only through the
     positional fallback - never by matching "" against "". */
  assert.equal(pairs[1].row.id, "y");
});

test("a real placeholder still falls through to the positional fallback", () => {
  const rows = [{ id: "p", code: "8030-1S", total: 419000, unit_price_sen: 419000, qty: 1 }];
  const { pairs } = pairRowsToPieces(rows, ["5535-1A(LHF)", "5535-CNR", "5535-2A(RHF)"]);
  assert.deepEqual(pairs.map((p) => p.row?.id ?? null), ["p", null, null]);
});

/* ---------------------------------------------------------------------------
 * supersededBy — the newest ruling for a build is the one the verify asserts.
 *
 * Bought by run 34301924900: 168 documents were written correctly and the run
 * still exited 1, because the 2026-08 entry for HC-SO-012929 was asserted after
 * the 2026-09 entry had overruled it on the same rows.
 * ------------------------------------------------------------------------ */
test("a later entry on the same document overrules an earlier one that shares rows", () => {
  /* HC-SO-012929, verbatim from the two correction files: 2026-08 targets
     1S+1A(LHF)+2A(RHF), 2026-09 targets 1A(LHF)+2A(RHF). Both select the
     26-inch rows; only the second is the owner's current answer. */
  const doc = ["SO:HC-SO-012929", "SO:HC-SO-012929"];
  assert.deepEqual(supersededBy(doc, [["r1", "r2", "r3"], ["r1", "r2"]]), [1, -1]);
});

test("the selector TEXT differing does not make them separate builds", () => {
  /* The real entries carry different desc2Match strings — "...Barley/Bottom wr"
     and "...Barley". Any key built from the selector would call these two
     builds and assert both. Row ids are what decide it. */
  const doc = ["SO:X", "SO:X"];
  assert.equal(supersededBy(doc, [["a"], ["a"]])[0], 1);
});

test("two real builds on one document are both asserted", () => {
  /* HC-PO-009024 holds a 4-piece build AND a separate 1S. They share no row, so
     neither may silence the other — collapsing them would leave a build
     unverified. */
  assert.deepEqual(supersededBy(["PO:1", "PO:1"], [["a", "b", "c", "d"], ["e"]]), [-1, -1]);
});

test("entries on different documents never interact", () => {
  assert.deepEqual(supersededBy(["SO:A", "SO:B"], [["r1"], ["r1"]]), [-1, -1]);
});

test("an entry that selects no rows is asserted, not explained away", () => {
  /* A build whose rows vanished must still FAIL. An empty set intersects
     nothing, so it can neither supersede nor be superseded. */
  assert.deepEqual(supersededBy(["SO:A", "SO:A"], [[], ["r1"]]), [-1, -1]);
});

test("the LAST ruling wins when three files touch one build", () => {
  const doc = ["SO:A", "SO:A", "SO:A"];
  assert.deepEqual(supersededBy(doc, [["r1"], ["r1"], ["r1"]]), [1, 2, -1]);
});
