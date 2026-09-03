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
  /** AutoCount's special-account column (0347). SDC/SCC/SBS are CONTROL
      accounts — pickers hide them, the server refuses them (由模块自动过账). */
  special_type?: string | null;
};

/* The CONTROL specials — AR (SDC), AP + customer deposits (SCC), stock (SBS).
   ONE frontend home on purpose; the server's requireLeafAccount holds the
   enforcing copy (a browser cannot import the Worker's), and this one only
   decides what the pickers and the Chart page SHOW. */
export const isControlSpecial = (special: string | null | undefined): boolean =>
  special === 'SDC' || special === 'SCC' || special === 'SBS';
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
  special: string | null;
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
  parentCode: string | null; accMoney: boolean; specialType?: string | null; shared: boolean;
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

/* ONE door to open an account (owner 2026-09-03: 照理说应该维护 overall
   chart of account 罢了): the definition is created once and lands in every
   ticked company, parent chain riding along per company. */
export const useChartCreate = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      code: string; name: string; accountType: string;
      parentCode?: string | null; accMoney?: boolean; companyIds?: number[];
    }) =>
      authedFetch<{ ok: boolean; code: string; companies: number[] }>(
        `/accounting/chart/account`, { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chart-union'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
};

/* 改码全账跟 (owner 2026-09-03): one call, and the GL, vouchers, settlement
   config and role bindings all carry the new code — or the database refuses
   and NOTHING moved. The refusal sentence comes back verbatim for the dialog. */
export const useChartRename = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { oldCode: string; newCode: string }) =>
      authedFetch<{ ok: boolean; moved: Record<string, number> }>(
        `/accounting/chart/rename`, { method: 'PUT', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chart-union'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
};

export const useChartUpdate = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { code: string; name?: string; accountType?: string; accMoney?: boolean }) =>
      authedFetch<{ ok: boolean; companies: number }>(
        `/accounting/chart/update`, { method: 'PUT', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chart-union'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
};

/* Only a NEVER-used code deletes; anything referenced comes back as a 409
   naming the holdouts — the page shows that sentence and offers the tick
   column instead. */
export const useChartDelete = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) =>
      authedFetch<{ ok: boolean; companies: number }>(
        `/accounting/chart/account?code=${encodeURIComponent(code)}`, { method: 'DELETE' },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chart-union'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
};

/* ── Other Debtors (owner 2026-09-03) ───────────────────────────────────────
   Counterparty registry + Debtor Bills (post directly) + Receipts (the PV's
   four layers, AP-Payment-style knock-off, partial included). The GL keeps
   one control (305-0000); per-party truth lives in these tables. */
export type OtherDebtor = {
  id: string; name: string; phone: string | null; notes: string | null;
  is_active: boolean; outstanding_sen: number;
};
export type DebtorBill = {
  id: string; bill_number: string; bill_date: string;
  total_sen: number; received_sen: number; status: string; notes: string | null;
};
export type DebtorReceipt = {
  id: string; receipt_number: string; receipt_date: string;
  bank_account_code: string; total_sen: number; status: string;
  submitted_at: string | null; submitted_by: string | null;
  checked_at: string | null; checked_by: string | null;
  approved_at: string | null; approved_by: string | null;
  posted_at: string | null; notes: string | null;
};

export const useOtherDebtors = () => baseQuery<{ debtors: OtherDebtor[] }>(
  ['other-debtors'], `/other-debtors`,
);
export const useDebtorDetail = (id: string | null) => useQuery({
  queryKey: ['other-debtor-detail', id],
  queryFn: () => authedFetch<{ debtor: OtherDebtor; bills: DebtorBill[]; receipts: DebtorReceipt[] }>(`/other-debtors/${id}`),
  enabled: !!id,
});

const invalidateDebtors = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['other-debtors'] });
  void qc.invalidateQueries({ queryKey: ['other-debtor-detail'] });
};

export const useCreateDebtor = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; phone?: string; notes?: string }) =>
      authedFetch<{ ok: boolean; debtor: { id: string } }>(`/other-debtors`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => invalidateDebtors(qc),
  });
};
export const useUpdateDebtor = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; phone?: string; notes?: string; isActive?: boolean }) =>
      authedFetch(`/other-debtors/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => invalidateDebtors(qc),
  });
};
export const useCreateDebtorBill = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ debtorId, ...body }: {
      debtorId: string; billDate?: string; notes?: string;
      lines: Array<{ description?: string; creditAccountCode: string; amountSen: number }>;
    }) => authedFetch<{ ok: boolean; bill: { billNumber: string; totalSen: number } }>(
      `/other-debtors/${debtorId}/bills`, { method: 'POST', body: JSON.stringify(body) },
    ),
    onSuccess: () => invalidateDebtors(qc),
  });
};
export const useCancelDebtorBill = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (billId: string) =>
      authedFetch(`/other-debtors/bills/${billId}/cancel`, { method: 'POST' }),
    onSuccess: () => invalidateDebtors(qc),
  });
};
export const useCreateDebtorReceipt = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ debtorId, ...body }: {
      debtorId: string; receiptDate?: string; bankAccountCode: string; notes?: string;
      allocations: Array<{ billId: string; amountSen: number }>;
    }) => authedFetch<{ ok: boolean; receipt: { receiptNumber: string } }>(
      `/other-debtors/${debtorId}/receipts`, { method: 'POST', body: JSON.stringify(body) },
    ),
    onSuccess: () => invalidateDebtors(qc),
  });
};
/* One hook, five doors — the receipt's four-layer actions mirror the PV's. */
export const useDebtorReceiptAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ receiptId, action, note }: {
      receiptId: string; action: 'submit' | 'withdraw' | 'check' | 'reject' | 'approve'; note?: string;
    }) => authedFetch(`/other-debtors/receipts/${receiptId}/${action}`, {
      method: 'POST', body: JSON.stringify(note ? { note } : {}),
    }),
    onSuccess: () => invalidateDebtors(qc),
  });
};
