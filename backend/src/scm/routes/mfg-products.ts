// ----------------------------------------------------------------------------
// /mfg-products — Manufacturer SKU master (HOOKKA port).
//
// Separate from /products (the retail/POS catalogue). Wires into the
// Products & Maintenance page in apps/backend.
//
// Endpoints:
//   GET  /mfg-products?category=BEDFRAME&search=hilton
//   GET  /mfg-products/:id
//   PATCH /mfg-products/:id   body: { basePriceSen?, price1Sen?, ..., notes? }
//
// CREATE is intentionally deferred to a follow-up — most SKUs come from
// the Excel import. Inline create in the UI hits POST /mfg-products once
// we add a `create_mfg_product_with_history` RPC (mirrors the retail
// /products POST pattern at apps/api/src/routes/products.ts:37).
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseAuth } from '../middleware/auth';
import { escapeForOr } from '../lib/postgrest-search';
import { paginateAll } from '../lib/paginate-all';
import { findSkuUsage, usageCheckFailedBody } from '../lib/sku-usage';
import { productToBindingPatch, type ProductSeatCost } from '../lib/cost-anchor-sync';
import { moduleCodeFromSku, normalizeSofaTier, parseDefaultFreeGifts } from '../shared';
import { canWriteScmConfig, canViewScmProductCost } from '../lib/houzs-perms';
import { PRODUCT_FINANCE_KEYS, stripProductPriceHistory } from '../lib/finance-keys';
import { scopeToCompany, activeCompanyId,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY,
  detailMissResponse } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import { resolveSellPriceSenAsOf, resolvePendingSellPriceAfter } from '../lib/product-pricing-history';
import type { Env, Variables } from '../env';

export const mfgProducts = new Hono<{ Bindings: Env; Variables: Variables }>();

mfgProducts.use('*', supabaseAuth);

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

// mfg_products has NO RLS — this app-layer gate is the only thing stopping a
// junior salesperson from rewriting SKU prices/data via a direct API call (the
// POS productsMode client gate is bypassable). Houzs-flavoured: gate via
// canWriteScmConfig against the REAL caller — satisfied by EITHER the flat
// permission key `scm.config.write` (Owner + IT pass via `*`; any role granted
// the key) OR the caller's POSITION policy canWriteConfig flag (the
// operation/purchasing cohort — Procurement/Purchasing et al. — positionPolicy.ts
// CONFIG_WRITE_POSITIONS). The 2990 staff_role lookup is dead in Houzs (the SCM
// bridge pins every caller to one super_admin row).
// GET stays open — the POS salesperson must read the catalogue to price builds.

async function requireRole(c: AppContext): Promise<{ ok: true } | { ok: false; res: Response }> {
  if (!canWriteScmConfig(c)) {
    return { ok: false, res: c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403) };
  }
  return { ok: true };
}

// Allowed values for the `field` column on master_price_history.
const PRICE_FIELDS = new Set(['base_price_sen', 'price1_sen', 'cost_price_sen', 'sell_price_sen', 'pwp_price_sen']);

/* ── Cost anchor (migration 0177; sofa one-way 2026-07-20) ─────────────────
   The product→binding leg of R8-at-SKU-level. After a product's COST
   (base_price_sen / price1_sen, or a SOFA seat_height_prices cost slot) is
   written, if a supplier_material_bindings row for this code is the cost anchor
   (is_cost_anchor=true), mirror the product cost onto that binding so the two
   sides stay equal. BEST-EFFORT: the product write already committed, so any
   failure here is swallowed. The mirror targets the binding row directly — it
   does NOT re-enter mfg-products PATCH, so there's no sync loop.

   SOFA: the product record is authoritative (owner "我这用的是产品档"), so this
   ONE-WAY push carries the product's seat_height_prices cost grid onto the
   binding's price_matrix; the reverse leg (bindingToProductPatch) stays skipped
   for sofa so a supplier edit can't overwrite the product.

   MULTI-SUPPLIER: the push targets the single is_cost_anchor binding (the
   owner's designated primary — "我锚定一个 supplier"), same as every other
   category. A sofa bound to a NON-anchor supplier keeps its own binding matrix
   (the PO cost path reads each supplier's own binding). Broadening the push to
   all bindings is an owner decision — see the PR flag. */
async function syncAnchorBindingFromProduct(
  supabase: SupabaseClient,
  productCode: string,
  product: {
    base_price_sen: number | null;
    price1_sen: number | null;
    seat_height_prices?: ProductSeatCost[] | null;
  },
  companyId?: number,
): Promise<void> {
  try {
    // The anchor binding for this code (at most one — enforced app-side).
    // Multi-company: material_code is shared across companies, so pin to the
    // active company or the maybeSingle() could resolve the other company's row.
    let bindingQ = supabase
      .from('supplier_material_bindings')
      .select('id, price_matrix')
      .eq('material_kind', 'mfg_product')
      .eq('material_code', productCode)
      .eq('is_cost_anchor', true);
    if (companyId != null) bindingQ = bindingQ.eq('company_id', companyId);
    const { data: binding } = await bindingQ.maybeSingle();
    if (!binding) return;

    // Category drives the mapping lane — read it off the product row we just
    // updated (passed in so we don't re-query mfg_products).
    let prodQ = supabase
      .from('mfg_products')
      .select('category')
      .eq('code', productCode);
    if (companyId != null) prodQ = prodQ.eq('company_id', companyId);
    const { data: prod } = await prodQ.maybeSingle();

    const result = productToBindingPatch(
      {
        base_price_sen: product.base_price_sen,
        price1_sen: product.price1_sen,
        seat_height_prices: product.seat_height_prices ?? null,
      },
      {
        category: (prod as { category: string | null } | null)?.category ?? null,
        price_matrix: (binding as { price_matrix: unknown }).price_matrix,
      },
    );
    if (result.skipped) return;
    if (Object.keys(result.patch).length === 0) return;

    await supabase
      .from('supplier_material_bindings')
      .update({ ...result.patch, updated_at: new Date().toISOString() })
      .eq('id', (binding as { id: string }).id);
  } catch {
    // Best-effort mirror — never surface to the primary product write.
  }
}

