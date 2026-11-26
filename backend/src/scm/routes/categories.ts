import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { scopeToCompany, activeCompanyId,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import type { Env, Variables } from '../env';


export const categoriesApi = new Hono<{ Bindings: Env; Variables: Variables }>();

categoriesApi.use('*', supabaseAuth);


categoriesApi.post('/:id/hero-image', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const id = c.req.param('id');
  const { data: exists } = await scopeToCompanyId(supabase.from('categories').select('id').eq('id', id), co.companyId).maybeSingle();
  if (!exists) return c.json(NOT_THIS_COMPANY, 404);
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.startsWith('image/jpeg') && !contentType.startsWith('image/png')) {
    return c.json({ error: 'unsupported_type', expected: 'image/jpeg or image/png' }, 400);
  }

  const blob = await c.req.arrayBuffer();
  if (blob.byteLength > 4 * 1024 * 1024) {
    return c.json({ error: 'too_large', max: '4MB' }, 413);
  }

  const ext = contentType.endsWith('jpeg') ? 'jpg' : 'png';
  const key = `category-heroes/${id}.${ext}`;

  await c.env.PUBLIC_ASSETS.put(key, blob, { httpMetadata: { contentType } });
  await scopeToCompanyId(supabase.from('categories').update({ hero_image_key: key }).eq('id', id), co.companyId);

  return c.json({ ok: true, key });
});

categoriesApi.get('/:id/hero-image', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const supabase = c.get('supabase');

  if (!c.env.PUBLIC_ASSETS) {
    return c.json({ error: 'public_assets_not_configured' }, 500);
  }

  const id = c.req.param('id');
  const row = await scopeToCompany(supabase.from('categories').select('hero_image_key').eq('id', id), c).maybeSingle();
  const heroKey = (row.data as { hero_image_key?: string | null } | null)?.hero_image_key ?? null;
  if (!heroKey) return c.json({ error: 'hero_not_set' }, 404);

  const obj = await c.env.PUBLIC_ASSETS.get(heroKey);
  if (!obj) return c.json({ error: 'hero_not_found_in_r2' }, 404);

  const contentType = obj.httpMetadata?.contentType ?? 'application/octet-stream';
  return new Response(obj.body, {
    headers: {
      'content-type': contentType,
      'cache-control': 'private, max-age=3600',
    },
  });
});

categoriesApi.delete('/:id/hero-image', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const id = c.req.param('id');
  const row = await scopeToCompanyId(supabase.from('categories').select('hero_image_key').eq('id', id), co.companyId).maybeSingle();
  if (!row.data) return c.json(NOT_THIS_COMPANY, 404);
  if (row.data?.hero_image_key) {
    await c.env.PUBLIC_ASSETS.delete(row.data.hero_image_key);
  }
  await scopeToCompanyId(supabase.from('categories').update({
    hero_image_key: null,
    hero_focal_x: null,
    hero_focal_y: null,
    hero_alt: null,
  }).eq('id', id), co.companyId);

  return c.json({ ok: true });
});


export const publicCategoriesApi = new Hono<{ Bindings: Env; Variables: Variables }>();

export const categoryHeroBlobHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  if (!c.env.PUBLIC_ASSETS) {
    return c.json({ error: 'public_assets_not_configured' }, 500);
  }
  const id = c.req.param('id');
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data } = await sb
    .schema('scm')
    .from('categories')
    .select('hero_image_key')
    .eq('id', id)
    .maybeSingle();
  const heroKey = (data as { hero_image_key?: string | null } | null)?.hero_image_key ?? null;
  if (!heroKey) return c.json({ error: 'hero_not_set' }, 404);

  if (!heroKey.startsWith('category-heroes/')) {
    return c.json({ error: 'hero_key_invalid' }, 400);
  }

  const obj = await c.env.PUBLIC_ASSETS.get(heroKey);
  if (!obj) return c.json({ error: 'hero_not_found_in_r2' }, 404);

  const contentType = obj.httpMetadata?.contentType ?? 'application/octet-stream';
  return new Response(obj.body, {
    headers: {
      'content-type': contentType,
      'cache-control': 'public, max-age=3600',
    },
  });
};
publicCategoriesApi.get('/:id/hero-blob', categoryHeroBlobHandler);

