// ============================================================================
// ⚠️  EXTERNAL CLIENT — no screen in THIS repo calls this route. That is
//     expected, not evidence it is dead.
//
//     The consumer is the 2990 POS (pos.2990shome.com, repo wenwei4046/2990s),
//     which has built against this API since the 2026-07-21 cutover. Neither
//     repo compiles against the other, so a repo-wide "find usages" here
//     returns nothing while the route is serving live tablet traffic.
//
//     Deleted as dead code on 2026-08-18 (#2422); the POS 404'd in production.
//     Restored 2026-08-19 (#2459). Before removing it again, grep the POS repo.
//     POS call sites: apps/pos/src/lib/queries.ts:1480,1652,1702,1711
// ============================================================================
// /fabric-tier-addon — the singleton config (4 whole-MYR Δ values) for the POS
// selling fabric-tier add-on. Mirrors delivery-fees.ts. Read by any staff;
// written by admin/coordinator/sales_director (server check + RLS, migration 0124).
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import type { Env, Variables } from '../env';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export const fabricTierAddonConfig = new Hono<{ Bindings: Env; Variables: Variables }>();

fabricTierAddonConfig.use('*', supabaseAuth);


const patchSchema = z.object({
  sofaTier2Delta:     z.number().int().nonnegative().optional(),
  sofaTier3Delta:     z.number().int().nonnegative().optional(),
  bedframeTier2Delta: z.number().int().nonnegative().optional(),
  bedframeTier3Delta: z.number().int().nonnegative().optional(),
});

fabricTierAddonConfig.get('/', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await scopeToCompany(
    supabase
      .from('fabric_tier_addon_config')
      .select('sofa_tier2_delta, sofa_tier3_delta, bedframe_tier2_delta, bedframe_tier3_delta, updated_at, updated_by'),
    c,
  )
    .maybeSingle();
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_configured', reason: 'no fabric_tier_addon_config for this company' }, 404);
  return c.json({
    sofaTier2Delta:     data.sofa_tier2_delta,
    sofaTier3Delta:     data.sofa_tier3_delta,
    bedframeTier2Delta: data.bedframe_tier2_delta,
    bedframeTier3Delta: data.bedframe_tier3_delta,
    updatedAt:          data.updated_at,
    updatedBy:          data.updated_by,
  });
});

fabricTierAddonConfig.patch('/', async (c) => {
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
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: userId };
  if (parsed.data.sofaTier2Delta     !== undefined) patch.sofa_tier2_delta     = parsed.data.sofaTier2Delta;
  if (parsed.data.sofaTier3Delta     !== undefined) patch.sofa_tier3_delta     = parsed.data.sofaTier3Delta;
  if (parsed.data.bedframeTier2Delta !== undefined) patch.bedframe_tier2_delta = parsed.data.bedframeTier2Delta;
  if (parsed.data.bedframeTier3Delta !== undefined) patch.bedframe_tier3_delta = parsed.data.bedframeTier3Delta;

  const { data: updated, error } = await scopeToCompany(supabase.from('fabric_tier_addon_config').update(patch), c).select('id');
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!updated || updated.length === 0) return c.json({ error: 'update_failed', reason: 'rls_blocked_zero_rows' }, 403);
  return c.json({ ok: true });
});


const specialSchema = z.object({
  modelId:    z.string().uuid(),
  tier2Delta: z.number().int().nonnegative().nullable(),
  tier3Delta: z.number().int().nonnegative().nullable(),
});

const requireFabricEditor = async (c: AppContext) => {
  if (!canWriteScmConfig(c)) {
    return { error: c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403) };
  }
  const u = c.get('user');
  if (!u?.id) return { error: c.json({ error: 'auth_required' }, 401) };
  const userId   = u.id;
  const supabase = c.get('supabase');
  return { userId, supabase };
};

fabricTierAddonConfig.get('/special', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await scopeToCompany(
    supabase
      .from('model_fabric_tier_overrides')
      .select('model_id, tier2_delta, tier3_delta, updated_at, product_models(name, model_code, category)'),
    c,
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  const rows = (data ?? []).map((r) => {
    const pm = (r as { product_models?: { name?: string; model_code?: string; category?: string } | null }).product_models ?? null;
    return {
      modelId:    (r as { model_id: string }).model_id,
      modelName:  pm?.name ?? '(unknown model)',
      modelCode:  pm?.model_code ?? null,
      category:   pm?.category ?? null,
      tier2Delta: (r as { tier2_delta: number | null }).tier2_delta,
      tier3Delta: (r as { tier3_delta: number | null }).tier3_delta,
      updatedAt:  (r as { updated_at: string }).updated_at,
    };
  });
  return c.json(rows);
});

