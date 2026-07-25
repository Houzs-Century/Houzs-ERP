import { describe, expect, test } from 'vitest';
import { assignRouteColors, routeColorFor, FLEET_ROUTE_COLORS } from './fleet-colors';

/* Per-lorry route colour assignment for the A4 day map. PURE — the same trip ids
   must always yield the same colours so the map, the side panel and the printed
   run-sheet never disagree, and a reload never reshuffles the routes. */
describe('assignRouteColors', () => {
  test('assigns palette colours in order, one per trip', () => {
    const c = assignRouteColors(['a', 'b', 'c']);
    expect(c.get('a')).toBe(FLEET_ROUTE_COLORS[0]);
    expect(c.get('b')).toBe(FLEET_ROUTE_COLORS[1]);
    expect(c.get('c')).toBe(FLEET_ROUTE_COLORS[2]);
  });

  test('is deterministic for the same input', () => {
    const ids = ['t3', 't1', 't2'];
    expect([...assignRouteColors(ids)]).toEqual([...assignRouteColors(ids)]);
  });

  test('cycles the palette when there are more trips than colours', () => {
    const ids = Array.from({ length: FLEET_ROUTE_COLORS.length + 2 }, (_, i) => `t${i}`);
    const c = assignRouteColors(ids);
    expect(c.get('t0')).toBe(FLEET_ROUTE_COLORS[0]);
    expect(c.get(`t${FLEET_ROUTE_COLORS.length}`)).toBe(FLEET_ROUTE_COLORS[0]);
    expect(c.get(`t${FLEET_ROUTE_COLORS.length + 1}`)).toBe(FLEET_ROUTE_COLORS[1]);
  });

  test('a duplicate id keeps its first colour and does not consume a slot', () => {
    const c = assignRouteColors(['a', 'a', 'b']);
    expect(c.get('a')).toBe(FLEET_ROUTE_COLORS[0]);
    expect(c.get('b')).toBe(FLEET_ROUTE_COLORS[1]);
  });

  test('routeColorFor falls back to the first colour for an unknown id', () => {
    const c = assignRouteColors(['a']);
    expect(routeColorFor(c, 'a')).toBe(FLEET_ROUTE_COLORS[0]);
    expect(routeColorFor(c, 'ghost')).toBe(FLEET_ROUTE_COLORS[0]);
  });
});
