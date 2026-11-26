
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { idempotentInit } from '../../../lib/idempotency';
import { AMENDMENT_APPROVALS_KEY } from '../../../hooks/useAmendmentApprovals';
import { invalidateSoLists } from './sales-order-queries';
import type { SoAmendmentHeaderChanges } from './so-amendment-header';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type AmendmentRow = {
  id: string;
  so_doc_no: string;
  amendment_no: number | string | null;
  status: string;
  reason: string | null;
  requested_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  resolution?: 'REJECTED' | 'WITHDRAWN' | null;
  rejection_reason?: string | null;
  rejected_by?: string | null;
  rejected_at?: string | null;
  edited_at?: string | null;
  edit_count?: number | null;
  lane?: 'LINES' | 'DELIVERY' | string | null;
  /* Set when an APPROVER said this request was not theirs to sign and PASSED it
     to the other desk (owner 2026-09-17). `lane` is already the receiving desk;
     this is the note that came with it. NULL when it never changed hands. */
  lane_flag_note?: string | null;
  /* Owner 2026-07-27 — the PO(s) this SO's lines were purchased on
     (purchase_order_items.so_item_id linkage, resolved by the list endpoint).
     The PO Amendments inbox merges rows with a bound PO alongside the direct
     po_amendments so purchasing sees the whole revision queue in one place.
     Empty on an SO with no purchase leg (and on responses from a pre-upgrade
     backend, so read it defensively). */
  bound_pos?: Array<{ id: string; po_number: string; status: string }>;
  /* Owner 2026-09-14 (the queue's Reference column) — the SO header's `ref` and
     `customer_so_no`, raw, as the list endpoint read them. Resolve for display
     with customerRefOf (lib/customer-ref.ts), the one rule for that cell. Absent
     from a pre-upgrade backend, so read it defensively. */
  so_ref?: string | null;
  so_customer_so_no?: string | null;
};

export type AmendmentLine = {
  id: string;
  amendment_id: string;
  sales_order_item_id: string | null;
  change_type: string;
  new_item_code: string | null;
  new_variants: unknown;
  new_qty: number | null;
  new_unit_price_sen: number | null;
  new_remark?: string | null;
  new_discount_sen?: number | null;
  old_snapshot: unknown;
};

export type AmendmentDetail = {
  amendment: AmendmentRow & Record<string, unknown> & {
    header_changes?: SoAmendmentHeaderChanges | null;
    old_header_snapshot?: SoAmendmentHeaderChanges | null;
    purchaser_ok_by?: string | null;
    purchaser_ok_at?: string | null;
    po_date_override_by?: string | null;
  };
  lines: AmendmentLine[];
  salesOrder: { doc_no: string; status: string; revision: number } | null;
  purchaseOrders: Array<{ id: string; po_number: string; status: string }>;
  viewerIsRequester?: boolean;
  purchaserOkRequired?: boolean;
};

export type SoRevisionRow = {
  id: string;
  revision: number;
  snapshot: unknown;
  created_at: string | null;
  created_by: string | null;
};

export type CreateAmendmentLine = {
  salesOrderItemId?: string;
  changeType: string;
  newItemCode?: string;
  newVariants?: unknown;
  newQty?: number;
  newUnitPriceSen?: number;
  /* HC-0095 — sent with a TYPED 0 only; the apply ignores a 0 without it. */
  zeroPriceIntended?: true;
  /* mig 0280 — the line's REMARK. Omit when the request does not touch it; ''
     is a real request to clear it. Before 0280 this had no column and the
     submit dropped it in silence (owner 2026-08-11, 2990-SO-2608-016). */
  newRemark?: string;
  newDiscountSen?: number;
  oldSnapshot?: unknown;
};

const invalidateAmendmentSideEffects = (
  qc: ReturnType<typeof useQueryClient>,
  id?: string,
) => {
  qc.invalidateQueries({ queryKey: ['amendments'] });
  if (id) qc.invalidateQueries({ queryKey: ['amendment-detail', id] });
  invalidateSoLists(qc);
  qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail'] });
  qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
  qc.invalidateQueries({ queryKey: ['mfg-purchase-order-detail'] });
  qc.invalidateQueries({ queryKey: ['po-amendments'] });
  qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log'] });
  /* The sidebar's red count of amendments awaiting THIS user's signature
     (hooks/useAmendmentApprovals). Every gate that resolves an amendment passes
     through here, which is why the invalidation lives at this one point rather
     than on each approve/reject screen: the owner's ask was "审批后就根据目前
     需要的单号改变", and a screen that forgot to call it would look exactly like
     the 60s poll being slow. The key is IMPORTED, not respelled — a second copy
     of it would drift silently and show as a badge that just never updates. */
  void qc.invalidateQueries({ queryKey: AMENDMENT_APPROVALS_KEY });
};

