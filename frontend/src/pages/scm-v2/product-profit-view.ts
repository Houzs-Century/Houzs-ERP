// ----------------------------------------------------------------------------
// product-profit-view — what the Product Profit tab shows, worked out from the
// server's rows and the owner's three levers (2026-10-05): the categories
// ticked (any number — 「别限制两个」; none ticked = all), whether the gifts
// count (「可以让我自己在表 switch 要不要 include」), and the column the rows
// are ranked by (gross profit by default). The screen, the charts and the
// Excel / PDF all read these, so they can never disagree. The words are
// English (owner 2026-10-05: 字体要英文).
// ----------------------------------------------------------------------------

import type { ProductCategory, ProductProfitData, ProductProfitRow } from '../../vendor/scm/lib/product-profit-queries';
import { AMOUNT_COLUMN, PCT_COLUMN, type ReportSheet, type SheetRow, type SheetValue } from '../../vendor/scm/lib/report-sheet';
import { fmtSenPlain } from '../../vendor/shared/format';

export const CATEGORY_ORDER: readonly ProductCategory[] = ['mattress', 'sofa', 'bedframe', 'other'];
export const CATEGORY_LABEL: Record<ProductCategory, string> = { mattress: 'Mattress', sofa: 'Sofa', bedframe: 'Bedframe', other: 'Others' };

/** A sofa is counted in sets (「按套」), everything else in pieces. */
export const unitWord = (category: ProductCategory, n: number): string =>
  (category === 'sofa' ? (n === 1 ? 'set' : 'sets') : (n === 1 ? 'pc' : 'pcs'));

export type SortKey = 'gp' | 'units' | 'sales' | 'gpPct';
export type ProfitView = { cats: ReadonlySet<ProductCategory>; gifts: boolean; sort: SortKey };

export const gpOf = (r: ProductProfitRow, gifts: boolean): number => r.salesSen - r.costSen - (gifts ? r.giftSen : 0);
export const gpPctOf = (r: { salesSen: number }, gp: number): number | null => (r.salesSen > 0 ? (gp / r.salesSen) * 100 : null);

/** The rows the view keeps, ranked: the chosen column, then gross profit, then the name. */
export function viewRows(d: ProductProfitData, v: ProfitView): ProductProfitRow[] {
  const kept = d.rows.filter((r) => v.cats.size === 0 || v.cats.has(r.category));
  const value = (r: ProductProfitRow): number => {
    if (v.sort === 'units') return r.units;
    if (v.sort === 'sales') return r.salesSen;
    if (v.sort === 'gpPct') return gpPctOf(r, gpOf(r, v.gifts)) ?? Number.NEGATIVE_INFINITY;
    return gpOf(r, v.gifts);
  };
  return [...kept].sort((a, b) => value(b) - value(a) || gpOf(b, v.gifts) - gpOf(a, v.gifts) || a.model.localeCompare(b.model));
}

export type ProfitTotals = { salesSen: number; costSen: number; giftSen: number; gpSen: number; gpPct: number | null };
export function totalsOf(rows: readonly ProductProfitRow[], gifts: boolean): ProfitTotals {
  const salesSen = rows.reduce((a, r) => a + r.salesSen, 0);
  const costSen = rows.reduce((a, r) => a + r.costSen, 0);
  const giftSen = rows.reduce((a, r) => a + r.giftSen, 0);
  const gpSen = salesSen - costSen - (gifts ? giftSen : 0);
  return { salesSen, costSen, giftSen, gpSen, gpPct: gpPctOf({ salesSen }, gpSen) };
}

/** A slice of the donut; a category slice carries its category, so its colour never moves with its rank. */
export type Slice = { label: string; valueSen: number; rest?: boolean; category?: ProductCategory };
export type Donut = { slices: Slice[]; byCategory: boolean; losers: { count: number; sen: number } };

/** The donut of gross profit: one category ticked → its products (the first six,
    the rest as one slice); otherwise the categories. Only what earned is drawn;
    what lost is counted under it. */
export function donutOf(rows: readonly ProductProfitRow[], v: ProfitView): Donut {
  if (v.cats.size === 1) {
    const ranked = [...rows].sort((a, b) => gpOf(b, v.gifts) - gpOf(a, v.gifts));
    const earned = ranked.filter((r) => gpOf(r, v.gifts) > 0);
    const lost = ranked.filter((r) => gpOf(r, v.gifts) <= 0);
    const slices: Slice[] = earned.slice(0, 6).map((r) => ({ label: r.model, valueSen: gpOf(r, v.gifts) }));
    const rest = earned.slice(6).reduce((a, r) => a + gpOf(r, v.gifts), 0);
    if (rest > 0) slices.push({ label: `Other models (${earned.length - 6})`, valueSen: rest, rest: true });
    return { slices, byCategory: false, losers: { count: lost.length, sen: lost.reduce((a, r) => a + gpOf(r, v.gifts), 0) } };
  }
  const cats = CATEGORY_ORDER.filter((c) => v.cats.size === 0 || v.cats.has(c));
  const byCat: Slice[] = cats.map((c) => ({ label: CATEGORY_LABEL[c], category: c, valueSen: rows.filter((r) => r.category === c).reduce((a, r) => a + gpOf(r, v.gifts), 0) }));
  const lost = byCat.filter((s) => s.valueSen < 0);
  return { slices: byCat.filter((s) => s.valueSen > 0), byCategory: true, losers: { count: lost.length, sen: lost.reduce((a, s) => a + s.valueSen, 0) } };
}

