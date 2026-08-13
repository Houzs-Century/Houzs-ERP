import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { scopeToCompany, activeCompanyId,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import type { Env, Variables } from '../env';

// TODO(Task 18): add categories.test.ts when R2 mocking is set up.

export const categoriesApi = new Hono<{ Bindings: Env; Variables: Variables }>();

categoriesApi.use('*', supabaseAuth);

// Houzs-flavoured: gate via canWriteScmConfig (flat `scm.config.write` OR the position policy canWriteConfig flag, see houzs-perms.ts) against
// the REAL caller (the 2990 staff_role lookup is dead in Houzs — the SCM
// bridge pins every caller to one super_admin row, so the original gate
// trivially passed for everyone).

categoriesApi.post('/:id/hero-image', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const id = c.req.param('id');
  // Multi-company: confirm the category is THIS company's before writing the R2
  // object or the DB row (a blind slug from another company is not found).
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

// Proxy GET — streams the stored hero image from the PUBLIC_ASSETS R2 bucket.
// Mirrors the SO/consignment per-line photo proxy: auth-gated (the whole
// /api/scm tree is owner-gated; this also requires an admin/coordinator staff
// role like the put/delete here), Content-Type set from the stored object,
// 404 when the category has no hero or the object is missing.
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
  // Multi-company: scope the load so we never read (or delete the R2 object of)
  // another company's category hero.
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

// ============================================================================
// publicCategoriesApi — mounted at /api/scm/categories (NO /admin prefix).
// Read-side surface for the 4a Categories page and HeroImageEditor:
//   GET  /                  → { categories: [...] }
//   GET  /:id/hero-meta     → { url, focal_x, focal_y, alt }
//   PATCH /:id/hero-meta    → updates focal + alt (admin gated)
//   GET  /:id/hero-blob     → streams the R2 hero image. The key is validated
//                             against the stored hero_image_key so a guessed
//                             URL can't leak unrelated R2 objects.
//
// Naming caveat: "public" in this router's name is partly aspirational. The
// whole /api/scm/* tree is gated by requireScmAccess (src/index.ts), so a
// raw unauthenticated request still gets 401 at the entry. hero-blob works
// as an <img src> because the browser attaches the existing session cookie
// automatically. If a guest-viewable hero proxy is ever needed (e.g. a
// public storefront), mount a new router OUTSIDE /api/scm.
// ============================================================================

export const publicCategoriesApi = new Hono<{ Bindings: Env; Variables: Variables }>();

// Registered BEFORE publicCategoriesApi.use('*', supabaseAuth) so the handler
// runs without that middleware attaching c.get('supabase') (browser <img>
// tags can't add the Bearer header it expects). The handler instead builds
// its own service-role client below. Parent requireScmAccess still applies —
// see the naming caveat above.
// Exported so it can ALSO be mounted OUTSIDE /api/scm (routes/public-images.ts)
// — same reason as the Model photo proxy: the cross-origin, Bearer-auth POS
// can't pass the global /api/scm gate with a plain <img src>. Mounted pre-auth
// there; the in-scmApp registration below stays for the same-origin SPA.
export const categoryHeroBlobHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  if (!c.env.PUBLIC_ASSETS) {
    return c.json({ error: 'public_assets_not_configured' }, 500);
  }
  const id = c.req.param('id');
  // Use a service-role client since no JWT is on the request.
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

  // Defensive: the stored key must live under the category-heroes/ prefix
  // we minted in POST. Stops a tampered DB row from streaming an arbitrary
  // R2 object (the bucket is shared with SO photos under a different prefix).
  if (!heroKey.startsWith('category-heroes/')) {
    return c.json({ error: 'hero_key_invalid' }, 400);
  }

  const obj = await c.env.PUBLIC_ASSETS.get(heroKey);
  if (!obj) return c.json({ error: 'hero_not_found_in_r2' }, 404);

  const contentType = obj.httpMetadata?.contentType ?? 'application/octet-stream';
  return new Response(obj.body, {
    headers: {
      'content-type': contentType,
      // Public, cacheable. Reload after upload is handled client-side by
      // invalidating the meta query (the URL is the same; cache will refresh
      // on next request — operators rarely need sub-second re-fetch).
      'cache-control': 'public, max-age=3600',
    },
  });
};
publicCategoriesApi.get('/:id/hero-blob', categoryHeroBlobHandler);

// Everything below requires auth.
publicCategoriesApi.use('*', supabaseAuth);

// GET / — list categories with the hero meta fields the page needs.
// Surfaces a relative-url hero_url that points at the public hero-blob proxy
// above, so the Categories grid + drawer don't need to know about R2 keys.
publicCategoriesApi.get('/', async (c) => {
  const supabase = c.get('supabase');
  let listQ = supabase
    .from('categories')
    .select('id, label, icon, tbc, sort_order, hero_image_key, hero_focal_x, hero_focal_y, hero_alt')
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });
  listQ = scopeToCompany(listQ, c); // multi-company: isolate to the active company
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
      name: row.label,           // align with the frontend's CategoryRow.name
      slug: row.icon,            // icon doubles as the slug-ish identifier
      // POS repoint (cutover): the 2990 POS reads label/icon/tbc/sortOrder off
      // this list (useCategoriesAll → the left category rail + "to be confirmed"
      // section). Emitted ALONGSIDE name/slug so the existing Houzs Categories
      // grid (reads name/slug/hero_url) is unaffected.
      label: row.label,
      icon: row.icon,
      tbc: row.tbc ?? false,
      sortOrder: row.sort_order,
      hero_image_key: row.hero_image_key,
      // /api/scm prefix is added by the worker's mount; this relative path
      // round-trips through authedFetch + <img src> (the latter via public
      // hero-blob — no auth needed). Null when no cover set.
      hero_url: row.hero_image_key
        ? `/api/scm/categories/${row.id}/hero-blob`
        : null,
    };
  });
  return c.json({ categories });
});

