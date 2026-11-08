// Google against what really happened, per lorry-day (owner 2026-11-08).
import { describe, expect, it } from 'vitest';
import { dayStat, onSiteByBuilding, stopStats, type Stamps } from '../src/scm/lib/lorry-day-stats';

const legs = [
  { ref: 'SO-1', distanceM: 12000, durationS: 1200 },
  { ref: 'SO-2', distanceM: 8000, durationS: 900 },
  { ref: 'SO-3', distanceM: 5000, durationS: 600 },
  { ref: null, distanceM: 15000, durationS: 1500 },
];
const stamps: Record<string, Stamps> = {
  // set off 09:00, arrived 09:25, done 09:45
  'SO-1': { departedAt: '2026-11-07T01:00:00Z', arrivedAt: '2026-11-07T01:25:00Z', deliveredAt: '2026-11-07T01:45:00Z' },
  // no "on the way" tap: driven from the stop before's completion, 09:45 -> 10:05
  'SO-2': { departedAt: null, arrivedAt: '2026-11-07T02:05:00Z', deliveredAt: '2026-11-07T03:05:00Z' },
  // not finished: no figures
  'SO-3': { departedAt: '2026-11-07T03:10:00Z', arrivedAt: null, deliveredAt: null },
};

describe('each finished stop', () => {
  const stats = stopStats(legs, (r) => stamps[r] ?? null);
  it('drive time from setting off, or from the stop before when that came later; on-site from arrived to done', () => {
    expect(stats).toEqual([
      { ref: 'SO-1', driveS: 1500, onSiteS: 1200, googleS: 1200 },
      { ref: 'SO-2', driveS: 1200, onSiteS: 3600, googleS: 900 },
    ]);
  });
  it('the day compares like for like: only timed stops, never the drive home', () => {
    const d = dayStat({ date: '2026-11-07', lorryId: 'L', distanceM: 40000, durationS: 4200, legs }, stats, null);
    expect(d).toMatchObject({ googleM: 40000, googleS: 4200, gpsKm: null, stops: 3, timedStops: 2, driveS: 2700, googleTimedS: 2100, onSiteS: 4800, onSiteStops: 2 });
  });
});

describe('on-site time per building type', () => {
  it('adds per type and lorry, and an order with no type shows as Not set', () => {
    expect(onSiteByBuilding([
      { lorryId: 'L', buildingType: 'Condo', onSiteS: 3600 },
      { lorryId: 'L', buildingType: 'Condo', onSiteS: 1800 },
      { lorryId: 'L', buildingType: null, onSiteS: 600 },
      { lorryId: 'L', buildingType: 'Landed', onSiteS: null },
    ])).toEqual([
      { buildingType: 'Condo', lorryId: 'L', stops: 2, onSiteS: 5400 },
      { buildingType: 'Not set', lorryId: 'L', stops: 1, onSiteS: 600 },
    ]);
  });
});
