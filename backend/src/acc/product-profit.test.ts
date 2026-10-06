/* The monthly product profit ranking (owner 2026-10-05), on the pure builder.
   Pinned: a product is its model, sizes together; a sofa counts in sets (the
   orders that bought it); a zero-price line of a model the same order sells is
   that product's own cost; every other zero-price line is a gift shared by the
   order's paid products by their sales, to the sen; free bedframes are shared
   the same way; DRAFT / CANCELLED orders, cancelled lines and service lines
   stay out; an order with gifts and no paid product is counted apart; a priced
   line with no cost is counted. */
import { describe, expect, test } from 'vitest';
import { buildProductProfit, shareByWeight, type PpLine, type PpModel, type PpOrder, type PpProduct } from './product-profit';

const so = (doc: string, status = 'CONFIRMED'): PpOrder => ({ doc_no: doc, status });
const ln = (doc: string, group: string, code: string, qty: number, sales: number, cost: number, over: Partial<PpLine> = {}): PpLine => ({
  doc_no: doc, item_group: group, item_code: code, description: null, qty, total_sen: sales, unit_cost_sen: null, line_cost_sen: cost, cancelled: false, ...over,
});
const PRODUCTS: PpProduct[] = [
  { code: 'ULT-Q', model_id: 'a1b2c3d4-0000-4000-8000-000000000001', base_model: null, size_label: 'Queen' },
  { code: 'ULT-K', model_id: 'a1b2c3d4-0000-4000-8000-000000000001', base_model: null, size_label: 'King' },
  { code: 'GRD-Q', model_id: 'a1b2c3d4-0000-4000-8000-000000000002', base_model: null, size_label: 'Queen' },
  { code: 'SOF-1A', model_id: 'a1b2c3d4-0000-4000-8000-000000000003', base_model: null, size_label: null },
  { code: 'SOF-CNR', model_id: 'a1b2c3d4-0000-4000-8000-000000000003', base_model: null, size_label: null },
  { code: 'JAG-Q', model_id: 'a1b2c3d4-0000-4000-8000-000000000004', base_model: null, size_label: 'Queen' },
  { code: 'PIL', model_id: null, base_model: 'PILLOW', size_label: null },
];
const MODELS: PpModel[] = [
  { id: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'ULTIMATE', branding: 'AKEMI' },
  { id: 'a1b2c3d4-0000-4000-8000-000000000002', name: 'GUARDIAN', branding: 'AKEMI' },
  { id: 'a1b2c3d4-0000-4000-8000-000000000003', name: 'SOFFIO', branding: 'ZANOTTI' },
  { id: 'a1b2c3d4-0000-4000-8000-000000000004', name: 'JAGER', branding: null },
];
const build = (orders: PpOrder[], lines: PpLine[]) =>
  buildProductProfit({ month: '2026-09', from: '2026-09-01', to: '2026-09-30', orders, lines, products: PRODUCTS, models: MODELS });
const row = (r: ReturnType<typeof build>, model: string) => r.rows.find((x) => x.model === model)!;

