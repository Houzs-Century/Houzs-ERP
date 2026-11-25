import { describe, expect, test } from 'vitest';
import { companySplit, defaultOwnFleetRange, jobsText, ownFleetTotals, perDo } from './ownFleet';
import type { OwnFleetMonth } from '../../../vendor/scm/lib/delivery-rate-card-queries';

const month = (p: Partial<OwnFleetMonth> & { month: string }): OwnFleetMonth => ({
  trips: 0, dos: 0, sets: 0, pricedTrips: 0, pricedDos: 0, costSen: 0, deliveryCostSen: 0,
  threePlDos: 0, threePlSets: 0, threePlBilledSen: 0, threePlPricedDos: 0, threePlBilledPricedSen: 0, threePlCardSen: 0, ...p,
});

describe('the Own fleet tab', () => {
  test('opens on the 1st of the month two months back, to today', () => {
    expect(defaultOwnFleetRange('2026-11-24')).toEqual({ from: '2026-09-01', to: '2026-11-24' });
    expect(defaultOwnFleetRange('2026-01-15')).toEqual({ from: '2025-11-01', to: '2026-01-15' });
  });

  test('per order is whole sen, and nothing when there is no order', () => {
    expect(perDo(10000, 3)).toBe(3333);
    expect(perDo(10000, 0)).toBeNull();
  });

  test('the strip adds the months up', () => {
    const t = ownFleetTotals([
      month({ month: '2026-10', trips: 2, dos: 5, costSen: 20000, deliveryCostSen: 18000, threePlDos: 1, threePlBilledSen: 9000 }),
      month({ month: '2026-11', trips: 1, dos: 2, costSen: 7000, deliveryCostSen: 7000, threePlDos: 2, threePlBilledSen: 12000 }),
    ]);
    expect(t).toMatchObject({ trips: 3, dos: 7, costSen: 27000, deliveryCostSen: 25000, threePlDos: 3, threePlBilledSen: 21000 });
  });

  test("words a trip's other jobs and whose orders it carried", () => {
    expect(jobsText({ SUPPLIER_PICKUP: 2, TRANSFER: 1 })).toBe('Supplier x2 · Transfer item');
    expect(jobsText({})).toBe('');
    expect(companySplit([{ doId: 'a', doNumber: null, companyCode: 'HOUZS' }, { doId: 'b', doNumber: null, companyCode: 'HOUZS' }])).toBe('2');
    expect(companySplit([
      { doId: 'b', doNumber: null, companyCode: '2990' }, { doId: 'a', doNumber: null, companyCode: 'HOUZS' }, { doId: 'c', doNumber: null, companyCode: 'HOUZS' },
    ])).toBe('HOUZS 2 · 2990 1');
  });
});
