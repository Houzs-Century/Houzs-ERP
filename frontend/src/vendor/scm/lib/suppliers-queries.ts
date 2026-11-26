
import { useMemo } from 'react';
import { useListMrpEnrichmentChunks } from './list-mrp-enrichment-chunks';
import type { ListMrpStatus } from '../../../lib/listMrpStatus';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { poListParams, type PoListFilterParams } from './po-list-export';
import type { PoListLine } from './po-line-export-columns';
import { applyListMrpEnrichment, type EnrichableMrpRow, type ListMrpEnrichment } from '../../../lib/listMrpEnrichment';
import { writeFailed, writeFailedAs, reportInBandFailure, type InBandFailure } from './mutation-error';
import { idempotentInit } from '../../../lib/idempotency';
import { invalidateSoLists } from './sales-order-queries';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import { supplierCodeLetter, type SupplierCodeKind } from '../../shared/supplier-code';
import type { OriginAssignment } from './flow-queries';
import type { OutstandingScope } from '../../../lib/outstandingEmptyReason';

export type SupplierStatus = 'ACTIVE' | 'INACTIVE' | 'BLOCKED';
export type Currency = 'MYR' | 'RMB' | 'CNY' | 'USD' | 'SGD';
export type MaterialKind = 'mfg_product' | 'fabric' | 'raw';
export type { PoStatus } from './po-status';
import type { PoStatus } from './po-status';

export type StatementType = 'OPEN_ITEM' | 'BALANCE_FORWARD' | 'NO_STATEMENT';
export type AgingBasis    = 'INVOICE_DATE' | 'DUE_DATE';

export type SupplierRow = {
  /* The Finance part (vendor/shared/supplier-finance-fields: TIN, business reg,
     registration, exemption, credit limit, statement type, aging basis) is
     OPTIONAL: the server leaves it out for a caller who is not Finance
     (owner 2026-09-30, 采购只看采购的部分). */
  id: string;
  code: string;
  name: string;
  whatsapp_number: string | null;
  email: string | null;
  /* Email 2 / Email 3 (owner 2026-11-09) — the PO email copies them (Cc). */
  email2?: string | null;
  email3?: string | null;
  contact_person: string | null;
  phone: string | null;
  address: string | null;
  address1?: string | null;
  address2?: string | null;
  address3?: string | null;
  address4?: string | null;
  state: string | null;
  payment_terms: string | null;
  status: SupplierStatus;
  rating: number;
  notes: string | null;
  supplier_type: string | null;
  category: string | null;
  tin_number?: string | null;
  business_reg_no?: string | null;
  postcode: string | null;
  area: string | null;
  city: string | null;
  mobile: string | null;
  fax: string | null;
  website: string | null;
  attention: string | null;
  business_nature: string | null;
  country: string;
  currency: Currency;
  statement_type?: StatementType;
  aging_basis?: AgingBasis;
  credit_limit_sen?: number;
  registration_no?: string | null;
  nature_of_business: string | null;
  exemption_no?: string | null;
  phone2: string | null;
  /* Supplier Maintenance (owner 2026-10-02) — also the Finance part, so also
     optional: the bank a payment carries, and whether purchasing shares the
     supplier (false = Finance's alone). Base-table reads only (detail / create /
     patch); the list view predates them. */
  bank_name?: string | null;
  bank_account_no?: string | null;
  bank_account_name?: string | null;
  for_purchasing?: boolean;
  created_at: string;
  updated_at: string;
  derived_category?: string | null;
};

/** PR — Commander 2026-05-27 ("跟着 Product Maintenance 的排版"):
 *  Per-category supplier cost matrix on supplier_material_bindings
 *  (migration 0089). Two concrete shapes the UI cares about; everything
 *  else (or null) → fall back to unit_price_sen.
 *
 *  SOFA:     { [seatHeight]: { P1?: centi, P2?: centi, P3?: centi } }
 *  BEDFRAME: { P1?: centi, P2?: centi }
 *
 *  Stored cell type is `number` (centi); we widen to `unknown` on the wire
 *  because the column is JSONB and the server is the source of truth.
 */
export type SofaPriceMatrix     = Record<string, { P1?: number; P2?: number; P3?: number; P4?: number }>;
export type BedframePriceMatrix = { P1?: number; P2?: number };
export type PriceMatrix         = SofaPriceMatrix | BedframePriceMatrix | Record<string, unknown>;

export type BindingRow = {
  id: string;
  supplier_id: string;
  material_kind: MaterialKind;
  item_code: string;
  ac_item_code: string | null;
  material_name: string;
  supplier_sku: string;
  unit_price_sen: number;
  currency: Currency;
  lead_time_days: number;
  payment_terms_override: string | null;
  moq: number;
  price_valid_from: string | null;
  price_valid_to: string | null;
  is_main_supplier: boolean;
  notes: string | null;
  price_matrix: PriceMatrix | null;
  is_cost_anchor: boolean;
  created_at: string;
  updated_at: string;
};

/** Migration 0324 — every PO row carries the HOLD MARKER, because the list
 *  renders it BESIDE the status pill rather than instead of it. */
export type PoHoldFields = {
  on_hold?: boolean | null;
  hold_reason?: string | null;
  held_at?: string | null;
  held_by?: string | null;
};

