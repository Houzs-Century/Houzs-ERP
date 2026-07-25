import { describe, it, expect } from 'vitest';
import {
  proposeRoute,
  timeToMinutes,
  minutesToTime,
  type ProposeStopInput,
} from './propose-route';

/* A symmetric travel matrix helper. Index 0 = depot. `min[i][j]` in MINUTES is
   converted to the seconds the sequencer consumes. Distance is a flat 1000 m per
   travel-minute so the distance total tracks the time total in these tests. */
function matrixFromMinutes(minsMatrix: number[][]): { travelSeconds: number[][]; distanceMetres: number[][] } {
  const travelSeconds = minsMatrix.map((row) => row.map((m) => m * 60));
  const distanceMetres = minsMatrix.map((row) => row.map((m) => m * 1000));
  return { travelSeconds, distanceMetres };
}

const H = (hhmm: string) => timeToMinutes(hhmm)!;

describe('timeToMinutes / minutesToTime', () => {
  it('round-trips HH:MM', () => {
    expect(timeToMinutes('09:00')).toBe(540);
    expect(timeToMinutes('13:30')).toBe(810);
    expect(minutesToTime(540)).toBe('09:00');
    expect(minutesToTime(810)).toBe('13:30');
  });
  it('null-safes blanks and garbage', () => {
    expect(timeToMinutes(null)).toBeNull();
    expect(timeToMinutes('')).toBeNull();
    expect(timeToMinutes('nope')).toBeNull();
    expect(minutesToTime(null)).toBeNull();
  });
  it('accepts HH:MM:SS (Postgres TIME)', () => {
    expect(timeToMinutes('10:15:00')).toBe(615);
  });
});

describe('proposeRoute — service durations are summed into the clock', () => {
  it('finish = start + service, and the next leg departs at finish', () => {
    // depot -> A (10 min) -> B (10 min); each stop 90 min service, no windows.
    const { travelSeconds, distanceMetres } = matrixFromMinutes([
      [0, 10, 20],
      [10, 0, 10],
      [20, 10, 0],
    ]);
    const stops: ProposeStopInput[] = [
      { ref: 'A', serviceMinutes: 90, earliestMin: null, latestMin: null },
      { ref: 'B', serviceMinutes: 90, earliestMin: null, latestMin: null },
    ];
    const r = proposeRoute({ departMin: H('09:00'), stops, travelSeconds, distanceMetres });
    expect(r.ok).toBe(true);
    const a = r.sequence[0];
    const b = r.sequence[1];
    // A: arrive 09:10, service 90 -> finish 10:40.
    expect(minutesToTime(a.arrivalMin)).toBe('09:10');
    expect(minutesToTime(a.finishMin)).toBe('10:40');
    // B: depart A at 10:40, +10 travel -> arrive 10:50, finish 12:20.
    expect(minutesToTime(b.arrivalMin)).toBe('10:50');
    expect(minutesToTime(b.finishMin)).toBe('12:20');
  });
});

describe('proposeRoute — EARLIEST window is a hard constraint (wait, never early)', () => {
  it('a condo with a 10:00 earliest is never serviced before 10:00 — the lorry waits', () => {
    // Depot is 5 min from the condo; depart 09:00 -> arrive 09:05, but earliest 10:00.
    const { travelSeconds, distanceMetres } = matrixFromMinutes([
      [0, 5],
      [5, 0],
    ]);
    const stops: ProposeStopInput[] = [
      { ref: 'CONDO', serviceMinutes: 60, earliestMin: H('10:00'), latestMin: H('17:00') },
    ];
    const r = proposeRoute({ departMin: H('09:00'), stops, travelSeconds, distanceMetres });
    const c = r.sequence[0];
    expect(minutesToTime(c.arrivalMin)).toBe('09:05');
    expect(c.waitMinutes).toBe(55);
    expect(minutesToTime(c.startServiceMin)).toBe('10:00'); // NOT 09:05
    expect(minutesToTime(c.finishMin)).toBe('11:00');
    expect(c.windowViolated).toBe(false);
  });
});

