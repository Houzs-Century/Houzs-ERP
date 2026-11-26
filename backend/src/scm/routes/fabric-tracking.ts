
import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { escapeForOr } from '../lib/postgrest-search';
import { activeCompanyId, scopeToCompany,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { readStatusCounts } from '../lib/status-counts';
import type { Env, Variables } from '../env';
import { seriesOf } from '../lib/fabric-series';

export const fabricTracking = new Hono<{ Bindings: Env; Variables: Variables }>();

fabricTracking.use('*', supabaseAuth);

const VALID_CATEGORIES = new Set(['B.M-FABR', 'S-FABR', 'S.M-FABR', 'LINING', 'WEBBING']);
const VALID_TIER_FIELDS = new Set(['sofaPriceTier', 'bedframePriceTier']);
const VALID_TIERS = new Set(['PRICE_1', 'PRICE_2', 'PRICE_3', 'PRICE_4']);
const BEDFRAME_TIERS = new Set(['PRICE_1', 'PRICE_2', 'PRICE_3']);

/* WHY A FABRIC WRITE PATH REFUSES A CODE AT ALL.

   A prod probe on 2026-08-13 found two rows in scm.fabric_trackings that are
   not fabrics — "SOFA 5535" described as "5535 (3+L)", and "SQUARE PILLOW"
   described as 'SQUARE PILLOW (16" X 16")'. Owner: 「为什么sofa 和square pillow
   在fabric convert里面？」.

   They were not typed here. Both are verbatim rows of backend/_hk.json, the
   153-row dump of the HOOKKA fabric master committed 2026-06-23 — same codes,
   same descriptions, same derived ids (SOFA_5535 / SQUARE_PILLOW, which is this
   file's own minting rule). Two AutoCount product items had been opened as
   "fabrics" in the source system, and the wholesale copy carried them across
   because nothing on this side looks at what a fabric code IS. Deleting the two
   rows does not close that: the same file, or any spreadsheet whose product
   column lands under `fabric_code`, puts them straight back.

   THE RULE IS THE CODE ONLY, AND ONLY AT ITS HEAD. Nine of those 153 genuine
   fabrics describe themselves as "SOFA FABRIC KOONA VELVET PEARL" — testing the
   DESCRIPTION would refuse every one of them, which is a far worse trade than
   two stray rows. The word list is the one in
   backend/scripts/probe-fabric-leftovers.mjs:43: it is what produced the
   owner's two rows off the live table, and it matches nothing else in the
   seeded catalogue (CG-/EZ-/BF-), the HOOKKA master, or the catalogue the owner
   dictated on 2026-08-11.

   REFUSING IS NOT DELETING. PATCH /:id/active and DELETE /:id are untouched, so
   the two rows already in the table stay fixable by the people who own them.
   The rows that were already there are retired by
   backend/scripts/retire-non-fabric-rows.mjs, which applies THIS rule (via
   scripts/lib/non-fabric-code.mjs, held identical to NON_FABRIC_HEAD by
   backend/tests/nonFabricCodeParity.test.ts) and refuses any row a live
   document still names. It deactivates and stamps; it never deletes. */
const NON_FABRIC_HEAD =
  /^(SOFA|SQUARE\s*PILLOW|LONG\s*PILLOW|BOLSTER|STOOL|CONSOLE|MATTRESS|BEDFRAME|DIVAN|DELIVERY|TRANSPORT|SERVICE|SVC)\b/i;

/** The product word a fabric code opens with, or null when it reads as a
 *  fabric. Exported for the guard's test. */
export function nonFabricCodeWord(code: string): string | null {
  const m = NON_FABRIC_HEAD.exec((code ?? '').trim());
  return m?.[1] ? m[1].toUpperCase().replace(/\s+/g, ' ') : null;
}

const TIER_FIELD_TO_COL: Record<string, string> = {
  sofaPriceTier: 'sofa_price_tier',
  bedframePriceTier: 'bedframe_price_tier',
};

const colourLabelOf = (code: string, description: string | null): string => {
  const desc = (description ?? '').trim();
  const sp = desc.indexOf(' ');
  return sp > 0 ? desc.slice(sp + 1).trim() : code;
};

async function syncFabricToSellingLibrary(
  sb: any,
  fabricCode: string,
  description: string | null,
  companyId: number | null,
): Promise<string | null> {
  const code = fabricCode.trim();
  if (!code) return null;
  const series = seriesOf(code);
  const companyCol = companyId != null ? { company_id: companyId } : {};
  const { error: serErr } = await sb.from('fabric_library').upsert(
    { ...companyCol, id: series, label: series, tier: 'standard', default_surcharge: 0, active: true, sort_order: 0 },
    { onConflict: 'id', ignoreDuplicates: true },
  );
  if (serErr) return `fabric_library: ${serErr.message}`;
  if (companyId != null) {
    const { data: owner, error: ownerErr } = await sb.from('fabric_library')
      .select('company_id').eq('id', series).maybeSingle();
    if (ownerErr) return `fabric_library: ${ownerErr.message}`;
    const ownerCo = (owner as { company_id?: number | null } | null)?.company_id;
    if (ownerCo != null && ownerCo !== companyId) {
      return `fabric_library: series "${series}" already belongs to another organisation. Fabric series ids are global (the id IS the series), so this import needs a distinct series code.`;
    }
  }
  const { error: colErr } = await sb.from('fabric_colours').upsert(
    { ...companyCol, fabric_id: series, colour_id: code, label: colourLabelOf(code, description), swatch_hex: null, active: true, sort_order: 0 },
    { onConflict: 'fabric_id,colour_id', ignoreDuplicates: true },
  );
  if (colErr) return `fabric_colours: ${colErr.message}`;
  if (companyId != null) {
    const { data: cOwner, error: cOwnerErr } = await sb.from('fabric_colours')
      .select('company_id').eq('fabric_id', series).eq('colour_id', code).maybeSingle();
    if (cOwnerErr) return `fabric_colours: ${cOwnerErr.message}`;
    const cCo = (cOwner as { company_id?: number | null } | null)?.company_id;
    if (cCo != null && cCo !== companyId) {
      return `fabric_colours: colour "${code}" under series "${series}" already belongs to another organisation. This pair is a global key, so the import needs a distinct code.`;
    }
  }
  return null;
}

fabricTracking.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const fabricCode = String(body.fabricCode ?? '').trim();
  if (!fabricCode) return c.json({ error: 'fabric_code_required' }, 400);

  const productWord = nonFabricCodeWord(fabricCode);
  if (productWord) {
    return c.json({
      error: 'non_fabric_code',
      reason: `“${fabricCode}” reads as a product, not a fabric — a fabric code cannot start with “${productWord}”. Open it in SKU Master instead.`,
    }, 400);
  }

  const cat = body.fabricCategory as string | undefined;
  if (cat && !VALID_CATEGORIES.has(cat)) return c.json({ error: 'invalid_category' }, 400);
  if (body.sofaPriceTier != null && !VALID_TIERS.has(body.sofaPriceTier as string)) {
    return c.json({ error: 'invalid_sofa_price_tier', allowed: [...VALID_TIERS] }, 400);
  }
  if (body.bedframePriceTier != null && !BEDFRAME_TIERS.has(body.bedframePriceTier as string)) {
    return c.json({ error: 'invalid_bedframe_price_tier', allowed: [...BEDFRAME_TIERS] }, 400);
  }

  const id = String(body.id ?? fabricCode.toUpperCase().replace(/\s+/g, '_'));

  const row: Record<string, unknown> = {
    id,
    fabric_code: fabricCode,
    fabric_description: (body.fabricDescription as string) ?? null,
    fabric_category: cat ?? null,
    sofa_price_tier: (body.sofaPriceTier as string) ?? null,
    bedframe_price_tier: (body.bedframePriceTier as string) ?? null,
    supplier_code: (body.supplierCode as string) ?? null,
    series: (body.series as string) ?? null,
    price_sen: typeof body.priceSen === 'number' ? body.priceSen : 0,
    is_active: typeof body.isActive === 'boolean' ? body.isActive : true,
  };

  const sb = c.get('supabase');
  const { data, error } = await sb.from('fabric_trackings').insert({ ...row, company_id: activeCompanyId(c) }).select('*').single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_code' }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  const libraryWarning = await syncFabricToSellingLibrary(sb, fabricCode, (body.fabricDescription as string) ?? null, activeCompanyId(c) ?? null);

  return c.json({ fabric: data, fabricSeries: seriesOf(fabricCode), libraryWarning }, 201);
});

