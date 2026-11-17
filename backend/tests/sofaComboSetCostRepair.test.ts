// The repair half of the combo set-cost fix (scripts/repair-sofa-combo-set-cost.mjs):
// which lines carry a set price a wrong-shaped combo put on one piece, and what
// each order costs once it is taken off. Fixtures copy the shape of company-2
// rows read from production on 2026-11-17 (models, modules, heights, how each
// order was built); the amounts are illustrative because this repository is
// public and a cost is not. Sen.
import { describe, expect, it } from 'vitest';
import {
  costCombos, listCostOf, onePieceSetPrices, repairOrder, setPriceOn,
} from '../scripts/lib/sofa-combo-set-cost.mjs';

type Row = Record<string, any>;
const combo = (id: string, base_model: string, modules: string[][], cost: Row, selling: Row, effective_from: string, created_at: string, over: Row = {}): Row => ({
  id, base_model, modules, tier: 'PRICE_2', customer_id: null, supplier_id: null,
  prices_by_height: cost, selling_prices_by_height: selling, label: null, effective_from, created_at, deleted_at: null, ...over,
});
const COMBOS: Row[] = [
  combo('l-cnr', 'Lotti', [['1A(LHF)', '1A(RHF)', '2A(LHF)', '2A(RHF)', 'CNR']], { 30: 210000 }, { 30: 210000 }, '2026-09-26', '2026-09-26T07:45:05Z'),
  combo('l-2al', 'Lotti', [['2A(LHF)', '2A(RHF)', 'L(LHF)', 'L(RHF)']], { 30: 175000 }, { 30: 175000 }, '2026-09-26', '2026-09-26T07:36:05Z'),
  combo('p-1', 'Pllao', [['2A(LHF)', '2A(RHF)', 'L(LHF)', 'L(RHF)']], { Flat: 180000 }, { Flat: 190000 }, '2026-07-27', '2026-07-29T07:20:31Z'),
  combo('p-set', 'Pllao', [['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']], { Flat: 180000 }, {}, '2026-11-05', '2026-11-05T03:46:33Z'),
  combo('b-3', 'Boaat', [['1A(P)(LHF)', '1A(P)(RHF)', '1NA']], { 32: 220000 }, { 32: 220000 }, '2026-08-19', '2026-08-19T02:08:42Z'),
  combo('b-set2', 'Boaat', [['1A(P)(LHF)'], ['1A(P)(RHF)']], { 32: 180000 }, {}, '2026-10-27', '2026-10-27T02:02:46Z'),
  combo('a-123', 'ANNSA', [['1S', '2S', '3S']], { 37: 350000 }, {}, '2026-09-26', '2026-09-26T07:30:00Z'),
  combo('a-sup', 'ANNSA', [['1A(LHF)', '1A(RHF)', '2A(LHF)', '2A(RHF)']], { 37: 160000 }, {}, '2026-10-12', '2026-10-12T00:00:00Z', { supplier_id: 'sup-1' }),
];
const PRODUCTS: Record<string, Row> = {
  'LOTTI-2A(LHF)': { seat_height_prices: [{ tier: 'PRICE_2', height: '30', priceSen: 110000 }, { tier: 'PRICE_1', height: '30', sellingPriceSen: 170000 }] },
  'LOTTI-L(RHF)': { seat_height_prices: [{ tier: 'PRICE_2', height: '30', priceSen: 90000 }] },
  'PLLAO-L(LHF)': { seat_height_prices: [{ tier: 'PRICE_2', height: '30', priceSen: 90000 }] },
  'PLLAO-2A(RHF)': { seat_height_prices: [{ tier: 'PRICE_2', height: 'Flat', priceSen: 90000 }] },
  'BOAAT-1A(P)(LHF)': { seat_height_prices: [{ tier: 'PRICE_2', height: '32', priceSen: 100000 }] },
  'BOAAT-1A(P)(RHF)': { seat_height_prices: [{ tier: 'PRICE_2', height: '32', priceSen: 100000 }] },
  'ANNSA-2S': { seat_height_prices: [{ tier: 'PRICE_2', height: '37', priceSen: 120000 }] },
};
const ctx = {
  setPrices: onePieceSetPrices(COMBOS),
  combos: costCombos(COMBOS),
  tierOfFabric: () => 'PRICE_2' as const,
  listCost: (l: Row) => listCostOf(PRODUCTS[l.item_code], l, 'PRICE_2'),
  asOf: '2026-11-17',
};
let seq = 0;
const line = (item_code: string, cost: number, unit: number, variants: Row | null, over: Row = {}): Row => ({
  id: `l${++seq}`, item_code, item_group: 'sofa', qty: 1, unit_price_sen: unit, total_sen: unit,
  line_cost_sen: cost, variants, cancelled: false, ...over,
});
const fee = () => line('SVC-DELIVERY', 0, 25000, null, { item_group: 'service' });
const order = (doc_no: string, lines: Row[], local_total_sen: number): Row => {
  const total = lines.reduce((s, l) => s + l.line_cost_sen, 0);
  return { doc_no, status: 'IN_PRODUCTION', local_total_sen, total_cost_sen: total, total_margin_sen: local_total_sen - total, mattress_sofa_cost_sen: total };
};

