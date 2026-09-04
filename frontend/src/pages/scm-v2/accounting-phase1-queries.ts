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

/** Money recorded on a document that never reached the ledger (acc/payments'
    unbookedPayments). `since` is the derived boundary — the first day this
    company ever booked one — and null means there is no period to check. */
export type UnbookedPayments = {
  since: string | null;
  rows: Array<{ source: 'SOPAY' | 'SIPAY'; id: string; docNo: string; paidOn: string; amountSen: number; method: string }>;
  totalSen: number;
  ok: boolean;
  /** Only when the check itself could not run. */
  error?: string;
};

export const useControlCheck = () => useQuery({
  queryKey: ['control-check'],
  queryFn: () => authedFetch<{ checks: ControlCheckRow[]; payments: UnbookedPayments }>(`/accounting/control-check`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export type DailyBankMovement = { jeNo: string; sourceType: string; sourceDocNo: string | null; note: string; amountSen: number };
export type DailyBankBlock = {
  accountCode: string; accountName: string;
  openingSen: number; inSen: number; outSen: number; closingSen: number;
  receipts: DailyBankMovement[]; payouts: DailyBankMovement[];
};
export type DailyBankBoard = {
  date: string;
  blocks: DailyBankBlock[];
  transit: Array<{ acquirerCode: string; accountCode: string; accountName: string; balanceSen: number }>;
  totalClosingSen: number; totalTransitSen: number; pendingApprovalSen: number; availableSen: number;
  note: string;
};

export const useDailyBank = (date: string) => useQuery({
  queryKey: ['daily-bank', date],
  queryFn: () => authedFetch<DailyBankBoard>(`/accounting/daily-bank?date=${date}`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export type DailyCloseRow = { bucket: string; systemSen: number; countedSen: number | null; diffSen: number | null; status: 'DRAFT' | 'CONFIRMED'; notes: string | null };

export const useDailyClose = (date: string) => useQuery({
  queryKey: ['daily-close', date],
  queryFn: () => authedFetch<{ date: string; rows: DailyCloseRow[] }>(`/accounting/daily-close?date=${date}`),
  staleTime: 15_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useSaveDailyClose = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { date: string; buckets: Array<{ bucket: string; countedSen: number | null; notes?: string | null }> }) =>
      authedFetch<{ ok: boolean }>(`/accounting/daily-close`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (_, v) => { void qc.invalidateQueries({ queryKey: ['daily-close', v.date] }); },
    onError: writeFailedAs('Daily close not saved'),
  });
};

export const useConfirmDailyClose = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { date: string }) =>
      authedFetch<{ ok: boolean; confirmed: number; cashPosting: { status: string; jeNo?: string } | null }>(
        `/accounting/daily-close/confirm`, { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: (_, v) => {
      void qc.invalidateQueries({ queryKey: ['daily-close', v.date] });
      void qc.invalidateQueries({ queryKey: ['daily-bank'] });
      void qc.invalidateQueries({ queryKey: ['account-balances'] });
    },
    onError: writeFailedAs('Daily close not confirmed'),
  });
};

/* ── Item groups — the product-group ↔ ledger-account registry (GL redesign
   item 1). The binding decides which purchase/sales account a document line
   posts to; an unbound group refuses to post, so this screen is where the
   owner keeps the map. ─────────────────────────────────────────────────── */

export type ItemGroupBinding = {
  purchase: string;
  sales: string;
  salesReturn: string;
  purchaseReturn: string;
};

export type ItemGroup = {
  code: string;
  name: string;
  isActive: boolean;
  /** companyId → the four accounts; a missing key means UNBOUND there. */
  bindings: Record<string, ItemGroupBinding>;
};

export const useItemGroups = () => useQuery({
  queryKey: ['item-groups'],
  queryFn: () => authedFetch<{ companies: Array<{ id: number; code: string }>; groups: ItemGroup[] }>(`/accounting/item-groups`),
  staleTime: 15_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useCreateItemGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { code: string; name: string; companyId: number; accounts: ItemGroupBinding }) =>
      authedFetch<{ ok: boolean; code: string }>(`/accounting/item-groups`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['item-groups'] }); },
    onError: writeFailedAs('Group not created'),
  });
};

export const useBindItemGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ code, ...body }: { code: string; companyId: number; accounts: ItemGroupBinding }) =>
      authedFetch<{ ok: boolean }>(`/accounting/item-groups/${encodeURIComponent(code)}/accounts`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['item-groups'] }); },
    onError: writeFailedAs('Binding not saved'),
  });
};

export const usePatchItemGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ code, ...body }: { code: string; name?: string; isActive?: boolean }) =>
      authedFetch<{ ok: boolean }>(`/accounting/item-groups/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['item-groups'] }); },
    onError: writeFailedAs('Group not updated'),
  });
};

/* ── Month-end stock close (GL redesign item 4) — run log + manual run. ──── */

export type StockCloseRun = {
  month: string;
  ran_at: string;
  trigger: string;
  stock_value_sen: number;
  action: 'posted' | 'unchanged' | 'reposted' | 'failed';
  je_no: string | null;
  rev_je_no: string | null;
  note: string | null;
};

export const useStockClose = () => useQuery({
  queryKey: ['stock-close'],
  queryFn: () => authedFetch<{ liveValueSen: number; defaultMonth: string; runs: StockCloseRun[] }>(`/accounting/stock-close`),
  staleTime: 15_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useRunStockClose = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { month?: string }) =>
      authedFetch<{ outcome: { action: string; jeNo?: string; note?: string } }>(`/accounting/stock-close/run`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stock-close'] });
      void qc.invalidateQueries({ queryKey: ['journal-entries'] });
      void qc.invalidateQueries({ queryKey: ['gl-entries'] });
      void qc.invalidateQueries({ queryKey: ['account-balances'] });
    },
    onError: writeFailedAs('Month-end run failed'),
  });
};
