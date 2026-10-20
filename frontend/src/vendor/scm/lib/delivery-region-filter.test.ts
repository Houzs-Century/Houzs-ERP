import { describe, it, expect } from 'vitest';
import { filterOrdersByRegion, planningCountsFrom } from './delivery-planning-queries';
import type { DeliveryState } from './delivery-planning-queries';

/* The region chip now filters in the browser (region=ALL fetch, local filter) —
   the regression guard that it behaves like the backend's matchesRegion:
   'ALL'/unknown → no-op, a known bucket → regions[]-membership. If this drifts,
   switching a region chip would blank the board or show the wrong bucket. */

const KNOWN = new Set(['ALL', 'KL', 'NORTHERN', 'SOUTHERN', 'EAST_COAST', 'EM']);

const o = (regions: string[]) => ({ regions });

describe('filterOrdersByRegion', () => {
  const orders = [o(['KL']), o(['NORTHERN']), o(['SOUTHERN', 'KL']), o(['EM'])];

  it('ALL returns every order (no filter)', () => {
    expect(filterOrdersByRegion(orders, 'ALL', KNOWN)).toHaveLength(4);
  });

  it('a known bucket keeps only orders whose regions[] include it', () => {
    expect(filterOrdersByRegion(orders, 'KL', KNOWN)).toEqual([o(['KL']), o(['SOUTHERN', 'KL'])]);
    expect(filterOrdersByRegion(orders, 'EM', KNOWN)).toEqual([o(['EM'])]);
  });

  it('a bucket with no members returns an empty slice', () => {
    expect(filterOrdersByRegion(orders, 'EAST_COAST', KNOWN)).toEqual([]);
  });

  it('an unknown / stale region key is a no-op, never an empty board', () => {
    expect(filterOrdersByRegion(orders, 'ATLANTIS', KNOWN)).toHaveLength(4);
    expect(filterOrdersByRegion(orders, '', KNOWN)).toHaveLength(4);
  });

  it('does not mutate or alias the input array', () => {
    const out = filterOrdersByRegion(orders, 'ALL', KNOWN);
    expect(out).not.toBe(orders);
  });
});

describe('planningCountsFrom', () => {
  const row = (delivery_state: DeliveryState) => ({ delivery_state });

  it('counts each delivery_state and totals ALL', () => {
    const counts = planningCountsFrom([
      row('PENDING_DELIVERY'), row('PENDING_DELIVERY'), row('OVERDUE'),
      row('DELIVERED'), row('PENDING_SCHEDULE'),
    ]);
    expect(counts).toEqual({ ALL: 5, PENDING_DELIVERY: 2, PENDING_SCHEDULE: 1, OVERDUE: 1, DELIVERED: 1 });
  });

  it('an empty slice is all zeros', () => {
    expect(planningCountsFrom([])).toEqual({ ALL: 0, PENDING_DELIVERY: 0, PENDING_SCHEDULE: 0, OVERDUE: 0, DELIVERED: 0 });
  });
});
