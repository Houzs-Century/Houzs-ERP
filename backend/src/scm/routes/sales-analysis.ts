// /sales-analysis — read-only analytics for the Sales Analysis page.
//
// Ported from 2990 apps/api/src/routes/sales-analysis.ts. The heavy aggregation
// lives in the pure vendored core (scm/shared/sales-analysis); this route only
// loads rows (company_2 scoped) and shapes the response. Money is integer centi.
//
// HOUZS ADAPTATIONS vs the 2990 source:
//   • Company scoping — every transactional read is scoped to the active
//     company via scopeToCompany(q, c) (the top-bar switcher isolates each
//     company's books). Combos + product/model master reads are scoped too.
//   • Role gate — 2990 gated on scm.staff.role (DEAD in Houzs: the SCM bridge
//     pins every caller to one super_admin staff row). Replaced with the real
//     Houzs permission gate: GET needs scm.so.view_all (aggregate across every
//     salesperson), PUT /targets needs scm.config.write.
//   • ACCESS gate vs FINANCE gate — two SEPARATE gates, deliberately. Getting
//     ONTO the page is canViewAllSales (whose orders you may aggregate); seeing
//     MARGIN is canViewScmFinance (the money tier). See gateSaFinance below.
//   • is_test — 2990's mfg_sales_orders.is_test column does NOT exist in Houzs.
//     The `includeTest` query param is parsed for contract compatibility but is
//     a no-op here (there is no test flag to filter on).
//   • Customer demographics — CUT, not ported. Houzs scm.customers has no
//     race/birthday/gender columns (2990 POS-capture fields), so those buckets
//     could only ever read 'Unknown' — re-add them only together with the
//     columns and real capture. Geographic buckets (state/city, from the ORDER
//     header) are real and remain. PUT /targets still stores the race/gender/age
//     TARGET profile (owner-entered config, not measured data, and its
//     area targets are live) — its presence is NOT a reason to re-add the
//     buckets. The vendored core keeps its demographics code untouched so it
//     stays byte-comparable with 2990, where the capture exists.
//   • Row-cap safety — reads page through paginateAll/chunkIn (Houzs convention,
//     mirrors reports.ts) instead of 2990's `.limit(100000)`, which PostgREST
//     silently truncates at 1000 rows.
//
// Mounted at '/sales-analysis' in scm/index.ts.

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import { canWriteScmConfig, canViewAllSales, canViewScmFinance } from '../lib/houzs-perms';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import {
  summarizeOverview, monthlyTrend, collapseToPurchases,
  foldProductUnits, buildProductsSection, classifySofaBuild, isFabricUpgrade,
  type SaOrderRow, type SaCustomerRow, type TargetProfile,
  type SaItemRow, type ProductCtx, type VariantRank, type ModelRank,
  type OverviewResult, type MonthlyRow,
} from '../shared/sales-analysis';
import {
  splitSofaCode, comboChargedPrices,
  type SofaComboRow, type SofaPriceTier,
} from '../shared/sofa-combo-pricing';
import {
  loadFabricSellingTiersByIds, loadFabricTierAddonConfig,
  loadModelFabricTierOverrides, loadCompartmentFabricTierOverrides,
} from '../lib/mfg-pricing-recompute';

export const salesAnalysis = new Hono<{ Bindings: Env; Variables: Variables }>();
salesAnalysis.use('*', supabaseAuth);

/**
 * The shapes Houzs SHIPS — the vendored rows minus the demographic blocks (see
 * the header). Everything they sit on (geographic area, order stats, product
 * rankings) is real and is carried through untouched.
 *
 * `marginCenti` is OPTIONAL on these (and grossMarginPct on SaOverviewOut):
 * present for a finance caller, ABSENT for everyone else — gateSaFinance below
 * deletes it. Two INDEPENDENT cuts land on one shape: demographics are dropped
 * for EVERYONE (Houzs captures none), margin only for a NON-FINANCE caller.
 */
type SaCustomerOut = Omit<SaCustomerRow, 'race' | 'birthday' | 'gender' | 'marginCenti'> & { marginCenti?: number };
type VariantOut = Omit<VariantRank, 'demographics'>;   // VariantRank carries no margin
type ModelOut = Omit<ModelRank, 'demographics' | 'variants' | 'marginCenti'>
  & { variants: VariantOut[]; marginCenti?: number };

