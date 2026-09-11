/* Deposit invoices (owner 2026-09-12; docs/bugs/0828): one per customer
   payment received before the order's final invoice, born off the payment
   hook when the company's switch is on. Finance's window: the list, one
   invoice with its payment, the switch (on/off + start day), the backlog
   button, cancel with a reason, post again. The server half is
   backend/src/scm/routes/deposit-invoices.ts. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type DepositInvoiceStatus = 'ISSUED' | 'CANCELLED';

export type DepositInvoice = {
  id: string; company_id: number; di_number: string; payment_source: string; payment_id: string; so_doc_no: string;
  party_code: string | null; party_name: string | null; invoice_date: string; amount_sen: number; method: string | null;
  status: DepositInvoiceStatus; je_no: string | null; credit_note_id: string | null; cancel_reason: string | null;
  created_at: string; created_by: string | null; cancelled_at: string | null; cancelled_by: string | null;
};
export type DepositInvoicePayment = {
  id: string; paid_at: string | null; method: string | null; merchant_provider: string | null; online_type: string | null;
  amount_sen: number; is_deposit: boolean | null; collected_by: string | null;
};
export type DepositInvoiceSettings = { enabled: boolean; fromDate: string | null };

const KEY = 'deposit-invoices';
const invalidate = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: [KEY] });
  void qc.invalidateQueries({ queryKey: ['journal-entries'] });
  void qc.invalidateQueries({ queryKey: ['gl-entries'] });
};

export const useDepositInvoices = (status: DepositInvoiceStatus | 'ALL', so: string) => useQuery({
  queryKey: [KEY, status, so],
  queryFn: () => authedFetch<{ rows: DepositInvoice[] }>(`/deposit-invoices?status=${status === 'ALL' ? '' : status}&so=${encodeURIComponent(so)}`),
  staleTime: 15_000,
  retry: retryUnlessClientError,
});

export const useDepositInvoiceDetail = (id: string | null) => useQuery({
  queryKey: [KEY, 'detail', id],
  enabled: id != null,
  queryFn: () => authedFetch<{ invoice: DepositInvoice; payment: DepositInvoicePayment | null }>(`/deposit-invoices/${id}`),
  staleTime: 0,
  retry: retryUnlessClientError,
});

export const useDepositInvoiceSettings = () => useQuery({
  queryKey: [KEY, 'settings'],
  queryFn: () => authedFetch<{ settings: DepositInvoiceSettings; missingCount: number }>('/deposit-invoices/settings'),
  staleTime: 0,
  retry: retryUnlessClientError,
});

export const useSaveDepositInvoiceSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DepositInvoiceSettings) =>
      authedFetch<{ ok: boolean; settings: DepositInvoiceSettings; missingCount: number | null }>('/deposit-invoices/settings', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => invalidate(qc),
  });
};

export const useIssueMissingDepositInvoices = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      authedFetch<{ ok: boolean; issued: string[]; skipped: Array<{ paymentId: string; why: string }> }>('/deposit-invoices/issue-missing', { method: 'POST', body: '{}' }),
    onSuccess: () => invalidate(qc),
  });
};

export const useCancelDepositInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      authedFetch<{ ok: boolean; status: string; contraJeNo: string | null }>(`/deposit-invoices/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
    onSuccess: () => invalidate(qc),
  });
};

export const usePostDepositInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: boolean; jeNo: string; status: string }>(`/deposit-invoices/${id}/post`, { method: 'POST', body: '{}' }),
    onSuccess: () => invalidate(qc),
  });
};
