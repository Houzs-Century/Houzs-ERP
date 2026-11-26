
import { Hono, type Context } from 'hono';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseAuth } from '../middleware/auth';
import { escapeForOr } from '../lib/postgrest-search';
import { paginateAll } from '../lib/paginate-all';
import { findSkuUsage, usageCheckFailedBody } from '../lib/sku-usage';
import { productToBindingPatch, type ProductSeatCost } from '../lib/cost-anchor-sync';
import { autoDeriveEnabled, mergeRetailOntoDerivedSeatGrid } from '../lib/auto-derive-cost';
import { resolveProductCostAnchor, comparableCostSen, type SupplierBindingCost } from '../lib/derive-product-cost-from-suppliers';
import { readMfgProductBindings } from '../lib/supplier-bindings';
import { moduleCodeFromSku, normalizeSofaTier, parseDefaultFreeGifts } from '../shared';
import { canWriteScmConfig, canViewScmProductCost } from '../lib/houzs-perms';
import { PRODUCT_FINANCE_KEYS, stripProductPriceHistory } from '../lib/finance-keys';
import { scopeToCompany, activeCompanyId,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY,
  detailMissResponse } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import { resolveSellPriceSenAsOf, resolvePendingSellPriceAfter } from '../lib/product-pricing-history';
import type { Env, Variables } from '../env';
import { categorySwapAllowed } from '../shared/category-swap';
import { PRODUCT_CODE_CASCADE } from '../lib/product-code-rename';
import { moveModelCategory, planModelCategoryMoves, type ImportModelMove } from '../lib/model-category-move';
import { ensureModelForSku, modelCodeForSku } from '../lib/ensure-model-for-sku';
import { newSkuPosActive } from '../lib/new-sku-pos-active';
import { activeProductCategories, isMfgProductCategory, mfgCategoryLabel, parseMfgCategory } from '../shared/product-categories';
import { loadProductCategories } from '../lib/product-category-registry';
import { mfgProductMerge } from './mfg-product-merge';

export const mfgProducts = new Hono<{ Bindings: Env; Variables: Variables }>();
mfgProducts.use('*', supabaseAuth);
mfgProducts.route('/merge', mfgProductMerge);

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;


async function requireRole(c: AppContext): Promise<{ ok: true } | { ok: false; res: Response }> {
  if (!canWriteScmConfig(c)) {
    return { ok: false, res: c.json({ error: 'forbidden', reason: 'missing_scm_config_write' }, 403) };
  }
  return { ok: true };
}

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
  itemCode: string,
  product: {
    base_price_sen: number | null;
    price1_sen: number | null;
    seat_height_prices?: ProductSeatCost[] | null;
  },
  companyId: number | null,
): Promise<void> {
  try {
    let bindingQ = supabase
      .from('supplier_material_bindings')
      .select('id, price_matrix')
      .eq('material_kind', 'mfg_product')
      .eq('item_code', itemCode)
      .eq('is_cost_anchor', true);
    if (companyId != null) bindingQ = bindingQ.eq('company_id', companyId);
    const { data: binding } = await bindingQ.maybeSingle();
    if (!binding) return;

    let prodQ = supabase
      .from('mfg_products')
      .select('category')
      .eq('code', itemCode);
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
  }
}

