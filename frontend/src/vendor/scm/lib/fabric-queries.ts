
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { serviceNotify } from './dialog-service';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

const fabricWriteFailed = (err: unknown) => {
  void serviceNotify({
    title: 'That change was not saved',
    body: err instanceof Error ? err.message : 'Something went wrong. Please try again.',
    tone: 'error',
  });
};

export type FabricCategoryValue = 'B.M-FABR' | 'S-FABR' | 'S.M-FABR' | 'LINING' | 'WEBBING';
export type FabricTier = 'PRICE_1' | 'PRICE_2' | 'PRICE_3' | 'PRICE_4';
export type FabricTierField = 'sofaPriceTier' | 'bedframePriceTier';

export const FABRIC_TIER_OPTIONS: Record<FabricTierField, readonly FabricTier[]> = {
  sofaPriceTier:     ['PRICE_1', 'PRICE_2', 'PRICE_3', 'PRICE_4'],
  bedframePriceTier: ['PRICE_1', 'PRICE_2'],
};

const SOFA_TIER_NAMES: Partial<Record<FabricTier, string>> = { PRICE_3: 'Price 3 (HL)', PRICE_4: 'Price 4 (FL)' };

export const fabricTierLabel = (t: FabricTier | null, field: FabricTierField): string => {
  if (!t) return '—';
  return (field === 'sofaPriceTier' ? SOFA_TIER_NAMES[t] : undefined) ?? `Price ${t.replace('PRICE_', '')}`;
};

export type FabricTrackingRow = {
  id: string;
  fabric_code: string;
  fabric_description: string | null;
  fabric_category: FabricCategoryValue | null;
  price_tier: FabricTier | null;
  sofa_price_tier: FabricTier | null;
  bedframe_price_tier: FabricTier | null;
  price_sen: number;
  soh_sen: number;
  po_outstanding_sen: number;
  last_month_usage_sen: number;
  one_week_usage_sen: number;
  two_weeks_usage_sen: number;
  one_month_usage_sen: number;
  shortage_sen: number;
  reorder_point_sen: number;
  supplier: string | null;
  supplier_code: string | null;
  lead_time_days: number;
  series: string | null;
  /* Migration 0167 — Fabric Converter ACTIVE toggle (owner spec 2026-06-12).
     Inactive fabrics hide from NEW-entry pickers; existing docs keep their
     code. Optional so the UI tolerates an API that predates the migration. */
  is_active?: boolean | null;
};

/* WHICH FABRIC CODES ARE RETIRED — asked per CODE, never per ROW.
   `scm.fabric_trackings` is keyed by `id`, not by `fabric_code`, and 21 codes on
   production carry TWO rows for the same code: one active and one retired,
   usually a plain id beside a `FABRIC_`-prefixed twin (`HR805-90` retired
   alongside `FABRIC_HR805-90` active; the same for HR805-10 and AVANI-01..12).

   Built from the retired ROWS alone, the dead twin hides the live one - so a
   fabric the floor sells disappears from the picker. MEASURED 2026-09-11: the
   filter hid 21 active colours and ALL 21 were hidden WRONGLY, an active row
   existing for every one. Zero legitimate hides; the filter was doing nothing
   but harm.

   Same mistake, third table in one day (docs/bugs/0817 for the fabric library,
   0814 for the option pools), which is why this is a shared helper and not a
   `filter` at the call site. docs/bugs/0818. */
export const inactiveFabricCodeSet = (
  rows: readonly { fabric_code?: string | null; is_active?: boolean | null }[],
): Set<string> => {
  const retired = new Set<string>();
  const live = new Set<string>();
  for (const r of rows) {
    const code = (r.fabric_code ?? '').trim();
    if (!code) continue;
    if (r.is_active === false) retired.add(code);
    else live.add(code);
  }
  for (const code of live) retired.delete(code);
  return retired;
};

export type FabricLite = Pick<
  FabricTrackingRow,
  | 'id'
  | 'fabric_code'
  | 'fabric_description'
  | 'supplier_code'
  | 'fabric_category'
  | 'price_tier'
  | 'sofa_price_tier'
  | 'bedframe_price_tier'
  | 'series'
  | 'is_active'
>;

/* ─── Fabric dual-code display (owner request 2026-06-12) ──────────────────
 * Wherever a fabric is picked or displayed, show BOTH codes:
 *   "CG-015 (DC-151-03) — description"
 * internal fabric_code first, then the supplier's EXTERNAL code in PARENTHESES
 * (fabric_trackings.supplier_code) when present — owner 2026-07-24 ("你正常不是都会
 * 有括弧（bracket）"): the bracketed supplier code is what the supplier recognises,
 * so a PO reads "BF-01 (PC151-01)". DISPLAY-ONLY — stored values remain the
 * internal fabric_code everywhere. */
