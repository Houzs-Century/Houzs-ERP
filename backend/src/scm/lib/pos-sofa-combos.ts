/* 2990 POS selling combos vs Houzs cost combos — which table a reader uses.
 *
 * Owner ruling 2026-09-26: the '2990' company's SELLING combos are authored on
 * the 2990 POS and live in scm.pos_sofa_combos, which only the POS can write
 * (migration *_scm_pos_sofa_combos). scm.sofa_combo_pricing is Houzs's (cost).
 * Before the split both lived in sofa_combo_pricing's master rows, so Houzs
 * cost work retired 96 of 2990's combos (2026-09-25) and overrode others on the
 * POS (2026-09-26).
 *
 * Every SELLING reader goes through loadSellingSofaCombos: the '2990' company
 * reads the POS table, every other company keeps sofa_combo_pricing's master
 * rows exactly as before. The SO cost spread keeps loadMasterSofaCombos for
 * every company. */

import {
  comboChargedPrices,
  type ComboSlots,
  type SofaComboRow,
  type SofaPriceTier,
} from '../shared';
import { activeCompanyId, scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { companyCodeById } from './doc-no';

export const POS_COMBO_COMPANY_CODE = '2990';

export const POS_COMBO_COLUMNS =
  'id, company_id, base_model, modules, tier, selling_prices_by_height, pwp_prices_by_height, ' +
  'default_free_gifts, label, effective_from, deleted_at, notes, created_at, updated_at, created_by, created_by_name';

export type PosComboRow = {
  id: string;
  company_id: number;
  base_model: string;
  modules: ComboSlots;
  tier: SofaPriceTier | null;
  selling_prices_by_height: Record<string, number | null> | null;
  pwp_prices_by_height: Record<string, number | null> | null;
  default_free_gifts: unknown;
  label: string | null;
  effective_from: string;
  deleted_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  created_by_name: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST client, same as every SCM loader
type Sb = any;

/** True when the active company's selling combos live in scm.pos_sofa_combos.
 *  The headless scan path carries only the company id, so the code is looked up. */
export async function posOwnsSellingCombos(sb: Sb, c: CompanyScopeCtx): Promise<boolean> {
  const code = (c.get('companyCode') as string | undefined) ?? (await companyCodeById(sb, activeCompanyId(c)));
  return code === POS_COMBO_COMPANY_CODE;
}

export function posComboToEngine(r: PosComboRow): SofaComboRow {
  return {
    id: r.id,
    baseModel: r.base_model,
    modules: r.modules,
    tier: r.tier,
    customerId: null,
    // No cost column: the charged price IS the selling price.
    pricesByHeight: r.selling_prices_by_height ?? {},
    pwpPricesByHeight: r.pwp_prices_by_height ?? {},
    label: r.label,
    effectiveFrom: r.effective_from,
    createdAt: r.created_at,
    deletedAt: r.deleted_at,
    defaultFreeGifts: r.default_free_gifts ?? [],
  };
}

/** Live POS combos of one company. Throws on a read error: an empty list would
 *  price every combo build a-la-carte, and the POS drift-fix offer could then
 *  adopt the dearer server figure. */
export async function loadLivePosCombos(sb: Sb, companyId: number): Promise<PosComboRow[]> {
  const { data, error } = await sb
    .from('pos_sofa_combos')
    .select(POS_COMBO_COLUMNS)
    .eq('company_id', companyId)
    .is('deleted_at', null);
  if (error) throw new Error(`pos_sofa_combos read failed: ${error.message ?? String(error)}`);
  return (data ?? []) as PosComboRow[];
}

type MasterComboRow = {
  id: string; base_model: string; modules: string[][]; tier: SofaPriceTier | null;
  customer_id: string | null; prices_by_height: Record<string, number | null>;
  selling_prices_by_height: Record<string, number | null>;
  pwp_prices_by_height: Record<string, number | null> | null;
  label: string | null; effective_from: string; created_at: string; deleted_at: string | null;
  default_free_gifts: unknown;
};

/** sofa_combo_pricing master rows (supplier_id NULL, default customer scope) of
 *  the active company, charged = selling over cost. */
export async function loadMasterSofaCombos(sb: Sb, c: CompanyScopeCtx): Promise<SofaComboRow[]> {
  const { data } = await scopeToCompany(
    sb
      .from('sofa_combo_pricing')
      .select('id, base_model, modules, tier, customer_id, prices_by_height, selling_prices_by_height, pwp_prices_by_height, label, effective_from, created_at, deleted_at, default_free_gifts'),
    c,
  )
    .is('deleted_at', null)
    .is('customer_id', null)
    .is('supplier_id', null);
  return ((data ?? []) as MasterComboRow[]).map((r) => ({
    id: r.id, baseModel: r.base_model, modules: r.modules,
    tier: r.tier, customerId: r.customer_id,
    pricesByHeight: comboChargedPrices(r.selling_prices_by_height, r.prices_by_height),
    pwpPricesByHeight: r.pwp_prices_by_height ?? {},
    label: r.label, effectiveFrom: r.effective_from, createdAt: r.created_at, deletedAt: r.deleted_at,
    defaultFreeGifts: r.default_free_gifts ?? [],
  }));
}

/** The combos a SELLING path prices with (SO create / line edit / add line /
 *  sofa swap, PWP, sales analysis). */
export async function loadSellingSofaCombos(sb: Sb, c: CompanyScopeCtx): Promise<SofaComboRow[]> {
  if (await posOwnsSellingCombos(sb, c)) {
    const companyId = activeCompanyId(c);
    if (companyId == null) throw new Error('pos_sofa_combos: active company unresolved');
    return (await loadLivePosCombos(sb, companyId)).map(posComboToEngine);
  }
  return loadMasterSofaCombos(sb, c);
}

/** id -> modules for the active company's combos in BOTH tables. Special
 *  delivery targets and PWP rules store combo ids, and a POS combo created
 *  after the split exists only in scm.pos_sofa_combos. */
export async function loadComboModulesById(sb: Sb, c: CompanyScopeCtx): Promise<Map<string, string[][]>> {
  const [{ data: houzsRows }, { data: posRows, error: posErr }] = await Promise.all([
    scopeToCompany(sb.from('sofa_combo_pricing').select('id, modules'), c),
    scopeToCompany(sb.from('pos_sofa_combos').select('id, modules'), c),
  ]);
  if (posErr) throw new Error(`pos_sofa_combos read failed: ${posErr.message ?? String(posErr)}`);
  const out = new Map<string, string[][]>();
  for (const r of (houzsRows ?? []) as Array<{ id: string; modules: string[][] | null }>) out.set(r.id, r.modules ?? []);
  for (const r of (posRows ?? []) as Array<{ id: string; modules: string[][] | null }>) out.set(r.id, r.modules ?? []);
  return out;
}

/** Live combos (id, base model, modules) from BOTH tables — for PWP rules, which
 *  reference combo ids. `ids` null = every live master combo (the PWP claim's
 *  candidate list); a list = exactly those ids. A POS row wins over a
 *  sofa_combo_pricing row with the same id (the copy left behind by the split). */
export async function loadLiveCombosByIds(
  sb: Sb,
  ids: readonly string[] | null,
): Promise<Map<string, { base_model: string; modules: string[][] }>> {
  let houzsQ = sb.from('sofa_combo_pricing').select('id, base_model, modules').is('deleted_at', null);
  let posQ = sb.from('pos_sofa_combos').select('id, base_model, modules').is('deleted_at', null);
  if (ids == null) {
    houzsQ = houzsQ.is('customer_id', null).is('supplier_id', null);
  } else {
    if (ids.length === 0) return new Map();
    houzsQ = houzsQ.in('id', ids as string[]);
    posQ = posQ.in('id', ids as string[]);
  }
  const [{ data: houzsRows }, { data: posRows, error: posErr }] = await Promise.all([houzsQ, posQ]);
  if (posErr) throw new Error(`pos_sofa_combos read failed: ${posErr.message ?? String(posErr)}`);
  const out = new Map<string, { base_model: string; modules: string[][] }>();
  type IdRow = { id: string; base_model: string; modules: string[][] | null };
  for (const r of (houzsRows ?? []) as IdRow[]) out.set(r.id, { base_model: r.base_model, modules: r.modules ?? [] });
  for (const r of (posRows ?? []) as IdRow[]) out.set(r.id, { base_model: r.base_model, modules: r.modules ?? [] });
  return out;
}
