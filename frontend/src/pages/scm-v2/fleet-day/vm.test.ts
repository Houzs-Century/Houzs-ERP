import { describe, expect, it, test } from 'vitest';
import {
  stopTimes, fmtMinutes,
  docRowVM, buildRuns, buildLorryCards, buildLorryRoutes, applyFilters, searchMatch, latestLiveDoId,
  EMPTY_FILTERS, filtersActive, isoToMytTime, mytTimeToIso, type DocRowVM, type DayClock,
} from './vm';
import type { MapLatLng } from '../../../vendor/scm/lib/delivery-map-model';
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
    const d = docRowVM(order(), 'overdue', CLOCK, null);
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
    const d = docRowVM(order({ delivered_at: '2026-11-01T03:20:00Z' }), 'done', CLOCK, null);
    expect(d.late).toBe(false);
    expect(d.deliveredAt).toBe('2026-11-01T03:20:00Z');
  });
  test('an SO delivery carries no job tag; its code line is SO · DO · Ref', () => {
    const d = docRowVM(order(), 'scheduled', CLOCK, null);
    expect(d.rowType).toBe('so');
    expect(d.jobLabel).toBeNull();
    expect(d.codeLine).toBe('HC-SO-000123 · HC-DO-9 · pg0791');
  });
  test('a DP job tags its type and shows its own DP number', () => {
    const d = docRowVM(order({
      row_type: 'dp', so_doc_no: 'DP:42', dp_job_type: 'TRANSFER', dp_no: 'DP-261102-VRH02',
      debtor_name: 'KL → Penang', local_total_sen: 0, delivered_qty: 0, remaining_qty: 0,
      delivery_orders: [], so_ref: null,
    }), 'scheduled', CLOCK, null);
    expect(d.rowType).toBe('dp');
    expect(d.jobLabel).toBe('Transfer item');
    expect(d.codeLine).toBe('DP-261102-VRH02');
  });
  test('an ASSR service leg and a PMS project window each tag their job + show its document', () => {
    const assr = docRowVM(order({
      row_type: 'assr', so_doc_no: 'ASSR/2610-031#delivery', assr_id: 1594, job_kind: 'delivery',
      ref: 'ASSR/2610-031', delivery_orders: [], so_ref: null,
    }), 'scheduled', CLOCK, null);
    expect(assr.jobLabel).toBe('Service / delivery back');
    expect(assr.codeLine).toBe('ASSR/2610-031');
    const prj = docRowVM(order({
      row_type: 'project', so_doc_no: 'PRJ:7#DISMANTLE', dp_job_type: 'DISMANTLE',
      ref: '2026-10-HOMEDEC-AKEMI', delivery_orders: [], so_ref: null,
    }), 'scheduled', CLOCK, null);
    expect(prj.jobLabel).toBe('Dismantle');
    expect(prj.codeLine).toBe('2026-10-HOMEDEC-AKEMI');
  });
  test('a completed non-SO job folds into the done list even when its stop status is unknown', () => {
    const d = docRowVM(order({
      row_type: 'assr', so_doc_no: 'ASSR/1#delivery', assr_id: 1, job_kind: 'delivery',
      ref: 'ASSR/1', delivery_state: 'DELIVERED', delivery_orders: [], so_ref: null,
    }), 'scheduled', CLOCK, null);
    expect(d.status).toBe('done');
    expect(d.late).toBe(false);
  });
  test('a DELIVERED SO row keeps its computed stop status (the done-fold is non-SO only)', () => {
    const d = docRowVM(order({ delivery_state: 'DELIVERED' }), 'scheduled', CLOCK, null);
    expect(d.status).toBe('scheduled');
  });
});

