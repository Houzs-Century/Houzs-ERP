
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { writeFailedAs } from '../../vendor/scm/lib/mutation-error';
import { retryUnlessClientError } from '../../lib/retryPolicy';
import type { Account, JeLineIn, JournalEntry, JournalEntryLine } from '../../vendor/scm/lib/accounting-queries';

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

/** A manual journal edited in one step (owner 2026-09-15: 我无法 edit). A
    posted entry comes back under a NEW number with `replaced` naming the old
    one and the contra that reversed it; a draft is rewritten in place and
    `replaced` is null. */
export type JournalEntryEdited = {
  journalEntry: JournalEntry;
  lineCount: number;
  replaced: { originalJeNo: string; originalJeId: string; contraJeNo: string | null } | null;
};
export const useEditJournalEntry = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; entryDate?: string; narration?: string | null; lines: JeLineIn[] }) =>
      authedFetch<JournalEntryEdited>(`/accounting/journal-entries/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (_, { id }) => {
      void qc.invalidateQueries({ queryKey: ['journal-entries'] });
      void qc.invalidateQueries({ queryKey: ['journal-entry-detail', id] });
      void qc.invalidateQueries({ queryKey: ['gl-entries'] });
      void qc.invalidateQueries({ queryKey: ['account-balances'] });
      void qc.invalidateQueries({ queryKey: ['control-check'] });
    },
    onError: writeFailedAs('Journal entry not edited'),
  });
};

/** The document an entry was written from, read back to the id its page opens
    by (backend acc/journal-document) — the card's "Open <document>". */
export type JournalDocument = { kind: 'SI' | 'SO' | 'PI' | 'API' | 'PV' | 'NOTE' | 'SUPPLIER_NOTE'; id: string; number: string };
export type JournalEntryCardData = {
  journalEntry: JournalEntry;
  lines: JournalEntryLine[];
  document?: JournalDocument | null;
  documentError?: string;
};
/** One entry for its card — the detail read the post / edit / reverse hooks
    already refresh (same key), with the entry's document beside it. */
export const useJournalEntryCard = (id: string | null) => useQuery({
  queryKey: ['journal-entry-detail', id],
  queryFn: () => authedFetch<JournalEntryCardData>(`/accounting/journal-entries/${id}`),
  enabled: Boolean(id),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

/** The Journal page grouped per entry (docs/bugs/0935): every entry of the
    period with its lines in order and the references the GL page prints. */
export type JournalLineLite = { line_no: number; account_code: string; debit_sen: number; credit_sen: number; party_name: string | null; notes: string | null };
export type JournalEntryGrouped = JournalEntry & {
  journal_class: string;
  lines: JournalLineLite[];
  doc: string | null;
  doc2: string | null;
  who: string | null;
  reference: string | null;
};
export type JournalGroupedFilters = { from: string; to: string; sourceType?: string };
export const useJournalEntriesGrouped = (f: JournalGroupedFilters, enabled = true) => {
  const params = new URLSearchParams({ withLines: '1', from: f.from, to: f.to });
  if (f.sourceType) params.set('sourceType', f.sourceType);
  const qs = params.toString();
  return useQuery({
    queryKey: ['journal-entries', 'grouped', qs],
    queryFn: () => authedFetch<{ journalEntries: JournalEntryGrouped[] }>(`/accounting/journal-entries?${qs}`),
    enabled: enabled && Boolean(f.from && f.to),
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
};

export type ControlDrift = {
  docNo: string; docTotalSen: number; jeTotalSen: number; diffSen: number; note: string;
  party?: string | null; date?: string | null; jeNo?: string | null;
  docKind?: 'SI' | 'PI' | 'API' | null; docId?: string | null;
};
export type ControlForeign = { jeNo: string; sourceType: string; debitSen: number; creditSen: number };
export type ControlCheckRow =
  | { role: string; accountCode: string; glBalanceSen: number; driftDocs: ControlDrift[]; foreignLines: ControlForeign[]; ok: boolean }
  | { role: string; accountCode: string; error: string };

/** Money recorded on a document that never reached the ledger (acc/payments'
    unbookedPayments). `since` is the derived boundary — the first day this
    company ever booked one — and null means there is no period to check. */
export type UnbookedPayments = {
  since: string | null;
  rows: Array<{
    source: 'SOPAY' | 'SIPAY'; id: string; docNo: string; paidOn: string; amountSen: number; method: string;
    customer?: string | null; salesperson?: string | null;
  }>;
  totalSen: number;
  ok: boolean;
  error?: string;
  /** When NOTHING has ever booked (since = null): what the payment tables hold
      anyway — the money the hook should have moved (docs/bugs/0652). */
  neverBooked?: { count: number; totalSen: number; firstPaidOn: string | null; lastPaidOn: string | null };
};

/** The Self-check card's "Why?" — the backfill endpoint in dry-run mode: each
    unbooked payment through the gate's own checks, verdict and reason back,
    nothing written (docs/bugs/0652). */
export type PaymentDryRunRow = { id: string; docNo: string; paidOn: string; method: string; amountSen: number; status: string; reason?: string };
export type PaymentDryRun = {
  ok: boolean; dryRun: boolean; scanned: number; posted: number; wouldPost: number; skipped: number;
  failed: Array<{ id: string; status: string; reason?: string }>; rows: PaymentDryRunRow[]; remaining: number;
};
export const usePaymentBookingDryRun = () => useMutation({
  mutationFn: () => authedFetch<PaymentDryRun>('/accounting/backfill/customer-payments', {
    method: 'POST', body: JSON.stringify({ dryRun: true, limit: 500 }),
  }),
});

/** A payment that reached the ledger and then stopped agreeing with it. The
    PATCH that edits a payment never re-posts, so an edited row leaves its
    entry behind; `fields` names what moved (amount / date / method), and both
    sides are carried so the difference can be read without opening the entry.
    A changed acquirer is NOT in here — that lives in the entry's lines. */
export type PaymentDriftRow = {
  source: 'SOPAY' | 'SIPAY';
  id: string;
  docNo: string;
  jeNo: string;
  fields: Array<'amount' | 'date' | 'method'>;
  paymentAmountSen: number;
  entryAmountSen: number;
  paidOn: string;
  entryDate: string;
  paymentMethod: string;
  entryMethod: string | null;
};
export type PaymentDrift = {
  rows: PaymentDriftRow[];
  scanned: number;
  ok: boolean;
  error?: string;
};

/** The Finance report of every payment action made on the correction right
    (docs/bugs/0785; widened to adds, deletes and proof attaches by a role
    holding the right, docs/bugs/0888): a filtered read of the SO audit log,
    one row per action, with the reason typed at the time, who first recorded
    the payment, and what it did to the ledger. */
export type PaymentCorrectionRow = {
  id: string;
  at: string;
  by: string;
  docNo: string;
  customer: string | null;
  kind: 'added' | 'edited' | 'deleted' | 'proof';
  changes: Array<{ field: string; from: unknown; to: unknown }>;
  amountFromSen: number | null;
  amountToSen: number | null;
  reason: string;
  /** No reason because the row predates the rule (owner 2026-09-14: 规则之前). */
  beforeRule: boolean;
  recordedBy: string | null;
  recordedOn: string | null;
  originalJeNo: string | null;
  contraJeNo: string | null;
  jeNo: string | null;
};
export type PaymentCorrections = {
  month: string;
  rows: PaymentCorrectionRow[];
  summary: {
    corrections: number; added: number; edited: number; deleted: number; proof: number;
    netMovedSen: number; addedSen: number; deletedSen: number;
  };
};
export const usePaymentCorrections = (month: string) => useQuery({
  queryKey: ['payment-corrections', month],
  queryFn: () => authedFetch<PaymentCorrections>(`/accounting/payment-corrections?month=${encodeURIComponent(month)}`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/** Self-check's Run again (batch 6 c3): the page's three reads, made on the
    server in one go and summed into the row To do reads. */
export type SelfCheckRunResult = {
  control: { checks: ControlCheckRow[]; payments: UnbookedPayments; paymentDrift?: PaymentDrift };
  cancelled: { orders: Array<Record<string, unknown>>; totalRemainingSen: number } | { error: string };
  receipts: { total: number; months: unknown[] } | { error: string };
  summary: { checks: number; findings: number; items: string[] };
  ranAt: string;
  recordError?: string;
};
export const useRunSelfCheck = () => useMutation({
  mutationFn: () => authedFetch<SelfCheckRunResult>('/accounting/self-check/run', { method: 'POST' }),
});

export const useControlCheck = () => useQuery({
  queryKey: ['control-check'],
  queryFn: () => authedFetch<{ checks: ControlCheckRow[]; payments: UnbookedPayments; paymentDrift?: PaymentDrift }>(`/accounting/control-check`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export type DailyBankMovement = {
  jeNo: string; sourceType: string; sourceDocNo: string | null;
  docNo: string;
  party: string | null;
  note: string; amountSen: number;
  method?: string | null;
  typedBy?: string | null;
};
export type DailyBankPending = { id: string | null; pvNumber: string | null; payee: string | null; description: string; voucherDate: string | null; accountCode: string | null; amountSen: number };
export type DailyBankTransit = { acquirerCode: string; accountCode: string; accountName: string; balanceSen: number; bankAccountCode: string | null };
export type DailyBankBlock = {
  accountCode: string; accountName: string;
  start: { date: string; balanceSen: number } | null;
  openingSen: number; inSen: number; outSen: number; closingSen: number;
  receipts: DailyBankMovement[]; payouts: DailyBankMovement[];
  pending: DailyBankPending[]; pendingSen: number; availableSen: number;
  transit: DailyBankTransit[]; transitSen: number; availableWithTransitSen: number;
  /** On the cash-book board only (owner 2026-11-25: 要，加勾选): the day's approved vouchers
      ticked as already in the starting balance — listed, not taken off. */
  notDeducted?: DailyBankNotDeducted[];
};
/** An approved voucher the cash book lists on its day but does not take off. */
export type DailyBankNotDeducted = {
  pvId: string; pvNumber: string; party: string | null; note: string; amountSen: number;
  tickedBy: string | null; tickedAt: string | null;
};
export type DailyBankBoard = {
  date: string;
  blocks: DailyBankBlock[];
  transit: DailyBankTransit[];
  totalClosingSen: number; totalTransitSen: number; pendingApprovalSen: number; availableSen: number;
  /** Card money whose acquirer names no bank on the board (未标银行). */
  unassignedTransit: DailyBankTransit[];
  unassignedPending: DailyBankPending[];
  /** 'ledger' = the original board; 'cashbook' = the owner's cash book (2026-11-23), a second board. */
  book: 'ledger' | 'cashbook';
  notStarted: Array<{ accountCode: string; accountName: string; startDate: string | null }>;
  note: string;
  canWrite?: boolean;
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
  queryFn: () => authedFetch<{ date: string; rows: DailyCloseRow[]; confirmedBy?: string | null; confirmedAt?: string | null; cashJeNo?: string | null }>(`/accounting/daily-close?date=${date}`),
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
      void qc.invalidateQueries({ queryKey: ['finance-todo'] });
    },
    onError: writeFailedAs('Daily close not confirmed'),
  });
};


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

/** The five closing stocks (owner 2026-09-30): customer, display, service, showroom, others. */
export type StockBucketValues = { customer: number; display: number; service: number; showroom: number; others: number };
/** A month the close has booked (batch 6 c4): its active closing entry, split by bucket. */
export type ClosedStockMonth = {
  month: string; buckets: StockBucketValues; totalSen: number; action: 'posted' | 'reposted';
  bookedOn: string | null; jeNo: string; revJeNo: string | null;
};
export type StockCloseStatus = {
  liveValueSen: number;
  liveBuckets?: StockBucketValues;
  defaultMonth: string;
  sweepMonths?: string[];
  runs: StockCloseRun[];
  months?: ClosedStockMonth[];
};

export const useStockClose = () => useQuery({
  queryKey: ['stock-close'],
  queryFn: () => authedFetch<StockCloseStatus>(`/accounting/stock-close`),
  staleTime: 15_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useRunStockClose = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { month?: string }) =>
      authedFetch<{ outcome: { action: string; valueSen?: number; jeNo?: string; revJeNo?: string; note?: string } }>(`/accounting/stock-close/run`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stock-close'] });
      void qc.invalidateQueries({ queryKey: ['finance-todo'] });
      void qc.invalidateQueries({ queryKey: ['journal-entries'] });
      void qc.invalidateQueries({ queryKey: ['gl-entries'] });
      void qc.invalidateQueries({ queryKey: ['account-balances'] });
    },
    onError: writeFailedAs('Month-end run failed'),
  });
};


export type NumberingAccount = { accountCode: string; accountName: string; letter: string | null; fixedCash?: boolean };

export const useVoucherNumbering = () => useQuery({
  queryKey: ['voucher-numbering'],
  queryFn: () => authedFetch<{ digits: number; accounts: NumberingAccount[] }>(`/accounting/numbering`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useSaveVoucherNumbering = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { digits?: number; letters?: Array<{ accountCode: string; letter: string }> }) =>
      authedFetch<{ ok: boolean }>(`/accounting/numbering`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['voucher-numbering'] }); },
    onError: writeFailedAs('Numbering not saved'),
  });
};

/** The real backfill behind the Self-check card's "Book now" — the same
    endpoint without dryRun, one batch of up to 500 (docs/bugs/0655). Each
    payment posts on its own paid date; the control check re-reads after. */
export const useBookUnbookedPayments = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => authedFetch<PaymentDryRun>('/accounting/backfill/customer-payments', {
      method: 'POST', body: JSON.stringify({ limit: 500 }),
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['control-check'] }); },
  });
};