export function fabricDualCode(internal: string, supplierCode?: string | null): string {
  const ext = supplierCode?.trim();
  return ext ? `${internal} (${ext})` : internal;
}

/** Full dropdown label: dual code + " — description" (falls back to series). */
export function fabricOptionLabel(
  f: Pick<FabricTrackingRow, 'fabric_code' | 'supplier_code' | 'fabric_description' | 'series'>,
): string {
  const code = fabricDualCode(f.fabric_code, f.supplier_code);
  const desc = f.fabric_description?.trim() || f.series?.trim() || '';
  return desc ? `${code} — ${desc}` : code;
}

/* `includeRetired` DEFAULTS TO TRUE so nothing that already calls this hook
   changes behaviour — the owner's 2026-06-12 spec is explicit that inactive rows
   STAY on the converter (they are managed and reactivated there), and only the
   NEW-entry pickers hide them. Screens that want the tidy view opt in by passing
   false; the filter lives here rather than in each page so the two fabric
   surfaces cannot drift on what "retired" means. */
export function useFabricTrackings(opts?: {
  category?: FabricCategoryValue;
  search?: string;
  includeRetired?: boolean;
}) {
  return useQuery({
    queryKey: ['fabric-tracking', opts?.category ?? 'all', opts?.search ?? ''],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      if (opts?.category) params.set('category', opts.category);
      if (opts?.search) params.set('search', opts.search);
      const res = await authedFetch<{ fabrics: FabricTrackingRow[] }>(
        `/fabric-tracking${params.toString() ? `?${params.toString()}` : ''}`,
        { signal },
      );
      return res.fabrics;
    },
    select: (fabrics: FabricTrackingRow[]) =>
      opts?.includeRetired === false
        ? fabrics.filter((f) => f.is_active !== false)
        : fabrics,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

export function useFabricTrackingsLite(opts?: {
  category?: FabricCategoryValue;
  search?: string;
  includeRetired?: boolean;
}) {
  return useQuery({
    queryKey: ['fabric-tracking-lite', opts?.category ?? 'all', opts?.search ?? ''],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      if (opts?.category) params.set('category', opts.category);
      if (opts?.search) params.set('search', opts.search);
      const res = await authedFetch<{ fabrics: FabricLite[] }>(
        `/fabric-tracking/lite${params.toString() ? `?${params.toString()}` : ''}`,
        { signal },
      );
      return res.fabrics;
    },
    select: (fabrics: FabricLite[]) =>
      opts?.includeRetired === false
        ? fabrics.filter((f) => f.is_active !== false)
        : fabrics,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}


export function useUpdateFabricTier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; field: FabricTierField; tier: FabricTier }) => {
      return authedFetch<{ ok: true; affectedProducts: number | null; fabricCode: string | null }>(
        `/fabric-tracking/${args.id}/tier`,
        {
          method: 'PATCH',
          body: JSON.stringify({ field: args.field, tier: args.tier }),
        },
      );
    },
    onSuccess: (res, vars) => {
      qc.invalidateQueries({ queryKey: ['fabric-tracking'] });
      qc.invalidateQueries({ queryKey: ['mfg-products'] });
      const tierLabel = vars.tier.replace('PRICE_', 'P');
      const fieldLabel = vars.field === 'bedframePriceTier' ? 'bedframe' : 'sofa';
      if (res.affectedProducts === null) {
        void serviceNotify({
          title: `Tier updated → ${tierLabel}`,
          body:
            `The tier change was saved. How many ${fieldLabel} products it affects could not be read, ` +
            `so no number is shown.`,
        });
      } else if (res.affectedProducts > 0) {
        void serviceNotify({
          title: `Tier updated → ${tierLabel}`,
          body:
            `${res.affectedProducts} ${fieldLabel} product${res.affectedProducts === 1 ? '' : 's'} ` +
            `tagged with fabric ${res.fabricCode ?? ''} now reflect the new tier when read.`,
        });
      }
    },
    onError: fabricWriteFailed,
  });
}

export function useUpdateFabricSupplierCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; supplierCode: string | null }) => {
      return authedFetch<{ ok: true; supplierCode: string | null }>(
        `/fabric-tracking/${args.id}/supplier-code`,
        {
          method: 'PATCH',
          body: JSON.stringify({ supplierCode: args.supplierCode }),
        },
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fabric-tracking'] }),
    onError: fabricWriteFailed,
  });
}

export function useUpdateFabricSeries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; series: string | null }) => {
      return authedFetch<{ ok: true; series: string | null }>(
        `/fabric-tracking/${args.id}/series`,
        {
          method: 'PATCH',
          body: JSON.stringify({ series: args.series }),
        },
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fabric-tracking'] }),
    onError: fabricWriteFailed,
  });
}

