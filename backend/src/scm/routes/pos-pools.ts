// ----------------------------------------------------------------------------
// /pos-pools — catalog + configurator read seam for the 2990 POS repoint.
//
// The POS (apps/pos) reads its whole catalog + configurator pools from this
// family. Before the cutover it hit 2990's API + direct Supabase; pointed at
// Houzs (VITE_BACKEND_TARGET=houzs) it reads here. Nine reads, company-scoped
// via X-Company-Id (POS = company 2):
//   GET /pos-pools/mfg-catalog[?id | ?modelId | ?baseModel&category]  <- spine
//   GET /pos-pools/product-size-variants?productId=
//   GET /pos-pools/size-library
//   GET /pos-pools/product-bundles?productId=
//   GET /pos-pools/product-compartments?productId=
//   GET /pos-pools/product-fabrics?productId=
//   GET /pos-pools/bedframe-colours
//   GET /pos-pools/product-bedframe-colours?productId=
//   GET /pos-pools/bedframe-options
//
// mfg-catalog is the live path (mfg_products + product_models embed); the eight
// pools back the legacy-retail configurator. Everything here is SELLING-only:
// cost columns (base_price_sen / price1_sen / cost_price_sen, and
// seat_height_prices[].priceSen) are never selected or emitted (#625). Units:
// mfg-catalog is in sen; the eight pools are whole MYR (their price/surcharge
// columns are int MYR, no cost column exists on any of them).
//
// Handlers are exported (like listMfgProductsHandler) so tests can drive them on
// a bare Hono app with an injected fake supabase + companyId.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { paginateAll } from '../lib/paginate-all';
import { scopeToCompany } from '../lib/companyScope';
import { comboSlotsKey, type ComboSlots } from '../shared';
import { todayMyt } from '../lib/my-time';
import type { Env, Variables } from '../env';

export const posPools = new Hono<{ Bindings: Env; Variables: Variables }>();

posPools.use('*', supabaseAuth);

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

// SELLING-only projection. cost_price_sen / base_price_sen / price1_sen are
// deliberately absent (#625) — the POS never needs them and they are cost.
// retail_product_id is added explicitly (the standard /mfg-products select
// omits it) so the POS's legacy-UUID bridge can resolve.
export const MFG_CATALOG_COLS =
  'id, code, name, category, description, branding, size_label, size_code, ' +
  'sell_price_sen, pwp_price_sen, seat_height_prices, included_addons, ' +
  'base_model, model_id, retail_product_id, status, pos_active, ' +
  'product_models(id, name, model_code, photo_url, active, allowed_options)';

// seat_height_prices holds a per-height COST (priceSen) next to the selling
// side (sellingPriceSen). Strip the cost per entry, keep {height,tier,sellingPriceSen}.
function stripSeatHeightCost(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => {
    if (r && typeof r === 'object' && 'priceSen' in (r as Record<string, unknown>)) {
      const { priceSen, ...rest } = r as Record<string, unknown>;
      void priceSen;
      return rest;
    }
    return r;
  });
}

