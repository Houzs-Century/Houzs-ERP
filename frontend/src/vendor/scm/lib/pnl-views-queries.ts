// ----------------------------------------------------------------------------
// pnl-views-queries — the Overall P&L's views side by side (owner 2026-11-25:
// 一张表并排): GET /accounting/reports/pnl-views, the range's whole months, the
// P&L (Actual: the books), the Performance P&L (by sales order) and the
// Forecast P&L, each laid on the P&L's own tree, so a row is the same row in
// every column. Server: backend/src/scm/routes/accounting-pnl-views.ts over
// acc/pnl-views.ts. Money in sen. By month (owner 2026-11-25: 可以by month
// 显示两份以上吗？) reads it once per period — the Total, then each month — as
// the P&L's own By month reads its endpoint once per column.
// ----------------------------------------------------------------------------

import { useQueries } from '@tanstack/react-query';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import { authedFetch } from './authed-fetch';
import type { LaidNode } from './report-layout';

/** One view on the P&L's tree — what report-monthly's pnlLines prints from. */
export type PnlViewSide = {
  layout: { baseSen: number | null; tradingIncome: LaidNode[]; costOfSales: LaidNode[]; otherIncome: LaidNode[]; expenses: LaidNode[]; taxation: LaidNode[] };
  /** The taxation lines: the block prints only when there are some. */
  taxation: Array<{ code: string; name: string; amountSen: number }>;
  totals: {
    tradingIncomeSen: number; costOfSalesSen: number; grossProfitSen: number; otherIncomeSen: number;
    expensesSen: number; profitBeforeTaxSen: number; taxationSen: number; netProfitSen: number;
  };
};

export type PnlViewsPayload = {
  from: string; to: string;
  /** The months the views cover, YYYY-MM. */
  months: string[];
  actual: PnlViewSide;
  performance: PnlViewSide;
  /** Null when none of the months has a forecast. */
  forecast: PnlViewSide | null;
};

export const pnlViewsPath = (from: string, to: string): string =>
  `/accounting/reports/pnl-views?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

/** The views for each period, a read each; `data` in the periods' order, complete once every read is in. */
export function usePnlViews(periods: ReadonlyArray<{ from: string; to: string }>, enabled: boolean) {
  const results = useQueries({
    queries: periods.map((p) => ({
      queryKey: ['report-pnl-views', p.from, p.to],
      queryFn: () => authedFetch<PnlViewsPayload>(pnlViewsPath(p.from, p.to)),
      enabled: enabled && Boolean(p.from && p.to),
      staleTime: 30_000,
      retry: retryUnlessClientError,
    })),
  });
  const data = results.map((r) => r.data);
  const error = results.find((r) => r.isError)?.error ?? null;
  return {
    data,
    complete: periods.length > 0 && data.every((d) => d !== undefined),
    loading: results.some((r) => r.isLoading),
    failed: results.filter((r) => r.isError).length,
    error,
  };
}
