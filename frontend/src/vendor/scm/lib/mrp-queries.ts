// Vendored from apps/backend/src/lib/mrp-queries.ts — the TanStack Query hooks
// for /mrp (the trading-company Stock Status Report) + per-category lead times.
//
// HOUZS VENDOR NOTE: the source module's lead-time PUT mutation hand-rolled a
// fetch with a supabase.auth.getSession() bearer token. Here the same write
// goes through the vendored authedFetch (→ /api/scm/mrp-lead-times), which
// reads the token from localStorage['auth:token']; the supabase import and the
// raw fetch are dropped. Everything else (the MRP read hooks + types) is copied
// verbatim.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';

export type MrpAllocSource = 'stock' | 'po' | 'shortage';

export type MrpLine = {
  soItemId: string;
  soDocNo: string;
  /* Canonical stored listing order within the SO (migration 0165) — the Sofa
     tab orders an SO's module rows by this so they read LHF → NA → RHF exactly
     as the SO detail + SO PDF do. NULL on legacy lines (created_at fallback). */
  lineNo?: number | null;
  createdAt?: string | null;
  debtorName: string | null;
  customerState: string | null;  // staff #8 — info-only, from the SO's customer_state
  soDate: string | null;
  deliveryDate: string | null;
  processingDate: string | null;
  /* Commander 2026-05-29 — order-by date = delivery − category lead days. */
  orderByDate: string | null;
  qty: number;
  source: MrpAllocSource;
  poNumber: string | null;
  poEta: string | null;
  shortageQty: number;
  /* Commander 2026-05-31 — when source==='po', the covering PO's supplier so a
     covered line shows it READ-ONLY (a raised PO's supplier can't change).
     NULL on stock / shortage lines. */
  poSupplierId: string | null;
  poSupplierName: string | null;
};

export type MrpSku = {
  /* Commander 2026-05-31 — each row is scoped to ONE warehouse (per-WH MRP);
     the same SKU+variant in two warehouses produces two rows. NULL when the
     demand line has no warehouse bound yet. */
  warehouseId: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  itemCode: string;
  variantKey: string;
  variantLabel: string | null;
  description: string | null;
  category: string | null;
  qtyNeeded: number;
  stock: number;
  poOutstanding: number;
  shortage: number;
  mainSupplierCode: string | null;
  mainSupplierName: string | null;
  suppliers: Array<{ supplierId: string; code: string; name: string; isMain: boolean }>;
  lines: MrpLine[];
};

export type MrpWarehouse = { id: string; code: string; name: string };

/* Sofa is ordered as a colour-matched SET, one per SO line ("每张 SO 一套"). */
export type SofaSet = {
  warehouseId: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  soItemId: string;
  soDocNo: string;
  /* Canonical stored listing order within the SO (migration 0165). NULL on
     legacy lines → groupBySo falls back to created_at, then item_code. */
  lineNo: number | null;
  createdAt: string | null;
  debtorName: string | null;
  customerState: string | null;  // staff #8 — info-only, from the SO's customer_state
  soDate: string | null;
  deliveryDate: string | null;
  processingDate: string | null;
  orderByDate: string | null; // delivery − category lead days
  itemCode: string;
  description: string | null;
  variantLabel: string | null;
  modules: string[];
  colour: string | null;
  qty: number;
  orderedQty: number;
  shortageQty: number;
  poNumber: string | null; // PO(s) this set's units were raised into
  poEta: string | null;    // earliest PO-line delivery date (when goods arrive)
  poSupplierId: string | null;   // covering PO's supplier (read-only on covered sets)
  poSupplierName: string | null; // …resolved name; null for stock/shortage sets
  suppliers: Array<{ supplierId: string; code: string; name: string; isMain: boolean }>;
};

