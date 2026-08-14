// ----------------------------------------------------------------------------
// Product Models — second-layer template entity (PR #49).
//
// Every SKU on `mfg_products` belongs to a Model (e.g. 5530, 1003). The Model
// owns the allowed-options pool that the SO/PO line picker (and a future
// auto-SKU-generator) reads from.
//
// Endpoints:
//   GET    /product-models           List, optional ?category=SOFA filter.
//   GET    /product-models/by-code/:code
//                                    One SKU's Model pools + real category.
//   GET    /product-models/by-code-batch?code=A&code=B
//                                    The same answer for many codes in ONE trip.
//                                    The SO/PO line editors ask per LINE, so the
//                                    single form costs one round trip per line.
//   GET    /product-models/:id       Detail + side-loaded SKU rows.
//   POST   /product-models           Create a new Model.
//   PATCH  /product-models/:id       Update name / description / allowed_options
//                                    / photo_url / active.
//   DELETE /product-models/:id       Hard delete. SKUs on mfg_products fall
//                                    back to model_id NULL (FK ON DELETE SET NULL).
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { supabaseAuth } from '../middleware/auth';
import { findModelUsage, usageCheckFailedBody } from '../lib/sku-usage';
import { activeCompanyId, stampCompany, scopeToCompany,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { canWriteScmConfig, canViewScmProductCost } from '../lib/houzs-perms';
import { PRODUCT_FINANCE_KEYS } from '../lib/finance-keys';
import { todayMyt } from '../lib/my-time';
import { baseKeyOf, deleteThumbFor, putOptionalThumb } from '../../services/photoThumbs';
import type { Env, Variables } from '../env';

export const productModels = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Public photo proxy (PR — Commander 2026-05-27) ─────────────────────────
// Exported so it can ALSO be mounted OUTSIDE /api/scm (routes/public-images.ts).
// Houzs gates all of /api/scm behind requireScmAccess + the global auth (main
// index.ts), which the same-origin Houzs SPA passes via its session cookie —
// but the 2990 POS is a DIFFERENT origin using Bearer auth, so its <img src>
// requests carry no Houzs cookie and 401. 2990 serves Model photos from an
// auth-free proxy (apps/api product-models.ts:35, before its own supabaseAuth);
// we replicate that by mounting this handler pre-auth. Security: validates the
// requested key against the Model's stored photo_url before streaming, so a
// guessed key can't leak another Model's blob. Service-role client (no JWT).
// The .schema('scm') is REQUIRED — product_models lives in scm; a bare .from()
// hits the empty public.product_models and 404s every photo (BUG-HISTORY 2026-07-20).
export const modelPhotoProxyHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const id = c.req.param('id');
  const rawKey = c.req.param('key');
  if (!id || !rawKey) return c.json({ error: 'bad_request' }, 400);
  const key = decodeURIComponent(rawKey);

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

  const sb = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: model } = await sb
    .schema('scm')
    .from('product_models')
    .select('photo_url')
    .eq('id', id)
    .maybeSingle();
  if (!model) return c.json({ error: 'not_found' }, 404);
  const m = model as { photo_url: string | null };
  if (!m.photo_url || extractPhotoKey(m.photo_url, id) !== key) {
    return c.json({ error: 'photo_not_in_model' }, 404);
  }

  const obj = await c.env.SO_ITEM_PHOTOS.get(key);
  if (!obj) return c.json({ error: 'photo_not_found_in_r2' }, 404);

  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      // The key IS the identity: upload mints `product-models/<id>/<uuid>.<ext>`
      // with crypto.randomUUID() (:1084), so a replaced photo is a different
      // key and therefore a different url — this one can never come to mean
      // other bytes. That is the same argument the old 1-hour TTL rested on;
      // an hour was conservatism, not the limit of what it proves. Measured
      // 2026-08-01: /scm/product-models issues 57 requests, most of them this
      // proxy, one per row.
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
};
productModels.get('/:id/photo/:key', modelPhotoProxyHandler);

// ── Gallery photo proxy (PUBLIC) ─────────────────────────────────────────────
// Multi-photo gallery (scm.product_model_photos, migration 0060). Same shape
// as the single-photo proxy above: registered BEFORE supabaseAuth so <img>
// tags work, validates the requested key against the gallery row, streams
// the R2 object. Path is distinct from /:id/photo/:key so the two coexist.
productModels.get('/:id/photo-gallery/:key', async (c) => {
  const id = c.req.param('id');
  const key = decodeURIComponent(c.req.param('key'));

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }
  // Defensive prefix check — keys we mint live under product-model-photos/.
  if (!key.startsWith('product-model-photos/')) {
    return c.json({ error: 'gallery_key_invalid' }, 400);
  }

  // WO-7 thumbnails live at `<r2_key>.thumb`. Authorize a thumb request
  // against its BASE key's gallery row — the thumb is never in r2_key itself.
  const baseKey = baseKeyOf(key);

  const sb = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data } = await sb
    .schema('scm')
    .from('product_model_photos')
    .select('id')
    .eq('model_id', id)
    .eq('r2_key', baseKey)
    .maybeSingle();
  if (!data) return c.json({ error: 'photo_not_in_model' }, 404);

  const obj = await c.env.SO_ITEM_PHOTOS.get(key);
  if (!obj) return c.json({ error: 'photo_not_found_in_r2' }, 404);

  const contentType = obj.httpMetadata?.contentType ?? 'application/octet-stream';
  return new Response(obj.body, {
    headers: {
      'content-type': contentType,
      // Gallery keys are minted the same way — `product-model-photos/<id>/
      // <uuid>.<ext>` via crypto.randomUUID() (:1286) — so the url names one
      // fixed object for its lifetime. See the single-photo proxy above.
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
});

productModels.use('*', supabaseAuth);

const CATEGORIES = ['SOFA', 'BEDFRAME', 'MATTRESS', 'ACCESSORY', 'SERVICE'] as const;

const CreateBody = z.object({
  // PR #69 — Branding is OPTIONAL across all categories per commander
  // 2026-05-26 ("bedframe dont need branding"). BEDFRAME / SOFA encode the
  // brand inside the Model name (HILTON BEDFRAME, SOFA 5530). MATTRESS
  // commander still treats branding as separate metadata. UI keeps the
  // field but no longer enforces it.
  branding:       z.string().trim().max(80).optional().nullable(),
  modelCode:      z.string().trim().min(1).max(32),
  name:           z.string().trim().min(1).max(200),
  category:       z.enum(CATEGORIES),
  description:    z.string().trim().max(500).optional().nullable(),
  photoUrl:       z.string().trim().url().optional().nullable(),
  allowedOptions: z.record(z.unknown()).optional(),
  active:         z.boolean().optional(),
});

const PatchBody = z.object({
  branding:       z.string().trim().max(80).nullable().optional(),
  modelCode:      z.string().trim().min(1).max(32).optional(),
  name:           z.string().trim().min(1).max(200).optional(),
  // category cannot be patched once set — it would orphan SKUs in the other category.
  description:    z.string().trim().max(500).nullable().optional(),
  photoUrl:       z.string().trim().url().nullable().optional(),
  allowedOptions: z.record(z.unknown()).optional(),
  active:         z.boolean().optional(),
});

const COLS = 'id, branding, model_code, name, category, description, photo_url, allowed_options, active, created_at, updated_at';

// ── GET / ──────────────────────────────────────────────────────────────────
export const listProductModelsHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const supabase = c.get('supabase');
  const category = c.req.query('category');

  let q = scopeToCompany(supabase.from('product_models').select(COLS), c).order('category').order('model_code');
  if (category && (CATEGORIES as readonly string[]).includes(category)) {
    q = q.eq('category', category);
  }
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = (data ?? []) as Array<Record<string, unknown> & { id: string }>;

  // SKU count per Model — surfaces "0 SKUs" orphan/empty models in Modular
  // (Wei Siang 2026-06-19: a deleted-from-SKU-Master model still showed with
  // no hint it had nothing under it). ONE grouped count over mfg_products, then
  // map onto the rows — NOT N+1. PostgREST has no GROUP BY in the REST API, so
  // we select just the model_id column for the visible models and tally
  // client-side; mfg_products is small enough (~hundreds of rows) that pulling
  // a single id column is cheaper than a per-model count roundtrip.
  const counts = new Map<string, number>();
  if (rows.length > 0) {
    let cq = supabase.from('mfg_products').select('model_id').not('model_id', 'is', null);
    // Scope to the models we're returning so a category filter doesn't pull
    // the whole table (and so the count query stays bounded).
    cq = cq.in('model_id', rows.map((m) => m.id));
    const { data: skuRows } = await cq;
    for (const r of (skuRows ?? []) as Array<{ model_id: string | null }>) {
      if (r.model_id) counts.set(r.model_id, (counts.get(r.model_id) ?? 0) + 1);
    }
  }
  const models = rows.map((m) => ({ ...m, sku_count: counts.get(m.id) ?? 0 }));
  /* Perf (go-live) — Models back the catalog picker's variant-filter pools and
     the Modular list; they change rarely (config edits, not per-order). A short
     PRIVATE max-age lets the browser reuse the list across a burst of picker
     opens without re-running the list + grouped-count round-trip. Kept short so
     a Model/allowed-options edit surfaces within a minute. */
  c.header('cache-control', 'private, max-age=60');
  /* Multi-company (fix/so-product-company-scope): same leak as GET /mfg-products.
     The 60s private cache is URL-keyed while the active company rides in the
     X-Company-Id header, so without Vary the sofa-model picker serves the previous
     company's models for up to a minute after a top-bar switch (a page reload does
     not bypass a still-fresh fetch response). The query is company-scoped
     (scopeToCompany); Vary keeps the CACHED RESPONSE company-scoped too. */
  c.header('vary', 'X-Company-Id');
  return c.json({ models });
};
productModels.get('/', listProductModelsHandler);

