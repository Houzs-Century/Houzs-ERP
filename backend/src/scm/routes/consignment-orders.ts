
import { yymmFor } from '../../services/documentRefs';
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
import { collectProcessingGateProblems, validationFailedBody } from '../shared/so-save-problems';
import { soDatePairCascadeColumns, soDatePairRefusal } from '../shared/so-processing-date';
import { validateItemCodes, unknownItemCodeResponse } from '../lib/validate-item-codes';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { moneySkipsCancelled, NOT_CANCELLED_OR } from '../lib/list-money-cancelled';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { SO_ITEM_FINANCE_KEYS, stripAuditFinance } from '../lib/finance-keys';
import type { Env, Variables } from '../env';
import { skuCategoryResolver } from '../lib/sku-category';
import { pgrestIn } from '../lib/pgrest-in-list';
import { cascadeCoHeaderDelivery } from '../lib/co-header-date-cascade';

export const consignmentOrders = new Hono<{ Bindings: Env; Variables: Variables }>();
consignmentOrders.use('*', supabaseAuth);

/* eslint-disable @typescript-eslint/no-explicit-any */

async function coHasDownstream(sb: any, coDocNo: string): Promise<{ error: string; message: string } | null> {
  const { count: noteCount, error: noteErr } = await sb.from('consignment_delivery_orders')
    .select('id', { head: true, count: 'exact' })
    .eq('consignment_so_doc_no', coDocNo)
    .neq('status', 'CANCELLED');
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

  const { data: owned, error: ownedErr } = await scopeToCompany(sb.from('consignment_sales_orders').select('doc_no').eq('doc_no', docNo), c).maybeSingle();
  if (ownedErr || !owned) return true;

  if (canViewAllSales(c)) return false;
  const { data, error } = await sb
    .from('consignment_sales_orders')
    .select('salesperson_id')
    .eq('doc_no', docNo)
    .maybeSingle();
  if (error || !data) return true;
  const sp = (data as { salesperson_id?: number | string | null }).salesperson_id;
  return salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, false, sp);
}


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





export const nextDocNo = async (sb: any, c: any): Promise<string> => {
  const yymm = yymmFor();
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'consignment_sales_orders', 'doc_no', `${p}CS-${yymm}`);
};


