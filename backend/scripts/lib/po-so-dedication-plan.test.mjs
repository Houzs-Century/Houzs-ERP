/**
 * node --test backend/scripts/lib/po-so-dedication-plan.test.mjs
 *
 * Zero dependencies, so it runs on a bare checkout — which is how
 * .github/workflows/working-agreement.yml runs it (`node --test
 * scripts/lib/*.test.mjs`, no `npm ci` in that job).
 *
 * WHAT THIS PINS. Every id, code and seat below was read off production
 * (company 1, Houzs Century) on 2026-09-05 with the read-only role. The pair is
 * HC-SO-012929 / HC-PO-009751: a 26" build the owner ruled is 1A(LHF)+2A(RHF),
 * plus a separate 28" single seater that is a genuine second sofa and must not
 * be touched by anything here.
 *
 * The defect it pins is one row. `scm.purchase_order_items.so_item_id` is the
 * dedication — "this purchase line is for THAT sales line" — and the PO's
 * 9028-1A(LHF) pointed at the sales order's 9028-1S. That is the state
 * `soLinkTargetRefusal` (mfg-purchase-orders.ts) answers 409
 * `so_link_material_mismatch` for, so no operator could have created it through
 * the UI; it came in with the migration. It is also what makes
 * apply-sofa-compartment-corrections.mjs refuse the whole build: the surplus
 * -1S line it would remove has a purchase line hanging off it.
 *
 * Three halves, and the last is the important one:
 *
 *  1. the re-point WORKS — the mismatched line lands on the sales line with the
 *     same code, and the unbound one is bound to its own;
 *  2. it NEVER matches by position — the fixtures are deliberately in a
 *     different order on the two documents;
 *  3. it REFUSES rather than picks whenever the answer is not forced: two
 *     candidate sales lines, none, a pointer that leaves the document pair, a
 *     cancelled target, an over-convert, or a purchase order that has no
 *     dedication to this sales order at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { planDedication } from "./po-so-dedication-plan.mjs";

/* ── the fixtures, exactly as prod holds them (2026-09-05) ────────────────── */

const SO_1S_26 = "1bcd78ab-2b5d-4701-a0fb-63ae9871c390"; // the surplus, carries RM 6,680
const SO_1S_28 = "d5b79877-da81-4b60-ac2c-2466440b9320"; // a REAL separate single seater
const SO_1A_26 = "28bf0d16-0d32-4db0-b844-0a26f831fd64";
const SO_2A_26 = "b025758d-efe6-4f0b-8740-f8b496cdc69e";

const PO_1S_28 = "16773952-68f3-41e9-a780-befe0a2c5980"; // correct already
const PO_2A_26 = "f9d305bd-52d1-45e7-bcb7-6b200eb385f0"; // dedicated to NOTHING
const PO_1A_26 = "fa011176-c63d-4e83-b660-8773505ff55d"; // dedicated to the WRONG row

const soRows = () => [
  { id: SO_1S_26, item_code: "9028-1S", qty: 1, seat: "26", cancelled: false },
  { id: SO_1S_28, item_code: "9028-1S", qty: 1, seat: "28", cancelled: false },
  { id: SO_1A_26, item_code: "9028-1A(LHF)", qty: 1, seat: "26", cancelled: false },
  { id: SO_2A_26, item_code: "9028-2A(RHF)", qty: 1, seat: "26", cancelled: false },
];

/* Deliberately NOT in the sales order's order: a planner that pairs by position
   would put 1S@28 on 1S@26 and get the one line this job must not touch wrong. */
const poRows = () => [
  { id: PO_1S_28, item_code: "9028-1S", qty: 1, seat: "28", so_item_id: SO_1S_28 },
  { id: PO_2A_26, item_code: "9028-2A(RHF)", qty: 1, seat: "26", so_item_id: null },
  { id: PO_1A_26, item_code: "9028-1A(LHF)", qty: 1, seat: "26", so_item_id: SO_1S_26 },
];