// ── GET /by-code/:code ───────────────────────────────────────────────────────
// Resolve a SKU's Model allowed_options pools by the SKU's item code, mirroring
// 2990's useModelAllowedOptionsByCode (a direct supabase join
// mfg_products → product_models.allowed_options). The SO line editor (SoLineCard)
// reads this so EDITING an already-saved line filters its variant dropdowns by
// the picked Model's pools, not just freshly-picked lines.
//
// Returns { allowedOptions: null } for legacy/unknown codes (no Model link) so
// the caller falls back to UNRESTRICTED dropdowns — the verbatim 2990's
// behaviour. NOTE: static `/by-code/...` MUST be declared before `/:id` so the
// param route doesn't swallow it.
productModels.get('/by-code/:code', async (c) => {
  const code = c.req.param('code');
  const supabase = c.get('supabase');

  // Resolve the SKU's model_id, then the Model's allowed_options. A two-step
  // read avoids relying on PostgREST embedded-resource shaping (which the
  // service client may camelCase / array-wrap inconsistently).
  const { data: sku, error: skuErr } = await supabase
    .from('mfg_products')
    .select('model_id, category')
    .eq('code', code)
    .eq('company_id', activeCompanyId(c))
    .limit(1)
    .maybeSingle();
  if (skuErr) {
    if (/relation .* does not exist/i.test(skuErr.message)) return c.json({ allowedOptions: null, category: null });
    return c.json({ error: 'load_failed', reason: skuErr.message }, 500);
  }
  // The SKU's REAL category (SOFA / BEDFRAME / …) so the SO line editor can
  // recognise a sofa/bedframe line whose persisted itemGroup came in generic
  // (scan/backdoor drafts) and render the right configurator + require its
  // variants (owner 2026-07-13). Null for legacy/unknown codes.
  const category = (sku as Record<string, unknown> | null)?.category != null
    ? String((sku as Record<string, unknown>).category)
    : null;
  // Dual-read camelCase ?? snake_case for the FK column.
  const modelId = (sku as Record<string, unknown> | null)?.modelId
    ?? (sku as Record<string, unknown> | null)?.model_id
    ?? null;
  if (!modelId) return c.json({ allowedOptions: null, category });

  const { data: model, error: modelErr } = await supabase
    .from('product_models')
    .select('allowed_options')
    .eq('id', modelId)
    .maybeSingle();
  if (modelErr) return c.json({ error: 'load_failed', reason: modelErr.message }, 500);
  const allowedOptions =
    (model as Record<string, unknown> | null)?.allowedOptions
    ?? (model as Record<string, unknown> | null)?.allowed_options
    ?? null;
  return c.json({ allowedOptions, category });
});

// ── GET /by-code-batch?code=A&code=B ─────────────────────────────────────────
// Batch form of GET /by-code/:code, same answer for every code in one trip.
//
// WHY this exists: the SO/PO line editors ask this question once per LINE
// (useModelAllowedOptionsByCode, called from SoLineCard / MobileNewSO / PoLineCard
// / PcVariantEditor). One code at a time, that is one HTTP round trip AND two DB
// reads per line, and the question can only be asked after the order has loaded
// and its lines are known — so it lands as a second, N-wide serial hop. On a
// phone at ~250ms RTT that hop is the dominant cost of opening an order (owner's
// capture, 2026-07-17: one authed-fetch per product, 171 requests for one SO).
// Two reads now serve the whole order.
//
// A GET, and NOT a POST, even though a code list reads more naturally in a body.
// This router is mounted `scmAreaGuard('scm.procurement.products', { openRead:
// true })` — openRead exempts GET/HEAD ONLY; a POST would require `edit` on the
// Products ADMIN area, which every L2-configured salesperson holds at `none`.
// A POST here would therefore 403 exactly the people who open Sales Orders, and
// their variant dropdowns would fail. Same scar as the scan-so writeLevel:'view'
// downgrade and fix/x1-so-create-gate. Repeated `code` params (not a comma list)
// so a code containing a comma cannot split.
//
// The per-code contract is IDENTICAL to the single route — { allowedOptions: null,
// category: null } for a legacy/unknown code, so callers keep their UNRESTRICTED
// dropdown fallback. An entry is returned for EVERY requested code: a caller must
// be able to tell "this SKU has no Model" (a real answer) from "we did not
// answer", so nothing here fills a gap with a default and the client rejects a
// missing entry rather than reading it as "no Model".
//
// MUST be declared before GET /:id — it is a single path segment, so the param
// route would otherwise swallow it (same reason as /by-code/:code above).
// Far above the largest real order (~30 lines); keeps the URL well inside limits.
// A longer list is not an error for the client — it simply sends a second batch.
const BY_CODE_BATCH_MAX = 100;

