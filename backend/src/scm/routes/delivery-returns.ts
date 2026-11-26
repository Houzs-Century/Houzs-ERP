
import { yymmFor } from '../../services/documentRefs';
import { Hono, type Context } from 'hono';
import { normalizePhone } from '../shared/phone';
import { buildVariantSummary } from '../shared';
import { parseReturnLineQty, returnLineQtyMessage } from '../shared/return-line-qty';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  crossCompanySourceRefusal,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { stampDoLineSoRefs } from '../lib/so-ref-lookup';
import { assertLinkedLineItemsMatch } from '../lib/line-link-item-identity';
import { dateOrNull, coerceEmptyDates } from '../lib/date-coerce';
import { reconcileUncostedAfterIn } from '../lib/oversell-retrocost';
import { warehouseLabel } from '../lib/warehouse-label';
import { doLineRemaining, returnableRemainingFrom, resolveCandidateDoIds, custKeyOf, remainingUnavailableResponse, type DoRemainingLine, type DoRemainingResult } from '../lib/do-line-remaining';
import { todayMyt } from '../lib/my-time';
import { validateItemCodes, unknownItemCodeResponse } from '../lib/validate-item-codes';
import { resolveItemGroups } from '../lib/sku-category';
import { cancelDrAtomically, drResyncCore, drStockFailureBody, drStockInCore, isDrFlipMiss, receiveCreatedDrAtomically, resolveDrLineWarehouses, type DrFlipResult, type DrStockResult } from '../lib/delivery-return-stock';
import { stockTxFor } from '../lib/stock-post-tx';
import { markIdempotencyNoWrite } from '../../middleware/idempotency';
import { findServiceLineCodes, serviceLinesNotReturnableResponse, serviceGuardUnavailableResponse } from '../lib/service-line-guard';
import { findUnlinkedDrLines, unlinkedReturnResponse } from '../lib/return-unlinked-lines';
import { unlinkedEditRefusal, unlinkedScanRefusal } from '../lib/unlinked-line-edit-guard';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { canViewAllSales, canViewScmFinance } from '../lib/houzs-perms';
import { SO_ITEM_FINANCE_KEYS } from '../lib/finance-keys';
import { sourceUnitCostByItemId } from '../lib/source-cost';
import { resolveSalesScopeIds, salesDocOutOfScope, resolveCallerStaffId } from '../lib/salesScope';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { isSoLineOverDelivered } from '../lib/so-remaining-by-item';
import { creditNoteHold, loadReturnCredit } from '../lib/cn-from-return';
import {
  DR_FINANCE_KEYS,
  DR_HEADER_COLS,
  attachDeliveryReturnLines,
  filterDeliveryReturnList,
  gateDrListFinance,
  orderDeliveryReturnList,
  readDeliveryReturnListFilters,
  stampDrListBookSpellings,
  stampDrListSoDocNo,
  type DrLineHeader,
} from '../lib/delivery-return-list-read';

export const deliveryReturns = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryReturns.use('*', supabaseAuth);

function gateDrFinance(
  c: Parameters<typeof canViewScmFinance>[0],
  deliveryReturn: unknown,
  items: unknown,
): void {
  if (canViewScmFinance(c)) return;
  if (deliveryReturn && typeof deliveryReturn === 'object') {
    for (const k of DR_FINANCE_KEYS) delete (deliveryReturn as Record<string, unknown>)[k];
  }
  for (const it of (Array.isArray(items) ? items : []) as Array<Record<string, unknown>>) {
    for (const k of SO_ITEM_FINANCE_KEYS) delete it[k];
  }
}

const HEADER = DR_HEADER_COLS;

const ITEM =
  'id, delivery_return_id, do_item_id, item_code, item_group, description, description2, ' +
  'uom, qty_returned, condition, unit_price_sen, discount_sen, line_total_sen, ' +
  'unit_cost_sen, line_cost_sen, line_margin_sen, refund_sen, variants, notes, created_at';

const nextNum = async (sb: any, c: any): Promise<string> => {
  const yymm = yymmFor();
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'delivery_returns', 'return_number', `${p}DR-${yymm}`);
};

async function recomputeTotals(sb: any, deliveryReturnId: string) {
  const { data: items, error: itemsErr } = await sb.from('delivery_return_items')
    .select('item_group, line_total_sen, line_cost_sen')
    .eq('delivery_return_id', deliveryReturnId);
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[dr-recompute] item read failed — header left unchanged:', deliveryReturnId, itemsErr.message);
    return;
  }
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0;
  for (const it of (items ?? []) as Array<{ item_group: string | null; line_total_sen: number | null; line_cost_sen: number | null }>) {
    const lineTotal = Number(it.line_total_sen ?? 0);
    const lineCost  = Number(it.line_cost_sen ?? 0);
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.item_group ?? '').toLowerCase();
    if (g.includes('mattress') || g.includes('sofa')) { mattressSofa += lineTotal; mattressSofaCost += lineCost; }
    else if (g.includes('bedframe')) { bedframe += lineTotal; bedframeCost += lineCost; }
    else if (g.includes('accessor')) { accessories += lineTotal; accessoriesCost += lineCost; }
    else { others += lineTotal; othersCost += lineCost; }
  }
  const margin = total - totalCost;
  const { error: updErr } = await sb.from('delivery_returns').update({
    mattress_sofa_sen: mattressSofa,
    bedframe_sen: bedframe,
    accessories_sen: accessories,
    others_sen: others,
    mattress_sofa_cost_sen: mattressSofaCost,
    bedframe_cost_sen: bedframeCost,
    accessories_cost_sen: accessoriesCost,
    others_cost_sen: othersCost,
    local_total_sen: total,
    total_cost_sen: totalCost,
    total_margin_sen: margin,
    margin_pct_basis: total > 0 ? Math.round((margin / total) * 10000) : 0,
    line_count: (items ?? []).length,
    refund_sen: total,
    updated_at: new Date().toISOString(),
  }).eq('id', deliveryReturnId);
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[dr-recompute] header update failed — totals left STALE:', deliveryReturnId, updErr.message);
  }
}

async function increaseInventoryForReturn(sb: any, deliveryReturnId: string, performedBy: string): Promise<string[]> {
  const core = await drStockInCore(sb, deliveryReturnId, performedBy);
  await afterDrStockIn(sb, core.written, performedBy);
  return core.errors;
}
async function afterDrStockIn(sb: any, written: DrStockResult['written'], performedBy: string): Promise<void> {
  if (written.length > 0) await reconcileUncostedAfterIn(sb, written, performedBy);
}

async function bookCreatedDrStock(c: any, sb: any, h: { id: string; return_number: string }, userId: string): Promise<{ refused: Response } | { movementErrors: string[] }> {
  const drTx = stockTxFor(c.env, 'DELIVERY_RETURN_MODE');
  if (!drTx) return { movementErrors: await increaseInventoryForReturn(sb, h.id, userId) };
  const got = await receiveCreatedDrAtomically(drTx, sb, h.id, h.return_number, activeCompanyId(c) ?? null, userId);
  if (!got.ok) {
    if (got.removed) markIdempotencyNoWrite(c);
    return { refused: c.json(got.body, 503) };
  }
  await afterDrStockIn(sb, got.written, userId);
  return { movementErrors: [] };
}

