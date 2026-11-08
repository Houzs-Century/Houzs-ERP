import { describe, expect, it } from 'vitest';
import { parseRoadRoute, roadRouteUrl, stopKey } from '../src/scm/lib/road-route';

const home = { lat: 3.0263633, lng: 101.7339527 };
const a = { lat: 3.07, lng: 101.6 };
const b = { lat: 3.1, lng: 101.55 };

describe('a lorry day by road', () => {
  it('starts and ends at home and keeps the stops in their order (no reordering)', () => {
    const url = roadRouteUrl(home, [a, b], 'K');
    expect(url).toContain('origin=3.026363,101.733953');
    expect(url).toContain('destination=3.026363,101.733953');
    expect(url).toContain(`waypoints=${encodeURIComponent('3.070000,101.600000')}|${encodeURIComponent('3.100000,101.550000')}`);
    expect(url).not.toContain('optimize');
  });
  it('adds every leg, the drive home included', () => {
    const r = parseRoadRoute({ status: 'OK', routes: [{ legs: [
      { distance: { value: 12000 }, duration: { value: 1200 } },
      { distance: { value: 8000 }, duration: { value: 900 } },
      { distance: { value: 15000 }, duration: { value: 1500 } },
    ], overview_polyline: { points: 'abc' } }] });
    expect(r).toEqual({ ok: true, distanceM: 35000, durationS: 3600, polyline: 'abc', legs: [
      { distanceM: 12000, durationS: 1200 }, { distanceM: 8000, durationS: 900 }, { distanceM: 15000, durationS: 1500 },
    ] });
  });
  it('a refused request is not a zero-km route', () => {
    expect(parseRoadRoute({ status: 'ZERO_RESULTS', routes: [] })).toEqual({ ok: false, reason: 'Directions status ZERO_RESULTS' });
  });
  it('the same run gives the same key; a changed stop order gives another', () => {
    expect(stopKey(home, [a, b])).toBe(stopKey(home, [a, b]));
    expect(stopKey(home, [a, b])).not.toBe(stopKey(home, [b, a]));
  });
});
