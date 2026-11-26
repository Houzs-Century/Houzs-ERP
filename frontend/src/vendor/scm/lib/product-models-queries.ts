
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMfgProducts, type MfgCategory } from './mfg-products-queries';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';
import { api } from '../../../api/client';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type ProductModelRow = {
  id: string;
  branding: string | null;
  model_code: string;
  name: string;
  category: MfgCategory;
  description: string | null;
  photo_url: string | null;
  allowed_options: AllowedOptions;
  default_variants: Record<string, string> | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  sku_count?: number;
  active_sku_count?: number;
};

/** Per-category allowed-options pool. Empty `{}` = no restriction. */
export type AllowedOptions = {
  sizes?:                 string[];
  compartments?:          string[];
  divan_heights?:         string[];
  total_heights?:         string[];
  gaps?:                  string[];
  leg_heights?:           string[];
  specials?:              string[];
  mattress_thickness_cm?: number;
  fabrics?:               string[];
};

export type ModelSkuRow = {
  id: string;
  code: string;
  name: string;
  size_code: string | null;
  size_label: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  base_price_sen: number | null;
  price1_sen: number | null;
  cost_price_sen: number;
  unit_m3_milli: number;
  pos_active?: boolean;
  one_shot?: boolean;
  source_doc_no?: string | null;
};

export function useProductModels(opts?: { category?: MfgCategory }) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['product-models', opts?.category ?? 'all'],
    queryFn: async ({ queryKey }) => {
      const qs = opts?.category ? `?category=${opts.category}` : '';
      const pastBrowserCache = qc.getQueryState(queryKey)?.isInvalidated;
      const res = await authedFetch<{ models: ProductModelRow[] }>(
        `/product-models${qs}`,
        pastBrowserCache ? { cache: 'no-cache' } : undefined,
      );
      return res.models;
    },
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

type ProjectBrandRow = {
  id: number;
  name: string;
  active: number | boolean;
};

/**
 * Houzs PMS brands — the central brand master maintained in Project
 * Maintenance > Brands. Only the ACTIVE brand names are offered to the SCM
 * Branding inputs. (`full=1` returns the full row set; we filter to active.)
 */
export function useProjectBrands() {
  return useQuery({
    queryKey: ['project-brands'],
    queryFn: () =>
      api
        .get<{ data: ProjectBrandRow[] }>('/api/projects/brands?full=1')
        .then((r) => r.data ?? []),
    staleTime: 60_000,
  });
}

/**
 * BRANDING pool resolver — single source for every Branding input.
 *
 * Resolution order:
 *   1. Houzs PMS brands (project_brands, maintained in Project Maintenance >
 *      Brands; active brands only).
 *   2. Fallback when the pool is empty/absent: DISTINCT non-null branding
 *      values across mfg_products + product_models (case-insensitive dedupe,
 *      first-seen casing wins, A→Z). Read-only suggestion — nothing is ever
 *      written back to the brand master.
 *
 * Consumers feed the result into a <datalist> so free text stays possible
 * (legacy values are never hard-blocked).
 */
export function useBrandingPool() {
  const brands = useProjectBrands();
  const products = useMfgProducts();
  const models = useProductModels();

  const configPool = useMemo(
    () =>
      (brands.data ?? [])
        .filter((b) => b.active === 1 || b.active === true)
        .map((b) => (b.name ?? '').trim())
        .filter((b) => b.length > 0),
    [brands.data],
  );

  const distinct = useMemo(() => {
    const seen = new Map<string, string>();
    const collect = (b: string | null | undefined) => {
      const t = (b ?? '').trim();
      if (!t) return;
      const k = t.toUpperCase();
      if (!seen.has(k)) seen.set(k, t);
    };
    for (const p of products.data ?? []) collect(p.branding);
    for (const m of models.data ?? []) collect(m.branding);
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  }, [products.data, models.data]);

  return {
    pool: configPool.length > 0 ? configPool : distinct,
    fromConfig: configPool.length > 0,
    configPool,
    distinct,
    isLoading: brands.isLoading || products.isLoading || models.isLoading,
  };
}