async function resyncInventoryForReturn(sb: any, deliveryReturnId: string, performedBy: string): Promise<string[]> {
  const core = await drResyncCore(sb, deliveryReturnId, performedBy);
  await afterDrResync(sb, deliveryReturnId, core.written, performedBy);
  return core.errors;
}
async function afterDrResync(sb: any, deliveryReturnId: string, written: DrStockResult['written'], performedBy: string): Promise<void> {
  if (written.length > 0) {
    await reconcileUncostedAfterIn(sb, written, performedBy);
    try {
      const { recomputeAllocationAfterSave } = await import('../lib/stock-allocation-job');
      await recomputeAllocationAfterSave(sb, 'post-dr-resync');
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-dr-resync failed:', e); }
  }
  await reopenSoFromReturn(sb, deliveryReturnId, performedBy);
}


async function warehouseCodeMap(
  sb: any,
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (uniq.length === 0) return out;
  const { data } = await sb.from('warehouses').select('id, code, name').in('id', uniq);
  for (const w of (data ?? []) as Array<{ id: string; code: string | null; name: string | null }>) {
    out.set(w.id, warehouseLabel(w) ?? '');
  }
  return out;
}


async function reopenSoFromReturn(
  sb: any,
  deliveryReturnId: string,
  actorId?: string | null,
): Promise<void> {
  try {
    const docs = new Set<string>();
    const { data: drHdr } = await sb.from('delivery_returns')
      .select('delivery_order_id').eq('id', deliveryReturnId).maybeSingle();
    const doId = (drHdr as { delivery_order_id: string | null } | null)?.delivery_order_id ?? null;
    if (doId) {
      const { data: doHdr } = await sb.from('delivery_orders')
        .select('so_doc_no').eq('id', doId).maybeSingle();
      const so = (doHdr as { so_doc_no: string | null } | null)?.so_doc_no ?? null;
      if (so) docs.add(so);
    }
    if (docs.size === 0) {
      const { data: drItems } = await sb.from('delivery_return_items')
        .select('do_item_id').eq('delivery_return_id', deliveryReturnId);
      const doItemIds = [...new Set(((drItems ?? []) as Array<{ do_item_id: string | null }>)
        .map((r) => r.do_item_id).filter((x): x is string => !!x))];
      if (doItemIds.length > 0) {
        const { data: doItems } = await sb.from('delivery_order_items')
          .select('so_item_id').in('id', doItemIds);
        const soItemIds = [...new Set(((doItems ?? []) as Array<{ so_item_id: string | null }>)
          .map((r) => r.so_item_id).filter((x): x is string => !!x))];
        if (soItemIds.length > 0) {
          const { data: soItems } = await sb.from('mfg_sales_order_items')
            .select('doc_no').in('id', soItemIds);
          for (const r of (soItems ?? []) as Array<{ doc_no: string | null }>) {
            if (r.doc_no) docs.add(r.doc_no);
          }
        }
      }
    }
    if (docs.size === 0) return;
    const { syncSoDeliveredFromDo } = await import('../lib/so-delivery-sync');
    await syncSoDeliveredFromDo(sb, [...docs], actorId ?? null);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-delivered-sync] post-dr failed:', e); }
}

/* Commander 2026-05-30 (Phase B) — LINE-LEVEL, QUANTITY-BASED DO → Delivery
   Return remaining.

     remaining_to_return = delivered − returned          (owner 2026-09-20)

   NOT delivered − invoiced − returned. Returning used to share ONE pool with
   invoicing, so a fully-invoiced DO had remaining_to_return = 0 — the picker
   showed nothing and no return could be started. That blocked the ordinary
   retail flow: the customer pays, the DO is invoiced, THEN part of it comes
   back. Whether goods can come back is a fact about what physically shipped, not
   about billing, so this subtracts only prior returns and caps total returns at
   what was delivered.

   The INVOICE pool is unchanged — doLineRemaining/'invoiceable' still subtracts
   returned — so returned goods still can't be invoiced and nothing double-bills.
   The MONEY side of returning invoiced goods (credit note / AR reversal) is a
   separate, deferred phase; this only lets stock come back. Cancelling a return
   releases its qty (it drops out of `returned`). */
async function doReturnableRemaining(sb: any, doIds: string[]): Promise<DoRemainingResult> {
  /* 'delivered' — goods still on the lorry never left, so nothing can come
     back. The owner's 2026-08-20 ruling widened the INVOICE pool only. */
  const base = await doLineRemaining(sb, doIds, 'delivered');
  if (!base.ok) return base;
  return { ok: true, lines: returnableRemainingFrom(base.lines) };
}

type DrOverRemainingRefusal =
  | { status: 409; body: { error: string; message: string; lines: Array<{ doItemId: string; requested: number; remaining: number }> } }
  | { status: 503; body: { error: string; message: string } };

async function checkDrOverRemaining(
  sb: any,
  items: Array<Record<string, unknown>>,
): Promise<DrOverRemainingRefusal | null> {
  const wanted = new Map<string, number>();
  for (const it of items) {
    const doItemId = (it.doItemId as string | undefined) ?? null;
    if (!doItemId) continue;
    const q = Number(it.qtyReturned ?? it.qty ?? 0);
    wanted.set(doItemId, (wanted.get(doItemId) ?? 0) + q);
  }
  if (wanted.size === 0) return null;

  const ids = [...wanted.keys()];
  const { data: rows, error } = await sb
    .from('delivery_order_items')
    .select('id, delivery_order_id')
    .in('id', ids);
  if (error) return { status: 503, body: remainingUnavailableResponse(`delivery_order_items: ${error.message}`) };
  const doIds = [...new Set((rows ?? []).map((r: { delivery_order_id: string }) => r.delivery_order_id))] as string[];
  const remaining = await doReturnableRemaining(sb, doIds);
  if (!remaining.ok) return { status: 503, body: remainingUnavailableResponse(remaining.reason) };

  const offenders: Array<{ doItemId: string; requested: number; remaining: number }> = [];
  for (const [doItemId, requested] of wanted) {
    const open = remaining.lines.get(doItemId)?.remaining ?? 0;
    if (requested > open) offenders.push({ doItemId, requested, remaining: open });
  }
  if (offenders.length === 0) return null;
  return {
    status: 409,
    body: {
      error: 'over_remaining',
      message: 'One or more lines return more than the remaining (delivered − returned) quantity.',
      lines: offenders,
    },
  };
}

function buildItemRow(
  deliveryReturnId: string,
  it: Record<string, unknown>,
  sourceCostByDoItem?: Map<string, number>,
) {
  const qty = Number(it.qtyReturned ?? it.qty ?? 1);
  const unitPrice = Number(it.unitPriceSen ?? 0);
  const discount = Number(it.discountSen ?? 0);
  const doItemId = (it.doItemId as string | undefined) ?? undefined;
  const sourceCost = doItemId ? sourceCostByDoItem?.get(doItemId) : undefined;
  const unitCost = sourceCost !== undefined ? sourceCost : Number(it.unitCostSen ?? 0);
  const lineTotal = Math.max(0, (qty * unitPrice) - discount);
  const lineCost = qty * unitCost;
  const itemGroup = (it.itemGroup as string) ?? null;
  const variants = (it.variants as unknown) ?? null;
  const refund = it.refundSen !== undefined ? Number(it.refundSen) : lineTotal;
  return {
    delivery_return_id: deliveryReturnId,
    do_item_id: (it.doItemId as string | undefined) ?? null,
    item_code: it.itemCode,
    item_group: itemGroup,
    description: (it.description as string) ?? null,
    description2: buildVariantSummary(String(itemGroup ?? ''), (variants as Record<string, unknown> | null) ?? null) || (it.description2 as string) || null,
    uom: (it.uom as string) ?? 'UNIT',
    qty_returned: qty,
    condition: (it.condition as string) ?? null,
    unit_price_sen: unitPrice,
    discount_sen: discount,
    line_total_sen: lineTotal,
    unit_cost_sen: unitCost,
    line_cost_sen: lineCost,
    line_margin_sen: lineTotal - lineCost,
    refund_sen: refund,
    variants,
    notes: (it.notes as string | undefined) ?? null,
  };
}

export async function deliveryReturnListHandler(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const sb = c.get('supabase');
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));
  const filters = readDeliveryReturnListFilters((k) => c.req.query(k));
  const { data, error } = await orderDeliveryReturnList(
    filterDeliveryReturnList(sb.from('delivery_returns').select(HEADER), filters, c, scopeIds),
  ).limit(500);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const rows = (data ?? []) as unknown as Array<DrLineHeader & Record<string, unknown>>;
  await stampDrListSoDocNo(sb, c, rows);
  await stampDrListBookSpellings(sb, c, rows);
  gateDrListFinance(rows, canViewScmFinance(c));
  const attached = await attachDeliveryReturnLines(sb, c, rows);
  if (attached.error !== null) return c.json({ error: 'load_failed', reason: attached.error }, 500);
  return c.json({ deliveryReturns: attached.rows });
}
deliveryReturns.get('/', deliveryReturnListHandler);

