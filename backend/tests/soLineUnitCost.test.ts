import { describe, expect, test } from 'vitest';
import { comboLineCosts, costHeight, posSetCosts, unitCostSen, usualHeights } from '../scripts/lib/so-line-unit-cost.mjs';
import { costCombos } from '../scripts/lib/sofa-combo-set-cost.mjs';

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
  test('a height the grid lacks takes the nearest it holds, the taller on a tie', () => {
    expect(unitCostSen(sofa('8069-1B', grid(['28', 90000])), { seatHeight: '32' }, none)).toBe(90000);
    expect(unitCostSen(sofa('5535-2A', grid(['24', 100000], ['28', 120000])), { seatHeight: '26' }, none)).toBe(120000);
    expect(unitCostSen(sofa('9058-1B', grid(['24', 73000], ['28', 75000])), { seatHeight: '30' }, none)).toBe(75000);
  });
  test('a height that is not a number takes no cost from the grid', () => {
    expect(unitCostSen(sofa('8069-1B', grid(['28', 90000])), { seatHeight: 'Default' }, none)).toBe(0);
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

/* 2990-SO-2611-107 (KABBIN 2A + L, 2026-11-18): the POS left the L at RM 0 cost
   while the 2A carried the whole set; stamping the L with its own cost counted it
   twice. Amounts are illustrative. */
describe('posSetCosts', () => {
  // As the database driver hands the rows over: dates arrive as Date objects.
  const combos = costCombos([{
    id: 'k', base_model: 'KABBIN', modules: [['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']], tier: 'PRICE_2', customer_id: null,
    prices_by_height: { 24: 188000, 28: 200000 }, label: null, effective_from: new Date('2026-10-19T00:00:00Z'), created_at: new Date('2026-10-19T07:20:07Z'),
  }]);
  const tier = () => 'PRICE_2';
  const v = (seatHeight: string, buildKey: string | null = 'build-1') => ({ seatHeight, fabricCode: 'EM-02', ...(buildKey ? { buildKey } : {}) });
  const piece = (id: string, item_code: string, held: number, own: number, variants: object) => ({ id, item_code, item_group: 'sofa', variants, qty: 1, held, own });

  test('a POS set costs its combo, spread by each piece\'s own cost: the 2A gives the L its share back', () => {
    const out = posSetCosts([piece('a', 'KABBIN-2A(LHF)', 200000, 95000, v('28')), piece('b', 'KABBIN-L(RHF)', 0, 105000, v('28'))], combos, tier);
    expect(Object.fromEntries(out)).toEqual({ a: 95000, b: 105000 });
  });
  test('at a height one piece has no cost of its own, the set price is shared by the costs the pieces do have', () => {
    const out = posSetCosts([piece('a', 'KABBIN-2A(LHF)', 188000, 95000, v('24')), piece('b', 'KABBIN-L(RHF)', 0, 95000, v('24'))], combos, tier);
    expect(Object.fromEntries(out)).toEqual({ a: 94000, b: 94000 });
  });
  test('an order without the POS build mark (every Houzs order) is left to the stamp as before', () => {
    expect(posSetCosts([piece('a', 'KABBIN-2A(LHF)', 200000, 95000, v('28', null)), piece('b', 'KABBIN-L(RHF)', 0, 105000, v('28', null))], combos, tier).size).toBe(0);
  });
  test('nothing to stamp, or no combo covering the set: left as before', () => {
    expect(posSetCosts([piece('a', 'KABBIN-2A(LHF)', 95000, 95000, v('28')), piece('b', 'KABBIN-L(RHF)', 105000, 105000, v('28'))], combos, tier).size).toBe(0);
    expect(posSetCosts([piece('a', 'KABBIN-2A(LHF)', 200000, 95000, v('28')), piece('b', 'KABBIN-1NA', 0, 65000, v('28'))], combos, tier).size).toBe(0);
  });
});
