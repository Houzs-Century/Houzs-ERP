// ----------------------------------------------------------------------------
// payment-request-queries — 申请付款 (owner 2026-09-29/30: 3a a new document, 4a
// a new permission). Server: backend/src/scm/routes/payment-requests.ts. The
// requester asks (who, how much, the event, the bill); Finance answers with a
// voucher raised on PV New (?fromRequest=), or with an AP invoice raised on AP
// Invoices (?fromRequest=, owner 2026-09-30 6.1). The stage is read off that
// document by the server on every read — never stored on the request.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';
import { fetchDocFileBlobUrl, type PvFile, type PvFilePayload } from './payment-voucher-queries';
import type { EventSuggestion } from './event-queries';
import { fmtSen } from '../../shared/format';

export type RequestStage =
  | 'SUBMITTED' | 'PROCESSING' | 'BOOKED' | 'PARTLY_PAID' | 'PAID' | 'BANK_CONFIRMED'
  | 'RETURNED' | 'WITHDRAWN' | 'VOUCHER_CANCELLED';

export type PaymentRequest = {
  id: string;
  request_no: string;
  requested_by: number;
  requested_by_name: string | null;
  payee_name: string;
  amount_sen: number;
  due_date: string | null;
  purpose: string;
  /** The requester's note to Finance (2026-10-02) — absent before then. */
  note?: string | null;
  project_id: number | null;
  bank_name: string | null;
  bank_account_no: string | null;
  bank_account_name: string | null;
  status: 'SUBMITTED' | 'VOUCHERED' | 'REJECTED' | 'WITHDRAWN';
  pv_id: string | null;
  ap_invoice_id?: string | null;
  finance_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
  stage: RequestStage;
  voucher: { id: string; pvNumber: string | null; status: string | null; approvedAt: string | null; postedAt: string | null; bankConfirmed: boolean } | null;
  /** The AP invoice answering it, when Finance booked the bill first: what is
      paid of it so far, and by which AP Payments. */
  invoice?: { id: string; invoiceNumber: string | null; status: string | null; totalSen: number; paidSen: number; paidBy: string[]; bankConfirmed: boolean } | null;
  /** What the bill reader read off its bill when it was attached (owner
      2026-10-01, item 1): the bill's own number, date and total, and whether it
      is for an event — with the requester's reason when it went without one. */
  bill_no?: string | null;
  bill_date?: string | null;
  bill_total_sen?: number | null;
  event_bill?: boolean;
  no_event_reason?: string | null;
  /** Other live requests, vouchers and AP invoices with the same bill number
      and date (同一张单) — said out loud, never refused. */
  billMatches?: BillMatch[];
  /** A bill paid in instalments (owner 2026-10-01, item 2): a balance names the
      bill's FIRST request; 1 for the first itself. */
  parent_request_id?: string | null;
  installment_no?: number;
  /** The percent of the bill this instalment is, as typed. */
  pay_pct?: number | null;
  /** The whole bill's figures and its instalments, read on every request. */
  family?: BillFamily;
  /** 欠正式单 (item 3): the answering payment's official-invoice state, read off it. */
  officialDoc?: { state: 'OWED' | 'RECEIVED' | 'CHECKED'; note: string | null } | null;
  /** The first request's AP invoice, when Finance booked the bill — a balance is paid ON it. */
  familyInvoice?: { id: string; invoiceNumber: string | null; status: string | null; supplierId: string | null; totalSen: number; paidSen: number } | null;
};

/** A bill's instalments and its figures (server: lib/payment-request.ts familyFigures). */
export type BillFamily = {
  rootId: string;
  rootNo: string;
  totalSen: number | null;
  askedSen: number;
  paidSen: number;
  pendingSen: number;
  remainingSen: number | null;
  installments: Array<{ id: string; request_no: string; installment_no: number; amount_sen: number; pay_pct: number | null; stage: RequestStage }>;
};

/** A bill worth reading as instalments: more than one, or a known total partly asked. */
export const hasInstalments = (f: BillFamily | undefined): f is BillFamily =>
  !!f && (f.installments.length > 1 || (f.totalSen != null && f.askedSen < f.totalSen));

/** The sen a percent of a total comes to — rounded to the sen. */
export const pctOf = (totalSen: number, pct: number): number => Math.round((totalSen * pct) / 100);

/** 申请付余额 is offered while the bill's first request stands and something is
    left to ask — or, its total unknown, once the bill already runs in instalments. */
export const mayAskBalance = (r: Pick<PaymentRequest, 'family'>): boolean => {
  const f = r.family;
  if (!f) return false;
  const first = f.installments.find((m) => m.id === f.rootId);
  if (!first || first.stage === 'WITHDRAWN') return false;
  return f.remainingSen != null ? f.remainingSen > 0 : f.installments.length > 1;
};

/** Another live document carrying the same bill number and date (server:
    lib/bill-matches.ts). A request names the voucher or AP invoice answering it. */
export type BillMatch = { kind: 'PRQ' | 'PV' | 'API'; id: string; number: string | null; amountSen: number; status: string; answeredBy: string | null };

