// ----------------------------------------------------------------------------
// /fabric-tracking — fabric inventory + per-context price tiers.
//
// Ported (simplified) from HOOKKA src/api/routes/fabric-tracking.ts. The
// HOOKKA version live-aggregates SOH/PO/usage from raw_materials, cost_ledger
// and active FAB_CUT job_cards — none of which exist in 2990s yet. So this
// version reads the static fabric_trackings table directly. Metric columns
// (SOH, po_outstanding, usage windows, shortage) are whatever was snapshotted
// at seed time. Forward port: re-compute live when raw_materials lands.
//
// Endpoints:
//   GET   /fabric-tracking?category=B.M-FABR&search=avani
//   POST  /fabric-tracking                — create one (PR #43)
//         400 non_fabric_code when fabricCode opens with a product word.
//   POST  /fabric-tracking/bulk-upsert    — Commander 2026-05-26 Export/Import:
//         body: { rows: Array<{fabricCode, ... any column}> }
//         Per-column partial upsert by id (derived from fabricCode if missing).
//         A product-code row is rejected into `errors` and skipped; the rest
//         of the import still lands. See NON_FABRIC_HEAD below for why.
//   DELETE /fabric-tracking/:id           — delete one (PR #43)
//   PATCH /fabric-tracking/:id/tier
//         body: { field: 'sofaPriceTier' | 'bedframePriceTier', tier: 'PRICE_1'|'PRICE_2'|'PRICE_3' }
//   PATCH /fabric-tracking/:id/supplier-code
//   PATCH /fabric-tracking/:id/description
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { escapeForOr } from '../lib/postgrest-search';
import { activeCompanyId, scopeToCompany,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { readStatusCounts } from '../lib/status-counts';
import type { Env, Variables } from '../env';

export const fabricTracking = new Hono<{ Bindings: Env; Variables: Variables }>();

fabricTracking.use('*', supabaseAuth);

const VALID_CATEGORIES = new Set(['B.M-FABR', 'S-FABR', 'S.M-FABR', 'LINING', 'WEBBING']);
const VALID_TIER_FIELDS = new Set(['sofaPriceTier', 'bedframePriceTier']);
const VALID_TIERS = new Set(['PRICE_1', 'PRICE_2', 'PRICE_3']);

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

// Map JS camelCase tier field → Postgres snake_case column.
const TIER_FIELD_TO_COL: Record<string, string> = {
  sofaPriceTier: 'sofa_price_tier',
  bedframePriceTier: 'bedframe_price_tier',
};

/* Chairman 2026-06-01 — the POS SELLING fabric library (fabric_library +
   fabric_colours) is a SERIES / COLOUR projection of this cost ledger:
     • series  = the fabric_code prefix before the first '-'  (BF-01 → 'BF')
     • colour  = the fabric_code itself, labelled with the colour name after the
                 code in the description ("CG-002 Sand" → "Sand"), else the code.
   So a Backend-added (or imported) fabric is immediately pickable on POS.

   INSERT-only (ignoreDuplicates): RLS (migration 0125) lets the editor set
   INSERT fabric_library/fabric_colours but not UPDATE/DELETE — so we never
   clobber a Master-Admin selling-tier edit, and re-syncing an existing fabric
   is a no-op instead of a 403/permission error. Selling tiers stay POS-only. */
/* The series is everything BEFORE the trailing colour number, not everything
   before the first dash. "AM275-02" -> AM275 either way, but "SF-AT-01" is
   SF-AT and "ALPINE-5311-13" is ALPINE-5311; splitting on the first dash calls
   them SF and ALPINE and mirrors the colour into the wrong series. Matches how
   normalize-fabric-codes.mjs derives it, so a fabric created here and a fabric
   normalised there land in the same place. */
const seriesOf = (code: string): string => {
  const v = (code || '').trim().toUpperCase();
  const m = /^(.+)[\s-]+\d{1,3}$/.exec(v);
  const head = (m ? m[1] : v.split('-')[0]) || v;
  return head.replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || v;
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
  /* Multi-company (mig 0089): stamp the active company on the mirrored selling
     rows. null/undefined (unresolved) inserts without the column — same no-op
     rule as companyScope. */
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
  /* `ignoreDuplicates` is right — re-running an import must not stamp over a
     series someone already curated. But 0089 records that fabric_library's PK is
     the SERIES TEXT and is GLOBAL: it "can't gain company_id without a PK
     redesign, so a 2990 import must use ids distinct from Houzs's". When the id
     IS taken by another organisation, DO NOTHING means the caller's row never
     lands, reads are company-scoped so it never appears, and NOTHING SAYS SO.
     Naming it is the whole fix: the row genuinely cannot be written until the PK
     is redesigned, so the honest outcome is to report, not to invent one. */
  if (companyId != null) {
    const { data: owner, error: ownerErr } = await sb.from('fabric_library')
      .select('company_id').eq('id', series).maybeSingle();
    if (ownerErr) return `fabric_library: ${ownerErr.message}`;  // fail closed — a blind read here would re-home the row
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
  /* Same shape as the series below: composite PK (fabric_id, colour_id), also
     named in 0089 as un-convertible, also DO NOTHING, also silent. */
  if (companyId != null) {
    const { data: cOwner, error: cOwnerErr } = await sb.from('fabric_colours')
      .select('company_id').eq('fabric_id', series).eq('colour_id', code).maybeSingle();
    if (cOwnerErr) return `fabric_colours: ${cOwnerErr.message}`;  // fail closed — see the series read above
    const cCo = (cOwner as { company_id?: number | null } | null)?.company_id;
    if (cCo != null && cCo !== companyId) {
      return `fabric_colours: colour "${code}" under series "${series}" already belongs to another organisation. This pair is a global key, so the import needs a distinct code.`;
    }
  }
  return null;
}

/* PR #43 — Create new fabric. Commander 2026-05-26: Fabric Converter
   was missing the "+ New Fabric" capability. */
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

  // id is text PK — use the fabric_code (uppercased) as the id by convention.
  // Allow caller to override via explicit `id`.
  const id = String(body.id ?? fabricCode.toUpperCase().replace(/\s+/g, '_'));

  const row: Record<string, unknown> = {
    id,
    fabric_code: fabricCode,
    fabric_description: (body.fabricDescription as string) ?? null,
    fabric_category: cat ?? null,
    sofa_price_tier: (body.sofaPriceTier as string) ?? null,
    bedframe_price_tier: (body.bedframePriceTier as string) ?? null,
    supplier_code: (body.supplierCode as string) ?? null,
    /* Migration 0063 — collection name. */
    series: (body.series as string) ?? null,
    price_sen: typeof body.priceSen === 'number' ? body.priceSen : 0,
    /* Migration 0167 — ACTIVE toggle; new fabrics default true. */
    is_active: typeof body.isActive === 'boolean' ? body.isActive : true,
  };

  const sb = c.get('supabase');
  const { data, error } = await sb.from('fabric_trackings').insert({ ...row, company_id: activeCompanyId(c) }).select('*').single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_code' }, 409);
    /* DEAD BRANCH -- here and at EVERY other 42501 site in this file. 42501 is
       Postgres permission-denied, i.e. RLS, and RLS cannot fire on this path: mig
       0061 enabled RLS on every scm table with NO policies, and the SCM client is
       the SERVICE-ROLE client (scm/middleware/auth.ts:93 -> db/supabase.ts
       getSupabaseService), which bypasses RLS by design. No scm function RAISEs
       42501 either -- the live tree's only ERRCODE is 22023. Do NOT read this as a
       permission check and do NOT treat it as scoping: the only boundary is this
       route's own predicate. (docs/audit-2026-08-13-ledger.md K1) */
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  // Mirror into the customer-pickable selling library (series + colour) so the
  // new fabric is immediately pickable on POS. The procurement row above is
  // already saved; surface any library failure as a warning so the operator can
  // retry without losing the fabric.
  const libraryWarning = await syncFabricToSellingLibrary(sb, fabricCode, (body.fabricDescription as string) ?? null, activeCompanyId(c) ?? null);

  return c.json({ fabric: data, fabricSeries: seriesOf(fabricCode), libraryWarning }, 201);
});

