// ----------------------------------------------------------------------------
// /sofa-combos — Sofa Combo Pricing maintenance.
//
// Commander 2026-05-28 ("去查看 hookka 的 combo module 把整个 copy 过来").
// Module-set combo deals — when a SO/POS line composes the modules array
// on this base model with the matching tier + customer scope, the combo
// price OVERRIDES per-Model compartment pricing.
//
//   GET    /sofa-combos                        — list (filterable)
//   GET    /sofa-combos/history                — append-only history rows
//   POST   /sofa-combos                        — create (or insert new effective row)
//   PUT    /sofa-combos/:id                    — convenience alias for POST
//                                                (creates a new effective row,
//                                                preserves identity of the
//                                                "logical" combo via tuple match)
//   DELETE /sofa-combos/:id                    — soft-delete (deleted_at = now)
//   POST   /sofa-combos/copy-to-customer       — duplicate rules between
//                                                customer scopes
//
// Append-only history: editing INSERTS a new row with a fresher
// effective_from. The latest row in scope wins at lookup time. See the
// migration header (0090_sofa_combo_pricing.sql) and the pure picker in
// packages/shared/src/sofa-combo-pricing.ts for full spec.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { canonicalizeComboModulesForStorage, comboSlotsKey, sofaComboCostSen, parseDefaultFreeGifts, type ComboSlots } from '../shared';
import { loadModelSofaModuleCosts } from '../lib/mfg-pricing-recompute';
import { canWriteScmConfig } from '../lib/houzs-perms';
import { todayMyt } from '../lib/my-time';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';

export const sofaCombos = new Hono<{ Bindings: Env; Variables: Variables }>();

sofaCombos.use('*', supabaseAuth);

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

// Combo pricing is staff-curated, not open to every authenticated user. Houzs
// gates on the flat permission key `scm.config.write` against the REAL caller
// (the 2990 staff_role lookup is dead in Houzs — the SCM bridge pins every
// caller to one super_admin row). Owner + IT Admin pass via `*`; grant
// individual positions via the Team > Positions matrix. GET stays open (the
// POS salesperson must read combos to price builds); only writes are gated.

async function requireWriteRole(c: AppContext): Promise<{ ok: true } | { ok: false; res: Response }> {
  if (!canWriteScmConfig(c)) {
    return { ok: false, res: c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403) };
  }
  return { ok: true };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const todayIso = () => todayMyt();
const TIERS = new Set(['PRICE_1', 'PRICE_2', 'PRICE_3']);

type Tier = 'PRICE_1' | 'PRICE_2' | 'PRICE_3' | null;

type Row = {
  id: string;
  base_model: string;
  modules: ComboSlots;   // jsonb string[][] — OR-set per slot
  tier: Tier;
  customer_id: string | null;
  supplier_id: string | null;
  prices_by_height: Record<string, number | null>;
  selling_prices_by_height: Record<string, number | null>;
  pwp_prices_by_height: Record<string, number | null> | null;
  default_free_gifts: Array<{ giftProductId: string; qty: number; campaignName?: string | null }> | null;
  label: string | null;
  effective_from: string;
  deleted_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
};

function rowToWire(r: Row) {
  return {
    id: r.id,
    baseModel: r.base_model,
    modules: r.modules,
    tier: r.tier,
    customerId: r.customer_id,
    supplierId: r.supplier_id,
    pricesByHeight: r.prices_by_height ?? {},
    sellingPricesByHeight: r.selling_prices_by_height ?? {},
    pwpPricesByHeight: r.pwp_prices_by_height ?? {},
    defaultFreeGifts: r.default_free_gifts ?? [],
    label: r.label,
    effectiveFrom: r.effective_from,
    deletedAt: r.deleted_at,
    notes: r.notes ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by,
  };
}

// ── R8 anchor mirror (Commander 2026-06-16) ──────────────────────────────
// A base_model can be ANCHORED to one supplier (sofa_combo_anchor, PK
// base_model). While anchored, every combo CREATE and price EDIT is mirrored
// bidirectionally between the master (sales-side, supplier_id NULL) combo and
// that supplier's scope (supplier_id = the anchored supplier), so the
// Product-Maintenance cost reference and the anchored supplier's cost stay in
// lock-step. Mirroring is append-only (it INSERTs a copy on the other side)
// and best-effort (the primary write already succeeded — a mirror failure must
// never 500 the caller; we just report mirrored:false).

