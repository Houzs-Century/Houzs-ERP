import { describe, expect, test } from 'vitest';
import { costHeight, linesOutsideChangedSets, masterSetRows, ownCostOn, productAsOf, recostSetOrder, setCostsOnDay, unitCostSen, usualHeights, wholeSetCosts } from '../scripts/lib/so-line-unit-cost.mjs';

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

/* A sofa set the nightly fill stamps costs the set price that stood on its ORDER
   DATE; with none then, each piece its own cost (owner 2026-11-19). History: the fill read
   effective_from with String(Date), "Mon Oct 19", so no combo was ever in effect;
   then it used today's set price, which put 7 orders on a set price created after
   they were sold. A piece left at RM 0 beside a sibling carrying a set price got
   costed again on top (HC-SO-2609-359, 2990-SO-2611-107). Amounts are illustrative. */
describe('wholeSetCosts', () => {
  // As the database driver hands the rows over: dates arrive as Date objects. The set price starts 2026-10-19.
  const combos = masterSetRows([{
    id: 'k', base_model: 'KABBIN', modules: [['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']], tier: 'PRICE_2', customer_id: null,
    prices_by_height: { 24: 188000, 28: 200000 }, label: null, effective_from: new Date('2026-10-19T00:00:00Z'), created_at: new Date('2026-10-19T07:20:07Z'), deleted_at: null,
  }]);
  const tier = () => 'PRICE_2';
  const SOLD_AFTER = '2026-11-01';
  const SOLD_BEFORE = '2026-09-30';
  const v = (seatHeight: string | null, buildKey: string | null = null) => ({ fabricCode: 'EM-02', ...(seatHeight ? { seatHeight } : {}), ...(buildKey ? { buildKey } : {}) });
  const piece = (id: string, item_code: string, held: number, own: number, variants: object, cancelled = false) => ({ id, item_code, item_group: 'sofa', variants, qty: 1, held, own, cancelled });

  test('a combo row read from the database is in effect: its date is a day, not "Mon Oct 19"', () => {
    expect(combos[0]?.effectiveFrom).toBe('2026-10-19');
  });
  test('sold after the set price started: a set with every piece at RM 0 costs it, shared by own cost', () => {
    const out = wholeSetCosts([piece('a', 'KABBIN-2A(LHF)', 0, 120000, v('28')), piece('b', 'KABBIN-L(RHF)', 0, 120000, v('28'))], combos, tier, SOLD_AFTER);
    expect(Object.fromEntries(out)).toEqual({ a: 100000, b: 100000 });
  });
  test('sold before the set price started: no set price, each piece is stamped at its own cost', () => {
    expect(wholeSetCosts([piece('a', 'KABBIN-2A(LHF)', 0, 120000, v('28')), piece('b', 'KABBIN-L(RHF)', 0, 120000, v('28'))], combos, tier, SOLD_BEFORE).size).toBe(0);
  });
  test('a piece at RM 0 beside one carrying the whole set price is never costed on top, on any order', () => {
    for (const buildKey of [null, 'build-1']) {
      const lines = [piece('a', 'KABBIN-2A(LHF)', 200000, 95000, v('28', buildKey)), piece('b', 'KABBIN-L(RHF)', 0, 105000, v('28', buildKey))];
      // Sold after the set price started: the set costs it once.
      expect(Object.fromEntries(wholeSetCosts(lines, combos, tier, SOLD_AFTER))).toEqual({ a: 95000, b: 105000 });
      // Sold before: a later save put that set price on the 2A; both pieces go back to their own cost.
      expect(Object.fromEntries(wholeSetCosts(lines, combos, tier, SOLD_BEFORE))).toEqual({ a: 95000, b: 105000 });
    }
  });
  test('at a height one piece has no cost of its own, the set price is shared by the costs the pieces do have', () => {
    const out = wholeSetCosts([piece('a', 'KABBIN-2A(LHF)', 188000, 95000, v('24')), piece('b', 'KABBIN-L(RHF)', 0, 95000, v('24'))], combos, tier, SOLD_AFTER);
    expect(Object.fromEntries(out)).toEqual({ a: 94000, b: 94000 });
  });
  test('nothing to stamp, no combo covering the set, or no seat height (as on a save): left as before', () => {
    expect(wholeSetCosts([piece('a', 'KABBIN-2A(LHF)', 95000, 95000, v('28')), piece('b', 'KABBIN-L(RHF)', 105000, 105000, v('28'))], combos, tier, SOLD_AFTER).size).toBe(0);
    expect(wholeSetCosts([piece('a', 'KABBIN-2A(LHF)', 0, 95000, v('28')), piece('b', 'KABBIN-1NA', 0, 65000, v('28'))], combos, tier, SOLD_AFTER).size).toBe(0);
    expect(wholeSetCosts([piece('a', 'KABBIN-2A(LHF)', 0, 95000, v(null)), piece('b', 'KABBIN-L(RHF)', 0, 105000, v(null))], combos, tier, SOLD_AFTER).size).toBe(0);
  });
  test('a cancelled piece is no part of the set', () => {
    const out = wholeSetCosts([
      piece('a', 'KABBIN-2A(LHF)', 0, 95000, v('28')), piece('b', 'KABBIN-L(RHF)', 0, 105000, v('28')), piece('c', 'KABBIN-L(LHF)', 0, 105000, v('28'), true),
    ], combos, tier, SOLD_AFTER);
    expect(Object.fromEntries(out)).toEqual({ a: 95000, b: 105000 });
  });
  test('setCostsOnDay prices a set with nothing left to stamp (what the repair puts right)', () => {
    const lines = [piece('a', 'KABBIN-2A(LHF)', 120000, 120000, v('28')), piece('b', 'KABBIN-L(RHF)', 120000, 120000, v('28'))];
    expect(wholeSetCosts(lines, combos, tier, SOLD_AFTER).size).toBe(0);
    expect(Object.fromEntries(setCostsOnDay(lines, combos, tier, SOLD_AFTER))).toEqual({ a: 100000, b: 100000 });
    // Sold before the set price: the pieces carry their own costs, not a set price, so nothing is priced.
    expect(setCostsOnDay(lines, combos, tier, SOLD_BEFORE).size).toBe(0);
  });
});

