/* The Forecast P&L (owner 2026-09-21: 照 P&L 现在那棵树一行一个户口填; 填 %
   反推 amount, 填 amount 反推 %). One read — the grid and its supplier
   figures, the accounts a line may name, the P&L's layout tree and the
   company's suppliers — and one write, the whole grid with its supplier
   figures. The server half is backend/src/scm/routes/accounting-forecast.ts;
   the arithmetic both sides share is vendor/shared/forecast-pnl.ts. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import type { ForecastAccount, ForecastGrid, SupplierGrid } from '../../shared/forecast-pnl';
import type { LayoutItem } from './report-layout';

/** A supplier of the active company: `recent` — the purchase accounts its bills landed on lately. */
export type ForecastSupplier = { id: string; code: string; name: string; active: boolean; recent: string[] };

export type ForecastResponse = {
  months: ForecastGrid;
  suppliers?: SupplierGrid;
  accounts: ForecastAccount[];
  layout: { stored: boolean; blocks: Record<string, LayoutItem[]> };
  supplierList?: ForecastSupplier[];
};

/** What Save sends: the whole grid and its supplier figures. */
export type ForecastSave = { months: ForecastGrid; suppliers: SupplierGrid };

const KEY = 'forecast-pnl';

export const useForecast = () => useQuery({
  queryKey: [KEY],
  queryFn: () => authedFetch<ForecastResponse>('/accounting/forecast'),
  staleTime: 0,
  retry: retryUnlessClientError,
});

/** PUT the whole grid: every month sent is kept as sent, with its supplier figures; every month absent is removed. */
export const useSaveForecast = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ForecastSave) =>
      authedFetch<{ ok: boolean; months: ForecastGrid; suppliers: SupplierGrid; removed: string[] }>('/accounting/forecast', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [KEY] });
      void qc.invalidateQueries({ queryKey: ['finance-dashboard'] });
      void qc.invalidateQueries({ queryKey: ['report-rp-forecast'] });
    },
  });
};
