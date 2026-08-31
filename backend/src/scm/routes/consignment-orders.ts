// /consignment-orders — B2B consignment orders. Cloned from /mfg-sales-orders
// (HOUZS pattern) onto the consignment_sales_* tables (migration 0153). Same
// request/response shape as the SO route's create/detail so the New Consignment
// Order form can mirror SalesOrderNew's payload near-verbatim.
//
// A Consignment Order writes NO inventory movements (order only — same as SO).
//
// Dropped vs the SO source (consignment doesn't use them):
//   · PWP voucher claim / redemption
//   · cross-category delivery-fee logic (cross_category_source_doc_no)
//   · MRP / stock-allocation feeds + POST /recompute-allocation
//   · SO→PO conversion feeds
//   · POS drift-rejection path (Backend authors the selling price)
//   · po_qty_picked / stock_status writes
// The customer auto-resolve (upsert_customer_by_name_phone) is retained — it's
// a simple, isolated stamp on the header.

import { Hono } from 'hono';
import { z } from 'zod';
import { normalizePhone } from '../shared/phone';
import { PAYMENT_METHOD_CODES } from '../shared/payment-methods';
import {
  pickComboMatch, spreadComboTotal, splitSofaCode, sofaHeightKey,
  buildVariantSummary, comboChargedPrices, type SofaComboRow, type SofaPriceTier,
} from '../shared';
import { supabaseAuth } from '../middleware/auth';
import {
  CO_FINANCE_KEYS, CO_IDENTITY_LOCK_COLS, HEADER, ITEM, MAX_PHOTO_BYTES,
  extFromMime, gateCoFinance, norm,
} from '../lib/consignment-order-shape';
import {
  deriveCountryFromState, deriveSalesLocationFromState, snapshotUnitCostSen,
} from '../lib/sales-doc-derive';
import { escapeForOr } from '../lib/postgrest-search';
import { createMixRefusal, lineMixRefusal } from '../lib/main-mix';
import { dateOrNull, coerceEmptyDates, effectiveDateAfterPatch } from '../lib/date-coerce';
import { resolveSalesScopeIds, salesDocOutOfScope, resolveCallerStaffId } from '../lib/salesScope';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { canViewAllSales, canViewScmFinance, hasHouzsPerm } from '../lib/houzs-perms';
import { warehouseLabel } from '../lib/warehouse-label';
import { todayMyt } from '../lib/my-time';
import { recordSoAudit, diffFields, type FieldChange } from '../lib/so-audit';
import { signSoItemPhotoUrl, soItemPhotoBindings } from '../lib/r2';
import { baseKeyOf, deleteThumbFor, putOptionalThumb, thumbKeyFor } from '../../services/photoThumbs';
import { photoProxyPath, proxyFallbackPayload, warnSigningFailedOnce, type PhotoUrlPayload } from '../lib/photoProxyFallback';
import {
  loadMaintenanceConfig,
  loadSpecialAddons,
  recomputeFromSnapshot,
  loadProductByCode,
  loadFabricByCode,
  loadFabricSellingTiers,
  loadFabricTierAddonConfig,
  loadModelFabricTierOverrides,
  loadCompartmentFabricTierOverrides,
  loadModelSofaModulePrices,
  loadModelSofaModuleCostRows,
  type MfgItemForRecompute,
  type RecomputedLine,
} from '../lib/mfg-pricing-recompute';
import {
  checkAllowedOptions,
  loadProductAndModel,
  variantCheckUnavailableResponse,
} from '../lib/allowed-options-check';
import { findIncompleteVariantLines } from '../lib/so-variant-check';
/* Aggregate ALL Processing-Date gate failures into one response (owner
   2026-07-18) — mirrors the SO path. Pure — no I/O. */
import { collectProcessingGateProblems, validationFailedBody } from '../shared/so-save-problems';
import { soDatePairCascadeColumns, soDatePairRefusal } from '../shared/so-processing-date';
import { validateItemCodes, unknownItemCodeResponse } from '../lib/validate-item-codes';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { SO_ITEM_FINANCE_KEYS, stripAuditFinance } from '../lib/finance-keys';
import type { Env, Variables } from '../env';
import { skuCategoryResolver } from '../lib/sku-category';

export const consignmentOrders = new Hono<{ Bindings: Env; Variables: Variables }>();
consignmentOrders.use('*', supabaseAuth);

/* eslint-disable @typescript-eslint/no-explicit-any */

/* ── CO child-lock guard (Tier 2 — downstream lock) ─────────────────────────
   A CO locks (read-only — no line edit / no CANCELLED transition) once it has
   ANY non-cancelled Delivery Order OR Sales Invoice referencing it. Mirrors the
   SO route's soHasDownstream. Returns the blocking JSON, or null if free. */
async function coHasDownstream(sb: any, coDocNo: string): Promise<{ error: string; message: string } | null> {
  // A Consignment Order's downstream is a Consignment Note (consignment_delivery_orders
  // keyed on consignment_so_doc_no) — NOT the real delivery_orders/sales_invoices
  // tables (those never reference a CS- doc number, so the lock silently never fired).
  const { count: noteCount, error: noteErr } = await sb.from('consignment_delivery_orders')
    .select('id', { head: true, count: 'exact' })
    .eq('consignment_so_doc_no', coDocNo)
    .neq('status', 'CANCELLED');
  /* A failed count is not zero (mirrors scm/lib/downstream-lock.ts). Dropping
     the error made `noteCount ?? 0` read as "no Consignment Note", which is the
     absence that authorises the line edit / CANCELLED transition this guard
     exists to refuse. A failed read must never read as an absence when the
     absence is what authorises the write. */
  if (noteErr) {
    return { error: 'downstream_check_failed', message: `Could not check whether this Consignment Order has a Consignment Note, so it is locked for safety — try again (${noteErr.message}).` };
  }
  if ((noteCount ?? 0) > 0) {
    return { error: 'co_has_downstream', message: 'Consignment Order has a Consignment Note — cancel it first to edit' };
  }
  return null;
}

/* ── Write-side own/downline guard (owner 2026-08-13: "要,和销售订单一致") ──────
   The direct mirror of mfg-sales-orders' selfScopedSalesBlocked; the two must
   keep reading alike, so a difference here is a bug, not a style.

   TWO DIMENSIONS, and neither replaces the other. Company is checked FIRST and
   for EVERYONE: the salesperson dimension answers "is this MY order" and returns
   false straight away for a view-all tier, which is useless for tenancy.

   The company half DEGRADES on an UNRESOLVED company rather than failing closed
   — the repo's three-state contract (companyScope.ts, "THE ALLOW-LIST
   SENTINEL"). Failing closed would lock every user out of every CO write during
   a Hyperdrive cold start, and it costs no strictness: every caller also runs
   requireActiveCompanyId + scopeToCompanyId, which refuse an unresolved company.

   Identity comes off the context as houzsUser.id, NOT the bridge-pinned scm.staff
   uuid on user.id, so it matches the reads. Returns TRUE => block, and the caller
   answers 404, indistinguishable from a nonexistent doc_no. A missing CO also
   returns TRUE (fail closed). Exported so a test can drive it directly. */
export async function selfScopedConsignmentBlocked(c: any, docNo: string): Promise<boolean> {
  const sb = c.get('supabase');

  // 1. Tenancy — every tier, view-all included. Degrading, per the note above.
  const { data: owned, error: ownedErr } = await scopeToCompany(sb.from('consignment_sales_orders').select('doc_no').eq('doc_no', docNo), c).maybeSingle();
  if (ownedErr || !owned) return true;

  // 2. Salesperson — only for the self-scoped tier.
  if (canViewAllSales(c)) return false; // view-all tier (director / office / *)
  const { data, error } = await sb
    .from('consignment_sales_orders')
    .select('salesperson_id')
    .eq('doc_no', docNo)
    .maybeSingle();
  if (error || !data) return true; // fail closed — unknown/unreadable doc is out of scope
  const sp = (data as { salesperson_id?: number | string | null }).salesperson_id;
  return salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, false, sp);
}

/* Identity + value columns a downstream DO / SI snapshots. Frozen on the CO
   header once a non-cancelled child exists; payment / remark / scheduling
   columns are intentionally NOT in this set. Keyed by DB column name. */

/* Server-side combo recompute source. Fetches active master sofa_combo_pricing
   rows once for the cost-side spread in recomputeTotals + the line recompute. */
async function loadActiveSofaCombos(sb: any): Promise<SofaComboRow[]> {
  const { data } = await sb
    .from('sofa_combo_pricing')
    .select('id, base_model, modules, tier, customer_id, prices_by_height, selling_prices_by_height, pwp_prices_by_height, label, effective_from, created_at, deleted_at')
    .is('deleted_at', null)
    .is('customer_id', null)
    .is('supplier_id', null);
  return ((data ?? []) as Array<{
    id: string; base_model: string; modules: string[][]; tier: SofaPriceTier | null;
    customer_id: string | null; prices_by_height: Record<string, number | null>;
    selling_prices_by_height: Record<string, number | null>;
    pwp_prices_by_height: Record<string, number | null> | null;
    label: string | null; effective_from: string; created_at: string; deleted_at: string | null;
  }>).map((r) => ({
    id: r.id, baseModel: r.base_model, modules: r.modules ?? [],
    tier: r.tier, customerId: r.customer_id,
    pricesByHeight: comboChargedPrices(r.selling_prices_by_height, r.prices_by_height),
    pwpPricesByHeight: r.pwp_prices_by_height ?? {},
    label: r.label, effectiveFrom: r.effective_from, createdAt: r.created_at, deletedAt: r.deleted_at,
  }));
}

/* See "WHY A CONSTANT" in shared/so-processing-date.ts. */


/* ── Country auto-derive — look up my_localities for the state's country.
   Falls back to 'Malaysia' for any non-empty-but-unmatched state (2990 is
   Malaysia-only today). Returns null only for an empty state. ──────────── */

/* Sales/shipping Location (warehouse) follows the customer's State. Returns the
   warehouse code for the state, or null when unmapped.

   COMPANY-SCOPED, like the mfg-SO twin. `state` stopped being a global key at
   mig 0092, which made scm.state_warehouse_mappings UNIQUE on
   `(company_id, state)`. Unscoped, this either stamps the OTHER company's
   warehouse onto Sales Location, or — once both companies map the same state —
   matches two rows, so `.maybeSingle()` errors (PGRST116) into the discarded
   `error` and the field silently stops deriving at all. */