productModels.get('/by-code-batch', async (c) => {
  const requested = c.req.queries('code') ?? [];
  const codes = [...new Set(requested.filter((x) => x.length > 0))];
  if (codes.length === 0) return c.json({ error: 'bad_request', reason: 'code is required' }, 400);
  if (codes.length > BY_CODE_BATCH_MAX) {
    return c.json({ error: 'bad_request', reason: `at most ${BY_CODE_BATCH_MAX} codes per request` }, 400);
  }

  const supabase = c.get('supabase');

  const allNull = () =>
    Object.fromEntries(codes.map((code) => [code, { allowedOptions: null, category: null }]));

  const { data: skus, error: skuErr } = await supabase
    .from('mfg_products')
    .select('code, model_id, category')
    .in('code', codes)
    .eq('company_id', activeCompanyId(c));
  if (skuErr) {
    // Parity with the single route: a missing relation degrades to "no Model"
    // rather than 500ing the whole order open.
    if (/relation .* does not exist/i.test(skuErr.message)) return c.json({ results: allNull() });
    return c.json({ error: 'load_failed', reason: skuErr.message }, 500);
  }
  // No `?? []` here: with error null a select yields an array, so a null `skus`
  // means the read did not answer. Folding that into "no rows" would report
  // every line as Model-less and silently unrestrict its dropdowns.
  if (!skus) return c.json({ error: 'load_failed', reason: 'mfg_products read returned no rows' }, 500);

  const skuByCode = new Map<string, { modelId: string | null; category: string | null }>();
  for (const r of skus as Array<Record<string, unknown>>) {
    if (r.code == null) continue;
    // Dual-read camelCase / snake_case for the FK column, as the single route does.
    const modelId = r.modelId ?? r.model_id ?? null;
    skuByCode.set(String(r.code), {
      modelId: modelId != null ? String(modelId) : null,
      category: r.category != null ? String(r.category) : null,
    });
  }

  const modelIds = [
    ...new Set(
      [...skuByCode.values()]
        .map((s) => s.modelId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const allowedByModelId = new Map<string, unknown>();
  if (modelIds.length > 0) {
    const { data: models, error: modelErr } = await supabase
      .from('product_models')
      .select('id, allowed_options')
      .in('id', modelIds);
    if (modelErr) return c.json({ error: 'load_failed', reason: modelErr.message }, 500);
    if (!models) return c.json({ error: 'load_failed', reason: 'product_models read returned no rows' }, 500);
    for (const m of models as Array<Record<string, unknown>>) {
      if (m.id == null) continue;
      allowedByModelId.set(String(m.id), m.allowedOptions ?? m.allowed_options ?? null);
    }
  }

  const results: Record<string, { allowedOptions: unknown; category: string | null }> = {};
  for (const code of codes) {
    const sku = skuByCode.get(code);
    if (!sku) { results[code] = { allowedOptions: null, category: null }; continue; }
    if (!sku.modelId) { results[code] = { allowedOptions: null, category: sku.category }; continue; }
    // A model_id resolving to no row is a dangling FK. The single route returns
    // null for it (maybeSingle -> null, no error); keep the two contracts
    // identical rather than inventing a different answer here.
    results[code] = {
      allowedOptions: allowedByModelId.has(sku.modelId) ? allowedByModelId.get(sku.modelId) : null,
      category: sku.category,
    };
  }
  return c.json({ results });
});

// ── GET /:id ───────────────────────────────────────────────────────────────
productModels.get('/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  const { data: model, error } = await scopeToCompany(
    supabase
      .from('product_models')
      .select(COLS)
      .eq('id', id),
    c,
  )
    .maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!model) return c.json({ error: 'not_found' }, 404);

  // Side-load the SKU list so the Model Detail page can show variant rows
  // without a second roundtrip. Cap at 200 (no Model exceeds ~30 today).
  const { data: skus } = await supabase
    .from('mfg_products')
    .select('id, code, name, size_code, size_label, status, base_price_sen, price1_sen, cost_price_sen, unit_m3_milli, pos_active, one_shot, source_doc_no')
    .eq('model_id', id)
    .order('code')
    .limit(200);

  /* #669 made the Cost column director-only on the screen this payload feeds and
     left the number on the wire; PRODUCT_FINANCE_KEYS is that ruling's payload
     half. base_price_sen stays — the same screen prints it to everyone as
     "Price 2".

     canViewScmProductCost, NOT canViewScmFinance: the screen this feeds
     (ProductModelDetail) gates its Cost column on canViewProductCost, which
     since #699 admits Purchasing. A director gate here deleted the key from
     under it, so the column rendered blank for the one function the owner's
     2026-07-17 ruling named. Screen and wire ask ONE question now. */
  const skuRows = (skus ?? []) as Array<Record<string, unknown>>;
  if (!canViewScmProductCost(c)) {
    for (const s of skuRows) {
      for (const k of PRODUCT_FINANCE_KEYS) delete s[k];
    }
  }

  return c.json({ model, skus: skuRows });
});

// ── POST / ─────────────────────────────────────────────────────────────────
productModels.post('/', async (c) => {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);

  const supabase = c.get('supabase');
  const insert = {
    company_id:      activeCompanyId(c),
    branding:        parsed.data.branding ?? null,
    model_code:      parsed.data.modelCode,
    name:            parsed.data.name,
    category:        parsed.data.category,
    description:     parsed.data.description ?? null,
    photo_url:       parsed.data.photoUrl ?? null,
    allowed_options: parsed.data.allowedOptions ?? {},
    active:          parsed.data.active ?? true,
  };
  const { data, error } = await supabase
    .from('product_models')
    .insert(insert)
    .select(COLS)
    .maybeSingle();
  if (error) {
    if (error.code === '23505') {
      return c.json({ error: 'duplicate_code', reason: error.message }, 409);
    }
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json({ model: data }, 201);
});