export const listMfgProductsHandler = async (c: AppContext) => {
  const category = c.req.query('category');
  const search = c.req.query('search');
  const wantAnchorState = c.req.query('anchorState') === '1';
  const supabase = c.get('supabase');

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
          'model:product_models(name, allowed_options, default_variants, active)',
      )
      .eq('status', 'ACTIVE')
      .order('code', { ascending: true });
    if (category) q = q.eq('category', category);
    if (s) q = q.or(`code.ilike.%${s}%,name.ilike.%${s}%,description.ilike.%${s}%,barcode.ilike.%${s}%`);
    q = scopeToCompany(q, c);
    return q.range(from, to);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  type ModelJoin = { name?: string | null; allowed_options: unknown; default_variants?: unknown; active?: boolean | null };
  const products: Array<Record<string, unknown>> = ((data ?? []) as unknown as Array<Record<string, unknown> & { model?: ModelJoin | ModelJoin[] | null }>)
    .map(({ model, ...p }) => ({ p, m: Array.isArray(model) ? model[0] : model }))
    .filter(({ m }) => m?.active !== false)
    .map(({ p, m }) => ({ ...p, allowed_options: m?.allowed_options ?? null, model_default_variants: m?.default_variants ?? null, model_name: m?.name ?? null }));

  if (wantAnchorState && products.length > 0) {
    const codes = products.map((p) => String(p.code));
    const { data: bindings, error: bErr } = await readMfgProductBindings<{
      item_code: string; supplier_id: string; is_main_supplier: boolean | null;
      unit_price_sen: number | null; price_matrix: unknown;
    }>(supabase, {
      codes,
      companyId: activeCompanyId(c),
      select: 'item_code, supplier_id, is_main_supplier, unit_price_sen, price_matrix',
    });
    if (!bErr) {
      const byCode = new Map<string, SupplierBindingCost[]>();
      for (const b of bindings) {
        const arr = byCode.get(b.item_code) ?? [];
        arr.push({ supplier_id: b.supplier_id, is_main_supplier: b.is_main_supplier, unit_price_sen: b.unit_price_sen, price_matrix: b.price_matrix });
        byCode.set(b.item_code, arr);
      }
      for (const p of products) {
        p.costAnchorState = resolveProductCostAnchor(
          (p.category as string | null) ?? null,
          byCode.get(String(p.code)) ?? [],
        ).state;
      }
    }
  }
  c.header('cache-control', 'private, max-age=60');
  c.header('vary', 'X-Company-Id');
  return c.json({ products });
};
mfgProducts.get('/', listMfgProductsHandler);

/* GET /categories — the product categories, from scm.acc_item_groups (the one
   list, HC-0258). Every screen's picker reads this, so a category added in
   Accounting -> Item groups shows everywhere with no release. Inactive rows
   come too, so an old row still shows its name; pickers offer the active ones.
   openRead (scm/index.ts): any SCM user can read it. Global, no company scope. */
mfgProducts.get('/categories', async (c) => {
  try {
    return c.json({ categories: await loadProductCategories(c.get('supabase')) });
  } catch (e) {
    return c.json({ error: 'load_failed', reason: (e as Error).message }, 500);
  }
});

mfgProducts.get('/bound-codes', async (c) => {
  const supabase = c.get('supabase');
  const { data, error } = await paginateAll((from, to) =>
    supabase
      .from('supplier_material_bindings')
      .select('item_code')
      .eq('material_kind', 'mfg_product')
      .eq('company_id', activeCompanyId(c))
      .order('item_code')
      .range(from, to),
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const codes = [
    ...new Set(
      ((data ?? []) as Array<{ item_code: string | null }>)
        .map((r) => r.item_code)
        .filter((code): code is string => Boolean(code)),
    ),
  ];
  c.header('vary', 'X-Company-Id');
  return c.json({ codes });
});

export const createMfgProductHandler = async (c: AppContext) => {
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

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const supabase = c.get('supabase');
  const active = activeProductCategories(await loadProductCategories(supabase));
  if (!isMfgProductCategory(active, category)) return c.json({ error: 'invalid_category', allowed: active.map((r) => r.code) }, 400);
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
    pos_active: newSkuPosActive(co.companyId, category),
    description: (body.description as string) ?? null,
    base_model: (body.baseModel as string) ?? null,
    size_code: (body.sizeCode as string) ?? null,
    size_label: (body.sizeLabel as string) ?? null,
    base_price_sen: body.basePriceSen == null ? null : Number(body.basePriceSen),
    price1_sen: body.price1Sen == null ? null : Number(body.price1Sen),
    cost_price_sen: body.costPriceSen == null ? 0 : Number(body.costPriceSen),
    unit_m3_milli: body.unitM3Milli == null ? 0 : Number(body.unitM3Milli),
    branding: (body.branding as string) ?? null,
    barcode: typeof body.barcode === 'string' && body.barcode.trim() ? body.barcode.trim() : null,
  };

  // Every SKU belongs to a Model (owner 2026-09-18) — find-or-create it and
  // stamp model_id so this bare create is uniform with the New-SKU/Model dialog
  // and the batch import. A variant (base_model set) links to the shared model;
  // a flat product is its own 1:1 model.
  const ensured = await ensureModelForSku(supabase, {
    companyId: co.companyId,
    code,
    name,
    category,
    baseModel: (body.baseModel as string) ?? null,
  });
  if (!ensured.ok) return c.json({ error: 'model_ensure_failed', reason: ensured.reason }, 500);
  row.model_id = ensured.modelId;

  const { data, error } = await supabase.from('mfg_products').insert({ ...row, company_id: co.companyId }).select('id, code').single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_code', reason: error.message }, 409);
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  return c.json(data, 201);
};
mfgProducts.post('/', createMfgProductHandler);

