// ----------------------------------------------------------------------------
// /reports — read-only reporting endpoints (AutoCount-style listings).
//
// Ported from 2990's apps/api/src/routes/reports.ts. Serves the four
// AutoCount-style "Detail Listing" reads the vendored report pages render:
//   GET /reports/sales-order-detail-listing
//   GET /reports/delivery-order-detail-listing
//   GET /reports/sales-invoice-detail-listing
//   GET /reports/delivery-return-detail-listing
// (the vendored authedFetch base prepends /api/scm).
//
// One row per LINE ITEM, with the parent document header denormalised onto
// each row. The client decides which AutoCount columns to render.
//
// Houzs adaptation: same plumbing as the sibling SCM routes — supabaseAuth
// bridge + scm-scoped service client via c.get('supabase'); every table ref
// already resolves against the `scm` schema (mfg_sales_orders / *_items /
// mfg_sales_order_payments / staff / delivery_orders / *_items / sales_invoices
// / *_items / delivery_returns / *_items — all confirmed present in
// scripts/scm-schema/2990s-full-schema.sql). Read-only: this route never
// writes. Mounted at '/reports' in scm/index.ts.
//
// ── THESE LISTINGS ARE SALES DOCUMENTS, NOT NEUTRAL LOOKUPS (fix/c1-reports) ─
// The mount comment in scm/index.ts calls the shared read helpers "read-mostly
// and not sensitive" and leaves them on the coarse scm.access gate. That is
// true of document-flow / outstanding / staff. It was NEVER true here: this
// file returns the SO book line by line. Being read-only does not make a
// payload safe — WHAT it reads is the question. Two rules therefore apply to
// every sales-doc listing below, and a report must never be a way around the
// rule its own module enforces:
//   1. FINANCE — cost / margin / deposit reach only canViewScmFinance (fails
//      closed). Mirrors gateSoFinance (#625) / gateDrFinance (#632); the key
//      lists are SHARED from lib/finance-keys.ts, not re-declared here.
//   2. SCOPE — rows are row-scoped to the caller's own + downline salespeople
//      via resolveSalesScopeIds, the same source of truth the SO / DO / SI list
//      handlers use. Without it a scoped rep read every other rep's documents
//      through the report while being correctly blocked on the module page.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { scopeToCompany, activeCompanyId } from '../lib/companyScope';
import { stampOrderDeposit } from '../lib/si-list-stamps';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { deriveDisplayBrandingByDoc } from '../lib/so-display-branding';
import { isPlaceholderBrandText } from '../shared/so-branding-label';
import { canViewAllSales, canViewScmFinance } from '../lib/houzs-perms';
import { salesJdDenial } from '../../services/salesJdAccess';
import { resolveSalesScopeIds } from '../lib/salesScope';
import { SO_FINANCE_KEYS, SO_ITEM_FINANCE_KEYS } from '../lib/finance-keys';
import { soPaidSen, soPaidInputsOf } from '../shared/so-outstanding';
import {
  parseStage, fairReportAccess, fairSoMoney, depositByTender, paymentMethodsUsed,
  belowDeposit, fairBalanceSen, doCostTotal, siCostTotal, marginPct, resolveDateWindow,
  summarizeSo, summarizeDo, summarizeInvoice,
  fairPnlLineCost, summarizeFairPnl,
  type FairStage, type FairFilters, type PaymentRow, type FairCostRate, type FairPnlSummaryRow,
} from '../lib/fair-report';
import type { AuthUser } from '../../services/auth';