/**
 * Active-company sofa combos (master scope: B2C default rows only, sales-side).
 * Mirrors the private loadActiveSofaCombos in mfg-sales-orders.ts, plus a
 * company_id scope so a combo authored under the other company never
 * misclassifies this company's builds. Used only to label combo vs custom —
 * this route never re-prices, so the combo price merge is cosmetic here but
 * kept faithful to the billing path.
 */
async function loadCompanyActiveSofaCombos(sb: any, c: any): Promise<SofaComboRow[]> {
  let q = sb
    .from('sofa_combo_pricing')
    .select('id, base_model, modules, tier, customer_id, prices_by_height, selling_prices_by_height, pwp_prices_by_height, label, effective_from, created_at, deleted_at, default_free_gifts')
    .is('deleted_at', null)
    .is('customer_id', null)
    .is('supplier_id', null);
  q = scopeToCompany(q, c);
  const { data } = await q;
  return ((data ?? []) as Array<{
    id: string; base_model: string; modules: string[][]; tier: SofaPriceTier | null;
    customer_id: string | null; prices_by_height: Record<string, number | null>;
    selling_prices_by_height: Record<string, number | null>;
    pwp_prices_by_height: Record<string, number | null> | null;
    label: string | null; effective_from: string; created_at: string; deleted_at: string | null;
    default_free_gifts: unknown;
  }>).map((r) => ({
    id: r.id, baseModel: r.base_model, modules: r.modules ?? [],
    tier: r.tier, customerId: r.customer_id,
    pricesByHeight: comboChargedPrices(r.selling_prices_by_height, r.prices_by_height),
    pwpPricesByHeight: r.pwp_prices_by_height ?? {},
    label: r.label, effectiveFrom: r.effective_from, createdAt: r.created_at, deletedAt: r.deleted_at,
    defaultFreeGifts: r.default_free_gifts ?? [],
  }));
}

/* ── Finance gate — MARGIN rides canViewScmFinance, not the access gate ───────
   The page-access gate (canViewAllSales) answers "whose orders may you
   aggregate"; it is deliberately BROADER than finance — it also admits any
   position holding the `scm.so.view_all` matrix grant, which services/
   permissions.ts defines as a per-rep attribution SCOPING bypass ("View every
   salesperson's My-Orders board"), NOT a money grant. houzs-perms.ts states the
   rule outright: such a caller "must STILL NOT see cost or margin". So margin
   gets its OWN gate — canViewScmFinance (isFinanceViewer = DIRECTOR), which
   fails CLOSED. Owner ruling 2026-07-16: "sales analysis 的毛利 director 可以
   看到" — the DIRECTOR sees margin, which is exactly isFinanceViewer.

   Mirrors gateSoFinance (#625, mfg-sales-orders.ts) / gateDrFinance (#632,
   delivery-returns.ts) — the FOURTH leak of that class.

   Margin is OMITTED, never zeroed: the keys are DELETED for a non-finance
   caller, so the wire carries no margin field at all rather than a `0` / `null`
   that would read as a genuine "no margin" (#632's lying-zero trap). Safe here
   because this route is READ-ONLY for margin — PUT /targets accepts only the
   age/race/gender/area profile keys and scm.analysis_customer_targets holds no
   cost or margin column, so nothing can round-trip a stripped value back.

   Revenue / AOV / delivery / order counts / geography / targets are NOT finance
   and stay for everyone who passed the access gate.

   The *Out types keep the vendored core (shared/sales-analysis.ts, verbatim
   from 2990) untouched: margin becomes optional only on the shape that reaches
   the response, which is where the Houzs-only gate belongs. SaCustomerOut and
   ModelOut (declared above, alongside the demographics cut) carry BOTH cuts —
   one type per shipped shape, not two competing ones. */
type SaOverviewOut = Omit<OverviewResult, 'grossMarginPct'> & { grossMarginPct?: number | null };
type SaMonthlyOut = Omit<MonthlyRow, 'marginCenti'> & { marginCenti?: number };

/** Strip every margin path in place for a non-finance caller. Takes the
 *  ALREADY-demographics-stripped products shape (ModelOut), i.e. exactly what
 *  c.json ships — gating the raw vendored ProductsSection instead would strip a
 *  shape the response never sees. */
