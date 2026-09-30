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
};

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
};

export const usePaymentRequests = (mine = false) => useQuery({
  queryKey: ['payment-requests', mine ? 'mine' : 'all'],
  queryFn: () => authedFetch<{ requests: PaymentRequest[]; finance: boolean }>(`/payment-requests${mine ? '?mine=1' : ''}`),
  staleTime: 15_000,
});

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
