import { describe, expect, test } from 'vitest';
import { comboLineCosts, costHeight, unitCostSen, usualHeights } from '../scripts/lib/so-line-unit-cost.mjs';

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
  test('a model never sold with a height takes the height all sofas sell at most', () => {
    const usual = usualHeights([{ item_code: '2376-1A', height: '28', n: 9 }, { item_code: '2376-1A', height: '24', n: 1 }]);
    expect(unitCostSen(sofa('9058-1B(LHF)', grid(['24', 73000], ['28', 75000])), {}, usual)).toBe(75000);
  });
  test('with no sale anywhere it takes the first height the grid holds', () => {
    expect(costHeight(sofa('9058-1B(LHF)', grid(['24', 73000], ['28', 75000])), {}, none)).toBe('24');
  });
  test('a height the grid lacks is not guessed at', () => {
    expect(unitCostSen(sofa('9058-1B(LHF)', grid(['24', 73000])), { seatHeight: '30' }, none)).toBe(0);
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
    expect(u.get('sku:A-1')).toEqual(['24', '28']);
    expect(u.get('model:A')?.[0]).toBe('30');
    expect(u.has('sku:B-1')).toBe(false);
  });
});

describe('comboLineCosts', () => {
  const combo = { id: 'c', baseModel: '9058', modules: [['2A(LHF)'], ['L(RHF)']], tier: null, customerId: null, pricesByHeight: { 28: 150000 }, pwpPricesByHeight: {}, label: null, effectiveFrom: '2026-01-01', createdAt: '2026-01-01', deletedAt: null, defaultFreeGifts: [] };
  const line = (id: string, itemCode: string, lineCostSen: number, over = {}) => ({ id, itemCode, qty: 1, tier: 'PRICE_2', height: '28', lineCostSen, ...over });
  test('a set matching its combo shares the combo cost', () => {
    const out = comboLineCosts([line('a', '9058-2A(LHF)', 100000), line('b', '9058-L(RHF)', 100000)], [combo]);
    expect([...out.values()].reduce((x: number, y: number) => x + y, 0)).toBe(150000);
  });
  test('mixed heights or no combo for the model keep the piece costs', () => {
    expect(comboLineCosts([line('a', '9058-2A(LHF)', 100000), line('b', '9058-L(RHF)', 100000, { height: '24' })], [combo]).size).toBe(0);
    expect(comboLineCosts([line('a', '5535-2A(LHF)', 100000)], [combo]).size).toBe(0);
  });
});
