// HC-0031, 15 Oct 2026: prod has 0 scm.trips; staff put the lorry on each DO
// (delivery_order_crew), so Lorry Capacity showed 0 trips for all 25 lorries.
import { describe, expect, test } from 'vitest';
import { tripsFromDoCrew } from '../src/scm/lib/lorry-capacity-do';

const idByPlate = new Map([['VRH9058', 'L1'], ['VNB9058', 'L2']]);

describe('tripsFromDoCrew', () => {
  test('one lorry on one date is one trip; each DO is a delivery', () => {
    const out = tripsFromDoCrew([
      { lorryId: 'L1', lorryPlate: null, date: '2026-10-15' },
      { lorryId: null, lorryPlate: 'vrh 9058', date: '2026-10-15' },
      { lorryId: null, lorryPlate: 'VRH9058', date: '2026-10-16T00:00:00Z' },
    ], idByPlate, new Map());
    expect([...out.get('L1')!.dates].sort()).toEqual(['2026-10-15', '2026-10-16']);
    expect(out.get('L1')!.jobs).toBe(3);
  });

  test('skips a lorry-date that already has a real trip, and DOs with no lorry or date', () => {
    const out = tripsFromDoCrew([
      { lorryId: 'L2', lorryPlate: null, date: '2026-10-15' },
      { lorryId: null, lorryPlate: 'UNKNOWN1', date: '2026-10-15' },
      { lorryId: 'L1', lorryPlate: null, date: null },
    ], idByPlate, new Map([['L2', new Set(['2026-10-15'])]]));
    expect(out.size).toBe(0);
  });
});