// ── GET /mfg-catalog ─────────────────────────────────────────────────────────
// The catalog spine + configurator loader. Four mutually-exclusive variants
// share ONE row shape; only the filter differs. Precedence id > modelId >
// baseModel > spine. HARD RULE: the id/modelId/baseModel variants must NOT
// filter on status/pos_active — a discontinued (status=INACTIVE) but pos_active
// sibling has to survive so the size picker keeps every size (greyed
// client-side). Only the paramless spine filters to pos_active=true (any status).
export const mfgCatalogHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const id = c.req.query('id');
  const modelId = c.req.query('modelId');
  const baseModel = c.req.query('baseModel');
  const category = c.req.query('category');

  const { data, error } = await paginateAll((from, to) => {
    let q = supabase.from('mfg_products').select(MFG_CATALOG_COLS);
    if (id) {
      q = q.eq('id', id);
    } else if (modelId) {
      q = q.eq('model_id', modelId);
    } else if (baseModel) {
      q = q.eq('base_model', baseModel);
      if (category) q = q.eq('category', category);
    } else {
      q = q.eq('pos_active', true);
    }
    q = scopeToCompany(q, c);
    return q.order('code', { ascending: true }).range(from, to);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const products = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((p) => ({
    ...p,
    seat_height_prices: stripSeatHeightCost(p.seat_height_prices),
  }));
  // Short PRIVATE cache like /mfg-products; Vary on X-Company-Id so a company
  // switch does not serve the other company's cached catalogue.
  c.header('cache-control', 'private, max-age=60');
  c.header('vary', 'X-Company-Id');
  return c.json({ products });
};
posPools.get('/mfg-catalog', mfgCatalogHandler);

// ── legacy-retail configurator pools ─────────────────────────────────────────
// Each backs one 2990 direct-Supabase read; whole-MYR selling values, no cost
// column exists on any of these tables. All company-scoped. productId-scoped
// pools return [] when the param is absent (mfg-* ids short-circuit client-side
// before ever calling; only legacy-UUID products reach these).

export const productSizeVariantsHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const productId = c.req.query('productId');
  if (!productId) return c.json({ rows: [] });
  const { data, error } = await scopeToCompany(
    supabase.from('product_size_variants').select('size_id, active, price').eq('product_id', productId),
    c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = ((data ?? []) as Array<{ size_id: string; active: boolean; price: number }>).map((r) => ({
    sizeId: r.size_id,
    active: r.active,
    price: r.price,
    pwpPrice: null,
  }));
  return c.json({ rows });
};
posPools.get('/product-size-variants', productSizeVariantsHandler);

export const sizeLibraryHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const { data, error } = await scopeToCompany(
    supabase.from('size_library').select('id, label, width_cm, length_cm, sort_order').order('sort_order'),
    c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = ((data ?? []) as Array<{ id: string; label: string; width_cm: number; length_cm: number; sort_order: number }>).map((r) => ({
    id: r.id,
    label: r.label,
    widthCm: r.width_cm,
    lengthCm: r.length_cm,
    sortOrder: r.sort_order,
  }));
  return c.json({ rows });
};
posPools.get('/size-library', sizeLibraryHandler);

export const productBundlesHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const productId = c.req.query('productId');
  if (!productId) return c.json({ rows: [] });
  const { data, error } = await scopeToCompany(
    supabase.from('product_bundles').select('bundle_id, active, price').eq('product_id', productId),
    c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = ((data ?? []) as Array<{ bundle_id: string; active: boolean; price: number }>).map((r) => ({
    bundleId: r.bundle_id,
    active: r.active,
    price: r.price,
  }));
  return c.json({ rows });
};
posPools.get('/product-bundles', productBundlesHandler);

export const productCompartmentsHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const productId = c.req.query('productId');
  if (!productId) return c.json({ rows: [] });
  const { data, error } = await scopeToCompany(
    supabase.from('product_compartments').select('compartment_id, active, price').eq('product_id', productId),
    c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = ((data ?? []) as Array<{ compartment_id: string; active: boolean; price: number }>).map((r) => ({
    compartmentId: r.compartment_id,
    active: r.active,
    price: r.price,
  }));
  return c.json({ rows });
};
posPools.get('/product-compartments', productCompartmentsHandler);

export const productFabricsHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const productId = c.req.query('productId');
  if (!productId) return c.json({ rows: [] });
  const { data, error } = await scopeToCompany(
    supabase.from('product_fabrics').select('fabric_id, active, surcharge').eq('product_id', productId),
    c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = ((data ?? []) as Array<{ fabric_id: string; active: boolean; surcharge: number }>).map((r) => ({
    fabricId: r.fabric_id,
    active: r.active,
    surcharge: r.surcharge,
  }));
  return c.json({ rows });
};
posPools.get('/product-fabrics', productFabricsHandler);

export const bedframeColoursHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const { data, error } = await scopeToCompany(
    supabase.from('bedframe_colours').select('id, label, swatch_hex, surcharge, sort_order').eq('active', true).order('sort_order'),
    c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = ((data ?? []) as Array<{ id: string; label: string; swatch_hex: string | null; surcharge: number; sort_order: number }>).map((r) => ({
    id: r.id,
    label: r.label,
    swatchHex: r.swatch_hex,
    surcharge: r.surcharge,
    sortOrder: r.sort_order,
  }));
  return c.json({ rows });
};
posPools.get('/bedframe-colours', bedframeColoursHandler);

export const productBedframeColoursHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const productId = c.req.query('productId');
  if (!productId) return c.json({ rows: [] });
  const { data, error } = await scopeToCompany(
    supabase.from('product_bedframe_colours').select('colour_id, active').eq('product_id', productId),
    c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = ((data ?? []) as Array<{ colour_id: string; active: boolean }>).map((r) => ({
    colourId: r.colour_id,
    active: r.active,
  }));
  return c.json({ rows });
};
posPools.get('/product-bedframe-colours', productBedframeColoursHandler);

export const bedframeOptionsHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const { data, error } = await scopeToCompany(
    supabase.from('bedframe_options').select('id, kind, value, surcharge, sort_order').eq('active', true).order('sort_order'),
    c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = ((data ?? []) as Array<{ id: string; kind: string; value: string; surcharge: number; sort_order: number }>).map((r) => ({
    id: r.id,
    kind: r.kind,
    value: r.value,
    surcharge: r.surcharge,
    sortOrder: r.sort_order,
  }));
  return c.json({ rows });
};
posPools.get('/bedframe-options', bedframeOptionsHandler);

// ── GET /sofa-combos ─────────────────────────────────────────────────────
// Cost-stripped Sofa Combo pricing for the POS. The admin /sofa-combos route is
// DELIBERATELY not openRead — its GET returns prices_by_height (the PO-benchmark
// COST) + supplier_id, a supplier-cost leak (class #625). The POS needs the
// CHARGED price only: selling merged over cost — the SAME merge the server SO-time
// recompute + drift gate use (comboChargedPrices). So we compute charged =
// selling ?? cost SERVER-side and emit it as sellingPricesByHeight with
// pricesByHeight = {}; the POS's own comboChargedPrices(selling, {}) resolves to
// exactly that, so POS live total == server recompute (no false drift-reject),
// and raw cost / supplierId / internal notes never leave the server. All 137
// company_2 combos carry selling prices (verified 2026-07-20), so the merge only
// ever surfaces the sell side. Master/sales combos only (supplier_id IS NULL);
// reduced to the active row per scope tuple (same reducer as the admin GET /).
type ComboPricingRow = {
  id: string;
  base_model: string;
  modules: ComboSlots;
  tier: 'PRICE_1' | 'PRICE_2' | 'PRICE_3' | null;
  customer_id: string | null;
  prices_by_height: Record<string, number | null> | null;
  selling_prices_by_height: Record<string, number | null> | null;
  pwp_prices_by_height: Record<string, number | null> | null;
  default_free_gifts: unknown;
  label: string | null;
  effective_from: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
};

// charged = selling ?? cost per height — mirrors @2990s/shared comboChargedPrices
// so the POS sees the identical number the server recompute charges.
function comboChargedByHeight(
  selling: Record<string, number | null> | null,
  cost: Record<string, number | null> | null,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const h of new Set([...Object.keys(selling ?? {}), ...Object.keys(cost ?? {})])) {
    const s = selling?.[h];
    out[h] = s !== null && s !== undefined ? s : (cost?.[h] ?? null);
  }
  return out;
}

