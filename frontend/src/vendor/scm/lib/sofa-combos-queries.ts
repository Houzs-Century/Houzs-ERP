// ----------------------------------------------------------------------------
// Sofa Combo Pricing hooks. Commander 2026-05-28 — ported from HOOKKA's
// combo module spec. Used by the Combo Pricing tab on Products.tsx + the
// supplier-scoped Combo Pricing tab on SupplierDetail.
//
// ── HOUZS VENDOR ADAPTATION ────────────────────────────────────────────────
//   • Copied verbatim from apps/backend/src/lib/sofa-combos-queries.ts.
//   • The source `import { supabase } from './supabase'` is DROPPED — supabase
//     is never referenced in this module (every hook goes through authedFetch,
//     which the vendor layer repoints at /api/scm). Everything else is identical.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SofaPriceTier } from '@2990s/shared';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';

export type SofaComboRule = {
  id: string;
  baseModel: string;
  /** OR-set per slot: ordered slots, each an array of alternative codes. */
  modules: string[][];
  tier: SofaPriceTier | null;
  customerId: string | null;
  supplierId: string | null;
  pricesByHeight: Record<string, number | null>;
  /* Selling / PWP maps — the backend has returned these all along; the type
     dropped them, which is exactly why the master card went all-dash (owner
     2026-07-24 "爆掉了"): the card showed the COST map, which is ALLOWED to be
     all-null, while the combo's real (selling) prices sat unread. */
  sellingPricesByHeight?: Record<string, number | null> | null;
  pwpPricesByHeight?: Record<string, number | null> | null;
  label: string | null;
  effectiveFrom: string;
  deletedAt: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
};

export type NewSofaCombo = {
  baseModel: string;
  /** OR-set per slot: ordered slots, each an array of alternative codes. */
  modules: string[][];
  tier: SofaPriceTier | null;
  customerId: string | null;
  /** Supplier scope. null/undefined = sales-side / master combo. */
  supplierId?: string | null;
  pricesByHeight: Record<string, number | null>;
  label?: string | null;
  effectiveFrom: string;
  notes?: string | null;
};

export type ComboFilters = {
  baseModel?: string;
  customerId?: string | null;  // null = '__all__' scope; undefined = no filter
  /** Supplier scope. Set = that supplier's combos; unset = sales-side. */
  supplierId?: string;
};

export function useSofaCombos(filters: ComboFilters = {}) {
  return useQuery({
    queryKey: ['sofa-combos', filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters.baseModel) params.set('baseModel', filters.baseModel);
      if (filters.customerId === null) params.set('customerId', '__all__');
      else if (filters.customerId) params.set('customerId', filters.customerId);
      if (filters.supplierId) params.set('supplierId', filters.supplierId);
      const qs = params.toString();
      return authedFetch<{ rules: SofaComboRule[] }>(
        `/sofa-combos${qs ? `?${qs}` : ''}`,
      ).then((r) => r.rules);
    },
    staleTime: 30_000,
  });
}

export function useSofaComboHistory(args: {
  baseModel: string;
  modules: string[][];
  tier: SofaPriceTier | null;
  customerId: string | null;
  /** Supplier scope. Set = that supplier's history; unset = sales-side. */
  supplierId?: string | null;
} | null) {
  return useQuery({
    queryKey: ['sofa-combos-history', args],
    enabled: !!args,
    queryFn: () => {
      if (!args) return Promise.resolve([] as SofaComboRule[]);
      const params = new URLSearchParams();
      params.set('baseModel', args.baseModel);
      // OR-set slots are JSON-encoded; the API matches by canonical slot key.
      params.set('modules', JSON.stringify(args.modules));
      if (args.tier) params.set('tier', args.tier);
      if (args.customerId) params.set('customerId', args.customerId);
      if (args.supplierId) params.set('supplierId', args.supplierId);
      return authedFetch<{ rules: SofaComboRule[] }>(
        `/sofa-combos/history?${params.toString()}`,
      ).then((r) => r.rules);
    },
    staleTime: 5_000,
  });
}

export function useCreateSofaCombo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewSofaCombo) =>
      authedFetch<SofaComboRule>('/sofa-combos', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sofa-combos'] });
      qc.invalidateQueries({ queryKey: ['sofa-combos-history'] });
    },
  });
}

export function useUpdateSofaCombo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id, pricesByHeight, label, effectiveFrom, notes, supplierId,
    }: {
      id: string;
      pricesByHeight: Record<string, number | null>;
      label?: string | null;
      effectiveFrom: string;
      notes?: string | null;
      /** Supplier scope. Omit to keep the original row's scope. */
      supplierId?: string | null;
    }) =>
      authedFetch<SofaComboRule>(`/sofa-combos/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ pricesByHeight, label, effectiveFrom, notes, supplierId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sofa-combos'] });
      qc.invalidateQueries({ queryKey: ['sofa-combos-history'] });
    },
  });
}

export function useDeleteSofaCombo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<void>(`/sofa-combos/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sofa-combos'] });
      qc.invalidateQueries({ queryKey: ['sofa-combos-history'] });
    },
  });
}

// ── R8 anchors ────────────────────────────────────────────────────────────
// A base_model can be anchored to ONE supplier (sofa_combo_anchor). While
// anchored, combo create + price edits mirror between the master (sales-side)
// combo and that supplier's scope, keeping the Product-Maintenance cost and the
// anchored supplier's cost in lock-step. See apps/api/src/routes/sofa-combos.ts.

export type SofaComboAnchor = {
  base_model: string;
  supplier_id: string;
};

export function useSofaComboAnchors() {
  return useQuery({
    queryKey: ['sofa-combo-anchors'],
    queryFn: () =>
      authedFetch<{ anchors: SofaComboAnchor[] }>('/sofa-combos/anchors').then((r) => r.anchors),
    staleTime: 30_000,
  });
}

export function useSetSofaComboAnchor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ baseModel, supplierId }: { baseModel: string; supplierId: string | null }) =>
      authedFetch<{ ok: true }>(`/sofa-combos/anchors/${encodeURIComponent(baseModel)}`, {
        method: 'PUT',
        body: JSON.stringify({ supplierId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sofa-combo-anchors'] });
      // The mirror creates/updates combos on the other side, so the combo lists
      // (both master + supplier-scoped) must refetch to show them.
      qc.invalidateQueries({ queryKey: ['sofa-combos'] });
    },
    onError: writeFailed,
  });
}

// Customer hooks removed 2026-05-28 — commander dropped customer scoping
// for 2990's B2C model. The DB column stays but the UI no longer writes
// to it; useCopyCombosToCustomer + useCustomersLite were used only here.