const nextDocNo = async (sb: any, c: any): Promise<string> => {
  // Format: CS-YYMM-NNN. max(suffix)+1 (NEVER count+1) so a deleted mid-month
  // row can't make the counter re-mint a surviving number forever — see doc-no.ts.
  const yymm = (() => {
    const d = new Date();
    return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'consignment_sales_orders', 'doc_no', `${p}CS-${yymm}`);
};

/* ── Cost snapshot ──────────────────────────────────────────────────────
   Pull cost_price_sen off mfg_products on line create so the header's
   total_cost_sen / category cost columns get populated even when the
   client doesn't snapshot the cost. Explicit client value (>0) →
   mfg_products.cost_price_sen → 0. Returns sen (integer). ─────────────── */

consignmentOrders.get('/', async (c) => {
  const sb = c.get('supabase');
  // Row-level "own / downline chain" scope (scm.staff uuids) — see lib/salesScope.ts.
  // Pass the REAL Houzs user id, NOT user.id (bridge-pinned staff uuid — was the non-admin 500).
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));
  const status = c.req.query('status');
  const debtor = c.req.query('debtor');

  /* Opt-in server-side pagination + search + sort (mirrors useSuppliersPaged in
     suppliers.ts). The PRESENCE of `page` switches paging on; when it is
     absent/empty the query below is BYTE-IDENTICAL to the historical behavior
     (so_date desc, limit 500, scopeIds + status + debtor + company scope,
     `{ salesOrders }` shape after the same per-doc rollups) — so every existing
     full-list caller is UNAFFECTED. */
  const pageRaw = c.req.query('page');
  const paginate = pageRaw !== undefined && pageRaw !== '';
  const page = Math.max(0, Math.trunc(Number(pageRaw)) || 0);
  const psRaw = Number(c.req.query('pageSize'));
  const pageSize = Number.isFinite(psRaw) && psRaw > 0 ? Math.min(200, Math.max(1, Math.trunc(psRaw))) : 50;

  let data: unknown[] | null;
  let count: number | null = null;
  /* Full-set money KPIs (Revenue / Outstanding / Paid). Pre-pagination the FE
     summed these columns over the whole filtered array; paging broke that (the
     client could only sum the current page). Recomputed server-side here over
     the identical filters. Only present on the paginated path. */
  let aggregates: { revenueSen: number; outstandingSen: number; paidSen: number } | undefined;
  if (!paginate) {
    /* --- LEGACY PATH (unchanged) --- */
    let q = sb.from('consignment_sales_orders').select(HEADER).order('so_date', { ascending: false }).limit(500);
    if (scopeIds) q = q.in('salesperson_id', scopeIds);
    if (status) q = q.eq('status', status);
    if (debtor) q = q.ilike('debtor_name', `%${debtor}%`);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    const res = await q;
    if (res.error) return c.json({ error: 'load_failed', reason: res.error.message }, 500);
    data = res.data ?? [];
  } else {
    /* --- PAGINATED PATH (opt-in via `page`) --- */
    /* Deterministic order + a unique tiebreaker (doc_no — the CO number is
       unique per company) so range paging can't skip/repeat rows that share the
       sort key. Sort over columns already in HEADER (schema-drift safe). */
    const SORT_COLS = new Set(['so_date', 'doc_no', 'debtor_name', 'status', 'local_total_sen']);
    const [rawCol, rawDir] = (c.req.query('sort') ?? 'so_date:desc').split(':');
    const sortCol = SORT_COLS.has(rawCol) ? rawCol : 'so_date';
    const sortAsc = rawDir === 'asc';
    let q = sb.from('consignment_sales_orders').select(HEADER, { count: 'exact' }).order(sortCol, { ascending: sortAsc });
    if (sortCol !== 'doc_no') q = q.order('doc_no', { ascending: false }); // unique tiebreaker
    if (scopeIds) q = q.in('salesperson_id', scopeIds);
    if (status) q = q.eq('status', status);
    if (debtor) q = q.ilike('debtor_name', `%${debtor}%`);
    /* Free-text search over the SAME columns the FE list currently searches +
       that already live in the HEADER select: doc_no + debtor_name. */
    const qText = c.req.query('q');
    if (qText) { const s = escapeForOr(qText); if (s) q = q.or(`doc_no.ilike.%${s}%,debtor_name.ilike.%${s}%`); }
    /* Outstanding-only overlay (?outstanding=1) — the FE's "Outstanding only"
       view (live balance > 0). Applied SERVER-SIDE here so it stays correct
       across pages + so the total/aggregate agree. balance_sen is in HEADER
       (schema-drift safe). Legacy path is untouched (it filtered client-side). */
    const outstanding = c.req.query('outstanding') === '1';
    if (outstanding) q = q.gt('balance_sen', 0);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    q = q.range(page * pageSize, page * pageSize + pageSize - 1);
    const res = await q;
    if (res.error) return c.json({ error: 'load_failed', reason: res.error.message }, 500);
    data = res.data ?? [];
    count = res.count ?? (res.data?.length ?? 0);

    /* Full-set money KPIs — sum local_total_sen (Revenue) / balance_sen
       (Outstanding, only when > 0) / paid_sen (Paid) over the SAME scope +
       status + debtor + search + outstanding filters as the page query, WITHOUT
       .range(). Mirrors the pre-pagination client KPI (liveBalance = balance_sen
       fallback local_total − paid). paginateAll pages past the 1000-row cap.
       All three columns are already in HEADER (schema-drift safe). */
    const moneyRes = await paginateAll<{ local_total_sen: number | null; balance_sen: number | null; paid_sen: number | null }>((mfrom, mto) => {
      let mq = sb.from('consignment_sales_orders').select('local_total_sen, balance_sen, paid_sen');
      if (scopeIds) mq = mq.in('salesperson_id', scopeIds);
      if (status) mq = mq.eq('status', status);
      if (debtor) mq = mq.ilike('debtor_name', `%${debtor}%`);
      if (qText) { const s = escapeForOr(qText); if (s) mq = mq.or(`doc_no.ilike.%${s}%,debtor_name.ilike.%${s}%`); }
      if (outstanding) mq = mq.gt('balance_sen', 0);
      mq = scopeToCompany(mq, c);
      return mq.range(mfrom, mto);
    });
    if (moneyRes.error) return c.json({ error: 'load_failed', reason: moneyRes.error.message }, 500);
    let revenueSen = 0, outstandingSen = 0, paidSen = 0;
    for (const m of (moneyRes.data ?? [])) {
      revenueSen += m.local_total_sen ?? 0;
      paidSen += m.paid_sen ?? 0;
      const bal = m.balance_sen ?? ((m.local_total_sen ?? 0) - (m.paid_sen ?? 0));
      if (bal > 0) outstandingSen += bal;
    }
    aggregates = { revenueSen, outstandingSen, paidSen };
  }

  const rows = (data ?? []) as unknown as Array<{ doc_no?: string } & Record<string, unknown>>;
  const docNos = rows.map((r) => r.doc_no).filter((x): x is string => !!x);
  if (docNos.length > 0) {
    /* Per-CO category set + first-item branding source, mirroring the SO list.
       Ordered (doc_no, created_at ASC) so the FIRST line per doc_no is its
       earliest. */
    // chunkIn — lines across the listed docs can exceed PostgREST's 1000-row
    // cap; page so per-doc category/branding rollups aren't dropped.
    const { data: itemRows } = await chunkIn<Record<string, unknown>>(docNos, (batch, from, to) => sb
      .from('consignment_sales_order_items')
      .select('doc_no, item_group, cancelled, branding, item_code, created_at')
      .in('doc_no', batch)
      .eq('cancelled', false)
      .order('doc_no')
      .order('created_at', { ascending: true })
      .range(from, to));
    const cats = new Map<string, Set<string>>();
    const firstCat = new Map<string, string>();
    const firstBranding = new Map<string, string | null>();
    const firstItemCode = new Map<string, string | null>();
    const normCategory = (raw: string): string => {
      const g = (raw ?? '').trim().toUpperCase();
      if (g.includes('BEDFRAME')) return 'BEDFRAME';
      if (g.includes('SOFA'))     return 'SOFA';
      if (g.includes('MATTRESS')) return 'MATTRESS';
      if (g.includes('ACCESSOR')) return 'ACCESSORY';
      return 'OTHERS';
    };
    for (const it of (itemRows ?? []) as Array<{ doc_no: string; item_group: string; cancelled: boolean; branding: string | null; item_code: string | null; created_at: string | null }>) {
      let catSet = cats.get(it.doc_no);
      if (!catSet) { catSet = new Set(); cats.set(it.doc_no, catSet); }
      catSet.add(normCategory(it.item_group));
      if (!firstCat.has(it.doc_no)) {
        firstCat.set(it.doc_no, normCategory(it.item_group));
        firstBranding.set(it.doc_no, it.branding ?? null);
        firstItemCode.set(it.doc_no, it.item_code ?? null);
      }
    }

    /* Mattress brand fallback from mfg_products.branding when the first line is a
       MATTRESS with blank own branding. */
    const mattressCodesToLookup = new Set<string>();
    for (const [docNo, cat] of firstCat) {
      if (cat !== 'MATTRESS') continue;
      const b = firstBranding.get(docNo);
      if (b && b.trim()) continue;
      const code = firstItemCode.get(docNo);
      if (code) mattressCodesToLookup.add(code);
    }
    const productBranding = new Map<string, string>();
    if (mattressCodesToLookup.size > 0) {
      const { data: prodRows } = await scopeToCompany(
        sb
          .from('mfg_products')
          .select('code, branding')
          .in('code', [...mattressCodesToLookup]),
        c,
      );
      for (const p of (prodRows ?? []) as Array<{ code: string; branding: string | null }>) {
        if (p.branding && p.branding.trim()) productBranding.set(p.code, p.branding);
      }
    }

    /* Payment Method summary from the payments LEDGER. */
    const paymentMethods = new Map<string, Set<string>>();
    {
      const { data: payRows } = await sb
        .from('consignment_sales_order_payments')
        .select('so_doc_no, method, online_type')
        .in('so_doc_no', docNos);
      for (const p of (payRows ?? []) as Array<{ so_doc_no: string; method: string | null; online_type: string | null }>) {
        const m = (p.method ?? '').trim().toLowerCase();
        let label: string;
        if (m === 'cash') label = 'Cash';
        else if (m === 'merchant') label = 'Card';
        else if (m === 'transfer') label = (p.online_type && p.online_type.trim()) ? p.online_type.trim() : 'Transfer';
        else continue;
        let set = paymentMethods.get(p.so_doc_no);
        if (!set) { set = new Set(); paymentMethods.set(p.so_doc_no, set); }
        set.add(label);
      }
    }

    /* Tier 2 downstream-lock — mark has_children on any CO that has a
       non-cancelled Consignment Note (consignment_delivery_orders) referencing
       it. (Was wrongly querying the real delivery_orders/sales_invoices tables,
       which a CS- doc number never matches, so the flag was always false.) */
    const downstreamDocNos = new Set<string>();
    const noteRowsRes = await sb.from('consignment_delivery_orders')
      .select('consignment_so_doc_no').in('consignment_so_doc_no', docNos).neq('status', 'CANCELLED');
    for (const d of ((noteRowsRes.data ?? []) as Array<{ consignment_so_doc_no: string | null }>)) {
      if (d.consignment_so_doc_no) downstreamDocNos.add(d.consignment_so_doc_no);
    }

    for (const r of rows) {
      const docNo = r.doc_no ?? '';
      (r as Record<string, unknown>).item_categories = [...(cats.get(docNo) ?? [])].sort();
      (r as Record<string, unknown>).has_children = downstreamDocNos.has(docNo);
      const fCat = firstCat.get(docNo);
      (r as Record<string, unknown>).first_item_category = fCat ?? null;
      let fBranding = firstBranding.get(docNo) ?? null;
      if (fCat === 'MATTRESS' && (!fBranding || !fBranding.trim())) {
        const code = firstItemCode.get(docNo);
        fBranding = (code && productBranding.get(code)) || fBranding;
      }
      (r as Record<string, unknown>).first_item_branding = fBranding;
      const pm = paymentMethods.get(docNo);
      (r as Record<string, unknown>).payment_methods_summary = pm ? [...pm].sort().join(' + ') : '';
    }
  }

  /* Strip the header finance keys for a non-finance caller (list half). The
     `aggregates` block is Revenue / Outstanding / Paid only — no cost or margin
     — so it needs no gate (unlike the Consignment Note / Return lists, whose
     aggregates DO carry cost + margin). */
  gateCoFinance(c, rows, null);

  if (paginate) return c.json({ salesOrders: rows, total: count ?? rows.length, page, pageSize, aggregates });
  return c.json({ salesOrders: rows });
});

/* "My consignment orders" board — the salesperson's OWN COs (lightweight). */
consignmentOrders.get('/mine', async (c) => {
  const sb = c.get('supabase'); const user = c.get('user');
  /* Attribution fix (mirror mfg-sales-orders.ts:1073): the SCM auth bridge
     pins user.id to ONE shared system scm.staff uuid, so filtering by it
     always returns empty. Resolve the caller's OWN deterministic staff uuid
     (mig-0066 link) for the self-view. */
  const myStaffId = (await resolveCallerStaffId(sb, c.get('houzsUser')?.id)) ?? user.id;
  // Company-scoped (owner 2026-08-10 audit): a rep granted to both companies
  // otherwise gets one pooled board instead of the active company's.
  const { data, error } = await scopeToCompany(
    sb
      .from('consignment_sales_orders')
      .select(
        'doc_no, debtor_name, phone, email, address1, address2, city, postcode, customer_state, ' +
        'customer_delivery_date, processing_date, status, payment_method, approval_code, note, so_date, created_at, ' +
        'total_revenue_sen, line_count, deposit_sen',
      )
      .eq('salesperson_id', myStaffId)
      /* `on_hold` since mig 0324 — the hold is a MARKER beside the status now,
         so the status arm below can no longer see one on its own. */
      .eq('on_hold', false)
      .not('status', 'in', '("CANCELLED","ON_HOLD")'),
    c,
  )
    .order('created_at', { ascending: false })
    .limit(80);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const rows = (data ?? []) as unknown as Array<{ doc_no?: string; deposit_sen?: number } & Record<string, unknown>>;
  const docNos = rows.map((r) => r.doc_no).filter((x): x is string => !!x);
  const itemsByDoc = new Map<string, Array<{ item_code: string; description: string | null; qty: number; total_sen: number; variants: unknown }>>();
  if (docNos.length > 0) {
    const { data: itemRows } = await sb
      .from('consignment_sales_order_items')
      .select('doc_no, item_code, description, qty, total_sen, variants')
      .in('doc_no', docNos)
      .eq('cancelled', false)
      .order('created_at', { ascending: true });
    for (const it of (itemRows ?? []) as Array<{ doc_no: string; item_code: string; description: string | null; qty: number; total_sen: number; variants: unknown }>) {
      const arr = itemsByDoc.get(it.doc_no) ?? [];
      arr.push({ item_code: it.item_code, description: it.description, qty: it.qty, total_sen: it.total_sen, variants: it.variants });
      itemsByDoc.set(it.doc_no, arr);
    }
  }

  const paidLedgerByDoc = new Map<string, number>();
  if (docNos.length > 0) {
    const { data: payRows } = await sb
      .from('consignment_sales_order_payments')
      .select('so_doc_no, amount_sen')
      .in('so_doc_no', docNos);
    for (const p of (payRows ?? []) as Array<{ so_doc_no: string; amount_sen: number }>) {
      paidLedgerByDoc.set(p.so_doc_no, (paidLedgerByDoc.get(p.so_doc_no) ?? 0) + (p.amount_sen ?? 0));
    }
  }

  const salesOrders = rows.map((r) => {
    const deposit = typeof r.deposit_sen === 'number' ? r.deposit_sen : 0;
    const ledger = paidLedgerByDoc.get(r.doc_no ?? '') ?? 0;
    return {
      ...r,
      paid_sen_total: deposit + ledger,
      items: itemsByDoc.get(r.doc_no ?? '') ?? [],
    };
  });

  return c.json({ salesOrders });
});

/* Per-CO-line delivery breakdown — which Consignment Note (=DO) shipped how
   much against each order line. Mirrors the SO detail's per-line `deliveries`.
   Cancelled notes are excluded. Read-only; powers the "Delivered" column. */
