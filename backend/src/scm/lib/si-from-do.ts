// ----------------------------------------------------------------------------
// si-from-do — the Sales Invoice raised FROM DELIVERY ORDER LINES, as a core
// with no request context, plus the invoice helpers that core needs.
//
// WHY IT IS ITS OWN MODULE (docs/bugs/0830). Two callers raise an invoice off
// delivered lines and only one of them is an HTTP request: POST
// /sales-invoices/from-dos (the picker), and the delivery reconciler
// (lib/so-delivery-sync), which invoices a fully delivered order by itself
// when the company's deposit-invoice flow is on and has no request to hand.
// Everything that must be true of a from-DO invoice — the migrated refusal,
// the remaining check, one customer per invoice, the race guard, the totals,
// the audit row, the AutoCount enqueue, the revenue posting, the customer
// credit, the paid roll — therefore lives below the route layer, or it holds
// for whichever caller somebody remembered.
//
// Lifted out of routes/sales-invoices.ts unchanged apart from the context
// (company id + doc prefix + actor in, an HTTP-shaped outcome out). That
// file is over its size ceiling and may only shrink; this is the split the
// ratchet asks for, not a redesign. recomputeTotals, buildItemRow,
// recordSiCreate and migratedRefusalForDeliveries moved with it because the
// core needs them and a lib may not import a route.
// ----------------------------------------------------------------------------

import { normalizePhone, buildVariantSummary, isServiceLine } from '../shared';
import { scopeToCompanyIdOrOpen } from './companyScope';
import { mintMonthlyDocNo, insertWithDocNoRetry } from './doc-no';
import { todayMyt } from './my-time';
import { dateOrNull } from './date-coerce';
import {
  doLineRemaining, doRemainingByItemId, findOverInvoicedDoItems, custKeyOf, remainingUnavailableResponse, siTransferRefusal,
} from './do-line-remaining';
import { refuseMigratedSources } from './migrated-chain';
import { postSiRevenue } from './post-si-revenue';
import { applyCustomerCreditToSi } from './customer-credits';
import { recomputeSiPaid } from './si-order-deposit';
import { recordEntityAudit, compactChanges, fieldChange, type AuditActor } from './entity-audit';
import { enqueueConvert } from './autocount-outbox';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client; `sb` is `any` throughout the SI route this was lifted from */
type Db = any;

/** The next invoice number under a company's prefix: {prefix}SI-YYMM-NNN. */
export const nextSiNumber = async (sb: Db, prefix: string): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  return mintMonthlyDocNo(sb, 'sales_invoices', 'invoice_number', `${prefix}SI-${yymm}`);
};

/**
 * Record the CREATE of an invoice that has SURVIVED its handler.
 *
 * Reads the row back rather than taking the caller's payload: the stored shape
 * is what a reader is being told about (the doc number was minted server-side,
 * the totals only exist after recomputeTotals), and a header that a compensating
 * branch already deleted reads back as nothing — so this cannot write a CREATE
 * row for an invoice that was rolled back.
 */
