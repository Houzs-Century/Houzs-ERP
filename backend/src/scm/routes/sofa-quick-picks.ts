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

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export const sofaQuickPicks = new Hono<{ Bindings: Env; Variables: Variables }>();

sofaQuickPicks.use('*', supabaseAuth);

// Houzs-flavoured: gate via canWriteScmConfig (flat `scm.config.write` OR the position policy canWriteConfig flag, see houzs-perms.ts) against
// the REAL caller (the 2990 staff_role lookup is dead in Houzs — the SCM
// bridge pins every caller to one super_admin row).

type Row = {
  id: string;
  base_model: string;
  label: string | null;
  modules: ComboSlots;   // jsonb string[][]
  depth: string;
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
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

/** Accept string[][] (OR-set slots) or a legacy flat string[] (each code → a
 *  singleton slot). Returns null on a malformed payload. A Quick Pick is a
 *  LAYOUT, so PRESERVE the built left-to-right slot order (unlike combos, which
 *  alphabetically sort — that moved a middle Console to the end on render). */
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

// ── GET / ──────────────────────────────────────────────────────────────
// Active picks (deleted_at IS NULL), optionally filtered to one base model.
sofaQuickPicks.get('/', async (c) => {
  const supabase = c.get('supabase');
  const baseModel = (c.req.query('baseModel') ?? '').trim();

  // An absent base model must not fan out to EVERY Model's picks (a sofa SKU
  // with no base_model would otherwise show layouts from other Models — Phase 5
  // review). Require the scope; the POS always passes it for a real sofa Model.
  if (!baseModel) return c.json({ picks: [] });

  const q = scopeToCompany(
    supabase
      .from('sofa_quick_picks')
      .select('id, base_model, label, modules, depth, sort_order, deleted_at, created_at, updated_at, created_by')
      .is('deleted_at', null)
      .eq('base_model', baseModel),
    c,
  )
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ picks: ((data ?? []) as unknown as Row[]).map(rowToWire) });
});

// ── POST / ─────────────────────────────────────────────────────────────
// Create a global Quick Pick. body: { baseModel, modules: string[][], depth,
// label?, sortOrder? }. No price — the engine computes it.
sofaQuickPicks.post('/', async (c) => {
  const gate = await requireWriteRole(c);
  if (!gate.ok) return gate.res;

  let body: {
    baseModel?: string;
    modules?: unknown;
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
      depth,
      sort_order: Number.isFinite(body.sortOrder) ? Math.round(body.sortOrder!) : 0,
      created_by: user.id,
    })
    .select('id, base_model, label, modules, depth, sort_order, deleted_at, created_at, updated_at, created_by')
    .single();

  if (error) {
    /* DEAD BRANCH -- here and at EVERY other 42501 site in this file. 42501 is
       Postgres permission-denied, i.e. RLS, and RLS cannot fire on this path: mig
       0061 enabled RLS on every scm table with NO policies, and the SCM client is
       the SERVICE-ROLE client (scm/middleware/auth.ts:93 -> db/supabase.ts
       getSupabaseService), which bypasses RLS by design. No scm function RAISEs
       42501 either -- the live tree's only ERRCODE is 22023. Do NOT read this as a
       permission check and do NOT treat it as scoping: the only boundary is this
       route's own predicate. (docs/audit-2026-08-13-ledger.md K1) */
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json(rowToWire(data as unknown as Row), 201);
});

// ── DELETE /:id ────────────────────────────────────────────────────────
// Soft-delete (deleted_at = now). Active lookup skips it.
sofaQuickPicks.delete('/:id', async (c) => {
  const gate = await requireWriteRole(c);
  if (!gate.ok) return gate.res;

  const id = c.req.param('id');
  const supabase = c.get('supabase');
  // The company filter IS the isolation boundary: the client is service-role, so
  // RLS never re-checks it. ACTIVE company (same predicate as GET /), so a
  // both-company curator reaches only the picks the list in front of them shows.
  // An id from the other company matches nothing and still 204s — the same
  // answer an unknown id already gave, so the response can't be used to prove a
  // pick exists over there.
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