fabricTracking.post('/bulk-upsert', async (c) => {
  let body: { rows?: unknown };
  try { body = (await c.req.json()) as typeof body; }
  catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!Array.isArray(body.rows)) return c.json({ error: 'rows_array_required' }, 400);
  if (body.rows.length === 0) return c.json({ upserted: 0, errors: [] });
  if (body.rows.length > 2000) return c.json({ error: 'too_many_rows', max: 2000 }, 413);

  const STRING_COLS: Array<[string, string]> = [
    ['fabricDescription',   'fabric_description'],
    ['supplierCode',        'supplier_code'],
    ['supplier',            'supplier'],
    ['sofaPriceTier',       'sofa_price_tier'],
    ['bedframePriceTier',   'bedframe_price_tier'],
    ['series',              'series'],
  ];
  const INT_COLS: Array<[string, string]> = [
    ['priceSen',              'price_sen'],
    ['sohSen',                'soh_sen'],
    ['poOutstandingSen',      'po_outstanding_sen'],
    ['lastMonthUsageSen',     'last_month_usage_sen'],
    ['oneWeekUsageSen',       'one_week_usage_sen'],
    ['twoWeeksUsageSen',      'two_weeks_usage_sen'],
    ['oneMonthUsageSen',      'one_month_usage_sen'],
    ['shortageSen',           'shortage_sen'],
    ['reorderPointSen',       'reorder_point_sen'],
    ['leadTimeDays',            'lead_time_days'],
  ];

  const errors: Array<{ index: number; reason: string }> = [];
  const dbRows: Array<Record<string, unknown>> = [];

  body.rows.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') { errors.push({ index: i, reason: 'not_object' }); return; }
    const r = raw as Record<string, unknown>;
    const code = typeof r.fabricCode === 'string' ? r.fabricCode.trim() : '';
    if (!code) { errors.push({ index: i, reason: 'missing_fabric_code' }); return; }
    if (nonFabricCodeWord(code)) { errors.push({ index: i, reason: 'non_fabric_code' }); return; }
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : code.toUpperCase().replace(/\s+/g, '_');

    const row: Record<string, unknown> = { id, fabric_code: code };

    for (const [k, col] of STRING_COLS) {
      if (k in r) {
        const v = r[k];
        row[col] = (v === '' || v == null) ? null : String(v);
      }
    }
    for (const col of ['sofa_price_tier', 'bedframe_price_tier']) {
      const v = row[col];
      const allowed = col === 'bedframe_price_tier' ? BEDFRAME_TIERS : VALID_TIERS;
      if (v != null && !allowed.has(v as string)) { errors.push({ index: i, reason: `invalid_${col}` }); return; }
    }
    let rowFailed = false;
    for (const [k, col] of INT_COLS) {
      if (k in r) {
        const v = r[k];
        if (v === '' || v == null) { row[col] = 0; continue; }
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n)) { errors.push({ index: i, reason: `invalid_${col}` }); rowFailed = true; break; }
        row[col] = Math.trunc(n);
      }
    }
    if (!rowFailed) dbRows.push(row);
  });

  if (dbRows.length === 0) return c.json({ upserted: 0, errors }, errors.length ? 400 : 200);

  const sb = c.get('supabase');
  const cid = activeCompanyId(c);
  const stampedRows = cid != null ? dbRows.map((r) => ({ ...r, company_id: cid })) : dbRows;
  /* THE FABRIC CODE IS NOW PER-COMPANY (mig 0342). fabric_trackings' identity is
     the composite PRIMARY KEY (company_id, id) — so the SAME code under two
     companies is two legitimately DIFFERENT rows, not a conflict. This upsert
     therefore targets ON CONFLICT (company_id, id): a re-import updates only THIS
     company's rows, and it can never reach, overwrite or re-home the other
     company's row of the same code.

     The old cross-company 409 guard (`fabric_id_belongs_to_another_company`) that
     stood here existed only because the id was a GLOBAL key — it stopped a bulk
     import from re-homing the other company's row. With the per-company key that
     hazard is gone at the schema level, so the guard is removed: a colliding code
     is now a normal, separate insert for the active company. See
     docs/bugs/0605-*.md and docs/modules/fabric-tracking.md. */
  const { error } = await sb.from('fabric_trackings').upsert(stampedRows, { onConflict: 'company_id,id' });
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message, errors }, 403);
    return c.json({ error: 'bulk_upsert_failed', reason: error.message, errors }, 500);
  }

  const mirrorCompanyCol = cid != null ? { company_id: cid } : {};
  const seriesRows = [...new Set(dbRows.map((r) => seriesOf(String(r.fabric_code))))]
    .map((s, i) => ({ ...mirrorCompanyCol, id: s, label: s, tier: 'standard', default_surcharge: 0, active: true, sort_order: (i + 1) * 10 }));
  const colourRows = dbRows.map((r) => {
    const code = String(r.fabric_code);
    return {
      ...mirrorCompanyCol,
      fabric_id: seriesOf(code), colour_id: code,
      label: colourLabelOf(code, typeof r.fabric_description === 'string' ? r.fabric_description : null),
      swatch_hex: null, active: true, sort_order: 0,
    };
  });
  await sb.from('fabric_library').upsert(seriesRows, { onConflict: 'id', ignoreDuplicates: true });
  await sb.from('fabric_colours').upsert(colourRows, { onConflict: 'fabric_id,colour_id', ignoreDuplicates: true });

  return c.json({ upserted: dbRows.length, errors });
});