type CoLineDelivery = { noNumber: string; qty: number; status: string };
async function coLineDeliveries(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  soItemIds: string[],
): Promise<Map<string, CoLineDelivery[]>> {
  const out = new Map<string, CoLineDelivery[]>();
  if (soItemIds.length === 0) return out;
  const { data: doLines } = await sb
    .from('consignment_delivery_order_items')
    .select('consignment_so_item_id, qty, consignment_delivery_order_id')
    .in('consignment_so_item_id', soItemIds);
  const rows = (doLines ?? []) as Array<{
    consignment_so_item_id: string | null; qty: number; consignment_delivery_order_id: string;
  }>;
  const doIds = [...new Set(rows.map((r) => r.consignment_delivery_order_id).filter(Boolean))];
  if (doIds.length === 0) return out;
  const { data: dos } = await sb.from('consignment_delivery_orders')
    .select('id, do_number, status').in('id', doIds);
  const doMeta = new Map<string, { noNumber: string; status: string }>();
  for (const g of (dos ?? []) as Array<{ id: string; do_number: string | null; status: string | null }>) {
    if ((g.status ?? '').toUpperCase() === 'CANCELLED') continue;
    doMeta.set(g.id, { noNumber: g.do_number ?? '—', status: (g.status ?? '').toUpperCase() });
  }
  for (const r of rows) {
    if (!r.consignment_so_item_id) continue;
    const meta = doMeta.get(r.consignment_delivery_order_id);
    if (!meta) continue;
    const qty = Number(r.qty ?? 0);
    if (qty <= 0) continue;
    const arr = out.get(r.consignment_so_item_id) ?? [];
    arr.push({ noNumber: meta.noNumber, qty, status: meta.status });
    out.set(r.consignment_so_item_id, arr);
  }
  return out;
}

consignmentOrders.get('/:docNo', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  const [h, i] = await Promise.all([
    scopeToCompany(sb.from('consignment_sales_orders').select(`${HEADER}, signature_b64`).eq('doc_no', docNo), c).maybeSingle(),
    sb.from('consignment_sales_order_items').select(ITEM).eq('doc_no', docNo).order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  /* Own/downline sales scope (lib/salesScope.ts) — mirror the SO detail. A
     scoped seller must not read another salesperson's CO/finance by
     enumerating doc_nos; out-of-scope → 404. Directors/view-all bypass.
     HEADER carries salesperson_id already. */
  {
    const sp = (h.data as { salesperson_id?: number | string | null }).salesperson_id;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), sp)) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
  /* Tier 2 downstream-lock — stamp has_children from the Consignment Note table
     (consignment_delivery_orders), the CO's real downstream. */
  const { count: noteCount } = await sb.from('consignment_delivery_orders')
    .select('id', { head: true, count: 'exact' })
    .eq('consignment_so_doc_no', docNo)
    .neq('status', 'CANCELLED');
  const salesOrder = {
    ...(h.data as unknown as Record<string, unknown>),
    has_children: (noteCount ?? 0) > 0,
  };
  const itemRows = (i.data ?? []) as unknown as Array<Record<string, unknown> & { id: string }>;
  const deliveriesMap = await coLineDeliveries(sb, itemRows.map((it) => it.id));
  const items = itemRows.map((it) => ({ ...it, deliveries: deliveriesMap.get(it.id) ?? [] }));
  gateCoFinance(c, salesOrder, items);
  // Stamp each line's supplier fabric code so the on-screen line reads
  // "BF-01 (PC151-01)" — same READ enrichment as the SO/PO/DO/SI details
  // (owner 2026-07-24). ONE batched query; fail-soft.
  await enrichLinesWithFabricSupplierCode(sb, c, items);
  return c.json({ salesOrder, items });
});

/* NO selfScopedConsignmentBlocked HERE, deliberately — the phrase the exemption
   test greps for. The guard answers "is this EXISTING doc mine", and a create
   has no target row, so calling it would refuse every create.

   OPEN, for the owner: mfg-sales-orders gates `salesperson_id` on
   `scm.so.attribute_other` and OVERRIDES a self-scoped caller's chosen
   salespersonId; this path takes `body.salespersonId` verbatim, so a scoped rep
   can book a NEW consignment order under someone else's name. That changes who
   gets paid and is a different control from the row scope ruled on above. */
consignmentOrders.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const customerName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!customerName) return c.json({ error: 'customer_name_required' }, 400);
  /* Phone is COMPULSORY (mirrors the SO route). Normalise once for both the
     header snapshot and the customer identity key. */
  const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!rawPhone) {
    return c.json({ error: 'phone_required', reason: 'A phone number is required on every consignment order.' }, 400);
  }
  const normPhone = normalizePhone(rawPhone) ?? rawPhone;
  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];

  const sb = c.get('supabase'); const user = c.get('user');
  const coGroupOf = await skuCategoryResolver(sb, items.map((it) => ({ materialKind: 'mfg_product', itemCode: it.itemCode })), activeCompanyId(c) ?? null);

  // itemCode catalog guard.
  if (items.length > 0) {
    const codeCheck = await validateItemCodes(sb, items.map((it) => it.itemCode as string | null | undefined), activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* See "THE PAIR RULE" in shared/so-processing-date.ts. */
  {
    const procDate  = (body.processingDate as string | null | undefined) || null;
    const delivDate = (body.customerDeliveryDate as string | null | undefined) || null;
    /* must-pair stays a short-circuit (structurally-incomplete date pair), and
       the predicate is shared/so-processing-date's so the CO paths cannot drift
       from the SO paths. Every date on a create is new — no originals. */
    const coCreatePairRefusal = soDatePairRefusal({
      nextProc: procDate, nextDeliv: delivDate, origProc: null, origDeliv: null,
    });
    if (coCreatePairRefusal) return c.json(coCreatePairRefusal, 400);
    /* Aggregate the rest (variants / past-date / processing-≤-delivery) into ONE
       response — mirrors the SO create path. No deposit gate on the consignment
       mirror, so `deposit` is omitted. All dates are new on create. */
    const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const coProblems = collectProcessingGateProblems({
      procDate,
      delivDate,
      todayMY,
      variantOffenders: procDate
        ? findIncompleteVariantLines(
            items.map((it) => ({
              itemCode: String(it.itemCode ?? ''),
              group:    (it.itemGroup as string | null | undefined) ?? null,
              variants: (it.variants as Record<string, unknown> | null) ?? null,
            })),
          )
        : [],
    });
    if (coProblems.length > 0) return c.json(validationFailedBody(coProblems), 422);
    /* Sofa is exclusive among MAIN products — one rule, one home
       (lib/main-mix.ts), shared with the SO paths and with this router's own
       add-line / edit-line handlers below. Loo 2026-06-07 — mattress BRAND
       mixing is allowed (old Rule 3 `so_mattress_one_brand` removed). */
    const mainMix = await createMixRefusal(sb, items, activeCompanyId(c));
    if (mainMix) return c.json(mainMix.body, mainMix.status);
  }

  // Minted inside insertWithDocNoRetry below so a concurrent-create collision
  // (23505 on doc_no) re-derives the next free number; the winning value is
  // captured here for the items insert / audit / response.
  let docNo = '';

  /* Auto-stamp venue_id from the caller's staff.venue_id when they're a
     POS-side role. Backend-only roles leave it NULL; an explicit body.venueId
     overrides. */
  let venueIdToStamp: string | null = (body.venueId as string | null | undefined) ?? null;
  if (!venueIdToStamp) {
    const { data: callerStaff } = await sb
      .from('staff')
      .select('role, venue_id')
      .eq('id', user.id)
      .maybeSingle();
    if (callerStaff && callerStaff.venue_id &&
        ['sales', 'sales_executive', 'outlet_manager'].includes(callerStaff.role)) {
      venueIdToStamp = callerStaff.venue_id as string;
    }
  }

  // Compute totals + category breakdown
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0;
  const headerDeliveryDate = dateOrNull(body.customerDeliveryDate);

  const cachedConfig = await loadMaintenanceConfig(sb);
  const cachedSpecialAddons = await loadSpecialAddons(sb);
  /* allowed_options pre-flight — run BEFORE the pricing recompute so a
     disallowed variant returns the precise field/value/allowed payload. */
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    const code = String(it.itemCode ?? '');
    if (!code) continue;
    const { product, model, lookupError } = await loadProductAndModel(sb, code, activeCompanyId(c));
    // A failed catalog read is ignorance, not permission — refuse, don't skip the gate.
    if (lookupError) return c.json(variantCheckUnavailableResponse(lookupError), 409);
    const err = checkAllowedOptions(
      product,
      model,
      (it.variants as Parameters<typeof checkAllowedOptions>[2]) ?? null,
    );
    if (err) {
      return c.json({ ...err, lineIdx: i, itemCode: code }, 400);
    }
  }
  const cachedCombos = await loadActiveSofaCombos(sb);
  const cachedFabricAddonConfig = await loadFabricTierAddonConfig(sb, activeCompanyId(c));
  const cachedModelOverrides = await loadModelFabricTierOverrides(sb);  // migration 0172 — per-Model Δ
  const cachedCompartmentOverrides = await loadCompartmentFabricTierOverrides(sb);  // migration 0025 — per-compartment Δ

  const lineProducts = await Promise.all(
    items.map((it) => loadProductByCode(sb, String(it.itemCode ?? ''), activeCompanyId(c))),
  );

  /* Resolve the REAL customer identity (find-or-create by name + phone) and
     stamp it on the CO. Best-effort — an RPC error must not block the order. */
  let orderCustomerId: string | null = null;
  {
    const { data: resolvedCustomerId, error: customerErr } = await sb.rpc('upsert_customer_by_name_phone', {
      p_name:  customerName,
      p_phone: normPhone,
      p_email: typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null,
      p_company_id: activeCompanyId(c) ?? null,  // mig 0164 — scope resolve to active company
    });
    if (customerErr) {
      console.error('[consignment-order] customer resolve failed:', customerErr.message ?? customerErr);
    } else {
      orderCustomerId = (resolvedCustomerId as string | null) ?? null;
    }
  }

  const recomputes: Array<RecomputedLine | null> = await Promise.all(items.map(async (it, idx) => {
    const itemCode = String(it.itemCode ?? '');
    if (!itemCode) return null;
    const product = lineProducts[idx] ?? null;
    const [fabric, sellingTiers] = await Promise.all([
      loadFabricByCode(sb, (it.variants as { fabricCode?: string } | null)?.fabricCode ?? null),
      loadFabricSellingTiers(sb, (it.variants as { fabricId?: string } | null)?.fabricId ?? null),
    ]);
    // Audit 2026-06-11 C2 — module COST rows so a build's cost = Σ module costs.
    const [sofaModulePrices, sofaModuleCostRows] = product?.category === 'SOFA'
      ? await Promise.all([
          loadModelSofaModulePrices(
            sb,
            product.base_model,
            String((it.variants as { depth?: unknown } | null)?.depth ?? '24'),
            activeCompanyId(c),
          ),
          loadModelSofaModuleCostRows(sb, product.base_model, activeCompanyId(c)),
        ])
      : [null, null];
    const draft: MfgItemForRecompute = {
      itemCode,
      itemGroup:      String(it.itemGroup ?? 'others'),
      qty:            Number(it.qty ?? 1),
      unitPriceSen: Number(it.unitPriceSen ?? 0),
      variants:       (it.variants as MfgItemForRecompute['variants']) ?? null,
    };
    return recomputeFromSnapshot(draft, product, fabric, cachedConfig, cachedCombos, sofaModulePrices, sellingTiers, cachedFabricAddonConfig, null, null, cachedSpecialAddons, sofaModuleCostRows, cachedModelOverrides, cachedCompartmentOverrides);
  }));

  /* Task #114 — snapshot unit cost from mfg_products when client didn't. */
  const itemRows = await Promise.all(items.map(async (it, idx) => {
    const qty = Number(it.qty ?? 1);
    const recomputed = recomputes[idx] ?? null;
    /* The server-computed selling price (the bound price-list figure) is always
       persisted — the Backend is costing-only. Backend authors the price; no
       drift rejection (consignment has no POS path). */
    const unit = recomputed ? recomputed.unit_price_sen : Number(it.unitPriceSen ?? 0);
    const discount = Number(it.discountSen ?? 0);
    // Audit 2026-06-20 — clamp like the PO create path (negative-money guard).
    const lineTotal = Math.max(0, (qty * unit) - discount);
    const itemCode = String(it.itemCode ?? '');
    const unitCost = recomputed && recomputed.unit_cost_sen > 0
      ? recomputed.unit_cost_sen
      : await snapshotUnitCostSen(sb, itemCode, Number(it.unitCostSen ?? 0), c);
    const lineCost = unitCost * qty;
    const group = String(it.itemGroup ?? '').toLowerCase();
    total += lineTotal;
    totalCost += lineCost;
    if (group.includes('mattress') || group.includes('sofa')) {
      mattressSofa += lineTotal;
      mattressSofaCost += lineCost;
    } else if (group.includes('bedframe')) {
      bedframe += lineTotal;
      bedframeCost += lineCost;
    } else if (group.includes('accessor')) {
      accessories += lineTotal;
      accessoriesCost += lineCost;
    } else {
      others += lineTotal;
      othersCost += lineCost;
    }
    const hasExplicitLineDate = it.lineDeliveryDate !== undefined && it.lineDeliveryDate !== null;
    const lineDeliveryDate = hasExplicitLineDate
      ? dateOrNull(it.lineDeliveryDate)
      : headerDeliveryDate;
    const lineDeliveryDateOverridden = hasExplicitLineDate
      ? (it.lineDeliveryDateOverridden === undefined ? true : Boolean(it.lineDeliveryDateOverridden))
      : Boolean(it.lineDeliveryDateOverridden ?? false);
    return {
      line_date: dateOrNull(it.lineDate) ?? todayMyt(),
      debtor_code: (body.debtorCode as string) ?? null,
      debtor_name: body.debtorName,
      agent: (body.agent as string) ?? null,
      item_group: coGroupOf(it) ?? 'others',
      item_code: it.itemCode,
      description: (it.description as string) ?? null,
      description2: buildVariantSummary(String(coGroupOf(it) ?? ''), (it.variants as Record<string, unknown> | null) ?? null) || null,
      uom: (it.uom as string) ?? 'UNIT',
      qty,
      unit_price_sen: unit,
      discount_sen: discount,
      total_sen: lineTotal,
      total_inc_sen: lineTotal,
      balance_sen: lineTotal,
      variants: (it.variants as unknown) ?? null,
      unit_cost_sen: unitCost,
      line_cost_sen: lineCost,
      line_margin_sen: lineTotal - lineCost,
      divan_price_sen:         recomputed?.divan_price_sen ?? 0,
      leg_price_sen:           recomputed?.leg_price_sen ?? 0,
      special_order_price_sen: recomputed?.special_order_sen ?? 0,
      custom_specials:         recomputed?.custom_specials ?? null,
      line_delivery_date: lineDeliveryDate,
      line_delivery_date_overridden: lineDeliveryDateOverridden,
    };
  }));

  const margin = total - totalCost;
  const marginPctBasis = total > 0 ? Math.round((margin / total) * 10000) : 0;

  const customerCountrySnapshot = await deriveCountryFromState(
    sb,
    (body.customerState as string | null | undefined) ?? null,
  );

  const derivedSalesLocation =
    (body.salesLocation as string | null | undefined) ??
    (await deriveSalesLocationFromState(
      sb,
      (body.customerState as string | null | undefined) ?? null,
      c,
    ));

  const { error: hErr } = await insertWithDocNoRetry<{ doc_no: string }>(
    () => nextDocNo(sb, c),
    (n) => { docNo = n; return sb.from('consignment_sales_orders').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    doc_no: docNo,
    transfer_to: (body.transferTo as string) ?? null,
    so_date: dateOrNull(body.soDate) ?? todayMyt(),
    branding: (body.branding as string) ?? null,
    debtor_code: (body.debtorCode ?? body.customerCode as string) ?? null,
    debtor_name: customerName,
    agent: (body.agent as string) ?? null,
    sales_location: derivedSalesLocation ?? null,
    ref: (body.ref as string) ?? null,
    po_doc_no: (body.poDocNo as string) ?? null,
    venue: (body.venue as string) ?? null,
    venue_id: venueIdToStamp,
    address1: (body.address1 as string) ?? null,
    address2: (body.address2 as string) ?? null,
    address3: (body.address3 as string) ?? null,
    address4: (body.address4 as string) ?? null,
    phone: normPhone,
    mattress_sofa_sen: mattressSofa,
    bedframe_sen: bedframe,
    accessories_sen: accessories,
    others_sen: others,
    mattress_sofa_cost_sen: mattressSofaCost,
    bedframe_cost_sen:      bedframeCost,
    accessories_cost_sen:   accessoriesCost,
    others_cost_sen:        othersCost,
    local_total_sen: total,
    balance_sen: total,
    total_cost_sen: totalCost,
    total_revenue_sen: total,
    total_margin_sen: margin,
    margin_pct_basis: marginPctBasis,
    line_count: items.length,
    currency: ((body.currency as string) ?? 'MYR').toUpperCase(),
    note: (body.note as string) ?? null,
    email: (body.email as string) ?? null,
    customer_type: (body.customerType as string) ?? null,
    salesperson_id: (body.salespersonId as string) ?? null,
    city: (body.city as string) ?? null,
    postcode: (body.postcode as string) ?? null,
    building_type: (body.buildingType as string) ?? null,
    emergency_contact_name: (body.emergencyContactName as string) ?? null,
    emergency_contact_phone: typeof body.emergencyContactPhone === 'string'
      ? (normalizePhone(body.emergencyContactPhone) ?? body.emergencyContactPhone)
      : null,
    emergency_contact_relationship: (body.emergencyContactRelationship as string) ?? null,
    target_date: dateOrNull(body.targetDate),
    customer_id: orderCustomerId,
    customer_state: (body.customerState as string) ?? null,
    customer_country: customerCountrySnapshot,
    customer_delivery_date: dateOrNull(body.customerDeliveryDate),
    processing_date: dateOrNull(body.processingDate),
    customer_so_no: (body.customerSoNo as string) ?? null,
    customer_po: (body.customerPo as string) ?? null,
    hub_id: (body.hubId as string) ?? null,
    hub_name: (body.hubName as string) ?? null,
    bill_to_address: (body.billToAddress as string) ?? null,
    signature_b64: (body.signatureB64 as string) ?? null,
    payment_method:     (body.paymentMethod as string) ?? null,
    installment_months: typeof body.installmentMonths === 'number' ? body.installmentMonths : null,
    merchant_provider:  (body.merchantProvider as string) ?? null,
    approval_code:      (body.approvalCode as string) ?? null,
    payment_date:       dateOrNull(body.paymentDate),
    /* Clamp >= 0 (the /mfg-sales-orders create path this was cloned from does;
       this copy didn't) — the header deposit is added on top of the ledger in
       the CO list's paid rollup, so a negative value would deflate it. */
    deposit_sen:      Math.max(0, typeof body.depositSen === 'number' ? body.depositSen : 0),
    /* SERVER-OWNED — never the client's number. Same back-door the SO create
       carried: paid is derived from the payments ledger, and taking
       body.paidSen here let a create book a CO as already-paid with zero
       payment rows. Always 0 at birth. */
    paid_sen:         0,
    /* Every new CO is CONFIRMED on insert (2990 has no DRAFT step). */
    status: 'CONFIRMED',
    created_by: user.id,
  }); },
  );
  if (hErr) { return c.json({ error: 'insert_failed', reason: hErr.message }, 500); }

  if (itemRows.length > 0) {
    const rowsWithDoc = itemRows.map((r) => ({ ...r, doc_no: docNo }));
    const { error: iErr } = await sb.from('consignment_sales_order_items').insert(stampCompany(rowsWithDoc, c));
    if (iErr) { await sb.from('consignment_sales_orders').delete().eq('doc_no', docNo); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }
    /* Re-roll the header through recomputeTotals so a matched sofa SET picks up
       its MASTER combo cost (spread across the lines). No-op otherwise. */
    await recomputeTotals(sb, docNo);
  }

  // Audit row — one CREATE entry.
  const createFields: FieldChange[] = [];
  const captureIfSet = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== '') createFields.push({ field: k, to: v });
  };
  captureIfSet('debtorName', customerName);
  captureIfSet('debtorCode', body.debtorCode);
  captureIfSet('agent', body.agent);
  captureIfSet('phone', body.phone);
  captureIfSet('email', body.email);
  captureIfSet('soDate', body.soDate);
  captureIfSet('lineCount', items.length);
  captureIfSet('localTotalSen', total);
  captureIfSet('paymentMethod', body.paymentMethod);
  captureIfSet('depositSen', body.depositSen);
  captureIfSet('processingDate', body.processingDate);
  captureIfSet('customerSoNo', body.customerSoNo);
  captureIfSet('customerPo', body.customerPo);
  await recordSoAudit(sb, {
    docNo,
    action: 'CREATE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: createFields,
    statusSnapshot: 'CONFIRMED',
  });

  return c.json({ docNo }, 201);
});