describe('finding a set price on one piece', () => {
  it('knows both figures the old costing could have written: cost and selling', () => {
    expect(ctx.setPrices.get('PLLAO|Flat')!.map((p: Row) => p.sen)).toEqual([180000, 190000]);
  });

  it('looks only at sofa lines, at their own height', () => {
    expect(setPriceOn(line('LOTTI-2A(LHF)', 210000, 149500, { seatHeight: '30' }), ctx.setPrices)).not.toBeNull();
    expect(setPriceOn(line('LOTTI-2A(LHF)', 210000, 149500, { seatHeight: '24' }), ctx.setPrices)).toBeNull();
    expect(setPriceOn(line('LOTTI-2A(LHF)', 210000, 149500, { seatHeight: '30' }, { item_group: 'accessory' }), ctx.setPrices)).toBeNull();
  });

  it('never prices cost with the wrong shape or a supplier row', () => {
    expect(costCombos(COMBOS).map((c: Row) => c.id).sort()).toEqual(['b-set2', 'p-set']);
  });
});

describe('re-costing the real orders', () => {
  it('the 2990-SO-2610-057 shape, LOTTI 2A + L: the 2A gets its build sibling\'s share back', () => {
    const v = { seatHeight: '30', fabricCode: 'HG1313-02', buildKey: 'build-1' };
    const lines = [line('LOTTI-2A(LHF)', 210000, 149500, v), line('LOTTI-L(RHF)', 100000, 149500, v), fee()];
    const r = repairOrder(order('2990-SO-2610-057', lines, 324000), lines, ctx) as Row;
    expect(r.status).toBe('repair');
    expect(r.changes).toEqual([expect.objectContaining({ item_code: 'LOTTI-2A(LHF)', from: 210000, to: 100000, how: 'build sibling' })]);
    expect(r.header).toEqual({ total_cost_sen: 200000, mattress_sofa_cost_sen: 200000, total_margin_sen: 124000, margin_pct_basis: 3827 });
  });

  it('the 2990-SO-2610-046 shape, BOAAT set counted twice: both seats back on the two-seat set', () => {
    const v = { seatHeight: '32', fabricCode: 'EZ-002', buildKey: 'build-1' };
    const pillow = line('SQUARE PILLOW', 3000, 0, null, { item_group: 'fabric_accessory' });
    const lines = [line('BOAAT-1A(P)(RHF)', 220000, 155750, v), line('BOAAT-1A(P)(LHF)', 220000, 155750, v), pillow, fee()];
    const r = repairOrder(order('2990-SO-2610-046', lines, 336500), lines, ctx) as Row;
    expect(r.changes.map((c: Row) => [c.from, c.to, c.how])).toEqual([[220000, 90000, 'set combo'], [220000, 90000, 'set combo']]);
    expect(r.header.total_cost_sen).toBe(183000); // the two-seat set + the pillow
  });

  it('the 2990-SO-2610-017 shape, PLLAO: the L has no flat-seat list cost, and the set combo prices the pair at its cost', () => {
    const v = { seatHeight: 'Flat', fabricCode: 'D-004' };
    const lines = [line('PLLAO-L(LHF)', 190000, 249000, v), line('PLLAO-2A(RHF)', 90000, 0, v), fee()];
    const r = repairOrder(order('2990-SO-2610-017', lines, 274000), lines, ctx) as Row;
    expect(r.changes).toEqual([expect.objectContaining({ item_code: 'PLLAO-L(LHF)', from: 190000, to: 90000, how: 'set combo' })]);
    expect(r.header.total_cost_sen).toBe(180000);
  });

  it('the 2990-SO-2608-064 shape, ANNSA 2S: no sibling of its price, so its own list cost', () => {
    const lines = [
      line('ANNSA-2S', 350000, 306500, { seatHeight: '37', fabricCode: 'EZ-002', buildKey: 'build-1' }),
      line('ANNSA-HEADREST', 20000, 0, { seatHeight: '37', fabricCode: 'EZ-002' }, { qty: 2 }),
    ];
    const r = repairOrder(order('2990-SO-2608-064', lines, 306500), lines, ctx) as Row;
    expect(r.changes).toEqual([expect.objectContaining({ item_code: 'ANNSA-2S', from: 350000, to: 120000, how: 'price list' })]);
  });

  it('leaves an order with no set price alone', () => {
    const lines = [line('LOTTI-2A(LHF)', 100000, 149500, { seatHeight: '30' }), line('LOTTI-L(RHF)', 100000, 149500, { seatHeight: '30' })];
    expect(repairOrder(order('X', lines, 299000), lines, ctx)).toEqual({ status: 'clean' });
  });

  it('refuses an order whose header does not add up to its lines, rather than adjust a wrong total', () => {
    const lines = [line('LOTTI-2A(LHF)', 210000, 149500, { seatHeight: '30' })];
    const r = repairOrder({ ...order('Y', lines, 149500), total_cost_sen: 1 }, lines, ctx) as Row;
    expect(r.status).toBe('refused');
  });

  it('refuses a sibling share far from the piece\'s own list cost', () => {
    const v = { seatHeight: '30', buildKey: 'build-1' };
    const lines = [line('LOTTI-2A(LHF)', 210000, 149500, v), line('LOTTI-L(RHF)', 40000, 149500, v)];
    expect((repairOrder(order('Z', lines, 299000), lines, ctx) as Row).status).toBe('refused');
  });

  it('refuses a piece it cannot price at all', () => {
    const lines = [line('PLLAO-L(LHF)', 190000, 249000, { seatHeight: 'Flat' }), line('PLLAO-1B(LHF)', 80000, 0, { seatHeight: 'Flat' })];
    expect((repairOrder(order('W', lines, 249000), lines, ctx) as Row).status).toBe('refused');
  });
});
