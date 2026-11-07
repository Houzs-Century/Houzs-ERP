import { describe, expect, it } from 'vitest';
import { fmtDrive, fmtKm, roadTotalsByLorry, runKey } from './lorry-routes-queries';

describe('road figures', () => {
  it('reads kilometres and driving time plainly', () => {
    expect(fmtKm(86_412)).toBe('86.4 km');
    expect(fmtKm(412_000)).toBe('412 km');
    expect(fmtDrive(11_400)).toBe('3 h 10 min');
    expect(fmtDrive(2_700)).toBe('45 min');
  });
  it('a reordered run is a new run', () => {
    const home = { lat: 3.02, lng: 101.73 }, a = { lat: 3.1, lng: 101.6 }, b = { lat: 3.2, lng: 101.5 };
    expect(runKey({ plate: 'X', home, stops: [a, b] })).not.toBe(runKey({ plate: 'X', home, stops: [b, a] }));
  });
  it('adds each lorry over the days', () => {
    const t = roadTotalsByLorry([
      { lorryId: 'L', date: '2026-11-01', distanceM: 1000, durationS: 60, stopCount: 1, polyline: null },
      { lorryId: 'L', date: '2026-11-02', distanceM: 2000, durationS: 120, stopCount: 2, polyline: null },
    ]);
    expect(t.get('L')).toEqual({ distanceM: 3000, durationS: 180, days: 2 });
  });
});
