// ----------------------------------------------------------------------------
// opening-balance-queries — Finance › Setup › Opening Balance (owner 2026-10-28:
// 「然后确定一下我是会有一个opening balance maintainence 表是吗？」). The books'
// opening: the account lines, the opening stock per bucket, the creditors and
// other debtors by their opening papers, and the clearing that reads nil when
// it all balances. Server: backend/src/scm/routes/accounting-opening.ts.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type OpeningBucket = 'customer' | 'display' | 'service' | 'showroom' | 'others';
export const OPENING_BUCKETS: ReadonlyArray<[OpeningBucket, string]> = [
  ['customer', 'Customer · 客户货'], ['display', 'Display · 展示'], ['service', 'Service · 维修'], ['showroom', 'Showroom · 门市'], ['others', 'Others · 其他'],
];

export type OpeningPaperKind = 'API' | 'SCN' | 'ODB' | 'ODR';
export type OpeningPaper = {
  id: string; kind: OpeningPaperKind; no: string; partyId: string; date: string; ref: string | null;
  amountSen: number; settledSen: number; status: string; note: string | null;
};
export type OpeningParty = {
  partyId: string; code: string | null; name: string; control?: string;
  /** Bills (what the party owes, or what we owe a supplier) and credits, in sen. */
  owingSen: number; creditSen: number; netSen: number;
  papers: OpeningPaper[];
};
export type OpeningAccount = { code: string; name: string; type: string | null; section: string | null; drSen: number; crSen: number };

export type OpeningBalance =
  | { booksStart: null }
  | {
      booksStart: string;
      openingDate: string;
      locked: { at: string; by: string | null } | null;
      journal: { jeNo: string; date: string } | null;
      accounts: OpeningAccount[];
      stock: { buckets: Partial<Record<OpeningBucket, number>>; totalSen: number; codes: Record<OpeningBucket, string> };
      creditors: OpeningParty[];
      debtors: OpeningParty[];
      check: { clearingCode: string; clearingSen: number };
    };

const KEY = ['opening-balance'];

export const useOpeningBalance = () => useQuery({
  queryKey: KEY,
  queryFn: () => authedFetch<OpeningBalance>('/accounting/opening'),
  staleTime: 15_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

const useOpeningWrite = <V,>(title: string, request: (v: V) => Promise<unknown>) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); },
    onError: writeFailedAs(title),
  });
};

export const useSaveOpeningAccounts = () => useOpeningWrite<Array<{ code: string; drSen: number; crSen: number }>>(
  'Opening accounts not saved',
  (lines) => authedFetch('/accounting/opening/accounts', { method: 'PUT', body: JSON.stringify({ lines }) }),
);

export const useSaveOpeningStock = () => useOpeningWrite<Partial<Record<OpeningBucket, number>>>(
  'Opening stock not saved',
  (buckets) => authedFetch('/accounting/opening/stock', { method: 'PUT', body: JSON.stringify({ buckets }) }),
);

export type NewOpeningPaper = { kind: OpeningPaperKind; partyId: string; date: string; ref?: string | null; amountSen: number; note?: string | null };
export const useCreateOpeningPaper = () => useOpeningWrite<NewOpeningPaper>(
  'Opening paper not added',
  (body) => authedFetch('/accounting/opening/papers', { method: 'POST', body: JSON.stringify(body) }),
);

export const useUpdateOpeningPaper = () => useOpeningWrite<{ kind: OpeningPaperKind; id: string; date?: string; ref?: string | null; amountSen?: number }>(
  'Opening paper not saved',
  ({ kind, id, ...body }) => authedFetch(`/accounting/opening/papers/${kind}/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
);

export const useCancelOpeningPaper = () => useOpeningWrite<{ kind: OpeningPaperKind; id: string }>(
  'Opening paper not cancelled',
  ({ kind, id }) => authedFetch(`/accounting/opening/papers/${kind}/${id}/cancel`, { method: 'POST' }),
);

export const useLockOpening = () => useOpeningWrite<'lock' | 'unlock'>(
  'Opening not changed',
  (what) => authedFetch(`/accounting/opening/${what}`, { method: 'POST' }),
);
