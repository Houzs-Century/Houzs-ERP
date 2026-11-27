
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { idempotentInit } from '../../../lib/idempotency';
import { writeFailed, writeFailedAs, reportInBandFailure } from './mutation-error';
import { retryUnlessClientError } from '../../../lib/retryPolicy';


export type InventoryBalance = {
  warehouse_id: string;
  item_code: string;
  variant_key?: string;
  product_name: string | null;
  qty: number;
  last_movement_at: string | null;
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
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
}

export function useInventoryProductBreakdown(itemCode: string | null) {
  return useQuery({
    queryKey: ['inventory', 'breakdown', itemCode],
    queryFn: () =>
      authedFetch<InventoryBalancesResponse>(
        `/inventory/breakdown/${encodeURIComponent(itemCode ?? '')}`,
      ),
    enabled: Boolean(itemCode),
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
    retry: retryUnlessClientError,
  });
}

export type StockAdjustmentLine = {
  id: string;
  line_no: number;
  item_code: string;
  product_name: string | null;
  item_group: string | null;
  variants: Record<string, unknown> | null;
  description2: string | null;
  variant_key: string;
  batch_no: string | null;
  qty: number;
  reason_code: string | null;
  notes: string | null;
};

export type StockAdjustmentDoc = {
  id: string;
  adjustment_no: string;
  warehouse_id: string;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  source_stock_take_id?: string | null;
  lines: StockAdjustmentLine[];
};

/** One line as the create / edit body carries it. On an INCREASE the backend
    derives variant_key from `variants` unless `variantKey` is sent (an edited
    line that kept its variants sends the key it is stored under); on a
    DECREASE `variantKey` + `batchNo` name the bucket the stock comes out of. */
export type StockAdjustmentLineInput = {
  itemCode: string;
  productName?: string;
  qty: number;
  reasonCode: string;
  notes?: string;
  itemGroup?: string | null;
  variants?: Record<string, unknown> | null;
  batchNo?: string | null;
  variantKey?: string | null;
  unitCostSen?: number;
};

