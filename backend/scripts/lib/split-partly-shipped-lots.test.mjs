/**
 * node --test backend/scripts/lib/split-partly-shipped-lots.test.mjs
 *
 * Zero dependencies, so it runs on a bare checkout — which is how
 * .github/workflows/working-agreement.yml runs it (`node --test
 * scripts/lib/*.test.mjs`, no `npm ci` in that job).
 *
 * WHAT THIS PINS. Every lot below is REAL: read off production (company 1,
 * Houzs Century) on 2026-09-04 with the read-only `claude_ro` role, and every
 * cost is the item's most recent PRICED AutoCount purchase-invoice line out of
 * backend/scripts/data/ac-last-purchase-costs.json.gz. Nothing here is
 * illustrative — the arithmetic these tests fix is the arithmetic that decides
 * how much inventory value the repair puts on the books.
 *
 * NO SHEBANG — this is a library, not a command.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { conservation, planSplit, planSplits } from './split-partly-shipped-lots.mjs';

/** The biggest of the 34: 633 received, 628 still on hand, 5 already shipped. */
const AK7 = {
  lotId: 'lot-ak7',
  itemCode: 'AK-SLEEP ESSENTIAL 7 HOLES',
  variantKey: '',
  warehouseId: 'wh-1',
  qtyReceived: 633,
  qtyRemaining: 628,
  unitCostSen: 0,
  consumedQty: 5,
  consumedCostSen: 0,
  movementId: 'mov-ak7',
  receivedAt: '2026-08-28T12:55:47.000Z',
};
const RM = (ringgit) => Math.round(ringgit * 100);

test('a partly-shipped lot splits into the shipped part and the on-hand part', () => {
  const r = planSplit(AK7, RM(18));
  assert.equal(r.ok, true, r.reason);
  // The ORIGINAL row keeps the 5 units that already shipped, at the cost they
  // shipped at (zero), and goes closed.
  assert.equal(r.plan.keepQty, 5);
  assert.equal(r.plan.keepUnitCostSen, 0);
  // The NEW row carries the 628 still on hand, at the real purchase cost.
  assert.equal(r.plan.splitQty, 628);
  assert.equal(r.plan.splitUnitCostSen, 1800);
  // 628 x RM18.00 = RM11,304.00
  assert.equal(r.plan.valueDeltaSen, 1130400);
});

test('quantity is conserved: what the lot held before is what the two rows hold after', () => {
  const { plan } = planSplit(AK7, RM(18));
  assert.equal(plan.keepQty + plan.splitQty, AK7.qtyReceived, 'received must not move');
  assert.equal(plan.keepQtyRemaining + plan.splitQtyRemaining, AK7.qtyRemaining, 'on-hand must not move');
  assert.equal(plan.keepQtyRemaining, 0, 'the shipped part is closed, not on hand');
});

test('the movement is re-valued at what is actually capitalised, never at the whole receipt', () => {
  const { plan } = planSplit(AK7, RM(18));
  // 5 units left at ZERO cost and that COGS is settled. Booking 633 x RM18 on
  // the receipt would put RM90 of value on the books that nothing holds.
  assert.equal(plan.movementTotalCostSen, 1130400);
  assert.notEqual(plan.movementTotalCostSen, 633 * 1800);
  assert.equal(plan.movementUnitCostSen, 1800);
});

test('FIFO position is inherited, not minted', () => {
  const { plan } = planSplit(AK7, RM(18));
  assert.equal(plan.splitReceivedAt, '2026-08-28T12:55:47.000Z');
});

test('a lot the fully-unconsumed backfill already owns is refused, not split again', () => {
  const untouched = { ...AK7, qtyRemaining: 633, consumedQty: 0 };
  const r = planSplit(untouched, RM(18));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'nothing-consumed');
});

test('a lot that already carries a cost is refused', () => {
  const r = planSplit({ ...AK7, unitCostSen: 1800 }, RM(18));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'already-costed');
});

