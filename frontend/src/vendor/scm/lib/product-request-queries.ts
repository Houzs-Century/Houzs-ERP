// ----------------------------------------------------------------------------
// product-request-queries — a request for a new product or a repack (owner
// 2026-10-06: to request new product / repack product; 要审批, Purchaser 批;
// Sales 都能提; 然后这个会连接 purchase consignment order). Server:
// backend/src/scm/routes/product-requests.ts.
//
// The salesperson asks — an existing SKU or a new Model by name, in a fabric,
// seat size and leg size, for a use, delivered where and by when. The
// Purchaser approves or rejects, builds the new Model + SKU from the request,
// then raises the Purchase Consignment Order from it on PC Order New
// (?fromProductRequest=). The desktop page, the phone screen and the PC Order
// form all read and write through these hooks; the status words live here once.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';

export type ProductRequestType = 'NEW_PRODUCT' | 'REPACK';
export type ProductRequestApplication = 'SHOWROOM' | 'CUSTOMER_ORDER' | 'SAMPLE' | 'FAIR_EXHIBITION';
export type ProductRequestStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'PCO_ISSUED' | 'CLOSED';

export type ProductRequest = {
  id: string;
  request_no: string;
  request_type: ProductRequestType;
  application: ProductRequestApplication;
  requested_by: number;
  requested_by_name: string | null;
  /** An existing SKU's code — picked by the requester, or built by the Purchaser from a new Model. */
  item_code: string | null;
  /** The Model the catalogue does not have yet, by the requester's name for it. */
  proposed_model_name: string | null;
  model_id: string | null;
  category: string;
  compartment: string | null;
  fabric_code: string | null;
  seat_size: string | null;
  leg_size: string | null;
  qty: number;
  special_remarks: string | null;
  delivery_location_id: string | null;
  expected_delivery_date: string | null;
  status: ProductRequestStatus;
  decision_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  pco_id: string | null;
  created_at: string;
  updated_at: string;
  /** The PC Order raised from it, when one was. */
  pco: { id: string; pcNumber: string; status: string; expectedAt: string | null } | null;
  deliveryLocation: { id: string; code: string; name: string } | null;
  model: { id: string; modelCode: string; name: string } | null;
};

export type ProductRequestInput = {
  requestType: ProductRequestType;
  application: ProductRequestApplication;
  itemCode: string | null;
  proposedModelName: string | null;
  category: string;
  compartment: string | null;
  fabricCode: string | null;
  seatSize: string | null;
  legSize: string | null;
  qty: number;
  specialRemarks: string | null;
  deliveryLocationId: string | null;
  expectedDeliveryDate: string | null;
};

/** Each status in words, and the colour it reads in — one home for desktop and phone. */
export const REQUEST_STATUS: Record<ProductRequestStatus, { label: string; tone: string }> = {
  REQUESTED: { label: 'Requested', tone: 'var(--c-orange)' },
  APPROVED: { label: 'Approved', tone: 'var(--c-green, #2f7d32)' },
  REJECTED: { label: 'Rejected', tone: 'var(--c-festive-b, #B8331F)' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'var(--fg-muted)' },
  PCO_ISSUED: { label: 'PC Order raised', tone: 'var(--c-secondary-a, #2F5D4F)' },
  CLOSED: { label: 'Closed', tone: 'var(--fg-muted)' },
};
export const REQUEST_TYPE_LABEL: Record<ProductRequestType, string> = { NEW_PRODUCT: 'New product', REPACK: 'Repack' };
/* English only on screen (owner 2026-10-07: 只要英文); Fair Exhibition added the same day. */
export const APPLICATION_LABEL: Record<ProductRequestApplication, string> = { SHOWROOM: 'Showroom', CUSTOMER_ORDER: 'Customer order', SAMPLE: 'Sample', FAIR_EXHIBITION: 'Fair exhibition' };

/** The requester may still change it: nobody has decided, or it came back. */
export const requesterMayChange = (r: Pick<ProductRequest, 'status'>): boolean => r.status === 'REQUESTED' || r.status === 'REJECTED';
/** Waiting for the Purchaser. */
export const awaitsPurchaser = (r: Pick<ProductRequest, 'status'>): boolean => r.status === 'REQUESTED';
/** Approved and asking for a Model the catalogue has not got yet — the Purchaser builds it first. */
export const needsModel = (r: Pick<ProductRequest, 'status' | 'item_code'>): boolean => r.status === 'APPROVED' && !r.item_code;
/** Approved, its SKU known — a PC Order may be raised from it. */
export const mayRaisePco = (r: Pick<ProductRequest, 'status' | 'item_code'>): boolean => r.status === 'APPROVED' && !!r.item_code;
/** The Purchaser may close it. */
export const mayClose = (r: Pick<ProductRequest, 'status'>): boolean => r.status === 'APPROVED' || r.status === 'PCO_ISSUED';

