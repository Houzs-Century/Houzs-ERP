/* ----------------------------------------------------------------------------
   document-cancel-queries — the ONE client of the cancellation-approval routes
   (backend/src/scm/routes/document-cancel-routes.ts), for both documents.

   THE OWNER, 2026-09-08: 「SO 和 PO 取消的话需要 approval 2 层 — 已经输入原因」.
   Cancelling a Sales Order or a Purchase Order is no longer one click: the
   person who wants it cancelled writes a reason and RAISES A REQUEST; a level-1
   approver signs; a level-2 approver signs; only then does the document's own
   cancel route run — and the server refuses it until then
   (`cancel_approval_required`), whatever screen sends it.

   NOTHING HERE CANCELS ANYTHING. The two cancel mutations that always existed
   (useUpdateMfgSalesOrderStatus with CANCELLED, useCancelPurchaseOrder) stay
   the only way a document is cancelled; the level-2 approve answers
   `execute: true` and the CALLER runs that mutation. Keeping the executor out
   of this file is what keeps the SO's version protocol and the PO's quota
   release in the one place each already lives.
   ---------------------------------------------------------------------------- */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

/** The two documents a cancellation request can sit on. */
export type CancelDocType = 'so' | 'po';

/** Mirrors scm.document_cancel_requests (mig 20260908T1400). */
export type CancelRequestRow = {
  id: string;
  company_id: number;
  doc_type: 'SO' | 'PO';
  /** `doc_no` for the Sales Order, `id` for the Purchase Order. */
  doc_key: string;
  doc_number: string;
  doc_status_at_request: string | null;
  status: 'REQUESTED' | 'L1_APPROVED' | 'APPROVED' | 'EXECUTED' | 'REJECTED' | 'WITHDRAWN';
  reason: string;
  requested_by: number;
  requested_by_name: string | null;
  requested_at: string;
  l1_by: number | null;
  l1_by_name: string | null;
  l1_at: string | null;
  l2_by: number | null;
  l2_by_name: string | null;
  l2_at: string | null;
  rejected_by: number | null;
  rejected_by_name: string | null;
  rejected_at: string | null;
  reject_reason: string | null;
  executed_by: number | null;
  executed_at: string | null;
};

export type CancelRequestDetail = {
  open: CancelRequestRow | null;
  history: CancelRequestRow[];
  needsApproval: boolean;
};

/** The permission that signs each level. MUST match the server's table
 *  (backend/src/scm/shared/document-cancel.ts CANCEL_APPROVE_KEY) — the screen
 *  only decides whether to SHOW a button; the server's 403 is the real gate. */
export const CANCEL_APPROVE_KEY: Record<CancelDocType, { 1: string; 2: string }> = {
  so: { 1: 'scm.so_cancel.approve_l1', 2: 'scm.so_cancel.approve_l2' },
  po: { 1: 'scm.po_cancel.approve_l1', 2: 'scm.po_cancel.approve_l2' },
};

const BASE: Record<CancelDocType, string> = { so: 'mfg-sales-orders', po: 'mfg-purchase-orders' };

export const docTypeOfRow = (row: Pick<CancelRequestRow, 'doc_type'>): CancelDocType => (row.doc_type === 'PO' ? 'po' : 'so');

/** Which signature the request is waiting for; null when none. */
export const pendingLevel = (status: string | null | undefined): 1 | 2 | null =>
  status === 'REQUESTED' ? 1 : status === 'L1_APPROVED' ? 2 : null;

export const signaturesGiven = (status: string | null | undefined): number =>
  status === 'L1_APPROVED' ? 1 : status === 'APPROVED' || status === 'EXECUTED' ? 2 : 0;

export const isOpenCancelStatus = (status: string | null | undefined): boolean =>
  status === 'REQUESTED' || status === 'L1_APPROVED' || status === 'APPROVED';

/** One sentence for the request's state, the same on every screen. */
export function cancelRequestLine(row: Pick<CancelRequestRow, 'status'>): string {
  switch (row.status) {
    case 'REQUESTED': return 'Waiting for level-1 approval (0 of 2)';
    case 'L1_APPROVED': return 'Waiting for level-2 approval (1 of 2)';
    case 'APPROVED': return 'Approved (2 of 2) — cancellation can run';
    case 'EXECUTED': return 'Cancelled';
    case 'REJECTED': return 'Rejected';
    case 'WITHDRAWN': return 'Withdrawn';
    default: return String(row.status);
  }
}

