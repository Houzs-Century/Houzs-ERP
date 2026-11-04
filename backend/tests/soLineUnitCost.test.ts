import { describe, expect, test } from 'vitest';
import { unitCostSen } from '../scripts/lib/so-line-unit-cost.mjs';

const grid = (...rows: Array<[string, number]>) => rows.flatMap(([height, priceSen]) => [
  { tier: 'PRICE_2', height, priceSen }, { tier: 'PRICE_3', height, priceSen: priceSen + 5000 },
]);
const sofa = (seat_height_prices: unknown) => ({ category: 'SOFA', base_price_sen: 0, seat_height_prices });

describe('unitCostSen', () => {
  test('a sofa at its ordered height takes that height', () => {
    expect(unitCostSen(sofa(grid(['24', 68000], ['30', 76000])), { seatHeight: '30"' })).toBe(76000);
  });
  test('no height on the order: one cost across the heights is the cost (8069, 8030)', () => {
    expect(unitCostSen(sofa(grid(['28', 90000])), { specials: [] })).toBe(90000);
    expect(unitCostSen(sofa(grid(['24', 70000], ['28', 70000])), {})).toBe(70000);
  });
  test('no height on the order and heights that cost differently stay 0, never a guess (9058)', () => {
    expect(unitCostSen(sofa(grid(['24', 73000], ['28', 75000])), {})).toBe(0);
  });
  test('a product with no cost anywhere stays 0, and others read the flat lane', () => {
    expect(unitCostSen(sofa([]), {})).toBe(0);
    expect(unitCostSen({ category: 'MATTRESS', base_price_sen: 155000 }, {})).toBe(155000);
    expect(unitCostSen(undefined, {})).toBe(0);
  });
});
