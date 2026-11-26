// /sales-invoices — we bill the customer (B2B sales side).
//
// Ported from 2990's apps/api/src/routes/sales-invoices.ts. A faithful clone of
// the Delivery Order API (delivery-orders-mfg.ts), itself a Sales Order clone:
// editable SO-style header, line-item CRUD, a payments ledger, a recomputeTotals
// rollup, plus a convert-from-DO that copies a Delivery Order's header + all line
// items (with variants + prices) into a new invoice.
//
// REVENUE: a Sales Invoice records revenue the moment it is created/confirmed.
// The POST handler calls the shared idempotent poster (post-si-revenue) which
// writes Dr 1100 (AR) / Cr 4000 (Sales Revenue) = total_sen into
// journal_entries + journal_entry_lines, keyed on (source_type='SI',
// source_doc_no=invoice_number) so it can never double-post. Posting failures
// never roll back the invoice (audit-DLQ pattern).
//
// ISSUED = FROZEN: this is the ONE document that leaves the building, so once it
// is issued (any status but DRAFT — see isIssuedSi) its money and identity stop
// being writable: line items are frozen wholesale, and the header freezes
// invoice_date / currency / debtor_name / debtor_code (SI_ISSUED_FROZEN_FIELDS)
// while every neutral field stays editable. The correction path is cancel → fix
// → reopen, which already re-derives revenue, credit and paid status. Without
// this gate a PAID invoice could be re-priced under a customer holding the PDF,
// and moving an issued invoice's date stranded its JE in the original period
// (post-si-revenue fixes entry_date from invoice_date; resyncSiRevenue compares
// only the total). The resync's void+repost is the owner's 2026-06-01 ruling and
// is CORRECT — the bug was the missing gate in front of it, not the mechanic.
//
// Houzs adaptation: same plumbing as the sibling SCM routes — supabaseAuth bridge
// + scm-scoped service client via c.get('supabase'). Imports repointed from
// @2990s/shared → ../shared. NOTE: GL posting needs scm.accounts seeded with at
// least codes 1100 / 4000; customer-credit + payment paths need the two tables
// in scripts/scm-schema/0103-0110-si-payments-and-credits.sql applied.
//
// Mounted at '/sales-invoices' in scm/index.ts.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { lineDiscountShare } from '../shared/line-discount-share';
import { normalizePhone, buildVariantSummary, isServiceLine, fmtSen, computeVariantKey } from '../shared';
import { PAYMENT_METHOD_CODES } from '../shared/payment-methods';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  isCrossCompanySource, crossCompanyConversionBlocked,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { stampDoLineSoRefs } from '../lib/so-ref-lookup';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { dateOrNull, coerceEmptyDates } from '../lib/date-coerce';
import { postUnpostedSiPayments, reverseSiPayment } from '../../acc/payments';
import { insertSiPaymentRow } from '../lib/si-payment-row';
import { followPaymentRemoval } from '../../acc/receipts';
import { recomputeSiPaid as recomputePaid, readOrderDepositForInvoice, siStatusFor } from '../lib/si-order-deposit';
import { invoiceReceipts } from '../lib/si-receipts';
import { stampSoDates, stampDoNumber, stampOrderDeposit } from '../lib/si-list-stamps';
import { SI_HEADER_COLS, SI_LIST_SELECT, filterSiList, orderSiList, readSiListFilters } from '../lib/si-list-read';
import { attachSiLines } from '../lib/si-export-rows';
import { SI_STATUS_BUCKETS } from '../lib/si-status-buckets';
import { postSiRevenue, reverseSiRevenue, resyncSiRevenue } from '../lib/post-si-revenue';
import { buildItemRow, createSalesInvoiceFromDoLines, migratedRefusalForDeliveries, nextSiNumber, recomputeTotals, recordSiCreate } from '../lib/si-from-do';
import { releaseDepositInvoicesBestEffort } from '../../acc/deposit-invoices';
import { releaseSalesInvoiceKnockOffs } from '../../acc/credit-note-si';
import { siCreditNotesSen } from '../lib/si-credit-notes';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { todayMyt } from '../lib/my-time';
import { resolveSalesScopeIds, salesDocOutOfScope } from '../lib/salesScope';
import { readStatusCounts } from '../lib/status-counts';
import { canViewAllSales, canViewScmFinance } from '../lib/houzs-perms';
import { SO_ITEM_FINANCE_KEYS } from '../lib/finance-keys';
import { doLineRemaining, doRemainingByItemId, checkSiOverRemaining, isDoLineOverInvoiced, checkSiReopenOverRemaining, findOverInvoicedDoItems, resolveCandidateDoIds, custKeyOf, remainingUnavailableResponse, siTransferRefusal, type DoRemainingLine } from '../lib/do-line-remaining';
import { siShadowRefusal, unlinkedEditRefusal } from '../lib/unlinked-line-edit-guard';
import { assertLinkedLineItemsMatch } from '../lib/line-link-item-identity';
import { resolveSiHeaderSources, resolveDoLineSources } from '../lib/source-po-trace';
import { validateItemCodes, unknownItemCodeResponse } from '../lib/validate-item-codes';
import { applyCustomerCreditToSi, creditFromCancelledSi, reverseCancelledSiCredit, reconcileSiOverpay } from '../lib/customer-credits';
import { recordEntityAudit, diffFields, compactChanges, fieldChange, statusChange } from '../lib/entity-audit';
import { SI_LINE_AUDIT_FIELDS, SI_LINE_AUDIT_SELECT } from '../lib/entity-audit-fields';
import { enqueueConvert, enqueueCancel, enqueueEdit, retiredLineOf, type AcRetiredLine } from '../lib/autocount-outbox';
import { recordSiAutoCountSource } from '../lib/si-autocount-source';
import { refuseMigratedSources } from '../lib/migrated-chain';
import { withSoRefDocNos } from '../lib/so-ref-search';
import { noWriteUntilMarked, writesFromHere } from '../lib/no-write-refusal';

async function queueAcSiEdit(c: any, id: string, retire: AcRetiredLine[] = [], newLineIds: string[] = []): Promise<void> {  // newLineIds: docs/bugs/0588
  await enqueueEdit(c.get('supabase'), {
    companyId: activeCompanyId(c),
    docType: 'IV',
    docId: id,
    retire, newLineIds,
    createdBy: c.get('houzsUser')?.id ?? null,
  });
}

export const salesInvoices = new Hono<{ Bindings: Env; Variables: Variables }>();
salesInvoices.use('*', supabaseAuth);



const SI_AUDIT_FIELDS: Array<[string, string]> = [
  ['debtorCode', 'debtor_code'], ['debtorName', 'debtor_name'], ['agent', 'agent'],
  ['salesLocation', 'sales_location'], ['ref', 'ref'], ['poDocNo', 'po_doc_no'],
  ['venue', 'venue'], ['venueId', 'venue_id'], ['branding', 'branding'],
  ['address1', 'address1'], ['address2', 'address2'],
  ['city', 'city'], ['state', 'state'], ['postcode', 'postcode'], ['phone', 'phone'],
  ['note', 'note'], ['notes', 'notes'],
  ['invoiceDate', 'invoice_date'], ['dueDate', 'due_date'], ['currency', 'currency'],
  ['customerState', 'customer_state'], ['customerCountry', 'customer_country'],
  ['customerSoNo', 'customer_so_no'],
  ['customerDeliveryDate', 'customer_delivery_date'],
  ['email', 'email'], ['customerType', 'customer_type'],
  ['salespersonId', 'salesperson_id'], ['buildingType', 'building_type'],
  ['emergencyContactName', 'emergency_contact_name'],
  ['emergencyContactPhone', 'emergency_contact_phone'],
  ['emergencyContactRelationship', 'emergency_contact_relationship'],
];

const SI_AUDIT_SELECT =
  `id, invoice_number, status, company_id, ${SI_AUDIT_FIELDS.map(([, snake]) => snake).join(', ')}`;


async function loadSiAuditMeta(
  sb: Variables['supabase'],
  siId: string,
): Promise<{ docNo: string | null; companyId: number | null; status: string | null }> {
  try {
    const { data } = await sb.from('sales_invoices')
      .select('invoice_number, company_id, status').eq('id', siId).maybeSingle();
    const row = (data ?? null) as { invoice_number?: string | null; company_id?: number | null; status?: string | null } | null;
    return { docNo: row?.invoice_number ?? null, companyId: row?.company_id ?? null, status: row?.status ?? null };
  } catch {
    return { docNo: null, companyId: null, status: null };
  }
}

/* recordSiCreate, recomputeTotals, buildItemRow and migratedRefusalForDeliveries
   live in lib/si-from-do.ts since docs/bugs/0830 — the from-DO conversion runs
   with no request context from the delivery reconciler, and a lib may not
   import a route. */

const HEADER = SI_HEADER_COLS;

const SI_FINANCE_KEYS = [
  'mattress_sofa_sen', 'bedframe_sen', 'accessories_sen', 'others_sen', 'service_sen',
  'mattress_sofa_cost_sen', 'bedframe_cost_sen', 'accessories_cost_sen', 'others_cost_sen', 'service_cost_sen',
  'total_cost_sen', 'total_margin_sen', 'margin_pct_basis',
] as const;

export function gateSiFinance(rows: unknown, showFinance: boolean): void {
  if (showFinance || !Array.isArray(rows)) return;
  for (const r of rows) {
    if (r && typeof r === 'object') {
      for (const k of SI_FINANCE_KEYS) delete (r as Record<string, unknown>)[k];
    }
  }
}

const ITEM =
  'id, sales_invoice_id, so_item_id, do_item_id, item_code, item_group, description, description2, ' +
  'uom, qty, unit_price_sen, discount_sen, tax_sen, line_total_sen, ' +
  'unit_cost_sen, line_cost_sen, line_margin_sen, variants, line_delivery_date, notes, created_at';


const PAYMENT_COLS =
  'id, sales_invoice_id, paid_at, method, merchant_provider, installment_months, ' +
  'online_type, approval_code, amount_sen, account_sheet, collected_by, note, ' +
  'created_at, created_by';

