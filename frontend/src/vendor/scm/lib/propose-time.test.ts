import { describe, expect, test } from 'vitest';
import {
  confirmedDateOf,
  groupByConfirmedDate,
  pinAssignToDate,
  mergeAssignResults,
  depotForDocNos,
} from './propose-time';
import type { SequenceAssignResponse, AssignedTrip } from './delivery-zones-queries';

/* The Time page's confirmed-date discipline (PR #1716 review): "Propose time"
 * acts on DATE-CONFIRMED orders, so every proposed stop's trip date must equal
 * its order's confirmed date — the Date page owns dates, the packer's own
 * start-date walk must never re-date anything. These tests pin the grouping,
 * the one-day pin (walked-past trips -> overflow FOR the confirmed date), and
 * the end-to-end invariant across a merged multi-date proposal. */

const so = (docNo: string, over: Record<string, unknown> = {}) => ({
  row_type: 'so' as const,
  so_doc_no: docNo,
  amended_delivery_date: '2026-08-10',
  trip_date: null,
  effective_delivery_date: null,
  customer_delivery_date: null,
  ...over,
});

const stop = (ref: string) => ({
  ref, debtorName: null, buildingType: null, address: '', serviceMinutes: 90,
  earliestTime: null, latestTime: null,
});

const trip = (over: Partial<AssignedTrip>): AssignedTrip => ({
  key: 'k1', date: '2026-08-10', group: 'KLANG_VALLEY',
  lorryId: 'lorry-a', plate: 'AAA', driverId: null, driverName: null,
  helperId: null, helperName: null, sets: 1, revenueSen: 100_00,
  ceilingSets: 10, ceilingRevenueSen: null, overCeiling: false,
  departTime: '09:00', stops: [stop('SO-1')], sequence: null,
  routeReason: null, ungeocoded: [],
  ...over,
});

const response = (over: Partial<SequenceAssignResponse>): SequenceAssignResponse => ({
  startDate: '2026-08-10', departTime: '09:00', configured: true,
  usingDefaultZoneMap: false, depotWarehouseId: null, depot: null,
  lorryCount: 2, dispatchableCount: 2, trips: [],
  excludedLorries: [], excludedDrivers: [], overflow: [], carriers: [],
  unassigned: [],
  ...over,
});

describe('confirmedDateOf — the confirmation chain', () => {
  test('amended date is THE confirmation; trip date is the next commitment', () => {
    expect(confirmedDateOf(so('A'))).toBe('2026-08-10');
    expect(confirmedDateOf(so('A', { amended_delivery_date: null, trip_date: '2026-08-12' }))).toBe('2026-08-12');
  });
  test('degraded fallback chain, then honest null', () => {
    expect(confirmedDateOf(so('A', { amended_delivery_date: null, effective_delivery_date: '2026-08-13' }))).toBe('2026-08-13');
    expect(confirmedDateOf(so('A', { amended_delivery_date: null, customer_delivery_date: '2026-08-14' }))).toBe('2026-08-14');
    expect(confirmedDateOf(so('A', { amended_delivery_date: null }))).toBeNull();
  });
  test('a stray timestamp truncates to its calendar day', () => {
    expect(confirmedDateOf(so('A', { amended_delivery_date: '2026-08-10T00:00:00Z' }))).toBe('2026-08-10');
  });
});

describe('groupByConfirmedDate — one call per confirmed date', () => {
  test('groups by date ascending; undated orders are reported, never guessed', () => {
    const orders = [
      so('SO-1'),
      so('SO-2', { amended_delivery_date: '2026-08-11' }),
      so('SO-3'),
      so('SO-4', { amended_delivery_date: null }),
    ];
    const { groups, undated } = groupByConfirmedDate(orders, ['SO-2', 'SO-1', 'SO-3', 'SO-4', 'SO-MISSING']);
    expect(groups).toEqual([
      { date: '2026-08-10', docNos: ['SO-1', 'SO-3'] },
      { date: '2026-08-11', docNos: ['SO-2'] },
    ]);
    expect(undated).toEqual(['SO-4', 'SO-MISSING']);
  });
});

describe('depotForDocNos — the depot the engine geocodes windows from', () => {
  const wh = (docNo: string, warehouseId: string | null, name: string | null = null) => ({
    row_type: 'so' as const, so_doc_no: docNo,
    warehouse_id: warehouseId, warehouse_name: name, warehouse_code: null,
  });

  test('majority warehouse wins, with its label for the loud failure message', () => {
    const depot = depotForDocNos([
      wh('SO-1', 'wh-kl', 'KL Warehouse'),
      wh('SO-2', 'wh-kl', 'KL Warehouse'),
      wh('SO-3', 'wh-jb', 'JB Warehouse'),
    ], ['SO-1', 'SO-2', 'SO-3']);
    expect(depot).toEqual({ warehouseId: 'wh-kl', label: 'KL Warehouse' });
  });

  test('ties break to the first seen (deterministic); unselected rows do not vote', () => {
    const depot = depotForDocNos([
      wh('SO-1', 'wh-a', 'A'),
      wh('SO-2', 'wh-b', 'B'),
      wh('SO-3', 'wh-b', 'B'),
    ], ['SO-1', 'SO-2']);
    expect(depot?.warehouseId).toBe('wh-a');
  });

  test('no warehouse anywhere -> null, a state the page must surface loudly', () => {
    expect(depotForDocNos([wh('SO-1', null)], ['SO-1'])).toBeNull();
    expect(depotForDocNos([], ['SO-1'])).toBeNull();
  });
});