// ── PATCH /:id ─────────────────────────────────────────────────────────────
productModels.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);

  // Build the partial update — only include keys the client actually sent so
  // we don't overwrite columns with `undefined` (Supabase treats that as NULL).
  const u: Record<string, unknown> = {};
  if (parsed.data.branding !== undefined)       u.branding        = parsed.data.branding;
  if (parsed.data.modelCode !== undefined)      u.model_code      = parsed.data.modelCode;
  if (parsed.data.name !== undefined)           u.name            = parsed.data.name;
  if (parsed.data.description !== undefined)    u.description     = parsed.data.description;
  if (parsed.data.photoUrl !== undefined)       u.photo_url       = parsed.data.photoUrl;
  if (parsed.data.allowedOptions !== undefined) u.allowed_options = parsed.data.allowedOptions;
  if (parsed.data.active !== undefined)         u.active          = parsed.data.active;

  if (Object.keys(u).length === 0) {
    return c.json({ error: 'empty_patch' }, 400);
  }

  const supabase = c.get('supabase');
  // Multi-company: scope the snapshot AND the write to the active company so a
  // blind model id from another company matches nothing.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  // Snapshot the pre-update compartments so we can tell which ones the admin
  // just ACTIVATED (sofa auto-SKU rule below — Chairman 2026-06-02).
  const { data: before } = await scopeToCompanyId(supabase
    .from('product_models')
    .select('allowed_options')
    .eq('id', id), co.companyId)
    .maybeSingle();
  const { data, error } = await scopeToCompanyId(supabase
    .from('product_models')
    .update(u)
    .eq('id', id), co.companyId)
    .select(COLS)
    .maybeSingle();
  if (error) {
    if (error.code === '23505') {
      return c.json({ error: 'duplicate_code', reason: error.message }, 409);
    }
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);

  // Chairman 2026-06-01: Modular's allowed_options is the SINGLE source of truth
  // for ON/OFF — there is no separate per-SKU "Visible" toggle anymore. For
  // size-keyed categories, mirror allowed_options.sizes onto each SKU's
  // pos_active (the flag the POS catalog reads) so toggling a size OFF in Modular
  // also pulls it from the catalog. Idempotent: only flips SKUs whose membership
  // changed. Sofa is unaffected (its configurator reads allowed_options directly;
  // its catalog card is model-level via product_models.active).
  const cat = (data as { category?: string }).category;
  const aoSizes = (parsed.data.allowedOptions as { sizes?: unknown } | undefined)?.sizes;
  if ((cat === 'MATTRESS' || cat === 'BEDFRAME') && Array.isArray(aoSizes) && aoSizes.length > 0) {
    const allowedSet = new Set((aoSizes as unknown[]).map((s) => String(s).toUpperCase()));
    // Scoped so the derived toOn/toOff id set is strictly this company's SKUs.
    const { data: skus } = await scopeToCompanyId(supabase
      .from('mfg_products')
      .select('id, size_code, pos_active')
      .eq('model_id', id), co.companyId);
    const toOn:  string[] = [];
    const toOff: string[] = [];
    for (const s of (skus ?? []) as Array<{ id: string; size_code: string | null; pos_active: boolean | null }>) {
      const inAllowed = allowedSet.has((s.size_code ?? '').toUpperCase());
      if (inAllowed && s.pos_active === false) toOn.push(s.id);
      else if (!inAllowed && s.pos_active !== false) toOff.push(s.id);
    }
    if (toOn.length)  await supabase.from('mfg_products').update({ pos_active: true  }).in('id', toOn);
    if (toOff.length) await supabase.from('mfg_products').update({ pos_active: false }).in('id', toOff);
  }

  // Chairman 2026-06-02: activating a SOFA compartment in Modular auto-creates
  // its SKU in SKU Master when missing. SKU creation is a Backend-authority
  // action, so it runs here server-side with the service-role client (the PATCH
  // itself is already auth-gated); the POS SKU Master then shows it via sync.
  // Format mirrors generate-skus: code `MODEL-<comp>`, name `SOFA <MODEL> <comp>`,
  // NO prices (Master Admin sets the base price afterwards in SKU Master). Only
  // NEWLY-activated compartments without an existing SKU are created; existing
  // SKUs + deactivations are untouched. `comp` keeps its pool casing (e.g.
  // "Console") — the engine matches case-sensitively, so the code suffix must
  // equal the laid-out cell code.
  const autoCreatedSkus: string[] = [];
  if (cat === 'SOFA' && parsed.data.allowedOptions !== undefined) {
    const oldComps = new Set(
      Array.isArray((before?.allowed_options as { compartments?: unknown } | null)?.compartments)
        ? ((before!.allowed_options as { compartments: unknown[] }).compartments).map((x) => String(x))
        : [],
    );
    const newComps = Array.isArray((parsed.data.allowedOptions as { compartments?: unknown }).compartments)
      ? ((parsed.data.allowedOptions as { compartments: unknown[] }).compartments).map((x) => String(x))
      : [];
    const added = [...new Set(newComps)].filter((comp) => comp && !oldComps.has(comp));
    if (added.length > 0) {
      const modelCode  = String((data as { model_code?: string }).model_code ?? '');
      const codePrefix = modelCode.toUpperCase();
      const modelName  = String((data as { name?: string }).name ?? '').trim();
      const branding   = String((data as { branding?: string | null }).branding ?? '').trim();
      const namePrefix = (branding ? `${branding} ` : '').toUpperCase();
      const upperName  = (modelName || modelCode).toUpperCase();
      // Backend-authority client (bypasses POS-role RLS for the system insert).
      const admin = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const wantCodes = added.map((comp) => `${codePrefix}-${comp}`);
      const { data: existing } = await admin
        .from('mfg_products')
        .select('code')
        .in('code', wantCodes)
        .eq('company_id', activeCompanyId(c));
      const have = new Set((existing ?? []).map((r) => (r as { code: string }).code));
      const now = new Date().toISOString();
      const rows = added
        .filter((comp) => !have.has(`${codePrefix}-${comp}`))
        .map((comp) => {
          const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          return {
            id:         `mfg-${rand.replace(/-/g, '').slice(0, 12)}`,
            code:       `${codePrefix}-${comp}`,
            name:       `${namePrefix}SOFA ${upperName} ${comp}`.trim(),
            category:   'SOFA',
            base_model: modelCode,
            model_id:   id,
            branding:   branding || null,
            status:     'ACTIVE',
            created_at: now,
            updated_at: now,
          };
        });
      if (rows.length > 0) {
        // Best-effort: allowed_options already saved; don't fail the PATCH if the
        // auto-create hiccups (Master Admin can still add via SKU Master). 23505
        // = a concurrent create already made it — treat as success (idempotent).
        const { error: insErr } = await admin.from('mfg_products').insert(stampCompany(rows, c));
        if (!insErr || insErr.code === '23505') autoCreatedSkus.push(...rows.map((r) => r.code));
      }
    }
  }

  return c.json({ model: data, autoCreatedSkus });
});

// ── POST /:id/generate-skus ───────────────────────────────────────────────
// "Open a code, don't open it 20 times" — bulk-INSERT one mfg_products row per
// allowed-option combination. Skips rows that already exist (ON CONFLICT on
// code). Returns count generated + skipped + the new SKU codes.
//
// Per-category combination rules:
//   SOFA:     one row per `compartments` value (sizes live in seat_height_prices
//             JSONB on the SKU, not in the code). Code = `{model_code}-{compartment}`.
//   BEDFRAME: one row per `sizes` value. Code = `{model_code}-({size_code})`.
//   MATTRESS: same as BEDFRAME.
//   ACCESSORY / SERVICE: one SKU, code = {model_code} (no variant axis).
//
// PR #66 — Standard size info per code. Mirrors commander's existing data:
//   1003-(K) → "HILTON BEDFRAME (6FT) (183X190CM)"
//   2990-NF AKKA-FIRM MATT (K) → "2990 AKKA-FIRM MATTRESS (183x190x31CM)"
//
// `dim` carries the dimensions string for BEDFRAME. MATTRESS adds a
// per-Model thickness (Model.allowed_options.mattress_thickness_cm) — see
// the MATTRESS branch in generate-skus for the assembly.
// `label` is the friendly size like "6FT" / "5FT" / "3FT" / "3.5FT".
// SK / SP fall back to label-only (their label IS already the dimensions).
const SIZE_INFO: Record<string, { label: string; dim: string; w: number; l: number }> = {
  K:  { label: '6FT',       dim: '183X190CM', w: 183, l: 190 },
  Q:  { label: '5FT',       dim: '152X190CM', w: 152, l: 190 },
  S:  { label: '3FT',       dim: '90X190CM',  w: 90,  l: 190 },
  SS: { label: '3.5FT',     dim: '107X190CM', w: 107, l: 190 },
  SK: { label: '200X200CM', dim: '',          w: 200, l: 200 },
  // SP = made-to-order custom size: no fixed dims (could be 200X220, etc.), so
  // w/l/dim are blank → generated name renders "(CUSTOM)" not a fake 220X220;
  // the real dimensions + quoted price are captured per-order on the SO/PO line.
  SP: { label: 'CUSTOM',    dim: '',          w: 0,   l: 0   },
};

/** PR #92 — Resolve a size code with the Maintenance sizeLabels override on
 *  top of the static SIZE_INFO table. Mirrors the resolveSizeInfo() helper
 *  in apps/backend/src/lib/size-info.ts so server-rendered SKU names pick
 *  up commander's relabel ("K → Super K · 200X200CM") the moment he saves
 *  the Maintenance row. */
function resolveSizeInfoServer(
  code: string,
  overrides?: Record<string, { label?: string; dimensions?: string } | undefined> | null,
): { label: string; dim: string; w: number; l: number } {
  const o = overrides?.[code];
  const base = SIZE_INFO[code];
  const label = o?.label?.trim() || base?.label || code;
  const dim   = o?.dimensions?.trim() || base?.dim || '';
  let w = base?.w ?? 0;
  let l = base?.l ?? 0;
  if (o?.dimensions) {
    const m = o.dimensions.trim().match(/^(\d+)\s*[xX×]\s*(\d+)/);
    if (m && m[1] && m[2]) {
      w = parseInt(m[1], 10);
      l = parseInt(m[2], 10);
    }
  }
  return { label, dim, w, l };
}

