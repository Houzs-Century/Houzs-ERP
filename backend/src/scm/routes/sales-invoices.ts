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
import { normalizePhone, buildVariantSummary, isServiceLine, fmtRM, computeVariantKey } from '../shared';
import { PAYMENT_METHOD_CODES } from '../shared/payment-methods';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  isCrossCompanySource, crossCompanyConversionBlocked,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { dateOrNull, coerceEmptyDates } from '../lib/date-coerce';
import { postUnpostedSiPayments, reverseSiPayment } from '../../acc/payments';
import { insertSiPaymentRow } from '../lib/si-payment-row';
import { ensureReceiptForPayment } from '../../acc/receipts';
import { recomputeSiPaid as recomputePaid, readOrderDepositForInvoice } from '../lib/si-order-deposit';
import { stampSoDates, stampDoNumber, stampOrderDeposit } from '../lib/si-list-stamps';
import { postSiRevenue, reverseSiRevenue, resyncSiRevenue } from '../lib/post-si-revenue';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { todayMyt } from '../lib/my-time';
import { resolveSalesScopeIds, salesDocOutOfScope } from '../lib/salesScope';
import { escapeForOr, phoneSearchOrParts } from '../lib/postgrest-search';
import { readStatusCounts } from '../lib/status-counts';
import { canViewAllSales, canViewScmFinance } from '../lib/houzs-perms';
import { SO_ITEM_FINANCE_KEYS } from '../lib/finance-keys';
import { doLineRemaining, doRemainingByItemId, checkSiOverRemaining, checkSiReopenOverRemaining, findOverInvoicedDoItems, resolveCandidateDoIds, custKeyOf, remainingUnavailableResponse, siTransferRefusal, type DoRemainingLine } from '../lib/do-line-remaining';
import { siShadowRefusal, unlinkedEditRefusal } from '../lib/unlinked-line-edit-guard';
import { resolveSiHeaderSources, resolveDoLineSources } from '../lib/source-po-trace';
import { validateItemCodes, unknownItemCodeResponse } from '../lib/validate-item-codes';
import { applyCustomerCreditToSi, creditFromCancelledSi, reverseCancelledSiCredit, reconcileSiOverpay } from '../lib/customer-credits';
import { recordEntityAudit, diffFields, compactChanges, fieldChange, statusChange } from '../lib/entity-audit';
import { SI_LINE_AUDIT_FIELDS, SI_LINE_AUDIT_SELECT } from '../lib/entity-audit-fields';
import { enqueueConvert, enqueueCancel, enqueueEdit, retiredLineOf, type AcRetiredLine } from '../lib/autocount-outbox';
import { recordSiAutoCountSource } from '../lib/si-autocount-source';
import { refuseMigratedSources } from '../lib/migrated-chain';

/* ERP -> AutoCount Sales Invoice edit. AutoCount calls it IV
   (AcSyncService.cs:443). See queueAcDoEdit for the shape. */
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

/* ── Audit trail (migration 0139 / lib/entity-audit) ───────────────────────────
   The action vocabulary is the shared six. How this module maps onto it:
     POST   — the invoice leaves DRAFT and revenue is posted to AR/GL.
     CANCEL — the status flips to CANCELLED (the document event).
     REVERSE— the AR/GL contra that follows a cancel (the LEDGER event). A
              separate row from the CANCEL for the same reason payment-vouchers
              keeps them apart: a cancel whose reversal FAILED must be
              distinguishable from one whose reversal landed.
     UPDATE — header edits, payments, and every other status transition.
   No DELETE: this module never hard-deletes an invoice. */

/* CREATE was added after the header/status/payment pass. Two things about it:

   It is recorded LATE — after the line insert and its compensating delete. Both
   create paths write the header first and delete it again if the lines fail, so
   a CREATE row emitted at insert time would describe an invoice that never
   existed and whose number was never used. recordSiCreate re-reads the persisted
   row rather than echoing the request body, which makes that ordering
   self-enforcing: a rolled-back header reads back as nothing and no row is
   written at all.

   It is recorded ONCE, before the branch that returns early for a DRAFT. The
   revenue post and the customer-credit auto-apply that follow are best-effort
   and never delete the header, so every remaining exit is a success — a second
   call on the non-draft path would be a duplicate, not extra coverage. */

/* The auditable header fields, camel (API) -> snake (column). Money is recorded
   as the INTEGER SEN it is stored as, never a formatted amount. */
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

/* The BEFORE half of every from->to pair the header PATCH records, plus the
   identity columns the audit row itself needs. */
const SI_AUDIT_SELECT =
  `id, invoice_number, status, company_id, ${SI_AUDIT_FIELDS.map(([, snake]) => snake).join(', ')}`;

/* The auditable LINE fields + the select that reads them back live in
   lib/entity-audit-fields (imported above), not here: the camelCase half is what
   AUDIT_FINANCE_FIELDS gates on, and a route file cannot be imported into a test
   without dragging Hono and the auth middleware along. See that file's header. */

/* The invoice's identity for an audit row written from a LINE handler, which has
   the line in hand but not the parent. Best-effort by design: the writer is
   fail-open, so an unresolved doc number costs the row its human key and nothing
   else. */
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

/**
 * Record the CREATE of an invoice that has SURVIVED its handler.
 *
 * Reads the row back rather than taking the caller's payload: the stored shape
 * is what a reader is being told about (the doc number was minted server-side,
 * the totals only exist after recomputeTotals), and a header that a compensating
 * branch already deleted reads back as nothing — so this cannot write a CREATE
 * row for an invoice that was rolled back.
 */
async function recordSiCreate(
  sb: Variables['supabase'],
  actor: Variables['houzsUser'],
  fallbackCompanyId: number | null | undefined,
  siId: string,
  lineCount: number,
  note?: string,
): Promise<void> {
  let row: Record<string, unknown> | null = null;
  try {
    const { data } = await sb.from('sales_invoices')
      .select('id, invoice_number, status, company_id, debtor_code, debtor_name, so_doc_no, ' +
        'delivery_order_id, invoice_date, due_date, currency, salesperson_id, total_sen, paid_sen')
      .eq('id', siId).maybeSingle();
    row = (data ?? null) as Record<string, unknown> | null;
  } catch { /* best-effort */ }
  if (!row) return; // rolled back (or unreadable): a CREATE row here would be a lie
  await recordEntityAudit(sb, {
    entityType: 'SALES_INVOICE',
    entityId: siId,
    entityDocNo: (row.invoice_number as string | null) ?? null,
    action: 'CREATE',
    actor,
    companyId: (row.company_id as number | null) ?? fallbackCompanyId,
    statusSnapshot: (row.status as string | null) ?? null,
    note,
    fieldChanges: compactChanges([
      fieldChange('status', null, row.status ?? null),
      fieldChange('debtorCode', null, row.debtor_code ?? null),
      fieldChange('debtorName', null, row.debtor_name ?? null),
      fieldChange('soDocNo', null, row.so_doc_no ?? null),
      fieldChange('deliveryOrderId', null, row.delivery_order_id ?? null),
      fieldChange('invoiceDate', null, row.invoice_date ?? null),
      fieldChange('dueDate', null, row.due_date ?? null),
      fieldChange('currency', null, row.currency ?? null),
      fieldChange('salespersonId', null, row.salesperson_id ?? null),
      /* INTEGER SEN, straight off the column. */
      fieldChange('totalSen', null, row.total_sen ?? null),
      fieldChange('lineCount', null, lineCount),
    ]),
  });
}

/* Full SI header — mirrors the editable DO header shape. */
const HEADER =
  'id, invoice_number, so_doc_no, delivery_order_id, debtor_code, debtor_name, ' +
  'invoice_date, due_date, customer_delivery_date, currency, ' +
  'subtotal_sen, discount_sen, tax_sen, total_sen, paid_sen, ' +
  'salesperson_id, agent, email, customer_type, building_type, branding, venue, venue_id, ref, ' +
  'customer_so_no, po_doc_no, sales_location, customer_state, customer_country, note, ' +
  'address1, address2, city, state, postcode, phone, ' +
  'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, ' +
  'mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen, service_sen, ' +
  'mattress_sofa_cost_sen, bedframe_cost_sen, accessories_cost_sen, others_cost_sen, service_cost_sen, ' +
  'local_total_sen, total_cost_sen, total_margin_sen, margin_pct_basis, line_count, ' +
  'status, notes, sent_at, paid_at, confirmed_at, created_at, created_by, updated_at';

/* FINANCE-GATED header keys — cost / margin / per-category revenue+cost
   subtotals. All are in HEADER (so they travel in the SI list payload) but must
   reach ONLY a finance-viewer (lib/houzs-perms.canViewScmFinance). Stripped from
   every row for a non-finance caller. Invoice totals shown to everyone
   (total_sen / local_total_sen / paid_sen) are NOT listed here. */
const SI_FINANCE_KEYS = [
  'mattress_sofa_sen', 'bedframe_sen', 'accessories_sen', 'others_sen', 'service_sen',
  'mattress_sofa_cost_sen', 'bedframe_cost_sen', 'accessories_cost_sen', 'others_cost_sen', 'service_cost_sen',
  'total_cost_sen', 'total_margin_sen', 'margin_pct_basis',
] as const;

/* Strip the finance keys from every row in place unless the caller may see
   finance. Applied to both the legacy and paginated list responses. */
function gateSiFinance(rows: unknown, showFinance: boolean): void {
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
  'unit_cost_sen, line_cost_sen, line_margin_sen, variants, notes, created_at';

/* KEPT LOCAL, deliberately — do NOT "converge" SI_FINANCE_KEYS onto
   SO_FINANCE_KEYS. It is the finance-shaped subset of THIS file's HEADER select.
   The SI carries service_sen / service_cost_sen (it invoices service lines)
   but NOT deposit_sen — a deposit is taken on the ORDER, not on the invoice,
   which is why SO_FINANCE_KEYS gates deposit and this list has nothing to gate.
   Importing the SO's list would make this gate depend on a vocabulary this
   document does not speak. The per-LINE keys ARE shared: byte-identical across
   all seven sales documents, so they live in lib/finance-keys
   (SO_ITEM_FINANCE_KEYS) and are imported above. */

const PAYMENT_COLS =
  'id, sales_invoice_id, paid_at, method, merchant_provider, installment_months, ' +
  'online_type, approval_code, amount_sen, account_sheet, collected_by, note, ' +
  'created_at, created_by';

const nextNum = async (sb: any, c: any): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'sales_invoices', 'invoice_number', `${p}SI-${yymm}`);
};

