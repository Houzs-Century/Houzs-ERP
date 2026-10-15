// ----------------------------------------------------------------------------
// product-request-queries — a request for new products or repacks (owner
// 2026-10-06: to request new product / repack product; 要审批, Purchaser 批;
// Sales 都能提; 然后这个会连接 purchase consignment order; 2026-10-15 方案 A: a
// header plus LINES, like a PC Order). Server:
// backend/src/scm/routes/product-requests.ts.
//
// The salesperson asks — each line an existing SKU or a new Model by name, in
// a fabric, seat size and leg size — for a use, delivered where and by when.
// The Purchaser approves or rejects the whole request, builds each new-Model
// line's Model + SKU, then raises ONE Purchase Consignment Order from it on PC
// Order New (?fromProductRequest=). The desktop page, the phone screen and the
// PC Order form all read and write through these hooks; the status words live
// here once.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';
import { fetchDocFileBlobUrl, type PvFile, type PvFilePayload } from './payment-voucher-queries';

export type ProductRequestType = 'NEW_PRODUCT' | 'REPACK';
export type ProductRequestApplication = 'SHOWROOM' | 'CUSTOMER_ORDER' | 'SAMPLE' | 'FAIR_EXHIBITION';
export type ProductRequestStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'PCO_ISSUED' | 'CLOSED';

export type ProductRequestLine = {
  id: string;
  line_no: number;
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
  /** The agreed unit price the requester named (owner 2026-10-08, 方案 C); the PC Order line is seeded from it. Optional. */
  unit_price_sen: number | null;
  remarks: string | null;
  model: { id: string; modelCode: string; name: string } | null;
};

export type ProductRequest = {
  id: string;
  request_no: string;
  request_type: ProductRequestType;
  application: ProductRequestApplication;
  requested_by: number;
  requested_by_name: string | null;
  special_remarks: string | null;
  delivery_location_id: string | null;
  expected_delivery_date: string | null;
  /** The supplier the requester named (方案 C); the PC Order's Creditor is seeded from it. Optional. */
  supplier_id: string | null;
  status: ProductRequestStatus;
  decision_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  pco_id: string | null;
  created_at: string;
  updated_at: string;
  lines: ProductRequestLine[];
  /** The PC Order raised from it, when one was. */
  pco: { id: string; pcNumber: string; status: string; expectedAt: string | null } | null;
  deliveryLocation: { id: string; code: string; name: string } | null;
  supplier: { id: string; code: string; name: string } | null;
};

export type ProductRequestLineInput = {
  itemCode: string | null;
  proposedModelName: string | null;
  category: string;
  compartment: string | null;
  fabricCode: string | null;
  seatSize: string | null;
  legSize: string | null;
  qty: number;
  unitPriceSen: number | null;
  remarks: string | null;
};

export type ProductRequestInput = {
  requestType: ProductRequestType;
  application: ProductRequestApplication;
  specialRemarks: string | null;
  deliveryLocationId: string | null;
  expectedDeliveryDate: string | null;
  supplierId: string | null;
  lines: ProductRequestLineInput[];
};

/** An empty line, as the form starts one. */
export const emptyRequestLine = (): ProductRequestLineInput => ({
  itemCode: null, proposedModelName: null, category: 'SOFA', compartment: null, fabricCode: null, seatSize: null, legSize: null, qty: 1, unitPriceSen: null, remarks: null,
});

/** A stored line, back in the shape the form edits. */
export const lineToInput = (l: ProductRequestLine): ProductRequestLineInput => ({
  itemCode: l.item_code, proposedModelName: l.proposed_model_name, category: l.category, compartment: l.compartment,
  fabricCode: l.fabric_code, seatSize: l.seat_size, legSize: l.leg_size, qty: l.qty, unitPriceSen: l.unit_price_sen, remarks: l.remarks,
});

/** The supplier picker for a requester (a salesperson holds no procurement
    area, so /suppliers is closed to them): ACTIVE suppliers, id / code / name. */
export const useProductRequestSupplierOptions = () => useQuery({
  queryKey: ['product-request-supplier-options'],
  queryFn: () => authedFetch<{ suppliers: Array<{ id: string; code: string; name: string }> }>('/product-requests/supplier-options'),
  staleTime: 60_000,
});

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
/** The lines still asking for a Model the catalogue has not got yet. */
export const linesNeedingModel = (r: Pick<ProductRequest, 'lines'>): ProductRequestLine[] => r.lines.filter((l) => !l.item_code);
/** Approved and some line asks for a Model the catalogue has not got yet — the Purchaser builds it first. */
export const needsModel = (r: Pick<ProductRequest, 'status' | 'lines'>): boolean => r.status === 'APPROVED' && linesNeedingModel(r).length > 0;
/** Approved, every line's SKU known — a PC Order may be raised from it. */
export const mayRaisePco = (r: Pick<ProductRequest, 'status' | 'lines'>): boolean => r.status === 'APPROVED' && r.lines.length > 0 && linesNeedingModel(r).length === 0;
/** The Purchaser may close it. */
export const mayClose = (r: Pick<ProductRequest, 'status'>): boolean => r.status === 'APPROVED' || r.status === 'PCO_ISSUED';