describe('shareByWeight', () => {
  test('shares a whole number of sen by weight and adds back exactly', () => {
    expect(shareByWeight(1000, [600_000, 300_000])).toEqual([667, 333]);
    expect(shareByWeight(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(shareByWeight(0, [5, 5])).toEqual([0, 0]);
    expect(shareByWeight(50, [0, 0])).toEqual([0, 0]);
  });
});

describe('buildProductProfit', () => {
  test('a model is one row, sizes together; the items keep the sizes', () => {
    const r = build([so('SO-1'), so('SO-2')], [
      ln('SO-1', 'mattress', 'ULT-Q', 1, 600_000, 150_000),
      ln('SO-2', 'mattress', 'ULT-K', 2, 1_400_000, 340_000),
    ]);
    const u = row(r, 'ULTIMATE');
    expect(u).toMatchObject({ brand: 'AKEMI', category: 'mattress', units: 3, orders: 2, salesSen: 2_000_000, costSen: 490_000, giftSen: 0 });
    expect(u.items.map((i) => [i.code, i.size, i.units])).toEqual([['ULT-K', 'King', 2], ['ULT-Q', 'Queen', 1]]);
  });

  test('a sofa counts in sets, and its unpriced modules are its own cost', () => {
    const r = build([so('SO-1'), so('SO-2')], [
      ln('SO-1', 'sofa', 'SOF-1A', 1, 500_000, 120_000),
      ln('SO-1', 'sofa', 'SOF-CNR', 1, 0, 80_000),
      ln('SO-2', 'sofa', 'SOF-1A', 2, 520_000, 240_000),
    ]);
    expect(row(r, 'SOFFIO')).toMatchObject({ category: 'sofa', units: 2, orders: 2, salesSen: 1_020_000, costSen: 440_000, giftSen: 0 });
    expect(row(r, 'SOFFIO').items.find((i) => i.code === 'SOF-CNR')).toMatchObject({ units: 0, salesSen: 0, costSen: 80_000 });
  });

  test("an order's gifts are shared by its paid products' sales; free bedframes too", () => {
    const r = build([so('SO-1')], [
      ln('SO-1', 'mattress', 'ULT-Q', 1, 600_000, 150_000),
      ln('SO-1', 'mattress', 'GRD-Q', 1, 300_000, 70_000),
      ln('SO-1', 'bedframe', 'JAG-Q', 1, 0, 90_000),
      ln('SO-1', 'accessory', 'PIL', 2, 0, 10_000),
    ]);
    expect(row(r, 'ULTIMATE')).toMatchObject({ giftSen: 66_667, freeBedframeSen: 60_000, freeBedframes: 0.7 });
    expect(row(r, 'GUARDIAN')).toMatchObject({ giftSen: 33_333, freeBedframeSen: 30_000, freeBedframes: 0.3 });
    expect(r.rows.find((x) => x.model === 'JAGER')).toBeUndefined();
    expect(r.freeBedframes).toEqual({ pieces: 1, sen: 90_000, orders: 1 });
    expect(r.rows.map((x) => x.model)).toEqual(['ULTIMATE', 'GUARDIAN']);
  });

  test('a bedframe sold is a product; the same model given free on another order is a gift there', () => {
    const r = build([so('SO-1'), so('SO-2')], [
      ln('SO-1', 'bedframe', 'JAG-Q', 1, 150_000, 45_000),
      ln('SO-2', 'mattress', 'ULT-Q', 1, 600_000, 150_000),
      ln('SO-2', 'bedframe', 'JAG-Q', 1, 0, 45_000),
    ]);
    expect(row(r, 'JAGER')).toMatchObject({ category: 'bedframe', units: 1, salesSen: 150_000, costSen: 45_000, giftSen: 0 });
    expect(row(r, 'ULTIMATE')).toMatchObject({ giftSen: 45_000, freeBedframes: 1 });
  });

  test('DRAFT and CANCELLED orders, cancelled lines and service lines stay out', () => {
    const r = build([so('SO-1'), so('SO-D', 'DRAFT'), so('SO-X', 'CANCELLED')], [
      ln('SO-1', 'mattress', 'ULT-Q', 1, 600_000, 150_000),
      ln('SO-1', 'mattress', 'GRD-Q', 1, 300_000, 70_000, { cancelled: true }),
      ln('SO-1', 'service', 'SVC-DELIVERY', 1, 15_000, 0),
      ln('SO-D', 'mattress', 'GRD-Q', 1, 300_000, 70_000),
      ln('SO-X', 'mattress', 'GRD-Q', 1, 300_000, 70_000),
    ]);
    expect(r.rows.map((x) => x.model)).toEqual(['ULTIMATE']);
    expect(r.orders).toBe(1);
  });

  test('gifts on an order that paid for no product are counted apart', () => {
    const r = build([so('SO-1')], [
      ln('SO-1', 'service', 'SVC-REPLACE', 1, 5_000, 0),
      ln('SO-1', 'accessory', 'PIL', 1, 0, 8_000),
    ]);
    expect(r.rows).toEqual([]);
    expect(r.unallocatedGift).toEqual({ orders: 1, sen: 8_000 });
  });

  test('a priced line with no cost is counted, on the row and in the month', () => {
    const r = build([so('SO-1')], [ln('SO-1', 'mattress', 'GRD-Q', 1, 300_000, 0)]);
    expect(row(r, 'GUARDIAN').noCostLines).toBe(1);
    expect(r.noCost).toEqual({ lines: 1, salesSen: 300_000 });
  });

  test('a code the product list does not know is its own row, named by the code', () => {
    const r = build([so('SO-1')], [ln('SO-1', 'dining', 'TBL-9', 1, 90_000, 40_000)]);
    expect(r.rows[0]).toMatchObject({ key: 'c:TBL-9', model: 'TBL-9', brand: null, category: 'other', units: 1 });
  });
});
