// /fabric-library — PATCH the SELLING tier on a customer-pickable fabric_library
// row. Distinct from /fabric-tracking (procurement/cost tiers). Master Admin only
// (server role check + RLS defence-in-depth, migration 0124).
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { scopeToCompany,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import type { Env, Variables } from '../env';

export const fabricLibrary = new Hono<{ Bindings: Env; Variables: Variables }>();

fabricLibrary.use('*', supabaseAuth);

// Houzs-flavoured: gate via canWriteScmConfig (flat `scm.config.write` OR the position policy canWriteConfig flag, see houzs-perms.ts) against
// the REAL caller (the 2990 staff_role lookup is dead in Houzs — the SCM
// bridge pins every caller to one super_admin row).
const VALID_TIER_FIELDS = new Set(['sofaTier', 'bedframeTier']);
const VALID_TIERS = new Set(['PRICE_1', 'PRICE_2', 'PRICE_3']);
const TIER_FIELD_TO_COL: Record<string, string> = { sofaTier: 'sofa_tier', bedframeTier: 'bedframe_tier' };

// GET /fabric-library — list all customer-pickable fabrics (incl. inactive, so
// admin can re-enable) for the ProductModelDetail sofa "fabrics offered" picker.
// In 2990's this read goes DIRECT to supabase from the POS (queries.ts →
// useFabricLibrary); Houzs has no client-side supabase, so it routes here.
//
// HOUZS VENDOR: scm.fabric_library exists (cols id/label/tier/default_surcharge/
// active/sort_order, verified 2026-06-20) but ships EMPTY until seeded — this
// returns [] in that case so the picker renders with no options instead of
// 500ing. Response is camelCased to the shape the frontend FabricLibrary type
// expects (queries.ts).
fabricLibrary.get('/', async (c) => {
  const supabase = c.get('supabase');
  let q = supabase
    .from('fabric_library')
    .select('id, label, tier, sofa_tier, bedframe_tier, default_surcharge, active, sort_order')
    .order('sort_order', { ascending: true });
  q = scopeToCompany(q, c); // multi-company: isolate to the active company
  const { data, error } = await q;
  if (error) {
    // Table missing entirely → degrade to empty so the picker still renders.
    if (/relation .* does not exist/i.test(error.message)) return c.json({ fabrics: [] });
    return c.json({ error: 'load_failed', reason: error.message }, 500);
  }
  // Dual-read camelCase ?? snake_case — the REST/PostgREST driver may camelCase
  // result columns; cover both so we never read undefined.
  const fabrics = (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id,
    label: r.label,
    tier: r.tier,
    // POS reads sofaTier/bedframeTier to compute the fabric-tier upcharge; without
    // them the upcharge resolves to 0 → POS total < server recompute → the drift
    // gate REJECTS the order (premium PRICE_2/PRICE_3 fabrics).
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
  // Multi-company: scope the write to the active company so a blind id from
  // another company matches nothing.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  // .select() so an RLS USING-filter (0 rows touched) surfaces as an error
  // instead of a phantom ok:true.
  const { data: updated, error } = await scopeToCompanyId(supabase.from('fabric_library').update({ [col]: body.tier }).eq('id', id), co.companyId).select('id');
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
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!updated || updated.length === 0) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true });
});
