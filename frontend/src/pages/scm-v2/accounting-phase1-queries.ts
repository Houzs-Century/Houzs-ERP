// Accounting phase 1 — the hooks the vendored accounting-queries slice does
// not carry (that file is a verbatim vendor copy; module-owned additions live
// here instead): chart management, manual-JV reversal, and the layer-1
// control-account self-check.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { writeFailedAs } from '../../vendor/scm/lib/mutation-error';
import { retryUnlessClientError } from '../../lib/retryPolicy';
import type { Account } from '../../vendor/scm/lib/accounting-queries';

export const useCreateAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { accountCode: string; accountName: string; accountType: string; parentCode?: string | null }) =>
      authedFetch<{ account: Account }>(`/accounting/accounts`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
    onError: writeFailedAs('Account not created'),
  });
};

export const useUpdateAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ code, ...body }: { code: string; accountName?: string; parentCode?: string | null; isActive?: boolean }) =>
      authedFetch<{ account: Account }>(`/accounting/accounts/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
    onError: writeFailedAs('Account not updated'),
  });
};

export const useReverseJournalEntry = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ ok: boolean; jeNo?: string; status: string }>(`/accounting/journal-entries/${id}/reverse`, { method: 'POST' }),
    onSuccess: (_, id) => {
      void qc.invalidateQueries({ queryKey: ['journal-entries'] });
      void qc.invalidateQueries({ queryKey: ['journal-entry-detail', id] });
      void qc.invalidateQueries({ queryKey: ['gl-entries'] });
      void qc.invalidateQueries({ queryKey: ['account-balances'] });
      void qc.invalidateQueries({ queryKey: ['control-check'] });
    },
    onError: writeFailedAs('Journal entry not reversed'),
  });
};

export type ControlDrift = { docNo: string; docTotalSen: number; jeTotalSen: number; diffSen: number; note: string };
export type ControlForeign = { jeNo: string; sourceType: string; debitSen: number; creditSen: number };
export type ControlCheckRow =
  | { role: string; accountCode: string; glBalanceSen: number; driftDocs: ControlDrift[]; foreignLines: ControlForeign[]; ok: boolean }
  | { role: string; accountCode: string; error: string };

export const useControlCheck = () => useQuery({
  queryKey: ['control-check'],
  queryFn: () => authedFetch<{ checks: ControlCheckRow[] }>(`/accounting/control-check`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});
