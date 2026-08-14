// Vendored from apps/backend/src/lib/product_models hooks (PR #49). Sister file
// to mfg-products-queries.ts — same authedFetch + cache conventions.
//
// HOUZS VENDOR NOTE: the source module imported `./supabase` but never actually
// called it (useBrandingPool reads via useMfgProducts/useProductModels, both
// authedFetch). The dead supabase import is dropped; the API_URL warning probe
// is dropped too (the vendored authedFetch owns the base URL). Everything else
// — including the multipart photo upload, which rides authedFetch's FormData
// passthrough to /api/scm/product-models/:id/photo (the Worker R2 path) — is
// copied verbatim.

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMfgProducts, type MfgCategory } from './mfg-products-queries';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';
// HOUZS RE-SOURCING (2026-06-21): branding is maintained centrally in Houzs's
// Project Maintenance / PMS (project_brands). The branding pool sources from
// /api/projects/brands — which lives OUTSIDE the /api/scm mount, so it uses the
// Houzs-native `api` client, not the /api/scm-scoped authedFetch.
import { api } from '../../../api/client';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type ProductModelRow = {
  id: string;
  /** PR #65 — required for SOFA/BEDFRAME/MATTRESS; drives the SKU-name template. */
  branding: string | null;
  model_code: string;
  name: string;
  category: MfgCategory;
  description: string | null;
  photo_url: string | null;
  allowed_options: AllowedOptions;
  active: boolean;
  created_at: string;
  updated_at: string;
  /** PR — Wei Siang 2026-06-19: count of mfg_products SKUs under this Model.
   *  Surfaces orphan/empty Models (e.g. all SKUs deleted from SKU Master but
   *  the Model still lingers in Modular). Optional so older cached payloads /
   *  the detail endpoint (which doesn't compute it) stay type-compatible. */
  sku_count?: number;
};

/** Per-category allowed-options pool. Empty `{}` = no restriction. */
export type AllowedOptions = {
  sizes?:                 string[];   // SOFA seat sizes OR BEDFRAME/MATTRESS sizes
  compartments?:          string[];   // SOFA only
  divan_heights?:         string[];   // BEDFRAME
  total_heights?:         string[];   // BEDFRAME
  gaps?:                  string[];   // BEDFRAME
  leg_heights?:           string[];
  specials?:              string[];
  /** MATTRESS only — drives the (WxLx{thickness}CM) substitution in the
      auto-generated SKU name. Set at New Model time or edited later via
      the Model detail page. */
  mattress_thickness_cm?: number;
  /** SOFA only — fabric_library.id slugs ticked for this Model (e.g.
      ['linen', 'velvet']). POS Configurator uses this list to populate
      the fabric colour picker. Empty / missing = no fabrics offered. */
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
  /** Migration 0161 — whether this SKU was minted as a one-shot from a remark. */
  pos_active?: boolean;
  one_shot?: boolean;
  source_doc_no?: string | null;
};

export function useProductModels(opts?: { category?: MfgCategory }) {
  return useQuery({
    queryKey: ['product-models', opts?.category ?? 'all'],
    queryFn: async () => {
      const qs = opts?.category ? `?category=${opts.category}` : '';
      const res = await authedFetch<{ models: ProductModelRow[] }>(`/product-models${qs}`);
      return res.models;
    },
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

// Raw row from GET /api/projects/brands (Houzs PMS BrandManager).
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
    const seen = new Map<string, string>(); // UPPER → first-seen original casing
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
    /** What dropdowns should offer: pool when set, else the distinct fallback. */
    pool: configPool.length > 0 ? configPool : distinct,
    /** True when the maintenance pool itself has values. */
    fromConfig: configPool.length > 0,
    /** The raw maintenance pool (may be empty). */
    configPool,
    /** DISTINCT branding values across products + models (suggestion seed). */
    distinct,
    /** True while any source of the resolved pool is still loading — lets a
     *  read-only consumer avoid flashing an empty state before the fallback
     *  (products/models) has settled. */
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
      active?: boolean;
    }) => {
      const { id, ...body } = args;
      return authedFetch<{ model: ProductModelRow }>(`/product-models/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['product-models'] });
      qc.invalidateQueries({ queryKey: ['product-models', vars.id] });
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
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['product-models', vars.id] });
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
      // Invalidate the detail query (skus list re-fetches and shows pos_active=true)
      // and the flat mfg-products list (SKU Master reflects the change).
      qc.invalidateQueries({ queryKey: ['mfg-products'] });
      // We don't have the model_id here, so invalidate all product-model details.
      qc.invalidateQueries({ queryKey: ['product-models'] });
      void vars; // suppress unused-var warning
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

/* ─── Photo upload / delete (PR — Commander 2026-05-27) ─────────────────
 *
 * Multipart POST sends the file body straight to the Worker, which
 * uploads to R2 (SO_ITEM_PHOTOS bucket, `product-models/{id}/...`
 * prefix) and patches product_models.photo_url with the proxy URL.
 *
 * Don't set content-type here — fetch() needs to set the multipart
 * boundary itself from the FormData. The shared authedFetch helper
 * stamps content-type only when init.body is a string, so a FormData
 * body slips past it correctly.
 *
 * HOUZS VENDOR — the source page uploaded the model photo client-side via
 * supabase.storage; here the vendored ProductModelDetail calls THIS hook so
 * the upload routes through the Worker R2 path instead.
 * ─────────────────────────────────────────────────────────────────────── */

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