const MATCH_STATUS: Record<string, string> = {
  SUBMITTED: 'waiting for Finance', VOUCHERED: 'answered', REJECTED: 'returned',
  DRAFT: 'draft', POSTED: 'posted', PARTIALLY_PAID: 'partly paid', PAID: 'paid',
};
const MATCH_KIND: Record<BillMatch['kind'], string> = { PRQ: 'Request', PV: 'Voucher', API: 'AP invoice' };

/** One match in one line: "Request HC-PRQ-2610-003 · RM 5,000.00 → HC-PV-2610-010 · answered". */
export const billMatchText = (m: BillMatch): string =>
  `${MATCH_KIND[m.kind]} ${m.number ?? '(no number yet)'} · ${fmtSen(m.amountSen)}${m.answeredBy ? ` → ${m.answeredBy}` : ''} · ${MATCH_STATUS[m.status] ?? m.status.toLowerCase()}`;

/** Each stage in the owner's words (2026-09-29: 已提交 → Finance 处理中 → 已付 →
    银行已确认; 2026-09-30 for a booked bill: 已入账、未付 → 部分已付) and the
    colour it reads in — one home for both. */
export const STAGE: Record<RequestStage, { label: string; tone: string }> = {
  SUBMITTED: { label: 'Submitted · 已提交', tone: 'var(--fg-muted)' },
  PROCESSING: { label: 'Finance processing · 处理中', tone: 'var(--c-orange)' },
  BOOKED: { label: 'Booked, not paid yet · 已入账、未付', tone: 'var(--c-orange)' },
  PARTLY_PAID: { label: 'Partly paid · 部分已付', tone: 'var(--c-orange)' },
  PAID: { label: 'Paid · 已付', tone: 'var(--c-green, #2f7d32)' },
  BANK_CONFIRMED: { label: 'Bank confirmed · 银行已确认', tone: 'var(--c-green-deep, #1b5e20)' },
  RETURNED: { label: 'Returned · 已退回', tone: 'var(--c-festive-b, #B8331F)' },
  WITHDRAWN: { label: 'Withdrawn · 已撤回', tone: 'var(--fg-muted)' },
  VOUCHER_CANCELLED: { label: 'Cancelled — Finance makes the next · 单据已取消', tone: 'var(--c-festive-b, #B8331F)' },
};

/** Finance's to-do: nothing answers these yet. */
export const awaitsFinance = (r: Pick<PaymentRequest, 'stage'>): boolean => r.stage === 'SUBMITTED' || r.stage === 'VOUCHER_CANCELLED';
/** Answered, the money not all out yet: a voucher in its cycle, or a booked bill not fully paid. */
export const financeWorking = (r: Pick<PaymentRequest, 'stage'>): boolean =>
  r.stage === 'PROCESSING' || r.stage === 'BOOKED' || r.stage === 'PARTLY_PAID';
/** The money is out. */
export const requestPaid = (r: Pick<PaymentRequest, 'stage'>): boolean => r.stage === 'PAID' || r.stage === 'BANK_CONFIRMED';

/** What answered the request, in one line — the voucher's number, or the AP
    invoice's with how much of it is paid so far (部分已付 RM x / y); null while
    nothing has. One home for the desktop list, its detail and the phone. */
export const answerText = (r: Pick<PaymentRequest, 'voucher' | 'invoice'>): string | null => {
  if (r.invoice) {
    const no = r.invoice.invoiceNumber ?? 'AP invoice';
    return r.invoice.paidSen > 0 ? `${no} · ${fmtSen(r.invoice.paidSen)} of ${fmtSen(r.invoice.totalSen)} paid` : no;
  }
  return r.voucher ? (r.voucher.pvNumber ?? 'Draft voucher') : null;
};

export type PaymentRequestInput = {
  payeeName: string; amountSen: number; dueDate: string | null; purpose: string; projectId: number | null;
  bankName: string | null; bankAccountNo: string | null; bankAccountName: string | null;
  /* What the reader read off the bill (absent = keep what the request has). */
  billNo?: string | null; billDate?: string | null; billTotalSen?: number | null; eventBill?: boolean;
  /** Why an event bill goes without its Event (找不到这场活动) — 5 characters at least. */
  noEventReason?: string | null;
  /** The percent of the bill this payment is, when typed as one (item 2). */
  payPct?: number | null;
  /** The requester's note to Finance (owner 2026-10-02: 多一个第五给他们写note). */
  note?: string | null;
};


/** The reason a requester gives when the event bill's event cannot be found. */
export const NO_EVENT_REASON_MIN = 5;

export const usePaymentRequests = (mine = false) => useQuery({
  queryKey: ['payment-requests', mine ? 'mine' : 'all'],
  /* hasEvents: whether the company runs events (2990 does not) — the form
     hides the Event field without them. */
  queryFn: () => authedFetch<{ requests: PaymentRequest[]; finance: boolean; hasEvents?: boolean }>(`/payment-requests${mine ? '?mine=1' : ''}`),
  staleTime: 15_000,
});

