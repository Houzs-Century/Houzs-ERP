import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { targetRefinementSchema } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import {
  activeCompanyId,
  scopeToCompany,
  requireActiveCompanyId,
  scopeToCompanyId,
  NOT_THIS_COMPANY,
} from '../lib/companyScope';
import type { Env, Variables } from '../env';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export const deliveryFees = new Hono<{ Bindings: Env; Variables: Variables }>();

deliveryFees.use('*', supabaseAuth);

// Houzs-flavoured: gate via canWriteScmConfig (flat `scm.config.write` OR the position policy canWriteConfig flag, see houzs-perms.ts) against
// the REAL caller (the 2990 staff_role lookup is dead in Houzs — the SCM
// bridge pins every caller to one super_admin row). Owner + IT Admin pass via
// `*`; grant individual positions via the Team > Positions matrix.

// Same form holds fees + lead days. Each field is independent so the PATCH
// can partial-update either group without nuking the other.
const patchSchema = z.object({
  baseFee:                  z.number().int().nonnegative().optional(),
  crossCategoryFee:         z.number().int().nonnegative().optional(),
  mattressBedframeLeadDays: z.number().int().nonnegative().optional(),
  sofaLeadDays:             z.number().int().nonnegative().optional(),
});

// GET — every authenticated staff role can read.
deliveryFees.get('/', async (c) => {
  const supabase = c.get('supabase');
  // Read the ACTIVE company's single config row by company_id (each company has
  // exactly one). NOT `.eq('id',1)` — 2990's row is id=100001, not 1, so keying
  // on id would miss it and fall back to Houzs's. company_id is the real key.
  const { data, error } = await scopeToCompany(
    supabase
      .from('delivery_fee_config')
      .select('base_fee, cross_category_fee, mattress_bedframe_lead_days, sofa_lead_days, updated_at, updated_by'),
    c,
  )
    .maybeSingle();
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_configured', reason: 'no delivery_fee_config for this company' }, 404);
  return c.json({
    baseFee:                  data.base_fee,
    crossCategoryFee:         data.cross_category_fee,
    mattressBedframeLeadDays: data.mattress_bedframe_lead_days,
    sofaLeadDays:             data.sofa_lead_days,
    updatedAt:                data.updated_at,
    updatedBy:                data.updated_by,
  });
});

// PATCH — fee editors only (admin / coordinator / sales_director). Server-side
// role check + RLS as defence-in-depth (migrations 0029 + 0112 grant UPDATE to
// exactly these roles).
deliveryFees.patch('/', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403);
  }
  const u = c.get('user');
  if (!u?.id) return c.json({ error: 'auth_required' }, 401);
  const userId   = u.id;
  const supabase = c.get('supabase');

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'validation_failed',
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    }, 400);
  }

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: userId,
  };
  if (parsed.data.baseFee                  !== undefined) patch.base_fee                    = parsed.data.baseFee;
  if (parsed.data.crossCategoryFee         !== undefined) patch.cross_category_fee          = parsed.data.crossCategoryFee;
  if (parsed.data.mattressBedframeLeadDays !== undefined) patch.mattress_bedframe_lead_days = parsed.data.mattressBedframeLeadDays;
  if (parsed.data.sofaLeadDays             !== undefined) patch.sofa_lead_days              = parsed.data.sofaLeadDays;

  // Update the ACTIVE company's row by company_id (not id=1 — 2990's is id=100001).
  let q = supabase
    .from('delivery_fee_config')
    .update(patch);
  q = scopeToCompany(q, c);
  const { error } = await q;
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

/* ─── Special delivery fee rules (migration 0024) ──────────────────────────
   Generalises the per-Model 0140 table onto the #691 RuleTarget abstraction. A
   rule's `target` jsonb is RuleTarget[] (scopes model | variant | combo |
   compartment). standalone_fee overrides the base delivery fee when the rule
   matches an SO; cross_cat_followup_fee applies on a cross-category follow-up.
   Read for any staff (the order POST recomputes from it); write for the same
   fee-editor roles as the config above. Fees are whole MYR (server scales ×100
   to sen). combo/compartment are model-agnostic — they allow an empty modelId;
   model/variant require a real modelId to match a line's Model. */

