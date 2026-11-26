
import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { mytDateOf, rangeBoundsMy } from '../lib/my-time';
import { scopeToCompany, activeCompanyId } from '../lib/companyScope';
import { stampOrderDeposit } from '../lib/si-list-stamps';
import { creditNotesOf } from '../lib/si-credit-notes';
import { stampSoRefs } from '../lib/so-ref-lookup';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { deriveDisplayBrandingByDoc } from '../lib/so-display-branding';
import { isPlaceholderBrandText } from '../shared/so-branding-label';
import { canViewAllSales, canViewScmFinance } from '../lib/houzs-perms';
import { warehouseLabel } from '../lib/warehouse-label';
import { bookSpellingOrOwn } from '../../services/autocount-writeback';
import { LOCATION_MAP } from '../../services/autocount-master-maps';
import { salesJdDenial } from '../../services/salesJdAccess';
import { resolveSalesScopeIds } from '../lib/salesScope';
import { SO_FINANCE_KEYS, SO_ITEM_FINANCE_KEYS } from '../lib/finance-keys';
import { soPaidSen, soPaidInputsOf } from '../shared/so-outstanding';
import {
  parseStage, parseDateBasis, dayInWindow, fairReportAccess, fairSoMoney, depositByTender, paymentMethodsUsed,
  belowDeposit, fairBalanceSen, doCostTotal, siCostTotal, siGoodsTotals, marginPct, resolveDateWindow,
  summarizeSo, summarizeDo, summarizeInvoice,
  fairPnlLineCost, summarizeFairPnl, everyFairPnl,
  type FairStage, type FairFilters, type PaymentRow, type FairCostRate, type FairPnlSummaryRow,
  type DoCostLine, type SiGoodsLine,
} from '../lib/fair-report';
import type { AuthUser } from '../../services/auth';

const gateReportFinance = (
  c: Parameters<typeof canViewScmFinance>[0],
  rows: Array<Record<string, unknown>>,
): void => {
  if (canViewScmFinance(c)) return;
  for (const r of rows) {
    for (const k of SO_FINANCE_KEYS) delete r[k];
    for (const k of SO_ITEM_FINANCE_KEYS) delete r[k];
  }
};

export const reports = new Hono<{ Bindings: Env; Variables: Variables }>();
reports.use('*', supabaseAuth);

