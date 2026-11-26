import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type BsForecast<R> = {
  start: string;
  currentMonth: string;
  months: Array<{ month: string; report: R }>;
  accrual: { code: string; name: string } | null;
  receipts: { orders: number; sen: number; capSen: number; countedSen: number };
};

export const useBalanceSheetForecast = <R,>(enabled: boolean) => useQuery({
  queryKey: ['report-bs-forecast'],
  queryFn: () => authedFetch<BsForecast<R>>('/accounting/reports/balance-sheet-forecast'),
  enabled,
  staleTime: 30_000,
  retry: retryUnlessClientError,
});
