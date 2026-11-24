/* The Forecast Balance Sheet (step 6 of the forecast port): from the last
   month-end's actual sheet, each month from the current one to the last the
   Forecast P&L has figures for, as a Balance Sheet of its own on the same
   layout, from GET /accounting/reports/balance-sheet-forecast (server half:
   backend/src/scm/routes/accounting-cashflow-forecast.ts). */
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type BsForecast<R> = {
  /** The last month-end: the actual sheet the forecast starts from. */
  start: string;
  currentMonth: string;
  months: Array<{ month: string; report: R }>;
  /** The salary accrual the forecast moves, when the chart has one. */
  accrual: { code: string; name: string } | null;
  /** The open orders' balances at the start, and what of them was counted (never beyond the start's debtors). */
  receipts: { orders: number; sen: number; capSen: number; countedSen: number };
};

export const useBalanceSheetForecast = <R,>(enabled: boolean) => useQuery({
  queryKey: ['report-bs-forecast'],
  queryFn: () => authedFetch<BsForecast<R>>('/accounting/reports/balance-sheet-forecast'),
  enabled,
  staleTime: 30_000,
  retry: retryUnlessClientError,
});