/* Re-derive the SI header's per-category revenue/cost totals + grand total from
   its line items. Mirrors the DO recomputeTotals plain per-category rollup. Also
   keeps subtotal_sen / total_sen in sync (they back the GL posting + the
   legacy payments path). Called after every item mutation.

   Fails CLOSED and never throws (2026-07-17) — same contract as the SO's
   recomputeTotals (mfg-sales-orders.ts), which carries the full rationale. Two
   separate decisions: (1) every read below aborts the whole recompute on error,
   because a header written from a read we cannot vouch for is a lie that looks
   like a fact, while a stale header is merely old and self-heals on the next
   successful edit; (2) it aborts by LOGGING, not throwing, because this roll-up
   only ever runs AFTER its triggering line write has already committed — a throw
   cannot undo that write, it can only turn it into a 500 the client retries,
   which on the create/add-line paths is a DUPLICATE LINE. See BUG-HISTORY
   2026-07-17 (fix/zeroing-twins). */
async function recomputeTotals(sb: any, salesInvoiceId: string) {
  const { data: items, error: itemsErr } = await sb.from('sales_invoice_items')
    .select('item_code, item_group, line_total_sen, line_cost_sen')
    .eq('sales_invoice_id', salesInvoiceId);
  /* A failed READ is not an empty invoice, and `?? []` cannot tell them apart:
     supabase-js resolves a failed select to { data: null, error } and does NOT
     throw, so a transient blip used to fold nothing and write subtotal_sen /
     total_sen / every category bucket to ZERO on an invoice whose lines were
     intact. total_sen backs the GL, and postSiRevenue treats a zero total as
     `zero_total` — a status its callers deliberately swallow — so the zeroing
     ALSO silently skipped the AR/revenue posting entirely. The ERROR is the
     signal, never the emptiness: a genuinely empty invoice (last line deleted)
     resolves error === null with data === [] and MUST still fall through to zero
     the header. */
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[si-recompute] item read failed — header left unchanged:', salesInvoiceId, itemsErr.message);
    return;
  }
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, service = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0, serviceCost = 0;
  for (const it of (items ?? []) as Array<{ item_code: string | null; item_group: string | null; line_total_sen: number | null; line_cost_sen: number | null }>) {
    const lineTotal = Number(it.line_total_sen ?? 0);
    const lineCost  = Number(it.line_cost_sen ?? 0);
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.item_group ?? '').toLowerCase();
    if (isServiceLine({ itemGroup: g, itemCode: it.item_code })) { service += lineTotal; serviceCost += lineCost; }
    else if (g.includes('mattress') || g.includes('sofa')) { mattressSofa += lineTotal; mattressSofaCost += lineCost; }
    else if (g.includes('bedframe')) { bedframe += lineTotal; bedframeCost += lineCost; }
    else if (g.includes('accessor')) { accessories += lineTotal; accessoriesCost += lineCost; }
    else { others += lineTotal; othersCost += lineCost; }
  }
  /* Fold any header-level discount/tax into the grand total. These columns are
     currently never written (all discount/tax is per-line, already inside
     line_total_sen), so this is a no-op today — but it stops a future
     header-discount UI that populates them from silently overstating the posted
     revenue (total_sen backs the GL). subtotal_sen stays the line sum. */
  const { data: siHdr, error: hdrErr } = await sb.from('sales_invoices')
    .select('discount_sen, tax_sen').eq('id', salesInvoiceId).maybeSingle();
  /* A failed read here reads as "no header discount/tax" and would write a
     total that silently ignores both. A header that genuinely carries neither
     is error === null with nulls, and still legitimately folds in zero. */
  if (hdrErr) {
    /* eslint-disable-next-line no-console */
    console.error('[si-recompute] header discount/tax read failed — header left unchanged:', salesInvoiceId, hdrErr.message);
    return;
  }
  const headerDiscount = Math.max(0, Number(siHdr?.discount_sen ?? 0));
  const headerTax = Math.max(0, Number(siHdr?.tax_sen ?? 0));
  const grand = Math.max(0, total - headerDiscount + headerTax);
  const margin = grand - totalCost;
  const { error: updErr } = await sb.from('sales_invoices').update({
    mattress_sofa_sen: mattressSofa,
    bedframe_sen: bedframe,
    accessories_sen: accessories,
    others_sen: others,
    service_sen: service,
    mattress_sofa_cost_sen: mattressSofaCost,
    bedframe_cost_sen: bedframeCost,
    accessories_cost_sen: accessoriesCost,
    others_cost_sen: othersCost,
    service_cost_sen: serviceCost,
    local_total_sen: grand,
    total_cost_sen: totalCost,
    total_margin_sen: margin,
    margin_pct_basis: grand > 0 ? Math.round((margin / grand) * 10000) : 0,
    line_count: (items ?? []).length,
    subtotal_sen: total,
    total_sen: grand,
    updated_at: new Date().toISOString(),
  }).eq('id', salesInvoiceId);
  /* The write's own result was discarded until 2026-07-17, so a rejected UPDATE
     left the header STALE with nothing logged and every caller reporting
     success. Logged, not thrown: see the contract note on this function. */
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[si-recompute] header update failed — totals left STALE:', salesInvoiceId, updErr.message);
  }
}

/* Build one sales_invoice_items insert row from a client line payload. */
function buildItemRow(salesInvoiceId: string, it: Record<string, unknown>, lineNo?: number | null) {
  const qty = Number(it.qty ?? 1);
  const unitPrice = Number(it.unitPriceSen ?? 0);
  const discount = Number(it.discountSen ?? 0);
  const tax = Number(it.taxSen ?? 0);
  const unitCost = Number(it.unitCostSen ?? 0);
  /* Clamp at 0 — the operator's screen already does (SalesInvoiceNew.tsx:250-252
     computes Math.max(0, qty*price − disc) per line). Without the clamp a line
     whose discount exceeds its gross recorded a NEGATIVE total: the operator saw
     one grand total on screen and the invoice persisted a lower one, because
     recomputeTotals sums the raw line totals and only clamps the GRAND total.
     Tax is inside the clamp so the two sides stay byte-identical (tax is 0 on
     every one of the owner's invoices; it is carried, not used). */
  const lineTotal = Math.max(0, (qty * unitPrice) - discount + tax);
  const lineCost = qty * unitCost;
  const itemGroup = (it.itemGroup as string) ?? null;
  const variants = (it.variants as unknown) ?? null;
  return {
    sales_invoice_id: salesInvoiceId,
    so_item_id: (it.soItemId as string | undefined) ?? null,
    do_item_id: (it.doItemId as string | undefined) ?? null,
    item_code: it.itemCode,
    item_group: itemGroup,
    description: (it.description as string) ?? null,
    description2: buildVariantSummary(String(itemGroup ?? ''), (variants as Record<string, unknown> | null) ?? null) || (it.description2 as string) || null,
    uom: (it.uom as string) ?? 'UNIT',
    qty,
    unit_price_sen: unitPrice,
    discount_sen: discount,
    tax_sen: tax,
    line_total_sen: lineTotal,
    unit_cost_sen: unitCost,
    line_cost_sen: lineCost,
    line_margin_sen: lineTotal - lineCost,
    variants,
    /* Migration 0058 — carry the dedicated variant-breakdown columns onto the SI
       line (sales_invoice_items has all 8). Source is the convert payload `it`. */
    gap_inches: (it.gapInches as number | null) ?? null,
    divan_height_inches: (it.divanHeightInches as number | null) ?? null,
    divan_price_sen: Number(it.divanPriceSen ?? 0),
    leg_height_inches: (it.legHeightInches as number | null) ?? null,
    leg_price_sen: Number(it.legPriceSen ?? 0),
    custom_specials: (it.customSpecials as unknown) ?? null,
    line_suffix: (it.lineSuffix as string | null) ?? null,
    special_order_price_sen: Number(it.specialOrderPriceSen ?? 0),
    notes: (it.notes as string) ?? null,
    ...(typeof lineNo === 'number' ? { line_no: lineNo } : {}),
  };
}

/* The migrated refusal for every path that can attach a DELIVERY to an invoice.
   `/from-dos` resolves its own delivery ids and calls refuseMigratedSources
   directly; the rest arrive holding either a do_item_id (POST /, POST
   /:id/items) or a delivery id (POST /:id/items/from-do/:doId), so the delivery
   has to be resolved before the rule can be applied. One rule behind all four
   doors — a caller cannot pick a softer one.

   A FAILED LOOKUP IS NOT A PASS. `ok: false` makes the caller refuse rather
   than proceed blind; what it would otherwise let through is revenue booked a
   second time for a sale AutoCount already invoiced. */
async function migratedRefusalForDeliveries(
  sb: any,
  opts: { doItemIds?: Array<string | null | undefined>; doIds?: Array<string | null | undefined> },
): Promise<
  | { ok: true; refusal: { error: string; message: string; docNumbers: string[] } | null }
  | { ok: false; reason: string }
> {
  const itemIds = [...new Set((opts.doItemIds ?? []).filter((x): x is string => typeof x === 'string' && x.length > 0))];
  const headIds = new Set((opts.doIds ?? []).filter((x): x is string => typeof x === 'string' && x.length > 0));
  if (itemIds.length > 0) {
    const { data, error } = await sb.from('delivery_order_items')
      .select('delivery_order_id').in('id', itemIds);
    if (error) return { ok: false, reason: error.message };
    for (const r of (data ?? []) as Array<{ delivery_order_id: string | null }>) {
      if (r.delivery_order_id) headIds.add(r.delivery_order_id);
    }
  }
  if (headIds.size === 0) return { ok: true, refusal: null };
  const { data, error } = await sb.from('delivery_orders')
    .select('do_number, migrated_no_stock').in('id', [...headIds]);
  if (error) return { ok: false, reason: error.message };
  return {
    ok: true,
    refusal: refuseMigratedSources(
      ((data ?? []) as Array<{ do_number: string; migrated_no_stock: boolean | null }>)
        .map((r) => ({ docNo: r.do_number, migrated: r.migrated_no_stock === true })),
    ),
  };
}

/* FIX 3's shadow check now lives in unlinked-line-edit-guard (siShadowRefusal),
   shared with the line PATCH that had no check at all. */

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
    /* An agreed price of 0 has no ratio to drift from (and a free/gift line is a
       real thing here) — nothing to say about it. */
    if (!(ordered > 0) || !Number.isFinite(invoiced)) continue;
    if (Math.abs(invoiced - ordered) / ordered <= SI_PRICE_DRIFT_THRESHOLD) continue;
    out.push({ itemCode: String(l.itemCode ?? src.item_code ?? ''), invoicedSen: invoiced, orderedSen: ordered });
  }
  return out;
}