describe('buildRuns — grouping + driver join + sort', () => {
  const drivers = new Map<string, DriverRow>([
    ['d1', { id: 'd1', driver_code: 'DRV-1', name: 'Shamsul', phone: '019-9', ic_number: '900101-10-1', vehicle: null, active: true, created_at: '' }],
  ]);
  test('a run carries its drops sorted by stop, with crew joined', () => {
    const docs: DocRowVM[] = [
      docRowVM(order({ so_doc_no: 'S2', trip_stop_no: 3 }), 'done', CLOCK, null),
      docRowVM(order({ so_doc_no: 'S1', trip_stop_no: 1, has_pod: true, crew: { driver_2_name: 'Zaki' } as PlanningOrder['crew'] }), 'done', CLOCK, null),
      docRowVM(order({ so_doc_no: 'OFF', trip_id: 'other', trip_stop_no: 1 }), 'scheduled', CLOCK, null),
    ];
    const runs = buildRuns([trip()], docs, drivers, () => '#2563eb');
    expect(runs).toHaveLength(1);
    const r = runs[0]!;
    expect(r.plate).toBe('VQE9058');
    expect(r.driverIc).toBe('900101-10-1');
    expect(r.driverPhone).toBe('019-9');
    expect(r.driver2Name).toBe('Zaki');
    expect(r.helpers).toEqual(['Ali', 'Bo']);
    expect(r.docs.map((d) => d.soDocNo)).toEqual(['S1', 'S2']);
    expect(r.status).toBe('COMPLETED');
    expect(r.rollup).toMatchObject({ drops: 2, delivered: 2, withPod: 1 });
    expect(r.color).toBe('#2563eb');
  });
});

describe('makeRunVM sort — drops ordered by delivery time (owner 2026-11-02)', () => {
  const drivers = new Map<string, DriverRow>();
  test('earliest delivery window first; AM before PM; untimed last; time beats stop no.', () => {
    const docs: DocRowVM[] = [
      docRowVM(order({ so_doc_no: 'D-2PM', trip_id: 't1', trip_stop_no: 1, time_range: '2pm-4pm' }), 'scheduled', CLOCK, null),
      docRowVM(order({ so_doc_no: 'D-NONE', trip_id: 't1', trip_stop_no: 2, time_range: null }), 'scheduled', CLOCK, null),
      docRowVM(order({ so_doc_no: 'D-AM', trip_id: 't1', trip_stop_no: 9, time_range: 'AM' }), 'scheduled', CLOCK, null),
      docRowVM(order({ so_doc_no: 'D-930', trip_id: 't1', trip_stop_no: 8, time_range: '9:30am to 11am' }), 'scheduled', CLOCK, null),
      docRowVM(order({ so_doc_no: 'D-1230', trip_id: 't1', trip_stop_no: 7, time_range: '12:30pm to 2:30pm' }), 'scheduled', CLOCK, null),
    ];
    const runs = buildRuns([trip()], docs, drivers, () => '#000');
    expect(runs[0]!.docs.map((d) => d.soDocNo)).toEqual(['D-AM', 'D-930', 'D-1230', 'D-2PM', 'D-NONE']);
  });
});

