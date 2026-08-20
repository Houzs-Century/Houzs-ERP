import { describe, expect, it } from 'vitest';
import {
  zoneColorFor,
  pinsFromGeoPoints,
  geoTotals,
  routesFromRuns,
  stagedRoutesFromRows,
  focusFilterRows,
  toggleFocus,
  clusterPins,
  CLUSTER_OFF_ZOOM,
  viewportForPins,
  regionExtent,
  SINGLE_PIN_ZOOM,
  FIT_MAX_ZOOM,
  zoneSummary,
  legendFromRoutes,
  roadmapDeclutterStyles,
  MAP_ESSENTIAL_COLUMNS,
  MAP_ESSENTIAL_COLUMNS_TIME,
  type MapFocus,
  type MapPin,
  type MapRoute,
} from './delivery-map-model';
import type { DeliveryGeoPoint } from './delivery-geo-queries';
import type { AnonymousRun } from './anonymous-runs';
import type { PlanningOrder } from './delivery-planning-queries';

const point = (over: Partial<DeliveryGeoPoint>): DeliveryGeoPoint => ({
  ref: 'SO-1', so_doc_no: 'SO-1', lat: 3.1, lng: 101.6,
  zone: 'KL', region: 'KL', state: 'Kuala Lumpur', postcode: '50000',
  sets: 2, revenueSen: 100_000, customer: 'Ali', address: '1 Jalan A',
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
      soDocNo: 'SO-1', customer: 'Ali', sets: 2, revenueSen: 100_000,
      address: '1 Jalan A', zone: 'KL',
    });
    // Unzoned pin colours by region, not by a phantom zone.
    expect(pins[1].color).toBe(zoneColorFor(null, 'SOUTHERN'));
  });
  it('totals fold orders / sets / revenue', () => {
    expect(geoTotals([point({}), point({ sets: 3, revenueSen: 50_000 })]))
      .toEqual({ orders: 2, sets: 5, revenueSen: 150_000 });
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
  stops: [], sets: 0, revenueSen: 0, overCapacity: false, windowViolations: 0,
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

const mapPin = (ref: string, lat: number, lng: number, color = '#2563eb'): MapPin => ({
  ref, lat, lng, color,
  card: { soDocNo: ref, customer: null, sets: 1, revenueSen: 0, address: null, zone: null },
});

describe('clusterPins — the low-zoom count bubbles', () => {
  /* zoom 6 → grid cells ~1.4 degrees: KL-area pins share a cell, Penang not. */
  const kl1 = mapPin('SO-1', 3.1, 101.6, '#dc2626');
  const kl2 = mapPin('SO-2', 3.2, 101.7, '#dc2626');
  const kl3 = mapPin('SO-3', 3.15, 101.65, '#2563eb');
  const penang = mapPin('SO-9', 5.4, 100.3);

  it('folds same-cell pins into one counted cluster; a far pin stays single', () => {
    const { clusters, singles } = clusterPins([kl1, kl2, penang], 6);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(2);
    expect(clusters[0].refs.sort()).toEqual(['SO-1', 'SO-2']);
    // Centroid — the bubble sits amid its members, not on any single one.
    expect(clusters[0].lat).toBeCloseTo(3.15, 5);
    expect(clusters[0].lng).toBeCloseTo(101.65, 5);
    expect(singles.map((p) => p.ref)).toEqual(['SO-9']);
  });

  it('the bubble takes the DOMINANT member colour (majority zone), never a new hue', () => {
    const { clusters } = clusterPins([kl1, kl2, kl3], 6);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(3);
    expect(clusters[0].color).toBe('#dc2626');
  });

  it('at/above CLUSTER_OFF_ZOOM every pin renders as itself (street reading)', () => {
    const { clusters, singles } = clusterPins([kl1, kl2, kl3], CLUSTER_OFF_ZOOM);
    expect(clusters).toHaveLength(0);
    expect(singles).toHaveLength(3);
  });

  it('is deterministic — the same input always yields the same fold', () => {
    expect(clusterPins([kl1, kl2, kl3, penang], 6)).toEqual(clusterPins([kl1, kl2, kl3, penang], 6));
  });
});

describe('viewportForPins + regionExtent — the region fly-to', () => {
  it('zero pins → the region\'s own geographic extent (Johor sits inside SOUTHERN)', () => {
    const vp = viewportForPins([], 'SOUTHERN');
    expect(vp.kind).toBe('bounds');
    if (vp.kind === 'bounds') {
      expect(vp.bounds).toEqual(regionExtent('SOUTHERN'));
      // Johor Bahru — the case the owner named ("Johor 有 order").
      expect(vp.bounds.south).toBeLessThan(1.49);
      expect(vp.bounds.north).toBeGreaterThan(1.49);
      expect(vp.bounds.west).toBeLessThan(103.74);
      expect(vp.bounds.east).toBeGreaterThan(103.74);
    }
  });

  it('an unknown/ALL region falls back to the whole-country extent (KK included)', () => {
    const all = regionExtent('ALL');
    expect(all.south).toBeLessThan(3.14);
    expect(all.north).toBeGreaterThan(5.98);
    expect(all.east).toBeGreaterThan(116.07);
    expect(regionExtent('SOME_NEW_REGION')).toEqual(all);
  });

  it('a single pin centres at a sensible zoom — capped, never street level', () => {
    const vp = viewportForPins([{ lat: 1.49, lng: 103.74 }], 'SOUTHERN');
    expect(vp).toEqual({ kind: 'center', center: { lat: 1.49, lng: 103.74 }, zoom: SINGLE_PIN_ZOOM });
    expect(SINGLE_PIN_ZOOM).toBeLessThanOrEqual(15);
    expect(FIT_MAX_ZOOM).toBeLessThanOrEqual(15);
  });

  it('many pins → their bounding box', () => {
    const vp = viewportForPins([
      { lat: 3.1, lng: 101.6 }, { lat: 5.4, lng: 100.3 }, { lat: 1.49, lng: 103.74 },
    ], 'ALL');
    expect(vp).toEqual({
      kind: 'bounds',
      bounds: { north: 5.4, south: 1.49, east: 103.74, west: 100.3 },
    });
  });
});

describe('zoneSummary — the per-zone count strip', () => {
  const regions = [
    { key: 'ALL', label: 'All' },
    { key: 'KL', label: 'KL/SEL' }, { key: 'NORTHERN', label: 'Northern' },
    { key: 'SOUTHERN', label: 'Southern' }, { key: 'EAST_COAST', label: 'East Coast' },
    { key: 'EM', label: 'East Malaysia' },
  ];

  it('under ALL: buckets with orders list in master order; the empty rest collapses to a count', () => {
    const s = zoneSummary(
      [{ region: 'KL' }, { region: 'KL' }, { region: 'SOUTHERN' }],
      regions,
      'ALL',
    );
    expect(s.entries).toEqual([
      { key: 'KL', label: 'KL/SEL', count: 2 },
      { key: 'SOUTHERN', label: 'Southern', count: 1 },
    ]);
    expect(s.zeroCount).toBe(3); // Northern, East Coast, East Malaysia
  });

  it('a region the master list lacks still shows (appended), never silently dropped', () => {
    const s = zoneSummary([{ region: 'SG' }], regions, 'ALL');
    expect(s.entries).toEqual([{ key: 'SG', label: 'SG', count: 1 }]);
  });

  it('under a region filter only that region is claimed — the others are not loaded', () => {
    const s = zoneSummary([{ region: 'NORTHERN' }, { region: 'NORTHERN' }], regions, 'NORTHERN');
    expect(s.entries).toEqual([{ key: 'NORTHERN', label: 'Northern', count: 2 }]);
    expect(s.zeroCount).toBe(0);
  });

  it('zero loaded points under ALL → no entries, every bucket in the zero count', () => {
    const s = zoneSummary([], regions, 'ALL');
    expect(s.entries).toEqual([]);
    expect(s.zeroCount).toBe(5);
  });
});

describe('legendFromRoutes — the trip legend model', () => {
  const legendRoute = (over: Partial<MapRoute>): MapRoute => ({
    id: 't1', color: '#2563eb', title: 'Trip 1', crewLabel: null, depot: null,
    stops: [], allRefs: [],
    ...over,
  });

  it('one row per route: colour, title, TOTAL stop count (unpinned included), per-stop windows', () => {
    const rows = legendFromRoutes([legendRoute({
      stops: [
        { ref: 'SO-1', lat: 3.1, lng: 101.6, order: 1, label: 'Ali', windowLabel: '09:40–10:25' },
        { ref: 'SO-2', lat: 3.2, lng: 101.7, order: 2, label: 'Siti', windowLabel: '11:00–11:45' },
      ],
      allRefs: ['SO-1', 'SO-2', 'SO-UNPINNED'],
      crewLabel: 'WXY 1234 · Ah Seng',
    })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].routeId).toBe('t1');
    expect(rows[0].color).toBe('#2563eb');
    expect(rows[0].title).toBe('Trip 1');
    expect(rows[0].crewLabel).toBe('WXY 1234 · Ah Seng');
    expect(rows[0].stopCount).toBe(3);
    expect(rows[0].stops).toEqual([
      { ref: 'SO-1', order: 1, windowLabel: '09:40–10:25' },
      { ref: 'SO-2', order: 2, windowLabel: '11:00–11:45' },
    ]);
  });

  it('time range = first window\'s start → last window\'s end', () => {
    const rows = legendFromRoutes([legendRoute({
      stops: [
        { ref: 'SO-1', lat: 3.1, lng: 101.6, order: 1, label: 'Ali', windowLabel: '09:40–10:25' },
        { ref: 'SO-2', lat: 3.2, lng: 101.7, order: 2, label: 'Siti', windowLabel: '12:10–12:55' },
      ],
    })]);
    expect(rows[0].timeRange).toBe('09:40 → 12:55');
  });

  it('staged ETA offsets range the same way ("+30m → +2h 5m")', () => {
    const rows = legendFromRoutes([legendRoute({
      stops: [
        { ref: 'SO-1', lat: 3.1, lng: 101.6, order: 1, label: 'Ali', windowLabel: '+30m' },
        { ref: 'SO-2', lat: 3.2, lng: 101.7, order: 2, label: 'Siti', windowLabel: '+2h 5m' },
      ],
    })]);
    expect(rows[0].timeRange).toBe('+30m → +2h 5m');
  });

  it('no windows anywhere → NO time range, never a fabricated clock', () => {
    const rows = legendFromRoutes([legendRoute({
      stops: [{ ref: 'SO-1', lat: 3.1, lng: 101.6, order: 1, label: 'Ali', windowLabel: null }],
    })]);
    expect(rows[0].timeRange).toBeNull();
  });
});

describe('roadmapDeclutterStyles — the decluttered roadmap layer', () => {
  const hides = (rules: ReturnType<typeof roadmapDeclutterStyles>, featureType?: string, elementType?: string) =>
    rules.some((r) => r.featureType === featureType && r.elementType === elementType
      && r.stylers.some((s) => s.visibility === 'off'));

  it('POI, transit and road-shield ICONS are hidden in BOTH label modes (they are the clutter)', () => {
    for (const labelsOn of [true, false]) {
      const rules = roadmapDeclutterStyles(labelsOn);
      expect(hides(rules, 'poi', undefined)).toBe(true);
      expect(hides(rules, 'transit', undefined)).toBe(true);
      expect(hides(rules, 'road', 'labels.icon')).toBe(true);
    }
  });

  it('labels ON keeps locality/road-name text (no global labels-off rule)', () => {
    expect(hides(roadmapDeclutterStyles(true), undefined, 'labels')).toBe(false);
  });

  it('labels OFF hides all labels — mirroring Satellite\'s unchecked Labels box', () => {
    expect(hides(roadmapDeclutterStyles(false), undefined, 'labels')).toBe(true);
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