/* Commander 2026-05-30 (Phase B) — feeds the line-level DO→Delivery Return
   picker. Returns each DO LINE that can still be returned (remaining > 0),
   where remaining = delivered − returned (derived live — invoicing does NOT
   remove a unit from the returnable pool, owner 2026-09-20). With
   ?doIds= it scopes to those DOs; without it, every non-cancelled DO.

   IMPORTANT (route ordering): this STATIC path MUST be registered BEFORE the
   `/:id` param route below, or Hono tries to cast it to an id.

   FINANCE: each descriptor carries the source DO line's `unitCostSen`, so this
   picker shipped every delivered line's unit cost to any caller who could reach
   it — #632 named it and correctly declined to strip it, because the New-Return
   form echoed the value back and the create path trusted it, so a strip alone
   would have booked every converted return at cost 0. That echo is now dead:
   buildItemRow re-reads the cost from the source DO line server-side and ignores
   the client. The strip is therefore safe, and it is done HERE at the response
   rather than inside doLineRemaining — that helper is shared with the SI/DR
   server-side convert paths, which legitimately need the real cost. camelCase is
   why no existing list matched this: SO_ITEM_FINANCE_KEYS is snake_case
   PostgREST vocabulary, and lib/finance-keys warns that a camelCasing surface
   must strip in ITS OWN vocabulary. This is that surface. */
deliveryReturns.get('/returnable-do-lines', async (c) => {
  const sb = c.get('supabase');
  // Company scope (owner 2026-08-10 audit) — see resolveCandidateDoIds.
  const candidates = await resolveCandidateDoIds(sb, c.req.query('doIds'), activeCompanyId(c), 'delivered');
  if (!candidates.ok) return c.json({ error: 'load_failed', reason: candidates.reason }, 500);
  if (candidates.doIds.length === 0) return c.json({ lines: [] });
  const remaining = await doReturnableRemaining(sb, candidates.doIds);
  if (!remaining.ok) return c.json({ error: 'load_failed', reason: remaining.reason }, 500);
  const lines = [...remaining.lines.values()].filter((l) => l.remaining > 0);
  if (!canViewScmFinance(c)) {
    for (const l of lines) delete (l as unknown as Record<string, unknown>).unitCostSen;
  }
  // The DO's order reference, for the picker's search (owner 2026-09-25).
  await stampDoLineSoRefs(sb, lines, (q) => scopeToCompany(q, c), 'returnable-do-lines');
  return c.json({ lines });
});

deliveryReturns.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    scopeToCompany(sb.from('delivery_returns').select(HEADER).eq('id', id), c).maybeSingle(),
    sb.from('delivery_return_items').select(ITEM).eq('delivery_return_id', id).order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  {
    const sp = (h.data as { salesperson_id?: number | string | null }).salesperson_id;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), sp)) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
  const rawItems = (i.data ?? []) as unknown as Array<{ id: string; do_item_id?: string | null } & Record<string, unknown>>;
  const headerWh = (h.data as { warehouse_id?: string | null }).warehouse_id ?? null;
  const lineWh = await resolveDrLineWarehouses(sb, rawItems, headerWh, activeCompanyId(c));
  const codeMap = await warehouseCodeMap(sb, [...lineWh.values()]);
  const items = rawItems.map((it) => {
    const wid = lineWh.get(it.id) ?? null;
    return { ...it, warehouse_id: wid, warehouse_code: wid ? (codeMap.get(wid) ?? null) : null };
  });
  gateDrFinance(c, h.data, items);
  // Stamp each line's supplier fabric code so the on-screen line reads
  // "BF-01 (PC151-01)" — same READ enrichment as the SO/PO/DO/SI details
  // (owner 2026-07-24). ONE batched query; fail-soft.
  await enrichLinesWithFabricSupplierCode(sb, c, items);
  const co = requireActiveCompanyId(c);
  const credit = co.ok ? await loadReturnCredit(sb, co.companyId, id, null) : null;
  const creditNote = credit?.ok
    ? { state: credit.value.state, notes: credit.value.notes.map((n) => ({ id: n.id, number: n.note_number, status: n.status })) }
    : { state: 'UNKNOWN', notes: [] };
  return c.json({ deliveryReturn: { ...(h.data as unknown as Record<string, unknown>), credit_note_state: creditNote.state }, items, creditNote });
});

