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
//     POS call sites: apps/pos/src/lib/personal-quick-picks.ts:43,61,73
// ============================================================================
// ----------------------------------------------------------------------------
// /personal-quick-picks — a salesperson's PERSONAL Quick Pick layouts (WS1).
//
// Port of 2990's apps/api/src/routes/personal-quick-picks.ts. Personal saved
// layouts follow the SALESPERSON across devices (they log in with their own
// account on any tablet), so they live in the DB instead of POS localStorage.
//
//   GET    /personal-quick-picks?baseModel=  — list the caller's active picks
//   POST   /personal-quick-picks             — save one of the caller's picks
//   DELETE /personal-quick-picks/:id         — soft-delete one of the caller's picks
//
// NO role-gate (unlike /sofa-quick-picks, the admin-curated global layer): every
// authenticated SCM user manages their OWN picks. Ownership is the REAL Houzs
// caller (c.get('houzsUser').id) — NOT c.get('user').id, which the SCM auth
// bridge pins to one shared system staff uuid for every request (that would
// collapse all salespeople onto one row). Rows are also scoped to the active
// company (multi-company merge). Both are enforced in every query.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import type { Env, Variables } from '../env';
import { canonicalizeLayoutModulesForStorage, type ComboSlots } from '../shared';
import { validateSofaSavedLayout } from '../lib/sofa-saved-layout';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export const personalQuickPicks = new Hono<{ Bindings: Env; Variables: Variables }>();

personalQuickPicks.use('*', supabaseAuth);

type Row = {
  id: string;
  company_id: number;
  owner_user_id: number;
  base_model: string;
  label: string | null;
  modules: ComboSlots;
  depth: string;
  layout: Record<string, unknown> | null;
  sort_order: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

const SELECT_COLS =
  'id, company_id, owner_user_id, base_model, label, modules, depth, layout, sort_order, deleted_at, created_at, updated_at';

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
  };
}

function ownerId(c: AppContext): number | null {
  const id = c.get('houzsUser')?.id;
  return typeof id === 'number' && Number.isFinite(id) ? id : null;
}

function validateModules(v: unknown): ComboSlots | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  for (const entry of v) {
    if (Array.isArray(entry)) {
      if (entry.some((code) => typeof code !== 'string')) return null;
    } else if (typeof entry !== 'string') {
      return null;
    }
  }
  return canonicalizeLayoutModulesForStorage(v);
}

personalQuickPicks.get('/', async (c) => {
  const uid = ownerId(c);
  if (uid == null) return c.json({ error: 'unauthorized' }, 401);

  const baseModel = (c.req.query('baseModel') ?? '').trim();
  if (!baseModel) return c.json({ picks: [] });

  const supabase = c.get('supabase');
  const query = supabase
    .from('personal_quick_picks')
    .select(SELECT_COLS)
    .is('deleted_at', null)
    .eq('owner_user_id', uid)
    .eq('base_model', baseModel)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });

  const { data, error } = await scopeToCompany(query, c);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const includeAccessories = c.req.query('includeAccessories') === '1';
  const rows = ((data ?? []) as unknown as Row[]).filter((r) => includeAccessories
    || !Array.isArray(r.layout?.accessories) || r.layout.accessories.length === 0);
  return c.json({ picks: rows.map(rowToWire) });
});

personalQuickPicks.post('/', async (c) => {
  const uid = ownerId(c);
  if (uid == null) return c.json({ error: 'unauthorized' }, 401);

  if (activeCompanyId(c) == null) {
    return c.json({ error: 'company_unresolved' }, 409);
  }

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
  const { data, error } = await supabase
    .from('personal_quick_picks')
    .insert({
      company_id: activeCompanyId(c),
      owner_user_id: uid,
      base_model: baseModel,
      label: body.label ?? null,
      modules,
      layout,
      depth,
      sort_order: Number.isFinite(body.sortOrder) ? Math.round(body.sortOrder!) : 0,
    })
    .select(SELECT_COLS)
    .single();

  if (error) {
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json(rowToWire(data as unknown as Row), 201);
});

personalQuickPicks.delete('/:id', async (c) => {
  const uid = ownerId(c);
  if (uid == null) return c.json({ error: 'unauthorized' }, 401);

  const id = c.req.param('id');
  const supabase = c.get('supabase');
  const query = supabase
    .from('personal_quick_picks')
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('owner_user_id', uid);

  const { error } = await scopeToCompany(query, c);
  if (error) {
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  return c.body(null, 204);
});
