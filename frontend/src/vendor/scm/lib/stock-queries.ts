// Vendored SLICE — the stock-movements wave (Stock Adjustments / Transfers /
// Takes). Consolidates the hooks those 8 pages read that were NOT already in
// the vendored inventory-queries slice:
//   • Inventory MOVEMENTS / BALANCES / ADJUSTMENT / BREAKDOWN / BUCKETS
//     (from apps/backend/src/lib/inventory-queries.ts — the slice only pulled
//     in useWarehouses + warehouse CRUD; the movement-ledger + adjustment side
//     lives here so the slice stays minimal and this wave is self-contained).
//   • Stock TRANSFERS (from apps/backend/src/lib/stock-transfers-queries.ts).
//   • Stock TAKES (from apps/backend/src/lib/stock-takes-queries.ts).
//
// HOUZS VENDOR NOTE: the source modules each `import { supabase } from
// './supabase'` but NEVER reference it (all reads/writes go through
// authedFetch) — DROPPED here exactly as in the other vendored slices. Every
// hook is copied verbatim, routed through the vendored authedFetch (→ /api/scm).
// `useWarehouses` is NOT re-declared — the pages import it from the existing
// vendored inventory-queries slice.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { idempotentInit } from '../../../lib/idempotency';
import { writeFailed, writeFailedAs, reportInBandFailure } from './mutation-error';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

/* ═══════════════════════════════════════════════════════════════════════════
   INVENTORY — movements / balances / adjustment / breakdown / buckets
   (verbatim from apps/backend/src/lib/inventory-queries.ts, supabase dropped)
   ═══════════════════════════════════════════════════════════════════════════ */

