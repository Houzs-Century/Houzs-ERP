// TanStack Query hooks for /suppliers + /mfg-purchase-orders. Mirrors the
// pattern in mfg-products-queries.ts.
//
// HOUZS VENDOR NOTE: the original line `import { supabase } from './supabase'`
// was DROPPED — `supabase` was imported but never referenced in this module
// (auth now lives entirely in authed-fetch via localStorage). Everything else
// is verbatim.

import { useMemo } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { applyListMrpEnrichment, type EnrichableMrpRow, type ListMrpEnrichment } from '../../../lib/listMrpEnrichment';
import { writeFailed, writeFailedAs } from './mutation-error';
import { idempotentInit } from '../../../lib/idempotency';
import { invalidateSoLists } from './sales-order-queries';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import type { OriginAssignment } from './flow-queries';
import type { OutstandingScope } from '../../../lib/outstandingEmptyReason';

export type SupplierStatus = 'ACTIVE' | 'INACTIVE' | 'BLOCKED';
export type Currency = 'MYR' | 'RMB' | 'USD' | 'SGD';
export type MaterialKind = 'mfg_product' | 'fabric' | 'raw';
// Draft/Confirmed two-state model re-adds DRAFT to po_status (migration 0042
// re-adds the enum value 0078 removed). A PO can be saved as DRAFT (no SO-quota
// advance, invisible to MRP supply) and later confirmed -> SUBMITTED.
export type PoStatus = 'DRAFT' | 'SUBMITTED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED';

export type StatementType = 'OPEN_ITEM' | 'BALANCE_FORWARD' | 'NO_STATEMENT';
export type AgingBasis    = 'INVOICE_DATE' | 'DUE_DATE';