// `Sb` = the Supabase client this route's middleware stashes on the context
// (`c.get('supabase')`, see env.ts Variables). The mirror helpers take it
// explicitly so they can run the secondary INSERT on the same client.
type Sb = SupabaseClient;

// The anchored supplier for a base model, or null when not anchored.
async function loadComboAnchor(
  sb: Sb,
  baseModel: string,
  companyId?: number | null,
): Promise<string | null> {
  let q = sb
    .from('sofa_combo_anchor')
    .select('supplier_id')
    .eq('base_model', baseModel);
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data } = await q.maybeSingle();
  return (data as { supplier_id?: string } | null)?.supplier_id ?? null;
}

// Mirror a just-saved combo row to the OTHER side of the anchor.
//   · savedRow on the master (supplier_id NULL)         → copy into the supplier scope.
//   · savedRow on the anchored supplier's scope          → copy into the master (NULL).
//   · savedRow on some OTHER supplier (not the anchor)   → no mirror (returns false).
// The copy keeps the same scope tuple (base_model / modules / tier / customer)
// and every price map, only swapping supplier_id to the mirror target, so the
// lookup picker treats it as a fresh effective-dated row on that side.
async function mirrorAnchoredCombo(
  sb: Sb,
  savedRow: Row,
  anchorSupplierId: string,
  userId: string,
  companyId?: number | null,
): Promise<boolean> {
  let target: string | null;
  if (savedRow.supplier_id == null) {
    target = anchorSupplierId;            // master → supplier scope
  } else if (savedRow.supplier_id === anchorSupplierId) {
    target = null;                        // anchored supplier → master
  } else {
    return false;                         // a different supplier — not part of this anchor
  }

  try {
    const { error } = await sb.from('sofa_combo_pricing').insert({
      company_id: companyId ?? null,
      base_model: savedRow.base_model,
      modules: savedRow.modules,
      tier: savedRow.tier,
      customer_id: savedRow.customer_id,
      supplier_id: target,
      prices_by_height: savedRow.prices_by_height,
      selling_prices_by_height: savedRow.selling_prices_by_height,
      pwp_prices_by_height: savedRow.pwp_prices_by_height ?? {},
      default_free_gifts: savedRow.default_free_gifts ?? [],
      label: savedRow.label,
      effective_from: savedRow.effective_from,
      notes: savedRow.notes,
      created_by: userId,
    });
    return !error;
  } catch {
    // Best-effort — the primary write already succeeded; never throw here.
    return false;
  }
}

/**
 * Validate + CANONICALIZE incoming combo `modules` into the OR-set slot shape
 * (string[][]). Mirrors HOOKKA's `canonicalSizes` (src/api/routes/sofa-combos.ts)
 * so equivalent combos persist byte-identical JSON and hash to the same scope:
 *   · string[][] — slots, each an OR-set of codes (the new shape).
 *   · string[]   — legacy flat list; each code becomes a singleton slot.
 *   · trims + de-dupes within each slot, drops empty slots,
 *   · sorts codes within each slot, then sorts the slots by their first code.
 * Returns null on a malformed payload (non-array, empty after trim, or a
 * slot with no codes).
 */
function validateComboModules(v: unknown): ComboSlots | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  // Reject mixed/garbage entries up front; the canonicalizer handles the
  // string vs string[] coercion + trimming + intra-slot/slot sort.
  for (const entry of v) {
    if (Array.isArray(entry)) {
      if (entry.some((c) => typeof c !== 'string')) return null;
    } else if (typeof entry !== 'string') {
      return null;
    }
  }
  return canonicalizeComboModulesForStorage(v);
}

function validatePricesByHeight(v: unknown): Record<string, number | null> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, number | null> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    // Height keys come from the Maintenance Sizes pool: numeric seat heights
    // ("24", "37") or named ones like "Flat". Accept alphanumeric labels (with
    // an optional space/dash); reject empty or symbol-only keys. The old
    // /^\d+$/ rejected the entire payload the moment "Flat" entered the pool.
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(k)) return null;
    if (raw === null || raw === undefined || raw === '') {
      out[k] = null;
      continue;
    }
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    out[k] = Math.round(n);
  }
  return out;
}

