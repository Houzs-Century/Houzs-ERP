/* Logistic Overview, day by day (owner, 2026-10-17): out vs delivered per day,
   by region, the average order per category, and lorry runs. */
import { describe, expect, test } from 'vitest';
import { logisticPeriod, regionOf, type PeriodDo } from '../src/scm/lib/logistic-period';

const d = (o: Partial<PeriodDo>): PeriodDo => ({
  id: 'd1', doDate: '2026-10-02', deliveredAt: null, status: 'LOADED', amountSen: 1000_00, state: 'SELANGOR',
  mattressSofaSen: 1000_00, bedframeSen: 0, accessoriesSen: 0, othersSen: 0, serviceSen: 0, ...o,
});

describe('logistic period', () => {
  test('regions follow the Delivery Planning buckets', () => {
    expect(regionOf('Kuala Lumpur')).toBe('KL / Selangor');
    expect(regionOf('PULAU PINANG')).toBe('Northern');
    expect(regionOf('Negeri Sembilan')).toBe('Southern');
    expect(regionOf('SARAWAK')).toBe('East Malaysia');
    expect(regionOf(null)).toBe('Unknown');
  });

  test('each day: out on its DO date, delivered on its delivered date, average order', () => {
    const r = logisticPeriod([
      d({ id: 'a', doDate: '2026-10-01', amountSen: 3000_00, mattressSofaSen: 2000_00, bedframeSen: 1000_00 }),
      d({ id: 'b', doDate: '2026-10-01', amountSen: 1000_00, state: 'PENANG' }),
      d({ id: 'c', doDate: '2026-09-28', status: 'DELIVERED', deliveredAt: '2026-10-02' }),
    ], [{ id: 't1', date: '2026-10-01', lorry: 'VNB9058', driver: null, stops: 2, amountSen: 4000_00, region: 'KL / Selangor' }], [
      { doId: 'a', category: 'Mattress', sen: 2000_00 }, { doId: 'a', category: 'Bedframe', sen: 1000_00 },
      { doId: 'b', category: 'Mattress', sen: 1000_00 }, { doId: 'b', category: 'Accessories', sen: 0 }, { doId: 'c', category: 'Sofa', sen: 1000_00 },
    ], '2026-10-01', '2026-10-02');
    expect(r.days[0]).toMatchObject({ date: '2026-10-01', outCount: 2, outSen: 4000_00, avgOrderSen: 2000_00, runs: 1, lorries: 1, runSen: 4000_00, deliveredCount: 0 });
    expect(r.days[1]).toMatchObject({ date: '2026-10-02', outCount: 0, deliveredCount: 1, deliveredSen: 1000_00 });
    expect(r.byRegion.map((g) => [g.region, g.outCount])).toEqual([['KL / Selangor', 1], ['Northern', 1]]);
    expect(r.byCategory).toEqual([
      { category: 'Mattress', orders: 2, amountSen: 3000_00, avgSen: 1500_00 },
      { category: 'Bedframe', orders: 1, amountSen: 1000_00, avgSen: 1000_00 },
    ]);
    expect(r.runList).toHaveLength(1);
  });
});