export type SupplierRow = {
  id: string;
  code: string;
  name: string;
  whatsapp_number: string | null;
  email: string | null;
  contact_person: string | null;
  phone: string | null;
  address: string | null;
  state: string | null;
  payment_terms: string | null;
  status: SupplierStatus;
  rating: number;
  notes: string | null;
  /* PR #40 — full master record (Commander 2026-05-26 AutoCount parity) */
  supplier_type: string | null;
  category: string | null;
  tin_number: string | null;
  business_reg_no: string | null;
  postcode: string | null;
  area: string | null;
  /* Mig 0131 — structured city (dropdown from scm.my_localities). Null on
     the list endpoint (view predates the column) — the DETAIL /create /
     patch handlers surface it via SUPPLIER_COLS. */
  city: string | null;
  mobile: string | null;
  fax: string | null;
  website: string | null;
  attention: string | null;
  business_nature: string | null;
  country: string;                          // PR #47 — default 'Malaysia'
  currency: Currency;
  statement_type: StatementType;
  aging_basis: AgingBasis;
  credit_limit_sen: number;
  /* Mig 0028 — AutoCount creditor-export parity (registration_no /
     nature_of_business / exemption_no / phone2). */
  registration_no: string | null;
  nature_of_business: string | null;
  exemption_no: string | null;
  phone2: string | null;
  created_at: string;
  updated_at: string;
  /* PR — Commander 2026-05-27: auto-derived from the supplier's assigned
     SKUs (distinct mfg_products.category across supplier_material_bindings).
     Populated ONLY on the list endpoint (suppliers_with_derived_category
     view in migration 0088); detail/create/patch responses omit it.
     Values: 'SOFA' / 'BEDFRAME' / 'MATTRESS' / 'ACCESSORY' / 'SERVICE'
     / 'MIXED' (≥2 distinct) / null (no SKUs assigned yet). */
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
export type SofaPriceMatrix     = Record<string, { P1?: number; P2?: number; P3?: number }>;
export type BedframePriceMatrix = { P1?: number; P2?: number };
export type PriceMatrix         = SofaPriceMatrix | BedframePriceMatrix | Record<string, unknown>;

export type BindingRow = {
  id: string;
  supplier_id: string;
  material_kind: MaterialKind;
  item_code: string;
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
  /** PR — Commander 2026-05-27: per-category cost matrix mirroring the
   *  Products Maintenance page shape. NULL on existing rows + on categories
   *  that use the single unit_price_sen (mattress / accessory / service). */
  price_matrix: PriceMatrix | null;
  /** Migration 0177 — cost anchor. When true, this binding is THE cost anchor
   *  for its item_code: editing either side's cost (this binding's
   *  unit_price_sen / price_matrix, or the linked mfg_products
   *  base_price_sen / price1_sen) mirrors onto the other. At most one anchor
   *  per item_code (enforced server-side). SOFA bindings can be anchored
   *  but cost sync is skipped (per-height matrix vs single SKU cost). */
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
  supplier_id: string;
  status: PoStatus;
  po_date: string;
  expected_at: string | null;
  /** Mig 0026 — supplier-revised header delivery dates. */
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
  /** Mig 0080 — bumped on every approved revision (SO-amendment follow-up or
   *  standalone PO amendment). Display shows `_R{revision-1}` when > 1. */
  revision?: number | null;
  /** PR #77 — default ship-to warehouse for every line on this PO. */
  purchase_location_id: string | null;
  /** List endpoint embeds the purchase-location warehouse (id/code/name) for
      the "Purchase Location" column + Excel export (owner 2026-08-05). */
  purchase_location?: { id: string; code: string; name: string } | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  // Detail endpoint also includes contact_person/phone/email/address; list
  // endpoint only fills id/code/name. Both shapes assignable here.
  supplier?: {
    id: string;
    code: string;
    name: string;
    contact_person?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
  } | null;
  /** PR — Commander 2026-05-27: list endpoint embeds a tiny items summary
      (item_code + qty per line) so the buyer can scan what's inside each
      PO row without drilling in. Detail endpoint returns full items[]
      separately, not on the header. Optional because not every consumer
      wants the join. */
  items?: PoItemSummary[];
  /** Tier 2 downstream-lock — list + detail endpoints stamp this flag when
      the PO has ANY non-cancelled GRN. Once true the PO is read-only +
      un-cancellable (the GRN must be cancelled / deleted first). Convert-to-
      GRN (partial receiving) is NOT gated. Mirrors GRN's has_children. */
  has_children?: boolean;
  /** Collapsed "Assigned SO" column (owner 2026-07-31) — the distinct Sales
      Order(s) this PO's supply is assigned to, resolved server-side by the SAME
      precedence engine the drill-down uses (delivered → DO-lock > stored link >
      MRP floating). `assigned_so_linked` is true when ANY line carries a stored
      so_item_id, so the column can mark an MRP-only guess apart from a binding. */
  assigned_sos?: OriginAssignment[];
  assigned_so_linked?: boolean;
  /** PR-3 (2026-08-07) — the parallel stored-origin "bought for" SO(s) of the
      coverage wire, rendered muted beside the precedence chips (never
      replacing them). Optional so an older backend degrades gracefully. */
  assigned_so_provenance?: OriginAssignment[];
  /** "Delivered" column (owner 2026-07-31) — the Delivery Order(s) that have
      shipped this PO's goods (batch_no = the PO number) + qty per DO, resolved
      server-side. EVERY DO renders (no collapse); empty when nothing shipped. */
  delivered_dos?: Array<{ doNo: string; qty: number }>;
  /** "GRN No" column — the non-cancelled Goods Received doc(s) this PO was
      received into, deduped and ordered by number. Carries the GRN's UUID
      because the detail route is /scm/grns/:id, not /:grnNumber. Empty on a PO
      nothing has been received against yet.

      A bare `string` is the PRE-2026-07-31 wire shape (doc number only). Pages
      and the Worker deploy independently, so a freshly-shipped bundle can talk
      to a worker that still sends it — the column renders those as plain,
      un-linkable chips instead of blank ones. */
  transfer_to_grns?: Array<{ id: string; grnNumber: string } | string>;
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
  /* PR #41 — variant fields (migration 0056) */
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
  /** PR #77 — per-line delivery date + ship-to warehouse (both inherit from
      PO header when null). */
  delivery_date?: string | null;
  warehouse_id?: string | null;
  /** Mig 0026 — supplier-revised per-line delivery dates. All optional; the
      supplier pushes the date back. Effective line date = MAX over non-null of
      [delivery_date, date2, date3, date4]. */
  supplier_delivery_date_2?: string | null;
  supplier_delivery_date_3?: string | null;
  supplier_delivery_date_4?: string | null;
  /** Per-line GR breakdown (which goods receipt took how much) — set by
      GET /:id so the PO list expansion can show a "Received" column identical
      to the SO "Delivered" column. Cancelled GRNs excluded server-side. */
  receipts?: PoLineReceipt[];
  /** Mig 0274 — line reference photos (R2 keys), carried from the source SO
      line on convert (same R2 objects; the AutoCount importer appends its own
      `po-items/...` keys). On the wire from GET /:id (ITEM_COLS) all along;
      read-only on the PO — photos are authored on the SO. */
  photo_urls?: string[] | null;
  /** Migration 0098 — source SO line this PO line was converted from. */
  so_item_id?: string | null;
  /** 2026-06-12 — stamped by GET /:id (so_item_id → SO doc_no) for the PO
      PDF's "For SO" provenance column (relabelled from "Transferred SO",
      owner 2026-08-07). Null for manual / MRP lines. */
  so_doc_no?: string | null;
  /** SO→PO drift (Commander 2026-06-16) — set by GET /:id when this line's
      source SO line was edited AFTER the PO was raised, so the PO snapshot no
      longer matches the live SO (e.g. customer changed the fabric). The
      purchaser must re-send the corrected PO to the supplier. Null = in sync /
      not from an SO. itemChanged = the SO swapped to a different SKU. */
  so_drift?: {
    specPo: string; specSo: string;
    itemPo: string; itemSo: string;
    itemChanged: boolean;
    /* Staff #12 — the SO line's ship-from warehouse moved after the PO was
       raised (so the PO still points at the old warehouse). */
    warehouseChanged: boolean;
    warehousePoId: string | null;
    warehouseSoId: string | null;
  } | null;
  /** Mig 0235 — the line's sub-numbered allocations (consolidated-PO split):
      which customer (SO line) or STOCK each slice of the line serves. Stamped
      by GET /:id, seq-ordered; empty array = an unsplit line (the single
      so_item_id above stays the 1:1 fast path). When any exist they are the
      authoritative finer-grained answer and layer (b) of the Assigned SO
      reads THEM instead of so_item_id. */
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

/* ── Suppliers ──────────────────────────────────────────────────────── */

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

/* Opt-in server-side pagination + search + Supply-Category filter + sort for
   the Suppliers LIST PAGE. Sending `page` switches /suppliers into its
   paginated contract ({ suppliers, total, page, pageSize }); the legacy
   useSuppliers above (no page) still returns the historical unpaginated
   SupplierRow[] — that is what the supplier PICKERS (MultiSupplierPicker,
   ProductModels supplier select) rely on, so do NOT route those through this.
   `q` searches code/name/contact_person (same columns as the legacy search).
   `category` is the Supply-Category chip value (omit for "all", '__mixed__' for
   the synthetic "Mixed / Other" chip); `pool` is the active maintained pool,
   passed ONLY for the mixed chip so the server can compute that set exactly.
   `sort` is 'col:dir' over { name, code, status, created_at } (default
   name:asc). placeholderData keepPrevious so paging doesn't flash empty. */
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['suppliers'] }),
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
      qc.invalidateQueries({ queryKey: ['suppliers'] });
      qc.invalidateQueries({ queryKey: ['supplier-detail', vars.id] });
    },
  });
}