fabricTracking.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data, error } = await scopeToCompanyId(sb.from('fabric_trackings').delete().eq('id', id), co.companyId).select('id').maybeSingle();
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    if (error.code === '23503') return c.json({ error: 'fabric_in_use', reason: 'Fabric is referenced by a product or PO; remove those links first.' }, 409);
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.body(null, 204);
});

fabricTracking.get('/', async (c) => {
  const category = c.req.query('category');
  const search = c.req.query('search');
  const supabase = c.get('supabase');

  let q = scopeToCompany(
    supabase
      .from('fabric_trackings')
      .select(
        'id, fabric_code, fabric_description, fabric_category, price_tier, ' +
          'sofa_price_tier, bedframe_price_tier, price_sen, soh_sen, ' +
          'po_outstanding_sen, last_month_usage_sen, one_week_usage_sen, ' +
          'two_weeks_usage_sen, one_month_usage_sen, shortage_sen, ' +
          'reorder_point_sen, supplier, supplier_code, lead_time_days, series, is_active',
      ),
    c,
  )
    .order('fabric_code', { ascending: true });

  if (category && VALID_CATEGORIES.has(category)) {
    q = q.eq('fabric_category', category);
  }
  if (search) {
    const s = escapeForOr(search);
    if (s) q = q.or(`fabric_code.ilike.%${s}%,fabric_description.ilike.%${s}%`);
  }

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ fabrics: data ?? [] });
});

