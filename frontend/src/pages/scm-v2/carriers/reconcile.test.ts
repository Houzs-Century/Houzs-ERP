import { describe, expect, it } from 'vitest';
import type { ChargeRow } from '../ThreePLInvoices';
import { carrierRecon, chargeTotals } from './reconcile';

const row = (over: Partial<ChargeRow>): ChargeRow => ({
  id: Math.random().toString(36), doNumber: 'DO', doDate: null, doStatus: null, customer: null, doCompanyCode: null,
  carrierId: 'a', carrierName: 'A', cardName: null, invoiceNo: null, invoiceDate: null,
  billedSen: 10000, expectedSen: 10000, varianceSen: 0, note: null, ...over,
});

describe('3PL charge sums', () => {
  it('totals billed over every DO, but the difference only over the DOs a card prices', () => {
    const t = chargeTotals([
      row({ billedSen: 12000, expectedSen: 10000, varianceSen: 2000 }),
      row({ billedSen: 9000, expectedSen: 10000, varianceSen: -1000 }),
      row({ billedSen: 10000 }),
      row({ billedSen: 5000, expectedSen: null, varianceSen: null }),
    ]);
    expect(t).toEqual({ dos: 4, billedSen: 36000, expectedSen: 30000, diffSen: 1000, priced: 3, over: 1, under: 1, noCard: 1 });
  });

  it('no priced DO means no difference, not zero', () => {
    expect(chargeTotals([row({ expectedSen: null, varianceSen: null })]).diffSen).toBeNull();
    expect(chargeTotals([]).diffSen).toBeNull();
  });

  it('per 3PL, sorted by name, counting DOs off the card and DOs with no card', () => {
    const r = carrierRecon([
      row({ carrierId: 'b', carrierName: 'B', varianceSen: 500, billedSen: 10500 }),
      row({ carrierId: 'a', carrierName: 'A', expectedSen: null, varianceSen: null }),
      row({ carrierId: 'b', carrierName: 'B' }),
    ]);
    expect(r.map((x) => [x.carrierName, x.dos, x.off, x.noCard, x.billedPricedSen - x.expectedSen])).toEqual([['A', 1, 0, 1, 0], ['B', 2, 1, 0, 500]]);
  });
});
