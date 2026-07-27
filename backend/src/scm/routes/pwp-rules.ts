// /pwp-rules — purchase-with-purchase (换购优惠) rules CRUD. Read by any staff;
// written by admin/super_admin/coordinator/sales_director (server check + RLS,
// migration 0128). A rule: buying a TRIGGER (eligible model in trigger_category)
// unlocks REWARD models (eligible list in reward_category) at their pwp_price_sen.
// Pricing itself is enforced server-side in mfg-sales-orders (shared resolvePwp).
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { activeCompanyId, scopeToCompany,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import type { Env, Variables } from '../env';

type AppCtx = Context<{ Bindings: Env; Variables: Variables }>;

export const pwpRules = new Hono<{ Bindings: Env; Variables: Variables }>();

pwpRules.use('*', supabaseAuth);

// Houzs-flavoured: gate via canWriteScmConfig (flat `scm.config.write` OR the position policy canWriteConfig flag, see houzs-perms.ts) against
// the REAL caller (the 2990 staff_role lookup is dead in Houzs — the SCM
// bridge pins every caller to one super_admin row).

const CATEGORY = z.enum(['SOFA', 'BEDFRAME', 'ACCESSORY', 'MATTRESS', 'SERVICE']);

const createSchema = z.object({
  triggerCategory:         CATEGORY,
  triggerEligibleModelIds: z.array(z.string()).default([]),
  triggerComboIds:         z.array(z.string()).default([]),  // SOFA trigger (Phase 2)
  rewardCategory:          CATEGORY,
  eligibleRewardModelIds:  z.array(z.string()).default([]),
  rewardComboIds:          z.array(z.string()).default([]),  // SOFA reward (Phase 2)
  // Variant/compartment refinement (migration 0182). ADDITIVE: narrows the
  // model/combo match by size (mattress/bedframe) or contained compartment
  // (any-build sofa trigger). [] = no refinement.
  triggerSizeCodes:        z.array(z.string()).default([]),
  triggerCompartments:     z.array(z.string()).default([]),
  rewardSizeCodes:         z.array(z.string()).default([]),
  rewardCompartments:      z.array(z.string()).default([]),
  qtyPerTrigger:           z.number().int().min(1).default(1),
  type:                    z.enum(['pwp', 'promo']).default('pwp'),  // promo lets a 0 reward redeem free (migration 0145)
  active:                  z.boolean().default(true),
});
const patchSchema = createSchema.partial();

// A SOFA trigger is matched EITHER by Combo (trigger_combo_ids) OR by Model
// (trigger_eligible_model_ids) — never both, never neither. Mirrors the POS
// editor's per-trigger toggle so a tampered/legacy client can't store an
// ambiguous sofa trigger (which would make the reserve/recompute mode-derivation
// — "which array is populated" — undefined). Non-sofa triggers are always by
// Model (an empty model list = the whole category, which is allowed).
function sofaTriggerXorError(
  cat: string | undefined,
  comboIds: string[] | undefined,
  modelIds: string[] | undefined,
): string | null {
  if (cat !== 'SOFA') return null;
  const hasCombo = (comboIds ?? []).length > 0;
  const hasModel = (modelIds ?? []).length > 0;
  if (hasCombo && hasModel) return 'A sofa trigger cannot be both by Combo and by Model — pick one.';
  if (!hasCombo && !hasModel) return 'A sofa trigger needs at least one combo (by Combo) or one Model (by Model).';
  return null;
}

type RuleRow = {
  id: string;
  trigger_category: string;
  trigger_eligible_model_ids: string[] | null;
  trigger_combo_ids: string[] | null;
  reward_category: string;
  eligible_reward_model_ids: string[] | null;
  reward_combo_ids: string[] | null;
  trigger_size_codes: string[] | null;
  trigger_compartments: string[] | null;
  reward_size_codes: string[] | null;
  reward_compartments: string[] | null;
  qty_per_trigger: number;
  type: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

const toApi = (r: RuleRow) => ({
  id:                      r.id,
  triggerCategory:         r.trigger_category,
  triggerEligibleModelIds: r.trigger_eligible_model_ids ?? [],
  triggerComboIds:         r.trigger_combo_ids ?? [],
  rewardCategory:          r.reward_category,
  eligibleRewardModelIds:  r.eligible_reward_model_ids ?? [],
  rewardComboIds:          r.reward_combo_ids ?? [],
  triggerSizeCodes:        r.trigger_size_codes ?? [],
  triggerCompartments:     r.trigger_compartments ?? [],
  rewardSizeCodes:         r.reward_size_codes ?? [],
  rewardCompartments:      r.reward_compartments ?? [],
  qtyPerTrigger:           r.qty_per_trigger,
  type:                    (r.type ?? 'pwp') as 'pwp' | 'promo',
  active:                  r.active,
  createdAt:               r.created_at,
  updatedAt:               r.updated_at,
});

const SELECT =
  'id, trigger_category, trigger_eligible_model_ids, trigger_combo_ids, reward_category, eligible_reward_model_ids, reward_combo_ids, trigger_size_codes, trigger_compartments, reward_size_codes, reward_compartments, qty_per_trigger, type, active, created_at, updated_at';

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

// GET — every authenticated staff role can read (POS configurator needs it).
pwpRules.get('/', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await scopeToCompany(
    supabase.from('pwp_rules').select(SELECT),
    c,
  ).order('created_at', { ascending: true });
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json({ rules: (data as RuleRow[]).map(toApi) });
});

// POST — create. Editors only. 23505 (one-active-per-pair) → 409.
pwpRules.post('/', async (c) => {
  const gate = await requireWrite(c);
  if (!gate.ok) return gate.res;

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }

  const trigErr = sofaTriggerXorError(parsed.data.triggerCategory, parsed.data.triggerComboIds, parsed.data.triggerEligibleModelIds);
  if (trigErr) return c.json({ error: 'invalid_sofa_trigger', reason: trigErr }, 400);

  const supabase = c.get('supabase');
  const { data, error } = await supabase
    .from('pwp_rules')
    .insert({
      company_id:                 activeCompanyId(c),
      trigger_category:           parsed.data.triggerCategory,
      trigger_eligible_model_ids: parsed.data.triggerEligibleModelIds,
      trigger_combo_ids:          parsed.data.triggerComboIds,
      reward_category:            parsed.data.rewardCategory,
      eligible_reward_model_ids:  parsed.data.eligibleRewardModelIds,
      reward_combo_ids:           parsed.data.rewardComboIds,
      trigger_size_codes:         parsed.data.triggerSizeCodes,
      trigger_compartments:       parsed.data.triggerCompartments,
      reward_size_codes:          parsed.data.rewardSizeCodes,
      reward_compartments:        parsed.data.rewardCompartments,
      qty_per_trigger:            parsed.data.qtyPerTrigger,
      type:                       parsed.data.type,
      active:                     parsed.data.active,
      created_by:                 gate.userId,
    })
    .select(SELECT)
    .single();
  if (error) {
    return c.json({ error: 'create_failed', reason: error.message }, 500);
  }
  return c.json({ rule: toApi(data as RuleRow) }, 201);
});