/* ── Bindings ───────────────────────────────────────────────────────── */

export type NewBinding = {
  materialKind: MaterialKind;
  itemCode: string;
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
  /** PR — Commander 2026-05-27: optional per-category cost matrix.
   *  Validated server-side against the SKU's category (see
   *  apps/api/src/routes/suppliers.ts validatePriceMatrix). */
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

// Batch-create N bindings in one round-trip. Backend de-dupes against any
// material already bound for this supplier and returns counts.
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
      // The initial sync may have rewritten the product's cost.
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

/* ═══════════════════════════════════════════════════════════════════════
   HOUZS VENDOR — Purchase-Order hooks block (source lines 419-875), copied
   verbatim. The Suppliers slice cut the file at useSuppliersForMaterial;
   the 4 PO pages need these PO + SO-driven + GRN/PI-picker hooks. The
   Smart-Buttons linked-docs block (source 877-950: usePurchaseOrderLinked
   etc.) is NOT vendored — the PO pages use RelationshipMapButton, not the
   /linked counters. authedFetch already points at /api/scm.
   ═══════════════════════════════════════════════════════════════════════ */

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

// Opt-in server-side pagination + search + sort + status-counts (mirrors
// useMfgSalesOrdersPaged). Sending `page` switches /mfg-purchase-orders into
// its paginated contract ({ purchaseOrders, total, page, pageSize,
// statusCounts }); the legacy usePurchaseOrders above (no page) still returns
// the historical unpaginated array. `status` is the filter-pill BUCKET NAME
// (draft/outstanding/open/partial/received/cancelled) — the backend resolves it
// to the raw purchase_orders.status values it covers, so `outstanding` spans
// SUBMITTED + PARTIALLY_RECEIVED. A raw DB status still works. Unlike the legacy hook this
// returns the FULL object so the page can read .purchaseOrders + .statusCounts.
//
// `outstanding` is OPTIONAL on the wire: a worker deployed before the roll-up
// bucket landed omits it, and Pages/Worker deploy independently. Callers derive
// open + partial when it's absent (exact, not a guess) — see PurchaseOrdersListV2.
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
export function usePurchaseOrdersPaged(params: { page: number; pageSize: number; status?: string; supplierId?: string; q?: string; sort?: string }) {
  const { page, pageSize, status, supplierId, q, sort } = params;
  const usp = new URLSearchParams();
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  if (status) usp.set('status', status);
  if (supplierId) usp.set('supplierId', supplierId);
  if (q && q.trim()) usp.set('q', q.trim());
  if (sort) usp.set('sort', sort);
  return useQuery({
    queryKey: ['mfg-purchase-orders-paged', page, pageSize, status ?? '', supplierId ?? '', q ?? '', sort ?? ''],
    queryFn: ({ signal }) => authedFetch<{ purchaseOrders: PoHeaderRow[]; total: number; page: number; pageSize: number; statusCounts: PoStatusCounts }>(`/mfg-purchase-orders?${usp.toString()}`, { signal }),
    placeholderData: (prev: any) => prev,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

/* Deferred PO-list enrichment — the MRP-derived columns (Assigned SO /
   Delivered) the list no longer computes on its critical path (see
   listMrpEnrichment.ts). Fired AFTER the list renders, for the POs it just
   showed, merged in by applyListMrpEnrichment. The ids are chunked at 100 so the
   request stays bounded; each chunk is cached independently. The backend runs
   ONE company-wide computeMrp per request regardless of chunk size. */
const PO_ENRICH_CHUNK = 100;

export function usePoListMrpEnrichmentMap(
  poIds: string[],
  enabled: boolean,
): { byId: Map<string, ListMrpEnrichment>; isFetching: boolean } {
  const chunks = useMemo(() => {
    const uniq = [...new Set(poIds.filter(Boolean))].sort();
    const out: string[][] = [];
    for (let i = 0; i < uniq.length; i += PO_ENRICH_CHUNK) out.push(uniq.slice(i, i + PO_ENRICH_CHUNK));
    return out;
  }, [poIds]);

  const results = useQueries({
    queries: chunks.map((chunk) => ({
      enabled: enabled && chunk.length > 0,
      queryKey: ['mfg-purchase-orders-list-mrp-enrichment', chunk.join(',')],
      queryFn: ({ signal }: { signal?: AbortSignal }) =>
        authedFetch<{ enrichment: Record<string, ListMrpEnrichment> }>(
          `/mfg-purchase-orders/list-mrp-enrichment?poIds=${encodeURIComponent(chunk.join(','))}`,
          { signal },
        ),
      staleTime: 30_000,
      retry: retryUnlessClientError,
      retryDelay: 800,
    })),
  });

  const sig = results.map((r) => r.dataUpdatedAt).join('|');
  const isFetching = results.some((r) => r.isFetching);
  const byId = useMemo(() => {
    const map = new Map<string, ListMrpEnrichment>();
    for (const r of results) {
      const e = r.data?.enrichment;
      if (e) for (const [k, v] of Object.entries(e)) map.set(k, v);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `results` is read through its `sig` (per-chunk dataUpdatedAt); depending on the array itself would rebuild every render.
  }, [sig]);

  return { byId, isFetching };
}

/* The overlay the PO list applies: take the rows the list endpoint returned
   (without the MRP-derived columns), fetch the deferred enrichment for their
   ids, and return the healed rows. */
export function useEnrichedPoListRows<T extends EnrichableMrpRow>(
  rows: T[],
  enabled: boolean,
): T[] {
  const poIds = useMemo(
    () => rows.map((r) => r.id).filter((x): x is string => !!x),
    [rows],
  );
  const { byId } = usePoListMrpEnrichmentMap(poIds, enabled);
  return useMemo(
    () => rows.map((r) => applyListMrpEnrichment(r, r.id ? byId.get(r.id) : undefined)),
    [rows, byId],
  );
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

/* Plain (non-hook) fetch of a PO's full detail, for loops like batch print —
   same shape + cache key as usePurchaseOrderDetail. */
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
  /* PR #41 — variant fields */
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
  /* PR #77 — per-line ship-to overrides; both null = inherit from PO header */
  deliveryDate?: string | null;
  warehouseId?: string | null;
  /* Mig 0026 — supplier-revised per-line delivery dates (optional). */
  supplierDeliveryDate2?: string | null;
  supplierDeliveryDate3?: string | null;
  supplierDeliveryDate4?: string | null;
  /* Commander 2026-05-29 (BUG 1) — source SO line id for lines added via the
     "From SO" picker. The generic create handler increments this SO line's
     po_qty_picked so it drops from the picker. NULL for manual PO lines. */
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
  /* Commander 2026-05-28 — PO-from-SO redesign extras. processingDate +
     salesLocation come off the SO header; lineDeliveryDate is the SO LINE's
     own delivery date (used to derive the PO line's warehouse + date). */
  processingDate:   string | null;
  salesLocation:    string | null;
  lineDeliveryDate: string | null;
  /* Commander 2026-05-28 — the SKU's MAIN supplier (null when unbound, i.e.
     the line can't be converted to a PO until it's assigned a supplier). */
  mainSupplierCode: string | null;
  mainSupplierName: string | null;
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
  /* Delivery-carry — the PO line's delivery date, carried into the GRN line. */
  deliveryDate:   string | null;
  supplierId:     string;
  supplierCode:   string;
  supplierName:   string;
  poDate:         string;
  expectedAt:     string | null;
  /* The PO's purchase_location (header warehouse) — the GRN's receive-into
     warehouse. One warehouse per GRN: the from-PO picker locks to it. */
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
    // The scope is part of the identity of this read now that the SERVER applies
    // it; without it in the key, a scoped and an unscoped picker share a cache
    // entry and one shows the other's rows.
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
        created: Array<{ id: string; grnNumber: string; purchaseOrderId: string; poNumber: string; lineCount: number }>;
        total: number;
      }>(`/grns/from-po-items`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      /* Picker must refetch so already-received PO lines drop off the list
         (Wei Siang 2026-05-30). */
      qc.invalidateQueries({ queryKey: ['grns', 'outstanding-po-items'], refetchType: 'all' });
    },
    onError: writeFailed,
  });
}

/** PR — Multi-select PI-from-GRN picker (task #52). Lists GRN LINES from
    POSTED GRNs that have NOT yet been invoiced (header-level dedupe per MVP
    — see /outstanding-grn-items handler for the trade-off note). */
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

export function useOutstandingGrnItems() {
  return useQuery({
    queryKey: ['purchase-invoices', 'outstanding-grn-items'],
    queryFn: () => authedFetch<{ items: OutstandingGrnItem[] }>(
      `/purchase-invoices/outstanding-grn-items`,
    ).then((r) => r.items),
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
      /* Force picker refetch so already-invoiced GRN lines drop off. */
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
      /* Commander 2026-05-31 — each pick now carries its own chosen supplier
         (MRP picks supplier per shortage SO line). NULL = let the server fall
         back to the SKU's main supplier. The backend groups by
         (warehouse, supplier). */
      picks: Array<{ soItemId: string; qty: number; supplierId?: string | null }>;
      /* Commander 2026-05-28 — Expected Delivery + Purchase Location are no
         longer asked: the server derives them per-line from the source SO.
         Kept optional for any legacy caller that still wants to force them. */
      expectedAt?: string;
      purchaseLocationId?: string;
      /* Commander 2026-05-28 — PO generation mode:
         'combined' = one PO per supplier (mattresses: many SOs → 1 PO);
         'per-so'   = one PO per (supplier × SO) (sofa/bedframe: 1 SO → 1 PO). */
      mode?: 'combined' | 'per-so';
      /* Commander 2026-05-29 — per-SKU supplier override picked in the MRP
         ({ itemCode: supplierId }); wins over the main-supplier binding. */
      supplierByCode?: Record<string, string>;
      /* Commander 2026-05-29 — when set, APPEND the picked lines to this existing
         PO (the "Transfer from Sales Order" / "Add Line Item" picker scoped to a PO)
         instead of creating new POs. */
      targetPoId?: string;
      /* Commander 2026-05-31 — converts raised from the MRP page are
         reference-only: bypass the qty_exceeds_remaining cap + tag PO lines
         from_mrp so they don't lock the source SO line (infinite-convert). */
      fromMrp?: boolean;
    }) =>
      authedFetch<{
        // Create-new-POs shape:
        created?: Array<{ id: string; poNumber: string; supplierId: string; lineCount: number }>;
        total?: number;
        // Append-to-existing-PO shape (targetPoId):
        targetPoId?: string;
        poNumber?: string;
        added?: number;
      }>(
        `/mfg-purchase-orders/from-sos`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) }),
      ),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
      /* Force picker refetch — refetchType:'all' kicks the query even when
         not currently mounted, so the next view sees only outstanding lines. */
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