productModels.post('/:id/generate-skus', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  // Multi-company: scope the model load so SKUs can only be minted for THIS
  // company's model (a blind model id from another company is not found).
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  // PR #51 + #69 — body shapes:
  //   { rows: [{code, name, size_code?, size_label?}] }
  //     → client already computed the candidate rows (using its current
  //       in-memory allowed_options). Insert them directly. Decouples the
  //       picker from "must save Allowed Options first" UX trap.
  //   { codes: string[] }
  //     → legacy filter: server materialises ALL allowed-option combos,
  //       then only INSERTs the listed codes.
  //   {} or null
  //     → materialise ALL allowed-option combos.
  let body: { rows?: Array<{ code: string; name: string; size_code?: string | null; size_label?: string | null }>; codes?: string[] } = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as typeof body;
  } catch { /* allow empty body */ }
  const explicitRows = Array.isArray(body.rows) && body.rows.length > 0 ? body.rows : null;
  const filterCodes = Array.isArray(body.codes) && body.codes.length > 0
    ? new Set(body.codes)
    : null;

  const { data: model, error: mErr } = await scopeToCompanyId(supabase
    .from('product_models')
    .select('id, branding, model_code, name, category, allowed_options')
    .eq('id', id), co.companyId)
    .maybeSingle();
  if (mErr) return c.json({ error: 'load_failed', reason: mErr.message }, 500);
  if (!model) return c.json(NOT_THIS_COMPANY, 404);

  // PR #92 — Maintenance sizeLabels override. Load the resolved maintenance
  // config so generated SKU names pick up commander's relabel ("K → 6FT (NEW)"
  // / "183X190CM → 180X200CM") without a code change. Best-effort: if the
  // load fails we fall back to the static SIZE_INFO map below.
  let sizeOverrides: Record<string, { label?: string; dimensions?: string }> | null = null;
  try {
    const { data: cfgRow } = await supabase
      // Audit (ported from 2990 3e288239) — was `maintenance_config`, a table that
      // does not exist (real table is maintenance_config_history, seeded by
      // mig 0022); the dead lookup meant Maintenance size-label relabels silently
      // never reached generated SKU names.
      .from('maintenance_config_history')
      .select('config')
      .eq('scope', 'master')
      .lte('effective_from', todayMyt())
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle();
    const blob = cfgRow?.config as { sizeLabels?: typeof sizeOverrides } | undefined;
    if (blob?.sizeLabels && typeof blob.sizeLabels === 'object') {
      sizeOverrides = blob.sizeLabels;
    }
  } catch {
    // Swallow — generator stays functional with static SIZE_INFO.
  }

  const opts = (model.allowed_options ?? {}) as Record<string, unknown>;
  // Commander 2026-05-26 spec (PR #66): the SKU name is driven by the Model
  // NAME (commander types it during create), NOT by the branding column.
  // Branding stays as a tracked metadata column on the Model + SKU rows.
  //
  // Per-category templates mirror the existing 2990's catalogue:
  //
  //   BEDFRAME  code:  {model_code}-({size_code})                  1003-(K)
  //             name:  {branding?} BEDFRAME ({size_label}) ({dim}) HILTON BEDFRAME (6FT) (183X190CM)
  //                                                                BEDFRAME (6FT) (183X190CM)  (no branding)
  //             — if size is SK/SP the label already IS the dimensions,
  //               so we skip the second parens and emit only ({label}).
  //             — branding prefix added in PR #83 to match FE
  //               DEFAULT_FORMATS.bedframeName + commander's expectation.
  //
  //   MATTRESS  code:  {branding?} {model_code} MATT ({size_code})
  //                                                                 2990 AKKA-FIRM MATT (K)
  //                                                                 HAPPI.S PUREZONE MATT (K)
  //             — "-NF" suffix dropped in PR #88 (Commander 2026-05-26:
  //               "NF 不需要"). Was 2990-specific legacy naming; not a
  //               default convention for new brands.
  //             name:  {branding?} {model.name} MATTRESS ({w}x{l}x{thickness}CM)
  //                                                                 2990 AKKA-FIRM MATTRESS (183x190x31CM)
  //                                                                 Happi.S GridCool MATTRESS (183x190x25CM)
  //             — thickness lives on Model.allowed_options.mattress_thickness_cm
  //               (commander sets it once per Model from the detail page).
  //               Falls back to ({label}) when thickness is unset.
  //             — branding prefix added in PR #81 to match commander's 2990
  //               data sample. Empty branding → prefix + space dropped.
  //
  //   SOFA      code:  {model_code}-{compartment}                  5530-1A(LHF)
  //             name:  {branding?} SOFA {model.name} {compartment} SOFA 5530 1A(LHF)
  //                                                                SOFA ADDA 1A(LHF)
  //                                                                Houzs SOFA ADDA 1A(LHF)
  //             — "SOFA" literal added in PR #81 to match commander's
  //               legacy data sample. Empty branding → prefix dropped.
  //
  const modelName = (model.name ?? '').trim();
  const sizesArr  = Array.isArray(opts.sizes)        ? (opts.sizes as string[])        : [];
  const compsArr  = Array.isArray(opts.compartments) ? (opts.compartments as string[]) : [];
  const mattressThickness = typeof opts.mattress_thickness_cm === 'number'
    ? opts.mattress_thickness_cm
    : null;

  // Compute the SKU rows we'd like to materialize.
  type GenRow = { code: string; name: string; size_code: string | null; size_label: string | null };
  const wanted: GenRow[] = [];

  // Fast path: client computed the rows already (using its local
  // allowed_options state) and just wants the server to INSERT them. This
  // avoids the "I forgot to click Save first" trap where the picker had
  // candidates but the DB allowed_options was still empty.
  if (explicitRows) {
    for (const r of explicitRows) {
      if (!r?.code || !r?.name) continue;
      wanted.push({
        code:       String(r.code),
        name:       String(r.name),
        size_code:  r.size_code ?? null,
        size_label: r.size_label ?? null,
      });
    }
  } else if (model.category === 'SOFA') {
    if (compsArr.length === 0) {
      return c.json({ error: 'no_compartments', reason: 'Allowed Options → Compartments is empty. Toggle at least one before generating.' }, 400);
    }
    // PR #81 — Commander 2026-05-26: Sofa generated names were missing the
    // "SOFA" word + branding prefix the legacy data carries
    // ("SOFA 5530 1A(LHF)"). The old data buried both inside `model.name`
    // (commander typed "SOFA 5530" as the name). Now the template adds
    // them so commander can keep `model.name` short ("ADDA" → "SOFA ADDA
    // 1A(LHF)"). Mattress branch below got the same treatment.
    const branding = (model.branding ?? '').trim();
    const prefix   = branding ? `${branding} ` : '';
    for (const comp of compsArr) {
      wanted.push({
        code:       `${model.model_code}-${comp}`,
        // "SOFA 5530 1A(LHF)" or "Houzs SOFA ADDA 1A(RHF)"
        name:       `${prefix}SOFA ${modelName} ${comp}`.trim(),
        size_code:  null,
        size_label: null,
      });
    }
  } else if (model.category === 'BEDFRAME') {
    if (sizesArr.length === 0) {
      return c.json({ error: 'no_sizes', reason: 'Allowed Options → Sizes is empty. Toggle at least one before generating.' }, 400);
    }
    // PR #83 — Commander 2026-05-26: "我明明在 Bedframe 填写了 Hilton，可是
    // hilton 却没有出来". Server-side template was using bare `${modelName}`,
    // ignoring the branding column. Frontend DEFAULT_FORMATS already
    // expected `{branding} BEDFRAME (...)`. Align server with FE so a
    // Bedframe Model with branding="Hilton" generates "Hilton BEDFRAME
    // (6FT) (183X190CM)" instead of the bare "BEDFRAME (...)" that just
    // confused commander. Empty branding → prefix dropped (no leading
    // space).
    //
    // PR #100 — Commander 2026-05-26: "为什么我的 Bedframe Create SKU 的
    // 时候，Description 没有跟着我们要的那个名字呢？" Mattress includes
    // the model name (e.g. "2990 AKKA-FIRM MATTRESS (…)"); bedframe was
    // dropping it ("BEDFRAME (6FT) (…)" with no TRION / HILTON). Inserted
    // modelName between branding prefix and the BEDFRAME word so symmetry
    // matches the mattress convention.
    const branding  = (model.branding ?? '').trim();
    const prefix    = branding ? `${branding} ` : '';
    const modelName = (model.name ?? '').trim();
    const namePrefix = modelName ? `${prefix}${modelName} ` : prefix;
    for (const sz of sizesArr) {
      const info  = resolveSizeInfoServer(sz, sizeOverrides);
      const label = info.label;
      const dim   = info.dim;
      // "TRION BEDFRAME (6FT) (183X190CM)" vs "TRION BEDFRAME (200X200CM)"
      const namePart = dim ? `${namePrefix}BEDFRAME (${label}) (${dim})` : `${namePrefix}BEDFRAME (${label})`;
      wanted.push({
        code:       `${model.model_code}-(${sz})`,
        name:       namePart.trim(),
        size_code:  sz,
        size_label: label,
      });
    }
  } else if (model.category === 'MATTRESS') {
    if (sizesArr.length === 0) {
      return c.json({ error: 'no_sizes', reason: 'Allowed Options → Sizes is empty. Toggle at least one before generating.' }, 400);
    }
    // PR #81 — Commander 2026-05-26 wanted generated mattress names to look
    // like the 2990 data sample: "2990 AKKA-FIRM MATTRESS (183x190x31CM)".
    // The old template ("{model.name} ({dim})") produced just
    // "GridCool (183x190x25CM)" — no branding prefix, no "MATTRESS" word.
    // Now: prepend {branding} + space (only when branding is non-empty) and
    // always insert the literal "MATTRESS" between model name and (dim).
    const branding = (model.branding ?? '').trim();
    const prefix   = branding ? `${branding} ` : '';
    for (const sz of sizesArr) {
      const info  = resolveSizeInfoServer(sz, sizeOverrides);
      const label = info.label;
      // Mattress dimensions include thickness so "(183x190x31CM)" is the goal.
      // Note lowercase 'x' to match commander's existing data.
      let dimPart: string;
      if (info.w && info.l && mattressThickness != null) {
        dimPart = `${info.w}x${info.l}x${mattressThickness}CM`;
      } else if (info.dim) {
        dimPart = info.dim.toLowerCase(); // bedframe-style fallback if thickness not set
      } else {
        dimPart = label;
      }
      wanted.push({
        // PR #88 (Commander 2026-05-26: "NF 不需要") — drop the "-NF"
        // suffix. PR #86 added it to match 2990 legacy "2990-NF
        // KETTA-FIRM MATT (K)", but commander now wants plain
        // "{branding} {model_code} MATT (size)" so other brands don't
        // inherit 2990's idiosyncratic suffix.
        code:       `${branding ? branding + ' ' : ''}${model.model_code} MATT (${sz})`,
        // "2990 AKKA-FIRM MATTRESS (183x190x31CM)" — branding prefix +
        // MATTRESS word inserted to match 2990 sample (PR #81).
        name:       `${prefix}${modelName} MATTRESS (${dimPart})`.trim(),
        size_code:  sz,
        size_label: label,
      });
    }
  } else if (model.category === 'ACCESSORY' || model.category === 'SERVICE') {
    // No variant axis — the Model itself IS the single SKU. Generate exactly one
    // row whose code is the model code (Wei Siang 2026-06-09: accessories /
    // services have no sizes, but must still produce one sellable SKU so they
    // show up in the SKU Master, instead of leaving a 0-SKU phantom model).
    const branding = (model.branding ?? '').trim();
    const prefix   = branding ? `${branding} ` : '';
    wanted.push({
      code:       model.model_code,
      name:       (modelName ? `${prefix}${modelName}` : `${prefix}${model.model_code}`).trim(),
      size_code:  null,
      size_label: null,
    });
  } else {
    return c.json({ error: 'unsupported_category', reason: `Auto-generate not supported for ${model.category}.` }, 400);
  }

  // PR #85 — Commander 2026-05-26: "所有生成的 SKU code + name 全部大写
  // (HILTON BEDFRAME 不是 Hilton BEDFRAME)". Normalise every row's code +
  // name + size_label to UPPERCASE before they hit the duplicate-check or
  // get INSERTed, so commander's input casing on branding / modelName
  // doesn't leak into the SKU rows. Centralised here so every category
  // branch above (sofa / bedframe / mattress / explicit) gets the same
  // treatment without each having to remember .toUpperCase().
  for (const w of wanted) {
    w.code = w.code.toUpperCase();
    w.name = w.name.toUpperCase();
    if (w.size_label) w.size_label = w.size_label.toUpperCase();
  }

  // If the caller filtered to specific codes, narrow `wanted` to just those.
  // Unknown codes (not in the allowed-option cartesian product) are silently
  // dropped — protects against the client sending stale codes after the
  // allowed_options were edited. filterCodes itself is uppercased on the
  // way in so a client passing mixed-case still matches.
  const filterCodesUpper = filterCodes
    ? new Set(Array.from(filterCodes).map((c) => c.toUpperCase()))
    : null;
  const wantedFiltered = filterCodesUpper
    ? wanted.filter((w) => filterCodesUpper.has(w.code))
    : wanted;

  // Find which codes already exist so we can report skip count.
  const codes = wantedFiltered.map((w) => w.code);
  const { data: existing } = codes.length
    ? await supabase.from('mfg_products').select('code').in('code', codes).eq('company_id', activeCompanyId(c))
    : { data: [] as Array<{ code: string }> };
  const existingSet = new Set((existing ?? []).map((r) => r.code as string));

  const toInsert = wantedFiltered.filter((w) => !existingSet.has(w.code));
  if (toInsert.length === 0) {
    return c.json({
      generated: 0,
      skipped: wantedFiltered.length,
      // Return the (already-existing) codes so the caller can still bind
      // suppliers to them — an existing SKU is NOT a failure to create the model.
      codes: wantedFiltered.map((w) => w.code),
      reason: 'All variant codes already exist — nothing new to insert.',
    });
  }

  // Build the rows. id is text on mfg_products and uses the `mfg-{rand}` pattern
  // already used by POST /mfg-products and the CSV batch-import.
  const now = new Date().toISOString();
  const rows = toInsert.map((w) => {
    const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return {
      id:         `mfg-${rand.replace(/-/g, '').slice(0, 12)}`,
      code:       w.code,
      name:       w.name,
      category:   model.category,
      base_model: model.model_code,
      size_code:  w.size_code,
      size_label: w.size_label,
      // PR #65 — mirror branding onto the SKU row too so it shows up in the
      // SKU Master list without having to JOIN product_models on read.
      branding:   model.branding ?? null,
      model_id:   model.id,
      status:     'ACTIVE',
      created_at: now,
      updated_at: now,
    };
  });

  const { error: insErr } = await supabase
    .from('mfg_products')
    .insert(stampCompany(rows, c));
  if (insErr) {
    return c.json({ error: 'insert_failed', reason: insErr.message }, 500);
  }

  return c.json({
    generated: rows.length,
    skipped: existingSet.size,
    // ALL wanted codes (newly-inserted + already-existing) so a partial batch
    // still lets the caller bind suppliers to every SKU, not only the new ones.
    codes: wantedFiltered.map((w) => w.code),
  });
});

