/* What the Product Profit tab shows (owner 2026-10-05). Pinned: any number of
   categories at once, none = all; the gifts switch moves gross profit, the
   margin, the waterfall and the export together; the ranking follows the
   chosen column; the donut is the products of one category, else the
   categories, and what lost money is counted beside it; the free-bedframe
   tile shows when mattresses or bedframes are in view. */
import { describe, expect, test } from 'vitest';
import type { ProductProfitData, ProductProfitRow } from '../../vendor/scm/lib/product-profit-queries';
import {
  donutOf, gpOf, productProfitSheet, profitNotes, rankingOf, showsFreeBedframes, totalsOf, viewRows, waterfallOf, type ProfitView,
} from './product-profit-view';

const row = (model: string, category: ProductProfitRow['category'], units: number, salesSen: number, costSen: number, giftSen: number, over: Partial<ProductProfitRow> = {}): ProductProfitRow => ({
  key: `m:${model}`, model, brand: null, category, units, orders: units, salesSen, costSen, giftSen,
  freeBedframes: 0, freeBedframeSen: 0, noCostLines: 0, items: [], ...over,
});
const DATA: ProductProfitData = {
  month: '2026-09', from: '2026-09-01', to: '2026-09-30', orders: 12,
  rows: [
    row('ULTIMATE', 'mattress', 89, 59_919_800, 14_650_000, 11_200_300, { brand: 'AKEMI', freeBedframes: 87, freeBedframeSen: 5_403_800 }),
    row('GUARDIAN', 'mattress', 54, 27_495_000, 6_956_000, 5_334_100),
    row('SOFFIO', 'sofa', 41, 20_570_400, 8_673_500, 232_800),
    row('JAGER', 'bedframe', 3, 481_400, 157_500, 50_500),
    row('PILLOW', 'other', 20, 36_000, 46_000, 0),
  ],
  unallocatedGift: { orders: 2, sen: 2_702_600 },
  freeBedframes: { pieces: 345, sen: 19_044_000, orders: 225 },
  noCost: { lines: 0, salesSen: 0 },
};
const view = (cats: Array<ProductProfitRow['category']>, gifts = true, sort: ProfitView['sort'] = 'gp'): ProfitView => ({ cats: new Set(cats), gifts, sort });

