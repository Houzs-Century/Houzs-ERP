import { describe, expect, test } from 'vitest';
import { doFacts, expectedSen, invoiceTotals, varianceSen } from './threepl-do-charge';
import type { RateCardSpec } from './delivery-rate-card';

const perSet: RateCardSpec = {
  basis: 'SET', aggregation: 'UNIT',
  rules: [
    { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 10000 },
    { ruleType: 'POSITIONAL_TIER', tierPosition: 2, amountSen: 6000 },
    { ruleType: 'OUTSTATION', zone: 'JOHOR', amountSen: 5000 },
  ],
};

describe('a 3PL charge priced per DO (HC-0031)', () => {
  test('a DO with a frame + mattress twice is two sets; cancelled lines do not count', () => {
    const f = doFacts([
      { category: 'BEDFRAME', qty: 2 }, { category: 'MATTRESS', qty: 2 },
      { category: 'SOFA', qty: 1, cancelled: true },
    ], null, null);
    expect(f.setCount).toBe(2);
    expect(f.itemCount).toBe(4);
    expect(f.dropCount).toBe(1);
  });

  test('expected = the card for that one DO, zone surcharge included', () => {
    const f = doFacts([{ category: 'BEDFRAME', qty: 2 }, { category: 'MATTRESS', qty: 2 }], 'JOHOR', null);
    expect(expectedSen(perSet, f)).toBe(10000 + 6000 + 5000);
  });

  test('no card means no system amount, so no variance (not a fake RM0 match)', () => {
    expect(expectedSen(null, doFacts([], null, null))).toBeNull();
    expect(varianceSen(12000, null)).toBeNull();
    expect(varianceSen(12000, 10000)).toBe(2000);
    expect(varianceSen(9000, 10000)).toBe(-1000);
  });

  test('invoice totals sum per carrier + invoice no, and go null if any DO is unpriced', () => {
    const t = invoiceTotals([
      { carrierId: 'msj', invoiceNo: 'INV1', billedSen: 100, expectedSen: 90 },
      { carrierId: 'msj', invoiceNo: 'INV1', billedSen: 50, expectedSen: 50 },
      { carrierId: 'msj', invoiceNo: 'INV2', billedSen: 70, expectedSen: null },
      { carrierId: 'msj', invoiceNo: 'INV2', billedSen: 30, expectedSen: 30 },
    ]);
    expect(t).toEqual([
      { carrierId: 'msj', invoiceNo: 'INV1', dos: 2, billedSen: 150, expectedSen: 140, varianceSen: 10 },
      { carrierId: 'msj', invoiceNo: 'INV2', dos: 2, billedSen: 100, expectedSen: null, varianceSen: null },
    ]);
  });
});