// ── DELETE /:id ────────────────────────────────────────────────────────────
productModels.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  // Multi-company: confirm the model is THIS company's before the usage probe
  // (so another company's model can't be probed) and scope the delete.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: exists } = await scopeToCompanyId(supabase.from('product_models').select('id').eq('id', id), co.companyId).maybeSingle();
  if (!exists) return c.json(NOT_THIS_COMPANY, 404);
  // (C) Wei Siang 2026-06-08 — lock USED models. If any SKU under this model has
  // been sold / ordered / moved in stock, block the delete: removing it would
  // orphan live order lines. Unused models (setup-phase typos) stay deletable.
  const used = await findModelUsage(supabase, id);
  /* A probe that could not run is NOT "unused" — see sku-usage.ts. */
  if (!used.ok) return c.json(usageCheckFailedBody('model', used.reason), 409);
  if (used.usage) {
    return c.json({
      error: 'model_in_use',
      reason: `SKU “${used.usage.code}” under this model is used in ${used.usage.where}` +
        `${used.usage.doc ? ` (${used.usage.doc})` : ''} — it can’t be deleted.`,
    }, 409);
  }
  const { error } = await scopeToCompanyId(supabase.from('product_models').delete().eq('id', id), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

// ── Photo upload (PR — Commander 2026-05-27) ───────────────────────────────
//
// Stores Model hero photo in the SO_ITEM_PHOTOS R2 bucket (already
// provisioned + bound for PR-F per-line SO photos). Reuses the bucket
// instead of provisioning a second one because:
//   - same access pattern (private bucket, auth-gated proxy reads),
//   - same auth model (any signed-in staff can upload from Backend),
//   - bucket layout uses a distinct prefix (`product-models/{id}/...`)
//     so the two purposes stay tidy without a second binding.
//
// The Model row's `photo_url` column stores the public proxy path
// (e.g. `/product-models/{id}/photo/{key}`) — relative URLs that the POS
// catalog hot-loads via the same Worker. Storing the proxy path (not a
// signed S3 URL) means commander's uploaded photo doesn't expire and the
// POS card cache stays stable. The proxy endpoint itself enforces auth +
// validates the key against `product_models.photo_url` before streaming
// the R2 object.

const PHOTO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB per task spec

const photoExtFromMime = (mime: string): string | null => {
  const m = mime.toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/png')                       return 'png';
  if (m === 'image/webp')                      return 'webp';
  return null;
};

productModels.post('/:id/photo', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  // Cheap existence check before consuming the upload body. Scoped so a blind
  // model id from another company is not found (no R2 object is written for it).
  const { data: model, error: mErr } = await scopeToCompanyId(supabase
    .from('product_models')
    .select('id, photo_url')
    .eq('id', id), co.companyId)
    .maybeSingle();
  if (mErr) return c.json({ error: 'load_failed', reason: mErr.message }, 500);
  if (!model) return c.json(NOT_THIS_COMPANY, 404);

  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody();
  } catch (e) {
    return c.json({ error: 'invalid_multipart', reason: e instanceof Error ? e.message : String(e) }, 400);
  }
  const file = form.file as File | undefined;
  if (!file || typeof file === 'string') {
    return c.json({ error: 'file_field_required' }, 400);
  }

  const ext = file.type ? photoExtFromMime(file.type) : null;
  if (!ext) {
    return c.json({ error: 'unsupported_type', expected: 'image/jpeg | image/png | image/webp', got: file.type }, 400);
  }
  if (file.size > PHOTO_MAX_BYTES) {
    return c.json({ error: 'file_too_large', maxBytes: PHOTO_MAX_BYTES, got: file.size }, 400);
  }

  const u = c.get('user');
  if (!u?.id) return c.json({ error: 'auth_required' }, 401);

  const photoId = crypto.randomUUID();
  const photoKey = `product-models/${id}/${photoId}.${ext}`;

  try {
    await c.env.SO_ITEM_PHOTOS.put(photoKey, file.stream(), {
      httpMetadata: { contentType: file.type },
      customMetadata: { modelId: id, uploadedBy: u.id },
    });
  } catch (e) {
    return c.json({ error: 'r2_put_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
  }

  // Proxy URL the POS catalog + Backend thumbnail render via <img src>.
  // Relative path keeps it portable across api.{env} domains.
  const photoUrl = `/product-models/${id}/photo/${encodeURIComponent(photoKey)}`;

  // Best-effort cleanup of the previous photo so we don't leak R2 storage
  // when commander overwrites a photo. Only deletes if the previous URL
  // points to a key under this Model's prefix (defensive — a manual URL
  // edit should never trigger a delete of an unrelated object).
  const prev = (model as { photo_url: string | null }).photo_url;
  if (prev) {
    const prevKey = extractPhotoKey(prev, id);
    if (prevKey && prevKey !== photoKey) {
      await c.env.SO_ITEM_PHOTOS.delete(prevKey).catch(() => {});
    }
  }

  const { error: updErr } = await scopeToCompanyId(supabase
    .from('product_models')
    .update({ photo_url: photoUrl })
    .eq('id', id), co.companyId);
  if (updErr) {
    // Rollback the just-uploaded blob so we don't leak.
    await c.env.SO_ITEM_PHOTOS.delete(photoKey).catch(() => {});
    return c.json({ error: 'db_update_failed', reason: updErr.message }, 500);
  }

  return c.json({ photoUrl, photoKey }, 201);
});

productModels.delete('/:id/photo', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: model, error: mErr } = await scopeToCompanyId(supabase
    .from('product_models')
    .select('id, photo_url')
    .eq('id', id), co.companyId)
    .maybeSingle();
  if (mErr) return c.json({ error: 'load_failed', reason: mErr.message }, 500);
  if (!model) return c.json(NOT_THIS_COMPANY, 404);

  const m = model as { id: string; photo_url: string | null };
  if (m.photo_url) {
    const key = extractPhotoKey(m.photo_url, id);
    if (key) await c.env.SO_ITEM_PHOTOS.delete(key).catch(() => {});
  }

  const { error: updErr } = await scopeToCompanyId(supabase
    .from('product_models')
    .update({ photo_url: null })
    .eq('id', id), co.companyId);
  if (updErr) return c.json({ error: 'db_update_failed', reason: updErr.message }, 500);

  return c.json({ ok: true });
});