async function insertHeader(sb: any, userId: string, body: Record<string, unknown>, c: any) {
  const phoneRaw = (body.phone as string | undefined) ?? null;
  const emPhoneRaw = (body.emergencyContactPhone as string | undefined) ?? null;
  /* Owner ruling 2026-07-16 — "要自動標記create order的人": with the picker left
     blank the DR landed unattributed, and now that the DR list/detail are
     row-scoped by salesperson_id the rep who created it could not see their own
     return. Fall back to the CREATOR's real scm.staff uuid, mirroring SO create
     (mfg-sales-orders.ts createSalesOrderCore). Lives in insertHeader so BOTH
     create paths get it: POST / (blank picker) and POST /from-do, which copies
     salesperson_id off the source DO header and yields NULL whenever that DO
     carries none.

     resolveCallerStaffId takes the REAL Houzs integer id from houzsUser —
     NEVER c.get('user').id, which inside /api/scm/* is the bridge's pinned
     system staff uuid (the documented 500 / mis-attribution trap).

     UNRESOLVABLE CALLER → NULL, deliberately NOT the pinned system row (this is
     where SO create differs: it degrades to user.id). Stamping the shared system
     uuid would attribute every such DR to one identity — the pos-cart bug (#633)
     — and, under the scoping this backstops, hand them to nobody while looking
     attributed. NULL stays honest: invisible to a scoped rep, visible to every
     view-all caller, who can assign the salesperson via PATCH /:id. */
  const salespersonId =
    (body.salespersonId as string | null | undefined) ??
    (await resolveCallerStaffId(sb, c.get('houzsUser')?.id));
  return insertWithDocNoRetry<{ id: string; return_number: string }>(
    () => nextNum(sb, c),
    (returnNumber) => sb.from('delivery_returns').insert({
    company_id: activeCompanyId(c),
    return_number: returnNumber,
    do_doc_no: (body.doDocNo as string) ?? null,
    delivery_order_id: (body.deliveryOrderId as string) ?? null,
    sales_invoice_id: (body.salesInvoiceId as string) ?? null,
    debtor_code: (body.debtorCode as string) ?? null,
    debtor_name: (body.debtorName ?? body.customerName) as string,
    return_date: dateOrNull(body.returnDate) ?? todayMyt(),
    reason: (body.reason as string) ?? null,
    address1: (body.address1 as string) ?? null,
    address2: (body.address2 as string) ?? null,
    city: (body.city as string) ?? null,
    state: (body.state as string) ?? (body.customerState as string) ?? null,
    customer_state: (body.customerState as string) ?? (body.state as string) ?? null,
    customer_country: (body.customerCountry as string) ?? null,
    postcode: (body.postcode as string) ?? null,
    phone: phoneRaw ? (normalizePhone(phoneRaw) ?? phoneRaw) : null,
    salesperson_id: salespersonId,
    agent: (body.agent as string) ?? null,
    email: (body.email as string) ?? null,
    customer_type: (body.customerType as string) ?? null,
    building_type: (body.buildingType as string) ?? null,
    branding: (body.branding as string) ?? null,
    venue: (body.venue as string) ?? null,
    venue_id: (body.venueId as string) ?? null,
    ref: (body.ref as string) ?? null,
    customer_so_no: (body.customerSoNo as string) ?? null,
    sales_location: (body.salesLocation as string) ?? null,
    note: (body.note as string) ?? null,
    emergency_contact_name: (body.emergencyContactName as string) ?? null,
    emergency_contact_phone: emPhoneRaw ? (normalizePhone(emPhoneRaw) ?? emPhoneRaw) : null,
    emergency_contact_relationship: (body.emergencyContactRelationship as string) ?? null,
    warehouse_id: (body.warehouseId as string) ?? null,
    currency: (body.currency as string) ?? 'MYR',
    status: 'RECEIVED',
    received_at: new Date().toISOString(),
    notes: (body.notes as string) ?? null,
    created_by: userId,
    }).select(HEADER).single(),
  );
}

async function crossCompanyDoSourceBlocked(sb: any, c: any, doIds: string[]) {
  const res = await crossCompanySourceRefusal(sb, c, 'delivery_orders', doIds, 'do_number');
  if (res && 'loadError' in res) {
    return {
      error: 'cross_company_check_failed',
      message: 'Could not verify which company that delivery order belongs to. Try again.',
    };
  }
  return res?.blocked ?? null;
}