// ── GET / ──────────────────────────────────────────────────────────────
export const listMfgProductsHandler = async (c: AppContext) => {
  const category = c.req.query('category');
  const search = c.req.query('search');
  const supabase = c.get('supabase');

  // PR #104 — Commander 2026-05-26: dropped fabric_usage_centi /
  // production_time_minutes / fabric_color from the public shape. The
  // columns still exist in the DB (historical data preserved) but
  // 2990's retail catalogue doesn't surface or write them anymore.
  // PostgREST caps a single response at 1000 rows even without a .limit(), so
  // the ACTIVE SKU master (1141 rows live) was silently truncated to 1000.
  // Page through with .range() and concatenate the lot.
  const s = search ? escapeForOr(search) : '';
  /* 防呆 — cost_price_sen IS NOT IN THIS SELECT, AND ITS ABSENCE IS THE GATE.
     There is no canViewScmProductCost strip below because there is nothing to
     strip: unlike GET /:id (select('*'), so it needs one), this select is an
     explicit column allowlist and cost has never been on it (#673 verified the
     same thing: "The LIST endpoint never selected cost_price_sen").

     IF YOU ADD IT — and the obvious ask is "Purchasing wants cost on the SKU
     Master" — add the strip in the SAME edit, or you hand every products reader
     a number the owner ruled is for Purchasing + Finance + Sales Director only
     (2026-07-17). The gate already exists and is one line; copy GET /:id:
         if (!canViewScmProductCost(c)) for (const k of PRODUCT_FINANCE_KEYS) delete p[k];
     Both are already imported at the top of this file.

     NOT a claim that this route is cost-free. seat_height_prices (below) IS a
     per-height COST and does ride this select to every caller — finance-keys.ts
     records why it cannot be stripped blind (the sofa chain resolves a CHARGED
     price through the same field, so a blind strip reprices a build). That one
     needs the owner's ruling, not a strip. */
  const { data, error } = await paginateAll((from, to) => {
    let q = supabase
      .from('mfg_products')
      .select(
        'id, code, name, category, description, base_model, size_code, size_label, base_price_sen, price1_sen, sell_price_sen, pwp_price_sen, ' +
          'unit_m3_milli, status, pos_active, one_shot, source_doc_no, included_addons, sku_code, model_id, ' +
          'branding, barcode, sub_assemblies, pieces, seat_height_prices, default_variants, updated_at, ' +
          // Commander 2026-05-29 — surface the Model's allowed_options so the SO
          // line editor can hide variant choices the SKU doesn't allow (instead
          // of letting them be picked and failing on save with variant_not_allowed).
          'model:product_models(allowed_options)',
      )
      .eq('status', 'ACTIVE')
      .order('code', { ascending: true });
    if (category) q = q.eq('category', category);
    // 0166 — barcode rides the same OR-chain so a scanner blast into the SKU
    // Master search box finds the row (escapeForOr keeps the grammar safe).
    if (s) q = q.or(`code.ilike.%${s}%,name.ilike.%${s}%,description.ilike.%${s}%,barcode.ilike.%${s}%`);
    q = scopeToCompany(q, c); // multi-company: mfg_products are per-company
    return q.range(from, to);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  // Flatten the joined model → a plain allowed_options field on each product.
  const products = ((data ?? []) as unknown as Array<Record<string, unknown> & { model?: { allowed_options: unknown } | Array<{ allowed_options: unknown }> | null }>)
    .map(({ model, ...p }) => {
      const m = Array.isArray(model) ? model[0] : model;
      return { ...p, allowed_options: m?.allowed_options ?? null };
    });
  /* Perf (go-live) — the 1141-row SKU master is the catalog picker every SO /
     PO / GRN / DO "new" page loads, and it changes rarely (price/config edits,
     not per-order). A short PRIVATE max-age lets the browser reuse the payload
     across a burst of page opens without a fresh 2-page paginate round-trip,
     while staying per-user (never shared/CDN) and short enough that a
     commander price edit shows within a minute. Follows the existing
     `private, max-age` header convention used elsewhere in this router. */
  c.header('cache-control', 'private, max-age=60');
  /* Multi-company (fix/so-product-company-scope): the 60s PRIVATE cache is keyed
     by URL only, but the ACTIVE company travels in the X-Company-Id REQUEST header
     (authed-fetch.ts stamps it from the top-bar switcher). WITHOUT Vary, the
     browser reuses the PREVIOUS company's cached catalogue for up to a minute
     after a switch — TopNavbar does window.location.reload(), but a reload does
     NOT bypass a still-fresh fetch response. That is the owner-reported "the SO
     product picker shows the other company's products, both directions" leak: the
     query IS company-scoped (scopeToCompany above), the CACHED RESPONSE is the
     stale one. Vary partitions the private cache per active company so a switch
     misses and refetches the correct list. See BUG-HISTORY.md 2026-07-19. */
  c.header('vary', 'X-Company-Id');
  return c.json({ products });
};
mfgProducts.get('/', listMfgProductsHandler);

// ── POST / ─────────────────────────────────────────────────────────────
// Create a new mfg_product. id is text PK — we generate a short uuid-ish
// id since the existing import uses Excel-style ids like 'mfg-xxxxxxx'.
/* The `mfg_product_category` PG enum, in declaration order. This is the ONE
   in-repo statement of that taxonomy — the HR item-KPI category picker imports
   it rather than re-listing the values, so a rule can never offer a category the
   column cannot hold. Keep in step with the enum if it ever gains a member. */
export const MFG_PRODUCT_CATEGORIES = ['SOFA', 'BEDFRAME', 'ACCESSORY', 'MATTRESS', 'BEDLINES', 'DINING', 'DIFFUSER', 'CARPET', 'SERVICE'] as const;
const VALID_CATEGORIES = new Set<string>(MFG_PRODUCT_CATEGORIES);
mfgProducts.post('/', async (c) => {
  const gate = await requireRole(c);
  if (!gate.ok) return gate.res;
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const code = String(body.code ?? '').trim();
  const name = String(body.name ?? '').trim();
  const category = String(body.category ?? '').trim();
  if (!code)  return c.json({ error: 'code_required' }, 400);
  if (!name)  return c.json({ error: 'name_required' }, 400);
  if (!VALID_CATEGORIES.has(category)) return c.json({ error: 'invalid_category', allowed: [...VALID_CATEGORIES] }, 400);

  const supabase = c.get('supabase');
  // Generate a stable id matching the existing seed convention. crypto is
  // global in CF Workers; fall back if absent.
  const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const id = `mfg-${rand.replace(/-/g, '').slice(0, 12)}`;

  const row: Record<string, unknown> = {
    id,
    code,
    name,
    category,
    status: 'ACTIVE',
    description: (body.description as string) ?? null,
    base_model: (body.baseModel as string) ?? null,
    size_code: (body.sizeCode as string) ?? null,
    size_label: (body.sizeLabel as string) ?? null,
    base_price_sen: body.basePriceSen == null ? null : Number(body.basePriceSen),
    price1_sen: body.price1Sen == null ? null : Number(body.price1Sen),
    cost_price_sen: body.costPriceSen == null ? 0 : Number(body.costPriceSen),
    unit_m3_milli: body.unitM3Milli == null ? 0 : Number(body.unitM3Milli),
    branding: (body.branding as string) ?? null,
    // 0166 — optional free-text barcode on create.
    barcode: typeof body.barcode === 'string' && body.barcode.trim() ? body.barcode.trim() : null,
    /* PR #104 — fabric_usage_centi / production_time_minutes /
       fabric_color removed (not used by 2990's retail catalogue). */
  };

  const { data, error } = await supabase.from('mfg_products').insert({ ...row, company_id: activeCompanyId(c) }).select('id, code').single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_code', reason: error.message }, 409);
    /* DEAD BRANCH -- here and at EVERY other 42501 site in this file. 42501 is
       Postgres permission-denied, i.e. RLS, and RLS cannot fire on this path: mig
       0061 enabled RLS on every scm table with NO policies, and the SCM client is
       the SERVICE-ROLE client (scm/middleware/auth.ts:93 -> db/supabase.ts
       getSupabaseService), which bypasses RLS by design. No scm function RAISEs
       42501 either -- the live tree's only ERRCODE is 22023. Do NOT read this as a
       permission check and do NOT treat it as scoping: the only boundary is this
       route's own predicate. (docs/audit-2026-08-13-ledger.md K1) */
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json(data, 201);
});

// ── POST /batch-import ─────────────────────────────────────────────────
// Bulk upsert from a CSV import. Body: { rows: [{ code, name, category, ... }] }.
// Upserts by code (ON CONFLICT DO UPDATE). Returns count inserted/updated.
mfgProducts.post('/batch-import', async (c) => {
  const gate = await requireRole(c);
  if (!gate.ok) return gate.res;
  let body: { rows?: Array<Record<string, unknown>> };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const list = body.rows ?? [];
  if (list.length === 0) return c.json({ error: 'rows_required' }, 400);
  if (list.length > 500) return c.json({ error: 'too_many', message: 'Max 500 rows per import' }, 400);

  const supabase = c.get('supabase');
  let upserted = 0;
  const failures: Array<{ code: string; reason: string }> = [];

  // Data-loss-safe upsert (Wei Siang). Only fields PRESENT and non-empty in
  // the body row are written. On an ON CONFLICT update that means a column the
  // operator left blank in the CSV is NOT touched — so re-importing an edited
  // export can never zero a price or wipe a description. On a fresh INSERT,
  // the omitted columns fall back to their DB defaults.
  const hasVal = (v: unknown): boolean => v != null && v !== '';
  for (const r of list) {
    const code = String(r.code ?? '').trim();
    const name = String(r.name ?? '').trim();
    const category = String(r.category ?? '').trim();
    if (!code || !name || !VALID_CATEGORIES.has(category)) {
      failures.push({ code, reason: 'missing code/name or invalid category' });
      continue;
    }
    const row: Record<string, unknown> = { code, name, category };

    // String fields — include only when the cell actually has a value.
    if (hasVal(r.status))      row.status = String(r.status);
    if (hasVal(r.description)) row.description = String(r.description);
    if (hasVal(r.base_model))  row.base_model = String(r.base_model);
    if (hasVal(r.size_label))  row.size_label = String(r.size_label);
    if (hasVal(r.branding))    row.branding = String(r.branding);

    // Numeric (sen / milli) fields — include only when present. No ?? 0
    // default, so a blank cell leaves the stored number untouched on update.
    if (hasVal(r.base_price_sen)) row.base_price_sen = Number(r.base_price_sen);
    if (hasVal(r.price1_sen))     row.price1_sen = Number(r.price1_sen);
    if (hasVal(r.unit_m3_milli))  row.unit_m3_milli = Number(r.unit_m3_milli);

    // Sofa per (size × tier) prices — JSONB array. Accept either camelCase
    // (frontend import) or snake_case.
    type SeatEntry = { height: string; priceSen: number; tier?: string };
    const seatRaw = (r.seatHeightPrices ?? r.seat_height_prices) as unknown;
    const rawSeat = (Array.isArray(seatRaw) ? seatRaw : []) as SeatEntry[];
    // Recognise + canonicalise each price's tier (P2 / "Price 2" / 2 → PRICE_2).
    // Missing tier = legacy → PRICE_2; an UNrecognisable one rejects the whole
    // row so a mislabelled price can never land in the wrong tier.
    let badTier: string | null = null;
    const incomingSeat: SeatEntry[] = [];
    for (const e of rawSeat) {
      const t = (e.tier == null || e.tier === '') ? 'PRICE_2' : normalizeSofaTier(e.tier);
      if (!t) { badTier = String(e.tier); break; }
      incomingSeat.push({ ...e, tier: t });
    }
    if (badTier !== null) {
      failures.push({ code, reason: `price tier "${badTier}" not recognized — use P1, P2, or P3` });
      continue;
    }
    const tierOf = (e: SeatEntry) => e.tier ?? 'PRICE_2';

    // Never rewrite the PK id on re-import: UPDATE an existing SKU by code (id +
    // any omitted column left untouched), INSERT a brand-new SKU with a fresh id.
    const { data: existing } = await supabase.from('mfg_products')
      .select('id, seat_height_prices').eq('code', code).eq('company_id', activeCompanyId(c)).maybeSingle();
    let error;
    if (existing) {
      // Merge sofa prices BY TIER: the export ships one tier at a time, so an
      // import must only replace the tiers it carries and leave the other tiers
      // (P1/P2/P3) on the SKU untouched — never wipe them.
      if (incomingSeat.length > 0) {
        const incomingTiers = new Set(incomingSeat.map(tierOf));
        const existingSeat = (Array.isArray((existing as { seat_height_prices?: unknown }).seat_height_prices)
          ? (existing as { seat_height_prices: SeatEntry[] }).seat_height_prices
          : []);
        const kept = existingSeat.filter((e) => !incomingTiers.has(tierOf(e)));
        row.seat_height_prices = [...kept, ...incomingSeat];
      }
      ({ error } = await supabase.from('mfg_products').update(row).eq('code', code).eq('company_id', activeCompanyId(c)));
    } else {
      if (incomingSeat.length > 0) row.seat_height_prices = incomingSeat;
      const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const id = `mfg-${rand.replace(/-/g, '').slice(0, 12)}`;
      ({ error } = await supabase.from('mfg_products').insert({ ...row, id, company_id: activeCompanyId(c) }));
    }
    if (error) {
      failures.push({ code, reason: error.message });
    } else {
      upserted += 1;
    }
  }

  return c.json({ upserted, failed: failures.length, failures: failures.slice(0, 50) });
});

// ── DELETE /:id ────────────────────────────────────────────────────────
// PR #82 (Commander 2026-05-26) — SKU Master multi-select delete needs a
// per-row DELETE endpoint. Bulk delete = N parallel DELETE calls from the
// client (matches the pattern PR #62 used for fabric_trackings wipe).
//
// PR #94 (Commander 2026-05-26) — `?force=true` query flag. Test SKUs that
// have lingering inventory_stock_lots / inventory_movements / supplier_
// material_bindings rows from earlier QA reject the plain DELETE with a
// 23503 FK violation. Force mode wipes those side-tables first (by
// material_code / product_code) then drops the SKU row. Front-end exposes
// it as a follow-up "Force delete" button after a normal delete fails so
// commander never destroys side data unintentionally.
export const deleteMfgProductHandler = async (c: any) => {
  const gate = await requireRole(c);
  if (!gate.ok) return gate.res;
  const id    = c.req.param('id');
  const force = c.req.query('force') === 'true';
  const supabase = c.get('supabase');
  /* Multi-company: a delete (and its force-cleanup) must act only on THIS
     company's SKU. Resolve the active company strictly up front — a delete
     across all companies on an unresolved context is exactly the trade the
     write helpers refuse. Scope the load so a blind id from another company
     reads as not-found. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  // Resolve the SKU code up front — needed for both the usage guard and the
  // force-cleanup side tables (which key off code, not id).
  const { data: row, error: loadErr } = await scopeToCompanyId(supabase
    .from('mfg_products')
    .select('code')
    .eq('id', id), co.companyId)
    .maybeSingle();
  if (loadErr) return c.json({ error: 'load_failed', reason: loadErr.message }, 500);
  if (!row)    return c.json(NOT_THIS_COMPANY, 404);
  const code = row.code;

  // (C) Wei Siang 2026-06-08 — lock USED SKUs. If this SKU has been sold on an
  // SO, ordered on a PO, or moved in stock, block the delete — NOT EVEN by
  // force. Deleting it would orphan live order lines / wipe stock history.
  // Unused SKUs (setup-phase typos) stay deletable.
  const used = await findSkuUsage(supabase, code);
  /* A probe that could not run is NOT "unused". Refusing here costs a retry;
     proceeding costs the stock-movement history this guard exists to protect
     (and on ?force=true, the movements and supplier bindings are deleted too). */
  if (!used.ok) return c.json(usageCheckFailedBody('SKU', used.reason), 409);
  if (used.usage) {
    return c.json({
      error: 'sku_in_use',
      reason: `“${code}” is used in ${used.usage.where}${used.usage.doc ? ` (${used.usage.doc})` : ''} and can’t be deleted.`,
    }, 409);
  }

  if (force) {
    // Multi-company: product code/material_code is shared across companies
    // (UNIQUE(company_id, code)), so cleaning side tables by code ALONE would
    // wipe the OTHER company's rows for the same code. Scope every code-keyed
    // delete to the active company (resolved strictly above).
    const cid = co.companyId;
    const cleanup: Array<{ table: string; column: string; value: string; scoped: boolean }> = [
      // Inventory side — movements key off product_code (per-company; company_id NOT NULL).
      // inventory_stock_lots has no company_id column (legacy/absent table) — leave unscoped;
      // its delete is a swallowed no-op on deployments where it doesn't exist.
      { table: 'inventory_stock_lots',         column: 'product_code',  value: code, scoped: false },
      { table: 'inventory_movements',          column: 'product_code',  value: code, scoped: true  },
      // Procurement side — supplier ↔ material bindings key off material_code (per-company).
      { table: 'supplier_material_bindings',   column: 'material_code', value: code, scoped: true  },
    ];
    for (const c2 of cleanup) {
      let delQ = supabase.from(c2.table).delete().eq(c2.column, c2.value);
      if (c2.scoped) delQ = delQ.eq('company_id', cid);
      const { error: delErr } = await delQ;
      // Best-effort: missing table / no-rows-affected is fine. RLS denial we
      // surface so commander knows force isn't actually clearing.
      if (delErr && delErr.code === '42501') {
        return c.json({ error: 'forbidden', reason: `${c2.table}: ${delErr.message}` }, 403);
      }
      // Other errors (e.g. relation does not exist on a fresh deployment)
      // get swallowed — the SKU delete below will surface anything still
      // blocking.
    }
  }

  const { error } = await scopeToCompanyId(supabase.from('mfg_products').delete().eq('id', id), co.companyId);
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    if (error.code === '23503') {
      // PR #94 — Echo the actual constraint name back so the UI can suggest
      // force-delete with a meaningful hint.
      return c.json({
        error:      'product_in_use',
        reason:     'Product is referenced by an order / PO / GRN line; remove those first or use force delete.',
        constraint: (error as { details?: string }).details ?? null,
        message:    error.message,
      }, 409);
    }
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  return c.body(null, 204);
};
mfgProducts.delete('/:id', deleteMfgProductHandler);

// ── GET /:id ───────────────────────────────────────────────────────────
mfgProducts.get('/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  const { data, error } = await scopeToCompany(
    supabase
      .from('mfg_products')
      .select('*')
      .eq('id', id),
    c,
  )
    .maybeSingle();

  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!data) {
    // Same cross-company honesty as the supplier detail: a product that lives in
    // another company the caller may see gets "switch to view", not the alarming
    // "could no longer be found" (owner ask 2026-07-24; detailMissResponse).
    return c.json(await detailMissResponse(c, supabase.from('mfg_products').select('company_id').eq('id', id), 'product'), 404);
  }

  /* select('*') hands back every column this table grows, so the cost strip
     is what stands between a new cost column and every products reader —
     PRODUCT_FINANCE_KEYS is the ONE place to name it. #669 closed the screen and
     said the wire was still open; this is the wire.

     canViewScmProductCost, NOT canViewScmFinance: this key is a SKU cost, and
     the owner's cost cohort includes Purchasing (2026-07-17). The director gate
     that stood here stripped it from Purchasing — the one function the ruling
     was about — while the FE (#699) told him he could see it. */
  const product = data as Record<string, unknown>;
  if (!canViewScmProductCost(c)) {
    for (const k of PRODUCT_FINANCE_KEYS) delete product[k];
  }

  // Side-load the per-dept config row (one-to-one on product_code) so the
  // UI can show working times without a second roundtrip.
  const { data: cfg } = await supabase
    .from('product_dept_configs')
    .select('*')
    .eq('product_code', data.code)
    .eq('company_id', activeCompanyId(c))
    .maybeSingle();

  return c.json({ product, deptConfig: cfg ?? null });
});