export type PoHeaderRow = PoHoldFields & {
  id: string;
  po_number: string;
  linked_ac_docno?: string | null;
  lines?: PoListLine[];
  supplier_id: string;
  status: PoStatus;
  po_date: string;
  expected_at: string | null;
  supplier_delivery_date_2?: string | null;
  supplier_delivery_date_3?: string | null;
  supplier_delivery_date_4?: string | null;
  currency: Currency;
  subtotal_sen: number;
  tax_sen: number;
  total_sen: number;
  notes: string | null;
  submitted_at: string | null;
  received_at: string | null;
  cancelled_at: string | null;
  cancel_reason?: string | null;
  revision?: number | null;
  purchase_location_id: string | null;
  /** List endpoint embeds the purchase-location warehouse (id/code/name) for
      the "Purchase Location" column + Excel export (owner 2026-08-05). */
  purchase_location?: { id: string; code: string; name: string } | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  supplier?: {
    id: string;
    code: string;
    name: string;
    contact_person?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
  } | null;
  items?: PoItemSummary[];
  has_children?: boolean;
  /** Collapsed "Assigned SO" column (owner 2026-07-31) — the distinct Sales
      Order(s) this PO's supply is assigned to, resolved server-side by the SAME
      precedence engine the drill-down uses (delivered → DO-lock > stored link >
      MRP floating). `assigned_so_linked` is true when ANY line carries a stored
      so_item_id, so the column can mark an MRP-only guess apart from a binding. */
  assigned_sos?: OriginAssignment[];
  assigned_so_linked?: boolean;
  assigned_so_provenance?: OriginAssignment[];
  /** "Delivered" column (owner 2026-07-31) — the Delivery Order(s) that have
      shipped this PO's goods (batch_no = the PO number) + qty per DO, resolved
      server-side. EVERY DO renders (no collapse); empty when nothing shipped. */
  delivered_dos?: Array<{ doNo: string; qty: number }>;
  transfer_to_grns?: Array<{ id: string; grnNumber: string; receivedAt?: string | null } | string>;
};

export type PoItemSummary = {
  item_code: string;
  material_name: string;
  qty: number;
  /** Supplier's own SKU for this line (owner 2026-08-05) — the list's
      "Supplier SKU" column / export; null on lines without a binding. */
  supplier_sku?: string | null;
};

export type PoItemRow = {
  id: string;
  purchase_order_id: string;
  binding_id: string | null;
  material_kind: MaterialKind;
  item_code: string;
  material_name: string;
  supplier_sku: string | null;
  qty: number;
  unit_price_sen: number;
  line_total_sen: number;
  received_qty: number;
  notes: string | null;
  item_group?: string | null;
  description?: string | null;
  description2?: string | null;
  uom?: string;
  discount_sen?: number;
  unit_cost_sen?: number;
  gap_inches?: number | null;
  divan_height_inches?: number | null;
  divan_price_sen?: number;
  leg_height_inches?: number | null;
  leg_price_sen?: number;
  custom_specials?: unknown;
  line_suffix?: string | null;
  special_order_price_sen?: number;
  variants?: Record<string, unknown> | null;
  delivery_date?: string | null;
  line_delivery_date_overridden?: boolean | null;
  warehouse_id?: string | null;
  supplier_delivery_date_2?: string | null;
  supplier_delivery_date_3?: string | null;
  supplier_delivery_date_4?: string | null;
  receipts?: PoLineReceipt[];
  photo_urls?: string[] | null;
  so_item_id?: string | null;
  /** 2026-06-12 — stamped by GET /:id (so_item_id → SO doc_no) for the PO
      PDF's "For SO" provenance column (relabelled from "Transferred SO",
      owner 2026-08-07). Null for manual / MRP lines. */
  so_doc_no?: string | null;
  so_drift?: {
    specPo: string; specSo: string;
    itemPo: string; itemSo: string;
    itemChanged: boolean;
    warehouseChanged: boolean;
    warehousePoId: string | null;
    warehouseSoId: string | null;
  } | null;
  allocations?: PoLineAllocation[];
};

/** One slice of a PO line (mig 0235): `qty` units for `so_doc_no`'s line, or
    for STOCK when so_item_id is null. `seq` is 1-based dense; the printable
    sub-number is `${po_number}-${String(seq).padStart(2, "0")}`. */
export type PoLineAllocation = {
  id: string;
  seq: number;
  qty: number;
  so_item_id: string | null;
  so_doc_no: string | null;
};

export type PoLineReceipt = { grnNumber: string; qty: number; status: string };


