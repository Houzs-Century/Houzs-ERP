// Vendored SLICE of apps/backend/src/lib/inventory-queries.ts.
//
// Originally only the Warehouse type + useWarehouses() (the PO pages' Purchase
// Location + per-line Ship-to dropdowns). The Inventory hub + Stock Card wave
// extends this with the read hooks those two pages need: product-totals,
// per-product breakdown, movements, FIFO lots, batches, COGS and the analytics
// KPI board — all copied verbatim from the source module, through the same
// authedFetch (→ /api/scm). The mutation surface beyond warehouse CRUD
// (useStockAdjustment / useInventoryBuckets / useInventoryValue / useInventory-
// Balances / useDeleteWarehouse) is still NOT pulled in — these two pages
// don't call it.
//
// HOUZS VENDOR NOTE: the source `import { supabase } from './supabase'` was
// imported but NEVER referenced in this module (all reads go through
// authedFetch); it is DROPPED here exactly as in the vendored suppliers-queries
// slice. Everything below is copied verbatim.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
// Host retry policy — the vendor auth/transport boundary already reaches into
// the host for readAuthToken (see authed-fetch.ts); retry semantics belong to
// the host's QueryClient for the same reason.
import { retryUnlessClientError } from '../../../lib/queryClient';

/* TYPE (mig 0171) — 5-bucket classification. `warehouse` = pure stock; `showroom`
   = a sales point that also feeds the venue list (mig 0148); `display` = display
   stock held at a partner site (not sellable in the same net); `service` = a
   repair / customer-service centre; `others` = HQ, C&C K.J, anything that does
   not fit. `is_showroom` (mig 0148) is now derived: `is_showroom = (type =
   'showroom')`. The old boolean stays in reads so the venue resolver and the
   Members page keep working without a rewrite. */
export type WarehouseType =
  | 'warehouse'
  | 'showroom'
  | 'display'
  | 'service'
  | 'others';

export type Warehouse = {
  id: string;
  code: string;
  name: string;
  location: string | null;
  /* Mig 0180 — structured address (country / state / postcode / city).
     Optional so pre-mig payloads still parse. */
  country?: string | null;
  state?: string | null;
  postcode?: string | null;
  city?: string | null;
  is_active: boolean;
  is_default: boolean;
  /* SHOWROOM (migration 0148) — flagging a warehouse as a Showroom makes it a
     VENUE source: it feeds the Sales Maintenance venue list, and salespeople
     parked under it on the Members page attribute their orders to venue_name.
     venue_name is deliberately separate from `name` — a warehouse is named for
     stock, a venue for the report — and a flagged showroom with no venue_name
     resolves to no venue at all rather than to its own code. Optional on the
     type so a pre-migration response still parses. */
  is_showroom?: boolean;
  venue_name?: string | null;
  /* Optional on the type so a pre-mig-0171 response still parses (backend
     defaults to 'warehouse' on POST when unspecified). */
  type?: WarehouseType;
};

export type InventoryBalance = {
  warehouse_id: string;
  product_code: string;
  /* Migration 0095 — attribute-composition bucket; '' = unclassified.
     Present on the default (non-showAll) balances rows. */
  variant_key?: string;
  /* Supplier's own code for the key's internal fabric, stamped READ-side by
     /inventory/breakdown (batched, fail-soft — absent when the fabric has no
     distinct supplier code). Feeds formatVariantKey's parens: "EZ-002 (KN390-2)". */
  fabric_supplier_code?: string | null;
  product_name: string | null;
  qty: number;
  last_movement_at: string | null;
  /* showAll=true rows include these */
  warehouse_code?: string;
  warehouse_name?: string;
  category?: 'ACCESSORY' | 'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'SERVICE';
  size_label?: string | null;
  value_sen?: number;
  main_supplier_code?: string | null;
  main_supplier_name?: string | null;
};

