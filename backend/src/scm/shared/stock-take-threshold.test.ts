import { describe, expect, test } from 'vitest';
import {
  DEFAULT_VARIANCE_QTY_LIMIT,
  DEFAULT_VARIANCE_VALUE_LIMIT_SEN,
  findVarianceBreaches,
  formatVarianceRefusal,
  parseVarianceThresholds,
  type VarianceThresholds,
} from './stock-take-threshold';

const T: VarianceThresholds = { qtyLimit: 5, valueLimitSen: 50_000 };

describe('parseVarianceThresholds', () => {
  test('absent env → shipped defaults (a missing var never changes behaviour)', () => {
    expect(parseVarianceThresholds(undefined)).toEqual({
      qtyLimit: DEFAULT_VARIANCE_QTY_LIMIT,
      valueLimitSen: DEFAULT_VARIANCE_VALUE_LIMIT_SEN,
    });
    expect(parseVarianceThresholds({})).toEqual(parseVarianceThresholds(null));
  });

  test('valid overrides are honoured, floored to integers', () => {
    expect(parseVarianceThresholds({
      STOCK_TAKE_VARIANCE_QTY_LIMIT: ' 10 ',
      STOCK_TAKE_VARIANCE_VALUE_LIMIT_SEN: '2500.9',
    })).toEqual({ qtyLimit: 10, valueLimitSen: 2500 });
  });

  test('garbage / negative values fall back to the default, never throw', () => {
    expect(parseVarianceThresholds({
      STOCK_TAKE_VARIANCE_QTY_LIMIT: 'lots',
      STOCK_TAKE_VARIANCE_VALUE_LIMIT_SEN: '-1',
    })).toEqual({
      qtyLimit: DEFAULT_VARIANCE_QTY_LIMIT,
      valueLimitSen: DEFAULT_VARIANCE_VALUE_LIMIT_SEN,
    });
  });

  test('zero is legal — every non-zero variance then needs a supervisor', () => {
    const t = parseVarianceThresholds({ STOCK_TAKE_VARIANCE_QTY_LIMIT: '0' });
    expect(t.qtyLimit).toBe(0);
    expect(findVarianceBreaches([{ itemCode: 'A', adjustment: 1, unitCostSen: null }], {
      ...t, valueLimitSen: 50_000,
    })).toEqual(['A']);
  });
});

describe('findVarianceBreaches', () => {
  test('at the limit passes, one over breaches (strict >)', () => {
    expect(findVarianceBreaches([
      { itemCode: 'AT', adjustment: 5, unitCostSen: null },
      { itemCode: 'OVER', adjustment: 6, unitCostSen: null },
      { itemCode: 'NEG', adjustment: -6, unitCostSen: null },
    ], T)).toEqual(['OVER', 'NEG']);
  });

  test('value rule: small qty on an expensive SKU still breaches', () => {
    // 2 × RM300 = RM600 > RM500, though |2| ≤ 5.
    expect(findVarianceBreaches([
      { itemCode: 'MAT-LUX', adjustment: -2, unitCostSen: 30_000 },
    ], T)).toEqual(['MAT-LUX']);
  });

  test('value exactly at the limit passes', () => {
    expect(findVarianceBreaches([
      { itemCode: 'EDGE', adjustment: 5, unitCostSen: 10_000 }, // = RM500
    ], T)).toEqual([]);
  });

  test('unknown cost is judged on qty alone — no manufactured breach, no excuse', () => {
    expect(findVarianceBreaches([
      { itemCode: 'NOCOST-SMALL', adjustment: 3, unitCostSen: null },
      { itemCode: 'NOCOST-BIG', adjustment: -9, unitCostSen: null },
    ], T)).toEqual(['NOCOST-BIG']);
  });

  test('zero-adjustment lines never breach, and codes deduplicate in order', () => {
    expect(findVarianceBreaches([
      { itemCode: 'Z', adjustment: 0, unitCostSen: 999_999 },
      { itemCode: 'CODY', adjustment: 7, unitCostSen: null },   // variant bucket 1
      { itemCode: 'CODY', adjustment: -8, unitCostSen: null },  // variant bucket 2
      { itemCode: 'BF-16', adjustment: 6, unitCostSen: null },
    ], T)).toEqual(['CODY', 'BF-16']);
  });
});

describe('formatVarianceRefusal', () => {
  test('names the limits and the SKUs, capped at three', () => {
    const msg = formatVarianceRefusal(['A', 'B', 'C', 'D', 'E'], T);
    expect(msg).toContain('5 units or RM500');
    expect(msg).toContain('A, B, C and 2 more');
    expect(msg).toContain('supervisor');
  });

  test('survives the client filter: under 200 chars, no braces, no bare five-digit number', () => {
    const msg = formatVarianceRefusal(
      ['VERY-LONG-PRODUCT-CODE-1', 'VERY-LONG-PRODUCT-CODE-2', 'VERY-LONG-PRODUCT-CODE-3', 'X'],
      T,
    );
    expect(msg.length).toBeLessThan(200);
    expect(msg).not.toMatch(/[{}]/);
    expect(msg).not.toMatch(/\b\d{5}\b/);
  });
});
