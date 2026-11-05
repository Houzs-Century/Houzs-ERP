import { describe, expect, test } from 'vitest';
import {
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
  test('an SO delivery carries no job tag; its code line is SO · DO · Ref', () => {
    const d = docRowVM(order(), 'scheduled', CLOCK);
    expect(d.rowType).toBe('so');
    expect(d.jobLabel).toBeNull();
    expect(d.codeLine).toBe('HC-SO-000123 · HC-DO-9 · pg0791');
  });
  test('a DP job tags its type and shows its own DP number', () => {
    const d = docRowVM(order({
      row_type: 'dp', so_doc_no: 'DP:42', dp_job_type: 'TRANSFER', dp_no: 'DP-261102-VRH02',
      debtor_name: 'KL → Penang', local_total_sen: 0, delivered_qty: 0, remaining_qty: 0,
      delivery_orders: [], so_ref: null,
    }), 'scheduled', CLOCK);
    expect(d.rowType).toBe('dp');
    expect(d.jobLabel).toBe('Transfer item');
    expect(d.codeLine).toBe('DP-261102-VRH02');
  });
  test('an ASSR service leg and a PMS project window each tag their job + show its document', () => {
    const assr = docRowVM(order({
      row_type: 'assr', so_doc_no: 'ASSR/2610-031#delivery', assr_id: 1594, job_kind: 'delivery',
      ref: 'ASSR/2610-031', delivery_orders: [], so_ref: null,
    }), 'scheduled', CLOCK);
    expect(assr.jobLabel).toBe('Service / delivery back');
    expect(assr.codeLine).toBe('ASSR/2610-031');
    const prj = docRowVM(order({
      row_type: 'project', so_doc_no: 'PRJ:7#DISMANTLE', dp_job_type: 'DISMANTLE',
      ref: '2026-10-HOMEDEC-AKEMI', delivery_orders: [], so_ref: null,
    }), 'scheduled', CLOCK);
    expect(prj.jobLabel).toBe('Dismantle');
    expect(prj.codeLine).toBe('2026-10-HOMEDEC-AKEMI');
  });
  test('a completed non-SO job folds into the done list even when its stop status is unknown', () => {
    const d = docRowVM(order({
      row_type: 'assr', so_doc_no: 'ASSR/1#delivery', assr_id: 1, job_kind: 'delivery',
      ref: 'ASSR/1', delivery_state: 'DELIVERED', delivery_orders: [], so_ref: null,
    }), 'scheduled', CLOCK);
    expect(d.status).toBe('done');
    expect(d.late).toBe(false);
  });
  test('a DELIVERED SO row keeps its computed stop status (the done-fold is non-SO only)', () => {
    const d = docRowVM(order({ delivery_state: 'DELIVERED' }), 'scheduled', CLOCK);
    expect(d.status).toBe('scheduled');
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

describe('makeRunVM sort — drops ordered by delivery time (owner 2026-11-02)', () => {
  const drivers = new Map<string, DriverRow>();
  test('earliest delivery window first; AM before PM; untimed last; time beats stop no.', () => {
    const docs: DocRowVM[] = [
      docRowVM(order({ so_doc_no: 'D-2PM', trip_id: 't1', trip_stop_no: 1, time_range: '2pm-4pm' }), 'scheduled', CLOCK),
      docRowVM(order({ so_doc_no: 'D-NONE', trip_id: 't1', trip_stop_no: 2, time_range: null }), 'scheduled', CLOCK),
      docRowVM(order({ so_doc_no: 'D-AM', trip_id: 't1', trip_stop_no: 9, time_range: 'AM' }), 'scheduled', CLOCK),
      docRowVM(order({ so_doc_no: 'D-930', trip_id: 't1', trip_stop_no: 8, time_range: '9:30am to 11am' }), 'scheduled', CLOCK),
      docRowVM(order({ so_doc_no: 'D-1230', trip_id: 't1', trip_stop_no: 7, time_range: '12:30pm to 2:30pm' }), 'scheduled', CLOCK),
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
      docRowVM(order({ so_doc_no: 'A', trip_id: 't1', trip_stop_no: 1 }), 'scheduled', CLOCK),
      docRowVM(order({ so_doc_no: 'B', trip_id: null, trip_stop_no: null, crew: { lorry_plate: 'MCF 3084' } as PlanningOrder['crew'] }), 'scheduled', CLOCK),
    ];
    const cards = buildLorryCards([trip()], docs, lorries, drivers, () => '#000');
    // In-house A->Z (VQE, VRH) then outsourced (MCF). The crew plate "MCF 3084"
    // normalises onto the master's "MCF3084".
    expect(cards.map((c) => c.plate)).toEqual(['VQE9058', 'VRH9058', 'MCF3084']);
    const byPlate = Object.fromEntries(cards.map((c) => [c.plate, c] as const));
    expect(byPlate.VQE9058!.trip).not.toBeNull();   // backed by its trip
    expect(byPlate.VRH9058!.trip).toBeNull();        // pinned, empty
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
      // a TRANSFER on VQE's trip (dp rows carry trip_id) groups via the trip
      docRowVM(order({
        row_type: 'dp', so_doc_no: 'DP:42', dp_job_type: 'TRANSFER', dp_no: 'DP-261102-VQE01',
        trip_id: 't1', trip_stop_no: null, delivery_orders: [], local_total_sen: 0,
      }), 'scheduled', CLOCK),
      // an ASSR service leg on VRH by its echoed crew plate, no trip of its own
      docRowVM(order({
        row_type: 'assr', so_doc_no: 'ASSR/1#delivery', assr_id: 1, job_kind: 'delivery',
        ref: 'ASSR/1', trip_id: null, trip_stop_no: null, delivery_orders: [], local_total_sen: 0,
        crew: { lorry_plate: 'VRH 9058' } as PlanningOrder['crew'],
      }), 'scheduled', CLOCK),
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
  // VQE runs three drops in delivery-time order; two geocode, one does not.
  const docs: DocRowVM[] = [
    docRowVM(order({ so_doc_no: 'A', trip_id: 't1', trip_stop_no: 1, time_range: 'AM', debtor_name: 'Ada' }), 'done', CLOCK),
    docRowVM(order({ so_doc_no: 'B', trip_id: 't1', trip_stop_no: 2, time_range: '2pm-4pm', debtor_name: 'Ben' }), 'scheduled', CLOCK),
    docRowVM(order({ so_doc_no: 'C', trip_id: 't1', trip_stop_no: 3, time_range: '2pm-4pm', debtor_name: 'Cho' }), 'scheduled', CLOCK),
  ];
  const cards = buildLorryCards([trip()], docs, lorries, drivers, () => '#000');
  const depot: MapLatLng = { lat: 3.1, lng: 101.6 };
  const pointByRef = new Map<string, MapLatLng>([
    ['A', { lat: 3.2, lng: 101.7 }],
    ['C', { lat: 3.3, lng: 101.8 }],
    // 'B' deliberately missing — it must surface, not vanish.
  ]);
  const { routes, unlocated } = buildLorryRoutes(cards, pointByRef, depot, (k) => `col:${k}`);

  test('one route per working lorry; an empty pinned lorry has none', () => {
    expect(routes.map((r) => r.id)).toEqual(['VQE9058']); // VRH is empty -> no route
  });
  test('stops are the geocoded drops in run order, numbered consecutively past a gap', () => {
    const vqe = routes[0]!;
    expect(vqe.stops.map((s) => s.ref)).toEqual(['A', 'C']);     // B dropped from the line
    expect(vqe.stops.map((s) => s.order)).toEqual([1, 2]);       // renumbered 1,2 — no gap at the hole
    expect(vqe.stops.map((s) => s.label)).toEqual(['Ada', 'Cho']);
    expect(vqe.stops[0]!.windowLabel).toBe('AM');
  });
  test('route carries the plate title, driver crew line, depot, per-lorry colour and delivered/total', () => {
    const vqe = routes[0]!;
    expect(vqe.title).toBe('VQE9058');
    expect(vqe.crewLabel).toBe('Shamsul');
    expect(vqe.depot).toEqual(depot);
    expect(vqe.color).toBe('col:VQE9058');
    expect(vqe.delivered).toBe(1);   // A is done
    expect(vqe.total).toBe(3);       // all three drops counted, located or not
    expect(vqe.allRefs).toEqual(['A', 'B', 'C']); // focus still finds the ungeocoded B
  });
  test('the ungeocoded drop is surfaced with a reason, never dropped', () => {
    expect(unlocated).toEqual([{ ref: 'B', label: 'B · HC-DO-9 · pg0791', reason: 'Address could not be located' }]);
  });
  test('a non-SO job with no pin says so (not a geocode miss)', () => {
    const jobDocs: DocRowVM[] = [
      docRowVM(order({
        row_type: 'assr', so_doc_no: 'ASSR/1#delivery', assr_id: 1, job_kind: 'delivery',
        ref: 'ASSR/1', trip_id: 't1', trip_stop_no: 1, delivery_orders: [], local_total_sen: 0,
      }), 'scheduled', CLOCK),
    ];
    const jobCards = buildLorryCards([trip()], jobDocs, lorries, drivers, () => '#000');
    const out = buildLorryRoutes(jobCards, new Map(), null, (k) => k);
    expect(out.routes.find((r) => r.id === 'VQE9058')!.stops).toEqual([]);
    expect(out.unlocated).toEqual([{ ref: 'ASSR/1#delivery', label: 'ASSR/1', reason: 'Non-delivery job — no location' }]);
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