const nextNum = async (sb: any, c: any): Promise<string> => nextSiNumber(sb, companyDocPrefix(c));





/* ── Invoice price vs the AGREED ORDER price — WARN, never block ───────────
   Nothing downstream of the SO compares the two. The happy path is already
   anchored (a from-DO SI line copies its price from the DO line at /from-dos,
   which copied it from the SO at delivery-orders-mfg.ts:2867), so this is
   structurally silent there. It fires on the case that has nothing catching it
   today: a clerk hand-editing a price on the create form for goods whose price
   was agreed months ago upstream.

   WARN, NEVER REJECT. The owner ruled (Commander 2026-05-29,
   mfg-pricing-recompute.ts:337-344) that the selling price is operator-authored
   and NOT computed — a hard block would overrule him on his own document. Note
   what the anchor is: the SO's 0.5% honest-pricing gate compares a client price
   against a COMPUTED price, and per that same ruling there IS no computed
   selling figure to compare to here. So the anchor is the price the customer
   already agreed to. Same 0.5% threshold as the SO gate, so the number means
   one thing system-wide.

   Only a DO-LINKED line has an anchor. A genuinely-new manual line is silently
   fine — the owner's ruling is that an SI MAY carry direct/standalone lines, and
   an unlinked line has no agreed price to drift from. Discount is deliberately
   NOT compared: a goodwill discount granted at invoice time is legitimate and
   would false-positive constantly. One query, and only when linked lines exist. */
const SI_PRICE_DRIFT_THRESHOLD = 0.005;

type SiPriceWarning = { itemCode: string; invoicedSen: number; orderedSen: number };

async function siPriceDriftWarnings(
  sb: any,
  lines: Array<Record<string, unknown>>,
): Promise<SiPriceWarning[]> {
  const linked = lines.filter((l) => l.doItemId && l.unitPriceSen !== undefined);
  if (linked.length === 0) return [];
  const { data } = await sb.from('delivery_order_items')
    .select('id, item_code, unit_price_sen')
    .in('id', [...new Set(linked.map((l) => String(l.doItemId)))]);
  const byId = new Map<string, { item_code: string | null; unit_price_sen: number | null }>();
  for (const r of (data ?? []) as Array<{ id: string; item_code: string | null; unit_price_sen: number | null }>) {
    byId.set(r.id, r);
  }
  const out: SiPriceWarning[] = [];
  for (const l of linked) {
    const src = byId.get(String(l.doItemId));
    if (!src) continue;
    const ordered = Math.round(Number(src.unit_price_sen ?? 0));
    const invoiced = Math.round(Number(l.unitPriceSen ?? 0));
    if (!(ordered > 0) || !Number.isFinite(invoiced)) continue;
    if (Math.abs(invoiced - ordered) / ordered <= SI_PRICE_DRIFT_THRESHOLD) continue;
    out.push({ itemCode: String(l.itemCode ?? src.item_code ?? ''), invoicedSen: invoiced, orderedSen: ordered });
  }
  return out;
}

function siPriceWarningMessage(warnings: SiPriceWarning[]): string {
  const parts = warnings.map(
    (w) => `${w.itemCode} is invoiced at ${fmtSen(w.invoicedSen)} but the order price is ${fmtSen(w.orderedSen)}`,
  );
  return `${parts.join('; ')}. Check the price before sending this invoice.`;
}

function withPriceWarnings<T extends object>(res: T, warnings: SiPriceWarning[]) {
  return warnings.length === 0
    ? res
    : { ...res, priceWarnings: warnings, priceWarningMessage: siPriceWarningMessage(warnings) };
}


const SI_STATUS_CANON: Record<string, string> = {
  DRAFT: 'DRAFT',
  SENT: 'SENT',
  ISSUED: 'SENT',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PARTIAL: 'PARTIALLY_PAID',
  PAID: 'PAID',
  COMPLETED: 'PAID',
  OVERDUE: 'OVERDUE',
  CANCELLED: 'CANCELLED',
  CANCELED: 'CANCELLED',
};
function canonicalSiStatus(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  return SI_STATUS_CANON[raw.trim().toUpperCase()] ?? null;
}

const isIssuedSi = (raw: string | null | undefined): boolean => {
  const s = (raw ?? '').trim().toUpperCase();
  return s !== 'DRAFT' && s !== 'CANCELLED';
};

const SI_ISSUED_FROZEN_FIELDS: Record<string, string> = {
  invoiceDate: 'invoice date',
  currency:    'currency',
  debtorName:  'customer name',
  debtorCode:  'customer code',
};

const SI_ISSUED_LINE_MESSAGE =
  'This invoice has already been issued to the customer, so its items can no longer be changed. Cancel the invoice and reopen it if it is wrong.';

const SI_LEGAL_TRANSITIONS: Record<string, Set<string>> = {
  DRAFT:          new Set(['SENT', 'CANCELLED']),
  SENT:           new Set(['PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED']),
  PARTIALLY_PAID: new Set(['SENT', 'PAID', 'OVERDUE', 'CANCELLED']),
  PAID:           new Set(['SENT', 'PARTIALLY_PAID', 'OVERDUE', 'CANCELLED']),
  OVERDUE:        new Set(['SENT', 'PARTIALLY_PAID', 'PAID', 'CANCELLED']),
  CANCELLED:      new Set(['SENT']),
};
function siTransitionReject(prev: string, next: string): string {
  if (prev === 'CANCELLED') return 'A cancelled invoice can only be reopened to Issued. Reopen it first; its payment status is then re-derived from the payments ledger.';
  if (next === 'DRAFT') return 'A confirmed invoice cannot be moved back to draft.';
  if (prev === 'DRAFT') return 'A draft invoice can only be confirmed (Issued) or cancelled.';
  return `An invoice cannot move from ${prev} to ${next}.`;
}

/* Source PO(s) for a page of Sales Invoices (owner 2026-07-31). An SI is born
   FROM a Delivery Order, so the useful cross-doc anchor is which PO the shipped-
   then-invoiced goods actually came from — the durable batch_no = source-PO hard
   link on the SI's DO's OUT movements, NOT an Assigned SO. An SI with no
   delivery_order_id (manual invoice) gets an empty list.
   2026-08-02 (header ≡ ∪(lines), same defect class as 2990-DO-2607-017): the
   cell is the union of the SI'S OWN LINES' traces (each line matched into its
   DO's ledger buckets — the exact per-line rule the SI detail applies), never
   the DO's raw byDo rollup, which surfaced orphan ledger buckets as phantom
   chips and could also include DO lines this SI never invoiced. */
export async function stampSourcePos(sb: any, rows: unknown): Promise<void> {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const list = rows as Array<Record<string, unknown>>;
  const bySi = await resolveSiHeaderSources(
    sb,
    list.map((r) => ({
      id: r.id as string | null,
      delivery_order_id: r.delivery_order_id as string | null,
    })),
  );
  for (const r of list) {
    const trace = bySi.get((r.id as string | null) ?? '');
    r.source_pos = trace?.pos ?? [];
    r.source_adj = (trace?.adjQty ?? 0) > 0;
  }
}

salesInvoices.get('/', async (c) => {
  const sb = c.get('supabase');
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  const pageRaw = c.req.query('page');
  const paginate = pageRaw !== undefined && pageRaw !== '';

  if (!paginate) {
    let q = sb.from('sales_invoices').select(HEADER).order('invoice_date', { ascending: false }).limit(500);
    if (scopeIds) q = q.in('salesperson_id', scopeIds);
    const status = c.req.query('status'); if (status) q = q.eq('status', status);
    q = scopeToCompany(q, c);
    const { data, error } = await q;
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    await stampSoDates(sb, data);
    await stampDoNumber(sb, data);
    await stampSourcePos(sb, data);
    await stampOrderDeposit(sb, data, activeCompanyId(c) ?? null);
    gateSiFinance(data, canViewScmFinance(c));
    return c.json({ salesInvoices: data ?? [] });
  }

  const page = Math.max(0, Math.trunc(Number(pageRaw)) || 0);
  const psRaw = Number(c.req.query('pageSize'));
  const pageSize = Number.isFinite(psRaw) && psRaw > 0 ? Math.min(100, Math.max(1, Math.trunc(psRaw))) : 50;

  const filters = await withSoRefDocNos(sb, c, readSiListFilters((k) => c.req.query(k)));
  let q = orderSiList(filterSiList(sb.from('sales_invoices').select(SI_LIST_SELECT, { count: 'exact' }), filters, c, scopeIds), filters.sort);
  q = q.range(page * pageSize, page * pageSize + pageSize - 1);
  const { data, error, count } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const total = count ?? (data?.length ?? 0);

  const countBase = () => {
    let cq = sb.from('sales_invoices').select('*', { count: 'exact', head: true });
    if (scopeIds) cq = cq.in('salesperson_id', scopeIds);
    cq = scopeToCompany(cq, c);
    return cq;
  };
  const [allC, draftC, sentC, partialC, paidC, cancelledC] = await Promise.all([
    countBase(),
    countBase().in('status', SI_STATUS_BUCKETS.draft),
    countBase().in('status', SI_STATUS_BUCKETS.sent),
    countBase().in('status', SI_STATUS_BUCKETS.partial),
    countBase().in('status', SI_STATUS_BUCKETS.paid),
    countBase().in('status', SI_STATUS_BUCKETS.cancelled),
  ]);
  const counted = readStatusCounts({ all: allC, draft: draftC, sent: sentC, partial: partialC, paid: paidC, cancelled: cancelledC });
  if (!counted.ok) return c.json({ error: 'status_counts_failed', reason: counted.reason }, 500);
  const statusCounts = counted.counts;

  await stampSoDates(sb, data);
  await stampDoNumber(sb, data);
  await stampSourcePos(sb, data);
  await stampOrderDeposit(sb, data, activeCompanyId(c) ?? null);
  gateSiFinance(data, canViewScmFinance(c));
  const withLines = await attachSiLines(sb, c, (data ?? []) as Array<{ id: string } & Record<string, unknown>>);
  if (withLines.error !== null) return c.json({ error: 'lines_read_failed', reason: withLines.error }, 500);
  return c.json({ salesInvoices: withLines.rows, total, page, pageSize, statusCounts });
});

