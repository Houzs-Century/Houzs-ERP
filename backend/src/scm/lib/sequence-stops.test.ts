import { describe, it, expect } from 'vitest';
import { buildSequenceProposal, type SequenceStopInput } from './sequence-stops';

// Matrix index 0 = depot, then stops in the INPUT order the call passes.
// Geography: depot->A 10min/5km, depot->B 30min/15km, A<->B 20min/10km.
// Built here for the INPUT order [B, A] (index 1 = B, index 2 = A).
const travel = [
  [0, 1800, 600],   // depot -> B, depot -> A
  [1800, 0, 1200],  // B -> A
  [600, 1200, 0],   // A -> B
];
const dist = [
  [0, 15000, 5000],
  [15000, 0, 10000],
  [5000, 10000, 0],
];

function stop(ref: string, over: Partial<SequenceStopInput> = {}): SequenceStopInput {
  return { ref, serviceMinutes: 30, earliestMin: null, latestMin: null, ...over };
}

describe('buildSequenceProposal', () => {
  it('sequences nearest-neighbour from the depot and offsets ETA from depart', () => {
    // Depart 09:00 (540). Nearest to depot is A (10min) then B (20min from A).
    const p = buildSequenceProposal({
      departMin: 540,
      stops: [stop('B'), stop('A')],   // input order deliberately B-first
      travelSeconds: travel,
      distanceMetres: dist,
    });
    expect(p.sequence.map((s) => s.ref)).toEqual(['A', 'B']);
    expect(p.sequence[0].order).toBe(1);
    // A: arrive 09:10, eta offset = 600s.
    expect(p.sequence[0].arrivalTime).toBe('09:10');
    expect(p.sequence[0].etaOffsetS).toBe(600);
    // Service 30min at A -> depart A 09:40 -> +20min -> arrive B 10:00.
    expect(p.sequence[1].arrivalTime).toBe('10:00');
    expect(p.sequence[1].etaOffsetS).toBe(60 * 60);  // 60 min from depart
    expect(p.sequence[1].legDistanceM).toBe(10000);
    expect(p.sequence[1].legDurationS).toBe(1200);
    expect(p.departTime).toBe('09:00');
  });

  it('carries the residence window onto the shaped stop and flags a violation', () => {
    // Input order [A, B]: index 1 = A, index 2 = B. B has a hard 09:15 close but
    // even visited FIRST (depot->B is 30min) it cannot be served before 09:30.
    const travelAB = [
      [0, 600, 1800],   // depot -> A, depot -> B
      [600, 0, 1200],   // A -> B
      [1800, 1200, 0],  // B -> A
    ];
    const distAB = [
      [0, 5000, 15000],
      [5000, 0, 10000],
      [15000, 10000, 0],
    ];
    const p = buildSequenceProposal({
      departMin: 540,
      stops: [stop('A'), stop('B', { latestMin: 555 })],
      travelSeconds: travelAB,
      distanceMetres: distAB,
    });
    const b = p.sequence.find((s) => s.ref === 'B')!;
    expect(b.latestTime).toBe('09:15');
    expect(b.windowViolated).toBe(true);
    expect(p.windowViolations).toBe(1);
  });

  it('waits for an earliest window rather than servicing early', () => {
    // A reachable at 09:10 but earliest 10:00 -> wait 50min, start 10:00.
    const p = buildSequenceProposal({
      departMin: 540,
      stops: [stop('A', { earliestMin: 600 })],
      travelSeconds: [[0, 600], [600, 0]],
      distanceMetres: [[0, 5000], [5000, 0]],
    });
    const a = p.sequence[0];
    expect(a.arrivalTime).toBe('09:10');
    expect(a.waitMinutes).toBe(50);
    expect(a.startServiceTime).toBe('10:00');
  });
});