export const useAmendments = () => useQuery({
  queryKey: ['amendments'],
  queryFn: () => authedFetch<{ amendments: AmendmentRow[] }>(`/so-amendments`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useAmendmentDetail = (id: string | null) => useQuery({
  queryKey: ['amendment-detail', id],
  queryFn: () => authedFetch<AmendmentDetail>(`/so-amendments/${id}`),
  enabled: Boolean(id),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useSoRevisions = (docNo: string | null) => useQuery({
  queryKey: ['so-revisions', docNo],
  queryFn: () => authedFetch<{ revisions: SoRevisionRow[] }>(`/mfg-sales-orders/${docNo}/revisions`),
  enabled: Boolean(docNo),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const usePoRevisions = (poId: string | null) => useQuery({
  queryKey: ['po-revisions', poId],
  queryFn: () => authedFetch<{ revisions: SoRevisionRow[] }>(`/mfg-purchase-orders/${poId}/revisions`),
  enabled: Boolean(poId),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/* ── Lane preview (owner 2026-09-15, option B) ─────────────────────────────
   POST /mfg-sales-orders/:docNo/amendments/lane-preview — which desk the
   request WILL go to, answered by the same resolver the create stores from.
   Read-only on the server; a POST only because the payload is the draft. Not
   cached across drafts: the key carries the lines and header keys, so editing
   the draft re-asks. */
export type AmendmentLane = 'LINES' | 'DELIVERY' | 'PRICE' | 'LINE_ADDREMOVE';
export type AmendmentLanePreview = {
  lanes: AmendmentLane[];
  perLane: Record<AmendmentLane, { lineCount: number; headerKeys: string[] }>;
};
export type AmendmentLanePreviewArgs = {
  docNo: string;
  lines: CreateAmendmentLine[];
  headerChanges?: SoAmendmentHeaderChanges;
};
export const useAmendmentLanePreview = (args: AmendmentLanePreviewArgs | null) => useQuery({
  queryKey: ['so-amendment-lane-preview', args?.docNo ?? null,
    (args?.lines ?? []).map((l) => `${l.salesOrderItemId ?? ''}|${l.newItemCode ?? ''}`),
    Object.keys(args?.headerChanges ?? {}).sort()],
  queryFn: () => authedFetch<AmendmentLanePreview>(
    `/mfg-sales-orders/${args!.docNo}/amendments/lane-preview`,
    { method: 'POST', body: JSON.stringify({
      lines: args!.lines.map(({ oldSnapshot: _snap, ...l }) => ({
        salesOrderItemId: l.salesOrderItemId ?? null, changeType: l.changeType,
        newItemCode: l.newItemCode ?? null, newVariants: l.newVariants ?? null,
        newQty: l.newQty ?? null, newUnitPriceSen: l.newUnitPriceSen ?? null,
        newRemark: l.newRemark ?? null, newDiscountSen: l.newDiscountSen ?? null,
      })),
      headerChanges: args!.headerChanges ?? null,
    }) },
  ),
  enabled: args != null,
  staleTime: 60_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/** What POST /mfg-sales-orders/:docNo/amendments answers, plus what the hook
 *  then did with it. `autoApplied` counts the halves that applied on the spot. */
export type CreateAmendmentResult = {
  amendment: AmendmentRow;
  amendments?: AmendmentRow[];
  lanes?: string[];
  selfApprovable?: string[];
  autoApplied?: number;
  notApplied?: string[];
};

/* THE SHORTCUT THE SERVER OFFERS (owner 2026-09-24: 「如果是 Logistic admin 修改
   客户信息, Delivery Date - 无需 approver」). The create response lists the ids the
   RAISER may apply themselves — a DELIVERY half, header-only, raised by someone
   who holds that lane's approve key (backend shared/amendment-self-approve.ts
   decides; the approve route re-checks, so this list is an invitation and never
   an authorisation).

   The apply runs through the ORDINARY approve route, exactly as the approver's
   own click does, so every guard it carries stays where it is — the same reason
   a cancellation's final approval runs the document's own cancel rather than
   re-implementing it (vendor/scm/lib/use-cancel-request-actions.ts).

   A refused apply is NOT an error for the submit: the amendment exists and sits
   in the queue as REQUESTED, which is exactly where it sat before this existed,
   and the desk that raised it can still sign it. So the failure is swallowed
   here and reported as `autoApplied: 0` — the notice then says 'waiting for
   Logistic' instead of 'applied', which is the truth in that case.

   It lives in this ONE hook because all four surfaces that raise an amendment
   (SO detail, MobileNewSO, MobileDeliveryPlanning, DeliveryFieldsDrawer) call
   it — a chain written at the call sites would be four chains, and the one that
   drifted would be the one that left the row pending. */
async function createAmendmentThenApplyOwn(
  docNo: string,
  idempotencyKey: string | undefined,
  body: unknown,
): Promise<CreateAmendmentResult> {
  const created = await authedFetch<CreateAmendmentResult>(
    `/mfg-sales-orders/${docNo}/amendments`,
    idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) }),
  );
  const ids = created.selfApprovable ?? [];
  if (ids.length === 0) return { ...created, autoApplied: 0, notApplied: [] };
  let autoApplied = 0;
  const notApplied: string[] = [];
  for (const id of ids) {
    try {
      await authedFetch(`/so-amendments/${id}/approve-so`, { method: 'PATCH' });
      autoApplied += 1;
    } catch {
      notApplied.push(id);
    }
  }
  return { ...created, autoApplied, notApplied };
}

export const useCreateAmendment = () => {
  const qc = useQueryClient();
  return useMutation({
    /* `headerChanges` carries the FROZEN header fields (Delivery Date etc.) the
       processing lock refuses on a direct PATCH — without it those changes had
       nowhere to go and were silently dropped (Owner 2026-07-16). Optional: a
       line-only amendment omits it. The server 400s `amendment_empty` when both
       halves are empty, so a no-op submit can no longer create a blank
       amendment in the approval queue. */
    mutationFn: ({ docNo, idempotencyKey, ...body }: {
      docNo: string;
      idempotencyKey?: string;
      reason?: string;
      lines: CreateAmendmentLine[];
      headerChanges?: SoAmendmentHeaderChanges;
    }) =>
      createAmendmentThenApplyOwn(docNo, idempotencyKey, body),
    onSuccess: (_, vars) => {
      invalidateAmendmentSideEffects(qc);
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
    },
  });
};

export const useSupplierConfirm = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; ref: string; note?: string; attachmentKey?: string }) =>
      authedFetch<{ amendment: AmendmentRow }>(`/so-amendments/${id}/supplier-confirm`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => invalidateAmendmentSideEffects(qc, vars.id),
  });
};

export const useApproveSo = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      authedFetch<{
        amendment: AmendmentRow;
        revision: number;
        poFollowUps?: Array<{ poId: string; poNumber: string; amendmentId: string; amendmentNo: string }>;
        warnings?: string[];
      }>(`/so-amendments/${id}/approve-so`, { method: 'PATCH' }),
    onSuccess: (_, vars) => invalidateAmendmentSideEffects(qc, vars.id),
  });
};

export const useApprovePo = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      authedFetch<{
        amendment: AmendmentRow;
        revisedPurchaseOrders: Array<{ poNumber: string; revision: number }>;
        warnings?: string[];
      }>(
        `/so-amendments/${id}/approve-po`, { method: 'PATCH' },
      ),
    onSuccess: (_, vars) => invalidateAmendmentSideEffects(qc, vars.id),
  });
};

