/**
 * Split a cutover lot that shipped a little and kept the rest, so the units
 * still on the shelf can be given their real purchase cost WITHOUT rewriting
 * the cost the shipped units already went out at.
 *
 * WHY A SPLIT AND NOT AN UPDATE. `backfill-zero-cost-lots.mjs` costed 264 lots
 * on 2026-09-04, and deliberately refused any lot that was not FULLY unconsumed
 * — one `unit_cost_sen` is shared by every unit in the row, so setting it on a
 * partly-shipped lot restates the whole receipt. 34 lots / 2,590 units were
 * left behind by that rule, and they are real stock that will ship at zero cost
 * and read as 100% margin. Splitting the row is what lets both halves be true
 * at once: the closed half keeps the zero it shipped at, the open half carries
 * the purchase price.
 *
 * THE ARITHMETIC THIS MODULE OWNS, and why it is here rather than inline in the
 * script: it decides how much money goes onto the balance sheet. The script it
 * serves cannot be unit-tested (it needs a live Postgres); this can, and is —
 * split-partly-shipped-lots.test.mjs pins every number against production rows
 * read on 2026-09-04.
 *
 * NO SHEBANG — this is a library, not a command.
 */

/** The cost file is keyed on a normalised item code; a stray double space in
 *  the lot's code must not cost that item its price. */
export const normCode = (s) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

/**
 * Plan the split of ONE lot.
 *
 * @param {{lotId: string, itemCode: string, variantKey?: string, warehouseId?: string,
 *          qtyReceived: number, qtyRemaining: number, unitCostSen: number|null,
 *          consumedQty: number, consumedCostSen: number, movementId?: string|null,
 *          receivedAt?: string}} lot   as read from scm.inventory_lots, with
 *          consumedQty / consumedCostSen summed from scm.inventory_lot_consumptions
 * @param {number} costSen  the item's most recent PRICED AutoCount purchase, in sen
 * @returns {{ok: true, plan: object} | {ok: false, reason: string, lotId: string, detail?: string}}
 */
export function planSplit(lot, costSen) {
  const refuse = (reason, detail) => ({ ok: false, reason, lotId: lot.lotId, itemCode: lot.itemCode, detail });

  const received = Number(lot.qtyReceived);
  const remaining = Number(lot.qtyRemaining);
  const consumed = Number(lot.consumedQty);
  const unitCost = Number(lot.unitCostSen ?? 0);
  const settledCogs = Number(lot.consumedCostSen ?? 0);

  if (!Number.isInteger(received) || !Number.isInteger(remaining) || !Number.isInteger(consumed)) {
    return refuse('non-integer-quantity', `received=${lot.qtyReceived} remaining=${lot.qtyRemaining} consumed=${lot.consumedQty}`);
  }
  // Already costed — either by the fully-unconsumed backfill or by a real
  // receipt. Nothing here is entitled to restate it.
  if (unitCost !== 0) return refuse('already-costed', `unit_cost_sen=${unitCost}`);
  if (remaining <= 0) return refuse('nothing-on-hand', `qty_remaining=${remaining}`);
  // A fully unconsumed lot belongs to backfill-zero-cost-lots.mjs, which can
  // simply set the cost. Splitting it would mint an empty sibling row.
  if (remaining >= received) return refuse('nothing-consumed', `received=${received} remaining=${remaining}`);
  // The lot's own arithmetic and the consumption ledger must already agree. If
  // they do not, one of them is wrong, and deciding which is not this script's
  // job — that is check-inventory-integrity.mjs's finding to report.
  if (consumed !== received - remaining) {
    return refuse('ledger-disagrees', `received-remaining=${received - remaining} but consumptions sum to ${consumed}`);
  }
  // A zero-cost lot whose shipped units booked REAL money is a contradiction,
  // and CLAUDE.md's rule is that a contradiction is a finding, not something to
  // bridge. Refuse it and say so.
  if (settledCogs !== 0) return refuse('settled-cogs-not-zero', `consumptions total_cost_sen=${settledCogs}`);
  // GWP / demo / display: no purchase price anywhere in AutoCount. Zero IS
  // their cost, and the owner's 2026-08-10 reading of the list said so.
  if (!(Number(costSen) > 0)) return refuse('no-purchase-price');

  const splitUnitCostSen = Math.round(Number(costSen));
  const valueDeltaSen = remaining * splitUnitCostSen;

  return {
    ok: true,
    plan: {
      lotId: lot.lotId,
      itemCode: lot.itemCode,
      movementId: lot.movementId ?? null,

      // ── the ORIGINAL row, restated to be only what it actually still is ──
      // It received `received` units and `consumed` of them left at zero cost.
      // After the split it is the CLOSED half: the units that shipped, at the
      // cost they shipped at. Its id does not change, so every consumption row
      // and every COGS line still points at it.
      keepQty: consumed,
      keepQtyRemaining: 0,
      keepUnitCostSen: 0,

      // ── the NEW row: everything still on the shelf, at the real cost ──
      splitQty: remaining,
      splitQtyRemaining: remaining,
      splitUnitCostSen,
      // FIFO is `received_at ASC, id ASC` (scm.fn_consume_fifo). The new row
      // INHERITS the instant so it keeps the original's place in the queue.
      splitReceivedAt: lot.receivedAt ?? null,

      // ── the receipt movement ──
      // Value it at what is actually capitalised, NOT at the whole receipt:
      // the consumed units left at zero and that COGS is settled, so booking
      // received x cost would put money on the books that nothing holds.
      // unit x qty therefore does NOT equal total on this row, deliberately —
      // the same convention the OUT branch already uses after a partial short.
      movementUnitCostSen: splitUnitCostSen,
      movementTotalCostSen: valueDeltaSen,

      valueDeltaSen,
    },
  };
}