reports.get('/sales-order-detail-listing', async (c) => {
  const sb = c.get('supabase');

  const dateFrom         = c.req.query('dateFrom');
  const dateTo           = c.req.query('dateTo');
  const docNo            = c.req.query('docNo');
  const debtorCode       = c.req.query('debtorCode');
  const itemCode         = c.req.query('itemCode');
  const deliveryDateFrom = c.req.query('deliveryDateFrom');
  const deliveryDateTo   = c.req.query('deliveryDateTo');
  const sortBy           = (c.req.query('sortBy') ?? 'date') as 'date' | 'doc_no' | 'item_code';

  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  const { data, error } = await paginateAll((pFrom, pTo) => {
    let q = sb
      .from('mfg_sales_order_items')
      .select(`
        id, doc_no, line_date, debtor_code, debtor_name, agent, item_group, item_code,
        description, description2, uom, location, qty, unit_price_sen, discount_sen,
        total_sen, tax_sen, total_inc_sen, balance_sen, payment_status, venue,
        branding, remark, cancelled, variants, created_at,
        unit_cost_sen, line_cost_sen, line_margin_sen,
        divan_height_inches, leg_height_inches, custom_specials,
        mfg_sales_orders!inner (
          doc_no, so_date, debtor_code, debtor_name, agent, branding, venue, ref,
          phone, address1, address2, address3, address4,
          currency, status, remark2, remark3, remark4, note,
          sales_exemption_expiry, approval_code,
          local_total_sen, balance_sen, deposit_sen,
          mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen, service_sen,
          mattress_sofa_cost_sen, bedframe_cost_sen, accessories_cost_sen, others_cost_sen, service_cost_sen,
          total_cost_sen, total_margin_sen, margin_pct_basis,
          customer_delivery_date, processing_date, target_date,
          customer_state, customer_country, customer_so_no,
          hub_name
        )
      `);
    if (docNo)      q = q.ilike('doc_no', `%${docNo}%`);
    if (itemCode)   q = q.ilike('item_code', `%${itemCode}%`);
    if (debtorCode) q = q.eq('debtor_code', debtorCode);
    if (scopeIds) q = q.in('mfg_sales_orders.salesperson_id', scopeIds);
    q = scopeToCompany(q, c);
    if (sortBy === 'item_code') {
      q = q.order('item_code', { ascending: true });
    } else if (sortBy === 'doc_no') {
      q = q.order('doc_no', { ascending: false });
    } else {
      q = q.order('line_date', { ascending: false });
    }
    return q.range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  type ItemRow = Record<string, unknown> & {
    mfg_sales_orders: Record<string, unknown> | Record<string, unknown>[] | null;
    line_date: string | null;
    doc_no: string;
    variants:             Record<string, unknown> | null;
    divan_height_inches:  number | null;
    leg_height_inches:    number | null;
    custom_specials:      unknown;
  };
  const itemsRaw = (data ?? []) as unknown as ItemRow[];

  const docNos = Array.from(new Set(itemsRaw.map((i) => i.doc_no))).filter(Boolean);
  const paidByDoc = new Map<string, number>();
  type PaymentMeta = {
    lastPaidAt: string | null;
    accountSheet: string | null;
    approvalCode: string | null;
    collectedById: string | null;
  };
  const paymentMetaByDoc = new Map<string, PaymentMeta>();
  const approvalCodesByDoc = new Map<string, Array<{ paidAt: string | null; code: string }>>();
  if (docNos.length > 0) {
    const { data: paymentTotals, error: payErr } = await chunkIn(docNos, (batch, pFrom, pTo) => scopeToCompany(sb
      .from('mfg_sales_order_payments')
      .select('so_doc_no, amount_sen, paid_at, account_sheet, approval_code, collected_by')
      .in('so_doc_no', batch), c)
      .range(pFrom, pTo));
    if (payErr) return c.json({ error: 'load_failed', reason: payErr.message }, 500);
    for (const p of paymentTotals ?? []) {
      const row = p as {
        so_doc_no: string;
        amount_sen: number | null;
        paid_at: string | null;
        account_sheet: string | null;
        approval_code: string | null;
        collected_by: string | null;
      };
      const key = row.so_doc_no;
      paidByDoc.set(key, (paidByDoc.get(key) ?? 0) + Number(row.amount_sen ?? 0));
      if (row.approval_code && row.approval_code.trim() !== '') {
        const arr = approvalCodesByDoc.get(key) ?? [];
        arr.push({ paidAt: row.paid_at ?? null, code: row.approval_code.trim() });
        approvalCodesByDoc.set(key, arr);
      }
      const prev = paymentMetaByDoc.get(key);
      const isNewer = !prev || !prev.lastPaidAt || (row.paid_at && row.paid_at > prev.lastPaidAt);
      if (isNewer) {
        paymentMetaByDoc.set(key, {
          lastPaidAt:    row.paid_at ?? prev?.lastPaidAt ?? null,
          accountSheet:  row.account_sheet  ?? prev?.accountSheet  ?? null,
          approvalCode:  row.approval_code  ?? prev?.approvalCode  ?? null,
          collectedById: row.collected_by   ?? prev?.collectedById ?? null,
        });
      }
    }
  }

  const collectorIds = Array.from(new Set(
    [...paymentMetaByDoc.values()].map((m) => m.collectedById).filter((v): v is string => Boolean(v))
  ));
  const staffNameById = new Map<string, string>();
  if (collectorIds.length > 0) {
    const { data: staffRows, error: staffErr } = await chunkIn(collectorIds, (batch, pFrom, pTo) => sb
      .from('staff')
      .select('id, name')
      .in('id', batch)
      .range(pFrom, pTo));
    if (staffErr) return c.json({ error: 'load_failed', reason: staffErr.message }, 500);
    for (const s of staffRows ?? []) {
      const row = s as { id: string; name: string | null };
      if (row.id && row.name) staffNameById.set(row.id, row.name);
    }
  }

  const rows = itemsRaw
    .map((r) => {
      const rawHeader = r.mfg_sales_orders;
      const h: Record<string, unknown> = Array.isArray(rawHeader)
        ? ((rawHeader[0] as Record<string, unknown>) ?? {})
        : ((rawHeader as Record<string, unknown>) ?? {});
      const flat: Record<string, unknown> = { ...r };
      delete flat.mfg_sales_orders;
      for (const [k, v] of Object.entries(h)) {
        if (k in flat && flat[k] != null && flat[k] !== '') continue;
        flat[k] = v;
      }
      flat.so_date  = h.so_date  ?? flat.so_date  ?? flat.line_date ?? null;
      flat.currency = h.currency ?? 'MYR';
      flat.status   = h.status   ?? null;
      flat.customer_delivery_date = h.customer_delivery_date ?? null;
      flat.paid_total_sen = paidByDoc.get(r.doc_no) ?? 0;
      const variantsObj = (r.variants ?? null) as Record<string, unknown> | null;
      const vStr = (k: string): string | null => {
        const v = variantsObj?.[k];
        return typeof v === 'string' && v.trim() ? v.trim() : null;
      };
      flat.fabric = vStr('fabricColor') ?? vStr('colourLabel') ?? vStr('fabricCode');
      const heightVal = (col: unknown, ...keys: string[]): number | string | null => {
        if (col != null) return col as number;
        for (const k of keys) {
          const raw = vStr(k);
          if (!raw) continue;
          const m = raw.match(/^(-?\d+(?:\.\d+)?)\s*(?:"|”|inch(?:es)?)?$/i);
          return m && m[1] ? Number(m[1]) : raw;
        }
        return null;
      };
      flat.divan_height = heightVal(r.divan_height_inches, 'divanHeight');
      flat.leg_height   = heightVal(r.leg_height_inches, 'legHeight', 'sofaLegHeight');
      const pm = paymentMetaByDoc.get(r.doc_no);
      flat.last_payment_at = pm?.lastPaidAt   ?? null;
      flat.account_sheet   = pm?.accountSheet ?? null;
      const codes = (approvalCodesByDoc.get(r.doc_no) ?? [])
        .sort((a, b) => String(a.paidAt ?? '').localeCompare(String(b.paidAt ?? '')))
        .map((x) => x.code);
      flat.approval_code = codes.length > 0
        ? codes.join(' + ') + (codes.length > 1 ? ` (${codes.length})` : '')
        : ((h.approval_code as string | null) ?? null);
      flat.collected_by    = pm?.collectedById ? (staffNameById.get(pm.collectedById) ?? null) : null;
      return flat;
    })
    .filter((r) => {
      const soDate = (r.so_date ?? r.line_date) as string | null;
      if (dateFrom && (!soDate || soDate < dateFrom)) return false;
      if (dateTo   && (!soDate || soDate > dateTo))   return false;
      const dd = r.customer_delivery_date as string | null;
      if (deliveryDateFrom && (!dd || dd < deliveryDateFrom)) return false;
      if (deliveryDateTo   && (!dd || dd > deliveryDateTo))   return false;
      return true;
    });

  gateReportFinance(c, rows);

  return c.json({ rows });
});

// ----------------------------------------------------------------------------
// Costing-gap listing (owner 2026-09-26). Which SO lines carry NO cost because
// the PRODUCT itself has no cost — the actionable list of products to fill in
// Product Maintenance (a line whose product HAS a cost is filled by the nightly
// restamp, so it is NOT a real gap and is excluded). Sits beside P&L in the
// Sales Report so the owner sees exactly what is incomplete. Read-only;
// finance-gated (it exposes the cost dimension).
// ----------------------------------------------------------------------------
function productHasCost(p: { category?: unknown; base_price_sen?: unknown; cost_price_sen?: unknown; seat_height_prices?: unknown }): boolean {
  if (Number(p.base_price_sen) > 0 || Number(p.cost_price_sen) > 0) return true;
  const grid = Array.isArray(p.seat_height_prices) ? p.seat_height_prices : [];
  return grid.some((r) => (r?.tier ?? 'PRICE_2') === 'PRICE_2' && Number(r?.priceSen) > 0);
}

reports.get('/costing-gap-listing', async (c) => {
  const sb = c.get('supabase');
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  const { data: prodData, error: prodErr } = await paginateAll((pFrom, pTo) => {
    let q = sb.from('mfg_products').select('code, category, base_price_sen, cost_price_sen, seat_height_prices');
    q = scopeToCompany(q, c);
    return q.range(pFrom, pTo);
  });
  if (prodErr) return c.json({ error: 'load_failed', reason: prodErr.message }, 500);
  const noCostCodes = new Set<string>();
  for (const p of (prodData ?? []) as AnyRow[]) if (!productHasCost(p)) noCostCodes.add(String(p.code));

  const { data, error } = await paginateAll((pFrom, pTo) => {
    let q = sb
      .from('mfg_sales_order_items')
      .select(`
        id, doc_no, line_date, item_code, description, item_group, qty, unit_cost_sen, cancelled, variants,
        mfg_sales_orders!inner ( doc_no, so_date, debtor_name, branding, venue, status )
      `)
      .or('unit_cost_sen.is.null,unit_cost_sen.eq.0');
    if (scopeIds) q = q.in('mfg_sales_orders.salesperson_id', scopeIds);
    q = scopeToCompany(q, c);
    return q.range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const rows = ((data ?? []) as unknown as AnyRow[])
    .map((r) => flattenJoin(r, 'mfg_sales_orders'))
    .filter((r) => !r.cancelled && noCostCodes.has(String(r.item_code)))
    .map((r) => ({
      doc_no: r.doc_no, so_date: r.so_date ?? r.line_date, item_code: r.item_code,
      description: r.description, item_group: r.item_group, qty: r.qty,
      debtor_name: r.debtor_name, venue: r.venue, branding: r.branding, status: r.status,
    }));

  gateReportFinance(c, rows);
  return c.json({ rows });
});


type AnyRow = Record<string, unknown>;

const flattenJoin = (item: AnyRow, headerKey: string): AnyRow => {
  const rawHeader = item[headerKey];
  const h: AnyRow = Array.isArray(rawHeader)
    ? ((rawHeader[0] as AnyRow) ?? {})
    : ((rawHeader as AnyRow) ?? {});
  const flat: AnyRow = { ...item };
  delete flat[headerKey];
  for (const [k, v] of Object.entries(h)) {
    if (k in flat && flat[k] != null && flat[k] !== '') continue;
    flat[k] = v;
  }
  return flat;
};

reports.get('/delivery-order-detail-listing', async (c) => {
  const sb = c.get('supabase');
  const dateFrom    = c.req.query('dateFrom');
  const dateTo      = c.req.query('dateTo');
  const docNo       = c.req.query('docNo');
  const debtorCode  = c.req.query('debtorCode');
  const itemCode    = c.req.query('itemCode');

  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  const { data, error } = await paginateAll((pFrom, pTo) => {
    let q = sb
      .from('delivery_order_items')
      .select(`
        id, delivery_order_id, so_item_id, item_code, description, description2,
        qty, m3_milli, unit_price_sen, discount_sen, line_total_sen,
        uom, item_group, variants, line_suffix, notes, created_at,
        delivery_orders!inner (
          id, do_number, so_doc_no, debtor_code, debtor_name, do_date,
          expected_delivery_at, signed_at, delivered_at, dispatched_at,
          driver_name, vehicle, address1, address2, city, state, postcode, phone,
          status, notes, m3_total_milli
        )
      `);
    if (docNo)      q = q.ilike('delivery_orders.do_number', `%${docNo}%`);
    if (itemCode)   q = q.ilike('item_code', `%${itemCode}%`);
    if (debtorCode) q = q.eq('delivery_orders.debtor_code', debtorCode);
    if (scopeIds)   q = q.in('delivery_orders.salesperson_id', scopeIds);
    q = scopeToCompany(q, c);
    return q.range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const rows = ((data ?? []) as unknown as AnyRow[])
    .map((r) => {
      const flat = flattenJoin(r, 'delivery_orders');
      flat.doc_no = flat.do_number;
      flat.line_date = flat.do_date;
      flat.total_sen = flat.line_total_sen ?? 0;
      return flat;
    })
    .filter((r) => {
      const d = (r.do_date ?? r.line_date) as string | null;
      if (dateFrom && (!d || d < dateFrom)) return false;
      if (dateTo   && (!d || d > dateTo))   return false;
      return true;
    });
  await stampSoRefs(sb, rows, 'so_doc_no', (q) => scopeToCompany(q, c), 'do-detail-listing');

  return c.json({ rows });
});

reports.get('/sales-invoice-detail-listing', async (c) => {
  const sb = c.get('supabase');
  const dateFrom    = c.req.query('dateFrom');
  const dateTo      = c.req.query('dateTo');
  const docNo       = c.req.query('docNo');
  const debtorCode  = c.req.query('debtorCode');
  const itemCode    = c.req.query('itemCode');

  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  const { data, error } = await paginateAll((pFrom, pTo) => {
    let q = sb
      .from('sales_invoice_items')
      .select(`
        id, sales_invoice_id, so_item_id, item_code, description, description2,
        qty, unit_price_sen, discount_sen, tax_sen, line_total_sen,
        uom, item_group, variants, line_suffix, notes, created_at,
        sales_invoices!inner (
          id, invoice_number, so_doc_no, delivery_order_id, debtor_code, debtor_name,
          invoice_date, due_date, currency,
          subtotal_sen, discount_sen, tax_sen, total_sen, paid_sen,
          status, notes, sent_at, paid_at
        )
      `);
    if (docNo)      q = q.ilike('sales_invoices.invoice_number', `%${docNo}%`);
    if (itemCode)   q = q.ilike('item_code', `%${itemCode}%`);
    if (debtorCode) q = q.eq('sales_invoices.debtor_code', debtorCode);
    if (scopeIds)   q = q.in('sales_invoices.salesperson_id', scopeIds);
    q = scopeToCompany(q, c);
    return q.range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const depositByInvoice = new Map<string, number>();
  const creditByInvoice = new Map<string, number>();
  {
    const stubs: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const r of (data ?? []) as unknown as AnyRow[]) {
      const raw = r.sales_invoices as AnyRow | AnyRow[] | null;
      const h: AnyRow = Array.isArray(raw) ? ((raw[0] as AnyRow) ?? {}) : ((raw as AnyRow) ?? {});
      const id = h.id == null ? '' : String(h.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      stubs.push({ id, so_doc_no: (h.so_doc_no as string | null) ?? null });
    }
    await stampOrderDeposit(sb, stubs, activeCompanyId(c) ?? null);
    for (const st of stubs) {
      depositByInvoice.set(String(st.id), Number(st.so_deposit_applied_sen ?? 0));
      creditByInvoice.set(String(st.id), creditNotesOf(st));
    }
  }

  const rows = ((data ?? []) as unknown as AnyRow[])
    .map((r) => {
      const headerRaw = r.sales_invoices as AnyRow | AnyRow[] | null;
      const headerObj: AnyRow = Array.isArray(headerRaw)
        ? ((headerRaw[0] as AnyRow) ?? {})
        : ((headerRaw as AnyRow) ?? {});
      const headerTotal = Number(headerObj.total_sen ?? 0);
      const headerPaid  = Number(headerObj.paid_sen ?? 0);
      const headerDiscount = Number(headerObj.discount_sen ?? 0);
      const headerTax      = Number(headerObj.tax_sen ?? 0);

      const flat = flattenJoin(r, 'sales_invoices');
      flat.doc_no = flat.invoice_number;
      flat.line_date = flat.invoice_date;
      flat.total_sen = flat.line_total_sen ?? 0;
      flat.header_total_sen    = headerTotal;
      flat.header_paid_sen     = headerPaid;
      flat.header_discount_sen = headerDiscount;
      flat.header_tax_sen      = headerTax;
      const headerDeposit = depositByInvoice.get(String(headerObj.id ?? '')) ?? 0;
      flat.so_deposit_applied_sen = headerDeposit;
      const headerCredit = creditByInvoice.get(String(headerObj.id ?? '')) ?? 0;
      flat.credit_notes_sen = headerCredit;
      flat.balance_sen = Math.max(headerTotal - headerPaid - headerDeposit - headerCredit, 0);
      return flat;
    })
    .filter((r) => {
      const d = (r.invoice_date ?? r.line_date) as string | null;
      if (dateFrom && (!d || d < dateFrom)) return false;
      if (dateTo   && (!d || d > dateTo))   return false;
      return true;
    });
  await stampSoRefs(sb, rows, 'so_doc_no', (q) => scopeToCompany(q, c), 'si-detail-listing');

  return c.json({ rows });
});

reports.get('/delivery-return-detail-listing', async (c) => {
  /* THE SECOND DOOR TO DELIVERY RETURNS, and closing only the first would have
     been a fake close. /reports is mounted on the COARSE umbrella (scm/index.ts
     — it is cross-area, and that mount is still right), so the
     scmAreaGuard('scm.sales.returns') on /delivery-returns/* never runs here:
     this listing returns return_number, debtor, refund and every line to any
     caller holding scm.access. The FE already treats it as part of the returns
     surface (DeliveryReturnsGuard wraps this report's route in App.tsx) — only
     the API disagreed. Gated in the handler, not at the mount, because guarding
     the whole /reports router on scm.sales.returns would 403 the SO/DO/SI
     listings too; that is the same reason this file's finance + scope rules live
     in the handlers. Owner 2026-07-17: "该关（我确实讲过 / 就是要关）". */
  const jdDenial = salesJdDenial(c.get('houzsUser'), 'scm.sales.returns');
  if (jdDenial) return c.json({ error: jdDenial }, 403);

  const sb = c.get('supabase');
  const dateFrom    = c.req.query('dateFrom');
  const dateTo      = c.req.query('dateTo');
  const docNo       = c.req.query('docNo');
  const debtorCode  = c.req.query('debtorCode');
  const itemCode    = c.req.query('itemCode');

  const { data, error } = await paginateAll((pFrom, pTo) => {
    let q = sb
      .from('delivery_return_items')
      .select(`
        id, delivery_return_id, do_item_id, item_code, description,
        qty_returned, condition, unit_price_sen, refund_sen, notes, created_at,
        delivery_returns!inner (
          id, return_number, delivery_order_id, sales_invoice_id, debtor_code,
          debtor_name, return_date, reason, status, refund_sen, ref, customer_so_no,
          received_at, inspected_at, refunded_at, inspection_notes, notes
        )
      `);
    if (docNo)      q = q.ilike('delivery_returns.return_number', `%${docNo}%`);
    if (itemCode)   q = q.ilike('item_code', `%${itemCode}%`);
    if (debtorCode) q = q.eq('delivery_returns.debtor_code', debtorCode);
    q = scopeToCompany(q, c);
    return q.range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const rows = ((data ?? []) as unknown as AnyRow[])
    .map((r) => {
      const lineRefund = Number(r.refund_sen ?? 0);
      const headerRaw = r.delivery_returns as AnyRow | AnyRow[] | null;
      const headerObj: AnyRow = Array.isArray(headerRaw)
        ? ((headerRaw[0] as AnyRow) ?? {})
        : ((headerRaw as AnyRow) ?? {});
      const headerRefund = Number(headerObj.refund_sen ?? 0);
      const flat = flattenJoin(r, 'delivery_returns');
      flat.line_refund_sen = lineRefund;
      flat.refund_sen_header = headerRefund;
      flat.doc_no = flat.return_number;
      flat.line_date = flat.return_date;
      flat.total_sen = lineRefund;
      const headerStatus = String(flat.status ?? '');
      const settled = headerStatus === 'REFUNDED' || headerStatus === 'CREDIT_NOTED' || headerStatus === 'REJECTED';
      flat.balance_sen = settled ? 0 : headerRefund;
      return flat;
    })
    .filter((r) => {
      const d = (r.return_date ?? r.line_date) as string | null;
      if (dateFrom && (!d || d < dateFrom)) return false;
      if (dateTo   && (!d || d > dateTo))   return false;
      return true;
    });

  return c.json({ rows });
});

// ============================================================================
// GET /reports/fair-report — the exhibition-performance report (owner 2026-07-19).
//
// A read-only report with THREE document-stage views selected by `stage`:
//   stage=so       one row per Sales Order  (booking view)
//   stage=do       one row per Delivery Order (fulfilment view — SO-cost vs DO-cost)
//   stage=invoice  one row per Sales Invoice  (billing view — SO→DO→landed cost)
//
// Every stage anchors on the FAIR = the exhibition PROJECT hard-linked to each SO
// via mfg_sales_orders.project_id (#814 / mig 0146). All filters live on the SO
// header, so DO/Invoice stages resolve the fair by joining their doc back to its
// SO — which also makes "not-yet-delivered / not-yet-invoiced SOs are absent"
// true by construction. CONFIRMED orders only.
//
// PERMISSION (owner-ruled, enforced PER STAGE — see lib/fair-report.fairReportAccess):
//   * ordinary salespeople → 403 on every stage
//   * Sales Director       → stage=so ONLY (403 on do + invoice)
//   * MANAGEMENT           → all stages. management = isFinanceViewer AND NOT a
//     Sales Director = {`*` owner/IT, Super Admin, Finance Manager}. It is NOT
//     canViewScmFinance raw: that cohort INCLUDES the Sales Director, and using
//     it for do/invoice would hand him the two stages the owner reserved.
// No SALESPERSON ROW-SCOPE is applied: the two admitted tiers (management + Sales
// Director) both see ALL sales (canViewAllSales superset), so there is no rep
// whose own+downline rows this could over-expose. A future widening of the gate
// would need to add resolveSalesScopeIds here, exactly as the listings above do.
// ============================================================================

function fairCaller(c: { get(key: 'houzsUser'): Variables['houzsUser'] }): AuthUser | null {
  const hu = c.get('houzsUser');
  if (!hu) return null;
  return { position_name: hu.position_name ?? null, permissions_set: hu.permissions_set } as AuthUser;
}

const FAIR_SO_COLS = `
  doc_no, so_date, ref, venue, venue_id, customer_state, salesperson_id, project_id, branding,
  local_total_sen, total_revenue_sen, deposit_sen,
  mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen, service_sen,
  mattress_sofa_cost_sen, bedframe_cost_sen, accessories_cost_sen, others_cost_sen, service_cost_sen,
  total_cost_sen
`;

type FairSoHeader = {
  doc_no: string;
  so_date: string | null;
  ref: string | null;
  venue: string | null;
  venue_id: string | null;
  customer_state: string | null;
  salesperson_id: string | null;
  project_id: number | null;
  branding: string | null;
  local_total_sen: number | null; total_revenue_sen: number | null; deposit_sen: number | null;
  mattress_sofa_sen: number | null; bedframe_sen: number | null; accessories_sen: number | null; others_sen: number | null; service_sen: number | null;
  mattress_sofa_cost_sen: number | null; bedframe_cost_sen: number | null; accessories_cost_sen: number | null; others_cost_sen: number | null; service_cost_sen: number | null;
  total_cost_sen: number | null;
};

function readFairFilters(c: { req: { query(k: string): string | undefined } }): FairFilters {
  const projectRaw = c.req.query('project');
  const project = projectRaw != null && projectRaw.trim() !== '' && Number.isFinite(Number(projectRaw)) ? Number(projectRaw) : null;
  return {
    venue: c.req.query('venue') ?? null,
    state: c.req.query('state') ?? null,
    project,
    branding: c.req.query('branding') ?? null,
    salesperson: c.req.query('salesperson') ?? null,
    dateFrom: c.req.query('date_from') ?? null,
    dateTo: c.req.query('date_to') ?? null,
    month: c.req.query('month') ?? null,
  };
}

async function fetchFairSos(
  c: any,
  filters: FairFilters,
  docNos?: readonly string[],
): Promise<{ rows: FairSoHeader[]; error?: string }> {
  const sb = c.get('supabase');
  const { from, to } = docNos ? { from: null, to: null } : resolveDateWindow(filters);
  const read = (pFrom: number, pTo: number, batch?: string[]) => {
    /* SCOPE (owner 2026-08-31: 「很多单都没进得来…可能因为我还没 delivered」).
       This read anchored on status='CONFIRMED' alone, so an order LEFT the
       report the moment the floor delivered it: measured on 2990, 34 of 49
       delivery orders were invisible for exactly that reason, and doing more
       business made the report emptier. A fair's completed business is still
       its business — only a DRAFT (not yet a sale) and a CANCELLED order are
       out. */
    let q = sb.from('mfg_sales_orders').select(FAIR_SO_COLS).not('status', 'in', '(DRAFT,CANCELLED)');
    if (filters.project != null) q = q.eq('project_id', filters.project);
    if (filters.venue)       q = q.eq('venue', filters.venue);
    if (filters.state)       q = q.eq('customer_state', filters.state);
    if (filters.salesperson) q = q.eq('salesperson_id', filters.salesperson);
    if (batch) q = q.in('doc_no', batch);
    if (from) q = q.gte('so_date', from);
    if (to)   q = q.lte('so_date', to);
    q = scopeToCompany(q, c);
    q = q.order('so_date', { ascending: false });
    return q.range(pFrom, pTo);
  };
  const { data, error } = docNos
    ? await chunkIn([...docNos], (batch: string[], pFrom: number, pTo: number) => read(pFrom, pTo, batch))
    : await paginateAll((pFrom: number, pTo: number) => read(pFrom, pTo));
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as unknown as FairSoHeader[] };
}

async function stageDocNosInWindow(
  c: FairCtx,
  stage: 'do' | 'invoice',
  from: string | null,
  to: string | null,
): Promise<{ docNos: string[]; error?: string }> {
  const sb = c.get('supabase');
  const out = new Set<string>();
  if (stage === 'invoice') {
    const { data, error } = await paginateAll((pFrom: number, pTo: number) => {
      let q = sb.from('sales_invoices').select('so_doc_no, invoice_date');
      if (from) q = q.gte('invoice_date', from);
      if (to) q = q.lte('invoice_date', to);
      return scopeToCompany(q, c).range(pFrom, pTo);
    });
    if (error) return { docNos: [], error: error.message };
    for (const s of (data ?? []) as Array<{ so_doc_no: string | null }>) if (s.so_doc_no) out.add(s.so_doc_no);
    return { docNos: [...out] };
  }
  const { startUtc, endUtc } = rangeBoundsMy(from, to);
  const byDoDate = await paginateAll((pFrom: number, pTo: number) => {
    let q = sb.from('delivery_orders').select('so_doc_no, do_date, delivered_at');
    if (from) q = q.gte('do_date', from);
    if (to) q = q.lte('do_date', to);
    return scopeToCompany(q, c).range(pFrom, pTo);
  });
  if (byDoDate.error) return { docNos: [], error: byDoDate.error.message };
  const byDelivered = await paginateAll((pFrom: number, pTo: number) => {
    let q = sb.from('delivery_orders').select('so_doc_no, do_date, delivered_at');
    if (startUtc) q = q.gte('delivered_at', startUtc);
    if (endUtc) q = q.lt('delivered_at', endUtc);
    return scopeToCompany(q, c).range(pFrom, pTo);
  });
  if (byDelivered.error) return { docNos: [], error: byDelivered.error.message };
  for (const d of [...(byDoDate.data ?? []), ...(byDelivered.data ?? [])] as Array<{ so_doc_no: string | null; do_date: string | null; delivered_at: string | null }>) {
    if (d.so_doc_no && dayInWindow(doRowDay(d), from, to)) out.add(d.so_doc_no);
  }
  return { docNos: [...out] };
}

const doRowDay = (d: { do_date: string | null; delivered_at: string | null }): string | null => {
  const v = d.delivered_at ?? d.do_date;
  return v ? mytDateOf(v) : null;
};

async function resolveStaffNames(c: any, ids: string[]): Promise<Map<string, string>> {
  const sb = c.get('supabase');
  const out = new Map<string, string>();
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  if (uniq.length === 0) return out;
  const { data } = await chunkIn(uniq, (batch: string[], pFrom: number, pTo: number) =>
    sb.from('staff').select('id, name').in('id', batch).range(pFrom, pTo));
  for (const s of (data ?? []) as Array<{ id: string; name: string | null }>) {
    if (s.id && s.name) out.set(s.id, s.name);
  }
  return out;
}

type ProjectMeta = { name: string | null; start_date: string | null; end_date: string | null };
async function resolveProjects(c: any, ids: number[]): Promise<Map<number, ProjectMeta>> {
  const out = new Map<number, ProjectMeta>();
  const uniq = Array.from(new Set(ids.filter((v) => Number.isFinite(v))));
  if (uniq.length === 0) return out;
  try {
    const placeholders = uniq.map(() => '?').join(',');
    const res = (await c.env.DB.prepare(
      `SELECT id, name, start_date, end_date FROM projects WHERE id IN (${placeholders})`,
    ).bind(...uniq).all()) as { results?: Array<{ id: number; name: string | null; start_date: string | null; end_date: string | null }> };
    for (const p of res.results ?? []) {
      out.set(Number(p.id), { name: p.name ?? null, start_date: p.start_date ?? null, end_date: p.end_date ?? null });
    }
  } catch {
  }
  return out;
}

type FairPaymentRow = PaymentRow & { is_deposit: boolean | null };
async function fetchPaymentsByDoc(c: any, docNos: string[]): Promise<Map<string, FairPaymentRow[]>> {
  const sb = c.get('supabase');
  const byDoc = new Map<string, FairPaymentRow[]>();
  const uniq = Array.from(new Set(docNos.filter(Boolean)));
  if (uniq.length === 0) return byDoc;
  const { data } = await chunkIn(uniq, (batch: string[], pFrom: number, pTo: number) => scopeToCompany(sb
    .from('mfg_sales_order_payments')
    .select('so_doc_no, method, amount_sen, merchant_provider, installment_months, is_deposit')
    .in('so_doc_no', batch), c)
    .range(pFrom, pTo));
  for (const p of (data ?? []) as Array<{ so_doc_no: string; method: string | null; amount_sen: number | null; is_deposit: boolean | null }>) {
    const arr = byDoc.get(p.so_doc_no) ?? [];
    arr.push({ method: p.method, amount_sen: p.amount_sen, is_deposit: p.is_deposit ?? null });
    byDoc.set(p.so_doc_no, arr);
  }
  return byDoc;
}

const joinParts = (parts: Array<string | null | undefined>, sep: string): string | null =>
  parts.map((p) => p?.trim()).filter(Boolean).join(sep) || null;

function fairDims(
  h: FairSoHeader,
  staffNames: Map<string, string>,
  projects: Map<number, ProjectMeta>,
): Record<string, unknown> {
  const proj = h.project_id != null ? projects.get(h.project_id) ?? null : null;
  return {
    venue: h.venue,
    venue_id: h.venue_id,
    state: h.customer_state,
    project_id: h.project_id,
    project: proj?.name ?? null,
    project_start_date: proj?.start_date ?? null,
    project_end_date: proj?.end_date ?? null,
    salesperson_id: h.salesperson_id,
    salesperson: h.salesperson_id ? staffNames.get(h.salesperson_id) ?? null : null,
    branding: h.branding,
  };
}

async function resolveFairRate(c: any, projectId: number): Promise<{ brand: string | null; rate: FairCostRate | null }> {
  try {
    const proj = (await c.env.DB.prepare('SELECT brand FROM projects WHERE id = ?')
      .bind(projectId)
      .first()) as { brand: string | null } | null;
    const brand = fairBrandOf(proj?.brand);
    if (!brand) return { brand: null, rate: null };
    const rate = (await c.env.DB.prepare(`SELECT ${FAIR_RATE_COLS} FROM project_cost_rates WHERE brand = ?`)
      .bind(brand)
      .first()) as FairCostRate | null;
    return { brand, rate: rate ? rateCard(rate) : null };
  } catch {
    return { brand: null, rate: null };
  }
}

const FAIR_RATE_COLS = `transport_pct, merchandise_pct, commission_normal_pct,
              commission_boost_pct, boost_min_gp_pct, boost_min_sales`;
const fairBrandOf = (raw: string | null | undefined): string | null => (raw?.trim() ? raw.trim() : null);
const rateCard = (r: FairCostRate): FairCostRate => ({
  transport_pct: r.transport_pct,
  merchandise_pct: r.merchandise_pct,
  commission_normal_pct: r.commission_normal_pct,
  commission_boost_pct: r.commission_boost_pct,
  boost_min_gp_pct: r.boost_min_gp_pct,
  boost_min_sales: r.boost_min_sales,
});

async function resolveFairRates(c: { env: Pick<Env, 'DB'> }, projectIds: number[]): Promise<Map<number, { brand: string | null; rate: FairCostRate | null }>> {
  const out = new Map<number, { brand: string | null; rate: FairCostRate | null }>();
  const uniq = Array.from(new Set(projectIds.filter((v) => Number.isFinite(v))));
  if (uniq.length === 0) return out;
  try {
    const projRes = await c.env.DB.prepare(
      `SELECT id, brand FROM projects WHERE id IN (${uniq.map(() => '?').join(',')})`,
    ).bind(...uniq).all<{ id: number; brand: string | null }>();
    for (const p of projRes.results) out.set(Number(p.id), { brand: fairBrandOf(p.brand), rate: null });
    const brands = Array.from(new Set([...out.values()].map((f) => f.brand).filter((b): b is string => b != null)));
    if (brands.length > 0) {
      const rateRes = await c.env.DB.prepare(
        `SELECT brand, ${FAIR_RATE_COLS} FROM project_cost_rates WHERE brand IN (${brands.map(() => '?').join(',')})`,
      ).bind(...brands).all<FairCostRate & { brand: string }>();
      const byBrand = new Map(rateRes.results.map((r) => [r.brand, rateCard(r)] as const));
      for (const f of out.values()) f.rate = f.brand ? byBrand.get(f.brand) ?? null : null;
    }
  } catch {
    for (const f of out.values()) f.rate = null;
  }
  return out;
}

type FairCtx = Context<{ Bindings: Env; Variables: Variables }>;

export const fairReportHandler = async (c: FairCtx) => {
  const stage = parseStage(c.req.query('stage'));
  if (!stage) return c.json({ error: 'The `stage` parameter is required and must be one of: so, do, invoice.' }, 400);

  const access = fairReportAccess(stage, fairCaller(c));
  if (!access.allowed) return c.json({ error: access.error }, 403);

  const filters = readFairFilters(c);
  /* How the dates pick the rows (owner 2026-11-03: 「都要」): by the orders' SO
     date (the default), or each stage by its own date — then the Delivery
     Orders and Invoices stages start from their own documents in the window,
     and their orders are read whatever their SO date. */
  const dateBasis = parseDateBasis(c.req.query('date_basis'));
  const window = resolveDateWindow(filters);
  const ownDate = dateBasis === 'stage' && (stage === 'do' || stage === 'invoice') && (window.from != null || window.to != null);
  let stageDocNos: string[] | undefined;
  if (ownDate) {
    const found = await stageDocNosInWindow(c, stage, window.from, window.to);
    if (found.error) return c.json({ error: 'load_failed', reason: found.error }, 500);
    stageDocNos = found.docNos;
  }
  const { rows: soRowsAll, error: soErr } = await fetchFairSos(c, filters, stageDocNos);
  if (soErr) return c.json({ error: 'load_failed', reason: soErr }, 500);

  const sb = c.get('supabase');

  {
    /* "Blank" includes the book's PLACEHOLDER spellings — "NONE" sits on 170
       imported orders and is not a brand (owner 2026-08-31, HC-SO-013402). */
    const blank = soRowsAll.filter((r) => isPlaceholderBrandText(r.branding)).map((r) => r.doc_no);
    if (blank.length > 0) {
      const derived = await deriveDisplayBrandingByDoc(sb, c, blank);
      for (const r of soRowsAll) {
        if (isPlaceholderBrandText(r.branding) && derived.has(r.doc_no)) {
          r.branding = derived.get(r.doc_no)!;
        }
      }
    }
  }
  const wantBrand = (filters.branding ?? '').trim();
  const soRows = wantBrand
    ? soRowsAll.filter((r) => (r.branding ?? '').trim() === wantBrand)
    : soRowsAll;

  const staffNames = await resolveStaffNames(c, soRows.map((r) => r.salesperson_id ?? '').filter(Boolean));
  const projects = await resolveProjects(c, soRows.map((r) => r.project_id).filter((v): v is number => v != null));
  const soByDoc = new Map(soRows.map((r) => [r.doc_no, r] as const));

  const filtersEcho = {
    stage,
    venue: filters.venue ?? null, state: filters.state ?? null, project: filters.project ?? null,
    branding: filters.branding ?? null, salesperson: filters.salesperson ?? null,
    month: filters.month ?? null, date_from: filters.dateFrom ?? null, date_to: filters.dateTo ?? null,
    date_basis: dateBasis,
  };

  if (stage === 'so') {
    const payByDoc = await fetchPaymentsByDoc(c, soRows.map((r) => r.doc_no));
    const rows = soRows.map((h) => {
      const money = fairSoMoney(h);
      const payments = payByDoc.get(h.doc_no) ?? [];
      const paidTotal = soPaidSen(soPaidInputsOf(h as unknown as Record<string, unknown>,
        payments.reduce((s, p) => s + Number(p.amount_sen ?? 0), 0),
        payments.some((p) => p.is_deposit === true)));
      const balanceSen = fairBalanceSen(money.amount_sen, paidTotal);
      const tender = depositByTender(payments);
      const below = belowDeposit({ balanceSen, depositSen: h.deposit_sen, paidSen: paidTotal });
      return {
        ...fairDims(h, staffNames, projects),
        so_date: h.so_date,
        so_no: h.doc_no,
        order_form: h.ref,
        amount_sen: money.amount_sen,
        selling_sen: money.selling_sen,
        service_rev_sen: money.service_rev_sen,
        cost_by_category: money.cost_by_category,
        total_so_cost_sen: money.total_so_cost_sen,
        goods_cost_sen: money.goods_cost_sen,
        margin_pct: money.margin_pct,
        balance_sen: balanceSen,
        paid_total_sen: paidTotal,
        deposit_sen: Number(h.deposit_sen ?? 0),
        payment_methods: paymentMethodsUsed(payments),
        deposit_by_tender: tender,
        below_deposit: below,
      };
    });
    const summary = summarizeSo(rows);
    return c.json({ stage, rows, summary, filters: filtersEcho, meta: { access_tier: access.tier } });
  }

  if (stage === 'pnl') {
    const everyFair = filters.project == null;
    const pnlSos = everyFair ? soRows.filter((r) => r.project_id != null) : soRows;
    const pnlDocNos = pnlSos.map((r) => r.doc_no);

    const doCostBySo = new Map<string, number>();
    if (pnlDocNos.length > 0) {
      const { data: doData, error: doErr } = await chunkIn(pnlDocNos, (batch: string[], pFrom: number, pTo: number) => scopeToCompany(sb
        .from('delivery_orders')
        .select('id, so_doc_no')
        .in('so_doc_no', batch), c)
        .range(pFrom, pTo));
      if (doErr) return c.json({ error: 'load_failed', reason: doErr.message }, 500);
      const dos = (doData ?? []) as Array<{ id: string; so_doc_no: string | null }>;
      const doIdToSo = new Map(dos.map((d) => [d.id, d.so_doc_no] as const));
      const doIds = dos.map((d) => d.id);
      if (doIds.length > 0) {
        const { data: liData, error: liErr } = await chunkIn(doIds, (batch: string[], pFrom: number, pTo: number) => scopeToCompany(sb
          .from('delivery_order_items')
          .select('delivery_order_id, qty, unit_cost_sen, ship_cost_sen, item_group')
          .in('delivery_order_id', batch), c)
          .range(pFrom, pTo));
        if (liErr) return c.json({ error: 'load_failed', reason: liErr.message }, 500);
        const linesByDo = new Map<string, Array<{ qty: number | null; unit_cost_sen: number | null; ship_cost_sen: number | null; item_group: string | null }>>();
        for (const l of (liData ?? []) as Array<{ delivery_order_id: string; qty: number | null; unit_cost_sen: number | null; ship_cost_sen: number | null; item_group: string | null }>) {
          const arr = linesByDo.get(l.delivery_order_id) ?? [];
          arr.push({ qty: l.qty, unit_cost_sen: l.unit_cost_sen, ship_cost_sen: l.ship_cost_sen, item_group: l.item_group });
          linesByDo.set(l.delivery_order_id, arr);
        }
        for (const [doId, lines] of linesByDo) {
          const so = doIdToSo.get(doId);
          if (!so) continue;
          doCostBySo.set(so, (doCostBySo.get(so) ?? 0) + doCostTotal(lines).total_do_cost_sen);
        }
      }
    }

    const siCostBySo = new Map<string, number>();
    if (pnlDocNos.length > 0) {
      const { data: siData, error: siErr } = await chunkIn(pnlDocNos, (batch: string[], pFrom: number, pTo: number) => scopeToCompany(sb
        .from('sales_invoices')
        .select('id, so_doc_no')
        .in('so_doc_no', batch), c)
        .range(pFrom, pTo));
      if (siErr) return c.json({ error: 'load_failed', reason: siErr.message }, 500);
      const sis = (siData ?? []) as Array<{ id: string; so_doc_no: string | null }>;
      const siIdToSo = new Map(sis.map((s) => [s.id, s.so_doc_no] as const));
      const siIds = sis.map((s) => s.id);
      if (siIds.length > 0) {
        const { data: liData, error: liErr } = await chunkIn(siIds, (batch: string[], pFrom: number, pTo: number) => scopeToCompany(sb
          .from('sales_invoice_items')
          .select('sales_invoice_id, qty, unit_cost_sen, line_cost_sen')
          .in('sales_invoice_id', batch), c)
          .range(pFrom, pTo));
        if (liErr) return c.json({ error: 'load_failed', reason: liErr.message }, 500);
        const linesBySi = new Map<string, Array<{ qty: number | null; unit_cost_sen: number | null; line_cost_sen: number | null }>>();
        for (const l of (liData ?? []) as Array<{ sales_invoice_id: string; qty: number | null; unit_cost_sen: number | null; line_cost_sen: number | null }>) {
          const arr = linesBySi.get(l.sales_invoice_id) ?? [];
          arr.push({ qty: l.qty, unit_cost_sen: l.unit_cost_sen, line_cost_sen: l.line_cost_sen });
          linesBySi.set(l.sales_invoice_id, arr);
        }
        for (const [siId, lines] of linesBySi) {
          const so = siIdToSo.get(siId);
          if (!so) continue;
          siCostBySo.set(so, (siCostBySo.get(so) ?? 0) + siCostTotal(lines));
        }
      }
    }

    if (everyFair) {
      const rates = await resolveFairRates(c, pnlSos.map((r) => r.project_id as number));
      const orders = soRows.map((h) => {
        const money = fairSoMoney(h);
        const doCost = doCostBySo.has(h.doc_no) ? (doCostBySo.get(h.doc_no) as number) : null;
        const siCost = siCostBySo.has(h.doc_no) ? (siCostBySo.get(h.doc_no) as number) : null;
        const cost = fairPnlLineCost({
          amount_sen: money.amount_sen, so_cost_sen: money.total_so_cost_sen, do_cost_sen: doCost, si_cost_sen: siCost,
        });
        return {
          project_id: h.project_id,
          venue: h.venue,
          amount_sen: money.amount_sen,
          selling_sen: money.selling_sen,
          service_rev_sen: money.service_rev_sen,
          so_cost_sen: money.total_so_cost_sen,
          do_cost_sen: doCost,
          si_cost_sen: siCost,
          effective_cost_sen: cost.effective_cost_sen,
        };
      });
      const { fairs, no_fair } = everyFairPnl(orders, (id) => {
        const p = projects.get(id);
        const r = rates.get(id);
        return { name: p?.name ?? null, start_date: p?.start_date ?? null, end_date: p?.end_date ?? null, brand: r?.brand ?? null, rate: r?.rate ?? null };
      });
      return c.json({
        stage,
        rows: [],
        summary: summarizeFairPnl([], null),
        fairs,
        no_fair,
        filters: filtersEcho,
        meta: { access_tier: access.tier, needs_project: true, brand: null, rate_present: false, rate: null, fair: null },
      });
    }

    const pickedFair = filters.project as number;
    const { brand, rate } = await resolveFairRate(c, pickedFair);
    const fairMeta = projects.get(pickedFair) ?? (await resolveProjects(c, [pickedFair])).get(pickedFair) ?? null;

    const rows = soRows.map((h) => {
      const money = fairSoMoney(h);
      const doCost = doCostBySo.has(h.doc_no) ? (doCostBySo.get(h.doc_no) as number) : null;
      const siCost = siCostBySo.has(h.doc_no) ? (siCostBySo.get(h.doc_no) as number) : null;
      const cost = fairPnlLineCost({
        amount_sen: money.amount_sen,
        so_cost_sen: money.total_so_cost_sen,
        do_cost_sen: doCost,
        si_cost_sen: siCost,
      });
      return {
        ...fairDims(h, staffNames, projects),
        so_date: h.so_date,
        so_no: h.doc_no,
        order_form: h.ref,
        revenue_sen: money.amount_sen,
        product_rev_sen: money.selling_sen,
        service_rev_sen: money.service_rev_sen,
        so_cost_sen: money.total_so_cost_sen,
        do_cost_sen: doCost,
        si_cost_sen: siCost,
        effective_cost_sen: cost.effective_cost_sen,
        effective_cost_stage: cost.effective_cost_stage,
        gross_profit_sen: cost.gross_profit_sen,
        margin_pct: cost.margin_pct,
      };
    });

    const summaryRows: FairPnlSummaryRow[] = rows.map((r) => ({
      amount_sen: r.revenue_sen,
      selling_sen: r.product_rev_sen,
      service_rev_sen: r.service_rev_sen,
      so_cost_sen: r.so_cost_sen,
      do_cost_sen: r.do_cost_sen,
      si_cost_sen: r.si_cost_sen,
      effective_cost_sen: r.effective_cost_sen,
    }));
    const summary = summarizeFairPnl(summaryRows, rate);
    return c.json({
      stage,
      rows,
      summary,
      filters: filtersEcho,
      meta: {
        access_tier: access.tier, needs_project: false, brand, rate_present: rate != null,
        rate,
        fair: fairMeta
          ? { project_id: pickedFair, project: fairMeta.name, project_start_date: fairMeta.start_date, project_end_date: fairMeta.end_date }
          : null,
      },
    });
  }

  const docNos = soRows.map((r) => r.doc_no);
  if (docNos.length === 0) {
    const summary = stage === 'do' ? summarizeDo([]) : summarizeInvoice([]);
    return c.json({ stage, rows: [], summary, filters: filtersEcho, meta: { access_tier: access.tier } });
  }

  if (stage === 'do') {
    const { data: doData, error: doErr } = await chunkIn(docNos, (batch: string[], pFrom: number, pTo: number) => scopeToCompany(sb
      .from('delivery_orders')
      .select('id, do_number, so_doc_no, do_date, delivered_at, status, address1, address2, city, postcode, state, warehouse_id, sales_location')
      .in('so_doc_no', batch), c)
      .range(pFrom, pTo));
    if (doErr) return c.json({ error: 'load_failed', reason: doErr.message }, 500);
    const doDocs = (doData ?? []) as Array<{
      id: string; do_number: string; so_doc_no: string | null; do_date: string | null; delivered_at: string | null; status: string | null;
      address1: string | null; address2: string | null; city: string | null; postcode: string | null; state: string | null;
      warehouse_id: string | null; sales_location: string | null;
    }>;
    const dos = ownDate ? doDocs.filter((d) => dayInWindow(doRowDay(d), window.from, window.to)) : doDocs;

    const whById = new Map<string, { code: string | null; name: string | null }>();
    const whIds = [...new Set(dos.map((d) => d.warehouse_id).filter((x): x is string => !!x))];
    if (whIds.length > 0) {
      const { data: whData, error: whErr } = await chunkIn(whIds, (batch: string[], pFrom: number, pTo: number) => sb
        .from('warehouses')
        .select('id, code, name')
        .in('id', batch)
        .range(pFrom, pTo));
      if (whErr) return c.json({ error: 'load_failed', reason: whErr.message }, 500);
      for (const w of whData as Array<{ id: string; code: string | null; name: string | null }>) whById.set(w.id, w);
    }

    const linesByDo = new Map<string, DoCostLine[]>();
    const doIds = dos.map((d) => d.id);
    if (doIds.length > 0) {
      const { data: liData, error: liErr } = await chunkIn(doIds, (batch: string[], pFrom: number, pTo: number) => scopeToCompany(sb
        .from('delivery_order_items')
        .select('delivery_order_id, qty, unit_cost_sen, ship_cost_sen, item_group, item_code')
        .in('delivery_order_id', batch), c)
        .range(pFrom, pTo));
      if (liErr) return c.json({ error: 'load_failed', reason: liErr.message }, 500);
      for (const l of (liData ?? []) as Array<DoCostLine & { delivery_order_id: string }>) {
        const arr = linesByDo.get(l.delivery_order_id) ?? [];
        arr.push({ qty: l.qty, unit_cost_sen: l.unit_cost_sen, ship_cost_sen: l.ship_cost_sen, item_group: l.item_group, item_code: l.item_code });
        linesByDo.set(l.delivery_order_id, arr);
      }
    }

    const rows = dos.map((d) => {
      const h = d.so_doc_no ? soByDoc.get(d.so_doc_no) : undefined;
      const money = h ? fairSoMoney(h) : null;
      const doCost = doCostTotal(linesByDo.get(d.id) ?? []);
      const totalSoCost = Number(h?.total_cost_sen ?? 0);
      const costDelta = doCost.total_do_cost_sen - totalSoCost;
      return {
        ...(h ? fairDims(h, staffNames, projects) : {}),
        delivery_date: d.delivered_at ?? d.do_date,
        do_no: d.do_number,
        so_no: d.so_doc_no,
        status: d.status,
        location: bookSpellingOrOwn(
          warehouseLabel(d.warehouse_id ? whById.get(d.warehouse_id) : null) ?? d.sales_location, LOCATION_MAP),
        delivery_location: joinParts([d.city, d.state], ', '),
        delivery_address: joinParts([d.address1, d.address2, joinParts([d.postcode, d.city], ' '), d.state], ', '),
        qty: doCost.qty,
        so_amount_sen: money ? money.amount_sen : null,
        total_so_cost_sen: totalSoCost,
        total_do_cost_sen: doCost.total_do_cost_sen,
        do_cost_is_legacy: doCost.is_legacy,
        do_cost_ship_anyway: doCost.has_zero_frozen,
        cost_delta_sen: costDelta,
        so_margin_pct: money ? money.margin_pct : null,
        do_margin_pct: money ? marginPct(money.selling_sen, doCost.goods_do_cost_sen) : null,
      };
    });
    const summary = summarizeDo(rows);
    return c.json({ stage, rows, summary, filters: filtersEcho, meta: { access_tier: access.tier } });
  }

  const { data: siData, error: siErr } = await chunkIn(docNos, (batch: string[], pFrom: number, pTo: number) => scopeToCompany(sb
    .from('sales_invoices')
    .select('id, invoice_number, so_doc_no, delivery_order_id, invoice_date, total_sen, status')
    .in('so_doc_no', batch), c)
    .range(pFrom, pTo));
  if (siErr) return c.json({ error: 'load_failed', reason: siErr.message }, 500);
  const siDocs = (siData ?? []) as Array<{ id: string; invoice_number: string; so_doc_no: string | null; delivery_order_id: string | null; invoice_date: string | null; total_sen: number | null; status: string | null }>;
  const sis = ownDate ? siDocs.filter((s) => dayInWindow(s.invoice_date ? s.invoice_date.slice(0, 10) : null, window.from, window.to)) : siDocs;

  const siLinesById = new Map<string, SiGoodsLine[]>();
  const siIds = sis.map((s) => s.id);
  if (siIds.length > 0) {
    const { data: liData, error: liErr } = await chunkIn(siIds, (batch: string[], pFrom: number, pTo: number) => scopeToCompany(sb
      .from('sales_invoice_items')
      .select('sales_invoice_id, qty, unit_cost_sen, line_cost_sen, line_total_sen, item_group, item_code')
      .in('sales_invoice_id', batch), c)
      .range(pFrom, pTo));
    if (liErr) return c.json({ error: 'load_failed', reason: liErr.message }, 500);
    for (const l of (liData ?? []) as Array<SiGoodsLine & { sales_invoice_id: string }>) {
      const arr = siLinesById.get(l.sales_invoice_id) ?? [];
      arr.push({
        qty: l.qty, unit_cost_sen: l.unit_cost_sen, line_cost_sen: l.line_cost_sen,
        line_total_sen: l.line_total_sen, item_group: l.item_group, item_code: l.item_code,
      });
      siLinesById.set(l.sales_invoice_id, arr);
    }
  }

  const linkedDoIds = Array.from(new Set(sis.map((s) => s.delivery_order_id).filter((v): v is string => Boolean(v))));
  const doCostById = new Map<string, number>();
  if (linkedDoIds.length > 0) {
    const { data: liData } = await chunkIn(linkedDoIds, (batch: string[], pFrom: number, pTo: number) => scopeToCompany(sb
      .from('delivery_order_items')
      .select('delivery_order_id, qty, unit_cost_sen, ship_cost_sen')
      .in('delivery_order_id', batch), c)
      .range(pFrom, pTo));
    const byDo = new Map<string, Array<{ qty: number | null; unit_cost_sen: number | null; ship_cost_sen: number | null }>>();
    for (const l of (liData ?? []) as Array<{ delivery_order_id: string; qty: number | null; unit_cost_sen: number | null; ship_cost_sen: number | null }>) {
      const arr = byDo.get(l.delivery_order_id) ?? [];
      arr.push({ qty: l.qty, unit_cost_sen: l.unit_cost_sen, ship_cost_sen: l.ship_cost_sen });
      byDo.set(l.delivery_order_id, arr);
    }
    for (const [id, lines] of byDo) doCostById.set(id, doCostTotal(lines).total_do_cost_sen);
  }

  const rows = sis.map((s) => {
    const h = s.so_doc_no ? soByDoc.get(s.so_doc_no) : undefined;
    const invoiced = Number(s.total_sen ?? 0);
    const soCost = Number(h?.total_cost_sen ?? 0);
    const doCost = s.delivery_order_id ? doCostById.get(s.delivery_order_id) ?? 0 : 0;
    const siLines = siLinesById.get(s.id) ?? [];
    const siCost = siCostTotal(siLines);
    const goods = siGoodsTotals(siLines);
    return {
      ...(h ? fairDims(h, staffNames, projects) : {}),
      invoice_date: s.invoice_date,
      inv_no: s.invoice_number,
      so_no: s.so_doc_no,
      do_id: s.delivery_order_id,
      status: s.status,
      invoiced_sen: invoiced,
      so_cost_sen: soCost,
      do_cost_sen: doCost,
      si_cost_sen: siCost,
      goods_invoiced_sen: goods.goods_invoiced_sen,
      goods_si_cost_sen: goods.goods_cost_sen,
      margin_pct: marginPct(goods.goods_invoiced_sen, goods.goods_cost_sen),
    };
  });
  const summary = summarizeInvoice(rows);
  return c.json({ stage, rows, summary, filters: filtersEcho, meta: { access_tier: access.tier } });
};
reports.get('/fair-report', fairReportHandler);

export const fairReportDetailHandler = async (c: FairCtx) => {
  const access = fairReportAccess('so', fairCaller(c));
  if (!access.allowed) return c.json({ error: access.error }, 403);

  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');

  const { data: headerData, error: hErr } = await scopeToCompany(sb
    .from('mfg_sales_orders').select(FAIR_SO_COLS).eq('doc_no', docNo), c).maybeSingle();
  if (hErr) return c.json({ error: 'load_failed', reason: hErr.message }, 500);
  if (!headerData) return c.json({ error: 'Sales Order not found.' }, 404);
  const h = headerData as unknown as FairSoHeader;

  if (!h.branding || !String(h.branding).trim()) {
    const derived = await deriveDisplayBrandingByDoc(sb, c, [h.doc_no]);
    h.branding = derived.get(h.doc_no) ?? h.branding;
  }

  const staffNames = await resolveStaffNames(c, h.salesperson_id ? [h.salesperson_id] : []);
  const projects = await resolveProjects(c, h.project_id != null ? [h.project_id] : []);

  const { data: itemData, error: iErr } = await paginateAll((pFrom: number, pTo: number) => scopeToCompany(sb
    .from('mfg_sales_order_items')
    // item_group + variants + description2 carry the VARIANT summary so the
    // Fair Report's "Order lines · selling & cost" line reads the same
    // "code / SEAT / LEG / fabric" subtitle every other order-line surface shows
    // (owner 2026-07-24: the variant must appear consistently system-wide).
    .select('item_group, item_code, description, description2, variants, qty, unit_price_sen, total_sen, unit_cost_sen, line_cost_sen, cancelled')
    .eq('doc_no', docNo), c)
    .range(pFrom, pTo));
  if (iErr) return c.json({ error: 'load_failed', reason: iErr.message }, 500);
  const lines = ((itemData ?? []) as Array<Record<string, unknown>>).map((r) => ({
    item_group: r.item_group, item_code: r.item_code, description: r.description,
    description2: r.description2, variants: r.variants, qty: r.qty,
    unit_price_sen: r.unit_price_sen, amount_sen: r.total_sen,
    unit_cost_sen: r.unit_cost_sen, line_cost_sen: r.line_cost_sen,
    cancelled: r.cancelled,
  }));
  await enrichLinesWithFabricSupplierCode(sb, c, lines);

  const { data: payData, error: pErr } = await paginateAll((pFrom: number, pTo: number) => scopeToCompany(sb
    .from('mfg_sales_order_payments')
    .select('method, amount_sen, merchant_provider, installment_months, approval_code, paid_at, is_deposit')
    .eq('so_doc_no', docNo), c)
    .range(pFrom, pTo));
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  const payments = (payData ?? []) as Array<{ method: string | null; amount_sen: number | null; merchant_provider: string | null; installment_months: number | null; approval_code: string | null; paid_at: string | null; is_deposit: boolean | null }>;
  const paidTotal = soPaidSen(soPaidInputsOf(h as unknown as Record<string, unknown>,
    payments.reduce((s, p) => s + Number(p.amount_sen ?? 0), 0),
    payments.some((p) => p.is_deposit === true)));
  const money = fairSoMoney(h);
  const balanceSen = fairBalanceSen(money.amount_sen, paidTotal);

  const { data: doData } = await scopeToCompany(sb
    .from('delivery_orders').select('do_number').eq('so_doc_no', docNo), c);
  const { data: siData } = await scopeToCompany(sb
    .from('sales_invoices').select('invoice_number').eq('so_doc_no', docNo), c);

  return c.json({
    ...fairDims(h, staffNames, projects),
    so_no: h.doc_no,
    order_form: h.ref,
    so_date: h.so_date,
    amount_sen: money.amount_sen,
    selling_sen: money.selling_sen,
    service_rev_sen: money.service_rev_sen,
    cost_by_category: money.cost_by_category,
    total_so_cost_sen: money.total_so_cost_sen,
    margin_pct: money.margin_pct,
    balance_sen: balanceSen,
    deposit_sen: Number(h.deposit_sen ?? 0),
    paid_total_sen: paidTotal,
    below_deposit: belowDeposit({ balanceSen, depositSen: h.deposit_sen, paidSen: paidTotal }),
    payment_methods: paymentMethodsUsed(payments),
    deposit_by_tender: depositByTender(payments),
    payments: payments.map((p) => ({
      tender: p.method, amount_sen: p.amount_sen, merchant_provider: p.merchant_provider,
      installment_months: p.installment_months, approval_code: p.approval_code, paid_at: p.paid_at, is_deposit: p.is_deposit,
    })),
    lines,
    linkage: {
      so_no: h.doc_no,
      do_nos: ((doData ?? []) as Array<{ do_number: string }>).map((d) => d.do_number),
      invoice_nos: ((siData ?? []) as Array<{ invoice_number: string }>).map((s) => s.invoice_number),
    },
    meta: { access_tier: access.tier },
  });
};
reports.get('/fair-report/:docNo', fairReportDetailHandler);
