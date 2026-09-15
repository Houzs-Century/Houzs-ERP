// The scripts' mirror of `isHardBoundLine` must answer as the engine does, and the
// MRP link repair must plan a Sofa Accessory line (2026-09-15). Its SQL copy read
// `in ('sofa','bedframe')` a day after `fabric_accessory` joined the rule, so a
// pillow purchase line filed under the wrong category could never be planned.
import { describe, expect, it } from 'vitest';
import { isHardBoundLine } from '../src/scm/lib/so-stock-allocation';
import { isHardBound, HARD_BOUND_GROUPS, planCategoryRepairs } from '../scripts/lib/hard-bound-group.mjs';

const CASES: Array<[string | null, string | null]> = [
  ['sofa', '8030-1A(LHF)'], ['SOFA', '8030-CNR'], ['bedframe', 'JAGER-(Q)'], ['fabric_accessory', 'SQUARE PILLOW'],
  ['FABRIC_ACCESSORY', 'BC04'], ['accessory', 'SQUARE PILLOW'], ['mattress', 'AKEMI BULWARK MATT (SP)'],
  ['mattress', 'AKEMI BULWARK MATT (SP)  '], ['mattress', 'AKEMI BULWARK MATT (K)'], ['others', 'X (SP)'],
  [null, null], ['', 'SOFA'], ['service', 'DELIVERY'],
];

describe('scripts/lib/hard-bound-group.mjs mirrors isHardBoundLine', () => {
  it.each(CASES)('group %s / code %s', (group, code) => {
    expect(isHardBound(group, code)).toBe(isHardBoundLine(group, code));
  });

  it('carries every bound group the engine binds', () => {
    for (const g of HARD_BOUND_GROUPS) expect(isHardBoundLine(g, 'ANY')).toBe(true);
    expect(HARD_BOUND_GROUPS).toContain('fabric_accessory');
  });
});

describe('MRP link repair — class B plans a Sofa Accessory line', () => {
  const row = (over: Record<string, unknown>) => ({
    po_item_id: 'poi-1', po_number: 'HC-PO-1', po_status: 'SUBMITTED', item_code: 'SQUARE PILLOW',
    po_group: 'accessory', so_group: 'fabric_accessory', so_doc_no: 'HC-SO-1', so_line_no: 3,
    qty: 1, received_qty: 0, ...over,
  });

  it('a pillow purchase line filed accessory under a Sofa Accessory sales line is REPAIRED to fabric_accessory', () => {
    const plan = planCategoryRepairs([row({})]);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ verdict: 'REPAIR', fromGroup: 'accessory', toGroup: 'fabric_accessory' });
  });

  it('is left for a human once goods were received under the old group', () => {
    expect(planCategoryRepairs([row({ received_qty: 2 })])[0].verdict).toBe('SKIP');
  });

  it('plans nothing when the purchase side is already bound or the sales side is not', () => {
    expect(planCategoryRepairs([row({ po_group: 'sofa' }), row({ so_group: 'accessory', po_group: 'others' })])).toEqual([]);
  });
});
