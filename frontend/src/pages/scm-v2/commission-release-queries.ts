/* Books › Commission release (owner 2026-11-25): what PREPAYMENT COMMISSION
   holds bill by bill, what each month releases to the commission expense as
   the bills' orders become sales, what is booked, every run, and one bill's
   orders. The server half is backend/src/scm/routes/accounting-commission-release.ts
   over acc/commission-release.ts; see docs/modules/accounting.md. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { writeFailedAs } from '../../vendor/scm/lib/mutation-error';
import { retryUnlessClientError } from '../../lib/retryPolicy';

export type ReleaseLayer = {
  key: string;
  month: string | null;
  amountSen: number;
  docs: string[];
  basis: 'close' | 'goods' | 'none';
  orders: number;
  fromMonth: string;
  byMonth: Array<{ month: string; sen: number }>;
  releasedSen: number;
  leftSen: number;
  note: string | null;
};

export type ReleaseMonth = { month: string; totalSen: number; parts: Array<{ key: string; sen: number }> };
export type PostedReleaseMonth = { month: string; jeNo: string; releasedSen: number; reposted: boolean; bookedOn: string | null };
export type ReleaseRun = {
  month: string; ran_at: string; trigger: 'cron' | 'manual'; released_sen: number;
  action: 'posted' | 'reposted' | 'cleared' | 'unchanged' | 'failed'; je_no: string | null; note: string | null;
};
export type PrepaidLine = {
  month: string | null; amountSen: number; docNo: string; jeNo: string; entryDate: string;
  sourceType: string; notes: string | null; monthGuessed: boolean;
};

export type CommissionReleaseStatus = {
  on: boolean;
  booksStart: string;
  currentMonth: string;
  lastMonth: string;
  accounts: { prepaid: { code: string; name: string | null }; expense: { code: string; name: string | null } };
  prepaid: PrepaidLine[];
  layers: ReleaseLayer[];
  months: ReleaseMonth[];
  posted: PostedReleaseMonth[];
  runs: ReleaseRun[];
};

export type LayerOrder = {
  docNo: string; soDate: string | null; status: string; totalSen: number;
  shareSen: number; sold: number; releasedSen: number; leftSen: number;
};

const KEY = 'commission-release';

export const useCommissionRelease = () => useQuery({
  queryKey: [KEY],
  queryFn: () => authedFetch<CommissionReleaseStatus>('/accounting/commission-release'),
  staleTime: 15_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useCommissionReleaseOrders = (layer: string | null) => useQuery({
  queryKey: [KEY, 'orders', layer],
  queryFn: () => authedFetch<{ layer: string; through: string; orders: LayerOrder[] }>(`/accounting/commission-release/orders?layer=${encodeURIComponent(layer ?? '')}`),
  enabled: Boolean(layer),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

type Outcome = { month: string; action: ReleaseRun['action']; releasedSen: number; jeNo?: string; note?: string };

const invalidateBooks = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: [KEY] });
  void qc.invalidateQueries({ queryKey: ['journal-entries'] });
  void qc.invalidateQueries({ queryKey: ['gl-entries'] });
  void qc.invalidateQueries({ queryKey: ['account-balances'] });
  void qc.invalidateQueries({ queryKey: ['report-performance'] });
};

export const useRunCommissionRelease = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => authedFetch<{ outcomes: Outcome[] }>('/accounting/commission-release/run', { method: 'POST', body: '{}' }),
    onSuccess: () => invalidateBooks(qc),
    onError: writeFailedAs('Commission release run failed'),
  });
};

export const useCommissionReleaseSwitch = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (on: boolean) =>
      authedFetch<{ ok: boolean; on: boolean; outcomes: Outcome[] }>('/accounting/commission-release/settings', { method: 'POST', body: JSON.stringify({ on }) }),
    onSuccess: () => invalidateBooks(qc),
    onError: writeFailedAs('Commission release switch not saved'),
  });
};