// ── PATCH /:id ─────────────────────────────────────────────────────────
// Updates base/price1/cost prices. Each numeric change emits a row to
// `master_price_history` for the audit drawer.
/* Exported so the swallowed-read guard below (the duplicate-code probe that
   gates the cascade rename) can be driven by a test — same reason
   deleteMfgProductHandler is exported. */
export const patchMfgProductHandler = async (c: AppContext) => {
  const gate = await requireRole(c);
  if (!gate.ok) return gate.res;
  const id = c.req.param('id');
  let body: {
    basePriceSen?: number | null;
    price1Sen?: number | null;
    costPriceSen?: number | null;
    sellPriceSen?: number | null;
    /** PWP (换购) SELLING base price (migration 0128). Selling-side, like sellPriceSen. */
    pwpPriceSen?: number | null;
    notes?: string;
    defaultVariants?: unknown;
    subAssemblies?: unknown;
    pieces?: unknown;
    seatHeightPrices?: Array<{ height: string; priceSen: number; tier?: 'PRICE_1' | 'PRICE_2' | 'PRICE_3'; sellingPriceSen?: number }>;
    branding?: string | null;
    /** PR #87 — per-SKU active toggle. Commander uses this from the Model
        detail "SKU variants" table to mark individual SKUs as no longer sold
        without having to delete the row (preserves stock + history). */
    status?: 'ACTIVE' | 'INACTIVE';
    /** D5 (cost/sell split Phase 2) — selling-only POS catalog visibility.
        Master Account (POS) writes this; SEPARATE from `status` (cost/PO).
        The Backend cost editor never sends it. */
    posActive?: boolean;
    /** D7 (Phase 3) — permanent free gifts ({addonId, qty}[]). Master Account
        sets; Configurator renders "× N INCLUDED". Display-only, no inventory. */
    includedAddons?: Array<{ addonId: string; qty: number }>;
    /** 0170 — Default Free Gift (accessory). [{giftProductId, qty, campaignName?}]. */
    defaultFreeGifts?: Array<{ giftProductId: string; qty: number; campaignName?: string | null }>;
    /* PR #89 (Commander 2026-05-26) — inline edit of SKU code + name from
       SKU Master. Unique-constraint on code → 23505 surfaces as 409. */
    code?: string;
    name?: string;
    /** 0166 — free-text SKU barcode. Empty string clears to NULL. */
    barcode?: string | null;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const supabase = c.get('supabase');
  const user = c.get('user');
  /* Multi-company: pricing + the code-rename cascade below both write, so
     resolve the active company strictly and scope the load — a blind id from
     another company is not found, and the rename cascade can never rewrite the
     other company's snapshots. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: current, error: loadErr } = await scopeToCompanyId(supabase
    .from('mfg_products')
    .select('code, base_price_sen, price1_sen, cost_price_sen, sell_price_sen, pwp_price_sen, default_variants, seat_height_prices')
    .eq('id', id), co.companyId)
    .maybeSingle();
  if (loadErr) return c.json({ error: 'load_failed', reason: loadErr.message }, 500);
  if (!current) return c.json(NOT_THIS_COMPANY, 404);

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const priceChanges: Array<{ field: string; oldValueSen: number | null; newValueSen: number | null }> = [];

  if (body.basePriceSen !== undefined && body.basePriceSen !== current.base_price_sen) {
    updates.base_price_sen = body.basePriceSen;
    priceChanges.push({ field: 'base_price_sen', oldValueSen: current.base_price_sen, newValueSen: body.basePriceSen });
  }
  if (body.price1Sen !== undefined && body.price1Sen !== current.price1_sen) {
    updates.price1_sen = body.price1Sen;
    priceChanges.push({ field: 'price1_sen', oldValueSen: current.price1_sen, newValueSen: body.price1Sen });
  }
  if (body.sellPriceSen !== undefined && body.sellPriceSen !== current.sell_price_sen) {
    updates.sell_price_sen = body.sellPriceSen;
    priceChanges.push({ field: 'sell_price_sen', oldValueSen: current.sell_price_sen, newValueSen: body.sellPriceSen });
  }
  // PWP (换购) selling base price (migration 0128) — selling-side, audited like the others.
  if (body.pwpPriceSen !== undefined && body.pwpPriceSen !== current.pwp_price_sen) {
    updates.pwp_price_sen = body.pwpPriceSen;
    priceChanges.push({ field: 'pwp_price_sen', oldValueSen: current.pwp_price_sen, newValueSen: body.pwpPriceSen });
  }
  if (body.costPriceSen !== undefined && body.costPriceSen !== current.cost_price_sen) {
    updates.cost_price_sen = body.costPriceSen;
    priceChanges.push({ field: 'cost_price_sen', oldValueSen: current.cost_price_sen, newValueSen: body.costPriceSen });
  }
  if (body.defaultVariants !== undefined) {
    updates.default_variants = body.defaultVariants;
  }
  if (body.subAssemblies !== undefined) {
    updates.sub_assemblies = body.subAssemblies;
  }
  if (body.pieces !== undefined) {
    updates.pieces = body.pieces;
  }
  if (body.branding !== undefined) {
    const trimmed = typeof body.branding === 'string' ? body.branding.trim() : null;
    updates.branding = trimmed ? trimmed : null;
  }
  // 0166 — barcode edit from the SKU drawers. Trimmed; empty clears to NULL.
  if (body.barcode !== undefined) {
    const trimmed = typeof body.barcode === 'string' ? body.barcode.trim() : null;
    updates.barcode = trimmed ? trimmed : null;
  }
  // PR #87 — per-SKU active toggle. Stored as 'ACTIVE' | 'INACTIVE' to match
  // the rest of the schema (matches mfg_products.status default in inserts).
  if (body.status === 'ACTIVE' || body.status === 'INACTIVE') {
    updates.status = body.status;
  }
  // D5 — selling-only POS catalog visibility. Independent of status (cost/PO).
  if (typeof body.posActive === 'boolean') {
    updates.pos_active = body.posActive;
  }
  // D7 — permanent free gifts (display-only). Master Account sets the array.
  if (Array.isArray(body.includedAddons)) {
    updates.included_addons = body.includedAddons;
  }
  // 0170 — Default Free Gift (accessory). Coerce via the shared parser so a
  // malformed entry can never poison the column.
  if (Array.isArray(body.defaultFreeGifts)) {
    updates.default_free_gifts = parseDefaultFreeGifts(body.defaultFreeGifts);
  }
  /* PR #89 — code + name inline edit from SKU Master. code is unique;
     duplicate triggers 23505 below. Both trimmed; empty rejected to keep
     the NOT NULL invariants on the schema. */
  if (body.code !== undefined) {
    const trimmed = typeof body.code === 'string' ? body.code.trim() : '';
    if (!trimmed) return c.json({ error: 'code_required' }, 400);
    updates.code = trimmed;
  }
  if (body.name !== undefined) {
    const trimmed = typeof body.name === 'string' ? body.name.trim() : '';
    if (!trimmed) return c.json({ error: 'name_required' }, 400);
    updates.name = trimmed;
  }
  // Sofa tier matrix — diff per (height × tier) slot so the audit trail
  // captures each change instead of a single opaque blob write.
  if (Array.isArray(body.seatHeightPrices)) {
    // Light validation: a present sellingPriceSen must be a finite, non-negative
    // integer (sen). priceSen (cost) keeps its existing tolerant handling.
    for (const s of body.seatHeightPrices) {
      if (s.sellingPriceSen != null &&
          (!Number.isInteger(s.sellingPriceSen) || s.sellingPriceSen < 0)) {
        return c.json({ error: 'invalid_selling_price' }, 400);
      }
    }
    type Slot = { height: string; priceSen: number; tier?: 'PRICE_1' | 'PRICE_2' | 'PRICE_3'; sellingPriceSen?: number };
    const oldArr = (Array.isArray(current.seat_height_prices)
      ? (current.seat_height_prices as Slot[])
      : []);
    const newArr = body.seatHeightPrices as Slot[];
    const keyOf = (s: Slot) => `${s.height}|${s.tier ?? 'PRICE_2'}`;

    /* Audit 2026-06-20 — seat_height_prices JSONB carries TWO independent
       dimensions per slot: priceSen (COST, Backend "Edit Prices" grid) and
       sellingPriceSen (SELLING, POS Sales-Director). A cost-only client omits
       sellingPriceSen, so the old verbatim store wiped the POS selling price on
       every edited slot — the combo COST-edit-wipes-SELLING bug twinned onto the
       SKU JSONB. MERGE each incoming slot over the matching current slot so an
       omitted dimension carries forward (an explicit incoming value still wins). */
    const oldByKey = new Map(oldArr.map((s) => [keyOf(s), s] as const));
    const mergedArr: Slot[] = newArr.map((s) => ({ ...oldByKey.get(keyOf(s)), ...s }));
    updates.seat_height_prices = mergedArr;

    const oldMap = new Map(oldArr.map((s) => [keyOf(s), s.priceSen] as const));
    const newMap = new Map(mergedArr.map((s) => [keyOf(s), s.priceSen] as const));
    const keys = new Set([...oldMap.keys(), ...newMap.keys()]);
    for (const k of keys) {
      const oldVal = oldMap.get(k) ?? null;
      const newVal = newMap.get(k) ?? null;
      if (oldVal !== newVal) {
        priceChanges.push({ field: `seat_height:${k}`, oldValueSen: oldVal, newValueSen: newVal });
      }
    }
    // SELLING side (POS Edit-Price grid writes sellingPriceSen; Chairman
    // 2026-06-01). Diffed against the MERGED array so the audit reflects what is
    // actually stored (an omitted slot now carries its prior selling forward).
    const oldSellMap = new Map(oldArr.map((s) => [keyOf(s), s.sellingPriceSen ?? null] as const));
    const newSellMap = new Map(mergedArr.map((s) => [keyOf(s), s.sellingPriceSen ?? null] as const));
    for (const k of new Set([...oldSellMap.keys(), ...newSellMap.keys()])) {
      const oldVal = oldSellMap.get(k) ?? null;
      const newVal = newSellMap.get(k) ?? null;
      if (oldVal !== newVal) {
        priceChanges.push({ field: `seat_height_selling:${k}`, oldValueSen: oldVal, newValueSen: newVal });
      }
    }
  }

  if (Object.keys(updates).length === 1) {
    // only updated_at — nothing meaningful to write
    return c.json({ ok: true, changed: 0 });
  }

  /* SKU-code rename cascade (2990 PR #720, Owner 2026-07-13 MAKOTA→MAKOTO
     typo). The code is snapshotted as TEXT (no FK) across the whole ERP — doc
     lines, supplier bindings and, critically, FIFO stock (inventory_lots keys
     stock ON HAND by product_code). PR #89's plain-column rename silently
     stranded all of those under the old code: the renamed SKU showed zero
     stock, its supplier binding died, and PO/GRN conversion lookups missed.
     So a code change now renames every snapshot in the same request.

     Ordering: referencing tables FIRST, mfg_products LAST — if a cascade step
     fails midway the product still carries the OLD code, so re-submitting the
     same rename is a clean retry (already-renamed tables match 0 rows). The
     duplicate check runs before anything is touched. Not transactional
     (supabase-js), but idempotent + retryable is enough here.

     Houzs adaptation: every cascade table carries company_id (migrations
     0083/0089), so both the duplicate precheck and each UPDATE are scoped to
     the active company via scopeToCompanyId — company A's rename must never
     rewrite company B's snapshots. */
  const cascadeCounts: Record<string, number> = {};
  {
    const oldCode = current.code as string;
    const newCode = typeof updates.code === 'string' ? (updates.code as string) : null;
    if (newCode && newCode !== oldCode) {
      const { data: dup, error: dupErr } = await scopeToCompanyId(
        supabase.from('mfg_products').select('id').eq('code', newCode).neq('id', id),
        co.companyId,
      ).limit(1);
      /* The duplicate probe is the ONLY thing standing between this request and
         a cascade that rewrites the code on stock lots, movements, supplier
         bindings and every document-line snapshot below. It used to drop the
         error, so an unreadable probe read as "no duplicate" and the cascade
         ran: the referencing tables are renamed FIRST (see the ordering note
         above), so the UNIQUE(company_id, code) constraint on mfg_products —
         the only backstop — fires LAST, after two SKUs' stock and bindings have
         already been merged under one code, and the retry the comment promises
         cannot separate them again. A failed read must never read as an absence
         when the absence is what authorises the write. */
      if (dupErr) {
        return c.json({
          error: 'duplicate_check_failed',
          reason:
            'Could not check whether another SKU already uses that code, so the rename is refused '
            + `rather than cascaded onto stock and documents unchecked — try again (${dupErr.message}).`,
        }, 409);
      }
      // `dup` is an array here — the `if (dupErr) return` above is what makes it
      // one, and a `dup &&` guard would read an unreadable probe as "no duplicate".
      if (dup.length > 0) {
        return c.json({ error: 'duplicate_code', reason: 'Another SKU already uses that code.' }, 409);
      }
      /* material_code tables carry material_kind (mfg_product | fabric | raw) —
         scope those so a fabric that happens to share the string is untouched. */
      const CASCADE: Array<{ table: string; col: string; kind?: true }> = [
        { table: 'supplier_material_bindings', col: 'material_code', kind: true },
        { table: 'purchase_order_items',       col: 'material_code', kind: true },
        { table: 'grn_items',                  col: 'material_code', kind: true },
        { table: 'purchase_invoice_items',     col: 'material_code', kind: true },
        { table: 'purchase_return_items',      col: 'material_code', kind: true },
        { table: 'mfg_sales_order_items',      col: 'item_code' },
        { table: 'mfg_so_price_overrides',     col: 'item_code' },
        { table: 'delivery_order_items',       col: 'item_code' },
        { table: 'sales_invoice_items',        col: 'item_code' },
        { table: 'delivery_return_items',      col: 'item_code' },
        { table: 'pwp_codes',                  col: 'trigger_item_code' },
        { table: 'pwp_codes',                  col: 'redeemed_item_code' },
        { table: 'hr_item_kpi',                col: 'ref' },
        { table: 'product_dept_configs',       col: 'product_code' },
        { table: 'master_price_history',       col: 'product_code' },
        { table: 'inventory_movements',        col: 'product_code' },
        { table: 'inventory_lots',             col: 'product_code' },
        { table: 'inventory_lot_consumptions', col: 'product_code' },
        { table: 'stock_transfer_lines',       col: 'product_code' },
        { table: 'stock_take_lines',           col: 'product_code' },
        { table: 'warehouse_rack_items',       col: 'product_code' },
        { table: 'warehouse_rack_movements',   col: 'product_code' },
      ];
      for (const t of CASCADE) {
        let q = scopeToCompanyId(
          supabase.from(t.table)
            .update({ [t.col]: newCode }, { count: 'exact' })
            .eq(t.col, oldCode),
          co.companyId,
        );
        if (t.kind) q = q.eq('material_kind', 'mfg_product');
        const { error: cErr, count } = await q;
        if (cErr) {
          // Missing table on a fresh DB is fine; anything else aborts BEFORE the
          // product row flips, so the same rename can simply be retried.
          if (/does not exist/i.test(cErr.message)) continue;
          return c.json({
            error: 'rename_cascade_failed',
            reason: `${t.table}.${t.col}: ${cErr.message}. Nothing is lost — the SKU still has its old code; retry the rename.`,
          }, 500);
        }
        if (count) cascadeCounts[`${t.table}.${t.col}`] = count;
      }
    }
  }

  const { error: updErr } = await scopeToCompanyId(supabase.from('mfg_products').update(updates).eq('id', id), co.companyId);
  if (updErr) {
    if (updErr.code === '42501' || /permission denied/i.test(updErr.message)) {
      return c.json({ error: 'forbidden', reason: updErr.message }, 403);
    }
    if (updErr.code === '23505') {
      // PR #89 — only the `code` column has a UNIQUE constraint that the
      // inline editor can collide with, so safe to label it that way.
      return c.json({ error: 'duplicate_code', reason: 'Another SKU already uses that code.' }, 409);
    }
    return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  }

  /* Cost anchor (0177) — mirror the new COST onto this SKU's anchor binding
     (if any). Only fires when base_price_sen / price1_sen actually changed
     (the two cost fields the mapping reads). Uses the FINAL values: the
     written value if it changed, else the unchanged current value. Best-effort
     — runs after the product write committed. */
  const costFieldChanged = priceChanges.some(
    (ch) =>
      ch.field === 'base_price_sen' ||
      ch.field === 'price1_sen' ||
      // SOFA per-(height,tier) COST slots (field `seat_height:<h>|<tier>`) — the
      // authoritative sofa cost the binding's price_matrix mirrors. This does
      // NOT match the selling side (`seat_height_selling:…`): the ':' vs '_'
      // boundary keeps them disjoint, so a POS selling-price edit never fires a
      // cost sync.
      ch.field.startsWith('seat_height:'),
  );
  /* Rename-aware: bindings + price history were cascade-renamed above, so all
     post-write side effects must address the SKU by its FINAL code. */
  const finalCode = typeof updates.code === 'string' ? (updates.code as string) : (current.code as string);
  if (costFieldChanged) {
    // Use the FINAL values. `'key' in updates` (not ??) so an explicit clear to
    // null is honoured rather than falling back to the old value.
    await syncAnchorBindingFromProduct(supabase, finalCode, {
      base_price_sen: 'base_price_sen' in updates
        ? (updates.base_price_sen as number | null)
        : current.base_price_sen,
      price1_sen: 'price1_sen' in updates
        ? (updates.price1_sen as number | null)
        : current.price1_sen,
      // Sofa cost grid — the MERGED array when this PATCH touched it, else the
      // unchanged current grid (so a base_price_sen-only edit still re-mirrors
      // the full sofa matrix rather than dropping it).
      seat_height_prices: 'seat_height_prices' in updates
        ? (updates.seat_height_prices as ProductSeatCost[])
        : ((current.seat_height_prices as ProductSeatCost[] | null) ?? null),
    }, activeCompanyId(c));
  }

  // Audit trail. Best-effort — if these fail the price update has already
  // committed, so we log and move on (matches the audit-dlq pattern used
  // elsewhere in 2990s).
  for (const ch of priceChanges) {
    // PRICE_FIELDS covers the flat columns; `seat_height*` carries the per-(height,
    // tier) cost + selling diffs (the old guard silently dropped ALL seat_height
    // rows — fixed here in one line; master_price_history.field is free-text).
    if (!PRICE_FIELDS.has(ch.field) && !ch.field.startsWith('seat_height')) continue;
    await supabase.from('master_price_history').insert({
      company_id: activeCompanyId(c),
      product_code: finalCode,
      field: ch.field,
      old_value_sen: ch.oldValueSen,
      new_value_sen: ch.newValueSen,
      reason: body.notes ?? null,
      changed_by: user.id,
    });
  }

  return c.json({
    ok: true,
    changed: priceChanges.length,
    // Rename cascade — rows re-pointed per table.column (absent on non-rename patches).
    ...(Object.keys(cascadeCounts).length > 0 ? { renamed: cascadeCounts } : {}),
  });
};
mfgProducts.patch('/:id', patchMfgProductHandler);

// ── POST /:id/activate-one-shot ───────────────────────────────────────────────
// Re-activate a one-shot SKU (minted from a remark + extra charge) so it is
// selectable again in POS. Flips pos_active=true; for SOFA it also adds the
// custom compartment code to the Model's allowed_options.compartments so the
// configurator palette shows it (art/price auto-flow via the shared helpers).
mfgProducts.post('/:id/activate-one-shot', async (c) => {
  const gate = await requireRole(c);
  if (!gate.ok) return gate.res;
  const id = c.req.param('id');
  /* Multi-company: this handler uses the service-role admin client (RLS
     bypassed), so the company_id predicate on every read/write below IS the
     isolation boundary. Resolve the active company strictly and scope the SKU
     and its Model so a blind id from another company can't be activated. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const admin = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: sku, error: skuErr } = await admin
    .from('mfg_products')
    .select('id, code, category, base_model, model_id, one_shot')
    .eq('id', id).eq('company_id', co.companyId).maybeSingle();
  if (skuErr) return c.json({ error: 'lookup_failed', reason: skuErr.message }, 500);
  if (!sku) return c.json(NOT_THIS_COMPANY, 404);
  if (!(sku as { one_shot?: boolean }).one_shot) return c.json({ error: 'not_one_shot' }, 400);

  const { error: upErr } = await admin.from('mfg_products').update({ pos_active: true }).eq('id', id).eq('company_id', co.companyId);
  if (upErr) return c.json({ error: 'activate_failed', reason: upErr.message }, 500);

  const s = sku as { category: string; code: string; base_model: string | null; model_id: string | null };
  if (s.category === 'SOFA' && s.model_id) {
    const moduleCode = moduleCodeFromSku(s.code, s.base_model);
    const { data: model } = await admin.from('product_models')
      .select('allowed_options').eq('id', s.model_id).eq('company_id', co.companyId).maybeSingle();
    const opts = ((model as { allowed_options?: Record<string, unknown> } | null)?.allowed_options) ?? {};
    const comps = Array.isArray((opts as { compartments?: unknown }).compartments)
      ? ((opts as { compartments: unknown[] }).compartments).map(String) : [];
    if (!comps.includes(moduleCode)) {
      const next = { ...opts, compartments: [...comps, moduleCode] };
      const { error: moErr } = await admin.from('product_models')
        .update({ allowed_options: next }).eq('id', s.model_id).eq('company_id', co.companyId);
      if (moErr) return c.json({ error: 'allowed_options_update_failed', reason: moErr.message }, 500);
    }
  }
  return c.json({ ok: true });
});

// ── GET /:id/price-history ────────────────────────────────────────────
mfgProducts.get('/:id/price-history', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  const { data: product, error: pErr } = await scopeToCompany(
    supabase
      .from('mfg_products')
      .select('code')
      .eq('id', id),
    c,
  )
    .maybeSingle();
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  if (!product) return c.json({ error: 'not_found' }, 404);

  const { data, error } = await supabase
    .from('master_price_history')
    .select('id, product_code, field, old_value_sen, new_value_sen, reason, changed_at, changed_by')
    .eq('product_code', product.code)
    .eq('company_id', activeCompanyId(c))
    .order('changed_at', { ascending: false });

  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  /* The history carries the old AND new cost of every cost edit in plain sight,
     keyed by the column name — gating GET /:id and not this would move the leak
     one endpoint over, which is the exact shape AUDIT_FINANCE_FIELDS exists to
     name on the SO side. */
  const history = (data ?? []) as Array<{ field?: string }>;
  return c.json({ history: canViewScmProductCost(c) ? history : stripProductPriceHistory(history) });
});

// ── GET /:id/suppliers ────────────────────────────────────────────────
// PR #38 — Returns every supplier that carries this product (via
// supplier_material_bindings), with their supplier-side SKU + price +
// lead time + is_main flag. Used by the Products page double-click drawer.
mfgProducts.get('/:id/suppliers', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  const { data: product, error: pErr } = await scopeToCompany(
    supabase
      .from('mfg_products')
      .select('code, name, category')
      .eq('id', id),
    c,
  )
    .maybeSingle();
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  if (!product) return c.json({ error: 'not_found' }, 404);

  const { data, error } = await supabase
    .from('supplier_material_bindings')
    .select(`
      id, supplier_id, supplier_sku, unit_price_centi, currency,
      lead_time_days, moq, is_main_supplier, notes,
      suppliers(code, name, phone)
    `)
    .eq('material_code', (product as { code: string }).code)
    .eq('company_id', activeCompanyId(c))
    .order('is_main_supplier', { ascending: false })
    .order('unit_price_centi', { ascending: true });

  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ product, suppliers: data ?? [] });
});

