import { describe, expect, it } from 'vitest';
import { petrolPerKm } from './petrolPerKm';
import type { LogisticsLorrySpend, LogisticsSpendLine } from '../../vendor/scm/lib/logistics-queries';

const line = (kind: LogisticsSpendLine['kind'], day: string, amountSen: number): LogisticsSpendLine =>
  ({ lineId: `${kind}${day}${amountSen}`, kind, accountCode: '900-P006', day, docNo: null, notes: null, amountSen, months: 1, byMonth: {}, otherPlate: null });
const lorry = (plate: string | null, ours: boolean, lines: LogisticsSpendLine[]): LogisticsLorrySpend => ({ plate, ours, lines, byMonth: {}, totalSen: 0 });

describe('petrol per GPS km, per lorry per month', () => {
  const lorries = [
    lorry('VNB9058', true, [line('petrol', '2026-10-03', 30_000), line('petrol', '2026-10-20', 50_000), line('upkeep', '2026-10-05', 99_000), line('petrol', '2026-11-02', 10_000)]),
    lorry('WXY1', false, [line('petrol', '2026-10-01', 1_000)]),
    lorry(null, false, [line('manpower', '2026-10-01', 1_000)]),
  ];
  const km = {
    '2026-10': { days: ['2026-10-01', '2026-10-02', '2026-10-03'], lorries: [{ id: '1', plate: 'VNB 9058', km: [400, null, 600], odoKm: [] }] },
  };

  it('adds only petrol lines booked in the month, sums GPS km over days with fixes, and flags above the limit', () => {
    const rows = petrolPerKm(lorries, km, ['2026-10', '2026-11'], 0.7);
    expect(rows.map((r) => r.plate)).toEqual(['VNB9058']);
    expect(rows[0]!.cells['2026-10']).toEqual({ petrolSen: 80_000, km: 1000, gpsDays: 2, days: 3, rmPerKm: 0.8, high: true });
    expect(petrolPerKm(lorries, km, ['2026-10'], 0.8)[0]!.cells['2026-10']!.high).toBe(false);
  });

  it('a month with no GPS fix has no km and no rate, never a zero', () => {
    const nov = petrolPerKm(lorries, km, ['2026-11'], 0.8)[0]!.cells['2026-11']!;
    expect(nov).toEqual({ petrolSen: 10_000, km: null, gpsDays: 0, days: 0, rmPerKm: null, high: false });
  });
});