/* Owner 2026-11-20: the set price that STOOD on the order date. A row deleted
   since still counts for the days it stood; a row created later never counts,
   whatever start date it was given (2990 has rows created in August that start
   on 31 May). Amounts are illustrative. */
describe('setCostsOnDay: which set prices stood on the day', () => {
  const tier = () => 'PRICE_2';
  const row = (over: object) => ({
    id: 'r', base_model: 'XAMMAR', modules: [['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']], tier: 'PRICE_2', customer_id: null, supplier_id: null,
    prices_by_height: { 24: 197500 }, label: null, effective_from: new Date('2026-06-10T00:00:00Z'), created_at: new Date('2026-06-10T03:00:00Z'), deleted_at: null, ...over,
  });
  const lines = (a: number, b: number) => [
    { id: 'a', item_code: 'XAMMAR-2A(RHF)', item_group: 'sofa', variants: { seatHeight: '24' }, qty: 1, held: a, own: 103239, cancelled: false },
    { id: 'b', item_code: 'XAMMAR-L(LHF)', item_group: 'sofa', variants: { seatHeight: '24' }, qty: 1, held: b, own: 94261, cancelled: false },
  ];

  test('a set price deleted after the order date still costs it', () => {
    const rows = masterSetRows([row({ deleted_at: new Date('2026-07-04T07:19:00Z') })]);
    expect(Object.fromEntries(setCostsOnDay(lines(99225, 99225), rows, tier, '2026-06-17'))).toEqual({ a: 103239, b: 94261 });
    // Opened after it was deleted: it never stood for that order.
    expect(setCostsOnDay(lines(103239, 94261), rows, tier, '2026-07-12').size).toBe(0);
  });
  test('a set price created after the order date never counts, even with an earlier start date, and is taken back off', () => {
    const rows = masterSetRows([row({ effective_from: new Date('2026-05-31T00:00:00Z'), created_at: new Date('2026-08-24T02:00:00Z'), prices_by_height: { 24: 190000 } })]);
    expect(setCostsOnDay(lines(103239, 94261), rows, tier, '2026-07-12').size).toBe(0);
    // Carrying it after a later save: each piece back to its own cost of the order date.
    expect(Object.fromEntries(setCostsOnDay(lines(96000, 94000), rows, tier, '2026-07-12'))).toEqual({ a: 103239, b: 94261 });
    // Carrying a figure that moves nothing when put back (another split of the same total): left alone.
    expect(setCostsOnDay(lines(103000, 94500), masterSetRows([row({ created_at: new Date('2026-08-24T02:00:00Z') })]), tier, '2026-07-12').size).toBe(0);
  });
  test('a row created and deleted on one day never stood', () => {
    const rows = masterSetRows([row({ created_at: new Date('2026-06-16T02:00:00Z'), deleted_at: new Date('2026-06-16T09:00:00Z') })]);
    expect(setCostsOnDay(lines(103239, 94261), rows, tier, '2026-06-16').size).toBe(0);
  });
  test('a day is a Malaysian day: a row created at 01:00 on the 10th (17:00 UTC on the 9th) stands from the 10th', () => {
    const rows = masterSetRows([row({ created_at: new Date('2026-06-09T17:00:00Z'), prices_by_height: { 24: 180000 } })]);
    expect(setCostsOnDay(lines(103239, 94261), rows, tier, '2026-06-09').size).toBe(0);
    expect(setCostsOnDay(lines(103239, 94261), rows, tier, '2026-06-10').size).toBe(2);
  });
  test('a set already carrying the right total, every piece costed, is left alone; a piece at RM 0 still takes its share', () => {
    const rows = masterSetRows([row({})]);
    expect(setCostsOnDay(lines(100000, 97500), rows, tier, '2026-06-17').size).toBe(0);
    expect(Object.fromEntries(setCostsOnDay(lines(197500, 0), rows, tier, '2026-06-17'))).toEqual({ a: 103239, b: 94261 });
  });
  test('supplier, customer and one-slot "whole set" rows never cost a set', () => {
    const rows = masterSetRows([
      row({ id: 's', supplier_id: 'sup' }), row({ id: 'c', customer_id: 'cus' }),
      row({ id: 'o', modules: [['2A(LHF)', '2A(RHF)', 'L(LHF)', 'L(RHF)']] }),
    ]);
    expect(rows).toEqual([]);
  });
});