export function useSuppliers(opts?: { status?: SupplierStatus; search?: string }) {
  return useQuery<SupplierRow[]>({
    queryKey: ['suppliers', opts?.status ?? 'all', opts?.search ?? ''],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      if (opts?.status) params.set('status', opts.status);
      if (opts?.search) params.set('search', opts.search);
      const res = await authedFetch<{ suppliers: SupplierRow[] }>(
        `/suppliers${params.toString() ? `?${params.toString()}` : ''}`,
        { signal },
      );
      return res.suppliers;
    },
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

export function useSuppliersPaged(params: {
  page: number;
  pageSize: number;
  status?: SupplierStatus;
  q?: string;
  category?: string;
  pool?: string[];
  sort?: string;
}) {
  const { page, pageSize, status, q, category, pool, sort } = params;
  const usp = new URLSearchParams();
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  if (status) usp.set('status', status);
  if (q && q.trim()) usp.set('q', q.trim());
  if (category) usp.set('category', category);
  if (pool && pool.length) usp.set('pool', pool.join('||'));
  if (sort) usp.set('sort', sort);
  return useQuery<{ suppliers: SupplierRow[]; total: number; page: number; pageSize: number }>({
    queryKey: ['suppliers-paged', page, pageSize, status ?? '', q ?? '', category ?? '', (pool ?? []).join('||'), sort ?? ''],
    queryFn: ({ signal }) => authedFetch<{ suppliers: SupplierRow[]; total: number; page: number; pageSize: number }>(`/suppliers?${usp.toString()}`, { signal }),
    placeholderData: (prev: unknown) => prev as { suppliers: SupplierRow[]; total: number; page: number; pageSize: number } | undefined,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

export function useSupplierPriceHistory(id: string | null) {
  return useQuery({
    queryKey: ['supplier-price-history', id],
    queryFn: () => authedFetch<{ history: Array<{ item_code: string; effective_from: string; created_at: string; unit_price_sen: number | null; price_matrix: unknown }> }>(`/suppliers/${id}/price-history`),
    enabled: Boolean(id),
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
}

/** Every supplier list: the picker list and the paged Suppliers page. The paged
 *  one was missed, so a changed supplier showed its old values on the list for up
 *  to 30 seconds after Back (Conts-ERP #406). */
export function invalidateSupplierLists(qc: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['suppliers'] }),
    qc.invalidateQueries({ queryKey: ['suppliers-paged'] }),
    qc.invalidateQueries({ queryKey: ['supplier-next-code'] }),
  ]);
}

/** The code a new supplier would get (GET /suppliers/next-code, owner
    2026-11-20): kind, the name's first letter, the next number. Keyed by the
    letter, not the whole name — the answer only changes when the letter does. */
export function useNextSupplierCode(kind: SupplierCodeKind, name: string, enabled: boolean) {
  const letter = supplierCodeLetter(name);
  return useQuery({
    queryKey: ['supplier-next-code', kind, letter],
    queryFn: () => authedFetch<{ kind: SupplierCodeKind; code: string | null }>(
      `/suppliers/next-code?kind=${kind}&name=${encodeURIComponent(letter ?? '')}`,
    ),
    enabled: enabled && letter !== null,
    staleTime: 15_000,
    retry: retryUnlessClientError,
  });
}

export function useSupplierDetail(id: string | null) {
  return useQuery({
    queryKey: ['supplier-detail', id],
    queryFn: () => authedFetch<{ supplier: SupplierRow; bindings: BindingRow[] }>(`/suppliers/${id}`),
    enabled: Boolean(id),
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

export type SupplierScorecard = {
  supplierId: string;
  onTimeRate: number;
  defectRate: number;
  averageLeadDays: number;
  totalPOs: number;
  receivedPOs: number;
  onTimeCount: number;
  last10POs: Array<{
    id: string;
    poNo: string;
    status: PoStatus;
    poDate: string;
    expectedDate: string | null;
    receivedDate: string | null;
    totalSen: number;
    orderedQty: number;
    receivedQty: number;
  }>;
};

export function useSupplierScorecard(id: string | null) {
  return useQuery({
    queryKey: ['supplier-scorecard', id],
    queryFn: () => authedFetch<SupplierScorecard>(`/suppliers/${id}/scorecard`),
    enabled: Boolean(id),
    staleTime: 60_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

export function useCreateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<SupplierRow>) =>
      authedFetch<{ supplier: SupplierRow }>(`/suppliers`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateSupplierLists(qc),
    onError: writeFailed,
  });
}

export function useUpdateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<SupplierRow> & { id: string }) =>
      authedFetch<{ supplier: SupplierRow }>(`/suppliers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      void invalidateSupplierLists(qc);
      qc.invalidateQueries({ queryKey: ['supplier-detail', vars.id] });
    },
  });
}


export type NewBinding = {
  materialKind: MaterialKind;
  itemCode: string;
  acItemCode?: string;
  materialName: string;
  supplierSku: string;
  unitPriceSen?: number;
  currency?: Currency;
  leadTimeDays?: number;
  moq?: number;
  isMainSupplier?: boolean;
  paymentTermsOverride?: string;
  priceValidFrom?: string;
  priceValidTo?: string;
  notes?: string;
  priceMatrix?: PriceMatrix | null;
};

export function useCreateBinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ supplierId, ...body }: NewBinding & { supplierId: string }) =>
      authedFetch<{ binding: BindingRow }>(`/suppliers/${supplierId}/bindings`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['supplier-detail', vars.supplierId] });
      qc.invalidateQueries({ queryKey: ['suppliers-for-material'] });
    },
  });
}

export function useCreateBindingsBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ supplierId, bindings }: { supplierId: string; bindings: NewBinding[] }) =>
      authedFetch<{ inserted: number; skipped: number; bindings: BindingRow[] }>(
        `/suppliers/${supplierId}/bindings/batch`,
        { method: 'POST', body: JSON.stringify({ bindings }) },
      ),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['supplier-detail', vars.supplierId] });
      qc.invalidateQueries({ queryKey: ['suppliers-for-material'] });
    },
  });
}

export function useUpdateBinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ supplierId, bindingId, ...body }: Partial<NewBinding> & { supplierId: string; bindingId: string }) =>
      authedFetch<{ binding: BindingRow }>(`/suppliers/${supplierId}/bindings/${bindingId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['supplier-detail', vars.supplierId] });
      qc.invalidateQueries({ queryKey: ['suppliers-for-material'] });
    },
  });
}

export function useDeleteBinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ supplierId, bindingId }: { supplierId: string; bindingId: string }) =>
      authedFetch<void>(`/suppliers/${supplierId}/bindings/${bindingId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['supplier-detail', vars.supplierId] });
      qc.invalidateQueries({ queryKey: ['suppliers-for-material'] });
    },
    onError: writeFailed,
  });
}

export type BindingPriceChange = {
  id: string;
  effective_from: string;
  unit_price_sen: number | null;
  price_matrix: PriceMatrix | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
};
export type BindingPriceHistory = {
  history: BindingPriceChange[];
  currentUnitPriceSen: number | null;
  currentPriceMatrix: PriceMatrix | null;
};

/** The binding's price timeline (newest first) + its current flat cost. */
export function useBindingPriceHistory(supplierId: string, bindingId: string | null) {
  return useQuery({
    queryKey: ['binding-price-history', supplierId, bindingId],
    enabled: !!bindingId,
    queryFn: () =>
      authedFetch<BindingPriceHistory>(`/suppliers/${supplierId}/bindings/${bindingId}/price-changes`),
  });
}

/** Append one effective-dated cost row (schedule a future/dated supplier price). */
export function useScheduleBindingPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ supplierId, bindingId, ...body }:
      { supplierId: string; bindingId: string; effectiveFrom: string; unitPriceSen: number; notes?: string }) =>
      authedFetch<{ ok: boolean; baselined: boolean; applied: boolean }>(
        `/suppliers/${supplierId}/bindings/${bindingId}/price-changes`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: (r, vars) => {
      void qc.invalidateQueries({ queryKey: ['binding-price-history', vars.supplierId, vars.bindingId] });
      void qc.invalidateQueries({ queryKey: ['supplier-detail', vars.supplierId] });
      if (r.applied) {
        void qc.invalidateQueries({ queryKey: ['suppliers-for-material'] });
        void qc.invalidateQueries({ queryKey: ['mfg-products'] });
      }
    },
    onError: writeFailed,
  });
}

/** Migration 0177 — set/clear this binding as the cost anchor for its
 *  item_code. Setting clears the flag on any other binding for the same
 *  product (one anchor per code) and pushes the binding's current cost onto the
 *  product (initial sync). We invalidate the supplier detail (flag changed) AND
 *  the mfg-products cache (the product's cost may have just been mirrored). */
export function useSetCostAnchor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ supplierId, bindingId, anchor }: { supplierId: string; bindingId: string; anchor: boolean }) =>
      authedFetch<{ binding: BindingRow }>(`/suppliers/${supplierId}/bindings/${bindingId}/cost-anchor`, {
        method: 'PATCH',
        body: JSON.stringify({ anchor }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['supplier-detail', vars.supplierId] });
      qc.invalidateQueries({ queryKey: ['suppliers-for-material'] });
      qc.invalidateQueries({ queryKey: ['mfg-products'] });
    },
    onError: writeFailed,
  });
}

export function useSuppliersForMaterial(kind: MaterialKind | null, code: string | null) {
  return useQuery({
    queryKey: ['suppliers-for-material', kind, code],
    queryFn: () => authedFetch<{ bindings: (BindingRow & { supplier: { id: string; code: string; name: string; status: SupplierStatus } })[] }>(
      `/suppliers/material/${kind}/${encodeURIComponent(code ?? '')}`,
    ),
    enabled: Boolean(kind && code),
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}


export function usePurchaseOrders(opts?: { status?: PoStatus; supplierId?: string }) {
  return useQuery({
    queryKey: ['mfg-purchase-orders', opts?.status ?? 'all', opts?.supplierId ?? 'all'],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.status) params.set('status', opts.status);
      if (opts?.supplierId) params.set('supplierId', opts.supplierId);
      const res = await authedFetch<{ purchaseOrders: PoHeaderRow[] }>(
        `/mfg-purchase-orders${params.toString() ? `?${params.toString()}` : ''}`,
      );
      return res.purchaseOrders;
    },
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

export type PoStatusCounts = {
  all: number;
  draft: number;
  outstanding?: number;
  open: number;
  partial: number;
  received: number;
  cancelled: number;
  /* ON_HOLD (mig 0318, owner 2026-08-21). Optional for the same reason
     `outstanding` is: an older deployment answers without it. */
  on_hold?: number;
};
export function usePurchaseOrdersPaged(params: { from?: string; to?: string; page: number; pageSize: number; status?: string; supplierId?: string; q?: string; sort?: string; creditorNames?: string[]; creditorCodes?: string[]; currencies?: string[]; docDates?: string[] }) {
  const { page, pageSize, status, supplierId, q, sort, creditorNames, creditorCodes, currencies, docDates, from, to } = params;
  const usp = poListParams({ status, supplierId, q, sort, creditorNames, creditorCodes, currencies, docDates, from, to });
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  return useQuery({
    queryKey: ['mfg-purchase-orders-paged', page, pageSize, status ?? '', supplierId ?? '', q ?? '', sort ?? '', JSON.stringify(creditorNames ?? []), JSON.stringify(creditorCodes ?? []), JSON.stringify(currencies ?? []), JSON.stringify(docDates ?? [])],
    queryFn: ({ signal }) => authedFetch<{ purchaseOrders: PoHeaderRow[]; total: number; page: number; pageSize: number; statusCounts: PoStatusCounts }>(`/mfg-purchase-orders?${usp.toString()}`, { signal }),
    placeholderData: (prev: any) => prev,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

export type PoListFacets = Record<'supplier' | 'creditor_code' | 'currency' | 'po_date', Array<[string, number]>>;
export function usePoListFacets(f: PoListFilterParams) {
  const usp = poListParams({ ...f, sort: undefined });
  return useQuery({
    queryKey: ['mfg-purchase-orders-facets', usp.toString()],
    queryFn: ({ signal }) => authedFetch<{ facets: PoListFacets }>(`/mfg-purchase-orders/facets?${usp.toString()}`, { signal }),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
}

const PO_ENRICH_CHUNK = 100;

export function usePoListMrpEnrichmentMap(
  poIds: string[],
  enabled: boolean,
): { byId: Map<string, ListMrpEnrichment>; isFetching: boolean; mrp: ListMrpStatus } {
  const { byId, isFetching, mrp } = useListMrpEnrichmentChunks<ListMrpEnrichment>({
    ids: poIds,
    enabled,
    queryKeyPrefix: 'mfg-purchase-orders-list-mrp-enrichment',
    urlPrefix: '/mfg-purchase-orders/list-mrp-enrichment?poIds=',
    chunkSize: PO_ENRICH_CHUNK,
  });
  return { byId, isFetching, mrp };
}

export function useEnrichedPoListRows<T extends EnrichableMrpRow>(
  rows: T[],
  enabled: boolean,
): { rows: T[]; mrp: ListMrpStatus } {
  const ids = useMemo(
    () => rows.map((r) => r.id).filter((x): x is string => !!x),
    [rows],
  );
  const { byId, mrp } = usePoListMrpEnrichmentMap(ids, enabled);
  const healed = useMemo(
    () => rows.map((r) => applyListMrpEnrichment(r, r.id ? byId.get(r.id) : undefined)),
    [rows, byId],
  );
  return { rows: healed, mrp };
}

export function usePurchaseOrderDetail(id: string | null) {
  return useQuery({
    queryKey: ['mfg-purchase-order-detail', id],
    queryFn: () => authedFetch<{ purchaseOrder: PoHeaderRow; items: PoItemRow[] }>(`/mfg-purchase-orders/${id}`),
    enabled: Boolean(id),
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

export const fetchPurchaseOrderDetail = (id: string) =>
  authedFetch<{ purchaseOrder: PoHeaderRow; items: PoItemRow[] }>(`/mfg-purchase-orders/${id}`);

export type NewPoItem = {
  materialKind: MaterialKind;
  itemCode: string;
  materialName: string;
  supplierSku?: string;
  qty: number;
  unitPriceSen: number;
  bindingId?: string;
  notes?: string;
  itemGroup?: string;
  description?: string;
  description2?: string;
  uom?: string;
  discountSen?: number;
  unitCostSen?: number;
  gapInches?: number | null;
  divanHeightInches?: number | null;
  divanPriceSen?: number;
  legHeightInches?: number | null;
  legPriceSen?: number;
  customSpecials?: unknown;
  lineSuffix?: string;
  specialOrderPriceSen?: number;
  variants?: Record<string, unknown>;
  deliveryDate?: string | null;
  lineDeliveryDateOverridden?: boolean;
  warehouseId?: string | null;
  supplierDeliveryDate2?: string | null;
  supplierDeliveryDate3?: string | null;
  supplierDeliveryDate4?: string | null;
  soItemId?: string | null;
};

/** PR — Phase 1: outstanding SO items for the "From SO" picker.
    Returns SO lines where qty - po_qty_picked > 0 (i.e. still convertible). */
export type OutstandingSoItem = {
  soItemId:       string;
  soDocNo:        string;
  debtorName:     string | null;
  branding:       string | null;
  soStatus:       string;
  soDate:         string;
  deliveryDate:   string | null;
  itemCode:       string;
  description:    string | null;
  itemGroup:      string;
  qty:            number;
  poQtyPicked:    number;
  remainingQty:   number;
  unitPriceSen: number;
  variants:       unknown;
  lineSuffix:     string | null;
  processingDate:   string | null;
  salesLocation:    string | null;
  lineDeliveryDate: string | null;
  mainSupplierCode: string | null;
  mainSupplierName: string | null;
  soRef?: string | null;
  soCustomerSoNo?: string | null;
};

export function useOutstandingSoItems() {
  return useQuery({
    queryKey: ['mfg-purchase-orders', 'outstanding-so-items'],
    queryFn: () => authedFetch<{ items: OutstandingSoItem[] }>(
      `/mfg-purchase-orders/outstanding-so-items`,
    ).then((r) => r.items),
    staleTime: 30_000,
  });
}

/** PR — Multi-select GRN-from-PO picker (task #52, Commander 2026-05-27).
    Lists PO LINES with remaining qty (qty - received_qty > 0) on outstanding
    POs (SUBMITTED ∪ PARTIALLY_RECEIVED). Used by /grns/from-po. */
export type OutstandingPoItem = {
  poItemId:       string;
  poId:           string;
  poDocNo:        string;
  itemCode:       string;
  /* Owner 2026-07-27 — the PO line's supplier-SKU snapshot (#1189), carried so
     the New-GRN line shows (and saves) the code the supplier's delivery note
     uses. Null on lines raised before the snapshot column existed. */
  supplierSku:    string | null;
  description:    string | null;
  itemGroup:      string;
  qty:            number;
  receivedQty:    number;
  remainingQty:   number;
  unitPriceSen: number;
  warehouseId:    string | null;
  variants:       unknown;
  deliveryDate:   string | null;
  supplierId:     string;
  supplierCode:   string;
  supplierName:   string;
  poDate:         string;
  expectedAt:     string | null;
  warehouseLocationId:   string | null;
  warehouseLocationCode: string | null;
  warehouseLocationName: string | null;
};

/**
 * `poIds` is REQUIRED, not optional, per CLAUDE.md's rule about a parameter that
 * decides something — it decides whether the server reads ONE Purchase Order or
 * every one in the company. An optional one defaults every forgetful caller to
 * the unscoped read, which is the LOOSER direction and is exactly the shape that
 * produced the owner's 2026-08-17 zero-row screen: the scope existed in the URL,
 * was never sent to the server, and was applied in the browser to an
 * already-truncated list. Pass `[]` for the open "From PO" picker.
 *
 * Returns the whole payload, `scope` included. That block is the WHY behind an
 * empty `items` and dropping it is how "your PO is a draft" became "every line
 * has been received" — see `lib/outstandingEmptyReason.ts`.
 */
export function useOutstandingPoItems(poIds: string[]) {
  const scopeParam = [...poIds].sort().join(',');
  return useQuery({
    queryKey: ['grns', 'outstanding-po-items', scopeParam],
    queryFn: () => authedFetch<{ items: OutstandingPoItem[]; scope?: OutstandingScope }>(
      scopeParam
        ? `/grns/outstanding-po-items?poId=${encodeURIComponent(scopeParam)}`
        : `/grns/outstanding-po-items`,
    ),
    staleTime: 30_000,
  });
}

/** PR — Multi-select GRN-from-PO creator (task #52). One GRN per PO
    (grns.purchase_order_id is a single FK), auto-posted (writes inventory
    IN + rolls received_qty onto PO items + flips PO status). */
export function useCreateGrnsFromPoItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      picks: Array<{ poItemId: string; qty: number }>;
      receivedDate?: string;
      notes?: string;
    }) =>
      authedFetch<{
        created: Array<{ id: string; grnNumber: string; purchaseOrderId: string; poNumber: string; lineCount: number } & InBandFailure>;
        total: number;
      }>(`/grns/from-po-items`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (data) => {
      for (const g of data.created) reportInBandFailure(`GRN ${g.grnNumber} created, but not everything was recorded`, g);
      qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['grns', 'outstanding-po-items'], refetchType: 'all' });
    },
    onError: writeFailed,
  });
}

/** PR — Multi-select PI-from-GRN picker (task #52). Lists the GRN LINES still to
    bill (accepted - invoiced - returned > 0) on POSTED, not-held notes. The
    server reads the notes that still have something to bill, not a window of
    the newest posted notes (backend/src/scm/lib/outstanding-grn-lines.ts). */
export type OutstandingGrnItem = {
  grnItemId:       string;
  grnId:           string;
  grnDocNo:        string;
  receivedAt:      string;
  supplierId:      string;
  supplierCode:    string;
  supplierName:    string;
  purchaseOrderId: string | null;
  poDocNo:         string | null;
  itemCode:        string;
  description:     string | null;
  itemGroup:       string;
  qtyAccepted:     number;
  remaining:       number;
  unitPriceSen:  number;
  variants:        unknown;
  /* Source note's currency + FX rate (owner 2026-08-06) — one invoice may bill
     several of a supplier's notes, but a PI header carries ONE currency + rate,
     so the picker locks the selection on these as well as the supplier. */
  currency?:       string | null;
  exchangeRate?:   number | null;
};

/** `truncated` is the server saying its note read stopped at its ceiling, so
    `items` is NOT every line still to bill and the screen must say so. A
    response without the field (a Worker older than the field) reads as false. */
export type OutstandingGrnItems = { items: OutstandingGrnItem[]; truncated: boolean };

export function useOutstandingGrnItems() {
  return useQuery({
    queryKey: ['purchase-invoices', 'outstanding-grn-items'],
    queryFn: () => authedFetch<{ items: OutstandingGrnItem[]; truncated?: boolean }>(
      `/purchase-invoices/outstanding-grn-items`,
    ).then((r): OutstandingGrnItems => ({ items: r.items, truncated: r.truncated === true })),
    staleTime: 30_000,
  });
}

/** PR — Multi-select PI-from-GRN creator (task #52). One PI per GRN (since
    purchase_invoices.grn_id is a single FK). Auto-posted (matches Commander
    preference: documents land in POSTED, not DRAFT). PI does NOT touch
    inventory (PI is AP-only — inventory landed at GRN time). */
export function useCreatePisFromGrnItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      picks: Array<{ grnItemId: string; qty: number }>;
      supplierInvoiceNumber?: string;
      invoiceDate?: string;
      dueDate?: string;
      notes?: string;
    }) =>
      authedFetch<{
        created: Array<{ id: string; invoiceNumber: string; supplierId: string; grnCount: number; lineCount: number }>;
        total: number;
      }>(`/purchase-invoices/from-grn-items`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['grns'] });
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
      qc.invalidateQueries({ queryKey: ['purchase-invoices', 'outstanding-grn-items'], refetchType: 'all' });
    },
    onError: writeFailed,
  });
}

/** PR — Phase 1: create POs (one per supplier) from multi-selected SO
    items with partial qty. Increments po_qty_picked on success.
    PR #157 — expectedAt + purchaseLocationId now required (applied to every
    PO created from the batch).

    `idempotencyKey` is OPTIONAL and destructured OUT of the body — the
    rest-spread would otherwise post it as a PO field. fix/doc-idempotency
    (2026-07-17) left this hook bare on the reasoning that its only live caller
    was Mrp.tsx, a long-lived page with no bindable intent. That reasoning had a
    factual error under it and one real half:

    THE ERROR — this hook has TWO live callers, not one. PurchaseOrderFromSo.tsx
    (routed at /scm/purchase-orders/from-so) is the "Transfer from Sales Order" / "Add Line
    Item" picker, and it is an ordinary route-level form: ONE post per mount, and
    it navigates to the PO on success. Its mount IS one intent, so a per-mount
    useIdempotencyKey() is correct there — the same shape as the other 17. That
    caller is the one that most needs a key: it does NOT send fromMrp, so its
    lines are capped by remaining, and a double-fire appends the SAME picked
    lines to the SAME PO twice whenever remaining >= 2x the pick. Missing it is
    the "a hook is not a call site" lesson repeating in the very PR that wrote it
    down.

    THE REAL HALF — Mrp.tsx genuinely has no per-MOUNT intent, and a per-mount
    key there really would make runs 2..N replay run 1 and silently raise NOTHING
    while reporting POs created. But "no per-mount intent" is not "no intent":
    the MRP run (the committed pick selection, from first submit until the run
    LANDS) is a real, bindable object, and Mrp.tsx now binds to it. The key is
    minted per run and retired the moment ANY 2xx arrives — see the ref there for
    why retiring on landing is mandatory rather than the module's usual sin.

    fromMrp does NOT make a key unsafe, and it is why the MRP caller is the more
    dangerous of the two: reference-only converts bypass qty_exceeds_remaining,
    so a double-fire has NO server-side backstop and duplicate-orders the whole
    shortage from the supplier. `fromMrp` makes a PAYLOAD-derived key unsafe
    (identical picks twice are two legitimate POs) — which is an argument against
    hashing the body, not against binding to the run. */
export function useCreatePosFromSoItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: {
      idempotencyKey?: string;
      picks: Array<{ soItemId: string; qty: number; supplierId?: string | null }>;
      expectedAt?: string;
      purchaseLocationId?: string;
      mode?: 'combined' | 'per-so';
      supplierByCode?: Record<string, string>;
      targetPoId?: string;
      fromMrp?: boolean;
      planAsOf?: string | null;
      allowSofaSupplierSplit?: boolean;
    }) =>
      authedFetch<{
        created?: Array<{ id: string; poNumber: string; supplierId: string; lineCount: number }>;
        total?: number;
        targetPoId?: string;
        poNumber?: string;
        added?: number;
      }>(
        `/mfg-purchase-orders/from-sos`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) }),
      ),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-purchase-orders', 'outstanding-so-items'], refetchType: 'all' });
      invalidateSoLists(qc);
      if (vars.targetPoId) qc.invalidateQueries({ queryKey: ['mfg-purchase-order-detail', vars.targetPoId] });
    },
  });
}

/** PR #78 — Convert a Sales Order's items into the current PO. Returns the
    server's { copied, skipped } counts so the UI can toast. */
export function useConvertPoFromSo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, soDocNo, itemIds }: { poId: string; soDocNo: string; itemIds?: string[] }) =>
      authedFetch<{ copied: number; skipped: number; sourceDocNo: string }>(
        `/mfg-purchase-orders/${poId}/convert-from-so`,
        { method: 'POST', body: JSON.stringify({ soDocNo, itemIds }) },
      ),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-purchase-order-detail', vars.poId] });
      qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
    },
    onError: writeFailedAs('Sales order lines not copied into this PO'),
  });
}

export function useCreatePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: {
      idempotencyKey?: string;
      supplierId: string;
      currency?: Currency;
      poDate?: string;
      expectedAt?: string;
      supplierDeliveryDate2?: string;
      supplierDeliveryDate3?: string;
      supplierDeliveryDate4?: string;
      notes?: string;
      items?: NewPoItem[];
      purchaseLocationId?: string | null;
      asDraft?: boolean;
      /** Over-convert override (owner 2026-07-24). SO-sourced lines are capped at
          the source SO line's remaining qty (409 qty_exceeds_remaining); set this
          after the operator confirms to raise a PO beyond what the SO still needs.
          Mirrors confirmShortStock. Only the New-PO-from-SO flow sends it. */
      confirmOverConvert?: boolean;
      /** Service-case exchange link (owner 2026-11-13). Set only when the New-PO
          form was opened from a service case (?fromAssrCase=); the server stamps
          scm.purchase_orders.assr_case_id so the case shows this exchange PO.
          Omitted for every ordinary PO. */
      assrCaseId?: number | null;
    }) =>
      authedFetch<{ id: string; poNumber: string }>(`/mfg-purchase-orders`,
        idempotentInit(idempotencyKey, {
          method: 'POST',
          body: JSON.stringify(body),
        })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] }),
  });
}

export function useUpdatePurchaseOrderHeader() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: string; expectedUpdatedAt: string | null; poDate?: string; expectedAt?: string;
      currency?: Currency; notes?: string; supplierId?: string;
      supplierDeliveryDate2?: string | null;
      supplierDeliveryDate3?: string | null;
      supplierDeliveryDate4?: string | null;
      purchaseLocationId?: string | null;
    }) => authedFetch<{ purchaseOrder: PoHeaderRow }>(`/mfg-purchase-orders/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-purchase-order-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
    },
  });
}

