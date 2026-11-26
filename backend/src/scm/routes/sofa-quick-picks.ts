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
//     POS call sites: apps/pos/src/lib/queries.ts:2237,2267,2294
// ============================================================================
// ----------------------------------------------------------------------------
// /sofa-quick-picks — global Quick Pick layouts (Phase 5).
//
// Chairman 2026-05-31: Quick Pick != Combo. A Quick Pick is a VISIBLE saved
// sofa LAYOUT for easy selection (it may be unpriced). The card price is
// computed by the POS pricing engine — this table stores NO price.
//
//   GET    /sofa-quick-picks?baseModel=  — list active picks (for the POS)
//   POST   /sofa-quick-picks             — create (Master Admin curates)
//   DELETE /sofa-quick-picks/:id         — soft-delete
//
// Writes are role-gated to sales_director + backend admins (the global layer is
// Master-Admin-curated). The personal layer lives client-side in
// apps/pos/src/state/quickpicks.ts (localStorage) and never touches this route.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import type { Env, Variables } from '../env';
import { canonicalizeLayoutModulesForStorage, type ComboSlots } from '../shared';
import { validateSofaSavedLayout } from '../lib/sofa-saved-layout';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export const sofaQuickPicks = new Hono<{ Bindings: Env; Variables: Variables }>();

sofaQuickPicks.use('*', supabaseAuth);


type Row = {
  id: string;
  base_model: string;
  label: string | null;
  modules: ComboSlots;
  depth: string;
  layout: Record<string, unknown> | null;
  sort_order: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
};

function rowToWire(r: Row) {
  return {
    id: r.id,
    baseModel: r.base_model,
    label: r.label,
    modules: r.modules ?? [],
    depth: r.depth,
    layout: r.layout ?? null,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

function validateModules(v: unknown): ComboSlots | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  for (const entry of v) {
    if (Array.isArray(entry)) {
      if (entry.some((c) => typeof c !== 'string')) return null;
    } else if (typeof entry !== 'string') {
      return null;
    }
  }
  return canonicalizeLayoutModulesForStorage(v);
}

async function requireWriteRole(c: AppContext) {
  if (!canWriteScmConfig(c)) {
    return { ok: false as const, res: c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403) };
  }
  return { ok: true as const };
}

sofaQuickPicks.get('/', async (c) => {
  const supabase = c.get('supabase');
  const baseModel = (c.req.query('baseModel') ?? '').trim();

  if (!baseModel) return c.json({ picks: [] });

  const q = scopeToCompany(
    supabase
      .from('sofa_quick_picks')
      .select('id, base_model, label, modules, depth, layout, sort_order, deleted_at, created_at, updated_at, created_by')
      .is('deleted_at', null)
      .eq('base_model', baseModel),
    c,
  )
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const includeAccessories = c.req.query('includeAccessories') === '1';
  const rows = ((data ?? []) as unknown as Row[]).filter((r) => includeAccessories
    || !Array.isArray(r.layout?.accessories) || r.layout.accessories.length === 0);
  return c.json({ picks: rows.map(rowToWire) });
});

sofaQuickPicks.post('/', async (c) => {
  const gate = await requireWriteRole(c);
  if (!gate.ok) return gate.res;

  let body: {
    baseModel?: string;
    modules?: unknown;
    layout?: unknown;
    depth?: string;
    label?: string | null;
    sortOrder?: number;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const baseModel = (body.baseModel ?? '').trim();
  if (!baseModel) return c.json({ error: 'base_model_required' }, 400);

  const modules = validateModules(body.modules);
  if (!modules) return c.json({ error: 'modules_required' }, 400);

  const layout = validateSofaSavedLayout(body.layout, modules);
  if (layout === false) return c.json({ error: 'layout_invalid' }, 400);

  const depth = (body.depth ?? '').trim();
  if (!depth) return c.json({ error: 'depth_required' }, 400);

  const supabase = c.get('supabase');
  const user = c.get('user');

  const { data, error } = await supabase
    .from('sofa_quick_picks')
    .insert({
      company_id: activeCompanyId(c),
      base_model: baseModel,
      label: body.label ?? null,
      modules,
      layout,
      depth,
      sort_order: Number.isFinite(body.sortOrder) ? Math.round(body.sortOrder!) : 0,
      created_by: user.id,
    })
    .select('id, base_model, label, modules, depth, layout, sort_order, deleted_at, created_at, updated_at, created_by')
    .single();

  if (error) {
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json(rowToWire(data as unknown as Row), 201);
});

sofaQuickPicks.delete('/:id', async (c) => {
  const gate = await requireWriteRole(c);
  if (!gate.ok) return gate.res;

  const id = c.req.param('id');
  const supabase = c.get('supabase');
  const query = supabase
    .from('sofa_quick_picks')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);

  const { error } = await scopeToCompany(query, c);
  if (error) {
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  return c.body(null, 204);
});
