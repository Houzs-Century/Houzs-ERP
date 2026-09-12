/* The Performance P&L (owner 2026-09-12; docs/bugs/0835): sales and cost of
   sales from the sales orders of a period per group, operating expense as
   an adjustable rate of sales excluding service in place of one ledger
   account, every other expense as booked; net. Numbers come from
   GET /accounting/reports/performance, computed live; the rate and the
   account are the company's settings. The server half is
   backend/src/scm/routes/accounting-performance.ts; see accounting.md. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import { fmtDateOrDash } from '../../shared/format';

export type PerformanceSettings = { rateBp: number; account: string };
export type PerformanceGroup = { key: string; label: string; lines: number; salesSen: number; cogsSen: number; gpSen: number; gpPct: number | null };
export type PerformanceExpense = { code: string; name: string; amountSen: number };
export type PerformanceReport = {
  from: string; to: string;
  orders: { counted: number; notDelivered: number; excludedDraft: number; excludedCancelled: number };
  groups: PerformanceGroup[];
  totals: { salesSen: number; cogsSen: number; gpSen: number; gpPct: number | null; salesExServiceSen: number };
  operatingExpense: { rateBp: number; baseSen: number; amountSen: number; account: string; accountName: string | null; accountFound: boolean; bookedSen: number };
  otherIncome: PerformanceExpense[];
  otherIncomeSen: number;
  otherExpenses: PerformanceExpense[];
  otherExpensesSen: number;
  netSen: number; netPct: number | null;
  settings: PerformanceSettings;
};

const KEY = 'report-performance';

export const performanceReportPath = (from: string, to: string): string =>
  `/accounting/reports/performance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

export const usePerformanceReport = (from: string, to: string) => useQuery({
  queryKey: [KEY, from, to],
  queryFn: () => authedFetch<PerformanceReport>(performanceReportPath(from, to)),
  enabled: Boolean(from && to),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

export const useSavePerformanceSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (s: PerformanceSettings) =>
      authedFetch<{ ok: boolean; settings: PerformanceSettings }>('/accounting/reports/performance/settings', { method: 'POST', body: JSON.stringify(s) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: [KEY] }); },
  });
};

/* ── The report's own dress — ONE home for the screen, the CSV and the PDF ── */

/** 1,234.56 with a bracketed negative. */
export const fmtPerf = (sen: number): string => {
  const abs = Math.abs(sen) / 100;
  const s = abs.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sen < 0 ? `(${s})` : s;
};
export const fmtPerfPct = (pct: number | null): string => (pct == null ? '—' : `${pct.toFixed(1)}%`);
const ratePct = (bp: number): string => `${(bp / 100).toFixed(2)}%`;

export type PerformanceSummaryLine = { kind: 'total' | 'row' | 'net'; label: string; amountSen: number; note?: string };

/** The lines under the groups — gross profit, the other income as booked,
    the computed operating expense (named for what it stands in for), every
    other expense as booked, net — expenses as deductions. */
export const performanceSummaryLines = (r: PerformanceReport): PerformanceSummaryLine[] => {
  const o = r.operatingExpense;
  const standsFor = o.accountFound
    ? `in place of ${o.account}${o.accountName ? ` ${o.accountName}` : ''}`
    : `${o.account} not in the chart — nothing replaced`;
  return [
    { kind: 'total', label: 'Gross profit', amountSen: r.totals.gpSen, note: fmtPerfPct(r.totals.gpPct) },
    ...r.otherIncome.map((e): PerformanceSummaryLine => ({ kind: 'row', label: `${e.code} · ${e.name}`, amountSen: e.amountSen })),
    { kind: 'total', label: 'Total other income (as booked)', amountSen: r.otherIncomeSen },
    { kind: 'row', label: `Operating expense — ${ratePct(o.rateBp)} of sales excluding service (${fmtPerf(o.baseSen)}), ${standsFor}`, amountSen: -o.amountSen },
    ...r.otherExpenses.map((e): PerformanceSummaryLine => ({ kind: 'row', label: `${e.code} · ${e.name}`, amountSen: -e.amountSen })),
    { kind: 'total', label: 'Total other expenses (as booked)', amountSen: -r.otherExpensesSen },
    { kind: 'net', label: 'NET PERFORMANCE', amountSen: r.netSen, note: r.netPct == null ? undefined : `${fmtPerfPct(r.netPct)} of sales` },
  ];
};

/** The sentences under the figures — what was read from where, and what the
    computed operating expense replaced (owner: 在 performance P&L 要注明). */
export const performanceNotes = (r: PerformanceReport): string[] => {
  const o = r.operatingExpense;
  const notes = [
    `Sales and cost of sales are taken from the sales orders dated ${fmtDateOrDash(r.from)} to ${fmtDateOrDash(r.to)} — every status except DRAFT and CANCELLED: ${r.orders.counted} orders, ${r.orders.notDelivered} of them not yet delivered. Cost of sales is each line's unit cost × quantity as recorded on the order.`,
    o.accountFound
      ? `Operating expense is ${ratePct(o.rateBp)} of sales excluding service / transport income (${fmtPerf(o.baseSen)}), in place of account ${o.account}${o.accountName ? ` ${o.accountName}` : ''}; the ${fmtPerf(o.bookedSen)} booked on that account in the period is left out. Other income and every other expense are as booked in the ledger, by journal date.`
      : `Operating expense is ${ratePct(o.rateBp)} of sales excluding service / transport income (${fmtPerf(o.baseSen)}). Account ${o.account} is not in this company's chart, so nothing was replaced: the computed figure is added to the expenses as booked. Other income and the expenses are as booked in the ledger, by journal date.`,
  ];
  const accessory = r.groups.find((g) => g.key === 'accessory');
  if (accessory && accessory.cogsSen > accessory.salesSen) notes.push('Accessory lines are largely free gifts — no sales against their cost — so a negative margin there is expected.');
  if (r.groups.some((g) => g.key === 'others')) notes.push('Others holds the lines outside the six groups (bedlines, carpets, diffusers …) so the total still ties to the orders.');
  return notes;
};
