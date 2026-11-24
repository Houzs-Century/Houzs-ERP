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