// PATCH /:id — update. Editors only.
pwpRules.patch('/:id', async (c) => {
  const gate = await requireWrite(c);
  if (!gate.ok) return gate.res;
  const id = c.req.param('id');

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }

  // Validate the sofa-trigger XOR only when the trigger is being (re)set — the
  // editor always sends triggerCategory + both arrays together on save.
  if (parsed.data.triggerCategory !== undefined) {
    const trigErr = sofaTriggerXorError(parsed.data.triggerCategory, parsed.data.triggerComboIds, parsed.data.triggerEligibleModelIds);
    if (trigErr) return c.json({ error: 'invalid_sofa_trigger', reason: trigErr }, 400);
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.triggerCategory         !== undefined) patch.trigger_category           = parsed.data.triggerCategory;
  if (parsed.data.triggerEligibleModelIds !== undefined) patch.trigger_eligible_model_ids = parsed.data.triggerEligibleModelIds;
  if (parsed.data.triggerComboIds         !== undefined) patch.trigger_combo_ids          = parsed.data.triggerComboIds;
  if (parsed.data.rewardCategory          !== undefined) patch.reward_category            = parsed.data.rewardCategory;
  if (parsed.data.eligibleRewardModelIds  !== undefined) patch.eligible_reward_model_ids  = parsed.data.eligibleRewardModelIds;
  if (parsed.data.rewardComboIds          !== undefined) patch.reward_combo_ids           = parsed.data.rewardComboIds;
  if (parsed.data.triggerSizeCodes        !== undefined) patch.trigger_size_codes         = parsed.data.triggerSizeCodes;
  if (parsed.data.triggerCompartments     !== undefined) patch.trigger_compartments       = parsed.data.triggerCompartments;
  if (parsed.data.rewardSizeCodes         !== undefined) patch.reward_size_codes          = parsed.data.rewardSizeCodes;
  if (parsed.data.rewardCompartments      !== undefined) patch.reward_compartments        = parsed.data.rewardCompartments;
  if (parsed.data.qtyPerTrigger           !== undefined) patch.qty_per_trigger            = parsed.data.qtyPerTrigger;
  if (parsed.data.type                    !== undefined) patch.type                       = parsed.data.type;
  if (parsed.data.active                  !== undefined) patch.active                     = parsed.data.active;

  const supabase = c.get('supabase');
  // Multi-company: scope the write to the active company so a blind id from
  // another company matches nothing (reported as not-found, not mutated).
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data, error } = await scopeToCompanyId(supabase.from('pwp_rules').update(patch).eq('id', id), co.companyId).select(SELECT).maybeSingle();
  if (error) {
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ rule: toApi(data as RuleRow) });
});

// DELETE /:id — editors only.
pwpRules.delete('/:id', async (c) => {
  const gate = await requireWrite(c);
  if (!gate.ok) return gate.res;
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  // Multi-company: scope the delete; select reports whether a row in THIS
  // company was actually removed.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data, error } = await scopeToCompanyId(supabase.from('pwp_rules').delete().eq('id', id), co.companyId).select('id').maybeSingle();
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});