/* PR #38 — Product totals view (one row per SKU, summed qty across warehouses) */
export type InventoryProductTotal = {
  product_code: string;
  product_name: string;
  category: 'ACCESSORY' | 'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'SERVICE';
  size_label: string | null;
  base_price_sen: number | null;
  price1_sen: number | null;
  branding: string | null;
  total_qty: number;
  total_value_sen: number;
  last_movement_at: string | null;
  main_supplier_code: string | null;
  main_supplier_name: string | null;
  main_supplier_price_centi: number | null;
  /* Owner 2026-07-24 six-column planning model (computed server-side, GET
     /inventory/products). committed_scheduled + unscheduled_qty == the whole
     open net-of-delivered SO demand (reserved_total):
       incoming_qty        = outstanding PO qty arriving within ~30 days
       incoming_pos        = the covering PO(s) + ETA behind incoming_qty (drill)
       committed_scheduled = open SO demand that HAS a delivery date
       unscheduled_qty     = open SO demand with NO delivery date
       available_qty       = stock + incoming_qty − committed_scheduled
       surplus_qty         = available_qty − unscheduled_qty
       oldest_lot_at       = oldest open FIFO lot → age of the stock */
  incoming_qty: number;
  incoming_pos: InventoryIncomingPo[];
  committed_scheduled: number;
  unscheduled_qty: number;
  reserved_total: number;
  available_qty: number;
  surplus_qty: number;
  oldest_lot_at: string | null;
};

/* One incoming purchase-order line feeding a SKU's Incoming (≤30-day) figure —
   the PO number bringing the stock and its effective ETA (mig 0180 revised
   date). Surfaced in the Balances row drill so "Incoming +6" names WHICH PO. */
export type InventoryIncomingPo = {
  po_number: string;
  eta: string | null;
  qty: number;
};

export type InventoryMovement = {
  id: string;
  movement_type: 'IN' | 'OUT' | 'ADJUSTMENT' | 'TRANSFER';
  warehouse_id: string;
  product_code: string;
  product_name: string | null;
  qty: number;
  unit_cost_sen?: number;
  total_cost_sen?: number;
  source_doc_type: string | null;
  source_doc_id: string | null;
  source_doc_no: string | null;
  reason_code: string | null;
  notes: string | null;
  performed_by: string | null;
  created_at: string;
};

export type InventoryLot = {
  id: string;
  warehouse_id: string;
  warehouse_code?: string;
  product_code: string;
  product_name: string | null;
  qty_received: number;
  qty_remaining: number;
  unit_cost_sen: number;
  remaining_value_sen?: number;
  received_at: string;
  source_doc_type: string | null;
  source_doc_no: string | null;
};

export type CogsEntry = {
  id: string;
  consumed_at: string;
  warehouse_id: string;
  warehouse_code: string;
  product_code: string;
  qty_consumed: number;
  unit_cost_sen: number;
  total_cost_sen: number;
  source_doc_type: string | null;
  source_doc_no: string | null;
  lot_received_at: string;
  lot_source_doc_no: string | null;
};

export function useWarehouses(opts?: { includeInactive?: boolean }) {
  return useQuery({
    queryKey: ['warehouses', opts?.includeInactive ?? false],
    queryFn: ({ signal }) => {
      const qs = opts?.includeInactive ? '?includeInactive=true' : '';
      return authedFetch<{ warehouses: Warehouse[] }>(`/inventory/warehouses${qs}`, { signal }).then((r) => r.warehouses);
    },
    staleTime: 5 * 60_000,
    /* HOUZS VENDOR — was a bare `retry: 1`, which re-sent a 403 that could only
       403 again (the owner saw this endpoint refused twice per page load). The
       host predicate keeps the single retry for network / 5xx and drops it for
       an authorization or validation failure. */
    retry: retryUnlessClientError,
  });
}

/* HOUZS VENDOR — ProductModels/Warehouses wave. The Warehouses CRUD page needs
   the create + update mutations. Copied verbatim from the source
   inventory-queries.ts (POST / PATCH /inventory/warehouses), through authedFetch
   (→ /api/scm). */
export function useCreateWarehouse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { code: string; name: string; location?: string; country?: string | null; state?: string | null; postcode?: string | null; city?: string | null; isDefault?: boolean; isShowroom?: boolean; venueName?: string | null; type?: WarehouseType }) =>
      authedFetch<{ warehouse: Warehouse }>(`/inventory/warehouses`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['warehouses'] }),
  });
}