/* Strip cost / margin / deposit from every FLAT report row for a non-finance
   caller. The listing denormalises the SO header onto each line, so one row
   carries BOTH halves of the vocabulary — strip both from the same object.
   canViewScmFinance fails closed (no houzsUser / no director position → not
   finance), so a mis-classified caller loses the columns rather than gaining
   them. Applied AFTER the flatten, so no header key can slip through under its
   own name. */
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

  /* Row-level visibility scope — the SAME rule and the SAME source of truth as
     the SO list handler (lib/salesScope): view-all callers (`scm.so.view_all`
     or a director position via canViewAllSales) are unrestricted; everyone else
     sees SELF + their full manager_id downline. Resolved ONCE, outside the
     pager, so every page of a wide date range uses one scope.
     NOTE: must pass the REAL Houzs integer user id (houzsUser) — user.id here
     is the bridge's pinned system staff uuid, and feeding that to the scope
     lookup is the documented non-admin 500. */
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  // Pull SO header + items as nested join. supabase-js renders the nested
  // table as a property on the item row — we flatten it back out below so
  // the client doesn't need to traverse mfg_sales_orders.*.
  // PostgREST's 1000-row cap silently truncated this listing — page through so
  // a wide date range returns every line, not just the first 1000.
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
    /* salesperson_id lives on the HEADER — filter the EMBEDDED table. The
       `!inner` join makes an embedded filter narrow the parent rows (same
       mechanism the DO/SI listings below already use for docNo/debtorCode). */
    if (scopeIds) q = q.in('mfg_sales_orders.salesperson_id', scopeIds);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    // Sort: line-level for item_code, header-level (joined) for date/doc_no.
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
    // Supabase's foreign-table join can return either a single object or an
    // array — both shapes are normalised in the flatten pass below.
    mfg_sales_orders: Record<string, unknown> | Record<string, unknown>[] | null;
    line_date: string | null;
    doc_no: string;
    variants:             Record<string, unknown> | null;
    divan_height_inches:  number | null;
    leg_height_inches:    number | null;
    custom_specials:      unknown;
  };
  const itemsRaw = (data ?? []) as unknown as ItemRow[];

  // paid_sen is derived live from the mfg_sales_order_payments ledger.
  // Aggregate once for all docs in this result and attach as paid_total_sen.
  // Also capture per-doc: last_payment_at (MAX paid_at) + the most-recent
  // payment's account_sheet / approval_code / collected_by. collected_by is a
  // staff.id uuid, so resolve once via a second batch query to staff.
  const docNos = Array.from(new Set(itemsRaw.map((i) => i.doc_no))).filter(Boolean);
  const paidByDoc = new Map<string, number>();
  type PaymentMeta = {
    lastPaidAt: string | null;
    accountSheet: string | null;
    approvalCode: string | null;
    collectedById: string | null;
  };
  const paymentMetaByDoc = new Map<string, PaymentMeta>();
  // The Approval Code column aggregates EVERY ledger code (a doc can be paid
  // in multiple instalments, each with its own code).
  const approvalCodesByDoc = new Map<string, Array<{ paidAt: string | null; code: string }>>();
  if (docNos.length > 0) {
    // chunkIn — docNos can exceed 1000 (un-truncated listing) and a doc can have
    // many instalment payments; batch the .in() and page each batch so the
    // paid totals are never UNDERSTATED (which would overstate outstanding).
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
      // "Most recent" = max paid_at; on tie keep first seen. Null paid_at
      // sorts older than any real date.
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

  // Resolve collected_by uuids → staff.name in a single batch query so
  // each row can display a human-readable collector name.
  const collectorIds = Array.from(new Set(
    [...paymentMetaByDoc.values()].map((m) => m.collectedById).filter((v): v is string => Boolean(v))
  ));
  const staffNameById = new Map<string, string>();
  if (collectorIds.length > 0) {
    // chunkIn — bound the collector-name resolve so the .in() list never exceeds
    // 1000 and PostgREST's cap can't drop names (unresolved collector → blank).
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

  // Flatten the join + apply the header-level date range filters in JS
  // (supabase-js can't .gte() across a joined table without rpc).
  const rows = itemsRaw
    .map((r) => {
      // Supabase returns the joined header as either a single object or
      // a one-element array depending on selection — normalise to single.
      const rawHeader = r.mfg_sales_orders;
      const h: Record<string, unknown> = Array.isArray(rawHeader)
        ? ((rawHeader[0] as Record<string, unknown>) ?? {})
        : ((rawHeader as Record<string, unknown>) ?? {});
      const flat: Record<string, unknown> = { ...r };
      delete flat.mfg_sales_orders;
      // Header fields fill any line field that's empty (debtor_code, agent, etc.).
      for (const [k, v] of Object.entries(h)) {
        if (k in flat && flat[k] != null && flat[k] !== '') continue;
        flat[k] = v;
      }
      // Always expose so_date + currency + status under canonical names too.
      flat.so_date  = h.so_date  ?? flat.so_date  ?? flat.line_date ?? null;
      flat.currency = h.currency ?? 'MYR';
      flat.status   = h.status   ?? null;
      flat.customer_delivery_date = h.customer_delivery_date ?? null;
      // Per-doc paid total from the payments ledger (replaces legacy paid_sen).
      flat.paid_total_sen = paidByDoc.get(r.doc_no) ?? 0;
      /* Light the Fabric / Divan / Leg columns from what SO lines ACTUALLY
         carry. Fabric: three sources, most specific first — fabricColor
         (GRN hand-keyed) ?? colourLabel (POS human label) ?? fabricCode (the
         shared code). Divan/Leg: real column (GRN paths) ?? the variants the
         SO paths write — legHeight / sofaLegHeight / divanHeight. Values can
         be strings ('4"', 'No Leg'): normalise to a NUMBER when parseable
         (frontend renders n″ + numeric sort) else pass the raw string. */
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
          return m && m[1] ? Number(m[1]) : raw; // '4"' → 4; 'No Leg' → as-is
        }
        return null;
      };
      flat.divan_height = heightVal(r.divan_height_inches, 'divanHeight');
      flat.leg_height   = heightVal(r.leg_height_inches, 'legHeight', 'sofaLegHeight');
      // Per-doc payment meta (last receipt only).
      const pm = paymentMetaByDoc.get(r.doc_no);
      flat.last_payment_at = pm?.lastPaidAt   ?? null;
      flat.account_sheet   = pm?.accountSheet ?? null;
      /* ALL approval codes, oldest→newest, plus a count when there are several
         ("123123 + 456456 (2)"). Header-level code covers legacy single-shot
         SOs with no ledger rows. */
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

  /* Cost / margin / deposit leave the server ONLY for a finance-viewer. This
     listing is the widest finance surface in the app — every line of every
     salesperson's every order — and it carried no gate at all. Revenue, order
     totals, balance and the paid ledger stay for everyone who passes access. */
  gateReportFinance(c, rows);

  return c.json({ rows });
});