describe('buildLorryCards — pin in-house, outsourced only when working', () => {
  const drivers = new Map<string, DriverRow>();
  const lorries = [
    { id: 'l1', plate: 'VQE9058', is_internal: true, active: true },
    { id: 'l2', plate: 'VRH9058', is_internal: true, active: true },
    { id: 'l3', plate: 'MCF3084', is_internal: false, active: true },
  ];
  test('every in-house lorry shows (even empty); an outsourced lorry shows only with drops', () => {
    const docs: DocRowVM[] = [
      docRowVM(order({ so_doc_no: 'A', trip_id: 't1', trip_stop_no: 1 }), 'scheduled', CLOCK, null),
      docRowVM(order({ so_doc_no: 'B', trip_id: null, trip_stop_no: null, crew: { lorry_plate: 'MCF 3084' } as PlanningOrder['crew'] }), 'scheduled', CLOCK, null),
    ];
    const cards = buildLorryCards([trip()], docs, lorries, drivers, () => '#000');
    expect(cards.map((c) => c.plate)).toEqual(['VQE9058', 'VRH9058', 'MCF3084']);
    const byPlate = Object.fromEntries(cards.map((c) => [c.plate, c] as const));
    expect(byPlate.VQE9058!.trip).not.toBeNull();
    expect(byPlate.VRH9058!.trip).toBeNull();
    expect(byPlate.VRH9058!.rollup.drops).toBe(0);
    expect(byPlate.MCF3084!.isInternal).toBe(false);
    expect(byPlate.MCF3084!.rollup.drops).toBe(1);
  });
  test('an outsourced lorry with no work today does not appear', () => {
    const cards = buildLorryCards([], [], lorries, drivers, () => '#000');
    expect(cards.map((c) => c.plate)).toEqual(['VQE9058', 'VRH9058']);
  });
  test('non-SO jobs ride their lorry too — a DP job on the trip, an ASSR leg by its crew plate', () => {
    const docs: DocRowVM[] = [
      docRowVM(order({
        row_type: 'dp', so_doc_no: 'DP:42', dp_job_type: 'TRANSFER', dp_no: 'DP-261102-VQE01',
        trip_id: 't1', trip_stop_no: null, delivery_orders: [], local_total_sen: 0,
      }), 'scheduled', CLOCK, null),
      docRowVM(order({
        row_type: 'assr', so_doc_no: 'ASSR/1#delivery', assr_id: 1, job_kind: 'delivery',
        ref: 'ASSR/1', trip_id: null, trip_stop_no: null, delivery_orders: [], local_total_sen: 0,
        crew: { lorry_plate: 'VRH 9058' } as PlanningOrder['crew'],
      }), 'scheduled', CLOCK, null),
    ];
    const cards = buildLorryCards([trip()], docs, lorries, drivers, () => '#000');
    const byPlate = Object.fromEntries(cards.map((c) => [c.plate, c] as const));
    expect(byPlate.VQE9058!.docs.map((d) => d.jobLabel)).toEqual(['Transfer item']);
    expect(byPlate.VRH9058!.docs.map((d) => d.jobLabel)).toEqual(['Service / delivery back']);
  });
});