describe('proposeRoute — order respects travel time (nearest-neighbour)', () => {
  it('visits the nearer stop first when neither has a window', () => {
    // Depot: FAR is 40 min away, NEAR is 10 min away.
    const { travelSeconds, distanceMetres } = matrixFromMinutes([
      [0, 40, 10], // depot -> FAR, NEAR
      [40, 0, 35],
      [10, 35, 0],
    ]);
    const stops: ProposeStopInput[] = [
      { ref: 'FAR', serviceMinutes: 30, earliestMin: null, latestMin: null },
      { ref: 'NEAR', serviceMinutes: 30, earliestMin: null, latestMin: null },
    ];
    const r = proposeRoute({ departMin: H('09:00'), stops, travelSeconds, distanceMetres });
    expect(r.sequence.map((s) => s.ref)).toEqual(['NEAR', 'FAR']);
    expect(r.sequence[0].order).toBe(1);
    expect(r.sequence[1].order).toBe(2);
  });
});

describe('proposeRoute — a tight window reorders ahead of pure distance', () => {
  it('serves the time-boxed stop before the nearer open-ended one when needed', () => {
    // NEAR (10 min) is open all day; TIGHT (30 min) closes at 09:45.
    // Serving NEAR first (finish 09:10 + service) then TIGHT would blow the 09:45
    // close; the sequencer must front-load TIGHT.
    const { travelSeconds, distanceMetres } = matrixFromMinutes([
      [0, 10, 30], // depot -> NEAR, TIGHT
      [10, 0, 25],
      [30, 25, 0],
    ]);
    const stops: ProposeStopInput[] = [
      { ref: 'NEAR', serviceMinutes: 60, earliestMin: null, latestMin: null },
      { ref: 'TIGHT', serviceMinutes: 20, earliestMin: null, latestMin: H('09:45') },
    ];
    const r = proposeRoute({ departMin: H('09:00'), stops, travelSeconds, distanceMetres });
    expect(r.sequence[0].ref).toBe('TIGHT');
    expect(r.sequence.every((s) => !s.windowViolated)).toBe(true);
  });
});

describe('proposeRoute — an impossible window is flagged, not hidden', () => {
  it('emits the stop with windowViolated=true when its latest cannot be met', () => {
    // Stop is 60 min away but closes at 09:30; departing 09:00 can only arrive 10:00.
    const { travelSeconds, distanceMetres } = matrixFromMinutes([
      [0, 60],
      [60, 0],
    ]);
    const stops: ProposeStopInput[] = [
      { ref: 'LATE', serviceMinutes: 30, earliestMin: null, latestMin: H('09:30') },
    ];
    const r = proposeRoute({ departMin: H('09:00'), stops, travelSeconds, distanceMetres });
    expect(r.sequence[0].windowViolated).toBe(true);
    expect(r.windowViolations).toBe(1);
    expect(minutesToTime(r.sequence[0].startServiceMin)).toBe('10:00');
  });
});

describe('proposeRoute — totals include the return leg to the depot', () => {
  it('sums every leg and returns home', () => {
    const { travelSeconds, distanceMetres } = matrixFromMinutes([
      [0, 10, 20],
      [10, 0, 15],
      [20, 15, 0],
    ]);
    const stops: ProposeStopInput[] = [
      { ref: 'A', serviceMinutes: 0, earliestMin: null, latestMin: null },
      { ref: 'B', serviceMinutes: 0, earliestMin: null, latestMin: null },
    ];
    const r = proposeRoute({ departMin: H('09:00'), stops, travelSeconds, distanceMetres });
    // NEAR-first: depot->A 10, A->B 15, B->depot 20 = 45 travel minutes.
    expect(r.totalTravelMinutes).toBe(45);
    expect(r.totalDistanceMetres).toBe(45_000);
    expect(minutesToTime(r.returnMin)).toBe('09:45');
  });
});

describe('proposeRoute — empty input', () => {
  it('returns ok:false with no sequence', () => {
    const r = proposeRoute({ departMin: 540, stops: [], travelSeconds: [], distanceMetres: [] });
    expect(r.ok).toBe(false);
    expect(r.sequence).toEqual([]);
  });
});