/* One plain sentence an operator can act on. Built server-side so EVERY caller
   gets the warning in words — the un-repointed 2990 POS/admin app consumes these
   same APIs and cannot be taught to compose this. fmtRM is the system-wide sole
   money formatter (shared/format.ts); whole-ringgit is fine because anything
   under the 0.5% gate is invisible at that precision anyway. */
function siPriceWarningMessage(warnings: SiPriceWarning[]): string {
  const parts = warnings.map(
    (w) => `${w.itemCode} is invoiced at ${fmtRM(w.invoicedSen / 100)} but the order price is ${fmtRM(w.orderedSen / 100)}`,
  );
  return `${parts.join('; ')}. Check the price before sending this invoice.`;
}

/* Attach the warning to a success response. Adds NOTHING when there is no drift,
   so the response stays byte-identical on the happy path and no existing
   consumer sees a new key it did not ask for. */
function withPriceWarnings<T extends object>(res: T, warnings: SiPriceWarning[]) {
  return warnings.length === 0
    ? res
    : { ...res, priceWarnings: warnings, priceWarningMessage: siPriceWarningMessage(warnings) };
}

/* Filter-pill bucket → the raw sales_invoices.status values it covers. Single
   source of truth for the status-count queries AND the list `status` filter; the
   FE sends the BUCKET NAME (a raw DB status still works). EVERY VALUE IS AN ENUM
   MEMBER AND EVERY MEMBER IS IN A BUCKET — a non-member 500s the tab and used to
   zero its count; a member in no bucket is a row in no tab. Pinned, with the
   2026-08-17 prod evidence, by tests/statusBucketsEnumMembership.test.mjs: ISSUED / PARTIAL / COMPLETED
   were never members (INPUT-only via SI_STATUS_CANON), OVERDUE was bucketless and joins `sent`, as the FE did. */
const SI_STATUS_BUCKETS: Record<string, string[]> = {
  sent: ['DRAFT', 'SENT', 'OVERDUE'],
  partial: ['PARTIALLY_PAID'],
  paid: ['PAID'],
  cancelled: ['CANCELLED'],
};

/* ── Canonical SI status set + legal /status transitions (fix/si-cancel-revenue-qty) ──
   The PATCH /:id/status write path persists ONLY the canonical UPPER-CASE values
   below; any lowercase or aliased input ('cancelled', 'issued', 'partial',
   'completed', US 'canceled') is folded to its canonical form so it can NEVER be
   written verbatim. This is what killed the "lowercase cancelled skips the revenue
   reversal" bug: the reversal is gated on `status === 'CANCELLED'`, and a verbatim
   'cancelled' slipped straight past it. */
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

/* ── ISSUED = the document is in the customer's hands ──────────────────────
   An SI leaves DRAFT at exactly the moment postSiRevenue books Dr AR / Cr Sales
   and the operator prints/sends the PDF. So "issued" is every status EXCEPT
   DRAFT — CANCELLED is frozen on its own terms and always was, so it is not
   "issued", it is simply dead.

   The line falls here and NOT at PAID on purpose: PAID is far too late. The
   SENT → PARTIALLY_PAID window is most of an invoice's life and is exactly when
   the customer is holding the PDF deciding what to pay, which is the window the
   harm lives in. An UNRECOGNISED status counts as issued (fail closed): the
   only cost is that the operator must cancel/reopen to edit it, whereas the
   cost of guessing wrong the other way is a silently mutated customer invoice.
   That does not brick a legacy row — SI_LEGAL_TRANSITIONS still fails OPEN, so
   cancel/reopen stays available to unfreeze it. */
const isIssuedSi = (raw: string | null | undefined): boolean => {
  const s = (raw ?? '').trim().toUpperCase();
  return s !== 'DRAFT' && s !== 'CANCELLED';
};

/* Header fields FROZEN once the invoice is issued → the plain-English name used
   in the rejection. These four are the money and the identity of the document
   the customer is holding; every other header field (phone, email, address,
   agent, venue, remarks…) stays editable forever, because correcting a typo'd
   phone number on a 3-month-old invoice is a real workflow and changes neither
   what is owed nor the GL.

   invoice_date earns its place here: post-si-revenue fixes the JE's entry_date
   from invoice_date at post time, and resyncSiRevenue compares only the TOTAL —
   so moving an issued invoice's date silently strands its JE in the original
   period. Freezing the date is the gate that makes the resync's total-only
   comparison correct BY CONSTRUCTION (the resync mechanic itself is the owner's
   2026-06-01 void+repost ruling and is deliberately untouched). A DRAFT may
   still move its date freely — it has no JE yet, and resyncSiRevenue
   short-circuits on DRAFT. */
const SI_ISSUED_FROZEN_FIELDS: Record<string, string> = {
  invoiceDate: 'invoice date',
  currency:    'currency',
  debtorName:  'customer name',
  debtorCode:  'customer code',
};

/* LINES are frozen WHOLESALE on an issued invoice — not field-by-field like the
   header above. The asymmetry is deliberate: a header carries genuinely neutral
   fields (a phone number, a delivery note) worth keeping editable for years,
   whereas every field on a line either IS the money (qty / price / discount) or
   is the customer-facing description of what the money bought. Freezing the set
   also matches the sibling documents, whose lock gates line add/remove wholesale
   (DeliveryOrderDetail / ConsignmentNoteDetail `canRemove={!isLocked}`).
   Cancel → fix → reopen is the sanctioned correction path and is already
   first-class here (it re-derives revenue, credit and paid status). */
const SI_ISSUED_LINE_MESSAGE =
  'This invoice has already been issued to the customer, so its items can no longer be changed. Cancel the invoice and reopen it if it is wrong.';

/* Legal transitions between canonical states (the SINGLE transition authority for
   PATCH /:id/status). Self-transitions (X→X) are always allowed (idempotent) and
   handled by the specific branches below. Rules:
     - DRAFT confirms to SENT (posts revenue) or cancels.
     - A CANCELLED invoice may only REOPEN to SENT; its payment status is then
       re-derived from the ledger.
     - An active invoice may take any payment-derived state or be cancelled.
     - NOTHING moves back to DRAFT (draft is a create-only state).
   An unrecognised PERSISTED status fails open (never brick a legacy row). */
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

// ── List ────────────────────────────────────────────────────────────────
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
async function stampSourcePos(sb: any, rows: unknown): Promise<void> {
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
    // Shipped (at least partly) from a PO-less stock ADJUSTMENT lot — the UI
    // renders "STOCK ADJ" instead of a blank cell (owner: never a dash on
    // delivered goods).
    r.source_adj = (trace?.adjQty ?? 0) > 0;
  }
}

salesInvoices.get('/', async (c) => {
  const sb = c.get('supabase');
  // Row-level "own / downline chain" scope (scm.staff uuids) — see lib/salesScope.ts.
  // Pass the REAL Houzs user id, NOT user.id (bridge-pinned staff uuid — was the non-admin 500).
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  /* Opt-in server-side pagination + search + sort + status-counts (mirrors the
     SO list in mfg-sales-orders.ts). The PRESENCE of `page` switches paging on;
     when it is absent/empty the query below is BYTE-IDENTICAL to the historical
     behavior (order invoice_date desc, limit 500, status param, scope + company,
     `{ salesInvoices }` shape). */
  const pageRaw = c.req.query('page');
  const paginate = pageRaw !== undefined && pageRaw !== '';

  if (!paginate) {
    /* --- LEGACY PATH (unchanged) --- */
    let q = sb.from('sales_invoices').select(HEADER).order('invoice_date', { ascending: false }).limit(500);
    if (scopeIds) q = q.in('salesperson_id', scopeIds);
    const status = c.req.query('status'); if (status) q = q.eq('status', status);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    const { data, error } = await q;
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    await stampSoDates(sb, data);
    await stampDoNumber(sb, data);
    await stampSourcePos(sb, data);
    await stampOrderDeposit(sb, data, activeCompanyId(c) ?? null);
    gateSiFinance(data, canViewScmFinance(c));
    return c.json({ salesInvoices: data ?? [] });
  }

  /* --- PAGINATED PATH (opt-in via `page`) --- */
  const page = Math.max(0, Math.trunc(Number(pageRaw)) || 0);
  const psRaw = Number(c.req.query('pageSize'));
  const pageSize = Number.isFinite(psRaw) && psRaw > 0 ? Math.min(100, Math.max(1, Math.trunc(psRaw))) : 50;

  const SORT_COLS = new Set(['invoice_date', 'invoice_number', 'debtor_name', 'status', 'total_sen']);
  const [rawCol, rawDir] = (c.req.query('sort') ?? 'invoice_date:desc').split(':');
  const sortCol = SORT_COLS.has(rawCol) ? rawCol : 'invoice_date';
  const sortAsc = rawDir === 'asc';

  let q = sb.from('sales_invoices').select(HEADER, { count: 'exact' }).order(sortCol, { ascending: sortAsc });
  /* unique tiebreaker so range paging can't skip/repeat rows sharing the sort key */
  if (sortCol !== 'invoice_number') q = q.order('invoice_number', { ascending: sortAsc });
  if (scopeIds) q = q.in('salesperson_id', scopeIds);
  /* Resolve the incoming `status`: a known bucket key → all its raw statuses;
     'all'/empty → no filter; otherwise treat it as a raw DB status. */
  const status = c.req.query('status');
  if (status && status !== 'all') {
    if (SI_STATUS_BUCKETS[status]) q = q.in('status', SI_STATUS_BUCKETS[status]);
    else q = q.eq('status', status);
  }
  q = scopeToCompany(q, c); // multi-company: isolate to the active company
  /* free-text search over the base-table columns the FE list's client-side
     search matches (SalesInvoicesListV2 hay). */
  const search = c.req.query('q');
  if (search) {
    const s = escapeForOr(search);
    // Match customer NAME (debtor_name), PHONE, and the linked SO REFERENCE
    // (ref, snapshotted onto the SI) — plus the doc numbers it already covered.
    if (s) q = q.or([
      `invoice_number.ilike.%${s}%`, `so_doc_no.ilike.%${s}%`, `debtor_name.ilike.%${s}%`,
      `debtor_code.ilike.%${s}%`, `ref.ilike.%${s}%`, `branding.ilike.%${s}%`, `sales_location.ilike.%${s}%`,
      ...phoneSearchOrParts(s, search, normalizePhone),
    ].join(','));
  }
  const from = c.req.query('from'); if (from) q = q.gte('invoice_date', from);
  const to = c.req.query('to'); if (to) q = q.lte('invoice_date', to);
  q = q.range(page * pageSize, page * pageSize + pageSize - 1);
  const { data, error, count } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const total = count ?? (data?.length ?? 0);

  /* Status counts mirror the FE filter-pill buckets (sent / partial / paid /
     cancelled) over the SAME scope + company filters but WITHOUT status /
     search / pagination. */
  const countBase = () => {
    let cq = sb.from('sales_invoices').select('*', { count: 'exact', head: true });
    if (scopeIds) cq = cq.in('salesperson_id', scopeIds);
    cq = scopeToCompany(cq, c);
    return cq;
  };
  const [allC, sentC, partialC, paidC, cancelledC] = await Promise.all([
    countBase(),
    countBase().in('status', SI_STATUS_BUCKETS.sent),
    countBase().in('status', SI_STATUS_BUCKETS.partial),
    countBase().in('status', SI_STATUS_BUCKETS.paid),
    countBase().in('status', SI_STATUS_BUCKETS.cancelled),
  ]);
  // A count that could not be READ is reported, never served as 0; an empty bucket still answers 0 (lib/status-counts.ts).
  const counted = readStatusCounts({ all: allC, sent: sentC, partial: partialC, paid: paidC, cancelled: cancelledC });
  if (!counted.ok) return c.json({ error: 'status_counts_failed', reason: counted.reason }, 500);
  const statusCounts = counted.counts;

  await stampSoDates(sb, data);
  await stampDoNumber(sb, data);
  await stampSourcePos(sb, data);
  await stampOrderDeposit(sb, data, activeCompanyId(c) ?? null);
  gateSiFinance(data, canViewScmFinance(c));
  return c.json({ salesInvoices: data ?? [], total, page, pageSize, statusCounts });
});