describe('product-profit-view', () => {
  test('none ticked is everything; any number of categories at once', () => {
    expect(viewRows(DATA, view([])).map((r) => r.model)).toEqual(['ULTIMATE', 'GUARDIAN', 'SOFFIO', 'JAGER', 'PILLOW']);
    expect(viewRows(DATA, view(['mattress', 'bedframe'])).map((r) => r.model)).toEqual(['ULTIMATE', 'GUARDIAN', 'JAGER']);
    expect(viewRows(DATA, view(['mattress', 'sofa', 'bedframe'])).length).toBe(4);
  });

  test('the gifts switch moves gross profit, and the ranking can follow units or margin', () => {
    const ult = DATA.rows[0];
    expect(gpOf(ult, true)).toBe(59_919_800 - 14_650_000 - 11_200_300);
    expect(gpOf(ult, false)).toBe(59_919_800 - 14_650_000);
    expect(viewRows(DATA, view(['mattress', 'sofa'], true, 'units')).map((r) => r.model)).toEqual(['ULTIMATE', 'GUARDIAN', 'SOFFIO']);
    expect(viewRows(DATA, view(['mattress', 'sofa'], true, 'gpPct')).map((r) => r.model)).toEqual(['ULTIMATE', 'SOFFIO', 'GUARDIAN']);
    const on = totalsOf(viewRows(DATA, view([])), true);
    const off = totalsOf(viewRows(DATA, view([])), false);
    expect(off.gpSen - on.gpSen).toBe(on.giftSen);
  });

  test('the waterfall: sales, less own cost, less the gifts when they count, is gross profit', () => {
    const t = totalsOf(viewRows(DATA, view(['mattress'])), true);
    expect(waterfallOf(t, true).map((s) => s.label)).toEqual(['Sales', 'Product cost', 'Gifts', 'Gross profit']);
    expect(waterfallOf(t, false).map((s) => s.label)).toEqual(['Sales', 'Product cost', 'Gross profit']);
    const s = waterfallOf(t, true);
    expect(s[0].valueSen + s[1].valueSen + s[2].valueSen).toBe(s[3].valueSen);
  });

  test('the donut: one category is its products; several are the categories; what lost is counted', () => {
    const one = donutOf(viewRows(DATA, view(['other'])), view(['other']));
    expect(one).toMatchObject({ byCategory: false, slices: [], losers: { count: 1, sen: -10_000 } });
    const mat = donutOf(viewRows(DATA, view(['mattress'])), view(['mattress']));
    expect(mat.slices.map((s) => s.label)).toEqual(['ULTIMATE', 'GUARDIAN']);
    const all = donutOf(viewRows(DATA, view([])), view([]));
    expect(all.byCategory).toBe(true);
    expect(all.slices.map((s) => s.label)).toEqual(['Mattress', 'Sofa', 'Bedframe']);
    expect(all.losers).toEqual({ count: 1, sen: -10_000 });
  });

  test('the ranking chart measures what the rows are ranked by', () => {
    const gp = rankingOf(viewRows(DATA, view([])), view([]));
    expect(gp.title).toBe('Gross profit ranking');
    expect(gp.bars[0]).toMatchObject({ label: 'ULTIMATE', value: 34_069_500, note: '341k · 56.9%' });
    const units = rankingOf(viewRows(DATA, view([], true, 'units')), view([], true, 'units'));
    expect(units.title).toBe('Units sold ranking');
    expect(units.bars.map((b) => [b.label, b.value])).toEqual([['ULTIMATE', 89], ['GUARDIAN', 54], ['SOFFIO', 41], ['PILLOW', 20], ['JAGER', 3]]);
    expect(units.bars[2].note).toBe('41 sets · 117k');
    const sales = rankingOf(viewRows(DATA, view(['mattress'], true, 'sales')), view(['mattress'], true, 'sales'));
    expect(sales).toMatchObject({ title: 'Sales ranking', bars: [{ label: 'ULTIMATE', value: 59_919_800 }, { label: 'GUARDIAN', value: 27_495_000 }] });
    const margin = rankingOf(viewRows(DATA, view(['sofa', 'other'], true, 'gpPct')), view(['sofa', 'other'], true, 'gpPct'));
    expect(margin.title).toBe('Margin ranking');
    expect(margin.bars.map((b) => b.label)).toEqual(['SOFFIO', 'PILLOW']);
    expect(margin.bars[1].value).toBeLessThan(0);
  });

  test('the free-bedframe tile shows with mattresses or bedframes in view', () => {
    expect(showsFreeBedframes(view([]))).toBe(true);
    expect(showsFreeBedframes(view(['mattress']))).toBe(true);
    expect(showsFreeBedframes(view(['sofa', 'bedframe']))).toBe(true);
    expect(showsFreeBedframes(view(['sofa']))).toBe(false);
  });

  test('Excel and PDF draw the rows as shown, with the gifts column only when they count', () => {
    const rows = viewRows(DATA, view(['mattress']));
    const on = productProfitSheet(DATA, view(['mattress']), rows);
    expect(on.tables[0].columns.map((c) => c.label)).toEqual(['Category', 'Sold', 'Avg price', 'Sales', 'Product cost', 'Gifts', 'Gross profit', 'Margin', 'Free bedframes']);
    expect(on.tables[0].rows[0]).toMatchObject({ label: '1. ULTIMATE · AKEMI', cells: ['Mattress', '89 pcs', 673_256, 59_919_800, 14_650_000, 11_200_300, 34_069_500, expect.any(Number), '87 pcs · 54,038.00'] });
    expect(on.tables[0].rows.at(-1)).toMatchObject({ kind: 'total' });
    expect(on.subtitle).toBe('2026-09 · Mattress · gifts included · RM');
    const off = productProfitSheet(DATA, view(['mattress'], false), rows);
    expect(off.tables[0].columns.map((c) => c.label)).not.toContain('Gifts');
    expect(profitNotes(DATA, view([], false), rows).some((n) => n.startsWith('Gifts are not counted this time'))).toBe(true);
    expect(profitNotes(DATA, view([]), rows).some((n) => n.includes('2 order(s) carry gifts but no paid product'))).toBe(true);
  });
});