consignmentOrders.get('/', async (c) => {
  const sb = c.get('supabase');
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));
  const status = c.req.query('status');
  const debtor = c.req.query('debtor');

  const pageRaw = c.req.query('page');
  const paginate = pageRaw !== undefined && pageRaw !== '';
  const page = Math.max(0, Math.trunc(Number(pageRaw)) || 0);
  const psRaw = Number(c.req.query('pageSize'));
  const pageSize = Number.isFinite(psRaw) && psRaw > 0 ? Math.min(200, Math.max(1, Math.trunc(psRaw))) : 50;

  let data: unknown[] | null;
  let count: number | null = null;
  let aggregates: { revenueSen: number; outstandingSen: number; paidSen: number } | undefined;
  if (!paginate) {
    let q = sb.from('consignment_sales_orders').select(HEADER).order('so_date', { ascending: false }).limit(500);
    if (scopeIds) q = q.in('salesperson_id', scopeIds);
    if (status) q = q.eq('status', status);
    if (debtor) q = q.ilike('debtor_name', `%${debtor}%`);
    q = scopeToCompany(q, c);
    const res = await q;
    if (res.error) return c.json({ error: 'load_failed', reason: res.error.message }, 500);
    data = res.data ?? [];
  } else {
    const SORT_COLS = new Set(['so_date', 'doc_no', 'debtor_name', 'status', 'local_total_sen']);
    const [rawCol, rawDir] = (c.req.query('sort') ?? 'so_date:desc').split(':');
    const sortCol = SORT_COLS.has(rawCol) ? rawCol : 'so_date';
    const sortAsc = rawDir === 'asc';
    let q = sb.from('consignment_sales_orders').select(HEADER, { count: 'exact' }).order(sortCol, { ascending: sortAsc });
    if (sortCol !== 'doc_no') q = q.order('doc_no', { ascending: false });
    if (scopeIds) q = q.in('salesperson_id', scopeIds);
    if (status) q = q.eq('status', status);
    if (debtor) q = q.ilike('debtor_name', `%${debtor}%`);
    const qText = c.req.query('q');
    if (qText) { const s = escapeForOr(qText); if (s) q = q.or(`doc_no.ilike.%${s}%,debtor_name.ilike.%${s}%`); }
    const outstanding = c.req.query('outstanding') === '1';
    if (outstanding) q = q.gt('balance_sen', 0);
    q = scopeToCompany(q, c);
    q = q.range(page * pageSize, page * pageSize + pageSize - 1);
    const res = await q;
    if (res.error) return c.json({ error: 'load_failed', reason: res.error.message }, 500);
    data = res.data ?? [];
    count = res.count ?? (res.data?.length ?? 0);

    const moneyRes = await paginateAll<{ local_total_sen: number | null; balance_sen: number | null; paid_sen: number | null }>((mfrom, mto) => {
      let mq = sb.from('consignment_sales_orders').select('local_total_sen, balance_sen, paid_sen');
      if (scopeIds) mq = mq.in('salesperson_id', scopeIds);
      if (status) mq = mq.eq('status', status);
      if (moneySkipsCancelled(status)) mq = mq.or(NOT_CANCELLED_OR);
      if (debtor) mq = mq.ilike('debtor_name', `%${debtor}%`);
      if (qText) { const s = escapeForOr(qText); if (s) mq = mq.or(`doc_no.ilike.%${s}%,debtor_name.ilike.%${s}%`); }
      if (outstanding) mq = mq.gt('balance_sen', 0);
      mq = scopeToCompany(mq, c);
      return mq.order('doc_no').range(mfrom, mto);
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
        pgrestIn(sb
          .from('mfg_products')
          .select('code, branding'), 'code', [...mattressCodesToLookup]),
        c,
      );
      for (const p of (prodRows ?? []) as Array<{ code: string; branding: string | null }>) {
        if (p.branding && p.branding.trim()) productBranding.set(p.code, p.branding);
      }
    }

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

  gateCoFinance(c, rows, null);

  if (paginate) return c.json({ salesOrders: rows, total: count ?? rows.length, page, pageSize, aggregates });
  return c.json({ salesOrders: rows });
});

consignmentOrders.get('/mine', async (c) => {
  const sb = c.get('supabase'); const user = c.get('user');
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
  {
    const sp = (h.data as { salesperson_id?: number | string | null }).salesperson_id;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), sp)) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
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

/* sales-scope-ok: NO selfScopedConsignmentBlocked HERE, deliberately. The guard
   asks "is this EXISTING doc mine"; a create has no target row, so it would
   refuse every create. OPEN, for the owner: this path takes body.salespersonId
   verbatim (mfg-sales-orders gates it on scm.so.attribute_other), so a scoped
   rep can book a new consignment order under someone else's name. */