// GET /:id/hero-meta — what the HeroImageEditor reads on open.
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
    // Default centred when null — the editor needs concrete numbers to
    // position the crosshair.
    focal_x: row.hero_focal_x ?? 0.5,
    focal_y: row.hero_focal_y ?? 0.5,
    alt: row.hero_alt ?? '',
  });
});

// ── Categories CRUD ────────────────────────────────────────────────────────
// scm.categories columns: id text PK, label text, icon text, tbc bool,
// hero_image_key text, sort_order int, hero_focal_x/y real, hero_alt text.
// id is a URL-safe slug supplied at create time (it IS the FK target on
// product_models.category, so it has to be stable). Owner-only writes.

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
  const icon = trim200(body.icon) || 'package'; // safe lucide default
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

  // sort_order defaults to (max + 1) so a new category lands at the bottom.
  let finalSort = sortOrder;
  if (finalSort === null) {
    let topQ = supabase
      .from('categories')
      .select('sort_order')
      .order('sort_order', { ascending: false })
      .limit(1);
    topQ = scopeToCompany(topQ, c); // multi-company: max within the active company
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

  // Block accidental PATCH against the meta sub-route — that route lives
  // separately at /:id/hero-meta. A "label" / "icon" body here on /:id is a
  // category update; /:id/hero-meta handles focal + alt.
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

  // Multi-company: scope the write so a blind slug from another company matches
  // nothing (PGRST116 → not-found, not mutated).
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

/* Exported so the in-use guard below can be driven by a test — same reason
   mfg-products.ts exports deleteMfgProductHandler. */
export const deleteCategoryHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  /* `?? ''` only because this handler is exported (and so has no path generic
     to prove the param is present); the router only ever calls it on /:id. */
  const id = c.req.param('id') ?? '';

  // Pre-flight: product_models.category is an UPPERCASE Postgres enum
  // (SOFA / BEDFRAME / MATTRESS / ACCESSORY / SERVICE) while categories.id
  // is a lowercase slug ('sofa'), so the comparison has to upper-case the
  // slug to land on the enum value. A direct .eq(id) silently matches 0
  // rows for IDs that should be in use — the first version of this code
  // let a legitimate 'sofa' delete through against prod, see Task #7.
  // Slugs that don't correspond to an enum value ('kids', 'bathroom',
  // 'dining', any custom id created via POST) won't match anything; for
  // those the delete proceeds, which is the right semantics — they have
  // no FK protection because there's no enum binding.
  const enumValue = id.toUpperCase();
  const { data: refs, count, error: refsErr } = await scopeToCompany(
    supabase
      .from('product_models')
      .select('model_code', { count: 'exact' })
      .eq('category', enumValue),
    c,
  )
    .limit(9);
  /* `count ?? 0` used to fold a FAILED count into zero, and zero is precisely
     what lets the delete below run — the category would be dropped (and its R2
     hero blob with it) on a reference check that never happened. A failed read
     must never read as an absence when the absence is what authorises the
     write; see lib/downstream-lock.ts, which states the rule. */
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
      sample_models: (refs ?? []).map((r) => (r as { model_code: string }).model_code),
    }, 409);
  }

  // Also clean up R2 hero (if any) — DELETE on the row alone would leave a
  // stranded blob in PUBLIC_ASSETS. Scoped so a blind slug from another company
  // can neither read its hero nor delete its R2 object.
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

// PATCH /:id/hero-meta — focal + alt update. Admin-only.
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

  // Multi-company: scope the write; select reports whether a row in THIS
  // company was actually updated.
  const { data: upd, error } = await scopeToCompanyId(supabase.from('categories').update(patch).eq('id', id), co.companyId).select('id').maybeSingle();
  if (error) return c.json({ error: 'patch_failed', reason: error.message }, 500);
  if (!upd) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});