export const useSendAmendment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      authedFetch<{ amendment: AmendmentRow }>(`/so-amendments/${id}/send`, { method: 'PATCH' }),
    onSuccess: (_, vars) => invalidateAmendmentSideEffects(qc, vars.id),
  });
};

export const useRejectAmendment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      authedFetch<{ amendment: AmendmentRow }>(`/so-amendments/${id}/reject`, {
        method: 'PATCH', body: JSON.stringify({ reason }),
      }),
    onSuccess: (_, vars) => invalidateAmendmentSideEffects(qc, vars.id),
  });
};

export const usePurchaserOk = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      authedFetch<{ amendment: AmendmentRow }>(`/so-amendments/${id}/purchaser-ok`, { method: 'PATCH' }),
    onSuccess: (_, vars) => invalidateAmendmentSideEffects(qc, vars.id),
  });
};

export const useFlagAmendmentLane = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      authedFetch<{ amendment: AmendmentRow }>(`/so-amendments/${id}/flag-lane`, {
        method: 'PATCH', body: JSON.stringify({ note }),
      }),
    onSuccess: (_, vars) => invalidateAmendmentSideEffects(qc, vars.id),
  });
};

export const useChangeAmendmentLane = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, lane, note }: { id: string; lane: 'LINES' | 'DELIVERY' | 'PRICE'; note: string }) =>
      authedFetch<{ amendment: AmendmentRow }>(`/so-amendments/${id}/lane`, {
        method: 'PATCH', body: JSON.stringify({ lane, note }),
      }),
    onSuccess: (_, vars) => invalidateAmendmentSideEffects(qc, vars.id),
  });
};

export const useWithdrawAmendment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      authedFetch<{ amendment: AmendmentRow }>(`/so-amendments/${id}/withdraw`, {
        method: 'PATCH', body: JSON.stringify({ reason }),
      }),
    onSuccess: (_, vars) => invalidateAmendmentSideEffects(qc, vars.id),
  });
};

