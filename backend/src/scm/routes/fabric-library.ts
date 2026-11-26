import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { scopeToCompany,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import type { Env, Variables } from '../env';

export const fabricLibrary = new Hono<{ Bindings: Env; Variables: Variables }>();

fabricLibrary.use('*', supabaseAuth);

const VALID_TIER_FIELDS = new Set(['sofaTier', 'bedframeTier']);
const VALID_TIERS = new Set(['PRICE_1', 'PRICE_2', 'PRICE_3']);
const TIER_FIELD_TO_COL: Record<string, string> = { sofaTier: 'sofa_tier', bedframeTier: 'bedframe_tier' };

fabricLibrary.get('/', async (c) => {
  const supabase = c.get('supabase');
  let q = supabase
    .from('fabric_library')
    .select('id, label, tier, sofa_tier, bedframe_tier, default_surcharge, active, sort_order')
    .order('sort_order', { ascending: true });
  q = scopeToCompany(q, c);
  const { data, error } = await q;
  if (error) {
    if (/relation .* does not exist/i.test(error.message)) return c.json({ fabrics: [] });
    return c.json({ error: 'load_failed', reason: error.message }, 500);
  }
  const fabrics = (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id,
    label: r.label,
    tier: r.tier,
    sofaTier: r.sofaTier ?? r.sofa_tier ?? null,
    bedframeTier: r.bedframeTier ?? r.bedframe_tier ?? null,
    defaultSurcharge: r.defaultSurcharge ?? r.default_surcharge ?? 0,
    active: r.active,
    sortOrder: r.sortOrder ?? r.sort_order ?? 0,
  }));
  return c.json({ fabrics });
});

fabricLibrary.patch('/:id/tier', async (c) => {
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403);
  }
  const id       = c.req.param('id');
  const supabase = c.get('supabase');

  let body: { field?: string; tier?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.field || !VALID_TIER_FIELDS.has(body.field)) return c.json({ error: 'invalid_field', allowed: [...VALID_TIER_FIELDS] }, 400);
  if (!body.tier  || !VALID_TIERS.has(body.tier))        return c.json({ error: 'invalid_tier',  allowed: [...VALID_TIERS] }, 400);

  const col = TIER_FIELD_TO_COL[body.field]!;
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: updated, error } = await scopeToCompanyId(supabase.from('fabric_library').update({ [col]: body.tier }).eq('id', id), co.companyId).select('id');
  if (error) {
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!updated || updated.length === 0) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});
