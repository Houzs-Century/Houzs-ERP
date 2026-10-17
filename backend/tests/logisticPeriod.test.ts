/* Logistic Overview, day by day (owner, 2026-10-17): delivered per day with the
   average order and the average per lorry, by region, the average order per
   category with fee lines left out. */
import { describe, expect, test } from 'vitest';
import { logisticPeriod, regionOf, workingDays, type PeriodDo } from '../src/scm/lib/logistic-period';

const d = (o: Partial<PeriodDo>): PeriodDo => ({
  id: 'd1', doDate: '2026-10-02', status: 'LOADED', amountSen: 1000_00, state: 'SELANGOR', lorry: null, ...o,
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
    ], '2026-10-01', '2026-10-02', [{ plate: 'L1', internal: true }, { plate: 'L9', internal: true }], '2026-10-17');
    expect(r.days[0]).toMatchObject({ date: '2026-10-01', orders: 4, amountSen: 12000_00, avgOrderSen: 3000_00, lorries: 2, lorryOrders: 3, perLorrySen: 3000_00 });
    expect(r.days[1]).toMatchObject({ date: '2026-10-02', orders: 0, perLorrySen: null });
    expect(r.lorry).toEqual({ lorryDays: 2, recordedOrders: 3, perLorrySen: 3000_00, workingDays: 2 });
    expect(r.byLorry.map((l) => [l.lorry, l.daysOut, l.occupancyPct, l.amountSen])).toEqual([['L1', 1, 50, 4000_00], ['L9', 0, 0, 0], ['L2', 1, 50, 2000_00]]);
    expect(r.lorryDayList[0]).toEqual({ date: '2026-10-01', lorry: 'L1', orders: 2, amountSen: 4000_00 });
    expect(r.byRegion.map((g) => [g.region, g.orders])).toEqual([['KL / Selangor', 3], ['Northern', 1]]);
    expect(r.byCategory).toEqual([
      { category: 'Mattress', orders: 2, amountSen: 3000_00, avgSen: 1500_00 },
      { category: 'Bedframe', orders: 1, amountSen: 1000_00, avgSen: 1000_00 },
    ]);
    expect(r.chargesSen).toBe(150_00);
  });
});
