import { describe, expect, test } from 'vitest';
import {
  docRowVM, buildRuns, applyFilters, searchMatch, latestLiveDoId,
  EMPTY_FILTERS, filtersActive, isoToMytTime, mytTimeToIso, type DocRowVM, type DayClock,
} from './vm';
import type { PlanningOrder } from '../../../vendor/scm/lib/delivery-planning-queries';
import type { FleetDayTrip } from '../../../vendor/scm/lib/fleet-day-queries';
import type { DriverRow } from '../../../vendor/scm/lib/drivers-queries';
import type { StopStatus } from '../../../vendor/scm/lib/delivery-stop-status';

const CLOCK: DayClock = { day: '2026-11-01', today: '2026-11-01', nowMinutes: 13 * 60 };

function order(over: Partial<PlanningOrder> = {}): PlanningOrder {
  return {
    row_type: 'so', so_doc_no: 'HC-SO-000123', debtor_name: 'Ada Wong', phone: '012-3456789',
    address: '12 Jalan Besar', region: 'KL/SEL', regions: ['KL/SEL'], branding: 'HOUZS',
    local_total_sen: 299000, delivered_qty: 1, remaining_qty: 2, time_range: '9-12',
    so_ref: 'pg0791', salesperson_id: 'staff-1', agent: 'Ada', has_pod: false,
    delivered_at: null, customer_delivered_date: null, trip_id: 't1', trip_stop_no: 2,
    delivery_orders: [{ id: 'do-1', do_number: 'HC-DO-9', status: 'LOADED' }],
    crew: { driver: null, helper: null, lorry: null, driver_1_name: null, driver_1_ic: null,
      driver_1_contact: null, driver_2_name: null, helper_1_name: null, helper_2_name: null, lorry_plate: null },
    ...over,
  } as unknown as PlanningOrder;
}

function trip(over: Partial<FleetDayTrip> = {}): FleetDayTrip {
  return {
    id: 't1', trip_no: 'TRIP-2611-0001', trip_date: '2026-11-01', status: 'PLANNED',
    is_outsourced: false, total_distance_km: null, lorry: { id: 'l1', plate: 'VQE9058' },
    driver: { id: 'd1', name: 'Shamsul' }, helpers: [{ id: 'h1', name: 'Ali' }, { id: 'h2', name: 'Bo' }],
    warehouse: null, depot: null, total_revenue_sen: 0, total_drops: 0, total_delivered: 0,
    total_with_pod: 0, stops: [], ...over,
  } as FleetDayTrip;
}

describe('latestLiveDoId', () => {
  test('picks the last non-draft/cancelled DO', () => {
    expect(latestLiveDoId({ delivery_orders: [
      { id: 'a', do_number: 'A', status: 'DRAFT' },
      { id: 'b', do_number: 'B', status: 'LOADED' },
    ] })).toBe('b');
    expect(latestLiveDoId({ delivery_orders: [{ id: 'a', do_number: 'A', status: 'CANCELLED' }] })).toBeNull();
    expect(latestLiveDoId({ delivery_orders: [] })).toBeNull();
  });
});

describe('docRowVM — field mapping + late', () => {
  test('maps the row, derives units/slot/DO, and marks overdue as late', () => {
    const d = docRowVM(order(), 'overdue', CLOCK);
    expect(d.key).toBe('so:HC-SO-000123');
    expect(d.customer).toBe('Ada Wong');
    expect(d.doNumber).toBe('HC-DO-9');
    expect(d.ref).toBe('pg0791');
    expect(d.units).toBe(3);
    expect(d.slotKind).toBe('AM');
    expect(d.slotLabel).toBe('AM');
    expect(d.stopNo).toBe(2);
    expect(d.late).toBe(true);
    expect(d.lateReason).toBe('Past its 12:00 PM slot');
    expect(d.latestLiveDoId).toBe('do-1');
  });
  test('a delivered row is not late and carries its delivered time', () => {
    const d = docRowVM(order({ delivered_at: '2026-11-01T03:20:00Z' }), 'done', CLOCK);
    expect(d.late).toBe(false);
    expect(d.deliveredAt).toBe('2026-11-01T03:20:00Z');
  });
});

