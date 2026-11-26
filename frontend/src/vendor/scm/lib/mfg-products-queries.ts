
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';
import { serviceNotify } from './dialog-service';
import { verifiedSave, readbackGet, friendlySaveMessage } from './verified-save';
import type { MaintPoolEntry } from '@2990s/shared';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import { getActiveCompanyId } from '../../../lib/activeCompany';
import type {
  MaintenanceConfig as MfgMaintenanceConfig,
  MfgPricedOption,
  MfgFabricTier,
} from '@2990s/shared/mfg-pricing';
import { mfgCategoryLabel, type MfgProductCategory } from './product-categories-store';
import { fmtSen } from '../../shared/format';

export type PricedOption = MfgPricedOption;

export type SofaPriceTier = MfgFabricTier;

export type MaintenanceConfig = MfgMaintenanceConfig & {
  supplierCategories?: MaintPoolEntry[];
  bedframeSizes?:    MaintPoolEntry[];
  sofaCompartments?: MaintPoolEntry[];
  mattressSizes?:    MaintPoolEntry[];
  brandings?:        MaintPoolEntry[];
  sofaCompartmentMeta?: Record<string, {
    imageKey?: string;
    description?: string;
    defaultPriceSen?: number;
  }>;
  sofaQuickPresets?: {
    id: string;
    label: string;
    modules: string[];
    sortOrder?: number;
    active?: boolean;
    defaultTier?: SofaPriceTier;
  }[];
  sizeLabels?: Record<string, { label?: string; dimensions?: string }>;
  bedframeCodeFormat?: string;
  bedframeNameFormat?: string;
  sofaCodeFormat?:     string;
  sofaNameFormat?:     string;
  mattressCodeFormat?: string;
  mattressNameFormat?: string;
};

export type MaintenanceResolved = {
  data: MaintenanceConfig | null;
  effectiveFrom: string | null;
  hasPendingPriceChange: boolean;
  pendingEffectiveFrom: string | null;
};

export type MaintenanceHistoryRow = {
  id: string;
  scope: string;
  config: MaintenanceConfig;
  effectiveFrom: string;
  notes: string;
  createdAt: string;
  createdBy: string | null;
  isPending: boolean;
};

/**
 * Maintenance config resolved at the given scope.
 *
 * PR #208 — accepts an `opts.enabled` flag so callers can defer the fetch
 * (e.g. PO pages waiting for the supplier id before scoping the query, or
 * the supplier-pricing tab fetching the master fallback only when the
 * supplier scope is empty). Defaults to enabled when `scope` is truthy.
 */