describe('buildLorryRoutes — per-lorry numbered route + surfaced unlocated stops', () => {
  const drivers = new Map<string, DriverRow>([
    ['d1', { id: 'd1', driver_code: 'DRV-1', name: 'Shamsul', phone: '019-9', ic_number: 'ic', vehicle: null, active: true, created_at: '' }],
  ]);
  const lorries = [
    { id: 'l1', plate: 'VQE9058', is_internal: true, active: true },
    { id: 'l2', plate: 'VRH9058', is_internal: true, active: true },
  ];
  const docs: DocRowVM[] = [
    docRowVM(order({ so_doc_no: 'A', trip_id: 't1', trip_stop_no: 1, time_range: 'AM', debtor_name: 'Ada' }), 'done', CLOCK, null),
    docRowVM(order({ so_doc_no: 'B', trip_id: 't1', trip_stop_no: 2, time_range: '2pm-4pm', debtor_name: 'Ben' }), 'scheduled', CLOCK, null),
    docRowVM(order({ so_doc_no: 'C', trip_id: 't1', trip_stop_no: 3, time_range: '2pm-4pm', debtor_name: 'Cho' }), 'scheduled', CLOCK, null),
  ];
  const cards = buildLorryCards([trip()], docs, lorries, drivers, () => '#000');
  const depot: MapLatLng = { lat: 3.1, lng: 101.6 };
  const pointByRef = new Map<string, MapLatLng>([
    ['A', { lat: 3.2, lng: 101.7 }],
    ['C', { lat: 3.3, lng: 101.8 }],
  ]);
  const { routes, unlocated, noByRef } = buildLorryRoutes(cards, pointByRef, new Set(), new Map(), depot, () => null, (k) => `col:${k}`);

  test('one route per working lorry; an empty pinned lorry has none', () => {
    expect(routes.map((r) => r.id)).toEqual(['VQE9058']);
  });
  test('every stop is numbered by its place in the run; the pin carries the same number as the card', () => {
    const vqe = routes[0]!;
    expect(vqe.stops.map((s) => s.ref)).toEqual(['A', 'C']);
    expect(vqe.stops.map((s) => s.order)).toEqual([1, 3]);
    expect([...noByRef]).toEqual([['A', 1], ['B', 2], ['C', 3]]);
    expect(vqe.stops.map((s) => s.label)).toEqual(['Ada', 'Cho']);
    expect(vqe.stops[0]!.windowLabel).toBe('AM');
  });
  test('route carries the plate title, driver crew line, depot, per-lorry colour and delivered/total', () => {
    const vqe = routes[0]!;
    expect(vqe.title).toBe('VQE9058');
    expect(vqe.crewLabel).toBe('Shamsul');
    expect(vqe.depot).toEqual(depot);
    expect(vqe.color).toBe('col:VQE9058');
    expect(vqe.delivered).toBe(1);
    expect(vqe.total).toBe(3);
    expect(vqe.allRefs).toEqual(['A', 'B', 'C']);
  });
  test('a lorry with a home warehouse starts and ends its route there, not at the day depot', () => {
    const penang: MapLatLng = { lat: 5.4, lng: 100.3 };
    const out = buildLorryRoutes(cards, pointByRef, new Set(), new Map(), depot, (k) => (k === 'VQE9058' ? penang : null), (k) => k);
    expect(out.routes[0]!.depot).toEqual(penang);
  });
  test('two stops at the same address share one pin labelled "1, 3"', () => {
    const same = new Map<string, MapLatLng>([['A', { lat: 3.2, lng: 101.7 }], ['B', { lat: 3.25, lng: 101.75 }], ['C', { lat: 3.2, lng: 101.7 }]]);
    const out = buildLorryRoutes(cards, same, new Set(), new Map(), depot, () => null, (k) => k);
    const stops = out.routes[0]!.stops;
    expect(stops.map((st) => st.pinLabel ?? String(st.order))).toEqual(['1, 3', '2', '3']);
    expect(stops.map((st) => st.covered === true)).toEqual([false, false, true]);
  });
  test('the ungeocoded drop is surfaced with a reason, never dropped', () => {
    expect(unlocated).toEqual([{ ref: 'B', label: 'B · HC-DO-9 · pg0791', reason: 'Address could not be located' }]);
  });
  const jobDocs: DocRowVM[] = [
    docRowVM(order({ so_doc_no: 'HC-SO-1', trip_id: 't1', trip_stop_no: 1, time_range: '9am-11am', debtor_name: 'Jack Gun' }), 'scheduled', CLOCK, null),
    docRowVM(order({
      row_type: 'assr', so_doc_no: 'ASSR/2610-054#delivery', assr_id: 1, job_kind: 'delivery',
      ref: 'ASSR/2610-054', trip_id: null, trip_stop_no: null, time_range: '2pm-4pm', delivery_orders: [], local_total_sen: 0,
      crew: { lorry_plate: 'VQE9058' } as DocRowVM['order']['crew'],
    }), 'scheduled', CLOCK, null),
    docRowVM(order({
      row_type: 'project', so_doc_no: 'PRJ:7#SETUP', dp_job_type: 'SETUP', ref: '2026-11-MEGAHOME-MELAKA',
      trip_id: null, trip_stop_no: null, time_range: '5pm', delivery_orders: [], local_total_sen: 0,
      crew: { lorry_plate: 'VQE9058' } as DocRowVM['order']['crew'],
    }), 'scheduled', CLOCK, null),
  ];
  const jobCards = buildLorryCards([trip()], jobDocs, lorries, drivers, () => '#000');

  test('a service-case leg and a setup are numbered in run order and passed to the map like an SO (owner 2026-11-18)', () => {
    const points = new Map<string, MapLatLng>([
      ['HC-SO-1', { lat: 3.2, lng: 101.7 }],
      ['ASSR/2610-054#delivery', { lat: 1.53, lng: 103.66 }],
      ['PRJ:7#SETUP', { lat: 2.27, lng: 102.28 }],
    ]);
    const out = buildLorryRoutes(jobCards, points, new Set(['ASSR/2610-054#delivery']), new Map(), null, () => null, (k) => k);
    const vqe = out.routes.find((r) => r.id === 'VQE9058')!;
    expect(vqe.stops.map((s) => [s.ref, s.order])).toEqual([['HC-SO-1', 1], ['ASSR/2610-054#delivery', 2], ['PRJ:7#SETUP', 3]]);
    expect(vqe.stops.map((s) => s.approximate)).toEqual([false, true, false]);
    expect(out.noByRef.get('PRJ:7#SETUP')).toBe(3);
    expect(out.unlocated).toEqual([]);
  });

  test('a stop nothing could locate keeps its number and is listed with the server reason', () => {
    const out = buildLorryRoutes(jobCards, new Map([['HC-SO-1', { lat: 3.2, lng: 101.7 }]]), new Set(),
      new Map([['ASSR/2610-054#delivery', 'no address, postcode or city on file']]), null, () => null, (k) => k);
    expect(out.noByRef.get('ASSR/2610-054#delivery')).toBe(2);
    expect(out.unlocated[0]).toEqual({ ref: 'ASSR/2610-054#delivery', label: 'ASSR/2610-054', reason: 'no address, postcode or city on file' });
  });
});