export const createDeliveryReturnHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  /* company-scope: the only by-id write here is the ROLLBACK — the header this
     handler inserted moments earlier is deleted when the child insert fails.
     insertHeader / insertWithDocNoRetry stamp the active company on that row, so
     the id is not caller-supplied and cannot name another company's document.
     Verified 2026-08-13 by reading the handler end to end. */
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const debtorName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!debtorName) return c.json({ error: 'debtor_name_required' }, 400);
  let items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];
  if (!Array.isArray(items) || items.length === 0) return c.json({ error: 'items_required' }, 400);

  {
    const bad = items.find((it) => parseReturnLineQty(it.qtyReturned ?? it.qty) === null);
    if (bad) {
      return c.json({ error: 'invalid_qty', message: returnLineQtyMessage(bad.itemCode as string | undefined, bad.qtyReturned ?? bad.qty) }, 400);
    }
    items = items.map((it) => ({ ...it, qtyReturned: parseReturnLineQty(it.qtyReturned ?? it.qty) }));
  }

  const sb = c.get('supabase'); const user = c.get('user');

  {
    const codeCheck = await validateItemCodes(sb, items.map((it) => it.itemCode as string | null | undefined), activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* THE GROUP IS THE SKU'S, AND IT IS DECIDED ONCE — docs/bugs/0524.
     `item_group` is not a label, it is the input to the stock bucket
     (shared/variant-key.ts): the IN that puts the returned goods back on hand is keyed from the group
     STORED on the line, so a client that sends a blank or wrong one picks the
     bucket. Rewritten here, above every reader, so the value written and the
     value later keyed from cannot differ. #2660 closed the inbound half. */
  items = await resolveItemGroups(sb, items, activeCompanyId(c) ?? null);

  {
    const doIds: string[] = [];
    const headerDoId = (body.deliveryOrderId as string | undefined) ?? null;
    if (headerDoId) doIds.push(headerDoId);
    const doItemIds = [...new Set(items
      .map((it) => (it.doItemId as string | undefined) ?? null)
      .filter((x): x is string => !!x))];
    if (doItemIds.length > 0) {
      const { data: parents, error: parentsErr } = await sb.from('delivery_order_items')
        .select('delivery_order_id').in('id', doItemIds);
      if (parentsErr) return c.json({ error: 'lookup_failed', reason: parentsErr.message }, 500);
      for (const r of ((parents ?? []) as Array<{ delivery_order_id: string | null }>)) {
        if (r.delivery_order_id) doIds.push(r.delivery_order_id);
      }
    }
    const blocked = await crossCompanyDoSourceBlocked(sb, c, doIds);
    if (blocked) return c.json(blocked, 409);
  }

  {
    const unlinked = await findUnlinkedDrLines(
      sb,
      (body.deliveryOrderId as string | undefined) ?? null,
      (body.doDocNo as string | undefined) ?? null,
      items.map((it, idx) => ({
        lineRef: String(idx),
        itemCode: String(it.itemCode ?? ''),
        qty: Number(it.qtyReturned ?? it.qty ?? 0),
        soItemId: (it.doItemId as string | undefined) ?? null,
      })),
    );
    const bad = unlinkedScanRefusal(unlinked, (o) => unlinkedReturnResponse(o, 'delivery'));
    if (bad) return c.json(bad, 409);
  }

  {
    const svc = await findServiceLineCodes(sb, items.map((it) => ({
      itemCode: it.itemCode as string | null | undefined,
      itemGroup: it.itemGroup as string | null | undefined,
    })), activeCompanyId(c));
    if (!svc.ok) return c.json(serviceGuardUnavailableResponse(svc.reason), 409);
    if (svc.codes.length > 0) return c.json(serviceLinesNotReturnableResponse(svc.codes), 409);
  }

  {
    const freeEntry = items.filter((it) => !((it.doItemId as string | undefined) ?? null));
    if (freeEntry.length > 0) {
      return c.json({
        error: 'do_link_required',
        message: 'Every return line must reference a delivered Delivery Order line. Only shipped goods can be returned.',
        lines: freeEntry.map((it) => ({ itemCode: (it.itemCode as string) ?? null })),
      }, 409);
    }
  }

  {
    const over = await checkDrOverRemaining(sb, items);
    if (over) return c.json(over.body, over.status);
  }

  /* IDENTITY, not just the key — docs/bugs/0672 site 15. The guards around this
     one prove the delivery line's company and that the return does not exceed
     what was delivered; none proves it is the SAME PRODUCT. The return books
     stock back IN against this link and `doLineRemaining` subtracts it from the
     source line's remaining, so a wrong link returns goods to the wrong product
     and re-opens a delivery that was fully invoiced. */
  {
    const idc = await assertLinkedLineItemsMatch(sb, 'delivery_order_items',
      (items as Array<Record<string, unknown>>).map((it) => ({ linkId: (it.doItemId as string | undefined) ?? null, itemCode: it.itemCode })),
      { source: 'Delivery Order line' });
    if (!idc.ok) return c.json(idc.body, idc.status);
  }

  const { data: header, error: hErr } = await insertHeader(sb, user.id, body, c);
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; return_number: string };

  const sourceCostByDoItem = await sourceUnitCostByItemId(
    sb, 'delivery_order_items', items.map((it: Record<string, unknown>) => it.doItemId as string | undefined),
    activeCompanyId(c) ?? null);
  const rows = items.map((it) => buildItemRow(h.id, it, sourceCostByDoItem));
  const { error: iErr } = await sb.from('delivery_return_items').insert(stampCompany(rows, c));
  if (iErr) { await sb.from('delivery_returns').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }
  await recomputeTotals(sb, h.id);

  {
    const drItemDoIds = [...new Set(items
      .map((it) => (it.doItemId as string | undefined) ?? null)
      .filter((x): x is string => !!x))];
    if (drItemDoIds.length > 0) {
      const { data: rowsForDo, error: rowsErr } = await sb.from('delivery_order_items')
        .select('delivery_order_id').in('id', drItemDoIds);
      const doIds = [...new Set(((rowsForDo ?? []) as Array<{ delivery_order_id: string }>)
        .map((r) => r.delivery_order_id))];
      const recheck = rowsErr
        ? { ok: false as const, reason: `delivery_order_items: ${rowsErr.message}` }
        : await doReturnableRemaining(sb, doIds);
      if (!recheck.ok) {
        await sb.from('delivery_return_items').delete().eq('delivery_return_id', h.id);
        await sb.from('delivery_returns').delete().eq('id', h.id);
        return c.json(remainingUnavailableResponse(recheck.reason), 503);
      }
      const overReturned = drItemDoIds
        .map((doItemId) => recheck.lines.get(doItemId))
        .filter((l): l is DoRemainingLine => l !== undefined && l.remaining < 0);
      if (overReturned.length > 0) {
        await sb.from('delivery_return_items').delete().eq('delivery_return_id', h.id);
        await sb.from('delivery_returns').delete().eq('id', h.id);
        return c.json({
          error: 'race_conflict',
          message: 'Another operator just returned overlapping qty from this Delivery Order. Refresh and try again.',
          conflicts: overReturned.map((l) => ({ doNumber: l.doNumber, itemCode: l.itemCode, remaining: l.remaining })),
        }, 409);
      }
    }
  }

  const booked = await bookCreatedDrStock(c, sb, h, user.id);
  if ('refused' in booked) return booked.refused;
  const { movementErrors } = booked;

  try {
    const { recomputeAllocationAfterSave } = await import('../lib/stock-allocation-job');
    await recomputeAllocationAfterSave(sb, 'post-dr');
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-dr failed:', e); }

  await reopenSoFromReturn(sb, h.id, user.id);

  return c.json({ id: h.id, returnNumber: h.return_number, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
};
deliveryReturns.post('/', createDeliveryReturnHandler);

/* Commander 2026-05-30 (Phase B) — LINE-LEVEL, QUANTITY-BASED convert, mirroring
   the SO→DO /from-sos picker. Pick individual DO LINES (each with a qty
   1..remaining_to_return) of ONE customer and combine them into ONE Delivery
   Return. A DO line can be returned across SEVERAL returns until its remaining
   (delivered − returned, derived live) reaches 0. Invoicing no longer removes a
   unit from the returnable pool (owner 2026-09-20) — see doReturnableRemaining.

   Body: { picks: [{ doItemId, qty, condition? }] }.

   Steps:
     1. Resolve every picked DO line's parent DO + live remaining via
        doReturnableRemaining.
     2. Validate (a) all picks share ONE customer (else 400 mixed_customers),
        (b) each pick qty is 1..remaining_to_return (else 409 over_remaining).
     3. Create ONE return (status RECEIVED) — header copied from the FIRST
        pick's DO; one return line per pick (qty_returned = picked, do_item_id
        set). recomputeTotals, then increaseInventoryForReturn (idempotent).

   Mounted at both /from-do and /from-dos so existing callers keep working. */
export const convertDoLinesToReturn = async (c: any) => {
  let body: { picks?: Array<{ doItemId?: string; qty?: number; qtyReturned?: number; condition?: string }> };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const sb = c.get('supabase'); const user = c.get('user');

  const pickQtyById = new Map<string, number>();
  const conditionById = new Map<string, string>();
  for (const p of (body.picks ?? [])) {
    if (!p || !p.doItemId) continue;
    const q = Number(p.qty ?? p.qtyReturned ?? 0);
    if (!(q > 0)) continue;
    pickQtyById.set(p.doItemId, (pickQtyById.get(p.doItemId) ?? 0) + q);
    if (p.condition && !conditionById.has(p.doItemId)) conditionById.set(p.doItemId, p.condition);
  }
  if (pickQtyById.size === 0) return c.json({ error: 'picks_required' }, 400);

  const pickedIds = [...pickQtyById.keys()];
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
  const remainingResult = await doReturnableRemaining(sb, doIds);
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
      message: 'All picked Delivery Order lines must belong to the same customer to combine into one Delivery Return.',
      customers: [...customerNames],
    }, 400);
  }

  for (const id of pickedIds) {
    const line = remainingMap.get(id)!;
    const qty = pickQtyById.get(id)!;
    if (qty < 1 || qty > line.remaining) {
      return c.json({
        error: 'over_remaining',
        message: `${line.itemCode} on ${line.doNumber}: return qty ${qty} exceeds remaining ${line.remaining}.`,
        doItemId: id,
        doNumber: line.doNumber,
        itemCode: line.itemCode,
        remaining: line.remaining,
        requested: qty,
      }, 409);
    }
  }

  {
    const svc = await findServiceLineCodes(sb, pickedIds.map((id) => {
      const line = remainingMap.get(id)!;
      return { itemCode: line.itemCode, itemGroup: line.itemGroup };
    }), activeCompanyId(c));
    if (!svc.ok) return c.json(serviceGuardUnavailableResponse(svc.reason), 409);
    if (svc.codes.length > 0) return c.json(serviceLinesNotReturnableResponse(svc.codes), 409);
  }

  const sortedPicks = pickedIds
    .map((id) => remainingMap.get(id)!)
    .sort((a, b) => a.doNumber.localeCompare(b.doNumber) || a.doItemId.localeCompare(b.doItemId));
  const firstDoId = sortedPicks[0]!.deliveryOrderId;
  const distinctDoNumbers = [...new Set(sortedPicks.map((l) => l.doNumber))].sort();

  const { data: doHeader, error: dhErr } = await scopeToCompany(sb.from('delivery_orders')
    .select('id, do_number, debtor_code, debtor_name, phone, email, salesperson_id, agent, ' +
            'customer_type, building_type, branding, venue, venue_id, ref, customer_so_no, ' +
            'sales_location, customer_state, customer_country, address1, address2, city, state, postcode, ' +
            'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, ' +
            'warehouse_id, currency, note')
    .eq('id', firstDoId), c).maybeSingle();
  if (dhErr) return c.json({ error: 'load_failed', reason: dhErr.message }, 500);
  if (!doHeader) return c.json({ error: 'delivery_order_not_found' }, 404);
  const doh = doHeader as unknown as Record<string, unknown>;

  const { data: header, error: hErr } = await insertHeader(sb, user.id, {
    doDocNo: doh.do_number,
    deliveryOrderId: doh.id,
    debtorCode: doh.debtor_code,
    debtorName: doh.debtor_name,
    phone: doh.phone,
    email: doh.email,
    salespersonId: doh.salesperson_id,
    agent: doh.agent,
    customerType: doh.customer_type,
    buildingType: doh.building_type,
    branding: doh.branding,
    venue: doh.venue,
    venueId: doh.venue_id,
    ref: distinctDoNumbers.length > 1 ? `Merged from ${distinctDoNumbers.join(', ')}` : (doh.ref ?? null),
    customerSoNo: doh.customer_so_no,
    salesLocation: doh.sales_location,
    customerState: doh.customer_state,
    customerCountry: doh.customer_country,
    address1: doh.address1,
    address2: doh.address2,
    city: doh.city,
    state: doh.state,
    postcode: doh.postcode,
    emergencyContactName: doh.emergency_contact_name,
    emergencyContactPhone: doh.emergency_contact_phone,
    emergencyContactRelationship: doh.emergency_contact_relationship,
    warehouseId: doh.warehouse_id,
    currency: doh.currency,
    note: doh.note,
    reason: distinctDoNumbers.length > 1
      ? `Return from DO ${distinctDoNumbers.join(', ')}`
      : `Return from DO ${String(doh.do_number ?? '')}`,
  }, c);
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; return_number: string };

  const rows = sortedPicks.map((line) => buildItemRow(h.id, {
    doItemId: line.doItemId,
    itemCode: line.itemCode,
    itemGroup: line.itemGroup,
    description: line.description,
    uom: line.uom,
    qtyReturned: pickQtyById.get(line.doItemId)!,
    condition: conditionById.get(line.doItemId) ?? 'NEW',
    unitPriceSen: line.unitPriceSen,
    discountSen: line.discountSen,
    unitCostSen: line.unitCostSen,
    variants: line.variants,
  }));
  const { error: iErr } = await sb.from('delivery_return_items').insert(stampCompany(rows, c));
  if (iErr) { await sb.from('delivery_returns').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }
  await recomputeTotals(sb, h.id);

  {
    const recheck = await doReturnableRemaining(sb, doIds);
    if (!recheck.ok) {
      await sb.from('delivery_return_items').delete().eq('delivery_return_id', h.id);
      await sb.from('delivery_returns').delete().eq('id', h.id);
      return c.json(remainingUnavailableResponse(recheck.reason), 503);
    }
    const overReturned = pickedIds
      .map((doItemId) => recheck.lines.get(doItemId))
      .filter((l): l is DoRemainingLine => l !== undefined && l.remaining < 0);
    if (overReturned.length > 0) {
      await sb.from('delivery_return_items').delete().eq('delivery_return_id', h.id);
      await sb.from('delivery_returns').delete().eq('id', h.id);
      return c.json({
        error: 'race_conflict',
        message: 'Another operator just returned overlapping qty from this Delivery Order. Refresh and try again.',
        conflicts: overReturned.map((l) => ({ doNumber: l.doNumber, itemCode: l.itemCode, remaining: l.remaining })),
      }, 409);
    }
  }

  const booked = await bookCreatedDrStock(c, sb, h, user.id);
  if ('refused' in booked) return booked.refused;
  const { movementErrors } = booked;

  await reopenSoFromReturn(sb, h.id, user.id);

  return c.json({ id: h.id, returnNumber: h.return_number, lineCount: rows.length, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
};
deliveryReturns.post('/from-do', convertDoLinesToReturn);
deliveryReturns.post('/from-dos', convertDoLinesToReturn);

deliveryReturns.patch('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const map: Array<[string, string]> = [
    ['debtorCode', 'debtor_code'], ['debtorName', 'debtor_name'], ['agent', 'agent'],
    ['salesLocation', 'sales_location'], ['ref', 'ref'],
    ['venue', 'venue'], ['venueId', 'venue_id'], ['branding', 'branding'],
    ['address1', 'address1'], ['address2', 'address2'],
    ['city', 'city'], ['state', 'state'], ['postcode', 'postcode'], ['phone', 'phone'],
    ['note', 'note'], ['notes', 'notes'], ['reason', 'reason'],
    ['returnDate', 'return_date'], ['currency', 'currency'],
    ['customerState', 'customer_state'], ['customerCountry', 'customer_country'],
    ['customerSoNo', 'customer_so_no'],
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
  coerceEmptyDates(updates);
  if (Object.keys(updates).length === 1) return c.json({ ok: true, changed: 0 });

  const { data, error } = await scopeToCompanyId(sb.from('delivery_returns').update(updates).eq('id', id), co.companyId).select('id').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true, id });
});