fabricTierAddonConfig.put('/special', async (c) => {
  const gate = await requireFabricEditor(c);
  if ('error' in gate) return gate.error;

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = specialSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }

  const { data: updated, error } = await gate.supabase
    .from('model_fabric_tier_overrides')
    .upsert({
      ...(activeCompanyId(c) != null ? { company_id: activeCompanyId(c) } : {}),
      model_id:    parsed.data.modelId,
      tier2_delta: parsed.data.tier2Delta,
      tier3_delta: parsed.data.tier3Delta,
      updated_at:  new Date().toISOString(),
      updated_by:  gate.userId,
    }, { onConflict: 'model_id' })
    .select('model_id');
  if (error) return c.json({ error: 'upsert_failed', reason: error.message }, 500);
  if (!updated || updated.length === 0) return c.json({ error: 'upsert_failed', reason: 'rls_blocked_zero_rows' }, 403);
  return c.json({ ok: true });
});

fabricTierAddonConfig.delete('/special/:modelId', async (c) => {
  const gate = await requireFabricEditor(c);
  if ('error' in gate) return gate.error;
  const modelId = c.req.param('modelId');
  const { error } = await scopeToCompany(gate.supabase
    .from('model_fabric_tier_overrides')
    .delete()
    .eq('model_id', modelId), c);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});


const compartmentSpecialSchema = z.object({
  compartmentId: z.string().min(1),
  tier2Delta:    z.number().int().nonnegative().nullable(),
  tier3Delta:    z.number().int().nonnegative().nullable(),
});

fabricTierAddonConfig.get('/compartment-special', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await scopeToCompany(
    supabase
      .from('compartment_fabric_tier_overrides')
      .select('compartment_id, tier2_delta, tier3_delta, updated_at'),
    c,
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  const rows = (data ?? []).map((r) => ({
    compartmentId: (r as { compartment_id?: string; compartmentId?: string }).compartment_id ?? (r as { compartmentId?: string }).compartmentId ?? '',
    tier2Delta:    (r as { tier2_delta?: number | null; tier2Delta?: number | null }).tier2_delta ?? (r as { tier2Delta?: number | null }).tier2Delta ?? null,
    tier3Delta:    (r as { tier3_delta?: number | null; tier3Delta?: number | null }).tier3_delta ?? (r as { tier3Delta?: number | null }).tier3Delta ?? null,
    updatedAt:     (r as { updated_at?: string; updatedAt?: string }).updated_at ?? (r as { updatedAt?: string }).updatedAt ?? null,
  }));
  return c.json(rows);
});

fabricTierAddonConfig.put('/compartment-special', async (c) => {
  const gate = await requireFabricEditor(c);
  if ('error' in gate) return gate.error;

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = compartmentSpecialSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }

  const companyId = activeCompanyId(c);
  if (companyId == null) {
    return c.json({
      error: 'company_unresolved',
      message: 'Cannot tell which company this belongs to right now. Reload and try again.',
    }, 409);
  }
  const { data: updated, error } = await gate.supabase
    .from('compartment_fabric_tier_overrides')
    .upsert({
      company_id:     companyId,
      compartment_id: parsed.data.compartmentId,
      tier2_delta:    parsed.data.tier2Delta,
      tier3_delta:    parsed.data.tier3Delta,
      updated_at:     new Date().toISOString(),
      updated_by:     gate.userId,
    }, { onConflict: 'compartment_id,company_id' })
    .select('compartment_id');
  if (error) return c.json({ error: 'upsert_failed', reason: error.message }, 500);
  if (!updated || updated.length === 0) return c.json({ error: 'upsert_failed', reason: 'rls_blocked_zero_rows' }, 403);
  return c.json({ ok: true });
});

fabricTierAddonConfig.delete('/compartment-special/:compartmentId', async (c) => {
  const gate = await requireFabricEditor(c);
  if ('error' in gate) return gate.error;
  const compartmentId = c.req.param('compartmentId');
  const { data: deleted, error } = await scopeToCompany(gate.supabase
    .from('compartment_fabric_tier_overrides')
    .delete()
    .eq('compartment_id', compartmentId), c)
    .select('compartment_id');
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  if (!deleted || deleted.length === 0) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});