/** The product, in one line: the SKU code, or the proposed Model name marked new. */
export const productText = (r: Pick<ProductRequest, 'item_code' | 'proposed_model_name'>): string =>
  r.item_code ? r.item_code : `${r.proposed_model_name ?? '—'} (new)`;

/** The spec, in one line: compartment · fabric · seat · leg. */
export const specText = (r: Pick<ProductRequest, 'compartment' | 'fabric_code' | 'seat_size' | 'leg_size'>): string =>
  [r.compartment, r.fabric_code, r.seat_size ? `seat ${r.seat_size}` : null, r.leg_size ? `leg ${r.leg_size}` : null].filter(Boolean).join(' · ') || '—';

type ListAnswer = { requests: ProductRequest[]; approver: boolean; mayRequest: boolean };

export const useProductRequests = (mine = false) => useQuery({
  queryKey: ['product-requests', mine ? 'mine' : 'all'],
  queryFn: () => authedFetch<ListAnswer>(`/product-requests${mine ? '?mine=1' : ''}`),
  staleTime: 15_000,
});

export const useProductRequest = (id: string | null) => useQuery({
  queryKey: ['product-request', id],
  queryFn: () => authedFetch<{ request: ProductRequest; approver: boolean; mayRequest: boolean }>(`/product-requests/${id}`),
  enabled: !!id,
});

const invalidate = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['product-requests'] });
  void qc.invalidateQueries({ queryKey: ['product-request'] });
};

export const useCreateProductRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProductRequestInput) => authedFetch<{ ok: true; request: ProductRequest }>('/product-requests', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => invalidate(qc),
    onError: writeFailedAs('The request was not sent'),
  });
};

export const useUpdateProductRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Partial<ProductRequestInput>) =>
      authedFetch<{ ok: true; request: ProductRequest }>(`/product-requests/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => invalidate(qc),
    onError: writeFailedAs('The request was not changed'),
  });
};

export const useWithdrawProductRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true }>(`/product-requests/${id}/withdraw`, { method: 'POST', body: '{}' }),
    onSuccess: () => invalidate(qc),
    onError: writeFailedAs('The request was not withdrawn'),
  });
};

export const useApproveProductRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string | null }) =>
      authedFetch<{ ok: true; needsModel: boolean }>(`/product-requests/${id}/approve`, { method: 'POST', body: JSON.stringify({ note: note ?? null }) }),
    onSuccess: () => invalidate(qc),
    onError: writeFailedAs('The request was not approved'),
  });
};

export const useRejectProductRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      authedFetch<{ ok: true }>(`/product-requests/${id}/reject`, { method: 'POST', body: JSON.stringify({ note }) }),
    onSuccess: () => invalidate(qc),
    onError: writeFailedAs('The request was not rejected'),
  });
};

/** The Purchaser builds the new Model and its first SKU from an approved
    request. The SKU code defaults on the server to `<MODEL>-<compartment>` for
    a sofa with a compartment, else the model code. */
export const useCreateModelFromRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, modelCode, skuCode, name }: { id: string; modelCode: string; skuCode?: string | null; name?: string | null }) =>
      authedFetch<{ ok: true; model: { id: string; modelCode: string; created: boolean }; sku: { id: string; code: string }; request: ProductRequest }>(
        `/product-requests/${id}/create-model`, { method: 'POST', body: JSON.stringify({ modelCode, skuCode: skuCode ?? null, name: name ?? null }) },
      ),
    onSuccess: () => {
      invalidate(qc);
      void qc.invalidateQueries({ queryKey: ['mfg-products'] });
      void qc.invalidateQueries({ queryKey: ['product-models'] });
    },
    onError: writeFailedAs('The Model was not created'),
  });
};

export const useCloseProductRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string | null }) =>
      authedFetch<{ ok: true }>(`/product-requests/${id}/close`, { method: 'POST', body: JSON.stringify({ note: note ?? null }) }),
    onSuccess: () => invalidate(qc),
    onError: writeFailedAs('The request was not closed'),
  });
};

/** Where the Purchaser raises the PC Order from a request: PC Order New,
    prefilled from it. One home, so the desktop and the phone land on the same door. */
export const pcoNewFromRequestPath = (id: string): string => `/scm/purchase-consignment-orders/new?fromProductRequest=${encodeURIComponent(id)}`;
