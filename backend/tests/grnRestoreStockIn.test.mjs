import { test } from 'vitest';
import assert from 'node:assert/strict';
import { planGrnStockRestore, GRN_CANCEL_NOTE } from '../scripts/lib/grn-restore-stock-in.mjs';

const grn = { status: 'POSTED', migrated_no_stock: false };
const lines = [{ item_code: 'A', qty_accepted: 1, item_group: 'sofa' }];
const mv = (type, at, extra = {}) => ({
  id: `${type}-${at}`, movement_type: type, item_code: 'A', variant_key: 'v', warehouse_id: 'kl',
  qty: 1, unit_cost_sen: type === 'IN' ? 125000 : null, notes: null, created_at: at, ...extra,
});

test('a re-posted GRN short by its cancel reversal restores one IN copied from the original', () => {
  const plan = planGrnStockRestore(grn, lines, [mv('IN', '05:03'), mv('OUT', '06:07', { notes: GRN_CANCEL_NOTE })]);
  assert.deepEqual(plan.refused, []);
  assert.deepEqual(plan.restore, [{ code: 'A', qty: 1, templateId: 'IN-05:03', unitCostSen: 125000, net: 0, want: 1 }]);
});

test('after the repair the plan is empty (re-run is inert)', () => {
  const plan = planGrnStockRestore(grn, lines, [
    mv('IN', '05:03'), mv('OUT', '06:07', { notes: GRN_CANCEL_NOTE }), mv('IN', '07:00'),
  ]);
  assert.deepEqual(plan, { restore: [], refused: [] });
});

test('refuses anything that is not the re-post gap', () => {
  assert.ok(planGrnStockRestore({ ...grn, status: 'CANCELLED' }, lines, []).refuse);
  // short, but not by a cancel reversal
  assert.equal(planGrnStockRestore(grn, lines, [mv('IN', '05:03'), mv('OUT', '06:07')]).refused.length, 1);
  // zero-cost original IN
  assert.equal(planGrnStockRestore(grn, lines, [
    mv('IN', '05:03', { unit_cost_sen: 0 }), mv('OUT', '06:07', { notes: GRN_CANCEL_NOTE }),
  ]).refused.length, 1);
});
