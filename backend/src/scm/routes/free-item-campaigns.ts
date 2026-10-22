// /free-item-campaigns — standalone giveaway campaigns (migration 0176). While
// active, eligible cart lines can be made RM0 by the salesperson. Read by all
// staff (POS cart + SO POST validate from it); written by SCM config editors.
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

// Houzs-flavoured: gate via canWriteScmConfig (flat `scm.config.write` OR the position policy canWriteConfig flag, see houzs-perms.ts) against
// the REAL caller (the 2990 staff_role lookup is dead in Houzs — the SCM
// bridge pins every caller to one super_admin row). Owner + IT Admin pass via
// `*`; grant the flat key to a ROLE, or set the Title's canWriteConfig flag,
// under Team > Roles & Permissions (the Roles and Titles tabs).

// eligible entries are unified RuleTargets (model / variant / combo / compartment);
// ruleTargetSchema enforces the per-scope fields. parseFreeItemEligible re-coerces
// on read (and tolerates legacy {scope:'combo', comboId} rows).
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

// GET — list all (admin view) or ?active=1 (slim, for the POS cart hook).
freeItemCampaigns.get('/', async (c) => {
  const supabase = c.get('supabase');
  let q = scopeToCompany(supabase.from('free_item_campaigns').select('id, name, active, max_free_qty, eligible'), c);
  if (c.req.query('active') === '1') q = q.eq('active', true);
  const { data, error } = await q;
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  return c.json((data ?? []).map((r) => rowToWire(r as Record<string, unknown>)));
});

// POST — create.
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
    .insert({ company_id: activeCompanyId(c), name: parsed.data.name, active: parsed.data.active, max_free_qty: parsed.data.maxFreeQty, eligible, created_by: gate.userId }) // multi-company: stamp the active company
    .select('id');
  if (error) return c.json({ error: 'create_failed', reason: error.message }, 500);
  if (!data || data.length === 0) return c.json({ error: 'create_failed', reason: 'rls_blocked_zero_rows' }, 403);
  return c.json({ ok: true, id: (data[0] as { id: string }).id });
});

// PATCH — update name / active / maxFreeQty / eligible.
freeItemCampaigns.patch('/:id', async (c) => {
  const gate = await requireCampaignEditor(c);
  if ('error' in gate) return gate.error;
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = writeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: parsed.error.issues }, 400);
  const eligible = parseFreeItemEligible(parsed.data.eligible);
  // Multi-company: scope the write to the active company so a blind id from
  // another company matches nothing.
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

// DELETE — remove a campaign (placed SO lines keep their snapshot → stay free).
freeItemCampaigns.delete('/:id', async (c) => {
  const gate = await requireCampaignEditor(c);
  if ('error' in gate) return gate.error;
  // Multi-company: scope the delete to the active company.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data, error } = await scopeToCompanyId(gate.supabase.from('free_item_campaigns').delete().eq('id', c.req.param('id')), co.companyId).select('id');
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  if (!data || data.length === 0) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});