/* Commander 2026-05-26 — Bulk upsert from CSV import. One Postgres upsert
   (INSERT ... ON CONFLICT (id) DO UPDATE) instead of N HTTP round-trips.

   Per-column merge semantics: only columns explicitly present in each row
   object are written. Missing columns keep their existing DB value on update,
   or take the schema default on insert. This lets the CSV stay narrow when a
   caller only wants to touch a few fields.

   `id` is derived from `fabricCode` (uppercased, spaces → underscores) when
   not provided — matches the single-row POST convention. */
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
    /* Per-row, like every other rejection here: an import that carries one
       product line still lands its real fabrics, and the count comes back so
       the operator can see something was refused. */
    if (nonFabricCodeWord(code)) { errors.push({ index: i, reason: 'non_fabric_code' }); return; }
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : code.toUpperCase().replace(/\s+/g, '_');

    const row: Record<string, unknown> = { id, fabric_code: code };

    for (const [k, col] of STRING_COLS) {
      if (k in r) {
        const v = r[k];
        row[col] = (v === '' || v == null) ? null : String(v);
      }
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
  // Multi-company (mig 0061): stamp the active company on each upserted row.
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

  // Mirror the imported cost fabrics into the SELLING library (series + colour),
  // batched + INSERT-only (RLS-safe, never clobbers a Master-Admin tier edit).
  // Best-effort: the procurement upsert already succeeded, so a library hiccup
  // must not fail the import.
  // Multi-company (mig 0089): mirror rows carry the same active company as the
  // procurement upsert above (cid from stampedRows).
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

/* PR #43 — Delete fabric. */
fabricTracking.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const sb = c.get('supabase');
  // Multi-company: scope the delete; select reports whether a row in THIS
  // company was actually removed (a blind id from another company is not found).
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

/* GET /fabric-tracking/lite — the DISPLAY/PICK read.
 *
 * WHY THIS EXISTS (bug 2026-08-20). The full GET above returns procurement COST
 * and STOCK (price_sen, soh_sen, *_usage_sen, shortage_sen, reorder_point_sen,
 * supplier cost), so its guard correctly requires scm.procurement.products. But
 * SoLineCard (the fabric dropdown on EVERY sales-order line) and the PC-Order
 * detail need only the fabric NAME + PRICE TIERS to pick a fabric and price the
 * line — and their pages are gated on scm.sales.* / scm.consignment.*, NOT
 * products. So a salesperson/consignment user fired the full read and got a 403
 * (surfaced by the client-error telemetry: [rbac 403] GET /fabric-tracking),
 * leaving the fabric dropdown empty.
 *
 * This lite read returns ONLY the non-sensitive display + tier fields, so it is
 * safe to expose via openReadPaths on the guard (see scm/index.ts). Cost/stock
 * NEVER appear here, so opening it leaks nothing; the full read stays gated.
 * Still company-scoped, exactly like the full read. */
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

/* Migration 0167 — ACTIVE toggle from the Fabric Converter table (owner spec
   2026-06-12). Inactive fabrics are hidden from NEW-entry fabric pickers
   (SO/CO variant selects, scan-SO catalog injection); existing documents keep
   displaying the code, and the converter still lists the row. */
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

/* Migration 0063 — Inline-edit Series cell from the Fabric Converter table. */
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

// Set the supplier's own code for this fabric (what we print on POs sent to
// the supplier). Single supplier per fabric — multi-supplier still goes
// through supplier_material_bindings.
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

  /* fabric_code comes back so the mirror can be aimed at the right colour
     without a second read — the row was just proven to be this company's. The
     .select().maybeSingle() stays OUTSIDE scopeToCompanyId, the shape every
     other handler in this file uses. */
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

/* Exported so the failed-count path has a test: the router below mounts this,
   and a test mounts it on a bare Hono with a fake supabase. trips.ts's
   patchTripHandler et al. take `c: any`; this one takes the router's OWN
   context type instead, because an extracted handler that widens to `any` pays
   for its test with the type safety the inline handler had. */
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
  if (!body.tier || !VALID_TIERS.has(body.tier)) {
    return c.json({ error: 'invalid_tier', allowed: [...VALID_TIERS] }, 400);
  }

  const col = TIER_FIELD_TO_COL[body.field]!;
  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  // Load the fabric code before update so we can count affected products
  // tagged with this fabric_color. This gives the UI a "propagation hint"
  // — N products now use the new tier when their price is read.
  // Multi-company: scoped so a blind id from another company is not found and
  // the tier write below can never re-price the other company's fabric.
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

  // Count downstream products. Sofa tier change affects SOFA + ACCESSORY
  // SKUs (HOOKKA convention); bedframe tier change only affects BEDFRAME.
  //
  // `count ?? 0` here was the same bug this branch fixed on the six list
  // endpoints, and it was first filed as a different class on the grounds that
  // it decides nothing. It decides nothing — but it is REPORTED, as
  // `affectedProducts`, and the frontend prints it as a sentence ("N sofa
  // products now reflect the new tier"). A count that could not be read is not
  // zero, and zero here is the reading that makes the operator do nothing.
  //
  // It cannot 500: the tier UPDATE above has already committed, so failing the
  // request would tell the operator their change did not land. The count is
  // served as null — unknown, and the caller says so — while ok stays true.
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