// ── GET / ──────────────────────────────────────────────────────────────
// List currently-active combos (one row per scope tuple — the row with the
// latest effective_from ≤ today, deleted_at IS NULL).
//
// Query params:
//   baseModel?  — filter to one base model
//   customerId? — filter to one customer ('' or '__all__' = NULL scope only)
//   supplierId? — filter to one supplier's purchasing-scope combos. When
//                 omitted the list returns the sales-side / master combos
//                 (supplier_id IS NULL) so the Products page is unaffected by
//                 supplier rows.
//   includeAll? — '1' to skip the "active only" reducer (returns every row;
//                 used by the History drawer).
sofaCombos.get('/', async (c) => {
  const supabase = c.get('supabase');
  const baseModel = (c.req.query('baseModel') ?? '').trim();
  const customerIdRaw = c.req.query('customerId');
  const supplierIdRaw = c.req.query('supplierId');
  const includeAll = c.req.query('includeAll') === '1';

  let q = scopeToCompany(
    supabase
      .from('sofa_combo_pricing')
      .select(
        'id, base_model, modules, tier, customer_id, supplier_id, prices_by_height, selling_prices_by_height, pwp_prices_by_height, default_free_gifts, label, ' +
        'effective_from, deleted_at, notes, created_at, updated_at, created_by',
      ),
    c,
  )
    .order('base_model', { ascending: true })
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false });

  if (!includeAll) q = q.is('deleted_at', null);
  if (baseModel) q = q.eq('base_model', baseModel);

  if (customerIdRaw !== undefined) {
    if (customerIdRaw === '' || customerIdRaw === '__all__' || customerIdRaw === 'null') {
      q = q.is('customer_id', null);
    } else {
      q = q.eq('customer_id', customerIdRaw);
    }
  }

  // Supplier scope. Provided = that supplier's combos. Omitted (or explicitly
  // the NULL sentinels) = sales-side / master combos so the Products page
  // never sees supplier rows.
  if (supplierIdRaw !== undefined && supplierIdRaw !== '' && supplierIdRaw !== 'null') {
    q = q.eq('supplier_id', supplierIdRaw);
  } else {
    q = q.is('supplier_id', null);
  }

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const rows = (data ?? []) as unknown as Row[];

  if (includeAll) {
    return c.json({ rules: rows.map(rowToWire) });
  }

  // Reduce to "currently active per scope tuple". Scope = (base_model,
  // sorted-modules, tier, customer_id). The first row encountered per
  // tuple (already sorted DESC by effective_from then created_at) wins.
  const today = todayIso();
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const r of rows) {
    if (r.effective_from > today) continue;
    const key = JSON.stringify([
      r.base_model,
      comboSlotsKey(r.modules ?? []),
      r.tier,
      r.customer_id,
      r.supplier_id,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return c.json({ rules: out.map(rowToWire) });
});

// ── GET /history ───────────────────────────────────────────────────────
// All effective-dated rows for one scope tuple. Caller passes the same
// (baseModel, modules, tier, customerId) used to build a logical combo
// and gets every row's effectiveFrom + prices history.
sofaCombos.get('/history', async (c) => {
  const supabase = c.get('supabase');
  const baseModel = (c.req.query('baseModel') ?? '').trim();
  const tierRaw = (c.req.query('tier') ?? '').trim();
  const customerIdRaw = c.req.query('customerId');
  const supplierIdRaw = c.req.query('supplierId');
  const modulesRaw = c.req.query('modules');

  if (!baseModel) return c.json({ error: 'base_model_required' }, 400);
  if (!modulesRaw) return c.json({ error: 'modules_required' }, 400);

  // `modules` arrives as a JSON-encoded slot-set (string[][]). Fall back to
  // the legacy CSV flat form (`a,b,c`) so older callers keep working — each
  // code becomes a singleton slot via normalizeComboModules.
  let parsedModules: unknown;
  try {
    parsedModules = JSON.parse(modulesRaw);
  } catch {
    parsedModules = modulesRaw.split(',');
  }
  const wantedKey = comboSlotsKey(
    Array.isArray(parsedModules) ? (parsedModules as (string | string[])[]) : modulesRaw.split(','),
  );
  const tier = TIERS.has(tierRaw) ? (tierRaw as Tier) : null;

  let q = scopeToCompany(
    supabase
      .from('sofa_combo_pricing')
      .select(
        'id, base_model, modules, tier, customer_id, supplier_id, prices_by_height, selling_prices_by_height, pwp_prices_by_height, default_free_gifts, label, ' +
        'effective_from, deleted_at, notes, created_at, updated_at, created_by',
      )
      .eq('base_model', baseModel),
    c,
  )
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false });

  if (tier === null) q = q.is('tier', null);
  else q = q.eq('tier', tier);

  if (customerIdRaw === undefined || customerIdRaw === '' || customerIdRaw === 'null') {
    q = q.is('customer_id', null);
  } else {
    q = q.eq('customer_id', customerIdRaw);
  }

  // Supplier scope — same convention as GET /: provided = that supplier;
  // omitted / NULL sentinels = sales-side history (supplier_id IS NULL).
  if (supplierIdRaw !== undefined && supplierIdRaw !== '' && supplierIdRaw !== 'null') {
    q = q.eq('supplier_id', supplierIdRaw);
  } else {
    q = q.is('supplier_id', null);
  }

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const matching = ((data ?? []) as unknown as Row[]).filter((r) => {
    return comboSlotsKey(r.modules ?? []) === wantedKey;
  });

  return c.json({ rules: matching.map(rowToWire) });
});

