/* ----------------------------------------------------------------------------
   payment-backdate-queries — the ONE client of the payment backdate-request
   routes (backend/src/scm/routes/so-payment-backdate-requests.ts).

   THE OWNER, 2026-09-30: 「balance collection 需要 request key in 如果是超过14天
   from today - 只有 admin 可以看到 request」. A payment whose slip date is more
   than 14 days old is no longer a dead end: the collector sends it as a request
   with a reason, and an admin (`scm.payment.backdate`) approves it — which books
   the payment — or rejects it. The desktop panel and the phone sheet both raise
   through here, and the per-order panel + the admin inbox both decide through
   here, so no surface can end up with a different rule.
   ---------------------------------------------------------------------------- */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { checkPaymentSlipDate } from './payment-slip-date';

export { PAYMENT_BACKDATE_KEY, BACKDATE_DECIDER_PERMS } from './payment-backdate-perms';

/** Mirrors scm.so_payment_backdate_requests (mig 20260930T1500). */
export type BackdateRequestRow = {
  id: string;
  company_id: number;
  so_doc_no: string;
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';
  reason: string;
  paid_at: string;
  method: string;
  merchant_provider: string | null;
  installment_months: number | null;
  online_type: string | null;
  approval_code: string | null;
  amount_sen: number;
  account_sheet: string | null;
  collected_by: string | null;
  note: string | null;
  slip_key: string | null;
  requested_by: number;
  requested_by_name: string | null;
  requested_at: string;
  decided_by: number | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  payment_id: string | null;
};

/** True when this slip date is refused ONLY for being too old — the one case a
 *  request can carry. A future date stays a plain refusal (a typo, not a late
 *  slip), and a caller holding the backdate right records it directly. */
export function slipDateNeedsRequest(paidAt: string | null | undefined, today: string, mayBackdate: boolean): boolean {
  if (mayBackdate) return false;
  const v = checkPaymentSlipDate(paidAt, today);
  return !v.ok && v.code === 'too_old';
}

/** The line shown under the date field when a request is the way forward. */
export const REQUEST_HINT = 'Slip date is more than 14 days old. Send it to an admin for approval.';

/** What the reason prompt asks, on both surfaces. */
export const BACKDATE_REASON_ASK = {
  title: 'Send this payment for admin approval',
  body: 'The slip date is more than 14 days old, so an admin has to approve it. The payment is recorded once they do.',
  input: { label: 'Reason', placeholder: 'Balance collected on 02/09, customer sent the slip only today', required: true as const },
  confirmLabel: 'Send request',
};

export const backdateStatusLabel = (s: BackdateRequestRow['status']): string =>
  s === 'REQUESTED' ? 'Waiting for admin' : s === 'APPROVED' ? 'Approved' : s === 'REJECTED' ? 'Rejected' : 'Withdrawn';

const docKey = (docNo: string | null) => ['so-payment-backdate-requests', docNo] as const;
const INBOX_KEY = 'payment-backdate-requests';
const docPath = (docNo: string, tail = '') => `/mfg-sales-orders/${encodeURIComponent(docNo)}/payment-backdate-requests${tail}`;

/** The order's requests — every one for an admin, only the caller's own otherwise. */
export function useSoBackdateRequests(docNo: string | null) {
  return useQuery({
    queryKey: docKey(docNo),
    queryFn: () => authedFetch<{ requests: BackdateRequestRow[]; isAdmin: boolean }>(docPath(docNo as string)),
    enabled: !!docNo,
    staleTime: 15_000,
  });
}

/** The admin inbox. */
export function useBackdateInbox(scope: 'open' | 'all', enabled = true) {
  return useQuery({
    queryKey: [INBOX_KEY, scope],
    queryFn: () => authedFetch<{ requests: BackdateRequestRow[] }>(`/payment-backdate-requests?scope=${scope}`),
    enabled,
    staleTime: 15_000,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['so-payment-backdate-requests'] });
    void qc.invalidateQueries({ queryKey: [INBOX_KEY] });
    /* The sidebar's red count (hooks/useAmendmentApprovals). */
    void qc.invalidateQueries({ queryKey: ['scm', 'payment-backdate-approvals'] });
    /* An approval books a payment: the ledger and the list totals move. */
    void qc.invalidateQueries({ queryKey: ['mfg-sales-orders'] });
  };
}

/** Raise a request — the payment body POST /:docNo/payments takes, plus the reason. */
export function useRaiseBackdateRequest() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ docNo, ...body }: { docNo: string; reason: string } & Record<string, unknown>) =>
      authedFetch<{ request: BackdateRequestRow }>(docPath(docNo), { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });
}

export function useDecideBackdateRequest() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ row, action, note }: { row: Pick<BackdateRequestRow, 'id' | 'so_doc_no'>; action: 'approve' | 'reject' | 'withdraw'; note?: string }) =>
      authedFetch<unknown>(
        action === 'withdraw'
          ? docPath(row.so_doc_no, `/${row.id}/withdraw`)
          : `/payment-backdate-requests/${row.id}/${action}`,
        { method: 'POST', body: JSON.stringify(note ? { note } : {}) },
      ),
    onSuccess: invalidate,
  });
}
