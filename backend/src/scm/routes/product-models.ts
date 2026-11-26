
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
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { baseKeyOf, deleteThumbFor, putOptionalThumb } from '../../services/photoThumbs';
import type { Env, Variables } from '../env';
import { pgrestIn } from '../lib/pgrest-in-list';
import { categorySwapAllowed } from '../shared/category-swap';
import { invalidModelDefault } from '../shared/model-default-variants';
import { moveModelCategory } from '../lib/model-category-move';
import { MFG_PRODUCT_CATEGORIES } from './mfg-products';
import { isSingleSkuCategory } from '../shared/product-categories';
import { newSkuPosActive } from '../lib/new-sku-pos-active';

export const productModels = new Hono<{ Bindings: Env; Variables: Variables }>();

export const modelPhotoProxyHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  // company-scope: PUBLIC pre-auth image proxy, mounted before companyContext on purpose (the 2990 POS <img> is cross-origin and carries no session), so no company can be resolved. The requested R2 key must equal the model's stored photo_url key, which is a server-minted randomUUID.
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
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
};
productModels.get('/:id/photo/:key', modelPhotoProxyHandler);

productModels.get('/:id/photo-gallery/:key', async (c) => {
  const id = c.req.param('id');
  const key = decodeURIComponent(c.req.param('key'));

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }
  if (!key.startsWith('product-model-photos/')) {
    return c.json({ error: 'gallery_key_invalid' }, 400);
  }

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
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
});

productModels.use('*', supabaseAuth);

const CATEGORIES = MFG_PRODUCT_CATEGORIES;

const CreateBody = z.object({
  branding:       z.string().trim().max(80).optional().nullable(),
  modelCode:      z.string().trim().min(1).max(32),
  name:           z.string().trim().min(1).max(200),
  category:       z.enum(CATEGORIES),
  description:    z.string().trim().max(500).optional().nullable(),
  photoUrl:       z.string().trim().url().optional().nullable(),
  allowedOptions: z.record(z.unknown()).optional(),
  active:         z.boolean().optional(),
});

const MODEL_CODE_MAX = 32;
const MODEL_CODE_REFUSALS: Record<string, string> = {
  empty_code: 'The model code cannot be empty.',
  code_taken: 'Another model, SKU, combo or quick pick already uses that code.',
  code_shared: 'Another model still uses the old code, so its SKUs cannot be moved safely.',
  pos_combos_in_use: 'The 2990 POS still has live combos under the old code. Retire them on the POS first.',
};

const PatchBody = z.object({
  branding:       z.string().trim().max(80).nullable().optional(),
  modelCode:      z.string().trim().min(1).max(200).optional(),
  name:           z.string().trim().min(1).max(200).optional(),
  category:       z.enum(CATEGORIES).optional(),
  description:    z.string().trim().max(500).nullable().optional(),
  photoUrl:       z.string().trim().url().nullable().optional(),
  allowedOptions: z.record(z.unknown()).optional(),
  defaultVariants: z.record(z.string().trim().min(1)).optional(),
  active:         z.boolean().optional(),
});

const COLS = 'id, branding, model_code, name, category, description, photo_url, allowed_options, default_variants, active, created_at, updated_at';

/* The newly ticked compartments that have no SKU yet. Case-insensitive (HC-0176):
   the pool says "Console Wooden" while the imported SKU is `9050-CONSOLE WOODEN`,
   and the unique index on code is case-sensitive, so an exact-case check minted
   a second SKU — the twin that shadows the real one in the scan's UPPER(code)
   canon (20260930T1100_deactivate_upper_console_twins.sql). */
export function compartmentsWithoutSku(added: string[], codePrefix: string, existingCodes: string[]): string[] {
  const have = new Set(existingCodes.map((code) => code.toUpperCase()));
  return added.filter((comp) => !have.has(`${codePrefix}-${comp}`.toUpperCase()));
}