/* `idempotencyKey` is OPTIONAL and is destructured OUT of the body — the
   rest-spread would otherwise post it as a PO field. Pass one per PO intent (see
   lib/idempotency.ts): the middleware replays the first response — the SAME
   poNumber — instead of committing the company to buy the goods twice. Omitting
   it is exactly today's behaviour (the middleware no-ops).

   This file had NO idempotency at all before 2026-07-17 (fix/doc-idempotency):
   unlike the DO/SI files there was not even a payment call site here to make the
   omission visible. A duplicate PO is an order placed with a real supplier. */
export function useCreatePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: {
      idempotencyKey?: string;
      supplierId: string;
      currency?: Currency;
      poDate?: string;
      expectedAt?: string;
      /** Mig 0026 — supplier-revised header delivery dates; fan down to lines
          that don't carry their own revised date. */
      supplierDeliveryDate2?: string;
      supplierDeliveryDate3?: string;
      supplierDeliveryDate4?: string;
      notes?: string;
      items?: NewPoItem[];                     // PR #41 — optional, allow blank-draft
      /** PR #97 — AutoCount Purchase Location at create time. NULL → can be
          set on the detail page after creation. */
      purchaseLocationId?: string | null;
      /** Draft/Confirmed — opt-in DRAFT save (status DRAFT, no SO-quota advance,
          invisible to MRP supply). Omitted/false → SUBMITTED, as before. */
      asDraft?: boolean;
      /** Over-convert override (owner 2026-07-24). SO-sourced lines are capped at
          the source SO line's remaining qty (409 qty_exceeds_remaining); set this
          after the operator confirms to raise a PO beyond what the SO still needs.
          Mirrors confirmShortStock. Only the New-PO-from-SO flow sends it. */
      confirmOverConvert?: boolean;
    }) =>
      authedFetch<{ id: string; poNumber: string }>(`/mfg-purchase-orders`,
        idempotentInit(idempotencyKey, {
          method: 'POST',
          body: JSON.stringify(body),
        })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] }),
  });
}

