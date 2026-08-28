// TanStack Query hooks for Payment Vouchers (Phase 1-B, MYR).
//
// HOUZS VENDOR — port of the PV slice of 2990's apps/backend/src/lib/flow-queries.ts.
// Import boundary only: all reads/writes go through the vendored authedFetch
// (→ /api/scm/payment-vouchers…). A DRAFT PV is created here, posted to the GL
// from the detail page, and cancelled (which reverses the GL entry + any PI
// settlement).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { idempotentInit } from '../../../lib/idempotency';
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

/* List row + detail shapes are loosely typed (accessors read by name), matching
   the PI/GRN list convention. */
export type PaymentVoucherRow = Record<string, unknown> & {
  id: string;
  pv_number: string;
  status: string;
  voucher_date: string | null;
  payee_name: string;
  total_sen?: number;
  currency?: string;
  credit_account_code?: string;
  supplier?: { id: string; code: string; name: string } | null;
  /* Phase 3 — the approval cycle's marks. Both null: an editable draft.
     Submitted only: in the queue. Both set: approved, waiting to post. */
  submitted_at?: string | null;
  submitted_by?: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
};

export type PaymentVoucherAllocation = {
  id: string;
  amountSen: number;
  piId: string | null;
  invoiceNumber: string | null;
  supplierInvoiceRef: string | null;
  currency: string | null;
  totalSen: number | null;
  paidSen: number | null;
  status: string | null;
};

export const usePaymentVouchers = (status?: string) => baseQuery<{ paymentVouchers: PaymentVoucherRow[] }>(
  ['payment-vouchers', status ?? 'all'], `/payment-vouchers${status ? `?status=${status}` : ''}`,
);

export const usePaymentVoucherDetail = (id: string | null) => useQuery({
  queryKey: ['payment-voucher-detail', id],
  queryFn: () => authedFetch<{
    paymentVoucher: Record<string, unknown>;
    lines: Array<Record<string, unknown>>;
    allocations: PaymentVoucherAllocation[];
  }>(`/payment-vouchers/${id}`),
  enabled: !!id,
});

/* `idempotencyKey` is OPTIONAL and must be destructured OUT of the body — the
   rest-spread would otherwise post it as a voucher field. Pass one per voucher
   intent (see lib/idempotency.ts): the middleware replays the first response —
   the SAME pvNumber — instead of raising a second voucher to pay the same
   supplier. Omitting it is exactly today's behaviour (the middleware no-ops).

   NOT on fix/so-idempotency's list, and the omission is worth naming: this is
   the most literal money-out document in the app, and lib/idempotency.ts even
   cites this file — but for /post and /cancel, which "detect their own replay
   and echo back". CREATE has no such guard. The domain-idempotent note was about
   two OTHER endpoints and quietly read as if the file were covered. */
export const useCreatePaymentVoucher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; pvNumber: string }>(`/payment-vouchers`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payment-vouchers'] }),
  });
};

export const useUpdatePaymentVoucher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ paymentVoucher: Record<string, unknown> }>(`/payment-vouchers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['payment-voucher-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['payment-vouchers'] });
    },
  });
};

export const usePostPaymentVoucher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true; jeNo?: string }>(`/payment-vouchers/${id}/post`, { method: 'POST' }),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['payment-vouchers'] });
      qc.invalidateQueries({ queryKey: ['payment-voucher-detail', id] });
      // A post settles linked PIs — refresh the PI list/detail too.
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
    },
  });
};

export const useCancelPaymentVoucher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/payment-vouchers/${id}/cancel`, { method: 'POST' }),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['payment-vouchers'] });
      qc.invalidateQueries({ queryKey: ['payment-voucher-detail', id] });
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
    },
  });
};

/* ── Phase 3: the approval cycle. Each mutation refreshes the list, the
   detail, and the Daily Bank board — a voucher entering or leaving the queue
   moves the board's "available" figure. */
const approvalMutation = (path: 'submit' | 'withdraw' | 'approve') => () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/payment-vouchers/${id}/${path}`, { method: 'POST' }),
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: ['payment-vouchers'] });
      void qc.invalidateQueries({ queryKey: ['payment-voucher-detail', id] });
      void qc.invalidateQueries({ queryKey: ['daily-bank'] });
    },
  });
};
export const useSubmitPaymentVoucher = approvalMutation('submit');
export const useWithdrawPaymentVoucher = approvalMutation('withdraw');
export const useApprovePaymentVoucher = approvalMutation('approve');

export const useRejectPaymentVoucher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      authedFetch(`/payment-vouchers/${id}/reject`, { method: 'POST', body: JSON.stringify({ note }) }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['payment-vouchers'] });
      void qc.invalidateQueries({ queryKey: ['payment-voucher-detail', vars.id] });
      void qc.invalidateQueries({ queryKey: ['daily-bank'] });
    },
  });
};