export const listProductModelsHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const supabase = c.get('supabase');
  const category = c.req.query('category');

  const inCategory = category && (CATEGORIES as readonly string[]).includes(category) ? category : null;
  const { data, error } = await paginateAll((from, to) => {
    let q = scopeToCompany(supabase.from('product_models').select(COLS), c).order('category').order('model_code').order('id');
    if (inCategory) q = q.eq('category', inCategory);
    return q.range(from, to);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = (data ?? []) as Array<Record<string, unknown> & { id: string }>;

  const counts = new Map<string, number>();
  const activeCounts = new Map<string, number>();
  if (rows.length > 0) {
    const { data: skuRows, error: cntErr } = await chunkIn(rows.map((m) => m.id), (batch, from, to) =>
      scopeToCompany(supabase.from('mfg_products').select('model_id, status').in('model_id', batch).order('id'), c)
        .range(from, to));
    if (cntErr) return c.json({ error: 'load_failed', reason: cntErr.message }, 500);
    for (const r of (skuRows ?? []) as Array<{ model_id: string | null; status: string | null }>) {
      if (!r.model_id) continue;
      counts.set(r.model_id, (counts.get(r.model_id) ?? 0) + 1);
      if (r.status === 'ACTIVE') activeCounts.set(r.model_id, (activeCounts.get(r.model_id) ?? 0) + 1);
    }
  }
  /* active_sku_count: Modular hides a Model whose codes are all off (merged away)
     unless "Show inactive" is on (owner, 2026-11-10). */
  const models = rows.map((m) => ({ ...m, sku_count: counts.get(m.id) ?? 0, active_sku_count: activeCounts.get(m.id) ?? 0 }));
  c.header('cache-control', 'private, max-age=60');
  c.header('vary', 'X-Company-Id');
  return c.json({ models });
};
productModels.get('/', listProductModelsHandler);

productModels.get('/by-code/:code', async (c) => {
  const code = c.req.param('code');
  const supabase = c.get('supabase');

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

  const { data: skus, error: skuErr } = await pgrestIn(supabase
    .from('mfg_products')
    .select('code, model_id, category'), 'code', codes)
    .eq('company_id', activeCompanyId(c));
  if (skuErr) {
    if (/relation .* does not exist/i.test(skuErr.message)) return c.json({ results: allNull() });
    return c.json({ error: 'load_failed', reason: skuErr.message }, 500);
  }
  if (!skus) return c.json({ error: 'load_failed', reason: 'mfg_products read returned no rows' }, 500);

  const skuByCode = new Map<string, { modelId: string | null; category: string | null }>();
  for (const r of skus as Array<Record<string, unknown>>) {
    if (r.code == null) continue;
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
    results[code] = {
      allowedOptions: allowedByModelId.has(sku.modelId) ? allowedByModelId.get(sku.modelId) : null,
      category: sku.category,
    };
  }
  return c.json({ results });
});

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

  const { data: skus } = await supabase
    .from('mfg_products')
    .select('id, code, name, size_code, size_label, status, base_price_sen, price1_sen, cost_price_sen, unit_m3_milli, pos_active, one_shot, source_doc_no')
    .eq('model_id', id)
    .order('code')
    .limit(200);

  const skuRows = (skus ?? []) as Array<Record<string, unknown>>;
  if (!canViewScmProductCost(c)) {
    for (const s of skuRows) {
      for (const k of PRODUCT_FINANCE_KEYS) delete s[k];
    }
  }

  return c.json({ model, skus: skuRows });
});

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