consignmentOrders.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const customerName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!customerName) return c.json({ error: 'customer_name_required' }, 400);
  const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!rawPhone) {
    return c.json({ error: 'phone_required', reason: 'A phone number is required on every consignment order.' }, 400);
  }
  const normPhone = normalizePhone(rawPhone) ?? rawPhone;
  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];

  const sb = c.get('supabase'); const user = c.get('user');
  const coGroupOf = await skuCategoryResolver(sb, items.map((it) => ({ materialKind: 'mfg_product', itemCode: it.itemCode })), activeCompanyId(c) ?? null);

  if (items.length > 0) {
    const codeCheck = await validateItemCodes(sb, items.map((it) => it.itemCode as string | null | undefined), activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  {
    const procDate  = (body.processingDate as string | null | undefined) || null;
    const delivDate = (body.customerDeliveryDate as string | null | undefined) || null;
    const coCreatePairRefusal = soDatePairRefusal({
      nextProc: procDate, nextDeliv: delivDate, origProc: null, origDeliv: null,
    });
    if (coCreatePairRefusal) return c.json(coCreatePairRefusal, 400);
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
    const mainMix = await createMixRefusal(sb, items, activeCompanyId(c));
    if (mainMix) return c.json(mainMix.body, mainMix.status);
  }

  let docNo = '';

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

  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0;
  const headerDeliveryDate = dateOrNull(body.customerDeliveryDate);

  const cachedConfig = await loadMaintenanceConfig(sb, activeCompanyId(c));
  const cachedSpecialAddons = await loadSpecialAddons(sb, activeCompanyId(c));
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    const code = String(it.itemCode ?? '');
    if (!code) continue;
    const { product, model, lookupError } = await loadProductAndModel(sb, code, activeCompanyId(c));
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
  const cachedModelOverrides = await loadModelFabricTierOverrides(sb);
  const cachedCompartmentOverrides = await loadCompartmentFabricTierOverrides(sb);

  const lineProducts = await Promise.all(
    items.map((it) => loadProductByCode(sb, String(it.itemCode ?? ''), activeCompanyId(c))),
  );

  let orderCustomerId: string | null = null;
  {
    const { data: resolvedCustomerId, error: customerErr } = await sb.rpc('upsert_customer_by_name_phone', {
      p_name:  customerName,
      p_phone: normPhone,
      p_email: typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null,
      p_company_id: activeCompanyId(c) ?? null,
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

  const itemRows = await Promise.all(items.map(async (it, idx) => {
    const qty = Number(it.qty ?? 1);
    const recomputed = recomputes[idx] ?? null;
    const unit = recomputed ? recomputed.unit_price_sen : Number(it.unitPriceSen ?? 0);
    const discount = Number(it.discountSen ?? 0);
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
    company_id: activeCompanyId(c),
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
    deposit_sen:      Math.max(0, typeof body.depositSen === 'number' ? body.depositSen : 0),
    paid_sen:         0,
    status: 'CONFIRMED',
    created_by: user.id,
  }); },
  );
  if (hErr) { return c.json({ error: 'insert_failed', reason: hErr.message }, 500); }

  if (itemRows.length > 0) {
    const rowsWithDoc = itemRows.map((r) => ({ ...r, doc_no: docNo }));
    const { error: iErr } = await sb.from('consignment_sales_order_items').insert(stampCompany(rowsWithDoc, c));
    if (iErr) { await sb.from('consignment_sales_orders').delete().eq('doc_no', docNo); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }
    await recomputeTotals(sb, docNo);
  }

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

export const patchConsignmentOrderStatusHandler = async (c: any) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  if (await selfScopedConsignmentBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  let body: { status?: string; notes?: string }; try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.status) return c.json({ error: 'status_required' }, 400);
  const toStatus = String(body.status).trim().toUpperCase();
  const { data: prev } = await scopeToCompanyId(sb.from('consignment_sales_orders').select('status').eq('doc_no', docNo), co.companyId).maybeSingle();
  const fromStatus = (prev as { status: string } | null)?.status ?? null;
  if (toStatus === 'CANCELLED' && fromStatus !== 'CANCELLED') {
    const childLock = await coHasDownstream(sb, docNo);
    if (childLock) return c.json(childLock, 409);
  }

  const patch: Record<string, unknown> = { status: toStatus, updated_at: new Date().toISOString() };
  const { data, error } = await scopeToCompanyId(sb.from('consignment_sales_orders').update(patch)
    .eq('doc_no', docNo), co.companyId).select('doc_no, status').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
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

consignmentOrders.get('/:docNo/audit-log', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
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
  const entries = (data ?? []) as Array<Record<string, unknown>>;
  if (!canViewScmFinance(c)) stripAuditFinance(entries);
  return c.json({ entries });
});

export const consignmentOverridePriceHandler = async (c: any) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const itemId = c.req.param('itemId');
  const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  if (!hasHouzsPerm(c, 'scm.so.price_override')) return c.json({ error: 'price_override_admin_only', message: 'Unit prices follow the SKU Master sell price. Only an admin can override a line price.' }, 403);
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

consignmentOrders.patch('/:docNo', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  if (await selfScopedConsignmentBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

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
  ];
  const PHONE_FIELDS = new Set(['phone', 'emergencyContactPhone']);
  const canFinance = canViewScmFinance(c);
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [from, to] of map) {
    if (body[from] === undefined) continue;
    if (from === 'depositSen' && !canFinance) continue;
    if (PHONE_FIELDS.has(from) && typeof body[from] === 'string') {
      const raw = body[from] as string;
      updates[to] = normalizePhone(raw) ?? raw;
    } else if (from === 'depositSen') {
      updates[to] = Math.max(0, typeof body[from] === 'number' ? (body[from] as number) : 0);
    } else {
      updates[to] = body[from];
    }
  }
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

  let coVariantOffenders: ReturnType<typeof findIncompleteVariantLines> = [];

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

  const beforeCols = map.map(([, snake]) => snake).concat(['status']).join(', ');
  const { data: before } = await scopeToCompanyId(sb.from('consignment_sales_orders').select(beforeCols).eq('doc_no', docNo), co.companyId).maybeSingle();

  let coCascadedDeliveryClear = false;
  let coDeliveryChanged = false;
  {
    const beforeRow = (before as unknown as Record<string, unknown> | null);
    const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const proc = body['processingDate'];
    const deliv = body['customerDeliveryDate'];
    const origProc = (beforeRow?.['processing_date'] as string | null) ?? null;
    const origDeliv = (beforeRow?.['customer_delivery_date'] as string | null) ?? null;
    const effProc  = effectiveDateAfterPatch(proc,  origProc);
    const effDeliv = effectiveDateAfterPatch(deliv, origDeliv);
    const coCascadeCols = soDatePairCascadeColumns({
      procCleared: proc !== undefined && dateOrNull(proc) === null && !!origProc,
      delivInPatch: deliv !== undefined,
      origDeliv,
    });
    for (const col of coCascadeCols) updates[col] = null;
    coCascadedDeliveryClear = coCascadeCols.length > 0;
    const effDelivAfterCascade = coCascadedDeliveryClear ? null : effDeliv;
    coDeliveryChanged = effDelivAfterCascade !== origDeliv;
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

  if (coDeliveryChanged) {
    await cascadeCoHeaderDelivery(sb, docNo, co.companyId,
      coCascadedDeliveryClear ? null : dateOrNull(body['customerDeliveryDate']));
  }

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

async function recomputeTotals(sb: any, docNo: string) {
  const { data: items, error: itemsErr } = await sb.from('consignment_sales_order_items')
    .select('id, item_code, item_group, variants, qty, total_sen, line_cost_sen')
    .eq('doc_no', docNo).eq('cancelled', false);
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[co-recompute] item read failed — header left unchanged:', docNo, itemsErr.message);
    return;
  }
  type Row = { id: string; item_code: string; item_group: string; variants: Record<string, unknown> | null; qty: number; total_sen: number; line_cost_sen: number };
  const rows = (items ?? []) as Row[];

  const sofaRows = rows.filter((r) => (r.item_group ?? '').toLowerCase() === 'sofa');
  if (sofaRows.length > 0) {
    const combos = await loadActiveSofaCombos(sb);
    if (combos.length > 0) {
      const fabricCodes = [...new Set(sofaRows.map((r) => String((r.variants ?? {} as Record<string, unknown>).fabricCode ?? '')).filter(Boolean))];
      const tierByFabric = new Map<string, SofaPriceTier>();
      if (fabricCodes.length > 0) {
        const { data: fabs, error: fabsErr } = await sb.from('fabric_trackings').select('fabric_code, price_tier, sofa_price_tier').in('fabric_code', fabricCodes);
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
        if (!sizeCode) continue;
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
        if (pool.length === 0) continue;
        const match = pickComboMatch(
          { baseModel: '', modules: members.map((m) => splitSofaCode(m.item_code).sizeCode), customerId: null, tier, height },
          pool,
        );
        if (!match) continue;
        const matched = match.matchedIndices.map((i) => members[i]).filter((m): m is Row => !!m);
        if (matched.length === 0) continue;
        const qtySet = new Set(matched.map((m) => Math.max(1, m.qty || 1)));
        if (qtySet.size !== 1) continue;
        const uniformQty = [...qtySet][0]!;
        const comboTotal = match.comboPriceSen * uniformQty;
        if (comboTotal <= 0) continue;
        const spread = spreadComboTotal(matched.map((m) => m.line_cost_sen || 0), comboTotal);
        for (let i = 0; i < matched.length; i++) {
          const m = matched[i]!; const newLineCost = spread[i] ?? 0; const q = Math.max(1, m.qty || 1);
          m.line_cost_sen = newLineCost;
          const { error: spreadErr } = await sb.from('consignment_sales_order_items').update({
            line_cost_sen:   newLineCost,
            unit_cost_sen:   Math.round(newLineCost / q),
            line_margin_sen: (m.total_sen || 0) - newLineCost,
          }).eq('id', m.id);
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
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[co-recompute] header update failed — totals left STALE:', docNo, updErr.message);
  }
}

consignmentOrders.post('/:docNo/items', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  if (await selfScopedConsignmentBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);

  {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }
  const addGroup = (await skuCategoryResolver(sb, [{ materialKind: 'mfg_product', itemCode: it.itemCode }], activeCompanyId(c) ?? null))(it) ?? 'others'; // SKU wins — docs/bugs/0514

  const childLock = await coHasDownstream(sb, docNo);
  if (childLock) return c.json(childLock, 409);

  const mainMix = await lineMixRefusal(sb, 'consignment_sales_order_items', docNo, null, String(it.itemCode), activeCompanyId(c));
  if (mainMix) return c.json(mainMix.body, mainMix.status);

  const { data: header } = await scopeToCompanyId(sb.from('consignment_sales_orders').select('debtor_code, debtor_name, agent, branding, venue, customer_delivery_date, customer_state').eq('doc_no', docNo), co.companyId).maybeSingle();
  if (!header) return c.json(NOT_THIS_COMPANY, 404);

  const qty = Number(it.qty ?? 1);
  const discount = Number(it.discountSen ?? 0);
  const itemCodeStr = String(it.itemCode ?? '');
  const variantsObj = (it.variants as MfgItemForRecompute['variants']) ?? null;
  {
    const { product, model, lookupError } = await loadProductAndModel(sb, itemCodeStr, activeCompanyId(c));
    if (lookupError) return c.json(variantCheckUnavailableResponse(lookupError), 409);
    const aoErr = checkAllowedOptions(
      product,
      model,
      variantsObj as Parameters<typeof checkAllowedOptions>[2],
    );
    if (aoErr) return c.json({ ...aoErr, itemCode: itemCodeStr }, 400);
  }
  const [cachedConfig, productLite, fabricLite, sofaCombosLite, sellingTiersLite, fabricAddonConfigLite, specialAddonsLite, modelOverridesLite, compartmentOverridesLite] = await Promise.all([
    loadMaintenanceConfig(sb, activeCompanyId(c)),
    loadProductByCode(sb, itemCodeStr, activeCompanyId(c)),
    loadFabricByCode(sb, variantsObj?.fabricCode ?? null),
    loadActiveSofaCombos(sb),
    loadFabricSellingTiers(sb, (variantsObj as { fabricId?: string } | null)?.fabricId ?? null),
    loadFabricTierAddonConfig(sb, activeCompanyId(c)),
    loadSpecialAddons(sb, activeCompanyId(c)),
    loadModelFabricTierOverrides(sb),
    loadCompartmentFabricTierOverrides(sb),
  ]);
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
    null,
    null,
    specialAddonsLite,
    sofaModuleCostRowsLite,
    modelOverridesLite,
    compartmentOverridesLite,
  );
  const unit = recomputed.unit_price_sen;
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
  if (await selfScopedConsignmentBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  if (it.itemCode !== undefined) {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  const childLock = await coHasDownstream(sb, docNo);
  if (childLock) return c.json(childLock, 409);

  const { data: prev } = await scopeToCompanyId(sb.from('consignment_sales_order_items')
    .select('qty, unit_price_sen, discount_sen, unit_cost_sen, item_code, item_group, description, description2, uom, variants, remark, cancelled')
    .eq('id', itemId), co.companyId).maybeSingle();
  if (!prev) return c.json(NOT_THIS_COMPANY, 404);
  if (it.itemCode !== undefined) {
    const mainMix = await lineMixRefusal(sb, 'consignment_sales_order_items', docNo, itemId, String(it.itemCode), activeCompanyId(c));
    if (mainMix) return c.json(mainMix.body, mainMix.status);
  }

  const qty = it.qty !== undefined ? Number(it.qty) : prev.qty;
  const clientUnit = it.unitPriceSen !== undefined ? Number(it.unitPriceSen) : prev.unit_price_sen;
  const discount = it.discountSen !== undefined ? Number(it.discountSen) : prev.discount_sen;

  let recomputedPatch: RecomputedLine | null = null;
  const variantsAfter = it.variants !== undefined
    ? (it.variants as MfgItemForRecompute['variants'])
    : ((prev as { variants?: MfgItemForRecompute['variants'] }).variants ?? null);
  const itemCodeAfter = it.itemCode !== undefined ? String(it.itemCode) : prev.item_code;
  const itemGroupAfter = it.itemGroup !== undefined ? String(it.itemGroup) : prev.item_group;
  const shouldRecompute = it.variants !== undefined || it.unitPriceSen !== undefined || it.itemCode !== undefined;

  if (it.variants !== undefined || it.itemCode !== undefined) {
    const { product, model, lookupError } = await loadProductAndModel(sb, itemCodeAfter, activeCompanyId(c));
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
      loadMaintenanceConfig(sb, activeCompanyId(c)),
      loadProductByCode(sb, itemCodeAfter, activeCompanyId(c)),
      loadFabricByCode(sb, variantsAfter?.fabricCode ?? null),
      loadActiveSofaCombos(sb),
      loadFabricSellingTiers(sb, (variantsAfter as { fabricId?: string } | null)?.fabricId ?? null),
      loadFabricTierAddonConfig(sb, activeCompanyId(c)),
      loadSpecialAddons(sb, activeCompanyId(c)),
      loadModelFabricTierOverrides(sb),
      loadCompartmentFabricTierOverrides(sb),
    ]);
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
      null,
      null,
      specialAddonsPatch,
      sofaModuleCostRowsPatch,
      modelOverridesPatch,
      compartmentOverridesPatch,
    );
  }
  const unit = recomputedPatch ? recomputedPatch.unit_price_sen : clientUnit;
  let unitCost: number;
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
  if (await selfScopedConsignmentBlocked(c, docNo)) return c.json({ error: 'not_found' }, 404);

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
    const { signedUrl: thumbUrl } = await signSoItemPhotoUrl(bindings, thumbKeyFor(photoKey));
    return c.json({ photoKey, photoUrl: signedUrl, thumbUrl, expiresAt }, 201);
  } catch (e) {
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
    const { signedUrl: thumbUrl } = await signSoItemPhotoUrl(bindings, thumbKeyFor(photoKey));
    const payload: PhotoUrlPayload = { mode: 'signed', signedUrl, thumbUrl, expiresAt };
    return c.json(payload);
  } catch (e) {
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

consignmentOrders.get('/:docNo/items/:itemId/photos/:photoKey', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  const itemId = c.req.param('itemId');
  const photoKey = decodeURIComponent(c.req.param('photoKey'));

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

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

const PAYMENT_COLS =
  'id, so_doc_no, paid_at, method, merchant_provider, installment_months, ' +
  'online_type, approval_code, amount_sen, account_sheet, collected_by, note, ' +
  'created_at, created_by';

consignmentOrders.get('/:docNo/payments', async (c) => {
  const sb = c.get('supabase'); const docNo = c.req.param('docNo');
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
    company_id:         activeCompanyId(c),
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

consignmentOrders.get('/debtors/search', async (c) => {
  const sb = c.get('supabase'); const q = c.req.query('q') ?? '';
  let query = scopeToCompany(sb.from('consignment_sales_orders').select('debtor_code, debtor_name, phone, address1, address2, address3, address4'), c).order('updated_at', { ascending: false }).limit(200);
  { const s = escapeForOr(q); if (s) query = query.or(`debtor_name.ilike.%${s}%,debtor_code.ilike.%${s}%`); }
  const { data, error } = await query;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

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
