import { describe, expect, it } from 'vitest';
import { planStopMove, type StopUpdate } from './move-stop';

const byId = (u: StopUpdate[]) => Object.fromEntries(u.map((x) => [x.id, x]));

describe('planStopMove — within-trip reorder', () => {
  const src = [{ id: 'a', stop_no: 1 }, { id: 'b', stop_no: 2 }, { id: 'c', stop_no: 3 }];
  it('moves c to the front and renumbers 1..n (no trip_id on a same-trip move)', () => {
    const u = byId(planStopMove({ stopId: 'c', sourceTripId: 'T', targetTripId: 'T', position: 1, sourceStops: src, targetStops: [] }));
    expect(u['c']).toEqual({ id: 'c', stop_no: 1 });
    expect(u['a']).toEqual({ id: 'a', stop_no: 2 });
    expect(u['b']).toEqual({ id: 'b', stop_no: 3 });
    expect(Object.values(u).every((x) => x.trip_id === undefined)).toBe(true);
  });
  it('moving to its own position touches nothing', () => {
    expect(planStopMove({ stopId: 'a', sourceTripId: 'T', targetTripId: 'T', position: 1, sourceStops: src, targetStops: [] })).toEqual([]);
  });
  it('clamps an out-of-range position to the last slot', () => {
    const u = byId(planStopMove({ stopId: 'a', sourceTripId: 'T', targetTripId: 'T', position: 99, sourceStops: src, targetStops: [] }));
    expect(u['a']).toEqual({ id: 'a', stop_no: 3 }); // a goes last
  });
});

describe('planStopMove — cross-trip move', () => {
  const src = [{ id: 'a', stop_no: 1 }, { id: 'b', stop_no: 2 }, { id: 'c', stop_no: 3 }];
  const tgt = [{ id: 'x', stop_no: 1 }, { id: 'y', stop_no: 2 }];
  it('closes the source gap and inserts into the target at position, moved carries trip_id', () => {
    const u = byId(planStopMove({ stopId: 'b', sourceTripId: 'T1', targetTripId: 'T2', position: 2, sourceStops: src, targetStops: tgt }));
    // source: a stays 1 (no update), c 3 -> 2
    expect(u['a']).toBeUndefined();
    expect(u['c']).toEqual({ id: 'c', stop_no: 2 });
    // target: x stays 1 (no update), b inserted at 2 with trip_id, y 2 -> 3
    expect(u['x']).toBeUndefined();
    expect(u['b']).toEqual({ id: 'b', stop_no: 2, trip_id: 'T2' });
    expect(u['y']).toEqual({ id: 'y', stop_no: 3 });
  });
  it('moving to an empty target trip puts it at stop 1', () => {
    const u = byId(planStopMove({ stopId: 'b', sourceTripId: 'T1', targetTripId: 'T2', position: 1, sourceStops: src, targetStops: [] }));
    expect(u['b']).toEqual({ id: 'b', stop_no: 1, trip_id: 'T2' });
  });
});

describe('planStopMove — guards', () => {
  it('returns [] when the stop is not on its claimed source trip', () => {
    expect(planStopMove({ stopId: 'zzz', sourceTripId: 'T1', targetTripId: 'T2', position: 1, sourceStops: [{ id: 'a', stop_no: 1 }], targetStops: [] })).toEqual([]);
  });
});
