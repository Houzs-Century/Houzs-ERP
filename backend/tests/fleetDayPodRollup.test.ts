import { describe, it, expect } from 'vitest';
import { assembleDayView, type AssembleInput, type RawTripRow, type RawStopRow } from '../src/scm/lib/fleet-day-view';

/* Per-trip POD rollup (Last Mile Delivery / FleetDay). assembleDayView is the
   pure assembler behind GET /trips/day; this pins the delivered / with-POD counts
   it derives per trip from each DELIVERY stop's DO state (podByStopId). */

function baseInput(over: Partial<AssembleInput> = {}): AssembleInput {
  return {
    trips: [],
    stops: [],
    driversById: new Map(),
    helpersById: new Map(),
    lorriesById: new Map(),
    warehousesById: new Map(),
    enrichByStopId: new Map(),
    geoByStopId: new Map(),
    depotByWarehouseId: new Map(),
    podByStopId: new Map(),
    ...over,
  };
}

const trip = (id: string): RawTripRow => ({
  id, trip_no: 'T1', trip_date: '2026-10-20', status: 'PLANNED', is_outsourced: false,
  lorry_id: null, driver_id: null, helper_1_id: null, helper_2_id: null,
  warehouse_id: null, total_distance_km: null,
});

const stop = (id: string, tripId: string, stopType: string): RawStopRow => ({
  id, trip_id: tripId, stop_no: 1, stop_type: stopType, do_id: null, so_id: null,
  customer_name: null, address: null, revenue_sen: 0, eta_offset_s: null, leg_distance_m: null,
});

describe('assembleDayView — per-trip POD rollup', () => {
  it('counts DELIVERED drops and those with real POD, ignoring non-DELIVERY stops', () => {
    const { trips } = assembleDayView(baseInput({
      trips: [trip('t1')],
      stops: [
        stop('d1', 't1', 'DELIVERY'),
        stop('d2', 't1', 'DELIVERY'),
        stop('d3', 't1', 'DELIVERY'),
        stop('p1', 't1', 'PICKUP'),
      ],
      podByStopId: new Map([
        ['d1', { delivered: true, hasPod: true }],
        ['d2', { delivered: true, hasPod: false }],
        // d3 has no entry -> treated as not delivered, no POD
        ['p1', { delivered: true, hasPod: true }], // a pickup must NOT count toward drops
      ]),
    }));
    expect(trips).toHaveLength(1);
    expect(trips[0].total_drops).toBe(3);
    expect(trips[0].total_delivered).toBe(2);
    expect(trips[0].total_with_pod).toBe(1);
  });

  it('a trip with no POD data reports zero delivered / zero POD', () => {
    const { trips } = assembleDayView(baseInput({
      trips: [trip('t1')],
      stops: [stop('d1', 't1', 'DELIVERY'), stop('d2', 't1', 'DELIVERY')],
    }));
    expect(trips[0].total_drops).toBe(2);
    expect(trips[0].total_delivered).toBe(0);
    expect(trips[0].total_with_pod).toBe(0);
  });
});