export type InventoryBalance = {
  warehouse_id: string;
  product_code: string;
  /* Migration 0095 — attribute-composition bucket; '' = unclassified.
     Present on the default (non-showAll) balances rows. */
  variant_key?: string;
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

// Re-declared locally so the breakdown hook can type its response.
type InventoryBalancesResponse = { balances: InventoryBalance[] };

export function useInventoryBalances(opts?: {
  warehouseId?: string;
  search?: string;
  category?: string;
  showAll?: boolean;
}) {
  return useQuery({
    queryKey: ['inventory', 'balances', opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set('warehouseId', opts.warehouseId);
      if (opts?.search) params.set('search', opts.search);
      if (opts?.category && opts.category !== 'all') params.set('category', opts.category);
      if (opts?.showAll) params.set('showAll', 'true');
      return authedFetch<{ balances: InventoryBalance[]; warehouses: unknown[] }>(
        `/inventory${params.toString() ? `?${params.toString()}` : ''}`,
      );
    },
    // Keep the current balances on screen while a search / category / warehouse
    // filter change loads, instead of flashing an empty table (keepPreviousData).
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
}

/* PR #38 — Per-warehouse breakdown for a single product (drilldown drawer) */
export function useInventoryProductBreakdown(productCode: string | null) {
  return useQuery({
    queryKey: ['inventory', 'breakdown', productCode],
    // Migration 0095 — per (warehouse × attribute-composition) rows so the
    // drawer can show a SKU broken into its variant buckets, each with qty.
    queryFn: () =>
      authedFetch<InventoryBalancesResponse>(
        `/inventory/breakdown/${encodeURIComponent(productCode ?? '')}`,
      ),
    enabled: Boolean(productCode),
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
    retry: retryUnlessClientError,
  });
}

export function useStockAdjustment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      warehouseId: string;
      productCode: string;
      productName?: string;
      qtyDelta: number;
      reasonCode: string;
      notes?: string;
      // Variant + batch (sofa/bedframe). On INCREASE the backend computes the
      // variant_key from `variants`; on DECREASE the picker supplies the exact
      // existing bucket via `variantKey` + `batchNo`.
      itemGroup?: string | null;
      variants?: Record<string, unknown> | null;
      batchNo?: string | null;
      variantKey?: string | null;
    }) => authedFetch<{ movement: { id: string } }>(`/inventory/adjustments`, {
      method: 'POST', body: JSON.stringify(body),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}

// Open stock buckets for one SKU, grouped by (variant_key, batch_no) — powers
// the DECREASE-adjustment picker so the operator takes stock from a real lot.
export type InventoryBucket = {
  warehouse_id: string;
  variant_key: string;
  batch_no: string | null;
  product_name: string | null;
  qty: number;
};

export function useInventoryBuckets(productCode: string | null, warehouseId: string | null) {
  return useQuery({
    queryKey: ['inventory', 'buckets', productCode, warehouseId],
    queryFn: () => {
      const params = new URLSearchParams();
      if (warehouseId) params.set('warehouseId', warehouseId);
      return authedFetch<{ buckets: InventoryBucket[] }>(
        `/inventory/buckets/${encodeURIComponent(productCode ?? '')}${params.toString() ? `?${params.toString()}` : ''}`,
      ).then((r) => r.buckets);
    },
    enabled: Boolean(productCode && warehouseId),
    staleTime: 15_000,
    retry: retryUnlessClientError,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   STOCK TRANSFERS
   (verbatim from apps/backend/src/lib/stock-transfers-queries.ts, supabase dropped)
   ═══════════════════════════════════════════════════════════════════════════ */

// PR-DRAFT-removal — DRAFT dropped (migration 0078). Transfers post on create.
export type StockTransferStatus = 'POSTED' | 'CANCELLED';

export type StockTransferWarehouse = {
  id: string;
  code: string;
  name: string;
};

export type StockTransferRow = {
  id: string;
  transfer_no: string;
  status: StockTransferStatus;
  from_warehouse_id: string;
  to_warehouse_id: string;
  transfer_date: string;
  notes: string | null;
  posted_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  created_by: string | null;
  line_count?: number;
  from_warehouse?: StockTransferWarehouse | null;
  to_warehouse?: StockTransferWarehouse | null;
};

export type StockTransferLine = {
  id: string;
  stock_transfer_id: string;
  product_code: string;
  product_name: string | null;
  qty: number;
  notes: string | null;
  created_at: string;
};

export type StockTransferDetail = {
  transfer: StockTransferRow;
  lines: StockTransferLine[];
};

export type StockTransferListFilters = {
  status?: StockTransferStatus;
  fromWarehouseId?: string;
  toWarehouseId?: string;
  dateFrom?: string;
  dateTo?: string;
};

export function useStockTransfers(opts?: StockTransferListFilters) {
  return useQuery({
    queryKey: ['stock-transfers', opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.status)          params.set('status', opts.status);
      if (opts?.fromWarehouseId) params.set('fromWarehouseId', opts.fromWarehouseId);
      if (opts?.toWarehouseId)   params.set('toWarehouseId',   opts.toWarehouseId);
      if (opts?.dateFrom)        params.set('dateFrom', opts.dateFrom);
      if (opts?.dateTo)          params.set('dateTo',   opts.dateTo);
      return authedFetch<{ transfers: StockTransferRow[] }>(
        `/stock-transfers${params.toString() ? `?${params.toString()}` : ''}`,
      ).then((r) => r.transfers);
    },
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
}

export function useStockTransferDetail(id: string | null) {
  return useQuery({
    queryKey: ['stock-transfers', id],
    queryFn: () =>
      authedFetch<StockTransferDetail>(`/stock-transfers/${encodeURIComponent(id ?? '')}`),
    enabled: Boolean(id),
    staleTime: 15_000,
    retry: retryUnlessClientError,
  });
}

export type StockTransferItemInput = {
  productCode: string;
  productName?: string;
  // Variant bucket at the source warehouse this line moves. Keeps stock + MRP
  // accurate (the OUT/IN movements consume + re-open the matching FIFO bucket,
  // which is keyed on variant_key). '' = unclassified (legacy). Owner 2026-07-20.
  variantKey?: string;
  qty: number;
  notes?: string;
};

export type CreateStockTransferInput = {
  fromWarehouseId: string;
  toWarehouseId: string;
  transferDate?: string;
  notes?: string;
  items: StockTransferItemInput[];
};

/* `idempotencyKey` is OPTIONAL and is destructured OUT of the body — the
   rest-spread would otherwise post it as a transfer field. Pass one per transfer
   intent (see lib/idempotency.ts): the middleware replays the first response —
   the SAME transferNo — instead of moving the stock twice. Omitting it is
   exactly today's behaviour (the middleware no-ops).

   NOT on fix/so-idempotency's list (that list walked the sales/purchase document
   chain and stopped there), but the note below is the argument for it: DRAFT was
   dropped in mig 0078, so the row is inserted POSTED and the create MOVES STOCK
   inline. A duplicate is phantom on-hand in two warehouses at once — invisible
   until a stock count, which is the owner's complaint verbatim. */
export function useCreateStockTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: CreateStockTransferInput & { idempotencyKey?: string }) =>
      authedFetch<{ id: string; transferNo: string }>(`/stock-transfers`,
        idempotentInit(idempotencyKey, {
          method: 'POST', body: JSON.stringify(body),
        })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stock-transfers'] });
      // DRAFT was dropped (mig 0078): the row is inserted POSTED and the paired
      // OUT@from / IN@to movements are written by the create itself, so a create
      // moves stock and inventory views must refetch.
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}

export type UpdateStockTransferInput = {
  id: string;
  fromWarehouseId?: string;
  toWarehouseId?: string;
  transferDate?: string;
  notes?: string | null;
  items?: StockTransferItemInput[];
};

export function useUpdateStockTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateStockTransferInput) =>
      authedFetch<{ transfer: StockTransferRow }>(`/stock-transfers/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['stock-transfers'] });
      qc.invalidateQueries({ queryKey: ['stock-transfers', vars.id] });
    },
    onError: writeFailed,
  });
}

export function usePostStockTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ transfer: StockTransferRow; movementErrors?: string[] }>(
        `/stock-transfers/${id}/post`, { method: 'PATCH', body: '{}' },
      ),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['stock-transfers'] });
      qc.invalidateQueries({ queryKey: ['stock-transfers', id] });
      // Posting moves stock — invalidate inventory views too.
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: writeFailedAs('Stock transfer not posted'),
  });
}

export function useCancelStockTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ transfer: StockTransferRow; reversalErrors?: string[] }>(`/stock-transfers/${id}/cancel`, {
        method: 'PATCH', body: '{}',
      }),
    onSuccess: (data, id) => {
      /* IN-BAND FAILURE. The cancel reverses the inter-warehouse movement, and
         that write is best-effort: its result comes back as `reversalErrors`,
         not as a rejection, so no `onError` can catch it. Unread until
         check-inband-failures.mjs counted producers against readers — the field
         had ZERO on the whole frontend. Without this the transfer shows as
         cancelled while the stock sits in the destination warehouse. */
      reportInBandFailure('Transfer cancelled, but the stock was not moved back', data);
      qc.invalidateQueries({ queryKey: ['stock-transfers'] });
      qc.invalidateQueries({ queryKey: ['stock-transfers', id] });
      // Cancel REVERSES the inter-warehouse movement (opposite-direction rows
      // per original line), so it moves stock just as the create did.
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}

export function useDeleteStockTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ ok: true }>(`/stock-transfers/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stock-transfers'] }),
    onError: writeFailedAs('Stock transfer not deleted'),
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   STOCK TAKES
   (verbatim from apps/backend/src/lib/stock-takes-queries.ts, supabase dropped)
   ═══════════════════════════════════════════════════════════════════════════ */

// PR-DRAFT-removal — DRAFT renamed to OPEN (migration 0078). Stock takes
// keep an editable working state because the commander enters counted_qty
// per line BEFORE posting; "OPEN" makes the intent explicit.
export type StockTakeStatus = 'OPEN' | 'POSTED' | 'CANCELLED';
/* NONZERO (phase 1, mig 0270) — only buckets whose system qty ≠ 0. */
export type StockTakeScopeType = 'ALL' | 'CATEGORY' | 'CODE_PREFIX' | 'NONZERO';

export type StockTakeWarehouse = {
  id: string;
  code: string;
  name: string;
};

export type StockTakeRow = {
  id: string;
  take_no: string;
  status: StockTakeStatus;
  warehouse_id: string;
  scope_type: StockTakeScopeType;
  scope_value: string | null;
  take_date: string;
  notes: string | null;
  posted_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  created_by: string | null;
  /* Phase 1 (mig 0270): the person responsible for the count + blind flag. */
  assignee_staff_id?: string | null;
  blind?: boolean;
  line_count?: number;
  /* null on a BLIND take that is still OPEN when the viewer is not a
     supervisor — the server strips it (variance would un-blind the count). */
  variance_total?: number | null;
  warehouse?: StockTakeWarehouse | null;
};

export type StockTakeLine = {
  id: string;
  stock_take_id: string;
  product_code: string;
  product_name: string | null;
  variant_key: string;
  variant_label: string | null;
  /* null while blind is active for this viewer (server-stripped). */
  system_qty: number | null;
  counted_qty: number | null;
  variance: number | null;
  notes: string | null;
  created_at: string;
  /* Phase 1 (mig 0270): WHO entered the counted qty (scm.staff uuid) and WHEN. */
  counted_by?: string | null;
  counted_at?: string | null;
};

/* Server-decided viewer facts (one shared logic layer — the frontend must not
   re-derive permissions): is this caller the assignee, may they supervise, and
   is the blind stripping active on THIS response's lines. */
export type StockTakeViewer = {
  isAssignee: boolean;
  canSupervise: boolean;
  blindActive: boolean;
};

export type StockTakeDetail = {
  take: StockTakeRow;
  lines: StockTakeLine[];
  viewer?: StockTakeViewer;
};

export type StockTakeListFilters = {
  status?: StockTakeStatus;
  warehouseId?: string;
  dateFrom?: string;
  dateTo?: string;
};

export function useStockTakes(opts?: StockTakeListFilters) {
  return useQuery({
    queryKey: ['stock-takes', opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.status)      params.set('status', opts.status);
      if (opts?.warehouseId) params.set('warehouseId', opts.warehouseId);
      if (opts?.dateFrom)    params.set('dateFrom', opts.dateFrom);
      if (opts?.dateTo)      params.set('dateTo',   opts.dateTo);
      return authedFetch<{ takes: StockTakeRow[] }>(
        `/stock-takes${params.toString() ? `?${params.toString()}` : ''}`,
      ).then((r) => r.takes);
    },
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
}

export function useStockTakeDetail(id: string | null) {
  return useQuery({
    queryKey: ['stock-takes', id],
    queryFn: () =>
      authedFetch<StockTakeDetail>(`/stock-takes/${encodeURIComponent(id ?? '')}`),
    enabled: Boolean(id),
    staleTime: 15_000,
    retry: retryUnlessClientError,
  });
}

export type CreateStockTakeInput = {
  warehouseId: string;
  /* Phase 1: required — the person responsible for this count (scm.staff uuid). */
  assigneeStaffId: string;
  takeDate?: string;
  scopeType: StockTakeScopeType;
  scopeValue?: string | null;
  notes?: string;
  /* Blind count: hide system qty / variance from the counter until posted. */
  blind?: boolean;
};

/* `idempotencyKey` is OPTIONAL and is destructured OUT of the body — the
   rest-spread would otherwise post it as a take field. Pass one per take intent
   (see lib/idempotency.ts): the middleware replays the first response — the SAME
   takeNo — instead of raising the count twice. Omitting it is exactly today's
   behaviour (the middleware no-ops). */
export function useCreateStockTake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: CreateStockTakeInput & { idempotencyKey?: string }) =>
      authedFetch<{ id: string; takeNo: string; lineCount: number }>(`/stock-takes`,
        idempotentInit(idempotencyKey, {
          method: 'POST', body: JSON.stringify(body),
        })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stock-takes'] });
    },
  });
}

export type StockTakeLineUpdate = {
  id: string;
  countedQty?: number | null;
  notes?: string | null;
};

export function useUpdateStockTakeLines() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, lines }: { id: string; lines: StockTakeLineUpdate[] }) =>
      authedFetch<{ ok: true; updated: number }>(
        `/stock-takes/${id}/lines`,
        { method: 'PATCH', body: JSON.stringify({ lines }) },
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['stock-takes'] });
      qc.invalidateQueries({ queryKey: ['stock-takes', vars.id] });
    },
  });
}