const moveTo = (plan, poItemId) => plan.moves.find((m) => m.poItemId === poItemId)?.to ?? null;

/* ── 1. the re-point works ─────────────────────────────────────────────────── */

test("the mismatched purchase line lands on the sales line with its own code", () => {
  const plan = planDedication({ poRows: poRows(), soRows: soRows() });
  assert.deepEqual(plan.refusals, []);
  assert.equal(moveTo(plan, PO_1A_26), SO_1A_26);
  assert.equal(plan.moves.find((m) => m.poItemId === PO_1A_26).from, SO_1S_26);
  assert.equal(plan.moves.find((m) => m.poItemId === PO_1A_26).why, "mismatch");
});

test("the unbound purchase line is bound to its own sales line", () => {
  const plan = planDedication({ poRows: poRows(), soRows: soRows() });
  assert.equal(moveTo(plan, PO_2A_26), SO_2A_26);
  assert.equal(plan.moves.find((m) => m.poItemId === PO_2A_26).why, "unbound");
});

test("the 28-inch single seater is KEPT, never moved — it is a second sofa", () => {
  const plan = planDedication({ poRows: poRows(), soRows: soRows() });
  assert.equal(moveTo(plan, PO_1S_28), null);
  assert.deepEqual(
    plan.keeps.map((k) => [k.poItemId, k.to]),
    [[PO_1S_28, SO_1S_28]],
  );
  /* And the sales line it is dedicated to is never a candidate for anything. */
  assert.ok(!plan.moves.some((m) => m.to === SO_1S_28));
});

test("nothing lands on the surplus 26-inch 1S — that is the whole point", () => {
  const plan = planDedication({ poRows: poRows(), soRows: soRows() });
  assert.ok(!plan.moves.some((m) => m.to === SO_1S_26));
  assert.ok(!plan.keeps.some((k) => k.to === SO_1S_26));
  assert.deepEqual(plan.freedSoItemIds, [SO_1S_26]);
});

test("a second run is inert — every pointer is already right", () => {
  const first = planDedication({ poRows: poRows(), soRows: soRows() });
  const applied = poRows().map((r) => {
    const to = moveTo(first, r.id);
    return to ? { ...r, so_item_id: to } : r;
  });
  const again = planDedication({ poRows: applied, soRows: soRows() });
  assert.deepEqual(again.moves, []);
  assert.deepEqual(again.refusals, []);
  assert.equal(again.keeps.length, 3);
});

/* ── 2. matched by CODE, never by position ─────────────────────────────────── */

test("shuffling either document changes nothing", () => {
  const rev = (xs) => [...xs].reverse();
  const a = planDedication({ poRows: poRows(), soRows: soRows() });
  const b = planDedication({ poRows: rev(poRows()), soRows: rev(soRows()) });
  const norm = (p) => p.moves.map((m) => `${m.poItemId}->${m.to}`).sort();
  assert.deepEqual(norm(b), norm(a));
  assert.deepEqual(b.refusals, []);
});

test("seat depth separates two sales lines that share a code", () => {
  /* Give the purchase order a 1S at 26" too. Code alone reaches both 1S lines;
     only the seat tells them apart, and the 28" one is already claimed. */
  const po = [
    ...poRows(),
    { id: "po-extra-1s-26", item_code: "9028-1S", qty: 1, seat: "26", so_item_id: null },
  ];
  const plan = planDedication({ poRows: po, soRows: soRows() });
  assert.deepEqual(plan.refusals, []);
  assert.equal(moveTo(plan, "po-extra-1s-26"), SO_1S_26);
});

/* ── 3. it refuses rather than picks ───────────────────────────────────────── */

