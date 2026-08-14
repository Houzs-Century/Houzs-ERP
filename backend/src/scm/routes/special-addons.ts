// /special-addons — Special Add-ons CRUD (Chairman 2026-06-02). Read by any
// staff (POS configurator + Modular need it); written by admin/super_admin/
// coordinator/sales_director (server check + RLS, migration 0133).
//
// A special add-on = a per-Model product add-on priced on top of the product
// (selling surcharge + 0..N follow-up choice groups), shown as an SO line
// description — NOT a SKU. `code` is the stable key reused by the per-Model gate
// (allowed_options.specials) + the SO line (variants.specials). Pricing itself is
// enforced server-side in mfg-sales-orders (later PR); this route is just the
// master editor backing the "Special Add-ons" tab.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { todayMyt } from '../lib/my-time';
import { activeCompanyId, scopeToCompany,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import type { Env, Variables } from '../env';

type AppCtx = Context<{ Bindings: Env; Variables: Variables }>;

export const specialAddons = new Hono<{ Bindings: Env; Variables: Variables }>();

specialAddons.use('*', supabaseAuth);

// Houzs-flavoured: gate via canWriteScmConfig (flat `scm.config.write` OR the position policy canWriteConfig flag, see houzs-perms.ts) against
// the REAL caller (the 2990 staff_role lookup is dead in Houzs — the SCM
// bridge pins every caller to one super_admin row).

const CATEGORY = z.enum(['SOFA', 'BEDFRAME', 'ACCESSORY', 'MATTRESS', 'SERVICE']);

// A single pickable choice inside a follow-up question. extraSen may be negative
// (a deduction) — matches the table's no-CHECK-on-sign design (Chairman C).
const choiceSchema = z.object({
  label:    z.string().min(1),
  extraSen: z.number().int().default(0),
});
// One follow-up question (e.g. "Thickness" → 10" / 8"). 0..N per add-on.
const groupSchema = z.object({
  label:    z.string().min(1),
  required: z.boolean().default(true),
  choices:  z.array(choiceSchema).min(1),
});

const createSchema = z.object({
  code:            z.string().min(1),
  label:           z.string().min(1),
  soDescription:   z.string().default(''),
  categories:      z.array(CATEGORY).default([]),
  sellingPriceSen: z.number().int().default(0),   // may be negative
  costPriceSen:    z.number().int().default(0),    // may be negative
  optionGroups:    z.array(groupSchema).default([]),
  active:          z.boolean().default(true),
  sortOrder:       z.number().int().default(0),
});
const patchSchema = createSchema.partial();

type OptionGroup = z.infer<typeof groupSchema>;

type AddonRow = {
  id: string;
  code: string;
  label: string;
  so_description: string;
  categories: string[] | null;
  selling_price_sen: number;
  cost_price_sen: number;
  option_groups: OptionGroup[] | null;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

const toApi = (r: AddonRow) => ({
  id:              r.id,
  code:            r.code,
  label:           r.label,
  soDescription:   r.so_description,
  categories:      r.categories ?? [],
  sellingPriceSen: r.selling_price_sen,
  costPriceSen:    r.cost_price_sen,
  optionGroups:    r.option_groups ?? [],
  active:          r.active,
  sortOrder:       r.sort_order,
  createdAt:       r.created_at,
  updatedAt:       r.updated_at,
});

const SELECT =
  'id, code, label, so_description, categories, selling_price_sen, cost_price_sen, option_groups, active, sort_order, created_at, updated_at';

// Editors-only guard — Houzs flat-key permission.
async function requireWrite(c: AppCtx) {
  if (!canWriteScmConfig(c)) {
    return { ok: false as const, res: c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403) };
  }
  const u = c.get('user');
  if (!u?.id) return { ok: false as const, res: c.json({ error: 'auth_required' }, 401) };
  const userId = u.id;
  return { ok: true as const, userId };
}

// GET — every authenticated staff role can read, cost_price_sen included.
//
// NOT finance-gated, and that is CORRECT — do not "fix" this. Audited
// 2026-07-16 against the assumption that it leaks cost to a non-finance caller:
//   1. It carries no information the same payload does not already give away.
//      Owner ruling 2026-06-22 ("ONE price"): a special add-on has a SINGLE
//      price, and the editor writes that one number to BOTH selling_price_sen
//      and cost_price_sen (SpecialAddonsTab.withSyncedPrice, mirrored by
//      Products.tsx). cost_price_sen IS selling_price_sen, and the selling
//      surcharge is what the customer reads off their own SO line.
//   2. The SO costing does NOT need it client-side, so a strip would not break
//      pricing: mfg-pricing-recompute.loadSpecialAddons(sb) reads the column
//      server-side and buildSpecialsPoolFromAddons prices from that.
//   3. A strip WOULD break the master editor, which round-trips the row
//      (SpecialAddonsTab duplicate-row posts costPriceSen back), and would then
//      DESYNC the two columns — re-creating precisely the divergence the
//      ONE-price ruling exists to prevent.
// THE LIMIT, stated so the next reader can re-check rather than re-derive: the
// equality is an EDITOR convention, not a schema invariant — patchSchema still
// accepts the two prices independently, so a non-Houzs writer (the un-repointed
// 2990 POS/admin app) could diverge them. If they ever diverge, cost_price_sen
// becomes real finance data and this verdict flips: gate it then, and sync or
// drop the column here in the same change.
specialAddons.get('/', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await scopeToCompany(
    supabase.from('special_addons').select(SELECT),
    c,
  )
    // sort_order is the MANUAL position and stays the higher rule (owner
    // 2026-08-12). Alphabetical is the tie-break, not a replacement: rows the
    // owner has not deliberately positioned share a sort_order and were
    // previously left in insertion order, which is what made the list unreadable.
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ addons: (data as AddonRow[]).map(toApi) });
});