const detailKey = (docType: CancelDocType, key: string | null) => ['document-cancel-request', docType, key] as const;
const INBOX_KEY = 'document-cancel-requests';

const path = (docType: CancelDocType, key: string, tail = '') =>
  `/${BASE[docType]}/${encodeURIComponent(key)}/cancel-request${tail}`;

/** The document's open request (if any) and its history. */
export function useCancelRequest(docType: CancelDocType, key: string | null) {
  return useQuery({
    queryKey: detailKey(docType, key),
    queryFn: () => authedFetch<CancelRequestDetail>(path(docType, key as string)),
    enabled: !!key,
    staleTime: 15_000,
  });
}

/** The inbox — both documents, this company. */
export function useCancelRequests(scope: 'open' | 'all') {
  return useQuery({
    queryKey: [INBOX_KEY, scope],
    queryFn: () => authedFetch<{ requests: CancelRequestRow[] }>(`/cancel-requests?scope=${scope}`),
    staleTime: 15_000,
  });
}

function useInvalidate(docType: CancelDocType) {
  const qc = useQueryClient();
  return (key: string) => {
    void qc.invalidateQueries({ queryKey: detailKey(docType, key) });
    void qc.invalidateQueries({ queryKey: [INBOX_KEY] });
  };
}

/** Raise a request — the reason is mandatory (the server refuses < 5 chars). */
export function useRaiseCancelRequest(docType: CancelDocType) {
  const invalidate = useInvalidate(docType);
  return useMutation({
    mutationFn: ({ key, reason }: { key: string; reason: string }) =>
      authedFetch<{ request: CancelRequestRow }>(path(docType, key), { method: 'POST', body: JSON.stringify({ reason }) }),
    onSuccess: (_d, v) => invalidate(v.key),
  });
}

/** Sign the level the request is waiting for. `execute` is true after level 2:
 *  the caller must then run the document's own cancel mutation. */
export function useApproveCancelRequest(docType: CancelDocType) {
  const invalidate = useInvalidate(docType);
  return useMutation({
    mutationFn: ({ key }: { key: string }) =>
      authedFetch<{ request: CancelRequestRow; execute: boolean }>(path(docType, key, '/approve'), { method: 'POST' }),
    onSuccess: (_d, v) => invalidate(v.key),
  });
}

export function useRejectCancelRequest(docType: CancelDocType) {
  const invalidate = useInvalidate(docType);
  return useMutation({
    mutationFn: ({ key, reason }: { key: string; reason: string }) =>
      authedFetch<{ request: CancelRequestRow }>(path(docType, key, '/reject'), { method: 'POST', body: JSON.stringify({ reason }) }),
    onSuccess: (_d, v) => invalidate(v.key),
  });
}

export function useWithdrawCancelRequest(docType: CancelDocType) {
  const invalidate = useInvalidate(docType);
  return useMutation({
    mutationFn: ({ key }: { key: string }) =>
      authedFetch<{ request: CancelRequestRow }>(path(docType, key, '/withdraw'), { method: 'POST' }),
    onSuccess: (_d, v) => invalidate(v.key),
  });
}

/* ── Who may press which button (display only; the server decides) ──────── */

export type CancelViewer = { userId: number | null | undefined; can: (perm: string) => boolean };

const same = (a: number | null | undefined, b: number | null | undefined) => a != null && b != null && Number(a) === Number(b);

export function viewerCanApprove(row: CancelRequestRow, v: CancelViewer): boolean {
  const level = pendingLevel(row.status);
  if (level == null) return false;
  if (same(v.userId, row.requested_by)) return false;
  if (level === 2 && same(v.userId, row.l1_by)) return false;
  return v.can(CANCEL_APPROVE_KEY[docTypeOfRow(row)][level]);
}

export function viewerCanReject(row: CancelRequestRow, v: CancelViewer): boolean {
  if (pendingLevel(row.status) == null) return false;
  const keys = CANCEL_APPROVE_KEY[docTypeOfRow(row)];
  return v.can(keys[1]) || v.can(keys[2]);
}

export function viewerCanWithdraw(row: CancelRequestRow, v: CancelViewer): boolean {
  if (!isOpenCancelStatus(row.status)) return false;
  if (same(v.userId, row.requested_by)) return true;
  const keys = CANCEL_APPROVE_KEY[docTypeOfRow(row)];
  return v.can(keys[1]) || v.can(keys[2]);
}
