// ----------------------------------------------------------------------------
// dashboardForecast — the Financial Dashboard with the forecasts (step 7 of the
// forecast port, owner 2026-11-24 「开始做第 7 步」; Hookka #1568 / #1572: the
// Cash Flow card's two dashed lines follow the tab picked). Per period, the
// Cash Flow's two forecasts — the P&L forecast (the Forecast P&L as cash) and
// Orders & bills (the money already in hand, from the current month on) — each
// the sum of its months' forecast reports. A period whose months a forecast
// does not all cover has none from it: a quarter half in the past has no
// Orders & bills, rather than a part of one.
// ----------------------------------------------------------------------------

import type { CashFlowForecast } from '../../../vendor/scm/lib/cash-flow-forecast-queries';

export type CashFigures = { inSen: number; outSen: number; netSen: number };
type MonthReport = { month: string; report: { totals: { receiptsTotalSen: number; paymentsTotalSen: number } } };

/** The forecast request's span: the periods' first month to their last; none past the door's 36 months. */
export const FORECAST_SPAN_MONTHS = 36;
export function forecastSpan(periods: ReadonlyArray<{ months: readonly string[] }>): { from: string; to: string } {
  const all = periods.flatMap((p) => p.months).sort();
  const from = all[0] ?? '';
  const to = all.at(-1) ?? '';
  if (!from || !to) return { from: '', to: '' };
  const span = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7)));
  return span < FORECAST_SPAN_MONTHS ? { from, to } : { from: '', to: '' };
}

/** One forecast's figures for a period: the sum of its months, or nothing when a month is missing. */
function sumOf(months: readonly string[], list: readonly MonthReport[]): CashFigures | null {
  if (months.length === 0) return null;
  const by = new Map(list.map((m) => [m.month, m.report.totals]));
  let inSen = 0;
  let outSen = 0;
  for (const ym of months) {
    const t = by.get(ym);
    if (!t) return null;
    inSen += t.receiptsTotalSen;
    outSen += t.paymentsTotalSen;
  }
  return { inSen, outSen, netSen: inSen - outSen };
}

/** A period's two forecasts. */
export function periodCashForecasts(months: readonly string[], f: CashFlowForecast | undefined): { pnl: CashFigures | null; docs: CashFigures | null } {
  if (!f) return { pnl: null, docs: null };
  return { pnl: sumOf(months, f.months), docs: sumOf(months, f.docs?.months ?? []) };
}

/** The tab's figure: money in, money out, or the net. */
export const pickCash = (f: CashFigures | null, tab: string): number | null => (f == null ? null : tab === 'in' ? f.inSen : tab === 'out' ? f.outSen : f.netSen);

/** Actual less forecast, where both are there. */
export const gapOf = (actual: number | null, forecast: number | null): number | null => (actual == null || forecast == null ? null : actual - forecast);

/* ── The Cash Flow card's Detail: each category, Actual | Forecast (part 3) ── */

type TreeNode = { id: string; kind: string; label: string; amountSen: number; children: TreeNode[] };
const isCategory = (n: TreeNode): boolean => n.kind === 'category' || n.kind === 'unassigned' || n.kind === 'subtotal';

/** The trees' categories two levels down, each once, in the order they first come: (id, label, depth). */
export function categoryRows(trees: ReadonlyArray<readonly TreeNode[]>): Array<{ id: string; label: string; depth: number }> {
  const out: Array<{ id: string; label: string; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (nodes: readonly TreeNode[], depth: number): void => {
    for (const n of nodes) {
      if (!isCategory(n)) continue;
      if (!seen.has(n.id)) { seen.add(n.id); out.push({ id: n.id, label: n.label, depth }); }
      if (depth < 1) walk(n.children, depth + 1);
    }
  };
  for (const t of trees) walk(t, 0);
  return out;
}

/** A tree's category amounts by id, two levels down. */
export function categoryAmounts(tree: readonly TreeNode[]): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (nodes: readonly TreeNode[], depth: number): void => {
    for (const n of nodes) {
      if (!isCategory(n)) continue;
      out.set(n.id, (out.get(n.id) ?? 0) + n.amountSen);
      if (depth < 1) walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

/** A period's forecast category amounts: its months' trees summed; nothing when a month is missing. */
export function periodCategoryForecast(months: readonly string[], list: ReadonlyArray<{ month: string; report: { layout: { tree: TreeNode[] } } }>): Map<string, number> | null {
  if (months.length === 0) return null;
  const by = new Map(list.map((m) => [m.month, m.report.layout.tree]));
  const out = new Map<string, number>();
  for (const ym of months) {
    const tree = by.get(ym);
    if (!tree) return null;
    for (const [id, sen] of categoryAmounts(tree)) out.set(id, (out.get(id) ?? 0) + sen);
  }
  return out;
}