// ── GET /anchors ─────────────────────────────────────────────────────────
// R8 — every base_model → anchored supplier mapping. SELECT is open (the combo
// UI reads this to drive the per-model anchor control + the write paths read it
// to decide whether to mirror). Declared BEFORE the `/:id` routes so the literal
// `/anchors` path always wins over the `:id` param matcher.
sofaCombos.get('/anchors', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await scopeToCompany(
    supabase
      .from('sofa_combo_anchor')
      .select('base_model, supplier_id'),
    c,
  )
    .order('base_model', { ascending: true });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ anchors: (data ?? []) as Array<{ base_model: string; supplier_id: string }> });
});

// ── PUT /anchors/:baseModel ───────────────────────────────────────────────
// R8 — set or clear the anchor for one base model. body { supplierId: string |
// null }. A non-empty supplierId UPSERTs the anchor (one row per base_model);
// null / empty deletes it (un-anchor). Write-gated like every combo mutation.
sofaCombos.put('/anchors/:baseModel', async (c) => {
  const gate = await requireWriteRole(c);
  if (!gate.ok) return gate.res;

  const baseModel = c.req.param('baseModel');
  if (!baseModel) return c.json({ error: 'base_model_required' }, 400);

  let body: { supplierId?: string | null };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const supabase = c.get('supabase');
  const user = c.get('user');
  const supplierId =
    typeof body.supplierId === 'string' && body.supplierId.trim() ? body.supplierId.trim() : null;

  if (supplierId) {
    const { error } = await supabase
      .from('sofa_combo_anchor')
      .upsert(
        {
          company_id: activeCompanyId(c),
          base_model: baseModel,
          supplier_id: supplierId,
          created_by: user.id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'company_id,base_model' },
      );
    if (error) {
      if (error.code === '42501' || /permission denied/i.test(error.message)) {
        return c.json({ error: 'forbidden', reason: error.message }, 403);
      }
      return c.json({ error: 'anchor_upsert_failed', reason: error.message }, 500);
    }
  } else {
    const { error } = await supabase.from('sofa_combo_anchor').delete().eq('base_model', baseModel).eq('company_id', activeCompanyId(c));
    if (error) {
      if (error.code === '42501' || /permission denied/i.test(error.message)) {
        return c.json({ error: 'forbidden', reason: error.message }, 403);
      }
      return c.json({ error: 'anchor_delete_failed', reason: error.message }, 500);
    }
  }

  return c.json({ ok: true });
});