test("REFUSES when two sales lines could both be the answer", () => {
  const so = [
    ...soRows(),
    { id: "so-second-1a-26", item_code: "9028-1A(LHF)", qty: 1, seat: "26", cancelled: false },
  ];
  const plan = planDedication({ poRows: poRows(), soRows: so });
  assert.equal(plan.moves.length, 1, "the unambiguous 2A(RHF) still plans");
  assert.equal(moveTo(plan, PO_2A_26), SO_2A_26);
  assert.equal(moveTo(plan, PO_1A_26), null);
  assert.ok(plan.refusals.some((r) => /9028-1A\(LHF\)/.test(r) && /2 sales line/.test(r)), plan.refusals.join(" | "));
});

test("REFUSES when no sales line carries that code at that seat", () => {
  const so = soRows().filter((r) => r.id !== SO_2A_26);
  const plan = planDedication({ poRows: poRows(), soRows: so });
  assert.equal(moveTo(plan, PO_2A_26), null);
  assert.ok(plan.refusals.some((r) => /9028-2A\(RHF\)/.test(r) && /no sales line/.test(r)), plan.refusals.join(" | "));
  /* The other one is independent and still planned. */
  assert.equal(moveTo(plan, PO_1A_26), SO_1A_26);
});

test("REFUSES a pointer that leaves the document pair rather than dragging it back", () => {
  const po = poRows().map((r) => (r.id === PO_1A_26 ? { ...r, so_item_id: "some-other-orders-line" } : r));
  const plan = planDedication({ poRows: po, soRows: soRows() });
  assert.equal(moveTo(plan, PO_1A_26), null);
  assert.ok(plan.refusals.some((r) => /some-other-orders-line/.test(r)), plan.refusals.join(" | "));
});

test("REFUSES a cancelled target — a cancelled line has no demand", () => {
  const so = soRows().map((r) => (r.id === SO_1A_26 ? { ...r, cancelled: true } : r));
  const plan = planDedication({ poRows: poRows(), soRows: so });
  assert.equal(moveTo(plan, PO_1A_26), null);
  assert.ok(plan.refusals.some((r) => /9028-1A\(LHF\)/.test(r) && /no sales line/.test(r)), plan.refusals.join(" | "));
});

test("REFUSES an over-convert — two purchase lines may not claim one unit", () => {
  const po = [
    ...poRows(),
    { id: "po-second-2a-26", item_code: "9028-2A(RHF)", qty: 1, seat: "26", so_item_id: null },
  ];
  const plan = planDedication({ poRows: po, soRows: soRows() });
  /* Two unbound 2A(RHF) lines, one sales line: neither is forced, so neither
     moves. The answer is a person's, not a coin toss. */
  assert.equal(moveTo(plan, PO_2A_26), null);
  assert.equal(moveTo(plan, "po-second-2a-26"), null);
  assert.ok(plan.refusals.some((r) => /9028-2A\(RHF\)/.test(r)), plan.refusals.join(" | "));
});

test("REFUSES to bind an unlinked line on a purchase order that is a stranger to this sales order", () => {
  /* No line on this PO points at any line of the sales order, so nothing
     evidences that the two documents belong together. */
  const po = poRows().map((r) => ({ ...r, so_item_id: null }));
  const plan = planDedication({ poRows: po, soRows: soRows() });
  assert.deepEqual(plan.moves, []);
  assert.ok(
    plan.refusals.every((r) => /nothing evidences that the two documents belong together/.test(r)),
    plan.refusals.join(" | "),
  );
  assert.equal(plan.belongs, false);
});

test("a qty that would exceed the sales line is refused, not truncated", () => {
  const po = poRows().map((r) => (r.id === PO_2A_26 ? { ...r, qty: 3 } : r));
  const plan = planDedication({ poRows: po, soRows: soRows() });
  assert.equal(moveTo(plan, PO_2A_26), null);
  assert.ok(plan.refusals.some((r) => /3 > 1|exceed/i.test(r)), plan.refusals.join(" | "));
});
