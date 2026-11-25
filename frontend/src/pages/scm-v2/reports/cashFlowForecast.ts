// ----------------------------------------------------------------------------
// cashFlowForecast — the Cash Flow's By month view with the forecasts (steps 2
// and 4 of the forecast port, owner 2026-11-24 「开始做第 2 步」「开始做第 4 步」;
// Hookka's three columns). Total leftmost as it is; every month after the
// current one, newest first, as its forecasts alone; then each month of the
// range as Actual | Orders & bills | P&L forecast under the month's name — the
// Orders & bills column from the current month on. A forecast column IS the
// server's report for that month on the same tree, so its lines merge with the
// actual by id. Balance b/f and c/f run through each forecast on its own: a
// month of the range starts from its own actual b/f; a later month from the
// same forecast's c/f the month before.
// ----------------------------------------------------------------------------

import { monthEnd } from '../../../lib/dateRangePresets';
import { fmtSenPlain } from '../../../vendor/shared/format';
import type { CashFlowForecast } from '../../../vendor/scm/lib/cash-flow-forecast-queries';
import type { RpReport } from '../../../vendor/scm/lib/rp-report-queries';
import { monthName, type StatementColumn } from './statementColumns';

export const ACTUAL_LABEL = 'Actual';
export const DOCS_LABEL = 'Orders & bills';
export const FORECAST_LABEL = 'P&L forecast';
/** A month's P&L forecast column. */
export const fpKey = (ym: string): string => `fp:${ym}`;
/** A month's Orders & bills column. */
export const fcKey = (ym: string): string => `fc:${ym}`;
export const isForecastKey = (key: string): boolean => key.startsWith('fp:') || key.startsWith('fc:');

/** The By month columns with the forecasts beside each month. */
export function forecastColumns(months: StatementColumn[], forecast: CashFlowForecast): StatementColumn[] {
  const out: StatementColumn[] = months.filter((c) => c.kind !== 'period');
  const inRange = new Set(months.filter((c) => c.kind === 'period').map((c) => c.key));
  const docs = new Set((forecast.docs?.months ?? []).map((m) => m.month));
  const pnl = new Set(forecast.months.map((m) => m.month));
  const later = [...new Set([...forecast.months, ...(forecast.docs?.months ?? [])].filter((m) => m.future && !inRange.has(m.month)).map((m) => m.month))].sort().reverse();
  for (const ym of later) {
    const at = { kind: 'period' as const, from: `${ym}-01`, to: monthEnd(`${ym}-01`), pct: false, group: { key: ym, label: monthName(`${ym}-01`), sub: 'Forecast only' } };
    if (docs.has(ym)) out.push({ key: fcKey(ym), label: DOCS_LABEL, ...at, mark: 'brass' });
    if (pnl.has(ym)) out.push({ key: fpKey(ym), label: FORECAST_LABEL, ...at, mark: 'gold' });
  }
  for (const c of months) {
    if (c.kind !== 'period') continue;
    const group = { key: c.key, label: c.label, ...(c.sub ? { sub: c.sub } : {}) };
    out.push({ ...c, label: ACTUAL_LABEL, pct: false, group, mark: 'petrol' });
    if (docs.has(c.key)) out.push({ key: fcKey(c.key), label: DOCS_LABEL, kind: 'period', from: c.from, to: c.to, pct: false, group, mark: 'brass' });
    out.push({ key: fpKey(c.key), label: FORECAST_LABEL, kind: 'period', from: c.from, to: c.to, pct: false, group, mark: 'gold' });
  }
  return out;
}

type ForecastMonth = { month: string; future: boolean; report: RpReport };

/** Each forecast month's report keyed by its column, its balances run through:
    a month of the range from its actual b/f (when that month's actual is read),
    a later month from the same forecast's c/f the month before. */
export function rollForecast(forecast: CashFlowForecast, actual: Partial<Record<string, RpReport>>): Record<string, RpReport> {
  const out: Record<string, RpReport> = {};
  const roll = (list: readonly ForecastMonth[], keyOf: (ym: string) => string): void => {
    let carry = 0;
    for (const m of [...list].sort((a, b) => a.month.localeCompare(b.month))) {
      const own = m.future ? undefined : actual[m.month];
      const opening = own ? own.totals.openingTotalSen : carry;
      const t = m.report.totals;
      const closing = opening + t.receiptsTotalSen - t.paymentsTotalSen;
      const col = m.report.columns[0]?.code ?? 'FORECAST';
      out[keyOf(m.month)] = {
        ...m.report,
        opening: { [col]: opening },
        totals: { ...t, openingTotalSen: opening, closingTotalSen: closing, closing: { [col]: closing } },
      };
      carry = closing;
    }
  };
  roll(forecast.months, fpKey);
  roll(forecast.docs?.months ?? [], fcKey);
  return out;
}