/** Extract the raw R2 key from a stored photo_url. Only returns a key if
 *  it lives under this Model's prefix — guards the DELETE/upload-replace
 *  paths against an attacker-supplied photo_url pointing at an unrelated
 *  object. */
function extractPhotoKey(photoUrl: string, modelId: string): string | null {
  const prefix = `/product-models/${modelId}/photo/`;
  const idx = photoUrl.indexOf(prefix);
  if (idx === -1) return null;
  const encoded = photoUrl.slice(idx + prefix.length);
  let decoded: string;
  try { decoded = decodeURIComponent(encoded); } catch { return null; }
  if (!decoded.startsWith(`product-models/${modelId}/`)) return null;
  return decoded;
}

// ============================================================================
// Multi-photo gallery (migration 0060_product_model_photos_and_hero_meta).
//
// Backs the 4a PhotoGallery component. Surface:
//   GET    /:id/photos                       → { photos: PhotoRow[] }
//   POST   /:id/photos        (multipart)    → { photo: PhotoRow }
//   DELETE /:id/photos/:photoId              → { ok: true }
//   PATCH  /:id/photos/:photoId              → { ok: true }
//                                              body: { is_primary?, order? }
//
// PhotoRow = { id, key, url, is_primary, order }
// `url` is a relative path to the PUBLIC hero/gallery proxy registered above
// (/product-models/:id/photo-gallery/:key) so <img src> works without auth.
//
// Storage: R2 bucket SO_ITEM_PHOTOS (shared with SO item photos under a
// different prefix). Keys are minted under product-model-photos/<modelId>/.
// ============================================================================

type PhotoCols = {
  id: string;
  r2_key: string;
  thumb_key: string | null;
  sort_order: number;
  is_primary: boolean;
  mime_type: string | null;
  size_bytes: number | null;
};

function photoToWire(modelId: string, p: PhotoCols) {
  return {
    id: p.id,
    key: p.r2_key,
    url: `/api/scm/product-models/${modelId}/photo-gallery/${encodeURIComponent(p.r2_key)}`,
    // WO-7: present only for photos uploaded with a client-generated thumb.
    // Old rows have thumb_key NULL and the frontend renders the full url.
    thumbUrl: p.thumb_key
      ? `/api/scm/product-models/${modelId}/photo-gallery/${encodeURIComponent(p.thumb_key)}`
      : null,
    is_primary: p.is_primary,
    order: p.sort_order,
  };
}

const GALLERY_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — matches the 4a frontend cap
const GALLERY_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