export const batchImportMfgProductsHandler = async (c: AppContext) => {
  const gate = await requireRole(c);
  if (!gate.ok) return gate.res;
  let body: { rows?: Array<Record<string, unknown>> };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const list = body.rows ?? [];
  if (list.length === 0) return c.json({ error: 'rows_required' }, 400);
  if (list.length > 500) return c.json({ error: 'too_many', message: 'Max 500 rows per import' }, 400);

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const supabase = c.get('supabase');
  let upserted = 0;
  let created = 0;
  const failures: Array<{ code: string; reason: string }> = [];

  const categories = activeProductCategories(await loadProductCategories(supabase));
  const plan = await planModelCategoryMoves(supabase, co.companyId, list, categories);
  if (!plan.ok) return c.json({ error: 'load_failed', reason: plan.reason }, 500);
  const modelsMoved: ImportModelMove[] = [];
  const moveFailed = new Map<string, string>();
  const modelIdCache = new Map<string, string>();

  const hasVal = (v: unknown): boolean => v != null && v !== '';
  for (const r of list) {
    const code = String(r.code ?? '').trim();
    const name = String(r.name ?? '').trim();
    const categoryCell = String(r.category ?? '').trim();
    /* Read as a person types it (any case, or the label "Sofa Accessory").
       A filled cell that is not a category is REPORTED: it used to be dropped
       without a word, so a batch category edit could save everything except
       the category and still say "updated" (owner 2026-09-15). */
    const category = parseMfgCategory(categories, categoryCell);
    if (!code) {
      failures.push({ code, reason: 'missing code' });
      continue;
    }
    /* NAME AND CATEGORY ARE REQUIRED TO CREATE, NOT TO UPDATE.
     *
     * The owner states the contract in one sentence (2026-09-07):
     * 「如果没有 Code 在系统里面的 import,就是等于开 Code。然后如果我有 Code 在
     *   系统里面,它 match 得到,就是代表我要更改东西」— a code the system does not
     * hold is a NEW SKU, a code it holds is an EDIT.
     *
     * Demanding both on every row contradicted the data-loss-safe rule written
     * twenty lines above: every OTHER column is written only when the cell is
     * filled, precisely so an edited export cannot wipe what it does not carry.
     * Name and category were the two exceptions, which made the commonest real
     * file — a price-only edit — impossible to import at all. It failed as
     * `missing code/name or invalid category`, reading like a broken file
     * rather than a rule.
     *
     * The existence read moved UP for this; the write branch below reuses it. */
    const { data: existing } = await supabase.from('mfg_products')
      .select('id, seat_height_prices').eq('code', code).eq('company_id', activeCompanyId(c)).maybeSingle();

    if (categoryCell && !category) {
      failures.push({
        code,
        reason: `category "${categoryCell}" is not a category — use one of: ${categories.map((r) => r.name).join(', ')}.`,
      });
      continue;
    }
    const statusCell = hasVal(r.status) ? String(r.status).trim() : '';
    const status = statusCell.toUpperCase();
    if (statusCell && status !== 'ACTIVE' && status !== 'INACTIVE') {
      failures.push({ code, reason: `status "${statusCell}" is not a status — use Active or Inactive.` });
      continue;
    }
    const conflict = category ? plan.conflicts.get(code) : undefined;
    if (conflict) {
      failures.push({ code, reason: conflict });
      continue;
    }
    if (!existing && (!name || !category)) {
      failures.push({
        code,
        reason: `${code} is not in the system, so this row would CREATE it — a new SKU needs a name and a valid category (${categories.map((r) => r.code).join(', ')}).`,
      });
      continue;
    }

    const row: Record<string, unknown> = { code };
    if (name) row.name = name;
    if (category) row.category = category;

    if (statusCell)            row.status = status;
    if (hasVal(r.description)) row.description = String(r.description);
    if (hasVal(r.base_model))  row.base_model = String(r.base_model);
    if (hasVal(r.size_label))  row.size_label = String(r.size_label);
    if (hasVal(r.branding))    row.branding = String(r.branding);

    if (hasVal(r.base_price_sen)) row.base_price_sen = Number(r.base_price_sen);
    if (hasVal(r.price1_sen))     row.price1_sen = Number(r.price1_sen);
    if (hasVal(r.unit_m3_milli))  row.unit_m3_milli = Number(r.unit_m3_milli);

    type SeatEntry = { height: string; priceSen: number; tier?: string };
    const seatRaw = (r.seatHeightPrices ?? r.seat_height_prices) as unknown;
    const rawSeat = (Array.isArray(seatRaw) ? seatRaw : []) as SeatEntry[];
    let badTier: string | null = null;
    const incomingSeat: SeatEntry[] = [];
    for (const e of rawSeat) {
      const t = (e.tier == null || e.tier === '') ? 'PRICE_2' : normalizeSofaTier(e.tier);
      if (!t) { badTier = String(e.tier); break; }
      incomingSeat.push({ ...e, tier: t });
    }
    if (badTier !== null) {
      failures.push({ code, reason: `price tier "${badTier}" not recognized — use P1, P2, P3 or P4` });
      continue;
    }
    const tierOf = (e: SeatEntry) => e.tier ?? 'PRICE_2';

    /* A SKU on a model changes category only with its model: the model and every
       SKU of it move first, once per model, and a failed move writes nothing for
       this row (owner 2026-09-15). */
    const move = existing && category ? plan.moves.get(code) : undefined;
    if (move) {
      let moveError = moveFailed.get(move.modelId);
      if (moveError === undefined && !modelsMoved.some((m) => m.modelId === move.modelId)) {
        const moved = await moveModelCategory(supabase, co.companyId, move.modelId, move.to, categories);
        if (moved.ok) {
          modelsMoved.push({ ...move, skuCount: moved.skuCodes.length });
        } else {
          moveError = `model ${move.modelCode} could not be moved to ${mfgCategoryLabel(categories, move.to)} (${moved.reason}), so this row was not saved.`;
          moveFailed.set(move.modelId, moveError);
        }
      }
      if (moveError !== undefined) {
        failures.push({ code, reason: moveError });
        continue;
      }
    }
    let error;
    if (existing) {
      if (incomingSeat.length > 0) {
        const incomingTiers = new Set(incomingSeat.map(tierOf));
        const existingSeat = (Array.isArray((existing as { seat_height_prices?: unknown }).seat_height_prices)
          ? (existing as { seat_height_prices: SeatEntry[] }).seat_height_prices
          : []);
        const kept = existingSeat.filter((e) => !incomingTiers.has(tierOf(e)));
        row.seat_height_prices = mergeRetailOntoDerivedSeatGrid(existingSeat, [...kept, ...incomingSeat]);
      }
      ({ error } = await supabase.from('mfg_products').update(row).eq('code', code).eq('company_id', activeCompanyId(c)));
    } else {
      if (incomingSeat.length > 0) row.seat_height_prices = incomingSeat;
      // Every NEW SKU belongs to a Model (owner 2026-09-18). name + category are
      // guaranteed present on a create by the guard above; base_model links a
      // variant's SKUs to one shared model, a flat product is its own 1:1 model.
      // Only the INSERT branch touches model_id — an UPDATE of an existing SKU
      // never has its model_id changed.
      const skuCategory = String(row.category);
      const skuBaseModel = typeof row.base_model === 'string' ? row.base_model : null;
      const cacheKey = `${skuCategory}|${modelCodeForSku(skuBaseModel, code)}`;
      let modelId = modelIdCache.get(cacheKey);
      if (modelId === undefined) {
        const ensured = await ensureModelForSku(supabase, {
          companyId: co.companyId,
          code,
          name,
          category: skuCategory,
          baseModel: skuBaseModel,
        });
        if (!ensured.ok) {
          failures.push({ code, reason: ensured.reason });
          continue;
        }
        modelId = ensured.modelId;
        modelIdCache.set(cacheKey, modelId);
      }
      row.model_id = modelId;
      const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const id = `mfg-${rand.replace(/-/g, '').slice(0, 12)}`;
      ({ error } = await supabase.from('mfg_products').insert({
        ...row, id, company_id: activeCompanyId(c), pos_active: newSkuPosActive(co.companyId, skuCategory),
      }));
    }
    if (error) {
      failures.push({ code, reason: error.message });
    } else {
      upserted += 1;
      if (!existing) created += 1;
    }
  }

  return c.json({ upserted, created, failed: failures.length, failures: failures.slice(0, 50), modelsMoved });
};
mfgProducts.post('/batch-import', batchImportMfgProductsHandler);