export const patchProductModelHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const id = c.req.param('id');
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);

  const u: Record<string, unknown> = {};
  if (parsed.data.branding !== undefined)       u.branding        = parsed.data.branding;
  if (parsed.data.modelCode !== undefined)      u.model_code      = parsed.data.modelCode;
  if (parsed.data.name !== undefined)           u.name            = parsed.data.name;
  if (parsed.data.description !== undefined)    u.description     = parsed.data.description;
  if (parsed.data.photoUrl !== undefined)       u.photo_url       = parsed.data.photoUrl;
  if (parsed.data.allowedOptions !== undefined) u.allowed_options = parsed.data.allowedOptions;
  if (parsed.data.defaultVariants !== undefined) u.default_variants = parsed.data.defaultVariants;
  if (parsed.data.active !== undefined)         u.active          = parsed.data.active;
  if (parsed.data.category !== undefined)       u.category        = parsed.data.category;

  if (Object.keys(u).length === 0) {
    return c.json({ error: 'empty_patch' }, 400);
  }

  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: before } = await scopeToCompanyId(supabase
    .from('product_models')
    .select('allowed_options, category, model_code')
    .eq('id', id), co.companyId)
    .maybeSingle();
  const beforeCode = (before as { model_code?: string } | null)?.model_code ?? null;
  if (u.model_code !== undefined && u.model_code !== beforeCode && String(u.model_code).length > MODEL_CODE_MAX) {
    return c.json({
      error: 'model_code_too_long',
      reason: `Model code can be at most ${MODEL_CODE_MAX} characters.`,
    }, 400);
  }
  const beforeCategory = (before as { category?: string } | null)?.category ?? null;
  if (u.category !== undefined && u.category === beforeCategory) delete u.category;
  if (u.category !== undefined && !categorySwapAllowed(beforeCategory, String(u.category))) {
    return c.json({
      error: 'category_change_not_allowed',
      reason: `"${String(u.category)}" is not a product category.`,
    }, 409);
  }
  if (Object.keys(u).length === 0) return c.json({ error: 'empty_patch' }, 400);
  if (parsed.data.defaultVariants !== undefined) {
    const bad = invalidModelDefault(
      String(u.category ?? beforeCategory ?? ''),
      parsed.data.defaultVariants,
      parsed.data.allowedOptions ?? (before as { allowed_options?: unknown } | null)?.allowed_options ?? null,
    );
    if (bad) {
      return c.json({ error: 'default_not_allowed', message: `The default for ${bad} is not one of this Model's allowed options.` }, 400);
    }
  }
  let codeRenamed = false;
  if (u.model_code !== undefined && u.model_code !== beforeCode) {
    const { data: ren, error: renErr } = await supabase.rpc('rename_model_code', {
      p_company_id: co.companyId, p_model_id: String(id), p_new_code: String(u.model_code),
    });
    if (renErr) return c.json({ error: 'rename_failed', reason: renErr.message }, 500);
    const r = (ren ?? {}) as { renamed?: boolean; refused?: string };
    if (!r.renamed) {
      if (r.refused === 'not_found') return c.json(NOT_THIS_COMPANY, 404);
      return c.json({ error: r.refused ?? 'rename_refused', message: MODEL_CODE_REFUSALS[r.refused ?? ''] ?? 'The model code could not be changed.' }, 409);
    }
    codeRenamed = true;
  }
  delete u.model_code;
  const newCategory = u.category === undefined ? undefined : String(u.category);
  delete u.category;
  let data: Record<string, unknown> | null = null;
  if (Object.keys(u).length > 0) {
    const { data: updated, error } = await scopeToCompanyId(supabase
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
    if (!updated) return c.json(NOT_THIS_COMPANY, 404);
    data = updated as Record<string, unknown>;
  }

  if (codeRenamed && !data && newCategory === undefined) {
    const { data: reread, error: rereadErr } = await scopeToCompanyId(supabase
      .from('product_models')
      .select(COLS)
      .eq('id', id), co.companyId)
      .maybeSingle();
    if (rereadErr) return c.json({ error: 'load_failed', reason: rereadErr.message }, 500);
    data = reread as Record<string, unknown> | null;
  }

  if (newCategory !== undefined) {
    const moved = await moveModelCategory(supabase, co.companyId, String(id), newCategory);
    if (!moved.ok) {
      if (moved.error === 'model_not_found') return c.json(NOT_THIS_COMPANY, 404);
      if (moved.error === 'target_category_taken') {
        return c.json({ error: moved.error, message: moved.reason }, 409);
      }
      return c.json({ error: moved.error, reason: moved.reason }, 500);
    }
    if (data) {
      data = { ...data, category: newCategory };
    } else {
      const { data: reread, error: rereadErr } = await scopeToCompanyId(supabase
        .from('product_models')
        .select(COLS)
        .eq('id', id), co.companyId)
        .maybeSingle();
      if (rereadErr) return c.json({ error: 'load_failed', reason: rereadErr.message }, 500);
      data = (reread as Record<string, unknown> | null) ?? { id, category: newCategory };
    }
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);

  const cat = (data as { category?: string }).category;
  const aoSizes = (parsed.data.allowedOptions as { sizes?: unknown } | undefined)?.sizes;
  if ((cat === 'MATTRESS' || cat === 'BEDFRAME') && Array.isArray(aoSizes) && aoSizes.length > 0) {
    const allowedSet = new Set((aoSizes as unknown[]).map((s) => String(s).toUpperCase()));
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

  const autoCreatedSkus: string[] = [];
  const autoCreateFailed: string[] = [];
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
      const upperName  = (modelName || modelCode).toUpperCase();
      const wantCodes = added.map((comp) => `${codePrefix}-${comp}`);
      const [{ data: existing, error: existingErr }, { data: ofModel, error: ofModelErr }] = await Promise.all([
        pgrestIn(supabase
          .from('mfg_products')
          .select('code'), 'code', wantCodes)
          .eq('company_id', activeCompanyId(c)),
        supabase
          .from('mfg_products')
          .select('code')
          .eq('model_id', id)
          .eq('company_id', activeCompanyId(c)),
      ]);
      for (const err of [existingErr, ofModelErr]) {
        if (!err) continue;
        // eslint-disable-next-line no-console
        console.error('[product-models] existing derived-code read failed:', (err as { message?: unknown }).message ?? err);
      }
      const haveCodes = [...(existing ?? []), ...(ofModel ?? [])].map((r) => (r as { code: string }).code);
      const now = new Date().toISOString();
      const rows = compartmentsWithoutSku(added, codePrefix, haveCodes)
        .map((comp) => {
          const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          return {
            id:         `mfg-${rand.replace(/-/g, '').slice(0, 12)}`,
            code:       `${codePrefix}-${comp}`,
            name:       `SOFA ${upperName} ${comp}`,
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
        const { error: insErr } = await supabase.from('mfg_products').insert(stampCompany(rows, c));
        if (!insErr || insErr.code === '23505') autoCreatedSkus.push(...rows.map((r) => r.code));
        else autoCreateFailed.push(...rows.map((r) => r.code));
      }
    }
  }

  return c.json({ model: data, autoCreatedSkus, autoCreateFailed });
};
productModels.patch('/:id', patchProductModelHandler);

const SIZE_INFO: Record<string, { label: string; dim: string; w: number; l: number }> = {
  K:  { label: '6FT',       dim: '183X190CM', w: 183, l: 190 },
  Q:  { label: '5FT',       dim: '152X190CM', w: 152, l: 190 },
  S:  { label: '3FT',       dim: '90X190CM',  w: 90,  l: 190 },
  SS: { label: '3.5FT',     dim: '107X190CM', w: 107, l: 190 },
  SK: { label: '200X200CM', dim: '',          w: 200, l: 200 },
  SP: { label: 'CUSTOM',    dim: '',          w: 0,   l: 0   },
};

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

export const generateModelSkusHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  let body: { rows?: Array<{ code: string; name: string; size_code?: string | null; size_label?: string | null }>; codes?: string[] } = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as typeof body;
  } catch { }
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

  let sizeOverrides: Record<string, { label?: string; dimensions?: string }> | null = null;
  try {
    const { data: cfgRow } = await scopeToCompanyId(supabase
      .from('maintenance_config_history')
      .select('config'), co.companyId)
      .eq('scope', 'master')
      .lte('effective_from', todayMyt())
      .order('effective_from', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const blob = cfgRow?.config as { sizeLabels?: typeof sizeOverrides } | undefined;
    if (blob?.sizeLabels && typeof blob.sizeLabels === 'object') {
      sizeOverrides = blob.sizeLabels;
    }
  } catch {
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
  //             name:  SOFA {model.name} {compartment}   SOFA 5530 1A(LHF)
  //                                                       SOFA ADDA 1A(LHF)
  //             — no branding in the name; it lives in the branding column.
  //
  const modelName = (model.name ?? '').trim();
  const sizesArr  = Array.isArray(opts.sizes)        ? (opts.sizes as string[])        : [];
  const compsArr  = Array.isArray(opts.compartments) ? (opts.compartments as string[]) : [];
  const mattressThickness = typeof opts.mattress_thickness_cm === 'number'
    ? opts.mattress_thickness_cm
    : null;

  type GenRow = { code: string; name: string; size_code: string | null; size_label: string | null };
  const wanted: GenRow[] = [];

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
    for (const comp of compsArr) {
      wanted.push({
        code:       `${model.model_code}-${comp}`,
        name:       `SOFA ${modelName} ${comp}`,
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
    const branding = (model.branding ?? '').trim();
    const prefix   = branding ? `${branding} ` : '';
    for (const sz of sizesArr) {
      const info  = resolveSizeInfoServer(sz, sizeOverrides);
      const label = info.label;
      let dimPart: string;
      if (info.w && info.l && mattressThickness != null) {
        dimPart = `${info.w}x${info.l}x${mattressThickness}CM`;
      } else if (info.dim) {
        dimPart = info.dim.toLowerCase();
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
        name:       `${prefix}${modelName} MATTRESS (${dimPart})`.trim(),
        size_code:  sz,
        size_label: label,
      });
    }
  } else if (isSingleSkuCategory(model.category)) {
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

  const filterCodesUpper = filterCodes
    ? new Set(Array.from(filterCodes).map((c) => c.toUpperCase()))
    : null;
  const wantedFiltered = filterCodesUpper
    ? wanted.filter((w) => filterCodesUpper.has(w.code))
    : wanted;

  const codes = wantedFiltered.map((w) => w.code);
  const { data: existing } = codes.length
    ? await pgrestIn(supabase.from('mfg_products').select('code'), 'code', codes).eq('company_id', activeCompanyId(c))
    : { data: [] as Array<{ code: string }> };
  const existingSet = new Set((existing ?? []).map((r) => r.code as string));

  const toInsert = wantedFiltered.filter((w) => !existingSet.has(w.code));
  if (toInsert.length === 0) {
    return c.json({
      generated: 0,
      skipped: wantedFiltered.length,
      codes: wantedFiltered.map((w) => w.code),
      reason: 'All variant codes already exist — nothing new to insert.',
    });
  }

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
      branding:   model.branding ?? null,
      model_id:   model.id,
      status:     'ACTIVE',
      pos_active: newSkuPosActive(co.companyId, model.category),
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
    codes: wantedFiltered.map((w) => w.code),
  });
};
productModels.post('/:id/generate-skus', generateModelSkusHandler);

productModels.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: exists } = await scopeToCompanyId(supabase.from('product_models').select('id').eq('id', id), co.companyId).maybeSingle();
  if (!exists) return c.json(NOT_THIS_COMPANY, 404);
  const used = await findModelUsage(supabase, id);
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