export function useUpdateWarehouse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; code?: string; name?: string; location?: string; country?: string | null; state?: string | null; postcode?: string | null; city?: string | null; isActive?: boolean; isDefault?: boolean; isShowroom?: boolean; venueName?: string | null; type?: WarehouseType }) =>
      authedFetch<{ warehouse: Warehouse }>(`/inventory/warehouses/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['warehouses'] }),
  });
}

/* ════════════════════════════════════════════════════════════════════════
   HOUZS VENDOR — Inventory hub + Stock Card wave. Read hooks copied verbatim
   from the source inventory-queries.ts.
   ════════════════════════════════════════════════════════════════════════ */

/* PR #38 — AutoCount-style: one row per SKU, totals across all warehouses.
   ask A (2026-07-24): optional warehouseId narrows Stock / Value / demand /
   incoming to one warehouse. */
export function useInventoryProductTotals(opts?: { search?: string; category?: string; warehouseId?: string | null }) {
  return useQuery({
    queryKey: ['inventory', 'product-totals', opts ?? {}],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (opts?.search) params.set('search', opts.search);
      if (opts?.category && opts.category !== 'all') params.set('category', opts.category);
      if (opts?.warehouseId) params.set('warehouseId', opts.warehouseId);
      return authedFetch<{ products: InventoryProductTotal[] }>(
        `/inventory/products${params.toString() ? `?${params.toString()}` : ''}`,
        { signal },
      ).then((r) => r.products);
    },
    // Keep the current rows on screen while a search / category filter change
    // loads, instead of flashing an empty table (keepPreviousData).
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
}

/* ── Inventory analytics / KPI board ─────────────────────────────────── */
export type InventoryAnalytics = {
  asOf: string;
  windowDays: number;
  totalValueSen: number;
  distinctSkus: number;
  aging: { key: string; label: string; qty: number; valueSen: number }[];
  turnover: { trailingCogsSen: number; annualizedTurns: number; daysOnHand: number | null };
  deadStock: { product_code: string; product_name: string; qty: number; valueSen: number; lastSoldAt: string | null }[];
  abc: {
    items: { product_code: string; product_name: string; cogsSen: number; onHandValueSen: number; cumPct: number; class: 'A' | 'B' | 'C' }[];
    summary: Record<'A' | 'B' | 'C', { count: number; valueSen: number }>;
  };
};

export function useInventoryAnalytics(opts?: { days?: number; warehouseId?: string | null }) {
  return useQuery({
    queryKey: ['inventory', 'analytics', opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.days) params.set('days', String(opts.days));
      if (opts?.warehouseId) params.set('warehouseId', opts.warehouseId);
      return authedFetch<InventoryAnalytics>(
        `/inventory/analytics${params.toString() ? `?${params.toString()}` : ''}`,
      );
    },
    staleTime: 60_000,
  });
}

/* PR #38 — Per-warehouse breakdown for a single product (drilldown drawer) */
export function useInventoryProductBreakdown(productCode: string | null) {
  return useQuery({
    queryKey: ['inventory', 'breakdown', productCode],
    // Migration 0095 — per (warehouse × attribute-composition) rows so the
    // drawer can show a SKU broken into its variant buckets, each with qty.
    queryFn: () =>
      authedFetch<{ balances: InventoryBalance[] }>(
        `/inventory/breakdown/${encodeURIComponent(productCode ?? '')}`,
      ),
    enabled: Boolean(productCode),
    staleTime: 30_000,
  });
}

export function useInventoryLots(productCode: string | null, opts?: { warehouseId?: string; includeClosed?: boolean }) {
  return useQuery({
    queryKey: ['inventory', 'lots', productCode, opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set('warehouseId', opts.warehouseId);
      if (opts?.includeClosed) params.set('includeClosed', 'true');
      return authedFetch<{ lots: InventoryLot[] }>(
        `/inventory/lots/${encodeURIComponent(productCode ?? '')}${params.toString() ? `?${params.toString()}` : ''}`,
      ).then((r) => r.lots);
    },
    enabled: Boolean(productCode),
    staleTime: 30_000,
  });
}

/* Stage 2 (Commander 2026-05-31) — open lots grouped by (warehouse, batch).
   A batch = the source PO number; sofa set components share one batch so the
   outbound side (Stage 3) can ship a whole colour-matched set from one dye lot. */
export type BatchComponent = {
  productCode: string;
  variantKey: string | null;
  productName: string | null;
  qtyRemaining: number;
  unitCostSen: number;
  receivedAt: string | null;
  /* Supplier fabric code for the component's variantKey (READ-side stamp,
     /inventory/batches — same contract as InventoryBalance.fabric_supplier_code). */
  fabric_supplier_code?: string | null;
};
export type InventoryBatch = {
  warehouseId: string;
  warehouseName: string | null;
  batchNo: string;
  supplierId: string | null;
  supplierName: string | null;
  receivedAt: string | null;
  totalRemaining: number;
  components: BatchComponent[];
};

export function useInventoryBatches(opts?: { warehouseId?: string; productCode?: string }) {
  return useQuery({
    queryKey: ['inventory', 'batches', opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set('warehouseId', opts.warehouseId);
      if (opts?.productCode) params.set('productCode', opts.productCode);
      return authedFetch<{ batches: InventoryBatch[] }>(
        `/inventory/batches${params.toString() ? `?${params.toString()}` : ''}`,
      ).then((r) => r.batches);
    },
    staleTime: 30_000,
  });
}

export function useCogsEntries(opts?: { warehouseId?: string; productCode?: string; from?: string; to?: string }) {
  return useQuery({
    queryKey: ['inventory', 'cogs', opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set('warehouseId', opts.warehouseId);
      if (opts?.productCode) params.set('productCode', opts.productCode);
      if (opts?.from) params.set('from', opts.from);
      if (opts?.to) params.set('to', opts.to);
      return authedFetch<{ cogs: CogsEntry[] }>(
        `/inventory/cogs${params.toString() ? `?${params.toString()}` : ''}`,
      ).then((r) => r.cogs);
    },
    staleTime: 30_000,
  });
}

/* Reserved-but-unshipped — one row per OPEN FIFO lot with the READY SO demand
   claiming it (GET /inventory/reservations). `reserved_since` is the reserving
   SO's created_at (no allocation timestamp exists — an honest proxy for the age
   of the claim). status FREE = no order claims the lot yet. */
export type InventoryReservationClaim = {
  doc_no: string;
  so_created_at: string | null;
  qty_ready: number;
};
export type InventoryReservation = {
  warehouse_id: string;
  warehouse_code: string | null;
  warehouse_name: string | null;
  product_code: string;
  product_name: string | null;
  variant_key: string;
  batch_no: string | null;
  qty_remaining: number;
  unit_cost_sen: number;
  received_at: string | null;
  status: 'RESERVED' | 'FREE';
  reserved_by: InventoryReservationClaim[];
  reserved_since: string | null;
};

export function useInventoryReservations(opts?: { warehouseId?: string; productCode?: string }) {
  return useQuery({
    queryKey: ['inventory', 'reservations', opts ?? {}],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set('warehouseId', opts.warehouseId);
      if (opts?.productCode) params.set('productCode', opts.productCode);
      return authedFetch<{ reservations: InventoryReservation[] }>(
        `/inventory/reservations${params.toString() ? `?${params.toString()}` : ''}`,
        { signal },
      ).then((r) => r.reservations);
    },
    staleTime: 30_000,
  });
}

export function useInventoryMovements(opts?: {
  warehouseId?: string;
  productCode?: string;
  docType?: string;
  dateFrom?: string;
  dateTo?: string;
}) {
  return useQuery({
    queryKey: ['inventory', 'movements', opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set('warehouseId', opts.warehouseId);
      if (opts?.productCode) params.set('productCode', opts.productCode);
      if (opts?.docType) params.set('docType', opts.docType);
      if (opts?.dateFrom) params.set('dateFrom', opts.dateFrom);
      if (opts?.dateTo) params.set('dateTo', opts.dateTo);
      return authedFetch<{ movements: InventoryMovement[] }>(
        `/inventory/movements${params.toString() ? `?${params.toString()}` : ''}`,
      ).then((r) => r.movements);
    },
    staleTime: 30_000,
    retry: 1,
  });
}