/* PR #41 — header PATCH + item CRUD endpoints for the new PO detail page */
export function useUpdatePurchaseOrderHeader() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: string; poDate?: string; expectedAt?: string;
      currency?: Currency; notes?: string; supplierId?: string;
      /** Mig 0026 — supplier-revised header delivery dates. */
      supplierDeliveryDate2?: string | null;
      supplierDeliveryDate3?: string | null;
      supplierDeliveryDate4?: string | null;
      /** PR #77 — default ship-to warehouse for every line on this PO. */
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
      /* #2/#3 — adding a line can change the header expected_at; refresh list. */
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
      /* #2/#3 — a per-line delivery-date edit now recomputes the header
         expected_at server-side, so refresh the list (it reads expected_at). */
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
      /* Commander 2026-05-29 (BUG 1) — deleting a PO line releases the source
         SO line's po_qty_picked back. Refresh the PO list (new total) AND the
         From-SO picker (the released line should reappear). The prefix key
         ['mfg-purchase-orders'] also matches ['mfg-purchase-orders',
         'outstanding-so-items']. */
      qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
    },
    onError: writeFailed,
  });
}

/* ── Per-line SO allocations (mig 0235) — the consolidated-PO split ─────────
   One PO line serving several customers plus stock, as sub-numbered slices.
   All three writes invalidate the detail (chips), the coverage read (the
   Assigned SO cell now lists each allocated SO) and the PO list (its collapsed
   Assigned SO column reads the same coverage rollup). Deliberately NOT
   invalidating the From-SO picker: allocations never move po_qty_picked. */

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