salesInvoices.get('/invoiceable-do-lines', async (c) => {
  const sb = c.get('supabase');
  // Company scope (owner 2026-08-10 audit) — without it the no-doIds path
  // enumerated every company's delivery orders into this picker.
  const candidates = await resolveCandidateDoIds(sb, c.req.query('doIds'), activeCompanyId(c), 'invoiceable');
  if (!candidates.ok) return c.json({ error: 'load_failed', reason: candidates.reason }, 500);
  if (candidates.doIds.length === 0) return c.json({ lines: [] });
  const remaining = await doLineRemaining(sb, candidates.doIds, 'invoiceable');
  if (!remaining.ok) return c.json({ error: 'load_failed', reason: remaining.reason }, 500);
  const lines = [...remaining.lines.values()].filter((l) => l.remaining > 0);
  // The DO's order reference, for the picker's search (owner 2026-09-25).
  await stampDoLineSoRefs(sb, lines, (q) => scopeToCompany(q, c), 'invoiceable-do-lines');
  return c.json({ lines });
});

salesInvoices.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    // Company-scoped (owner 2026-08-10 audit) — a bare uuid must not read
    // another company's invoice.
    scopeToCompany(sb.from('sales_invoices').select(HEADER), c).eq('id', id).maybeSingle(),
    sb.from('sales_invoice_items').select(ITEM).eq('sales_invoice_id', id)
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  {
    const sp = (h.data as { salesperson_id?: number | string | null }).salesperson_id;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), sp)) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
  const items = (i.data ?? []) as unknown as Array<Record<string, unknown>>;
  if (!canViewScmFinance(c)) {
    gateSiFinance([h.data], false);
    for (const it of items) {
      for (const k of SO_ITEM_FINANCE_KEYS) delete it[k];
    }
  }
  /* Per-line Source PO (owner 2026-07-31): the SI's goods came FROM a Delivery
     Order — show which PO they were procured on (batch_no = source PO), matched
     by the SAME (item_code, variant_key) bucket the DO shipped them under.
     Resolved from the SI's DO ledger; a manual SI with no DO gets a dash. */
  {
    const doId = (h.data as { delivery_order_id?: string | null }).delivery_order_id ?? null;
    const bySku = doId ? await resolveDoLineSources(sb, doId) : new Map<string, { pos: string[]; adjQty: number }>();
    for (const it of items) {
      const vk = computeVariantKey(
        (it.item_group as string | null) ?? null,
        (it.variants as Record<string, unknown> | null) ?? null,
      );
      const trace = bySku.get(`${(it.item_code as string) ?? ''}::${vk}`);
      it.source_pos = trace?.pos ?? [];
      it.source_adj = (trace?.adjQty ?? 0) > 0;
    }
  }
  await stampDoNumber(sb, [h.data]);  // else the page prints a uuid — docs/bugs/0526
  // Stamp each line's supplier fabric code so the on-screen line reads
  // "BF-01 (PC151-01)" (owner 2026-07-24). ONE batched query; fail-soft.
  await enrichLinesWithFabricSupplierCode(sb, c, items);
  const dep = await readOrderDepositForInvoice(sb, {
    id,
    so_doc_no: (h.data as { so_doc_no?: string | null }).so_doc_no ?? null,
    company_id: (h.data as { company_id?: number | null }).company_id ?? activeCompanyId(c),
  });
  (h.data as unknown as Record<string, unknown>).so_deposit_applied_sen =
    dep.ok ? (dep.deposit?.applied_sen ?? 0) : null;
  (h.data as unknown as Record<string, unknown>).credit_notes_sen =
    await siCreditNotesSen(sb, (h.data as { company_id?: number | null }).company_id ?? activeCompanyId(c) ?? null, id);
  {
    const { data: own, error: ownErr } = await scopeToCompany(
      sb.from('sales_invoice_payments').select('paid_at, method, amount_sen, created_at').eq('sales_invoice_id', id), c,
    ).order('paid_at', { ascending: true }).order('created_at', { ascending: true });
    (h.data as unknown as Record<string, unknown>).receipts = ownErr || !dep.ok
      ? null
      : invoiceReceipts(dep.deposit, (own ?? []) as Array<{ paid_at: string | null; method: string | null; amount_sen: number }>);
  }
  return c.json({
    salesInvoice: h.data,
    items,
    orderDeposit: dep.ok ? dep.deposit : null,
    orderDepositUnavailable: !dep.ok,
  });
});