fabricTracking.get('/lite', async (c) => {
  const category = c.req.query('category');
  const search = c.req.query('search');
  const supabase = c.get('supabase');

  let q = scopeToCompany(
    supabase
      .from('fabric_trackings')
      .select(
        'id, fabric_code, fabric_description, supplier_code, fabric_category, ' +
          'price_tier, sofa_price_tier, bedframe_price_tier, series, is_active',
      ),
    c,
  )
    .order('fabric_code', { ascending: true });

  if (category && VALID_CATEGORIES.has(category)) {
    q = q.eq('fabric_category', category);
  }
  if (search) {
    const s = escapeForOr(search);
    if (s) q = q.or(`fabric_code.ilike.%${s}%,fabric_description.ilike.%${s}%`);
  }

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ fabrics: data ?? [] });
});

fabricTracking.patch('/:id/active', async (c) => {
  const id = c.req.param('id');
  let body: { isActive?: unknown };
  try { body = (await c.req.json()) as typeof body; }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  if (typeof body.isActive !== 'boolean') {
    return c.json({ error: 'is_active_boolean_required' }, 400);
  }

  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data, error } = await scopeToCompanyId(supabase
    .from('fabric_trackings')
    .update({ is_active: body.isActive })
    .eq('id', id), co.companyId)
    .select('id').maybeSingle();

  if (error) {
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    if (/column .* does not exist/i.test(error.message)) {
      return c.json({ error: 'migration_pending', reason: 'Run migration 0167 against Supabase.' }, 500);
    }
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true, isActive: body.isActive });
});

fabricTracking.patch('/:id/series', async (c) => {
  const id = c.req.param('id');
  let body: { series?: string | null };
  try { body = (await c.req.json()) as typeof body; }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const trimmed = typeof body.series === 'string' ? body.series.trim() : null;
  const next = trimmed === '' ? null : trimmed;

  const { data, error } = await scopeToCompanyId(supabase
    .from('fabric_trackings')
    .update({ series: next })
    .eq('id', id), co.companyId)
    .select('id').maybeSingle();

  if (error) {
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    if (/column .* does not exist/i.test(error.message)) {
      return c.json({ error: 'migration_pending', reason: 'Run migration 0063 against Supabase.' }, 500);
    }
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true, series: next });
});

fabricTracking.patch('/:id/supplier-code', async (c) => {
  const id = c.req.param('id');
  let body: { supplierCode?: string | null };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const trimmed = typeof body.supplierCode === 'string' ? body.supplierCode.trim() : null;
  const next = trimmed === '' ? null : trimmed;

  const { data, error } = await scopeToCompanyId(supabase
    .from('fabric_trackings')
    .update({ supplier_code: next })
    .eq('id', id), co.companyId)
    .select('id').maybeSingle();

  if (error) {
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    if (/column .* does not exist/i.test(error.message)) {
      return c.json({ error: 'migration_pending', reason: 'Run migration 0046 against Supabase.' }, 500);
    }
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true, supplierCode: next });
});

