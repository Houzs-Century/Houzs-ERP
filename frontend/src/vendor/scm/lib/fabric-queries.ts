// Vendored SLICE of apps/backend/src/lib/fabric-queries.ts — only the pieces
// the PO New form reads: the FabricTrackingRow type, the dual-code display
// helpers (fabricDualCode / fabricOptionLabel) and useFabricTrackings() (the
// fabric dropdown source for sofa/bedframe variant pricing).
//
// HOUZS VENDOR NOTE: the source module's `import { supabase }` (used only by
// useFabricColoursActive, a POS-side colour-library read the PO pages don't
// use) and `import { serviceNotify }` (used only by the tier-update mutation)
// are DROPPED along with those functions. Everything kept here is copied
// verbatim and goes through the vendored authedFetch (→ /api/scm).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { serviceNotify } from './dialog-service';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

/* EVERY fabric write in this file used to fail SILENTLY. All nine mutations had
   an onSuccess and not one had an onError, so a refused PATCH — the area guard
   requiring `edit` on scm.procurement.products where the grid's GET only needs
   `view` (scm/middleware/area-guard.ts:16), a 409 when the active company has
   not resolved, a 404 when the row belongs to the other company — produced no
   toast, no inline message and no console line. The row simply stayed as it was.
   Reported by the owner as "I press Deactivate and nothing happens", which is
   exactly what the code does.

   serviceNotify was already imported here and used for ONE success toast on the
   tier update, so the mechanism was present the whole time; only the failure
   half was missing. authedFetch throws Errors carrying the server's own
   sentence, so surfacing err.message names the real cause instead of a generic
   "something went wrong" that would send the next person hunting again. */
const fabricWriteFailed = (err: unknown) => {
  void serviceNotify({
    title: 'That change was not saved',
    body: err instanceof Error ? err.message : 'Something went wrong. Please try again.',
    tone: 'error',
  });
};

export type FabricCategoryValue = 'B.M-FABR' | 'S-FABR' | 'S.M-FABR' | 'LINING' | 'WEBBING';
export type FabricTier = 'PRICE_1' | 'PRICE_2' | 'PRICE_3';
export type FabricTierField = 'sofaPriceTier' | 'bedframePriceTier';

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
  /* Migration 0063 — collection name (free text, e.g. "KOONA VELVET H2O"). */
  series: string | null;
  /* Migration 0167 — Fabric Converter ACTIVE toggle (owner spec 2026-06-12).
     Inactive fabrics hide from NEW-entry pickers; existing docs keep their
     code. Optional so the UI tolerates an API that predates the migration. */
  is_active?: boolean | null;
};

/* The NON-SENSITIVE subset served by GET /fabric-tracking/lite — name + price
   tiers, NO cost/stock. Everything the SO fabric dropdown + PC-Order detail need
   to pick a fabric and price a line, and safe to read without products access
   (the full FabricTrackingRow carries cost/stock and stays gated). */
export type FabricLite = Pick<
  FabricTrackingRow,
  | 'id'
  | 'fabric_code'
  | 'fabric_description'
  // supplier_code is the DISPLAY dual-code (the "(DC-151-03)" shown in the picker
  // label), not cost/stock — safe and needed by fabricOptionLabel.
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
    /* The API returns every row and has no active filter, so the split happens
       here. `select` keeps ONE cache entry per (category, search) and derives
       both views from it — a retired-only refetch would otherwise double the
       requests for a list of ~830 rows. `is_active` is only ever false when a
       row has been explicitly retired; null/undefined is a pre-0167 row and
       counts as live. */
    select: (fabrics: FabricTrackingRow[]) =>
      opts?.includeRetired === false
        ? fabrics.filter((f) => f.is_active !== false)
        : fabrics,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

/* DISPLAY/PICK read — names + price tiers only, hits GET /fabric-tracking/lite
   which is openRead (no cost/stock). Use this on surfaces gated by scm.sales.* /
   scm.consignment.* (the SO fabric dropdown, PC-Order detail) so a user without
   scm.procurement.products does NOT hit the 403 the full useFabricTrackings gave
   them. The full hook stays for the products/fabric pages that show cost/stock. */
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

/* ═══════════════════════════════════════════════════════════════════════════
   HOUZS VENDOR — Fabric Converter page mutations. Copied verbatim from
   apps/backend/src/lib/fabric-queries.ts; all go through the vendored
   authedFetch (→ /api/scm/fabric-tracking…). The source module's supabase
   colour-library reads are NOT vendored (the FabricTracking page never calls
   them). serviceNotify lands the tier-update toast in the in-app NotifyDialog.
   ═══════════════════════════════════════════════════════════════════════════ */

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
      qc.invalidateQueries({ queryKey: ['mfg-products'] });  // price display might shift
      const tierLabel = vars.tier.replace('PRICE_', 'P');
      const fieldLabel = vars.field === 'bedframePriceTier' ? 'bedframe' : 'sofa';
      // Light-touch in-app toast via the app-wide NotifyDialog (serviceNotify bridge).
      if (res.affectedProducts === null) {
        /* The tier DID change; only the propagation count could not be read.
           Saying nothing would read as "nothing was affected", which is the
           same silence a `count ?? 0` produced on the server. */
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
    /* The one mutation that already had a serviceNotify — for SUCCESS only. A
       tier change that the server refuses is exactly as invisible as a refused
       Deactivate was. */
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

/* Migration 0063 — Inline-edit Series cell from the Fabric Converter table. */
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

/* Migration 0167 — Active toggle on the Fabric Converter (owner spec
   2026-06-12). Inactive = hidden from NEW-entry fabric pickers (SO/CO variant
   selects, scan-SO catalog); rows stay on the converter + old docs keep
   displaying the code. */
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

/* PR #38 — Make fabric description editable from the converter table. */
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

/* PR #43 — Create new fabric (Commander 2026-05-26) */
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
  // Migration 0124/0125 — also create the customer-pickable fabric_library entry.
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

/* Commander 2026-05-26 — Bulk upsert for CSV Import. One HTTP call to the
   server's /bulk-upsert endpoint (which does a single Postgres upsert).
   `rows` is the camelCase shape parsed from CSV — see fabric-csv.parseCsv. */
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

/* HOUZS VENDOR — SO line editor (SoLineCard) read. Routes through GET
   /api/scm/fabric-colours (backend/src/scm/routes/fabric-colours.ts), which
   lists ACTIVE scm.fabric_colours rows camelCased to FabricColourRow. Empty
   table → endpoint returns [], so the SoLineCard Fabrics dropdown falls back to
   its "(current)" rehydrate for saved lines and offers no colour picks for new
   lines (the verbatim empty-pool behaviour). Seed sample colours with
   seed-fabric-colours.mjs. */
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
export const useFabricColoursSearch = (
  q: string,
  opts?: { enabled?: boolean },
) => {
  const trimmed = q.trim();
  return useQuery({
    queryKey: ['fabric-colours', 'search', trimmed],
    staleTime: 60_000,
    enabled: (opts?.enabled ?? true) && trimmed.length >= 2,
    queryFn: async ({ signal }): Promise<FabricColourRow[]> => {
      const res = await authedFetch<{ colours: FabricColourRow[] }>(
        `/fabric-colours?q=${encodeURIComponent(trimmed)}&limit=50`,
        { signal },
      );
      return res.colours ?? [];
    },
  });
};

/* Resolve a single colour by its code (colour_id) — used to REHYDRATE a saved
   SO line's fabric that isn't in the current typeahead result set, so the
   combobox can render its full object (label/swatch/series) without pulling the
   whole library. Returns the first exact-code match. Disabled when no code. */
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
