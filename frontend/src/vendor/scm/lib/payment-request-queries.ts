// ----------------------------------------------------------------------------
// payment-request-queries — 申请付款 (owner 2026-09-29/30: 3a a new document, 4a
// a new permission). Server: backend/src/scm/routes/payment-requests.ts. The
// requester asks (who, how much, the event, the bill); Finance answers with a
// voucher raised on PV New (?fromRequest=). The stage is read off that voucher
// by the server on every read — never stored on the request.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';
import { fetchDocFileBlobUrl, type PvFile, type PvFilePayload } from './payment-voucher-queries';

export type RequestStage = 'SUBMITTED' | 'PROCESSING' | 'PAID' | 'BANK_CONFIRMED' | 'RETURNED' | 'WITHDRAWN' | 'VOUCHER_CANCELLED';

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
  finance_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
  stage: RequestStage;
  voucher: { id: string; pvNumber: string | null; status: string | null; approvedAt: string | null; postedAt: string | null; bankConfirmed: boolean } | null;
};

/** The owner's words for each stage (2026-09-29): 已提交 → Finance 处理中 → 已付 → 银行已确认. */
export const STAGE_LABEL: Record<RequestStage, string> = {
  SUBMITTED: 'Submitted · 已提交',
  PROCESSING: 'Finance processing · 处理中',
  PAID: 'Paid · 已付',
  BANK_CONFIRMED: 'Bank confirmed · 银行已确认',
  RETURNED: 'Returned · 已退回',
  WITHDRAWN: 'Withdrawn · 已撤回',
  VOUCHER_CANCELLED: 'Voucher cancelled · 付款单已取消',
};

/** Finance's to-do: nothing answers these yet. */
export const awaitsFinance = (r: Pick<PaymentRequest, 'stage'>): boolean => r.stage === 'SUBMITTED' || r.stage === 'VOUCHER_CANCELLED';

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