// POST — create. Editors only. 23505 (unique code) → 409.
specialAddons.post('/', async (c) => {
  const gate = await requireWrite(c);
  if (!gate.ok) return gate.res;

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }

  const supabase = c.get('supabase');
  const { data, error } = await supabase
    .from('special_addons')
    .insert({
      company_id:        activeCompanyId(c),
      code:              parsed.data.code,
      label:             parsed.data.label,
      so_description:    parsed.data.soDescription,
      categories:        parsed.data.categories,
      selling_price_sen: parsed.data.sellingPriceSen,
      cost_price_sen:    parsed.data.costPriceSen,
      option_groups:     parsed.data.optionGroups,
      active:            parsed.data.active,
      sort_order:        parsed.data.sortOrder,
      created_by:        gate.userId,
    })
    .select(SELECT)
    .single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_code', reason: 'a special add-on with this code already exists' }, 409);
    return c.json({ error: 'create_failed', reason: error.message }, 500);
  }
  return c.json({ addon: toApi(data as AddonRow) }, 201);
});

// PATCH /:id — update. Editors only.
specialAddons.patch('/:id', async (c) => {
  const gate = await requireWrite(c);
  if (!gate.ok) return gate.res;
  const id = c.req.param('id');

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.code            !== undefined) patch.code              = parsed.data.code;
  if (parsed.data.label           !== undefined) patch.label             = parsed.data.label;
  if (parsed.data.soDescription   !== undefined) patch.so_description    = parsed.data.soDescription;
  if (parsed.data.categories      !== undefined) patch.categories        = parsed.data.categories;
  if (parsed.data.sellingPriceSen !== undefined) patch.selling_price_sen = parsed.data.sellingPriceSen;
  if (parsed.data.costPriceSen    !== undefined) patch.cost_price_sen    = parsed.data.costPriceSen;
  if (parsed.data.optionGroups    !== undefined) patch.option_groups     = parsed.data.optionGroups;
  if (parsed.data.active          !== undefined) patch.active            = parsed.data.active;
  if (parsed.data.sortOrder       !== undefined) patch.sort_order        = parsed.data.sortOrder;

  const supabase = c.get('supabase');
  // Multi-company: scope the write to the active company so a blind id from
  // another company matches nothing (reported as not-found, not mutated).
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data, error } = await scopeToCompanyId(supabase.from('special_addons').update(patch).eq('id', id), co.companyId).select(SELECT).maybeSingle();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_code', reason: 'a special add-on with this code already exists' }, 409);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ addon: toApi(data as AddonRow) });
});