describe('buildRuns — grouping + driver join + sort', () => {
  const drivers = new Map<string, DriverRow>([
    ['d1', { id: 'd1', driver_code: 'DRV-1', name: 'Shamsul', phone: '019-9', ic_number: '900101-10-1', vehicle: null, active: true, created_at: '' }],
  ]);
  test('a run carries its drops sorted by stop, with crew joined', () => {
    const docs: DocRowVM[] = [
      docRowVM(order({ so_doc_no: 'S2', trip_stop_no: 3 }), 'done', CLOCK),
      docRowVM(order({ so_doc_no: 'S1', trip_stop_no: 1, has_pod: true, crew: { driver_2_name: 'Zaki' } as PlanningOrder['crew'] }), 'done', CLOCK),
      docRowVM(order({ so_doc_no: 'OFF', trip_id: 'other', trip_stop_no: 1 }), 'scheduled', CLOCK),
    ];
    const runs = buildRuns([trip()], docs, drivers, () => '#2563eb');
    expect(runs).toHaveLength(1);
    const r = runs[0]!;
    expect(r.plate).toBe('VQE9058');
    expect(r.driverIc).toBe('900101-10-1');
    expect(r.driverPhone).toBe('019-9');
    expect(r.driver2Name).toBe('Zaki');
    expect(r.helpers).toEqual(['Ali', 'Bo']);
    expect(r.docs.map((d) => d.soDocNo)).toEqual(['S1', 'S2']); // sorted by stop, off-trip dropped
    expect(r.status).toBe('COMPLETED');
    expect(r.rollup).toMatchObject({ drops: 2, delivered: 2, withPod: 1 });
    expect(r.color).toBe('#2563eb');
  });
});

describe('applyFilters + searchMatch', () => {
  const docs = [
    docRowVM(order({ so_doc_no: 'A', region: 'KL/SEL', regions: ['KL/SEL'], salesperson_id: 's1', time_range: '9-12' }), 'overdue', CLOCK),
    docRowVM(order({ so_doc_no: 'B', region: 'NTH', regions: ['NTH'], salesperson_id: 's2', time_range: '2pm-6pm' }), 'done', CLOCK),
  ];
  test('region, status, slot, salesperson, lateOnly each narrow', () => {
    expect(applyFilters(docs, { ...EMPTY_FILTERS, region: 'NTH' }).map((d) => d.soDocNo)).toEqual(['B']);
    expect(applyFilters(docs, { ...EMPTY_FILTERS, status: 'done' }).map((d) => d.soDocNo)).toEqual(['B']);
    expect(applyFilters(docs, { ...EMPTY_FILTERS, slot: 'PM' }).map((d) => d.soDocNo)).toEqual(['B']);
    expect(applyFilters(docs, { ...EMPTY_FILTERS, salespersonId: 's1' }).map((d) => d.soDocNo)).toEqual(['A']);
    expect(applyFilters(docs, { ...EMPTY_FILTERS, lateOnly: true }).map((d) => d.soDocNo)).toEqual(['A']);
  });
  test('search matches name, SO, DO, ref and >=3 phone digits', () => {
    const d = docs[0]!;
    expect(searchMatch(d, 'a')).toBe(true); // <2 chars = everything
    expect(searchMatch(d, 'ada')).toBe(true);
    expect(searchMatch(d, 'pg0791')).toBe(true);
    expect(searchMatch(d, 'HC-DO-9')).toBe(true);
    expect(searchMatch(d, '345')).toBe(true); // phone digits
    expect(searchMatch(d, 'nope')).toBe(false);
  });
  test('filtersActive flags any non-default', () => {
    expect(filtersActive(EMPTY_FILTERS)).toBe(false);
    expect(filtersActive({ ...EMPTY_FILTERS, lateOnly: true })).toBe(true);
  });
});

describe('isoToMytTime / mytTimeToIso', () => {
  test('round-trips a Malaysian clock through the board day', () => {
    const iso = mytTimeToIso('2026-11-01', '08:30');
    expect(iso).toBe('2026-11-01T08:30:00+08:00');
    expect(isoToMytTime(iso)).toBe('08:30');
  });
  test('blank clears; absent reads empty', () => {
    expect(mytTimeToIso('2026-11-01', '')).toBeNull();
    expect(isoToMytTime(null)).toBe('');
    expect(isoToMytTime('nope')).toBe('');
  });
});
