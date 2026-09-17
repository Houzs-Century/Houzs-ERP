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
import { autoDeriveEnabled } from '../lib/auto-derive-cost';
import { deriveMasterComboCostFromSuppliers, comboCostChanged, pickDearestSupplierCombo } from '../lib/derive-combo-cost';
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

  // ── Combo Pricing derive-status (A1) ──────────────────────────────────────
  // For the MASTER view (supplier_id IS NULL), tell each combo whether its COST
  // auto-derives from a supplier (and WHICH — the dearest whole set, same rule
  // as recomputeMasterComboCostFromSuppliers), or is a GAP (no supplier combo,
  // owner fills it in the binding), or is MANUAL (has cost, no supplier combo).
  // Gated on the auto-derive flag so a flag-OFF read is byte-identical to before.
  const scopeKeyOf = (r: Row) => JSON.stringify([r.base_model, comboSlotsKey(r.modules ?? []), r.tier, r.customer_id]);
  const isMasterView = !(supplierIdRaw !== undefined && supplierIdRaw !== '' && supplierIdRaw !== 'null');
  let winnerByScope: Map<string, { supplierId: string; supplierName: string | null }> | null = null;
  if (isMasterView && out.length > 0 && (await autoDeriveEnabled(supabase))) {
    let sq = scopeToCompany(
      supabase.from('sofa_combo_pricing')
        .select('base_model, modules, tier, customer_id, supplier_id, prices_by_height, effective_from, created_at')
        .is('deleted_at', null)
        .not('supplier_id', 'is', null),
      c,
    ).order('effective_from', { ascending: false }).order('created_at', { ascending: false });
    if (baseModel) sq = sq.eq('base_model', baseModel);
    if (customerIdRaw !== undefined) {
      if (customerIdRaw === '' || customerIdRaw === '__all__' || customerIdRaw === 'null') sq = sq.is('customer_id', null);
      else sq = sq.eq('customer_id', customerIdRaw);
    }
    const { data: supData, error: supErr } = await sq;
    // Best-effort enrichment: a failed supplier-combo read just omits the
    // derive-status — it never 500s the combo list.
    if (supErr) return c.json({ rules: out.map(rowToWire) });

    // Latest supplier row per (scope, supplier), then group by scope.
    const supSeen = new Set<string>();
    const byScope = new Map<string, Array<{ supplier_id: string; prices_by_height: Record<string, number | null> | null }>>();
    for (const r of ((supData ?? []) as unknown as Row[])) {
      if (r.effective_from > today || r.supplier_id == null) continue;
      const supKey = `${scopeKeyOf(r)}|${r.supplier_id}`;
      if (supSeen.has(supKey)) continue;
      supSeen.add(supKey);
      const sk = scopeKeyOf(r);
      const list = byScope.get(sk) ?? [];
      list.push({ supplier_id: r.supplier_id as string, prices_by_height: r.prices_by_height });
      byScope.set(sk, list);
    }

    const winnerIdByScope = new Map<string, string>();
    const wantedIds = new Set<string>();
    for (const [sk, combos] of byScope) {
      const w = pickDearestSupplierCombo(combos);
      if (w) { winnerIdByScope.set(sk, w.supplierId); wantedIds.add(w.supplierId); }
    }
    const nameById = new Map<string, string>();
    if (wantedIds.size > 0) {
      const { data: sup, error: nameErr } = await scopeToCompany(supabase.from('suppliers').select('id, name'), c).in('id', [...wantedIds]);
      // Best-effort: on a name-lookup failure the anchor still shows by id.
      if (!nameErr) for (const s of ((sup ?? []) as Array<{ id: string; name: string | null }>)) nameById.set(s.id, s.name ?? '');
    }
    winnerByScope = new Map();
    for (const [sk, supplierId] of winnerIdByScope) {
      winnerByScope.set(sk, { supplierId, supplierName: nameById.get(supplierId) ?? null });
    }
  }

  const gridHasCost = (g: unknown): boolean => {
    for (const v of Object.values((g ?? {}) as Record<string, unknown>)) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n) && n > 0) return true;
    }
    return false;
  };
  const withDeriveStatus = (r: Row) => {
    const wire = rowToWire(r);
    if (winnerByScope == null) return wire;
    const w = winnerByScope.get(scopeKeyOf(r));
    if (w) return { ...wire, costSource: 'auto', derivedFromSupplierId: w.supplierId, derivedFromSupplierName: w.supplierName };
    return {
      ...wire,
      costSource: gridHasCost(r.prices_by_height) ? 'manual' : 'gap',
      derivedFromSupplierId: null,
      derivedFromSupplierName: null,
    };
  };
  return c.json({ rules: out.map(withDeriveStatus) });
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


/* Auto-derive stage 5b (owner Option 1, COST-ONLY): after a SUPPLIER-scoped
   combo write, derive the MASTER combo's COST grid (prices_by_height) from the
   most-expensive supplier combo for the same scope tuple and append a master row
   — preserving the master's SELLING grid (selling_prices_by_height, POS). No
   supplier combo -> nothing derived (a gap the owner fills). This replaces the
   sofa_combo_anchor mirror. Best-effort; flag-gated by the caller. */
