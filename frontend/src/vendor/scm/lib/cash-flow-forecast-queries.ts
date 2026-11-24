/* The Cash Flow's P&L forecast column (step 2 of the forecast port): the
   Forecast P&L as cash, each month a Cash Flow report of its own on the same
   tree, from GET /accounting/reports/cash-flow-forecast (server half:
   backend/src/scm/routes/accounting-cashflow-forecast.ts). */
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import type { RpReport } from './rp-report-queries';

export type CashFlowForecast = {
  from: string; to: string; currentMonth: string;
  /** The range's months, then — when it reaches the current month — the later months the money reaches. */
  months: Array<{ month: string; future: boolean; report: RpReport }>;
  /** What the timings were measured over. */
  measured: { from: string; to: string };
  /** The customers' money by kind and delay after the order month, in % of what came in. */
  receiptMix: Array<{ kind: 'DEP' | 'BAL'; months: number; pct: number }>;
  /** Suppliers counted a month later for want of a usable payment term. */
  flagged: Array<{ id: string; code: string; name: string }>;
  /** Forecast lines left out as moving no cash. */
  nonCash: Array<{ code: string; name: string }>;
};

export const cashFlowForecastPath = (from: string, to: string): string =>
  `/accounting/reports/cash-flow-forecast?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

/** The months from..to (YYYY-MM); off while either is blank. */
export const useCashFlowForecast = (from: string, to: string) => useQuery({
  queryKey: ['report-rp-forecast', from, to],
  queryFn: () => authedFetch<CashFlowForecast>(cashFlowForecastPath(from, to)),
  enabled: Boolean(from && to),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});
