// Unit tests for the DP-order (manual delivery-planning job) per-assignee row
// scope — the gap PR #756 left open. Route-level coverage is not possible in
// this harness (scm rides Supabase Postgres), so these pin the pure filtering
// rule the GET /dp-orders list and the write-ownership guard rely on: a DP order
// is a self-scoped Driver/Helper's own iff its TRIP's crew includes their fleet
// id, and an ops/dispatcher (`all`) caller sees every DP order unchanged.
import { describe, expect, test } from 'vitest';
import { filterDpOrdersByScope } from '../src/scm/routes/dp-orders';
import type { CrewAssignment, DeliveryScope } from '../src/scm/lib/deliveryScope';

type Row = { id: string; trip_id: string | null };

// Three DP orders on three different trips + one still unscheduled (no trip).
const rows: Row[] = [
  { id: 'dp-own-driver', trip_id: 'trip-A' }, // trip crew = driver drv-1
  { id: 'dp-own-helper', trip_id: 'trip-B' }, // trip crew = helper hlp-1
  { id: 'dp-other-crew', trip_id: 'trip-C' }, // trip crew = someone else
  { id: 'dp-unscheduled', trip_id: null },    // no trip → no crew
];

const tripCrew = new Map<string, CrewAssignment>([
  ['trip-A', { driverIds: ['drv-1'], helperIds: [null, null] }],
  ['trip-B', { driverIds: ['drv-9'], helperIds: ['hlp-1', null] }],
  ['trip-C', { driverIds: ['drv-9'], helperIds: ['hlp-9', null] }],
]);

const driverScope: DeliveryScope = {
  mode: 'self',
  driverIds: new Set(['drv-1']),
  helperIds: new Set(['hlp-1']),
};

describe('filterDpOrdersByScope', () => {
  test('an ops/dispatcher (`all`) scope sees every DP order, unchanged', () => {
    const out = filterDpOrdersByScope({ mode: 'all' }, rows, tripCrew);
    expect(out).toBe(rows); // identity — no copy, no drop
    expect(out.map((r) => r.id)).toEqual([
      'dp-own-driver', 'dp-own-helper', 'dp-other-crew', 'dp-unscheduled',
    ]);
  });

  test('a self-scoped Driver/Helper sees ONLY their own DP jobs', () => {
    const out = filterDpOrdersByScope(driverScope, rows, tripCrew);
    // Kept: the trip they drive AND the trip they help on.
    expect(out.map((r) => r.id).sort()).toEqual(['dp-own-driver', 'dp-own-helper']);
    // Dropped: another crew's job, and the unscheduled (no-trip) job.
    expect(out.map((r) => r.id)).not.toContain('dp-other-crew');
    expect(out.map((r) => r.id)).not.toContain('dp-unscheduled');
  });

  test('an unscheduled DP order (no trip, no crew) never matches a self scope', () => {
    const out = filterDpOrdersByScope(driverScope, [{ id: 'x', trip_id: null }], tripCrew);
    expect(out).toEqual([]);
  });

  test('a self scope with no matching crew keeps nothing', () => {
    const stranger: DeliveryScope = { mode: 'self', driverIds: new Set(['drv-x']), helperIds: new Set(['hlp-x']) };
    const out = filterDpOrdersByScope(stranger, rows, tripCrew);
    expect(out).toEqual([]);
  });
});