// Status transition with audit row.
export const patchConsignmentOrderStatusHandler = async (c: any) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  /* Self-scoped sales may only CANCEL / re-status their OWN CO. Ahead of the
     downstream lock below, so an out-of-scope caller gets 404 rather than being
     told the order has a Consignment Note: a refusal must not leak existence. */
  if (await selfScopedConsignmentBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  let body: { status?: string; notes?: string }; try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.status) return c.json({ error: 'status_required' }, 400);
  /* NORMALISE FIRST, as the SO handler this clones does. Read RAW, a lowercase 'cancelled'
     never entered coHasDownstream below — SI_STATUS_CANON's class; tests/lifecycleStatusCasing. */
  const toStatus = String(body.status).trim().toUpperCase();
  const { data: prev } = await scopeToCompanyId(sb.from('consignment_sales_orders').select('status').eq('doc_no', docNo), co.companyId).maybeSingle();
  const fromStatus = (prev as { status: string } | null)?.status ?? null;
  /* Tier 2 downstream-lock — only the CANCELLED transition is gated. */
  if (toStatus === 'CANCELLED' && fromStatus !== 'CANCELLED') {
    const childLock = await coHasDownstream(sb, docNo);
    if (childLock) return c.json(childLock, 409);
  }

  const patch: Record<string, unknown> = { status: toStatus, updated_at: new Date().toISOString() };
  const { data, error } = await scopeToCompanyId(sb.from('consignment_sales_orders').update(patch)
    .eq('doc_no', docNo), co.companyId).select('doc_no, status').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  // Stale/missing docNo (or another company's) matches 0 rows → clean 404.
  if (!data) return c.json(NOT_THIS_COMPANY, 404);

  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_STATUS',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [{ field: 'status', from: fromStatus, to: toStatus }],
    statusSnapshot: toStatus,
    note: body.notes ?? undefined,
  });

  return c.json({ salesOrder: data });
};
consignmentOrders.patch('/:docNo/status', patchConsignmentOrderStatusHandler);

// ── GET /:docNo/audit-log — unified history feed (newest first). ──────
consignmentOrders.get('/:docNo/audit-log', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  /* Own/downline sales scope (lib/salesScope.ts) — resolve the CO's
     salesperson_id first so a scoped seller can't read another
     salesperson's history by enumerating doc_nos. Out-of-scope /
     missing → 404. Directors/view-all bypass. */
  {
    const { data: hdr } = await scopeToCompany(sb.from('consignment_sales_orders').select('salesperson_id').eq('doc_no', docNo), c).maybeSingle();
    if (!hdr) return c.json({ error: 'not_found' }, 404);
    const sp = (hdr as { salesperson_id?: number | string | null }).salesperson_id;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), sp)) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
  const { data, error } = await sb.from('mfg_so_audit_log')
    .select('id, so_doc_no, action, actor_id, actor_name_snapshot, field_changes, status_snapshot, source, note, created_at')
    .eq('so_doc_no', docNo)
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  /* The audit HISTORY is a finance read too — the line PATCH records
     `cmp('unitCostSen', prev.unit_cost_sen, unitCost)`, so field_changes
     carries the old AND new unit cost in plain sight. Stripping the detail
     while leaving the history would just move the leak one endpoint over (this
     is the "one path gets missed" shape #600 / #625 / #632 each repeated).
     Drop the finance field_changes entries for a non-finance caller and keep
     the entry itself — who changed what, when, is not finance data. Note the
     camelCase escape hatch: field_changes is keyed by the API's camelCase field
     names, so it never matched the snake_case strip lists. */
  const entries = (data ?? []) as Array<Record<string, unknown>>;
  if (!canViewScmFinance(c)) stripAuditFinance(entries);
  return c.json({ entries });
});

// POST — override the price on a single line item.
// Exported so a cross-tenant test can drive it without the supabaseAuth bridge.
export const consignmentOverridePriceHandler = async (c: any) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId');
  const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  // WRITES MONEY — only an admin-level caller may override the SKU-Master price, as the SO twin's /override does (isPriceOverrideCaller, mfg-sales-orders.ts:6205). Without this a scm.so.view_all-only caller could re-price. Gate before the self-scope / row reads. BUG-HISTORY 2026-08-19.
  if (!hasHouzsPerm(c, 'scm.so.price_override')) return c.json({ error: 'price_override_admin_only', message: 'Unit prices follow the SKU Master sell price. Only an admin can override a line price.' }, 403);
  // Self-scoped sales may only re-price a line on their OWN CO. This verb WRITES MONEY.
  if (await selfScopedConsignmentBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  let body: { overridePriceSen?: number; reason?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const newPrice = Number(body.overridePriceSen ?? 0);
  if (!Number.isFinite(newPrice) || newPrice < 0) return c.json({ error: 'invalid_price' }, 400);

  const { data: item } = await scopeToCompanyId(sb.from('consignment_sales_order_items')
    .select('id, doc_no, item_code, unit_price_sen, qty, discount_sen')
    .eq('id', itemId), co.companyId).maybeSingle();
  if (!item) return c.json(NOT_THIS_COMPANY, 404);
  const i = item as { id: string; doc_no: string; item_code: string; unit_price_sen: number; qty: number; discount_sen: number };
  if (i.doc_no !== docNo) return c.json({ error: 'item_doc_mismatch' }, 400);

  const originalPriceSen = i.unit_price_sen;
  const overridePriceSen = newPrice;

  // Audit 2026-06-20 — clamp like the PO create path (negative-money guard).
  const newLineTotal = Math.max(0, (i.qty * newPrice) - i.discount_sen);
  const { data: costRow } = await scopeToCompanyId(sb.from('consignment_sales_order_items')
    .select('line_cost_sen')
    .eq('id', itemId), co.companyId)
    .maybeSingle();
  const currentLineCost = Number((costRow as { line_cost_sen?: number } | null)?.line_cost_sen ?? 0);
  const { error } = await scopeToCompanyId(sb.from('consignment_sales_order_items').update({
    unit_price_sen: newPrice,
    total_sen: newLineTotal,
    total_inc_sen: newLineTotal,
    balance_sen: newLineTotal,
    line_margin_sen: newLineTotal - currentLineCost,
  }).eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  await recomputeTotals(sb, docNo);

  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'unitPriceSen', from: originalPriceSen, to: overridePriceSen },
    ],
    note: (body.reason as string) || undefined,
  });

  return c.json({ ok: true, itemId, newPrice });
};
consignmentOrders.post('/:docNo/items/:itemId/override', consignmentOverridePriceHandler);