/**
 * Plan every lot, and total what the run would move.
 *
 * @param {Array<object>} lots
 * @param {Map<string, number>} costByItem  normalised item code -> cost in sen
 */
export function planSplits(lots, costByItem) {
  const plan = [];
  const refused = [];
  for (const lot of lots) {
    const r = planSplit(lot, costByItem.get(normCode(lot.itemCode)) ?? 0);
    if (r.ok) plan.push(r.plan);
    else refused.push(r);
  }
  const totals = {
    lots: plan.length,
    splitUnits: plan.reduce((s, p) => s + p.splitQty, 0),
    keepUnits: plan.reduce((s, p) => s + p.keepQty, 0),
    valueDeltaSen: plan.reduce((s, p) => s + p.valueDeltaSen, 0),
  };
  return { plan, refused, totals };
}

/**
 * The three things that must hold across one lot's transaction, asserted on
 * numbers re-read inside that transaction rather than on a row count.
 *
 * A row count is not a shape (CLAUDE.md): on 2026-08-13 a repair reproduced the
 * jsonb double-encoding bug on 7 rows and its count reported 7 of 7.
 *
 * @param {{qtyRemaining: number, qtyReceived: number, valueSen: number, cogsDigest: string}} before
 * @param {{qtyRemaining: number, qtyReceived: number, valueSen: number, cogsDigest: string}} after
 * @param {number} expectedValueDeltaSen
 * @returns {string[]} one line per broken invariant; empty means all held
 */
export function conservation(before, after, expectedValueDeltaSen) {
  const fails = [];
  if (Number(after.qtyRemaining) !== Number(before.qtyRemaining)) {
    fails.push(`on-hand quantity moved: ${before.qtyRemaining} -> ${after.qtyRemaining}`);
  }
  if (Number(after.qtyReceived) !== Number(before.qtyReceived)) {
    fails.push(`received quantity moved: ${before.qtyReceived} -> ${after.qtyReceived}`);
  }
  const moved = Number(after.valueSen) - Number(before.valueSen);
  if (moved !== Number(expectedValueDeltaSen)) {
    fails.push(`inventory value moved by ${moved} sen, planned ${expectedValueDeltaSen} sen`);
  }
  if (String(after.cogsDigest) !== String(before.cogsDigest)) {
    fails.push(`settled COGS changed: digest ${before.cogsDigest} -> ${after.cogsDigest}`);
  }
  return fails;
}
