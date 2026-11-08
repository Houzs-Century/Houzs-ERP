import { describe, expect, it } from 'vitest';
import { fmtDrive, fmtKm, roadTotalsByLorry, legLabelsByRef } from './lorry-routes-queries';
import { slotSortKey } from './fleet-day-cards';

describe('road figures', () => {
  it('reads kilometres and driving time plainly', () => {
    expect(fmtKm(86_412)).toBe('86.4 km');
    expect(fmtKm(412_000)).toBe('412 km');
    expect(fmtDrive(11_400)).toBe('3 h 10 min');
    expect(fmtDrive(2_700)).toBe('45 min');
  });
  /* The server orders each run with windowStartMinutes (backend/src/scm/lib/lorry-day-runs.ts,
     backend/tests/lorryDayRuns.test.ts holds the same table): the card order and the road
     order must not drift apart. */
  it.each([
    ['9:00-12:00', 540], ['TIME AROUND 9AM TO 11AM', 540], ['2pm - 6pm', 840], ['10.30am', 630],
    ['AM', 0], ['PM', 720], ['', Number.MAX_SAFE_INTEGER], [null, Number.MAX_SAFE_INTEGER], ['call first', Number.MAX_SAFE_INTEGER],
  ])('the card sorts %s at %s, as the server does', (t, m) => { expect(slotSortKey(t)).toBe(m); });
  it('adds each lorry over the days', () => {
    const t = roadTotalsByLorry([
      { lorryId: 'L', date: '2026-11-01', distanceM: 1000, durationS: 60, stopCount: 1, polyline: null, legs: null },
      { lorryId: 'L', date: '2026-11-02', distanceM: 2000, durationS: 120, stopCount: 2, polyline: null, legs: null },
    ]);
    expect(t.get('L')).toEqual({ distanceM: 3000, durationS: 180, days: 2 });
  });
});

describe('each order by road from the stop before', () => {
  it('labels every order on the day and leaves the drive home off', () => {
    const fig = { lorryId: 'l1', date: '2026-11-07', distanceM: 35000, durationS: 3600, stopCount: 2, polyline: null, legs: [
      { ref: 'SO-1', distanceM: 12000, durationS: 1080 }, { ref: 'SO-2', distanceM: 8000, durationS: 900 }, { ref: null, distanceM: 15000, durationS: 1620 },
    ] };
    const m = legLabelsByRef([fig, { ...fig, lorryId: 'l2', legs: null }]);
    expect([...m]).toEqual([['SO-1', '12.0 km · 18 min'], ['SO-2', '8.0 km · 15 min']]);
  });
});
