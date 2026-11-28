// ----------------------------------------------------------------------------
// bsForecast — the Balance Sheet's By month view with the forecast (step 6 of
// the forecast port, owner 2026-11-24 「开始做第 6 步」). Every month after the
// current one, newest first, as its forecast alone; the current month as
// Actual | Forecast under its name; earlier months as they are. A forecast
// column IS the server's sheet for that month-end on the same layout, so its
// lines merge with the actual by id; its figures do not open (no ledger lines).
// ----------------------------------------------------------------------------

import { monthEnd } from '../../../lib/dateRangePresets';
import { fmtSenPlain } from '../../../../../shared/src/vendor/shared/format';
import type { BsForecast } from '../../../vendor/scm/lib/bs-forecast-queries';
import { monthName, type StatementColumn } from './statementColumns';

export const BS_FORECAST_LABEL = 'Forecast';
/** A month-end's forecast column. */
export const fbKey = (ym: string): string => `fb:${ym}`;

/** The month-end columns with the forecast beside the current month and after it. */
export function bsForecastColumns<R>(columns: StatementColumn[], forecast: BsForecast<R>): StatementColumn[] {
  const shown = new Set(columns.map((c) => c.key));
  const forecastMonths = new Set(forecast.months.map((m) => m.month));
  const later = forecast.months.map((m) => m.month).filter((ym) => !shown.has(ym)).sort().reverse();
  const out: StatementColumn[] = later.map((ym) => ({
    key: fbKey(ym), label: BS_FORECAST_LABEL, kind: 'period', from: `${ym}-01`, to: monthEnd(`${ym}-01`), pct: true,
    group: { key: ym, label: monthName(`${ym}-01`), sub: 'Forecast only' }, mark: 'gold', noDrill: true,
  }));
  for (const c of columns) {
    if (!forecastMonths.has(c.key)) { out.push(c); continue; }
    const group = { key: c.key, label: c.label, ...(c.sub ? { sub: c.sub } : {}) };
    out.push({ ...c, label: 'Actual', group, mark: 'petrol' });
    out.push({ key: fbKey(c.key), label: BS_FORECAST_LABEL, kind: 'period', from: c.from, to: monthEnd(c.from), pct: c.pct, group, mark: 'gold', noDrill: true });
  }
  return out;
}

/** What the forecast columns are, said under the table. */
export function bsForecastNote<R>(f: BsForecast<R>): string {
  const start = monthName(f.start);
  const parts = [
    `Forecast: from the actual sheet at the end of ${start}, each month moved by the Forecast P&L — its sales owed by customers, its purchases owed to suppliers${f.accrual ? `, its salaries owed on ${f.accrual.code} ${f.accrual.name} and paid the month after` : ''}, its depreciation — and by the money as the Cash Flow's P&L forecast moves it, the bills owed at the start when due, the trade-finance plan and Capex & financing.`,
    'Stock stays as at the start; the profit is on Current period earnings; the forecast cash and depreciation sit on lines of their own.',
  ];
  const r = f.receipts;
  if (r.orders > 0) {
    parts.push(r.countedSen > 0
      ? `Open orders' balances at the start: RM ${fmtSenPlain(r.sen)} on ${r.orders} orders; RM ${fmtSenPlain(r.countedSen)} counted as they are delivered — never beyond the debtors on the start sheet.`
      : `Open orders' balances at the start (RM ${fmtSenPlain(r.sen)} on ${r.orders} orders) are not counted: the debtors on the start sheet were not above zero.`);
  }
  return parts.join(' ');
}