/* PR #38 — Make fabric description editable from the Fabric Converter table.

   AND MAKE THE EDIT REACH THE PICKER (owner 2026-08-13: "Description 好像是直接
   可以更改。如果可以更改的话，到时候可以 save 得到吗？").

   It saved, and it did nothing. The description is the ONLY place a colour's
   NAME is written — colourLabelOf takes everything after the code — and the
   name a salesperson actually sees when picking fabric on an SO comes from the
   MIRRORED row in scm.fabric_colours, not from here. That mirror was written
   once, at create (:143) and at CSV import, and never again: the description
   PATCH did not touch it, and both mirror upserts carry
   `ignoreDuplicates: true`, so even re-running the sync would skip a colour
   that already exists.

   So the Converter showed the new text, every fabric picker kept the old one,
   and nothing reported a problem. That is the whole bug: an edit that appears
   to work and reaches nobody.

   The label is updated in place, scoped to the company and to the colour_id
   that IS this fabric's code. Best-effort and reported, never fatal: the cost
   ledger — the thing the operator was editing — has already been written, and
   a library hiccup must not turn a saved edit into an error. */
fabricTracking.patch('/:id/description', async (c) => {
  const id = c.req.param('id');
  let body: { description?: string | null };
  try { body = (await c.req.json()) as typeof body; }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const trimmed = typeof body.description === 'string' ? body.description.trim() : null;
  const next = trimmed === '' ? null : trimmed;

  const { data, error } = await scopeToCompanyId(supabase
    .from('fabric_trackings')
    .update({ fabric_description: next })
    .eq('id', id), co.companyId)
    .select('id, fabric_code').maybeSingle();

  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);

  const row = data as { id: string; fabric_code: string | null };
  const code = (row.fabric_code ?? '').trim();
  let pickerWarning: string | null = null;
  if (code) {
    const { error: mirrorErr } = await scopeToCompanyId(supabase
      .from('fabric_colours')
      .update({ label: colourLabelOf(code, next) })
      .eq('fabric_id', seriesOf(code))
      .eq('colour_id', code), co.companyId);
    if (mirrorErr) pickerWarning = `fabric_colours: ${mirrorErr.message}`;
  }

  return c.json({ ok: true, description: next, pickerLabel: code ? colourLabelOf(code, next) : null, ...(pickerWarning ? { pickerWarning } : {}) });
});

export const patchFabricTierHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const id = c.req.param('id');
  let body: { field?: string; tier?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  if (!body.field || !VALID_TIER_FIELDS.has(body.field)) {
    return c.json({ error: 'invalid_field', allowed: [...VALID_TIER_FIELDS] }, 400);
  }
  const allowedTiers = body.field === 'bedframePriceTier' ? BEDFRAME_TIERS : VALID_TIERS;
  if (!body.tier || !allowedTiers.has(body.tier)) {
    return c.json({ error: 'invalid_tier', allowed: [...allowedTiers] }, 400);
  }

  const col = TIER_FIELD_TO_COL[body.field]!;
  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: fabric } = await scopeToCompanyId(supabase
    .from('fabric_trackings')
    .select('fabric_code')
    .eq('id', id), co.companyId)
    .maybeSingle();
  if (!fabric) return c.json(NOT_THIS_COMPANY, 404);
  const fabricCode = (fabric as { fabric_code: string } | null)?.fabric_code ?? null;

  const updates: Record<string, string> = { [col]: body.tier };
  const { error } = await scopeToCompanyId(supabase.from('fabric_trackings').update(updates).eq('id', id), co.companyId);

  if (error) {
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }

  let affectedProducts: number | null = 0;
  if (fabricCode) {
    const targetCategories = body.field === 'bedframePriceTier'
      ? ['BEDFRAME']
      : ['SOFA', 'ACCESSORY'];
    const counted = readStatusCounts({
      affectedProducts: await scopeToCompany(
        supabase
          .from('mfg_products')
          .select('id', { head: true, count: 'exact' })
          .eq('fabric_color', fabricCode)
          .in('category', targetCategories),
        c,
      ),
    });
    if (counted.ok) {
      affectedProducts = counted.counts.affectedProducts;
    } else {
      console.error(`fabric tier propagation hint: ${counted.reason}`);
      affectedProducts = null;
    }
  }

  return c.json({ ok: true, affectedProducts, fabricCode });
};

fabricTracking.patch('/:id/tier', patchFabricTierHandler);