function gateSaFinance(
  c: Parameters<typeof canViewScmFinance>[0],
  payload: {
    overview: SaOverviewOut;
    monthly: SaMonthlyOut[];
    customers: SaCustomerOut[];
    products: { byCategory: Record<string, ModelOut[]> };
  },
): void {
  if (canViewScmFinance(c)) return;
  delete payload.overview.grossMarginPct;
  for (const m of payload.monthly) delete m.marginCenti;
  for (const cu of payload.customers) delete cu.marginCenti;
  for (const models of Object.values(payload.products.byCategory)) {
    for (const m of models) delete m.marginCenti;
  }
}

salesAnalysis.get('/', async (c) => {
  const sb = c.get('supabase');

  // ACCESS gate — viewing aggregate sales across EVERY salesperson requires the
  // "view all SOs" permission OR a director position (Sales Director / Super
  // Admin / Finance Manager) — a Director sees all Orders / the Financial
  // Report. canViewAllSales OR-s the two (additive; permission path unchanged).
  // Passing this does NOT grant margin — that is gateSaFinance's call, below.
  if (!canViewAllSales(c)) {
    return c.json({ error: 'forbidden', reason: 'sales_analysis_requires_scm.so.view_all' }, 403);
  }

  const period = (c.req.query('period') ?? 'all').trim(); // 'all' | 'YYYY-MM'
  const includeTest = c.req.query('includeTest') === 'true'; // no-op in Houzs (no is_test column)

  type Raw = {
    doc_no: string; cross_category_source_doc_no: string | null; so_date: string;
    total_revenue_centi: number | null; total_margin_centi: number | null; service_centi: number | null;
    customer_id: string | null;
    city: string | null;
    customer_state: string | null;
  };

  // Load all non-cancelled / non-on-hold orders (monthly trend always spans
  // everything; the period filter scopes only the Overview below). Paged so the
  // 1000-row cap can't truncate a busy history.
  const { data: orderRows, error: ordErr } = await paginateAll<Raw>((from, to) => {
    let q = sb
      .from('mfg_sales_orders')
      .select('doc_no, cross_category_source_doc_no, so_date, total_revenue_centi, total_margin_centi, service_centi, customer_id, city, customer_state')
      .not('status', 'in', '("CANCELLED","ON_HOLD")')
      .order('doc_no')
      .range(from, to);
    q = scopeToCompany(q, c);
    return q;
  });
  if (ordErr) return c.json({ error: 'load_failed', reason: ordErr.message }, 500);

  const allOrders: SaOrderRow[] = ((orderRows ?? []) as Raw[]).map((r) => ({
    docNo: r.doc_no,
    sourceDocNo: r.cross_category_source_doc_no ?? null,
    soDate: r.so_date,
    totalRevenueCenti: Number(r.total_revenue_centi) || 0,
    totalMarginCenti: Number(r.total_margin_centi) || 0,
    serviceCenti: Number(r.service_centi) || 0,
  }));

  const monthly: SaMonthlyOut[] = monthlyTrend(allOrders);
  const scoped = /^\d{4}-\d{2}$/.test(period)
    ? allOrders.filter((row) => row.soDate.slice(0, 7) === period)
    : allOrders;

  // Delivery actually charged = SVC-DELIVERY* lines (base + CROSS + ADD),
  // summed per doc, non-cancelled — for the scoped orders only.
  const docNos = scoped.map((row) => row.docNo);
  const deliveryByDoc = new Map<string, number>();
  if (docNos.length) {
    const { data: delRows, error: delErr } = await chunkIn<{ doc_no: string; total_centi: number | null }>(
      docNos,
      (batch, from, to) => {
        let q = sb
          .from('mfg_sales_order_items')
          .select('doc_no, total_centi')
          .like('item_code', 'SVC-DELIVERY%')
          .eq('cancelled', false)
          .in('doc_no', batch)
          .order('id')
          .range(from, to);
        q = scopeToCompany(q, c);
        return q;
      },
    );
    if (delErr) return c.json({ error: 'load_failed', reason: delErr.message }, 500);
    for (const r of delRows) {
      deliveryByDoc.set(r.doc_no, (deliveryByDoc.get(r.doc_no) ?? 0) + (Number(r.total_centi) || 0));
    }
  }

  const overview: SaOverviewOut = summarizeOverview(scoped, deliveryByDoc);

  // Customer Data section — geographic area from the ORDER header. Per-customer
  // order stats are over the scoped window.
  const custIdByDoc = new Map<string, string | null>();
  for (const r of ((orderRows ?? []) as Raw[])) custIdByDoc.set(r.doc_no, r.customer_id ?? null);
  const ordersByCustomer = new Map<string, SaOrderRow[]>();
  for (const r of scoped) {
    const cid = custIdByDoc.get(r.docNo);
    if (!cid) continue;
    const arr = ordersByCustomer.get(cid);
    if (arr) arr.push(r); else ordersByCustomer.set(cid, [r]);
  }
  let customers: SaCustomerOut[] = [];
  const custIds = [...ordersByCustomer.keys()];
  if (custIds.length) {
    const { data: custRows, error: custErr } = await chunkIn<{ id: string; name: string | null }>(
      custIds,
      (batch, from, to) => {
        let q = sb.from('customers').select('id, name').in('id', batch).order('id').range(from, to);
        q = scopeToCompany(q, c);
        return q;
      },
    );
    if (custErr) return c.json({ error: 'load_failed', reason: custErr.message }, 500);
    const nameById = new Map<string, string>();
    for (const cr of custRows) nameById.set(cr.id, cr.name ?? '');
    const areaByDoc = new Map<string, { city: string | null; state: string | null }>();
    for (const r of ((orderRows ?? []) as Raw[])) {
      areaByDoc.set(r.doc_no, { city: r.city ?? null, state: r.customer_state ?? null });
    }
    customers = custIds.map((cid) => {
      const ords = ordersByCustomer.get(cid)!;
      const purchases = collapseToPurchases(ords).length;
      const sorted = [...ords].sort((a, b) => a.soDate.localeCompare(b.soDate));
      const latest = sorted[sorted.length - 1]!;
      const area = areaByDoc.get(latest.docNo) ?? { city: null, state: null };
      return {
        id: cid,
        name: nameById.get(cid) ?? '',
        state: area.state,
        city: area.city,
        orderCount: purchases,
        ltvCenti: ords.reduce((s, o) => s + o.totalRevenueCenti, 0),
        marginCenti: ords.reduce((s, o) => s + o.totalMarginCenti, 0),
        firstOrderDate: sorted[0]?.soDate ?? null,
        lastOrderDate: latest.soDate,
        isReturning: purchases > 1,
      };
    });
  }

  // Target profile — one row per company (keyed by company_id).
  let tq = sb.from('analysis_customer_targets').select('*');
  tq = scopeToCompany(tq, c);
  const { data: tRow } = await tq.maybeSingle();
  const targets: TargetProfile = {
    ageRangeMin: tRow?.age_range_min ?? null,
    ageRangeMax: tRow?.age_range_max ?? null,
    raceTargets: tRow?.race_targets ?? null,
    genderTargets: tRow?.gender_targets ?? null,
    areaStates: tRow?.area_states ?? [],
    areaCities: tRow?.area_cities ?? [],
  };

  // ── Products section — per-category model/variant ranking. Combo
  // classification mirrors the authoritative SELLING billing path
  // (computeSofaSellingSen): tier PRICE_1, height = variants.depth ?? seatHeight.
  let products = buildProductsSection([]);
  if (docNos.length) {
    // Product lines for the scoped docs, excluding service (its own bucket).
    const { data: lineRows, error: lineErr } = await chunkIn<{
      doc_no: string; item_code: string | null; item_group: string | null;
      qty: number | null; total_centi: number | null; line_cost_centi: number | null;
      variants: Record<string, unknown> | null;
    }>(
      docNos,
      (batch, from, to) => {
        let q = sb
          .from('mfg_sales_order_items')
          .select('doc_no, item_code, item_group, qty, total_centi, line_cost_centi, variants')
          .neq('item_group', 'service')
          .not('item_code', 'like', 'SVC-%')
          .eq('cancelled', false)
          .in('doc_no', batch)
          .order('id')
          .range(from, to);
        q = scopeToCompany(q, c);
        return q;
      },
    );
    if (lineErr) console.error('sales-analysis product-line load failed (products section empty):', lineErr.message ?? lineErr);
    const rawLines = lineRows ?? [];

    // Product master (distinct item_code) + models (distinct model_id).
    const codes = [...new Set(rawLines.map((r) => (r.item_code ?? '').trim()).filter(Boolean))];
    const productByCode = new Map<string, { category: string; modelId: string | null; sizeLabel: string | null; baseModel: string | null }>();
    if (codes.length) {
      const { data: prodRows, error: prodErr } = await chunkIn<{ code: string; category: string | null; model_id: string | null; size_code: string | null; size_label: string | null; base_model: string | null }>(
        codes,
        (batch, from, to) => {
          let q = sb
            .from('mfg_products')
            .select('code, category, model_id, size_code, size_label, base_model')
            .in('code', batch)
            .order('code')
            .range(from, to);
          q = scopeToCompany(q, c);
          return q;
        },
      );
      if (prodErr) console.error('sales-analysis product-master load failed:', prodErr.message ?? prodErr);
      for (const p of prodRows) {
        productByCode.set(p.code, {
          category: String(p.category ?? ''),
          modelId: p.model_id ?? null,
          sizeLabel: p.size_label ?? p.size_code ?? null,
          baseModel: p.base_model ?? null,
        });
      }
    }
    const modelIds = [...new Set([...productByCode.values()].map((p) => p.modelId).filter((x): x is string => !!x))];
    const modelById = new Map<string, string>();
    if (modelIds.length) {
      const { data: modelRows, error: modelErr } = await chunkIn<{ id: string; name: string | null }>(
        modelIds,
        (batch, from, to) => {
          let q = sb.from('product_models').select('id, name').in('id', batch).order('id').range(from, to);
          q = scopeToCompany(q, c);
          return q;
        },
      );
      if (modelErr) console.error('sales-analysis model load failed:', modelErr.message ?? modelErr);
      for (const m of modelRows) modelById.set(m.id, m.name ?? '');
    }

    // Sofa combos (company scope) + fabric-tier config for upgrade detection.
    const combos = await loadCompanyActiveSofaCombos(sb, c);
    const fabricIds = [...new Set(rawLines.map((r) => ((r.variants ?? {}) as Record<string, unknown>).fabricId).filter(Boolean).map(String))];
    const [fabricTiersById, addonConfig, modelOverrides, compartmentOverrides] = await Promise.all([
      loadFabricSellingTiersByIds(sb, fabricIds),
      loadFabricTierAddonConfig(sb, activeCompanyId(c)),
      loadModelFabricTierOverrides(sb),
      loadCompartmentFabricTierOverrides(sb),
    ]);

    const soDateByDoc = new Map(allOrders.map((o) => [o.docNo, o.soDate]));

    const itemRows: SaItemRow[] = rawLines.map((r) => {
      const v = (r.variants ?? {}) as Record<string, unknown>;
      // Height carrier mirrors the billing path (sofaHeightKey = depth ?? seatHeight).
      const heightRaw = v.depth ?? v.seatHeight;
      const seatHeight = heightRaw != null && String(heightRaw).trim() !== '' ? String(heightRaw) : null;
      return {
        docNo: r.doc_no,
        soDate: soDateByDoc.get(r.doc_no) ?? '',
        itemCode: r.item_code ?? '',
        itemGroup: r.item_group ?? '',
        qty: Number(r.qty) || 0,
        totalCenti: Number(r.total_centi) || 0,
        costCenti: Number(r.line_cost_centi) || 0,
        buildKey: (v.buildKey as string) ?? null,
        fabricId: (v.fabricId as string) ?? null,
        legHeight: (v.legHeight as string) ?? null,
        seatHeight,
        isPwp: v.pwp === true,
        // Inert: the vendored SaItemRow requires these. Houzs captures no
        // demographics and the response carries none (see the header).
        race: null, birthday: null, gender: null,
      };
    });

    // buyerByDoc stays EMPTY — foldProductUnits falls back to all-null per doc,
    // so filling it would only rebuild the same nulls under a different name.
    const ctx: ProductCtx = { productByCode, modelById, buyerByDoc: new Map() };
    const units = foldProductUnits(itemRows, ctx);
    for (const u of units) {
      if (u.category !== 'SOFA' && u.category !== 'BEDFRAME') continue;
      const category = u.category as 'SOFA' | 'BEDFRAME';   // narrow (u.category is string)
      const tiers = u.fabricId ? fabricTiersById.get(u.fabricId) : undefined;
      const tier = category === 'SOFA' ? (tiers?.sofaTier ?? null) : (tiers?.bedframeTier ?? null);
      const compartments = category === 'SOFA' ? u.itemCodes.map((code) => splitSofaCode(code).sizeCode).filter(Boolean) : [];
      u.fabricUpgrade = isFabricUpgrade(
        { category, tier, buildCompartments: compartments, modelId: u.modelId },
        addonConfig, modelOverrides, compartmentOverrides,
      );
      if (category === 'SOFA') {
        const lead = u.itemCodes[0] ?? '';
        const baseModel = productByCode.get(lead)?.baseModel ?? splitSofaCode(lead).baseModel;
        // FIDELITY: mirror billing — computeSofaSellingSen matches combos at
        // PRICE_1 and keys height = depth ?? seatHeight.
        const cls = classifySofaBuild(
          {
            baseModel,
            moduleCodes: compartments,
            tier: 'PRICE_1' as SofaPriceTier,
            height: u.seatHeight ?? '24',
            soDate: soDateByDoc.get(u.docNo) ?? '9999-12-31',
            isPwp: u.isPwp,
          },
          combos,
        );
        u.sofaClass = cls.sofaClass;
        u.comboLabel = cls.comboLabel;
        u.variantLabel = cls.comboLabel ?? 'Custom';
      }
    }
    products = buildProductsSection(units);
  }

  // The vendored core hangs a BuyerDemographics block (race / ageBand / gender)
  // off every model and variant. Houzs captures none of it, so it is stripped
  // here rather than shipped as an all-'Unknown' bucket. The rankings it sits on
  // (units / revenue / combo / fabric-upgrade) are real and ship as-is; the
  // margin beside them is finance-only and is gated separately, below.
  const byCategory: Record<string, ModelOut[]> = {};
  for (const [category, models] of Object.entries(products.byCategory)) {
    byCategory[category] = models.map(({ demographics, variants, ...model }) => ({
      ...model,
      variants: variants.map(({ demographics: variantDemographics, ...variant }) => variant),
    }));
  }
  const productsOut: { byCategory: Record<string, ModelOut[]> } = { byCategory };

  // Demographics come off for EVERYONE (above); margin comes off only for a
  // non-finance caller. Gate productsOut — the shape c.json actually ships —
  // NOT the raw vendored `products`, which the response no longer carries.
  gateSaFinance(c, { overview, monthly, customers, products: productsOut });
  return c.json({ period, includeTest, overview, monthly, customers, targets, products: productsOut });
});

