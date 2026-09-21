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
import { fmtDateOrDash, fmtSenPlain } from '../../shared/format';
import { flattenLaid, type LaidNode } from './report-layout';

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
  /** The account part on the report's layout (docs/bugs/0912): the other
      income and the expenses as trees, the computed operating expense
      standing where the account it replaces sits, % of sales on every line. */
  layout: { stored: boolean; baseSen: number | null; otherIncome: LaidNode[]; expenses: LaidNode[] };
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

/** 1,234.56 with a bracketed negative — the Finance reports' one money dress (fmtSenPlain). */
export const fmtPerf = (sen: number): string => fmtSenPlain(sen);
export const fmtPerfPct = (pct: number | null): string => (pct == null ? '—' : `${pct.toFixed(1)}%`);
const ratePct = (bp: number): string => `${(bp / 100).toFixed(2)}%`;

/** A line under the groups: its amount, that amount as a % of sales (null
    when there were no sales), and how deep it sits on the report's tree —
    0 for the fixed lines (gross profit, the totals, net), 1 and deeper for
    the categories and accounts of the layout. */
export type PerformanceSummaryLine = { id: string; kind: 'total' | 'category' | 'row' | 'net'; label: string; amountSen: number; pct: number | null; depth: number; code?: string };

/** The lines under the groups — gross profit, the other income on its tree,
    the expenses on theirs (the computed operating expense standing where
    the account it replaces sits, under its own sentence), net.

    SIGNS (owner 2026-09-14, docs/bugs/0910: expense 可以不用（）吗？因为本身就是
    费用，除非他当月是 ct 大过 debit 才（）): an expense is the positive figure it
    is — no parentheses — and only a line whose credits beat its debits in the
    period (a reversal) is negative and prints in them; a loss is a negative
    net and reads the same way. Every line carries its % of sales, so the
    screen can set it under the GP % column (percentage 也是).

    LEVELS (docs/bugs/0912): the trees come flattened with each line's depth,
    so the screen folds them by level and the CSV and the PDF indent them —
    one list for the three. */
export const performanceSummaryLines = (r: PerformanceReport): PerformanceSummaryLine[] => {
  const ofSales = (sen: number): number | null => (r.totals.salesSen > 0 ? Math.round((sen / r.totals.salesSen) * 1000) / 10 : null);
  const tree = (nodes: LaidNode[]): PerformanceSummaryLine[] =>
    flattenLaid(nodes).map(({ node, depth }) => ({ id: node.id, kind: node.kind === 'account' ? 'row' : 'category', label: node.label, amountSen: node.amountSen, pct: node.pct, depth, ...(node.code ? { code: node.code } : {}) }));
  const expensesSen = r.operatingExpense.amountSen + r.otherExpensesSen;
  return [
    { id: 'sum:gross', kind: 'total', label: 'Gross profit', amountSen: r.totals.gpSen, pct: r.totals.gpPct, depth: 0 },
    ...tree(r.layout.otherIncome),
    { id: 'sum:otherIncome', kind: 'total', label: 'Total other income (as booked)', amountSen: r.otherIncomeSen, pct: ofSales(r.otherIncomeSen), depth: 0 },
    ...tree(r.layout.expenses),
    { id: 'sum:expenses', kind: 'total', label: `Total expenses (operating expense at ${ratePct(r.operatingExpense.rateBp)} + as booked)`, amountSen: expensesSen, pct: ofSales(expensesSen), depth: 0 },
    { id: 'sum:net', kind: 'net', label: 'NET PERFORMANCE', amountSen: r.netSen, pct: r.netPct, depth: 0 },
  ];
};

/** The lines a level shows: a line prints while its depth is within the
    level — a category at the level keeps its subtotal, its rows fold away. */
export const summaryLinesAtLevel = (lines: PerformanceSummaryLine[], level: number | 'all'): PerformanceSummaryLine[] =>
  level === 'all' ? lines : lines.filter((l) => l.depth <= level);

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
