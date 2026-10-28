import { describe, expect, it } from 'vitest';
import { costSen, kmFromFixes, myDayWindow } from '../src/scm/lib/lorry-km';

// 0.01 deg latitude ~ 1.112 km.
const fix = (lat: number, min: number) => ({ lat, lng: 101.6, recorded_at: new Date(Date.UTC(2026, 9, 15, 2, min)).toISOString() });

describe('kmFromFixes', () => {
  it('sums consecutive hops regardless of input order', () => {
    expect(kmFromFixes([fix(3.02, 10), fix(3.0, 0), fix(3.01, 5)])).toBeCloseTo(2.2, 1);
  });
  it('skips a hop faster than 150 km/h as a GPS jump', () => {
    // 3.0 -> 3.5 in 5 min is ~667 km/h; the hop back also jumps.
    expect(kmFromFixes([fix(3.0, 0), fix(3.5, 5), fix(3.01, 10)])).toBe(0);
  });
  it('ignores parked-GPS drift under 50 m', () => {
    expect(kmFromFixes([fix(3.0, 0), fix(3.0003, 5), fix(3.0, 10)])).toBe(0);
  });
  it('is 0 for fewer than two fixes', () => {
    expect(kmFromFixes([])).toBe(0);
    expect(kmFromFixes([fix(3.0, 0)])).toBe(0);
  });
});

describe('costSen', () => {
  it('km x rate, rounded to a sen', () => expect(costSen(12.5, 85)).toBe(1063));
  it('null when no rate is set', () => expect(costSen(12.5, null)).toBeNull());
});

describe('myDayWindow', () => {
  it('a Malaysia day starts 16:00 UTC the day before', () => {
    expect(myDayWindow('2026-10-15')).toEqual({ from: '2026-10-14T16:00:00.000Z', to: '2026-10-15T16:00:00.000Z' });
  });
  it('null for a date that does not exist', () => {
    expect(myDayWindow('2026-13-45')).toBeNull();
    expect(myDayWindow('2026-02-30')).toBeNull();
  });
});