// ── Effective-dated SELLING price (Pricing "Option B", ph.2) ──────────────────
// Schedule a product's selling price BY DATE, and read the timeline back. Backed
// by scm.mfg_product_price_history (migration 0187); the resolver
// (lib/product-pricing-history.ts) returns the as-of price, falling back to the
// flat mfg_products.sell_price_sen when no row applies — so with the table empty
// every price resolves exactly as today. Append-only: a correction is a NEW row,
// never an UPDATE/DELETE. See docs/pricing-effective-dating-design.md.
//
// ⚠️ SCOPE BOUNDARY: these routes only STORE/READ scheduled prices. The order
// read-integration (mfg-pricing-recompute.ts takes the as-of price on a document's
// own date — design phase 3) is deliberately NOT wired here, so no existing order
// changes how it is priced.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── POST /:id/price-changes ───────────────────────────────────────────────────
// Append ONE { effectiveFrom, sellPriceSen, notes? } row. Editor-gated (requireRole
// / canWriteScmConfig — the SCM area guard's openRead lets reads through, so writes
// carry the app-layer gate, exactly like PATCH). Company-stamped strictly.
export const createPriceChangeHandler = async (c: any) => {
  const gate = await requireRole(c);
  if (!gate.ok) return gate.res;
  const id = c.req.param('id');

  let body: { effectiveFrom?: string; sellPriceSen?: number | null; notes?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const effectiveFrom = (body.effectiveFrom ?? '').trim();
  if (!ISO_DATE.test(effectiveFrom)) {
    return c.json({ error: 'effective_from_required', message: 'YYYY-MM-DD' }, 400);
  }
  // Phase 1 always writes the selling price (the nullable column is reserved for
  // future multi-column snapshots). Integer sen, >= 0.
  const sellPriceSen = body.sellPriceSen;
  if (typeof sellPriceSen !== 'number' || !Number.isInteger(sellPriceSen) || sellPriceSen < 0) {
    return c.json({ error: 'sell_price_required', message: 'integer sen >= 0' }, 400);
  }

  const supabase = c.get('supabase');
  const houzsUser = c.get('houzsUser');
  const systemUser = c.get('user');
  /* Multi-company: this WRITE stamps company_id, so resolve the active company
     STRICTLY and refuse when unknown — never append across every company. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  // Resolve the SKU by id, scoped to the active company (same detail-scoping
  // pattern as PATCH/DELETE). A blind id from another company reads as a miss;
  // detailMissResponse turns that into an honest cross-company hint.
  const { data: product, error: loadErr } = await scopeToCompanyId(
    supabase.from('mfg_products').select('code, sell_price_sen').eq('id', id),
    co.companyId,
  ).maybeSingle();
  if (loadErr) return c.json({ error: 'load_failed', reason: loadErr.message }, 500);
  if (!product) {
    return c.json(await detailMissResponse(c, supabase.from('mfg_products').select('company_id').eq('id', id), 'product'), 404);
  }
  const code = (product as { code: string }).code;
  const currentSellPriceSen = (product as { sell_price_sen: number | null }).sell_price_sen ?? null;

  /* created_by is ATTRIBUTION, and inside /api/scm/* c.get('user') is the pinned
     system row (the same uuid for every caller — see scm/middleware/auth.ts). So
     record the REAL caller stashed on houzsUser. The column is free text (no FK),
     so we store the readable name the owner wants to see in the timeline, falling
     back to email / id, and finally the system id if houzsUser is absent. */
  const createdBy =
    (houzsUser?.name?.trim() || houzsUser?.email?.trim() ||
      (houzsUser?.id != null ? String(houzsUser.id) : '')) || systemUser.id;

  const today = todayMyt();

  /* AUTO-BASELINE (Hookka trick): when scheduling the FIRST future-dated price for
     a product with NO history yet, also snapshot the CURRENT flat price at today,
     so the timeline reads "today = current, <future> = new" rather than implying
     the new price was always in effect. Skipped when the flat price is null — a
     null baseline row says nothing, and reads already fall back to the null flat. */
  let baselined = false;
  const toInsert: Array<Record<string, unknown>> = [];
  if (effectiveFrom > today && currentSellPriceSen != null) {
    const { data: existing, error: existErr } = await supabase
      .from('mfg_product_price_history')
      .select('id')
      .eq('company_id', co.companyId)
      .eq('product_code', code)
      .limit(1)
      .maybeSingle();
    if (existErr) return c.json({ error: 'load_failed', reason: existErr.message }, 500);
    if (!existing) {
      baselined = true;
      toInsert.push({
        company_id: co.companyId,
        product_code: code,
        sell_price_sen: currentSellPriceSen,
        effective_from: today,
        notes: 'Auto-baseline: current price before the first scheduled change.',
        created_by: createdBy,
      });
    }
  }
  toInsert.push({
    company_id: co.companyId,
    product_code: code,
    sell_price_sen: sellPriceSen,
    effective_from: effectiveFrom,
    notes: body.notes?.trim() ? body.notes.trim() : null,
    created_by: createdBy,
  });

  // Single insert (atomic when a baseline rides along); the DB owns id + created_at.
  const { data, error } = await supabase
    .from('mfg_product_price_history')
    .insert(toInsert)
    .select('id, effective_from, sell_price_sen, notes, created_by, created_at');
  if (error) {
    if (error.code === '42501' || /permission denied/i.test(error.message)) {
      return c.json({ error: 'forbidden', reason: error.message }, 403);
    }
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  const inserted = (data ?? []) as Array<{
    id: string; effective_from: string; sell_price_sen: number | null;
    notes: string | null; created_by: string | null; created_at: string;
  }>;
  // The baseline (if any) is dated today; the scheduled row is the future date.
  const created = inserted.find((r) => r.effective_from === effectiveFrom) ?? inserted.at(-1) ?? null;

  return c.json({
    ok: true,
    baselined,
    row: created ? {
      id: created.id,
      effectiveFrom: created.effective_from,
      sellPriceSen: created.sell_price_sen,
      notes: created.notes ?? null,
      createdBy: created.created_by ?? null,
      createdAt: created.created_at,
    } : null,
  }, 201);
};
mfgProducts.post('/:id/price-changes', createPriceChangeHandler);

// ── GET /:id/price-changes ─────────────────────────────────────────────────────
// The product's selling-price timeline (newest first) + the current as-of price
// and the pending-next price (for a "Next: RM X from <date>" badge). Open read,
// mirroring GET /:id/price-history: the SCM area guard's openRead lets a
// salesperson read the catalogue, and a SELLING price is not cost, so it is NOT
// finance-gated (see lib/finance-keys.ts — only cost_price_sen is confidential).
export const listPriceChangesHandler = async (c: any) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  // Both the history filter and the resolver need a concrete companyId, so resolve
  // it strictly here too (same as the write) rather than degrading.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: product, error: pErr } = await scopeToCompanyId(
    supabase.from('mfg_products').select('code, sell_price_sen').eq('id', id),
    co.companyId,
  ).maybeSingle();
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  if (!product) {
    return c.json(await detailMissResponse(c, supabase.from('mfg_products').select('company_id').eq('id', id), 'product'), 404);
  }
  const code = (product as { code: string }).code;
  const flatSellPriceSen = (product as { sell_price_sen: number | null }).sell_price_sen ?? null;

  const { data, error } = await supabase
    .from('mfg_product_price_history')
    .select('id, effective_from, sell_price_sen, notes, created_by, created_at')
    .eq('company_id', co.companyId)
    .eq('product_code', code)
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const today = todayMyt();
  // Current as-of price = the newest row effective <= today, else the flat value.
  const asOf = await resolveSellPriceSenAsOf(supabase, co.companyId, code, today);
  const pending = await resolvePendingSellPriceAfter(supabase, co.companyId, code, today);

  return c.json({
    history: data ?? [],
    currentSellPriceSen: asOf ?? flatSellPriceSen,
    pending: pending ? { sellPriceSen: pending.sellPriceSen, effectiveFrom: pending.effectiveFrom } : null,
  });
};
mfgProducts.get('/:id/price-changes', listPriceChangesHandler);
