import { describe, expect, it } from 'vitest';
import {
  zoneColorFor,
  pinsFromGeoPoints,
  geoTotals,
  routesFromRuns,
  stagedRoutesFromRows,
  focusFilterRows,
  toggleFocus,
  MAP_ESSENTIAL_COLUMNS,
  MAP_ESSENTIAL_COLUMNS_TIME,
  type MapFocus,
} from './delivery-map-model';
import type { DeliveryGeoPoint } from './delivery-geo-queries';
import type { AnonymousRun } from './anonymous-runs';
import type { PlanningOrder } from './delivery-planning-queries';

const point = (over: Partial<DeliveryGeoPoint>): DeliveryGeoPoint => ({
  ref: 'SO-1', so_doc_no: 'SO-1', lat: 3.1, lng: 101.6,
  zone: 'KL', region: 'KL', state: 'Kuala Lumpur', postcode: '50000',
  sets: 2, revenueCenti: 100_000, customer: 'Ali', address: '1 Jalan A',
  ...over,
});

describe('zoneColorFor — deterministic zone colouring', () => {
  it('same zone always yields the same colour; different canonical zones differ', () => {
    expect(zoneColorFor('KL')).toBe(zoneColorFor('KL'));
    expect(zoneColorFor('KL')).not.toBe(zoneColorFor('PJ'));
  });
  it('falls back to the region bucket for unzoned points, and to a neutral for neither', () => {
    expect(zoneColorFor(null, 'JOHOR')).toBe(zoneColorFor('JOHOR'));
    expect(zoneColorFor(null, null)).toMatch(/^#/);
  });
  it('an owner-added (non-canonical) zone still gets a stable palette colour', () => {
    expect(zoneColorFor('SEREMBAN2')).toBe(zoneColorFor('SEREMBAN2'));
  });
});

describe('pinsFromGeoPoints + geoTotals — the geo point model', () => {
  it('maps every point to a pin carrying the mini-card facts', () => {
    const pins = pinsFromGeoPoints([point({}), point({ ref: 'SO-2', so_doc_no: 'SO-2', zone: null, region: 'SOUTHERN' })]);
    expect(pins).toHaveLength(2);
    expect(pins[0].card).toEqual({
      soDocNo: 'SO-1', customer: 'Ali', sets: 2, revenueCenti: 100_000,
      address: '1 Jalan A', zone: 'KL',
    });
    // Unzoned pin colours by region, not by a phantom zone.
    expect(pins[1].color).toBe(zoneColorFor(null, 'SOUTHERN'));
  });
  it('totals fold orders / sets / revenue', () => {
    expect(geoTotals([point({}), point({ sets: 3, revenueCenti: 50_000 })]))
      .toEqual({ orders: 2, sets: 5, revenueCenti: 150_000 });
  });
});

const runStop = (ref: string, order: number, over: Partial<AnonymousRun['stops'][number]> = {}) => ({
  ref, order, debtorName: `C-${ref}`, buildingType: null,
  arrivalTime: null, finishTime: null, earliestTime: null, latestTime: null,
  windowViolated: false, etaOffsetS: null, legDistanceM: null, legDurationS: null,
  ...over,
});

const run = (over: Partial<AnonymousRun>): AnonymousRun => ({
  key: 'k1', date: '2026-08-12', group: 'KLANG_VALLEY', runNo: 1,
  stops: [], sets: 0, revenueCenti: 0, overCapacity: false, windowViolations: 0,
  returnTime: null, totalDistanceMetres: null, routeReason: null, ungeocoded: [],
  vehicleSlotId: 'slot-1',
  ...over,
});

describe('routesFromRuns — the proposal polylines', () => {
  const pts = new Map([
    ['SO-1', { lat: 3.1, lng: 101.6 }],
    ['SO-2', { lat: 3.2, lng: 101.7 }],
  ]);

  it('joins stops to geo points, keeps stop order, carries the est window label', () => {
    const routes = routesFromRuns([
      run({ stops: [runStop('SO-2', 2), runStop('SO-1', 1, { arrivalTime: '09:40', finishTime: '10:10' })] }),
    ], '2026-08-12', pts, { lat: 3.0, lng: 101.5 });
    expect(routes).toHaveLength(1);
    expect(routes[0].stops.map((s) => s.ref)).toEqual(['SO-1', 'SO-2']);
    expect(routes[0].stops[0].windowLabel).toBe('09:40–10:25'); // finish + 15-min unload buffer
    expect(routes[0].depot).toEqual({ lat: 3.0, lng: 101.5 });
  });

  it('only the picked date draws; an unlocatable stop stays OFF the line but IN allRefs', () => {
    const routes = routesFromRuns([
      run({ key: 'other', date: '2026-08-13', stops: [runStop('SO-1', 1)] }),
      run({ stops: [runStop('SO-1', 1), runStop('SO-NOWHERE', 2)] }),
    ], '2026-08-12', pts, null);
    expect(routes).toHaveLength(1);
    expect(routes[0].stops.map((s) => s.ref)).toEqual(['SO-1']);
    expect(routes[0].allRefs).toEqual(['SO-1', 'SO-NOWHERE']);
  });
});

/* Minimal SO row — only the fields stagedRoutesFromRows reads; cast because a
   full PlanningOrder is 50+ fields of noise for this fold. */
const soRow = (): PlanningOrder => ({
  row_type: 'so', so_doc_no: 'SO-1', debtor_name: 'Ali',
  trip_id: null, trip_no: null, trip_date: null, trip_stop_no: null, trip_eta_offset_s: null,
} as unknown as PlanningOrder);

describe('stagedRoutesFromRows — the staged-trip polylines', () => {
  const pts = new Map([
    ['SO-1', { lat: 3.1, lng: 101.6 }],
    ['SO-2', { lat: 3.2, lng: 101.7 }],
    ['SO-3', { lat: 3.3, lng: 101.8 }],
  ]);
  const rows: PlanningOrder[] = [
    { ...soRow(), so_doc_no: 'SO-2', trip_id: 't1', trip_no: 'TRP-002', trip_date: '2026-08-12', trip_stop_no: 2, trip_eta_offset_s: 5400 },
    { ...soRow(), so_doc_no: 'SO-1', trip_id: 't1', trip_no: 'TRP-002', trip_date: '2026-08-12', trip_stop_no: 1, trip_eta_offset_s: 1800 },
    { ...soRow(), so_doc_no: 'SO-3', trip_id: 't0', trip_no: 'TRP-001', trip_date: '2026-08-12', trip_stop_no: 1, trip_eta_offset_s: null },
    { ...soRow(), so_doc_no: 'SO-9', trip_id: 't9', trip_no: 'TRP-009', trip_date: '2026-08-13', trip_stop_no: 1, trip_eta_offset_s: null },
  ] as PlanningOrder[];

  it('groups the date\'s rows by trip (trip_no order), stops in trip_stop_no order, ETA label per stop', () => {
    const routes = stagedRoutesFromRows(rows, '2026-08-12', pts, null);
    expect(routes.map((r) => r.title)).toEqual(['Trip 1', 'Trip 2']);
    expect(routes[0].id).toBe('t0');
    expect(routes[1].stops.map((s) => s.ref)).toEqual(['SO-1', 'SO-2']);
    expect(routes[1].stops[0].windowLabel).toBe('+30m');
    // Never-routed stop shows no fabricated clock.
    expect(routes[0].stops[0].windowLabel).toBeNull();
  });

  it('another day\'s trip never draws on this day', () => {
    const routes = stagedRoutesFromRows(rows, '2026-08-12', pts, null);
    expect(routes.some((r) => r.id === 't9')).toBe(false);
  });
});

describe('focusFilterRows + toggleFocus — the trip-focus board filter', () => {
  const rows = [
    { row_type: 'so', so_doc_no: 'SO-1' },
    { row_type: 'so', so_doc_no: 'SO-2' },
    { row_type: 'so', so_doc_no: 'SO-3' },
    { row_type: 'dp', so_doc_no: 'DP-X' },
  ] as Array<Pick<PlanningOrder, 'row_type' | 'so_doc_no'>>;

  it('no focus → rows unchanged; a focus → only the route\'s refs (unpinned stops included)', () => {
    expect(focusFilterRows(rows, null)).toHaveLength(4);
    const focus: MapFocus = { routeId: 't1', refs: ['SO-1', 'SO-3', 'SO-UNPINNED'] };
    expect(focusFilterRows(rows, focus).map((r) => r.so_doc_no)).toEqual(['SO-1', 'SO-3']);
  });

  it('clicking the focused trip again unfocuses; a different trip refocuses', () => {
    const a: MapFocus = { routeId: 't1', refs: [] };
    const b: MapFocus = { routeId: 't2', refs: [] };
    expect(toggleFocus(null, a)).toEqual(a);
    expect(toggleFocus(a, a)).toBeNull();
    expect(toggleFocus(a, b)).toEqual(b);
  });
});

describe('map-open essential columns', () => {
  it('the essential set is SO No / Customer / State / Postcode / the two delivery dates', () => {
    expect(MAP_ESSENTIAL_COLUMNS).toEqual([
      'so_doc_no', 'debtor_name', 'region', 'postcode',
      'customer_delivery_date', 'amended_delivery_date',
    ]);
  });
  it('the Time page adds its trip + window columns', () => {
    expect(MAP_ESSENTIAL_COLUMNS_TIME).toEqual([...MAP_ESSENTIAL_COLUMNS, 'trip_no', 'time_range']);
  });
});
