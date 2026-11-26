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
//     POS call sites: apps/pos/src/lib/queries.ts:1814,1823,1840
// ============================================================================
// /model-free-gifts — per-Model default free gifts (migration 0174). A row gives
// a Model the accessory gift(s) auto-added at RM0 when that Model is placed on an
// SO (a complete sofa of the Model counts once). Read by all staff (SO POST
// recomputes from it); written by SCM config editors. Mirrors fabric-tier-addon.ts /special.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { parseDefaultFreeGifts, targetRefinementSchema } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import type { Env, Variables } from '../env';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export const modelFreeGifts = new Hono<{ Bindings: Env; Variables: Variables }>();
modelFreeGifts.use('*', supabaseAuth);


const giftEntry = z.object({
  giftProductId: z.string().min(1),
  qty: z.number().int().positive(),
  campaignName: z.string().nullable().optional(),
  condition: targetRefinementSchema.nullable().optional(),
});
const putSchema = z.object({
  modelId: z.string().uuid(),
  gifts: z.array(giftEntry),
});

const requireGiftEditor = async (c: AppContext) => {
  if (!canWriteScmConfig(c)) {
    return { error: c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403) };
  }
  const u = c.get('user');
  if (!u?.id) return { error: c.json({ error: 'auth_required' }, 401) };
  const userId   = u.id;
  const supabase = c.get('supabase');
  return { userId, supabase };
};

modelFreeGifts.get('/', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await scopeToCompany(
    supabase
      .from('model_default_free_gifts')
      .select('model_id, gifts, updated_at, product_models(name, model_code, category)'),
    c,
  );
  if (error) return c.json({ error: 'fetch_failed', reason: error.message }, 500);
  const rows = (data ?? []).map((r) => {
    const pm = (r as { product_models?: { name?: string; model_code?: string; category?: string } | null }).product_models ?? null;
    return {
      modelId:   (r as { model_id: string }).model_id,
      modelName: pm?.name ?? '(unknown model)',
      modelCode: pm?.model_code ?? null,
      category:  pm?.category ?? null,
      gifts:     parseDefaultFreeGifts((r as { gifts: unknown }).gifts),
      updatedAt: (r as { updated_at: string }).updated_at,
    };
  });
  return c.json(rows);
});

modelFreeGifts.put('/', async (c) => {
  const gate = await requireGiftEditor(c);
  if ('error' in gate) return gate.error;

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }

  const gifts = parseDefaultFreeGifts(parsed.data.gifts);
  const { data: updated, error } = await gate.supabase
    .from('model_default_free_gifts')
    .upsert({ company_id: activeCompanyId(c), model_id: parsed.data.modelId, gifts, updated_at: new Date().toISOString(), updated_by: gate.userId }, { onConflict: 'model_id' })
    .select('model_id');
  if (error) return c.json({ error: 'upsert_failed', reason: error.message }, 500);
  if (!updated || updated.length === 0) return c.json({ error: 'upsert_failed', reason: 'rls_blocked_zero_rows' }, 403);
  return c.json({ ok: true });
});

modelFreeGifts.delete('/:modelId', async (c) => {
  const gate = await requireGiftEditor(c);
  if ('error' in gate) return gate.error;
  const { error } = await scopeToCompany(gate.supabase.from('model_default_free_gifts').delete().eq('model_id', c.req.param('modelId')), c);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});