export function useAddPurchaseOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, ...body }: NewPoItem & { poId: string }) =>
      authedFetch<{ item: PoItemRow }>(`/mfg-purchase-orders/${poId}/items`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-purchase-order-detail', vars.poId] });
      qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
    },
  });
}

export function useUpdatePurchaseOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, itemId, ...body }: Partial<NewPoItem> & { poId: string; itemId: string }) =>
      authedFetch<{ ok: true }>(`/mfg-purchase-orders/${poId}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-purchase-order-detail', vars.poId] });
      qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
    },
  });
}

export function useDeletePurchaseOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, itemId }: { poId: string; itemId: string }) =>
      authedFetch<void>(`/mfg-purchase-orders/${poId}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-purchase-order-detail', vars.poId] });
      qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
    },
    onError: writeFailed,
  });
}


/** SO-line candidates for the allocation editor: every company SO line carrying
    this item code — including picked/delivered ones (historical consolidated
    POs are the point). Excludes cancelled lines + cancelled/draft SOs. */
export type SoLineCandidate = {
  soItemId: string;
  soDocNo: string;
  debtorName: string | null;
  soStatus: string | null;
  qty: number;
  deliveryDate: string | null;
};
// poId+itemId narrow the candidates to the PO line's SPEC (fabric + SEAT/LEG/
// SPECIAL), not just its item code (owner 2026-08-08). Omitting them falls back
// to code-only. Keyed on all three so switching lines refetches.
export function useSoLineCandidates(
  code: string | null,
  poId?: string | null,
  itemId?: string | null,
) {
  return useQuery({
    queryKey: ['po-so-line-candidates', code ?? '', poId ?? '', itemId ?? ''],
    queryFn: () => {
      const qs = new URLSearchParams({ code: code ?? '' });
      if (poId) qs.set('poId', poId);
      if (itemId) qs.set('itemId', itemId);
      return authedFetch<{ items: SoLineCandidate[] }>(
        `/mfg-purchase-orders/so-line-candidates?${qs.toString()}`,
      ).then((r) => r.items);
    },
    enabled: Boolean(code),
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
}

const invalidateAllocationReads = (qc: ReturnType<typeof useQueryClient>, poId: string) => {
  qc.invalidateQueries({ queryKey: ['mfg-purchase-order-detail', poId] });
  qc.invalidateQueries({ queryKey: ['po-so-coverage'] });
  qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
};

export function useAddPoLineAllocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, itemId, ...body }: { poId: string; itemId: string; qty: number; soItemId: string | null }) =>
      authedFetch<{ allocation: PoLineAllocation; allocations: PoLineAllocation[] }>(
        `/mfg-purchase-orders/${poId}/items/${itemId}/allocations`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: (_, vars) => invalidateAllocationReads(qc, vars.poId),
  });
}