export function usePostStockTake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{
        take: StockTakeRow;
        movementsWritten: number;
        movementErrors?: string[];
      }>(`/stock-takes/${id}/post`, { method: 'PATCH', body: '{}' }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['stock-takes'] });
      qc.invalidateQueries({ queryKey: ['stock-takes', id] });
      // Posting writes ADJUSTMENT movements — invalidate inventory views.
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}

// Undo a POSTED take: reverses every ADJUSTMENT it wrote (stock returns to
// pre-post) and marks the take CANCELLED + locked. Mirrors usePostStockTake's
// inventory invalidation since stock levels change back.
export function useReverseStockTake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{
        take: StockTakeRow;
        movementsReversed: number;
        movementErrors?: string[];
      }>(`/stock-takes/${id}/reverse`, { method: 'PATCH', body: '{}' }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['stock-takes'] });
      qc.invalidateQueries({ queryKey: ['stock-takes', id] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}

export function useCancelStockTake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ take: StockTakeRow }>(`/stock-takes/${id}/cancel`, {
        method: 'PATCH', body: '{}',
      }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['stock-takes'] });
      qc.invalidateQueries({ queryKey: ['stock-takes', id] });
    },
  });
}

export function useDeleteStockTake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ ok: true }>(`/stock-takes/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stock-takes'] }),
  });
}