export type StepKey = 'sales' | 'cost' | 'gifts' | 'gp';
export type Step = { key: StepKey; label: string; valueSen: number; kind: 'start' | 'down' | 'end' };
/** Sales → own cost → the gifts (when they count) → gross profit. */
export function waterfallOf(t: ProfitTotals, gifts: boolean): Step[] {
  const steps: Step[] = [
    { key: 'sales', label: 'Sales', valueSen: t.salesSen, kind: 'start' },
    { key: 'cost', label: 'Product cost', valueSen: -t.costSen, kind: 'down' },
  ];
  if (gifts) steps.push({ key: 'gifts', label: 'Gifts', valueSen: -t.giftSen, kind: 'down' });
  steps.push({ key: 'gp', label: 'Gross profit', valueSen: t.gpSen, kind: 'end' });
  return steps;
}

/** The free-bedframe tile shows when the view holds mattresses or bedframes (「床架和床垫一起」). */
export const showsFreeBedframes = (v: ProfitView): boolean => v.cats.size === 0 || v.cats.has('mattress') || v.cats.has('bedframe');

export const unitsText = (r: ProductProfitRow): string => `${r.units} ${unitWord(r.category, r.units)}`;
export const freeBedframesText = (r: ProductProfitRow): string =>
  (r.freeBedframeSen > 0 || r.freeBedframes > 0
    ? `${Number.isInteger(r.freeBedframes) ? r.freeBedframes : r.freeBedframes.toFixed(1)} ${r.freeBedframes === 1 ? 'pc' : 'pcs'} · ${fmtSenPlain(r.freeBedframeSen)}`
    : '');
export const viewLabel = (v: ProfitView): string =>
  (v.cats.size === 0 ? 'All' : CATEGORY_ORDER.filter((c) => v.cats.has(c)).map((c) => CATEGORY_LABEL[c]).join(' + '));
export const giftsLabel = (gifts: boolean): string => (gifts ? 'gifts included' : 'gifts not counted');

/** The foot: what the figures leave out, and what reads high. */
export function profitNotes(d: ProductProfitData, v: ProfitView, rows: readonly ProductProfitRow[]): string[] {
  const notes = ['By SO date. Draft and cancelled orders, cancelled lines and service lines (delivery, installation) are left out.'];
  const giftAll = rows.reduce((a, r) => a + r.giftSen, 0);
  notes.push(v.gifts
    ? 'Gifts (free bedframes, pillows, protectors and the like) are shared among the paid products on the same order, by their sales.'
    : `Gifts are not counted this time (these products' share of the gifts: ${fmtSenPlain(giftAll)}).`);
  if (v.gifts && d.unallocatedGift.orders > 0) {
    notes.push(`${d.unallocatedGift.orders} order(s) carry gifts but no paid product; their cost, ${fmtSenPlain(d.unallocatedGift.sen)}, is in no row.`);
  }
  const noCost = rows.filter((r) => r.noCostLines > 0);
  if (noCost.length > 0) {
    notes.push(`${noCost.length} model(s) have priced lines with no cost (marked "Cost incomplete") — their margin reads high.`);
  }
  return notes;
}

/** The table as the screen shows it — same rows, same order, same switch — for Excel and PDF. */
export function productProfitSheet(d: ProductProfitData, v: ProfitView, rows: readonly ProductProfitRow[]): ReportSheet {
  const t = totalsOf(rows, v.gifts);
  const cells = (r: ProductProfitRow): SheetValue[] => {
    const gp = gpOf(r, v.gifts);
    const out: SheetValue[] = [CATEGORY_LABEL[r.category], unitsText(r), r.units > 0 ? Math.round(r.salesSen / r.units) : null, r.salesSen, r.costSen];
    if (v.gifts) out.push(r.giftSen);
    out.push(gp, gpPctOf(r, gp), freeBedframesText(r) || null);
    return out;
  };
  const table: SheetRow[] = rows.map((r, i) => ({ kind: 'row', depth: 0, label: `${i + 1}. ${r.model}${r.brand ? ` · ${r.brand}` : ''}`, cells: cells(r) }));
  const total: SheetValue[] = [null, null, null, t.salesSen, t.costSen];
  if (v.gifts) total.push(t.giftSen);
  total.push(t.gpSen, t.gpPct, null);
  table.push({ kind: 'total', depth: 0, label: 'Total', cells: total });
  return {
    title: 'Product Profit',
    subtitle: `${d.month} · ${viewLabel(v)} · ${giftsLabel(v.gifts)} · RM`,
    meta: [
      { label: 'Month', value: d.month },
      { label: 'Models', value: String(rows.length) },
      { label: 'Orders', value: String(d.orders) },
    ],
    tables: [{
      columns: [
        { label: 'Category', kind: 'text' }, { label: 'Sold', kind: 'text' }, AMOUNT_COLUMN('Avg price'), AMOUNT_COLUMN('Sales'), AMOUNT_COLUMN('Product cost'),
        ...(v.gifts ? [AMOUNT_COLUMN('Gifts')] : []),
        AMOUNT_COLUMN('Gross profit'), PCT_COLUMN('Margin'), { label: 'Free bedframes', kind: 'text' as const },
      ],
      rows: table,
    }],
    notes: profitNotes(d, v, rows),
  };
}