export function useStockAdjustments(opts?: { warehouseId?: string; dateFrom?: string; dateTo?: string }) {
  return useQuery({
    queryKey: ['inventory', 'adjustments', opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set('warehouseId', opts.warehouseId);
      if (opts?.dateFrom) params.set('dateFrom', opts.dateFrom);
      if (opts?.dateTo) params.set('dateTo', opts.dateTo);
      return authedFetch<{ adjustments: StockAdjustmentDoc[] }>(
        `/inventory/adjustments${params.toString() ? `?${params.toString()}` : ''}`,
      ).then((r) => r.adjustments);
    },
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
}

export function useStockAdjustmentDoc(id: string | null) {
  return useQuery({
    queryKey: ['inventory', 'adjustments', 'one', id],
    queryFn: () => authedFetch<{ adjustment: StockAdjustmentDoc }>(`/inventory/adjustments/${id}`).then((r) => r.adjustment),
    enabled: Boolean(id),
    retry: retryUnlessClientError,
  });
}

export function useStockAdjustment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { warehouseId: string; notes?: string; lines: StockAdjustmentLineInput[] }) =>
      authedFetch<{ id: string; adjustmentNo: string }>(`/inventory/adjustments`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}

export function useUpdateStockAdjustment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { notes?: string | null; lines?: StockAdjustmentLineInput[] }) =>
      authedFetch<{ adjustment: Omit<StockAdjustmentDoc, 'lines'>; movedBuckets: number }>(`/inventory/adjustments/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}

export type InventoryBucket = {
  warehouse_id: string;
  variant_key: string;
  batch_no: string | null;
  product_name: string | null;
  qty: number;
};

export function useInventoryBuckets(itemCode: string | null, warehouseId: string | null) {
  return useQuery({
    queryKey: ['inventory', 'buckets', itemCode, warehouseId],
    queryFn: () => {
      const params = new URLSearchParams();
      if (warehouseId) params.set('warehouseId', warehouseId);
      return authedFetch<{ buckets: InventoryBucket[] }>(
        `/inventory/buckets/${encodeURIComponent(itemCode ?? '')}${params.toString() ? `?${params.toString()}` : ''}`,
      ).then((r) => r.buckets);
    },
    enabled: Boolean(itemCode && warehouseId),
    staleTime: 15_000,
    retry: retryUnlessClientError,
  });
}


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
  racks_applied_at?: string | null;
  racks_reversed_at?: string | null;
  line_count?: number;
  from_warehouse?: StockTransferWarehouse | null;
  to_warehouse?: StockTransferWarehouse | null;
};

export type StockTransferLine = {
  id: string;
  stock_transfer_id: string;
  item_code: string;
  product_name: string | null;
  variant_key: string | null;
  qty: number;
  notes: string | null;
  created_at: string;
  from_rack_id?: string | null;
  to_rack_id?: string | null;
};

export type StockTransferDetail = {
  transfer: StockTransferRow;
  lines: StockTransferLine[];
  stockNotBack?: boolean;
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
  itemCode: string;
  productName?: string;
  // Variant bucket at the source warehouse this line moves. Keeps stock + MRP
  // accurate (the OUT/IN movements consume + re-open the matching FIFO bucket,
  // which is keyed on variant_key). '' = unclassified (legacy). Owner 2026-07-20.
  variantKey?: string;
  qty: number;
  notes?: string;
  /** Optional rack of the From warehouse the goods come off. Owner 2026-11-27. */
  fromRackId?: string;
  /** Optional rack of the To warehouse the goods go onto. Owner 2026-11-27. */
  toRackId?: string;
};

export type CreateStockTransferInput = {
  fromWarehouseId: string;
  toWarehouseId: string;
  transferDate?: string;
  notes?: string;
  items: StockTransferItemInput[];
};

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
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}

export type UpdateStockTransferNotesInput = {
  id: string;
  notes?: string | null;
  items?: StockTransferItemInput[];
};

export function useUpdateStockTransferNotes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateStockTransferNotesInput) =>
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
      reportInBandFailure('Transfer cancelled, but the stock was not moved back', data);
      qc.invalidateQueries({ queryKey: ['stock-transfers'] });
      qc.invalidateQueries({ queryKey: ['stock-transfers', id] });
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


export type StockTakeStatus = 'OPEN' | 'PENDING_APPROVAL' | 'POSTED' | 'CANCELLED';
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
  /* Approval lane (owner 2026-11-20): who sent an over-limit count for approval
     and when. Set while PENDING_APPROVAL; cleared when a supervisor returns it. */
  submitted_at?: string | null;
  submitted_by?: string | null;
  assignee_staff_id?: string | null;
  assignee_staff_ids?: string[] | null;
  nonzero_only?: boolean;
  blind?: boolean;
  line_count?: number;
  variance_total?: number | null;
  warehouse?: StockTakeWarehouse | null;
};

export type StockTakeLine = {
  id: string;
  stock_take_id: string;
  item_code: string;
  product_name: string | null;
  variant_key: string;
  variant_label: string | null;
  system_qty: number | null;
  counted_qty: number | null;
  variance: number | null;
  notes: string | null;
  created_at: string;
  counted_by?: string | null;
  counted_at?: string | null;
  added_on_count?: boolean;
  rack_id?: string | null;
  est_unit_cost_sen?: number | null;
  entered_unit_cost_sen?: number | null;
  /* HC-0158: the PO(s) behind this bucket's open lots, qty per PO; empty when
     none traces (AC opening / adjustment stock, a negative bucket, blind). */
  source_pos?: Array<{ po: string; qty: number }>;
};

export type StockTakeViewer = {
  isAssignee: boolean;
  canSupervise: boolean;
  blindActive: boolean;
};

/* One ADJUSTMENT movement a POSTED take booked (owner 2026-11-20): the SKU, its
   signed qty change, and the unit cost the +variance lot took (0 for a negative
   variance, which the trigger costs FIFO). Each links to the SKU's stock card. */
export type StockTakeAdjustment = {
  item_code: string;
  product_name: string | null;
  variant_key: string | null;
  qty: number;
  unit_cost_sen: number | null;
};

export type StockTakeDetail = {
  take: StockTakeRow;
  lines: StockTakeLine[];
  adjustments?: StockTakeAdjustment[];
  /* The formal Stock Adjustment document this take booked (owner 2026-11-20) —
     the take links to it instead of a stock card. Null for a take posted before
     this feature (or until a backfill mints one). */
  adjustment?: { id: string; adjustment_no: string } | null;
  viewer?: StockTakeViewer;
};

export type StockTakeListFilters = {
  status?: StockTakeStatus;
  warehouseId?: string;
  dateFrom?: string;
  dateTo?: string;
  submitted?: boolean;
};

export function useStockTakes(opts?: StockTakeListFilters) {
  return useQuery({
    queryKey: ['stock-takes', opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.status)      params.set('status', opts.status);
      if (opts?.submitted)   params.set('submitted', 'true');
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
  assigneeStaffIds: string[];
  nonzeroOnly?: boolean;
  takeDate?: string;
  scopeType: StockTakeScopeType;
  scopeValue?: string | null;
  notes?: string;
  blind?: boolean;
};

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
  rackId?: string | null;
  enteredUnitCostSen?: number | null;
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

/* Post result. A within-limit count (or any supervisor post) books immediately
   and carries `movementsWritten`. A non-supervisor's over-limit count instead
   comes back with `pendingApproval: true` and the breached `itemCodes` — no
   stock moved; a supervisor must /approve it (owner 2026-11-20). */
export type PostStockTakeResult = {
  take: StockTakeRow;
  movementsWritten?: number;
  movementErrors?: string[];
  racksMoved?: number;
  racksSkipped?: string[];
  rackError?: string;
  pendingApproval?: boolean;
  itemCodes?: string[];
  message?: string;
  /* The Stock Adjustment document this post booked (owner 2026-11-20). */
  adjustmentId?: string;
  adjustmentNo?: string;
};

export function usePostStockTake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<PostStockTakeResult>(`/stock-takes/${id}/post`, { method: 'PATCH', body: '{}' }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['stock-takes'] });
      qc.invalidateQueries({ queryKey: ['stock-takes', id] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
}

export function useApproveStockTake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<PostStockTakeResult>(`/stock-takes/${id}/approve`, { method: 'PATCH', body: '{}' }),
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: ['stock-takes'] });
      void qc.invalidateQueries({ queryKey: ['stock-takes', id] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      void qc.invalidateQueries({ queryKey: ['scm', 'stock-take-approvals'] });
    },
  });
}

export function useRejectStockTake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ take: StockTakeRow }>(`/stock-takes/${id}/reject`, { method: 'PATCH', body: '{}' }),
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: ['stock-takes'] });
      void qc.invalidateQueries({ queryKey: ['stock-takes', id] });
      void qc.invalidateQueries({ queryKey: ['scm', 'stock-take-approvals'] });
    },
  });
}

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

/* Reopen a CANCELLED take → OPEN, re-snapshotting its lines to current stock
   (owner 2026-11-23). `lineCount` is how many lines the fresh snapshot holds. */
export function useReopenStockTake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ take: StockTakeRow; lineCount: number }>(`/stock-takes/${id}/reopen`, {
        method: 'PATCH', body: '{}',
      }),
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: ['stock-takes'] });
      void qc.invalidateQueries({ queryKey: ['stock-takes', id] });
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

export const stockTakeAssignees = (t: Pick<StockTakeRow, 'assignee_staff_id' | 'assignee_staff_ids'>): string[] =>
  t.assignee_staff_ids && t.assignee_staff_ids.length > 0
    ? t.assignee_staff_ids
    : t.assignee_staff_id ? [t.assignee_staff_id] : [];

export function useUpdateStockTakeHeader() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; assigneeStaffIds?: string[]; notes?: string | null }) =>
      authedFetch<{ take: StockTakeRow }>(`/stock-takes/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['stock-takes'] });
      void qc.invalidateQueries({ queryKey: ['stock-takes', vars.id] });
    },
  });
}

