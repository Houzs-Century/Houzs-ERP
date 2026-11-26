import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { todayMyt } from '../lib/my-time';
import { activeCompanyId, scopeToCompany,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { compartmentPricesFromRow } from '../lib/mfg-pricing-recompute';
import { normalizeCompartmentCode } from '../shared/sofa-build';
import type { Env, Variables } from '../env';

type AppCtx = Context<{ Bindings: Env; Variables: Variables }>;

export const specialAddons = new Hono<{ Bindings: Env; Variables: Variables }>();

specialAddons.use('*', supabaseAuth);


const CATEGORY = z.enum(['SOFA', 'BEDFRAME', 'ACCESSORY', 'MATTRESS', 'SERVICE']);

const choiceSchema = z.object({
  label:    z.string().min(1),
  extraSen: z.number().int().default(0),
});
const groupSchema = z.object({
  label:    z.string().min(1),
  required: z.boolean().default(true),
  choices:  z.array(choiceSchema).min(1),
});

// "Detect by compartment" (2990 owner 2026-10-26): the add-on's SELLING price on
// a sofa that carries this compartment — the highest wins when several match
// (shared specialAddonBaseSellingSen). Codes are stored canonical, because the
// pricing compares them exactly; one price per compartment.
const compartmentPricesSchema = z.array(z.object({
  compartment:     z.string().trim().min(1).transform((code) => normalizeCompartmentCode(code)),
  sellingPriceSen: z.number().int(),
})).refine(
  (rows) => new Set(rows.map((r) => r.compartment)).size === rows.length,
  { message: 'each compartment can have one price only' },
);

const createSchema = z.object({
  code:              z.string().min(1),
  label:             z.string().min(1),
  soDescription:     z.string().default(''),
  categories:        z.array(CATEGORY).default([]),
  sellingPriceSen:   z.number().int().default(0),
  costPriceSen:      z.number().int().default(0),
  optionGroups:      z.array(groupSchema).default([]),
  compartmentPrices: compartmentPricesSchema.default([]),
  active:            z.boolean().default(true),
  sortOrder:         z.number().int().default(0),
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
  compartment_prices: unknown;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

const toApi = (r: AddonRow) => ({
  id:                r.id,
  code:              r.code,
  label:             r.label,
  soDescription:     r.so_description,
  categories:        r.categories ?? [],
  sellingPriceSen:   r.selling_price_sen,
  costPriceSen:      r.cost_price_sen,
  optionGroups:      r.option_groups ?? [],
  compartmentPrices: compartmentPricesFromRow(r.compartment_prices),
  active:            r.active,
  sortOrder:         r.sort_order,
  createdAt:         r.created_at,
  updatedAt:         r.updated_at,
});

const SELECT =
  'id, code, label, so_description, categories, selling_price_sen, cost_price_sen, option_groups, compartment_prices, active, sort_order, created_at, updated_at';

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
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ addons: (data as AddonRow[]).map(toApi) });
});

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
      compartment_prices: parsed.data.compartmentPrices,
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
  if (parsed.data.compartmentPrices !== undefined) patch.compartment_prices = parsed.data.compartmentPrices;
  if (parsed.data.active          !== undefined) patch.active            = parsed.data.active;
  if (parsed.data.sortOrder       !== undefined) patch.sort_order        = parsed.data.sortOrder;

  const supabase = c.get('supabase');
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

specialAddons.delete('/:id', async (c) => {
  const gate = await requireWrite(c);
  if (!gate.ok) return gate.res;
  const id = c.req.param('id');
  const supabase = c.get('supabase');
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

const snapshotEntrySchema = z.object({
  code:            z.string().min(1),
  label:           z.string().min(1),
  soDescription:   z.string().default(''),
  categories:      z.array(CATEGORY).default([]),
  sellingPriceSen: z.number().int().default(0),
  costPriceSen:    z.number().int().default(0),
  optionGroups:    z.array(groupSchema).default([]),
  compartmentPrices: compartmentPricesSchema.optional(),
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

  const codes = addons.map((a) => a.code);
  if (new Set(codes).size !== codes.length) {
    return c.json({ error: 'duplicate_code', reason: 'the same add-on code appears twice in this save' }, 400);
  }

  const supabase = c.get('supabase');
  const userId = gate.userId;

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  let fullAddons = addons;
  if (addons.some((a) => a.compartmentPrices === undefined)) {
    const { data: liveRows, error: liveReadErr } = await scopeToCompanyId(
      supabase.from('special_addons').select('code, compartment_prices'), co.companyId);
    if (liveReadErr) return c.json({ error: 'apply_failed', reason: liveReadErr.message }, 500);
    const liveByCode = new Map(((liveRows as Array<{ code: string; compartment_prices: unknown }> | null) ?? [])
      .map((r) => [r.code, compartmentPricesFromRow(r.compartment_prices)]));
    fullAddons = addons.map((a) => ({ ...a, compartmentPrices: a.compartmentPrices ?? liveByCode.get(a.code) ?? [] }));
  }

  const histId = genHistId();
  const { data: hist, error: histErr } = await supabase
    .from('special_addons_history')
    .insert({ company_id: co.companyId, id: histId, addons: fullAddons, effective_from: effectiveFrom, notes: notes ?? null, created_by: userId })
    .select('id, addons, effective_from, notes, created_at')
    .single();
  if (histErr) return c.json({ error: 'history_insert_failed', reason: histErr.message }, 500);

  const nowIso = new Date().toISOString();
  const cid = activeCompanyId(c);
  const upsertRows = fullAddons.map((a) => ({
    ...(cid != null ? { company_id: cid } : {}),
    code:              a.code,
    label:             a.label,
    so_description:    a.soDescription,
    categories:        a.categories,
    selling_price_sen: a.sellingPriceSen,
    cost_price_sen:    a.costPriceSen,
    option_groups:     a.optionGroups,
    compartment_prices: a.compartmentPrices ?? [],
    active:            a.active,
    sort_order:        a.sortOrder,
    created_by:        userId,
    updated_at:        nowIso,
  }));
  if (upsertRows.length > 0) {
    const { error: upErr } = await supabase
      .from('special_addons')
      .upsert(upsertRows, { onConflict: 'company_id,code' });
    if (upErr) {
      if (upErr.code === '42501' || /permission denied/i.test(upErr.message)) {
        return c.json({ error: 'forbidden', reason: upErr.message }, 403);
      }
      return c.json({ error: 'apply_failed', reason: upErr.message }, 500);
    }
  }
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
