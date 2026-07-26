import { describe, expect, test } from 'vitest';
import { buildMapRoutes, etaLabel, windowLabel, kmLabel } from './fleet-day-model';
import { assignRouteColors, FLEET_ROUTE_COLORS } from './fleet-colors';
import type { FleetDayTrip, FleetDayStop } from './fleet-day-queries';

const stop = (over: Partial<FleetDayStop> & { id: string }): FleetDayStop => ({
  stop_no: 1, stop_type: 'DELIVERY', customer_name: null, address: null, phone: null,
  house_type: null, earliest_time: null, latest_time: null, access_note: null,
  eta_offset_s: null, leg_distance_m: null, revenue_centi: 0, lat: null, lng: null, geocoded: false,
  ...over,
});

const trip = (over: Partial<FleetDayTrip> & { id: string }): FleetDayTrip => ({
  trip_no: over.id, trip_date: '2026-07-26', status: 'PLANNED', is_outsourced: false,
  total_distance_km: null, lorry: null, driver: null, helpers: [], warehouse: null,
  depot: null, total_revenue_centi: 0, total_drops: 0, stops: [], ...over,
});

describe('buildMapRoutes', () => {
  test('only geocoded stops become pins, renumbered contiguously', () => {
    const colors = assignRouteColors(['T1']);
    const routes = buildMapRoutes([trip({
      id: 'T1',
      depot: { lat: 3.0, lng: 101.5 },
      stops: [
        stop({ id: 'a', stop_no: 1, geocoded: true, lat: 3.1, lng: 101.6, customer_name: 'Ali' }),
        stop({ id: 'b', stop_no: 2, geocoded: false }), // ungeocoded — no pin
        stop({ id: 'c', stop_no: 3, geocoded: true, lat: 3.2, lng: 101.7, customer_name: 'Bob' }),
      ],
    })], colors);
    expect(routes).toHaveLength(1);
    expect(routes[0].color).toBe(FLEET_ROUTE_COLORS[0]);
    expect(routes[0].stops.map((s) => s.order)).toEqual([1, 2]);
    expect(routes[0].stops.map((s) => s.ref)).toEqual(['a', 'c']);
    expect(routes[0].stops[0].label).toBe('Ali');
  });

  test('a trip with no geocoded stop but a depot is kept (depot-only marker)', () => {
    const colors = assignRouteColors(['T1']);
    const routes = buildMapRoutes([trip({ id: 'T1', depot: { lat: 3, lng: 101 }, stops: [stop({ id: 'x' })] })], colors);
    expect(routes).toHaveLength(1);
    expect(routes[0].stops).toEqual([]);
  });

  test('a trip with no geocoded stop and no depot is dropped', () => {
    const colors = assignRouteColors(['T1']);
    const routes = buildMapRoutes([trip({ id: 'T1', depot: null, stops: [stop({ id: 'x' })] })], colors);
    expect(routes).toEqual([]);
  });

  test('label falls back to address then stop number', () => {
    const colors = assignRouteColors(['T1']);
    const routes = buildMapRoutes([trip({
      id: 'T1',
      stops: [
        stop({ id: 'a', stop_no: 7, geocoded: true, lat: 1, lng: 1, customer_name: null, address: '9 Jln B' }),
        stop({ id: 'b', stop_no: 8, geocoded: true, lat: 1, lng: 1, customer_name: null, address: null }),
      ],
    })], colors);
    expect(routes[0].stops[0].label).toBe('9 Jln B');
    expect(routes[0].stops[1].label).toBe('Stop 8');
  });
});

describe('etaLabel', () => {
  test('formats seconds from departure', () => {
    expect(etaLabel(0)).toBe('+0m');
    expect(etaLabel(1200)).toBe('+20m');
    expect(etaLabel(4800)).toBe('+1h 20m');
  });
  test('null / non-finite -> dash', () => {
    expect(etaLabel(null)).toBe('—');
    expect(etaLabel(undefined)).toBe('—');
    expect(etaLabel(NaN)).toBe('—');
  });
});

describe('windowLabel', () => {
  test('both bounds -> range', () => expect(windowLabel('10:00', '17:00')).toBe('10:00–17:00'));
  test('earliest only -> from', () => expect(windowLabel('10:00', null)).toBe('from 10:00'));
  test('latest only -> by', () => expect(windowLabel(null, '17:00')).toBe('by 17:00'));
  test('neither -> empty', () => expect(windowLabel(null, '')).toBe(''));
});

describe('kmLabel', () => {
  test('metres -> km', () => expect(kmLabel(12340)).toBe('12.3 km'));
  test('null -> dash', () => expect(kmLabel(null)).toBe('—'));
});
