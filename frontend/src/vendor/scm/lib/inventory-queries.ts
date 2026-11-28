
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LOOKUP_CACHE } from './lookup-cache';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';
import { retryUnlessClientError } from '../../../lib/queryClient';

/** The closing stock a warehouse's goods book on at month end (backend scm/lib/stock-bucket.ts). */
export type StockBucket = 'customer' | 'display' | 'service' | 'showroom' | 'others';

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
  country?: string | null;
  state?: string | null;
  postcode?: string | null;
  city?: string | null;
  is_active: boolean;
  is_default: boolean;
  is_showroom?: boolean;
  venue_name?: string | null;
  type?: WarehouseType;
  stock_bucket?: StockBucket | null;
};

export type InventoryBalance = {
  warehouse_id: string;
  item_code: string;
  variant_key?: string;
  fabric_supplier_code?: string | null;
  product_name: string | null;
  qty: number;
  last_movement_at: string | null;
  warehouse_code?: string;
  warehouse_name?: string;
  /* R6 (owner 2026-07-24) — the balance's warehouse is a CONSIGNMENT location
     (stock held but not owned). Stamped by /inventory/breakdown so the drawer
     can show consignment QUANTITY separately and exclude it from inventory
     VALUE. Display-only; no costing/AP path depends on it. */
  is_consignment?: boolean;
  category?: 'ACCESSORY' | 'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'SERVICE';
  size_label?: string | null;
  value_sen?: number;
  main_supplier_code?: string | null;
  main_supplier_name?: string | null;
};

export type InventoryProductTotal = {
  item_code: string;
  product_name: string;
  barcode: string | null;
  category: 'ACCESSORY' | 'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'SERVICE';
  size_label: string | null;
  base_price_sen: number | null;
  price1_sen: number | null;
  branding: string | null;
  total_qty: number;
  total_value_sen: number;
  owned_qty?: number;
  held_qty?: number;
  held_value_sen?: number;
  last_movement_at: string | null;
  main_supplier_code: string | null;
  main_supplier_name: string | null;
  main_supplier_price_sen: number | null;
  /* Owner 2026-07-24 six-column planning model (computed server-side, GET
     /inventory/products). committed_scheduled + unscheduled_qty == the whole
     open net-of-delivered SO demand (reserved_total):
       incoming_qty        = outstanding PO qty arriving within ~30 days
       incoming_pos        = the covering PO(s) + ETA behind incoming_qty (drill)
       committed_scheduled = open SO demand that HAS a delivery date
       unscheduled_qty     = open SO demand with NO delivery date
       available_qty       = stock + incoming_qty − committed_scheduled
       surplus_qty         = available_qty − unscheduled_qty
       non_selling_qty     = on-hand standing in a showroom / display / service
                             warehouse — doing its job, not idle
       sellable_surplus_qty= ON-HAND owned − all open demand − owned non_selling,
                             floored at 0 (incoming never counts); the
                             dead-stock signal, and the ONLY one the Dead/Spare
                             badge may read
       oldest_lot_at       = oldest open FIFO lot → age of the stock */
  incoming_qty: number;
  incoming_pos: InventoryIncomingPo[];
  demand_sos: InventoryDemandSo[];
  committed_scheduled: number;
  unscheduled_qty: number;
  reserved_total: number;
  available_qty: number;
  surplus_qty: number;
  non_selling_qty?: number;
  sellable_surplus_qty?: number;
  movement_qty?: number;
  ledger_mismatch?: boolean;
  oldest_lot_at: string | null;
  /* On-hand per warehouse (owned + consignment, held_qty = the consignment
     part), largest first (HC-0206). Optional for the same cached-payload
     reason as above. */
  stock_by_warehouse?: InventoryWarehouseQty[];
};

export type InventoryWarehouseQty = {
  warehouse_id: string;
  code: string;
  name: string | null;
  qty: number;
  held_qty: number;
};

export type InventoryIncomingPo = {
  po_number: string;
  eta: string | null;
  qty: number;
};

/* One open Sales Order claiming a SKU — the SO(s) behind Scheduled (delivery_date
   set) and Unscheduled (delivery_date null), net of delivered (HC-0115). */
export type InventoryDemandSo = {
  doc_no: string;
  debtor_name: string | null;
  so_date: string | null;
  delivery_date: string | null;
  qty: number;
};

export type InventoryMovement = {
  id: string;
  movement_type: 'IN' | 'OUT' | 'ADJUSTMENT' | 'TRANSFER';
  warehouse_id: string;
  item_code: string;
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
  item_code: string;
  product_name: string | null;
  qty_received: number;
  qty_remaining: number;
  unit_cost_sen: number;
  remaining_value_sen?: number;
  received_at: string;
  source_doc_type: string | null;
  source_doc_no: string | null;
  is_consignment?: boolean;
};

export type CogsEntry = {
  id: string;
  consumed_at: string;
  warehouse_id: string;
  warehouse_code: string;
  item_code: string;
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
    ...LOOKUP_CACHE,
    retry: retryUnlessClientError,
  });
}

