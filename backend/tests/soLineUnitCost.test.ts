import { describe, expect, test } from 'vitest';
import { costHeight, recostSetOrder, setSpreadByOwnCost, unitCostSen, usualHeights, wholeSetCosts } from '../scripts/lib/so-line-unit-cost.mjs';
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

/* A sofa set the nightly fill stamps costs its set price, as a save prices it.
   2026-11-18: the fill read effective_from with String(Date), "Mon Oct 19", so no
   combo was ever in effect and a set with every piece at RM 0 got the sum of its
   pieces (6 Houzs orders); a piece left at RM 0 beside a sibling carrying the whole
   set price was costed again on top (HC-SO-2609-359, 2990-SO-2611-107). Amounts are
   illustrative. */
describe('wholeSetCosts', () => {
  // As the database driver hands the rows over: dates arrive as Date objects.
  const combos = costCombos([{
    id: 'k', base_model: 'KABBIN', modules: [['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']], tier: 'PRICE_2', customer_id: null,
    prices_by_height: { 24: 188000, 28: 200000 }, label: null, effective_from: new Date('2026-10-19T00:00:00Z'), created_at: new Date('2026-10-19T07:20:07Z'),
  }]);
  const tier = () => 'PRICE_2';
  const v = (seatHeight: string | null, buildKey: string | null = null) => ({ fabricCode: 'EM-02', ...(seatHeight ? { seatHeight } : {}), ...(buildKey ? { buildKey } : {}) });
  const piece = (id: string, item_code: string, held: number, own: number, variants: object, cancelled = false) => ({ id, item_code, item_group: 'sofa', variants, qty: 1, held, own, cancelled });

  test('a combo row read from the database is in effect: its date is a day, not "Mon Oct 19"', () => {
    expect(combos[0]?.effectiveFrom).toBe('2026-10-19');
  });
  test('a set with every piece at RM 0 costs its combo, spread by each piece\'s own cost', () => {
    const out = wholeSetCosts([piece('a', 'KABBIN-2A(LHF)', 0, 120000, v('28')), piece('b', 'KABBIN-L(RHF)', 0, 120000, v('28'))], combos, tier);
    expect(Object.fromEntries(out)).toEqual({ a: 100000, b: 100000 });
  });
  test('a piece at RM 0 beside one carrying the whole set price: the set is costed once, on any order', () => {
    for (const buildKey of [null, 'build-1']) {
      const out = wholeSetCosts([piece('a', 'KABBIN-2A(LHF)', 200000, 95000, v('28', buildKey)), piece('b', 'KABBIN-L(RHF)', 0, 105000, v('28', buildKey))], combos, tier);
      expect(Object.fromEntries(out)).toEqual({ a: 95000, b: 105000 });
    }
  });
  test('at a height one piece has no cost of its own, the set price is shared by the costs the pieces do have', () => {
    const out = wholeSetCosts([piece('a', 'KABBIN-2A(LHF)', 188000, 95000, v('24')), piece('b', 'KABBIN-L(RHF)', 0, 95000, v('24'))], combos, tier);
    expect(Object.fromEntries(out)).toEqual({ a: 94000, b: 94000 });
  });
  test('nothing to stamp, no combo covering the set, or no seat height (as on a save): left as before', () => {
    expect(wholeSetCosts([piece('a', 'KABBIN-2A(LHF)', 95000, 95000, v('28')), piece('b', 'KABBIN-L(RHF)', 105000, 105000, v('28'))], combos, tier).size).toBe(0);
    expect(wholeSetCosts([piece('a', 'KABBIN-2A(LHF)', 0, 95000, v('28')), piece('b', 'KABBIN-1NA', 0, 65000, v('28'))], combos, tier).size).toBe(0);
    expect(wholeSetCosts([piece('a', 'KABBIN-2A(LHF)', 0, 95000, v(null)), piece('b', 'KABBIN-L(RHF)', 0, 105000, v(null))], combos, tier).size).toBe(0);
  });
  test('a cancelled piece is no part of the set', () => {
    const out = wholeSetCosts([
      piece('a', 'KABBIN-2A(LHF)', 0, 95000, v('28')), piece('b', 'KABBIN-L(RHF)', 0, 105000, v('28')), piece('c', 'KABBIN-L(LHF)', 0, 105000, v('28'), true),
    ], combos, tier);
    expect(Object.fromEntries(out)).toEqual({ a: 95000, b: 105000 });
  });
  test('setSpreadByOwnCost prices a set that has nothing left to stamp (what the repair puts right)', () => {
    const lines = [piece('a', 'KABBIN-2A(LHF)', 120000, 120000, v('28')), piece('b', 'KABBIN-L(RHF)', 120000, 120000, v('28'))];
    expect(wholeSetCosts(lines, combos, tier).size).toBe(0);
    expect(Object.fromEntries(setSpreadByOwnCost(lines, combos, tier))).toEqual({ a: 100000, b: 100000 });
  });
});