publicCategoriesApi.use('*', supabaseAuth);

publicCategoriesApi.get('/', async (c) => {
  const supabase = c.get('supabase');
  let listQ = supabase
    .from('categories')
    .select('id, label, icon, tbc, sort_order, hero_image_key, hero_focal_x, hero_focal_y, hero_alt')
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });
  listQ = scopeToCompany(listQ, c);
  const { data, error } = await listQ;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const categories = (data ?? []).map((r) => {
    const row = r as {
      id: string;
      label: string;
      icon: string;
      tbc: boolean | null;
      sort_order: number;
      hero_image_key: string | null;
      hero_focal_x: number | null;
      hero_focal_y: number | null;
      hero_alt: string | null;
    };
    return {
      id: row.id,
      name: row.label,
      slug: row.icon,
      label: row.label,
      icon: row.icon,
      tbc: row.tbc ?? false,
      sortOrder: row.sort_order,
      hero_image_key: row.hero_image_key,
      hero_url: row.hero_image_key
        ? `/api/scm/categories/${row.id}/hero-blob`
        : null,
    };
  });
  return c.json({ categories });
});

publicCategoriesApi.get('/:id/hero-meta', async (c) => {
  const supabase = c.get('supabase');
  const id = c.req.param('id');
  const { data, error } = await scopeToCompany(
    supabase
      .from('categories')
      .select('hero_image_key, hero_focal_x, hero_focal_y, hero_alt')
      .eq('id', id),
    c,
  )
    .maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  const row = data as {
    hero_image_key: string | null;
    hero_focal_x: number | null;
    hero_focal_y: number | null;
    hero_alt: string | null;
  };
  return c.json({
    url: row.hero_image_key
      ? `/api/scm/categories/${id}/hero-blob`
      : null,
    focal_x: row.hero_focal_x ?? 0.5,
    focal_y: row.hero_focal_y ?? 0.5,
    alt: row.hero_alt ?? '',
  });
});


const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/;
const isValidId = (v: unknown): v is string =>
  typeof v === 'string' && ID_PATTERN.test(v);
const trim200 = (v: unknown): string =>
  typeof v === 'string' ? v.trim().slice(0, 200) : '';

publicCategoriesApi.post('/', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const id = typeof body.id === 'string' ? body.id.trim().toLowerCase() : '';
  if (!isValidId(id)) {
    return c.json({
      error: 'invalid_id',
      reason: 'Lowercase letters / digits / hyphens, must start with alnum, 1–50 chars.',
    }, 400);
  }
  const label = trim200(body.label);
  if (!label) return c.json({ error: 'label_required' }, 400);
  const icon = trim200(body.icon) || 'package';
  const sortOrder = Number.isInteger(body.sort_order) ? Number(body.sort_order) : null;

  const supabase = c.get('supabase');
  // Pre-flight: bounce duplicate id with a clear error (cheaper than a
  // catch-the-constraint round-trip).
  //
  // Company scope (owner audit 2026-07-22): the unscoped SELECT would 409
  // when the same id existed in ANOTHER company, leaking existence of that
  // company's category id (a small enumeration probe). Scope to the active
  // company so the caller only learns about their own duplicates; the DB
  // unique constraint is (company_id, id) so a legitimate insert still works.
  const { data: existing } = await scopeToCompany(
    supabase.from('categories').select('id').eq('id', id),
    c,
  ).maybeSingle();
  if (existing) return c.json({ error: 'id_taken', id }, 409);

  let finalSort = sortOrder;
  if (finalSort === null) {
    let topQ = supabase
      .from('categories')
      .select('sort_order')
      .order('sort_order', { ascending: false })
      .limit(1);
    topQ = scopeToCompany(topQ, c);
    const { data: top } = await topQ.maybeSingle();
    finalSort = ((top as { sort_order: number } | null)?.sort_order ?? -1) + 1;
  }

  const { data, error } = await supabase
    .from('categories')
    .insert({ company_id: activeCompanyId(c), id, label, icon, sort_order: finalSort, tbc: false })
    .select('id, label, icon, sort_order, hero_image_key')
    .single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);

  return c.json({ category: data });
});