test('no purchase price anywhere is left alone — zero IS its cost', () => {
  const r = planSplit({ ...AK7, itemCode: 'GN-VM PILLOW-DEMO' }, 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-purchase-price');
});

test('a lot whose consumption rows disagree with its own arithmetic is refused, not reconciled', () => {
  // 633 - 628 = 5, but the consumption ledger says 4. One of the two is wrong
  // and this script is not the thing that decides which.
  const r = planSplit({ ...AK7, consumedQty: 4 }, RM(18));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ledger-disagrees');
});

test('a zero-cost lot whose shipped units booked real COGS is a contradiction, and is refused', () => {
  const r = planSplit({ ...AK7, consumedCostSen: 9000 }, RM(18));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'settled-cogs-not-zero');
});

test('the plan totals are the sum of its rows, and refusals never enter them', () => {
  const lots = [
    AK7,
    { ...AK7, lotId: 'lot-ntyr', itemCode: 'NTYR-CS LTX PIL + CSC', qtyReceived: 557, qtyRemaining: 551, consumedQty: 6 },
    { ...AK7, lotId: 'lot-demo', itemCode: 'GN-VM PILLOW-DEMO' },
  ];
  const costs = new Map([
    ['AK-SLEEP ESSENTIAL 7 HOLES', RM(18)],
    ['NTYR-CS LTX PIL + CSC', RM(46.5)],
  ]);
  const out = planSplits(lots, costs);
  assert.equal(out.plan.length, 2);
  assert.equal(out.refused.length, 1);
  assert.equal(out.refused[0].reason, 'no-purchase-price');
  assert.equal(out.totals.splitUnits, 628 + 551);
  assert.equal(out.totals.keepUnits, 5 + 6);
  // 628 x 1800 + 551 x 4650 = 1,130,400 + 2,562,150
  assert.equal(out.totals.valueDeltaSen, 1130400 + 2562150);
});

test('the item lookup is case- and whitespace-insensitive, the way the cost file is keyed', () => {
  const costs = new Map([['AK-SLEEP ESSENTIAL 7 HOLES', RM(18)]]);
  const out = planSplits([{ ...AK7, itemCode: '  ak-sleep   essential 7 holes ' }], costs);
  assert.equal(out.plan.length, 1, 'a stray double space must not cost the item its price');
  assert.equal(out.plan[0].splitUnitCostSen, 1800);
});

// ── conservation(): the arithmetic the apply path asserts inside each txn ────

test('conservation passes only when quantity holds AND value moved by exactly the plan', () => {
  const before = { qtyRemaining: 628, qtyReceived: 633, valueSen: 0, cogsDigest: 'abc' };
  const after = { qtyRemaining: 628, qtyReceived: 633, valueSen: 1130400, cogsDigest: 'abc' };
  assert.deepEqual(conservation(before, after, 1130400), []);
});

test('conservation catches a value move that is off by even one sen', () => {
  const before = { qtyRemaining: 628, qtyReceived: 633, valueSen: 0, cogsDigest: 'abc' };
  const after = { qtyRemaining: 628, qtyReceived: 633, valueSen: 1130401, cogsDigest: 'abc' };
  const fails = conservation(before, after, 1130400);
  assert.equal(fails.length, 1);
  assert.match(fails[0], /value/i);
});

test('conservation catches quantity that moved, which a row count never would', () => {
  const before = { qtyRemaining: 628, qtyReceived: 633, valueSen: 0, cogsDigest: 'abc' };
  const after = { qtyRemaining: 1256, qtyReceived: 1261, valueSen: 1130400, cogsDigest: 'abc' };
  const fails = conservation(before, after, 1130400);
  assert.equal(fails.length, 2, 'both the on-hand and the received totals moved');
});

test('conservation catches settled COGS that changed — the one thing this repair must never do', () => {
  const before = { qtyRemaining: 628, qtyReceived: 633, valueSen: 0, cogsDigest: 'abc' };
  const after = { qtyRemaining: 628, qtyReceived: 633, valueSen: 1130400, cogsDigest: 'def' };
  const fails = conservation(before, after, 1130400);
  assert.equal(fails.length, 1);
  assert.match(fails[0], /COGS/);
});