// ── PATCH header — edit debtor info, addresses, note, etc. ───────────
consignmentOrders.patch('/:docNo', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  /* Self-scoped sales may only amend their OWN CO. `salespersonId` is in the map
     below, so without this a rep could REASSIGN another rep's order to
     themselves; `depositSen` is money. */
  if (await selfScopedConsignmentBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  /* Phone is COMPULSORY — guard only when phone is present in the body. */
  if (body.phone !== undefined) {
    const patchPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
    if (!patchPhone) {
      return c.json({ error: 'phone_required', reason: 'A phone number is required on every consignment order.' }, 400);
    }
  }

  const map: Array<[string, string]> = [
    ['debtorCode', 'debtor_code'], ['debtorName', 'debtor_name'], ['agent', 'agent'],
    ['salesLocation', 'sales_location'], ['ref', 'ref'], ['poDocNo', 'po_doc_no'],
    ['venue', 'venue'], ['venueId', 'venue_id'], ['branding', 'branding'], ['transferTo', 'transfer_to'],
    ['address1', 'address1'], ['address2', 'address2'], ['address3', 'address3'],
    ['address4', 'address4'], ['phone', 'phone'], ['note', 'note'],
    ['remark2', 'remark2'], ['remark3', 'remark3'], ['remark4', 'remark4'],
    ['soDate', 'so_date'], ['currency', 'currency'],
    ['customerId', 'customer_id'], ['customerState', 'customer_state'],
    ['customerPo', 'customer_po'], ['customerPoId', 'customer_po_id'],
    ['customerPoDate', 'customer_po_date'], ['customerPoImageB64', 'customer_po_image_b64'],
    ['customerSoNo', 'customer_so_no'],
    ['hubId', 'hub_id'], ['hubName', 'hub_name'],
    ['customerDeliveryDate', 'customer_delivery_date'], ['processingDate', 'processing_date'],
    ['linkedDoDocNo', 'linked_do_doc_no'],
    ['shipToAddress', 'ship_to_address'], ['billToAddress', 'bill_to_address'],
    ['installToAddress', 'install_to_address'],
    ['email', 'email'], ['customerType', 'customer_type'],
    ['salespersonId', 'salesperson_id'],
    ['city', 'city'], ['postcode', 'postcode'], ['buildingType', 'building_type'],
    ['emergencyContactName', 'emergency_contact_name'],
    ['emergencyContactPhone', 'emergency_contact_phone'],
    ['emergencyContactRelationship', 'emergency_contact_relationship'],
    ['targetDate', 'target_date'],
    ['paymentMethod', 'payment_method'],
    ['installmentMonths', 'installment_months'],
    ['merchantProvider', 'merchant_provider'],
    ['approvalCode', 'approval_code'],
    ['paymentDate', 'payment_date'],
    ['depositSen', 'deposit_sen'],
    /* `paidSen` is deliberately NOT mapped — paid is SERVER-OWNED, derived
       from the payments ledger (the CO list rollup sums it). Mapping it let a
       caller PATCH {paidSen: <order total>} and book the CO paid with zero
       payment rows. Mirrors /mfg-sales-orders. Record a payment, not a total. */
  ];
  const PHONE_FIELDS = new Set(['phone', 'emergencyContactPhone']);
  /* A caller who cannot READ deposit must not WRITE it. gateCoFinance now strips
     deposit_sen from the detail payload, and this map accepts ANY defined
     value — so a client that seeded its header draft off that payload would
     round-trip the stripped field as a genuine 0 and wipe the deposit (the #632
     trap, which bit the DR line PATCH for real). No Houzs caller sends
     depositSen on PATCH today — ConsignmentOrderDetail never renders or echoes
     it — so this is defence-in-depth that keeps the strip safe by construction
     rather than by the frontend's current shape. A finance caller is unaffected. */
  const canFinance = canViewScmFinance(c);
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [from, to] of map) {
    if (body[from] === undefined) continue;
    if (from === 'depositSen' && !canFinance) continue;
    if (PHONE_FIELDS.has(from) && typeof body[from] === 'string') {
      const raw = body[from] as string;
      updates[to] = normalizePhone(raw) ?? raw;
    } else if (from === 'depositSen') {
      /* Clamp >= 0, matching the create path — the header deposit feeds the
         list's paid rollup, so a negative value would deflate it. */
      updates[to] = Math.max(0, typeof body[from] === 'number' ? (body[from] as number) : 0);
    } else {
      updates[to] = body[from];
    }
  }
  /* When customerState changes, re-derive customer_country + sales_location. */
  if (body['customerState'] !== undefined) {
    updates['customer_country'] = await deriveCountryFromState(
      sb,
      body['customerState'] as string | null,
    );
    if (body['salesLocation'] === undefined) {
      const derived = await deriveSalesLocationFromState(
        sb,
        body['customerState'] as string | null,
        c,
      );
      if (derived) updates['sales_location'] = derived;
    }
  }

  if (Object.keys(updates).length === 1) return c.json({ ok: true, changed: 0 });

  /* Collect every Processing-Date gate and report them together (owner
     2026-07-18) — mirrors the SO header PATCH path. */
  let coVariantOffenders: ReturnType<typeof findIncompleteVariantLines> = [];

  /* Processing Date set → every non-cancelled line must carry its category-
     required variants. Collected (not returned) — aggregated with the date rules
     below. */
  if (body['processingDate'] !== undefined && body['processingDate'] !== null && body['processingDate'] !== '') {
    const { data: liveItems } = await scopeToCompanyId(sb
      .from('consignment_sales_order_items')
      .select('id, item_code, item_group, variants, cancelled')
      .eq('doc_no', docNo), co.companyId);
    coVariantOffenders = findIncompleteVariantLines(
      ((liveItems ?? []) as Array<{ id: string; item_code: string; item_group: string; variants: Record<string, unknown> | null; cancelled: boolean }>)
        .filter((it) => !it.cancelled)
        .map((it) => ({ id: it.id, itemCode: it.item_code, group: it.item_group, variants: it.variants })),
    );
  }

  // Snapshot the row before update for the audit diff + the date / lock guards.
  const beforeCols = map.map(([, snake]) => snake).concat(['status']).join(', ');
  const { data: before } = await scopeToCompanyId(sb.from('consignment_sales_orders').select(beforeCols).eq('doc_no', docNo), co.companyId).maybeSingle();

  /* See "THE PAIR RULE" in shared/so-processing-date.ts. */
  /* Set when clearing the Processing Date also clears a Delivery Date the
     request never named — read by the line-level cascade after the write. */
  let coCascadedDeliveryClear = false;
  {
    const beforeRow = (before as unknown as Record<string, unknown> | null);
    const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const proc = body['processingDate'];
    const deliv = body['customerDeliveryDate'];
    const origProc = (beforeRow?.['processing_date'] as string | null) ?? null;
    const origDeliv = (beforeRow?.['customer_delivery_date'] as string | null) ?? null;
    const effProc  = effectiveDateAfterPatch(proc,  origProc);
    const effDeliv = effectiveDateAfterPatch(deliv, origDeliv);
    /* The pair rule — see "THE CO HEADER PATCH" in shared/so-processing-date.ts.
       Absent vs cleared is `=== undefined`, never `typeof === 'string'`: the CO
       edit page clears a date as JSON null, same as the SO one. */
    const coCascadeCols = soDatePairCascadeColumns({
      procCleared: proc !== undefined && dateOrNull(proc) === null && !!origProc,
      delivInPatch: deliv !== undefined,
      origDeliv,
    });
    for (const col of coCascadeCols) updates[col] = null;
    coCascadedDeliveryClear = coCascadeCols.length > 0;
    const effDelivAfterCascade = coCascadedDeliveryClear ? null : effDeliv;
    const coPairRefusal = soDatePairRefusal({
      nextProc: effProc, nextDeliv: effDelivAfterCascade, origProc, origDeliv,
    });
    if (coPairRefusal) return c.json(coPairRefusal, 400);
    const coProblems = collectProcessingGateProblems({
      procDate: effProc,
      delivDate: effDelivAfterCascade,
      todayMY,
      origProcDate: origProc,
      origDelivDate: origDeliv,
      variantOffenders: coVariantOffenders,
    });
    if (coProblems.length > 0) return c.json(validationFailedBody(coProblems), 422);
  }

  /* Partial header lock. Once a non-cancelled DO / SI exists, the IDENTITY +
     VALUE fields downstream documents snapshot are frozen. Payment / remark /
     scheduling fields stay editable. */
  if (before) {
    const beforeRow = before as unknown as Record<string, unknown>;
    const changedLocked = [...CO_IDENTITY_LOCK_COLS].filter(
      (col) => col in updates && norm(updates[col]) !== norm(beforeRow[col]),
    );
    if (changedLocked.length > 0) {
      const lock = await coHasDownstream(sb, docNo);
      if (lock) {
        return c.json({
          error: 'co_identity_locked',
          message: 'Consignment Order has a Delivery Order / Sales Invoice — customer, branding, address, reference and value fields are locked. Payment and remarks can still be edited.',
          lockedFields: changedLocked,
        }, 409);
      }
    }
  }

  const { data, error } = await scopeToCompanyId(sb.from('consignment_sales_orders').update(coerceEmptyDates(updates)).eq('doc_no', docNo), co.companyId).select('doc_no').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json(NOT_THIS_COMPANY, 404);

  /* Master-follower cascade. When the header's customer_delivery_date changes,
     every non-overridden line picks up the new date. Best-effort. */
  if (body['customerDeliveryDate'] !== undefined || coCascadedDeliveryClear) {
    /* A cascaded clear has no body value to read — the header column was set to
       null above, so the lines must follow it, or MRP keeps ordering by a line
       date the header no longer holds. */
    const newDate = coCascadedDeliveryClear ? null : dateOrNull(body['customerDeliveryDate']); // header coerced, lines did not: the cascade 500'd after the header committed
    await scopeToCompanyId(sb.from('consignment_sales_order_items')
      .update({ line_delivery_date: newDate })
      .eq('doc_no', docNo), co.companyId)
      .eq('line_delivery_date_overridden', false);
  }

  /* Audit log row capturing field-level from→to diff. */
  if (before) {
    const beforeRow = before as unknown as Record<string, unknown>;
    const fieldChanges = diffFields(beforeRow, body, map);
    if (fieldChanges.length > 0) {
      await recordSoAudit(sb, {
        docNo,
        action: 'UPDATE_DETAILS',
        actorId: user.id,
        actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
        fieldChanges,
        statusSnapshot: (beforeRow as { status?: string }).status ?? null,
      });
    }
  }

  return c.json({ ok: true, docNo });
});