export async function recordSiCreate(
  sb: Db,
  actor: AuditActor | null | undefined,
  fallbackCompanyId: number | null | undefined,
  siId: string,
  lineCount: number,
  note?: string,
): Promise<void> {
  let row: Record<string, unknown> | null = null;
  try {
    const { data, error } = await sb.from('sales_invoices')
      .select('id, invoice_number, status, company_id, debtor_code, debtor_name, so_doc_no, ' +
        'delivery_order_id, invoice_date, due_date, currency, salesperson_id, total_sen, paid_sen')
      .eq('id', siId).maybeSingle();
    /* A read that did not answer is not a rolled-back invoice: it is logged
       and the CREATE row is skipped, the same silence as before, out loud. */
    if (error) {
      // eslint-disable-next-line no-console
      console.error('[si-audit] create row skipped — invoice read failed:', siId, error.message);
      return;
    }
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
export async function recomputeTotals(sb: Db, salesInvoiceId: string): Promise<void> {
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
export function buildItemRow(salesInvoiceId: string, it: Record<string, unknown>, lineNo?: number | null) {
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
  const itemGroup = (it.itemGroup as string | null | undefined) ?? null;
  const variants = (it.variants as unknown) ?? null;
  return {
    sales_invoice_id: salesInvoiceId,
    so_item_id: (it.soItemId as string | undefined) ?? null,
    do_item_id: (it.doItemId as string | undefined) ?? null,
    item_code: it.itemCode,
    item_group: itemGroup,
    description: (it.description as string | null | undefined) ?? null,
    description2: buildVariantSummary(String(itemGroup ?? ''), variants as Record<string, unknown> | null) || (it.description2 as string) || null,
    uom: (it.uom as string | null | undefined) ?? 'UNIT',
    qty,
    unit_price_sen: unitPrice,
    discount_sen: discount,
    tax_sen: tax,
    line_total_sen: lineTotal,
    unit_cost_sen: unitCost,
    line_cost_sen: lineCost,
    line_margin_sen: lineTotal - lineCost,
    variants,
    line_delivery_date: (it.lineDeliveryDate as string | null) ?? null,
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
    notes: (it.notes as string | null | undefined) ?? null,
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
export async function migratedRefusalForDeliveries(
  sb: Db,
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

/* ── The core ────────────────────────────────────────────────────────────── */

export type SiFromDoInput = {
  /** The company the invoice belongs to; null keeps the reads open (legacy, no active company). */
  companyId: number | null;
  /** The document prefix the number is minted under (companyDocPrefix / docPrefixForCode). */
  docPrefix: string;
  picks: Array<{ doItemId: string; qty: number }>;
  asDraft: boolean;
  /** created_by on the header — the Supabase user id the route carries, or null for automation. */
  createdBy: string | null;
  /** The REAL Houzs user for the audit row and the AutoCount enqueue; null for automation. */
  actor: AuditActor | null | undefined;
  /** The audit row's note; defaults to "Converted from Delivery Order(s) …". */
  auditNote?: string;
  /** The invoice's date (YYYY-MM-DD). Defaults to today (MYT) — the picker's
      rule; a delivery invoiced after the fact passes its delivery day so the
      revenue lands in the month the goods left (docs/bugs/0832). */
  invoiceDate?: string | null;
};

export type SiFromDoStatus = 201 | 400 | 404 | 409 | 500 | 503;
export type SiFromDoRevenue = { posted: boolean; jeNo?: string; status: string };
/** The AutoCount enqueue's own problem sentences, passed through untouched. */
type AcProblems = NonNullable<Awaited<ReturnType<typeof enqueueConvert>>>['problems'];
export type SiFromDoOutcome =
  | { ok: true; status: 201; body: { id: string; invoiceNumber: string; revenue: SiFromDoRevenue; creditApplied: number; acNotSent?: AcProblems } }
  | { ok: false; status: Exclude<SiFromDoStatus, 201>; body: Record<string, unknown> };

const refuse = (status: Exclude<SiFromDoStatus, 201>, body: Record<string, unknown>): SiFromDoOutcome => ({ ok: false, status, body });

/**
 * Raise ONE sales invoice off the picked delivery-order lines (all of one
 * customer), SENT and posted unless `asDraft`. The outcome is HTTP-shaped so
 * the route returns it as-is and the reconciler reads the same refusals.
 */
export async function createSalesInvoiceFromDoLines(sb: Db, input: SiFromDoInput): Promise<SiFromDoOutcome> {
  const { companyId, asDraft: isDraft } = input;
  const pickQtyById = new Map<string, number>();
  for (const p of input.picks) {
    if (!p.doItemId) continue;
    const q = Number(p.qty);
    if (!(q > 0)) continue;
    pickQtyById.set(p.doItemId, (pickQtyById.get(p.doItemId) ?? 0) + q);
  }
  if (pickQtyById.size === 0) return refuse(400, { error: 'picks_required' });
  const pickedIds = [...pickQtyById.keys()];
  /* SOURCE LOAD, SCOPED — the caller's doItemIds enter here, so this read plus
     the scoped DO-header read below decide what the conversion can see: another
     company's line resolves to NO ROW and falls out at `do_item_not_found`.
     THE COST is the message, because naming the other company needs an UNSCOPED
     read this path otherwise never makes. */
  const { data: pickedItemRows, error: pErr } = await scopeToCompanyIdOrOpen(sb
    .from('delivery_order_items')
    .select('id, delivery_order_id')
    .in('id', pickedIds), companyId);
  if (pErr) return refuse(500, { error: 'load_failed', reason: pErr.message });
  const idToDo = new Map<string, string>();
  for (const r of (pickedItemRows ?? []) as Array<{ id: string; delivery_order_id: string }>) idToDo.set(r.id, r.delivery_order_id);
  const missing = pickedIds.filter((id) => !idToDo.has(id));
  if (missing.length > 0) return refuse(404, { error: 'do_item_not_found', missing });
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
    if (!mig.ok) return refuse(500, { error: 'load_failed', reason: mig.reason });
    if (mig.refusal) return refuse(409, mig.refusal);
  }
  const remainingResult = await doLineRemaining(sb, doIds, 'invoiceable');
  /* Pre-write refusal — every qty below is capped by `line.remaining`, and an
     empty map surfaced as a 404 blaming the pick for a database error. */
  if (!remainingResult.ok) return refuse(503, remainingUnavailableResponse(remainingResult.reason));
  const remainingMap = remainingResult.lines;
  const customers = new Set<string>();
  const customerNames = new Set<string>();
  for (const id of pickedIds) {
    const line = remainingMap.get(id);
    if (!line) return refuse(404, { error: 'do_item_not_found', missing: [id] });
    customers.add(custKeyOf(line));
    customerNames.add(line.debtorName ?? line.debtorCode ?? '(none)');
  }
  if (customers.size > 1) {
    return refuse(400, {
      error: 'mixed_customers',
      message: 'All picked Delivery Order lines must belong to the same customer to combine into one Sales Invoice.',
      customers: [...customerNames],
    });
  }
  for (const id of pickedIds) {
    const line = remainingMap.get(id)!;
    const qty = pickQtyById.get(id)!;
    if (qty < 1 || qty > line.remaining) {
      return refuse(409, {
        error: 'over_remaining',
        message: `${line.itemCode} on ${line.doNumber}: pick qty ${qty} exceeds remaining ${line.remaining}.`,
        doItemId: id,
        doNumber: line.doNumber,
        itemCode: line.itemCode,
        remaining: line.remaining,
        requested: qty,
      });
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
  const { data: doHeaderRow, error: hLoadErr } = await scopeToCompanyIdOrOpen(sb
    .from('delivery_orders')
    .select(DO_HEADER)
    .eq('id', firstDoId), companyId)
    .maybeSingle();
  if (hLoadErr) return refuse(500, { error: 'load_failed', reason: hLoadErr.message });
  if (!doHeaderRow) return refuse(404, { error: 'delivery_order_not_found' });
  const head = doHeaderRow as unknown as Record<string, unknown>;
  const badDo = siTransferRefusal(head.status as string | null); if (badDo) return refuse(409, badDo);

  const nowIso = new Date().toISOString();
  const phoneRaw = head.phone as string | null;
  const emPhoneRaw = head.emergency_contact_phone as string | null;

  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; invoice_number: string }>(
    () => nextSiNumber(sb, input.docPrefix),
    (invoiceNumber) => sb.from('sales_invoices').insert({
    ...(companyId != null ? { company_id: companyId } : {}), // multi-company: stamp the caller's company
    invoice_number: invoiceNumber,
    so_doc_no: (head.so_doc_no as string | null) ?? null,
    delivery_order_id: firstDoId,
    debtor_code: (head.debtor_code as string | null) ?? null,
    debtor_name: (head.debtor_name as string | null) ?? 'Customer',
    invoice_date: dateOrNull(input.invoiceDate) ?? todayMyt(),
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
    created_by: input.createdBy,
    }).select('id, invoice_number').single(),
  );
  if (hErr) return refuse(500, { error: 'insert_failed', reason: hErr.message });
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
    lineDeliveryDate: line.lineDeliveryDate,
    gapInches: line.gapInches,
    divanHeightInches: line.divanHeightInches,
    divanPriceSen: line.divanPriceSen,
    legHeightInches: line.legHeightInches,
    legPriceSen: line.legPriceSen,
    customSpecials: line.customSpecials,
    lineSuffix: line.lineSuffix,
    specialOrderPriceSen: line.specialOrderPriceSen,
  }, lineNo));
  const stamped = companyId != null ? rows.map((r) => ({ company_id: companyId, ...r })) : rows;
  const { error: iErr } = await sb.from('sales_invoice_items').insert(stamped);
  if (iErr) {
    await sb.from('sales_invoices').delete().eq('id', h.id);
    return refuse(500, { error: 'items_insert_failed', reason: iErr.message });
  }
  /* Race-condition guard — same as the POST / path, and the SI counterpart of
     "Edge #E" in delivery-orders-mfg.ts. This is the picker path, so EVERY line
     carries a do_item_id and the whole invoice is exposed to the race, not just
     the linked part of it. */
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
        return refuse(503, remainingUnavailableResponse(recheck.reason));
      }
      const over = findOverInvoicedDoItems(pickedDoItemIds, recheck.remaining);
      if (over.length > 0) {
        await sb.from('sales_invoice_items').delete().eq('sales_invoice_id', h.id);
        await sb.from('sales_invoices').delete().eq('id', h.id);
        return refuse(409, {
          error: 'race_conflict',
          message: 'Another operator just invoiced overlapping qty from this Delivery Order. Refresh and try again.',
          conflicts: over,
        });
      }
    }
  }
  await recomputeTotals(sb, h.id);
  /* Past the items-insert rollback — the invoice is permanent from here. */
  await recordSiCreate(
    sb, input.actor, companyId, h.id, rows.length,
    input.auditNote ?? `Converted from ${distinctDoNumbers.length > 1 ? 'Delivery Orders' : 'Delivery Order'} ${distinctDoNumbers.join(', ')}`,
  );
  /* ERP -> AutoCount DO->Invoice, MERGED OR NOT. An invoice covering several
     delivery orders names them all; AcSyncService takes FromDocNos. What this
     used to skip on was the primitive's single-source key array, which the
     service now works around by grouping per source document. */
  const ac = doIds.length ? await enqueueConvert(sb, {
      companyId,
      op: 'do_to_iv',
      from: doIds.map((id) => ({ table: 'delivery_orders' as const, keyCol: 'id', key: id })),
      to: { table: 'sales_invoices', keyCol: 'id', key: h.id },
      docType: 'IV',
      docNo: h.invoice_number,
      docId: h.id,
      createdBy: input.actor?.id ?? null,
  }) : null;
  const acNotSent = ac?.problems.length ? { acNotSent: ac.problems } : {};
  /* LEAK GUARD (DRAFT) — no AR/GL revenue, no customer credit on a DRAFT SI.
     Both move to the confirm transition (PATCH /:id/status DRAFT→SENT). */
  if (isDraft) {
    return { ok: true, status: 201, body: { id: h.id, invoiceNumber: h.invoice_number, revenue: { posted: false, status: 'draft' }, creditApplied: 0, ...acNotSent } };
  }
  let revenue: SiFromDoRevenue = { posted: false, status: 'skipped' };
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
    const { data: latest, error: latestErr } = await sb.from('sales_invoices').select('total_sen, paid_sen, debtor_code, debtor_name').eq('id', h.id).maybeSingle();
    /* A failed read is not "no debtor": the credit is simply not applied on
       this pass (the next roll can), and the reason is written down. */
    if (latestErr) throw new Error(`invoice read: ${latestErr.message}`);
    const l = latest as { total_sen: number | null; paid_sen: number | null; debtor_code: string | null; debtor_name: string | null } | null;
    if (l?.debtor_code) {
      const due = Math.max(0, Number(l.total_sen ?? 0) - Number(l.paid_sen ?? 0));
      const res = await applyCustomerCreditToSi(sb, {
        debtorCode: l.debtor_code,
        debtorName: l.debtor_name,
        siId: h.id,
        siNumber: h.invoice_number,
        remainingDueSen: due,
        createdBy: input.createdBy,
      });
      creditApplied = res.applied;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[customer-credit] apply-on-from-dos failed for ${h.invoice_number}:`, e);
  }
  /* The paid roll ALWAYS, not only when credit landed (docs/bugs/0830): the
     status ladder counts the ORDER's deposits (si-order-deposit), so an
     invoice raised off a deposit-paid order reads PARTIALLY_PAID / PAID from
     birth instead of chasing the customer until the next payment rolls it. */
  await recomputeSiPaid(sb, h.id);
  return { ok: true, status: 201, body: { id: h.id, invoiceNumber: h.invoice_number, revenue, creditApplied, ...acNotSent } };
}
