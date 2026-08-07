import { describe, it, expect } from 'vitest';
import { planStockRelease, planAllocationCreate, type AllocationRow } from './po-allocations';

const alloc = (seq: number, qty: number, so: string | null): AllocationRow =>
  ({ id: `a-${seq}`, seq, qty, so_item_id: so });

describe('planStockRelease', () => {
  it('releases the whole line when nothing is sliced', () => {
    expect(planStockRelease(2, [])).toEqual({ seq: 1, qty: 2 });
  });

  it('releases only the un-allocated remainder', () => {
    expect(planStockRelease(5, [alloc(1, 2, 'so-1')])).toEqual({ seq: 2, qty: 3 });
  });

  it('returns null when the line is fully allocated — deliberate splits are not touched', () => {
    expect(planStockRelease(2, [alloc(1, 1, 'so-1'), alloc(2, 1, null)])).toBeNull();
  });

  it('never releases a negative remainder', () => {
    expect(planStockRelease(1, [alloc(1, 2, 'so-1')])).toBeNull();
  });

  it('produces a slice the create-planner itself would accept', () => {
    const existing = [alloc(1, 1, 'so-1')];
    const plan = planStockRelease(3, existing);
    expect(plan).not.toBeNull();
    const create = planAllocationCreate(3, existing, plan!.qty);
    expect('refusal' in create && create.refusal ? create.refusal : null).toBeNull();
  });
});