/* repair-fill-sofa-set-cost.mjs: an order the fill costed piece by piece, re-costed
   to its set price. Amounts are illustrative. */
describe('recostSetOrder', () => {
  const combos = costCombos([{
    id: 'k', base_model: 'KABBIN', modules: [['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']], tier: null, customer_id: null,
    prices_by_height: { 28: 200000 }, label: null, effective_from: new Date('2026-10-19T00:00:00Z'), created_at: new Date('2026-10-19T07:20:07Z'),
  }]);
  const ctx = { combos, tierOfFabric: () => 'PRICE_2', ownCost: (l: { own?: number }) => l.own ?? 0 };
  const line = (id: string, item_code: string, line_cost_sen: number, own: number, over = {}) => ({
    id, item_code, item_group: 'sofa', variants: { seatHeight: '28' }, qty: 1, total_sen: 150000, line_cost_sen, own, cancelled: false, ...over,
  });
  const delivery = { id: 'd', item_code: 'SVC-DELIVERY', item_group: 'service', variants: {}, qty: 1, total_sen: 0, line_cost_sen: 0, cancelled: false };
  const order = (over = {}) => ({ doc_no: 'X', status: 'CONFIRMED', total_revenue_sen: 300000, total_cost_sen: 240000, total_margin_sen: 60000, mattress_sofa_cost_sen: 240000, ...over });

  test('a set costed piece by piece takes its set price; cost, margin and margin basis follow', () => {
    const r = recostSetOrder(order(), [line('a', 'KABBIN-2A(LHF)', 120000, 120000), line('b', 'KABBIN-L(RHF)', 120000, 120000), delivery], ctx);
    expect(r.status).toBe('repair');
    if (r.status !== 'repair') return;
    expect(r.changes.map((c) => [c.id, c.from, c.to])).toEqual([['a', 120000, 100000], ['b', 120000, 100000]]);
    expect(r.header).toEqual({ total_cost_sen: 200000, mattress_sofa_cost_sen: 200000, total_margin_sen: 100000, margin_pct_basis: 3333 });
  });
  test('a piece costed on top of a sibling carrying the set price: the set is costed once, by own costs', () => {
    const r = recostSetOrder(order({ total_cost_sen: 320000 }), [line('a', 'KABBIN-2A(LHF)', 200000, 60000), line('b', 'KABBIN-L(RHF)', 120000, 140000)], ctx);
    expect(r.status === 'repair' && r.changes.map((c) => [c.id, c.to])).toEqual([['a', 60000], ['b', 140000]]);
  });
  test('an order imported with no revenue on its header: the margin moves with the cost, its basis stays 0', () => {
    const r = recostSetOrder(order({ total_revenue_sen: 0, total_margin_sen: -240000 }), [line('a', 'KABBIN-2A(LHF)', 120000, 120000), line('b', 'KABBIN-L(RHF)', 120000, 120000)], ctx);
    expect(r.status === 'repair' && r.header).toEqual({ total_cost_sen: 200000, mattress_sofa_cost_sen: 200000, total_margin_sen: -200000, margin_pct_basis: 0 });
  });
  test('a second run has nothing to change, so it writes nothing', () => {
    const r = recostSetOrder(order({ total_cost_sen: 200000 }), [line('a', 'KABBIN-2A(LHF)', 100000, 120000), line('b', 'KABBIN-L(RHF)', 100000, 120000)], ctx);
    expect(r).toEqual({ status: 'refused', why: 'nothing to change: its sofa sets already carry their set price' });
  });
  test('refused: a header that is not the sum of its lines, a set no combo covers, a cancelled order', () => {
    expect(recostSetOrder(order({ total_cost_sen: 1 }), [line('a', 'KABBIN-2A(LHF)', 120000, 120000)], ctx).status).toBe('refused');
    expect(recostSetOrder(order({ total_cost_sen: 120000 }), [line('a', 'KABBIN-2A(LHF)', 120000, 120000)], ctx).status).toBe('refused');
    expect(recostSetOrder(order({ status: 'CANCELLED' }), [line('a', 'KABBIN-2A(LHF)', 120000, 120000), line('b', 'KABBIN-L(RHF)', 120000, 120000)], ctx).status).toBe('refused');
  });
});
