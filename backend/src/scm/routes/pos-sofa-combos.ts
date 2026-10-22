/* /pos-pools/sofa-combos — the 2990 POS's own selling combos (scm.pos_sofa_combos).
 *
 * EXTERNAL CLIENT: the 2990 POS (repo wenwei4046/2990s) — Products > Combo
 * Pricing, the configurator's "Save as combo", PWP / free-gift rule pickers.
 * Owner ruling 2026-09-26: Houzs's combos (sofa_combo_pricing) are Houzs's cost;
 * these are the POS's selling prices, the two sets may differ, and only the POS
 * writes these. Writes go through scm.pos_sofa_combo_insert / _retire (the DB
 * refuses any other writer) and are audited with the real caller.
 *
 *   GET    /pos-pools/sofa-combos          active combo per scope (sofaCombosPosHandler)
 *   GET    /pos-pools/sofa-combos/history  every version of one scope, retired included
 *   POST   /pos-pools/sofa-combos          create
 *   PUT    /pos-pools/sofa-combos/:id      edit = append a new effective-dated version
 *   DELETE /pos-pools/sofa-combos/:id      retire
 *
 * Wire shape matches the admin /sofa-combos rows so the POS keeps one type;
 * pricesByHeight is always {} (there is no cost here). */

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { todayMyt } from '../lib/my-time';
import { requireActiveCompanyId } from '../lib/companyScope';
import { POS_COMBO_COLUMNS, posOwnsSellingCombos, type PosComboRow } from '../lib/pos-sofa-combos';
import { comboSlotsKey, parseDefaultFreeGifts, type SofaPriceTier } from '../shared';
import { TIERS, validateComboModules, validatePricesByHeight } from './sofa-combos';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function posComboToWire(r: PosComboRow) {
  return {
    id: r.id,
    baseModel: r.base_model,
    modules: r.modules,
    tier: r.tier,
    customerId: null,
    supplierId: null,
    pricesByHeight: {},
    sellingPricesByHeight: r.selling_prices_by_height ?? {},
    pwpPricesByHeight: r.pwp_prices_by_height ?? {},
    defaultFreeGifts: r.default_free_gifts ?? [],
    label: r.label,
    effectiveFrom: r.effective_from,
    deletedAt: r.deleted_at,
    notes: r.notes ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
  };
}

type PosCompany = { ok: true; companyId: number } | { ok: false; res: Response };

async function posCompany(c: AppContext): Promise<PosCompany> {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return { ok: false, res: c.json(co.refusal, 409) };
  if (!(await posOwnsSellingCombos(c.get('supabase'), c))) {
    return { ok: false, res: c.json({ error: 'not_pos_combo_company', message: 'POS combos are kept for the 2990 company only.' }, 404) };
  }
  return { ok: true, companyId: co.companyId };
}

function writeGate(c: AppContext): Response | null {
  return canWriteScmConfig(c) ? null : c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403);
}

function actorOf(c: AppContext): { user_id: number | null; name: string | null; email: string | null } {
  const hu = c.get('houzsUser');
  return { user_id: hu?.id ?? null, name: hu?.name ?? hu?.email ?? null, email: hu?.email ?? null };
}

function rpcFailure(c: AppContext, error: { code?: string; message?: string }): Response {
  if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
  return c.json({ error: 'write_failed', reason: error.message }, 500);
}

/** The 2990 branch of GET /pos-pools/sofa-combos: the active row per scope
 *  (latest effective_from <= today, newest created_at on a tie). */
export async function listPosCombos(c: AppContext, companyId: number): Promise<Response> {
  const baseModel = (c.req.query('baseModel') ?? '').trim();
  let q = c.get('supabase')
    .from('pos_sofa_combos')
    .select(POS_COMBO_COLUMNS)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('base_model', { ascending: true })
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false });
  if (baseModel) q = q.eq('base_model', baseModel);

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const today = todayMyt();
  const seen = new Set<string>();
  const rules: ReturnType<typeof posComboToWire>[] = [];
  for (const r of data as unknown as PosComboRow[]) {
    if (r.effective_from > today) continue;
    const key = JSON.stringify([r.base_model, comboSlotsKey(r.modules), r.tier]);
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(posComboToWire(r));
  }
  return c.json({ rules });
}

export const posSofaCombosHistoryHandler = async (c: AppContext) => {
  const co = await posCompany(c);
  if (!co.ok) return co.res;

  const baseModel = (c.req.query('baseModel') ?? '').trim();
  const modulesRaw = c.req.query('modules');
  const tierRaw = (c.req.query('tier') ?? '').trim();
  if (!baseModel) return c.json({ error: 'base_model_required' }, 400);
  if (!modulesRaw) return c.json({ error: 'modules_required' }, 400);

  let parsed: unknown;
  try {
    parsed = JSON.parse(modulesRaw);
  } catch {
    parsed = modulesRaw.split(',');
  }
  const wantedKey = comboSlotsKey(Array.isArray(parsed) ? (parsed as (string | string[])[]) : modulesRaw.split(','));
  const tier = TIERS.has(tierRaw) ? (tierRaw as SofaPriceTier) : null;

  let q = c.get('supabase')
    .from('pos_sofa_combos')
    .select(POS_COMBO_COLUMNS)
    .eq('company_id', co.companyId)
    .eq('base_model', baseModel)
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false });
  q = tier === null ? q.is('tier', null) : q.eq('tier', tier);

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rules = (data as unknown as PosComboRow[])
    .filter((r) => comboSlotsKey(r.modules) === wantedKey)
    .map(posComboToWire);
  return c.json({ rules });
};