// ----------------------------------------------------------------------------
// L2 line-level Detail Listings for Delivery Order / Sales Invoice / Delivery
// Return. Same shape as /sales-order-detail-listing: flatten the header onto
// every line, apply filter params, return { rows: [...] }.
//
//   DO  : delivery_order_items     joined with delivery_orders
//   SI  : sales_invoice_items      joined with sales_invoices
//   DR  : delivery_return_items    joined with delivery_returns
//
// Delivery Return has a `refund_sen` instead of revenue — surfaced as
// `total_sen` so the column reuse is straightforward.
//
// FINANCE: none of these three SELECT a cost or margin column (DO/SI carry
// unit_price/discount/tax/line_total, DR carries unit_price/refund) — all
// selling-side money the customer's own document shows them. Audited row by row
// against lib/finance-keys.ts; no strip is needed. Add one the moment a cost
// column joins a SELECT here.
//
// SCOPE: DO + SI ARE row-scoped below, because delivery-orders-mfg.ts and
// sales-invoices.ts row-scope their own list handlers — leaving the report open
// would let a rep read through the report exactly what the module page denies
// them. DR is deliberately NOT scoped: delivery-returns.ts does not row-scope
// its own list either, so scoping only the report would invent a rule the DR
// module does not have. That module-level gap is real and flagged in
// BUG-HISTORY (fix/c1-reports) rather than half-fixed here.
//   DR UPDATE (feat/dead-cells-and-returns, 2026-07-17): the Sales cohort is now
//   DENIED this listing outright (salesJdDenial — the owner's returns rule, which
//   /delivery-returns/* enforces at its mount and this router could not). That is
//   a COHORT gate, not a row scope: the "who may open the DR module at all"
//   question, answered the same way in both places. It does NOT close the scoping
//   gap above — a non-Sales caller with scm.access still reads every DR row here,
//   exactly as they read every DR row on the module page. Still one gap, still
//   flagged, still not half-fixed.
// ----------------------------------------------------------------------------

type AnyRow = Record<string, unknown>;

const flattenJoin = (item: AnyRow, headerKey: string): AnyRow => {
  const rawHeader = item[headerKey];
  const h: AnyRow = Array.isArray(rawHeader)
    ? ((rawHeader[0] as AnyRow) ?? {})
    : ((rawHeader as AnyRow) ?? {});
  const flat: AnyRow = { ...item };
  delete flat[headerKey];
  // Item columns win over header columns when both exist (line-level
  // debtor_code etc.); fall through to header values otherwise.
  for (const [k, v] of Object.entries(h)) {
    if (k in flat && flat[k] != null && flat[k] !== '') continue;
    flat[k] = v;
  }
  return flat;
};