publicCategoriesApi.patch('/:id', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }
  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = c.req.param('id');

  const patch: Record<string, unknown> = {};
  if (body.label !== undefined) {
    const label = trim200(body.label);
    if (!label) return c.json({ error: 'label_blank' }, 400);
    patch.label = label;
  }
  if (body.icon !== undefined) {
    const icon = trim200(body.icon);
    if (!icon) return c.json({ error: 'icon_blank' }, 400);
    patch.icon = icon;
  }
  if (body.sort_order !== undefined) {
    const n = Number(body.sort_order);
    if (!Number.isInteger(n) || n < 0) {
      return c.json({ error: 'sort_order_invalid', expected: 'non-negative integer' }, 400);
    }
    patch.sort_order = n;
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: 'nothing_to_patch' }, 400);
  }

  const { data, error } = await scopeToCompanyId(supabase
    .from('categories')
    .update(patch)
    .eq('id', id), co.companyId)
    .select('id, label, icon, sort_order, hero_image_key')
    .single();
  if (error) {
    if (error.code === 'PGRST116') return c.json({ error: 'not_found' }, 404);
    return c.json({ error: 'patch_failed', reason: error.message }, 500);
  }
  return c.json({ category: data });
});

export const deleteCategoryHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = c.req.param('id') ?? '';

  const enumValue = id.toUpperCase();
  const { data: refs, count, error: refsErr } = await scopeToCompany(
    supabase
      .from('product_models')
      .select('model_code', { count: 'exact' })
      .eq('category', enumValue),
    c,
  )
    .limit(9);
  if (refsErr) {
    return c.json({
      error: 'category_in_use_check_failed',
      reason:
        'Could not check whether any product model still uses this category, so it is kept '
        + `rather than deleted on an answer nobody verified — try again (${refsErr.message}).`,
    }, 409);
  }
  if ((count ?? 0) > 0) {
    return c.json({
      error: 'category_in_use',
      count: count ?? 0,
      sample_models: refs.map((r) => (r as { model_code: string }).model_code),
    }, 409);
  }

  const { data: row } = await scopeToCompanyId(supabase
    .from('categories')
    .select('hero_image_key')
    .eq('id', id), co.companyId)
    .maybeSingle();
  if (!row) return c.json(NOT_THIS_COMPANY, 404);
  const heroKey = (row as { hero_image_key: string | null } | null)?.hero_image_key;
  if (heroKey && c.env.PUBLIC_ASSETS) {
    await c.env.PUBLIC_ASSETS.delete(heroKey).catch(() => {});
  }

  const { error } = await scopeToCompanyId(supabase.from('categories').delete().eq('id', id), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);

  return c.json({ ok: true });
};
publicCategoriesApi.delete('/:id', deleteCategoryHandler);

publicCategoriesApi.patch('/:id/hero-meta', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }
  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const id = c.req.param('id');

  const patch: Record<string, unknown> = {};
  if (body.focal_x !== undefined) {
    const n = Number(body.focal_x);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return c.json({ error: 'focal_x_out_of_range', expected: '0..1' }, 400);
    }
    patch.hero_focal_x = n;
  }
  if (body.focal_y !== undefined) {
    const n = Number(body.focal_y);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return c.json({ error: 'focal_y_out_of_range', expected: '0..1' }, 400);
    }
    patch.hero_focal_y = n;
  }
  if (body.alt !== undefined) {
    const s = String(body.alt ?? '').trim();
    if (s.length > 200) {
      return c.json({ error: 'alt_too_long', max: 200 }, 400);
    }
    patch.hero_alt = s || null;
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: 'nothing_to_patch' }, 400);
  }

  const { data: upd, error } = await scopeToCompanyId(supabase.from('categories').update(patch).eq('id', id), co.companyId).select('id').maybeSingle();
  if (error) return c.json({ error: 'patch_failed', reason: error.message }, 500);
  if (!upd) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});