export function useMaintenanceConfig(
  scope = 'master',
  opts?: { enabled?: boolean },
) {
  const enabled = opts?.enabled ?? Boolean(scope);
  return useQuery({
    queryKey: ['maintenance-config', 'resolved', scope],
    queryFn: () =>
      authedFetch<MaintenanceResolved>(`/maintenance-config/resolved?scope=${encodeURIComponent(scope)}`),
    enabled,
    staleTime: 60_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}


/* FABRIC_ACCESSORY is shown as "Sofa Accessory" (owner 2026-09-14). The code has no
   'sofa' in it on purpose: 41 readers test a group with includes('sofa'), and a pillow
   would become a SOFA main product to all of them. tasks/PLAN-sofa-accessories-category.md */
export type MfgCategory = MfgProductCategory;
export { mfgCategoryLabel };

/** MfgProductRow — the PO New form only reads id/code/name/category off each
    SKU. The ProductModels wave reads a few more SKU columns (size_code for the
    supplier-sku suffix, model_id to group SKUs under a Model, base_price_sen /
    branding for the Model list summary). All extras are OPTIONAL so the PO-page
    callers stay unaffected. The full source row carries ~30 columns the
    vendored pages never touch. */
export type MfgProductRow = {
  id: string;
  code: string;
  name: string;
  category: MfgCategory;
  size_code?: string | null;
  size_label?: string | null;
  base_price_sen: number | null;
  price1_sen: number | null;
  status: 'ACTIVE' | 'INACTIVE';
  branding?: string | null;
  model_id?: string | null;
  sell_price_sen?: number | null;
  seat_height_prices?: SeatHeightPrice[] | null;
  allowed_options?: ModelAllowedOptions | null;
  model_default_variants?: Record<string, string> | null;
  description?: string | null;
  base_model?: string | null;
  model_name?: string | null;
  pwp_price_sen?: number | null;
  unit_m3_milli: number;
  sku_code?: string | null;
  barcode?: string | null;
  sub_assemblies?: unknown;
  pieces?: unknown;
  default_variants?: unknown;
  updated_at?: string;
  one_shot?: boolean;
  source_doc_no?: string | null;
  costAnchorState?: 'ok' | 'conflict' | 'empty' | 'service';
};

/** Sofa-only seat-height price row off the SKU's seat_height_prices JSONB.
 *  `tier` matches the source (optional; a missing tier means a legacy row,
 *  treated as PRICE_2 by the pricing engine). */
export type SeatHeightPrice = { height: string; priceSen: number; tier?: MfgFabricTier };

/** The Model's Modular (allowed_options) pools — single ON/OFF authority for
 *  what a SKU may sell with. `fabrics` holds fabric COLOUR codes. */
export type ModelAllowedOptions = {
  sizes?: string[] | null;
  compartments?: string[] | null;
  divan_heights?: string[] | null;
  total_heights?: string[] | null;
  leg_heights?: string[] | null;
  gaps?: string[] | null;
  fabrics?: string[] | null;
  specials?: string[] | null;
};

function activeCompanyKey(): string {
  return String(getActiveCompanyId() ?? 'default');
}

export function useMfgProducts(opts?: {
  category?: MfgCategory;
  search?: string;
  enabled?: boolean;
  anchorState?: boolean;
  fresh?: boolean;
}) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['mfg-products', activeCompanyKey(), opts?.category ?? 'all', opts?.search ?? '', opts?.anchorState ? 'anchor' : ''],
    queryFn: async ({ signal, queryKey }) => {
      const params = new URLSearchParams();
      if (opts?.category) params.set('category', opts.category);
      if (opts?.search) params.set('search', opts.search);
      if (opts?.anchorState) params.set('anchorState', '1');
      const pastBrowserCache = opts?.fresh || qc.getQueryState(queryKey)?.isInvalidated;
      const res = await authedFetch<{ products: MfgProductRow[] }>(
        `/mfg-products${params.toString() ? `?${params.toString()}` : ''}`,
        { signal, ...(pastBrowserCache ? { cache: 'no-cache' as const } : {}) },
      );
      return res.products;
    },
    enabled: opts?.enabled ?? true,
    refetchOnMount: opts?.fresh ? 'always' : true,
    /* HOUZS VENDOR perf deviation (owner 2026-07-03, "Loading Catalog is
       slow"): the catalog is stable reference data, so cache it 5 min and
       keep the previous page's rows on screen while a new (category, search)
       key fetches — the mobile SKU picker no longer blanks to "Loading
       Catalog" on every open/keystroke. */
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

/** Client-side product search — matches the SAME fields the `/mfg-products?search`
 *  server filter does: code / name / description / barcode, case-insensitive
 *  substring (backend routes/mfg-products.ts:204). The SKU pickers filter the
 *  cached list with THIS instead of firing a per-keystroke `?search=` request,
 *  which stalled or dropped the connection while the Worker was slow (owner
 *  2026-09-23: "product code search slow"). Pure, so it is unit-tested. */
export function matchesProductQuery(
  p: Pick<MfgProductRow, 'code' | 'name' | 'description' | 'barcode'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return (
    p.code.toLowerCase().includes(q)
    || p.name.toLowerCase().includes(q)
    || (p.description ?? '').toLowerCase().includes(q)
    || (p.barcode ?? '').toLowerCase().includes(q)
  );
}

export function useMfgProductBoundCodes() {
  return useQuery({
    queryKey: ['mfg-product-bound-codes', activeCompanyKey()],
    queryFn: async () => {
      const res = await authedFetch<{ codes: string[] }>('/mfg-products/bound-codes');
      return new Set(res.codes);
    },
    staleTime: 60_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

export interface SpecialAddonChoice { label: string; extraSen: number; }
export interface SpecialAddonGroup { label: string; required: boolean; choices: SpecialAddonChoice[]; }
export interface SpecialAddonRow {
  id: string;
  code: string;
  label: string;
  soDescription: string;
  categories: string[];
  sellingPriceSen: number;
  costPriceSen: number;
  optionGroups: SpecialAddonGroup[];
  active: boolean;
  sortOrder: number;
}

export const useSpecialAddons = () =>
  useQuery({
    queryKey: ['special-addons'],
    staleTime: 60_000,
    queryFn: async (): Promise<SpecialAddonRow[]> => {
      const body = await authedFetch<{ addons: SpecialAddonRow[] }>('/special-addons');
      return body.addons ?? [];
    },
  });

export function useUpdateMfgProductStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; status: 'ACTIVE' | 'INACTIVE' }) => {
      const { id, status } = args;
      return authedFetch<{ ok: boolean; changed: number }>(`/mfg-products/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mfg-products'] });
      qc.invalidateQueries({ queryKey: ['product-models'] });
    },
  });
}

/* The raw by-code payload — allowed_options pools + the SKU's REAL category.
   `category` (owner 2026-07-13) lets the SO line editor recognise a sofa/
   bedframe line whose persisted itemGroup came in generic (scan / backdoor
   drafts) and render the right configurator. Null for legacy/unknown codes. */
type ModelByCodeResult = {
  allowedOptions: ModelAllowedOptions | null;
  category: MfgCategory | null;
};

type RawByCode = { allowedOptions?: ModelAllowedOptions | null; category?: string | null };

const normaliseByCode = (res: RawByCode): ModelByCodeResult => ({
  allowedOptions: res.allowedOptions ?? null,
  category: res.category ? (res.category.toUpperCase() as MfgCategory) : null,
});

type ByCodeJob = {
  code: string;
  resolve: (r: ModelByCodeResult) => void;
  reject: (e: unknown) => void;
};

const BY_CODE_BATCH_MAX = 100;

let byCodeQueue: ByCodeJob[] = [];
let byCodeFlushScheduled = false;

async function flushByCodeQueue(): Promise<void> {
  const jobs = byCodeQueue;
  byCodeQueue = [];
  byCodeFlushScheduled = false;
  if (jobs.length === 0) return;

  for (let i = 0; i < jobs.length; i += BY_CODE_BATCH_MAX) {
    const chunk = jobs.slice(i, i + BY_CODE_BATCH_MAX);
    const codes = [...new Set(chunk.map((j) => j.code))];
    try {
      const params = new URLSearchParams();
      for (const code of codes) params.append('code', code);
      const res = await authedFetch<{ results?: Record<string, RawByCode | undefined> }>(
        `/product-models/by-code-batch?${params.toString()}`,
      );
      for (const job of chunk) {
        const row = res.results?.[job.code];
        if (!row) {
          job.reject(new Error(`by-code-batch returned no entry for ${job.code}`));
          continue;
        }
        job.resolve(normaliseByCode(row));
      }
    } catch (e) {
      for (const job of chunk) job.reject(e);
    }
  }
}

function loadModelByCode(code: string): Promise<ModelByCodeResult> {
  return new Promise<ModelByCodeResult>((resolve, reject) => {
    byCodeQueue.push({ code, resolve, reject });
    if (byCodeFlushScheduled) return;
    byCodeFlushScheduled = true;
    queueMicrotask(() => { void flushByCodeQueue(); });
  });
}

const modelByCodeQueryOptions = (itemCode: string | undefined) => ({
  enabled: Boolean(itemCode),
  queryKey: ['model-allowed-options-by-code', itemCode] as const,
  staleTime: 60_000,
  queryFn: async (): Promise<ModelByCodeResult> => {
    if (!itemCode) return { allowedOptions: null, category: null };
    return loadModelByCode(itemCode);
  },
});

export const useModelAllowedOptionsByCode = (itemCode: string | undefined) =>
  useQuery({
    ...modelByCodeQueryOptions(itemCode),
    select: (r: ModelByCodeResult) => r.allowedOptions,
  });

/* The SKU's REAL category resolved from its item code (via the SAME by-code
   query as useModelAllowedOptionsByCode — one network round-trip serves both).
   The SO line editor uses this to drive the variant configurator off the SKU's
   true category when a saved line's itemGroup is generic (owner 2026-07-13). */
export const useSkuCategoryByCode = (itemCode: string | undefined) =>
  useQuery({
    ...modelByCodeQueryOptions(itemCode),
    select: (r: ModelByCodeResult) => r.category,
  });


export function useUpdateMfgProductPrices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      id: string;
      basePriceSen?: number | null;
      price1Sen?: number | null;
      costPriceSen?: number | null;
      seatHeightPrices?: SeatHeightPrice[];
      branding?: string | null;
      barcode?: string | null;
      subAssemblies?: string[];
      pieces?: { count: number; names: string[] } | null;
      defaultVariants?: Record<string, unknown>;
      notes?: string;
      code?: string;
      name?: string;
    }) => {
      const { id, ...body } = args;
      const expect: Record<string, unknown> = {};
      if (body.basePriceSen !== undefined) expect.base_price_sen = body.basePriceSen;
      if (body.price1Sen    !== undefined) expect.price1_sen     = body.price1Sen;
      if (body.costPriceSen !== undefined) expect.cost_price_sen = body.costPriceSen;
      if (body.barcode      !== undefined) expect.barcode        = body.barcode;
      if (body.code         !== undefined) expect.code           = body.code.trim();
      if (body.name         !== undefined) expect.name           = body.name.trim();

      const result = await verifiedSave<{ product: Record<string, unknown> }>({
        endpoint: `/mfg-products/${id}`,
        method: 'PATCH',
        body,
        readback: () => readbackGet<{ product: Record<string, unknown> }>(`/mfg-products/${id}`),
        expect,
        accessor: (d, f) => d?.product?.[f],
      });

      const message = (r: Exclude<typeof result, { ok: true }>) => friendlySaveMessage(r, {
        noun: 'change',
        fieldNames: { base_price_sen: 'Base price', price1_sen: 'Price 1', cost_price_sen: 'Cost price', name: 'Description', code: 'Product code' },
        fmt: (v) => (v == null ? '(blank)' : fmtSen(Number(v))),
      });
      if (!result.ok && result.reason === 'unverified') {
        void serviceNotify({ title: 'Saved', body: message(result), tone: 'info' });
        return { ok: true as const, changed: 1 };
      }
      if (!result.ok) throw new Error(message(result));
      return { ok: true as const, changed: 1 };
    },
    onError: (err) => {
      serviceNotify({ title: 'Save failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mfg-products'] });
    },
  });
}

export type MasterPriceHistoryRow = {
  id: string;
  item_code: string;
  field: string;
  old_value_sen: number | null;
  new_value_sen: number | null;
  reason: string | null;
  changed_at: string;
  changed_by: string | null;
};

export function useMfgProductPriceHistory(id: string | null) {
  return useQuery({
    queryKey: ['mfg-product-price-history', id],
    queryFn: () => authedFetch<{ history: MasterPriceHistoryRow[] }>(`/mfg-products/${id}/price-history`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export type MfgProductPriceChangeRow = {
  id: string;
  effective_from: string;
  sell_price_sen: number | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
};

export type MfgProductPriceChanges = {
  history: MfgProductPriceChangeRow[];
  currentSellPriceSen: number | null;
  pending: { sellPriceSen: number; effectiveFrom: string } | null;
};

export function useMfgProductPriceChanges(id: string | null) {
  return useQuery({
    queryKey: ['mfg-product-price-changes', id],
    queryFn: () => authedFetch<MfgProductPriceChanges>(`/mfg-products/${id}/price-changes`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function useCreateMfgProductPriceChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; effectiveFrom: string; sellPriceSen: number; notes?: string }) => {
      const { id, ...body } = args;
      return authedFetch<{ ok: boolean; baselined: boolean }>(
        `/mfg-products/${id}/price-changes`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mfg-product-price-changes'] });
    },
  });
}

export type ProductSupplierRow = {
  id: string;
  supplier_id: string;
  supplier_sku: string;
  unit_price_sen: number;
  currency: string;
  lead_time_days: number;
  moq: number;
  is_main_supplier: boolean;
  notes: string | null;
  suppliers: {
    code: string;
    name: string;
    phone: string | null;
  } | null;
};
export type ProductCostAnchorState = 'ok' | 'conflict' | 'empty' | 'service';
export type ProductCostAnchor = {
  state: ProductCostAnchorState;
  reason: string | null;
  anchorSupplierId: string | null;
  anchorSupplierName: string | null;
  costSen: number | null;
  costedCount: number;
  totalCount: number;
};

export function useMfgProductSuppliers(id: string | null) {
  return useQuery({
    queryKey: ['mfg-product-suppliers', id],
    queryFn: () => authedFetch<{
      product: { code: string; name: string; category: string };
      suppliers: ProductSupplierRow[];
      anchor: ProductCostAnchor;
    }>(`/mfg-products/${id}/suppliers`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export type MfgProductCostHistoryRow = {
  id: string;
  effectiveFrom: string;
  basePriceSen: number | null;
  price1Sen: number | null;
  seatHeightPrices: unknown | null;
  sourceSupplierId: string | null;
  sourceSupplierName: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
};
export function useMfgProductCostHistory(id: string | null) {
  return useQuery({
    queryKey: ['mfg-product-cost-history', id],
    queryFn: () => authedFetch<{ history: MfgProductCostHistoryRow[] }>(`/mfg-products/${id}/cost-history`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export type SupplierPriceHistoryRow = {
  id: string;
  supplierId: string;
  supplierCode: string | null;
  supplierName: string | null;
  isMainSupplier: boolean;
  unitPriceSen: number | null;
  priceMatrix: unknown | null;
  comparableSen: number | null;
  direction: 'up' | 'down' | null;
  effectiveFrom: string;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
};
export function useMfgProductSupplierPriceHistory(id: string | null) {
  return useQuery({
    queryKey: ['mfg-product-supplier-price-history', id],
    queryFn: () => authedFetch<{ history: SupplierPriceHistoryRow[] }>(`/mfg-products/${id}/supplier-price-history`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

/** Body shape for POST /mfg-products. id + status default server-side. */
export type NewMfgProductInput = {
  code: string;
  name: string;
  category: MfgCategory;
  description?: string;
  baseModel?: string;
  sizeCode?: string;
  sizeLabel?: string;
  basePriceSen?: number | null;
  price1Sen?: number | null;
  costPriceSen?: number | null;
  unitM3Milli?: number;
  fabricUsageSen?: number;
  productionTimeMinutes?: number;
  branding?: string;
  fabricColor?: string;
  barcode?: string;
};

export function useCreateMfgProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewMfgProductInput) =>
      authedFetch<{ id: string; code: string }>(`/mfg-products`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mfg-products'] });
    },
  });
}

export type BatchImportRow = {
  code: string;
  name: string;
  category: string;
  description?: string;
  base_model?: string;
  size_label?: string;
  status?: string;
  branding?: string;
  base_price_sen?: number;
  price1_sen?: number;
  unit_m3_milli?: number;
  seatHeightPrices?: SeatHeightPrice[];
};

export type BatchImportResult = {
  upserted: number;
  created?: number;
  failed: number;
  failures: Array<{ code: string; reason: string }>;
  modelsMoved?: ImportModelMove[];
};

export type ImportModelMove = {
  modelCode: string;
  modelName: string | null;
  from: string;
  to: string;
  skuCount: number;
};

export function useBatchImportMfgProducts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rows: BatchImportRow[]) =>
      authedFetch<BatchImportResult>(`/mfg-products/batch-import`, {
        method: 'POST',
        body: JSON.stringify({ rows }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mfg-products'] });
    },
  });
}

export function useDeleteMfgProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: string | { id: string; force?: boolean }) => {
      const id    = typeof args === 'string' ? args : args.id;
      const force = typeof args === 'string' ? false : !!args.force;
      const qs    = force ? '?force=true' : '';
      return authedFetch<void>(`/mfg-products/${encodeURIComponent(id)}${qs}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mfg-products'] });
    },
  });
}

export function useMaintenanceConfigHistory(scope = 'master') {
  return useQuery({
    queryKey: ['maintenance-config', 'history', scope],
    queryFn: () =>
      authedFetch<{ history: MaintenanceHistoryRow[] }>(
        `/maintenance-config/history?scope=${encodeURIComponent(scope)}`,
      ),
    staleTime: 30_000,
  });
}

export interface SpecialAddonInput {
  code: string;
  label: string;
  soDescription: string;
  categories: string[];
  sellingPriceSen: number;
  costPriceSen: number;
  optionGroups: SpecialAddonGroup[];
  active: boolean;
  sortOrder: number;
}

export const useCreateSpecialAddon = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SpecialAddonInput) =>
      authedFetch<{ id: string }>('/special-addons', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['special-addons'] }); },
  });
};