describe('pinAssignToDate — the walk is constrained to the confirmed day', () => {
  test('a day-one trip passes through (namespaced key); a walked-past trip spills to overflow FOR the confirmed date', () => {
    const r = response({
      trips: [
        trip({ key: 'a', date: '2026-08-10', stops: [stop('SO-1')] }),
        trip({ key: 'b', date: '2026-08-11', stops: [stop('SO-2'), stop('SO-3')], sets: 4, revenueSen: 900_00 }),
      ],
      overflow: [{ key: 'o1', date: '2026-08-11', group: 'JOHOR', orders: ['SO-9'], sets: 2, revenueSen: 300_00, reason: 'no slot' }],
      unassigned: [{ key: null, date: null, group: null, orders: ['SO-8'], reason: 'no crew' }],
    });
    const pinned = pinAssignToDate(r, '2026-08-10');
    expect(pinned.trips).toHaveLength(1);
    expect(pinned.trips[0]).toMatchObject({ key: '2026-08-10|a', date: '2026-08-10' });
    /* The spilled trip keeps its orders and lands in overflow ON the date. */
    expect(pinned.overflow).toHaveLength(2);
    const spill = pinned.overflow.find((o) => o.orders.includes('SO-2'));
    expect(spill).toMatchObject({ date: '2026-08-10', orders: ['SO-2', 'SO-3'], sets: 4, revenueSen: 900_00 });
    expect(spill?.reason).toContain('own fleet full on 2026-08-10');
    /* Existing overflow + unassigned are pinned to the confirmed date too. */
    expect(pinned.overflow.find((o) => o.orders.includes('SO-9'))?.date).toBe('2026-08-10');
    expect(pinned.unassigned[0].date).toBe('2026-08-10');
    /* Nothing anywhere carries another date. */
    for (const t of pinned.trips) expect(t.date).toBe('2026-08-10');
    for (const o of pinned.overflow) expect(o.date).toBe('2026-08-10');
  });
});

describe('the invariant — every proposed stop lands on its order\'s confirmed date', () => {
  test('grouping + per-date pin + merge: each trip\'s date equals every one of its stops\' confirmed dates', () => {
    const orders = [
      so('SO-1'), so('SO-2'),                                   // confirmed 08-10
      so('SO-3', { amended_delivery_date: '2026-08-12' }),      // confirmed 08-12
    ];
    const { groups } = groupByConfirmedDate(orders, ['SO-1', 'SO-2', 'SO-3']);
    /* Simulate the per-group endpoint calls: the 08-10 packer fits SO-1 on day
       one but walks SO-2 to the next day; the 08-12 packer fits SO-3. */
    const byDate: Record<string, SequenceAssignResponse> = {
      '2026-08-10': response({
        trips: [
          trip({ key: 'a', date: '2026-08-10', stops: [stop('SO-1')] }),
          trip({ key: 'b', date: '2026-08-11', stops: [stop('SO-2')] }),
        ],
      }),
      '2026-08-12': response({
        startDate: '2026-08-12',
        trips: [trip({ key: 'c', date: '2026-08-12', stops: [stop('SO-3')] })],
      }),
    };
    const merged = mergeAssignResults(groups.map((g) => pinAssignToDate(byDate[g.date], g.date)));
    expect(merged).not.toBeNull();

    const confirmed = new Map(orders.map((o) => [o.so_doc_no, confirmedDateOf(o)]));
    /* THE invariant: no trip carries a stop whose confirmed date differs. */
    for (const t of merged!.trips) {
      for (const s of t.stops) expect(t.date).toBe(confirmed.get(s.ref));
    }
    /* And the spilled order surfaces as overflow ON its confirmed date. */
    const spill = merged!.overflow.find((o) => o.orders.includes('SO-2'));
    expect(spill?.date).toBe(confirmed.get('SO-2'));
    /* Merge keeps per-date trips apart and sorts by date. */
    expect(merged!.trips.map((t) => t.date)).toEqual(['2026-08-10', '2026-08-12']);
  });

  test('merge dedupes the repeated fleet facts and is honest about configured', () => {
    const a = pinAssignToDate(response({
      excludedLorries: [{ id: 'L1', plate: 'AAA', status: 'BREAKDOWN' }],
      carriers: [{ id: 'C1', plate: '3PL-1', warehouseId: null }],
    }), '2026-08-10');
    const b = pinAssignToDate(response({
      startDate: '2026-08-12', configured: false,
      excludedLorries: [{ id: 'L1', plate: 'AAA', status: 'BREAKDOWN' }],
      carriers: [{ id: 'C1', plate: '3PL-1', warehouseId: null }],
    }), '2026-08-12');
    const merged = mergeAssignResults([a, b]);
    expect(merged!.excludedLorries).toHaveLength(1);
    expect(merged!.carriers).toHaveLength(1);
    expect(merged!.configured).toBe(false);
    expect(merged!.startDate).toBe('2026-08-10');
    expect(mergeAssignResults([])).toBeNull();
  });
});
