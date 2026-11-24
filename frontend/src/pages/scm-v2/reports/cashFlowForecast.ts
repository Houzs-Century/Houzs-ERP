// ----------------------------------------------------------------------------
// cashFlowForecast — the Cash Flow's By month view with the P&L forecast (step 2
// of the forecast port, owner 2026-11-24 「开始做第 2 步」; Hookka's three columns,
// the P&L forecast first). Total leftmost as it is; every month after the current
// one, newest first, as its P&L forecast alone; then each month of the range as
// Actual | P&L forecast under the month's name. A forecast column IS the server's
// report for that month on the same tree, so its lines merge with the actual by id.
// Balance b/f and c/f run through the forecast: a month of the range starts from
// its own actual b/f; a later month from the month before's forecast c/f.
// ----------------------------------------------------------------------------

import { monthEnd } from '../../../lib/dateRangePresets';
import type { CashFlowForecast } from '../../../vendor/scm/lib/cash-flow-forecast-queries';
import type { RpReport } from '../../../vendor/scm/lib/rp-report-queries';
import { monthName, type StatementColumn } from './statementColumns';

export const ACTUAL_LABEL = 'Actual';
export const FORECAST_LABEL = 'P&L forecast';
/** A month's P&L forecast column. */
export const fpKey = (ym: string): string => `fp:${ym}`;
export const isForecastKey = (key: string): boolean => key.startsWith('fp:');

/** The By month columns with the P&L forecast beside each month. */
export function forecastColumns(months: StatementColumn[], forecast: CashFlowForecast): StatementColumn[] {
  const out: StatementColumn[] = months.filter((c) => c.kind !== 'period');
  const later = forecast.months.filter((m) => m.future).map((m) => m.month).sort().reverse();
  for (const ym of later) {
    out.push({
      key: fpKey(ym), label: FORECAST_LABEL, kind: 'period', from: `${ym}-01`, to: monthEnd(`${ym}-01`), pct: false,
      group: { key: ym, label: monthName(`${ym}-01`), sub: 'Forecast only' }, mark: 'gold',
    });
  }
  for (const c of months) {
    if (c.kind !== 'period') continue;
    const group = { key: c.key, label: c.label, ...(c.sub ? { sub: c.sub } : {}) };
    out.push({ ...c, label: ACTUAL_LABEL, pct: false, group, mark: 'petrol' });
    out.push({ key: fpKey(c.key), label: FORECAST_LABEL, kind: 'period', from: c.from, to: c.to, pct: false, group, mark: 'gold' });
  }
  return out;
}

/** Each forecast month's report keyed by its column, its balances run through:
    a month of the range from its actual b/f (when that month's actual is read),
    a later month from the forecast c/f of the month before. */
export function rollForecast(forecast: CashFlowForecast, actual: Partial<Record<string, RpReport>>): Record<string, RpReport> {
  const out: Record<string, RpReport> = {};
  let carry = 0;
  for (const m of [...forecast.months].sort((a, b) => a.month.localeCompare(b.month))) {
    const own = m.future ? undefined : actual[m.month];
    const opening = own ? own.totals.openingTotalSen : carry;
    const t = m.report.totals;
    const closing = opening + t.receiptsTotalSen - t.paymentsTotalSen;
    const col = m.report.columns[0]?.code ?? 'FORECAST';
    out[fpKey(m.month)] = {
      ...m.report,
      opening: { [col]: opening },
      totals: { ...t, openingTotalSen: opening, closingTotalSen: closing, closing: { [col]: closing } },
    };
    carry = closing;
  }
  return out;
}

const after = (n: number): string => (n === 0 ? 'in the order month' : n === 1 ? 'a month after' : `${n} months after`);
const NAMES_SHOWN = 12;

/** What the forecast columns are, said under the table. */
export function forecastNote(forecast: CashFlowForecast): string {
  const mix = forecast.receiptMix.map((p) => `${p.pct}% ${p.kind === 'DEP' ? 'as deposits' : 'as settlements'} ${after(p.months)}`).join(', ');
  const parts = [
    `P&L forecast: the Forecast P&L as cash. Sales come in as the customers paid from ${monthName(forecast.measured.from)} to ${monthName(forecast.measured.to)}: ${mix}.`,
    'A purchase line split by supplier is paid after each supplier’s payment term; Other, and a supplier without a term, a month later; a purchase line keyed whole by its recent suppliers’ terms.',
    'Salaries are paid the month after; every other line in its month.',
    'A month after this one shows the forecast alone; its Balance b/f runs on from the month before.',
  ];
  if (forecast.nonCash.length > 0) parts.push(`Left out as moving no cash: ${forecast.nonCash.map((l) => `${l.code} ${l.name}`).join(', ')}.`);
  if (forecast.flagged.length > 0) {
    const names = forecast.flagged.slice(0, NAMES_SHOWN).map((s) => s.name).join(', ');
    const more = forecast.flagged.length > NAMES_SHOWN ? ` and ${forecast.flagged.length - NAMES_SHOWN} more` : '';
    parts.push(`No payment term on the supplier, counted a month later (${forecast.flagged.length}): ${names}${more}. Set the term on the supplier's page.`);
  }
  return parts.join(' ');
}