export function useUpdatePoLineAllocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, itemId, allocationId, ...body }: { poId: string; itemId: string; allocationId: string; qty?: number; soItemId?: string | null }) =>
      authedFetch<{ ok: true; allocations: PoLineAllocation[] }>(
        `/mfg-purchase-orders/${poId}/items/${itemId}/allocations/${allocationId}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      ),
    onSuccess: (_, vars) => invalidateAllocationReads(qc, vars.poId),
  });
}

export function useDeletePoLineAllocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, itemId, allocationId }: { poId: string; itemId: string; allocationId: string }) =>
      authedFetch<{ ok: true; allocations: PoLineAllocation[] }>(
        `/mfg-purchase-orders/${poId}/items/${itemId}/allocations/${allocationId}`,
        { method: 'DELETE' },
      ),
    onSuccess: (_, vars) => invalidateAllocationReads(qc, vars.poId),
  });
}


/** Confirm a DRAFT PO → SUBMITTED (Draft/Confirmed two-state). This is where a
    draft commits: it stamps submitted_at server-side and advances the source
    SO lines' po_qty_picked (they leave the From-SO picker) + the PO becomes
    live MRP supply / GRN-receivable. Invalidates the PO list (incl. the
    outstanding-so-items picker via the shared prefix) + this PO's detail. */
export function useConfirmPurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ purchaseOrder: { id: string; status: PoStatus; submitted_at: string } }>(
        `/mfg-purchase-orders/${id}/confirm`,
        { method: 'PATCH' },
      ),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-purchase-order-detail', id] });
    },
    onError: writeFailed,
  });
}

/** Cancel a PO. The REASON is mandatory (owner 2026-09-09: 「PO cancelled 不需要
 *  审批，只需要 remark 原因取消」) — the server's cancel guard refuses a body
 *  without one (400 reason_required) and records it in the cancellation ledger,
 *  so every surface has to ask for it. Use usePoCancelAction (pages/scm-v2/
 *  use-po-cancel-action.ts) rather than calling this with words of your own. */
export function useCancelPurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      authedFetch<{ purchaseOrder: { id: string; status: PoStatus; cancelled_at: string } }>(
        `/mfg-purchase-orders/${id}/cancel`,
        { method: 'PATCH', body: JSON.stringify({ reason }) },
      ),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-purchase-order-detail', id] });
    },
  });
}

/** Reopen a cancelled PO → SUBMITTED (inverse of cancel; re-claims SO quota). */
export function useReopenPurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ purchaseOrder: { id: string; status: PoStatus; cancelled_at: string | null } }>(
        `/mfg-purchase-orders/${id}/reopen`,
        { method: 'PATCH' },
      ),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-purchase-order-detail', id] });
    },
  });
}

/* useDeletePurchaseOrder was REMOVED with its endpoint (owner rule 2026-08-11:
   不可以删只可以 cancel). A PO is cancelled, never purged — see the note where
   DELETE /:id used to live in backend/src/scm/routes/mfg-purchase-orders.ts. */