// DELETE /:id — editors only.
specialAddons.delete('/:id', async (c) => {
  const gate = await requireWrite(c);
  if (!gate.ok) return gate.res;
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  // Multi-company: scope the delete; select reports whether a row in THIS
  // company was actually removed.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data, error } = await scopeToCompanyId(supabase.from('special_addons').delete().eq('id', id), co.companyId).select('id').maybeSingle();
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════
// Effective-dated history (owner 2026-06-22) — gives the Specials / Sofa
// Specials Maintenance tabs TRUE Edit -> Save(effective-date) + History, the
// same mechanism the other Maintenance pools get via maintenance_config_history.
//
// A Save snapshots the WHOLE add-on set into special_addons_history at an
// effective_from date (audit + version log), then APPLIES that snapshot onto the
// live special_addons table (upsert by code; codes omitted from the snapshot are
// deactivated, never deleted, so existing orders keep resolving). SO costing is
// UNCHANGED — it reads the live special_addons table via loadSpecialAddons.
// ════════════════════════════════════════════════════════════════════════

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const todayIso = () => todayMyt();

function genHistId(): string {
  const rnd = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `sah-${rnd}`;
}

// One snapshot entry = the full API shape of an add-on, so the history blob is a
// self-contained record of the set at that effective date (mirrors the maintenance
// config blob). soDescription/sortOrder default like the table columns.
const snapshotEntrySchema = z.object({
  code:            z.string().min(1),
  label:           z.string().min(1),
  soDescription:   z.string().default(''),
  categories:      z.array(CATEGORY).default([]),
  sellingPriceSen: z.number().int().default(0),
  costPriceSen:    z.number().int().default(0),
  optionGroups:    z.array(groupSchema).default([]),
  active:          z.boolean().default(true),
  sortOrder:       z.number().int().default(0),
});

const saveSchema = z.object({
  effectiveFrom: z.string().regex(ISO_DATE, 'YYYY-MM-DD'),
  notes:         z.string().optional(),
  addons:        z.array(snapshotEntrySchema),
});

type HistoryRow = {
  id: string;
  addons: unknown;
  effective_from: string;
  notes: string | null;
  created_at: string;
  created_by: string | null;
};

// GET /history — full append-only version log. Each row carries isPending so the
// UI can colour future-effective snapshots (same convention as maintenance-config).
specialAddons.get('/history', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await scopeToCompany(
    supabase
      .from('special_addons_history')
      .select('id, addons, effective_from, notes, created_at, created_by'),
    c,
  )
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const today = todayIso();
  const history = ((data as HistoryRow[]) ?? []).map((r) => ({
    id:            r.id,
    addons:        Array.isArray(r.addons) ? r.addons : [],
    effectiveFrom: r.effective_from,
    notes:         r.notes ?? '',
    createdAt:     r.created_at,
    createdBy:     r.created_by,
    isPending:     r.effective_from > today,
  }));
  return c.json({ history });
});

// POST /save — append an effective-dated snapshot + apply it onto the live table.
// Editors only.
specialAddons.post('/save', async (c) => {
  const gate = await requireWrite(c);
  if (!gate.ok) return gate.res;

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }
  const { effectiveFrom, notes, addons } = parsed.data;

  // Guard duplicate codes inside one save (the unique constraint would catch it
  // on apply, but a clear 400 beats a half-applied upsert).
  const codes = addons.map((a) => a.code);
  if (new Set(codes).size !== codes.length) {
    return c.json({ error: 'duplicate_code', reason: 'the same add-on code appears twice in this save' }, 400);
  }

  const supabase = c.get('supabase');
  const userId = gate.userId;

  // The apply step below upserts ON CONFLICT (company_id, code) — the constraint
  // migration 0087 put there. An unresolved company would send company_id NULL,
  // which never conflicts, so every save would INSERT a second copy of every
  // add-on instead of updating it. Refuse instead, matching PATCH and DELETE.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  // 1) Append the version-log snapshot (audit + apply-source).
  const histId = genHistId();
  const { data: hist, error: histErr } = await supabase
    .from('special_addons_history')
    .insert({ company_id: co.companyId, id: histId, addons, effective_from: effectiveFrom, notes: notes ?? null, created_by: userId })
    .select('id, addons, effective_from, notes, created_at')
    .single();
  if (histErr) return c.json({ error: 'history_insert_failed', reason: histErr.message }, 500);

  // 2) Apply the snapshot onto the LIVE special_addons table (what SO costing
  //    reads). Upsert by code; codes NOT in the snapshot are deactivated (never
  //    deleted) so existing orders keep resolving the value.
  const nowIso = new Date().toISOString();
  const cid = activeCompanyId(c);
  const upsertRows = addons.map((a) => ({
    ...(cid != null ? { company_id: cid } : {}),
    code:              a.code,
    label:             a.label,
    so_description:    a.soDescription,
    categories:        a.categories,
    selling_price_sen: a.sellingPriceSen,
    cost_price_sen:    a.costPriceSen,
    option_groups:     a.optionGroups,
    active:            a.active,
    sort_order:        a.sortOrder,
    created_by:        userId,
    updated_at:        nowIso,
  }));
  if (upsertRows.length > 0) {
    const { error: upErr } = await supabase
      .from('special_addons')
      // 0087 dropped special_addons_code_unique and added
      // special_addons_company_code_unique UNIQUE (company_id, code). ON CONFLICT
      // must name the constraint that EXISTS or Postgres raises 42P10, which is
      // what made every Save return 500.
      .upsert(upsertRows, { onConflict: 'company_id,code' });
    if (upErr) {
      /* DEAD BRANCH -- here and at EVERY other 42501 site in this file. 42501 is
         Postgres permission-denied, i.e. RLS, and RLS cannot fire on this path: mig
         0061 enabled RLS on every scm table with NO policies, and the SCM client is
         the SERVICE-ROLE client (scm/middleware/auth.ts:93 -> db/supabase.ts
         getSupabaseService), which bypasses RLS by design. No scm function RAISEs
         42501 either -- the live tree's only ERRCODE is 22023. Do NOT read this as a
         permission check and do NOT treat it as scoping: the only boundary is this
         route's own predicate. (docs/audit-2026-08-13-ledger.md K1) */
      if (upErr.code === '42501' || /permission denied/i.test(upErr.message)) {
        return c.json({ error: 'forbidden', reason: upErr.message }, 403);
      }
      return c.json({ error: 'apply_failed', reason: upErr.message }, 500);
    }
  }
  // Deactivate any live code the snapshot dropped (retire, don't delete).
  {
    const { data: live, error: liveErr } = await scopeToCompany(supabase.from('special_addons').select('id, code'), c);
    if (liveErr) return c.json({ error: 'apply_failed', reason: liveErr.message }, 500);
    const keep = new Set(codes);
    const retireIds = ((live as Array<{ id: string; code: string }>) ?? [])
      .filter((r) => !keep.has(r.code))
      .map((r) => r.id);
    if (retireIds.length > 0) {
      const { error: retErr } = await supabase
        .from('special_addons')
        .update({ active: false, updated_at: nowIso })
        .in('id', retireIds);
      if (retErr) return c.json({ error: 'apply_failed', reason: retErr.message }, 500);
    }
  }

  return c.json(
    {
      id:            hist.id,
      addons:        Array.isArray(hist.addons) ? hist.addons : [],
      effectiveFrom: hist.effective_from,
      notes:         hist.notes ?? '',
    },
    201,
  );
});