export function useUpdateFabricActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; isActive: boolean }) => {
      return authedFetch<{ ok: true; isActive: boolean }>(
        `/fabric-tracking/${args.id}/active`,
        {
          method: 'PATCH',
          body: JSON.stringify({ isActive: args.isActive }),
        },
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fabric-tracking'] }),
    onError: fabricWriteFailed,
  });
}

export function useUpdateFabricDescription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; description: string | null }) => {
      return authedFetch<{ ok: true; description: string | null }>(
        `/fabric-tracking/${args.id}/description`,
        {
          method: 'PATCH',
          body: JSON.stringify({ description: args.description }),
        },
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fabric-tracking'] }),
    onError: fabricWriteFailed,
  });
}

export type NewFabric = {
  id?: string;
  fabricCode: string;
  fabricDescription?: string;
  fabricCategory?: FabricCategoryValue;
  sofaPriceTier?: FabricTier;
  bedframePriceTier?: FabricTier;
  supplierCode?: string;
  series?: string;
  priceSen?: number;
  label?: string;
  colours?: Array<{ colourId?: string; label: string; swatchHex?: string }>;
};
export function useCreateFabric() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewFabric) =>
      authedFetch<{ fabric: FabricTrackingRow; fabricLibraryId?: string; libraryWarning?: string | null }>(`/fabric-tracking`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fabric-tracking'] }),
    onError: fabricWriteFailed,
  });
}

export type BulkUpsertResult = {
  upserted: number;
  errors:   Array<{ index: number; reason: string }>;
};
export function useBulkUpsertFabrics() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rows: Array<Record<string, unknown>>) =>
      authedFetch<BulkUpsertResult>(`/fabric-tracking/bulk-upsert`, {
        method: 'POST',
        body: JSON.stringify({ rows }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fabric-tracking'] }),
    onError: fabricWriteFailed,
  });
}

export function useDeleteFabric() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<void>(`/fabric-tracking/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fabric-tracking'] }),
    onError: fabricWriteFailed,
  });
}

export type FabricColourRow = {
  fabricId: string;
  colourId: string;
  label: string | null;
  swatchHex: string | null;
  sortOrder: number;
};

export const useFabricColoursActive = () =>
  useQuery({
    queryKey: ['fabric-colours', 'active'],
    staleTime: 60_000,
    queryFn: async ({ signal }): Promise<FabricColourRow[]> => {
      const res = await authedFetch<{ colours: FabricColourRow[] }>('/fabric-colours', { signal });
      return res.colours ?? [];
    },
  });

/* HOUZS SCALING (owner #1 pain 2026-07-14) — SERVER typeahead for the SoLineCard
   Fabrics picker. The old useFabricColoursActive() pulled EVERY active colour on
   every line card and rendered them all as <option>s. This hits the SAME GET
   /fabric-colours with an opt-in `?q=` (ilike over the code + label, capped at
   50 server-side), keyed on the query, and only fires when >= 2 chars are typed
   (mirrors the SKU picker's useMfgProducts gate in SoLineCard). Selection shape
   is unchanged — the combobox hands back a full FabricColourRow, identical to a
   row from useFabricColoursActive(). */
/* `itemCode` is REQUIRED (null when the line has none yet): with it, the server
   applies the Model's fabric pool BEFORE the 50-row cap, so an allowed colour is
   never crowded out by disallowed ones ahead of it (docs/bugs/0893, the
   fabric-search entry). A caller that forgot it would silently get the old,
   short answer, which is the optional-parameter trap this repo bans. */
export const useFabricColoursSearch = (
  q: string,
  opts: { enabled: boolean; itemCode: string | null },
) => {
  const trimmed = q.trim();
  const item = (opts.itemCode ?? '').trim();
  return useQuery({
    queryKey: ['fabric-colours', 'search', trimmed, item],
    staleTime: 60_000,
    enabled: opts.enabled && trimmed.length >= 2,
    queryFn: async ({ signal }): Promise<FabricColourRow[]> => {
      const itemParam = item ? `&itemCode=${encodeURIComponent(item)}` : '';
      const res = await authedFetch<{ colours: FabricColourRow[] }>(
        `/fabric-colours?q=${encodeURIComponent(trimmed)}&limit=50${itemParam}`,
        { signal },
      );
      return res.colours ?? [];
    },
  });
};

export const useFabricColourByCode = (code: string | null | undefined) => {
  const c = (code ?? '').trim();
  return useQuery({
    queryKey: ['fabric-colours', 'by-code', c],
    staleTime: 60_000,
    enabled: c.length > 0,
    queryFn: async (): Promise<FabricColourRow | null> => {
      const res = await authedFetch<{ colours: FabricColourRow[] }>(
        `/fabric-colours?q=${encodeURIComponent(c)}&limit=50`,
      );
      const rows = res.colours ?? [];
      return rows.find((r) => r.colourId === c) ?? null;
    },
  });
};