export const addDeliveryReturnItemHandler = async (c: Context<{ Bindings: Env; Variables: Variables }, '/:id/items'>) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);
  {
    const q = parseReturnLineQty(it.qtyReturned ?? it.qty);
    if (q === null) return c.json({ error: 'invalid_qty', message: returnLineQtyMessage(it.itemCode as string, it.qtyReturned ?? it.qty) }, 400);
    it = { ...it, qtyReturned: q };
  }

  if (!((it.doItemId as string | undefined) ?? null)) {
    return c.json({
      error: 'do_link_required',
      message: 'Every return line must reference a delivered Delivery Order line. Only shipped goods can be returned.',
    }, 409);
  }

  {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* SKU wins, decided once — docs/bugs/0524. Same rule as the create path: the
     stored group is what the stock movement is keyed from. */
  it = (await resolveItemGroups(sb, [it], activeCompanyId(c) ?? null))[0]!;

  {
    const svc = await findServiceLineCodes(sb, [{
      itemCode: it.itemCode as string | null | undefined,
      itemGroup: it.itemGroup as string | null | undefined,
    }], activeCompanyId(c));
    if (!svc.ok) return c.json(serviceGuardUnavailableResponse(svc.reason), 409);
    if (svc.codes.length > 0) return c.json(serviceLinesNotReturnableResponse(svc.codes), 409);
  }

  const { data: header } = await scopeToCompanyId(sb.from('delivery_returns').select('id').eq('id', id), co.companyId).maybeSingle();
  if (!header) return c.json(NOT_THIS_COMPANY, 404);

  {
    const over = await checkDrOverRemaining(sb, [it]);
    if (over) return c.json(over.body, over.status);
  }

  /* IDENTITY, not just the key — docs/bugs/0672 site 15. The guards around this
     one prove the delivery line's company and that the return does not exceed
     what was delivered; none proves it is the SAME PRODUCT. The return books
     stock back IN against this link and `doLineRemaining` subtracts it from the
     source line's remaining, so a wrong link returns goods to the wrong product
     and re-opens a delivery that was fully invoiced. */
  {
    const idc = await assertLinkedLineItemsMatch(sb, 'delivery_order_items',
      [{ linkId: (it.doItemId as string | undefined) ?? null, itemCode: it.itemCode }],
      { source: 'Delivery Order line' });
    if (!idc.ok) return c.json(idc.body, idc.status);
  }

  const row = buildItemRow(id, it, await sourceUnitCostByItemId(
    sb, 'delivery_order_items', [it.doItemId as string | undefined],
    activeCompanyId(c) ?? null));
  const { data, error } = await sb.from('delivery_return_items').insert({ ...row, company_id: activeCompanyId(c) }).select(ITEM).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  let resyncErrs: string[] = [];
  try { resyncErrs = await resyncInventoryForReturn(sb, id, c.get('user')?.id); }
  catch (e) { resyncErrs = [`return resync threw: ${(e as Error)?.message ?? 'unknown'}`]; }
  return c.json({ item: data, movementErrors: resyncErrs.length ? resyncErrs : undefined }, 201);
};
deliveryReturns.post('/:id/items', addDeliveryReturnItemHandler);