salesAnalysis.put('/targets', async (c) => {
  const sb = c.get('supabase');

  // Editing the marketing target profile = SCM master-data config.
  if (!canWriteScmConfig(c)) {
    return c.json({ error: 'forbidden', reason: 'targets_edit_requires_scm.config.write' }, 403);
  }

  const cid = activeCompanyId(c);
  if (cid == null) {
    return c.json({ error: 'company_unresolved', reason: 'no_active_company' }, 409);
  }

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const shares = (v: unknown): Record<string, number> | null => {
    if (!v || typeof v !== 'object') return null;
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const n = Number(val); if (Number.isFinite(n) && n > 0) out[k] = n;
    }
    return Object.keys(out).length ? out : null;
  };
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];

  const row = {
    company_id: cid,
    age_range_min: num(body.ageRangeMin),
    age_range_max: num(body.ageRangeMax),
    race_targets: shares(body.raceTargets),
    gender_targets: shares(body.genderTargets),
    area_states: strArr(body.areaStates),
    area_cities: strArr(body.areaCities),
    updated_at: new Date().toISOString(),
    updated_by: String(c.get('houzsUser')?.id ?? ''),
  };
  const { error } = await sb.from('analysis_customer_targets').upsert(row, { onConflict: 'company_id' });
  if (error) return c.json({ error: 'save_failed', reason: error.message }, 500);

  const targets: TargetProfile = {
    ageRangeMin: row.age_range_min,
    ageRangeMax: row.age_range_max,
    raceTargets: row.race_targets,
    genderTargets: row.gender_targets,
    areaStates: row.area_states,
    areaCities: row.area_cities,
  };
  return c.json({ targets });
});