export function useProductModel(id: string | undefined) {
  return useQuery({
    queryKey: ['product-models', id],
    enabled: !!id,
    queryFn: async () => {
      const res = await authedFetch<{ model: ProductModelRow; skus: ModelSkuRow[] }>(
        `/product-models/${id}`,
      );
      return res;
    },
    staleTime: 30_000,
  });
}

export function useCreateProductModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      branding?: string | null;
      modelCode: string;
      name: string;
      category: MfgCategory;
      description?: string | null;
      allowedOptions?: AllowedOptions;
    }) => {
      return authedFetch<{ model: ProductModelRow }>('/product-models', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['product-models'] });
    },
  });
}

export function useUpdateProductModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      id: string;
      branding?: string | null;
      modelCode?: string;
      name?: string;
      description?: string | null;
      photoUrl?: string | null;
      allowedOptions?: AllowedOptions;
      defaultVariants?: Record<string, string>;
      active?: boolean;
    }) => {
      const { id, ...body } = args;
      return authedFetch<{ model: ProductModelRow; autoCreatedSkus?: string[]; autoCreateFailed?: string[] }>(`/product-models/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['product-models'] });
      qc.invalidateQueries({ queryKey: ['product-models', vars.id] });
      void qc.invalidateQueries({ queryKey: ['mfg-products'] });
      void qc.invalidateQueries({ queryKey: ['model-allowed-options-by-code'] });
    },
  });
}

/** PR #49 / #51 / #69 — Generator. Two modes:
 *    - `rows: [{code, name, size_code?, size_label?}]` — client supplies the
 *      exact rows to materialise (computed from local allowed_options state).
 *      Bypasses the DB's saved allowed_options so commander doesn't have to
 *      click "Save changes" before "Add codes".
 *    - `codes: string[]` — server materialises the cartesian product from the
 *      saved allowed_options, then INSERTs only the listed codes.
 *    - neither — server materialises everything from saved allowed_options.
 */
export function useGenerateModelSkus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      id: string;
      rows?:  Array<{ code: string; name: string; size_code?: string | null; size_label?: string | null }>;
      codes?: string[];
    }) => {
      const body: Record<string, unknown> = {};
      if (args.rows && args.rows.length > 0) body.rows = args.rows;
      else if (args.codes && args.codes.length > 0) body.codes = args.codes;
      return authedFetch<{ generated: number; skipped: number; codes: string[]; reason?: string }>(
        `/product-models/${args.id}/generate-skus`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['product-models'] });
      qc.invalidateQueries({ queryKey: ['mfg-products'] });
    },
  });
}

/** Migration 0161 — Activate a one-shot SKU so it surfaces in the POS catalog.
 *  Calls POST /mfg-products/:id/activate-one-shot which sets pos_active=true and
 *  (for SOFA) appends the compartment to the Model's allowed_options. */
export function useActivateOneShot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      return authedFetch<{ ok: true }>(`/mfg-products/${id}/activate-one-shot`, {
        method: 'POST',
      });
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-products'] });
      qc.invalidateQueries({ queryKey: ['product-models'] });
      void vars;
    },
    onError: writeFailed,
  });
}

export function useDeleteProductModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return authedFetch<{ ok: true }>(`/product-models/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['product-models'] });
    },
  });
}


export function useUploadProductModelPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => {
      const fd = new FormData();
      fd.append('file', file);
      return authedFetch<{ photoUrl: string; photoKey: string }>(
        `/product-models/${id}/photo`,
        { method: 'POST', body: fd },
      );
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['product-models'] });
      qc.invalidateQueries({ queryKey: ['product-models', vars.id] });
    },
  });
}

export function useDeleteProductModelPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return authedFetch<{ ok: true }>(`/product-models/${id}/photo`, { method: 'DELETE' });
    },
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['product-models'] });
      qc.invalidateQueries({ queryKey: ['product-models', id] });
    },
  });
}