export type StockTakeBucketOption = { variantKey: string; variantLabel: string | null; qtyHere: number };

export function useStockTakeBucketOptions(takeId: string | null, itemCode: string) {
  const code = itemCode.trim();
  return useQuery({
    queryKey: ['stock-takes', takeId, 'bucket-options', code],
    queryFn: () => authedFetch<{ options: StockTakeBucketOption[] }>(
      `/stock-takes/${encodeURIComponent(takeId ?? '')}/bucket-options?itemCode=${encodeURIComponent(code)}`,
    ).then((r) => r.options),
    enabled: Boolean(takeId && code),
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
}

export function useAddStockTakeLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; itemCode: string; variantKey: string; countedQty: number }) =>
      authedFetch<{ line: StockTakeLine }>(`/stock-takes/${id}/lines`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['stock-takes', vars.id] });
    },
  });
}

/* HC-0140: remove a line added during the count (the server refuses a sheet line). */
export function useDeleteStockTakeLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, lineId }: { id: string; lineId: string }) =>
      authedFetch<{ ok: true }>(`/stock-takes/${id}/lines/${lineId}`, { method: 'DELETE' }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['stock-takes', vars.id] });
    },
  });
}

export function useStockTakeRacks(takeId: string | null) {
  return useQuery({
    queryKey: ['stock-takes', takeId, 'racks'],
    queryFn: () => authedFetch<{ racks: Array<{ id: string; rack: string; zone: string | null }> }>(
      `/stock-takes/${encodeURIComponent(takeId ?? '')}/racks`,
    ).then((r) => r.racks),
    enabled: Boolean(takeId),
    staleTime: 60_000,
    retry: retryUnlessClientError,
  });
}

export type SheetProposal = {
  lineId: string; no: number | null; itemCode: string; variantLabel: string | null;
  counted: number | null; rackText: string | null; rackId: string | null; unclear: boolean;
};
export type SheetUnmatched = {
  no: number | null; itemCode: string | null; counted: number | null; rackText: string | null;
  reason: 'not_on_sheet' | 'ambiguous_code' | 'duplicate_row' | 'no_code';
};
export type SheetRead = {
  takeNoRead: string | null; takeNoMatches: boolean | null;
  proposals: SheetProposal[]; unmatched: SheetUnmatched[];
};

export const readStockTakeSheet = (takeId: string, file: { name: string; mime: string; dataBase64: string }) =>
  authedFetch<SheetRead>(`/stock-takes/${encodeURIComponent(takeId)}/read-sheet`, {
    method: 'POST', body: JSON.stringify({ files: [file] }),
  });
