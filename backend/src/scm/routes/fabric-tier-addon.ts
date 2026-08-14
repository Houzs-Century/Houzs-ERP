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

// Exported name avoids clashing with the shared `fabricTierAddon` pure function.
export const fabricTierAddonConfig = new Hono<{ Bindings: Env; Variables: Variables }>();

fabricTierAddonConfig.use('*', supabaseAuth);

// Houzs-flavoured: gate via canWriteScmConfig (flat `scm.config.write` OR the position policy canWriteConfig flag, see houzs-perms.ts) against
// the REAL caller (the 2990 staff_role lookup is dead in Houzs — the SCM
// bridge pins every caller to one super_admin row). Owner + IT Admin pass via
// `*`; grant individual positions via the Team > Positions matrix.

const patchSchema = z.object({
  sofaTier2Delta:     z.number().int().nonnegative().optional(),
  sofaTier3Delta:     z.number().int().nonnegative().optional(),
  bedframeTier2Delta: z.number().int().nonnegative().optional(),
  bedframeTier3Delta: z.number().int().nonnegative().optional(),
});

// GET — every authenticated staff role can read.
fabricTierAddonConfig.get('/', async (c) => {
  const supabase = c.get('supabase');
  // Read by company_id (each company has one row). NOT `.eq('id',1)` — 2990's
  // row is id=100001, so keying on id would miss it and fall back to Houzs's.
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

// PATCH — editors only. Server role check + RLS defence-in-depth (migration 0124).
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

  // .select() so an RLS USING-filter (0 rows touched) surfaces as an error
  // instead of a phantom ok:true — exactly how the super_admin gap hid for days.
  const { data: updated, error } = await scopeToCompany(supabase.from('fabric_tier_addon_config').update(patch), c).select('id');
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!updated || updated.length === 0) return c.json({ error: 'update_failed', reason: 'rls_blocked_zero_rows' }, 403);
  return c.json({ ok: true });
});

/* ─── Per-Model fabric-tier Δ overrides (migration 0172) ───────────────────
   A row gives a Model its own selling fabric-tier Δ that REPLACES the global
   config for that Model; NULL tier = inherit. Read by all staff (the SO POST
   recomputes from it); write for the same editor set as the global config.
   Mirrors delivery-fees.ts /special. */

const specialSchema = z.object({
  modelId:    z.string().uuid(),
  tier2Delta: z.number().int().nonnegative().nullable(),
  tier3Delta: z.number().int().nonnegative().nullable(),
});

// Reused gate for the per-Model writes — Houzs flat-key permission.
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

// GET — list every override row with its Model's name + code + category.
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

// PUT — upsert one Model's override (tier deltas may be null = inherit global).
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

// DELETE — un-tag a Model (reverts to the global Δ).
fabricTierAddonConfig.delete('/special/:modelId', async (c) => {
  const gate = await requireFabricEditor(c);
  if ('error' in gate) return gate.error;
  const modelId = c.req.param('modelId');
  /* Scoped like the GET above (L112). scm.model_fabric_tier_overrides carries
     company_id NOT NULL (mig 0083), so an id-only delete removed another
     company's override and its SO recompute silently fell back to the global Δ
     — a price change with no edit behind it. Same fix as sofa-combos and
     model-free-gifts in this pass.

     THIS PARAGRAPH USED TO CLAIM A BUG THAT DOES NOT EXIST, and it is kept as a
     correction because the claim was plausible enough to be believed twice. It
     said: the PK is `model_id` ALONE (2990s-full-schema.sql:770; mig 0083 added
     company_id and left the key untouched), therefore one company's upsert
     overwrites the other's.

     The first half is true and the conclusion does not follow. product_models
     itself carries company_id — rows are CREATED with `company_id:
     activeCompanyId(c)` (routes/product-models.ts:445) and listed through
     scopeToCompany (:181) — so each company owns its own model rows with their
     own uuids. Two companies can never contend for one model_id, and a key of
     (model_id) already implies a company.

     Its compartment-level twin below IS real, but NOT for the reason this
     comment first gave. It said "compartment_library carries no company_id, the
     catalogue is shared" — mig 0089:74 adds one, NOT NULL. Corrected the same
     day by a doc-vs-source sweep; the verdict held, the argument did not.

     The real reason is one file away: `compartment_id` there is an UNVALIDATED
     free string from the request body, never joined to the catalogue (nothing in
     backend/src reads scm.compartment_library at all), and the values are
     normalized sofa module codes that both companies produce from their own
     SKUs. So its GET filtered by company while its PK permitted one row
     globally — a contradiction provable inside that one handler. Re-keyed by
     mig 0287.

     Same DDL shape, opposite verdicts. The lesson stands but is narrower than
     first written: counting company_id columns answers nothing, and neither does
     one glance at a parent — you have to find who actually WRITES the key. */
  const { error } = await scopeToCompany(gate.supabase
    .from('model_fabric_tier_overrides')
    .delete()
    .eq('model_id', modelId), c);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

/* ─── Per-compartment fabric-tier Δ overrides (migration 0025, ports 2990 0184) ─
   A row gives a sofa compartment code its own selling fabric-tier Δ. The SO
   recompute resolves the effective Δ by TAKING THE HIGHEST over the model
   override and every matching compartment override (custom-build cells only);
   NULL tier = not set (inherit global). Read by all staff (the SO POST
   recomputes from it); write for the same editor set as the global config.
   Mirrors the per-Model /special handlers above. */

const compartmentSpecialSchema = z.object({
  compartmentId: z.string().min(1),
  tier2Delta:    z.number().int().nonnegative().nullable(),
  tier3Delta:    z.number().int().nonnegative().nullable(),
});

// GET — list every compartment override row.
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

// PUT — upsert one compartment's override (tier deltas may be null = not set).
fabricTierAddonConfig.put('/compartment-special', async (c) => {
  const gate = await requireFabricEditor(c);
  if ('error' in gate) return gate.error;

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = compartmentSpecialSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }

  /* The key is (compartment_id, company_id) since mig 0287, and BOTH halves have
     to be present or the upsert cannot address a row. `compartmentId` arrives
     from the request body and is NEVER validated against a catalogue — nothing
     in backend/src reads scm.compartment_library — and the values are normalized
     sofa module codes, which both companies produce from their own SKUs. So
     before 0287 this upsert landed on the OTHER company's row: deltas replaced,
     company_id flipped, their next
     scoped GET showing the compartment as un-tagged. A fabric-tier delta is a
     PRICE (mfg-pricing-recompute.ts:997 reads this table), so that silently
     repriced their sofa builds.

     An UNRESOLVED company therefore has to refuse rather than omit the stamp:
     company_id is NOT NULL in the key now, so a write without it fails at the
     database anyway — better to say so in words. Same fail-safe shape as
     routes/pos-cart.ts after 0284. */
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

// DELETE — un-tag a compartment (reverts to model/global resolution).
fabricTierAddonConfig.delete('/compartment-special/:compartmentId', async (c) => {
  const gate = await requireFabricEditor(c);
  if ('error' in gate) return gate.error;
  const compartmentId = c.req.param('compartmentId');
  // Scoped like its model-level twin above. The single-column-PK problem this
  // comment used to record was REAL here (unlike the model twin) and is closed:
  // mig 0287 re-keyed the table (compartment_id, company_id).
  const { data: deleted, error } = await scopeToCompany(gate.supabase
    .from('compartment_fabric_tier_overrides')
    .delete()
    .eq('compartment_id', compartmentId), c)
    .select('compartment_id');
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  if (!deleted || deleted.length === 0) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});