const PHOTO_MAX_BYTES = 2 * 1024 * 1024;

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

  const photoUrl = `/product-models/${id}/photo/${encodeURIComponent(photoKey)}`;

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
    thumbUrl: p.thumb_key
      ? `/api/scm/product-models/${modelId}/photo-gallery/${encodeURIComponent(p.thumb_key)}`
      : null,
    is_primary: p.is_primary,
    order: p.sort_order,
  };
}

const GALLERY_MAX_BYTES = 5 * 1024 * 1024;
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
  const { data: model } = await scopeToCompanyId(supabase
    .from('product_models')
    .select('id')
    .eq('id', id), co.companyId)
    .maybeSingle();
  if (!model) return c.json(NOT_THIS_COMPANY, 404);

  const ext = file.type === 'image/png' ? 'png'
            : file.type === 'image/webp' ? 'webp'
            : 'jpg';
  const r2Key = `product-model-photos/${id}/${crypto.randomUUID()}.${ext}`;
  const buf = await file.arrayBuffer();
  await c.env.SO_ITEM_PHOTOS.put(r2Key, buf, {
    httpMetadata: { contentType: file.type },
  });

  const thumbKey = await putOptionalThumb(c.env.SO_ITEM_PHOTOS, body.thumb, r2Key);

  const { count } = await supabase
    .from('product_model_photos')
    .select('id', { count: 'exact', head: true })
    .eq('model_id', id);
  const isFirst = (count ?? 0) === 0;

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
    company_id: activeCompanyId(c),
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
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

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

  if (c.env.SO_ITEM_PHOTOS) {
    await c.env.SO_ITEM_PHOTOS.delete(target.r2_key).catch(() => {});
    await deleteThumbFor(c.env.SO_ITEM_PHOTOS, target.r2_key);
  }

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
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: row } = await scopeToCompanyId(supabase
    .from('product_model_photos')
    .select('id, is_primary, sort_order')
    .eq('model_id', id)
    .eq('id', photoId), co.companyId)
    .maybeSingle();
  if (!row) return c.json(NOT_THIS_COMPANY, 404);
  const target = row as { id: string; is_primary: boolean; sort_order: number };

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