export const useUpdateSpecialAddon = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<SpecialAddonInput> }) =>
      authedFetch<void>(`/special-addons/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['special-addons'] }); },
  });
};

export const useDeleteSpecialAddon = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<void>(`/special-addons/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['special-addons'] }); },
  });
};

export interface SpecialAddonSnapshotEntry extends SpecialAddonInput {}
export type SpecialAddonsHistoryRow = {
  id: string;
  addons: SpecialAddonRow[];
  effectiveFrom: string;
  notes: string;
  createdAt: string;
  createdBy: string | null;
  isPending: boolean;
};

export const useSpecialAddonsHistory = () =>
  useQuery({
    queryKey: ['special-addons', 'history'],
    staleTime: 30_000,
    queryFn: async (): Promise<SpecialAddonsHistoryRow[]> => {
      const body = await authedFetch<{ history: SpecialAddonsHistoryRow[] }>('/special-addons/history');
      return body.history ?? [];
    },
  });

export const useSaveSpecialAddons = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { effectiveFrom: string; notes?: string; addons: SpecialAddonSnapshotEntry[] }) =>
      authedFetch<{ id: string; effectiveFrom: string; notes: string }>(
        '/special-addons/save',
        { method: 'POST', body: JSON.stringify(args) },
      ),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['special-addons'] }); },
  });
};

