// Vendored SLICE of apps/backend/src/lib/flow-queries.ts — the Accounting
// surface (chart of accounts, journal entries, GL, balances, AR/AP aging) the
// Accounting page reads. Copied verbatim; all reads go through the vendored
// authedFetch (→ /api/scm/accounting…). The source module's verified-save /
// supabase / serviceNotify imports are NOT needed here and are left out. The
// `baseQuery` factory is inlined (the source defines it once at module scope).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

// baseQuery is a custom-hook factory — only ever called from use* hooks below.
// eslint-disable-next-line react-hooks/rules-of-hooks
const baseQuery = <T>(key: string[], path: string) => useQuery({
  queryKey: key,
  queryFn: () => authedFetch<T>(path),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export type Account = {
  account_code: string;
  account_name: string;
  account_type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
  parent_code: string | null;
  is_active: boolean;
  /** True for the money set (bank / cash / e-wallet — what Daily Bank shows).
      The PV "Paid From" picker offers only these. */
  acc_money?: boolean | null;
};
export const useAccounts = () => baseQuery<{ accounts: Account[] }>(
  ['accounts'], `/accounting/accounts`,
);

/* Which account plays which part for the ACTIVE company (resolveRoles server-
   side: overrides first, seeded defaults where nothing is set). BANK_DEFAULT
   pre-fills the PV "Paid From"; AP is the control account an AP Payment
   debits. */
export type AccountRoles = { roles: Record<string, string>; overridden: Record<string, string> };
export const useAccountRoles = () => baseQuery<AccountRoles>(
  ['account-roles'], `/accounting/roles`,
);

/* The owner's own lever (默认银行我可以自己maintenance): repoint BANK_DEFAULT to
   another money account. The server refuses non-money / inactive / other-
   company accounts by name. */
export const useSaveBankDefault = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountCode: string) => authedFetch<{ ok: boolean; accountCode: string }>(
      `/accounting/roles/BANK_DEFAULT`,
      { method: 'PUT', body: JSON.stringify({ accountCode }) },
    ),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['account-roles'] }); },
    onError: writeFailedAs('Default bank not saved'),
  });
};

export type JournalEntry = {
  id: string;
  je_no: string;
  entry_date: string;
  source_type: string;
  source_doc_no: string | null;
  narration: string | null;
  total_debit_sen: number;
  total_credit_sen: number;
  posted: boolean;
  posted_at: string | null;
  reversed: boolean;
  created_at: string;
};
export type JournalEntryLine = {
  id: string;
  journal_entry_id: string;
  line_no: number;
  account_code: string;
  debit_sen: number;
  credit_sen: number;
  party_type: string | null;
  party_code: string | null;
  party_name: string | null;
  notes: string | null;
};
export const useJournalEntries = (filters?: {
  sourceType?: string; sourceDocNo?: string; from?: string; to?: string; posted?: boolean;
}) => {
  const params = new URLSearchParams();
  if (filters?.sourceType)  params.set('sourceType',  filters.sourceType);
  if (filters?.sourceDocNo) params.set('sourceDocNo', filters.sourceDocNo);
  if (filters?.from)        params.set('from',        filters.from);
  if (filters?.to)          params.set('to',          filters.to);
  if (filters?.posted != null) params.set('posted', String(filters.posted));
  const qs = params.toString();
  return baseQuery<{ journalEntries: JournalEntry[] }>(
    ['journal-entries', qs],
    `/accounting/journal-entries${qs ? `?${qs}` : ''}`,
  );
};
export const useJournalEntryDetail = (id: string | null) => useQuery({
  queryKey: ['journal-entry-detail', id],
  queryFn: () => authedFetch<{ journalEntry: JournalEntry; lines: JournalEntryLine[] }>(`/accounting/journal-entries/${id}`),
  enabled: Boolean(id),
  staleTime: 30_000,
});

export type JeLineIn = {
  accountCode: string;
  debitSen?: number;
  creditSen?: number;
  partyType?: string | null;
  partyCode?: string | null;
  partyName?: string | null;
  notes?: string | null;
};
export const useCreateJournalEntry = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      entryDate?: string;
      sourceType?: string;
      sourceDocNo?: string | null;
      narration?: string | null;
      lines: JeLineIn[];
    }) => authedFetch<{ journalEntry: JournalEntry; lineCount: number }>(
      `/accounting/journal-entries`, { method: 'POST', body: JSON.stringify(body) },
    ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      qc.invalidateQueries({ queryKey: ['account-balances'] });
    },
    onError: writeFailedAs('Journal entry not created'),
  });
};