deliveryReturns.patch('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  if (it.itemCode !== undefined) {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  const { data: prev } = await scopeToCompanyId(sb.from('delivery_return_items')
    .select('qty_returned, unit_price_sen, discount_sen, unit_cost_sen, item_code, item_group, description, uom, variants, notes, condition, do_item_id')
    .eq('id', itemId).eq('delivery_return_id', id), co.companyId).maybeSingle();
  if (!prev) return c.json(NOT_THIS_COMPANY, 404);

  /* SKU wins on the EDIT half too — docs/bugs/0524. An edit that names a group,
     or re-points the code, decides which bucket this line's stock resync moves;
     the group stored is the SKU's. Every reader below takes
     `it.itemGroup ?? prev.item_group`, so one assignment settles the stored
     column, description2 and the resync's key together.
     ONLY when the request touches identity. An edit that changes neither is
     left exactly as it was: repairing rows this request did not touch is a
     different, write-shaped job that needs the probe's count first (#2671). */
  if (it.itemGroup !== undefined || it.itemCode !== undefined) {
    const [resolved] = await resolveItemGroups(sb, [{
      itemCode: (it.itemCode ?? prev.item_code) as string | null,
      itemGroup: (it.itemGroup ?? prev.item_group) as string | null,
    }], activeCompanyId(c) ?? null);
    it.itemGroup = resolved?.itemGroup ?? null;
  }

  if (it.itemCode !== undefined || it.itemGroup !== undefined) {
    const svc = await findServiceLineCodes(sb, [{
      itemCode: (it.itemCode ?? prev.item_code) as string | null | undefined,
      itemGroup: (it.itemGroup ?? prev.item_group) as string | null | undefined,
    }], activeCompanyId(c));
    if (!svc.ok) return c.json(serviceGuardUnavailableResponse(svc.reason), 409);
    if (svc.codes.length > 0) return c.json(serviceLinesNotReturnableResponse(svc.codes), 409);
  }

  let qty = Number(prev.qty_returned);
  if ((it.qtyReturned ?? it.qty) !== undefined) {
    const q = parseReturnLineQty(it.qtyReturned ?? it.qty);
    if (q === null) return c.json({ error: 'invalid_qty', message: returnLineQtyMessage((it.itemCode ?? prev.item_code) as string, it.qtyReturned ?? it.qty) }, 400);
    qty = q;
  }
  if (qty < Number(prev.qty_returned ?? 0)) {
    const held = await creditNoteHold(sb, co.companyId, [{ itemId, qty }]);
    if (held) return c.json({ error: held.error, message: held.message }, held.status);
  }

  {
    const doItemId = (prev as { do_item_id?: string | null }).do_item_id ?? null;
    const delta = qty - Number(prev.qty_returned ?? 0);
    if (doItemId && delta > 0) {
      const over = await checkDrOverRemaining(sb, [{ doItemId, qtyReturned: delta } as Record<string, unknown>]);
      if (over) return c.json(over.body, over.status);
    }
  }

  const unitPrice = it.unitPriceSen !== undefined ? Number(it.unitPriceSen) : Number(prev.unit_price_sen);
  const discount = it.discountSen !== undefined ? Number(it.discountSen) : Number(prev.discount_sen);
  const unitCost = (canViewScmFinance(c) && it.unitCostSen !== undefined)
    ? Number(it.unitCostSen)
    : Number(prev.unit_cost_sen);
  const lineTotal = Math.max(0, (qty * unitPrice) - discount);
  const lineCost = qty * unitCost;

  const updates: Record<string, unknown> = {
    qty_returned: qty, unit_price_sen: unitPrice, discount_sen: discount, unit_cost_sen: unitCost,
    line_total_sen: lineTotal, line_cost_sen: lineCost, line_margin_sen: lineTotal - lineCost,
    refund_sen: lineTotal,
  };
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['itemGroup', 'item_group'], ['description', 'description'],
    ['uom', 'uom'], ['variants', 'variants'], ['notes', 'notes'], ['condition', 'condition'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  {
    const effGroup = (it.itemGroup ?? prev.item_group) as string | null | undefined;
    const effVariants = (it.variants ?? prev.variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  {
    const repoint = await unlinkedEditRefusal(sb, 'delivery-return', {
      parent: { table: 'delivery_returns', column: 'delivery_order_id', id, companyId: co.companyId },
      storedLink: (prev as { do_item_id?: string | null }).do_item_id ?? null,
      storedCode: (prev as { item_code?: string | null }).item_code ?? null,
      patchCode: it.itemCode,
    });
    if (repoint) return c.json(repoint, 409);
  }

  const { error } = await scopeToCompanyId(sb.from('delivery_return_items').update(updates).eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  let resyncErrs: string[] = [];
  try { resyncErrs = await resyncInventoryForReturn(sb, id, user?.id); }
  catch (e) { resyncErrs = [`return resync threw: ${(e as Error)?.message ?? 'unknown'}`]; }
  return c.json({ ok: true, movementErrors: resyncErrs.length ? resyncErrs : undefined });
});

deliveryReturns.delete('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  {
    const { data: line } = await scopeToCompanyId(sb.from('delivery_return_items')
      .select('id').eq('id', itemId).eq('delivery_return_id', id), co.companyId).maybeSingle();
    if (!line) return c.json(NOT_THIS_COMPANY, 404);
  }
  {
    const held = await creditNoteHold(sb, co.companyId, [{ itemId, qty: 0 }]);
    if (held) return c.json({ error: held.error, message: held.message }, held.status);
  }
  const { error } = await scopeToCompanyId(sb.from('delivery_return_items').delete().eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  let resyncErrs: string[] = [];
  try { resyncErrs = await resyncInventoryForReturn(sb, id, user?.id); }
  catch (e) { resyncErrs = [`return resync threw: ${(e as Error)?.message ?? 'unknown'}`]; }
  return c.json({ ok: true, movementErrors: resyncErrs.length ? resyncErrs : undefined });
});

export const patchDeliveryReturnStatusHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: { status?: string; inspectionNotes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.status) return c.json({ error: 'status_required' }, 400);

  const toStatus = String(body.status).trim().toUpperCase();

  const { data: cur } = await scopeToCompanyId(sb.from('delivery_returns').select('status').eq('id', id), co.companyId).maybeSingle();
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const prevStatus = (cur as { status: string }).status;
  if (toStatus === 'CANCELLED' && prevStatus === 'CANCELLED') {
    return c.json({ deliveryReturn: { id, status: 'CANCELLED' } });
  }
  if (prevStatus === 'CANCELLED') {
    return c.json({
      error: 'dr_cancelled_final',
      reason: 'A cancelled Delivery Return cannot be reactivated — its stock entry was already drained. Create a new return instead.',
    }, 409);
  }

  if (toStatus === 'CANCELLED') {
    const { data: lines, error: lErr } = await scopeToCompanyId(sb.from('delivery_return_items').select('id').eq('delivery_return_id', id), co.companyId);
    if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);
    const held = await creditNoteHold(sb, co.companyId, ((lines ?? []) as Array<{ id: string }>).map((l) => ({ itemId: l.id, qty: 0 })));
    if (held) return c.json({ error: held.error, message: held.message }, held.status);
  }

  const now = new Date().toISOString();
  const ts: Record<string, string> = { updated_at: now, status: toStatus };
  if (toStatus === 'RECEIVED') ts.received_at = now;
  if (toStatus === 'INSPECTED') { ts.inspected_at = now; if (body.inspectionNotes) ts.inspection_notes = body.inspectionNotes; }
  if (toStatus === 'REFUNDED') ts.refunded_at = now;

  /* COMPARE-AND-SET on the status we read. Every status write — cancel and the
     RECEIVED / INSPECTED / REFUNDED stamps alike — carries `.eq('status',
     prevStatus)`, so a write that lost a race matches zero rows instead of
     overwriting the winner. The CANCELLED gate above is a read; without this a
     REFUNDED landing just after a concurrent cancel turned CANCELLED back into
     REFUNDED with the stock already drained (Hookka #1130 sister). Two cancels
     racing: Postgres serialises the UPDATEs, one wins and fires the single
     reversal, the loser re-reads CANCELLED and echoes without reversing. */
  const write = (db: any): Promise<DrFlipResult> => scopeToCompanyId(db.from('delivery_returns')
    .update(ts).eq('id', id), co.companyId).eq('status', prevStatus)
    .select('id, status').maybeSingle()
    .then((r: unknown) => r as DrFlipResult, (e: { message: string; code?: string }) => ({ data: null, error: e }));
  const drTx = toStatus === 'CANCELLED' ? stockTxFor(c.env, 'DELIVERY_RETURN_MODE') : null;
  let drained: DrStockResult['written'] | null = null;
  let flipped: DrFlipResult;
  if (drTx) {
    const out = await cancelDrAtomically(drTx, id, user.id, write);
    if (out.ok) { flipped = { data: out.data, error: null }; drained = out.written; }
    else if (isDrFlipMiss(out)) flipped = out.flip;
    else return c.json(drStockFailureBody('cancelled', out), 503);
  } else flipped = await write(sb);
  const { data: updated, error } = flipped;
  if (toStatus === 'CANCELLED' && isSoLineOverDelivered(error)) return c.json({ error: 'cancel_over_delivers', message: 'Cancelling this return would put a Sales Order line above its ordered qty, because a later Delivery Order already re-shipped the returned units. Cancel or reduce that Delivery Order first.', reason: error?.message }, 409);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!updated) {
    const { data: latest, error: reErr } = await scopeToCompanyId(sb.from('delivery_returns').select('status').eq('id', id), co.companyId).maybeSingle();
    if (reErr) return c.json({ error: 'status_changed', message: 'This return was changed by someone else just now and its new state could not be read. Nothing was saved. Refresh and check before trying again.', reason: reErr.message }, 409);
    if (!latest) return c.json(NOT_THIS_COMPANY, 404);
    const nowStatus = (latest as { status: string }).status;
    if (toStatus === 'CANCELLED' && nowStatus === 'CANCELLED') {
      return c.json({ deliveryReturn: { id, status: 'CANCELLED' } });
    }
    const message = `This return was changed by someone else just now (it is now ${nowStatus}, it was ${prevStatus} when you started). Nothing was saved. Refresh and check before trying again.`;
    return c.json({ error: 'status_changed', message, reason: message, currentStatus: nowStatus }, 409);
  }
  const data = updated as { id: string; status: string };

  let resyncErrs: string[] = [];
  if (toStatus === 'CANCELLED') {
    resyncErrs = [];
    if (drained) await afterDrResync(sb, id, drained, user.id);
    else {
      try { resyncErrs = await resyncInventoryForReturn(sb, id, user.id); }
      catch (e) { resyncErrs = [`return resync threw: ${(e as Error)?.message ?? 'unknown'}`]; }
    }
    try {
      const { recomputeAllocationAfterSave } = await import('../lib/stock-allocation-job');
      await recomputeAllocationAfterSave(sb, 'post-dr-cancel');
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-dr-cancel failed:', e); }
  }

    return c.json({ deliveryReturn: data, movementErrors: resyncErrs.length ? resyncErrs : undefined });
};
deliveryReturns.patch('/:id/status', patchDeliveryReturnStatusHandler);
