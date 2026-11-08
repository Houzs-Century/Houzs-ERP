// HC-0031, 15 Oct 2026: prod has 0 scm.trips; staff put the lorry on each DO
// (delivery_order_crew) and on PMS project setup/dismantle, so Lorry Capacity
// showed 0 trips for all 25 lorries.
import { describe, expect, test } from 'vitest';
import { tripsFromJobs } from '../src/scm/lib/lorry-capacity-jobs';

const idByPlate = new Map([['VRH9058', 'L1'], ['VNB9058', 'L2']]);

describe('tripsFromJobs', () => {
  test('one lorry on one date is one trip; each DO is a delivery', () => {
    const out = tripsFromJobs([
      { lorryId: 'L1', lorryPlate: null, date: '2026-10-15', kind: 'delivery', revenueSen: 0 },
      { lorryId: null, lorryPlate: 'vrh 9058', date: '2026-10-15', kind: 'delivery', revenueSen: 0 },
      { lorryId: null, lorryPlate: 'VRH9058', date: '2026-10-16T00:00:00Z', kind: 'delivery', revenueSen: 0 },
    ], idByPlate, new Map());
    expect([...out.get('L1')!.dates].sort()).toEqual(['2026-10-15', '2026-10-16']);
    expect(out.get('L1')!.delivery).toBe(3);
  });

  test('a DO and a project setup on the same lorry-date: one trip, both jobs counted', () => {
    const out = tripsFromJobs([
      { lorryId: 'L1', lorryPlate: null, date: '2026-10-15', kind: 'delivery', revenueSen: 0 },
      { lorryId: 'L1', lorryPlate: null, date: '2026-10-15', kind: 'setupDismantle', revenueSen: 0 },
    ], idByPlate, new Map());
    const l1 = out.get('L1')!;
    expect(l1.dates.size).toBe(1);
    expect(l1.delivery).toBe(1);
    expect(l1.setupDismantle).toBe(1);
    expect([...l1.deliveryDates]).toEqual(['2026-10-15']);
  });

  test('a setup-only day is a trip but not a delivery day', () => {
    const out = tripsFromJobs([{ lorryId: 'L1', lorryPlate: null, date: '2026-10-15', kind: 'setupDismantle', revenueSen: 0 }], idByPlate, new Map());
    expect(out.get('L1')!.dates.size).toBe(1);
    expect(out.get('L1')!.deliveryDates.size).toBe(0);
  });

  test('skips a lorry-date that already has a real trip, and jobs with no lorry or date', () => {
    const out = tripsFromJobs([
      { lorryId: 'L2', lorryPlate: null, date: '2026-10-15', kind: 'delivery', revenueSen: 0 },
      { lorryId: 'L2', lorryPlate: null, date: '2026-10-15', kind: 'setupDismantle', revenueSen: 0 },
      { lorryId: null, lorryPlate: 'UNKNOWN1', date: '2026-10-15', kind: 'delivery', revenueSen: 0 },
      { lorryId: 'L1', lorryPlate: null, date: null, kind: 'delivery', revenueSen: 0 },
    ], idByPlate, new Map([['L2', new Set(['2026-10-15'])]]));
    expect(out.size).toBe(0);
  });
});

describe('a lorry-date from the board earns its delivery orders', () => {
  it('adds each delivery job amount; a set-up adds none', () => {
    const out = tripsFromJobs([
      { lorryId: 'L1', lorryPlate: null, date: '2026-11-05', kind: 'delivery', revenueSen: 3_000_00 },
      { lorryId: 'L1', lorryPlate: null, date: '2026-11-05', kind: 'delivery', revenueSen: 1_500_00 },
      { lorryId: 'L1', lorryPlate: null, date: '2026-11-06', kind: 'setupDismantle', revenueSen: 0 },
    ], new Map(), new Map());
    expect(out.get('L1')!.revenueSen).toBe(4_500_00);
  });
});
