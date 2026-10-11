// Vendored SLICE of apps/backend/src/lib/warehouse-queries.ts — only the Rack
// type + useRacks() the GRN pages read (the optional per-line destination Rack
// picker on New GRN, and the GRN detail's rack-label resolution). The full
// source module (rack CRUD, movements, summary KPIs, stock-in/out) is not
// pulled in — the GRN pages never call it.
//
// HOUZS VENDOR NOTE: the source `import { supabase } from './supabase'` was
// imported but NEVER referenced (all reads go through authedFetch); DROPPED here
// exactly as in the vendored inventory-queries slice. useRacks is copied
// verbatim, routed through the vendored authedFetch (→ /api/scm/warehouse).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type RackStatus = 'OCCUPIED' | 'EMPTY' | 'RESERVED';

export type RackItem = {
  id: string;
  rack_id: string;
  product_code: string;
  product_name: string | null;
  size_label: string | null;
  customer_name: string | null;
  source_doc_no: string | null;
  qty: number;
  stocked_in_date: string;
  notes: string | null;
};

export type Rack = {
  id: string;
  warehouse_id: string;
  rack: string;
  position: string | null;
  status: RackStatus;
  reserved: boolean;
  notes: string | null;
  items: RackItem[];
  created_at: string;
  updated_at: string;
};

export type RackSummary = {
  total: number;
  occupied: number;
  empty: number;
  reserved: number;
  occupancyRate: number;
};

export type WarehouseOption = { id: string; code: string; name: string };

/* ── Rack grid + KPI summary ──────────────────────────────────────────── */
export function useRacks(opts?: { warehouseId?: string }) {
  return useQuery({
    queryKey: ['warehouse', 'racks', opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.warehouseId) params.set('warehouseId', opts.warehouseId);
      return authedFetch<{ racks: Rack[]; warehouses: WarehouseOption[]; summary: RackSummary }>(
        `/warehouse${params.toString() ? `?${params.toString()}` : ''}`,
      );
    },
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
}

/* ── Rack CRUD ────────────────────────────────────────────────────────────
   HOUZS VENDOR — Desktop Racks & Bins page (feat/desktop-rack-management). The
   original slice pulled in only the useRacks() READ hook (the GRN pages never
   wrote racks). The desktop Racks page is the create surface the GRN per-line
   picker was missing, so the write mutations are pulled in here, verbatim in
   shape against the existing backend routes:
     POST   /warehouse/racks       — single { warehouseId, rack, position?,
                                       reserved?, notes? } OR seed
                                       { warehouseId, count, prefix? }
     PATCH  /warehouse/racks/:id    — { rack?, position?, notes?, reserved? }
     DELETE /warehouse/racks/:id    — only when the rack is empty (backend 409)
   Every mutation invalidates the ['warehouse','racks'] query family so the grid
   + KPI summary refetch. */

/* Scope — which warehouse RECORD(s) the rack(s) are created into. A rack shared
   across warehouses is materialised as one row per target (fan-out on create),
   so pass a single warehouseId (back-compat), a chosen set (warehouseIds), or
   allWarehouses:true. Exactly one of the three is used, resolved server-side. */
export type RackScope =
  | { warehouseId: string }
  | { warehouseIds: string[] }
  | { allWarehouses: true };

export type CreateRackBody =
  | (RackScope & { rack: string; position?: string; reserved?: boolean; notes?: string })
  | (RackScope & { count: number; prefix?: string });

export function useCreateRack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRackBody) =>
      authedFetch<{ rack?: Rack; racks?: Rack[]; created?: number }>(`/warehouse/racks`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['warehouse', 'racks'] }),
  });
}

export function useUpdateRack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; rack?: string; position?: string; notes?: string; reserved?: boolean }) =>
      authedFetch<{ rack: Rack; status: RackStatus }>(`/warehouse/racks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['warehouse', 'racks'] }),
  });
}

export function useDeleteRack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ ok: true }>(`/warehouse/racks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['warehouse', 'racks'] }),
  });
}

/* ── Stock in / out / transfer + movement ledger ───────────────────────────
   HOUZS VENDOR — Warehouse (Rack/REC) desktop experience (feat/rec-warehouse-
   desktop-p1). The rich 3-tab Warehouse page needs the stock-flow mutations and
   the movement ledger read the plain Racks & Bins grid never used. All hit the
   existing backend routes verbatim in shape:
     POST /warehouse/stock-in  — { rackId, productCode, productName?, sizeLabel?,
                                   customerName?, sourceDocNo?, qty?, notes?, reason? }
     POST /warehouse/stock-out — { itemId, reason? }
     POST /warehouse/transfer  — { fromItemId, toRackId, qty? }  (same warehouse)
     GET  /warehouse/movements — ?type&from&to&warehouseId&limit
   Every mutation invalidates the whole ['warehouse'] query family so BOTH the
   rack grid (['warehouse','racks']) and the ledger (['warehouse','movements'])
   refetch. */

export type RackMovementType = 'STOCK_IN' | 'STOCK_OUT' | 'TRANSFER';

export type RackMovement = {
  id: string;
  movement_type: RackMovementType;
  rack_id: string | null;
  rack_label: string | null;
  to_rack_id: string | null;
  to_rack_label: string | null;
  warehouse_id: string | null;
  product_code: string;
  variant_key: string | null;
  product_name: string | null;
  source_doc_no: string | null;
  quantity: number;
  reason: string | null;
  performed_by: string | null;
  created_at: string;
};

export type StockInBody = {
  rackId: string;
  productCode: string;
  productName?: string;
  sizeLabel?: string;
  customerName?: string;
  sourceDocNo?: string;
  qty?: number;
  notes?: string;
  reason?: string;
};

export function useStockIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StockInBody) =>
      authedFetch<{ item: RackItem; status: RackStatus }>(`/warehouse/stock-in`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['warehouse'] }),
  });
}

export function useStockOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { itemId: string; reason?: string }) =>
      authedFetch<{ ok: true; status: RackStatus | null }>(`/warehouse/stock-out`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['warehouse'] }),
  });
}

export function useTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { fromItemId: string; toRackId: string; qty?: number; reason?: string }) =>
      authedFetch<{ ok: true; fromStatus: RackStatus; toStatus: RackStatus }>(`/warehouse/transfer`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['warehouse'] }),
    onError: writeFailedAs('Rack transfer not saved'),
  });
}

export function useMovements(opts?: {
  type?: RackMovementType | '';
  from?: string;
  to?: string;
  warehouseId?: string;
}) {
  return useQuery({
    queryKey: ['warehouse', 'movements', opts ?? {}],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.type) params.set('type', opts.type);
      if (opts?.from) params.set('from', opts.from);
      if (opts?.to) params.set('to', opts.to);
      if (opts?.warehouseId) params.set('warehouseId', opts.warehouseId);
      return authedFetch<{ movements: RackMovement[] }>(
        `/warehouse/movements${params.toString() ? `?${params.toString()}` : ''}`,
      ).then((r) => r.movements);
    },
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });
}
