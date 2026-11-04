import { describe, expect, test } from 'vitest';
import { unitCostSen, usualHeights } from '../scripts/lib/so-line-unit-cost.mjs';

const grid = (...rows: Array<[string, number]>) => rows.flatMap(([height, priceSen]) => [
  { tier: 'PRICE_2', height, priceSen }, { tier: 'PRICE_3', height, priceSen: priceSen + 5000 },
]);
const sofa = (code: string, seat_height_prices: unknown) => ({ code, category: 'SOFA', base_price_sen: 0, seat_height_prices });
const none = new Map<string, string>();

describe('unitCostSen', () => {
  test('a sofa at its ordered height takes that height', () => {
    expect(unitCostSen(sofa('2376-1A', grid(['24', 68000], ['30', 76000])), { seatHeight: '30"' }, none)).toBe(76000);
    expect(unitCostSen(sofa('2376-1A', grid(['24', 68000], ['30', 76000])), { depth: '24' }, none)).toBe(68000);
  });
  test('no height on the order: one cost across the heights is the cost (8069, 8030)', () => {
    expect(unitCostSen(sofa('8069-1B', grid(['28', 90000])), { specials: [] }, none)).toBe(90000);
    expect(unitCostSen(sofa('8030-1A', grid(['24', 70000], ['28', 70000])), {}, none)).toBe(70000);
  });
  test('no height and costs that differ: the height this SKU sells at most (9058)', () => {
    const usual = usualHeights([{ item_code: '9058-1B(LHF)', height: '28"', n: 9 }, { item_code: '9058-1B(LHF)', height: '24', n: 2 }]);
    expect(unitCostSen(sofa('9058-1B(LHF)', grid(['24', 73000], ['28', 75000])), {}, usual)).toBe(75000);
  });
  test('a SKU never sold with a height falls back to its model', () => {
    const usual = usualHeights([{ item_code: '9058-2A(LHF)', height: '28', n: 3 }]);
    expect(unitCostSen(sofa('9058-1B(LHF)', grid(['24', 73000], ['28', 75000])), {}, usual)).toBe(75000);
  });
  test('with no sales to go by it stays 0', () => {
    expect(unitCostSen(sofa('9058-1B(LHF)', grid(['24', 73000], ['28', 75000])), {}, none)).toBe(0);
  });
  test('a product with no cost anywhere stays 0, and others read the flat lane', () => {
    expect(unitCostSen(sofa('X', []), {}, none)).toBe(0);
    expect(unitCostSen({ code: 'M', category: 'MATTRESS', base_price_sen: 155000 }, {}, none)).toBe(155000);
    expect(unitCostSen(undefined, {}, none)).toBe(0);
  });
});

describe('usualHeights', () => {
  test('sums by SKU and by model, and a tie takes the smaller height', () => {
    const u = usualHeights([{ item_code: 'A-1', height: '28', n: 2 }, { item_code: 'A-1', height: '24', n: 2 }, { item_code: 'A-2', height: '30', n: 5 }, { item_code: 'B-1', height: null, n: 9 }]);
    expect(u.get('sku:A-1')).toBe('24');
    expect(u.get('model:A')).toBe('30');
    expect(u.has('sku:B-1')).toBe(false);
  });
});