/* useSubmitPurchaseOrder (PATCH /mfg-purchase-orders/:id/submit) was REMOVED
   2026-08-18. Its endpoint had no write path — it read the row, echoed an
   already-SUBMITTED PO and then returned 409 cannot_submit unconditionally — so
   the only caller left, the read-only PO detail page, failed on every DRAFT it
   was offered on. /confirm is the one verb that commits a draft; see
   vendor/scm/lib/po-next-step.ts for the full account. */

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
    /* Added 2026-08-18 with the retirement of useSubmitPurchaseOrder. This is
       now the ONLY way to commit a draft PO, and /confirm has a refusal an
       operator can act on: PO_WAREHOUSE_REQUIRED 409s a PO with no ship-to
       warehouse and names the offending lines. Without an onError that refusal
       reached nobody — the button would simply appear to do nothing, which is
       the failure mode the retired endpoint already had. */
    onError: writeFailed,
  });
}

export function useCancelPurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ purchaseOrder: { id: string; status: PoStatus; cancelled_at: string } }>(
        `/mfg-purchase-orders/${id}/cancel`,
        { method: 'PATCH' },
      ),
    onSuccess: (_, id) => {
      // Prefix key also matches ['mfg-purchase-orders','outstanding-so-items'],
      // so the released SO lines reappear in the From-SO picker.
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
      // Re-claims SO quota, so the From-SO picker (prefix
      // ['mfg-purchase-orders','outstanding-so-items']) must refetch — those
      // lines leave the picker again — plus this PO's detail.
      qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-purchase-order-detail', id] });
    },
  });
}

/* useDeletePurchaseOrder was REMOVED with its endpoint (owner rule 2026-08-11:
   不可以删只可以 cancel). A PO is cancelled, never purged — see the note where
   DELETE /:id used to live in backend/src/scm/routes/mfg-purchase-orders.ts. */