export const sofaCombosPosHandler = async (c: AppContext) => {
  const supabase = c.get('supabase');
  const baseModel = (c.req.query('baseModel') ?? '').trim();
  const customerIdRaw = c.req.query('customerId');

  let q = scopeToCompany(
    supabase
      .from('sofa_combo_pricing')
      .select(
        'id, base_model, modules, tier, customer_id, prices_by_height, ' +
          'selling_prices_by_height, pwp_prices_by_height, default_free_gifts, label, ' +
          'effective_from, created_at, updated_at, created_by',
      )
      .is('deleted_at', null)
      .is('supplier_id', null),
    c,
  )
    .order('base_model', { ascending: true })
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false });

  if (baseModel) q = q.eq('base_model', baseModel);
  if (customerIdRaw !== undefined && customerIdRaw !== '' && customerIdRaw !== '__all__' && customerIdRaw !== 'null') {
    q = q.eq('customer_id', customerIdRaw);
  } else {
    q = q.is('customer_id', null);
  }

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const today = todayMyt();
  const seen = new Set<string>();
  const rules: unknown[] = [];
  for (const r of (data ?? []) as unknown as ComboPricingRow[]) {
    if (r.effective_from > today) continue; // future-dated not yet active
    const key = JSON.stringify([r.base_model, comboSlotsKey(r.modules ?? []), r.tier, r.customer_id]);
    if (seen.has(key)) continue; // first (latest-effective) per tuple wins
    seen.add(key);
    rules.push({
      id: r.id,
      baseModel: r.base_model,
      modules: r.modules ?? [],
      tier: r.tier,
      customerId: r.customer_id,
      supplierId: null, // withheld — never reveal which supplier to the POS
      pricesByHeight: {}, // cost stripped; the charged value rides sellingPricesByHeight
      sellingPricesByHeight: comboChargedByHeight(r.selling_prices_by_height, r.prices_by_height),
      pwpPricesByHeight: r.pwp_prices_by_height ?? {},
      defaultFreeGifts: r.default_free_gifts ?? [],
      label: r.label,
      effectiveFrom: r.effective_from,
      deletedAt: null,
      notes: '', // internal notes withheld
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      createdBy: r.created_by,
    });
  }
  return c.json({ rules });
};
posPools.get('/sofa-combos', sofaCombosPosHandler);