export const usePostJournalEntry = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ journalEntry: JournalEntry }>(
      `/accounting/journal-entries/${id}/post`, { method: 'POST' },
    ),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      qc.invalidateQueries({ queryKey: ['journal-entry-detail', id] });
      qc.invalidateQueries({ queryKey: ['gl-entries'] });
      qc.invalidateQueries({ queryKey: ['account-balances'] });
    },
    onError: writeFailedAs('Journal entry not posted'),
  });
};

export type GlEntry = {
  line_id: string;
  je_no: string;
  entry_date: string;
  source_type: string;
  source_doc_no: string | null;
  line_no: number;
  account_code: string;
  account_name: string;
  account_type: string;
  debit_sen: number;
  credit_sen: number;
  party_type: string | null;
  party_code: string | null;
  party_name: string | null;
  notes: string | null;
  posted: boolean;
  posted_at: string | null;
};
export const useGlEntries = (filters?: { accountCode?: string; from?: string; to?: string }) => {
  const params = new URLSearchParams();
  if (filters?.accountCode) params.set('accountCode', filters.accountCode);
  if (filters?.from)        params.set('from',        filters.from);
  if (filters?.to)          params.set('to',          filters.to);
  const qs = params.toString();
  return baseQuery<{ glEntries: GlEntry[] }>(
    ['gl-entries', qs],
    `/accounting/gl${qs ? `?${qs}` : ''}`,
  );
};

export type AccountBalance = {
  account_code: string;
  account_name: string;
  account_type: string;
  total_debit_sen: number;
  total_credit_sen: number;
  balance_sen: number;
};
export const useAccountBalances = () => baseQuery<{ balances: AccountBalance[] }>(
  ['account-balances'], `/accounting/balances`,
);

export type ArAgingRow = {
  invoice_id: string;
  invoice_number: string;
  debtor_code: string | null;
  debtor_name: string;
  invoice_date: string;
  due_date: string | null;
  total_sen: number;
  paid_sen: number;
  outstanding_sen: number;
  days_overdue: number;
  aging_bucket: 'CURRENT' | '1-30' | '31-60' | '61-90' | '90+';
  status: string;
};
export const useArAging = () => baseQuery<{ arAging: ArAgingRow[] }>(
  ['ar-aging'], `/accounting/ar-aging`,
);

export type ApAgingRow = {
  invoice_id: string;
  invoice_number: string;
  supplier_invoice_ref: string | null;
  supplier_id: string;
  supplier_code: string | null;
  supplier_name: string | null;
  invoice_date: string;
  due_date: string | null;
  total_sen: number;
  paid_sen: number;
  outstanding_sen: number;
  days_overdue: number;
  aging_bucket: 'CURRENT' | '1-30' | '31-60' | '61-90' | '90+';
  status: string;
};
export const useApAging = () => baseQuery<{ apAging: ApAgingRow[] }>(
  ['ap-aging'], `/accounting/ap-aging`,
);

/* ── The Chart of Accounts maintenance surface (roadmap A, 2026-09-03) ──────
   The owner's selective sharing: one union across the granted companies, a
   tick per company per code, and the accountant's xlsx upserted whole. */
export type ChartCompany = { id: number; code: string };
export type ChartRow = {
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
  parentCode: string | null;
  accMoney: boolean;
  perCompany: Partial<Record<number, { active: boolean }>>;
};
export const useChartUnion = () => baseQuery<{ companies: ChartCompany[]; accounts: ChartRow[] }>(
  ['chart-union'], `/accounting/chart`,
);

export const useChartTick = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { companyId: number; code: string; active: boolean }) =>
      authedFetch(`/accounting/chart/tick`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chart-union'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
};

export type ChartImportRow = {
  code: string; name: string; accountType: string;
  parentCode: string | null; accMoney: boolean; shared: boolean;
};
export const useChartImport = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { companyId: number; rows: ChartImportRow[] }) =>
      authedFetch<{ ok: boolean; imported: number; shared: number; sharedTo: number[] }>(
        `/accounting/chart/import`, { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chart-union'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
};
