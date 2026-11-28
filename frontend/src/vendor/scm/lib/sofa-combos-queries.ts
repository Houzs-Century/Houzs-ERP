
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SofaPriceTier } from '@2990s/shared';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';

export type SofaComboRule = {
  id: string;
  baseModel: string;
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
  createdByName?: string | null;
  costSource?: 'auto' | 'manual' | 'gap';
  derivedFromSupplierId?: string | null;
  derivedFromSupplierName?: string | null;
};

export type ComboFilters = {
  baseModel?: string;
  customerId?: string | null;
  supplierId?: string;
  includeAll?: boolean;
  enabled?: boolean;
};

export function useSofaCombos(filters: ComboFilters = {}) {
  return useQuery({
    enabled: filters.enabled ?? true,
    queryKey: ['sofa-combos', filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters.baseModel) params.set('baseModel', filters.baseModel);
      if (filters.customerId === null) params.set('customerId', '__all__');
      else if (filters.customerId) params.set('customerId', filters.customerId);
      if (filters.supplierId) params.set('supplierId', filters.supplierId);
      if (filters.includeAll) params.set('includeAll', '1');
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
  supplierId?: string | null;
} | null) {
  return useQuery({
    queryKey: ['sofa-combos-history', args],
    enabled: !!args,
    queryFn: () => {
      if (!args) return Promise.resolve([] as SofaComboRule[]);
      const params = new URLSearchParams();
      params.set('baseModel', args.baseModel);
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

/** One combo at one Price. `prices` names only the cells to change; null takes a
 *  price away; {} opens a combo with no price, or does nothing if it already exists. */
export type ApplyComboItem = {
  baseModel: string;
  modules: string[][];
  tier: SofaPriceTier;
  supplierId: string | null;
  prices: Record<string, number | null>;
  effectiveFrom: string;
  label?: string | null;
  notes?: string | null;
};

export type ComboRef = { baseModel: string; modules: string[][] };
export type AssignTarget = { id: string; name: string; linked: boolean; held: string[] };

const APPLY_CHUNK = 200;

const useComboWrite = <T,>(write: (body: T) => Promise<unknown>) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sofa-combos'] });
      void qc.invalidateQueries({ queryKey: ['sofa-combos-history'] });
      void qc.invalidateQueries({ queryKey: ['sofa-combo-targets'] });
    },
  });
};

/** A big Excel file goes in chunks, each one atomic on the server. */
export const useApplyCombos = () =>
  useComboWrite(async (items: ApplyComboItem[]) => {
    for (let i = 0; i < items.length; i += APPLY_CHUNK) {
      await authedFetch('/sofa-combos/apply', { method: 'POST', body: JSON.stringify({ items: items.slice(i, i + APPLY_CHUNK) }) });
    }
  });

/** No supplier = the master combo, and every supplier's copy goes with it. */
export const useRetireCombos = () =>
  useComboWrite(async ({ items, supplierId }: { items: ComboRef[]; supplierId: string | null }) => {
    for (let i = 0; i < items.length; i += APPLY_CHUNK) {
      await authedFetch('/sofa-combos/retire', { method: 'POST', body: JSON.stringify({ items: items.slice(i, i + APPLY_CHUNK), supplierId }) });
    }
  });

export const useRecomposeCombos = () =>
  useComboWrite(async (moves: Array<{ baseModel: string; from: string[][]; to: string[][]; supplierId: string | null; label?: string | null; notes?: string | null }>) => {
    for (const move of moves) {
      await authedFetch('/sofa-combos/recompose', { method: 'POST', body: JSON.stringify(move) });
    }
  });

export function useComboAssignTargets(baseModel: string | null) {
  return useQuery({
    enabled: !!baseModel,
    queryKey: ['sofa-combo-targets', baseModel],
    queryFn: () =>
      authedFetch<{ suppliers: AssignTarget[] }>(`/sofa-combos/assign-targets?baseModel=${encodeURIComponent(baseModel ?? '')}`)
        .then((r) => r.suppliers),
  });
}

