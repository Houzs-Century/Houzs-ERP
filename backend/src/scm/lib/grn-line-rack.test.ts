import { describe, it, expect } from 'vitest';
import { planGrnLineRackChange } from './grn-line-rack';

const base = {
  grnStatus: 'POSTED', migratedNoStock: false,
  fromRackId: null as string | null, toRackId: 'R2' as string | null,
  qtyAccepted: 1, placedRows: [] as { id: string; qty: number }[],
};

describe('planGrnLineRackChange', () => {
  it('places a posted line that had no rack (the HC-GRN-2610-005 case)', () => {
    expect(planGrnLineRackChange(base)).toEqual({ kind: 'place' });
  });

  it('refuses on a cancelled or closed GRN', () => {
    for (const grnStatus of ['CANCELLED', 'closed']) {
      expect(planGrnLineRackChange({ ...base, grnStatus }).kind).toBe('refuse');
    }
  });

  it('is a no-op when the rack does not change', () => {
    expect(planGrnLineRackChange({ ...base, fromRackId: 'R2' })).toEqual({ kind: 'noop' });
    expect(planGrnLineRackChange({ ...base, toRackId: null })).toEqual({ kind: 'noop' });
  });

  it('only writes the row when nothing is on a shelf from this GRN', () => {
    expect(planGrnLineRackChange({ ...base, grnStatus: 'DRAFT', fromRackId: 'R1' })).toEqual({ kind: 'row_only' });
    expect(planGrnLineRackChange({ ...base, migratedNoStock: true })).toEqual({ kind: 'row_only' });
    expect(planGrnLineRackChange({ ...base, qtyAccepted: 0 })).toEqual({ kind: 'row_only' });
  });

  it('moves or pulls the placed row matching the line qty', () => {
    const placedRows = [{ id: 'a', qty: 2 }, { id: 'b', qty: 1 }];
    expect(planGrnLineRackChange({ ...base, fromRackId: 'R1', placedRows })).toEqual({ kind: 'move', rowId: 'b' });
    expect(planGrnLineRackChange({ ...base, fromRackId: 'R1', toRackId: null, placedRows })).toEqual({ kind: 'pull', rowId: 'b' });
  });

  it('refuses when the placed goods were already moved on the rack board', () => {
    const plan = planGrnLineRackChange({ ...base, fromRackId: 'R1', placedRows: [{ id: 'a', qty: 3 }] });
    expect(plan.kind).toBe('refuse');
    if (plan.kind === 'refuse') expect(plan.body.message.length).toBeLessThan(200);
  });
});
