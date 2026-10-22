import { describe, it, expect } from 'vitest';
import { filterOrdersByRegion, planningCountsFrom, sxeDateOf } from './delivery-planning-queries';
import type { DeliveryState, PlanningOrder } from './delivery-planning-queries';

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

/* The "Sales Exemption Expiry Date" column value — ASSR rows show their own
   service date (customer_delivery_date), everyone else the AutoCount book value
   (owner 2026-10-22). sxeDateOf reads only these three fields. */
const order = (p: Partial<PlanningOrder>): PlanningOrder => (p as PlanningOrder);
describe('sxeDateOf', () => {
  it('an ASSR row shows its own service date, not the (null) book value', () => {
    expect(sxeDateOf(order({ row_type: 'assr', customer_delivery_date: '2026-09-05', ac_sales_exemption_expiry: null }))).toBe('2026-09-05');
  });
  it('an SO row shows the AutoCount book exemption date, never its delivery date', () => {
    expect(sxeDateOf(order({ row_type: 'so', customer_delivery_date: '2026-09-01', ac_sales_exemption_expiry: '2026-12-31' }))).toBe('2026-12-31');
  });
  it('a project / DP row with no book value stays blank', () => {
    expect(sxeDateOf(order({ row_type: 'project', customer_delivery_date: '2026-09-10', ac_sales_exemption_expiry: null }))).toBeNull();
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