// ── Item CRUD ─────────────────────────────────────────────────────────
//
// Each mutation recomputes the header totals + category breakdown so the list
// view stays accurate without a separate refresh step.
//
// Fails CLOSED and never throws (2026-07-17) — this is the SO's recomputeTotals
// twin (mfg-sales-orders.ts), which carries the full rationale. Every read below
// aborts the whole recompute on error, because a header written from a read we
// cannot vouch for is a lie that looks like a fact, while a stale header is
// merely old and self-heals on the next successful edit. It aborts by LOGGING,
// not throwing, because this roll-up only ever runs AFTER its triggering
// mutation has already committed — a throw cannot undo that write, it can only
// turn it into a 500 the client retries into a DUPLICATE. See BUG-HISTORY
// 2026-07-17 (fix/zeroing-twins).
async function recomputeTotals(sb: any, docNo: string) {
  const { data: items, error: itemsErr } = await sb.from('consignment_sales_order_items')
    .select('id, item_code, item_group, variants, qty, total_sen, line_cost_sen')
    .eq('doc_no', docNo).eq('cancelled', false);
  /* A failed READ is not an empty order, and `?? []` cannot tell them apart — it
     folded a transient blip into local_total / balance / revenue / margin / every
     category bucket / line_count all ZERO on an order whose lines were intact,
     wreckage indistinguishable from a legitimately empty order. The ERROR is the
     signal, never the emptiness: an order with every line cancelled resolves
     error === null with data === [] and MUST still fall through to zero the
     header — bailing on emptiness would break that real state. */
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[co-recompute] item read failed — header left unchanged:', docNo, itemsErr.message);
    return;
  }
  type Row = { id: string; item_code: string; item_group: string; variants: Record<string, unknown> | null; qty: number; total_sen: number; line_cost_sen: number };
  const rows = (items ?? []) as Row[];

  /* ── Master sofa-combo COST spread ─────────────────────────────────────────
     A sofa is a set of per-module lines. When those lines (same base model)
     match a MASTER combo, the set's COST = the combo price, spread across the
     matched lines off the stored per-line line_cost_sen. Idempotent. */
  const sofaRows = rows.filter((r) => (r.item_group ?? '').toLowerCase() === 'sofa');
  if (sofaRows.length > 0) {
    const combos = await loadActiveSofaCombos(sb); // master scope only
    if (combos.length > 0) {
      const fabricCodes = [...new Set(sofaRows.map((r) => String((r.variants ?? {} as Record<string, unknown>).fabricCode ?? '')).filter(Boolean))];
      const tierByFabric = new Map<string, SofaPriceTier>();
      if (fabricCodes.length > 0) {
        const { data: fabs, error: fabsErr } = await sb.from('fabric_trackings').select('fabric_code, price_tier, sofa_price_tier').in('fabric_code', fabricCodes);
        /* Same collapse as the item read, one step subtler: an empty tier map
           does not skip the combo, it makes every fabric fall to the PRICE_2
           default below — so a failed read would pick a REAL combo at the WRONG
           tier and write that cost to the header as fact. A fabric row that
           genuinely carries no tier still defaults; only the error aborts. */
        if (fabsErr) {
          /* eslint-disable-next-line no-console */
          console.error('[co-recompute] fabric tier read failed — header left unchanged:', docNo, fabsErr.message);
          return;
        }
        for (const f of (fabs ?? []) as Array<{ fabric_code: string; price_tier: SofaPriceTier | null; sofa_price_tier: SofaPriceTier | null }>) {
          tierByFabric.set(f.fabric_code, (f.sofa_price_tier ?? f.price_tier ?? 'PRICE_2'));
        }
      }
      const groups = new Map<string, Row[]>();
      for (const r of sofaRows) {
        const { baseModel, sizeCode } = splitSofaCode(r.item_code);
        /* Audit 2026-06-11 I-1 — the old `sizeCode.includes('-')` gate was a
           legacy dash-vocabulary sniff that skipped EVERY canonical parens
           module (`1A(LHF)`) AND whole-unit codes (1S/2S/3S) — dead code since
           the 2026-06-04 vocabulary unification. pickComboMatch itself rejects
           non-matching module sets; we only skip codes with no module token. */
        if (!sizeCode) continue; // bare model code → nothing to match
        const key = baseModel.toUpperCase();
        const arr = groups.get(key) ?? [];
        arr.push(r); groups.set(key, arr);
      }
      for (const [bm, members] of groups) {
        const tierOf = (m: Row) => tierByFabric.get(String((m.variants ?? {} as Record<string, unknown>).fabricCode ?? '')) ?? 'PRICE_2';
        const tiers = new Set(members.map(tierOf));
        if (tiers.size !== 1) continue;
        const tier = [...tiers][0]!;
        const heights = new Set(members.map((m) => sofaHeightKey(m.variants)));
        if (heights.size !== 1) continue;
        const height = [...heights][0]!;
        if (!height) continue;
        /* Audit 2026-06-11 I2 — same-base-model combos ONLY (owner rule: no
           cross-model fallback; module codes are a shared vocabulary, so the
           old `named.length > 0 ? named : combos` fallback let another Model's
           combo price leak in as this set's cost). */
        const pool = combos.filter((cmb) => (cmb.baseModel ?? '').toUpperCase() === bm);
        if (pool.length === 0) continue; // no combo named for this Model → no combo
        const match = pickComboMatch(
          { baseModel: '', modules: members.map((m) => splitSofaCode(m.item_code).sizeCode), customerId: null, tier, height },
          pool,
        );
        if (!match) continue;
        const matched = match.matchedIndices.map((i) => members[i]).filter((m): m is Row => !!m);
        if (matched.length === 0) continue;
        /* Audit 2026-06-11 I1 — combo price is ONE set; line_cost_sen is a
           LINE total. Uniform qty q → q sets → comboTotal×q; mixed qtys →
           SKIP (keep per-module costs, never under-book). */
        const qtySet = new Set(matched.map((m) => Math.max(1, m.qty || 1)));
        if (qtySet.size !== 1) continue;
        const uniformQty = [...qtySet][0]!;
        const comboTotal = match.comboPriceSen * uniformQty;
        if (comboTotal <= 0) continue;
        const spread = spreadComboTotal(matched.map((m) => m.line_cost_sen || 0), comboTotal);
        for (let i = 0; i < matched.length; i++) {
          const m = matched[i]!; const newLineCost = spread[i] ?? 0; const q = Math.max(1, m.qty || 1);
          m.line_cost_sen = newLineCost; // mutate in place so the rollup below sees it
          const { error: spreadErr } = await sb.from('consignment_sales_order_items').update({
            line_cost_sen:   newLineCost,
            unit_cost_sen:   Math.round(newLineCost / q),
            line_margin_sen: (m.total_sen || 0) - newLineCost,
          }).eq('id', m.id);
          /* The in-memory mutation above already fed this cost to the roll-up, so
             a failed line write would have the header assert a cost its own lines
             do not carry. There is no transaction here to undo the sibling lines
             that did land; leaving the header alone keeps the ONE row every list
             and margin report reads honest, and the spread is idempotent so the
             next successful edit re-rolls the whole group. */
          if (spreadErr) {
            /* eslint-disable-next-line no-console */
            console.error('[co-recompute] combo cost spread failed — header left unchanged:', docNo, m.id, spreadErr.message);
            return;
          }
        }
      }
    }
  }

  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0;
  for (const it of (items ?? []) as Array<{ item_group: string; total_sen: number; line_cost_sen: number }>) {
    const lineTotal = it.total_sen || 0;
    const lineCost  = it.line_cost_sen || 0;
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.item_group ?? '').toLowerCase();
    if (g.includes('mattress') || g.includes('sofa')) {
      mattressSofa += lineTotal;
      mattressSofaCost += lineCost;
    } else if (g.includes('bedframe')) {
      bedframe += lineTotal;
      bedframeCost += lineCost;
    } else if (g.includes('accessor')) {
      accessories += lineTotal;
      accessoriesCost += lineCost;
    } else {
      others += lineTotal;
      othersCost += lineCost;
    }
  }
  const grandMargin = total - totalCost;
  const { error: updErr } = await sb.from('consignment_sales_orders').update({
    mattress_sofa_sen: mattressSofa,
    bedframe_sen: bedframe,
    accessories_sen: accessories,
    others_sen: others,
    mattress_sofa_cost_sen: mattressSofaCost,
    bedframe_cost_sen:      bedframeCost,
    accessories_cost_sen:   accessoriesCost,
    others_cost_sen:        othersCost,
    local_total_sen: total,
    balance_sen: total,
    total_cost_sen: totalCost,
    total_revenue_sen: total,
    total_margin_sen: grandMargin,
    margin_pct_basis: total > 0 ? Math.round((grandMargin / total) * 10000) : 0,
    line_count: (items ?? []).length,
    updated_at: new Date().toISOString(),
  }).eq('doc_no', docNo);
  /* The write's own result was discarded until 2026-07-17: a rejected UPDATE left
     the header STALE with nothing logged and every caller reporting success.
     Logged, not thrown: see the contract note on this function. */
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[co-recompute] header update failed — totals left STALE:', docNo, updErr.message);
  }
}

consignmentOrders.post('/:docNo/items', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  // Self-scoped sales may only add a line to their OWN CO.
  if (await selfScopedConsignmentBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);

  /* itemCode catalog guard. */
  {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }
  const addGroup = (await skuCategoryResolver(sb, [{ materialKind: 'mfg_product', itemCode: it.itemCode }], activeCompanyId(c) ?? null))(it) ?? 'others'; // SKU wins — docs/bugs/0514

  /* Tier 2 downstream-lock — line-add is blocked once a DO / SI exists. */
  const childLock = await coHasDownstream(sb, docNo);
  if (childLock) return c.json(childLock, 409);

  /* Composition guard. The create path above refuses a sofa that shares a
     document with a bedframe / mattress; this path had NO copy of that rule, so
     a CO created bedframe-only (which create legitimately permits — no sofa
     present) accepted a sofa line and built a document the business rule says
     cannot exist. coHasDownstream is not a substitute: it only blocks once a
     DO / SI exists, and a fresh CO has neither. INTRODUCED, not flat — an order
     that already mixes stays editable. */
  const mainMix = await lineMixRefusal(sb, 'consignment_sales_order_items', docNo, null, String(it.itemCode), activeCompanyId(c));
  if (mainMix) return c.json(mainMix.body, mainMix.status);

  const { data: header } = await scopeToCompanyId(sb.from('consignment_sales_orders').select('debtor_code, debtor_name, agent, branding, venue, customer_delivery_date, customer_state').eq('doc_no', docNo), co.companyId).maybeSingle();
  if (!header) return c.json(NOT_THIS_COMPANY, 404);

  const qty = Number(it.qty ?? 1);
  const discount = Number(it.discountSen ?? 0);
  const itemCodeStr = String(it.itemCode ?? '');
  const variantsObj = (it.variants as MfgItemForRecompute['variants']) ?? null;
  /* allowed_options check on add-item. */
  {
    const { product, model, lookupError } = await loadProductAndModel(sb, itemCodeStr, activeCompanyId(c));
    // A failed catalog read is ignorance, not permission — refuse, don't skip the gate.
    if (lookupError) return c.json(variantCheckUnavailableResponse(lookupError), 409);
    const aoErr = checkAllowedOptions(
      product,
      model,
      variantsObj as Parameters<typeof checkAllowedOptions>[2],
    );
    if (aoErr) return c.json({ ...aoErr, itemCode: itemCodeStr }, 400);
  }
  const [cachedConfig, productLite, fabricLite, sofaCombosLite, sellingTiersLite, fabricAddonConfigLite, specialAddonsLite, modelOverridesLite, compartmentOverridesLite] = await Promise.all([
    loadMaintenanceConfig(sb),
    loadProductByCode(sb, itemCodeStr, activeCompanyId(c)),
    loadFabricByCode(sb, variantsObj?.fabricCode ?? null),
    loadActiveSofaCombos(sb),
    loadFabricSellingTiers(sb, (variantsObj as { fabricId?: string } | null)?.fabricId ?? null),
    loadFabricTierAddonConfig(sb, activeCompanyId(c)),
    loadSpecialAddons(sb),
    loadModelFabricTierOverrides(sb),
    loadCompartmentFabricTierOverrides(sb),
  ]);
  // Audit 2026-06-11 C2 — module COST rows so a build's cost = Σ module costs.
  const [sofaModulePricesLite, sofaModuleCostRowsLite] = productLite?.category === 'SOFA'
    ? await Promise.all([
        loadModelSofaModulePrices(
          sb,
          productLite.base_model,
          String((variantsObj as { depth?: unknown } | null)?.depth ?? '24'),
          activeCompanyId(c),
        ),
        loadModelSofaModuleCostRows(sb, productLite.base_model, activeCompanyId(c)),
      ])
    : [null, null];
  const recomputed = recomputeFromSnapshot(
    {
      itemCode:       itemCodeStr,
      itemGroup:      String(it.itemGroup ?? 'others'),
      qty,
      unitPriceSen: Number(it.unitPriceSen ?? 0),
      variants:       variantsObj,
    },
    productLite,
    fabricLite,
    cachedConfig,
    sofaCombosLite,
    sofaModulePricesLite,
    sellingTiersLite,
    fabricAddonConfigLite,
    null,                // pwpBaseSen
    null,                // pwpSofaComboIds
    specialAddonsLite,
    sofaModuleCostRowsLite,
    modelOverridesLite,  // migration 0172 — per-Model Δ
    compartmentOverridesLite,  // migration 0025 — per-compartment Δ
  );
  /* Backend authors the selling price; no drift rejection (no POS path). */
  const unit = recomputed.unit_price_sen;
  // Audit 2026-06-20 — clamp like the PO create path (negative-money guard).
  const lineTotal = Math.max(0, (qty * unit) - discount);
  const unitCost = recomputed.unit_cost_sen > 0
    ? recomputed.unit_cost_sen
    : await snapshotUnitCostSen(sb, itemCodeStr, Number(it.unitCostSen ?? 0), c);
  const lineCost = unitCost * qty;
  const hasExplicitLineDate = it.lineDeliveryDate !== undefined && it.lineDeliveryDate !== null;
  const lineDeliveryDate = hasExplicitLineDate
    ? dateOrNull(it.lineDeliveryDate)
    : (header.customer_delivery_date as string | null) ?? null;
  const lineDeliveryDateOverridden = hasExplicitLineDate
    ? (it.lineDeliveryDateOverridden === undefined ? true : Boolean(it.lineDeliveryDateOverridden))
    : Boolean(it.lineDeliveryDateOverridden ?? false);
  const row = {
    doc_no: docNo,
    line_date: dateOrNull(it.lineDate) ?? todayMyt(),
    debtor_code: header.debtor_code,
    debtor_name: header.debtor_name,
    agent: header.agent,
    item_group: addGroup,
    item_code: it.itemCode,
    description: (it.description as string) ?? null,
    description2: buildVariantSummary(addGroup, (it.variants as Record<string, unknown> | null) ?? null) || null,
    uom: (it.uom as string) ?? 'UNIT',
    qty,
    unit_price_sen: unit,
    discount_sen: discount,
    total_sen: lineTotal,
    total_inc_sen: lineTotal,
    balance_sen: lineTotal,
    venue: header.venue,
    branding: header.branding,
    variants: (it.variants as unknown) ?? null,
    unit_cost_sen: unitCost,
    line_cost_sen: lineCost,
    line_margin_sen: lineTotal - lineCost,
    divan_price_sen:         recomputed.divan_price_sen,
    leg_price_sen:           recomputed.leg_price_sen,
    special_order_price_sen: recomputed.special_order_sen,
    custom_specials:         recomputed.custom_specials ?? null,
    line_delivery_date: lineDeliveryDate,
    line_delivery_date_overridden: lineDeliveryDateOverridden,
  };
  const { data, error } = await sb.from('consignment_sales_order_items').insert({ company_id: activeCompanyId(c), ...row }).select('*').single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  /* select('*') echoes the stored line back verbatim — cost/margin included. A
     non-finance caller must not read it off the create response either (this is
     the "fourth path" this class of bug keeps hiding in). */
  gateCoFinance(c, null, data);
  await recomputeTotals(sb, docNo);

  await recordSoAudit(sb, {
    docNo,
    action: 'ADD_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'itemCode', to: row.item_code },
      { field: 'qty', to: row.qty },
      { field: 'unitPriceSen', to: row.unit_price_sen },
      { field: 'totalSen', to: row.total_sen },
    ],
  });

  return c.json({ item: data }, 201);
});