const deliveryTargetSchema = targetRefinementSchema
  .and(z.object({ modelId: z.string() }))
  .superRefine((t, ctx) => {
    if ((t.scope === 'model' || t.scope === 'variant') && !t.modelId) {
      ctx.addIssue({ code: 'custom', message: 'modelId required for model/variant', path: ['modelId'] });
    }
  });

const specialRuleSchema = z.object({
  id:                  z.string().uuid().optional(),
  target:              z.array(deliveryTargetSchema).min(1),
  standaloneFee:       z.number().int().min(0),
  crossCatFollowupFee: z.number().int().min(0),
  label:               z.string().optional(),
});

// Reused gate for the special-fee writes — Houzs flat-key permission.
const requireFeeEditor = async (c: AppContext) => {
  if (!canWriteScmConfig(c)) {
    return { error: c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403) };
  }
  const u = c.get('user');
  if (!u?.id) return { error: c.json({ error: 'auth_required' }, 401) };
  const userId   = u.id;
  const supabase = c.get('supabase');
  return { userId, supabase };
};

// GET — list every special delivery rule. `target` (jsonb RuleTarget[]) passes
// through untouched; the matcher (deliveryTargetMatchesAnyLine) coerces on use.
deliveryFees.get('/special', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await scopeToCompany(
    supabase
      .from('special_delivery_fee_rules')
      .select('id, target, standalone_fee, cross_cat_followup_fee, label, updated_at'),
    c,
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  const rows = (data ?? []).map((r) => ({
    id:                  (r as { id: string }).id,
    target:              (r as { target: unknown }).target ?? [],
    standaloneFee:       (r as { standalone_fee: number }).standalone_fee,
    crossCatFollowupFee: (r as { cross_cat_followup_fee: number }).cross_cat_followup_fee,
    label:               (r as { label: string | null }).label ?? null,
    updatedAt:           (r as { updated_at: string }).updated_at,
  }));
  return c.json(rows);
});

// PUT — upsert one special rule. With `id` → update that row; without → insert.
deliveryFees.put('/special', async (c) => {
  const gate = await requireFeeEditor(c);
  if ('error' in gate) return gate.error;

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = specialRuleSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'validation_failed',
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    }, 400);
  }

  const fields = {
    target:                 parsed.data.target,
    standalone_fee:         parsed.data.standaloneFee,
    cross_cat_followup_fee: parsed.data.crossCatFollowupFee,
    label:                  parsed.data.label ?? null,
    updated_at:             new Date().toISOString(),
    updated_by:             gate.userId,
  };

  if (parsed.data.id) {
    // Company scope (owner audit 2026-07-22): id-only UPDATE let a caller in
    // company A re-price company B's special rule by knowing the UUID.
    const co = requireActiveCompanyId(c);
    if (!co.ok) return c.json(co.refusal, 409);
    const { data, error } = await scopeToCompanyId(
      gate.supabase.from('special_delivery_fee_rules').update(fields).eq('id', parsed.data.id),
      co.companyId,
    ).select('id');
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    if (!data || data.length === 0) return c.json(NOT_THIS_COMPANY, 404);
    return c.json({ ok: true, id: parsed.data.id });
  }

  const { data, error } = await gate.supabase
    .from('special_delivery_fee_rules')
    .insert({ ...fields, company_id: activeCompanyId(c) })
    .select('id');
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  if (!data || data.length === 0) return c.json({ error: 'insert_failed', reason: 'rls_blocked_zero_rows' }, 403);
  return c.json({ ok: true, id: (data[0] as { id: string }).id });
});

// DELETE — drop a special rule (delivery reverts to the normal base/cross fee).
// Company scope (owner audit 2026-07-22): id-only DELETE let a caller in A
// wipe B's special rule by knowing the UUID.
deliveryFees.delete('/special/:id', async (c) => {
  const gate = await requireFeeEditor(c);
  if ('error' in gate) return gate.error;
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data, error } = await scopeToCompanyId(
    gate.supabase.from('special_delivery_fee_rules').delete().eq('id', c.req.param('id')),
    co.companyId,
  ).select('id');
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  if (!data || data.length === 0) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});