type WriteBody = {
  baseModel?: string;
  modules?: unknown;
  tier?: string | null;
  sellingPricesByHeight?: unknown;
  pwpPricesByHeight?: unknown;
  defaultFreeGifts?: Array<{ giftProductId: string; qty: number; campaignName?: string | null }>;
  label?: string | null;
  effectiveFrom?: string;
  notes?: string | null;
};

async function readBody(c: AppContext): Promise<WriteBody | null> {
  try {
    return (await c.req.json()) as WriteBody;
  } catch {
    return null;
  }
}

async function insertVersion(c: AppContext, companyId: number, row: Record<string, unknown>): Promise<Response> {
  const { data, error } = await c.get('supabase').rpc('pos_sofa_combo_insert', {
    p_company_id: companyId,
    p_row: { ...row, created_by: c.get('user').id },
    p_actor: actorOf(c),
  });
  if (error) return rpcFailure(c, error);
  return c.json(posComboToWire(data as PosComboRow), 201);
}

export const posSofaCombosCreateHandler = async (c: AppContext) => {
  const denied = writeGate(c);
  if (denied) return denied;
  const co = await posCompany(c);
  if (!co.ok) return co.res;

  const body = await readBody(c);
  if (!body) return c.json({ error: 'invalid_json' }, 400);

  const baseModel = (body.baseModel ?? '').trim();
  if (!baseModel) return c.json({ error: 'base_model_required' }, 400);
  const modules = validateComboModules(body.modules);
  if (!modules) return c.json({ error: 'modules_required' }, 400);
  const tier = body.tier != null && TIERS.has(body.tier) ? body.tier : null;

  const selling = validatePricesByHeight(body.sellingPricesByHeight);
  if (!selling) return c.json({ error: 'selling_prices_by_height_invalid' }, 400);
  if (!Object.values(selling).some((v) => v !== null)) {
    return c.json({ error: 'selling_prices_all_null', message: 'At least one height needs a selling price' }, 400);
  }
  const pwp = body.pwpPricesByHeight === undefined ? {} : validatePricesByHeight(body.pwpPricesByHeight);
  if (!pwp) return c.json({ error: 'pwp_prices_by_height_invalid' }, 400);

  const effectiveFrom = (body.effectiveFrom ?? '').trim();
  if (!ISO_DATE.test(effectiveFrom)) return c.json({ error: 'effective_from_required', message: 'YYYY-MM-DD' }, 400);

  return insertVersion(c, co.companyId, {
    base_model: baseModel,
    modules,
    tier,
    selling_prices_by_height: selling,
    pwp_prices_by_height: pwp,
    default_free_gifts: Array.isArray(body.defaultFreeGifts) ? parseDefaultFreeGifts(body.defaultFreeGifts) : [],
    label: body.label ?? null,
    effective_from: effectiveFrom,
    notes: body.notes ?? null,
  });
};

export const posSofaCombosEditHandler = async (c: AppContext) => {
  const denied = writeGate(c);
  if (denied) return denied;
  const co = await posCompany(c);
  if (!co.ok) return co.res;

  const { data: orig, error: findErr } = await c.get('supabase')
    .from('pos_sofa_combos')
    .select(POS_COMBO_COLUMNS)
    .eq('company_id', co.companyId)
    .eq('id', c.req.param('id'))
    .maybeSingle();
  if (findErr) return c.json({ error: 'load_failed', reason: findErr.message }, 500);
  if (!orig) return c.json({ error: 'not_found' }, 404);
  const o = orig as unknown as PosComboRow;

  const body = await readBody(c);
  if (!body) return c.json({ error: 'invalid_json' }, 400);

  // Omitted = carried forward, so editing one dimension never wipes another.
  const selling = body.sellingPricesByHeight === undefined
    ? (o.selling_prices_by_height ?? {})
    : validatePricesByHeight(body.sellingPricesByHeight);
  if (!selling) return c.json({ error: 'selling_prices_by_height_invalid' }, 400);
  if (!Object.values(selling).some((v) => v !== null)) {
    return c.json({ error: 'selling_prices_all_null', message: 'At least one height needs a selling price' }, 400);
  }
  const pwp = body.pwpPricesByHeight === undefined
    ? (o.pwp_prices_by_height ?? {})
    : validatePricesByHeight(body.pwpPricesByHeight);
  if (!pwp) return c.json({ error: 'pwp_prices_by_height_invalid' }, 400);

  const effectiveFrom = (body.effectiveFrom ?? '').trim();
  if (!ISO_DATE.test(effectiveFrom)) return c.json({ error: 'effective_from_required', message: 'YYYY-MM-DD' }, 400);

  return insertVersion(c, co.companyId, {
    base_model: o.base_model,
    modules: o.modules,
    tier: o.tier,
    selling_prices_by_height: selling,
    pwp_prices_by_height: pwp,
    default_free_gifts: Array.isArray(body.defaultFreeGifts)
      ? parseDefaultFreeGifts(body.defaultFreeGifts)
      : (o.default_free_gifts ?? []),
    label: body.label ?? null,
    effective_from: effectiveFrom,
    notes: body.notes ?? null,
  });
};

export const posSofaCombosRetireHandler = async (c: AppContext) => {
  const denied = writeGate(c);
  if (denied) return denied;
  const co = await posCompany(c);
  if (!co.ok) return co.res;

  const { data, error } = await c.get('supabase').rpc('pos_sofa_combo_retire', {
    p_company_id: co.companyId,
    p_id: c.req.param('id'),
    p_actor: actorOf(c),
  });
  if (error) return rpcFailure(c, error);
  if (data !== true) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
};
