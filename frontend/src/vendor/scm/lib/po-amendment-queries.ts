
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { idempotentInit } from '../../../lib/idempotency';
import { PO_AMENDMENT_APPROVALS_KEY } from '../../../hooks/useAmendmentApprovals';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import type { AmendmentFieldKind } from './amendment-routing';
import { amendmentVariantSummaries } from './so-amendment-line-diff';

export type PoAmendmentRow = {
  id: string;
  po_id: string;
  po_number: string;
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
};

export type PoAmendmentLine = {
  id: string;
  amendment_id: string;
  purchase_order_item_id: string | null;
  change_type: string;
  new_item_code: string | null;
  new_material_name: string | null;
  new_variants: unknown;
  new_qty: number | null;
  new_unit_price_sen: number | null;
  new_delivery_date: string | null;
  old_snapshot: unknown;
};

export const poLineFieldKinds = (l: PoAmendmentLine): AmendmentFieldKind[] => {
  if (l.change_type === 'ADD' || l.change_type === 'REMOVE') return ['LINE'];
  const old = (l.old_snapshot as { item_code?: string | null; qty?: number | null; unit_price_sen?: number | null; delivery_date?: string | null } | null) ?? {};
  const kinds: AmendmentFieldKind[] = [];
  if (l.new_item_code != null && l.new_item_code !== (old.item_code ?? null)) kinds.push('SPEC');
  const spec = amendmentVariantSummaries({ change_type: l.change_type, new_variants: l.new_variants, old_snapshot: l.old_snapshot });
  if (l.new_variants != null && spec.from !== spec.to) kinds.push('VARIANT');
  if (l.new_qty != null && l.new_qty !== (old.qty ?? null)) kinds.push('QTY');
  if (l.new_unit_price_sen != null && l.new_unit_price_sen !== (old.unit_price_sen ?? null)) kinds.push('COST');
  if (l.new_delivery_date != null && l.new_delivery_date !== (old.delivery_date ?? null)) kinds.push('DELIVERY');
  return kinds;
};

export type PoAmendmentHeaderChanges = Record<string, string | null>;

/** Route a PO header change key to its field atom (supplier -> SUPPLIER, delivery
    date -> DELIVERY). `notes` is not routable. */
export const poHeaderFieldKind = (key: string): AmendmentFieldKind | null =>
  key === 'supplier_id' ? 'SUPPLIER' : key === 'expected_at' ? 'DELIVERY' : null;

export type PoAmendmentDetail = {
  amendment: PoAmendmentRow & Record<string, unknown> & {
    approved_by?: string | null;
    approved_at?: string | null;
    header_changes?: PoAmendmentHeaderChanges | null;
    old_header_snapshot?: PoAmendmentHeaderChanges | null;
  };
  lines: PoAmendmentLine[];
  purchaseOrder: {
    id: string;
    po_number: string;
    status: string;
    revision: number;
    supplier_id?: string | null;
    expected_at?: string | null;
  } | null;
  viewerIsRequester?: boolean;
};

export type CreatePoAmendmentLine = {
  purchaseOrderItemId?: string | null;
  changeType: string;
  newMaterialCode?: string | null;
  newMaterialName?: string | null;
  newVariants?: unknown;
  newQty?: number | null;
  newUnitPriceSen?: number | null;
  newDeliveryDate?: string | null;
  oldSnapshot?: unknown;
};

const invalidatePoAmendmentSideEffects = (
  qc: ReturnType<typeof useQueryClient>,
  id?: string,
  poId?: string,
) => {
  qc.invalidateQueries({ queryKey: ['po-amendments'] });
  if (id) qc.invalidateQueries({ queryKey: ['po-amendment-detail', id] });
  qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
  qc.invalidateQueries({ queryKey: ['mfg-purchase-orders-paged'] });
  if (poId) qc.invalidateQueries({ queryKey: ['mfg-purchase-order-detail', poId] });
  else qc.invalidateQueries({ queryKey: ['mfg-purchase-order-detail'] });
  qc.invalidateQueries({ queryKey: ['po-revisions'] });
  /* The sidebar's red count of PO amendments awaiting THIS user's confirmation
     (hooks/useAmendmentApprovals). Every gate that resolves one passes through
     here, so the invalidation lives at this one point rather than on each
     screen: the owner's ask was "审批后就根据目前需要的单号改变", and a screen
     that forgot to call it would look exactly like the 60s poll being slow. The
     key is IMPORTED, not respelled — a second copy would drift silently and
     show as a badge that just never updates. */
  void qc.invalidateQueries({ queryKey: PO_AMENDMENT_APPROVALS_KEY });
};

export const usePoAmendments = () => useQuery({
  queryKey: ['po-amendments'],
  queryFn: () => authedFetch<{ amendments: PoAmendmentRow[] }>(`/po-amendments`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const usePoAmendmentDetail = (id: string | null) => useQuery({
  queryKey: ['po-amendment-detail', id],
  queryFn: () => authedFetch<PoAmendmentDetail>(`/po-amendments/${id}`),
  enabled: Boolean(id),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useCreatePoAmendment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: {
      poId: string;
      idempotencyKey?: string;
      reason?: string;
      headerChanges?: PoAmendmentHeaderChanges;
      lines: CreatePoAmendmentLine[];
    }) =>
      authedFetch<{ amendment: PoAmendmentRow }>(
        `/po-amendments`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) }),
      ),
    onSuccess: (_, vars) => invalidatePoAmendmentSideEffects(qc, undefined, vars.poId),
  });
};


export const useApprovePoAmendment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; poId?: string }) =>
      authedFetch<{
        amendment: PoAmendmentRow;
        revision: number;
        warnings?: string[];
      }>(`/po-amendments/${id}/approve`, { method: 'PATCH' }),
    onSuccess: (_, vars) => invalidatePoAmendmentSideEffects(qc, vars.id, vars.poId),
  });
};

export const useRejectPoAmendment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string; poId?: string }) =>
      authedFetch<{
        amendment: PoAmendmentRow;
        releasedToStock?: Array<{ poItemId: string; itemCode: string; qty: number }>;
        releaseWarnings?: string[];
      }>(`/po-amendments/${id}/reject`, {
        method: 'PATCH', body: JSON.stringify({ reason }),
      }),
    onSuccess: (_, vars) => invalidatePoAmendmentSideEffects(qc, vars.id, vars.poId),
  });
};

export const useWithdrawPoAmendment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string; poId?: string }) =>
      authedFetch<{ amendment: PoAmendmentRow }>(`/po-amendments/${id}/withdraw`, {
        method: 'PATCH', body: JSON.stringify({ reason }),
      }),
    onSuccess: (_, vars) => invalidatePoAmendmentSideEffects(qc, vars.id, vars.poId),
  });
};