// ── POST / ─────────────────────────────────────────────────────────────
// Create a new combo row. body: {
//   baseModel, modules: string[][], tier?: SofaPriceTier | null,
//   customerId?: uuid | null, pricesByHeight: { '<inch>': centi | null },
//   label?: string, effectiveFrom: 'YYYY-MM-DD', notes?: string
// }
// `modules` is the OR-set slot-set (string[][]); a flat string[] is also
// accepted for back-compat (each code → a singleton slot).
// Always INSERTs (append-only). To "edit" an existing combo, POST a new
// row with the same scope tuple + a fresher effectiveFrom.
sofaCombos.post('/', async (c) => {
  const gate = await requireWriteRole(c);
  if (!gate.ok) return gate.res;

  let body: {
    baseModel?: string;
    modules?: unknown;
    tier?: string | null;
    customerId?: string | null;
    supplierId?: string | null;
    pricesByHeight?: unknown;
    sellingPricesByHeight?: unknown;
    pwpPricesByHeight?: unknown;
    defaultFreeGifts?: Array<{ giftProductId: string; qty: number; campaignName?: string | null }>;
    label?: string | null;
    effectiveFrom?: string;
    notes?: string | null;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const baseModel = (body.baseModel ?? '').trim();
  if (!baseModel) return c.json({ error: 'base_model_required' }, 400);

  const modules = validateComboModules(body.modules);
  if (!modules) {
    return c.json({ error: 'modules_required' }, 400);
  }

  const tier =
    body.tier === null || body.tier === '' || body.tier === undefined
      ? null
      : TIERS.has(body.tier)
        ? (body.tier as Tier)
        : null;

  const customerId =
    body.customerId === null || body.customerId === '' || body.customerId === undefined
      ? null
      : body.customerId;

  // Supplier scope — null when absent = sales-side / master combo.
  const supplierId =
    body.supplierId === null || body.supplierId === '' || body.supplierId === undefined
      ? null
      : body.supplierId;

  const supabase = c.get('supabase');
  const user = c.get('user');

  // SELLING prices (Master Admin) — what the customer pays.
  const sellingProvided = body.sellingPricesByHeight !== undefined;
  const selling = sellingProvided ? validatePricesByHeight(body.sellingPricesByHeight) : null;
  if (sellingProvided && !selling) return c.json({ error: 'selling_prices_by_height_invalid' }, 400);

  // PWP (换购) SELLING price per height (Phase 2). POS-only; {} when unset → the
  // engine never overrides the normal selling price. Validated like selling.
  const pwpProvided = body.pwpPricesByHeight !== undefined;
  const pwpPrices = pwpProvided ? validatePricesByHeight(body.pwpPricesByHeight) : null;
  if (pwpProvided && !pwpPrices) return c.json({ error: 'pwp_prices_by_height_invalid' }, 400);

  // COST prices (Backend / PO benchmark). Three cases (Chairman 2026-05-31):
  //   1. client sends pricesByHeight        → use it (Backend keys / overrides).
  //   2. client omits it but sends selling  → AUTO-DETECT = Σ module SKU costs
  //      (base_price_sen) for every height the selling covers. A combo is just
  //      existing module SKUs assembled, so its cost = the sum of those SKUs'
  //      cost (auto key-in; Backend can override later via PUT). A height the
  //      module costs can't price stays null (no phantom cost).
  //   3. client omits both                  → reject (nothing to price).
  let prices: Record<string, number | null> | null;
  if (body.pricesByHeight !== undefined) {
    prices = validatePricesByHeight(body.pricesByHeight);
    if (!prices) return c.json({ error: 'prices_by_height_invalid' }, 400);
  } else if (selling) {
    const moduleCosts = await loadModelSofaModuleCosts(supabase, baseModel, activeCompanyId(c));
    const costSen = sofaComboCostSen(modules, moduleCosts); // sen == combo centi scale
    prices = {};
    for (const h of Object.keys(selling)) prices[h] = costSen > 0 ? costSen : null;
  } else {
    return c.json({ error: 'prices_by_height_required' }, 400);
  }

  // SELLING defaults to cost when not supplied (no silent free combo).
  const sellingPrices = selling ?? prices;

  // Never persist an all-null combo — there must be a price to charge. At least
  // one height needs a non-null SELLING value. The Create-Combo POS modal always
  // sends one; this rejects hand-crafted all-null payloads (Phase 5 review). COST
  // may stay null (auto-detect can miss / Backend overrides later) — only the
  // charged SELLING side is required.
  if (!Object.values(sellingPrices).some((v) => v !== null)) {
    return c.json({ error: 'selling_prices_all_null', message: 'At least one height needs a selling price' }, 400);
  }

  const effectiveFrom = (body.effectiveFrom ?? '').trim();
  if (!ISO_DATE.test(effectiveFrom)) {
    return c.json({ error: 'effective_from_required', message: 'YYYY-MM-DD' }, 400);
  }

  const { data, error } = await supabase
    .from('sofa_combo_pricing')
    .insert({
      company_id: activeCompanyId(c),
      base_model: baseModel,
      modules,
      tier,
      customer_id: customerId,
      supplier_id: supplierId,
      prices_by_height: prices,
      selling_prices_by_height: sellingPrices,
      pwp_prices_by_height: pwpPrices ?? {},
      default_free_gifts: Array.isArray(body.defaultFreeGifts)
        ? parseDefaultFreeGifts(body.defaultFreeGifts)
        : [],
      label: body.label ?? null,
      effective_from: effectiveFrom,
      notes: body.notes ?? null,
      created_by: user.id,
    })
    .select(
      'id, base_model, modules, tier, customer_id, supplier_id, prices_by_height, selling_prices_by_height, pwp_prices_by_height, default_free_gifts, label, ' +
      'effective_from, deleted_at, notes, created_at, updated_at, created_by',
    )
    .single();

  if (error) {
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }

  // R8 — if this base model is anchored to a supplier, mirror the just-saved
  // combo to the other side (master ⇄ that supplier). Best-effort: a mirror
  // failure leaves the primary row intact and just reports mirrored:false.
  const savedRow = data as unknown as Row;
  const anchor = await loadComboAnchor(supabase, baseModel, activeCompanyId(c));
  const mirrored = anchor ? await mirrorAnchoredCombo(supabase, savedRow, anchor, user.id, activeCompanyId(c)) : false;
  return c.json({ ...rowToWire(savedRow), mirrored }, 201);
});

// ── PUT /:id ───────────────────────────────────────────────────────────
// Convenience alias: edit by id = read the row's tuple + insert a NEW row
// with the supplied effectiveFrom / prices / etc. The caller can also use
// POST directly with the tuple — this just saves the round-trip when the
// UI already has a row id.
sofaCombos.put('/:id', async (c) => {
  const gate = await requireWriteRole(c);
  if (!gate.ok) return gate.res;

  const id = c.req.param('id');
  const supabase = c.get('supabase');

  const { data: orig, error: findErr } = await supabase
    .from('sofa_combo_pricing')
    .select('base_model, modules, tier, customer_id, supplier_id, selling_prices_by_height, pwp_prices_by_height, default_free_gifts')
    .eq('id', id)
    .maybeSingle();
  if (findErr) return c.json({ error: 'load_failed', reason: findErr.message }, 500);
  if (!orig) return c.json({ error: 'not_found' }, 404);

  let body: {
    pricesByHeight?: unknown;
    sellingPricesByHeight?: unknown;
    pwpPricesByHeight?: unknown;
    defaultFreeGifts?: Array<{ giftProductId: string; qty: number; campaignName?: string | null }>;
    label?: string | null;
    effectiveFrom?: string;
    notes?: string | null;
    supplierId?: string | null;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const prices = validatePricesByHeight(body.pricesByHeight);
  if (!prices) return c.json({ error: 'prices_by_height_invalid' }, 400);

  // SELLING prices (Master Admin). Audit (ported from 2990 21163bde) — the
  // Backend Combo Pricing COST editor sends ONLY pricesByHeight (no
  // sellingPricesByHeight). The old default (sellingPrices = the freshly-
  // submitted COST map) silently OVERWROTE the customer SELLING price with cost
  // on every cost edit, collapsing the charged price down to cost downstream
  // (comboChargedPrices) = silent revenue loss. Carry the ORIGINAL selling map
  // forward when the body omits it (mirrors the PWP carry-forward below); only an
  // explicit sellingPricesByHeight changes it. Falls back to the cost map only
  // for a legacy row that has no selling.
  const sellingPrices = body.sellingPricesByHeight === undefined
    ? ((orig as { selling_prices_by_height: Record<string, number | null> | null }).selling_prices_by_height ?? prices)
    : validatePricesByHeight(body.sellingPricesByHeight);
  if (!sellingPrices) return c.json({ error: 'selling_prices_by_height_invalid' }, 400);

  // Audit (ported from 2990 21163bde) — mirror the POST all-null guard: never
  // persist an all-null combo. An empty / all-null edit would become the newest
  // effective row and match no height in the lookup, silently disabling the
  // combo (build reverts to à-la-carte with no error).
  if (!Object.values(sellingPrices).some((v) => v !== null)) {
    return c.json({ error: 'selling_prices_all_null', message: 'At least one height needs a selling price' }, 400);
  }

  // PWP (换购) selling price (Phase 2). Append-only edit: carry the existing PWP
  // prices forward unless the body sets new ones, so editing the selling price
  // never wipes the combo's PWP price.
  const pwpPrices = body.pwpPricesByHeight === undefined
    ? ((orig as { pwp_prices_by_height: Record<string, number | null> | null }).pwp_prices_by_height ?? {})
    : validatePricesByHeight(body.pwpPricesByHeight);
  if (!pwpPrices) return c.json({ error: 'pwp_prices_by_height_invalid' }, 400);

  const effectiveFrom = (body.effectiveFrom ?? '').trim();
  if (!ISO_DATE.test(effectiveFrom)) {
    return c.json({ error: 'effective_from_required', message: 'YYYY-MM-DD' }, 400);
  }

  // Supplier scope is part of the combo's identity, so the new effective row
  // stays in the SAME supplier scope as the original (same as customer_id).
  // An explicit supplierId in the body may override it (null = sales-side).
  const supplierId =
    body.supplierId === undefined
      ? (orig as { supplier_id: string | null }).supplier_id
      : body.supplierId === null || body.supplierId === ''
        ? null
        : body.supplierId;

  const user = c.get('user');
  const { data, error } = await supabase
    .from('sofa_combo_pricing')
    .insert({
      company_id: activeCompanyId(c),
      base_model: (orig as { base_model: string }).base_model,
      modules:    (orig as { modules: ComboSlots }).modules,
      tier:       (orig as { tier: Tier }).tier,
      customer_id: (orig as { customer_id: string | null }).customer_id,
      supplier_id: supplierId,
      prices_by_height: prices,
      selling_prices_by_height: sellingPrices,
      pwp_prices_by_height: pwpPrices,
      default_free_gifts: Array.isArray(body.defaultFreeGifts)
        ? parseDefaultFreeGifts(body.defaultFreeGifts)
        : ((orig as { default_free_gifts: Array<{ giftProductId: string; qty: number; campaignName?: string | null }> | null }).default_free_gifts ?? []),
      label: body.label ?? null,
      effective_from: effectiveFrom,
      notes: body.notes ?? null,
      created_by: user.id,
    })
    .select(
      'id, base_model, modules, tier, customer_id, supplier_id, prices_by_height, selling_prices_by_height, pwp_prices_by_height, default_free_gifts, label, ' +
      'effective_from, deleted_at, notes, created_at, updated_at, created_by',
    )
    .single();

  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);

  // R8 — mirror the new effective row to the other side of the anchor when the
  // base model is anchored (master ⇄ supplier). Same best-effort contract as POST.
  const savedRow = data as unknown as Row;
  const anchor = await loadComboAnchor(supabase, (orig as { base_model: string }).base_model, activeCompanyId(c));
  const mirrored = anchor ? await mirrorAnchoredCombo(supabase, savedRow, anchor, user.id, activeCompanyId(c)) : false;
  return c.json({ ...rowToWire(savedRow), mirrored }, 201);
});

// ── DELETE /:id ────────────────────────────────────────────────────────
// Soft-delete. The History drawer still shows the row; pricing lookup
// skips it (the picker filters deleted_at IS NULL).
sofaCombos.delete('/:id', async (c) => {
  const gate = await requireWriteRole(c);
  if (!gate.ok) return gate.res;

  const id = c.req.param('id');
  const supabase = c.get('supabase');

  const { error } = await supabase
    .from('sofa_combo_pricing')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);

  if (error) {
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  return c.body(null, 204);
});

// ── Copy-to-customer endpoint removed 2026-05-28 ───────────────────────
// Commander dropped customer scoping for 2990's B2C model
// ("2990 是不需要的。因为是 B2C 直接 apply 给全顾客的"). The endpoint
// has no callers; deletion keeps the API surface honest.
