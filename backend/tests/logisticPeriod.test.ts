/* Logistic Overview, day by day (owner, 2026-10-17): delivered per day with the
   average order and the average per lorry, by region, the average order per
   category with fee lines left out. */
import { regionOf as frontendRegionOf } from '../../frontend/src/vendor/shared/logistic-region';
import { describe, expect, test } from 'vitest';
import { logisticPeriod, regionOf, workingDays, type PeriodDo } from '../src/scm/lib/logistic-period';
import type { LorryJob } from '../src/scm/shared/logistic-region';

const d = (o: Partial<PeriodDo>): PeriodDo => ({
  id: 'd1', doDate: '2026-10-02', status: 'LOADED', amountSen: 1000_00, state: 'SELANGOR', lorry: null, ...o,
});

describe('trips and occupancy', () => {
  const run = (jobs: LorryJob[]) => logisticPeriod([d({ id: 'a', doDate: '2026-10-01', amountSen: 3000_00, lorry: 'L1' })], [], '2026-10-01', '2026-10-03', [{ plate: 'L1', internal: true }], '2026-10-03', new Map(), jobs).byLorry[0];
  const job = (date: string, kind: LorryJob['kind']): LorryJob => ({ plate: 'L1', date, kind });

  test('a delivery run is one trip however many orders it carries, service jobs ride on it', () => {
    expect(run([job('2026-10-01', 'delivery'), job('2026-10-01', 'service'), job('2026-10-01', 'service')]))
      .toMatchObject({ daysOut: 1, trips: 1, serviceOrders: 2, orders: 3 });
  });
  test('a set-up or a dismantle is a trip each', () => {
    expect(run([job('2026-10-02', 'setup'), job('2026-10-02', 'setup')])).toMatchObject({ daysOut: 1, fairTrips: 2, trips: 3, occupancyPct: 100 });
  });
  test('a supplier pickup or stock transfer is half a trip', () => {
    expect(run([job('2026-10-02', 'transport')])).toMatchObject({ stockTrips: 0.5, trips: 1.5, occupancyPct: 50 });
  });
  test('occupancy can pass 100%', () => {
    expect(run([job('2026-10-01', 'setup'), job('2026-10-02', 'setup'), job('2026-10-02', 'setup'), job('2026-10-03', 'setup')]))
      .toMatchObject({ trips: 5, occupancyPct: 166.7 });
  });
  test('a service-only day is a delivery day, and revenue per day counts it', () => {
    expect(run([job('2026-10-02', 'service')])).toMatchObject({ daysOut: 2, perDayOutSen: 1500_00 });
  });
});

describe('what category an order is', () => {
  const run = (lines: Array<{ doId: string; category: string; sen: number }>) =>
    logisticPeriod([d({ id: 'a' }), d({ id: 'b' })], lines, '2026-10-02', '2026-10-02', [], '2026-10-17', new Map(), []).byCategory;

  test('a mattress with a bedframe is one mattress order, whole amount', () => {
    expect(run([{ doId: 'a', category: 'Mattress', sen: 300 }, { doId: 'a', category: 'Bedframe', sen: 100 }]))
      .toEqual([{ category: 'Mattress', orders: 1, amountSen: 400, avgSen: 400 }]);
  });
  test('a bedframe counts when the order delivers only that', () => {
    expect(run([{ doId: 'a', category: 'Bedframe', sen: 100 }, { doId: 'a', category: 'Accessories', sen: 20 }]))
      .toEqual([{ category: 'Bedframe', orders: 1, amountSen: 120, avgSen: 120 }]);
  });
  test('accessories alone stay accessories', () => {
    expect(run([{ doId: 'b', category: 'Accessories', sen: 20 }])[0]?.category).toBe('Accessories');
  });
  test('a free bundled bedframe does not make a bedframe order', () => {
    expect(run([{ doId: 'a', category: 'Bedframe', sen: 0 }])).toEqual([]);
  });
});

describe('the region rule', () => {
  test('the page and the server agree', () => {
    for (const s of ['Kuala Lumpur', 'PULAU PINANG', 'Negeri Sembilan', 'SARAWAK', 'PAHANG', 'Sabah', 'Oversea', null]) expect(frontendRegionOf(s)).toBe(regionOf(s));
  });
});