// ── Invoiceable DO lines (line-level partial-invoice picker) ──────────────
/* STATIC path MUST be registered BEFORE the `/:id` param route below. */
salesInvoices.get('/invoiceable-do-lines', async (c) => {
  const sb = c.get('supabase');
  // Company scope (owner 2026-08-10 audit) — without it the no-doIds path
  // enumerated every company's delivery orders into this picker.
  const candidates = await resolveCandidateDoIds(sb, c.req.query('doIds'), activeCompanyId(c), 'invoiceable');
  // NOT `{ lines: [] }` — an empty picker claims every delivered line is already
  // invoiced, and a failed read may not make that claim. Refuse to render.
  if (!candidates.ok) return c.json({ error: 'load_failed', reason: candidates.reason }, 500);
  if (candidates.doIds.length === 0) return c.json({ lines: [] });
  const remaining = await doLineRemaining(sb, candidates.doIds, 'invoiceable');
  if (!remaining.ok) return c.json({ error: 'load_failed', reason: remaining.reason }, 500);
  const lines = [...remaining.lines.values()].filter((l) => l.remaining > 0);
  return c.json({ lines });
});

// ── Detail ──────────────────────────────────────────────────────────────
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
  /* Own/downline sales scope (lib/salesScope.ts) — mirror the SO detail
     (mfg-sales-orders.ts). A scoped seller must not read another
     salesperson's invoice/finance by enumerating ids; an out-of-scope id
     answers 404, indistinguishable from a missing one. Directors/view-all
     bypass. HEADER carries salesperson_id already. */
  {
    const sp = (h.data as { salesperson_id?: number | string | null }).salesperson_id;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), sp)) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
  /* Finance gate — the DETAIL leaks cost/margin the same way the list did before
     gateSiFinance, so strip the header's SI_FINANCE_KEYS + every line's
     cost/margin for a non-finance caller (canViewScmFinance fails closed).
     Critical now that a scoped salesperson can open their own invoices
     (readInheritsFrom scm.sales.orders): they see the customer-facing invoice
     but never cost or margin. */
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
  /* The deposit taken on the ORDER this invoice came from (lib/si-order-deposit).
     Served BESIDE paid_sen, never folded into it: the two are different money
     arriving on different documents, and the screen has to be able to say which
     one took it. `orderDepositUnavailable` is the honest third answer — an
     invoice whose order we could not read is not an invoice with no deposit, and
     the screen must say so rather than quietly re-inventing the chase this
     endpoint exists to stop. NOT finance-gated: this is what the customer paid,
     the same class as total_sen / paid_sen, not cost or margin. */
  const dep = await readOrderDepositForInvoice(sb, {
    id,
    so_doc_no: (h.data as { so_doc_no?: string | null }).so_doc_no ?? null,
    company_id: (h.data as { company_id?: number | null }).company_id ?? activeCompanyId(c),
  });
  /* ONE field name for the applied amount across every surface —
     `so_deposit_applied_sen`, the same key the LIST rows are stamped with
     (lib/si-list-stamps). The detail additionally gets the `orderDeposit`
     object because only this screen draws the per-transaction panel; every
     screen that just needs the number reads the scalar, so no surface has to
     know two shapes. `null` means "not known" and every reader treats it as no
     deposit, which renders the LARGER outstanding. */
  (h.data as unknown as Record<string, unknown>).so_deposit_applied_sen =
    dep.ok ? (dep.deposit?.applied_sen ?? 0) : null;
  return c.json({
    salesInvoice: h.data,
    items,
    orderDeposit: dep.ok ? dep.deposit : null,
    orderDepositUnavailable: !dep.ok,
  });
});