async function recomputeMasterComboCostFromSuppliers(
  supabase: SupabaseClient,
  savedRow: Row,
  companyId: number | null | undefined,
  createdBy: string,
): Promise<void> {
  try {
    const key = comboSlotsKey(savedRow.modules ?? []);
    const asOf = todayMyt();
    let q = supabase
      .from('sofa_combo_pricing')
      .select('supplier_id, modules, prices_by_height, selling_prices_by_height, pwp_prices_by_height, default_free_gifts, label, effective_from, created_at')
      .eq('base_model', savedRow.base_model)
      .eq('tier', savedRow.tier)
      .is('deleted_at', null)
      .lte('effective_from', asOf);
    if (companyId != null) q = q.eq('company_id', companyId);
    q = savedRow.customer_id == null ? q.is('customer_id', null) : q.eq('customer_id', savedRow.customer_id);
    const { data, error } = await q.order('effective_from', { ascending: false }).order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    const rows = ((data ?? []) as Row[]).filter((r) => comboSlotsKey(r.modules ?? []) === key);
    const latestSup = new Map<string, Row>();
    let master: Row | null = null;
    for (const r of rows) {
      if (r.supplier_id == null) { if (!master) master = r; }
      else if (!latestSup.has(r.supplier_id)) latestSup.set(r.supplier_id, r);
    }
    const derived = deriveMasterComboCostFromSuppliers(
      [...latestSup.values()].map((r) => ({ supplier_id: r.supplier_id as string, prices_by_height: r.prices_by_height })),
    );
    if (!derived) return;
    if (master && !comboCostChanged(master.prices_by_height, derived)) return;
    const { error: insErr } = await supabase.from('sofa_combo_pricing').insert({
      company_id: companyId,
      base_model: savedRow.base_model,
      modules: savedRow.modules,
      tier: savedRow.tier,
      customer_id: savedRow.customer_id,
      supplier_id: null,
      prices_by_height: derived,
      selling_prices_by_height: master?.selling_prices_by_height ?? {},
      pwp_prices_by_height: master?.pwp_prices_by_height ?? {},
      default_free_gifts: master?.default_free_gifts ?? [],
      label: master?.label ?? savedRow.label,
      effective_from: asOf,
      notes: 'auto-derived cost (max supplier)',
      created_by: createdBy,
    });
    if (insErr) throw new Error(insErr.message);
  } catch (e) {
    console.error('[auto-derive] master combo cost recompute failed:', e instanceof Error ? e.message : e);
  }
}

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
  let mirrored = false;
  // Auto-derive (flag-gated): a supplier-scope write derives the MASTER combo
  // COST from the most-expensive supplier (cost-only). The old sofa_combo_anchor
  // mirror is removed — 0 models were ever anchored, so it never fired, and the
  // derivation replaces it (owner 2026-09-16). `mirrored` stays for response
  // shape and is always false now.
  if (savedRow.supplier_id != null && (await autoDeriveEnabled(supabase))) {
    await recomputeMasterComboCostFromSuppliers(supabase, savedRow, activeCompanyId(c), user.id);
  }
  return c.json({ ...rowToWire(savedRow), mirrored }, 201);
});

// ── PUT /:id ───────────────────────────────────────────────────────────
// Convenience alias: edit by id = read the row's tuple + insert a NEW row
// with the supplied effectiveFrom / prices / etc. The caller can also use
// POST directly with the tuple — this just saves the round-trip when the
// UI already has a row id.
// Exported so a cross-tenant test can drive it without the supabaseAuth bridge.
export const sofaComboPutHandler = async (c: any) => {
  const gate = await requireWriteRole(c);
  if (!gate.ok) return gate.res;

  const id = c.req.param('id');
  const supabase = c.get('supabase');

  /* Company scope. sofa_combo_pricing carries company_id NOT NULL + FK since
     migration 0083, and requireWriteRole above checks the scm_config_write
     PERMISSION only — no tenancy. An unscoped read-by-id let this edit-by-id
     alias clone ANOTHER company's combo price into a new row for the active
     company. Mirror the scoped DELETE /:id below. */
  const { data: orig, error: findErr } = await scopeToCompany(supabase
    .from('sofa_combo_pricing')
    .select('base_model, modules, tier, customer_id, supplier_id, selling_prices_by_height, pwp_prices_by_height, default_free_gifts')
    .eq('id', id), c)
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

  // Auto-derive (flag-gated): a supplier-scope write derives the master combo
  // COST from the most-expensive supplier. Anchor mirror removed (see POST).
  const savedRow = data as unknown as Row;
  const mirrored = false;
  if (savedRow.supplier_id != null && (await autoDeriveEnabled(supabase))) {
    await recomputeMasterComboCostFromSuppliers(supabase, savedRow, activeCompanyId(c), user.id);
  }
  return c.json({ ...rowToWire(savedRow), mirrored }, 201);
};
sofaCombos.put('/:id', sofaComboPutHandler);

// ── DELETE /:id ────────────────────────────────────────────────────────
// Soft-delete. The History drawer still shows the row; pricing lookup
// skips it (the picker filters deleted_at IS NULL).
sofaCombos.delete('/:id', async (c) => {
  /* Company scope. sofa_combo_pricing carries company_id NOT NULL + FK since
     migration 0083, and requireWriteRole above checks the scm_config_write
     PERMISSION only — no tenancy — so an unscoped soft-delete by id retired
     another company's combo price. Verified 2026-08-13: read the gate, then the
     table's DDL, before changing anything. */
  const gate = await requireWriteRole(c);
  if (!gate.ok) return gate.res;

  const id = c.req.param('id');
  const supabase = c.get('supabase');

  const { error } = await scopeToCompany(supabase
    .from('sofa_combo_pricing')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id), c);

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