describe('applyFilters + searchMatch', () => {
  const docs = [
    docRowVM(order({ so_doc_no: 'A', region: 'KL/SEL', regions: ['KL/SEL'], salesperson_id: 's1', time_range: '9-12' }), 'overdue', CLOCK, null),
    docRowVM(order({ so_doc_no: 'B', region: 'NTH', regions: ['NTH'], salesperson_id: 's2', time_range: '2pm-6pm' }), 'done', CLOCK, null),
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
    expect(searchMatch(d, 'a')).toBe(true);
    expect(searchMatch(d, 'ada')).toBe(true);
    expect(searchMatch(d, 'pg0791')).toBe(true);
    expect(searchMatch(d, 'HC-DO-9')).toBe(true);
    expect(searchMatch(d, '345')).toBe(true);
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

describe('time on the road and on site', () => {
  const doc = (key: string, departedAt: string | null, arrivedAt: string | null, deliveredAt: string | null) =>
    ({ key, departedAt, arrivedAt, deliveredAt }) as unknown as DocRowVM;
  it('first stop runs from setting off; each later stop from the one before it was completed', () => {
    const t = stopTimes([
      doc('b', '2026-11-07T02:00:00Z', '2026-11-07T04:00:00Z', '2026-11-07T04:45:00Z'),
      doc('a', '2026-11-07T02:00:00Z', '2026-11-07T02:30:00Z', '2026-11-07T03:10:00Z'),
    ]);
    expect(t.get('a')).toEqual({ roadMin: 30, siteMin: 40 });
    expect(t.get('b')).toEqual({ roadMin: 50, siteMin: 45 });
  });
  it('a stop never marked arrived shows neither figure', () => {
    expect(stopTimes([doc('a', '2026-11-07T02:00:00Z', null, '2026-11-07T03:10:00Z')]).get('a')).toEqual({ roadMin: null, siteMin: null });
  });
  it('reads minutes past an hour plainly', () => {
    expect(fmtMinutes(65)).toBe('1 h 05 min');
    expect(fmtMinutes(25)).toBe('25 min');
  });
});
