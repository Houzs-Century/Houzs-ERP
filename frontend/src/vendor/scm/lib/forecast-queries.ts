/* The Forecast P&L (owner 2026-09-21: 照 P&L 现在那棵树一行一个户口填; 填 %
   反推 amount, 填 amount 反推 %). One read — the grid, the accounts a line
   may name and the P&L's layout tree — and one write, the whole grid. The
   server half is backend/src/scm/routes/accounting-forecast.ts; the
   arithmetic both sides share is vendor/shared/forecast-pnl.ts. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import type { ForecastAccount, ForecastGrid } from '../../shared/forecast-pnl';
import type { LayoutItem } from './report-layout';

export type ForecastResponse = {
  months: ForecastGrid;
  accounts: ForecastAccount[];
  layout: { stored: boolean; blocks: Record<string, LayoutItem[]> };
};

const KEY = 'forecast-pnl';

export const useForecast = () => useQuery({
  queryKey: [KEY],
  queryFn: () => authedFetch<ForecastResponse>('/accounting/forecast'),
  staleTime: 0,
  retry: retryUnlessClientError,
});

/** PUT the whole grid: every month sent is kept as sent, every month absent is removed. */
export const useSaveForecast = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (months: ForecastGrid) =>
      authedFetch<{ ok: boolean; months: string[]; removed: string[] }>('/accounting/forecast', { method: 'PUT', body: JSON.stringify({ months }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [KEY] });
      void qc.invalidateQueries({ queryKey: ['finance-dashboard'] });
    },
  });
};
