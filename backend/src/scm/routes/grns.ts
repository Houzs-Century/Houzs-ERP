
import { yymmFor } from '../../services/documentRefs';
import { poPriceByPoItemId, poRefByPoItemId, stampGrnLinePoRefs, type LinePoRef } from '../lib/line-po-ref';
import { Hono } from 'hono';
import { GRN_STATUS_BUCKETS } from '../lib/grn-status-buckets';
import { GRN_HEADER_COLS, GRN_LIST_SELECT, grnListSelect, filterGrnList, orderGrnList, readGrnListFilters } from '../lib/grn-list-read'; import { attachGrnLines } from '../lib/grn-export-rows';
import { HELD_OR_TERM, isDocumentHeld } from '../lib/document-hold';
import { isReceivablePo } from '../lib/source-document-gates'; import { mountHoldRoute } from './document-hold-routes';
import type { Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { createDraftGrnsFromPoItemsCore, type GrnFromPoItemsContext } from '../lib/grn-from-po-core';
import { getSupabaseService } from '../../db/supabase';
import { noteGrnScanAccepted } from '../lib/grn-scan-review';
import { writeMovements, defaultWarehouseId } from '../lib/inventory-movements';
import { dateOrNull, coerceEmptyDates } from '../lib/date-coerce';
import { grnHasDownstream } from '../lib/downstream-lock';
import { isPoLineOverReceived, qtyCapRefusal } from '../lib/qty-cap';
import { enqueueConvert, recordParentlessCreate, enqueueCancel, retiredLineOf, type AcRetiredLine } from '../lib/autocount-outbox';
import { sourcePoIdsForGrn } from '../lib/convert-parent';
import { queueAcGrnEdit } from '../lib/ac-grn-outbox';
import { buildGrnCancelReversals } from '../lib/grn-cancel-reversal';
import { grnReverseWouldGoNegative } from '../lib/grn-reverse-guard';
import { isMigratedNoStock } from '../lib/migrated-no-stock';
import { loadGrnAuditMeta } from '../lib/grn-audit-meta';
import { runScmPgCommand } from '../lib/pg-supabase-transaction';
import { isStockTxFailure, STOCK_TX_ROLLED_BACK, stockTxFailureBody, stockTxFor, type StockTx } from '../lib/stock-post-tx'; import { isoDayOf, runGrnPostTail, type GrnPostTail } from '../lib/grn-post-tail';
import { scheduleStockAllocationAfterCommand } from '../lib/stock-allocation-job';

import { reconcileUncostedAfterIn } from '../lib/oversell-retrocost';
import { buildVariantSummary, computeVariantKey, effectiveDelivery, isServiceLine, type VariantAttrs } from '../shared';
import {
  orderSofaModuleRowsWithinBuilds,
  sortSoLinesByGroupRank,
} from '../shared/so-line-display';
import { recostFromGrn } from '../lib/recost';
import { normalizeExchangeRate, toMyrSen, normalizeCurrency, masterRateForCurrency } from '../lib/fx';
import { assertForeignRatePostable, assertForeignRatePatchable } from '../lib/fx-guard';
import { allocateLandedCharges, normalizeAllocationMethod } from '../lib/landed-allocation';
import { findUnlinkedPoLines, unlinkedPoLinesResponse } from '../lib/grn-unlinked-po-lines';
import { unlinkedEditRefusal, unlinkedScanRefusal } from '../lib/unlinked-line-edit-guard';
import { computeGrnFlags } from '../lib/grn-consumption-flags';
import {
  parsePoIdScope, loadOutstandingPoLines, toOutstandingPoItems,
} from '../lib/outstanding-po-lines';
import { checkReceiptCosts, refuseZeroCostReceipt, zeroCostAckColumns, ZERO_COST_RECEIPT_ERROR, type ReceiptCostLine } from '../lib/zero-cost-receipt-guard';
import { refuseWithoutWriting } from '../lib/no-write-refusal'; import { LINES_UNREADABLE, linesUnreadableBody } from '../lib/failed-read-refusal'; import { readFailure } from '../lib/read-failure'; import { grnReceiptBooked } from '../lib/grn-receipt-booked';
import { grnPostRefusal } from '../lib/grn-post-capability';
import { getGrnItemRacksHandler, grnRackSplitPostRefusal, putGrnItemRacksHandler } from '../lib/grn-line-racks';
import { grnInheritedFieldChanges, grnInheritedLockedRefusal, grnHeaderInheritedChanges, grnHeaderInheritedRefusal, type GrnLinePrev, type GrnLinePatch } from '../lib/grn-inherited-lock';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  isCrossCompanySource, crossCompanyConversionBlocked, crossCompanySourceRefusal,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';

import { assertSourceLinesInCompany } from '../lib/ref-in-company';
import { assertPoLinesFromSupplier } from '../lib/grn-po-supplier';
import { parseLineNumbers, invalidLineNumberBody } from '../shared/line-numbers';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { todayMyt } from '../lib/my-time';
import { paginateAll } from '../lib/paginate-all';
import { readStatusCounts } from '../lib/status-counts';
import { recordEntityAudit, assertAuditWritable, auditUnavailableBody, diffFields, compactChanges, fieldChange, statusChange } from '../lib/entity-audit';
import { GRN_LINE_AUDIT_FIELDS, GRN_LINE_AUDIT_SELECT } from '../lib/entity-audit-fields';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { eager } from '../lib/concurrency';
import { keyedVariantWithWarning, skuCategoryResolver, lineIdentityFields } from '../lib/sku-category';
import * as bk from '../lib/stock-bucket-key';
import { pgrestIn } from '../lib/pgrest-in-list';
import { setGrnLineRackHandler } from '../lib/grn-line-rack';
import { grnLineNetReceived } from '../lib/po-net-received';
import { stepClock, timed } from '../../lib/step-timing';

export const grns = new Hono<{ Bindings: Env; Variables: Variables }>();
grns.use('*', supabaseAuth);


const GRN_AUDIT_FIELDS: Array<[string, string]> = [
  ['supplierId', 'supplier_id'], ['receivedAt', 'received_at'],
  ['deliveryNoteRef', 'delivery_note_ref'], ['warehouseId', 'warehouse_id'],
  ['notes', 'notes'], ['currency', 'currency'],
  ['exchangeRate', 'exchange_rate'], ['allocationMethod', 'allocation_method'],
];

const GRN_AUDIT_SELECT =
  `id, grn_number, status, company_id, ${GRN_AUDIT_FIELDS.map(([, snake]) => snake).join(', ')}`;



/**
 * Record the CREATE of a GRN that has SURVIVED its handler.
 *
 * Reads the row back rather than taking the caller's payload, for two reasons.
 * The receipt's stored shape is what a reader is being told about — currency and
 * exchange_rate are resolved server-side, the warehouse may have been derived
 * from the PO lines, and total_sen only exists after recomputeGrnTotals. And a
 * header that a compensating branch already deleted reads back as nothing, so a
 * CREATE row can never describe a rolled-back document even if a future edit
 * moves this call earlier by mistake.
 */
export async function recordGrnCreate(
  sb: Variables['supabase'],
  actor: Variables['houzsUser'],
  fallbackCompanyId: number | null | undefined,
  grnId: string,
  lineCount: number,
  note?: string,
): Promise<void> {
  let row: Record<string, unknown> | null = null;
  try {
    const { data } = await sb.from('grns')
      .select('id, grn_number, status, company_id, supplier_id, warehouse_id, purchase_order_id, ' +
        'received_at, delivery_note_ref, currency, exchange_rate, allocation_method, total_sen')
      .eq('id', grnId).maybeSingle();
    row = (data ?? null) as Record<string, unknown> | null;
  } catch { }
  if (!row) return;
  await recordEntityAudit(sb, {
    entityType: 'GRN',
    entityId: grnId,
    entityDocNo: (row.grn_number as string | null) ?? null,
    action: 'CREATE',
    actor,
    companyId: (row.company_id as number | null) ?? fallbackCompanyId,
    statusSnapshot: (row.status as string | null) ?? null,
    note,
    fieldChanges: compactChanges([
      fieldChange('status', null, row.status ?? null),
      fieldChange('supplierId', null, row.supplier_id ?? null),
      fieldChange('purchaseOrderId', null, row.purchase_order_id ?? null),
      fieldChange('warehouseId', null, row.warehouse_id ?? null),
      fieldChange('receivedAt', null, row.received_at ?? null),
      fieldChange('deliveryNoteRef', null, row.delivery_note_ref ?? null),
      fieldChange('currency', null, row.currency ?? null),
      fieldChange('exchangeRate', null, row.exchange_rate ?? null),
      fieldChange('allocationMethod', null, row.allocation_method ?? null),
      fieldChange('totalSen', null, row.total_sen ?? null),
      fieldChange('lineCount', null, lineCount),
    ]),
  });
}


/* Resolve the receive-into warehouse for a GRN WITHOUT ever silently falling
   back to the default (first, code-sorted = China/transit) warehouse. Returns
   the explicit body warehouse when the form sent one; else the single warehouse
   the PO-linked lines all bind to (the authoritative per-warehouse binding at
   the PO line — the auto-resolution the post chokepoint also honours); else
   null so the caller rejects with a plain 400 instead of dumping received stock
   into the wrong (transit) warehouse. (Owner 2026-07-02 China/transit fix — this
   is the server-side counterpart to the FE `GrnNew.tsx` required-picker guard;
   before this a manual / mixed-warehouse GRN with no warehouseId in the body
   still landed in defaultWarehouseId server-side.) */
async function resolveReceiveWarehouse(
  sb: any,
  explicitWarehouseId: string | null,
  poItemIds: Array<string | null | undefined>,
): Promise<string | null> {
  if (explicitWarehouseId) return explicitWarehouseId;
  const ids = [...new Set(poItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return null;
  const { data: whRows } = await sb.from('purchase_order_items')
    .select('warehouse_id').in('id', ids);
  const whs = [...new Set(((whRows ?? []) as Array<{ warehouse_id: string | null }>)
    .map((r) => r.warehouse_id).filter((x): x is string => Boolean(x)))];
  return whs.length === 1 ? whs[0]! : null;
}

export async function resolvePoBatchByItem(
  sb: any,
  poItemIds: Array<string | null>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(poItemIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return out;
  const { data: poi } = await sb.from('purchase_order_items')
    .select('id, purchase_order_id').in('id', ids);
  const rows = (poi ?? []) as Array<{ id: string; purchase_order_id: string | null }>;
  const poIds = [...new Set(rows.map((r) => r.purchase_order_id).filter((x): x is string => !!x))];
  if (poIds.length === 0) return out;
  const { data: pos } = await sb.from('purchase_orders')
    .select('id, po_number').in('id', poIds);
  const poNo = new Map<string, string>();
  for (const p of (pos ?? []) as Array<{ id: string; po_number: string }>) poNo.set(p.id, p.po_number);
  for (const r of rows) {
    const n = r.purchase_order_id ? poNo.get(r.purchase_order_id) : undefined;
    if (n) out.set(r.id, n);
  }
  return out;
}

export async function resolveGrnFx(
  sb: any,
  poId: string | null | undefined,
  bodyCurrency: unknown,
  bodyRate: unknown,
): Promise<{ currency: string; exchange_rate: number }> {
  let currency = normalizeCurrency(bodyCurrency);
  if (poId && !bodyCurrency) {
    const { data: poRow } = await sb.from('purchase_orders')
      .select('currency').eq('id', poId).maybeSingle();
    const poCur = (poRow as { currency?: string | null } | null)?.currency;
    if (poCur) currency = normalizeCurrency(poCur);
  }
  const rateRaw = bodyRate !== undefined && bodyRate !== null
    ? bodyRate
    : await masterRateForCurrency(sb, currency);
  return { currency, exchange_rate: normalizeExchangeRate(rateRaw, currency) };
}

/* ── Landed-cost allocation (migration 0082) — "平摊" ────────────────────────
   Compute each goods line's share of the SERVICE-line (freight) charge pool and
   PERSIST it onto grn_items.allocated_charge_sen, so the FIFO lot cost and a
   later PI recost both fold it in deterministically. Returns the allocation
   result (with per-line landed unit cost) so the caller can stamp the IN
   movements. Pure-on-empty: chargePool === 0 ⇒ allocation 0 everywhere ⇒ no
   writes ⇒ byte-for-byte no-op for a GRN with no service lines. */
type AllocItemRow = {
  id: string; qty_accepted: number; item_code: string;
  unit_price_sen: number | null; line_total_sen?: number | null;
  item_group?: string | null;
};
async function computeAndStoreGrnAllocation(
  sb: any,
  items: AllocItemRow[],
  grnRate: unknown,
  method: ReturnType<typeof normalizeAllocationMethod>,
  companyId: number | null,
) {
  const m3ByCode = new Map<string, number>();
  const codes = [...new Set(items.map((it) => it.item_code).filter(Boolean))];
  if (codes.length > 0) {
    const volQ = pgrestIn(sb.from('mfg_products').select('code, unit_m3_milli'), 'code', codes);
    const { data: prods } = await (companyId != null ? volQ.eq('company_id', companyId) : volQ);
    for (const p of (prods ?? []) as Array<{ code: string; unit_m3_milli: number | null }>) {
      m3ByCode.set(p.code, Number(p.unit_m3_milli ?? 0));
    }
  }
  const alloc = allocateLandedCharges(
    items.map((it) => ({
      id: it.id,
      itemGroup: it.item_group ?? null,
      itemCode: it.item_code,
      qty: Number(it.qty_accepted ?? 0),
      amountSen: Number(it.line_total_sen ?? 0),
      unitPriceSen: Number(it.unit_price_sen ?? 0),
      unitM3Milli: m3ByCode.get(it.item_code) ?? 0,
    })),
    method,
    grnRate,
  );
  const anyToReset = items.some((it) => Number((it as { allocated_charge_sen?: number | null }).allocated_charge_sen ?? 0) !== 0);
  if (alloc.chargePoolMyr > 0 || anyToReset) {
    await Promise.all(alloc.goods.map((g) =>
      sb.from('grn_items').update({ allocated_charge_sen: g.allocatedChargeSen }).eq('id', g.id),
    ));
  }
  return alloc;
}

async function reallocateGrnCharges(sb: any, grnId: string, companyId: number | null): Promise<void> {
  const { data: head, error: headErr } = await sb.from('grns')
    .select('exchange_rate, allocation_method').eq('id', grnId).maybeSingle();
  if (headErr) return;
  const grnRate = (head as { exchange_rate?: string | number | null } | null)?.exchange_rate ?? 1;
  const method = normalizeAllocationMethod((head as { allocation_method?: string | null } | null)?.allocation_method);
  const { data: items } = await sb.from('grn_items')
    .select('id, qty_accepted, item_code, unit_price_sen, line_total_sen, item_group, allocated_charge_sen')
    .eq('grn_id', grnId);
  await computeAndStoreGrnAllocation(sb, (items ?? []) as AllocItemRow[], grnRate, method, companyId);
}

export type ZeroCostRefusal = NonNullable<Awaited<ReturnType<typeof checkReceiptCosts>>>;
type GrnCostGateRow = {
  id: string; qty_accepted: number; item_code: string;
  unit_price_sen: number | null; line_total_sen?: number | null;
  item_group?: string | null; zero_cost_ack?: boolean | null;
};
async function checkGrnZeroCost(
  sb: any,
  items: GrnCostGateRow[],
  grnHeader: { company_id?: number | null; exchange_rate?: string | number | null } | null,
): Promise<ZeroCostRefusal | null> {
  if (items.length === 0) return null;
  const rate = grnHeader?.exchange_rate ?? 1;
  const chargePool = items
    .filter((it) => isServiceLine({ itemGroup: it.item_group ?? null, itemCode: it.item_code }))
    .reduce((sum, it) => sum + Math.abs(Number(it.line_total_sen ?? 0)), 0);
  if (chargePool > 0) return null;
  const lines: ReceiptCostLine[] = items.map((it) => ({
    id: it.id,
    itemCode: it.item_code,
    qtyAccepted: Number(it.qty_accepted ?? 0),
    unitCostSen: toMyrSen(Number(it.unit_price_sen ?? 0), rate),
    itemGroup: it.item_group ?? null,
    zeroCostAck: it.zero_cost_ack ?? false,
  }));
  return checkReceiptCosts(sb, lines, grnHeader?.company_id ?? null);
}

type GrnPostResult = { ok: true; movementErrors?: string[]; recountError?: string } | { ok: false; reason: string; status?: number; zeroCost?: ZeroCostRefusal; detail?: string };
export async function postGrnAndRollup(sb: any, grnId: string, userId: string, companyId: number, expectedStatus: string, tx: StockTx | null): Promise<GrnPostResult> {
  const core = tx
    ? await timed('grn-post-core', () => tx((t) => postGrnCore(t, grnId, userId, companyId, expectedStatus, true)))
    : await timed('grn-post-core', () => postGrnCore(sb, grnId, userId, companyId, expectedStatus, false));
  if (!core.ok) return core;
  await timed('grn-post-tail', () => runGrnPostTail(sb, core.tail));
  return { ok: true, movementErrors: core.movementErrors, recountError: core.recountError };
}
async function postGrnCore(sb: Parameters<typeof writeMovements>[0], grnId: string, userId: string, companyId: number, expectedStatus: string, atomic: boolean): Promise<(GrnPostResult & { ok: false }) | { ok: true; movementErrors?: string[]; recountError?: string; tail: GrnPostTail }> {
  const { data: grnHeader, error: headErr } = await scopeToCompanyId(sb.from('grns')
    .select('grn_number, warehouse_id, company_id, exchange_rate, allocation_method, received_at')
    .eq('id', grnId), companyId).maybeSingle();
  const { data: items, error: itemsErr } = await sb.from('grn_items')
    .select('id, purchase_order_item_id, qty_accepted, item_code, material_name, unit_price_sen, line_total_sen, item_group, variants, zero_cost_ack')
    .eq('grn_id', grnId);
  const linkedPoItemIds = (items ?? []).map((it: { purchase_order_item_id: string | null }) => it.purchase_order_item_id).filter((x: string | null): x is string => !!x);
  const poWhRes = linkedPoItemIds.length > 0 ? await sb.from('purchase_order_items').select('warehouse_id').in('id', [...new Set(linkedPoItemIds)]) : { data: [], error: null };
  if (headErr || itemsErr || poWhRes.error) return { ok: false, reason: LINES_UNREADABLE, status: 503 };

  const zeroCost = await checkGrnZeroCost(sb, (items ?? []) as GrnCostGateRow[], grnHeader);
  if (zeroCost) {
    return { ok: false, reason: ZERO_COST_RECEIPT_ERROR, status: 409, zeroCost };
  }

  const expectedNorm = expectedStatus.toUpperCase();
  if (expectedNorm === 'CANCELLED' || expectedNorm === 'CLOSED') {
    return { ok: false, reason: `grn_${expectedNorm.toLowerCase()}`, status: 409 };
  }
  const { data, error } = await scopeToCompanyId(sb.from('grns').update({
    status: 'POSTED',
    posted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', grnId), companyId).eq('status', expectedStatus).select('id, status, posted_at').maybeSingle()
    .then((r: unknown) => r as { data: unknown; error: { message: string; code?: string } | null }, (e: { message: string; code?: string }) => ({ data: null, error: e }));
  // HC-0004: the DB cap (mig 20261014T1600) refused a post past a PO line's qty.
  if (isPoLineOverReceived(error)) return { ok: false, reason: 'qty_exceeds_remaining', status: 409 };
  if (error) return { ok: false, reason: error.message, status: 500 };
  if (!data) return { ok: false, reason: 'already_posting', status: 409 };

  const touchedPoItemIds = (items ?? [])
    .map((it: { purchase_order_item_id: string | null }) => it.purchase_order_item_id);
  const recount = await timed('grn-po-recount', () => recomputePoReceived(sb, touchedPoItemIds));
  if (!recount.ok && atomic) return { ok: false, reason: STOCK_TX_ROLLED_BACK, status: 503, detail: `PO received recount: ${recount.reason ?? 'unknown'}` };
  if (!recount.ok) {
    try {
      await recordEntityAudit(sb, {
        entityType: 'GRN',
        entityId: grnId,
        entityDocNo: (grnHeader as { grn_number?: string | null } | null)?.grn_number ?? null,
        action: 'RECOUNT_FAILED',
        companyId,
        source: 'postGrnAndRollup',
        note:
          `Receipt committed (GRN POSTED + stock IN) but the PO received_qty recount did not run: ` +
          `${recount.reason ?? 'unknown'}. The linked PO lines under-report until recounted.`,
      });
    } catch { }
  }

  const movementErrors: string[] = [];
  let booked: GrnPostTail['booked'] = null;
  const grnNo = (grnHeader as { grn_number: string } | null)?.grn_number ?? grnId;
  let warehouseId = (grnHeader as { warehouse_id: string | null } | null)?.warehouse_id
    ?? (await defaultWarehouseId(sb, companyId));
  /* Owner 2026-07-02 — AUTHORITATIVE receiving warehouse = the source PO line's
     bound warehouse. The warehouse binds at the SO/PO line and must flow into the
     GRN's stock movements (per-warehouse model, no cross-warehouse pooling). A
     frontend default once fell back to the FIRST warehouse (CHINA landing) and
     silently received PO-bound goods into the wrong warehouse, so MRP for the
     real (MY) warehouse still showed shortage. Guard it at this single post
     chokepoint: when the GRN's PO-linked lines share ONE warehouse, that is the
     truth — override a mismatched header + persist it so the movement (and the
     detail/list) land where the PO expected. Manual (no-PO) or mixed-warehouse
     GRNs keep the header/default untouched. */
  if (linkedPoItemIds.length > 0) {
    const poWhs = [...new Set(((poWhRes.data ?? []) as Array<{ warehouse_id: string | null }>)
      .map((r) => r.warehouse_id).filter((x): x is string => !!x))];
    if (poWhs.length === 1 && poWhs[0] !== warehouseId) {
      warehouseId = poWhs[0]!;
      await sb.from('grns').update({ warehouse_id: warehouseId, updated_at: new Date().toISOString() }).eq('id', grnId);
    }
  }
  const grnRate = (grnHeader as { exchange_rate?: string | number | null } | null)?.exchange_rate ?? 1;
  const method = normalizeAllocationMethod((grnHeader as { allocation_method?: string | null } | null)?.allocation_method);
  const itemRows = (items ?? []) as Array<{ id: string; purchase_order_item_id: string | null; qty_accepted: number; item_code: string; material_name: string | null; unit_price_sen: number | null; line_total_sen?: number | null; item_group?: string | null; variants?: VariantAttrs | null }>;
  const alloc = await computeAndStoreGrnAllocation(sb, itemRows, grnRate, method, companyId);
  const allocByItemId = new Map(alloc.goods.map((g) => [g.id, g]));
  if (warehouseId && items) {
    const batchByItem = await resolvePoBatchByItem(
      sb,
      itemRows.map((it) => it.purchase_order_item_id),
    );
    const grnKeyOf = await bk.stockBucketKeyResolver(sb, companyId, itemRows.map((it) => bk.stockKeyLine(it, warehouseId)));
    const movements = itemRows
      .filter((it) => !isServiceLine({ itemGroup: it.item_group ?? null, itemCode: it.item_code }))
      .filter((it) => it.qty_accepted > 0)
      .map((it) => ({
        movement_type: 'IN' as const,
        warehouse_id: warehouseId, item_code: it.item_code,
        variant_key: (keyedVariantWithWarning(grnNo, it, computeVariantKey), grnKeyOf(bk.stockKeyLine(it, warehouseId))),
        product_name: it.material_name,
        qty: it.qty_accepted,
        unit_cost_sen: allocByItemId.get(it.id)?.landedUnitCostMyr
          ?? toMyrSen(Number(it.unit_price_sen ?? 0), grnRate),
        source_doc_type: 'GRN' as const,
        source_doc_id: grnId,
        source_doc_no: grnNo, movement_date: isoDayOf((grnHeader as { received_at?: unknown } | null)?.received_at) ?? undefined,
        batch_no: it.purchase_order_item_id ? (batchByItem.get(it.purchase_order_item_id) ?? null) : null,
        performed_by: userId,
      }));
    let alreadyBooked = false;
    if (movements.length > 0) {
      const booked = await grnReceiptBooked(sb, grnId);
      if (!booked.ok) return { ok: false, reason: LINES_UNREADABLE, status: 503, detail: `stock already booked for ${grnNo}: ${booked.error.message}` };
      alreadyBooked = booked.booked;
    }
    if (movements.length > 0 && !alreadyBooked) {
      const res = await timed('grn-stock-in', () => writeMovements(sb, movements, grnHeader?.company_id ?? null));
      if (!res.ok && atomic) return { ok: false, reason: STOCK_TX_ROLLED_BACK, status: 503, detail: `stock IN ${grnNo}: ${res.reason ?? 'unknown'}` };
      if (!res.ok) movementErrors.push(`IN ${grnNo}: ${res.reason ?? 'unknown'}`);
      booked = {
        buckets: movements.map((m) => ({ warehouse_id: m.warehouse_id, item_code: m.item_code, variant_key: m.variant_key, batch_no: m.batch_no ?? null })),
        receiptCutoffTs: new Date().toISOString(),
      };
    }
  }
  return {
    ok: true,
    movementErrors: movementErrors.length ? movementErrors : undefined,
    recountError: recount.ok ? undefined : (recount.reason ?? 'unknown'),
    tail: { grnId, grnNo, companyId, userId, booked },
  };
}

const HEADER = GRN_HEADER_COLS;
const ITEM =
  'id, grn_id, purchase_order_item_id, material_kind, item_code, material_name, supplier_sku, ' +
  'qty_received, qty_accepted, qty_rejected, rejection_reason, unit_price_sen, notes, ' +
  'item_group, description, description2, uom, discount_sen, variants, ' +
  'gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, ' +
  'custom_specials, line_suffix, special_order_price_sen, ' +
  'line_total_sen, delivery_date, unit_cost_sen, ' +
  'invoiced_qty, returned_qty, created_at, ' +
  'allocated_charge_sen, ' +
  'rack_id, ' +
  'zero_cost_ack, zero_cost_reason, zero_cost_ack_by, zero_cost_ack_at';

const nextNumber = async (sb: ReturnType<Variables['supabase']['valueOf']> extends never ? never : any, prefix: string, table: string, col: string, c: any): Promise<string> => {
  const yymm = yymmFor();
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, table, col, `${p}${prefix}-${yymm}`);
};

export async function recomputeGrnTotals(sb: any, grnId: string) {
  const { data: items, error: itemsErr } = await sb.from('grn_items')
    .select('line_total_sen')
    .eq('grn_id', grnId);
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[grn-recompute] item read failed — header left unchanged:', grnId, itemsErr.message);
    return;
  }
  const subtotal = (items ?? []).reduce((s: number, r: any) => s + (r.line_total_sen ?? 0), 0);
  const { error: updErr } = await sb.from('grns').update({
    subtotal_sen: subtotal,
    total_sen: subtotal,
    updated_at: new Date().toISOString(),
  }).eq('id', grnId);
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[grn-recompute] header update failed — totals left STALE:', grnId, updErr.message);
  }
}

export async function verifyGrnOverReceipt(
  sb: any,
  grnId: string,
  poItemIds: Array<string | null | undefined>,
): Promise<{ poItemId: string; requested: number; remaining: number } | null> {
  const ids = [...new Set(poItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return null;
  try {
    const { data: poItems } = await sb.from('purchase_order_items')
      .select('id, qty').in('id', ids);
    const capById = new Map<string, number>(
      ((poItems ?? []) as Array<{ id: string; qty: number }>).map((r) => [r.id, r.qty ?? 0]),
    );
    const { data: sib } = await sb.from('grn_items')
      .select('purchase_order_item_id, qty_accepted, returned_qty, returned_closed_qty, grn_id')
      .in('purchase_order_item_id', ids);
    const sibRows = (sib ?? []) as Array<{ purchase_order_item_id: string; qty_accepted: number; returned_qty: number; returned_closed_qty: number; grn_id: string }>;
    const grnIds = [...new Set(sibRows.map((r) => r.grn_id).filter(Boolean))];
    const cancelled = new Set<string>();
    if (grnIds.length > 0) {
      const { data: gs } = await sb.from('grns').select('id, status').in('id', grnIds);
      for (const g of (gs ?? []) as Array<{ id: string; status: string }>) {
        if (g.id === grnId) continue;
        if (g.status === 'CANCELLED' || g.status === 'DRAFT') cancelled.add(g.id);
      }
    }
    const liveByPoi = new Map<string, number>();
    const thisGrnByPoi = new Map<string, number>();
    for (const r of sibRows) {
      if (cancelled.has(r.grn_id)) continue;
      const q = grnLineNetReceived(r);
      liveByPoi.set(r.purchase_order_item_id, (liveByPoi.get(r.purchase_order_item_id) ?? 0) + q);
      if (r.grn_id === grnId) thisGrnByPoi.set(r.purchase_order_item_id, (thisGrnByPoi.get(r.purchase_order_item_id) ?? 0) + q);
    }
    for (const poiId of ids) {
      const cap = capById.get(poiId) ?? 0;
      const live = liveByPoi.get(poiId) ?? 0;
      if (live > cap) {
        const mine = thisGrnByPoi.get(poiId) ?? 0;
        return { poItemId: poiId, requested: mine, remaining: cap - (live - mine) };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Outcome of a recount. Mirrors AuditWriteResult in scm/lib/entity-audit.ts —
 *  same shape for the same reason: a post-commit writer that must not throw, but
 *  must not pretend it succeeded either. `reason` is for logs and the audit
 *  trail, never for an operator. */
export type RecountResult = { ok: boolean; reason?: string };

export async function recomputePoReceived(
  sb: any,
  poItemIds: Array<string | null | undefined>,
): Promise<RecountResult> {
  const ids = [...new Set(poItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return { ok: true };

  try {
    const { data: glines, error: glinesErr } = await sb.from('grn_items')
      .select('purchase_order_item_id, qty_accepted, returned_qty, returned_closed_qty, grn_id')
      .in('purchase_order_item_id', ids);
    if (glinesErr) return { ok: false, reason: `GRN line read failed: ${glinesErr.message ?? 'unknown'}` };
    const rows = (glines ?? []) as Array<{ purchase_order_item_id: string; qty_accepted: number; returned_qty: number; returned_closed_qty: number; grn_id: string }>;
    const grnIds = [...new Set(rows.map((r) => r.grn_id).filter(Boolean))];
    const cancelled = new Set<string>();
    if (grnIds.length > 0) {
      const { data: gs, error: gsErr } = await sb.from('grns').select('id, status').in('id', grnIds);
      if (gsErr) return { ok: false, reason: `GRN status read failed: ${gsErr.message ?? 'unknown'}` };
      for (const g of (gs ?? []) as Array<{ id: string; status: string }>) {
        if (g.status === 'CANCELLED' || g.status === 'DRAFT') cancelled.add(g.id);
      }
    }
    const recvByPoi = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const r of rows) {
      if (cancelled.has(r.grn_id)) continue;
      recvByPoi.set(r.purchase_order_item_id, (recvByPoi.get(r.purchase_order_item_id) ?? 0) + grnLineNetReceived(r));
    }
    const itemWrites = await Promise.all([...recvByPoi.entries()].map(([poiId, recv]) =>
      sb.from('purchase_order_items').update({ received_qty: recv }).eq('id', poiId),
    ));
    const itemErr = itemWrites.find((r: { error?: { message?: string } | null }) => r?.error);
    if (itemErr) {
      return { ok: false, reason: `received_qty write failed: ${itemErr.error?.message ?? 'unknown'}` };
    }

    const { data: poiRows, error: poiErr } = await sb.from('purchase_order_items')
      .select('purchase_order_id').in('id', ids);
    if (poiErr) return { ok: false, reason: `PO line read failed: ${poiErr.message ?? 'unknown'}` };
    const poIds = [...new Set(((poiRows ?? []) as Array<{ purchase_order_id: string }>)
      .map((r) => r.purchase_order_id).filter(Boolean))];
    for (const poId of poIds) {
      const { data: lines, error: linesErr } = await sb.from('purchase_order_items')
        .select('qty, received_qty').eq('purchase_order_id', poId);
      if (linesErr) return { ok: false, reason: `PO line read failed for ${poId}: ${linesErr.message ?? 'unknown'}` };
      const ll = (lines ?? []) as Array<{ qty: number; received_qty: number }>;
      if (ll.length === 0) continue;
      const anyReceived = ll.some((l) => (l.received_qty ?? 0) > 0);
      const fully = ll.every((l) => (l.received_qty ?? 0) >= l.qty);
      const newStatus = fully ? 'RECEIVED' : anyReceived ? 'PARTIALLY_RECEIVED' : 'SUBMITTED';
      const { data: head, error: headErr } = await sb.from('purchase_orders')
        .select('received_at').eq('id', poId).maybeSingle();
      if (headErr) return { ok: false, reason: `PO header read failed for ${poId}: ${headErr.message ?? 'unknown'}` };
      const prevReceivedAt = (head as { received_at: string | null } | null)?.received_at ?? null;
      const patch: Record<string, unknown> = { status: newStatus, updated_at: new Date().toISOString() };
      patch.received_at = fully ? (prevReceivedAt ?? new Date().toISOString()) : null;
      /* NO `on_hold` TERM, DELIBERATELY — a WRITER re-deriving a status from a
         fact can no longer erase a hold (mig 0324); the literal stays for a
         legacy row. docs/modules/purchase-order.md. */
      const { error: poErr } = await sb.from('purchase_orders')
        .update(patch).eq('id', poId).not('status', 'in', '("CANCELLED","ON_HOLD")');
      if (poErr) {
        return { ok: false, reason: `PO status write failed for ${poId}: ${poErr.message ?? 'unknown'}` };
      }
    }
    return { ok: true };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(
      '[po-recount-failed] the GRN receipt is already committed but its PO roll-up did NOT run; ' +
        'these PO lines now UNDER-REPORT what was received until something recounts them',
      { poItemIds: ids, reason },
    );
    return { ok: false, reason };
  }
}




grns.get('/', async (c) => {
  const sb = c.get('supabase');
  // .limit(500) bounds the result so PostgREST's default 1000-row cap can't
  // silently truncate the GRN list — match the SO/DO/SI list convention.
  // warehouse embeds the receiving location's NAME (Owner 2026-07-02 — the GRN
  // list "Purchase Location" column); warehouse_id is already in HEADER.
  const pageRaw = c.req.query('page');
  const paginate = pageRaw !== undefined && pageRaw !== '';

  let data: unknown = null;
  let error: { message: string } | null = null;
  let total = 0;
  let page = 0;
  let pageSize = 50;
  let statusCounts: { all: number; draft: number; posted: number; cancelled: number } | undefined;
  let countError: string | null = null;

  if (!paginate) {
    let q = sb.from('grns').select(GRN_LIST_SELECT).order('received_at', { ascending: false }).limit(500);
    const status = c.req.query('status'); if (status) q = q.eq('status', status);
    const supplierId = c.req.query('supplierId'); if (supplierId) q = q.eq('supplier_id', supplierId);
    q = scopeToCompany(q, c);
    const res = await q;
    data = res.data;
    error = res.error;
  } else {
    page = Math.max(0, Math.trunc(Number(pageRaw)) || 0);
    const psRaw = Number(c.req.query('pageSize'));
    pageSize = Number.isFinite(psRaw) && psRaw > 0 ? Math.min(100, Math.max(1, Math.trunc(psRaw))) : 50;

    const filters = readGrnListFilters((k) => c.req.query(k));
    const supplierId = filters.supplierId;
    let q = orderGrnList(filterGrnList(sb.from('grns').select(grnListSelect(filters), { count: 'exact' }), filters, c), filters.sort);
    q = q.range(page * pageSize, page * pageSize + pageSize - 1);

    const countBase = () => {
      let cq = sb.from('grns').select('*', { count: 'exact', head: true });
      cq = scopeToCompany(cq, c);
      if (supplierId) cq = cq.eq('supplier_id', supplierId);
      return cq;
    };
    const countsProm = eager(Promise.all([
      countBase(),
      countBase().in('status', GRN_STATUS_BUCKETS.draft),
      countBase().in('status', GRN_STATUS_BUCKETS.posted),
      countBase().in('status', GRN_STATUS_BUCKETS.cancelled),
      countBase().or(HELD_OR_TERM),
    ]));
    const res = await q;
    data = res.data;
    error = res.error;
    total = res.count ?? (res.data?.length ?? 0);
    const [allC, draftC, postedC, cancelledC, onHoldC] = (await countsProm)();
    const counted = readStatusCounts({ all: allC, draft: draftC, posted: postedC, cancelled: cancelledC, on_hold: onHoldC });
    if (counted.ok) statusCounts = counted.counts; else countError = counted.reason;
  }
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (countError) return c.json({ error: 'status_counts_failed', reason: countError }, 500);

  const rows = (data ?? []) as Array<{ id: string } & Record<string, unknown>>;
  const ids = rows.map((g) => g.id);
  const linesByGrn = new Map<string, Array<{ qty_accepted: number | null; invoiced_qty: number | null; returned_qty: number | null }>>();
  // Owner 2026-07-02 — "Transfer To" list column: map each grn_item → its GRN so
  // the per-line downstream (PI/PR) can be rolled up to a per-GRN doc-number set.
  const grnByItem = new Map<string, string>();
  if (ids.length > 0) {
    const { data: lineRows, error: lineErr } = await paginateAll<{ id: string; grn_id: string; qty_accepted: number | null; invoiced_qty: number | null; returned_qty: number | null }>((from, to) => sb
      .from('grn_items')
      .select('id, grn_id, qty_accepted, invoiced_qty, returned_qty')
      .in('grn_id', ids)
      .order('id')
      .range(from, to));
    if (lineErr) return c.json({ error: 'load_failed', reason: lineErr.message }, 500);
    for (const li of (lineRows ?? []) as Array<{ id: string; grn_id: string; qty_accepted: number | null; invoiced_qty: number | null; returned_qty: number | null }>) {
      const arr = linesByGrn.get(li.grn_id) ?? [];
      arr.push({ qty_accepted: li.qty_accepted, invoiced_qty: li.invoiced_qty, returned_qty: li.returned_qty });
      linesByGrn.set(li.grn_id, arr);
      if (li.id) grnByItem.set(li.id, li.grn_id);
    }
  }
  const downstreamByGrn = new Map<string, Map<string, { docNumber: string; docType: 'PI' | 'PR'; qty: number }>>();
  if (grnByItem.size > 0) {
    const perItem = await grnLineDownstream(sb, [...grnByItem.keys()]);
    for (const [itemId, entries] of perItem.entries()) {
      const grnId = grnByItem.get(itemId);
      if (!grnId) continue;
      const acc = downstreamByGrn.get(grnId) ?? new Map();
      for (const e of entries) {
        const prev = acc.get(e.docNumber);
        if (prev) prev.qty += e.qty;
        else acc.set(e.docNumber, { docNumber: e.docNumber, docType: e.docType, qty: e.qty });
      }
      downstreamByGrn.set(grnId, acc);
    }
  }
  /* Assigned SO / Delivered columns (owner 2026-07-31) are MRP-DERIVED and now
     OMITTED here — not blanked (C16). Resolving them ran a company-wide
     computeMrp on this critical path (resolvePoSoCoveragePerSkuForPos), the
     list's dominant cost (~4s). The client heals them a beat after render via
     GET /grns/list-mrp-enrichment (routes/grns-list-enrichment.ts +
     lib/listMrpEnrichment.ts), rolling up over each GRN's own line codes exactly
     as this handler did. downstream + the lock/convert flags stay inline (cheap,
     non-MRP). */
  const grns = rows.map((g) => ({
    ...g,
    total_sen: (g.total_sen as number | null | undefined) ?? 0,
    downstream: [...(downstreamByGrn.get(g.id)?.values() ?? [])],
    ...computeGrnFlags(linesByGrn.get(g.id) ?? []),
  }));
  if (!paginate) return c.json({ grns });
  const withLines = await attachGrnLines(sb, c, grns); if (withLines.error !== null) return c.json({ error: 'lines_read_failed', reason: withLines.error }, 500);
  return c.json({ grns: withLines.rows, total, page, pageSize, statusCounts });
});

grns.get('/outstanding-po-items', async (c) => {
  const sb = c.get('supabase');
  /* ONE AUTHORITY FOR THIS READ. #2367 landed the same truncation fix on main as
     `lib/outstanding-po-items.ts` while this branch landed it as
     `lib/outstanding-po-lines.ts`. Keeping both would have left the module whose
     header says "three properties this must keep" with ZERO callers — its tests
     would go on passing about code the endpoint no longer runs, which is the
     disarmed-tripwire failure this repo already pays for. The `-lines` module is
     the superset (it also pushes `?poId=` into SQL and reports WHY an empty
     answer is empty), so `-items` was deleted in the merge and every assertion
     its suite made was carried into `outstanding-po-lines.test.ts` as a
     BEHAVIOURAL test of `loadOutstandingPoLines`, not a source-text one. */
  /* The scope the operator arrived with. Applied in SQL, not in the browser:
     the old code filtered `?poId=` client-side over an already-truncated list,
     so scoping could only narrow the window and never recover a PO that fell
     outside it. That is the owner's 2026-08-17 zero-row screen. */
  const requestedPoIds = parsePoIdScope(c.req.query('poId'));
  /* The read lives in lib/outstanding-po-lines.ts: paged rather than capped,
     scoped in SQL, and it reports WHY an empty answer is empty. Both predicates
     are handed IN — `scopeToCompany` because items carry company_id since mig
     0083 and it must fail closed when the company context cannot resolve (owner
     2026-08-10 "为什么 houzs 的数据进到去 2990": this picker used to return every
     company's lines), and `isReceivablePo` because it is the same predicate
     the create paths gate on, so the picker cannot offer what they refuse. */
  const loaded = await loadOutstandingPoLines({
    sb,
    scopeQuery: (q) => scopeToCompany(q, c),
    requestedPoIds,
    isReceivable: isReceivablePo,
  });
  if (loaded.error !== null) return c.json({ error: 'load_failed', reason: loaded.error }, 500);
  const { rows, scope } = loaded;

  const outstanding = await toOutstandingPoItems(sb, rows, effectiveDelivery);

  return c.json({ items: outstanding, scope });
});

export type GrnLineDownstream = { docNumber: string; docType: 'PI' | 'PR'; qty: number; status: string };
export async function grnLineDownstream(
  sb: any,
  grnItemIds: string[],
): Promise<Map<string, GrnLineDownstream[]>> {
  const out = new Map<string, GrnLineDownstream[]>();
  const ids = [...new Set(grnItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return out;

  const [piLinesRes, prLinesRes] = await Promise.all([
    sb.from('purchase_invoice_items').select('grn_item_id, qty, purchase_invoice_id').in('grn_item_id', ids),
    sb.from('purchase_return_items').select('grn_item_id, qty_returned, purchase_return_id').in('grn_item_id', ids),
  ]);
  const piLines = (piLinesRes.data ?? []) as Array<{ grn_item_id: string | null; qty: number; purchase_invoice_id: string }>;
  const prLines = (prLinesRes.data ?? []) as Array<{ grn_item_id: string | null; qty_returned: number; purchase_return_id: string }>;

  const piIds = [...new Set(piLines.map((r) => r.purchase_invoice_id).filter(Boolean))];
  const prIds = [...new Set(prLines.map((r) => r.purchase_return_id).filter(Boolean))];
  const [piHeadRes, prHeadRes] = await Promise.all([
    piIds.length > 0 ? sb.from('purchase_invoices').select('id, invoice_number, status').in('id', piIds) : Promise.resolve({ data: [] }),
    prIds.length > 0 ? sb.from('purchase_returns').select('id, return_number, status').in('id', prIds) : Promise.resolve({ data: [] }),
  ]);
  const piMeta = new Map<string, { docNumber: string; status: string }>();
  for (const p of (piHeadRes.data ?? []) as Array<{ id: string; invoice_number: string | null; status: string | null }>) {
    if ((p.status ?? '').toUpperCase() === 'CANCELLED') continue;
    piMeta.set(p.id, { docNumber: p.invoice_number ?? '—', status: (p.status ?? '').toUpperCase() });
  }
  const prMeta = new Map<string, { docNumber: string; status: string }>();
  for (const p of (prHeadRes.data ?? []) as Array<{ id: string; return_number: string | null; status: string | null }>) {
    if ((p.status ?? '').toUpperCase() === 'CANCELLED') continue;
    prMeta.set(p.id, { docNumber: p.return_number ?? '—', status: (p.status ?? '').toUpperCase() });
  }

  const push = (grnItemId: string | null, entry: GrnLineDownstream) => {
    if (!grnItemId) return;
    const arr = out.get(grnItemId) ?? [];
    arr.push(entry);
    out.set(grnItemId, arr);
  };
  for (const r of piLines) {
    const meta = piMeta.get(r.purchase_invoice_id);
    if (!meta) continue;
    push(r.grn_item_id, { docNumber: meta.docNumber, docType: 'PI', qty: Number(r.qty ?? 0), status: meta.status });
  }
  for (const r of prLines) {
    const meta = prMeta.get(r.purchase_return_id);
    if (!meta) continue;
    push(r.grn_item_id, { docNumber: meta.docNumber, docType: 'PR', qty: Number(r.qty_returned ?? 0), status: meta.status });
  }
  return out;
}

grns.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    // Company-scoped (owner 2026-08-10 audit): a bare uuid must not read
    // another company's GRN. Siblings (delivery-returns, suppliers) do this.
    scopeToCompany(sb.from('grns').select(`${HEADER}, supplier:suppliers(id, code, name, contact_person, phone, email, email2, email3, address), purchase_order:purchase_orders(id, po_number), warehouse:warehouses!warehouse_id(id, code, name)`), c).eq('id', id).maybeSingle(),
    sb.from('grn_items').select(ITEM).eq('grn_id', id).order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  if (i.error) return c.json(readFailure('grn_lines', i.error), 500);
  const itemRows = i.data as Array<{ qty_accepted?: number | null; invoiced_qty?: number | null; returned_qty?: number | null }>;
  const header = h.data as Record<string, unknown> & { warehouse?: { code?: string | null; name?: string | null } | null };
  const grn = {
    ...header,
    warehouse_code: header.warehouse?.code ?? null,
    warehouse_name: (header.warehouse?.name ?? '').trim() || null,
    ...computeGrnFlags(itemRows),
  };

  type GrnLineRow = Record<string, unknown> & { id: string; purchase_order_item_id: string | null; item_code: string };
  const lineItems = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      (i.data as unknown as Array<Record<string, unknown> & { id: string; purchase_order_item_id: string | null; item_code: string }>)
        .map((it): GrnLineRow => ({ ...it, item_code: it.item_code })),
      (r) => r.item_group as string | null | undefined,
    ),
  );
  const headerReceivedAt = (h.data as { received_at?: string | null }).received_at ?? null;
  const poItemIds = [...new Set(lineItems.map((it) => it.purchase_order_item_id).filter((x): x is string => Boolean(x)))];
  let poRefs: ReadonlyMap<string, LinePoRef> = new Map(); let poPrices: ReadonlyMap<string, number | null> = new Map();
  /* Owner 2026-08-06 — the V2 detail's "Ordered" column needs the SOURCE PO
     line's qty (grn_items has no ordered-qty column of its own; the V2 page
     was reading a nonexistent `qty` field and rendered 0 on every GRN). Same
     round trip that already resolves the PO number — just carry `qty` too.
     Manual lines (no purchase_order_item_id) stay null → the page shows "—". */
  const poQtyByItemId = new Map<string, number>();
  const downstreamMap = await grnLineDownstream(sb, lineItems.map((it) => it.id));
  if (poItemIds.length > 0) {
    const { data: poiRows, error: poiErr } = await sb.from('purchase_order_items')
      .select('id, qty, unit_price_sen, purchase_order_id, po:purchase_orders ( po_number )')
      .in('id', poItemIds);
    if (poiErr) return c.json(readFailure('grn_po_lines', poiErr), 500);
    const rows = poiRows as Array<{ id: string; qty: number | null; purchase_order_id: string | null; po: { po_number: string } | Array<{ po_number: string }> | null }>;
    poRefs = poRefByPoItemId(rows); poPrices = poPriceByPoItemId(rows as Array<{ id: string; unit_price_sen?: number | null }>);
    for (const r of rows) if (r.qty != null) poQtyByItemId.set(r.id, Number(r.qty));
  }
  stampGrnLinePoRefs(lineItems, poRefs, poPrices);
  const items = lineItems.map((it) => ({
    ...it,
    ordered_qty: it.purchase_order_item_id ? (poQtyByItemId.get(it.purchase_order_item_id) ?? null) : null,
    received_at: headerReceivedAt,
    downstream: downstreamMap.get(it.id) ?? [],
  }));
  // Stamp each line's supplier fabric code so the on-screen line reads
  // "BF-01 (PC151-01)" — same READ enrichment as the SO/PO/DO/SI details
  // (owner 2026-07-24). ONE batched query; fail-soft.
  await enrichLinesWithFabricSupplierCode(sb, c, items);
  return c.json({ grn, items });
});

grns.get('/:id/linked', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');

  const [grnRes, piRes, prRes] = await Promise.all([
    scopeToCompany(sb.from('grns')
      .select('id, purchase_order_id, purchase_order:purchase_orders(id, po_number)')
      .eq('id', id), c)
      .maybeSingle(),
    sb.from('purchase_invoices')
      .select('id, invoice_number, status, invoice_date')
      .eq('grn_id', id)
      .order('invoice_date', { ascending: false }),
    sb.from('purchase_returns')
      .select('id, return_number, status, return_date')
      .eq('grn_id', id)
      .order('return_date', { ascending: false }),
  ]);

  if (grnRes.error) return c.json({ error: 'load_failed', reason: grnRes.error.message }, 500);
  if (!grnRes.data) return c.json({ error: 'not_found' }, 404);
  if (piRes.error)  return c.json({ error: 'load_failed', reason: piRes.error.message  }, 500);
  if (prRes.error)  return c.json({ error: 'load_failed', reason: prRes.error.message  }, 500);

  const raw = grnRes.data as unknown as {
    purchase_order?: { id: string; po_number: string } | Array<{ id: string; po_number: string }> | null;
  };
  const poJoin = raw.purchase_order;
  const po: { id: string; po_number: string } | null =
    Array.isArray(poJoin) ? (poJoin[0] ?? null) : (poJoin ?? null);

  /* Multi-GRN PIs (owner 2026-08-06) — one supplier invoice can bill several
     notes, and only ONE of them is the header's primary grn_id. Union the
     header match above with the LINE-level path (this note's grn_items →
     purchase_invoice_items) so a note billed on another note's PI still lists
     its invoice here. A failed read answers 500: the header-matched set alone
     would tell the operator a billed note has no invoice yet. */
  let invoices = (piRes.data ?? []) as Array<{ id: string; invoice_number: string; status: string; invoice_date: string }>;
  try {
    const { data: myLines, error: myLinesErr } = await sb.from('grn_items').select('id').eq('grn_id', id);
    if (myLinesErr) return c.json(readFailure('grn_linked_invoices', myLinesErr), 500);
    const grnItemIds = (myLines as Array<{ id: string }>).map((r) => r.id);
    if (grnItemIds.length) {
      const { data: piLines, error: piLinesErr } = await sb.from('purchase_invoice_items')
        .select('purchase_invoice_id').in('grn_item_id', grnItemIds);
      if (piLinesErr) return c.json(readFailure('grn_linked_invoices', piLinesErr), 500);
      const piIds = [...new Set((piLines as Array<{ purchase_invoice_id: string | null }>)
        .map((r) => r.purchase_invoice_id).filter((x): x is string => Boolean(x)))];
      const missing = piIds.filter((pid) => !invoices.some((v) => v.id === pid));
      if (missing.length) {
        const { data: extra, error: extraErr } = await sb.from('purchase_invoices')
          .select('id, invoice_number, status, invoice_date').in('id', missing);
        if (extraErr) return c.json(readFailure('grn_linked_invoices', extraErr), 500);
        invoices = [...invoices, ...(extra as typeof invoices)]
          .sort((a, b) => String(b.invoice_date).localeCompare(String(a.invoice_date)));
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[grn linked] line-level PI union failed', { id, error: e });
  }

  return c.json({
    purchaseOrder: po,
    invoices,
    returns:       prRes.data ?? [],
  });
});

grns.post('/', async (c) => {
  const lap = stepClock();
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return refuseWithoutWriting(c, { error: 'invalid_json' }, 400); }
  const asDraft = (body as { asDraft?: unknown }).asDraft === true;
  if (body.status === 'DRAFT') return refuseWithoutWriting(c, { error: 'draft_status_not_supported', message: 'Use asDraft:true to save a GRN as a draft.' }, 400);
  const postRefusal = asDraft ? null : grnPostRefusal(c.get('houzsUser'));
  if (postRefusal) return refuseWithoutWriting(c, postRefusal, 403);
  if (!body.supplierId) return refuseWithoutWriting(c, { error: 'supplier_required' }, 400);
  const items = body.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items) || !items.length) return refuseWithoutWriting(c, { error: 'items_required' }, 400);

  const sb = c.get('supabase'); const user = c.get('user');
  const grnGroupOf = await skuCategoryResolver(sb, items.map((it) => ({ materialKind: 'mfg_product', itemCode: it.itemCode })), activeCompanyId(c) ?? null);

  {
    const acceptedByPoItem = new Map<string, number>();
    for (const it of items) {
      const poItemId = (it.purchaseOrderItemId as string | undefined) ?? null;
      if (!poItemId) continue;
      const accepted = Number(it.qtyAccepted ?? it.qtyReceived ?? 0);
      acceptedByPoItem.set(poItemId, (acceptedByPoItem.get(poItemId) ?? 0) + accepted);
    }
    if (acceptedByPoItem.size > 0) {
      const xl = await assertSourceLinesInCompany(sb, c, 'purchase_order_items', [...acceptedByPoItem.keys()], { lines: items, linkField: 'purchaseOrderItemId', source: 'Purchase Order line' });
      if (!xl.ok) return refuseWithoutWriting(c, xl.body, xl.status);
      const sup = await assertPoLinesFromSupplier(sb, c, [...acceptedByPoItem.keys()], String(body.supplierId));
      if (!sup.ok) return refuseWithoutWriting(c, sup.body, sup.status);
      const { data: poItems } = await sb.from('purchase_order_items')
        .select('id, qty, received_qty, po:purchase_orders!inner ( status, on_hold )').in('id', [...acceptedByPoItem.keys()]);
      type EPo = { status: string; on_hold: boolean | null };
      for (const r of (poItems ?? []) as Array<{ id: string; po: EPo | EPo[] | null }>) {
        const po = Array.isArray(r.po) ? (r.po[0] ?? null) : r.po;
        if (!isReceivablePo(po)) {
          return refuseWithoutWriting(c, { error: 'po_not_receivable', poItemId: r.id, status: po?.status ?? null, onHold: isDocumentHeld(po) }, 409);
        }
      }
      const remByPoItem = new Map<string, number>(
        ((poItems ?? []) as Array<{ id: string; qty: number; received_qty: number }>)
          .map((r) => [r.id, (r.qty ?? 0) - (r.received_qty ?? 0)]),
      );
      for (const [poItemId, accepted] of acceptedByPoItem) {
        const remaining = remByPoItem.get(poItemId) ?? 0;
        if (accepted > remaining) {
          return refuseWithoutWriting(c, { error: 'qty_exceeds_remaining', poItemId, requested: accepted, remaining }, 409);
        }
      }
    }
  }

  let grnNumber = await nextNumber(sb, 'GRN', 'grns', 'grn_number', c);

  {
    const x = await crossCompanySourceRefusal(sb, c, 'purchase_orders', [(body.purchaseOrderId as string | undefined) ?? null], 'po_number');
    if (x && 'loadError' in x) return refuseWithoutWriting(c, { error: 'load_failed', reason: x.loadError }, 500);
    if (x) return refuseWithoutWriting(c, x.blocked, 409);
  }

  /* The other half of "lines with no purchase_order_item_id are uncapped"
     (Wei Siang 2026-08-04, "包括 GR 那边也是"). Uncapped is right for a free
     receipt; it is not right for receiving THIS PO's own material without
     ticking the PO line off, because the stock goes in while the PO's
     received_qty does not move — so the same delivery can be received twice.
     Refused only when the named PO already orders that material. */
  {
    const unlinked = await findUnlinkedPoLines(
      sb,
      (body.purchaseOrderId as string | undefined) ?? null,
      null,
      items.map((it, idx) => ({
        lineRef: String(idx),
        itemCode: String(it.itemCode ?? ''),
        qty: Number(it.qtyAccepted ?? it.qtyReceived ?? 0),
        soItemId: (it.purchaseOrderItemId as string | undefined) ?? null,
      })),
    );
    const bad = unlinkedScanRefusal(unlinked, unlinkedPoLinesResponse);
    if (bad) return refuseWithoutWriting(c, bad, 409);
  }

  const headerWarehouseId = await resolveReceiveWarehouse(
    sb,
    (body.warehouseId as string | undefined) ?? null,
    items.map((it) => (it.purchaseOrderItemId as string | undefined) ?? null),
  );
  if (!headerWarehouseId) {
    return refuseWithoutWriting(c, { error: 'warehouse_required', message: 'Select a warehouse to receive the goods into.' }, 400);
  }

  const pf = await assertAuditWritable(sb, { entityType: 'GRN', action: 'CREATE', companyId: activeCompanyId(c) });
  if (!pf.ok) return refuseWithoutWriting(c, auditUnavailableBody(), 409);

  /* Migration 0082 — GRN currency + rate inherit from the source PO (MYR default);
     allocation_method for landed-freight "平摊" (default QTY). MYR ⇒ rate 1, no-op. */
  const grnFx = await resolveGrnFx(sb, (body.purchaseOrderId as string | undefined) ?? null, body.currency, body.exchangeRate);
  {
    const rateGuard = await assertForeignRatePostable(sb, { currency: grnFx.currency, operatorRate: body.exchangeRate, docLabel: 'GRN' });
    if (!rateGuard.ok) return refuseWithoutWriting(c, rateGuard.body, 422);
  }
  lap('grn-prep');
  let firstMint = true;
  const { data: header, error: hErr } = await insertWithDocNoRetry(
    async () => {
      if (firstMint) { firstMint = false; return grnNumber; }
      grnNumber = await nextNumber(sb, 'GRN', 'grns', 'grn_number', c);
      return grnNumber;
    },
    (dn) => sb.from('grns').insert({
    company_id: activeCompanyId(c),
    grn_number: dn,
    purchase_order_id: (body.purchaseOrderId as string | undefined) ?? null,
    supplier_id: body.supplierId,
    warehouse_id: headerWarehouseId,
    received_at: dateOrNull(body.receivedAt) ?? todayMyt(),
    delivery_note_ref: (body.deliveryNoteRef as string) ?? null,
    currency: grnFx.currency,
    exchange_rate: grnFx.exchange_rate,
    allocation_method: normalizeAllocationMethod(body.allocationMethod),
    notes: (body.notes as string) ?? null,
    status: 'DRAFT',
    posted_at: null,
    created_by: user.id,
    }).select(`${HEADER}, company_id`).single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; grn_number: string; company_id: number };

  const rows = items.map((it) => {
    const qtyReceived = Number(it.qtyReceived ?? 0);
    const unitPriceSen = Number(it.unitPriceSen ?? 0);
    const discountSen = Number(it.discountSen ?? 0);
    return {
      grn_id: h.id,
      purchase_order_item_id: (it.purchaseOrderItemId as string | undefined) ?? null,
      material_kind: it.materialKind,
      item_code: it.itemCode,
      material_name: it.materialName,
      supplier_sku: (it.supplierSku as string | undefined) ?? null,
      qty_received: qtyReceived,
      qty_accepted: Number(it.qtyAccepted ?? it.qtyReceived ?? 0),
      qty_rejected: Number(it.qtyRejected ?? 0),
      rejection_reason: (it.rejectionReason as string | undefined) ?? null,
      unit_price_sen: unitPriceSen,
      discount_sen: discountSen,
      line_total_sen: Math.max(0, (qtyReceived * unitPriceSen) - discountSen),
      delivery_date: dateOrNull(it.deliveryDate),
      unit_cost_sen: Number(it.unitCostSen ?? 0),
      notes: (it.notes as string | undefined) ?? null,
      variants: it.variants ?? null,
      description: (it.description as string | undefined) ?? null,
      ...lineIdentityFields(grnGroupOf, it, buildVariantSummary), // SKU wins — docs/bugs/0514
      rack_id: (it.rackId as string | undefined) || null,
      ...zeroCostAckColumns(it, user.id),
    };
  });
  const { error: iErr } = await sb.from('grn_items').insert(stampCompany(rows, c));
  if (iErr) { await sb.from('grns').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }

  if (!asDraft) {
    const over = await verifyGrnOverReceipt(sb, h.id, items.map((it) => (it.purchaseOrderItemId as string | undefined) ?? null));
    if (over) {
      await sb.from('grn_items').delete().eq('grn_id', h.id);
      await sb.from('grns').delete().eq('id', h.id);
      return c.json({ error: 'qty_exceeds_remaining', poItemId: over.poItemId, requested: over.requested, remaining: over.remaining }, 409);
    }
  }

  lap('grn-write');
  let postRes: Awaited<ReturnType<typeof postGrnAndRollup>> | undefined;
  if (!asDraft) postRes = await postGrnAndRollup(sb, h.id, user.id, h.company_id, 'DRAFT', stockTxFor(c.env, 'GRN_POST_MODE'));
  lap('grn-post');
  if (postRes && !postRes.ok) {
    await sb.from('grn_items').delete().eq('grn_id', h.id);
    await sb.from('grns').delete().eq('id', h.id);
    if (postRes.zeroCost) {
      return refuseZeroCostReceipt(c, postRes.zeroCost, { nothingWritten: true });
    }
    if (postRes.reason === 'qty_exceeds_remaining') return c.json({ error: 'qty_exceeds_remaining', message: 'Another receipt already covers this Purchase Order line. Refresh and check the remaining qty.' }, 409);
    if (postRes.reason === LINES_UNREADABLE) return c.json(linesUnreadableBody('the receipt lines', 'posted', null), 503);
    if (isStockTxFailure(postRes)) return refuseWithoutWriting(c, stockTxFailureBody('posted', postRes), 503);
    return c.json({ error: 'post_failed', reason: postRes.reason }, (postRes.status ?? 409) as 409 | 500);
  }
  await recomputeGrnTotals(sb, h.id);

  await recordGrnCreate(sb, c.get('houzsUser'), activeCompanyId(c), h.id, items.length);
  lap('grn-totals-audit');

  /* ERP -> AutoCount. A receipt whose LINES name a purchase order is sent as a
     real po_to_gr; one that names none is still parentless. This used to record
     every receipt raised here as parentless — see lib/convert-parent.ts and
     docs/bugs/0524 for why that was wrong and what it cost. */
  const srcPoIds = await sourcePoIdsForGrn(sb, h.id);
  const acBase = { companyId: activeCompanyId(c), docType: 'GR' as const, docNo: h.grn_number, docId: h.id, createdBy: c.get('houzsUser')?.id ?? null };
  if (srcPoIds.length) {
    await enqueueConvert(sb, { ...acBase, op: 'po_to_gr',
      from: srcPoIds.map((id) => ({ table: 'purchase_orders' as const, keyCol: 'id' as const, key: id })),
      to: { table: 'grns', keyCol: 'id', key: h.id } });
  } else {
    await recordParentlessCreate(sb, { ...acBase, missing: 'no source Purchase Order' });
  }

  lap('grn-ac-queue');
  const movementErrors = postRes && postRes.ok ? postRes.movementErrors : undefined;
  const recountError = postRes && postRes.ok ? postRes.recountError : undefined;
  return c.json({ id: h.id, grnNumber: h.grn_number, movementErrors: movementErrors?.length ? movementErrors : undefined, recountError }, 201);
});

export const createGrnFromPosHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const sb = c.get('supabase'); const user = c.get('user'); const grnTx = stockTxFor(c.env, 'GRN_POST_MODE');
  let body: { purchaseOrderIds?: string[]; deliveryNoteRef?: string; notes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return refuseWithoutWriting(c, { error: 'invalid_json' }, 400); }
  const poIds = body.purchaseOrderIds ?? [];
  if (poIds.length === 0) return refuseWithoutWriting(c, { error: 'po_ids_required' }, 400);
  const postRefusal = grnPostRefusal(c.get('houzsUser'));
  if (postRefusal) return refuseWithoutWriting(c, postRefusal, 403);

  const { data: pos, error: poErr } = await scopeToCompany(sb.from('purchase_orders')
    .select('id, po_number, supplier_id, status, on_hold, currency')
    .in('id', poIds), c);
  if (poErr) return refuseWithoutWriting(c, { error: 'load_failed', reason: poErr.message }, 500);
  const poList = (pos ?? []) as Array<{ id: string; po_number: string; supplier_id: string; status: string; on_hold: boolean | null; currency?: string | null }>;
  if (poList.length === 0) return refuseWithoutWriting(c, { error: 'pos_not_found' }, 404);

  const notReceivable = poList.find((p) => !isReceivablePo(p));
  if (notReceivable) {
    return refuseWithoutWriting(c, { error: 'po_not_receivable', poId: notReceivable.id, status: notReceivable.status, onHold: isDocumentHeld(notReceivable) }, 409);
  }

  const supplierIds = new Set(poList.map((p) => p.supplier_id));
  if (supplierIds.size > 1) {
    return refuseWithoutWriting(c, { error: 'mixed_suppliers', message: 'All selected POs must be from the same supplier' }, 400);
  }
  const supplierId = [...supplierIds][0]!;

  const { data: items, error: itemsErr } = await scopeToCompany(sb.from('purchase_order_items')
    .select('id, purchase_order_id, material_kind, item_code, material_name, qty, received_qty, unit_price_sen, ' +
      'item_group, description, description2, uom, variants, gap_inches, divan_height_inches, divan_price_sen, ' +
      'leg_height_inches, leg_price_sen, custom_specials, line_suffix, special_order_price_sen, discount_sen, unit_cost_sen, delivery_date, ' +
      'supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4')
    .in('purchase_order_id', poIds), c);
  if (itemsErr) return refuseWithoutWriting(c, { error: 'lookup_failed', reason: itemsErr.message }, 500);
  const itemList = ((items ?? []) as unknown as Array<{
    id: string; purchase_order_id: string; material_kind: string; item_code: string;
    material_name: string; qty: number; received_qty: number; unit_price_sen: number;
    item_group?: string | null; description?: string | null; description2?: string | null;
    uom?: string; variants?: unknown; gap_inches?: number | null;
    divan_height_inches?: number | null; divan_price_sen?: number;
    leg_height_inches?: number | null; leg_price_sen?: number;
    custom_specials?: unknown; line_suffix?: string | null; special_order_price_sen?: number;
    discount_sen?: number; unit_cost_sen?: number; delivery_date?: string | null;
    supplier_delivery_date_2?: string | null;
    supplier_delivery_date_3?: string | null;
    supplier_delivery_date_4?: string | null;
  }>).filter((it) => it.qty - (it.received_qty ?? 0) > 0);

  if (itemList.length === 0) return refuseWithoutWriting(c, { error: 'nothing_outstanding', message: 'No outstanding lines came back for this PO. Open it and check its received balance before treating it as received in full.' }, 400);

  const batchWarehouseId = await resolveReceiveWarehouse(sb, null, itemList.map((it) => it.id));
  if (!batchWarehouseId) {
    return refuseWithoutWriting(c, { error: 'warehouse_required', message: 'These purchase orders have no single receive-into warehouse. Set the warehouse on the PO lines, or receive them per warehouse.' }, 400);
  }

  const pf = await assertAuditWritable(sb, { entityType: 'GRN', action: 'CREATE', companyId: activeCompanyId(c) });
  if (!pf.ok) return refuseWithoutWriting(c, auditUnavailableBody(), 409);

  const yymm = yymmFor();
  const cp = companyDocPrefix(c);
  let grnNumber = await mintMonthlyDocNo(sb, 'grns', 'grn_number', `${cp}GRN-${yymm}`);

  const poNumbersJoined = poList.map((p) => p.po_number).join(', ');
  const batchFx = await resolveGrnFx(sb, poList[0]!.id, poList[0]!.currency ?? undefined, undefined);
  {
    const rateGuard = await assertForeignRatePostable(sb, { currency: batchFx.currency, operatorRate: undefined, docLabel: 'GRN' });
    if (!rateGuard.ok) return refuseWithoutWriting(c, rateGuard.body, 422);
  }
  let firstMint = true;
  const { data: header, error: hErr } = await insertWithDocNoRetry(
    async () => {
      if (firstMint) { firstMint = false; return grnNumber; }
      grnNumber = await mintMonthlyDocNo(sb, 'grns', 'grn_number', `${cp}GRN-${yymm}`);
      return grnNumber;
    },
    (dn) => sb.from('grns').insert({
    company_id: activeCompanyId(c),
    grn_number: dn,
    purchase_order_id: poList[0]!.id,
    supplier_id: supplierId,
    warehouse_id: batchWarehouseId,
    received_at: todayMyt(),
    delivery_note_ref: body.deliveryNoteRef ?? null,
    currency: batchFx.currency,
    exchange_rate: batchFx.exchange_rate,
    allocation_method: normalizeAllocationMethod((body as { allocationMethod?: unknown }).allocationMethod),
    notes: `Batch-converted from ${poList.length} POs: ${poNumbersJoined}${body.notes ? ` · ${body.notes}` : ''}`,
    status: grnTx ? 'DRAFT' : 'POSTED',
    posted_at: grnTx ? null : new Date().toISOString(),
    created_by: user.id,
    }).select('id, grn_number, company_id').single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; grn_number: string; company_id: number };

  const rows = itemList.map((it) => {
    const qtyReceived = it.qty - (it.received_qty ?? 0);
    const discountSen = it.discount_sen ?? 0;
    return {
      grn_id: h.id,
      purchase_order_item_id: it.id,
      material_kind: it.material_kind,
      item_code: it.item_code,
      material_name: it.material_name,
      qty_received: qtyReceived,
      qty_accepted: qtyReceived,
      qty_rejected: 0,
      unit_price_sen: it.unit_price_sen,
      line_total_sen: Math.max(0, (qtyReceived * it.unit_price_sen) - discountSen),
      unit_cost_sen: it.unit_cost_sen ?? 0,
      item_group: it.item_group ?? null,
      description: it.description ?? null,
      description2: it.description2 ?? null,
      uom: it.uom ?? 'UNIT',
      variants: it.variants ?? null,
      gap_inches: it.gap_inches ?? null,
      divan_height_inches: it.divan_height_inches ?? null,
      divan_price_sen: it.divan_price_sen ?? 0,
      leg_height_inches: it.leg_height_inches ?? null,
      leg_price_sen: it.leg_price_sen ?? 0,
      custom_specials: it.custom_specials ?? null,
      line_suffix: it.line_suffix ?? null,
      special_order_price_sen: it.special_order_price_sen ?? 0,
      discount_sen: discountSen,
      delivery_date: effectiveDelivery(
        it.delivery_date,
        it.supplier_delivery_date_2,
        it.supplier_delivery_date_3,
        it.supplier_delivery_date_4,
      ),
    };
  });
  const { error: iErr } = await sb.from('grn_items').insert(stampCompany(rows, c));
  if (iErr) {
    await sb.from('grns').delete().eq('id', h.id);
    if (isPoLineOverReceived(iErr)) return c.json({ error: 'qty_exceeds_remaining', message: 'Another receipt already covers these Purchase Order lines. Refresh the picker and try again.', reason: iErr.message }, 409);
    return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500);
  }

  {
    const over = await verifyGrnOverReceipt(sb, h.id, itemList.map((it) => it.id));
    if (over) {
      await sb.from('grn_items').delete().eq('grn_id', h.id);
      await sb.from('grns').delete().eq('id', h.id);
      return c.json({ error: 'qty_exceeds_remaining', poItemId: over.poItemId, requested: over.requested, remaining: over.remaining }, 409);
    }
  }

  const postRes = await postGrnAndRollup(sb, h.id, user.id, h.company_id, grnTx ? 'DRAFT' : 'POSTED', grnTx);
  if (!postRes.ok && (postRes.zeroCost || postRes.reason === LINES_UNREADABLE || grnTx)) {
    await sb.from('grn_items').delete().eq('grn_id', h.id);
    await sb.from('grns').delete().eq('id', h.id);
    if (isStockTxFailure(postRes)) return refuseWithoutWriting(c, stockTxFailureBody('posted', postRes), 503);
    if (!postRes.zeroCost && postRes.reason !== LINES_UNREADABLE) return c.json({ error: postRes.reason === 'qty_exceeds_remaining' ? postRes.reason : 'post_failed', reason: postRes.reason }, (postRes.status ?? 409) as 409 | 500);
    if (!postRes.zeroCost) return c.json(linesUnreadableBody('the receipt lines', 'posted', null), 503);
    return refuseZeroCostReceipt(c, postRes.zeroCost, { nothingWritten: true });
  }
  await recomputeGrnTotals(sb, h.id);

  await recordGrnCreate(
    sb, c.get('houzsUser'), activeCompanyId(c), h.id, itemList.length,
    `Batch-converted from ${poList.length} PO${poList.length === 1 ? '' : 's'}: ${poNumbersJoined}`,
  );

  /* The receipt IS in the accounts; these are fields on it that are NOT — the
     other verdict, on #2499's key and shape. */
  const ac = poList.length ? await enqueueConvert(sb, {
      companyId: activeCompanyId(c),
      op: 'po_to_gr',
      from: poList.map((po) => ({ table: 'purchase_orders' as const, keyCol: 'id', key: po.id })),
      to: { table: 'grns', keyCol: 'id', key: h.id },
      docType: 'GR',
      docNo: h.grn_number,
      docId: h.id,
      createdBy: c.get('houzsUser')?.id ?? null,
  }) : null;

  const movementErrors = postRes.ok ? postRes.movementErrors : undefined;
  const recountError = postRes.ok ? postRes.recountError : undefined;
  return c.json({ id: h.id, grnNumber: h.grn_number, poCount: poList.length, lineCount: itemList.length, movementErrors: movementErrors?.length ? movementErrors : undefined, recountError, ...(ac?.problems.length ? { acNotSent: ac.problems } : {}) }, 201);
};
grns.post('/from-pos', createGrnFromPosHandler);

export const postGrnHandler = async (c: any) => {
  const lap = stepClock();
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return refuseWithoutWriting(c, co.refusal, 409);
  const { data: cur } = await scopeToCompanyId(sb.from('grns')
    .select('id, status, posted_at, grn_number, warehouse_id, total_sen').eq('id', id), co.companyId).maybeSingle();
  if (!cur) return refuseWithoutWriting(c, NOT_THIS_COMPANY, 404);
  const row = cur as {
    id: string; status: string; posted_at: string | null;
    grn_number: string; warehouse_id: string | null; total_sen: number | null;
  };
  if (row.status === 'POSTED') {
    return c.json({ grn: row });
  }
  if (row.status === 'CANCELLED' || row.status === 'CLOSED') {
    return refuseWithoutWriting(c, { error: 'cannot_confirm', message: `GRN is ${row.status} — cannot confirm.` }, 409);
  }
  const postRefusal = grnPostRefusal(c.get('houzsUser'));
  if (postRefusal) return refuseWithoutWriting(c, postRefusal, 403);
  const splitRefusal = await grnRackSplitPostRefusal(sb, id, co.companyId);
  if (splitRefusal) return refuseWithoutWriting(c, splitRefusal.body, splitRefusal.status);

  const { data: gLines, error: gLinesErr } = await sb.from('grn_items')
    .select('purchase_order_item_id').eq('grn_id', id);
  if (gLinesErr) return refuseWithoutWriting(c, linesUnreadableBody('the receipt lines', 'posted', gLinesErr), 503);
  const poItemIds = ((gLines ?? []) as Array<{ purchase_order_item_id: string | null }>)
    .map((l) => l.purchase_order_item_id);
  const over = await verifyGrnOverReceipt(sb, id, poItemIds);
  if (over) {
    return refuseWithoutWriting(c, { error: 'qty_exceeds_remaining', poItemId: over.poItemId, requested: over.requested, remaining: over.remaining }, 409);
  }

  const pf = await assertAuditWritable(sb, { entityType: 'GRN', entityId: id, action: 'POST', companyId: activeCompanyId(c) });
  if (!pf.ok) return refuseWithoutWriting(c, auditUnavailableBody(), 409);

  lap('grn-checks');
  const res = await postGrnAndRollup(sb, id, user.id, co.companyId, row.status, stockTxFor(c.env, 'GRN_POST_MODE'));
  lap('grn-post');
  if (!res.ok) {
    if (res.zeroCost) return refuseZeroCostReceipt(c, res.zeroCost, { nothingWritten: true });
    if (isStockTxFailure(res)) return refuseWithoutWriting(c, stockTxFailureBody('posted', res), 503);
    if (res.status === 409) {
      const { data: now } = await scopeToCompanyId(sb.from('grns')
        .select('id, status, posted_at, total_sen').eq('id', id), co.companyId).maybeSingle();
      return c.json({ error: 'cannot_confirm', reason: res.reason, grn: now ?? undefined }, 409);
    }
    if (res.reason === LINES_UNREADABLE) return refuseWithoutWriting(c, linesUnreadableBody('the receipt lines', 'posted', null), 503);
    return c.json({ error: 'post_failed', reason: res.reason }, res.status === 404 ? 404 : 500);
  }
  await recomputeGrnTotals(sb, id);
  const { data } = await scopeToCompanyId(sb.from('grns').select('id, status, posted_at, total_sen').eq('id', id), co.companyId).single();

  const postedGrn = data as unknown as { total_sen: number | null } | null;
  await recordEntityAudit(sb, {
    entityType: 'GRN',
    entityId: id,
    entityDocNo: row.grn_number,
    action: 'POST',
    actor: c.get('houzsUser'),
    companyId: activeCompanyId(c),
    statusSnapshot: 'POSTED',
    note: res.movementErrors?.length
      ? `Stock IN reported errors: ${res.movementErrors.join('; ')}`
      : undefined,
    fieldChanges: compactChanges([
      ...statusChange(row.status, 'POSTED'),
      fieldChange('warehouseId', null, row.warehouse_id),
      fieldChange('totalSen', row.total_sen, postedGrn?.total_sen ?? null),
      fieldChange('lineCount', null, poItemIds.length),
    ]),
  });

  try {
    const grnScanNote = noteGrnScanAccepted(getSupabaseService(c.env), row.grn_number);
    try { c.executionCtx.waitUntil(grnScanNote); }
    catch { }
  } catch { }

  lap('grn-totals-audit');
  return c.json({ grn: data, movementErrors: res.movementErrors?.length ? res.movementErrors : undefined, recountError: res.recountError });
};
grns.patch('/:id/post', postGrnHandler);

export const createGrnsFromPoItemsHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  // company-scope: the source load, the active-company stamp and the doc-no
  // prefix all happen inside createDraftGrnsFromPoItemsCore (scoped to this
  // company via the wired context); every by-id write below acts only on a draft
  // id THAT core just created and returned for this company, and postGrnAndRollup
  // re-scopes by the header's own company_id — no caller-supplied id is touched.
  const postRefusal = grnPostRefusal(c.get('houzsUser'));
  if (postRefusal) return refuseWithoutWriting(c, postRefusal, 403);
  const coreRes = await createDraftGrnsFromPoItemsCore({
    req: { json: () => c.req.json() },
    get: ((key: 'supabase' | 'user' | 'companyId' | 'allowedCompanyIds' | 'companyCode') =>
      c.get(key as 'supabase')) as unknown as GrnFromPoItemsContext['get'],
  });
  if (!coreRes.ok) return refuseWithoutWriting(c, coreRes.body, coreRes.status);

  const sb = c.get('supabase'); const user = c.get('user');
  const created: Array<{ id: string; grnNumber: string; purchaseOrderId: string; poNumber: string; lineCount: number; posted?: boolean; postError?: string; movementErrors?: string[]; recountError?: string }> = [];
  const overReceipt = coreRes.overReceipt;
  let zeroCostRefusal: ZeroCostRefusal | null = null;
  let dbCapRefused = false;
  const grnTx = stockTxFor(c.env, 'GRN_POST_MODE');

  for (const draft of coreRes.created) {
    const postRes = await postGrnAndRollup(sb, draft.id, user.id, draft.companyId, 'DRAFT', grnTx);
    if (!postRes.ok && postRes.zeroCost) {
      await sb.from('grn_items').delete().eq('grn_id', draft.id);
      await sb.from('grns').delete().eq('id', draft.id);
      zeroCostRefusal = postRes.zeroCost;
      continue;
    }
    // HC-0004: the DB cap refused the post (a concurrent receipt took the qty).
    // Same rollback; nothing of this bucket was posted.
    if (!postRes.ok && postRes.reason === 'qty_exceeds_remaining') {
      await scopeToCompanyId(sb.from('grn_items').delete().eq('grn_id', draft.id), draft.companyId);
      await scopeToCompanyId(sb.from('grns').delete().eq('id', draft.id), draft.companyId);
      dbCapRefused = true;
      continue;
    }
    if (!postRes.ok) {
    }
    await recordGrnCreate(
      sb, c.get('houzsUser'), activeCompanyId(c), draft.id, draft.lineCount,
      `Received from ${draft.poNumbers.join(', ')}`,
    );

    const bucketPoIds = draft.poIds.length ? draft.poIds : (draft.primaryPoId ? [draft.primaryPoId] : []);
    const bucketAc = bucketPoIds.length ? await enqueueConvert(sb, {
        companyId: activeCompanyId(c),
        op: 'po_to_gr',
        from: bucketPoIds.map((id) => ({ table: 'purchase_orders' as const, keyCol: 'id', key: id })),
        to: { table: 'grns', keyCol: 'id', key: draft.id },
        docType: 'GR',
        docNo: draft.grnNumber,
        docId: draft.id,
        createdBy: c.get('houzsUser')?.id ?? null,
    }) : null;
    const postFailReason = postRes.ok ? undefined : postRes.reason;
    const bucketMovementErrors = postRes.ok ? postRes.movementErrors : undefined;
    const bucketRecountError = postRes.ok ? postRes.recountError : undefined;
    created.push({
      id: draft.id, grnNumber: draft.grnNumber,
      purchaseOrderId: draft.primaryPoId, poNumber: draft.poNumbers.join(', '),
      lineCount: draft.lineCount,
      posted: postRes.ok,
      ...(postFailReason ? { postError: postFailReason } : {}),
      ...(bucketMovementErrors?.length ? { movementErrors: bucketMovementErrors } : {}),
      ...(bucketRecountError ? { recountError: bucketRecountError } : {}),
      ...(bucketAc?.problems.length ? { acNotSent: bucketAc.problems } : {}),
    });
  }

  if (zeroCostRefusal) {
    return refuseZeroCostReceipt(c, { ...zeroCostRefusal, created }, { nothingWritten: created.length === 0 });
  }

  if (dbCapRefused && !overReceipt) {
    return c.json({ error: 'qty_exceeds_remaining', message: 'Another receipt already covers these Purchase Order lines. Refresh the picker and try again.', created }, 409);
  }
  if (overReceipt) {
    return c.json({
      error: 'qty_exceeds_remaining',
      poItemId: overReceipt.poItemId,
      requested: overReceipt.requested,
      remaining: overReceipt.remaining,
      created,
    }, 409);
  }

  return c.json({ created, total: created.length }, 201);
};
grns.post('/from-po-items', createGrnsFromPoItemsHandler);

mountHoldRoute(grns, 'grn');

/* Second GRN route in the PG command txn: the CANCELLED flip, the reversing
   stock OUT, the rack reversal, the audit rows, the AutoCount cancel and the
   allocation request commit together or not at all. 503s without DATABASE_URL
   by design. `sb` is the TRANSACTIONAL client - the body must not reach for
   c.get('supabase'). The body stays INSIDE the route on purpose: several checks
   scan grns.ts by route block, and hoisting it to a named handler moved it out
   of their sight. docs/modules/grn.md 7c. */
export const cancelGrnCommand = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono's context, as everywhere else in this file.
  c: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the pg command client is a PostgREST-shaped shim, not a SupabaseClient; typing it honestly needs schema.pg.ts to cover the SCM tables (drizzle-kit pull), the upstream fix ci.yml's lint job names. Same shape as the line DELETE below.
  sb: any,
) => {
  const cancelErrors: string[] = [];
  const id = c.req.param('id');
  const user = c.get('user');

  const co = requireActiveCompanyId(c);
  if (!co.ok) return refuseWithoutWriting(c, co.refusal, 409);

  const { data: cur, error: readErr } = await scopeToCompanyId(sb.from('grns')
    .select('id, status, grn_number, warehouse_id, migrated_no_stock')
    .eq('id', id), co.companyId).maybeSingle();
  if (readErr) return refuseWithoutWriting(c, { error: 'load_failed', reason: readErr.message }, 500);
  if (!cur) return refuseWithoutWriting(c, NOT_THIS_COMPANY, 404);
  const head = cur as {
    id: string; status: string; grn_number: string; warehouse_id: string | null;
    migrated_no_stock?: boolean | null;
  };
  const migratedNoStock = isMigratedNoStock(head);
  if (head.status === 'CANCELLED') {
    const { data } = await scopeToCompanyId(sb.from('grns').select(HEADER).eq('id', id), co.companyId).maybeSingle();
    return c.json({ grn: data ?? { id, status: 'CANCELLED' } });
  }

  const pf = await assertAuditWritable(sb, { entityType: 'GRN', entityId: id, action: 'CANCEL', companyId: activeCompanyId(c) });
  if (!pf.ok) return refuseWithoutWriting(c, auditUnavailableBody(), 409);

  const recountPoAndRewalk = async (poItemIds: Array<string | null>) => {
    try {
      const recount = await recomputePoReceived(sb, poItemIds);
      if (!recount.ok) {
        cancelErrors.push(
          `PO recount FAILED: ${recount.reason ?? 'unknown'}. The GRN is cancelled but its PO lines ` +
          'still show the goods as received — reopen and re-save the PO, or run the recount.',
        );
      }
    } catch (e) {
      cancelErrors.push(`PO recount threw: ${(e as Error)?.message ?? 'unknown'}`);
    }
    await scheduleStockAllocationAfterCommand(c, sb, `grn-cancel:${id}`);
  };

  if (head.status === 'DRAFT') {
    const { data } = await scopeToCompanyId(sb.from('grns')
      .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'DRAFT'), co.companyId).select(HEADER).maybeSingle();
    await recordEntityAudit(sb, {
      entityType: 'GRN',
      entityId: id,
      entityDocNo: head.grn_number,
      action: 'CANCEL',
      actor: c.get('houzsUser'),
      companyId: activeCompanyId(c),
      statusSnapshot: 'CANCELLED',
      note: 'Draft GRN — nothing was received, so nothing was reversed',
      fieldChanges: statusChange('DRAFT', 'CANCELLED'),
    });
    const { data: draftLines, error: draftLinesErr } = await sb.from('grn_items')
      .select('purchase_order_item_id').eq('grn_id', id);
    if (draftLinesErr) {
      cancelErrors.push(`PO recount skipped: could not read the GRN lines (${draftLinesErr.message}).`);
    } else {
      await recountPoAndRewalk(((draftLines ?? []) as Array<{ purchase_order_item_id: string | null }>)
        .map((l) => l.purchase_order_item_id));
    }
    return c.json({ grn: data ?? { id, status: 'CANCELLED' }, ...(cancelErrors.length ? { cancelErrors } : {}) });
  }

  const childLock = await grnHasDownstream(sb, id);
  if (childLock) return refuseWithoutWriting(c, childLock, 409);

  const { data: lines, error: linesErr } = await sb.from('grn_items')
    .select('purchase_order_item_id, qty_accepted, item_code, material_name, unit_price_sen, item_group, variants')
    .eq('grn_id', id);
  if (linesErr) return refuseWithoutWriting(c, linesUnreadableBody('the receipt lines', 'cancelled', linesErr), 503);
  const lineList = (lines ?? []) as Array<{
    purchase_order_item_id: string | null; qty_accepted: number;
    item_code: string; material_name: string | null; unit_price_sen: number | null;
    item_group?: string | null; variants?: VariantAttrs | null;
  }>;

  if (!migratedNoStock) {
    const consumedLock = await grnReverseWouldGoNegative(sb, head.warehouse_id, lineList);
    if (consumedLock) return refuseWithoutWriting(c, consumedLock, 409);
  }

  const { data: updRow, error: updErr } = await scopeToCompanyId(sb.from('grns')
    .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
    .eq('id', id).neq('status', 'CANCELLED'), co.companyId).select('id').maybeSingle();
  if (updErr) return c.json({ error: 'cancel_failed', reason: updErr.message }, 500);
  if (!updRow) {
    const { data } = await scopeToCompanyId(sb.from('grns').select(HEADER).eq('id', id), co.companyId).maybeSingle();
    return c.json({ grn: data ?? { id, status: 'CANCELLED' } });
  }

  await recordEntityAudit(sb, {
    entityType: 'GRN',
    entityId: id,
    entityDocNo: head.grn_number,
    action: 'CANCEL',
    actor: c.get('houzsUser'),
    companyId: activeCompanyId(c),
    statusSnapshot: 'CANCELLED',
    note: migratedNoStock
      ? `Migrated AutoCount paperwork (${lineList.length} line(s)) — no stock was posted by this receipt, so none was reversed`
      : `Reversing receipt of ${lineList.length} line(s)`,
    fieldChanges: compactChanges([
      ...statusChange(head.status, 'CANCELLED'),
      fieldChange('warehouseId', null, head.warehouse_id),
      fieldChange('qtyReversed', null, migratedNoStock
        ? 0
        : lineList.reduce((s, l) => s + Number(l.qty_accepted ?? 0), 0)),
    ]),
  });

  try {
    const warehouseId = migratedNoStock
      ? null
      : head.warehouse_id ?? (await defaultWarehouseId(sb, activeCompanyId(c)));
    if (warehouseId) {
      const batchByItem = await resolvePoBatchByItem(sb, lineList.map((it) => it.purchase_order_item_id));
      const movements = buildGrnCancelReversals(lineList, batchByItem, {
        warehouseId, grnId: id, grnNumber: head.grn_number, performedBy: user.id,
      }, await bk.loadOwnBucketKeys(sb, 'GRN', id, 'IN', activeCompanyId(c) ?? null));
      if (movements.length > 0) {
        const wrote = await writeMovements(sb, movements, activeCompanyId(c));
        if (!wrote.ok) {
          cancelErrors.push(
            `Stock reversal FAILED (${movements.length} row(s)): ${wrote.reason ?? 'unknown'}. ` +
            'The GRN is cancelled but its received stock is still on hand — run /inventory/reconcile.',
          );
        }
      }
    }
  } catch { }

  if (!migratedNoStock) {
    try {
      const { reverseGrnRacks } = await import('../lib/grn-rack-sync');
      await reverseGrnRacks(sb, id, head.grn_number, user.id);
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[grn-rack] reverse failed:', e); }
  }

  await recountPoAndRewalk(lineList.map((it) => it.purchase_order_item_id));

  const { data } = await sb.from('grns').select(HEADER).eq('id', id).maybeSingle();

  await enqueueCancel(sb, {
    companyId: activeCompanyId(c),
    docType: 'GR',
    docNo: head.grn_number ?? id,
    docId: id,
    self: { table: 'grns', keyCol: 'id', key: id },
    createdBy: c.get('houzsUser')?.id ?? null,
  });

  return c.json({ grn: data ?? { id, status: 'CANCELLED' }, ...(cancelErrors.length ? { cancelErrors } : {}) });
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see cancelGrnCommand.
grns.patch('/:id/cancel', async (c) => runScmPgCommand(c, async (sb: any) => cancelGrnCommand(c, sb)));


grns.patch('/:id', async (c) => {
  const id = c.req.param('id');
  /* company-scope: prove the GRN is ours BEFORE anything below touches it. Every
     write keys on the caller-supplied uuid, so the status and downstream guards
     are real but company-blind — and a header write can relocate stock. */
  {
    const { data: own, error: ownErr } = await scopeToCompany(
      c.get('supabase').from('grns').select('id').eq('id', id), c,
    ).maybeSingle();
    if (ownErr) return refuseWithoutWriting(c, { error: 'lookup_failed', reason: ownErr.message }, 500);
    if (!own) return refuseWithoutWriting(c, { error: 'not_found' }, 404);
  }
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return refuseWithoutWriting(c, { error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const user = c.get('user');

  const co = requireActiveCompanyId(c);
  if (!co.ok) return refuseWithoutWriting(c, co.refusal, 409);

  const { data: beforeRow } = await scopeToCompanyId(sb.from('grns')
    .select(`${GRN_AUDIT_SELECT}, migrated_no_stock`).eq('id', id), co.companyId).maybeSingle();
  if (!beforeRow) return refuseWithoutWriting(c, NOT_THIS_COMPANY, 404);
  const before = (beforeRow ?? {}) as unknown as Record<string, unknown>;

  /* Header inherited-field lock (owner 2026-08-20, §8 GAP-1; grn-inherited-lock.ts):
     supplier + costing basis freeze once a live PI/PR exists. Runs before the
     relocation block so a locked edit writes nothing. */
  const grnHeaderLocked = grnHeaderInheritedChanges(body, before, GRN_AUDIT_FIELDS);
  if (grnHeaderLocked.length > 0 && (await grnHasDownstream(sb, id))) {
    return refuseWithoutWriting(c, grnHeaderInheritedRefusal(grnHeaderLocked), 409);
  }

  if (typeof body.supplierId === 'string' && body.supplierId && body.supplierId !== before.supplier_id) {
    const { data: linked, error: linkedErr } = await scopeToCompanyId(
      sb.from('grn_items').select('purchase_order_item_id').eq('grn_id', id).not('purchase_order_item_id', 'is', null),
      co.companyId,
    );
    if (linkedErr) return refuseWithoutWriting(c, { error: 'lookup_failed', reason: linkedErr.message }, 500);
    const sup = await assertPoLinesFromSupplier(
      sb, c, ((linked ?? []) as Array<{ purchase_order_item_id: string | null }>).map((r) => r.purchase_order_item_id), body.supplierId,
    );
    if (!sup.ok) return refuseWithoutWriting(c, sup.body, sup.status);
  }

  const pf = await assertAuditWritable(sb, {
    entityType: 'GRN', entityId: id, action: 'UPDATE',
    companyId: (before.company_id as number | null) ?? activeCompanyId(c),
  });
  if (!pf.ok) return refuseWithoutWriting(c, auditUnavailableBody(), 409);

  const migratedNoStock = isMigratedNoStock(before as { migrated_no_stock?: boolean | null });
  if (body.warehouseId !== undefined && !migratedNoStock) {
    const c0 = (beforeRow ?? null) as unknown as { grn_number: string; status: string | null; warehouse_id: string | null; exchange_rate?: string | number | null } | null;
    const oldWh = c0?.warehouse_id ?? null;
    const newWh = (body.warehouseId as string | null) ?? null;
    if (c0 && (c0.status ?? '').toUpperCase() === 'POSTED' && newWh && oldWh && newWh !== oldWh) {
      const { data: lines } = await sb.from('grn_items')
        .select('purchase_order_item_id, qty_accepted, item_code, material_name, unit_price_sen, item_group, variants')
        .eq('grn_id', id);
      const lineList = (lines ?? []) as Array<{
        purchase_order_item_id: string | null; qty_accepted: number;
        item_code: string; material_name: string | null; unit_price_sen: number | null;
        item_group?: string | null; variants?: VariantAttrs | null;
      }>;
      const consumedLock = await grnReverseWouldGoNegative(sb, oldWh, lineList);
      if (consumedLock) return refuseWithoutWriting(c, consumedLock, 409);
      const batchByItem = await resolvePoBatchByItem(sb, lineList.map((it) => it.purchase_order_item_id));

      const { data: priorIns, error: priorInsErr } = await sb.from('inventory_movements')
        .select('item_code, variant_key, unit_cost_sen')
        .eq('source_doc_type', 'GRN')
        .eq('source_doc_id', id)
        .eq('movement_type', 'IN');
      if (priorInsErr) return refuseWithoutWriting(c, { error: 'lookup_failed', reason: priorInsErr.message }, 500);
      const landedByBucket = new Map<string, number>();
      for (const m of ((priorIns ?? []) as Array<{ item_code: string; variant_key: string | null; unit_cost_sen: number | null }>)) {
        const cost = Number(m.unit_cost_sen ?? 0);
        if (cost > 0) landedByBucket.set(`${m.item_code}::${m.variant_key ?? ''}`, cost);
      }

      const movements = lineList
        .filter((it) => !isServiceLine({ itemGroup: it.item_group ?? null, itemCode: it.item_code }))
        .filter((it) => (it.qty_accepted ?? 0) > 0)
        .flatMap((it) => {
          const variant_key = bk.ownBucketKey(bk.ownBucketKeyMapFor(activeCompanyId(c) ?? null, (priorIns ?? []) as Array<{ item_code: string; variant_key: string | null }>), it.item_code, computeVariantKey(it.item_group, it.variants ?? null));
          const batch_no = it.purchase_order_item_id ? (batchByItem.get(it.purchase_order_item_id) ?? null) : null;
          const base = {
            item_code: it.item_code, variant_key, product_name: it.material_name,
            qty: it.qty_accepted, source_doc_type: 'GRN' as const, source_doc_id: id,
            source_doc_no: c0.grn_number, batch_no, performed_by: user?.id,
          };
          return [
            { ...base, movement_type: 'OUT' as const, warehouse_id: oldWh, notes: 'GRN warehouse changed — out of old warehouse' },
            {
              ...base,
              movement_type: 'IN' as const,
              warehouse_id: newWh,
              unit_cost_sen: landedByBucket.get(`${it.item_code}::${variant_key}`)
                ?? toMyrSen(Number(it.unit_price_sen ?? 0), c0?.exchange_rate ?? 1),
              notes: 'GRN warehouse changed — into new warehouse',
            },
          ];
        });
      if (movements.length > 0) {
        try {
          await writeMovements(sb, movements, activeCompanyId(c));
          await reconcileUncostedAfterIn(sb, movements, user?.id ?? null);
          try {
            const { recomputeAllocationAfterSave } = await import('../lib/stock-allocation-job');
            await recomputeAllocationAfterSave(sb, 'post-grn-relocate');
          } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-grn-relocate failed:', e); }
        } catch (e) {
          return c.json({ error: 'relocate_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
        }
      }
    }
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [from, to] of [
    ['supplierId', 'supplier_id'], ['receivedAt', 'received_at'], ['notes', 'notes'],
    ['deliveryNoteRef', 'delivery_note_ref'], ['warehouseId', 'warehouse_id'], ['currency', 'currency'],
  ] as const) {
    if (body[from] !== undefined) updates[to] = body[from];
  }
  if (updates.currency !== undefined) updates.currency = normalizeCurrency(updates.currency);
  {
    const rateGuard = await assertForeignRatePatchable(sb, {
      fromCurrency: before.currency,
      toCurrency: updates.currency,
      operatorRate: body.exchangeRate,
      docLabel: 'GRN',
    });
    if (!rateGuard.ok) return c.json(rateGuard.body, 422);
  }
  let methodChanged = false;
  if (body.allocationMethod !== undefined) {
    updates.allocation_method = normalizeAllocationMethod(body.allocationMethod);
    methodChanged = true;
  }
  let rateChanged = false;
  if (body.exchangeRate !== undefined || updates.currency !== undefined) {
    let effectiveCurrency = updates.currency as string | undefined;
    if (effectiveCurrency === undefined) {
      effectiveCurrency = (before.currency as string | undefined) ?? 'MYR';
    }
    if (body.exchangeRate !== undefined) {
      updates.exchange_rate = normalizeExchangeRate(body.exchangeRate, effectiveCurrency);
      rateChanged = true;
    } else if (String(effectiveCurrency).toUpperCase() === 'MYR') {
      updates.exchange_rate = 1;
      rateChanged = true;
    }
  }
  const { data, error } = await scopeToCompanyId(sb.from('grns')
    .update(coerceEmptyDates(updates)).eq('id', id), co.companyId).select(HEADER).maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json(NOT_THIS_COMPANY, 404);

  {
    const auditPatch: Record<string, unknown> = {};
    for (const [camel, snake] of GRN_AUDIT_FIELDS) {
      if (updates[snake] !== undefined) auditPatch[camel] = updates[snake];
    }
    await recordEntityAudit(sb, {
      entityType: 'GRN',
      entityId: id,
      entityDocNo: (before.grn_number as string | null) ?? null,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: (before.company_id as number | null) ?? activeCompanyId(c),
      statusSnapshot: (before.status as string | null) ?? null,
      fieldChanges: diffFields(before, auditPatch, GRN_AUDIT_FIELDS),
    });
  }

  if (rateChanged || methodChanged) {
    try {
      await reallocateGrnCharges(sb, id, activeCompanyId(c) ?? null);
      await recostFromGrn(sb, id);
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[grn-patch] re-alloc/recost failed:', id, e); }
  }
  await queueAcGrnEdit(c, sb, id);
  return c.json({ grn: data });
});

grns.post('/:id/items', async (c) => {
  const grnId = c.req.param('id');
  const addMovementErrors: string[] = [];
  let addRecountError: string | undefined;
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return refuseWithoutWriting(c, { error: 'invalid_json' }, 400); }
  if (!it.itemCode) return refuseWithoutWriting(c, { error: 'item_code_required' }, 400);
  if (!it.materialName) return refuseWithoutWriting(c, { error: 'material_name_required' }, 400);

  const sb = c.get('supabase');
  const addLineGroupOf = await skuCategoryResolver(sb, [{ materialKind: 'mfg_product', itemCode: it.itemCode }], activeCompanyId(c) ?? null);
  const user = c.get('user');
  /* company-scope: PROVE THE PARENT GRN FIRST — the gate PATCH /:id opens with.
     A STAMP IS NOT A PREDICATE: the insert below stamps activeCompanyId(c),
     which says who was typing, not whose GRN was loaded. Every read here keys on
     `grnId` alone and the client is service-role (RLS bypassed, mig 0061), so
     another company's GRN id was accepted — their receipt carrying our stamp,
     their header re-totalled, their inventory IN and their PO's received_qty.
     Refused BEFORE the child-lock and status probes, so an out-of-company id
     cannot be used to ask whether that GRN exists. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return refuseWithoutWriting(c, co.refusal, 409);
  const { data: grnOwn, error: grnOwnErr } = await scopeToCompanyId(
    sb.from('grns').select('id').eq('id', grnId), co.companyId,
  ).maybeSingle();
  if (grnOwnErr) return refuseWithoutWriting(c, { error: 'lookup_failed', reason: grnOwnErr.message }, 500);
  if (!grnOwn) return refuseWithoutWriting(c, NOT_THIS_COMPANY, 404);

  const childLock = await grnHasDownstream(sb, grnId);
  if (childLock) return refuseWithoutWriting(c, childLock, 409);
  const { data: grnGate } = await sb.from('grns').select('status, migrated_no_stock').eq('id', grnId).maybeSingle();
  const grnGateStatus = ((grnGate as { status?: string } | null)?.status ?? '').toUpperCase();
  const migratedNoStock = isMigratedNoStock(grnGate as { migrated_no_stock?: boolean | null } | null);
  if (grnGateStatus === 'CANCELLED' || grnGateStatus === 'CLOSED') {
    return refuseWithoutWriting(c, { error: 'grn_locked',
      message: `This GRN is ${grnGateStatus} — its lines can no longer be changed.` }, 409);
  }

  {
    const { data: grnPo } = await sb.from('grns').select('purchase_order_id').eq('id', grnId).maybeSingle();
    const unlinked = await findUnlinkedPoLines(
      sb,
      (grnPo as { purchase_order_id?: string | null } | null)?.purchase_order_id ?? null,
      null,
      [{
        lineRef: 'add',
        itemCode: String(it.itemCode ?? ''),
        qty: Number(it.qtyAccepted ?? it.qtyReceived ?? it.qty ?? 0),
        soItemId: (it.purchaseOrderItemId as string | undefined) ?? null,
      }],
    );
    const bad = unlinkedScanRefusal(unlinked, unlinkedPoLinesResponse);
    if (bad) return refuseWithoutWriting(c, bad, 409);
  }

  const parsedAdd = parseLineNumbers({
    qty: { value: it.qty, fallback: 1 },
    unitPriceSen: { value: it.unitPriceSen },
    discountSen: { value: it.discountSen },
  });
  if (!parsedAdd.ok) return refuseWithoutWriting(c, invalidLineNumberBody(parsedAdd.invalid), 400);
  const { qty: qtyReceived, unitPriceSen, discountSen } = parsedAdd.nums as {
    qty: number; unitPriceSen: number; discountSen: number;
  };
  const lineTotal = Math.max(0, (qtyReceived * unitPriceSen) - discountSen);

  const addLinePoItemId = (it.purchaseOrderItemId as string) ?? null;
  if (addLinePoItemId) {
    const xl = await assertSourceLinesInCompany(sb, c, 'purchase_order_items', [addLinePoItemId], { lines: [it], linkField: 'purchaseOrderItemId', source: 'Purchase Order line' });
    if (!xl.ok) return refuseWithoutWriting(c, xl.body, xl.status);
    const { data: grnSup, error: grnSupErr } = await scopeToCompanyId(
      sb.from('grns').select('supplier_id').eq('id', grnId), co.companyId,
    ).maybeSingle();
    if (grnSupErr) return refuseWithoutWriting(c, { error: 'lookup_failed', reason: grnSupErr.message }, 500);
    const sup = await assertPoLinesFromSupplier(sb, c, [addLinePoItemId], String((grnSup as { supplier_id?: string | null } | null)?.supplier_id ?? ''));
    if (!sup.ok) return refuseWithoutWriting(c, sup.body, sup.status);
    const capLock = await qtyCapRefusal(sb, {
      table: 'purchase_order_items', id: addLinePoItemId,
      capColumn: 'qty', drawnColumns: ['received_qty'],
      requested: qtyReceived, what: 'PO line',
    });
    if (capLock) return refuseWithoutWriting(c, { ...capLock, poItemId: addLinePoItemId }, 409);
  }

  const pf = await assertAuditWritable(sb, { entityType: 'GRN', entityId: grnId, action: 'UPDATE', companyId: activeCompanyId(c) });
  if (!pf.ok) return refuseWithoutWriting(c, auditUnavailableBody(), 409);

  const row: Record<string, unknown> = {
    grn_id: grnId,
    purchase_order_item_id: (it.purchaseOrderItemId as string) ?? null,
    material_kind: (it.materialKind as string) ?? 'mfg_product',
    item_code: it.itemCode,
    material_name: it.materialName,
    supplier_sku: (it.supplierSku as string) ?? null,
    qty_received: qtyReceived,
    qty_accepted: qtyReceived,
    qty_rejected: 0,
    unit_price_sen: unitPriceSen,
    discount_sen: discountSen,
    line_total_sen: lineTotal,
    unit_cost_sen: Number(it.unitCostSen ?? 0),
    notes: (it.notes as string) ?? null,
    gap_inches: (it.gapInches as number) ?? null,
    divan_height_inches: (it.divanHeightInches as number) ?? null,
    divan_price_sen: Number(it.divanPriceSen ?? 0),
    leg_height_inches: (it.legHeightInches as number) ?? null,
    leg_price_sen: Number(it.legPriceSen ?? 0),
    custom_specials: (it.customSpecials as unknown) ?? null,
    line_suffix: (it.lineSuffix as string) ?? null,
    special_order_price_sen: Number(it.specialOrderPriceSen ?? 0),
    variants: (it.variants as unknown) ?? null,
    description: (it.description as string) ?? null,
    ...lineIdentityFields(addLineGroupOf, it, buildVariantSummary), // SKU wins — docs/bugs/0514
    uom: (it.uom as string) ?? 'UNIT',
    delivery_date: dateOrNull(it.deliveryDate),
    ...zeroCostAckColumns(it, user.id),
  };
  const { data, error } = await sb.from('grn_items').insert({ ...row, company_id: co.companyId }).select(ITEM).single();
  if (isPoLineOverReceived(error)) return c.json({ error: 'qty_exceeds_remaining', poItemId: addLinePoItemId, requested: qtyReceived, reason: error?.message }, 409);
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);

  if (addLinePoItemId) {
    const inserted = data as unknown as { id: string } | null;
    const { data: poItem } = await sb.from('purchase_order_items')
      .select('qty').eq('id', addLinePoItemId).maybeSingle();
    if (poItem) {
      const cap = (poItem as { qty: number }).qty ?? 0;
      const { data: sib } = await sb.from('grn_items')
        .select('qty_accepted, grn_id').eq('purchase_order_item_id', addLinePoItemId);
      const sibRows = (sib ?? []) as Array<{ qty_accepted: number; grn_id: string }>;
      const grnIds = [...new Set(sibRows.map((r) => r.grn_id))];
      const cancelled = new Set<string>();
      if (grnIds.length > 0) {
        const { data: gs } = await sb.from('grns').select('id, status').in('id', grnIds);
        for (const g of (gs ?? []) as Array<{ id: string; status: string }>) {
          if (g.status === 'CANCELLED') cancelled.add(g.id);
        }
      }
      const liveAccepted = sibRows
        .filter((r) => !cancelled.has(r.grn_id))
        .reduce((s, r) => s + Number(r.qty_accepted ?? 0), 0);
      if (liveAccepted > cap && inserted?.id) {
        await sb.from('grn_items').delete().eq('id', inserted.id);
        return c.json({ error: 'qty_exceeds_remaining', poItemId: addLinePoItemId, requested: qtyReceived, remaining: cap - (liveAccepted - qtyReceived) }, 409);
      }
    }
  }

  await recomputeGrnTotals(sb, grnId);

  {
    const added = (data ?? {}) as unknown as Record<string, unknown>;
    const meta = await loadGrnAuditMeta(sb, grnId);
    await recordEntityAudit(sb, {
      entityType: 'GRN',
      entityId: grnId,
      entityDocNo: meta.docNo,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: meta.companyId ?? activeCompanyId(c),
      statusSnapshot: meta.status,
      note: `Line added: ${String(it.itemCode ?? '')}`,
      fieldChanges: compactChanges(
        GRN_LINE_AUDIT_FIELDS.map(([camel, snake]) => fieldChange(camel, null, added[snake] ?? null)),
      ),
    });
  }

  const addedPoiId = (it.purchaseOrderItemId as string) ?? null;
  if (grnGateStatus !== 'DRAFT') {
  try {
    const recount = await recomputePoReceived(sb, [addedPoiId]);
    if (!recount.ok) addRecountError = recount.reason ?? 'unknown';
  } catch (e) { addRecountError = e instanceof Error ? e.message : String(e); }
  if (qtyReceived > 0 && !migratedNoStock) {
    try {
      const { data: grnHeader } = await sb.from('grns')
        .select('grn_number, warehouse_id, exchange_rate').eq('id', grnId).maybeSingle();
      const warehouseId = (grnHeader as { warehouse_id: string | null } | null)?.warehouse_id
        ?? (await defaultWarehouseId(sb, activeCompanyId(c)));
      const addLineRate = (grnHeader as { exchange_rate?: string | number | null } | null)?.exchange_rate ?? 1;
      if (warehouseId) {
        const addedPoItemId = (it.purchaseOrderItemId as string) ?? null;
        const batchByItem = await resolvePoBatchByItem(sb, [addedPoItemId]);
        const addedKey = await bk.stockBucketKeyOne(sb, activeCompanyId(c) ?? null, { item_code: String(it.itemCode), item_group: (it.itemGroup as string) ?? null, variants: it.variants ?? null, warehouse_id: warehouseId });
        const wrote = await writeMovements(sb, [{
          movement_type: 'IN' as const,
          warehouse_id: warehouseId,
          item_code: String(it.itemCode),
          variant_key: addedKey,
          product_name: String(it.materialName),
          qty: qtyReceived,
          unit_cost_sen: toMyrSen(unitPriceSen, addLineRate),
          source_doc_type: 'GRN' as const,
          source_doc_id: grnId,
          source_doc_no: (grnHeader as { grn_number: string } | null)?.grn_number ?? grnId,
          batch_no: addedPoItemId ? (batchByItem.get(addedPoItemId) ?? null) : null,
          performed_by: user.id,
          notes: 'GRN line added — receipt',
        }], activeCompanyId(c));
        if (!wrote.ok) addMovementErrors.push(`IN ${String(it.itemCode)}: ${wrote.reason ?? 'unknown'}`);
        await reconcileUncostedAfterIn(sb, [{
          movement_type: 'IN',
          warehouse_id: warehouseId,
          item_code: String(it.itemCode),
          variant_key: addedKey,
          qty: qtyReceived,
        }], user.id);
        try {
          const { recomputeAllocationAfterSave } = await import('../lib/stock-allocation-job');
          await recomputeAllocationAfterSave(sb, 'post-grn-line-add');
        } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-grn-line-add failed:', e); }
      } else {
        addMovementErrors.push(`IN ${String(it.itemCode)}: no warehouse to receive into`);
      }
    } catch (e) { addMovementErrors.push(`stock IN threw: ${e instanceof Error ? e.message : String(e)}`); }
  }
  }
  await queueAcGrnEdit(c, sb, grnId, [], ((data as { id?: unknown } | null)?.id ? [String((data as { id?: unknown }).id)] : []));
  return c.json({ item: data, movementErrors: addMovementErrors.length ? addMovementErrors : undefined, recountError: addRecountError }, 201);
});

grns.patch('/:id/items/:itemId', async (c) => {
  const grnId = c.req.param('id'); const itemId = c.req.param('itemId');
  const editMovementErrors: string[] = [];
  let editRecountError: string | undefined;
  // company-scope: prove the parent GRN. Editing a line re-costs it and rolls
  // the PO's received_qty back up — both are writes on the other company's data
  // if the parent is not ours.
  {
    const { data: own, error: ownErr } = await scopeToCompany(
      c.get('supabase').from('grns').select('id').eq('id', grnId), c,
    ).maybeSingle();
    if (ownErr) return refuseWithoutWriting(c, { error: 'lookup_failed', reason: ownErr.message }, 500);
    if (!own) return refuseWithoutWriting(c, { error: 'not_found' }, 404);
  }
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return refuseWithoutWriting(c, { error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const user = c.get('user');

  const co = requireActiveCompanyId(c);
  if (!co.ok) return refuseWithoutWriting(c, co.refusal, 409);

  const childLock = await grnHasDownstream(sb, grnId);
  if (childLock) return refuseWithoutWriting(c, childLock, 409);
  const { data: grnGate } = await scopeToCompanyId(sb.from('grns').select('status, purchase_order_id, migrated_no_stock').eq('id', grnId), co.companyId).maybeSingle();
  if (!grnGate) return refuseWithoutWriting(c, NOT_THIS_COMPANY, 404);
  const grnGateStatus = ((grnGate as { status?: string } | null)?.status ?? '').toUpperCase();
  const migratedNoStock = isMigratedNoStock(grnGate as { migrated_no_stock?: boolean | null } | null);
  if (grnGateStatus === 'CANCELLED' || grnGateStatus === 'CLOSED') {
    return refuseWithoutWriting(c, { error: 'grn_locked',
      message: `This GRN is ${grnGateStatus} — its lines can no longer be changed.` }, 409);
  }

  const { data: prevRow } = await sb.from('grn_items')
    .select(GRN_LINE_AUDIT_SELECT + ', variants, purchase_order_item_id, version')
    .eq('id', itemId).maybeSingle();
  if (!prevRow) return refuseWithoutWriting(c, { error: 'not_found' }, 404);
  const prev = prevRow as unknown as Record<string, unknown>;

  const prevAccepted = (prev as { qty_accepted: number }).qty_accepted ?? 0;
  const parsedQty = parseLineNumbers({
    qty: { value: it.qty !== undefined ? it.qty : (prev as { qty_received: number }).qty_received },
  });
  if (!parsedQty.ok) return refuseWithoutWriting(c, invalidLineNumberBody(parsedQty.invalid), 400);
  const qtyReceived = parsedQty.nums.qty as number;

  {
    const poItemId = (prev as { purchase_order_item_id: string | null }).purchase_order_item_id;
    const prevQty = (prev as { qty_received: number }).qty_received ?? 0;
    if (poItemId && qtyReceived > prevQty) {
      const capLock = await qtyCapRefusal(sb, {
        table: 'purchase_order_items', id: poItemId,
        capColumn: 'qty', drawnColumns: ['received_qty'],
        requested: qtyReceived, ownPriorDraw: prevQty, what: 'PO line',
      });
      if (capLock) return refuseWithoutWriting(c, { ...capLock, poItemId }, 409);
    }
  }

  const repoint = await unlinkedEditRefusal(sb, 'grn', {
    parentId: (grnGate as { purchase_order_id?: string | null } | null)?.purchase_order_id ?? null,
    storedLink: (prev as { purchase_order_item_id: string | null }).purchase_order_item_id,
    storedCode: (prev as { item_code: string | null }).item_code,
    patchCode: it.itemCode,
  });
  if (repoint) return refuseWithoutWriting(c, repoint, 409);
  // Inherited-field lock — a PO-linked GRN line's item/variant is read-only
  // (owner 2026-08-20; grn-inherited-lock.ts). Cancel the GRN, edit the PO.
  const grnLockChanges = grnInheritedFieldChanges(prev as GrnLinePrev, it as GrnLinePatch, buildVariantSummary);
  if (grnLockChanges.length > 0) return refuseWithoutWriting(c, grnInheritedLockedRefusal(grnLockChanges), 409);
  const unit = it.unitPriceSen !== undefined ? Number(it.unitPriceSen) : (prev as { unit_price_sen: number }).unit_price_sen;
  const discount = it.discountSen !== undefined ? Number(it.discountSen) : ((prev as { discount_sen: number }).discount_sen ?? 0);
  const lineTotal = Math.max(0, (qtyReceived * unit) - discount);

  const updates: Record<string, unknown> = {
    qty_received: qtyReceived,
    qty_accepted: qtyReceived,
    unit_price_sen: unit,
    discount_sen: discount,
    line_total_sen: lineTotal,
  };
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['materialName', 'material_name'],
    ['supplierSku', 'supplier_sku'], ['itemGroup', 'item_group'],
    ['description', 'description'], ['uom', 'uom'],
    ['unitCostSen', 'unit_cost_sen'], ['notes', 'notes'],
    ['gapInches', 'gap_inches'], ['divanHeightInches', 'divan_height_inches'],
    ['divanPriceSen', 'divan_price_sen'], ['legHeightInches', 'leg_height_inches'],
    ['legPriceSen', 'leg_price_sen'], ['customSpecials', 'custom_specials'],
    ['lineSuffix', 'line_suffix'], ['specialOrderPriceSen', 'special_order_price_sen'],
    ['variants', 'variants'], ['deliveryDate', 'delivery_date'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  Object.assign(updates, zeroCostAckColumns(it, user.id));

  {
    const effGroup = (it.itemGroup ?? (prev as { item_group?: string }).item_group) as string | null | undefined;
    const effVariants = (it.variants ?? (prev as { variants?: unknown }).variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  const newAccepted = updates.qty_accepted as number;
  const oldGroup = (prev as { item_group?: string | null }).item_group ?? null;
  const oldVariants = (prev as { variants?: VariantAttrs | null }).variants ?? null;
  const effGroup = (updates.item_group !== undefined ? (updates.item_group as string | null) : oldGroup);
  const effVariants = (updates.variants !== undefined ? (updates.variants as VariantAttrs | null) : oldVariants);
  const oldKey = computeVariantKey(oldGroup, oldVariants);
  const newKey = computeVariantKey(effGroup, effVariants);
  const matCode = (updates.item_code as string | undefined) ?? (prev as { item_code: string }).item_code;
  const matName = (updates.material_name as string | undefined) ?? (prev as { material_name: string | null }).material_name;
  const bucketChanged = !bk.sameBucketFor(activeCompanyId(c) ?? null, oldKey, newKey);
  const qtyChanged = newAccepted !== prevAccepted;
  const isDraftGrn = grnGateStatus === 'DRAFT';
  const inventoryChange = !isDraftGrn && !migratedNoStock
    && (qtyChanged || bucketChanged) && (prevAccepted > 0 || newAccepted > 0);

  let editWarehouseId: string | null = null;
  let editGrnNo = grnId;
  let editRate: string | number | null = 1;
  if (inventoryChange) {
    const { data: grnHead, error: grnHeadErr } = await sb.from('grns').select('grn_number, warehouse_id, exchange_rate').eq('id', grnId).maybeSingle();
    if (grnHeadErr) return refuseWithoutWriting(c, linesUnreadableBody('the receipt header', 'changed', grnHeadErr), 503);
    editWarehouseId = (grnHead as { warehouse_id: string | null } | null)?.warehouse_id
      ?? (await defaultWarehouseId(sb, activeCompanyId(c)));
    editGrnNo = (grnHead as { grn_number: string } | null)?.grn_number ?? grnId;
    editRate = (grnHead as { exchange_rate?: string | number | null } | null)?.exchange_rate ?? 1;

    if (editWarehouseId) {
      const guardLines: Array<{ qty_accepted: number; item_code: string; item_group?: string | null; variants?: VariantAttrs | null }> = [];
      if (bucketChanged) {
        if (prevAccepted > 0) guardLines.push({ qty_accepted: prevAccepted, item_code: matCode, item_group: oldGroup, variants: oldVariants });
      } else if (newAccepted < prevAccepted) {
        guardLines.push({ qty_accepted: prevAccepted - newAccepted, item_code: matCode, item_group: effGroup, variants: effVariants });
      }
      const consumedLock = await grnReverseWouldGoNegative(sb, editWarehouseId, guardLines);
      if (consumedLock) return refuseWithoutWriting(c, consumedLock, 409);
    }
  }

  const pf = await assertAuditWritable(sb, { entityType: 'GRN', entityId: grnId, action: 'UPDATE', companyId: activeCompanyId(c) });
  if (!pf.ok) return refuseWithoutWriting(c, auditUnavailableBody(), 409);

  const storedVersion = (prev as { version?: number | null }).version;
  if (storedVersion != null) updates.version = Number(storedVersion) + 1;
  const storedAccepted = (prev as { qty_accepted: number | null }).qty_accepted;
  let lineWrite = sb.from('grn_items').update(coerceEmptyDates(updates)).eq('id', itemId);
  lineWrite = storedAccepted == null ? lineWrite.is('qty_accepted', null) : lineWrite.eq('qty_accepted', storedAccepted);
  if (storedVersion != null) lineWrite = lineWrite.eq('version', Number(storedVersion));
  const { data: claimedLine, error } = await scopeToCompanyId(lineWrite, co.companyId).select('id');
  if (!error && ((claimedLine as unknown[] | null) ?? []).length === 0) {
    return refuseWithoutWriting(c, { error: 'line_changed', message: 'Someone else changed this line while you were editing it. Reload to see their change, then edit again.' }, 409);
  }
  if (isPoLineOverReceived(error)) return c.json({ error: 'qty_exceeds_remaining', poItemId: (prev as { purchase_order_item_id: string | null }).purchase_order_item_id, requested: qtyReceived, reason: error?.message }, 409);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);

  {
    const auditPatch: Record<string, unknown> = {};
    for (const [camel, snake] of GRN_LINE_AUDIT_FIELDS) {
      if (updates[snake] !== undefined) auditPatch[camel] = updates[snake];
    }
    const lineChanges = diffFields(prev as unknown as Record<string, unknown>, auditPatch, GRN_LINE_AUDIT_FIELDS);
    if (lineChanges.length > 0) {
      const meta = await loadGrnAuditMeta(sb, grnId);
      await recordEntityAudit(sb, {
        entityType: 'GRN',
        entityId: grnId,
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

  if (inventoryChange && editWarehouseId) {
    const warehouseId = editWarehouseId;
    const editPoItemId = (prev as { purchase_order_item_id: string | null }).purchase_order_item_id;
    const editBatch = editPoItemId
      ? ((await resolvePoBatchByItem(sb, [editPoItemId])).get(editPoItemId) ?? null)
      : null;
    const batchTag = editBatch ? { batch_no: editBatch } : {};
    const oldStoredKey = await bk.ownDocBucketKey(sb, { type: 'GRN', id: grnId, movement: 'IN', companyId: activeCompanyId(c) ?? null }, matCode, oldKey);
    const newStoredKey = bucketChanged ? await bk.stockBucketKeyOne(sb, activeCompanyId(c) ?? null, { item_code: matCode, item_group: effGroup, variants: effVariants, warehouse_id: warehouseId }) : oldStoredKey;
    const movements: Array<Parameters<typeof writeMovements>[1][number]> = [];
    if (bucketChanged) {
      if (prevAccepted > 0) movements.push({
        movement_type: 'OUT', warehouse_id: warehouseId, item_code: matCode,
        variant_key: oldStoredKey, product_name: matName, qty: prevAccepted,
        source_doc_type: 'GRN', source_doc_id: grnId, source_doc_no: editGrnNo,
        performed_by: user.id, notes: 'GRN line edited — variant changed, reversing old bucket', ...batchTag,
      });
      if (newAccepted > 0) movements.push({
        movement_type: 'IN', warehouse_id: warehouseId, item_code: matCode,
        variant_key: newStoredKey, product_name: matName, qty: newAccepted, unit_cost_sen: toMyrSen(unit, editRate),
        source_doc_type: 'GRN', source_doc_id: grnId, source_doc_no: editGrnNo,
        performed_by: user.id, notes: 'GRN line edited — variant changed, re-adding new bucket', ...batchTag,
      });
    } else {
      const delta = newAccepted - prevAccepted;
      if (delta > 0) movements.push({
        movement_type: 'IN', warehouse_id: warehouseId, item_code: matCode,
        variant_key: newStoredKey, product_name: matName, qty: delta, unit_cost_sen: toMyrSen(unit, editRate),
        source_doc_type: 'GRN', source_doc_id: grnId, source_doc_no: editGrnNo,
        performed_by: user.id, notes: 'GRN line qty edited — receiving delta', ...batchTag,
      });
      else if (delta < 0) movements.push({
        movement_type: 'OUT', warehouse_id: warehouseId, item_code: matCode,
        variant_key: newStoredKey, product_name: matName, qty: -delta,
        source_doc_type: 'GRN', source_doc_id: grnId, source_doc_no: editGrnNo,
        performed_by: user.id, notes: 'GRN line qty edited — reversing delta', ...batchTag,
      });
    }
    if (movements.length > 0) {
      try {
        const wrote = await writeMovements(sb, movements, activeCompanyId(c));
        if (!wrote.ok) editMovementErrors.push(`stock ${wrote.reason ?? 'unknown'}`);
        await reconcileUncostedAfterIn(sb, movements, user.id);
        try {
          const { recomputeAllocationAfterSave } = await import('../lib/stock-allocation-job');
          await recomputeAllocationAfterSave(sb, 'post-grn-line-edit');
        } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-grn-line-edit failed:', e); }
      } catch (e) { editMovementErrors.push(`stock write threw: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  await recomputeGrnTotals(sb, grnId);
  if (!isDraftGrn) {
    try {
      const recount = await recomputePoReceived(sb, [(prev as { purchase_order_item_id: string | null }).purchase_order_item_id]);
      if (!recount.ok) editRecountError = recount.reason ?? 'unknown';
    } catch (e) { editRecountError = e instanceof Error ? e.message : String(e); }
    const prevUnit = (prev as { unit_price_sen: number | null }).unit_price_sen ?? 0;
    const priceChanged = Number(unit) !== Number(prevUnit);
    if (priceChanged || bucketChanged) await recostFromGrn(sb, grnId);
  }
  await queueAcGrnEdit(c, sb, grnId);
  return c.json({ ok: true, movementErrors: editMovementErrors.length ? editMovementErrors : undefined, recountError: editRecountError });
});

grns.patch('/:id/items/:itemId/rack', setGrnLineRackHandler);
grns.get('/:id/racks', getGrnItemRacksHandler);
grns.put('/:id/items/:itemId/racks', putGrnItemRacksHandler);

/* First GRN route in the PG command txn: line delete, stock OUT, audit, outbox
   and allocation request commit together or not at all. 503s without
   DATABASE_URL by design. `sb` is the TRANSACTIONAL client - the body must not
   reach for c.get('supabase'). The body stays INSIDE the route on purpose:
   several checks scan grns.ts by route block, and hoisting it to a named
   handler moved it out of their sight. docs/modules/grn.md 7c. */
grns.delete('/:id/items/:itemId', async (c) => runScmPgCommand(c, async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the pg command client is a PostgREST-shaped shim, not a SupabaseClient; typing it honestly needs schema.pg.ts to cover the SCM tables (drizzle-kit pull), the upstream fix ci.yml's lint job names. Same shape as mfg-sales-orders' command handlers.
  sb: any,
) => {
  const grnId = c.req.param('id'); const itemId = c.req.param('itemId');
  const user = c.get('user');
  // company-scope: prove the parent GRN — same reasoning as the line PATCH.
  {
    const { data: own, error: ownErr } = await scopeToCompany(
      sb.from('grns').select('id').eq('id', grnId), c,
    ).maybeSingle();
    if (ownErr) return refuseWithoutWriting(c, { error: 'lookup_failed', reason: ownErr.message }, 500);
    if (!own) return refuseWithoutWriting(c, { error: 'not_found' }, 404);
  }

  const co = requireActiveCompanyId(c);
  if (!co.ok) return refuseWithoutWriting(c, co.refusal, 409);

  const childLock = await grnHasDownstream(sb, grnId);
  if (childLock) return refuseWithoutWriting(c, childLock, 409);
  const { data: grnGate } = await scopeToCompanyId(sb.from('grns').select('status, migrated_no_stock').eq('id', grnId), co.companyId).maybeSingle();
  if (!grnGate) return refuseWithoutWriting(c, NOT_THIS_COMPANY, 404);
  const grnGateStatus = ((grnGate as { status?: string } | null)?.status ?? '').toUpperCase();
  const migratedNoStock = isMigratedNoStock(grnGate as { migrated_no_stock?: boolean | null } | null);
  if (grnGateStatus === 'CANCELLED' || grnGateStatus === 'CLOSED') {
    return refuseWithoutWriting(c, { error: 'grn_locked',
      message: `This GRN is ${grnGateStatus} — its lines can no longer be changed.` }, 409);
  }

  const { data: lineRow } = await sb.from('grn_items')
    .select(GRN_LINE_AUDIT_SELECT + ', purchase_order_item_id, variants')
    .eq('id', itemId).maybeSingle();
  const line = (lineRow ?? null) as unknown as Record<string, unknown> | null;

  const isDraftGrn = grnGateStatus === 'DRAFT';
  const noCommittedStock = isDraftGrn || migratedNoStock;
  if (line && !noCommittedStock) {
    const lg = line as {
      qty_accepted: number; item_code: string;
      item_group?: string | null; variants?: VariantAttrs | null;
    };
    if ((lg.qty_accepted ?? 0) > 0) {
      const { data: grnHead } = await sb.from('grns').select('warehouse_id').eq('id', grnId).maybeSingle();
      const warehouseId = (grnHead as { warehouse_id: string | null } | null)?.warehouse_id
        ?? (await defaultWarehouseId(sb, activeCompanyId(c)));
      const consumedLock = await grnReverseWouldGoNegative(sb, warehouseId, [lg]);
      if (consumedLock) return refuseWithoutWriting(c, consumedLock, 409);
    }
  }

  const pf = await assertAuditWritable(sb, { entityType: 'GRN', entityId: grnId, action: 'UPDATE', companyId: activeCompanyId(c) });
  if (!pf.ok) return refuseWithoutWriting(c, auditUnavailableBody(), 409);

  const retire = await retiredLineOf(sb, 'grn_items', itemId);

  const { error } = await scopeToCompanyId(sb.from('grn_items').delete().eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);

  {
    const doomed = (line ?? {}) as unknown as Record<string, unknown>;
    const meta = await loadGrnAuditMeta(sb, grnId);
    await recordEntityAudit(sb, {
      entityType: 'GRN',
      entityId: grnId,
      entityDocNo: meta.docNo,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: meta.companyId ?? activeCompanyId(c),
      statusSnapshot: meta.status,
      note: `Line removed: ${String(doomed.item_code ?? itemId)}`,
      fieldChanges: compactChanges(
        GRN_LINE_AUDIT_FIELDS.map(([camel, snake]) => fieldChange(camel, doomed[snake] ?? null, null)),
      ),
    });
  }

  if (line && !isDraftGrn) {
    const l = line as {
      qty_accepted: number; purchase_order_item_id: string | null;
      item_code: string; material_name: string | null; unit_price_sen: number | null;
      item_group?: string | null; variants?: VariantAttrs | null;
    };
    try { await recomputePoReceived(sb, [l.purchase_order_item_id]); } catch { }

    if ((l.qty_accepted ?? 0) > 0 && !noCommittedStock) {
      let stockReversed = false;
      try {
        const { data: grnHeader } = await sb.from('grns')
          .select('grn_number, warehouse_id').eq('id', grnId).maybeSingle();
        const warehouseId = (grnHeader as { warehouse_id: string | null } | null)?.warehouse_id
          ?? (await defaultWarehouseId(sb, activeCompanyId(c)));
        if (warehouseId) {
          const variantKey = await bk.ownDocBucketKey(sb, { type: 'GRN', id: grnId, movement: 'IN', companyId: activeCompanyId(c) ?? null }, l.item_code, computeVariantKey(l.item_group, l.variants ?? null));
          const batchMap = await resolvePoBatchByItem(sb, [l.purchase_order_item_id]);
          const batchNo: string | null = l.purchase_order_item_id
            ? (batchMap.get(l.purchase_order_item_id) ?? null)
            : null;
          await writeMovements(sb, [{
            movement_type: 'OUT' as const,
            warehouse_id: warehouseId,
            item_code: l.item_code,
            variant_key: variantKey,
            product_name: l.material_name,
            qty: l.qty_accepted,
            ...(batchNo ? { batch_no: batchNo } : {}),
            source_doc_type: 'GRN' as const,
            source_doc_id: grnId,
            source_doc_no: (grnHeader as { grn_number: string } | null)?.grn_number ?? grnId,
            performed_by: user.id,
            notes: 'GRN line deleted — reversing receipt',
          }], activeCompanyId(c));
          stockReversed = true;
        }
      } catch { }
      /* DURABLE: queues with the OUT above, and is NOT caught - a failed
         enqueue must fail the delete. docs/modules/grn.md 7c. */
      if (stockReversed) await scheduleStockAllocationAfterCommand(c, sb, `grn-line-delete:${grnId}`);
    }
  }

  await recomputeGrnTotals(sb, grnId);
  await queueAcGrnEdit(c, sb, grnId, retire);
  return c.body(null, 204);
}));