/** What scm.rename_sofa_compartment reports, for a preview or a run. */
export type SofaCompartmentRenameResult = {
  from: string;
  to: string;
  applied: boolean;
  refused: 'in_use' | null;
  inUse: Record<string, number>;
  inUseTotal: number;
  changes: Record<string, number>;
  photoCleared: boolean;
};

/**
 * Renames a sofa compartment code in the ACTIVE company only. `apply: false`
 * is a preview (no write). A code still used by any SKU, document or stock row
 * of the company is refused (409 in_use).
 */
export function useRenameSofaCompartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { from: string; to: string; apply: boolean }) => {
      return authedFetch<{ ok: boolean; applied: boolean; result: SofaCompartmentRenameResult }>(
        `/maintenance-config/sofa-compartments/rename`,
        { method: 'POST', body: JSON.stringify(args) },
      );
    },
    onSuccess: (_data, args) => {
      if (!args.apply) return;
      qc.invalidateQueries({ queryKey: ['maintenance-config'] });
      qc.invalidateQueries({ queryKey: ['product-models'] });
      qc.invalidateQueries({ queryKey: ['sofa-combos'] });
    },
  });
}

export function useSaveMaintenanceConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      scope: string;
      config: MaintenanceConfig;
      effectiveFrom: string;
      notes?: string;
    }) => {
      return authedFetch<{
        id: string;
        scope: string;
        config: MaintenanceConfig;
        effectiveFrom: string;
        notes: string;
      }>(`/maintenance-config/changes`, {
        method: 'POST',
        body: JSON.stringify(args),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-config'] });
    },
    onError: writeFailed,
  });
}

export function useUploadSofaCompartmentPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ code, file }: { code: string; file: File }) => {
      const fd = new FormData();
      fd.append('file', file);
      return authedFetch<{ photoUrl: string; photoKey: string }>(
        `/maintenance-config/sofa-compartments/${encodeURIComponent(code)}/photo`,
        { method: 'POST', body: fd },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-config'] });
    },
  });
}

export function useDeleteSofaCompartmentPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) => {
      return authedFetch<{ ok: true }>(
        `/maintenance-config/sofa-compartments/${encodeURIComponent(code)}/photo`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance-config'] });
    },
    onError: writeFailed,
  });
}

export interface AdminAddonRow {
  id: string;
  label: string;
  description: string | null;
  icon: string;
  kind: 'qty' | 'floors_items' | 'flat';
  category: string | null;
  price: number;
  perFloorItem: number | null;
  unit: string | null;
  defaultQty: number;
  stock: number | null;
  enabled: boolean;
  showAtHandover: boolean;
  serviceSku: string | null;
  sortOrder: number;
}

export const useAllAddons = () =>
  useQuery({
    queryKey: ['addons-all'],
    staleTime: 60_000,
    queryFn: async (): Promise<AdminAddonRow[]> => {
      const body = await authedFetch<{ addons: AdminAddonRow[] }>('/addons');
      return body.addons ?? [];
    },
  });

export const useUpdateAddon = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; patch: { price?: number; perFloorItem?: number | null; enabled?: boolean; showAtHandover?: boolean; serviceSku?: string | null } }): Promise<{ addon: AdminAddonRow }> =>
      authedFetch<{ addon: AdminAddonRow }>(`/addons/${encodeURIComponent(args.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(args.patch),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['addons-all'] }); },
  });
};

export const useCreateAddon = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (row: {
      id: string; label: string; description: string | null; icon: string;
      kind: 'qty' | 'floors_items' | 'flat'; category: string | null;
      price: number; perFloorItem: number | null; unit: string | null;
      stock: number | null; enabled: boolean; showAtHandover: boolean;
      serviceSku: string | null; sortOrder: number;
    }): Promise<{ addon: AdminAddonRow }> =>
      authedFetch<{ addon: AdminAddonRow }>('/addons', {
        method: 'POST',
        body: JSON.stringify(row),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['addons-all'] }); },
  });
};

export const useDeleteAddon = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string): Promise<{ ok: true }> =>
      authedFetch<{ ok: true }>(`/addons/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['addons-all'] }); },
  });
};