/** One line's product, in a word: the SKU code, or the proposed Model name marked new. */
export const lineProductText = (l: Pick<ProductRequestLine, 'item_code' | 'proposed_model_name'>): string =>
  l.item_code ? l.item_code : `${l.proposed_model_name ?? '—'} (new)`;

/** The request's products, in one line: the first product, then how many more. */
export const productText = (r: Pick<ProductRequest, 'lines'>): string => {
  if (r.lines.length === 0) return '—';
  const first = lineProductText(r.lines[0]);
  return r.lines.length === 1 ? first : `${first} +${r.lines.length - 1} more`;
};

/** Every unit on the request. */
export const totalQty = (r: Pick<ProductRequest, 'lines'>): number => r.lines.reduce((sum, l) => sum + (Number(l.qty) || 0), 0);

/** One line's spec: fabric · seat · leg. The stored compartment (owner 2026-10-15: remove
    compartment from the form) is kept on the row but no longer shown or asked. */
export const specText = (l: Pick<ProductRequestLine, 'fabric_code' | 'seat_size' | 'leg_size'>): string =>
  [l.fabric_code, l.seat_size ? `seat ${l.seat_size}` : null, l.leg_size ? `leg ${l.leg_size}` : null].filter(Boolean).join(' · ') || '—';

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

/** A change to the header, and — when `lines` is sent — the whole set of lines replaced. */
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
      authedFetch<{ ok: true; needsModel: boolean; pendingModels: number }>(`/product-requests/${id}/approve`, { method: 'POST', body: JSON.stringify({ note: note ?? null }) }),
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

/** The Purchaser builds one line's new Model and its first SKU from an
    approved request. The SKU code defaults on the server to
    the model code (the Purchaser may type another). */
export const useCreateModelFromRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, lineId, modelCode, skuCode, name }: { id: string; lineId: string; modelCode: string; skuCode?: string | null; name?: string | null }) =>
      authedFetch<{ ok: true; model: { id: string; modelCode: string; created: boolean }; sku: { id: string; code: string }; lineId: string; request: ProductRequest }>(
        `/product-requests/${id}/lines/${lineId}/create-model`, { method: 'POST', body: JSON.stringify({ modelCode, skuCode: skuCode ?? null, name: name ?? null }) },
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

/* The request's files (owner 2026-10-15: 需要可以 attach 文件功能) — the same
   factory the payment request's bill rides (doc-files.ts): quotation, photos,
   a drawing. Attach on the request after it exists; the form uploads what was
   picked once the request is created. */
export const useProductRequestFiles = (id: string | null) => useQuery({
  queryKey: ['product-request-files', id],
  queryFn: () => authedFetch<{ files: PvFile[] }>(`/product-requests/${id}/files`),
  enabled: !!id,
});

export const useUploadProductRequestFile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }: { id: string; file: PvFilePayload }) =>
      authedFetch<{ ok: true; file: PvFile }>(`/product-requests/${id}/files`, {
        method: 'POST', body: JSON.stringify({ fileName: file.name, mime: file.mime, dataBase64: file.dataBase64 }),
      }),
    onSuccess: (_d, vars) => { void qc.invalidateQueries({ queryKey: ['product-request-files', vars.id] }); },
    onError: writeFailedAs('The file was not attached'),
  });
};

export const useDeleteProductRequestFile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, fileId }: { id: string; fileId: string }) =>
      authedFetch<{ ok: true }>(`/product-requests/${id}/files/${fileId}`, { method: 'DELETE' }),
    onSuccess: (_d, vars) => { void qc.invalidateQueries({ queryKey: ['product-request-files', vars.id] }); },
    onError: writeFailedAs('The file was not removed'),
  });
};

export const fetchProductRequestFileBlobUrl = (id: string, fileId: string): Promise<{ url: string; contentType: string }> =>
  fetchDocFileBlobUrl(`/product-requests/${id}/files/${fileId}`);

/** Where the Purchaser raises the PC Order from a request: PC Order New,
    prefilled from it. One home, so the desktop and the phone land on the same door. */
export const pcoNewFromRequestPath = (id: string): string => `/scm/purchase-consignment-orders/new?fromProductRequest=${encodeURIComponent(id)}`;