/* A piece's own cost on a day comes from scm.mfg_product_cost_history: the
   2000-01-01 baseline is the cost as it was before the history began. */
describe('productAsOf / ownCostOn', () => {
  const grid = (sen: number) => [{ tier: 'PRICE_2', height: '24', priceSen: sen }];
  const product = { code: 'XAMMAR-2A(RHF)', category: 'SOFA', base_price_sen: 0, seat_height_prices: grid(105000) };
  const history = [
    { effective_from: new Date('2000-01-01T00:00:00Z'), created_at: new Date('2026-09-16T10:00:00Z'), base_price_sen: null, price1_sen: null, seat_height_prices: grid(103239) },
    { effective_from: new Date('2026-09-17T00:00:00Z'), created_at: new Date('2026-09-16T10:00:01Z'), base_price_sen: null, price1_sen: null, seat_height_prices: grid(99225) },
    { effective_from: new Date('2026-09-25T00:00:00Z'), created_at: new Date('2026-09-25T02:00:00Z'), base_price_sen: null, price1_sen: null, seat_height_prices: grid(105000) },
  ];
  const v = { seatHeight: '24' };
  test('the newest row in effect by the day', () => {
    expect(ownCostOn(product, history, '2026-08-28', v, none)).toBe(103239);
    expect(ownCostOn(product, history, '2026-09-20', v, none)).toBe(99225);
    expect(ownCostOn(product, history, '2026-10-01', v, none)).toBe(105000);
  });
  test('no history: the product as it is now; a field the row leaves empty reads the product', () => {
    expect(ownCostOn(product, [], '2026-08-28', v, none)).toBe(105000);
    expect(productAsOf({ ...product, base_price_sen: 7 }, [{ ...history[0], seat_height_prices: null }], '2026-08-28').seat_height_prices).toEqual(grid(105000));
  });
  test('a product with no cost that day takes the cost it has now (the gap the fill closes)', () => {
    expect(ownCostOn(product, [{ ...history[0], seat_height_prices: grid(0) }], '2026-08-28', v, none)).toBe(105000);
  });
});