export function useCreateWarehouse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { code: string; name: string; location?: string; country?: string | null; state?: string | null; postcode?: string | null; city?: string | null; isDefault?: boolean; isShowroom?: boolean; venueName?: string | null; type?: WarehouseType; stockBucket?: StockBucket | null }) =>
      authedFetch<{ warehouse: Warehouse }>(`/inventory/warehouses`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['warehouses'] }),
    onError: writeFailed,
  });
}

export function useUpdateWarehouse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; code?: string; name?: string; location?: string; country?: string | null; state?: string | null; postcode?: string | null; city?: string | null; isActive?: boolean; isDefault?: boolean; isShowroom?: boolean; venueName?: string | null; type?: WarehouseType; stockBucket?: StockBucket | null }) =>
      authedFetch<{ warehouse: Warehouse }>(`/inventory/warehouses/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['warehouses'] }),
    onError: writeFailed,
  });
}


export function useInventoryProductTotals(opts?: { search?: string; category?: string; warehouseIds?: readonly string[] }) {
  return useQuery({
    queryKey: ['inventory', 'product-totals', opts ?? {}],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (opts?.search) params.set('search', opts.search);
      if (opts?.category && opts.category !== 'all') params.set('category', opts.category);
      if (opts?.warehouseIds?.length) params.set('warehouseIds', opts.warehouseIds.join(','));
      return authedFetch<{ products: InventoryProductTotal[] }>(
        `/inventory/products${params.toString() ? `?${params.toString()}` : ''}`,
        { signal },
      ).then((r) => r.products);
    },
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
}

export type InventoryAnalytics = {
  asOf: string;
  windowDays: number;
  totalValueSen: number;
  distinctSkus: number;
  aging: { key: string; label: string; qty: number; valueSen: number }[];
  turnover: { trailingCogsSen: number; annualizedTurns: number; daysOnHand: number | null };
  deadStock: { item_code: string; product_name: string; qty: number; valueSen: number; lastSoldAt: string | null }[];
  abc: {
    items: { item_code: string; product_name: string; cogsSen: number; onHandValueSen: number; cumPct: number; class: 'A' | 'B' | 'C' }[];
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

export function useInventoryProductBreakdown(itemCode: string | null) {
  return useQuery({
    queryKey: ['inventory', 'breakdown', itemCode],
    queryFn: () =>
      authedFetch<{ balances: InventoryBalance[] }>(
        `/inventory/breakdown/${encodeURIComponent(itemCode ?? '')}`,
      ),
    enabled: Boolean(itemCode),
    staleTime: 30_000,
  });
}

export function useInventoryLots(itemCode: string | null, opts?: { warehouseId?: string; includeClosed?: boolean }) {
  return useQuery({
    queryKey: ['inventory', 'lots', itemCode, opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set('warehouseId', opts.warehouseId);
      if (opts?.includeClosed) params.set('includeClosed', 'true');
      return authedFetch<{ lots: InventoryLot[] }>(
        `/inventory/lots/${encodeURIComponent(itemCode ?? '')}${params.toString() ? `?${params.toString()}` : ''}`,
      ).then((r) => r.lots);
    },
    enabled: Boolean(itemCode),
    staleTime: 30_000,
  });
}

export type BatchComponent = {
  itemCode: string;
  variantKey: string | null;
  productName: string | null;
  qtyRemaining: number;
  unitCostSen: number;
  receivedAt: string | null;
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

export function useInventoryBatches(opts?: { warehouseId?: string; itemCode?: string }) {
  return useQuery({
    queryKey: ['inventory', 'batches', opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set('warehouseId', opts.warehouseId);
      if (opts?.itemCode) params.set('itemCode', opts.itemCode);
      return authedFetch<{ batches: InventoryBatch[] }>(
        `/inventory/batches${params.toString() ? `?${params.toString()}` : ''}`,
      ).then((r) => r.batches);
    },
    staleTime: 30_000,
  });
}

export function useCogsEntries(opts?: { warehouseId?: string; itemCode?: string; from?: string; to?: string }) {
  return useQuery({
    queryKey: ['inventory', 'cogs', opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set('warehouseId', opts.warehouseId);
      if (opts?.itemCode) params.set('itemCode', opts.itemCode);
      if (opts?.from) params.set('from', opts.from);
      if (opts?.to) params.set('to', opts.to);
      return authedFetch<{ cogs: CogsEntry[] }>(
        `/inventory/cogs${params.toString() ? `?${params.toString()}` : ''}`,
      ).then((r) => r.cogs);
    },
    staleTime: 30_000,
  });
}

export type InventoryReservationClaim = {
  doc_no: string;
  so_created_at: string | null;
  qty_ready: number;
  delivery_date?: string | null;
};
export type InventoryReservation = {
  id?: string;
  warehouse_id: string;
  warehouse_code: string | null;
  warehouse_name: string | null;
  item_code: string;
  product_name: string | null;
  variant_key: string;
  batch_no: string | null;
  qty_remaining: number;
  unit_cost_sen: number;
  received_at: string | null;
  source_doc_type?: string | null;
  source_doc_no?: string | null;
  source_po_no?: string | null;
  is_consignment?: boolean;
  fabric_supplier_code?: string;
  status: 'RESERVED' | 'FREE';
  reserved_by: InventoryReservationClaim[];
  reserved_since: string | null;
  // ── MRP-derived assigned-vs-free split (owner 2026-07-25, dead-stock view) ──
  // A lot is ASSIGNED iff the ONE MRP engine allocates on-hand stock to an SO's
  // demand (the SAME floating coverage the SO↔PO "Assigned SO" feature uses) —
  // NOT just the hard READY reservation. assigned_qty + free_qty == qty_remaining.
  // mrp_assigned_to names the SO(s) this lot's assigned units belong to (FIFO).
  // is_dead_stock: this lot carries FREE (un-assigned) OWNED units — emphasised
  // for make_to_order (SOFA/BEDFRAME) where free stock is abnormal. All fields
  // are optional: an older/degraded payload omits them → treat as all-free.
  category?: string | null;
  make_to_order?: boolean;
  assigned_qty?: number;
  free_qty?: number;
  mrp_assigned_to?: Array<{ doc_no: string; delivery_date: string | null; qty: number }>;
  is_dead_stock?: boolean;
};

export type StockLotLike = {
  qty_remaining: number;
  unit_cost_sen: number;
  is_consignment?: boolean;
  assigned_qty?: number;
  free_qty?: number;
};

export type StockBreakdown<T extends StockLotLike = InventoryReservation> = {
  ownedLots: T[];
  consignmentLots: T[];
  ownedQty: number;
  ownedValueSen: number;
  consignmentQty: number;
  totalQty: number;
  // MRP-derived assigned-vs-free totals over OWNED lots (owner 2026-07-25). These
  // reconcile with the header "N assigned / M free": ownedAssignedQty +
  // ownedFreeQty == ownedQty. ownedFreeQty is the SKU's on-hand dead-stock slice.
  ownedAssignedQty: number;
  ownedFreeQty: number;
};

export function lotAssignedQty(l: StockLotLike): number {
  return Math.max(0, Math.round(l.assigned_qty ?? 0));
}
export function lotFreeQty(l: StockLotLike): number {
  const qty = l.qty_remaining ?? 0;
  return l.free_qty != null ? Math.max(0, Math.round(l.free_qty)) : qty;
}

export function lotIsDeadStock(l: StockLotLike & { is_dead_stock?: boolean }): boolean {
  return l.is_dead_stock ?? (!l.is_consignment && lotFreeQty(l) > 0);
}

export function buildStockBreakdown<T extends StockLotLike>(
  rows: T[] | null | undefined,
): StockBreakdown<T> {
  const list = rows ?? [];
  const ownedLots = list.filter((l) => !l.is_consignment);
  const consignmentLots = list.filter((l) => l.is_consignment);
  const ownedQty = ownedLots.reduce((s, l) => s + (l.qty_remaining ?? 0), 0);
  const ownedValueSen = ownedLots.reduce(
    (s, l) => s + (l.qty_remaining ?? 0) * (l.unit_cost_sen ?? 0),
    0,
  );
  const consignmentQty = consignmentLots.reduce((s, l) => s + (l.qty_remaining ?? 0), 0);
  const ownedAssignedQty = ownedLots.reduce((s, l) => s + lotAssignedQty(l), 0);
  const ownedFreeQty = ownedLots.reduce((s, l) => s + lotFreeQty(l), 0);
  return {
    ownedLots,
    consignmentLots,
    ownedQty,
    ownedValueSen: Math.round(ownedValueSen),
    consignmentQty,
    totalQty: ownedQty + consignmentQty,
    ownedAssignedQty,
    ownedFreeQty,
  };
}

/* Owner 2026-07-25 (dead-stock view) — is this SKU category make-to-order?
   SOFA/BEDFRAME are built against a customer SO, so FREE stock is abnormal (a
   strong dead-stock signal); MATTRESS is make-to-stock (free is normal, soft).
   Mirrors the backend isMakeToOrderCategory — ONE rule, both sides. */
export function isMakeToOrderCategory(category: string | null | undefined): boolean {
  const c = (category ?? '').toUpperCase();
  return c.includes('SOFA') || c.includes('BEDFRAME');
}

export function useInventoryReservations(opts?: { warehouseId?: string; itemCode?: string }) {
  return useQuery({
    queryKey: ['inventory', 'reservations', opts ?? {}],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set('warehouseId', opts.warehouseId);
      if (opts?.itemCode) params.set('itemCode', opts.itemCode);
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
  itemCode?: string;
  docType?: string;
  dateFrom?: string;
  dateTo?: string;
}) {
  return useQuery({
    queryKey: ['inventory', 'movements', opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set('warehouseId', opts.warehouseId);
      if (opts?.itemCode) params.set('itemCode', opts.itemCode);
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