const after = (n: number): string => (n === 0 ? 'in the order month' : n === 1 ? 'a month after' : `${n} months after`);
const NAMES_SHOWN = 12;
const named = (names: string[]): string => `${names.slice(0, NAMES_SHOWN).join(', ')}${names.length > NAMES_SHOWN ? ` and ${names.length - NAMES_SHOWN} more` : ''}`;
const rm = (sen: number): string => `RM ${fmtSenPlain(sen)}`;

/** What the Orders & bills column is, said under the table. */
function docsNote(d: NonNullable<CashFlowForecast['docs']>): string[] {
  const month = monthName(d.asAt);
  const parts = [
    `Orders & bills: the money already in hand. An open order's unpaid balance comes in its delivery month; one whose delivery date had passed is in ${month} on its own row.`,
    `A supplier is paid what the books say it is owed — its newest bills — each on its planned day, else its due date, else its payment term; a bill already past that is in ${month} on its own row.`,
    `Salaries and the other Forecast P&L costs as in the P&L forecast, less the bills already counted; Capex & financing as keyed. ${month} is as it stood on its 1st; a later month is from today's orders and bills.`,
  ];
  if (d.undated.length > 0) {
    const n = d.undated.reduce((s, u) => s + u.orders, 0);
    parts.push(`Open orders with no delivery date, in no month (${n}): ${d.undated.map((u) => `${u.orders} ordered in ${u.year}, ${rm(u.sen)}`).join('; ')}.`);
  }
  const { orders, orderSen, bills, billSen } = d.beyond;
  if (orders > 0) parts.push(`Delivery after the last month shown: ${orders} open order${orders === 1 ? '' : 's'}, ${rm(orderSen)}.`);
  if (bills > 0) parts.push(`Due after the last month shown: ${bills} bill${bills === 1 ? '' : 's'}, ${rm(billSen)}.`);
  if (d.flagged.length > 0) parts.push(`Bills timed a month later for want of a payment term (${d.flagged.length}): ${named(d.flagged)}.`);
  return parts;
}

/** What the trade-finance plan puts in both forecasts, said under the table. */
function tfNote(t: NonNullable<CashFlowForecast['tf']>): string[] {
  const parts = t.facilities.map((x) => {
    const n = Math.round(x.tenorDays / 30);
    const plan = x.suppliers.length > 0 ? `; its planned draws pay ${named(x.suppliers)}` : '';
    return `Trade finance (${x.lender}): ${rm(x.owedNowSen)} owed today, each draw repaid ${n === 1 ? 'a month' : `${n} months`} after it with ${(x.rateBp / 100).toFixed(2)}% interest per draw${plan}.`;
  });
  if (t.interestLeftOut.length > 0) parts.push(`The Forecast P&L's ${t.interestLeftOut.map((l) => `${l.code} ${l.name}`).join(', ')} is left out: the interest comes with each repayment.`);
  return parts;
}

/** What the forecast columns are, said under the table. */
export function forecastNote(forecast: CashFlowForecast): string {
  const mix = forecast.receiptMix.map((p) => `${p.pct}% ${p.kind === 'DEP' ? 'as deposits' : 'as settlements'} ${after(p.months)}`).join(', ');
  const parts = [
    ...(forecast.docs ? docsNote(forecast.docs) : []),
    `P&L forecast: the Forecast P&L as cash. Sales come in as the customers paid from ${monthName(forecast.measured.from)} to ${monthName(forecast.measured.to)}: ${mix}.`,
    'A purchase line split by supplier is paid after each supplier’s payment term; Other, and a supplier without a term, a month later; a purchase line keyed whole by its recent suppliers’ terms.',
    'Salaries are paid the month after; every other line in its month. Capex & financing keyed on this page is in its month, on its own account.',
    'A month after this one shows the forecasts alone; its Balance b/f runs on from the month before.',
    ...(forecast.tf ? tfNote(forecast.tf) : []),
  ];
  if (forecast.nonCash.length > 0) parts.push(`Left out as moving no cash: ${forecast.nonCash.map((l) => `${l.code} ${l.name}`).join(', ')}.`);
  if (forecast.flagged.length > 0) {
    parts.push(`No payment term on the supplier, counted a month later (${forecast.flagged.length}): ${named(forecast.flagged.map((s) => s.name))}. Set the term on the supplier's page.`);
  }
  return parts.join(' ');
}