/* ── Delivery Order Detail Listing ──────────────────────────────────── */
reports.get('/delivery-order-detail-listing', async (c) => {
  const sb = c.get('supabase');
  const dateFrom    = c.req.query('dateFrom');
  const dateTo      = c.req.query('dateTo');
  const docNo       = c.req.query('docNo');
  const debtorCode  = c.req.query('debtorCode');
  const itemCode    = c.req.query('itemCode');

  /* Same own+downline scope the DO list handler applies (delivery-orders-mfg.ts
     `.in('salesperson_id', scopeIds)`); resolved once, outside the pager. */
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  // PostgREST's 1000-row cap silently truncated this listing — page through.
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
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    return q.range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const rows = ((data ?? []) as unknown as AnyRow[])
    .map((r) => {
      const flat = flattenJoin(r, 'delivery_orders');
      // Normalise common field names used by the L2 page.
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

  return c.json({ rows });
});

/* ── Sales Invoice Detail Listing ───────────────────────────────────── */
reports.get('/sales-invoice-detail-listing', async (c) => {
  const sb = c.get('supabase');
  const dateFrom    = c.req.query('dateFrom');
  const dateTo      = c.req.query('dateTo');
  const docNo       = c.req.query('docNo');
  const debtorCode  = c.req.query('debtorCode');
  const itemCode    = c.req.query('itemCode');

  /* Same own+downline scope the SI list handler applies (sales-invoices.ts
     `.in('salesperson_id', scopeIds)`); resolved once, outside the pager. */
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  // PostgREST's 1000-row cap silently truncated this listing — page through.
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
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    return q.range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  /* The deposit taken on the source SALES ORDER settles part of this invoice
     (scm/lib/si-order-deposit). Resolved ONCE per distinct invoice — the join
     above returns one row per LINE, so stamping per row would re-read the same
     orders dozens of times — then subtracted from `balance_sen` below. Same
     function the invoice list uses, so the report and the screen cannot drift.
     A failed stamp leaves the slice at 0 and the balance UN-adjusted, which is
     the only direction a report of what is owed may be wrong in. */
  const depositByInvoice = new Map<string, number>();
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
    for (const st of stubs) depositByInvoice.set(String(st.id), Number(st.so_deposit_applied_sen ?? 0));
  }

  const rows = ((data ?? []) as unknown as AnyRow[])
    .map((r) => {
      // Capture header totals before flatten — line items have their own
      // discount_sen / tax_sen, and the LINE values win in flatten, so the
      // header values must be snapshotted up front for the outstanding calc.
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
      // Use the LINE total, not the header total, for revenue column on L2.
      flat.total_sen = flat.line_total_sen ?? 0;
      // Outstanding = header total − header paid (per doc, repeated per line).
      flat.header_total_sen    = headerTotal;
      flat.header_paid_sen     = headerPaid;
      flat.header_discount_sen = headerDiscount;
      flat.header_tax_sen      = headerTax;
      const headerDeposit = depositByInvoice.get(String(headerObj.id ?? '')) ?? 0;
      flat.so_deposit_applied_sen = headerDeposit;
      flat.balance_sen = Math.max(headerTotal - headerPaid - headerDeposit, 0);
      return flat;
    })
    .filter((r) => {
      const d = (r.invoice_date ?? r.line_date) as string | null;
      if (dateFrom && (!d || d < dateFrom)) return false;
      if (dateTo   && (!d || d > dateTo))   return false;
      return true;
    });

  return c.json({ rows });
});

/* ── Delivery Return Detail Listing ────────────────────────────────── */
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

  // PostgREST's 1000-row cap silently truncated this listing — page through.
  const { data, error } = await paginateAll((pFrom, pTo) => {
    let q = sb
      .from('delivery_return_items')
      .select(`
        id, delivery_return_id, do_item_id, item_code, description,
        qty_returned, condition, unit_price_sen, refund_sen, notes, created_at,
        delivery_returns!inner (
          id, return_number, delivery_order_id, sales_invoice_id, debtor_code,
          debtor_name, return_date, reason, status, refund_sen,
          received_at, inspected_at, refunded_at, inspection_notes, notes
        )
      `);
    if (docNo)      q = q.ilike('delivery_returns.return_number', `%${docNo}%`);
    if (itemCode)   q = q.ilike('item_code', `%${itemCode}%`);
    if (debtorCode) q = q.eq('delivery_returns.debtor_code', debtorCode);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    return q.range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const rows = ((data ?? []) as unknown as AnyRow[])
    .map((r) => {
      // Both line and header have refund_sen. Capture each explicitly
      // before flattenJoin's "line wins" rule discards the header value.
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
      // "Outstanding" for a return = pending payout (status not yet REFUNDED
      // / CREDIT_NOTED / REJECTED).
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

/* Build the AuthUser-shaped caller the gate reads, from the REAL Houzs user the
   bridge stashed (the scm `user` context is the pinned system staff row with no
   position). Only position_name + permissions_set are read by the gate. */
function fairCaller(c: { get(key: 'houzsUser'): Variables['houzsUser'] }): AuthUser | null {
  const hu = c.get('houzsUser');
  if (!hu) return null;
  return { position_name: hu.position_name ?? null, permissions_set: hu.permissions_set } as AuthUser;
}

/* The SO-header columns every stage needs — fair dims + the money split. */
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

/* Read the `stage` + shared filter query params off the request. */
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

/* Fetch the CONFIRMED SOs of a fair matching the filters. The single source of
   truth for "which orders are in scope" — all three stages start here. */
async function fetchFairSos(
  c: any,
  filters: FairFilters,
): Promise<{ rows: FairSoHeader[]; error?: string }> {
  const sb = c.get('supabase');
  const { from, to } = resolveDateWindow(filters);
  const { data, error } = await paginateAll((pFrom: number, pTo: number) => {
    /* SCOPE (owner 2026-08-31: 「很多单都没进得来…可能因为我还没 delivered」).
       This read anchored on status='CONFIRMED' alone, so an order LEFT the
       report the moment the floor delivered it: measured on 2990, 34 of 49
       delivery orders were invisible for exactly that reason, and doing more
       business made the report emptier. A fair's completed business is still
       its business — only a DRAFT (not yet a sale) and a CANCELLED order are
       out. */
    let q = sb.from('mfg_sales_orders').select(FAIR_SO_COLS).not('status', 'in', '(DRAFT,CANCELLED)');
    if (filters.project != null) q = q.eq('project_id', filters.project);
    /* Filter by the venue TEXT, not venue_id. mfg_sales_orders.venue_id is a UUID
       FK to the empty/unused scm.venues; the SO write path NULLs it for every
       venue picked from public.project_venues (the modern New-SO path) and keeps
       only the `venue` TEXT column, which routes/mfg-sales-orders.ts documents as
       "the source of truth for the venue". So an eq on venue_id matched almost
       nothing and the Venue dropdown built off it was always empty (BUG-HISTORY
       2026-07-24). Match STATE/BRANDING: the dropdown lists distinct venue TEXT
       and filters on it. */
    if (filters.venue)       q = q.eq('venue', filters.venue);
    if (filters.state)       q = q.eq('customer_state', filters.state);
    /* NO branding predicate here: header branding is blank on nearly every SO
       (the create form has no branding field), so an eq matched nothing. The
       handler derives display branding after this fetch and filters there. */
    if (filters.salesperson) q = q.eq('salesperson_id', filters.salesperson);
    if (from) q = q.gte('so_date', from);
    if (to)   q = q.lte('so_date', to);
    q = scopeToCompany(q, c);
    q = q.order('so_date', { ascending: false });
    return q.range(pFrom, pTo);
  });
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as unknown as FairSoHeader[] };
}

/* Resolve salesperson uuid → staff.name for a set of ids (batched). */
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

/* Resolve project_id (int) → { name, start_date, end_date } from the PUBLIC
   schema (projects lives in public, not scm — read via c.env.DB, the same
   binding createSalesOrderCore stamps the link from). */
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
    /* non-fatal — an unresolved project simply renders a null name (the SO's
       own venue text still identifies the fair). Never block the report. */
  }
  return out;
}

/* Fetch the payment ledger for a set of SO doc_nos, grouped by doc_no.
   `is_deposit` is carried, not dropped: soPaidSen needs it to decide whether the
   header's legacy `deposit_sen` is already in the ledger. Dropping it here is
   what would double-count every modern order's deposit. */
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

/* Shared "fair identity" columns emitted on every stage row. */
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

/* Resolve a fair (project_id) → its brand and the brand's cost-rate card, both
   from the PUBLIC schema via c.env.DB (project_cost_rates + projects live there,
   the same binding resolveProjects + services/projectCostRates.ts read). A fair
   whose project has no brand, or whose brand has no rate row, yields rate=null —
   the P&L then reports zero overhead rather than blocking. Never throws. */
async function resolveFairRate(c: any, projectId: number): Promise<{ brand: string | null; rate: FairCostRate | null }> {
  try {
    const proj = (await c.env.DB.prepare('SELECT brand FROM projects WHERE id = ?')
      .bind(projectId)
      .first()) as { brand: string | null } | null;
    const brand = proj?.brand?.trim() ? proj.brand.trim() : null;
    if (!brand) return { brand: null, rate: null };
    const rate = (await c.env.DB.prepare(
      `SELECT transport_pct, merchandise_pct, commission_normal_pct,
              commission_boost_pct, boost_min_gp_pct, boost_min_sales
         FROM project_cost_rates WHERE brand = ?`,
    )
      .bind(brand)
      .first()) as FairCostRate | null;
    return { brand, rate: rate ?? null };
  } catch {
    return { brand: null, rate: null };
  }
}

type FairCtx = Context<{ Bindings: Env; Variables: Variables }>;

/* Exported so the route test can drive the handler DIRECTLY on a bare Hono app
   (injecting supabase + houzsUser + env.DB via its own middleware), without the
   supabaseAuth bridge — which cannot run in the test harness. Registered on the
   real router with supabaseAuth in front, below. */
export const fairReportHandler = async (c: FairCtx) => {
  const stage = parseStage(c.req.query('stage'));
  if (!stage) return c.json({ error: 'The `stage` parameter is required and must be one of: so, do, invoice.' }, 400);

  const access = fairReportAccess(stage, fairCaller(c));
  if (!access.allowed) return c.json({ error: access.error }, 403);

  const filters = readFairFilters(c);
  const { rows: soRowsAll, error: soErr } = await fetchFairSos(c, filters);
  if (soErr) return c.json({ error: 'load_failed', reason: soErr }, 500);

  const sb = c.get('supabase');

  /* Header `branding` is blank on essentially every SO (the create form has
     never had a branding field — see lib/derive-line-branding.ts), so the raw
     column rendered a dash on every report row. Derive the display branding
     the SO LIST shows (first MAIN line's brand -> catalog mattress fallback ->
     bedframe-only "BEDFRAME"), and apply the branding FILTER against the
     derived value — the old SQL eq on the raw header column matched nothing. */
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
  };

  // ── stage=so ──────────────────────────────────────────────────────────────
  if (stage === 'so') {
    const payByDoc = await fetchPaymentsByDoc(c, soRows.map((r) => r.doc_no));
    const rows = soRows.map((h) => {
      const money = fairSoMoney(h);
      const payments = payByDoc.get(h.doc_no) ?? [];
      /* PAID and BALANCE both come from the payment LEDGER, never from the
         header's `paid_sen` / `balance_sen` columns — neither is maintained
         (see fairBalanceSen and scm/shared/so-outstanding.ts). soPaidSen owns
         the legacy-deposit rule so a modern order does not double-count it. */
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

  // ── stage=pnl ───────────────────────────────────────────────────────────────
  // Per fair: revenue (confirmed SO amount) vs the three-way fulfillment cost
  // (most-progressed booked stage per order) vs the project_cost_rates overhead.
  // REQUIRES a fair (project) so the per-brand rate card resolves to one row.
  if (stage === 'pnl') {
    if (filters.project == null) {
      return c.json({
        stage,
        rows: [],
        summary: summarizeFairPnl([], null),
        filters: filtersEcho,
        meta: { access_tier: access.tier, needs_project: true, brand: null, rate_present: false },
      });
    }

    const pnlDocNos = soRows.map((r) => r.doc_no);

    // DO cost per SO — Σ COALESCE(ship_cost_sen, unit_cost_sen) × qty over
    // the SO's delivery-order lines. Absent (null) when the SO has no DO.
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

    // SI (landed) cost per SO — Σ line cost over the SO's sales-invoice lines.
    // Absent (null) when the SO has no SI.
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

    const { brand, rate } = await resolveFairRate(c, filters.project);

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
      meta: { access_tier: access.tier, needs_project: false, brand, rate_present: rate != null },
    });
  }

  const docNos = soRows.map((r) => r.doc_no);
  if (docNos.length === 0) {
    const summary = stage === 'do' ? summarizeDo([]) : summarizeInvoice([]);
    return c.json({ stage, rows: [], summary, filters: filtersEcho, meta: { access_tier: access.tier } });
  }

  // ── stage=do ──────────────────────────────────────────────────────────────
  if (stage === 'do') {
    // DOs whose SO is in the fair (link by so_doc_no text — no FK to embed on).
    const { data: doData, error: doErr } = await chunkIn(docNos, (batch: string[], pFrom: number, pTo: number) => scopeToCompany(sb
      .from('delivery_orders')
      .select('id, do_number, so_doc_no, do_date, delivered_at, status')
      .in('so_doc_no', batch), c)
      .range(pFrom, pTo));
    if (doErr) return c.json({ error: 'load_failed', reason: doErr.message }, 500);
    const dos = (doData ?? []) as Array<{ id: string; do_number: string; so_doc_no: string | null; do_date: string | null; delivered_at: string | null; status: string | null }>;

    // Their lines (cost), grouped per DO id.
    const linesByDo = new Map<string, Array<{ qty: number | null; unit_cost_sen: number | null; ship_cost_sen: number | null }>>();
    const doIds = dos.map((d) => d.id);
    if (doIds.length > 0) {
      const { data: liData, error: liErr } = await chunkIn(doIds, (batch: string[], pFrom: number, pTo: number) => scopeToCompany(sb
        .from('delivery_order_items')
        .select('delivery_order_id, qty, unit_cost_sen, ship_cost_sen')
        .in('delivery_order_id', batch), c)
        .range(pFrom, pTo));
      if (liErr) return c.json({ error: 'load_failed', reason: liErr.message }, 500);
      for (const l of (liData ?? []) as Array<{ delivery_order_id: string; qty: number | null; unit_cost_sen: number | null; ship_cost_sen: number | null }>) {
        const arr = linesByDo.get(l.delivery_order_id) ?? [];
        arr.push({ qty: l.qty, unit_cost_sen: l.unit_cost_sen, ship_cost_sen: l.ship_cost_sen });
        linesByDo.set(l.delivery_order_id, arr);
      }
    }

    const rows = dos.map((d) => {
      const h = d.so_doc_no ? soByDoc.get(d.so_doc_no) : undefined;
      const doCost = doCostTotal(linesByDo.get(d.id) ?? []);
      const totalSoCost = Number(h?.total_cost_sen ?? 0);
      const costDelta = doCost.total_do_cost_sen - totalSoCost;
      return {
        ...(h ? fairDims(h, staffNames, projects) : {}),
        delivery_date: d.delivered_at ?? d.do_date,
        do_no: d.do_number,
        so_no: d.so_doc_no,
        status: d.status,
        qty: doCost.qty,
        // The linked SO's amount (product + service) — same value the SO tab
        // shows in its Amount column, so the two stages reconcile per SO.
        so_amount_sen: h ? fairSoMoney(h).amount_sen : null,
        total_so_cost_sen: totalSoCost,
        total_do_cost_sen: doCost.total_do_cost_sen,
        do_cost_is_legacy: doCost.is_legacy,
        /* Stock left before any lot existed, so FIFO froze it at zero — the row
           would otherwise read as a naked 100% margin (2990-DO-2607-021). */
        do_cost_ship_anyway: doCost.has_zero_frozen,
        cost_delta_sen: costDelta,
        so_margin_pct: marginPct(Number(h?.local_total_sen ?? 0), totalSoCost),
        do_margin_pct: marginPct(Number(h?.local_total_sen ?? 0), doCost.total_do_cost_sen),
      };
    });
    const summary = summarizeDo(rows);
    return c.json({ stage, rows, summary, filters: filtersEcho, meta: { access_tier: access.tier } });
  }

  // ── stage=invoice ───────────────────────────────────────────────────────────
  // SIs whose SO is in the fair. so_cost = SO total_cost; do_cost = the linked
  // DO's cost; landed(SI) cost = Σ SI line cost.
  const { data: siData, error: siErr } = await chunkIn(docNos, (batch: string[], pFrom: number, pTo: number) => scopeToCompany(sb
    .from('sales_invoices')
    .select('id, invoice_number, so_doc_no, delivery_order_id, invoice_date, total_sen, status')
    .in('so_doc_no', batch), c)
    .range(pFrom, pTo));
  if (siErr) return c.json({ error: 'load_failed', reason: siErr.message }, 500);
  const sis = (siData ?? []) as Array<{ id: string; invoice_number: string; so_doc_no: string | null; delivery_order_id: string | null; invoice_date: string | null; total_sen: number | null; status: string | null }>;

  // SI line costs grouped per SI id.
  const siLinesById = new Map<string, Array<{ qty: number | null; unit_cost_sen: number | null; line_cost_sen: number | null }>>();
  const siIds = sis.map((s) => s.id);
  if (siIds.length > 0) {
    const { data: liData, error: liErr } = await chunkIn(siIds, (batch: string[], pFrom: number, pTo: number) => scopeToCompany(sb
      .from('sales_invoice_items')
      .select('sales_invoice_id, qty, unit_cost_sen, line_cost_sen')
      .in('sales_invoice_id', batch), c)
      .range(pFrom, pTo));
    if (liErr) return c.json({ error: 'load_failed', reason: liErr.message }, 500);
    for (const l of (liData ?? []) as Array<{ sales_invoice_id: string; qty: number | null; unit_cost_sen: number | null; line_cost_sen: number | null }>) {
      const arr = siLinesById.get(l.sales_invoice_id) ?? [];
      arr.push({ qty: l.qty, unit_cost_sen: l.unit_cost_sen, line_cost_sen: l.line_cost_sen });
      siLinesById.set(l.sales_invoice_id, arr);
    }
  }

  // DO cost for each linked delivery_order_id (for the do_cost column of the progression).
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
    const siCost = siCostTotal(siLinesById.get(s.id) ?? []);
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
      margin_pct: marginPct(invoiced, siCost),
    };
  });
  const summary = summarizeInvoice(rows);
  return c.json({ stage, rows, summary, filters: filtersEcho, meta: { access_tier: access.tier } });
};
reports.get('/fair-report', fairReportHandler);