/** What the reader read off a bill being attached (POST /payment-requests/read-bill). */
export type ReadBillResult =
  | { ok: false; reason: string }
  | {
    ok: true;
    bill: {
      billNo: string | null; billDate: string | null; totalSen: number | null; vendorName: string | null;
      /* What the form fills where empty (owner 2026-10-02) — absent from a
         server older than that, so optional. */
      dueDate?: string | null; summary?: string | null;
      bankName?: string | null; bankAccountNo?: string | null; bankAccountName?: string | null;
    };
    hasEvents: boolean;
    /** The bill is for an event — it goes with its Event, or a reason. */
    eventBill: boolean;
    eventSuggestions: EventSuggestion[];
    matches: BillMatch[];
  };

/** Read the bill as it is attached — before the request exists ({ files }) or
    a request's stored bill ({ requestId }). Writes nothing; a reader that
    cannot read says so (ok: false) and the request still goes. */
export const useReadRequestBill = () => useMutation({
  mutationFn: (body: { files: PvFilePayload[] } | { requestId: string }) =>
    authedFetch<ReadBillResult>('/payment-requests/read-bill', { method: 'POST', body: JSON.stringify(body) }),
});

/** Finance's voucher form asks the same question of a typed bill number and date. */
export const useBillMatches = (no: string, date: string, excludeRequest: string | null = null) => {
  const n = no.trim();
  const ok = n !== '' && /^\d{4}-\d{2}-\d{2}$/.test(date);
  return useQuery({
    queryKey: ['payment-request-bill-matches', n, date, excludeRequest],
    queryFn: () => authedFetch<{ matches: BillMatch[] }>(`/payment-requests/bill-matches?${new URLSearchParams({ no: n, date, ...(excludeRequest ? { excludeRequest } : {}) }).toString()}`),
    enabled: ok,
    staleTime: 30_000,
  });
};

export const usePaymentRequest = (id: string | null) => useQuery({
  queryKey: ['payment-request', id],
  queryFn: () => authedFetch<{ request: PaymentRequest; finance: boolean }>(`/payment-requests/${id}`),
  enabled: !!id,
});

const invalidate = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['payment-requests'] });
  void qc.invalidateQueries({ queryKey: ['payment-request'] });
};

export const useCreatePaymentRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PaymentRequestInput) =>
      authedFetch<{ ok: true; request: PaymentRequest }>('/payment-requests', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => invalidate(qc),
    onError: writeFailedAs('Request not sent'),
  });
};

export const useUpdatePaymentRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: PaymentRequestInput & { id: string }) =>
      authedFetch<{ ok: true; request: PaymentRequest }>(`/payment-requests/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => invalidate(qc),
    onError: writeFailedAs('Request not saved'),
  });
};

export const useWithdrawPaymentRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true }>(`/payment-requests/${id}/withdraw`, { method: 'POST' }),
    onSuccess: () => invalidate(qc),
    onError: writeFailedAs('Request not withdrawn'),
  });
};

/** 申请付余额 — the next instalment of the same bill (POST /payment-requests/:id/balance). */
export type BalanceInput = { amountSen: number; payPct: number | null; dueDate: string | null; purpose: string | null };

export const useRequestBalance = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: BalanceInput & { id: string }) =>
      authedFetch<{ ok: true; request: PaymentRequest; overTotal: boolean }>(`/payment-requests/${id}/balance`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => invalidate(qc),
    onError: writeFailedAs('Balance not requested'),
  });
};

export const useReturnPaymentRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      authedFetch<{ ok: true }>(`/payment-requests/${id}/return`, { method: 'POST', body: JSON.stringify({ note }) }),
    onSuccess: () => invalidate(qc),
    onError: writeFailedAs('Request not returned'),
  });
};

/* The bill — the same factory the voucher's files ride (doc-files.ts). */
export const usePaymentRequestFiles = (id: string | null) => useQuery({
  queryKey: ['payment-request-files', id],
  queryFn: () => authedFetch<{ files: PvFile[] }>(`/payment-requests/${id}/files`),
  enabled: !!id,
});

export const useUploadPaymentRequestFile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }: { id: string; file: PvFilePayload }) =>
      authedFetch<{ ok: true; file: PvFile }>(`/payment-requests/${id}/files`, {
        method: 'POST',
        body: JSON.stringify({ fileName: file.name, mime: file.mime, dataBase64: file.dataBase64 }),
      }),
    onSuccess: (_d, vars) => { void qc.invalidateQueries({ queryKey: ['payment-request-files', vars.id] }); },
  });
};

export const useDeletePaymentRequestFile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, fileId }: { id: string; fileId: string }) =>
      authedFetch<{ ok: true }>(`/payment-requests/${id}/files/${fileId}`, { method: 'DELETE' }),
    onSuccess: (_d, vars) => { void qc.invalidateQueries({ queryKey: ['payment-request-files', vars.id] }); },
  });
};

export const fetchPaymentRequestFileBlobUrl = (id: string, fileId: string): Promise<{ url: string; contentType: string }> =>
  fetchDocFileBlobUrl(`/payment-requests/${id}/files/${fileId}`);
