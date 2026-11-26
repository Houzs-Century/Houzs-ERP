import { describe, it, expect } from 'vitest';
import { buildSequenceProposal, type SequenceStopInput } from './sequence-stops';

const travel = [
  [0, 1800, 600],
  [1800, 0, 1200],
  [600, 1200, 0],
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
    const p = buildSequenceProposal({
      departMin: 540,
      stops: [stop('B'), stop('A')],
      travelSeconds: travel,
      distanceMetres: dist,
    });
    expect(p.sequence.map((s) => s.ref)).toEqual(['A', 'B']);
    expect(p.sequence[0].order).toBe(1);
    expect(p.sequence[0].arrivalTime).toBe('09:10');
    expect(p.sequence[0].etaOffsetS).toBe(600);
    expect(p.sequence[1].arrivalTime).toBe('10:00');
    expect(p.sequence[1].etaOffsetS).toBe(60 * 60);
    expect(p.sequence[1].legDistanceM).toBe(10000);
    expect(p.sequence[1].legDurationS).toBe(1200);
    expect(p.departTime).toBe('09:00');
  });

  it('carries the residence window onto the shaped stop and flags a violation', () => {
    const travelAB = [
      [0, 600, 1800],
      [600, 0, 1200],
      [1800, 1200, 0],
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