productModels.get('/:id/photos', async (c) => {
  const supabase = c.get('supabase');
  const id = c.req.param('id');
  const { data, error } = await scopeToCompany(
    supabase
      .from('product_model_photos')
      .select('id, r2_key, thumb_key, sort_order, is_primary, mime_type, size_bytes')
      .eq('model_id', id),
    c,
  )
    .order('is_primary', { ascending: false })
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const photos = (data ?? []).map((row) => photoToWire(id, row as PhotoCols));
  return c.json({ photos });
});

productModels.post('/:id/photos', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }
  const supabase = c.get('supabase');
  const id = c.req.param('id');

  // Multipart upload — Hono parses FormData via c.req.parseBody().
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: 'invalid_multipart' }, 400);
  }
  const file = body.file as File | undefined;
  if (!file || typeof file === 'string') {
    return c.json({ error: 'file_missing', expected: 'multipart field "file"' }, 400);
  }
  if (!GALLERY_MIME.has(file.type)) {
    return c.json(
      { error: 'unsupported_type', got: file.type, allowed: Array.from(GALLERY_MIME) },
      400,
    );
  }
  if (file.size > GALLERY_MAX_BYTES) {
    return c.json({ error: 'too_large', max_bytes: GALLERY_MAX_BYTES }, 413);
  }

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  // Confirm the model exists (in THIS company) before minting a key / uploading.
  const { data: model } = await scopeToCompanyId(supabase
    .from('product_models')
    .select('id')
    .eq('id', id), co.companyId)
    .maybeSingle();
  if (!model) return c.json(NOT_THIS_COMPANY, 404);

  // Mint a unique key under this model's prefix. Use crypto.randomUUID for
  // collision-safety; extension derived from MIME so the bucket reads back
  // the right content-type.
  const ext = file.type === 'image/png' ? 'png'
            : file.type === 'image/webp' ? 'webp'
            : 'jpg';
  const r2Key = `product-model-photos/${id}/${crypto.randomUUID()}.${ext}`;
  const buf = await file.arrayBuffer();
  await c.env.SO_ITEM_PHOTOS.put(r2Key, buf, {
    httpMetadata: { contentType: file.type },
  });

  // WO-7: optional client-generated thumbnail rides the same multipart body.
  // Best-effort — old clients send no `thumb` part and nothing changes.
  const thumbKey = await putOptionalThumb(c.env.SO_ITEM_PHOTOS, body.thumb, r2Key);

  // First photo for a model auto-marks itself primary. After that, primary
  // stays sticky until the operator changes it.
  const { count } = await supabase
    .from('product_model_photos')
    .select('id', { count: 'exact', head: true })
    .eq('model_id', id);
  const isFirst = (count ?? 0) === 0;

  // sort_order = current MAX + 1 (or 0 if empty). NULL on the very first
  // insert defaults to 0 per the table default.
  const { data: maxRow } = await supabase
    .from('product_model_photos')
    .select('sort_order')
    .eq('model_id', id)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextOrder =
    ((maxRow as { sort_order: number } | null)?.sort_order ?? -1) + 1;

  const insertRow = {
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    model_id: id,
    r2_key: r2Key,
    thumb_key: thumbKey,
    sort_order: nextOrder,
    is_primary: isFirst,
    mime_type: file.type,
    size_bytes: file.size,
  };
  const { data, error } = await supabase
    .from('product_model_photos')
    .insert(insertRow)
    .select('id, r2_key, thumb_key, sort_order, is_primary, mime_type, size_bytes')
    .single();
  if (error) {
    // Roll back the R2 objects so a failed DB insert doesn't leak storage.
    await c.env.SO_ITEM_PHOTOS.delete(r2Key).catch(() => {});
    await deleteThumbFor(c.env.SO_ITEM_PHOTOS, r2Key);
    return c.json({ error: 'db_insert_failed', reason: error.message }, 500);
  }
  return c.json({ photo: photoToWire(id, data as PhotoCols) });
});

productModels.delete('/:id/photos/:photoId', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const supabase = c.get('supabase');
  const id = c.req.param('id');
  const photoId = c.req.param('photoId');
  // Multi-company: scope the load + delete (and the re-promote below) so a blind
  // photo id from another company can't be read, have its R2 object deleted, or
  // be removed.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  // Load the row first so we know which R2 key to drop + can re-promote a
  // new primary if we deleted the existing one.
  const { data: row } = await scopeToCompanyId(supabase
    .from('product_model_photos')
    .select('id, r2_key, is_primary')
    .eq('model_id', id)
    .eq('id', photoId), co.companyId)
    .maybeSingle();
  if (!row) return c.json(NOT_THIS_COMPANY, 404);
  const target = row as { id: string; r2_key: string; is_primary: boolean };

  const { error: delErr } = await scopeToCompanyId(supabase
    .from('product_model_photos')
    .delete()
    .eq('id', photoId), co.companyId);
  if (delErr) return c.json({ error: 'db_delete_failed', reason: delErr.message }, 500);

  // Best-effort R2 cleanup — if the bucket call fails we DON'T re-insert the
  // row (delete intent was the operator's). Log via Workers tail if needed.
  if (c.env.SO_ITEM_PHOTOS) {
    await c.env.SO_ITEM_PHOTOS.delete(target.r2_key).catch(() => {});
    await deleteThumbFor(c.env.SO_ITEM_PHOTOS, target.r2_key);
  }

  // If the deleted row was the primary, promote the lowest-order remaining
  // photo so the gallery never sits primary-less while photos exist.
  if (target.is_primary) {
    const { data: next } = await scopeToCompanyId(supabase
      .from('product_model_photos')
      .select('id')
      .eq('model_id', id), co.companyId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (next) {
      await scopeToCompanyId(supabase
        .from('product_model_photos')
        .update({ is_primary: true })
        .eq('id', (next as { id: string }).id), co.companyId);
    }
  }

  return c.json({ ok: true });
});

productModels.patch('/:id/photos/:photoId', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }
  const supabase = c.get('supabase');
  const id = c.req.param('id');
  const photoId = c.req.param('photoId');
  // Multi-company: scope the load + every write so a blind photo id from another
  // company can't be re-ordered or promoted.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  // Validate target exists + belongs to this model.
  const { data: row } = await scopeToCompanyId(supabase
    .from('product_model_photos')
    .select('id, is_primary, sort_order')
    .eq('model_id', id)
    .eq('id', photoId), co.companyId)
    .maybeSingle();
  if (!row) return c.json(NOT_THIS_COMPANY, 404);
  const target = row as { id: string; is_primary: boolean; sort_order: number };

  // is_primary: setting true → demote the current primary on the same model
  // first (the partial unique index would otherwise reject the insert).
  if (body.is_primary === true) {
    await scopeToCompanyId(supabase
      .from('product_model_photos')
      .update({ is_primary: false })
      .eq('model_id', id)
      .eq('is_primary', true), co.companyId);
    const { error } = await scopeToCompanyId(supabase
      .from('product_model_photos')
      .update({ is_primary: true })
      .eq('id', photoId), co.companyId);
    if (error) return c.json({ error: 'patch_failed', reason: error.message }, 500);
  }

  // order: PATCH expects an absolute integer (the 4a frontend's move-up /
  // move-down compute the new value client-side). Re-numbering siblings is
  // intentionally out of scope here — the table tolerates ties (sort_order
  // + created_at break ordering ties), so a simple absolute write is enough.
  if (body.order !== undefined) {
    const n = Number(body.order);
    if (!Number.isInteger(n) || n < 0) {
      return c.json({ error: 'order_invalid', expected: 'non-negative integer' }, 400);
    }
    const { error } = await scopeToCompanyId(supabase
      .from('product_model_photos')
      .update({ sort_order: n })
      .eq('id', photoId), co.companyId);
    if (error) return c.json({ error: 'patch_failed', reason: error.message }, 500);
  }

  return c.json({ ok: true });
});
