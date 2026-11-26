
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed, writeFailedAs } from './mutation-error';

export type MrpAllocSource = 'stock' | 'po' | 'shortage';

export type MrpLine = {
  soItemId: string;
  soDocNo: string;
  lineNo?: number | null;
  createdAt?: string | null;
  debtorName: string | null;
  customerState: string | null;
  soDate: string | null;
  deliveryDate: string | null;
  processingDate: string | null;
  orderByDate: string | null;
  qty: number;
  source: MrpAllocSource;
  poNumber: string | null;
  poEta: string | null;
  shortageQty: number;
  poSupplierId: string | null;
  poSupplierName: string | null;
  /* HC-0128 — supplier the line's content routes to (Hydraulic / NB fabric ->
     NB FURNITURE), pre-selected over the SKU's main. Absent on a snapshot
     stored before the field existed. */
  ruleSupplierId?: string | null;
  batchNo?: string | null;
};

export type MrpSku = {
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
  lineNo: number | null;
  createdAt: string | null;
  debtorName: string | null;
  customerState: string | null;
  soDate: string | null;
  deliveryDate: string | null;
  processingDate: string | null;
  orderByDate: string | null;
  itemCode: string;
  description: string | null;
  variantLabel: string | null;
  modules: string[];
  colour: string | null;
  qty: number;
  orderedQty: number;
  shortageQty: number;
  poNumber: string | null;
  poEta: string | null;
  poSupplierId: string | null;
  poSupplierName: string | null;
  stockQty?: number;
  batchNo?: string | null;
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
    lines: number;
    shortageUnits: number;
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
  computedAt?: string;
  stored?: boolean;
};

/** Stock Status Report / MRP — recomputed server-side on every call. */
export function useMrp(params: { category: string | null; warehouseId: string; includeUndated?: boolean }) {
  const { category, warehouseId, includeUndated } = params;
  /* Undated demand is HIDDEN unless the caller asks for it (owner 2026-08-18;
     same default as the server's parseIncludeUndated). Kept in one place so the
     cache key and the query string can never disagree about what was asked for
     — and it must keep matching the server: two defaults for one flag is the
     "one rule, two homes" shape that this codebase keeps paying for. */
  const wantUndated = includeUndated ?? false;
  return useQuery({
    queryKey: ['mrp', category ?? 'all', warehouseId, wantUndated],
    queryFn: () => {
      const q = new URLSearchParams();
      if (category && category !== 'all') q.set('category', category);
      if (warehouseId && warehouseId !== 'all') q.set('warehouseId', warehouseId);
      q.set('includeUndated', wantUndated ? 'true' : 'false');
      const qs = q.toString();
      return authedFetch<MrpResponse>(`/mrp${qs ? `?${qs}` : ''}`);
    },
    staleTime: 30_000,
  });
}

export function useRegenerateMrp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => authedFetch<MrpResponse>(`/mrp/regenerate`, { method: 'POST' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['mrp'] }); },
    onError: writeFailedAs('Could not regenerate the MRP plan'),
  });
}

export type LeadCategory = string;
export type CategoryLeadTimes = Partial<Record<LeadCategory, number>>;
export interface LeadCategoryOption { key: LeadCategory; label: string }

export const GLOBAL_LEAD_KEY = 'null';
export type WarehouseLeadTimes = Record<string, CategoryLeadTimes>;

export function useCategoryLeadTimes() {
  return useQuery({
    queryKey: ['mrp-lead-times'],
    queryFn: () => authedFetch<{ categories: LeadCategoryOption[]; leadTimes: WarehouseLeadTimes }>(`/mrp-lead-times`),
    staleTime: 60_000,
  });
}

export function leadFallbackLabel(
  category: LeadCategory,
  layers: Array<(c: LeadCategory) => number | undefined>,
  labelOf: (c: LeadCategory) => string,
  ownFallbackName: string,
): string {
  const own = layers.slice(1).map((l) => l(category)).find((n) => n !== undefined);
  if (own !== undefined) return `${ownFallbackName}: ${own} days`;
  const next = category === 'others' ? [] : category === 'fabric_accessory' ? ['sofa', 'others'] : ['others'];
  for (const c of next) {
    const n = layers.map((l) => l(c)).find((v) => v !== undefined);
    if (n !== undefined) return `${labelOf(c)}: ${n} days`;
  }
  return '0 days';
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
      qc.invalidateQueries({ queryKey: ['mrp'] });
    },
    onError: writeFailed,
  });
}
