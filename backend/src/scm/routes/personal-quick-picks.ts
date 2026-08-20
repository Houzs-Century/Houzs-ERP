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

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export const personalQuickPicks = new Hono<{ Bindings: Env; Variables: Variables }>();

personalQuickPicks.use('*', supabaseAuth);

type Row = {
  id: string;
  company_id: number;
  owner_user_id: number;
  base_model: string;
  label: string | null;
  modules: ComboSlots;   // jsonb string[][]
  depth: string;
  sort_order: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

const SELECT_COLS =
  'id, company_id, owner_user_id, base_model, label, modules, depth, sort_order, deleted_at, created_at, updated_at';

function rowToWire(r: Row) {
  return {
    id: r.id,
    baseModel: r.base_model,
    label: r.label,
    modules: r.modules ?? [],
    depth: r.depth,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
  };
}

/** The REAL Houzs caller's integer id, or null when unresolved. */
function ownerId(c: AppContext): number | null {
  const id = c.get('houzsUser')?.id;
  return typeof id === 'number' && Number.isFinite(id) ? id : null;
}

/** Same validation/canonicalisation as sofa-quick-picks: accept string[][]
 *  (OR-set slots) or a legacy flat string[] (each code → a singleton slot).
 *  Returns null on a malformed payload. A Quick Pick is a LAYOUT — preserve the
 *  built left-to-right slot order (combos alphabetically sort, which moved a
 *  middle Console to the end on render). */
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

// ── GET / ──────────────────────────────────────────────────────────────
// The caller's active picks for one base model, within the active company.
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
  return c.json({ picks: ((data ?? []) as unknown as Row[]).map(rowToWire) });
});

// ── POST / ─────────────────────────────────────────────────────────────
// Save one of the caller's picks. body: { baseModel, modules, depth, label?, sortOrder? }.
personalQuickPicks.post('/', async (c) => {
  const uid = ownerId(c);
  if (uid == null) return c.json({ error: 'unauthorized' }, 401);

  // scm.personal_quick_picks.company_id is NOT NULL with NO default (mig 0102,
  // created after the 0091 default backfill), so an insert with an unresolved
  // company_id (Hyperdrive cold-start negative-cache, up to 30s) would 500 on the
  // NOT NULL constraint. Guard up front with a clean 409 — mirrors sales-analysis.
  if (activeCompanyId(c) == null) {
    return c.json({ error: 'company_unresolved' }, 409);
  }

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
  const { data, error } = await supabase
    .from('personal_quick_picks')
    .insert({
      company_id: activeCompanyId(c),
      owner_user_id: uid,
      base_model: baseModel,
      label: body.label ?? null,
      modules,
      depth,
      sort_order: Number.isFinite(body.sortOrder) ? Math.round(body.sortOrder!) : 0,
    })
    .select(SELECT_COLS)
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
// Soft-delete one of the caller's picks. The owner_user_id + company filters
// ensure a salesperson can only delete their own.
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