// ── Create ──────────────────────────────────────────────────────────────
// Exported for the tests: supabaseAuth cannot run in the vitest harness.
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

  /* A delivery carried over from AutoCount is invoiced by the migrated-invoice
     converter, never by hand — see lib/migrated-chain.ts. Checked HERE as well
     as on /from-dos because this path reaches the same delivery lines through
     `deliveryOrderId` or a line's `doItemId`, and would otherwise be the open
     gate beside the fence: AutoCount already booked this revenue. */
  {
    const mig = await migratedRefusalForDeliveries(sb, {
      doItemIds: items.map((it) => it.doItemId as string | undefined),
      doIds: [(body.deliveryOrderId as string | undefined) ?? null],
    });
    if (!mig.ok) return c.json({ error: 'load_failed', reason: mig.reason }, 500);
    if (mig.refusal) return c.json(mig.refusal, 409);
  }

  /* FIX 3 — this SI declares a source DO, so its DO-derived lines must stay
     linked. Block any unlinked line that shadows a still-Pending DO line (dropping
     the link would let the same delivered goods be invoiced twice). */
  {
    const fromDoId = (body.deliveryOrderId as string | undefined) ?? null;
    if (fromDoId) {
      const shadow = await siShadowRefusal(sb, fromDoId, items, (codes) =>
        `These items are still pending on the source Delivery Order and must be added through "Add from Delivery Order" so the delivered quantity is tracked: ${codes.join(', ')}.`);
      if (shadow) return c.json(shadow, 409);
    }
  }

  /* CROSS-COMPANY GUARD — this create path stamps the ACTIVE company on the new
     invoice, so invoicing another company's SO or DO here would post that
     company's revenue, AR and commission onto the active company's books.
     Checks BOTH declared sources: an SI can be raised from an SO directly or
     from a DO (which itself may legitimately be a 2990 DO, since the
     Delivery-Planning converter correctly inherits the source company). */
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

  /* Price-vs-order drift — a WARNING carried back in the response, NEVER a
     rejection (see siPriceDriftWarnings). Computed here so the operator hears
     about a fat-fingered price on the same round-trip that creates the invoice,
     while it is still a draft they can fix. */
  const priceWarnings = await siPriceDriftWarnings(sb, items);

  const phoneRaw = (body.phone as string | undefined) ?? null;
  const emPhoneRaw = (body.emergencyContactPhone as string | undefined) ?? null;
  const nowIso = new Date().toISOString();

  /* DRAFT flow (mirror SO mfg-sales-orders.ts:3072) — opt-in `asDraft` lands the
     invoice as DRAFT. A DRAFT SI commits NOTHING: no AR/GL revenue, no customer
     credit. It also leaves sent_at / confirmed_at NULL (stamped on confirm).
     The confirm transition (PATCH /:id/status DRAFT→SENT) does the posting. */
  const isDraft = (body as { asDraft?: unknown }).asDraft === true;

  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; invoice_number: string; debtor_code: string | null; debtor_name: string | null; total_sen: number | null; paid_sen: number | null }>(
    () => nextNum(sb, c),
    (invoiceNumber) => sb.from('sales_invoices').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
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
    if (iErr) { await sb.from('sales_invoices').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }

  /* Race-condition guard — the SI counterpart of "Edge #E" in
     delivery-orders-mfg.ts. checkSiOverRemaining above is read-before-write, so
     two invoices raised against the same delivered goods at the same moment can
     both pass and bill the customer twice for one delivery. After inserting,
     re-derive remaining for the picked DO lines and ROLL BACK when any has gone
     negative.

     SO -> DO, PO -> GRN and GRN -> PI all close this already; DO -> SI was the
     one conversion without it. */
  {
    const pickedDoItemIds = rows
      .map((r) => (r as { do_item_id?: string | null }).do_item_id)
      .filter((x): x is string => !!x);
    if (pickedDoItemIds.length > 0) {
      const recheck = await doRemainingByItemId(sb, pickedDoItemIds, 'invoiceable');
      /* Recheck unreadable -> roll back, and never under the race message.
         lib/do-line-remaining.ts's header argues the trade-off in full. */
      if (!recheck.ok) {
        await sb.from('sales_invoice_items').delete().eq('sales_invoice_id', h.id);
        await sb.from('sales_invoices').delete().eq('id', h.id);
        return c.json(remainingUnavailableResponse(recheck.reason), 503);
      }
      const over = findOverInvoicedDoItems(pickedDoItemIds, recheck.remaining);
      if (over.length > 0) {
        // Undo: lines then header. Nothing else has happened yet — revenue is
        // posted further down, so there is no ledger entry to reverse.
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

  /* The invoice has survived the only branch that could undo it. Everything
     below (revenue post, credit auto-apply) is best-effort and never deletes the
     header, so from here every exit is a success and this CREATE row is true.
     Written before the DRAFT early-return so both statuses record exactly one. */
  await recordSiCreate(sb, c.get('houzsUser'), activeCompanyId(c), h.id, items.length);

  /* ERP -> AutoCount DO->Invoice, or a written-down reason why not. This used
     to be an unconditional recordParentlessCreate claiming "no source Delivery
     Order" — a fact it never checked, while this very handler accepts
     `deliveryOrderId` and a per-line `doItemId` and the desktop from-DO flow
     sends both. lib/si-autocount-source decides it from what was WRITTEN.
     Placed BEFORE the DRAFT early return so a draft and a posted invoice each
     record exactly one row, in step with recordSiCreate directly above. */
  await recordSiAutoCountSource(sb, {
    companyId: activeCompanyId(c),
    invoiceId: h.id,
    invoiceNumber: h.invoice_number,
    createdBy: c.get('houzsUser')?.id ?? null,
  });

  /* LEAK GUARD (DRAFT) — a DRAFT SI must NOT post AR/GL revenue nor auto-apply
     customer credit. Both happen on confirm (PATCH /:id/status DRAFT→SENT). */
  if (isDraft) {
    return c.json(withPriceWarnings({ id: h.id, invoiceNumber: h.invoice_number, revenue: { posted: false, status: 'draft' }, creditApplied: 0 }, priceWarnings), 201);
  }

  /* REVENUE — record it now. Idempotent + best-effort. */
  let revenue: { posted: boolean; jeNo?: string; status: string } = { posted: false, status: 'skipped' };
  const post = await postSiRevenue(sb, h.invoice_number);
  if (post.ok) {
    /* 'migrated_source' carries no jeNo and needs none: AutoCount already booked
       the revenue, so the correct number of journal entries here is zero. */
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

  /* Edge #11 — auto-apply existing customer credit balance toward this new SI. */
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

/* ── Convert picked DO LINES (partial qty) → ONE Sales Invoice ───────────── */
// Exported for the scope tests: supabaseAuth cannot run in the vitest harness.
export const createSalesInvoiceFromDoLinesHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { picks?: Array<{ doItemId?: string; qty?: number }>; asDraft?: unknown };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  /* DRAFT flow — opt-in, identical to POST /. A DRAFT SI off DO lines commits
     nothing (no AR/GL revenue, no credit) until confirm. A DRAFT SI is allowed
     to draw from DO lines (a draft is just a draft; confirm does the posting). */
  const isDraft = body.asDraft === true;

  const pickQtyById = new Map<string, number>();
  for (const p of (body.picks ?? [])) {
    if (!p || !p.doItemId) continue;
    const q = Number(p.qty ?? 0);
    if (!(q > 0)) continue;
    pickQtyById.set(p.doItemId, (pickQtyById.get(p.doItemId) ?? 0) + q);
  }
  if (pickQtyById.size === 0) return c.json({ error: 'picks_required' }, 400);

  const pickedIds = [...pickQtyById.keys()];
  /* SOURCE LOAD, SCOPED — the caller's doItemIds enter here, so this read plus
     the scoped DO-header read below decide what the conversion can see: another
     company's line resolves to NO ROW and falls out at `do_item_not_found`.
     THE COST is the message, because naming the other company needs an UNSCOPED
     read this handler otherwise never makes. */
  const { data: pickedItemRows, error: pErr } = await scopeToCompany(sb
    .from('delivery_order_items')
    .select('id, delivery_order_id')
    .in('id', pickedIds), c);
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  const idToDo = new Map<string, string>();
  for (const r of (pickedItemRows ?? []) as Array<{ id: string; delivery_order_id: string }>) idToDo.set(r.id, r.delivery_order_id);
  const missing = pickedIds.filter((id) => !idToDo.has(id));
  if (missing.length > 0) return c.json({ error: 'do_item_not_found', missing }, 404);

  const doIds = [...new Set([...idToDo.values()])];

  /* A delivery carried over from AutoCount is invoiced by the migrated-invoice
     converter, never here. AutoCount already raised the invoice and already
     booked its revenue, so this path would mint a second one under an ERP
     number (breaking the owner's "keep AutoCount's number" rule), post
     Dr 1100 / Cr 4000 for revenue already recognised, and enqueue a do_to_iv
     transfer that duplicates the invoice in the live account book. It would
     also consume the DO line's Pending pool, so the mistake could not be undone
     without cancelling the invoice. See lib/migrated-chain.ts. */
  {
    const mig = await migratedRefusalForDeliveries(sb, { doIds });
    if (!mig.ok) return c.json({ error: 'load_failed', reason: mig.reason }, 500);
    if (mig.refusal) return c.json(mig.refusal, 409);
  }

  const remainingResult = await doLineRemaining(sb, doIds, 'invoiceable');
  /* Pre-write refusal — every qty below is capped by `line.remaining`, and an
     empty map surfaced as a 404 blaming the pick for a database error. */
  if (!remainingResult.ok) return c.json(remainingUnavailableResponse(remainingResult.reason), 503);
  const remainingMap = remainingResult.lines;

  const customers = new Set<string>();
  const customerNames = new Set<string>();
  for (const id of pickedIds) {
    const line = remainingMap.get(id);
    if (!line) return c.json({ error: 'do_item_not_found', missing: [id] }, 404);
    customers.add(custKeyOf(line));
    customerNames.add(line.debtorName ?? line.debtorCode ?? '(none)');
  }
  if (customers.size > 1) {
    return c.json({
      error: 'mixed_customers',
      message: 'All picked Delivery Order lines must belong to the same customer to combine into one Sales Invoice.',
      customers: [...customerNames],
    }, 400);
  }

  for (const id of pickedIds) {
    const line = remainingMap.get(id)!;
    const qty = pickQtyById.get(id)!;
    if (qty < 1 || qty > line.remaining) {
      return c.json({
        error: 'over_remaining',
        message: `${line.itemCode} on ${line.doNumber}: pick qty ${qty} exceeds remaining ${line.remaining}.`,
        doItemId: id,
        doNumber: line.doNumber,
        itemCode: line.itemCode,
        remaining: line.remaining,
        requested: qty,
      }, 409);
    }
  }

  const sortedPicks = pickedIds
    .map((id) => remainingMap.get(id)!)
    .sort((a, b) => a.doNumber.localeCompare(b.doNumber) || (a.lineSeq - b.lineSeq) || a.doItemId.localeCompare(b.doItemId));
  const firstDoId = sortedPicks[0]!.deliveryOrderId;
  const distinctDoNumbers = [...new Set(sortedPicks.map((l) => l.doNumber))].sort();

  const DO_HEADER =
    'id, status, do_number, company_id, so_doc_no, debtor_code, debtor_name, customer_delivery_date, ' +
    'salesperson_id, agent, email, customer_type, building_type, branding, venue, venue_id, ref, ' +
    'customer_so_no, po_doc_no, sales_location, customer_state, customer_country, note, address1, address2, city, state, postcode, phone, currency, ' +
    'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship';
  // HEADER half of the same source document — same predicate as the lines.
  const { data: doHeaderRow, error: hLoadErr } = await scopeToCompany(sb
    .from('delivery_orders')
    .select(DO_HEADER)
    .eq('id', firstDoId), c)
    .maybeSingle();
  if (hLoadErr) return c.json({ error: 'load_failed', reason: hLoadErr.message }, 500);
  if (!doHeaderRow) return c.json({ error: 'delivery_order_not_found' }, 404);
  const head = doHeaderRow as unknown as Record<string, unknown>;
  const badDo = siTransferRefusal(head.status as string | null); if (badDo) return c.json(badDo, 409);

  const nowIso = new Date().toISOString();
  const phoneRaw = head.phone as string | null;
  const emPhoneRaw = head.emergency_contact_phone as string | null;

  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; invoice_number: string }>(
    () => nextNum(sb, c),
    (invoiceNumber) => sb.from('sales_invoices').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    invoice_number: invoiceNumber,
    so_doc_no: (head.so_doc_no as string | null) ?? null,
    delivery_order_id: firstDoId,
    debtor_code: (head.debtor_code as string | null) ?? null,
    debtor_name: (head.debtor_name as string | null) ?? 'Customer',
    invoice_date: todayMyt(),
    customer_delivery_date: (head.customer_delivery_date as string | null) ?? null,
    address1: (head.address1 as string | null) ?? null,
    address2: (head.address2 as string | null) ?? null,
    city: (head.city as string | null) ?? null,
    state: (head.state as string | null) ?? (head.customer_state as string | null) ?? null,
    customer_state: (head.customer_state as string | null) ?? (head.state as string | null) ?? null,
    customer_country: (head.customer_country as string | null) ?? null,
    postcode: (head.postcode as string | null) ?? null,
    phone: phoneRaw ? (normalizePhone(phoneRaw) ?? phoneRaw) : null,
    salesperson_id: (head.salesperson_id as string | null) ?? null,
    agent: (head.agent as string | null) ?? null,
    email: (head.email as string | null) ?? null,
    customer_type: (head.customer_type as string | null) ?? null,
    building_type: (head.building_type as string | null) ?? null,
    branding: (head.branding as string | null) ?? null,
    venue: (head.venue as string | null) ?? null,
    venue_id: (head.venue_id as string | null) ?? null,
    ref: distinctDoNumbers.length > 1
      ? `Merged from ${distinctDoNumbers.join(', ')}`
      : ((head.ref as string | null) ?? null),
    customer_so_no: (head.customer_so_no as string | null) ?? null,
    po_doc_no: (head.po_doc_no as string | null) ?? null,
    sales_location: (head.sales_location as string | null) ?? null,
    note: (head.note as string | null) ?? null,
    emergency_contact_name: (head.emergency_contact_name as string | null) ?? null,
    emergency_contact_phone: emPhoneRaw ? (normalizePhone(emPhoneRaw) ?? emPhoneRaw) : null,
    emergency_contact_relationship: (head.emergency_contact_relationship as string | null) ?? null,
    currency: ((head.currency as string | null) ?? 'MYR').toUpperCase(),
    status: isDraft ? 'DRAFT' : 'SENT',
    sent_at: isDraft ? null : nowIso,
    confirmed_at: isDraft ? null : nowIso,
    created_by: user.id,
    }).select(HEADER).single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; invoice_number: string };

  const rows = sortedPicks.map((line, lineNo) => buildItemRow(h.id, {
    doItemId: line.doItemId,
    itemCode: line.itemCode,
    itemGroup: line.itemGroup,
    description: line.description,
    description2: line.description2,
    uom: line.uom,
    qty: pickQtyById.get(line.doItemId)!,
    unitPriceSen: line.unitPriceSen,
    discountSen: line.discountSen,
    unitCostSen: line.unitCostSen,
    variants: line.variants,
    /* Migration 0058 — carry the dedicated variant-breakdown columns onto the SI line. */
    gapInches: line.gapInches,
    divanHeightInches: line.divanHeightInches,
    divanPriceSen: line.divanPriceSen,
    legHeightInches: line.legHeightInches,
    legPriceSen: line.legPriceSen,
    customSpecials: line.customSpecials,
    lineSuffix: line.lineSuffix,
    specialOrderPriceSen: line.specialOrderPriceSen,
  }, lineNo));
  const { error: iErr } = await sb.from('sales_invoice_items').insert(stampCompany(rows, c));
  if (iErr) {
    await sb.from('sales_invoices').delete().eq('id', h.id);
    return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500);
  }

  /* Race-condition guard — same as the POST / path above, and the SI
     counterpart of "Edge #E" in delivery-orders-mfg.ts. This is the picker
     path, so EVERY line carries a do_item_id and the whole invoice is exposed
     to the race, not just the linked part of it. */
  {
    const pickedDoItemIds = rows
      .map((r) => (r as { do_item_id?: string | null }).do_item_id)
      .filter((x): x is string => !!x);
    if (pickedDoItemIds.length > 0) {
      const recheck = await doRemainingByItemId(sb, pickedDoItemIds, 'invoiceable');
      // Recheck unreadable -> roll back, under the honest reason (as POST / above).
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

  /* Past the items-insert rollback — the invoice is permanent from here. */
  await recordSiCreate(
    sb, c.get('houzsUser'), activeCompanyId(c), h.id, rows.length,
    `Converted from ${distinctDoNumbers.length > 1 ? 'Delivery Orders' : 'Delivery Order'} ${distinctDoNumbers.join(', ')}`,
  );

  /* ERP -> AutoCount DO->Invoice, MERGED OR NOT. An invoice covering several
     delivery orders names them all; AcSyncService takes FromDocNos. What this
     used to skip on was the primitive's single-source key array, which the
     service now works around by grouping per source document. */
  const ac = doIds.length ? await enqueueConvert(sb, {
      companyId: activeCompanyId(c),
      op: 'do_to_iv',
      from: doIds.map((id) => ({ table: 'delivery_orders' as const, keyCol: 'id', key: id })),
      to: { table: 'sales_invoices', keyCol: 'id', key: h.id },
      docType: 'IV',
      docNo: h.invoice_number,
      docId: h.id,
      createdBy: c.get('houzsUser')?.id ?? null,
  }) : null;

  /* LEAK GUARD (DRAFT) — no AR/GL revenue, no customer credit on a DRAFT SI.
     Both move to the confirm transition (PATCH /:id/status DRAFT→SENT). */
  if (isDraft) {
    return c.json({ id: h.id, invoiceNumber: h.invoice_number, revenue: { posted: false, status: 'draft' }, creditApplied: 0, ...(ac?.problems.length ? { acNotSent: ac.problems } : {}) }, 201);
  }

  let revenue: { posted: boolean; jeNo?: string; status: string } = { posted: false, status: 'skipped' };
  const post = await postSiRevenue(sb, h.invoice_number);
  if (post.ok) {
    /* 'migrated_source' carries no jeNo and needs none: AutoCount already booked
       the revenue, so the correct number of journal entries here is zero. */
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
  try {
    const { data: latest } = await sb.from('sales_invoices').select('total_sen, paid_sen, debtor_code, debtor_name').eq('id', h.id).maybeSingle();
    const l = latest as { total_sen: number | null; paid_sen: number | null; debtor_code: string | null; debtor_name: string | null } | null;
    if (l?.debtor_code) {
      const due = Math.max(0, Number(l.total_sen ?? 0) - Number(l.paid_sen ?? 0));
      const res = await applyCustomerCreditToSi(sb, {
        debtorCode: l.debtor_code,
        debtorName: l.debtor_name,
        siId: h.id,
        siNumber: h.invoice_number,
        remainingDueSen: due,
        createdBy: user.id,
      });
      creditApplied = res.applied;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[customer-credit] apply-on-from-dos failed for ${h.invoice_number}:`, e);
  }

  if (creditApplied > 0) await recomputePaid(sb, h.id);
  return c.json({ id: h.id, invoiceNumber: h.invoice_number, revenue, creditApplied, ...(ac?.problems.length ? { acNotSent: ac.problems } : {}) }, 201);
};
salesInvoices.post('/from-dos', createSalesInvoiceFromDoLinesHandler);

/* ── Append a Delivery Order's lines into an EXISTING invoice ────────────── */
// Exported for the scope tests: supabaseAuth cannot run in the vitest harness.
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
  /* ISSUED gate — same rule as the other three line paths. The in-place "append
     a DO into this invoice" button was retired from the UI (Commander
     2026-05-30, Phase B: one invoice per convert, via /sales-invoices/from-do),
     so this endpoint now only serves API callers — which is precisely why it
     needs the gate spelled out rather than assumed. */
  if (isIssuedSi((si as { status: string }).status)) {
    return c.json({ error: 'invoice_issued', message: SI_ISSUED_LINE_MESSAGE }, 409);
  }

  /* SOURCE LOAD, SCOPED — the PARTIAL form of the same DO -> SI conversion as
     POST /from-dos: a second delivery folded into an existing invoice. doId is a
     URL param, so this read is where it enters; another company's DO resolves to
     NO ROW and falls out at `delivery_order_not_found`. With the destination
     invoice scoped above, both ends are closed by construction. THE COST is the
     message, as on every other converted source load. */
  const { data: doHeader } = await scopeToCompany(sb.from('delivery_orders')
    .select('id, status, do_number, company_id').eq('id', doId), c).maybeSingle();
  if (!doHeader) return c.json({ error: 'delivery_order_not_found' }, 404);
  const bad = siTransferRefusal((doHeader as { status: string }).status); if (bad) return c.json(bad, 409);

  /* Same refusal as /from-dos: a delivery carried over from AutoCount is
     invoiced by the migrated-invoice converter, never appended by hand. This
     endpoint serves API callers only (the UI button was retired), which is
     exactly why the rule has to be spelled out here rather than assumed to be
     unreachable. */
  {
    const mig = await migratedRefusalForDeliveries(sb, { doIds: [doId] });
    if (!mig.ok) return c.json({ error: 'load_failed', reason: mig.reason }, 500);
    if (mig.refusal) return c.json(mig.refusal, 409);
  }

  // LINE-level half of the same source document, under the same predicate.
  const { data: doItems, error: doItemsErr } = await scopeToCompany(sb.from('delivery_order_items').select(
    'id, item_code, item_group, description, description2, uom, qty, ' +
    'unit_price_sen, discount_sen, unit_cost_sen, variants, notes, ' +
    'gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, ' +
    'custom_specials, line_suffix, special_order_price_sen',
  ).eq('delivery_order_id', doId)
    .order('line_no', { ascending: true, nullsFirst: false })
    .order('created_at'), c);

  /* NEITHER read may reach the code below as "no lines": unreadable candidates
     become 409 `do_fully_invoiced` ("already invoiced in full") and an unreadable
     ceiling became a silent 200 with nothing appended. Refuse before both. */
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
      discountSen: it.discount_sen,
      unitCostSen: it.unit_cost_sen,
      variants: it.variants,
      notes: it.notes,
      /* Migration 0058 — carry the dedicated variant-breakdown columns (supabase-js
         returns snake_case; dual-read stays safe either way). */
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
  if (iErr) return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500);
  await recomputeTotals(sb, id);
  await recomputePaid(sb, id);

  /* UPDATE on the INVOICE — this appends lines to a document that already
     exists. One row for the batch, not one per line: the operator performed one
     act. The per-line detail is the item codes in the note; a reader who needs
     the amounts has the invoice's own lines. */
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
  /* LEAK GUARD (DRAFT) — appending DO lines to a DRAFT invoice must NOT post
     AR/GL revenue. Posting happens once, on confirm. */
  if ((si as { status: string }).status !== 'DRAFT') {
    await postSiRevenue(sb, (si as { invoice_number: string }).invoice_number);
  }
  /* ERP -> AutoCount edit. This is AutoCount's PARTIAL TRANSFER — a second (or
     third) delivery order folded into an invoice that already exists — and it
     was the one conversion path that queued nothing at all, not even a skipped
     row, so the invoice in the account book kept the lines of only the first DO.

     It is queued as an EDIT rather than a second convert on purpose: a convert
     would make AcSyncService AddNew a whole new Invoice document, which is a
     different document from the one the ERP just appended to. Where the added
     lines have no DtlKey the edit is refused with a visible row — see the same
     note on the PO's convert-from-so. */
  await queueAcSiEdit(c, id);
  return c.json({ ok: true, added: rows.length }, 201);
};
salesInvoices.post('/:id/items/from-do/:doId', appendDoLinesToSalesInvoiceHandler);

// ── Header PATCH (editable SO/DO-style fields) ─────────────────────────────
salesInvoices.patch('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  /* Load the header BEFORE writing: this route had no status check, no sales
     scope and no company filter at all — the least-guarded write on the
     customer-facing document. Company-scoped to match the LIST (`GET /`), so an
     invoice the caller cannot even see in their list can never be written by id.
     Out-of-scope / other-company / missing all answer 404, indistinguishable
     from one another (mirrors GET /:id + GET /:id/payments). */
  /* SI_AUDIT_SELECT, not the three columns the guards need: this row is also the
     BEFORE half of every from->to pair recorded at the end of the handler. An
     audit entry that carries only the new value does not answer "what changed". */
  const { data: cur, error: curErr } = await scopeToCompany(
    sb.from('sales_invoices').select(SI_AUDIT_SELECT).eq('id', id), c,
  ).maybeSingle();
  if (curErr) return c.json({ error: 'load_failed', reason: curErr.message }, 500);
  if (!cur) return c.json({ error: 'not_found' }, 404);
  const before = cur as unknown as Record<string, unknown>;
  {
    /* Read through `before`, not `cur`: a .select() built from a concatenated
       string infers as GenericStringError on the SupabaseClient<any> the scm
       client is, so the row shape only exists after the cast above. */
    const sp = before.salesperson_id as number | string | null | undefined;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), sp)) {
      return c.json({ error: 'not_found' }, 404);
    }
  }

  const curStatus = String(before.status ?? '').toUpperCase();
  if (curStatus === 'CANCELLED') {
    return c.json({ error: 'invoice_cancelled', message: 'This invoice is cancelled — reopen it before editing it.' }, 409);
  }
  /* ISSUED gate — the money and identity of a document the customer is already
     holding cannot change under them. Everything else on the header stays
     editable (see SI_ISSUED_FROZEN_FIELDS). Rejected as a set rather than
     silently dropped: a caller that thinks it changed the price must not be told
     "ok". */
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

  /* "" -> NULL: an unfilled date input would otherwise fail this whole UPDATE. */
  const { data, error } = await sb.from('sales_invoices').update(coerceEmptyDates(updates)).eq('id', id).select('id').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);

  /* Diff the NORMALISED values actually written (`updates`), not the raw body —
     phone numbers are rewritten by normalizePhone above, and a log of what the
     client asked for rather than what was stored is a log of the wrong thing. */
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
  // TENANCY BEFORE the item-code check: that answered about an invoice they cannot see.
  const { data: header } = await scopeToCompanyId(sb.from('sales_invoices').select('id, invoice_number, status, delivery_order_id').eq('id', id), co.companyId).maybeSingle();
  if (!header) return c.json(NOT_THIS_COMPANY, 404);
  const codeCheck = await validateItemCodes(sb, [it.itemCode as string], co.companyId);
  if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  if (((header as { status: string }).status ?? '').toUpperCase() === 'CANCELLED') {
    return c.json({ error: 'invoice_cancelled', message: 'This invoice is cancelled — reopen it before adding lines.' }, 409);
  }
  /* ISSUED gate — adding a line to an issued invoice raises what the customer
     owes and void+reposts its GL through the resync below, all without the
     customer's copy of the PDF changing. */
  if (isIssuedSi((header as { status: string }).status)) {
    return c.json({ error: 'invoice_issued', message: SI_ISSUED_LINE_MESSAGE }, 409);
  }

  {
    const over = await checkSiOverRemaining(sb, [it]);
    if (over) return c.json(over.body, over.status);
  }

  /* Same refusal as every other path that can attach a delivery line. */
  {
    const mig = await migratedRefusalForDeliveries(sb, { doItemIds: [it.doItemId as string | undefined] });
    if (!mig.ok) return c.json({ error: 'load_failed', reason: mig.reason }, 500);
    if (mig.refusal) return c.json(mig.refusal, 409);
  }

  /* FIX 3 — the invoice was created from a DO, so a manually-added line that
     shadows a still-Pending DO line must be linked via the DO picker, not added
     free (which would bypass the ceiling + pool and double-invoice the goods). */
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
  /* Price-vs-order drift — warning only, same contract as POST /. */
  const priceWarnings = await siPriceDriftWarnings(sb, [it]);

  const row = buildItemRow(id, it, nextLineNo);
  const { data, error } = await sb.from('sales_invoice_items').insert({ ...row, company_id: co.companyId }).select(ITEM).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  await recomputePaid(sb, id);

  /* UPDATE, not CREATE: the entity is the INVOICE and it already existed. The
     line's identity travels in the note and as the to-value of every pair. */
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

  /* Re-pricing an invoice line moves revenue and margin, so the company gate is
     strict: refuse an unresolved company rather than fall through to "every
     company", and pin the status gate, the line read and the UPDATE itself. The
     `sales_invoice_id` predicate proves the line is on THIS invoice, not that
     the invoice is in THIS company's books. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  // Source DO, read on the gate query below and used by the re-point guard.
  let siFromDoId: string | null = null;
  {
    /* The gate for the whole handler: every line write below keys on
       (itemId, sales_invoice_id), so proving the INVOICE is ours proves the
       chain. Unscoped, the status gate below read the OTHER company's status. */
    const { data: hd } = await scopeToCompanyId(sb.from('sales_invoices').select('status, delivery_order_id').eq('id', id), co.companyId).maybeSingle();
    if (!hd) return c.json(NOT_THIS_COMPANY, 404);
    if (hd && ((hd as { status: string }).status ?? '').toUpperCase() === 'CANCELLED') {
      return c.json({ error: 'invoice_cancelled', message: 'This invoice is cancelled — reopen it before editing lines.' }, 409);
    }
    /* ISSUED gate — this is the path that could re-price a PAID invoice. */
    if (hd && isIssuedSi((hd as { status: string }).status)) {
      return c.json({ error: 'invoice_issued', message: SI_ISSUED_LINE_MESSAGE }, 409);
    }
    siFromDoId = (hd as { delivery_order_id?: string | null } | null)?.delivery_order_id ?? null;
  }

  if (it.itemCode !== undefined) {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* The audited columns as well as the ones the money logic reads: this row is
     also the BEFORE half of every from->to pair recorded after the update lands.
     `variants` and `do_item_id` are business-logic only and deliberately not in
     SI_LINE_AUDIT_FIELDS — variants render into description2, which is
     server-owned and derived, not an operator edit. */
  const { data: prevRow } = await scopeToCompanyId(sb.from('sales_invoice_items')
    .select(SI_LINE_AUDIT_SELECT + ', variants, do_item_id')
    .eq('id', itemId).eq('sales_invoice_id', id), co.companyId).maybeSingle();
  if (!prevRow) return c.json(NOT_THIS_COMPANY, 404);
  /* Cast through `unknown`: a .select() built from a concatenated string infers
     as GenericStringError on the SupabaseClient<any> the scm client is, so the
     row shape only exists after this. Project-wide pattern (see SI_AUDIT_SELECT
     in the header PATCH, and ITEM everywhere else in this file). */
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
  /* A caller who cannot READ the cost must not WRITE it. GET /:id strips
     unit_cost_sen for a non-finance caller (#600), so a client that seeds its
     line draft off the detail payload and echoes it back would round-trip the
     stripped field as a genuine 0 and wipe the line's cost basis — the DR bug
     #632, on the SI. Latent today (the routed SalesInvoiceDetailV2 has no line
     PATCH at all), but the endpoint accepts any caller's body and the
     un-repointed 2990 POS/admin app is a live consumer of these APIs. Keep the
     stored cost instead; a finance caller is unaffected. DO NOT relax this to a
     bare `!== undefined` — that test IS the trap. */
  const unitCost = (canViewScmFinance(c) && it.unitCostSen !== undefined)
    ? Number(it.unitCostSen)
    : Number(prev.unit_cost_sen);
  /* Same 0-clamp as buildItemRow — the edit path must not be able to persist a
     negative line the create path refuses. */
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

  /* The EDIT half of FIX 3 — see unlinked-line-edit-guard for why (the cap above
     is gated on prev.do_item_id, so a re-typed unlinked code double-bills). */
  {
    const repoint = await unlinkedEditRefusal(sb, 'sales-invoice', {
      parentId: siFromDoId,
      storedLink: (prev as { do_item_id?: string | null }).do_item_id ?? null,
      storedCode: (prev as { item_code?: string | null }).item_code ?? null,
      patchCode: it.itemCode,
    });
    if (repoint) return c.json(repoint, 409);
  }

  const { error } = await scopeToCompanyId(sb.from('sales_invoice_items').update(updates).eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);

  /* Diff `updates` — the EFFECTIVE values written — against the stored row. qty,
     price, discount, tax and cost are each recomputed above from the body OR the
     prior row (the cost deliberately ignores a non-finance caller's echo), so
     the body alone would not say what was actually stored. */
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
  // Same strict company gate as the line PATCH — see the note there.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  {
    // Header read is the gate — same reasoning as the line PATCH above.
    const { data: hd } = await scopeToCompanyId(sb.from('sales_invoices').select('status').eq('id', id), co.companyId).maybeSingle();
    if (!hd) return c.json(NOT_THIS_COMPANY, 404);
    if (hd && ((hd as { status: string }).status ?? '').toUpperCase() === 'CANCELLED') {
      return c.json({ error: 'invoice_cancelled', message: 'This invoice is cancelled — reopen it before deleting lines.' }, 409);
    }
    /* ISSUED gate — deleting a line lowers what the customer owes while their
       copy of the invoice still shows it. */
    if (hd && isIssuedSi((hd as { status: string }).status)) {
      return c.json({ error: 'invoice_issued', message: SI_ISSUED_LINE_MESSAGE }, 409);
    }
  }
  /* Read the line BEFORE destroying it — afterwards the audit row is the only
     remaining evidence of what was invoiced, and there is nothing left to join
     back to. */
  const { data: doomedRow } = await scopeToCompanyId(sb.from('sales_invoice_items')
    .select(SI_LINE_AUDIT_SELECT).eq('id', itemId).eq('sales_invoice_id', id), co.companyId).maybeSingle();
  if (!doomedRow) return c.json(NOT_THIS_COMPANY, 404);
  const doomed = doomedRow as unknown as Record<string, unknown>;

  /* The AutoCount key of the line this save REMOVES. Read BEFORE the delete:
     afterwards the row is gone and its DtlKey with it, and an edit that does not
     NAME the removal leaves the line live and outstanding in the account book. */
  const retire = await retiredLineOf(sb, 'sales_invoice_items', itemId);

  const { error } = await scopeToCompanyId(sb.from('sales_invoice_items').delete().eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);

  /* UPDATE, not DELETE: the entity is the INVOICE and it still exists. DELETE on
     this entity type would tell a reader the whole invoice was destroyed. */
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

// ── Payments (mirror DO / SO payments ledger) ──────────────────────────────
salesInvoices.get('/:id/payments', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  /* Own/downline sales scope (lib/salesScope.ts) — resolve the invoice's
     salesperson_id first so a scoped seller can't read another
     salesperson's payment ledger by enumerating ids. Out-of-scope /
     missing → 404. Directors/view-all bypass. */
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

/* recomputePaid moved to lib/si-order-deposit.ts — the ORDER-side payment
   writer has to run the same roll, and this file is over its size ceiling. */
// Exported for the scope tests: supabaseAuth cannot run in the vitest harness.
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
  /* LEAK GUARD (DRAFT) — a DRAFT invoice is not yet committed; it cannot accept
     payments. Confirm it first (DRAFT → SENT), then record payments. */
  if ((doc as { status?: string }).status === 'DRAFT') return c.json({ error: 'not_payable', message: 'SI is a draft — confirm it before recording payments' }, 409);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = paymentCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  const { data, error } = await insertSiPaymentRow(sb, {
    salesInvoiceId: id, companyId: activeCompanyId(c), paidAt: p.paidAt,
    method: p.method, merchantProvider: p.merchantProvider, installmentMonths: p.installmentMonths,
    onlineType: p.onlineType, approvalCode: p.approvalCode, amountSen: p.amountSen,
    accountSheet: p.accountSheet, collectedBy: p.collectedBy, note: p.note, createdBy: user.id,
  });
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  /* The Official Receipt is born with the payment (GL redesign item 9);
     best-effort — ensureReceiptForPayment heals a hiccup at the next print. */
  try {
    const paymentId = String((data as { id?: unknown } | null)?.id ?? '');
    if (paymentId) await ensureReceiptForPayment(sb, 'SIPAY', paymentId);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[receipts] draft OR not created for SI payment:', e);
  }
  await recomputePaid(sb, id);
  await postUnpostedSiPayments(sb, id); // Accounting hook (需求书 6.3, owner approved 2026-08-16); best-effort
  try { await reconcileSiOverpay(sb, id); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[customer-credit] overpay reconcile failed (post):', e); }

  /* Money IN. paidSen is read AFTER recomputePaid so the from->to pair is the
     real ledger total either side of this payment, not the requested amount
     twice. Both are the INTEGER SEN. Best-effort read: an unresolved `to` still
     leaves a row naming who paid what and when. */
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
salesInvoices.post('/:id/payments', postSalesInvoicePaymentHandler);

salesInvoices.delete('/:id/payments/:paymentId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const paymentId = c.req.param('paymentId');
  /* company-scope: through the parent invoice, BEFORE anything is read or
     destroyed. The doc-mismatch check below proves only that the payment belongs
     to the invoice in the URL, never whose invoice that is. */
  const { data: own, error: ownErr } = await scopeToCompany(sb.from('sales_invoices').select('id').eq('id', id), c).maybeSingle();
  if (ownErr) return c.json({ error: 'lookup_failed', reason: ownErr.message }, 500);
  if (!own) return c.json({ error: 'not_found' }, 404);
  /* The payment's own columns are read BEFORE the delete — once the row is gone
     the audit entry is the only remaining evidence of what was removed. */
  /* Taking money back off an invoice is a books change, so the company gate is
     strict — an unresolved company refuses rather than reaching every company's
     receipts. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: row } = await scopeToCompanyId(sb.from('sales_invoice_payments')
    .select('sales_invoice_id, amount_sen, method, paid_at').eq('id', paymentId), co.companyId).maybeSingle();
  if (!row) return c.json(NOT_THIS_COMPANY, 404);
  const doomed = row as { sales_invoice_id: string; amount_sen?: number | null; method?: string | null; paid_at?: string | null };
  if (doomed.sales_invoice_id !== id) return c.json({ error: 'payment_doc_mismatch' }, 400);
  /* A CREDIT payment cannot be deleted. Applying credit writes TWO rows in one
     transaction (scm.apply_customer_credit_to_si): this payment row, and a
     negative APPLIED_TO_SI on the customer's ledger. Nothing in the repo ever
     reverses APPLIED_TO_SI — reconcileSiOverpay below handles OVERPAY only — so
     deleting just the payment leaves the invoice unpaid AND the balance still
     debited, and clears the idempotency guard so the same credit can be spent
     twice. REFUSE rather than compensate: the transactional undo already exists,
     and it is cancelling the invoice (creditFromCancelledSi). */
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
  try { await reconcileSiOverpay(sb, id); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[customer-credit] overpay reconcile failed (delete):', e); }

  /* Money taken back OFF the invoice. Recorded as UPDATE, not DELETE: the entity
     is the INVOICE and it still exists — DELETE on this entity type means the
     document itself was destroyed, and a reader must not be told that. */
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
      ]),
    });
  }

  return c.json({ ok: true });
});

// ── Status transition (Cancel / Reopen) ────────────────────────────────────
export const patchSalesInvoiceStatusHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  let body: { status?: string }; try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.status) return c.json({ error: 'status_required' }, 400);

  /* FIX 1 + FIX 2 (fix/si-cancel-revenue-qty) — canonicalise the incoming status
     to its UPPER-CASE form BEFORE any branch. A lowercase 'cancelled' (or
     'issued' / 'partial' / 'completed') used to be persisted verbatim and slip
     past the `status === 'CANCELLED'` gate below, so a SENT invoice was marked
     cancelled WITHOUT reversing AR/GL revenue, while do-line-remaining (which
     upper-cases) freed the delivered goods for re-invoicing — a silent finance +
     double-invoice bug. Canonicalising once here makes 'cancelled' and 'CANCELLED'
     ONE path and guarantees reverseSiRevenue fires exactly once on cancel
     regardless of input case (the idempotent .neq('status','CANCELLED') guard on
     the update still prevents a double reversal). */
  const status = canonicalSiStatus(body.status);
  if (!status) {
    return c.json({ error: 'invalid_status', message: `"${body.status}" is not a recognised invoice status.` }, 400);
  }
  const now = new Date().toISOString();
  const ts: Record<string, string> = { updated_at: now };
  if (status === 'SENT') ts.sent_at = now;
  if (status === 'PAID') ts.paid_at = now;

  /* Scoped load, matching PATCH /:id in this same file — the header edit was
     given this boundary and the status flip was not, though the flip is the one
     that reverses revenue, mints customer credits and re-posts GL. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: curRow, error: curErr } = await scopeToCompanyId(sb.from('sales_invoices')
    .select('status, invoice_number, company_id').eq('id', id), co.companyId).maybeSingle();
  if (curErr) return c.json({ error: 'load_failed', reason: curErr.message }, 500);
  if (!curRow) return c.json(NOT_THIS_COMPANY, 404);
  const prevStatus = ((curRow as { status: string }).status ?? '').toUpperCase();
  /* Identity for the audit rows below, read here so every exit path has it
     without a second round-trip. */
  const auditDocNo = (curRow as { invoice_number?: string | null }).invoice_number ?? null;
  const auditCompanyId = (curRow as { company_id?: number | null }).company_id ?? activeCompanyId(c);

  /* FIX 2 — single legal-transition authority. Unknown targets were rejected
     above; here we reject clearly-illegal jumps (e.g. any → DRAFT, a payment jump
     off a draft, reopening a cancelled invoice to anything but SENT). Every
     currently-legitimate transition is allowed: confirm (DRAFT→SENT), cancel,
     reopen (CANCELLED→SENT), and the payment-derived states. Self-transitions pass
     (handled idempotently below). An unrecognised PERSISTED status fails open so a
     legacy row is never bricked. */
  const canonPrev = SI_STATUS_CANON[prevStatus];
  const allowedTargets = canonPrev ? SI_LEGAL_TRANSITIONS[canonPrev] : undefined;
  if (allowedTargets && canonPrev !== status && !allowedTargets.has(status)) {
    return c.json({
      error: 'invalid_transition',
      message: siTransitionReject(canonPrev as string, status),
      from: prevStatus, to: status,
    }, 409);
  }

  /* ── CONFIRM transition (DRAFT → SENT) ─────────────────────────────────
     A DRAFT SI committed nothing on create. Confirming it is where the
     posting now happens: stamp sent_at / confirmed_at, post AR/GL revenue
     (postSiRevenue — idempotent), then auto-apply any customer credit
     (applyCustomerCreditToSi). DRAFT may ONLY move to SENT (or be cancelled,
     handled below). This mirrors the SO confirm (status PATCH DRAFT→CONFIRMED). */
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
    // Lost the race — another submit already confirmed it. Idempotent echo, no
    // second posting (postSiRevenue is idempotent anyway, but skip the work).
    if (!confirmed) return c.json({ salesInvoice: { id, status: 'SENT' } });
    const d = confirmed as { id: string; status: string; invoice_number: string; debtor_code: string | null; debtor_name: string | null; total_sen: number | null; paid_sen: number | null };

    /* POST revenue now (was skipped on draft create). Idempotent + best-effort. */
    const post = await postSiRevenue(sb, d.invoice_number);
    if (!post.ok && post.status !== 'zero_total' && post.status !== 'invoice_not_found') {
      // eslint-disable-next-line no-console
      console.error(`[si-revenue] confirm post failed for ${d.invoice_number}:`, post.status, (post as { reason?: string }).reason);
    }

    /* The moment the invoice becomes real to the customer AND to the ledger. The
       .eq('status','DRAFT') gate above means only the call that actually flipped
       it reaches here, so exactly one POST row is written per confirm. totalSen
       is the INTEGER SEN posted to AR. */
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

    /* Auto-apply customer credit now (was skipped on draft create). */
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

  /* Reopen = CANCELLED → SENT (the ONLY target the transition table permits from
     CANCELLED); the qty re-check below guards against the delivered goods having
     been invoiced elsewhere while this invoice sat cancelled. */
  const isReopen = prevStatus === 'CANCELLED' && status !== 'CANCELLED';
  if (isReopen && status === 'SENT') {
    /* The READ that builds the line list is part of this guard, so it lives with
       it in the lib — swallowed here, it fed the ceiling an empty list and the
       reopen sailed through at the full delivered quantity. */
    const over = await checkSiReopenOverRemaining(sb, id);
    /* An unreadable ledger refuses the reopen with the 503, not this 409:
       "invoiced elsewhere" when a read timed out sends him hunting a duplicate. */
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
      .select('id, status, invoice_number, paid_sen, debtor_code, debtor_name')
      .single();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    data = updated as typeof data;
  }

  /* The DOCUMENT event, recorded for every transition that actually moved the
     status. The cancel branch's .neq('status','CANCELLED') gate already returned
     early when it changed nothing, so a losing concurrent cancel writes no row.
     The reopen's revenue re-post is recorded separately below — same document-
     event / ledger-event split the cancel path uses. */
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

    /* A SEPARATE row from the CANCEL above, not a duplicate of it: that was a
       document-status event, this is the AR/GL contra, and a cancel whose
       reversal failed must be distinguishable from one whose reversal landed.
       paidSen is the INTEGER SEN that becomes a customer credit below. */
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

    /* ERP -> AutoCount cancel. THE OWNER'S OUTSTANDING RULE IS WHY THIS EXISTS,
       not tidiness: his rule is "not converted to DO and NOT TO IV, cancelled
       excluded". An invoice cancelled here but left live in the account book
       keeps consuming its Sales Order on the AutoCount side, so the two systems
       disagree about which orders are still outstanding by exactly the set of
       invoices the ERP has cancelled. AcSyncService has handled `case "IV"`
       since it was written (AcSyncService.cs:423); the ERP simply never asked.

       Placed inside the atomic `.neq('status','CANCELLED')` branch, so a losing
       concurrent cancel returned above and exactly one cancel is ever queued.
       Never throws — enqueueCancel swallows, and a write-back must not fail a
       save that has already committed. */
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

    /* The LEDGER half of a reopen — the UPDATE row above recorded the status
       move. Reopening re-posts revenue that the cancel contra'd, so whether that
       re-post landed is its own fact. */
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

// Legacy quick-payment endpoint (kept for the Outstanding page + any callers
// that POST a single amount). Records into the payments ledger + rolls status.
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
  /* LEAK GUARD (DRAFT) — same as POST /:id/payments: a draft can't be paid. */
  if ((cur as { status: string }).status === 'DRAFT') return c.json({ error: 'not_payable', message: 'SI is a draft — confirm it before recording payments' }, 409);

  const { error } = await sb.from('sales_invoice_payments').insert({
    // The ACTIVE company, proven to be the invoice's by the scoped read above.
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
  /* Edge #A — an overpayment via this legacy quick-pay must book the excess as a
     customer-credit, same as the POST /payments + DELETE paths. Without this the
     overpaid amount was silently lost (no OVERPAY credit row). */
  try { await reconcileSiOverpay(sb, id); }
  catch (e) { /* eslint-disable-next-line no-console */ console.error('[customer-credit] overpay reconcile failed (quick-pay):', e); }
  const { data } = await sb.from('sales_invoices').select('id, paid_sen, status').eq('id', id).maybeSingle();

  /* Same money event as POST /:id/payments, reached through the legacy quick-pay
     screen. It writes the same ledger, so it writes the same audit row — an
     entry point the history cannot see is a gap in it. */
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