consignmentOrders.patch('/:docNo/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  // Self-scoped sales may only edit a line on their OWN CO. This verb WRITES MONEY.
  if (await selfScopedConsignmentBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  /* itemCode catalog guard (only when caller is changing it). */
  if (it.itemCode !== undefined) {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* Tier 2 downstream-lock — line-edit is blocked once a DO / SI exists. */
  const childLock = await coHasDownstream(sb, docNo);
  if (childLock) return c.json(childLock, 409);

  const { data: prev } = await scopeToCompanyId(sb.from('consignment_sales_order_items')
    .select('qty, unit_price_sen, discount_sen, unit_cost_sen, item_code, item_group, description, description2, uom, variants, remark, cancelled')
    .eq('id', itemId), co.companyId).maybeSingle();
  if (!prev) return c.json(NOT_THIS_COMPANY, 404);
  /* Composition guard — a product SWAP must not INTRODUCE a sofa x
     (bedframe | mattress) mix. Same rule, same home as the create + add paths;
     this path had no copy of it either. Only when the caller actually changes
     the code: an untouched line cannot introduce anything. */
  if (it.itemCode !== undefined) {
    const mainMix = await lineMixRefusal(sb, 'consignment_sales_order_items', docNo, itemId, String(it.itemCode), activeCompanyId(c));
    if (mainMix) return c.json(mainMix.body, mainMix.status);
  }

  const qty = it.qty !== undefined ? Number(it.qty) : prev.qty;
  const clientUnit = it.unitPriceSen !== undefined ? Number(it.unitPriceSen) : prev.unit_price_sen;
  const discount = it.discountSen !== undefined ? Number(it.discountSen) : prev.discount_sen;

  /* Server-side recompute on PATCH when the caller touches variants OR
     unitPriceSen OR itemCode. */
  let recomputedPatch: RecomputedLine | null = null;
  const variantsAfter = it.variants !== undefined
    ? (it.variants as MfgItemForRecompute['variants'])
    : ((prev as { variants?: MfgItemForRecompute['variants'] }).variants ?? null);
  const itemCodeAfter = it.itemCode !== undefined ? String(it.itemCode) : prev.item_code;
  const itemGroupAfter = it.itemGroup !== undefined ? String(it.itemGroup) : prev.item_group;
  const shouldRecompute = it.variants !== undefined || it.unitPriceSen !== undefined || it.itemCode !== undefined;

  if (it.variants !== undefined || it.itemCode !== undefined) {
    const { product, model, lookupError } = await loadProductAndModel(sb, itemCodeAfter, activeCompanyId(c));
    // A failed catalog read is ignorance, not permission — refuse, don't skip the gate.
    if (lookupError) return c.json(variantCheckUnavailableResponse(lookupError), 409);
    const aoErr = checkAllowedOptions(
      product,
      model,
      variantsAfter as Parameters<typeof checkAllowedOptions>[2],
    );
    if (aoErr) return c.json({ ...aoErr, itemCode: itemCodeAfter }, 400);
  }
  if (shouldRecompute && itemCodeAfter) {
    const [cfg, prodLite, fabLite, sofaCombosPatch, sellingTiersPatch, fabricAddonConfigPatch, specialAddonsPatch, modelOverridesPatch, compartmentOverridesPatch] = await Promise.all([
      loadMaintenanceConfig(sb),
      loadProductByCode(sb, itemCodeAfter, activeCompanyId(c)),
      loadFabricByCode(sb, variantsAfter?.fabricCode ?? null),
      loadActiveSofaCombos(sb),
      loadFabricSellingTiers(sb, (variantsAfter as { fabricId?: string } | null)?.fabricId ?? null),
      loadFabricTierAddonConfig(sb, activeCompanyId(c)),
      loadSpecialAddons(sb),
      loadModelFabricTierOverrides(sb),
      loadCompartmentFabricTierOverrides(sb),
    ]);
    // Audit 2026-06-11 C2 — module COST rows so a build's cost = Σ module costs.
    const [sofaModulePricesPatch, sofaModuleCostRowsPatch] = prodLite?.category === 'SOFA'
      ? await Promise.all([
          loadModelSofaModulePrices(
            sb,
            prodLite.base_model,
            String((variantsAfter as { depth?: unknown } | null)?.depth ?? '24'),
            activeCompanyId(c),
          ),
          loadModelSofaModuleCostRows(sb, prodLite.base_model, activeCompanyId(c)),
        ])
      : [null, null];
    recomputedPatch = recomputeFromSnapshot(
      {
        itemCode:       itemCodeAfter,
        itemGroup:      itemGroupAfter,
        qty,
        unitPriceSen: clientUnit,
        variants:       variantsAfter,
      },
      prodLite,
      fabLite,
      cfg,
      sofaCombosPatch,
      sofaModulePricesPatch,
      sellingTiersPatch,
      fabricAddonConfigPatch,
      null,                // pwpBaseSen
      null,                // pwpSofaComboIds
      specialAddonsPatch,
      sofaModuleCostRowsPatch,
      modelOverridesPatch, // migration 0172 — per-Model Δ
      compartmentOverridesPatch, // migration 0025 — per-compartment Δ
    );
  }
  /* Carry the bound price-list figure out when a recompute ran. Backend drift
     saves silently (no POS path). */
  const unit = recomputedPatch ? recomputedPatch.unit_price_sen : clientUnit;
  let unitCost: number;
  /* DO NOT relax this to `it.unitCostSen !== undefined ? … : prev` — the
     `explicitCost > 0` precedence below is load-bearing SECURITY, not style.
     gateCoFinance strips unit_cost_sen from the detail payload, and
     ConsignmentOrderDetail seeds each line draft off it (`unit_cost_sen ?? 0`)
     and posts the value back here on save; the `> 0` test makes that stripped
     0 fall through to the recompute / stored cost instead of wiping the line's
     cost basis. The Consignment Note + Return line PATCHes took ANY defined
     value and had to be guarded explicitly (#632's DR trap). Same reason
     gateSoFinance was safe on the SO (#625). */
  const explicitCost = it.unitCostSen !== undefined ? Number(it.unitCostSen) : 0;
  const itemCodeChanged = it.itemCode !== undefined && it.itemCode !== prev.item_code;
  if (explicitCost > 0) {
    unitCost = explicitCost;
  } else if (recomputedPatch && recomputedPatch.unit_cost_sen > 0) {
    unitCost = recomputedPatch.unit_cost_sen;
  } else if (itemCodeChanged) {
    unitCost = await snapshotUnitCostSen(sb, String(it.itemCode ?? ''), 0, c);
  } else {
    unitCost = prev.unit_cost_sen;
  }
  // Audit 2026-06-20 — clamp like the PO create path (negative-money guard).
  const lineTotal = Math.max(0, (qty * unit) - discount);
  const lineCost = unitCost * qty;

  const updates: Record<string, unknown> = {
    qty, unit_price_sen: unit, discount_sen: discount, unit_cost_sen: unitCost,
    total_sen: lineTotal, total_inc_sen: lineTotal, balance_sen: lineTotal,
    line_cost_sen: lineCost, line_margin_sen: lineTotal - lineCost,
  };
  if (recomputedPatch) {
    updates.divan_price_sen         = recomputedPatch.divan_price_sen;
    updates.leg_price_sen           = recomputedPatch.leg_price_sen;
    updates.special_order_price_sen = recomputedPatch.special_order_sen;
    updates.custom_specials         = recomputedPatch.custom_specials ?? null;
  }
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['itemGroup', 'item_group'], ['description', 'description'],
    ['description2', 'description2'], ['uom', 'uom'], ['variants', 'variants'],
    ['remark', 'remark'], ['cancelled', 'cancelled'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  /* "Description 2" is ALWAYS the server-generated variant summary. */
  {
    const effGroup = (it.itemGroup ?? prev.item_group) as string | null | undefined;
    const effVariants = (it.variants ?? prev.variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  if (it.lineDeliveryDate !== undefined) {
    updates['line_delivery_date'] = dateOrNull(it.lineDeliveryDate);
    updates['line_delivery_date_overridden'] = true;
  }
  if (it.lineDeliveryDateOverridden !== undefined) {
    updates['line_delivery_date_overridden'] = Boolean(it.lineDeliveryDateOverridden);
  }

  const { error } = await scopeToCompanyId(sb.from('consignment_sales_order_items').update(coerceEmptyDates(updates)).eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  await recomputeTotals(sb, docNo);

  const fieldChanges: FieldChange[] = [];
  const cmp = (field: string, fromVal: unknown, toVal: unknown) => {
    const a = fromVal == null ? '' : String(fromVal);
    const b = toVal == null ? '' : String(toVal);
    if (a !== b) fieldChanges.push({ field, from: fromVal ?? null, to: toVal ?? null });
  };
  cmp('qty', prev.qty, qty);
  cmp('unitPriceSen', prev.unit_price_sen, unit);
  cmp('discountSen', prev.discount_sen, discount);
  cmp('unitCostSen', prev.unit_cost_sen, unitCost);
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['itemGroup', 'item_group'], ['description', 'description'],
    ['description2', 'description2'], ['uom', 'uom'], ['remark', 'remark'], ['cancelled', 'cancelled'],
  ] as const) {
    if (it[from] !== undefined) cmp(from, (prev as Record<string, unknown>)[to], it[from]);
  }
  if (fieldChanges.length > 0) {
    fieldChanges.unshift({ field: 'itemCode', to: prev.item_code });
    await recordSoAudit(sb, {
      docNo,
      action: 'UPDATE_LINE',
      actorId: user.id,
      actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
      fieldChanges,
    });
  }

  return c.json({ ok: true });
});

consignmentOrders.delete('/:docNo/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  // Self-scoped sales may only delete a line from their OWN CO.
  if (await selfScopedConsignmentBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  /* Tier 2 downstream-lock — line-delete is blocked once a DO / SI exists. */
  const childLock = await coHasDownstream(sb, docNo);
  if (childLock) return c.json(childLock, 409);

  const { data: prev } = await scopeToCompanyId(sb.from('consignment_sales_order_items')
    .select('item_code, qty, unit_price_sen, total_sen, photo_urls')
    .eq('id', itemId), co.companyId).maybeSingle();
  const prevTyped = prev as
    | { item_code: string; qty: number; unit_price_sen: number; total_sen: number; photo_urls: string[] | null }
    | null;
  if (!prevTyped) return c.json(NOT_THIS_COMPANY, 404);

  const { error } = await scopeToCompanyId(sb.from('consignment_sales_order_items').delete().eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  await recomputeTotals(sb, docNo);

  // Orphan photo cleanup — best-effort.
  let photosCleaned = 0;
  const photoKeys = prevTyped?.photo_urls ?? [];
  if (photoKeys.length > 0 && c.env.SO_ITEM_PHOTOS) {
    for (const key of photoKeys) {
      try {
        await c.env.SO_ITEM_PHOTOS.delete(key);
        photosCleaned += 1;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[co-item-photo] orphan cleanup failed for', key, e);
      }
      // WO-7: sweep the thumb sibling alongside its main object.
      await deleteThumbFor(c.env.SO_ITEM_PHOTOS, key);
    }
  }

  if (prevTyped) {
    await recordSoAudit(sb, {
      docNo,
      action: 'DELETE_LINE',
      actorId: user.id,
      actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
      fieldChanges: [
        { field: 'itemCode', from: prevTyped.item_code },
        { field: 'qty', from: prevTyped.qty },
        { field: 'unitPriceSen', from: prevTyped.unit_price_sen },
        { field: 'totalSen', from: prevTyped.total_sen },
        ...(photoKeys.length > 0
          ? [{ field: 'photosCleaned', from: photoKeys.length, to: photosCleaned } satisfies FieldChange]
          : []),
      ],
    });
  }

  return c.body(null, 204);
});

// ── Per-line photos (R2-backed photo array on every CO item) ──────────

consignmentOrders.post('/:docNo/items/:itemId/photos', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  const itemId = c.req.param('itemId');
  const user = c.get('user');

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  // Self-scoped sales may only attach a photo to a line on their OWN CO.
  if (await selfScopedConsignmentBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  const { data: item, error: itemErr } = await scopeToCompanyId(sb
    .from('consignment_sales_order_items')
    .select('id, doc_no, item_code, photo_urls')
    .eq('id', itemId), co.companyId)
    .maybeSingle();
  if (itemErr) return c.json({ error: 'item_lookup_failed', reason: itemErr.message }, 500);
  if (!item) return c.json(NOT_THIS_COMPANY, 404);
  const i = item as { id: string; doc_no: string; item_code: string; photo_urls: string[] | null };
  if (i.doc_no !== docNo) return c.json({ error: 'item_doc_mismatch' }, 400);

  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody();
  } catch (e) {
    return c.json({ error: 'invalid_multipart', reason: e instanceof Error ? e.message : String(e) }, 400);
  }
  const file = form.file as File | undefined;
  if (!file || typeof file === 'string') return c.json({ error: 'file_field_required' }, 400);

  if (!file.type || !file.type.toLowerCase().startsWith('image/')) {
    return c.json({ error: 'invalid_mime', got: file.type || '(none)' }, 400);
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return c.json({ error: 'file_too_large', maxBytes: MAX_PHOTO_BYTES, got: file.size }, 400);
  }

  const photoId = crypto.randomUUID();
  const ext = extFromMime(file.type) || 'bin';
  const photoKey = `co-items/${docNo}/${itemId}/${photoId}.${ext}`;

  try {
    await c.env.SO_ITEM_PHOTOS.put(photoKey, file.stream(), {
      httpMetadata: { contentType: file.type },
      customMetadata: {
        docNo,
        itemId,
        itemCode: i.item_code,
        uploadedBy: user.id,
      },
    });
  } catch (e) {
    return c.json({ error: 'r2_put_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
  }

  // WO-7: optional client-generated thumbnail in the same multipart body,
  // stored at `<photoKey>.thumb`. Best-effort; absent for old clients.
  await putOptionalThumb(c.env.SO_ITEM_PHOTOS, form.thumb, photoKey, {
    docNo,
    itemId,
    uploadedBy: user.id,
  });

  const nextKeys = [...(i.photo_urls ?? []), photoKey];
  const { error: updErr } = await scopeToCompanyId(sb
    .from('consignment_sales_order_items')
    .update({ photo_urls: nextKeys })
    .eq('id', itemId), co.companyId);
  if (updErr) {
    await c.env.SO_ITEM_PHOTOS.delete(photoKey).catch(() => {});
    await deleteThumbFor(c.env.SO_ITEM_PHOTOS, photoKey);
    return c.json({ error: 'db_update_failed', reason: updErr.message }, 500);
  }

  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'itemCode', to: i.item_code },
      { field: 'photoAdded', to: photoKey },
    ],
  });

  try {
    const bindings = soItemPhotoBindings(c.env);
    const { signedUrl, expiresAt } = await signSoItemPhotoUrl(bindings, photoKey);
    // WO-7: thumbUrl is signed for the `.thumb` sibling. When no thumb was
    // uploaded the URL 404s on fetch and the frontend falls back to photoUrl.
    const { signedUrl: thumbUrl } = await signSoItemPhotoUrl(bindings, thumbKeyFor(photoKey));
    return c.json({ photoKey, photoUrl: signedUrl, thumbUrl, expiresAt }, 201);
  } catch (e) {
    /* Upload succeeded and the row is inserted — never lose it. Hand back the
       proxy path. Same inert-fallback fix as the SO upload route: `mode` lets
       the client branch on the contract instead of sniffing the string. */
    const basePath = `/consignment-orders/${docNo}/items/${itemId}`;
    const reason = e instanceof Error ? e.message : String(e);
    warnSigningFailedOnce('co-item-photo', reason);
    return c.json(
      {
        photoKey,
        mode: 'proxy',
        photoUrl: photoProxyPath(basePath, photoKey),
        thumbProxyPath: photoProxyPath(basePath, thumbKeyFor(photoKey)),
        expiresAt: null,
        reason,
      },
      201,
    );
  }
});

/* Refresh a signed GET URL for an existing key.
   NO selfScopedConsignmentBlocked HERE, nor on the proxy GET below: both are
   READS and the owner's ruling covered the WRITE verbs. They keep their company
   scope. The residual is a same-company rep reading another rep's line photo,
   which needs BOTH the line uuid and the exact crypto.randomUUID() photo key —
   handed out only by GET /:docNo, which IS salesperson-scoped. The SO's proxy
   read DOES carry the guard, so this asymmetry is known, not overlooked. */
export const consignmentItemPhotoSignedHandler = async (c: any) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  const itemId = c.req.param('itemId');
  const photoKey = decodeURIComponent(c.req.param('photoKey'));

  const { data: item } = await scopeToCompany(sb
    .from('consignment_sales_order_items')
    .select('doc_no, photo_urls')
    .eq('id', itemId), c)
    .maybeSingle();
  if (!item) return c.json({ error: 'item_not_found' }, 404);
  const i = item as { doc_no: string; photo_urls: string[] | null };
  if (i.doc_no !== docNo) return c.json({ error: 'item_doc_mismatch' }, 400);
  if (!(i.photo_urls ?? []).includes(photoKey)) {
    return c.json({ error: 'photo_not_in_item' }, 404);
  }

  try {
    const bindings = soItemPhotoBindings(c.env);
    const { signedUrl, expiresAt } = await signSoItemPhotoUrl(bindings, photoKey);
    // WO-7: signed thumb sibling. Pre-existing photos have no thumb object —
    // the frontend's <img> onError falls back to signedUrl on the 404.
    const { signedUrl: thumbUrl } = await signSoItemPhotoUrl(bindings, thumbKeyFor(photoKey));
    const payload: PhotoUrlPayload = { mode: 'signed', signedUrl, thumbUrl, expiresAt };
    return c.json(payload);
  } catch (e) {
    /* 2026-08-10: R2 S3 creds unset in prod => signing throws for every photo.
       Fall back to the proxy route below rather than 500. See
       scm/lib/photoProxyFallback.ts for why this is not returned as
       `signedUrl`. */
    return c.json(
      proxyFallbackPayload(
        'co-item-photo',
        `/consignment-orders/${docNo}/items/${itemId}`,
        photoKey,
        e,
      ),
    );
  }
};