// ----------------------------------------------------------------------------
// GET /reports/fair-report/:docNo — per-order DETAIL for the quick-view.
// docNo = the SO doc_no. Gated exactly like stage=so (management OR Sales
// Director — both are finance-viewers, so the per-line cost + deposit-by-tender
// this returns are theirs to see). Returns order lines, cost-by-category,
// deposit-by-tender (+ merchant bank / instalment plan), and the SO→DO→Invoice
// linkage doc numbers.
// ----------------------------------------------------------------------------
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

  /* Same display-branding derivation as the list handler above, so the
     quick-view drawer agrees with the row it was opened from. */
  if (!h.branding || !String(h.branding).trim()) {
    const derived = await deriveDisplayBrandingByDoc(sb, c, [h.doc_no]);
    h.branding = derived.get(h.doc_no) ?? h.branding;
  }

  const staffNames = await resolveStaffNames(c, h.salesperson_id ? [h.salesperson_id] : []);
  const projects = await resolveProjects(c, h.project_id != null ? [h.project_id] : []);

  // Order lines — item, qty, unit sell, amount, unit cost, line cost.
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
  // Stamp each line's supplier fabric code so the Fair Report line reads
  // "BF-01 (PC151-01)" too — same enrichment the SO/PO/DO/SI detail endpoints do.
  await enrichLinesWithFabricSupplierCode(sb, c, lines);

  // Deposit-by-tender + merchant bank / plan.
  const { data: payData, error: pErr } = await paginateAll((pFrom: number, pTo: number) => scopeToCompany(sb
    .from('mfg_sales_order_payments')
    .select('method, amount_sen, merchant_provider, installment_months, approval_code, paid_at, is_deposit')
    .eq('so_doc_no', docNo), c)
    .range(pFrom, pTo));
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  const payments = (payData ?? []) as Array<{ method: string | null; amount_sen: number | null; merchant_provider: string | null; installment_months: number | null; approval_code: string | null; paid_at: string | null; is_deposit: boolean | null }>;
  /* Same ledger rule as the list — the header's balance_sen/paid_sen columns
     are not maintained (fairBalanceSen, scm/shared/so-outstanding.ts). */
  const paidTotal = soPaidSen(soPaidInputsOf(h as unknown as Record<string, unknown>,
    payments.reduce((s, p) => s + Number(p.amount_sen ?? 0), 0),
    payments.some((p) => p.is_deposit === true)));
  const money = fairSoMoney(h);
  const balanceSen = fairBalanceSen(money.amount_sen, paidTotal);

  // SO → DO → Invoice linkage doc numbers.
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