export type MrpResponse = {
  asOf: string;
  categories: string[];
  warehouses: MrpWarehouse[];
  skus: MrpSku[];
  sofaSets: SofaSet[];
  /* Demand with no delivery date, counted whether or not it was RENDERED —
     `hidden` is the server saying which it did. The page must show this: a
     filter the operator cannot see turned a real shortage into an invisible one
     (owner, 2026-08-16). Optional on the type only so a response from a backend
     that predates the field still parses. */
  undated?: {
    /** General (non-sofa) path — respects the category + warehouse filters. */
    lines: number;
    shortageUnits: number;
    /** Sofa path — SOFA-by-construction and NOT category-filtered, so read it
        on the sofa view only or it overstates every other tab. */
    sofaSets: number;
    sofaShortageUnits: number;
    hidden: boolean;
  };
  totals: {
    skuCount: number;
    shortageSkuCount: number;
    shortageUnits: number;
    sofaSetCount: number;
    sofaSetShortageCount: number;
  };
};

/** Stock Status Report / MRP — recomputed server-side on every call. */
export function useMrp(params: { category: string; warehouseId: string; includeUndated?: boolean }) {
  const { category, warehouseId, includeUndated } = params;
  /* Undated demand is HIDDEN unless the caller asks for it (owner 2026-08-18;
     same default as the server's parseIncludeUndated). Kept in one place so the
     cache key and the query string can never disagree about what was asked for
     — and it must keep matching the server: two defaults for one flag is the
     "one rule, two homes" shape that this codebase keeps paying for. */
  const wantUndated = includeUndated ?? false;
  return useQuery({
    queryKey: ['mrp', category, warehouseId, wantUndated],
    queryFn: () => {
      const q = new URLSearchParams();
      if (category && category !== 'all') q.set('category', category);
      if (warehouseId && warehouseId !== 'all') q.set('warehouseId', warehouseId);
      /* ALWAYS sent, in BOTH directions. The old `if (includeUndated) set(...)`
         expressed "hide" by SILENCE, which only worked while the server default
         happened to agree. Now that the default is true, silence would mean
         "show" and unticking the box would have changed nothing on screen —
         the omitted-parameter no-op this repo keeps re-learning. The client
         states what it wants and the response's `undated.hidden` states what it
         got, so a flag the server did not honour is visible from the answer. */
      q.set('includeUndated', wantUndated ? 'true' : 'false');
      const qs = q.toString();
      return authedFetch<MrpResponse>(`/mrp${qs ? `?${qs}` : ''}`);
    },
    staleTime: 30_000,
  });
}

/* ── Per-category lead times (Commander 2026-05-29), now per-WAREHOUSE
      (Commander 2026-06-22, migration 0184 / SCM mig 0036) ──────────────────── */
export type LeadCategory = 'sofa' | 'bedframe' | 'mattress' | 'accessory' | 'service';
export type CategoryLeadTimes = Record<LeadCategory, number>;
export const LEAD_CATEGORIES: LeadCategory[] = ['sofa', 'bedframe', 'mattress', 'accessory', 'service'];

/* Per-warehouse lead-time map. The global-defaults bucket is under the key
   "null"; each warehouse under its uuid. A warehouse with no override yet has
   no entry — callers fall back to the "null" bucket. */
export const GLOBAL_LEAD_KEY = 'null';
export type WarehouseLeadTimes = Record<string, CategoryLeadTimes>;

export function useCategoryLeadTimes() {
  return useQuery({
    queryKey: ['mrp-lead-times'],
    queryFn: () => authedFetch<{ leadTimes: WarehouseLeadTimes }>(`/mrp-lead-times`),
    staleTime: 60_000,
  });
}

export function useUpdateCategoryLeadTime() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { warehouseId: string | null; category: LeadCategory; leadDays: number }) =>
      authedFetch<{ ok: true; warehouseId: string | null; category: LeadCategory; leadDays: number }>(`/mrp-lead-times`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mrp-lead-times'] });
      qc.invalidateQueries({ queryKey: ['mrp'] }); // order-by dates recompute
    },
    onError: writeFailed,
  });
}