/* repair-fill-sofa-set-cost.mjs: named orders put on their order-date cost. Amounts are illustrative. */
describe('recostSetOrder', () => {
  const rows = masterSetRows([{
    id: 'k', base_model: 'KABBIN', modules: [['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']], tier: null, customer_id: null,
    prices_by_height: { 28: 200000 }, label: null, effective_from: new Date('2026-10-19T00:00:00Z'), created_at: new Date('2026-10-19T07:20:07Z'), deleted_at: null,
  }]);
  const ctx = { rows, tierOfFabric: () => 'PRICE_2', ownCost: (l: { own?: number }) => l.own ?? 0 };
  const AFTER = '2026-11-01';
  const BEFORE = '2026-06-30';
  const line = (id: string, item_code: string, line_cost_sen: number, own: number, over = {}) => ({
    id, item_code, item_group: 'sofa', variants: { seatHeight: '28' }, qty: 1, total_sen: 150000, line_cost_sen, own, cancelled: false, ...over,
  });
  const delivery = { id: 'd', item_code: 'SVC-DELIVERY', item_group: 'service', variants: {}, qty: 1, total_sen: 0, line_cost_sen: 0, cancelled: false };
  const order = (over = {}) => ({ doc_no: 'X', so_date: new Date('2026-11-01T00:00:00Z'), status: 'CONFIRMED', total_revenue_sen: 300000, total_cost_sen: 240000, total_margin_sen: 60000, mattress_sofa_cost_sen: 240000, ...over });

  test('sold after the set price started: a set costed piece by piece takes it; cost, margin and basis follow', () => {
    const r = recostSetOrder(order(), [line('a', 'KABBIN-2A(LHF)', 120000, 120000), line('b', 'KABBIN-L(RHF)', 120000, 120000), delivery], ctx, AFTER);
    expect(r.status).toBe('repair');
    if (r.status !== 'repair') return;
    expect(r.changes.map((c) => [c.id, c.from, c.to])).toEqual([['a', 120000, 100000], ['b', 120000, 100000]]);
    expect(r.header).toEqual({ total_cost_sen: 200000, mattress_sofa_cost_sen: 200000, total_margin_sen: 100000, margin_pct_basis: 3333 });
  });
  test('sold before the set price started, carrying it now: each piece goes back to its own cost', () => {
    const r = recostSetOrder(order({ so_date: new Date('2026-06-30T00:00:00Z'), total_cost_sen: 200000 }),
      [line('a', 'KABBIN-2A(LHF)', 100000, 120000), line('b', 'KABBIN-L(RHF)', 100000, 120000)], ctx, BEFORE);
    expect(r.status === 'repair' && r.changes.map((c) => [c.id, c.from, c.to])).toEqual([['a', 100000, 120000], ['b', 100000, 120000]]);
  });
  test('a piece costed on top of a sibling carrying the set price: costed once, by the order date', () => {
    // The 2A carries the whole set price, the L its own cost on top (how the fill double-counted).
    const lines = [line('a', 'KABBIN-2A(LHF)', 200000, 70000), line('b', 'KABBIN-L(RHF)', 150000, 150000)];
    const after = recostSetOrder(order({ total_cost_sen: 350000 }), lines, ctx, AFTER);
    expect(after.status === 'repair' && after.changes.map((c) => [c.id, c.to])).toEqual([['a', 63636], ['b', 136364]]);
    const before = recostSetOrder(order({ so_date: new Date('2026-06-30T00:00:00Z'), total_cost_sen: 350000 }), lines, ctx, BEFORE);
    expect(before.status === 'repair' && before.changes.map((c) => [c.id, c.to])).toEqual([['a', 70000]]);
  });
  test('an order imported with no revenue on its header: the margin moves with the cost, its basis stays 0', () => {
    const r = recostSetOrder(order({ total_revenue_sen: 0, total_margin_sen: -240000 }), [line('a', 'KABBIN-2A(LHF)', 120000, 120000), line('b', 'KABBIN-L(RHF)', 120000, 120000)], ctx, AFTER);
    expect(r.status === 'repair' && r.header).toEqual({ total_cost_sen: 200000, mattress_sofa_cost_sen: 200000, total_margin_sen: -200000, margin_pct_basis: 0 });
  });
  test('a second run has nothing to change, so it writes nothing', () => {
    const after = recostSetOrder(order({ total_cost_sen: 200000 }), [line('a', 'KABBIN-2A(LHF)', 100000, 120000), line('b', 'KABBIN-L(RHF)', 100000, 120000)], ctx, AFTER);
    expect(after).toEqual({ status: 'refused', why: 'nothing to change: its sofa sets already carry the cost of their day' });
    const before = recostSetOrder(order({ so_date: new Date('2026-06-30T00:00:00Z') }), [line('a', 'KABBIN-2A(LHF)', 120000, 120000), line('b', 'KABBIN-L(RHF)', 120000, 120000)], ctx, BEFORE);
    expect(before.status).toBe('refused');
  });
  test('refused: a header that is not the sum of its lines, a cancelled order', () => {
    expect(recostSetOrder(order({ total_cost_sen: 1 }), [line('a', 'KABBIN-2A(LHF)', 120000, 120000)], ctx, AFTER).status).toBe('refused');
    expect(recostSetOrder(order({ status: 'CANCELLED' }), [line('a', 'KABBIN-2A(LHF)', 120000, 120000), line('b', 'KABBIN-L(RHF)', 120000, 120000)], ctx, AFTER).status).toBe('refused');
  });
  test('rule 2: an order whose product changed later is priced on the change day', () => {
    // Opened before the set price, its pieces changed after it: the set price of the change day.
    const r = recostSetOrder(order({ so_date: new Date('2026-06-30T00:00:00Z') }), [line('a', 'KABBIN-2A(LHF)', 120000, 120000), line('b', 'KABBIN-L(RHF)', 120000, 120000)], ctx, '2026-10-25');
    expect(r.status === 'repair' && r.changes.map((c) => [c.id, c.to])).toEqual([['a', 100000], ['b', 100000]]);
  });
});

// Owner 2026-11-23 (rule 2): a sofa set re-costed on the day its pieces changed
// keeps that cost; the nightly fill must not spread the order-date set price over it.
describe('linesOutsideChangedSets', () => {
  test('leaves out the pieces of a set re-costed on a change day, and nothing else', () => {
    const lines = [
      { id: 'a', item_code: 'M100-1A(LHF)', item_group: 'sofa', set_cost_day: '2026-11-05' },
      { id: 'b', item_code: 'M100-2A(RHF)', item_group: 'sofa', set_cost_day: null },
      { id: 'c', item_code: 'K200-1A(LHF)', item_group: 'sofa', set_cost_day: null },
      { id: 'd', item_code: 'M100-(Q)', item_group: 'mattress', set_cost_day: null },
    ];
    expect(linesOutsideChangedSets(lines).map((l) => l.id)).toEqual(['c', 'd']);
    expect(linesOutsideChangedSets(lines.slice(1))).toHaveLength(3);
  });
});