describe('a lorry in the workshop', () => {
  test('its down days come off the days it could work, so occupancy reads what it could do', () => {
    const r = logisticPeriod([d({ id: 'a', doDate: '2026-10-01', amountSen: 3000_00, lorry: 'L1' })], [], '2026-10-01', '2026-10-02', [{ plate: 'L1', internal: true }], '2026-10-17', new Map([['L1', new Set(['2026-10-02'])]]), []);
    expect(r.byLorry[0]).toMatchObject({ daysOut: 1, workingDays: 1, downDays: 1, occupancyPct: 100, perDayOutSen: 3000_00 });
  });

  test('the day it delivered and then broke down stays a day it worked; only the next is off', () => {
    const r = logisticPeriod([d({ id: 'a', doDate: '2026-10-01', amountSen: 3000_00, lorry: 'L1' })], [], '2026-10-01', '2026-10-03', [{ plate: 'L1', internal: true }], '2026-10-17', new Map([['L1', new Set(['2026-10-01', '2026-10-02'])]]), []);
    expect(r.byLorry[0]).toMatchObject({ daysOut: 1, workingDays: 2, downDays: 1, occupancyPct: 50 });
  });
});

describe('logistic period', () => {
  test('working days leave out Sundays', () => {
    /* 2026-10-01 is a Thursday; October 2026 has 4 Sundays. */
    expect(workingDays('2026-10-01', '2026-10-31')).toBe(27);
    expect(workingDays('2026-10-04', '2026-10-04')).toBe(0);
  });

  test('regions follow the Delivery Planning buckets', () => {
    expect(regionOf('Kuala Lumpur')).toBe('KL / Selangor');
    expect(regionOf('PULAU PINANG')).toBe('Northern');
    expect(regionOf('Negeri Sembilan')).toBe('Southern');
    expect(regionOf('SARAWAK')).toBe('East Malaysia');
    expect(regionOf(null)).toBe('Unknown');
  });

  test('each day: delivered on its DO date, average order, average per lorry from the DOs whose lorry is known', () => {
    const r = logisticPeriod([
      d({ id: 'a', doDate: '2026-10-01', amountSen: 3000_00, lorry: 'L1' }),
      d({ id: 'b', doDate: '2026-10-01', amountSen: 1000_00, state: 'PENANG', lorry: 'L1' }),
      d({ id: 'e', doDate: '2026-10-01', amountSen: 2000_00, lorry: 'L2' }),
      d({ id: 'f', doDate: '2026-10-01', amountSen: 6000_00 }),
      d({ id: 'c', doDate: '2026-09-28', status: 'DELIVERED' }),
    ], [
      { doId: 'a', category: 'Mattress', sen: 2000_00 }, { doId: 'a', category: 'Bedframe', sen: 1000_00 },
      { doId: 'b', category: 'Mattress', sen: 1000_00 }, { doId: 'b', category: 'Accessories', sen: 0 },
      { doId: 'b', category: 'Charges', sen: 150_00 }, { doId: 'c', category: 'Sofa', sen: 1000_00 },
    ], '2026-10-01', '2026-10-02', [{ plate: 'L1', internal: true }, { plate: 'L9', internal: true }], '2026-10-17', new Map(), []);
    expect(r.days[0]).toMatchObject({ date: '2026-10-01', orders: 4, amountSen: 12000_00, avgOrderSen: 3000_00, lorries: 2, lorryOrders: 3, perLorrySen: 3000_00 });
    expect(r.days[1]).toMatchObject({ date: '2026-10-02', orders: 0, perLorrySen: null });
    expect(r.lorry).toEqual({ lorryDays: 2, recordedOrders: 3, perLorrySen: 3000_00, workingDays: 2 });
    expect(r.byLorry.map((l) => [l.lorry, l.daysOut, l.occupancyPct, l.amountSen])).toEqual([['L1', 1, 50, 4000_00], ['L9', 0, 0, 0], ['L2', 1, 50, 2000_00]]);
    expect(r.lorryDayList[0]).toEqual({ date: '2026-10-01', lorry: 'L1', orders: 2, amountSen: 4000_00 });
    expect(r.byRegion.map((g) => [g.region, g.orders])).toEqual([['KL / Selangor', 3], ['Northern', 1]]);
    expect(r.byCategory).toEqual([
      { category: 'Mattress', orders: 2, amountSen: 4000_00, avgSen: 2000_00 },
    ]);
    expect(r.chargesSen).toBe(150_00);
  });
});