consignmentOrders.get('/:docNo/items/:itemId/photos/:photoKey/signed', consignmentItemPhotoSignedHandler);

/* Proxy GET (fallback for clients holding proxy URLs).
   NO selfScopedConsignmentBlocked HERE — see the note on the /signed handler
   above, which this route backs up and whose authorization it must match. */
consignmentOrders.get('/:docNo/items/:itemId/photos/:photoKey', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  const itemId = c.req.param('itemId');
  const photoKey = decodeURIComponent(c.req.param('photoKey'));

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

  // WO-7: a `.thumb` sibling is authorised against its BASE key — thumbs
  // are never listed in photo_urls.
  const { data: item } = await scopeToCompany(sb
    .from('consignment_sales_order_items')
    .select('doc_no, photo_urls')
    .eq('id', itemId), c)
    .maybeSingle();
  if (!item) return c.json({ error: 'item_not_found' }, 404);
  const i = item as { doc_no: string; photo_urls: string[] | null };
  if (i.doc_no !== docNo) return c.json({ error: 'item_doc_mismatch' }, 400);
  if (!(i.photo_urls ?? []).includes(baseKeyOf(photoKey))) {
    return c.json({ error: 'photo_not_in_item' }, 404);
  }

  const obj = await c.env.SO_ITEM_PHOTOS.get(photoKey);
  if (!obj) return c.json({ error: 'photo_not_found_in_r2' }, 404);

  const contentType =
    obj.httpMetadata?.contentType ?? 'application/octet-stream';
  return new Response(obj.body, {
    headers: {
      'content-type': contentType,
      // Key is minted per upload with crypto.randomUUID() (:1964), so this url
      // names one fixed object for its lifetime. Stays `private`.
      'cache-control': 'private, max-age=31536000, immutable',
    },
  });
});

consignmentOrders.delete('/:docNo/items/:itemId/photos/:photoKey', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  const itemId = c.req.param('itemId');
  const photoKey = decodeURIComponent(c.req.param('photoKey'));
  const user = c.get('user');

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  // Self-scoped sales may only remove a photo from a line on their OWN CO.
  if (await selfScopedConsignmentBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  const { data: item } = await scopeToCompanyId(sb
    .from('consignment_sales_order_items')
    .select('doc_no, item_code, photo_urls')
    .eq('id', itemId), co.companyId)
    .maybeSingle();
  if (!item) return c.json(NOT_THIS_COMPANY, 404);
  const i = item as { doc_no: string; item_code: string; photo_urls: string[] | null };
  if (i.doc_no !== docNo) return c.json({ error: 'item_doc_mismatch' }, 400);
  const existing = i.photo_urls ?? [];
  if (!existing.includes(photoKey)) {
    return c.json({ error: 'photo_not_in_item' }, 404);
  }

  const nextKeys = existing.filter((k) => k !== photoKey);
  const { error: updErr } = await scopeToCompanyId(sb
    .from('consignment_sales_order_items')
    .update({ photo_urls: nextKeys })
    .eq('id', itemId), co.companyId);
  if (updErr) return c.json({ error: 'db_update_failed', reason: updErr.message }, 500);

  await c.env.SO_ITEM_PHOTOS.delete(photoKey).catch(() => {});
  await deleteThumbFor(c.env.SO_ITEM_PHOTOS, photoKey);

  await recordSoAudit(sb, {
    docNo,
    action: 'UPDATE_LINE',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'itemCode', to: i.item_code },
      { field: 'photoRemoved', from: photoKey, to: null },
    ],
  });

  return c.json({ ok: true });
});

// ── Payments — transaction ledger per CO ──────────────────────────────
const PAYMENT_COLS =
  'id, so_doc_no, paid_at, method, merchant_provider, installment_months, ' +
  'online_type, approval_code, amount_sen, account_sheet, collected_by, note, ' +
  'created_at, created_by';

consignmentOrders.get('/:docNo/payments', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
  /* Own/downline sales scope (lib/salesScope.ts) — resolve the CO's
     salesperson_id first so a scoped seller can't read another
     salesperson's payment ledger by enumerating doc_nos. Out-of-scope /
     missing → 404. Directors/view-all bypass. */
  {
    const { data: hdr } = await scopeToCompany(sb.from('consignment_sales_orders').select('salesperson_id').eq('doc_no', docNo), c).maybeSingle();
    if (!hdr) return c.json({ error: 'not_found' }, 404);
    const sp = (hdr as { salesperson_id?: number | string | null }).salesperson_id;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), sp)) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
  const { data, error } = await scopeToCompany(sb
    .from('consignment_sales_order_payments')
    .select(`${PAYMENT_COLS}, staff:collected_by ( name )`)
    .eq('so_doc_no', docNo), c)
    .order('paid_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const payments = (data ?? []).map((r: unknown) => {
    const row = r as Record<string, unknown> & { staff: { name: string } | null };
    const { staff, ...rest } = row;
    return { ...rest, collected_by_name: staff?.name ?? null };
  });
  return c.json({ payments });
});

const paymentCreateSchema = z.object({
  paidAt:             z.string().min(1),
  /* 2026-06-06 payment-method unify — 'installment' is first-class L1. The
     accepted set IS shared/payment-methods.ts's PAYMENT_METHOD_CODES, not a
     re-typed literal: this enum stood in seven route files, so "don't add a
     5th code without wiring its branch logic" (that module's header) was
     advice no reader of this line could act on. */
  method:             z.enum(PAYMENT_METHOD_CODES),
  merchantProvider:   z.string().trim().min(1).optional().nullable(),
  installmentMonths:  z.number().int().min(0).max(60).optional().nullable(),
  onlineType:         z.string().trim().min(1).optional().nullable(),
  approvalCode:       z.string().optional().nullable(),
  amountSen:        z.number().int().nonnegative(),
  accountSheet:       z.string().optional().nullable(),
  collectedBy:        z.string().uuid().optional().nullable(),
  note:               z.string().optional().nullable(),
});

consignmentOrders.post('/:docNo/payments', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  /* Self-scoped sales may only record a payment against their OWN CO. This verb
     WRITES MONEY into the ledger GET /:docNo/payments already scopes on read. */
  if (await selfScopedConsignmentBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  const { data: so } = await scopeToCompanyId(sb.from('consignment_sales_orders').select('doc_no').eq('doc_no', docNo), co.companyId).maybeSingle();
  if (!so) return c.json(NOT_THIS_COMPANY, 404);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = paymentCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  const merchantLike      = p.method === 'merchant' || p.method === 'installment';
  const merchantProvider  = merchantLike ? (p.merchantProvider ?? null) : null;
  const installmentMonths = merchantLike
    ? (typeof p.installmentMonths === 'number' && p.installmentMonths > 0 ? p.installmentMonths : null)
    : null;
  const onlineType        = p.method === 'transfer' ? (p.onlineType ?? null) : null;

  const { data, error } = await sb.from('consignment_sales_order_payments').insert({
    company_id:         activeCompanyId(c), // multi-company: stamp the active company
    so_doc_no:          docNo,
    paid_at:            p.paidAt,
    method:             p.method,
    merchant_provider:  merchantProvider,
    installment_months: installmentMonths,
    online_type:        onlineType,
    approval_code:      p.approvalCode ?? null,
    amount_sen:       p.amountSen,
    account_sheet:      p.accountSheet ?? null,
    collected_by:       p.collectedBy ?? null,
    note:               p.note ?? null,
    created_by:         user.id,
  }).select(PAYMENT_COLS).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);

  await recordSoAudit(sb, {
    docNo,
    action: 'ADD_PAYMENT',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'paidAt',             from: null, to: p.paidAt },
      { field: 'method',             from: null, to: p.method },
      { field: 'amountSen',        from: null, to: p.amountSen },
      ...(merchantProvider  ? [{ field: 'merchantProvider',  from: null, to: merchantProvider  } satisfies FieldChange] : []),
      ...(installmentMonths ? [{ field: 'installmentMonths', from: null, to: installmentMonths } satisfies FieldChange] : []),
      ...(onlineType        ? [{ field: 'onlineType',        from: null, to: onlineType        } satisfies FieldChange] : []),
      ...(p.approvalCode    ? [{ field: 'approvalCode',      from: null, to: p.approvalCode    } satisfies FieldChange] : []),
      ...(p.accountSheet    ? [{ field: 'accountSheet',      from: null, to: p.accountSheet    } satisfies FieldChange] : []),
    ],
  });

  return c.json({ payment: data }, 201);
});

consignmentOrders.delete('/:docNo/payments/:id', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const id = c.req.param('id');
  const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  // Own CO only. Deleting a receipt re-opens the balance, so this writes money.
  if (await selfScopedConsignmentBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

  const { data: row } = await scopeToCompanyId(sb.from('consignment_sales_order_payments').select('*').eq('id', id), co.companyId).maybeSingle();
  if (!row) return c.json(NOT_THIS_COMPANY, 404);
  const rowTyped = row as { so_doc_no: string; paid_at: string; method: string; amount_sen: number; approval_code: string | null };
  if (rowTyped.so_doc_no !== docNo) return c.json({ error: 'payment_doc_mismatch' }, 400);

  const { error } = await scopeToCompanyId(sb.from('consignment_sales_order_payments').delete().eq('id', id), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);

  await recordSoAudit(sb, {
    docNo,
    action: 'DELETE_PAYMENT',
    actorId: user.id,
    actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
    fieldChanges: [
      { field: 'paidAt',       from: rowTyped.paid_at,       to: null },
      { field: 'method',       from: rowTyped.method,        to: null },
      { field: 'amountSen',  from: rowTyped.amount_sen,  to: null },
      ...(rowTyped.approval_code ? [{ field: 'approvalCode', from: rowTyped.approval_code, to: null } satisfies FieldChange] : []),
    ],
  });

  return c.json({ ok: true });
});

// ── Debtor lookup — autocomplete from prior consignment orders ────────
consignmentOrders.get('/debtors/search', async (c) => {
  const sb = c.get('supabase'); const q = c.req.query('q') ?? '';
  let query = scopeToCompany(sb.from('consignment_sales_orders').select('debtor_code, debtor_name, phone, address1, address2, address3, address4'), c).order('updated_at', { ascending: false }).limit(200);
  { const s = escapeForOr(q); if (s) query = query.or(`debtor_name.ilike.%${s}%,debtor_code.ilike.%${s}%`); }
  const { data, error } = await query;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  // Dedupe by (debtor_code || debtor_name) — keep most recent only.
  const seen = new Set<string>();
  const out = [];
  for (const r of (data ?? []) as Array<Record<string, string | null>>) {
    const key = (r.debtor_code || r.debtor_name || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= 25) break;
  }
  return c.json({ debtors: out });
});
