import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { parseFreeItemEligible, ruleTargetSchema } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import type { Env, Variables } from '../env';
import { activeCompanyId, scopeToCompany,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export const freeItemCampaigns = new Hono<{ Bindings: Env; Variables: Variables }>();
freeItemCampaigns.use('*', supabaseAuth);


const writeSchema = z.object({
  name: z.string().min(1),
  active: z.boolean(),
  maxFreeQty: z.number().int().positive(),
  eligible: z.array(ruleTargetSchema),
});

const requireCampaignEditor = async (c: AppContext) => {
  if (!canWriteScmConfig(c)) {
    return { error: c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403) };
  }
  const u = c.get('user');
  if (!u?.id) return { error: c.json({ error: 'auth_required' }, 401) };
  const userId = u.id;
  const supabase = c.get('supabase');
  return { userId, supabase };
};

const rowToWire = (r: Record<string, unknown>) => ({
  id:         String(r.id),
  name:       String(r.name ?? ''),
  active:     Boolean(r.active),
  maxFreeQty: Number(r.max_free_qty ?? 1),
  eligible:   parseFreeItemEligible(r.eligible),
});

freeItemCampaigns.get('/', async (c) => {
  const supabase = c.get('supabase');
  let q = scopeToCompany(supabase.from('free_item_campaigns').select('id, name, active, max_free_qty, eligible'), c);
  if (c.req.query('active') === '1') q = q.eq('active', true);
  const { data, error } = await q;
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json((data ?? []).map((r) => rowToWire(r as Record<string, unknown>)));
});

freeItemCampaigns.post('/', async (c) => {
  const gate = await requireCampaignEditor(c);
  if ('error' in gate) return gate.error;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = writeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: parsed.error.issues }, 400);
  const eligible = parseFreeItemEligible(parsed.data.eligible);
  const { data, error } = await gate.supabase
    .from('free_item_campaigns')
    .insert({ company_id: activeCompanyId(c), name: parsed.data.name, active: parsed.data.active, max_free_qty: parsed.data.maxFreeQty, eligible, created_by: gate.userId })
    .select('id');
  if (error) return c.json({ error: 'create_failed', reason: error.message }, 500);
  if (!data || data.length === 0) return c.json({ error: 'create_failed', reason: 'rls_blocked_zero_rows' }, 403);
  return c.json({ ok: true, id: (data[0] as { id: string }).id });
});

freeItemCampaigns.patch('/:id', async (c) => {
  const gate = await requireCampaignEditor(c);
  if ('error' in gate) return gate.error;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = writeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: parsed.error.issues }, 400);
  const eligible = parseFreeItemEligible(parsed.data.eligible);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data, error } = await scopeToCompanyId(gate.supabase
    .from('free_item_campaigns')
    .update({ name: parsed.data.name, active: parsed.data.active, max_free_qty: parsed.data.maxFreeQty, eligible, updated_at: new Date().toISOString() })
    .eq('id', c.req.param('id')), co.companyId)
    .select('id');
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data || data.length === 0) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});

freeItemCampaigns.delete('/:id', async (c) => {
  const gate = await requireCampaignEditor(c);
  if ('error' in gate) return gate.error;
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data, error } = await scopeToCompanyId(gate.supabase.from('free_item_campaigns').delete().eq('id', c.req.param('id')), co.companyId).select('id');
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  if (!data || data.length === 0) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});