export const createSalesInvoiceHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const debtorName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!debtorName) return c.json({ error: 'debtor_name_required' }, 400);
  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];

  const sb = c.get('supabase'); const user = c.get('user');

  if (items.length > 0) {
    const codeCheck = await validateItemCodes(sb, items.map((it) => it.itemCode as string | null | undefined), activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  {
    const over = await checkSiOverRemaining(sb, items);
    if (over) return c.json(over.body, over.status);
  }

  {
    const mig = await migratedRefusalForDeliveries(sb, {
      doItemIds: items.map((it) => it.doItemId as string | undefined),
      doIds: [(body.deliveryOrderId as string | undefined) ?? null],
    });
    if (!mig.ok) return c.json({ error: 'load_failed', reason: mig.reason }, 500);
    if (mig.refusal) return c.json(mig.refusal, 409);
  }

  {
    const fromDoId = (body.deliveryOrderId as string | undefined) ?? null;
    if (fromDoId) {
      const shadow = await siShadowRefusal(sb, fromDoId, items, (codes) =>
        `These items are still pending on the source Delivery Order and must be added through "Add from Delivery Order" so the delivered quantity is tracked: ${codes.join(', ')}.`);
      if (shadow) return c.json(shadow, 409);
    }
  }

  {
    const srcSoDocNo = (body.soDocNo as string | undefined) ?? null;
    if (srcSoDocNo) {
      const { data: soRow, error: soErr } = await sb
        .from('mfg_sales_orders').select('doc_no, company_id').eq('doc_no', srcSoDocNo).maybeSingle();
      if (soErr) return c.json({ error: 'load_failed', reason: soErr.message }, 500);
      const so = soRow as { doc_no: string; company_id: number | null } | null;
      if (so && isCrossCompanySource(so.company_id, c)) {
        return c.json(crossCompanyConversionBlocked(so.doc_no, so.company_id, c), 409);
      }
    }
    const srcDoId = (body.deliveryOrderId as string | undefined) ?? null;
    if (srcDoId) {
      const { data: doRow, error: doErr } = await sb
        .from('delivery_orders').select('do_number, company_id').eq('id', srcDoId).maybeSingle();
      if (doErr) return c.json({ error: 'load_failed', reason: doErr.message }, 500);
      const dr = doRow as { do_number: string; company_id: number | null } | null;
      if (dr && isCrossCompanySource(dr.company_id, c)) {
        return c.json(crossCompanyConversionBlocked(dr.do_number, dr.company_id, c), 409);
      }
    }
  }

  {
    const srcSoDocNo = (body.soDocNo as string | undefined) ?? null;
    const fromDo = Boolean(body.deliveryOrderId) || items.some((it) => Boolean(it.doItemId));
    if (srcSoDocNo && !fromDo) {
      const { data: sis, error: siErr } = await scopeToCompany(
        sb.from('sales_invoices').select('invoice_number, status').eq('so_doc_no', srcSoDocNo), c,
      );
      if (siErr) return c.json({ error: 'load_failed', reason: siErr.message }, 500);
      const liveSi = ((sis ?? []) as Array<{ invoice_number: string; status: string | null }>)
        .find((s) => String(s.status ?? '').trim().toUpperCase() !== 'CANCELLED');
      if (liveSi) {
        return c.json({
          error: 'so_already_invoiced',
          message: `${srcSoDocNo} already has invoice ${liveSi.invoice_number}. Cancel it first, or raise the extra charge on a new Sales Order.`,
        }, 409);
      }
    }
  }

  const priceWarnings = await siPriceDriftWarnings(sb, items);

  const phoneRaw = (body.phone as string | undefined) ?? null;
  const emPhoneRaw = (body.emergencyContactPhone as string | undefined) ?? null;
  const nowIso = new Date().toISOString();

  const isDraft = (body as { asDraft?: unknown }).asDraft === true;

  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; invoice_number: string; debtor_code: string | null; debtor_name: string | null; total_sen: number | null; paid_sen: number | null }>(
    () => nextNum(sb, c),
    (invoiceNumber) => sb.from('sales_invoices').insert({
    company_id: activeCompanyId(c),
    invoice_number: invoiceNumber,
    so_doc_no: (body.soDocNo as string) ?? null,
    delivery_order_id: (body.deliveryOrderId as string) ?? null,
    debtor_code: (body.debtorCode as string) ?? null,
    debtor_name: debtorName,
    invoice_date: dateOrNull(body.invoiceDate) ?? todayMyt(),
    due_date: dateOrNull(body.dueDate),
    customer_delivery_date: dateOrNull(body.customerDeliveryDate),
    address1: (body.address1 as string) ?? null,
    address2: (body.address2 as string) ?? null,
    city: (body.city as string) ?? null,
    state: (body.state as string) ?? (body.customerState as string) ?? null,
    customer_state: (body.customerState as string) ?? (body.state as string) ?? null,
    customer_country: (body.customerCountry as string) ?? null,
    postcode: (body.postcode as string) ?? null,
    phone: phoneRaw ? (normalizePhone(phoneRaw) ?? phoneRaw) : null,
    salesperson_id: (body.salespersonId as string) ?? null,
    agent: (body.agent as string) ?? null,
    email: (body.email as string) ?? null,
    customer_type: (body.customerType as string) ?? null,
    building_type: (body.buildingType as string) ?? null,
    branding: (body.branding as string) ?? null,
    venue: (body.venue as string) ?? null,
    venue_id: (body.venueId as string) ?? null,
    ref: (body.ref as string) ?? null,
    customer_so_no: (body.customerSoNo as string) ?? null,
    po_doc_no: (body.poDocNo as string) ?? null,
    sales_location: (body.salesLocation as string) ?? null,
    note: (body.note as string) ?? null,
    emergency_contact_name: (body.emergencyContactName as string) ?? null,
    emergency_contact_phone: emPhoneRaw ? (normalizePhone(emPhoneRaw) ?? emPhoneRaw) : null,
    emergency_contact_relationship: (body.emergencyContactRelationship as string) ?? null,
    currency: ((body.currency as string) ?? 'MYR').toUpperCase(),
    status: isDraft ? 'DRAFT' : 'SENT',
    sent_at: isDraft ? null : nowIso,
    confirmed_at: isDraft ? null : nowIso,
    notes: (body.notes as string) ?? null,
    created_by: user.id,
    }).select(HEADER).single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; invoice_number: string; debtor_code: string | null; debtor_name: string | null; total_sen: number | null; paid_sen: number | null };

  if (items.length > 0) {
    const rows = items.map((it, lineNo) => buildItemRow(h.id, it, lineNo));
    const { error: iErr } = await sb.from('sales_invoice_items').insert(stampCompany(rows, c));
    if (iErr) {
      await sb.from('sales_invoices').delete().eq('id', h.id);
      // HC-0004: the DB cap (mig 20261014T1410) refused a line past its DO line.
      if (isDoLineOverInvoiced(iErr)) return c.json({ error: 'race_conflict', message: 'Another operator just invoiced overlapping qty from this Delivery Order. Refresh and try again.', reason: iErr.message }, 409);
      return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500);
    }

  {
    const pickedDoItemIds = rows
      .map((r) => (r as { do_item_id?: string | null }).do_item_id)
      .filter((x): x is string => !!x);
    if (pickedDoItemIds.length > 0) {
      const recheck = await doRemainingByItemId(sb, pickedDoItemIds, 'invoiceable');
      if (!recheck.ok) {
        await sb.from('sales_invoice_items').delete().eq('sales_invoice_id', h.id);
        await sb.from('sales_invoices').delete().eq('id', h.id);
        return c.json(remainingUnavailableResponse(recheck.reason), 503);
      }
      const over = findOverInvoicedDoItems(pickedDoItemIds, recheck.remaining);
      if (over.length > 0) {
        await sb.from('sales_invoice_items').delete().eq('sales_invoice_id', h.id);
        await sb.from('sales_invoices').delete().eq('id', h.id);
        return c.json({
          error: 'race_conflict',
          message: 'Another operator just invoiced overlapping qty from this Delivery Order. Refresh and try again.',
          conflicts: over,
        }, 409);
      }
    }
  }
    await recomputeTotals(sb, h.id);
  }

  await recordSiCreate(sb, c.get('houzsUser'), activeCompanyId(c), h.id, items.length);

  await recordSiAutoCountSource(sb, {
    companyId: activeCompanyId(c),
    invoiceId: h.id,
    invoiceNumber: h.invoice_number,
    createdBy: c.get('houzsUser')?.id ?? null,
  });

  if (isDraft) {
    return c.json(withPriceWarnings({ id: h.id, invoiceNumber: h.invoice_number, revenue: { posted: false, status: 'draft' }, creditApplied: 0 }, priceWarnings), 201);
  }

  let revenue: { posted: boolean; jeNo?: string; status: string } = { posted: false, status: 'skipped' };
  const post = await postSiRevenue(sb, h.invoice_number);
  if (post.ok) {
    revenue = post.status === 'migrated_source'
      ? { posted: false, status: post.status }
      : { posted: post.status === 'posted', jeNo: post.jeNo, status: post.status };
  } else {
    revenue = { posted: false, status: post.status };
    if (post.status !== 'zero_total' && post.status !== 'invoice_not_found') {
      // eslint-disable-next-line no-console
      console.error(`[si-revenue] post failed for ${h.invoice_number}:`, post.status, post.reason);
    }
  }

  let creditApplied = 0;
  if (h.debtor_code) {
    try {
      const { data: latest } = await sb.from('sales_invoices').select('total_sen, paid_sen').eq('id', h.id).maybeSingle();
      const total = Number((latest as { total_sen: number } | null)?.total_sen ?? 0);
      const paid  = Number((latest as { paid_sen: number } | null)?.paid_sen ?? 0);
      const due   = Math.max(0, total - paid);
      const res = await applyCustomerCreditToSi(sb, {
        debtorCode: h.debtor_code,
        debtorName: h.debtor_name,
        siId: h.id,
        siNumber: h.invoice_number,
        remainingDueSen: due,
        createdBy: user.id,
      });
      creditApplied = res.applied;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[customer-credit] apply-on-create failed for ${h.invoice_number}:`, e);
    }
  }

  if (creditApplied > 0) await recomputePaid(sb, h.id);
  return c.json(withPriceWarnings({ id: h.id, invoiceNumber: h.invoice_number, revenue, creditApplied }, priceWarnings), 201);
};
salesInvoices.post('/', createSalesInvoiceHandler);

export const createSalesInvoiceFromDoLinesHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { picks?: Array<{ doItemId?: string; qty?: number }>; asDraft?: unknown };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  /* The conversion itself is lib/si-from-do (docs/bugs/0830): the same core
     the delivery reconciler runs with no request to hand. This door only
     resolves the caller — company, prefix, user, actor — and returns the
     outcome the core shaped. DRAFT flow stays opt-in, identical to POST /. */
  const r = await createSalesInvoiceFromDoLines(sb, {
    companyId: activeCompanyId(c) ?? null,
    docPrefix: companyDocPrefix(c),
    picks: (body.picks ?? []).map((p) => ({ doItemId: String(p?.doItemId ?? ''), qty: Number(p?.qty ?? 0) })),
    asDraft: body.asDraft === true,
    createdBy: user.id,
    actor: c.get('houzsUser'),
  });
  return c.json(r.body, r.status);
};
salesInvoices.post('/from-dos', createSalesInvoiceFromDoLinesHandler);

export const appendDoLinesToSalesInvoiceHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const doId = c.req.param('doId');

  /* company-scope: this header read is the gate for the whole handler. Unscoped,
     company A appended lines to B's invoice — and the insert below stamps the
     ACTIVE company, so they landed on B's document tagged as A's. */
  const { data: si } = await scopeToCompany(
    sb.from('sales_invoices').select('id, invoice_number, status').eq('id', id), c,
  ).maybeSingle();
  if (!si) return c.json({ error: 'not_found' }, 404);
  if ((si as { status: string }).status === 'CANCELLED') return c.json({ error: 'invoice_cancelled' }, 409);
  if (isIssuedSi((si as { status: string }).status)) {
    return c.json({ error: 'invoice_issued', message: SI_ISSUED_LINE_MESSAGE }, 409);
  }

  const { data: doHeader } = await scopeToCompany(sb.from('delivery_orders')
    .select('id, status, do_number, company_id').eq('id', doId), c).maybeSingle();
  if (!doHeader) return c.json({ error: 'delivery_order_not_found' }, 404);
  const bad = siTransferRefusal((doHeader as { status: string }).status); if (bad) return c.json(bad, 409);

  {
    const mig = await migratedRefusalForDeliveries(sb, { doIds: [doId] });
    if (!mig.ok) return c.json({ error: 'load_failed', reason: mig.reason }, 500);
    if (mig.refusal) return c.json(mig.refusal, 409);
  }

  const { data: doItems, error: doItemsErr } = await scopeToCompany(sb.from('delivery_order_items').select(
    'id, item_code, item_group, description, description2, uom, qty, ' +
    'unit_price_sen, discount_sen, unit_cost_sen, variants, notes, line_delivery_date, ' +
    'gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, ' +
    'custom_specials, line_suffix, special_order_price_sen',
  ).eq('delivery_order_id', doId)
    .order('line_no', { ascending: true, nullsFirst: false })
    .order('created_at'), c);

  if (doItemsErr) return c.json(remainingUnavailableResponse(`delivery_order_items: ${doItemsErr.message}`), 503);
  const doLines = (doItems as Array<Record<string, unknown>> | null) ?? [];
  const remainingResult = await doRemainingByItemId(sb, doLines.map((it) => it.id as string), 'invoiceable');
  if (!remainingResult.ok) return c.json(remainingUnavailableResponse(remainingResult.reason), 503);
  const remainingMap = remainingResult.remaining;
  const { data: maxNoRow } = await sb
    .from('sales_invoice_items')
    .select('line_no')
    .eq('sales_invoice_id', id)
    .order('line_no', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const baseLineNo = typeof (maxNoRow as { line_no?: number | null } | null)?.line_no === 'number'
    ? (maxNoRow as { line_no: number }).line_no + 1
    : null;
  const rows = doLines
    .map((it) => ({ it, remaining: remainingMap.get(it.id as string) ?? 0 }))
    .filter(({ remaining }) => remaining > 0)
    .map(({ it, remaining }, idx) => buildItemRow(id, {
      doItemId: it.id,
      itemCode: it.item_code,
      itemGroup: it.item_group,
      description: it.description,
      description2: it.description2,
      uom: it.uom,
      qty: Math.min(Number(it.qty ?? 0), remaining),
      unitPriceSen: it.unit_price_sen,
      discountSen: lineDiscountShare(Number(it.discount_sen ?? 0), Number(it.qty ?? 0), Number(it.qty ?? 0) - remaining, Math.min(Number(it.qty ?? 0), remaining)),
      unitCostSen: it.unit_cost_sen,
      variants: it.variants,
      notes: it.notes,
      lineDeliveryDate: (it.line_delivery_date as string | null) ?? null,
      gapInches: it.gapInches ?? it.gap_inches ?? null,
      divanHeightInches: it.divanHeightInches ?? it.divan_height_inches ?? null,
      divanPriceSen: it.divanPriceSen ?? it.divan_price_sen ?? 0,
      legHeightInches: it.legHeightInches ?? it.leg_height_inches ?? null,
      legPriceSen: it.legPriceSen ?? it.leg_price_sen ?? 0,
      customSpecials: it.customSpecials ?? it.custom_specials ?? null,
      lineSuffix: it.lineSuffix ?? it.line_suffix ?? null,
      specialOrderPriceSen: it.specialOrderPriceSen ?? it.special_order_price_sen ?? 0,
    }, baseLineNo === null ? null : baseLineNo + idx));
  if (rows.length === 0) return c.json({ error: 'do_fully_invoiced' }, 409);

  const { error: iErr } = await sb.from('sales_invoice_items').insert(stampCompany(rows, c));
  if (isDoLineOverInvoiced(iErr)) return c.json({ error: 'race_conflict', message: 'Another operator just invoiced overlapping qty from this Delivery Order. Refresh and try again.', reason: iErr?.message }, 409);
  if (iErr) return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500);
  await recomputeTotals(sb, id);
  await recomputePaid(sb, id);

  {
    const meta = await loadSiAuditMeta(sb, id);
    await recordEntityAudit(sb, {
      entityType: 'SALES_INVOICE',
      entityId: id,
      entityDocNo: meta.docNo,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: meta.companyId ?? activeCompanyId(c),
      statusSnapshot: meta.status,
      note: `Lines added from Delivery Order: ${rows.map((r) => String((r as { item_code?: unknown }).item_code ?? '')).filter(Boolean).join(', ')}`,
      fieldChanges: compactChanges([
        fieldChange('lineCount', null, rows.length),
      ]),
    });
  }
  if ((si as { status: string }).status !== 'DRAFT') {
    await postSiRevenue(sb, (si as { invoice_number: string }).invoice_number);
  }
  await queueAcSiEdit(c, id);
  return c.json({ ok: true, added: rows.length }, 201);
};
salesInvoices.post('/:id/items/from-do/:doId', appendDoLinesToSalesInvoiceHandler);

salesInvoices.patch('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const { data: cur, error: curErr } = await scopeToCompany(
    sb.from('sales_invoices').select(SI_AUDIT_SELECT).eq('id', id), c,
  ).maybeSingle();
  if (curErr) return c.json({ error: 'load_failed', reason: curErr.message }, 500);
  if (!cur) return c.json({ error: 'not_found' }, 404);
  const before = cur as unknown as Record<string, unknown>;
  {
    const sp = before.salesperson_id as number | string | null | undefined;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), sp)) {
      return c.json({ error: 'not_found' }, 404);
    }
  }

  const curStatus = String(before.status ?? '').toUpperCase();
  if (curStatus === 'CANCELLED') {
    return c.json({ error: 'invoice_cancelled', message: 'This invoice is cancelled — reopen it before editing it.' }, 409);
  }
  if (isIssuedSi(curStatus)) {
    const frozen = Object.keys(SI_ISSUED_FROZEN_FIELDS).filter((k) => body[k] !== undefined);
    if (frozen.length > 0) {
      const names = frozen.map((k) => SI_ISSUED_FROZEN_FIELDS[k]);
      return c.json({
        error: 'invoice_issued',
        message: `This invoice has already been issued to the customer, so its ${names.join(', ')} can no longer be changed. Cancel the invoice and reopen it if it is wrong.`,
        fields: frozen,
      }, 409);
    }
  }

  const map: Array<[string, string]> = [
    ['debtorCode', 'debtor_code'], ['debtorName', 'debtor_name'], ['agent', 'agent'],
    ['salesLocation', 'sales_location'], ['ref', 'ref'], ['poDocNo', 'po_doc_no'],
    ['venue', 'venue'], ['venueId', 'venue_id'], ['branding', 'branding'],
    ['address1', 'address1'], ['address2', 'address2'], ['note', 'note'], ['notes', 'notes'],
    ['city', 'city'], ['state', 'state'], ['postcode', 'postcode'], ['phone', 'phone'],
    ['invoiceDate', 'invoice_date'], ['dueDate', 'due_date'], ['currency', 'currency'],
    ['customerState', 'customer_state'], ['customerCountry', 'customer_country'],
    ['customerSoNo', 'customer_so_no'], ['customerDeliveryDate', 'customer_delivery_date'],
    ['email', 'email'], ['customerType', 'customer_type'],
    ['salespersonId', 'salesperson_id'], ['buildingType', 'building_type'],
    ['emergencyContactName', 'emergency_contact_name'],
    ['emergencyContactPhone', 'emergency_contact_phone'],
    ['emergencyContactRelationship', 'emergency_contact_relationship'],
  ];
  const PHONE_FIELDS = new Set(['phone', 'emergencyContactPhone']);
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [from, to] of map) {
    if (body[from] === undefined) continue;
    if (PHONE_FIELDS.has(from) && typeof body[from] === 'string') {
      const raw = body[from] as string;
      updates[to] = normalizePhone(raw) ?? raw;
    } else {
      updates[to] = body[from];
    }
  }
  if (Object.keys(updates).length === 1) return c.json({ ok: true, changed: 0 });

  const { data, error } = await sb.from('sales_invoices').update(coerceEmptyDates(updates)).eq('id', id).select('id').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);

  const auditPatch: Record<string, unknown> = {};
  for (const [camel, snake] of SI_AUDIT_FIELDS) {
    if (updates[snake] !== undefined) auditPatch[camel] = updates[snake];
  }
  await recordEntityAudit(sb, {
    entityType: 'SALES_INVOICE',
    entityId: id,
    entityDocNo: (before.invoice_number as string | null) ?? null,
    action: 'UPDATE',
    actor: c.get('houzsUser'),
    companyId: (before.company_id as number | null) ?? activeCompanyId(c),
    statusSnapshot: (before.status as string | null) ?? null,
    fieldChanges: diffFields(before, auditPatch, SI_AUDIT_FIELDS),
  });

  await queueAcSiEdit(c, id);
  return c.json({ ok: true, id });
});

// ── Item CRUD ─────────────────────────────────────────────────────────────
// STRICT like PATCH/DELETE here; named so a test can mount it. What a company STAMP hid: docs/modules/sales-invoice.md.
export const appendSalesInvoiceItemHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const co = requireActiveCompanyId(c); if (!co.ok) return c.json(co.refusal, 409);
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);
  const { data: header } = await scopeToCompanyId(sb.from('sales_invoices').select('id, invoice_number, status, delivery_order_id').eq('id', id), co.companyId).maybeSingle();
  if (!header) return c.json(NOT_THIS_COMPANY, 404);
  const codeCheck = await validateItemCodes(sb, [it.itemCode as string], co.companyId);
  if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  if (((header as { status: string }).status ?? '').toUpperCase() === 'CANCELLED') {
    return c.json({ error: 'invoice_cancelled', message: 'This invoice is cancelled — reopen it before adding lines.' }, 409);
  }
  if (isIssuedSi((header as { status: string }).status)) {
    return c.json({ error: 'invoice_issued', message: SI_ISSUED_LINE_MESSAGE }, 409);
  }

  {
    const over = await checkSiOverRemaining(sb, [it]);
    if (over) return c.json(over.body, over.status);
  }

  {
    const mig = await migratedRefusalForDeliveries(sb, { doItemIds: [it.doItemId as string | undefined] });
    if (!mig.ok) return c.json({ error: 'load_failed', reason: mig.reason }, 500);
    if (mig.refusal) return c.json(mig.refusal, 409);
  }

  {
    const fromDoId = (header as { delivery_order_id?: string | null }).delivery_order_id ?? null;
    if (fromDoId && !it.doItemId) {
      const shadow = await siShadowRefusal(sb, fromDoId, [it], (codes) =>
        `${codes.join(', ')} is still pending on the source Delivery Order — add it through "Add from Delivery Order" so the delivered quantity is tracked.`);
      if (shadow) return c.json(shadow, 409);
    }
  }

  const { data: maxNoRow } = await sb
    .from('sales_invoice_items')
    .select('line_no')
    .eq('sales_invoice_id', id)
    .order('line_no', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const nextLineNo = typeof (maxNoRow as { line_no?: number | null } | null)?.line_no === 'number'
    ? (maxNoRow as { line_no: number }).line_no + 1
    : null;
  const priceWarnings = await siPriceDriftWarnings(sb, [it]);

  const row = buildItemRow(id, it, nextLineNo);
  const { data, error } = await sb.from('sales_invoice_items').insert({ ...row, company_id: co.companyId }).select(ITEM).single();
  if (isDoLineOverInvoiced(error)) return c.json({ error: 'over_remaining', message: 'Add qty exceeds what is left to invoice on the linked Delivery Order line.', reason: error?.message }, 409);
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  await recomputePaid(sb, id);

  {
    const added = (data ?? {}) as unknown as Record<string, unknown>;
    const meta = await loadSiAuditMeta(sb, id);
    await recordEntityAudit(sb, {
      entityType: 'SALES_INVOICE',
      entityId: id,
      entityDocNo: meta.docNo,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: meta.companyId ?? activeCompanyId(c),
      statusSnapshot: meta.status,
      note: `Line added: ${String(added.item_code ?? it.itemCode ?? '')}`,
      fieldChanges: compactChanges(
        SI_LINE_AUDIT_FIELDS.map(([camel, snake]) => fieldChange(camel, null, added[snake] ?? null)),
      ),
    });
  }
  try {
    await resyncSiRevenue(sb, (header as { invoice_number: string }).invoice_number);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[si-revenue] post-add-line resync failed:', e); }
  await queueAcSiEdit(c, id, [], data?.id ? [String(data.id)] : []);
  return c.json(withPriceWarnings({ item: data }, priceWarnings), 201);
};
salesInvoices.post('/:id/items', appendSalesInvoiceItemHandler);

salesInvoices.patch('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  let siFromDoId: string | null = null;
  {
    const { data: hd } = await scopeToCompanyId(sb.from('sales_invoices').select('status, delivery_order_id').eq('id', id), co.companyId).maybeSingle();
    if (!hd) return c.json(NOT_THIS_COMPANY, 404);
    if (hd && ((hd as { status: string }).status ?? '').toUpperCase() === 'CANCELLED') {
      return c.json({ error: 'invoice_cancelled', message: 'This invoice is cancelled — reopen it before editing lines.' }, 409);
    }
    if (hd && isIssuedSi((hd as { status: string }).status)) {
      return c.json({ error: 'invoice_issued', message: SI_ISSUED_LINE_MESSAGE }, 409);
    }
    siFromDoId = (hd as { delivery_order_id?: string | null } | null)?.delivery_order_id ?? null;
  }

  if (it.itemCode !== undefined) {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  const { data: prevRow } = await scopeToCompanyId(sb.from('sales_invoice_items')
    .select(SI_LINE_AUDIT_SELECT + ', variants, do_item_id')
    .eq('id', itemId).eq('sales_invoice_id', id), co.companyId).maybeSingle();
  if (!prevRow) return c.json(NOT_THIS_COMPANY, 404);
  const prev = prevRow as unknown as Record<string, unknown>;

  const qty = it.qty !== undefined ? Number(it.qty) : Number(prev.qty);

  if (it.qty !== undefined && prev.do_item_id && qty > Number(prev.qty)) {
    const exclude = new Map<string, number>([[prev.do_item_id as string, Number(prev.qty)]]);
    const over = await checkSiOverRemaining(sb, [{ doItemId: prev.do_item_id, qty }], exclude);
    if (over) return c.json(over.body, over.status);
  }
  const unitPrice = it.unitPriceSen !== undefined ? Number(it.unitPriceSen) : Number(prev.unit_price_sen);
  const discount = it.discountSen !== undefined ? Number(it.discountSen) : Number(prev.discount_sen);
  const tax = it.taxSen !== undefined ? Number(it.taxSen) : Number(prev.tax_sen ?? 0);
  const unitCost = (canViewScmFinance(c) && it.unitCostSen !== undefined)
    ? Number(it.unitCostSen)
    : Number(prev.unit_cost_sen);
  const lineTotal = Math.max(0, (qty * unitPrice) - discount + tax);
  const lineCost = qty * unitCost;

  const updates: Record<string, unknown> = {
    qty, unit_price_sen: unitPrice, discount_sen: discount, tax_sen: tax, unit_cost_sen: unitCost,
    line_total_sen: lineTotal, line_cost_sen: lineCost, line_margin_sen: lineTotal - lineCost,
  };
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['itemGroup', 'item_group'], ['description', 'description'],
    ['uom', 'uom'], ['variants', 'variants'], ['notes', 'notes'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  {
    const effGroup = (it.itemGroup ?? prev.item_group) as string | null | undefined;
    const effVariants = (it.variants ?? prev.variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  {
    const storedLink = (prev as { do_item_id?: string | null }).do_item_id ?? null;
    const repoint = await unlinkedEditRefusal(sb, 'sales-invoice', { parentId: siFromDoId, storedLink, storedCode: (prev as { item_code?: string | null }).item_code ?? null, patchCode: it.itemCode });
    if (repoint) return c.json(repoint, 409);
    const drift = await assertLinkedLineItemsMatch(sb, 'delivery_order_items', [{ linkId: storedLink, itemCode: updates['item_code'] !== undefined ? updates['item_code'] : prev.item_code }], { source: 'Delivery Order line' });
    if (!drift.ok) return c.json(drift.body, drift.status);
  }

  const { error } = await scopeToCompanyId(sb.from('sales_invoice_items').update(updates).eq('id', itemId), co.companyId);
  if (isDoLineOverInvoiced(error)) return c.json({ error: 'over_remaining', message: 'New qty exceeds what is left to invoice on the linked Delivery Order line.', reason: error?.message }, 409);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);

  {
    const auditPatch: Record<string, unknown> = {};
    for (const [camel, snake] of SI_LINE_AUDIT_FIELDS) {
      if (updates[snake] !== undefined) auditPatch[camel] = updates[snake];
    }
    const lineChanges = diffFields(prev as unknown as Record<string, unknown>, auditPatch, SI_LINE_AUDIT_FIELDS);
    if (lineChanges.length > 0) {
      const meta = await loadSiAuditMeta(sb, id);
      await recordEntityAudit(sb, {
        entityType: 'SALES_INVOICE',
        entityId: id,
        entityDocNo: meta.docNo,
        action: 'UPDATE',
        actor: c.get('houzsUser'),
        companyId: meta.companyId ?? activeCompanyId(c),
        statusSnapshot: meta.status,
        note: `Line edited: ${String((prev as unknown as { item_code?: string | null }).item_code ?? itemId)}`,
        fieldChanges: lineChanges,
      });
    }
  }

  await recomputeTotals(sb, id);
  await recomputePaid(sb, id);
  try {
    const { data: h } = await sb.from('sales_invoices').select('invoice_number').eq('id', id).maybeSingle();
    if (h) await resyncSiRevenue(sb, (h as { invoice_number: string }).invoice_number);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[si-revenue] post-line-edit resync failed:', e); }
  await queueAcSiEdit(c, id);
  return c.json({ ok: true });
});

salesInvoices.delete('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  {
    const { data: hd } = await scopeToCompanyId(sb.from('sales_invoices').select('status').eq('id', id), co.companyId).maybeSingle();
    if (!hd) return c.json(NOT_THIS_COMPANY, 404);
    if (hd && ((hd as { status: string }).status ?? '').toUpperCase() === 'CANCELLED') {
      return c.json({ error: 'invoice_cancelled', message: 'This invoice is cancelled — reopen it before deleting lines.' }, 409);
    }
    if (hd && isIssuedSi((hd as { status: string }).status)) {
      return c.json({ error: 'invoice_issued', message: SI_ISSUED_LINE_MESSAGE }, 409);
    }
  }
  const { data: doomedRow } = await scopeToCompanyId(sb.from('sales_invoice_items')
    .select(SI_LINE_AUDIT_SELECT).eq('id', itemId).eq('sales_invoice_id', id), co.companyId).maybeSingle();
  if (!doomedRow) return c.json(NOT_THIS_COMPANY, 404);
  const doomed = doomedRow as unknown as Record<string, unknown>;

  const retire = await retiredLineOf(sb, 'sales_invoice_items', itemId);

  const { error } = await scopeToCompanyId(sb.from('sales_invoice_items').delete().eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);

  {
    const meta = await loadSiAuditMeta(sb, id);
    await recordEntityAudit(sb, {
      entityType: 'SALES_INVOICE',
      entityId: id,
      entityDocNo: meta.docNo,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: meta.companyId ?? activeCompanyId(c),
      statusSnapshot: meta.status,
      note: `Line removed: ${String(doomed.item_code ?? itemId)}`,
      fieldChanges: compactChanges(
        SI_LINE_AUDIT_FIELDS.map(([camel, snake]) => fieldChange(camel, doomed[snake] ?? null, null)),
      ),
    });
  }

  await recomputeTotals(sb, id);
  await recomputePaid(sb, id);
  try {
    const { data: h } = await sb.from('sales_invoices').select('invoice_number').eq('id', id).maybeSingle();
    if (h) await resyncSiRevenue(sb, (h as { invoice_number: string }).invoice_number);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[si-revenue] post-line-delete resync failed:', e); }
  await queueAcSiEdit(c, id, retire);
  return c.json({ ok: true });
});

salesInvoices.get('/:id/payments', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  {
    /* company-scope: the salesperson dimension returns false for a view-all tier,
       so on its own it is not tenancy — a director in company A could read B's
       payment ledger. Company first, for everyone. The payment rows carry the
       invoice id only, so the parent is the only place to check. */
    const { data: hdr } = await scopeToCompany(
      sb.from('sales_invoices').select('salesperson_id').eq('id', id), c,
    ).maybeSingle();
    if (!hdr) return c.json({ error: 'not_found' }, 404);
    const sp = (hdr as { salesperson_id?: number | string | null }).salesperson_id;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), sp)) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
  const { data, error } = await sb
    .from('sales_invoice_payments')
    .select(`${PAYMENT_COLS}, staff:collected_by ( name )`)
    .eq('sales_invoice_id', id)
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

export const postSalesInvoicePaymentHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  /* company-scope: money IN. Unscoped, a payment against company B's invoice was
     filed under company A and recomputePaid then moved B's paid_sen and AR
     status. Selecting company_id is not comparing it. */
  const { data: doc } = await scopeToCompany(
    sb.from('sales_invoices')
      .select('id, status, invoice_number, company_id, paid_sen').eq('id', id), c,
  ).maybeSingle();
  if (!doc) return c.json({ error: 'sales_invoice_not_found' }, 404);
  if ((doc as { status?: string }).status === 'CANCELLED') return c.json({ error: 'not_payable', message: 'SI is cancelled' }, 409);
  if ((doc as { status?: string }).status === 'DRAFT') return c.json({ error: 'not_payable', message: 'SI is a draft — confirm it before recording payments' }, 409);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = paymentCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  writesFromHere(c);
  const { data, error } = await insertSiPaymentRow(sb, {
    salesInvoiceId: id, companyId: activeCompanyId(c), paidAt: p.paidAt,
    method: p.method, merchantProvider: p.merchantProvider, installmentMonths: p.installmentMonths,
    onlineType: p.onlineType, approvalCode: p.approvalCode, amountSen: p.amountSen,
    accountSheet: p.accountSheet, collectedBy: p.collectedBy, note: p.note, createdBy: user.id,
  });
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  await recomputePaid(sb, id);
  await postUnpostedSiPayments(sb, id); // Accounting hook (需求书 6.3, owner approved 2026-08-16); best-effort
  try { await reconcileSiOverpay(sb, id); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[customer-credit] overpay reconcile failed (post):', e); }

  {
    const head = doc as { invoice_number?: string | null; company_id?: number | null; paid_sen?: number | null };
    const { data: after } = await sb.from('sales_invoices').select('paid_sen, status').eq('id', id).maybeSingle();
    const post = (after ?? null) as { paid_sen?: number | null; status?: string | null } | null;
    await recordEntityAudit(sb, {
      entityType: 'SALES_INVOICE',
      entityId: id,
      entityDocNo: head.invoice_number ?? null,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: head.company_id ?? activeCompanyId(c),
      statusSnapshot: post?.status ?? null,
      note: 'Payment recorded',
      fieldChanges: compactChanges([
        fieldChange('paidSen', Number(head.paid_sen ?? 0), post?.paid_sen ?? null),
        fieldChange('paymentAmountSen', null, p.amountSen),
        fieldChange('paymentMethod', null, p.method),
        fieldChange('paidAt', null, p.paidAt),
      ]),
    });
  }

  return c.json({ payment: data }, 201);
};
salesInvoices.post('/:id/payments', noWriteUntilMarked, postSalesInvoicePaymentHandler);

salesInvoices.delete('/:id/payments/:paymentId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const paymentId = c.req.param('paymentId');
  /* company-scope: through the parent invoice, BEFORE anything is read or
     destroyed. The doc-mismatch check below proves only that the payment belongs
     to the invoice in the URL, never whose invoice that is. */
  const { data: own, error: ownErr } = await scopeToCompany(sb.from('sales_invoices').select('id').eq('id', id), c).maybeSingle();
  if (ownErr) return c.json({ error: 'lookup_failed', reason: ownErr.message }, 500);
  if (!own) return c.json({ error: 'not_found' }, 404);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: row } = await scopeToCompanyId(sb.from('sales_invoice_payments')
    .select('sales_invoice_id, amount_sen, method, paid_at').eq('id', paymentId), co.companyId).maybeSingle();
  if (!row) return c.json(NOT_THIS_COMPANY, 404);
  const doomed = row as { sales_invoice_id: string; amount_sen?: number | null; method?: string | null; paid_at?: string | null };
  if (doomed.sales_invoice_id !== id) return c.json({ error: 'payment_doc_mismatch' }, 400);
  if (String(doomed.method ?? '').toLowerCase() === 'credit') {
    return c.json({
      error: 'credit_payment_not_deletable',
      message:
        'This payment was settled from the customer\'s credit balance, so removing it here would ' +
        'leave the credit spent and the invoice unpaid. Cancel the invoice instead — that returns ' +
        'the credit to the customer in one step.',
    }, 409);
  }
  const { data: inv } = await scopeToCompanyId(sb.from('sales_invoices').select('status, invoice_number, company_id, paid_sen').eq('id', id), co.companyId).maybeSingle();
  if (!inv) return c.json(NOT_THIS_COMPANY, 404);
  if ((inv as { status?: string } | null)?.status === 'CANCELLED') return c.json({ error: 'not_payable', message: 'SI is cancelled' }, 409);
  const { error } = await scopeToCompanyId(sb.from('sales_invoice_payments').delete().eq('id', paymentId), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  await recomputePaid(sb, id);
  // Accounting hook (需求书 6.3, owner approved 2026-08-16): void the deleted payment's entry; never-booked rows no-op.
  const unbooked = await reverseSiPayment(sb, paymentId, (inv as { invoice_number?: string | null } | null)?.invoice_number ?? null);
  // eslint-disable-next-line no-console
  if (!unbooked.ok) console.error('[acc] SI payment reversal failed:', paymentId, unbooked.status, unbooked.reason);
  /* Its receipt goes with it (owner 2026-10-29: 收据跟着付款改或作废) — a draft removed, a formal one cancelled and kept. */
  const receipt = await followPaymentRemoval(sb, {
    source: 'SIPAY', paymentId, companyId: co.companyId, actor: c.get('houzsUser')?.name ?? null,
    why: `Payment on ${(inv as { invoice_number?: string | null } | null)?.invoice_number ?? 'the invoice'} deleted`,
  }).catch((e: unknown) => ({ ok: false as const, reason: String(e) }));
  // eslint-disable-next-line no-console
  if (!receipt.ok) console.error('[receipts] receipt did not follow its deleted SI payment:', paymentId, receipt.reason);
  try { await reconcileSiOverpay(sb, id); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[customer-credit] overpay reconcile failed (delete):', e); }

  {
    const head = (inv ?? null) as { invoice_number?: string | null; company_id?: number | null; paid_sen?: number | null } | null;
    const { data: after } = await sb.from('sales_invoices').select('paid_sen, status').eq('id', id).maybeSingle();
    const post = (after ?? null) as { paid_sen?: number | null; status?: string | null } | null;
    await recordEntityAudit(sb, {
      entityType: 'SALES_INVOICE',
      entityId: id,
      entityDocNo: head?.invoice_number ?? null,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: head?.company_id ?? activeCompanyId(c),
      statusSnapshot: post?.status ?? null,
      note: 'Payment deleted',
      fieldChanges: compactChanges([
        fieldChange('paidSen', Number(head?.paid_sen ?? 0), post?.paid_sen ?? null),
        fieldChange('paymentAmountSen', Number(doomed.amount_sen ?? 0), null),
        fieldChange('paymentMethod', doomed.method ?? null, null),
        fieldChange('paidAt', doomed.paid_at ?? null, null),
        receipt.ok && receipt.touch ? fieldChange(receipt.touch.draft ? 'draftReceipt' : 'receipt', receipt.touch.from, null) : null,
      ]),
    });
  }

  return c.json({ ok: true });
});

export const patchSalesInvoiceStatusHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  let body: { status?: string }; try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.status) return c.json({ error: 'status_required' }, 400);

  const status = canonicalSiStatus(body.status);
  if (!status) {
    return c.json({ error: 'invalid_status', message: `"${body.status}" is not a recognised invoice status.` }, 400);
  }
  const now = new Date().toISOString();
  const ts: Record<string, string> = { updated_at: now };
  if (status === 'SENT') ts.sent_at = now;
  if (status === 'PAID') ts.paid_at = now;

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: curRow, error: curErr } = await scopeToCompanyId(sb.from('sales_invoices')
    .select('status, invoice_number, company_id, total_sen, paid_sen, so_doc_no').eq('id', id), co.companyId).maybeSingle();
  if (curErr) return c.json({ error: 'load_failed', reason: curErr.message }, 500);
  if (!curRow) return c.json(NOT_THIS_COMPANY, 404);
  const prevStatus = ((curRow as { status: string }).status ?? '').toUpperCase();
  const prevStoredStatus = (curRow as { status: string }).status;
  const auditDocNo = (curRow as { invoice_number?: string | null }).invoice_number ?? null;
  const auditCompanyId = (curRow as { company_id?: number | null }).company_id ?? activeCompanyId(c);

  const canonPrev = SI_STATUS_CANON[prevStatus];
  const allowedTargets = canonPrev ? SI_LEGAL_TRANSITIONS[canonPrev] : undefined;
  if (allowedTargets && canonPrev !== status && !allowedTargets.has(status)) {
    return c.json({
      error: 'invalid_transition',
      message: siTransitionReject(canonPrev as string, status),
      from: prevStatus, to: status,
    }, 409);
  }

  if ((status === 'PAID' || status === 'PARTIALLY_PAID') && canonPrev !== status && prevStatus !== 'DRAFT' && prevStatus !== 'CANCELLED') {
    const cur0 = curRow as { total_sen?: number | null; paid_sen?: number | null; so_doc_no?: string | null; company_id?: number | null };
    const dep = await readOrderDepositForInvoice(sb, { id, so_doc_no: cur0.so_doc_no ?? null, company_id: cur0.company_id ?? co.companyId });
    if (!dep.ok) return c.json({ error: 'load_failed', reason: dep.reason }, 503);
    const credited = await siCreditNotesSen(sb, cur0.company_id ?? co.companyId, id);
    if (credited === null) return c.json({ error: 'load_failed', reason: 'credit notes' }, 503);
    const settled = Number(cur0.paid_sen ?? 0) + (dep.deposit?.applied_sen ?? 0) + credited;
    const derived = siStatusFor(prevStatus, Number(cur0.total_sen ?? 0), settled);
    if (derived !== status) {
      return c.json({
        error: 'status_follows_money',
        message: status === 'PAID'
          ? 'This invoice is not paid in full yet. Record the payment and it turns Paid by itself.'
          : 'Part paid follows the payments recorded. Record the payment instead.',
        settledSen: settled, totalSen: Number(cur0.total_sen ?? 0),
      }, 409);
    }
  }

  if (prevStatus === 'DRAFT' && status !== 'CANCELLED') {
    if (status !== 'SENT') {
      return c.json({
        error: 'invalid_transition',
        message: `A draft invoice can only be confirmed (to SENT) or cancelled. Cannot move directly to ${status}.`,
        from: prevStatus, to: status,
      }, 409);
    }
    const { data: confirmed, error: cErr } = await scopeToCompanyId(sb.from('sales_invoices')
      .update({ status: 'SENT', sent_at: now, confirmed_at: now, updated_at: now })
      .eq('id', id), co.companyId).eq('status', 'DRAFT')
      .select('id, status, invoice_number, debtor_code, debtor_name, total_sen, paid_sen')
      .maybeSingle();
    if (cErr) return c.json({ error: 'update_failed', reason: cErr.message }, 500);
    if (!confirmed) return c.json({ salesInvoice: { id, status: 'SENT' } });
    const d = confirmed as { id: string; status: string; invoice_number: string; debtor_code: string | null; debtor_name: string | null; total_sen: number | null; paid_sen: number | null };

    const post = await postSiRevenue(sb, d.invoice_number);
    if (!post.ok && post.status !== 'zero_total' && post.status !== 'invoice_not_found') {
      // eslint-disable-next-line no-console
      console.error(`[si-revenue] confirm post failed for ${d.invoice_number}:`, post.status, (post as { reason?: string }).reason);
    }

    await recordEntityAudit(sb, {
      entityType: 'SALES_INVOICE',
      entityId: id,
      entityDocNo: d.invoice_number,
      action: 'POST',
      actor: c.get('houzsUser'),
      companyId: auditCompanyId,
      statusSnapshot: 'SENT',
      note: post.ok ? undefined : `AR/GL revenue post FAILED: ${post.status}`,
      fieldChanges: compactChanges([
        ...statusChange('DRAFT', 'SENT'),
        fieldChange('totalSen', null, Number(d.total_sen ?? 0)),
        fieldChange('paidSen', null, Number(d.paid_sen ?? 0)),
        fieldChange('revenuePosted', null, post.ok),
      ]),
    });

    if (d.debtor_code) {
      try {
        const { data: latest } = await sb.from('sales_invoices').select('total_sen, paid_sen').eq('id', id).maybeSingle();
        const total = Number((latest as { total_sen: number } | null)?.total_sen ?? 0);
        const paid  = Number((latest as { paid_sen: number } | null)?.paid_sen ?? 0);
        const res = await applyCustomerCreditToSi(sb, {
          debtorCode: d.debtor_code,
          debtorName: d.debtor_name,
          siId: id,
          siNumber: d.invoice_number,
          remainingDueSen: Math.max(0, total - paid),
          createdBy: c.get('user')?.id,
        });
        if (res.applied > 0) await recomputePaid(sb, id);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[customer-credit] apply-on-confirm failed for ${d.invoice_number}:`, e);
      }
    }
    return c.json({ salesInvoice: { id, status: 'SENT' } });
  }

  if (status === 'CANCELLED' && prevStatus === 'CANCELLED') {
    return c.json({ salesInvoice: { id, status: 'CANCELLED' } });
  }

  const isReopen = prevStatus === 'CANCELLED' && status !== 'CANCELLED';
  if (isReopen && status === 'SENT') {
    const over = await checkSiReopenOverRemaining(sb, id);
    if (over?.status === 503) return c.json(over.body, 503);
    if (over) {
      return c.json({
        error: 'over_remaining',
        message: 'Cannot reopen — the delivered quantity has since been invoiced elsewhere. The DO lines no longer have room for this invoice.',
        lines: over.body.lines,
      }, 409);
    }
  }

  let data: { id: string; status: string; invoice_number: string; paid_sen: number | null; debtor_code: string | null; debtor_name: string | null } | null;
  if (status === 'CANCELLED') {
    const { data: updated, error } = await scopeToCompanyId(sb.from('sales_invoices')
      .update({ status, ...ts })
      .eq('id', id), co.companyId).neq('status', 'CANCELLED')
      .select('id, status, invoice_number, paid_sen, debtor_code, debtor_name')
      .maybeSingle();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    if (!updated) {
      return c.json({ salesInvoice: { id, status: 'CANCELLED' } });
    }
    data = updated as typeof data;
  } else {
    const { data: updated, error } = await scopeToCompanyId(sb.from('sales_invoices')
      .update({ status, ...ts })
      .eq('id', id), co.companyId)
      .eq('status', prevStoredStatus)
      .select('id, status, invoice_number, paid_sen, debtor_code, debtor_name')
      .maybeSingle();
    if (isDoLineOverInvoiced(error)) {
      return c.json({ error: 'over_remaining', message: 'Cannot reopen — the delivered quantity has since been invoiced elsewhere. The DO lines no longer have room for this invoice.', reason: error?.message }, 409);
    }
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    if (!updated) return c.json({ error: 'status_changed', reason: 'This invoice just changed. Reload it and try again.' }, 409);
    data = updated as typeof data;
  }

  await recordEntityAudit(sb, {
    entityType: 'SALES_INVOICE',
    entityId: id,
    entityDocNo: (data as { invoice_number?: string | null } | null)?.invoice_number ?? auditDocNo,
    action: status === 'CANCELLED' ? 'CANCEL' : 'UPDATE',
    actor: c.get('houzsUser'),
    companyId: auditCompanyId,
    statusSnapshot: status,
    note: isReopen ? 'Invoice reopened' : undefined,
    fieldChanges: statusChange(prevStatus, status),
  });

  if (status === 'CANCELLED') {
    const d = data as { invoice_number: string; paid_sen: number | null; debtor_code: string | null; debtor_name: string | null };
    const rev = await reverseSiRevenue(sb, d.invoice_number);
    if (!rev.ok) {
      // eslint-disable-next-line no-console
      console.error(`[si-revenue] reversal failed for ${d.invoice_number}:`, rev.status, rev.reason);
    }
    /* The notes that closed this invoice's deposit invoices go with it: the
       deposits stand again until a new final invoice (docs/bugs/0831). */
    await releaseDepositInvoicesBestEffort(sb, {
      companyId: auditCompanyId ?? null, siId: id, siNumber: d.invoice_number,
      actor: String((c.get('houzsUser') as { name?: string } | undefined)?.name ?? '') || null,
    });
    await releaseSalesInvoiceKnockOffs(sb, { companyId: auditCompanyId ?? null, siId: id });

    await recordEntityAudit(sb, {
      entityType: 'SALES_INVOICE',
      entityId: id,
      entityDocNo: d.invoice_number,
      action: 'REVERSE',
      actor: c.get('houzsUser'),
      companyId: auditCompanyId,
      statusSnapshot: 'CANCELLED',
      note: rev.ok ? `AR/GL reversal: ${rev.status}` : `AR/GL reversal FAILED: ${rev.status} — ${rev.reason ?? 'no reason given'}`,
      fieldChanges: compactChanges([
        fieldChange('reversalOk', null, rev.ok),
        fieldChange('paidSenCredited', null, Number(d.paid_sen ?? 0)),
      ]),
    });
    if (Number(d.paid_sen ?? 0) > 0) {
      try {
        const user = c.get('user');
        await creditFromCancelledSi(sb, {
          siId: id,
          siNumber: d.invoice_number,
          debtorCode: d.debtor_code,
          debtorName: d.debtor_name,
          paidSen: Number(d.paid_sen),
          createdBy: user?.id,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[customer-credit] credit-from-cancel failed for ${d.invoice_number}:`, e);
      }
    }

    await enqueueCancel(sb, {
      companyId: co.companyId ?? activeCompanyId(c),
      docType: 'IV',
      docNo: d.invoice_number ?? id,
      docId: id,
      self: { table: 'sales_invoices', keyCol: 'id', key: id },
      createdBy: c.get('houzsUser')?.id ?? null,
    });
  }

  if (isReopen) {
    const d = data as { invoice_number: string; debtor_code: string | null; debtor_name: string | null };
    const post = await postSiRevenue(sb, d.invoice_number);
    if (!post.ok) {
      // eslint-disable-next-line no-console
      console.error(`[si-revenue] re-post on reopen failed for ${d.invoice_number}:`, post.status, (post as { reason?: string }).reason);
    }

    await recordEntityAudit(sb, {
      entityType: 'SALES_INVOICE',
      entityId: id,
      entityDocNo: d.invoice_number,
      action: 'POST',
      actor: c.get('houzsUser'),
      companyId: auditCompanyId,
      statusSnapshot: status,
      note: post.ok ? 'AR/GL revenue re-posted on reopen' : `AR/GL revenue re-post FAILED: ${post.status}`,
      fieldChanges: compactChanges([fieldChange('revenuePosted', null, post.ok)]),
    });

    try {
      const user = c.get('user');
      await reverseCancelledSiCredit(sb, {
        siId: id,
        siNumber: d.invoice_number,
        debtorCode: d.debtor_code,
        debtorName: d.debtor_name,
        createdBy: user?.id,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[customer-credit] reopen credit-reversal failed for ${d.invoice_number}:`, e);
    }
    try { await recomputePaid(sb, id); }
    catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[si-paid] reopen status recompute failed for ${d.invoice_number}:`, e);
    }
  }

  return c.json({ salesInvoice: data });
};
salesInvoices.patch('/:id/status', patchSalesInvoiceStatusHandler);

salesInvoices.patch('/:id/payment', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  let body: { amountSen?: number; notes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const amount = Number(body.amountSen ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'invalid_amount' }, 400);

  /* company-scope: the same money event as POST /:id/payments through the legacy
     quick-pay screen, so it gets the same gate. Unscoped it wrote a cash payment
     onto another company's invoice and rolled that invoice's paid status. */
  const { data: cur } = await scopeToCompany(
    sb.from('sales_invoices')
      .select('status, invoice_number, company_id, paid_sen').eq('id', id), c,
  ).maybeSingle();
  if (!cur) return c.json({ error: 'not_found' }, 404);
  if ((cur as { status: string }).status === 'CANCELLED') return c.json({ error: 'not_payable', message: 'SI is cancelled' }, 409);
  if ((cur as { status: string }).status === 'DRAFT') return c.json({ error: 'not_payable', message: 'SI is a draft — confirm it before recording payments' }, 409);

  const { error } = await sb.from('sales_invoice_payments').insert({
    company_id: activeCompanyId(c),
    sales_invoice_id: id,
    paid_at: todayMyt(),
    method: 'cash',
    amount_sen: amount,
    note: body.notes ?? null,
    created_by: user.id,
  });
  if (error) return c.json({ error: 'payment_failed', reason: error.message }, 500);
  await recomputePaid(sb, id);
  await postUnpostedSiPayments(sb, id); // Accounting hook (需求书 6.3): quick-pay returns no row, book by convergence
  try { await reconcileSiOverpay(sb, id); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[customer-credit] overpay reconcile failed (quick-pay):', e); }
  const { data } = await sb.from('sales_invoices').select('id, paid_sen, status').eq('id', id).maybeSingle();

  {
    const head = cur as { invoice_number?: string | null; company_id?: number | null; paid_sen?: number | null };
    const post = (data ?? null) as { paid_sen?: number | null; status?: string | null } | null;
    await recordEntityAudit(sb, {
      entityType: 'SALES_INVOICE',
      entityId: id,
      entityDocNo: head.invoice_number ?? null,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: head.company_id ?? activeCompanyId(c),
      statusSnapshot: post?.status ?? null,
      note: 'Payment recorded (quick pay)',
      fieldChanges: compactChanges([
        fieldChange('paidSen', Number(head.paid_sen ?? 0), post?.paid_sen ?? null),
        fieldChange('paymentAmountSen', null, amount),
        fieldChange('paymentMethod', null, 'cash'),
      ]),
    });
  }

  return c.json({ salesInvoice: data });
});