export const deleteMfgProductHandler = async (c: any) => {
  const gate = await requireRole(c);
  if (!gate.ok) return gate.res;
  const id    = c.req.param('id');
  const force = c.req.query('force') === 'true';
  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: row, error: loadErr } = await scopeToCompanyId(supabase
    .from('mfg_products')
    .select('code')
    .eq('id', id), co.companyId)
    .maybeSingle();
  if (loadErr) return c.json({ error: 'load_failed', reason: loadErr.message }, 500);
  if (!row)    return c.json(NOT_THIS_COMPANY, 404);
  const code = row.code;

  const used = await findSkuUsage(supabase, code);
  if (!used.ok) return c.json(usageCheckFailedBody('SKU', used.reason), 409);
  if (used.usage) {
    return c.json({
      error: 'sku_in_use',
      reason: `“${code}” is used in ${used.usage.where}${used.usage.doc ? ` (${used.usage.doc})` : ''} and can’t be deleted.`,
    }, 409);
  }

  if (force) {
    const cid = co.companyId;
    const cleanup: Array<{ table: string; column: string; value: string; scoped: boolean }> = [
      { table: 'inventory_stock_lots',         column: 'item_code',  value: code, scoped: false },
      { table: 'inventory_movements',          column: 'item_code',  value: code, scoped: true  },
      { table: 'supplier_material_bindings',   column: 'item_code', value: code, scoped: true  },
    ];
    for (const c2 of cleanup) {
      let delQ = supabase.from(c2.table).delete().eq(c2.column, c2.value);
      if (c2.scoped) delQ = delQ.eq('company_id', cid);
      const { error: delErr } = await delQ;
      if (delErr && delErr.code === '42501') {
        return c.json({ error: 'forbidden', reason: `${c2.table}: ${delErr.message}` }, 403);
      }
    }
  }

  const { error } = await scopeToCompanyId(supabase.from('mfg_products').delete().eq('id', id), co.companyId);
  if (error) {
    if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
    if (error.code === '23503') {
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

  const { data: cfg } = await supabase
    .from('product_dept_configs')
    .select('*')
    .eq('item_code', data.code)
    .eq('company_id', activeCompanyId(c))
    .maybeSingle();

  return c.json({ product, deptConfig: cfg ?? null });
});

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
    seatHeightPrices?: Array<{ height: string; priceSen: number; tier?: 'PRICE_1' | 'PRICE_2' | 'PRICE_3' | 'PRICE_4'; sellingPriceSen?: number }>;
    branding?: string | null;
    status?: 'ACTIVE' | 'INACTIVE';
    posActive?: boolean;
    includedAddons?: Array<{ addonId: string; qty: number }>;
    defaultFreeGifts?: Array<{ giftProductId: string; qty: number; campaignName?: string | null }>;
    code?: string;
    name?: string;
    barcode?: string | null;
    category?: string;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const supabase = c.get('supabase');
  const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: current, error: loadErr } = await scopeToCompanyId(supabase
    .from('mfg_products')
    .select('code, category, model_id, base_price_sen, price1_sen, cost_price_sen, sell_price_sen, pwp_price_sen, default_variants, seat_height_prices')
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
  if (body.barcode !== undefined) {
    const trimmed = typeof body.barcode === 'string' ? body.barcode.trim() : null;
    updates.barcode = trimmed ? trimmed : null;
  }
  if (body.category !== undefined && String(body.category).toUpperCase() !== String(current.category ?? '').toUpperCase()) {
    if (current.model_id) {
      return c.json({ error: 'category_on_model', reason: 'This SKU belongs to a model — change the category on the model, and its SKUs move with it.' }, 409);
    }
    if (!categorySwapAllowed(await loadProductCategories(supabase), current.category, body.category)) {
      return c.json({ error: 'category_change_not_allowed', reason: `"${String(body.category)}" is not a product category.` }, 409);
    }
    updates.category = String(body.category).toUpperCase();
  }
  if (body.status === 'ACTIVE' || body.status === 'INACTIVE') {
    updates.status = body.status;
  }
  if (typeof body.posActive === 'boolean') {
    updates.pos_active = body.posActive;
  }
  if (Array.isArray(body.includedAddons)) {
    updates.included_addons = body.includedAddons;
  }
  if (Array.isArray(body.defaultFreeGifts)) {
    updates.default_free_gifts = parseDefaultFreeGifts(body.defaultFreeGifts);
  }
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
  if (Array.isArray(body.seatHeightPrices)) {
    for (const s of body.seatHeightPrices) {
      if (s.sellingPriceSen != null &&
          (!Number.isInteger(s.sellingPriceSen) || s.sellingPriceSen < 0)) {
        return c.json({ error: 'invalid_selling_price' }, 400);
      }
    }
    type Slot = { height: string; priceSen: number; tier?: 'PRICE_1' | 'PRICE_2' | 'PRICE_3' | 'PRICE_4'; sellingPriceSen?: number };
    const oldArr = (Array.isArray(current.seat_height_prices)
      ? (current.seat_height_prices as Slot[])
      : []);
    const newArr = body.seatHeightPrices as Slot[];
    const keyOf = (s: Slot) => `${s.height}|${s.tier ?? 'PRICE_2'}`;

    const oldByKey = new Map(oldArr.map((s) => [keyOf(s), s] as const));
    const mergedArr: Slot[] = newArr.map((s) => ({ ...oldByKey.get(keyOf(s)), ...s }));

    const incomingKeys = new Set(newArr.map(keyOf));
    for (const s of oldArr) {
      if (incomingKeys.has(keyOf(s))) continue;
      if (s.sellingPriceSen == null) continue;
      mergedArr.push({ height: s.height, tier: s.tier ?? 'PRICE_2', sellingPriceSen: s.sellingPriceSen } as Slot);
    }
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
    return c.json({ ok: true, changed: 0 });
  }

  /* SKU-code rename cascade (2990 PR #720, Owner 2026-07-13 MAKOTA→MAKOTO
     typo). The code is snapshotted as TEXT (no FK) across the whole ERP — doc
     lines, supplier bindings and, critically, FIFO stock (inventory_lots keys
     stock ON HAND by item_code). PR #89's plain-column rename silently
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
      if (dupErr) {
        return c.json({
          error: 'duplicate_check_failed',
          reason:
            'Could not check whether another SKU already uses that code, so the rename is refused '
            + `rather than cascaded onto stock and documents unchecked — try again (${dupErr.message}).`,
        }, 409);
      }
      if (dup.length > 0) {
        return c.json({ error: 'duplicate_code', reason: 'Another SKU already uses that code.' }, 409);
      }
      for (const t of PRODUCT_CODE_CASCADE) {
        let q = scopeToCompanyId(
          supabase.from(t.table)
            .update({ [t.col]: newCode }, { count: 'exact' })
            .eq(t.col, oldCode),
          co.companyId,
        );
        if (t.kind) q = q.eq('material_kind', 'mfg_product');
        const { error: cErr, count } = await q;
        if (cErr) {
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
      return c.json({ error: 'duplicate_code', reason: 'Another SKU already uses that code.' }, 409);
    }
    return c.json({ error: 'update_failed', reason: updErr.message }, 500);
  }

  const costFieldChanged = priceChanges.some(
    (ch) =>
      ch.field === 'base_price_sen' ||
      ch.field === 'price1_sen' ||
      ch.field.startsWith('seat_height:'),
  );
  const finalCode = typeof updates.code === 'string' ? (updates.code as string) : (current.code as string);
  if (costFieldChanged && !(await autoDeriveEnabled(supabase, activeCompanyId(c)))) {
    await syncAnchorBindingFromProduct(supabase, finalCode, {
      base_price_sen: 'base_price_sen' in updates
        ? (updates.base_price_sen as number | null)
        : current.base_price_sen,
      price1_sen: 'price1_sen' in updates
        ? (updates.price1_sen as number | null)
        : current.price1_sen,
      seat_height_prices: 'seat_height_prices' in updates
        ? (updates.seat_height_prices as ProductSeatCost[])
        : ((current.seat_height_prices as ProductSeatCost[] | null) ?? null),
    }, activeCompanyId(c) ?? null);
  }

  for (const ch of priceChanges) {
    if (!PRICE_FIELDS.has(ch.field) && !ch.field.startsWith('seat_height')) continue;
    await supabase.from('master_price_history').insert({
      company_id: activeCompanyId(c),
      item_code: finalCode,
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
    ...(Object.keys(cascadeCounts).length > 0 ? { renamed: cascadeCounts } : {}),
  });
};
mfgProducts.patch('/:id', patchMfgProductHandler);

mfgProducts.post('/:id/activate-one-shot', async (c) => {
  const gate = await requireRole(c);
  if (!gate.ok) return gate.res;
  const id = c.req.param('id');
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
    .select('id, item_code, field, old_value_sen, new_value_sen, reason, changed_at, changed_by')
    .eq('item_code', product.code)
    .eq('company_id', activeCompanyId(c))
    .order('changed_at', { ascending: false });

  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const history = (data ?? []) as Array<{ field?: string }>;
  return c.json({ history: canViewScmProductCost(c) ? history : stripProductPriceHistory(history) });
});

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
      id, supplier_id, supplier_sku, unit_price_sen, price_matrix, currency,
      lead_time_days, moq, is_main_supplier, notes,
      suppliers(code, name, phone)
    `)
    .eq('item_code', (product as { code: string }).code)
    .eq('company_id', activeCompanyId(c))
    .order('is_main_supplier', { ascending: false })
    .order('unit_price_sen', { ascending: true });

  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const rows = (data ?? []) as Array<{
    supplier_id: string;
    is_main_supplier: boolean | null;
    unit_price_sen: number | null;
    price_matrix: unknown;
    suppliers?: { name?: string | null } | null;
  }>;
  const resolved = resolveProductCostAnchor(
    (product as { category: string | null }).category,
    rows.map((r) => ({
      supplier_id: r.supplier_id,
      is_main_supplier: r.is_main_supplier,
      unit_price_sen: r.unit_price_sen,
      price_matrix: r.price_matrix,
    })),
  );
  const anchorSupplierName =
    resolved.anchorSupplierId != null
      ? rows.find((r) => r.supplier_id === resolved.anchorSupplierId)?.suppliers?.name ?? null
      : null;
  const anchor = {
    state: resolved.state,
    reason: resolved.reason,
    anchorSupplierId: resolved.anchorSupplierId,
    anchorSupplierName,
    costSen: canViewScmProductCost(c) ? resolved.costSen : null,
    costedCount: resolved.costedCount,
    totalCount: resolved.totalCount,
  };
  return c.json({ product, suppliers: data ?? [], anchor });
});

mfgProducts.get('/:id/cost-history', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  const { data: product, error: pErr } = await scopeToCompany(
    supabase.from('mfg_products').select('code').eq('id', id),
    c,
  ).maybeSingle();
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  if (!product) return c.json({ error: 'not_found' }, 404);

  const { data, error } = await supabase
    .from('mfg_product_cost_history')
    .select('id, base_price_sen, price1_sen, seat_height_prices, source_supplier_id, effective_from, notes, created_by, created_at')
    .eq('item_code', (product as { code: string }).code)
    .eq('company_id', activeCompanyId(c))
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const rows = (data ?? []) as Array<{
    source_supplier_id: string | null;
    base_price_sen: number | null;
    price1_sen: number | null;
    seat_height_prices: unknown;
  } & Record<string, unknown>>;

  const supplierIds = [...new Set(rows.map((r) => r.source_supplier_id).filter((v): v is string => !!v))];
  const nameById = new Map<string, string>();
  if (supplierIds.length > 0) {
    const { data: sup, error: sErr } = await supabase
      .from('suppliers')
      .select('id, name')
      .in('id', supplierIds)
      .eq('company_id', activeCompanyId(c));
    if (sErr) return c.json({ error: 'load_failed', reason: sErr.message }, 500);
    for (const s of (sup ?? []) as Array<{ id: string; name: string | null }>) {
      if (s.name != null) nameById.set(s.id, s.name);
    }
  }

  const canCost = canViewScmProductCost(c);
  const history = rows.map((r) => ({
    id: r.id,
    effectiveFrom: r.effective_from,
    basePriceSen: canCost ? r.base_price_sen : null,
    price1Sen: canCost ? r.price1_sen : null,
    seatHeightPrices: canCost ? r.seat_height_prices : null,
    sourceSupplierId: r.source_supplier_id,
    sourceSupplierName: r.source_supplier_id ? nameById.get(r.source_supplier_id) ?? null : null,
    notes: r.notes ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
  }));
  return c.json({ history });
});

mfgProducts.get('/:id/supplier-price-history', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  const { data: product, error: pErr } = await scopeToCompany(
    supabase.from('mfg_products').select('code, category').eq('id', id),
    c,
  ).maybeSingle();
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  if (!product) return c.json({ error: 'not_found' }, 404);
  const category = (product as { category: string | null }).category;

  const { data, error } = await supabase
    .from('supplier_binding_price_history')
    .select('id, supplier_id, unit_price_sen, price_matrix, is_main_supplier, effective_from, notes, created_by, created_at, suppliers(code, name)')
    .eq('material_kind', 'mfg_product')
    .eq('item_code', (product as { code: string }).code)
    .eq('company_id', activeCompanyId(c))
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const rows = (data ?? []) as Array<{
    id: string;
    supplier_id: string;
    unit_price_sen: number | null;
    price_matrix: unknown;
    is_main_supplier: boolean | null;
    effective_from: string;
    notes: string | null;
    created_by: string | null;
    created_at: string;
    suppliers?: { code?: string | null; name?: string | null } | null;
  }>;

  const priorBySupplier = new Map<string, number>();
  const withDir = rows.map((r) => {
    const cur = comparableCostSen(category, { unit_price_sen: r.unit_price_sen, price_matrix: r.price_matrix });
    return { r, cur };
  });
  for (let i = withDir.length - 1; i >= 0; i--) {
    const { r, cur } = withDir[i];
    const prior = priorBySupplier.get(r.supplier_id);
    (withDir[i] as { dir?: 'up' | 'down' | null }).dir =
      prior === undefined ? null : cur > prior ? 'up' : cur < prior ? 'down' : null;
    priorBySupplier.set(r.supplier_id, cur);
  }

  const canCost = canViewScmProductCost(c);
  const history = withDir.map(({ r, cur }, i) => ({
    id: r.id,
    supplierId: r.supplier_id,
    supplierCode: r.suppliers?.code ?? null,
    supplierName: r.suppliers?.name ?? null,
    isMainSupplier: Boolean(r.is_main_supplier),
    unitPriceSen: canCost ? r.unit_price_sen : null,
    priceMatrix: canCost ? r.price_matrix : null,
    comparableSen: canCost ? cur : null,
    direction: canCost ? (withDir[i] as { dir?: 'up' | 'down' | null }).dir ?? null : null,
    effectiveFrom: r.effective_from,
    notes: r.notes ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
  }));
  return c.json({ history });
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  const sellPriceSen = body.sellPriceSen;
  if (typeof sellPriceSen !== 'number' || !Number.isInteger(sellPriceSen) || sellPriceSen < 0) {
    return c.json({ error: 'sell_price_required', message: 'integer sen >= 0' }, 400);
  }

  const supabase = c.get('supabase');
  const houzsUser = c.get('houzsUser');
  const systemUser = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

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

  const createdBy =
    (houzsUser?.name?.trim() || houzsUser?.email?.trim() ||
      (houzsUser?.id != null ? String(houzsUser.id) : '')) || systemUser.id;

  const today = todayMyt();

  let baselined = false;
  const toInsert: Array<Record<string, unknown>> = [];
  if (effectiveFrom > today && currentSellPriceSen != null) {
    const { data: existing, error: existErr } = await supabase
      .from('mfg_product_price_history')
      .select('id')
      .eq('company_id', co.companyId)
      .eq('item_code', code)
      .limit(1)
      .maybeSingle();
    if (existErr) return c.json({ error: 'load_failed', reason: existErr.message }, 500);
    if (!existing) {
      baselined = true;
      toInsert.push({
        company_id: co.companyId,
        item_code: code,
        sell_price_sen: currentSellPriceSen,
        effective_from: today,
        notes: 'Auto-baseline: current price before the first scheduled change.',
        created_by: createdBy,
      });
    }
  }
  toInsert.push({
    company_id: co.companyId,
    item_code: code,
    sell_price_sen: sellPriceSen,
    effective_from: effectiveFrom,
    notes: body.notes?.trim() ? body.notes.trim() : null,
    created_by: createdBy,
  });

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

export const listPriceChangesHandler = async (c: any) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');
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
    .eq('item_code', code)
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const today = todayMyt();
  const asOf = await resolveSellPriceSenAsOf(supabase, co.companyId, code, today);
  const pending = await resolvePendingSellPriceAfter(supabase, co.companyId, code, today);

  return c.json({
    history: data ?? [],
    currentSellPriceSen: asOf ?? flatSellPriceSen,
    pending: pending ? { sellPriceSen: pending.sellPriceSen, effectiveFrom: pending.effectiveFrom } : null,
  });
};
mfgProducts.get('/:id/price-changes', listPriceChangesHandler);
