// /grns — Goods Receipt Notes (procurement receiving step).
// PO → GRN → Purchase Invoice. On POST, qty_received rolls up to PO items.

import { Hono } from 'hono';
import { GRN_STATUS_BUCKETS } from '../lib/grn-status-buckets';
import { HELD_OR_TERM, HOLD_COLUMNS, isDocumentHeld } from '../lib/document-hold';
import { isReceivablePo } from '../lib/source-document-gates'; import { mountHoldRoute } from './document-hold-routes';
import type { Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { writeMovements, defaultWarehouseId, reconcileDropshipBatches } from '../lib/inventory-movements';
import { dateOrNull, coerceEmptyDates } from '../lib/date-coerce';
import { grnHasDownstream } from '../lib/downstream-lock';
import { qtyCapRefusal } from '../lib/qty-cap';
import { enqueueConvert, recordParentlessCreate, enqueueCancel, retiredLineOf, type AcRetiredLine } from '../lib/autocount-outbox';
import { sourcePoIdsForGrn } from '../lib/convert-parent';
import { queueAcGrnEdit } from '../lib/ac-grn-outbox';
import { buildGrnCancelReversals } from '../lib/grn-cancel-reversal';
import { loadGrnAuditMeta } from '../lib/grn-audit-meta';
import { runScmPgCommand } from '../lib/pg-supabase-transaction';
import { scheduleStockAllocationAfterCommand } from '../lib/stock-allocation-job';

/* ERP -> AutoCount GRN edit. See queueAcDoEdit in delivery-orders-mfg.ts for
   the shape and why it never throws. AcSyncService.cs:445 is `case "GR"`. */
import { reconcileUncostedOuts, reconcileUncostedAfterIn } from '../lib/oversell-retrocost';
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
import { refuseWithoutWriting } from '../lib/no-write-refusal';
import { grnInheritedFieldChanges, grnInheritedLockedRefusal, grnHeaderInheritedChanges, grnHeaderInheritedRefusal, type GrnLinePrev, type GrnLinePatch } from '../lib/grn-inherited-lock';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  isCrossCompanySource, crossCompanyConversionBlocked, crossCompanySourceRefusal,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';

/* CROSS-COMPANY GUARD for the bare-create POST /, whose `purchaseOrderId` is an
   OPTIONAL body field on a path that also serves manual, PO-less receipts — so
   there is no single source read to scope. That path stamps the ACTIVE company
   on the new GRN and mints under the ACTIVE company's prefix, so receiving
   another company's PO would post the stock IN, and its cost, into the active
   company's inventory and books.

   Called inline via crossCompanySourceRefusal — the file-local wrapper this note
   used to sit on was one line of delegation and went 2026-08-18. Returns the
   refusal for the first offending PO, or null when every referenced PO is the
   active company's (unresolved degrades to allowed). The two declared converters
   (/from-pos, /from-po-items) no longer use it: they scope their source reads,
   so a cross-company PO is not visible to them at all. */
import { assertSourceLinesInCompany } from '../lib/ref-in-company';
import { parseLineNumbers, invalidLineNumberBody } from '../shared/line-numbers';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { todayMyt } from '../lib/my-time';
import { paginateAll } from '../lib/paginate-all';
import { escapeForOr } from '../lib/postgrest-search';
import { readStatusCounts } from '../lib/status-counts';
import { recordEntityAudit, assertAuditWritable, auditUnavailableBody, diffFields, compactChanges, fieldChange, statusChange } from '../lib/entity-audit';
import { GRN_LINE_AUDIT_FIELDS, GRN_LINE_AUDIT_SELECT } from '../lib/entity-audit-fields';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { eager } from '../lib/concurrency';
import { keyedVariantWithWarning, skuCategoryResolver, lineIdentityFields } from '../lib/sku-category';

export const grns = new Hono<{ Bindings: Env; Variables: Variables }>();
grns.use('*', supabaseAuth);

/* ── Audit trail (migration 0139 / lib/entity-audit) ───────────────────────────
   Action vocabulary for this module:
     CREATE — the receipt is raised. Recorded for BOTH the DRAFT and the
              straight-to-POSTED create; statusSnapshot is what distinguishes
              them, because "a draft existed first" is itself part of the story.
     POST   — DRAFT -> POSTED. The stock IN and the PO received-rollup commit.
     CANCEL — status -> CANCELLED plus the reversing OUT.
     UPDATE — header edits and the line add / edit / delete.
   No DELETE: this file never destroys a GRN header, and using DELETE for a line
   would tell a reader the whole receipt was destroyed (same rule the DO keeps).

   ── WHY EVERY CREATE ROW IS WRITTEN LATE ──
   Three of the create paths COMPENSATE: they insert the header, then delete it
   again when the line insert fails or when the post-insert over-receipt
   re-verification finds this GRN broke a PO line's cap. A CREATE row emitted at
   insert time would outlive the document it describes — a receipt in the ledger
   that never existed, against a PO whose numbers never moved. So each CREATE is
   recorded only after the LAST compensating branch has been passed, at the point
   where the only remaining exits are success. recordGrnCreate also re-reads the
   persisted row rather than echoing the request body, which makes that ordering
   self-enforcing: a rolled-back header reads back empty. */

/* The auditable GRN header fields, camel (API) -> snake (column). Deliberately
   the same list the header PATCH's own map writes. */
const GRN_AUDIT_FIELDS: Array<[string, string]> = [
  ['supplierId', 'supplier_id'], ['receivedAt', 'received_at'],
  ['deliveryNoteRef', 'delivery_note_ref'], ['warehouseId', 'warehouse_id'],
  ['notes', 'notes'], ['currency', 'currency'],
  ['exchangeRate', 'exchange_rate'], ['allocationMethod', 'allocation_method'],
];

/* The BEFORE half of the header PATCH's from->to pairs, plus the identity
   columns every audit row on this entity needs. */
const GRN_AUDIT_SELECT =
  `id, grn_number, status, company_id, ${GRN_AUDIT_FIELDS.map(([, snake]) => snake).join(', ')}`;

/* The auditable LINE fields + the select that reads them back live in
   lib/entity-audit-fields (imported above), not here: the camelCase half is what
   AUDIT_FINANCE_FIELDS gates on, and a route file cannot be imported into a test
   without dragging Hono and the auth middleware along. See that file's header. */

/* The GRN's identity for an audit row written from a LINE handler, which has the
   line in hand but not the parent. Best-effort by design: the writer is
   fail-open, so an unresolved doc number costs the row its human key and
   nothing else. */

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
async function recordGrnCreate(
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
  } catch { /* best-effort — fall through with what we know */ }
  if (!row) return; // rolled back (or unreadable): recording a CREATE would be a lie
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
      /* INTEGER SEN, straight off the column — never a formatted amount. */
      fieldChange('totalSen', null, row.total_sen ?? null),
      fieldChange('lineCount', null, lineCount),
    ]),
  });
}

/* THE RECEIVABLE-PO PREDICATE MOVED to lib/source-document-gates.ts (mig 0324), where it learned to read the hold MARKER. */

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

/* ── Migration 0120 — resolve the production batch (source PO number) for each
   GRN line, keyed by purchase_order_item_id. A GRN can aggregate lines from
   several POs (the add-PO picker), so we resolve PER LINE, not off the GRN
   header. Lines with no PO link (free GRN) get no batch. The IN movement carries
   batch_no → the FIFO trigger stamps it on the lot, so a sofa set's components
   share a batch and Stage 3 can ship the whole set from one dye lot. */
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

/* ── Resolve a GRN's currency + exchange_rate on CREATE (migration 0082) ──────
   The GRN inherits its currency from the source PO (the receiver knows whether
   it's an RMB/USD receipt); an explicit body.currency wins; else MYR. The rate
   auto-fills from the currency MASTER (rate_to_myr) unless the body sends one.
   normalizeExchangeRate forces MYR → 1 and a foreign rate → finite > 0 (else 1),
   so an all-MYR GRN is exchange_rate 1 (a strict no-op). */
async function resolveGrnFx(
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
  // CBM basis needs each goods line's product volume (unit_m3_milli). Resolve
  // per item_code in one round trip; default 0 (the allocator falls back to
  // QTY when the CBM Σ is 0, so a missing volume never divides by zero).
  const m3ByCode = new Map<string, number>();
  const codes = [...new Set(items.map((it) => it.item_code).filter(Boolean))];
  if (codes.length > 0) {
    // Company-scoped: `code` is shared, and the other company's volume would
    // shift every goods line's share of the landed charge.
    let volQ = sb.from('mfg_products').select('code, unit_m3_milli').in('code', codes);
    if (companyId != null) volQ = volQ.eq('company_id', companyId);
    const { data: prods } = await volQ;
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
      // Pool by the SERVICE line's line total; allocate ONTO goods unit price.
      amountSen: Number(it.line_total_sen ?? 0),
      unitPriceSen: Number(it.unit_price_sen ?? 0),
      unitM3Milli: m3ByCode.get(it.item_code) ?? 0,
    })),
    method,
    grnRate,
  );
  // Persist allocated_charge_sen per goods line. ALWAYS write the computed
  // value (incl. resetting to 0) so a removed charge / re-split method change is
  // reflected — but only when there's something to reconcile (a non-zero pool
  // now, OR any line currently carries a non-zero allocation).
  const anyToReset = items.some((it) => Number((it as { allocated_charge_sen?: number | null }).allocated_charge_sen ?? 0) !== 0);
  if (alloc.chargePoolMyr > 0 || anyToReset) {
    await Promise.all(alloc.goods.map((g) =>
      sb.from('grn_items').update({ allocated_charge_sen: g.allocatedChargeSen }).eq('id', g.id),
    ));
  }
  return alloc;
}

/* Recompute + persist a GRN's landed allocation from its CURRENT lines + header
   (used after the allocation_method / rate is changed on PATCH, before recost).
   Reads everything off the DB so it's self-contained. Best-effort. */
async function reallocateGrnCharges(sb: any, grnId: string, companyId: number | null): Promise<void> {
  const { data: head } = await sb.from('grns')
    .select('exchange_rate, allocation_method').eq('id', grnId).maybeSingle();
  const grnRate = (head as { exchange_rate?: string | number | null } | null)?.exchange_rate ?? 1;
  const method = normalizeAllocationMethod((head as { allocation_method?: string | null } | null)?.allocation_method);
  const { data: items } = await sb.from('grn_items')
    .select('id, qty_accepted, item_code, unit_price_sen, line_total_sen, item_group, allocated_charge_sen')
    .eq('grn_id', grnId);
  await computeAndStoreGrnAllocation(sb, (items ?? []) as AllocItemRow[], grnRate, method, companyId);
}

/* ── Zero-cost receipt gate, adapted to this file's row shape ───────────────
   Resolves each line to the MYR cost the movement would actually carry, then
   asks the guard whether any of them would open a zero-cost stock layer.

   The cost fed in is the BASE landed figure — toMyrSen(unit_price_sen, rate)
   — not the freight-allocated one, because the allocation is computed and
   PERSISTED further down inside postGrnAndRollup and running it before a
   possible refusal would leave a write behind a rejected receipt. That only
   matters when a GRN carries a service (freight) line whose pool could lift a
   zero-priced goods line off zero, so a GRN with a non-zero charge pool is
   skipped rather than risk refusing a receipt that was in fact costed. */
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

/* ── Shared helper: post a GRN, roll up to PO items, write inventory IN ──
   Pulled out of the PATCH /:id/post handler so both single-doc post and
   the multi-PO `/from-po-items` route can reuse the same logic.
   Best-effort inventory write (matches existing /post behaviour). */
/* companyId is REQUIRED, not optional, and it is not defaulted. This function is
   the single chokepoint that writes inventory IN and rolls PO received_qty, so
   an omitted scope here would let one company's confirm commit stock against
   another's GRN. Callers get it from requireActiveCompanyId and refuse first. */
async function postGrnAndRollup(sb: any, grnId: string, userId: string, companyId: number): Promise<{ ok: true; movementErrors?: string[]; recountError?: string } | { ok: false; reason: string; status?: number; zeroCost?: ZeroCostRefusal }> {
  const { data: grnHeader } = await scopeToCompanyId(sb.from('grns')
    .select('grn_number, warehouse_id, company_id, exchange_rate, allocation_method, received_at')
    .eq('id', grnId), companyId).maybeSingle();
  const { data: items } = await sb.from('grn_items')
    .select('id, purchase_order_item_id, qty_accepted, item_code, material_name, unit_price_sen, line_total_sen, item_group, variants, zero_cost_ack')
    .eq('grn_id', grnId);

  /* ZERO-COST GATE — the last honest moment. Runs BEFORE the CAS flip so a
     refusal writes nothing at all: the GRN stays exactly as it was and the
     caller gets a 409. A zero unit price is legitimate on a Houzs PO (suppliers
     price the goods-received document, not the order), but a zero that reaches
     the FIFO trigger's IN branch becomes a zero-cost lot, then RM0 COGS, then a
     100% margin — and by then the unit has shipped and the COGS must never be
     rewritten. See zero-cost-receipt-guard.ts for why the discriminator is the
     SKU's own purchase history rather than a flag. */
  const zeroCost = await checkGrnZeroCost(sb, (items ?? []) as GrnCostGateRow[], grnHeader);
  if (zeroCost) {
    return { ok: false, reason: ZERO_COST_RECEIPT_ERROR, status: 409, zeroCost };
  }

  // Flip to POSTED FIRST, THEN recount. recomputePoReceived excludes DRAFT lines
  // from a PO line's received_qty, so the confirm transition (which calls this
  // while the row is still DRAFT) MUST flip the row to POSTED before recounting —
  // otherwise this GRN's own just-confirmed lines wouldn't count. Idempotent on
  // the legacy already-POSTED path (no status change there).
  //
  /* GUARD 1 — the flip is an atomic compare-and-swap on the status this call
     actually observed, not `.neq('status','CLOSED')`. The old predicate matched
     ANY non-CLOSED row, so two concurrent confirms of one DRAFT GRN both flipped
     successfully and both went on to write the stock IN — doubling on-hand qty
     AND landed value, with no DB unique index behind it to reject the second
     write (unlike DO/DR, which have one). CAS-ing on the observed value means
     only the call that actually performs the transition proceeds; the loser
     matches no row and is refused. Same pattern stock-take already uses
     (stock-takes.ts, `.eq('status','OPEN')` on its POST flip).

     The expected value is READ rather than hard-coded to 'DRAFT' because the
     create-as-posted paths insert the row with status 'POSTED' and then call
     this chokepoint — hard-coding DRAFT would refuse every non-draft create. */
  const { data: preRow } = await scopeToCompanyId(
    sb.from('grns').select('status').eq('id', grnId), companyId,
  ).maybeSingle();
  /* CAS on the RAW stored value, compare on an upper-cased copy. Feeding the
     normalised string back into .eq() would never match a row whose status is
     not already upper-case, turning every post into a spurious 409. */
  const preStatus = (preRow as { status?: string | null } | null)?.status ?? null;
  if (preStatus == null) return { ok: false, reason: 'not_found', status: 404 };
  const preStatusNorm = preStatus.toUpperCase();
  /* A CANCELLED GRN already had its receipt reversed by an OUT; re-posting it
     would book the stock a second time against that reversal. CLOSED was already
     excluded by the old predicate. */
  if (preStatusNorm === 'CANCELLED' || preStatusNorm === 'CLOSED') {
    return { ok: false, reason: `grn_${preStatusNorm.toLowerCase()}`, status: 409 };
  }
  const { data, error } = await scopeToCompanyId(sb.from('grns').update({
    status: 'POSTED',
    posted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', grnId), companyId).eq('status', preStatus).select('id, status, posted_at').maybeSingle();
  if (error) return { ok: false, reason: error.message, status: 500 };
  // Lost the race: another confirm advanced the row between the read and the
  // flip. That call owns the stock write; this one must not duplicate it.
  if (!data) return { ok: false, reason: 'already_posting', status: 409 };

  // Recount received_qty + re-evaluate PO status from live GRN lines (now that
  // this GRN is POSTED, its lines count).
  const touchedPoItemIds = (items ?? [])
    .map((it: { purchase_order_item_id: string | null }) => it.purchase_order_item_id);
  const recount = await recomputePoReceived(sb, touchedPoItemIds);
  /* THE GAP THIS CLOSES (2026-07-31). Everything above already committed: the
     GRN is POSTED and the stock IN follows below. If the recount did not run,
     its POs now under-report what was received — they keep offering the same
     lines to the convert-to-GRN picker and keep counting as outstanding money —
     and until today the ONLY trace was a console.error in a log with no
     retention. That is how eleven receipts (2990-GRN-2607-011..-021) rotted for
     nine days unnoticed.

     Two durable traces now, neither of which can roll back the receipt:
       • a row on the GRN's own audit trail, where anyone investigating THIS
         document already looks;
       • recountError on the response, alongside movementErrors, which is this
         file's existing convention for "the post succeeded, a best-effort step
         after it did not".
     Detection still does not depend on either: diag-po-receipt-drift compares
     received_qty against live GRN lines on a schedule and fails loudly, which
     catches drift from causes nobody predicted — including whatever caused
     this one, which remains unidentified. */
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
    } catch { /* the trail is the backstop, not another way to lose the receipt */ }
  }

  // ── Inventory IN per item — best effort, doesn't roll back the post. ─
  const movementErrors: string[] = [];
  const grnNo = (grnHeader as { grn_number: string } | null)?.grn_number ?? grnId;
  let warehouseId = (grnHeader as { warehouse_id: string | null } | null)?.warehouse_id
    /* Per-company default (2026-08-03) — this used to be a company-blind draw
       across every company's is_default warehouses, decided by alphabetical
       `code` order, so Houzs receipts could land in 2990's Guangzhou warehouse. */
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
  const linkedPoItemIds = (items ?? [])
    .map((it: { purchase_order_item_id: string | null }) => it.purchase_order_item_id)
    .filter((x: string | null): x is string => !!x);
  if (linkedPoItemIds.length > 0) {
    const { data: poWhRows } = await sb.from('purchase_order_items')
      .select('warehouse_id').in('id', [...new Set(linkedPoItemIds)]);
    const poWhs = [...new Set(((poWhRows ?? []) as Array<{ warehouse_id: string | null }>)
      .map((r) => r.warehouse_id).filter((x): x is string => !!x))];
    if (poWhs.length === 1 && poWhs[0] !== warehouseId) {
      warehouseId = poWhs[0]!;
      await sb.from('grns').update({ warehouse_id: warehouseId, updated_at: new Date().toISOString() }).eq('id', grnId);
    }
  }
  /* Landed-cost core (migration 0082) — the GRN line unit_price_sen is in the
     GRN's OWN currency (RMB / USD / SGD / MYR, copied from the source PO). The
     FIFO lot must carry MYR, so convert the IN cost at the GRN's rate:
     unit_cost_sen = round(unit_price_sen × exchange_rate). For an MYR GRN the
     rate is 1 → toMyrSen is a byte-for-byte no-op (round(int×1) === int), so
     existing MYR lot costs / COGS / margins are unchanged. A later PI recost
     OVERWRITES this with the PI line price × the PI's own rate. */
  const grnRate = (grnHeader as { exchange_rate?: string | number | null } | null)?.exchange_rate ?? 1;
  /* Landed-cost allocation (migration 0082) — a SERVICE line (item_group='service'
     — freight, no supplier, just description + amount) is NOT goods: it creates
     NO inventory movement. Its amount is POOLED and allocated across the goods
     lines (QTY/VALUE/CBM, header allocation_method) so each goods line's FIFO lot
     cost = base MYR cost + its per-unit share of the freight, persisted as
     allocated_charge_sen. chargePool === 0 (no service lines) ⇒ allocation 0
     everywhere ⇒ byte-for-byte identical to the plain-goods path. */
  const method = normalizeAllocationMethod((grnHeader as { allocation_method?: string | null } | null)?.allocation_method);
  const itemRows = (items ?? []) as Array<{ id: string; purchase_order_item_id: string | null; qty_accepted: number; item_code: string; material_name: string | null; unit_price_sen: number | null; line_total_sen?: number | null; item_group?: string | null; variants?: VariantAttrs | null }>;
  const alloc = await computeAndStoreGrnAllocation(sb, itemRows, grnRate, method, companyId);
  const allocByItemId = new Map(alloc.goods.map((g) => [g.id, g]));
  if (warehouseId && items) {
    // Migration 0120 — stamp each IN with its source PO number as the batch.
    const batchByItem = await resolvePoBatchByItem(
      sb,
      itemRows.map((it) => it.purchase_order_item_id),
    );
    const movements = itemRows
      // SERVICE lines (freight) never enter inventory — skip them here. Their
      // amount has already been allocated INTO the goods lines' lot cost above.
      .filter((it) => !isServiceLine({ itemGroup: it.item_group ?? null, itemCode: it.item_code }))
      .filter((it) => it.qty_accepted > 0)
      .map((it) => ({
        movement_type: 'IN' as const,
        warehouse_id: warehouseId,
        item_code: it.item_code,
        variant_key: keyedVariantWithWarning(grnNo, it, computeVariantKey), // mig 0095; warns when the group ignores them
        product_name: it.material_name,
        qty: it.qty_accepted,
        // Landed MYR lot cost = base (rate→MYR) + per-unit allocated freight.
        // No service lines ⇒ === toMyrSen(unit_price, rate), so existing GRNs
        // are byte-for-byte unchanged.
        unit_cost_sen: allocByItemId.get(it.id)?.landedUnitCostMyr
          ?? toMyrSen(Number(it.unit_price_sen ?? 0), grnRate),
        /* The BUSINESS date (GL redesign item 4): a GRN keyed late must still
           count in the month the goods actually arrived — the received date
           the operator filled in, not the keying moment. */
        movement_date: (String((grnHeader as { received_at?: string | null } | null)?.received_at ?? '').slice(0, 10)) || undefined,
        source_doc_type: 'GRN' as const,
        source_doc_id: grnId,
        source_doc_no: grnNo,
        // Production batch = source PO number (migration 0120). NULL for free GRNs.
        batch_no: it.purchase_order_item_id ? (batchByItem.get(it.purchase_order_item_id) ?? null) : null,
        performed_by: userId,
      }));
    /* GUARD 2 — has this GRN already booked its receipt? Direct mirror of
       deductInventoryForDo's idempotency guard #1 (delivery-orders-mfg.ts). The
       CAS above closes the concurrent-confirm race for callers that go through
       the status flip; this defends EVERY caller of the chokepoint, including a
       re-entry on an already-POSTED row (where the CAS legitimately matches and
       changes nothing). Post-time is the only moment a GRN has zero IN rows —
       the line-add / line-edit delta INs are written later, on an already-POSTED
       GRN, so they cannot make this guard fire early. */
    let alreadyBooked = false;
    if (movements.length > 0) {
      const { count: existingIn } = await sb.from('inventory_movements')
        .select('id', { head: true, count: 'exact' })
        .eq('source_doc_type', 'GRN')
        .eq('source_doc_id', grnId)
        .eq('movement_type', 'IN');
      alreadyBooked = (existingIn ?? 0) > 0;
    }
    if (movements.length > 0 && !alreadyBooked) {
      /* Capture the best-effort write result so the caller can surface a failed
         stock IN (was silently swallowed — GRN flipped POSTED with stock NOT
         booked and the caller never told). No rollback; just make it loud. */
      const res = await writeMovements(sb, movements, grnHeader?.company_id ?? null);
      if (!res.ok) movementErrors.push(`IN ${grnNo}: ${res.reason ?? 'unknown'}`);
      /* Receipt cutoff for the retro-cost reconciles below: the moment the IN rows
         posted. Only OUTs that shipped BEFORE this are eligible to draw on the
         arriving lots — a later order consumes them through the normal FIFO trigger
         at its own ship time (coverage-theft guard, migration 0154). */
      const receiptCutoffTs = new Date().toISOString();
      /* Drop-ship receipt reconcile (mig 0057) — the IN just created fresh
         batched lots. If a sofa was drop-shipped against this batch before
         receipt, its OUT consumed no lot; consume that outstanding shortfall
         from the new lots now so coverage + valuation don't double-count the
         already-shipped units. Ledger-driven + idempotent; best-effort (never
         rolls back the post). Only batched (sofa) lines have drop-ship semantics. */
      const reconcile = await reconcileDropshipBatches(
        sb,
        movements.map((m) => ({
          warehouse_id: m.warehouse_id,
          item_code: m.item_code,
          variant_key: m.variant_key,
          batch_no: m.batch_no ?? null,
        })),
        userId,
      );
      /* COGS — the reconcile bumped each drop-ship DO OUT movement's cost from
         the arriving lot. Re-stamp those DO lines (+ their Sales Invoices) so
         margins reflect the real cost, exactly like a normal short-ship that
         later receives stock. Best-effort; restamp is idempotent + bucket-keyed. */
      if (reconcile.affectedDoIds.length > 0) {
        try {
          const { restampDoActualCost } = await import('./delivery-orders-mfg');
          const { restampSiFromDo } = await import('../lib/recost');
          for (const doId of reconcile.affectedDoIds) {
            await restampDoActualCost(sb, doId);
            try { await restampSiFromDo(sb, doId); } catch { /* best-effort */ }
          }
        } catch (e) { /* eslint-disable-next-line no-console */ console.error('[dropship] DO restamp failed:', e); }
      }
      /* Oversell retro-cost (migration 0154) — NORMAL (non-drop-ship) DO short-
         ships. When a DO oversold via the soft "ship anyway" path, its short units
         shipped UNBATCHED and UNCOSTED (fn_consume_fifo discarded the qty_short) and
         inventory_balances went negative. The arriving lots let us retro-cost that
         outstanding shortfall now (plain FIFO, real lot cost) so COGS catches up and
         the signed-balance vs lot-value views re-converge. Scoped to prior shipments
         only (receiptCutoffTs) + non-drop-ship + non-cancelled + idempotent; drop-
         ship shorts are owned by the batched reconcile above (0088). Best-effort. */
      const oversell = await reconcileUncostedOuts(
        sb,
        movements.map((m) => ({
          warehouse_id: m.warehouse_id,
          item_code: m.item_code,
          variant_key: m.variant_key,
        })),
        receiptCutoffTs,
        userId,
      );
      if (oversell.affectedDoIds.length > 0) {
        try {
          const { restampDoActualCost } = await import('./delivery-orders-mfg');
          const { restampSiFromDo } = await import('../lib/recost');
          for (const doId of oversell.affectedDoIds) {
            await restampDoActualCost(sb, doId);
            try { await restampSiFromDo(sb, doId); } catch { /* best-effort */ }
          }
        } catch (e) { /* eslint-disable-next-line no-console */ console.error('[oversell] DO restamp failed:', e); }
      }
    }
  }
  /* Physical rack placement — lines that chose a rack on the GRN form get
     placed onto that rack (separate ledger, migration 0151). Best-effort. */
  try {
    const { placeGrnLinesOnRacks } = await import('../lib/grn-rack-sync');
    await placeGrnLinesOnRacks(sb, grnId, grnNo, userId);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[grn-rack] place failed:', e); }
  /* B2C SO auto-allocation — stock just came in, re-walk every PENDING SO line
     and flip to READY where the new inventory covers it. Best-effort. */
  try {
    const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
    await recomputeSoStockAllocation(sb);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-grn failed:', e); }
  return {
    ok: true,
    movementErrors: movementErrors.length ? movementErrors : undefined,
    recountError: recount.ok ? undefined : (recount.reason ?? 'unknown'),
  };
}

const HEADER =
  'id, grn_number, purchase_order_id, supplier_id, warehouse_id, received_at, delivery_note_ref, status, notes, ' +
  /* Migration 0101 — GRN ↔ PO money parity; 0082 — exchange_rate (FX→MYR cost) +
     allocation_method (landed-cost "平摊" basis). */
  'currency, exchange_rate, allocation_method, subtotal_sen, tax_sen, total_sen, ' +
  'posted_at, created_at, created_by, updated_at, ' + HOLD_COLUMNS; // mig 0324's marker, BESIDE the status pill
const ITEM =
  'id, grn_id, purchase_order_item_id, material_kind, item_code, material_name, supplier_sku, ' +
  'qty_received, qty_accepted, qty_rejected, rejection_reason, unit_price_sen, notes, ' +
  /* PR #42 — variant fields (migration 0057) */
  'item_group, description, description2, uom, discount_sen, variants, ' +
  'gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, ' +
  'custom_specials, line_suffix, special_order_price_sen, ' +
  /* Migration 0101 — line money + per-line date + cost snapshot */
  'line_total_sen, delivery_date, unit_cost_sen, ' +
  /* Migration 0106 — GRN line consumption (downstream PI/PR draw) */
  'invoiced_qty, returned_qty, created_at, ' +
  /* Migration 0082 — landed freight allocated to this goods line (MYR sen) */
  'allocated_charge_sen, ' +
  /* Migration 0151 — physical rack placement */
  'rack_id, ' +
  /* migration 0280 — the zero-cost acknowledgement, read back so the receipt
     screen can show WHICH line was waived and by whom, rather than the waiver
     being invisible everywhere except the gate that honours it. */
  'zero_cost_ack, zero_cost_reason, zero_cost_ack_by, zero_cost_ack_at';

const nextNumber = async (sb: ReturnType<Variables['supabase']['valueOf']> extends never ? never : any, prefix: string, table: string, col: string, c: any): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, table, col, `${p}${prefix}-${yymm}`);
};

/* ── Recompute GRN header money rollups (migration 0101) ──────────────────
   Mirrors recomputePoTotals (apps/api/src/routes/mfg-purchase-orders.ts):
   sum line_total_sen across grn_items → write subtotal_sen + total_sen
   on the grns header. GRN carries no tax, so total = subtotal.

   Fails CLOSED and never throws (2026-07-17) — same contract as the SO's
   recomputeTotals (mfg-sales-orders.ts), which carries the full rationale.
   See BUG-HISTORY 2026-07-17 (fix/zeroing-twins). */
async function recomputeGrnTotals(sb: any, grnId: string) {
  const { data: items, error: itemsErr } = await sb.from('grn_items')
    .select('line_total_sen')
    .eq('grn_id', grnId);
  /* A failed READ is not an empty GRN, and `?? []` cannot tell them apart — it
     folded a transient blip into subtotal_sen / total_sen ZERO on a receipt
     whose lines were intact. The ERROR is the signal, never the emptiness: a
     genuinely empty GRN resolves error === null with data === [] and MUST still
     fall through to zero the header. */
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

/* ── Post-insert over-receipt verification for BULK GRN creates ────────────
   The bulk create paths (POST /, /from-pos, /from-po-items) only PRE-check
   remaining qty before insert — a read-then-write race lets two concurrent
   receives both pass and over-receive a PO line. This mirrors the add-line
   path's POST-insert guard: after the GRN's lines are committed, re-sum the
   LIVE qty_accepted across all non-cancelled GRN lines per affected PO line; if
   any now exceeds the PO line's qty, THIS GRN broke the cap → delete the whole
   GRN it just created and signal a 409. Best-effort consistent with the rest of
   the file. Returns the over-receipt detail (same shape as the add-line 409) or
   null when every affected PO line is within cap. */
async function verifyGrnOverReceipt(
  sb: any,
  grnId: string,
  poItemIds: Array<string | null | undefined>,
): Promise<{ poItemId: string; requested: number; remaining: number } | null> {
  const ids = [...new Set(poItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return null;
  try {
    // PO line caps.
    const { data: poItems } = await sb.from('purchase_order_items')
      .select('id, qty').in('id', ids);
    const capById = new Map<string, number>(
      ((poItems ?? []) as Array<{ id: string; qty: number }>).map((r) => [r.id, r.qty ?? 0]),
    );
    // Live accepted per PO line across all non-cancelled GRN lines.
    const { data: sib } = await sb.from('grn_items')
      .select('purchase_order_item_id, qty_accepted, returned_qty, grn_id')
      .in('purchase_order_item_id', ids);
    const sibRows = (sib ?? []) as Array<{ purchase_order_item_id: string; qty_accepted: number; returned_qty: number; grn_id: string }>;
    const grnIds = [...new Set(sibRows.map((r) => r.grn_id).filter(Boolean))];
    const cancelled = new Set<string>();
    if (grnIds.length > 0) {
      const { data: gs } = await sb.from('grns').select('id, status').in('id', grnIds);
      for (const g of (gs ?? []) as Array<{ id: string; status: string }>) {
        // DRAFT GRNs have committed no receipt, so (like CANCELLED) their SIBLING
        // lines don't count toward a PO line's live-accepted cap — two drafts can
        // coexist on one PO line, and a draft sibling never falsely 409s a real
        // receive. EXCEPTION: the GRN under scrutiny (grnId) always counts its own
        // lines, so the confirm transition (which runs this while the row is still
        // DRAFT) still catches a draft that would over-receive on confirm.
        if (g.id === grnId) continue;
        if (g.status === 'CANCELLED' || g.status === 'DRAFT') cancelled.add(g.id);
      }
    }
    // This GRN's own contribution per PO line — what we'd give back on rollback.
    const liveByPoi = new Map<string, number>();
    const thisGrnByPoi = new Map<string, number>();
    for (const r of sibRows) {
      if (cancelled.has(r.grn_id)) continue;
      // Audit (ported from 2990 073cc6d0) — net of returns (qty_accepted −
      // returned_qty), matching recomputePoReceived, so a legitimate replacement
      // GRN after a purchase return isn't falsely rejected by a gross-qty
      // over-receipt cap.
      const q = Math.max(0, Number(r.qty_accepted ?? 0) - Number(r.returned_qty ?? 0));
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
    // Best-effort: a thrown verification failure must not block the receipt.
    /* ⚠️ AND THE THREE READS ABOVE DROP THEIR `error` — a PostgREST failure is
       RETURNED, not thrown, so it never reaches this catch. It folds to
       `?? []`, the cap check finds nothing over, and an over-received line
       stays committed. That is the 2026-08-13 swallowed-error class ("a guard
       that says all clear because it could not look", BUG-HISTORY.md), left
       here DELIBERATELY: reading those errors means 409-ing legitimate
       receipts on a transient blip, which reverses the best-effort policy this
       comment states, and that is the owner's call. The sweep fixed the guards
       whose fail-closed answer costs nothing; this one is listed, not churned.
       Same note applies to the add-line verifier below and to the over-invoice
       / over-return twins in purchase-invoices.ts, purchase-returns.ts and the
       purchase-consignment routes. */
    return null;
  }
}

/** Outcome of a recount. Mirrors AuditWriteResult in scm/lib/entity-audit.ts —
 *  same shape for the same reason: a post-commit writer that must not throw, but
 *  must not pretend it succeeded either. `reason` is for logs and the audit
 *  trail, never for an operator. */
export type RecountResult = { ok: boolean; reason?: string };

/* ── Self-heal PO receipt counter (live-count model, mirrors recomputeSoPicked
   in mfg-purchase-orders.ts) ────────────────────────────────────────────────
   For each given purchase_order_item, RECOUNT received_qty from scratch as the
   sum of qty_accepted across ALL live (non-cancelled) GRN lines that point at
   it, then re-evaluate the parent PO's status. This replaces the old scattered
   +/- arithmetic so receive / edit / delete / cancel all converge to the truth
   and the PO line auto-releases the moment its receipts go away. Never
   resurrects a CANCELLED PO. Non-throwing — see the ruling below. */
export async function recomputePoReceived(
  sb: any,
  poItemIds: Array<string | null | undefined>,
): Promise<RecountResult> {
  const ids = [...new Set(poItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return { ok: true };

  // Still never throws (Commander 2026-05-30): the primary write already
  // committed, and a GRN that received stock must not un-receive it because the
  // recount hiccupped — rolling back a write the operator watched succeed is the
  // same bug pointing the other way. That is the identical ruling entity-audit.ts
  // records for its own post-commit writer.
  //
  // What changed 2026-07-31 is that it no longer swallows the OUTCOME. The old
  // comment here claimed "the live-count model self-heals on the next operation
  // that touches these PO lines" — true only if another operation ever comes.
  // For 2990-PO-2606-005/008/013/015/016/017/024 and 2607-002/005/006/007 none
  // did: eleven POs sat with their goods in the warehouse and received_qty
  // untouched from 2026-07-14 until someone opened one on 07-31, because the
  // only record of the failure was a console.error in an ephemeral Worker log.
  // Callers now get the failure back — postGrnAndRollup writes it to the GRN's
  // own audit trail and returns it in the response — so "self-heals" became a
  // claim somebody can check instead of a hope.
  try {
    // 1. Recount received_qty per PO item from live GRN lines. Net out goods
    //    sent back to the supplier (returned_qty, migration 0106): a returned
    //    qty no longer counts as received, so the PO line re-opens and a
    //    replacement shipment can be received against it. Clamped ≥ 0.
    const { data: glines } = await sb.from('grn_items')
      .select('purchase_order_item_id, qty_accepted, returned_qty, grn_id')
      .in('purchase_order_item_id', ids);
    const rows = (glines ?? []) as Array<{ purchase_order_item_id: string; qty_accepted: number; returned_qty: number; grn_id: string }>;
    const grnIds = [...new Set(rows.map((r) => r.grn_id).filter(Boolean))];
    const cancelled = new Set<string>();
    if (grnIds.length > 0) {
      const { data: gs } = await sb.from('grns').select('id, status').in('id', grnIds);
      for (const g of (gs ?? []) as Array<{ id: string; status: string }>) {
        // DRAFT GRNs have committed no receipt, so their lines must NOT count
        // toward a PO line's received_qty (same treatment as CANCELLED). The
        // confirm transition flips DRAFT → POSTED first, then runs the recount,
        // so a confirmed GRN's lines DO count.
        if (g.status === 'CANCELLED' || g.status === 'DRAFT') cancelled.add(g.id);
      }
    }
    const recvByPoi = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const r of rows) {
      if (cancelled.has(r.grn_id)) continue;
      const net = Number(r.qty_accepted ?? 0) - Number(r.returned_qty ?? 0);
      recvByPoi.set(r.purchase_order_item_id, (recvByPoi.get(r.purchase_order_item_id) ?? 0) + Math.max(0, net));
    }
    /* CHECK THE WRITES. supabase-js RESOLVES on a rejected write rather than
       throwing, so a row refused by a constraint never reaches the catch below:
       discarding `{ data, error }` here made this function return { ok: true }
       and report `recountError: undefined` on a recount that did not happen. */
    const itemWrites = await Promise.all([...recvByPoi.entries()].map(([poiId, recv]) =>
      sb.from('purchase_order_items').update({ received_qty: recv }).eq('id', poiId),
    ));
    const itemErr = itemWrites.find((r: { error?: { message?: string } | null }) => r?.error);
    if (itemErr) {
      return { ok: false, reason: `received_qty write failed: ${itemErr.error?.message ?? 'unknown'}` };
    }

    // 2. Re-evaluate each touched PO's status from its (now-recounted) lines.
    const { data: poiRows } = await sb.from('purchase_order_items')
      .select('purchase_order_id').in('id', ids);
    const poIds = [...new Set(((poiRows ?? []) as Array<{ purchase_order_id: string }>)
      .map((r) => r.purchase_order_id).filter(Boolean))];
    for (const poId of poIds) {
      const { data: lines } = await sb.from('purchase_order_items')
        .select('qty, received_qty').eq('purchase_order_id', poId);
      const ll = (lines ?? []) as Array<{ qty: number; received_qty: number }>;
      if (ll.length === 0) continue;
      const anyReceived = ll.some((l) => (l.received_qty ?? 0) > 0);
      const fully = ll.every((l) => (l.received_qty ?? 0) >= l.qty);
      const newStatus = fully ? 'RECEIVED' : anyReceived ? 'PARTIALLY_RECEIVED' : 'SUBMITTED';
      const { data: head } = await sb.from('purchase_orders')
        .select('received_at').eq('id', poId).maybeSingle();
      const prevReceivedAt = (head as { received_at: string | null } | null)?.received_at ?? null;
      const patch: Record<string, unknown> = { status: newStatus, updated_at: new Date().toISOString() };
      // Stamp received_at on first full receipt, preserve it if already set, clear on regression.
      patch.received_at = fully ? (prevReceivedAt ?? new Date().toISOString()) : null;
      // Checked for the same reason as the received_qty writes above: unchecked,
      // the PO stays RECEIVED (or SUBMITTED) under a clean-looking recount.
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
    /* Say plainly that the receipt already committed — the old line ("best-effort
       recount failed") read as a shrug, and opaque poItemIds gave an investigator
       nothing to search prod for. */
    const reason = e instanceof Error ? e.message : String(e);
    console.error(
      '[po-recount-failed] the GRN receipt is already committed but its PO roll-up did NOT run; ' +
        'these PO lines now UNDER-REPORT what was received until something recounts them',
      { poItemIds: ids, reason },
    );
    return { ok: false, reason };
  }
}

/* ── GRN child-lock guard (migration 0106) ─────────────────────────────────
   A GRN locks (read-only — no line edit / no cancel) once ANY of its lines has
   a downstream child: invoiced_qty > 0 OR returned_qty > 0 (a PI or PR line is
   drawn from it).

   The rule now lives in scm/lib/downstream-lock.ts with its three siblings
   (SO / PO / DO), which had drifted into four private copies in four route
   files. Same signature, same JSON, same behaviour — see that module for why
   it is also the ERP half of AutoCount's transferred-document rule. */

/* ── Downstream-consumption guard (bug #2) ─────────────────────────────────
   Reversing a GRN receipt (whole-cancel or line-delete) writes an inventory OUT
   per line. The FIFO trigger (migration 0053) ALLOWS negative stock, so if the
   received goods were ALREADY consumed downstream (shipped on a DO / drawn into
   production), that reversing OUT eats some OTHER lot's FIFO batch → negative
   stock + wrong COGS. grnHasDownstream only catches PI/PR draws, NOT physical
   consumption.

   This guard checks, per (warehouse, product, variant) bucket, whether the
   CURRENT on-hand (inventory_balances) still covers the qty we're about to
   reverse out. If on-hand < what we'd reverse, the received stock is (at least
   partly) already gone downstream — BLOCK the cancel/delete.

   `lines` carry each reversing line's accepted qty + variant; warehouseId is the
   GRN's receive-into warehouse (same one the OUT would target). Returns the
   blocking JSON, or null when every bucket still has enough on-hand to reverse
   safely. Best-effort read: if the balance query errors we DON'T block (the
   primary lock semantics in grnHasDownstream still apply). */
async function grnReverseWouldGoNegative(
  sb: any,
  warehouseId: string | null,
  lines: Array<{ qty_accepted: number; item_code: string; item_group?: string | null; variants?: VariantAttrs | null }>,
): Promise<{ error: string; message: string } | null> {
  if (!warehouseId) return null;
  // Sum the qty we'd reverse OUT per (item_code, variant_key) bucket.
  const needByBucket = new Map<string, { item_code: string; variant_key: string; need: number }>();
  for (const l of lines) {
    /* SERVICE lines never entered inventory, so they cannot be reversed out of
       it. The POST path skips them and this guard did not, which made a
       landed-cost GRN impossible to cancel: a freight line produces no IN, so
       onHand 0 < need 1 and the cancel returned 409 grn_consumed_downstream,
       naming a cause that does not exist. It also blocked the warehouse relocate
       and the line's own deletion. Counting it as stock is a live hazard too:
       the movement build below would write an OUT for a non-stock SKU. */
    if (isServiceLine({ itemGroup: l.item_group ?? null, itemCode: l.item_code })) continue;
    const qty = Number(l.qty_accepted ?? 0);
    if (qty <= 0) continue;
    const variant_key = computeVariantKey(l.item_group, l.variants ?? null);
    const k = `${l.item_code}::${variant_key}`;
    const cur = needByBucket.get(k) ?? { item_code: l.item_code, variant_key, need: 0 };
    cur.need += qty;
    needByBucket.set(k, cur);
  }
  if (needByBucket.size === 0) return null;

  const itemCodes = [...new Set([...needByBucket.values()].map((b) => b.item_code))];
  const { data: balRows, error } = await sb
    .from('inventory_balances')
    .select('item_code, variant_key, qty')
    .eq('warehouse_id', warehouseId)
    .in('item_code', itemCodes);
  if (error) return null; // best-effort: don't block on a balance read failure
  const onHand = new Map<string, number>();
  for (const r of (balRows ?? []) as Array<{ item_code: string; variant_key: string | null; qty: number }>) {
    onHand.set(`${r.item_code}::${r.variant_key ?? ''}`, Number(r.qty ?? 0));
  }
  for (const [k, b] of needByBucket) {
    const have = onHand.get(k) ?? 0;
    if (have < b.need) {
      return {
        error: 'grn_consumed_downstream',
        message: 'Received goods were already consumed downstream (shipped / used in production) — cannot reverse this GRN. Make a Purchase Return instead.',
      };
    }
  }
  return null;
}

/* Filter-pill bucket → the raw grns.status values it covers. Single source of truth for BOTH the status-count queries and
   the list `status` filter; the FE sends the BUCKET NAME (a raw DB status still works). EVERY VALUE IS AN ENUM MEMBER AND
   EVERY MEMBER IS IN A BUCKET — pinned by tests/statusBucketsEnumMembership.test.mjs. CLOSED joined `posted` on 2026-08-17
   out of NO bucket (it counted in `all`, showed in no tab). SAY IT PLAINLY: unlike the SI and DO maps, nothing here was ever a NON-member, so no GRN tab 500d and no GRN count was wrong — this half is a COVERAGE JUDGMENT and it MOVES A NUMBER an operator reads as fact. The Posted pill rises by the number of CLOSED GRNs and ?status=posted returns rows it never returned before. `posted` rather than a fourth `closed` pill because a CLOSED GRN's stock IN stands where a CANCELLED one's receipt was reversed, and it is the bucket GoodsReceivedListV2's statusFor() already fell back to — so the tab and the row chip stop disagreeing. If the owner wants CLOSED separated, the change is a `closed` entry here plus a StatusTab arm; nothing else depends on the pairing. */

grns.get('/', async (c) => {
  const sb = c.get('supabase');
  // .limit(500) bounds the result so PostgREST's default 1000-row cap can't
  // silently truncate the GRN list — match the SO/DO/SI list convention.
  // warehouse embeds the receiving location's NAME (Owner 2026-07-02 — the GRN
  // list "Purchase Location" column); warehouse_id is already in HEADER.
  /* Opt-in server-side pagination + search + sort + status-counts (mirrors the
     SO list in mfg-sales-orders.ts). The PRESENCE of `page` switches paging on;
     when it is absent/empty the query below is BYTE-IDENTICAL to the historical
     behavior (order received_at desc, limit 500, status + supplierId params,
     `{ grns }` shape). */
  const pageRaw = c.req.query('page');
  const paginate = pageRaw !== undefined && pageRaw !== '';

  let data: unknown = null;
  let error: { message: string } | null = null;
  let total = 0;
  let page = 0;
  let pageSize = 50;
  let statusCounts: { all: number; draft: number; posted: number; cancelled: number } | undefined;
  let countError: string | null = null; // held, not returned here, so the LIST read's own error still wins the report

  if (!paginate) {
    /* --- LEGACY PATH (unchanged) --- */
    let q = sb.from('grns').select(`${HEADER}, supplier:suppliers(id, code, name, contact_person, phone, email, address), purchase_order:purchase_orders(id, po_number), warehouse:warehouses!warehouse_id(id, code, name)`).order('received_at', { ascending: false }).limit(500);
    const status = c.req.query('status'); if (status) q = q.eq('status', status);
    const supplierId = c.req.query('supplierId'); if (supplierId) q = q.eq('supplier_id', supplierId);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    const res = await q;
    data = res.data;
    error = res.error;
  } else {
    /* --- PAGINATED PATH (opt-in via `page`) --- */
    page = Math.max(0, Math.trunc(Number(pageRaw)) || 0);
    const psRaw = Number(c.req.query('pageSize'));
    pageSize = Number.isFinite(psRaw) && psRaw > 0 ? Math.min(100, Math.max(1, Math.trunc(psRaw))) : 50;

    const SORT_COLS = new Set(['received_at', 'grn_number', 'status', 'total_sen']);
    const [rawCol, rawDir] = (c.req.query('sort') ?? 'received_at:desc').split(':');
    const sortCol = SORT_COLS.has(rawCol) ? rawCol : 'received_at';
    const sortAsc = rawDir === 'asc';

    let q = sb.from('grns').select(`${HEADER}, supplier:suppliers(id, code, name, contact_person, phone, email, address), purchase_order:purchase_orders(id, po_number), warehouse:warehouses!warehouse_id(id, code, name)`, { count: 'exact' }).order(sortCol, { ascending: sortAsc });
    /* unique tiebreaker so range paging can't skip/repeat rows sharing the sort key */
    if (sortCol !== 'grn_number') q = q.order('grn_number', { ascending: sortAsc });
    /* Resolve the incoming `status`: a known bucket key → all its raw statuses;
       'all'/empty → no filter; otherwise treat it as a raw DB status. */
    const status = c.req.query('status');
    /* The `on_hold` tab reads the MARKER (mig 0324), not the status. */
    if (status && status !== 'all') {
      if (status === 'on_hold') q = q.or(HELD_OR_TERM);
      else if (GRN_STATUS_BUCKETS[status]) q = q.in('status', GRN_STATUS_BUCKETS[status]);
      else q = q.eq('status', status);
    }
    const supplierId = c.req.query('supplierId'); if (supplierId) q = q.eq('supplier_id', supplierId);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    /* free-text search over the base-table text columns the FE searches
       (GoodsReceivedListV2 hay). Supplier name / PO number are embedded resources,
       not base grns columns, so they can't be ilike'd here. */
    const search = c.req.query('q');
    if (search) {
      const s = escapeForOr(search);
      if (s) q = q.or(`grn_number.ilike.%${s}%,delivery_note_ref.ilike.%${s}%,notes.ilike.%${s}%`);
    }
    const from = c.req.query('from'); if (from) q = q.gte('received_at', from);
    const to = c.req.query('to'); if (to) q = q.lte('received_at', to);
    q = q.range(page * pageSize, page * pageSize + pageSize - 1);

    /* Status counts mirror the FE filter-pill buckets (draft / posted /
       cancelled) over the SAME company + supplier filters but WITHOUT status /
       search / pagination. */
    const countBase = () => {
      let cq = sb.from('grns').select('*', { count: 'exact', head: true });
      cq = scopeToCompany(cq, c);
      if (supplierId) cq = cq.eq('supplier_id', supplierId);
      return cq;
    };
    /* PERF: issued here, awaited below; semantics and error order unchanged. */
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
    // A count that could not be READ is reported, never served as 0; an empty bucket still answers 0 (lib/status-counts.ts).
    const counted = readStatusCounts({ all: allC, draft: draftC, posted: postedC, cancelled: cancelledC, on_hold: onHoldC });
    if (counted.ok) statusCounts = counted.counts; else countError = counted.reason;
  }
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (countError) return c.json({ error: 'status_counts_failed', reason: countError }, 500);

  // Commander 2026-05-29 — the GRN list grid needs a money column (AutoCount's
  // GRN list shows Sub-Total / Total). The Total is the STORED header total_sen
  // (recomputeGrnTotals = Σ line_total_sen = Σ qty*unit − discount), already
  // selected by HEADER. The old per-line qty_accepted*unit_price sum here ignored
  // discount_sen, so the list Total drifted from the detail Total — use the
  // header value instead. We still fetch the lines (ONE round trip) to derive the
  // convert-eligibility / lock flags (has_children / fully_invoiced /
  // fully_returned).
  const rows = (data ?? []) as Array<{ id: string } & Record<string, unknown>>;
  const ids = rows.map((g) => g.id);
  // Migration 0106 — collect each GRN's lines for the lock/convert flags.
  const linesByGrn = new Map<string, Array<{ qty_accepted: number | null; invoiced_qty: number | null; returned_qty: number | null }>>();
  // Owner 2026-07-02 — "Transfer To" list column: map each grn_item → its GRN so
  // the per-line downstream (PI/PR) can be rolled up to a per-GRN doc-number set.
  const grnByItem = new Map<string, string>();
  /* The per-GRN line-code roll-up (Assigned-SO / Delivered) moved to the deferred
     enrichment endpoint (grns-list-enrichment.ts), which rebuilds codesByGrn
     itself — so this read no longer fetches item_code. It still feeds linesByGrn
     (lock/convert flags) and grnByItem (downstream PI/PR roll-up). */
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
  // Per-GRN downstream: aggregate the per-line PI/PR breakdown into one deduped
  // doc-number list per GRN (qty summed across lines of the same PI/PR). Reuses
  // the same helper the detail page uses; cancelled PIs/PRs are already excluded.
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
    // Stored header total (= Σ qty*unit − discount). Falls back to 0 if unset.
    total_sen: (g.total_sen as number | null | undefined) ?? 0,
    downstream: [...(downstreamByGrn.get(g.id)?.values() ?? [])],
    ...computeGrnFlags(linesByGrn.get(g.id) ?? []),
  }));
  if (paginate) return c.json({ grns, total, page, pageSize, statusCounts });
  return c.json({ grns });
});

/* ── GET /outstanding-po-items ──────────────────────────────────────────
   Returns a flat list of PO line items with remaining qty > 0. Used by
   the multi-select "GRN from POs (line-level)" picker at /grns/from-po,
   and by the mobile convert wizard.
   Filters:
     - parent PO status must be SUBMITTED or PARTIALLY_RECEIVED — IN SQL
     - `?poId=a,b,c` scopes to those POs — IN SQL
     - line item must have qty - received_qty > 0 — in JS, because PostgREST
       cannot compare two columns
   Shape mirrors the GET /outstanding-so-items pattern on mfgPurchaseOrders.
   Also returns `scope`, the facts an EMPTY answer needs in order to say
   something true. See lib/outstanding-po-lines.ts for the three mechanisms
   that used to make an unreceived PO read as fully received.

   IMPORTANT (route ordering): this STATIC path MUST be registered before
   the `/:id` param route below — otherwise Hono matches `/:id` first and
   tries to cast "outstanding-po-items" to a uuid → 500. (Bug fix
   2026-05-28, same class as the PO-from-SO shadowing.) */
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
  // `!== null`, not truthiness: an empty-string message is falsy, so TS cannot
  // discriminate the union on `if (loaded.error)` and neither can a reader.
  if (loaded.error !== null) return c.json({ error: 'load_failed', reason: loaded.error }, 500);
  const { rows, scope } = loaded;

  /* The wire shape, including the second round trip that resolves each line's
     effective warehouse. Lives beside the read, in the same module, so the
     picker's contract is one file. */
  const outstanding = await toOutstandingPoItems(sb, rows, effectiveDelivery);

  /* `scope` is the WHY behind an empty `items`. Returned as data, not as a
     sentence: the desktop picker and the mobile convert wizard read this same
     endpoint, so the wording belongs to each surface and the facts belong here. */
  return c.json({ items: outstanding, scope });
});

/* Per-GRN-line downstream breakdown — for each GRN item id, the documents it was
   carried into: Purchase Invoices (via purchase_invoice_items.grn_item_id) and
   Purchase Returns (via purchase_return_items.grn_item_id). Carries the parent
   doc number + kind (PI / PR) + qty + status. Cancelled PIs / PRs are excluded so
   the "Transfer To" column never shows a voided document. The GRN counterpart of
   poLineReceipts — read-only display aid, no writes. */
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
    if (!meta) continue; // cancelled PI — excluded
    push(r.grn_item_id, { docNumber: meta.docNumber, docType: 'PI', qty: Number(r.qty ?? 0), status: meta.status });
  }
  for (const r of prLines) {
    const meta = prMeta.get(r.purchase_return_id);
    if (!meta) continue; // cancelled PR — excluded
    push(r.grn_item_id, { docNumber: meta.docNumber, docType: 'PR', qty: Number(r.qty_returned ?? 0), status: meta.status });
  }
  return out;
}

grns.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    // Company-scoped (owner 2026-08-10 audit): a bare uuid must not read
    // another company's GRN. Siblings (delivery-returns, suppliers) do this.
    scopeToCompany(sb.from('grns').select(`${HEADER}, supplier:suppliers(id, code, name, contact_person, phone, email, address), purchase_order:purchase_orders(id, po_number)`), c).eq('id', id).maybeSingle(),
    sb.from('grn_items').select(ITEM).eq('grn_id', id).order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  // Migration 0106 — surface the convert-eligibility / lock flags on the grn
  // object so the detail page can lock once a PI/PR draws from it.
  const itemRows = (i.data ?? []) as Array<{ qty_accepted?: number | null; invoiced_qty?: number | null; returned_qty?: number | null }>;
  const grn = { ...(h.data as Record<string, unknown>), ...computeGrnFlags(itemRows) };

  /* Bug #2 (Agent C 2026-05-31) — surface "received from which PO" + "receive
     date" per GRN line. The header carries received_at; each line links to a PO
     item (purchase_order_item_id), so resolve its source PO number in one extra
     round trip (item → po_item → po). source_po_number is null for manual lines.
     received_at mirrors the GRN header date so the detail/list line table can show
     a per-line column without a separate column on grn_items. */
  /* Canonical SKU/build order at READ (sofa modules LHF→NA→RHF, mains→
     accessories→services), mirroring the SO detail GET. The shared helper keys
     on `item_code`; GRN lines expose `item_code`, so sort a shimmed view
     that carries the original row back unchanged. `.order('created_at')` above
     stays as the stable tiebreaker — pure ordering, no persistence touched. */
  type GrnLineRow = Record<string, unknown> & { id: string; purchase_order_item_id: string | null; item_code: string };
  const lineItems = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      ((i.data ?? []) as unknown as Array<Record<string, unknown> & { id: string; purchase_order_item_id: string | null; item_code: string }>)
        .map((it): GrnLineRow => ({ ...it, item_code: it.item_code })),
      (r) => r.item_group as string | null | undefined,
    ),
  );
  const headerReceivedAt = (h.data as { received_at?: string | null }).received_at ?? null;
  const poItemIds = [...new Set(lineItems.map((it) => it.purchase_order_item_id).filter((x): x is string => Boolean(x)))];
  const poNoByItemId = new Map<string, string>();
  /* Owner 2026-08-06 — the V2 detail's "Ordered" column needs the SOURCE PO
     line's qty (grn_items has no ordered-qty column of its own; the V2 page
     was reading a nonexistent `qty` field and rendered 0 on every GRN). Same
     round trip that already resolves the PO number — just carry `qty` too.
     Manual lines (no purchase_order_item_id) stay null → the page shows "—". */
  const poQtyByItemId = new Map<string, number>();
  const downstreamMap = await grnLineDownstream(sb, lineItems.map((it) => it.id));
  if (poItemIds.length > 0) {
    const { data: poiRows } = await sb.from('purchase_order_items')
      .select('id, qty, po:purchase_orders ( po_number )')
      .in('id', poItemIds);
    for (const r of (poiRows ?? []) as Array<{ id: string; qty: number | null; po: { po_number: string } | Array<{ po_number: string }> | null }>) {
      const po = Array.isArray(r.po) ? r.po[0] : r.po;
      if (po?.po_number) poNoByItemId.set(r.id, po.po_number);
      if (r.qty != null) poQtyByItemId.set(r.id, Number(r.qty));
    }
  }
  const items = lineItems.map((it) => ({
    ...it,
    source_po_number: it.purchase_order_item_id ? (poNoByItemId.get(it.purchase_order_item_id) ?? null) : null,
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

// ── Linked docs (Smart Buttons fan-out) ─────────────────────────────
// For a GRN: the parent PO + downstream PIs + PRs.
grns.get('/:id/linked', async (c) => {
  /* Company-scoped like every other read on this router: without it a caller in
     one company resolves ANOTHER company's GRN to its linked document numbers by
     id. The same gap existed on all seven /:id/linked endpoints. */
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

  // Supabase typegen returns joined rows as arrays even for to-one FKs.
  // Normalise to a single object (or null).
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
     its invoice here. Fail-soft: a hiccup leaves the header-matched set. */
  let invoices = (piRes.data ?? []) as Array<{ id: string; invoice_number: string; status: string; invoice_date: string }>;
  try {
    const { data: myLines } = await sb.from('grn_items').select('id').eq('grn_id', id);
    const grnItemIds = ((myLines ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (grnItemIds.length) {
      const { data: piLines } = await sb.from('purchase_invoice_items')
        .select('purchase_invoice_id').in('grn_item_id', grnItemIds);
      const piIds = [...new Set(((piLines ?? []) as Array<{ purchase_invoice_id: string | null }>)
        .map((r) => r.purchase_invoice_id).filter((x): x is string => Boolean(x)))];
      const missing = piIds.filter((pid) => !invoices.some((v) => v.id === pid));
      if (missing.length) {
        const { data: extra } = await sb.from('purchase_invoices')
          .select('id, invoice_number, status, invoice_date').in('id', missing);
        invoices = [...invoices, ...((extra ?? []) as typeof invoices)]
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
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return refuseWithoutWriting(c, { error: 'invalid_json' }, 400); }
  /* Draft/Confirmed two-state (mirrors SO) — DRAFT is opt-in per request via
     asDraft. A DRAFT GRN commits NOTHING (no stock IN, no PO received-rollup);
     the entire commit moves to the confirm transition (PATCH /:id/post). A
     manual `status:'DRAFT'` body field is still rejected — DRAFT is reached only
     through the asDraft flag below, never as a free-form status. */
  const asDraft = (body as { asDraft?: unknown }).asDraft === true;
  if (body.status === 'DRAFT') return refuseWithoutWriting(c, { error: 'draft_status_not_supported', message: 'Use asDraft:true to save a GRN as a draft.' }, 400);
  /* Commander 2026-05-29 — a GRN may now be created WITHOUT a parent PO
     (blank/manual receipt + From-PO-multi picks that feed the New GRN form).
     Only the supplier is required; purchaseOrderId is optional. Each grn_item
     still carries its own purchase_order_item_id (or null) so the received-qty
     rollup in postGrnAndRollup runs per-line for PO-linked rows and is skipped
     for manual rows (which still write the inventory-IN movement). */
  if (!body.supplierId) return refuseWithoutWriting(c, { error: 'supplier_required' }, 400);
  const items = body.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items) || !items.length) return refuseWithoutWriting(c, { error: 'items_required' }, 400);

  const sb = c.get('supabase'); const user = c.get('user');
  const grnGroupOf = await skuCategoryResolver(sb, items.map((it) => ({ materialKind: 'mfg_product', itemCode: it.itemCode })), activeCompanyId(c) ?? null);

  /* Over-receipt guard — PO-linked lines can't accept more than the PO line's
     remaining (qty - received_qty). Mirrors the same 409 the From-PO flows
     enforce, so the manual New-GRN form can't sneak past the gate. Lines with
     no purchase_order_item_id (free / manual receipts) are uncapped. Picks that
     target the SAME PO line within one GRN are summed. */
  {
    const acceptedByPoItem = new Map<string, number>();
    for (const it of items) {
      const poItemId = (it.purchaseOrderItemId as string | undefined) ?? null;
      if (!poItemId) continue;
      const accepted = Number(it.qtyAccepted ?? it.qtyReceived ?? 0);
      acceptedByPoItem.set(poItemId, (acceptedByPoItem.get(poItemId) ?? 0) + accepted);
    }
    if (acceptedByPoItem.size > 0) {
      const xl = await assertSourceLinesInCompany(sb, c, 'purchase_order_items', [...acceptedByPoItem.keys()]);
      if (!xl.ok) return refuseWithoutWriting(c, xl.body, xl.status);
      const { data: poItems } = await sb.from('purchase_order_items')
        .select('id, qty, received_qty, po:purchase_orders!inner ( status, on_hold )').in('id', [...acceptedByPoItem.keys()]);
      /* Receivable-PO guard (audit gap #5) — a PO-linked line may only be
         received while its source PO is receivable. Only `/from-po-items`
         enforced this; the manual New-GRN form (this path) could slip PO-linked
         lines onto a DRAFT / CANCELLED / already-RECEIVED PO and write stock IN.
         Manual (no-PO) lines never reach here — they carry no
         purchase_order_item_id, so the intentional manual-GRN flow is unaffected. */
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

  /* PR-DRAFT-removal — Commander 2026-05-27: GRN is created as POSTED
     directly. Commander already enters Received/Accepted/Rejected per line
     on the New GRN form, so there's never a moment where DRAFT is useful.
     We insert with status:'POSTED' + posted_at, then call postGrnAndRollup
     to do the receipt rollup + inventory IN. */
  /* Commander 2026-05-29 — New GRN now mirrors New PO's header, including a
     "Receive into" Warehouse picker. Persist the chosen warehouse on the grn
     header so the inventory-IN movement lands in the right warehouse.
     Warehouse-required guard (audit gap #6) — when the form omits a warehouse we
     no longer silently default to defaultWarehouseId (first, code-sorted =
     China/transit), which received goods into the wrong warehouse and left MRP
     for the real (MY) warehouse short. Resolve it from the PO-linked lines'
     single bound warehouse (the auto-resolution the post chokepoint honours);
     only if neither an explicit picker value nor a single PO-line warehouse is
     available do we reject with a plain 400. A manual GRN (no PO lines) must now
     carry an explicit warehouse — the intentional manual-receipt flow still
     works, it just can't land stock nowhere-in-particular. */
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

  /* AUDIT PRE-FLIGHT — the ordering rationale for all nine in this file.
     recordEntityAudit runs AFTER the business write commits, so it cannot honestly
     fail there; refusing up front is the only point at which "nothing has changed"
     is true. Each sits after every auth/validation/read guard and strictly before
     the handler's FIRST mutating call — which is also what lets every refusal at or
     above it answer through refuseWithoutWriting and release the idempotency key. */
  const pf = await assertAuditWritable(sb, { entityType: 'GRN', action: 'CREATE', companyId: activeCompanyId(c) });
  if (!pf.ok) return refuseWithoutWriting(c, auditUnavailableBody(), 409);

  /* Migration 0082 — GRN currency + rate inherit from the source PO (MYR default);
     allocation_method for landed-freight "平摊" (default QTY). MYR ⇒ rate 1, no-op. */
  const grnFx = await resolveGrnFx(sb, (body.purchaseOrderId as string | undefined) ?? null, body.currency, body.exchangeRate);
  /* R2 money-path guard (audit inventory-costing-integrity R2) — refuse a foreign
     GRN whose currency has no positive master rate and no operator-entered rate,
     rather than capitalising the raw foreign figure into the lot at 1:1. Applies
     to drafts too: a draft stored at the fallback 1 cannot be told apart from a
     deliberate 1 once written, so the create boundary is the only safe gate. */
  {
    const rateGuard = await assertForeignRatePostable(sb, { currency: grnFx.currency, operatorRate: body.exchangeRate, docLabel: 'GRN' });
    if (!rateGuard.ok) return refuseWithoutWriting(c, rateGuard.body, 422);
  }
  /* Doc-no collision retry (2026-07-14): two warehouse staff posting a GRN in
     the same company + YYMM both mint the same grn_number; without a retry the
     loser hits the UNIQUE grn_number (23505) and the receipt 500s. Lines key off
     the returned header.id, so a re-mint needs no child re-stamp. */
  let firstMint = true;
  const { data: header, error: hErr } = await insertWithDocNoRetry(
    async () => {
      if (firstMint) { firstMint = false; return grnNumber; }
      grnNumber = await nextNumber(sb, 'GRN', 'grns', 'grn_number', c);
      return grnNumber;
    },
    (dn) => sb.from('grns').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
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
    // Draft/Confirmed — DRAFT commits nothing; the confirm transition (PATCH
    // /:id/post) flips it to POSTED and runs the stock IN + PO rollup there.
    status: asDraft ? 'DRAFT' : 'POSTED',
    posted_at: asDraft ? null : new Date().toISOString(),
    created_by: user.id,
    }).select(`${HEADER}, company_id`).single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  /* company_id read back off the row we just inserted, NOT re-derived from the
     request: it scopes the post chokepoint below to this GRN's own company
     without adding a refusal to a create path that has none today. */
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
      /* Migration 0101 — GRN line money: qty_received * unit - discount. */
      // Audit (ported from 2990 20190257) — clamp like the PO create path (negative-money guard).
      line_total_sen: Math.max(0, (qtyReceived * unitPriceSen) - discountSen),
      delivery_date: dateOrNull(it.deliveryDate),
      unit_cost_sen: Number(it.unitCostSen ?? 0),
      notes: (it.notes as string | undefined) ?? null,
      /* Commander 2026-05-29 — persist the line category + variant selections so
         MANUAL bedframe/sofa lines (which now have the per-category variant editor
         on the New GRN form, like the PO) keep their picks. The inventory-IN
         movement's variant_key in postGrnAndRollup reads item_group + variants. */
      variants: it.variants ?? null,
      description: (it.description as string | undefined) ?? null,
      ...lineIdentityFields(grnGroupOf, it, buildVariantSummary), // SKU wins — docs/bugs/0514
      /* Migration 0151 — physical rack this received line is placed onto. */
      rack_id: (it.rackId as string | undefined) || null,
      /* migration 0280 — the zero-cost gate's escape hatch. It is in the
         EXPLICIT whitelist because this insert is explicit: a field absent
         here is silently dropped, and a tick the operator set but the server
         dropped would refuse the receipt they just acknowledged. */
      ...zeroCostAckColumns(it, user.id),
    };
  });
  const { error: iErr } = await sb.from('grn_items').insert(stampCompany(rows, c));
  if (iErr) { await sb.from('grns').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }

  /* Post-insert over-receipt verification — the pre-check above is a read-then-
     write race (two concurrent receives both pass). Re-sum live received per PO
     line; if any now exceeds cap, THIS GRN broke it → delete it + 409.
     LEAK GUARD: skipped for a DRAFT — a draft consumes no PO headroom (it hasn't
     committed) and verifyGrnOverReceipt sums ALL non-cancelled lines (incl.
     DRAFT), so running it on a draft could falsely 409 it or count its lines
     against a sibling. The cap is re-verified at confirm time. */
  if (!asDraft) {
    const over = await verifyGrnOverReceipt(sb, h.id, items.map((it) => (it.purchaseOrderItemId as string | undefined) ?? null));
    if (over) {
      await sb.from('grn_items').delete().eq('grn_id', h.id);
      await sb.from('grns').delete().eq('id', h.id);
      return c.json({ error: 'qty_exceeds_remaining', poItemId: over.poItemId, requested: over.requested, remaining: over.remaining }, 409);
    }
  }

  /* LEAK GUARD (CRITICAL): a DRAFT GRN must NOT post — postGrnAndRollup is the
     single chokepoint that writes inventory IN + rolls up the PO received_qty.
     Skip it for a draft; the confirm transition (PATCH /:id/post) runs it. */
  let postRes: Awaited<ReturnType<typeof postGrnAndRollup>> | undefined;
  if (!asDraft) postRes = await postGrnAndRollup(sb, h.id, user.id, h.company_id);
  /* ZERO-COST refusal on a create-as-POSTED path. This route inserts the row
     with status POSTED and then calls the chokepoint, so a refusal would
     otherwise leave a POSTED GRN carrying no stock — the worst of both. Undo
     the document exactly like the over-receipt rollback above and 409. */
  if (postRes && !postRes.ok && postRes.zeroCost) {
    await sb.from('grn_items').delete().eq('grn_id', h.id);
    await sb.from('grns').delete().eq('id', h.id);
    return refuseZeroCostReceipt(c, postRes.zeroCost, { nothingWritten: true });
  }
  // Migration 0101 — populate header money rollups from the inserted lines.
  // (Money only — no stock — so it's safe to run for a draft too.)
  await recomputeGrnTotals(sb, h.id);

  /* The receipt has survived every compensating branch above (items-insert
     rollback, over-receipt rollback) — from here the only exits are success, so
     this is the earliest point at which a CREATE row is true. Written AFTER
     recomputeGrnTotals so totalSen is the rolled-up figure. */
  await recordGrnCreate(sb, c.get('houzsUser'), activeCompanyId(c), h.id, items.length);

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

  const movementErrors = postRes && postRes.ok ? postRes.movementErrors : undefined;
  const recountError = postRes && postRes.ok ? postRes.recountError : undefined;
  return c.json({ id: h.id, grnNumber: h.grn_number, movementErrors: movementErrors?.length ? movementErrors : undefined, recountError }, 201);
});

// ── POST /from-pos ─────────────────────────────────────────────────────
// Batch-convert multiple POs into ONE GRN. Validates same supplier across
// all POs. Pre-fills qty_received + qty_accepted with the outstanding qty
// (po_item.qty - po_item.received_qty) per line. Returns the new GRN's id
// so the UI can navigate to its detail page for review.
/* Exported so the company-scope tests can drive it without supabaseAuth, which
   cannot run in the vitest harness. The registration below is unchanged. */
export const createGrnFromPosHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { purchaseOrderIds?: string[]; deliveryNoteRef?: string; notes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return refuseWithoutWriting(c, { error: 'invalid_json' }, 400); }
  const poIds = body.purchaseOrderIds ?? [];
  if (poIds.length === 0) return refuseWithoutWriting(c, { error: 'po_ids_required' }, 400);

  /* SOURCE LOAD, SCOPED — purchaseOrderIds arrive in the request body, so this
     read is what the conversion can see. Another company's PO id resolves to NO
     ROW and falls out at `pos_not_found` below, which is also why the
     firstCrossCompanyPo refusal that used to stand here can no longer fire.
     THE COST: that request gets `pos_not_found` rather than "belongs to 2990,
     switch company" — naming the other company needs an UNSCOPED read this
     handler otherwise never makes. Same trade as /:id/convert-from-so. */
  const { data: pos, error: poErr } = await scopeToCompany(sb.from('purchase_orders')
    .select('id, po_number, supplier_id, status, on_hold, currency')
    .in('id', poIds), c);
  if (poErr) return refuseWithoutWriting(c, { error: 'load_failed', reason: poErr.message }, 500);
  const poList = (pos ?? []) as Array<{ id: string; po_number: string; supplier_id: string; status: string; on_hold: boolean | null; currency?: string | null }>;
  if (poList.length === 0) return refuseWithoutWriting(c, { error: 'pos_not_found' }, 404);

  /* Receivable-PO guard (audit gap #5) — a batch-convert may only receive POs
     that are still open for receipt. Without this a DRAFT / CANCELLED /
     already-RECEIVED PO could be converted to a GRN and write stock IN. Mirrors
     the 409 `/from-po-items` already enforces per pick. */
  const notReceivable = poList.find((p) => !isReceivablePo(p));
  if (notReceivable) {
    return refuseWithoutWriting(c, { error: 'po_not_receivable', poId: notReceivable.id, status: notReceivable.status, onHold: isDocumentHeld(notReceivable) }, 409);
  }

  const supplierIds = new Set(poList.map((p) => p.supplier_id));
  if (supplierIds.size > 1) {
    return refuseWithoutWriting(c, { error: 'mixed_suppliers', message: 'All selected POs must be from the same supplier' }, 400);
  }
  const supplierId = [...supplierIds][0]!;

  // Load PO items with outstanding qty (+ variant fields for PR #44). SCOPED —
  // the LINE-level half of the same source document. Redundant after the scoped
  // header read, and kept: an id-keyed read is its own entry point.
  const { data: items, error: itemsErr } = await scopeToCompany(sb.from('purchase_order_items')
    .select('id, purchase_order_id, material_kind, item_code, material_name, qty, received_qty, unit_price_sen, ' +
      'item_group, description, description2, uom, variants, gap_inches, divan_height_inches, divan_price_sen, ' +
      'leg_height_inches, leg_price_sen, custom_specials, line_suffix, special_order_price_sen, discount_sen, unit_cost_sen, delivery_date, ' +
      // Migration 0180 — revised dates so the GRN line carries the EFFECTIVE date.
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

  if (itemList.length === 0) return refuseWithoutWriting(c, { error: 'nothing_outstanding', message: 'No outstanding lines came back for this PO. Open it and check its received balance before treating it as received in full.' }, 400); // Refusing is right; the VERDICT was not. This read is company-scoped and scopeToCompany fails closed, so [] arrives with error: null whether the order is settled or the company could not be resolved. Five siblings in purchase-returns / purchase-consignment-* were reworded with it; audit:empty-state-claims keeps them honest.

  /* Warehouse-required guard (audit gap #6) — this batch-convert never set a
     header warehouse and relied on postGrnAndRollup's defaultWarehouseId
     fallback, so POs whose lines carry no (or mixed) warehouse binding silently
     received into the first (China/transit) warehouse. Bind the single warehouse
     the PO lines resolve to; reject when they don't (there is no picker on this
     flow — fix the PO line binding or receive per-warehouse instead). */
  const batchWarehouseId = await resolveReceiveWarehouse(sb, null, itemList.map((it) => it.id));
  if (!batchWarehouseId) {
    return refuseWithoutWriting(c, { error: 'warehouse_required', message: 'These purchase orders have no single receive-into warehouse. Set the warehouse on the PO lines, or receive them per warehouse.' }, 400);
  }

  const pf = await assertAuditWritable(sb, { entityType: 'GRN', action: 'CREATE', companyId: activeCompanyId(c) });
  if (!pf.ok) return refuseWithoutWriting(c, auditUnavailableBody(), 409);

  // Generate GRN number using same pattern as the single-POST endpoint.
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const cp = companyDocPrefix(c);
  let grnNumber = await mintMonthlyDocNo(sb, 'grns', 'grn_number', `${cp}GRN-${yymm}`);

  const poNumbersJoined = poList.map((p) => p.po_number).join(', ');
  /* Migration 0082 — GRN currency = the source POs' currency (same supplier ⇒
     assume one currency; take the primary PO's). Rate auto-fills from the master;
     allocation_method defaults QTY. MYR ⇒ rate 1, no-op. */
  const batchFx = await resolveGrnFx(sb, poList[0]!.id, poList[0]!.currency ?? undefined, undefined);
  /* R2 money-path guard — the batch-from-POs GRN inherits the PO currency with no
     operator rate; refuse it if that currency has no positive master rate (would
     capitalise the raw foreign figure at 1:1). Checked before the single insert. */
  {
    const rateGuard = await assertForeignRatePostable(sb, { currency: batchFx.currency, operatorRate: undefined, docLabel: 'GRN' });
    if (!rateGuard.ok) return refuseWithoutWriting(c, rateGuard.body, 422);
  }
  /* Doc-no collision retry (2026-07-14): a concurrent GRN create in the same
     company + YYMM can mint the same grn_number; without a retry the loser hits
     the UNIQUE grn_number (23505) and the batch-convert 500s. Lines key off the
     returned header.id, so a re-mint needs no child re-stamp. */
  let firstMint = true;
  const { data: header, error: hErr } = await insertWithDocNoRetry(
    async () => {
      if (firstMint) { firstMint = false; return grnNumber; }
      grnNumber = await mintMonthlyDocNo(sb, 'grns', 'grn_number', `${cp}GRN-${yymm}`);
      return grnNumber;
    },
    (dn) => sb.from('grns').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    grn_number: dn,
    purchase_order_id: poList[0]!.id,                    // primary PO ref (first one)
    supplier_id: supplierId,
    warehouse_id: batchWarehouseId,                      // audit gap #6 — no silent China/transit default
    received_at: todayMyt(),
    delivery_note_ref: body.deliveryNoteRef ?? null,
    currency: batchFx.currency,
    exchange_rate: batchFx.exchange_rate,
    allocation_method: normalizeAllocationMethod((body as { allocationMethod?: unknown }).allocationMethod),
    notes: `Batch-converted from ${poList.length} POs: ${poNumbersJoined}${body.notes ? ` · ${body.notes}` : ''}`,
    /* PR-DRAFT-removal — auto-POSTED on create. */
    status: 'POSTED',
    posted_at: new Date().toISOString(),
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
      /* Migration 0101 — GRN line money: qty_received * unit - discount. */
      // Audit (ported from 2990 20190257) — clamp like the PO create path (negative-money guard).
      line_total_sen: Math.max(0, (qtyReceived * it.unit_price_sen) - discountSen),
      unit_cost_sen: it.unit_cost_sen ?? 0,
      /* PR #44 — preserve variants from PO line */
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
      /* Deliverable 5 — carry the PO line's delivery date into the GRN line so a
         converted GRN line shows the PO's delivery date instead of blank.
         Migration 0180 — use the EFFECTIVE (latest revised) line date. */
      delivery_date: effectiveDelivery(
        it.delivery_date,
        it.supplier_delivery_date_2,
        it.supplier_delivery_date_3,
        it.supplier_delivery_date_4,
      ),
    };
  });
  const { error: iErr } = await sb.from('grn_items').insert(stampCompany(rows, c));
  if (iErr) { await sb.from('grns').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }

  /* Post-insert over-receipt verification — the outstanding-qty prefill above is
     a read-then-write race with concurrent receives. Re-sum live received per PO
     line; if any now exceeds cap, THIS GRN broke it → delete it + 409. */
  {
    const over = await verifyGrnOverReceipt(sb, h.id, itemList.map((it) => it.id));
    if (over) {
      await sb.from('grn_items').delete().eq('grn_id', h.id);
      await sb.from('grns').delete().eq('id', h.id);
      return c.json({ error: 'qty_exceeds_remaining', poItemId: over.poItemId, requested: over.requested, remaining: over.remaining }, 409);
    }
  }

  /* PR-DRAFT-removal — auto-rollup + inventory IN after items insert. */
  const postRes = await postGrnAndRollup(sb, h.id, user.id, h.company_id);
  /* ZERO-COST refusal — same rollback as POST /: this path also inserts POSTED
     before calling the chokepoint, so the document must not survive a refusal. */
  if (!postRes.ok && postRes.zeroCost) {
    await sb.from('grn_items').delete().eq('grn_id', h.id);
    await sb.from('grns').delete().eq('id', h.id);
    return refuseZeroCostReceipt(c, postRes.zeroCost, { nothingWritten: true });
  }
  // Migration 0101 — populate header money rollups from the inserted lines.
  await recomputeGrnTotals(sb, h.id);

  /* Past the items-insert rollback and the over-receipt rollback — the GRN is
     now permanent, so the CREATE row cannot outlive a document that was undone. */
  await recordGrnCreate(
    sb, c.get('houzsUser'), activeCompanyId(c), h.id, itemList.length,
    `Batch-converted from ${poList.length} PO${poList.length === 1 ? '' : 's'}: ${poNumbersJoined}`,
  );

  /* ERP -> AutoCount PO->GR, BATCHED OR NOT. A GRN receiving several purchase
     orders names every one of them: AcSyncService takes FromDocNos and either
     FullTransfers the array or groups the named line keys per source document.
     The "one transfer, one source document" limit this used to skip on belongs
     to the primitive's key array, never to the target. */
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
  /* Confirm transition (DRAFT → POSTED) — this is where the GRN commits.
     postGrnAndRollup is the single chokepoint: it writes inventory IN +
     rolls up the PO received_qty + flips PO status. A GRN created with
     asDraft:true sits at DRAFT (committing nothing) until this runs.

     Back-compat: a non-draft GRN is already POSTED at create; hitting this on
     a POSTED row is an idempotent no-op (200 with the current row). The
     manual New-GRN form still calls this right after create — when that create
     was non-draft the row is POSTED → no-op; when it was a draft this is the
     real confirm. */
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  /* Company-scoped BEFORE the status read, because everything past this point —
     the over-receipt check, the stock IN, the PO rollup — acts on whatever this
     load returned. Unscoped, a confirm from one company committed inventory
     against another company's GRN. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return refuseWithoutWriting(c, co.refusal, 409);
  const { data: cur } = await scopeToCompanyId(sb.from('grns')
    .select('id, status, posted_at, grn_number, warehouse_id, total_sen').eq('id', id), co.companyId).maybeSingle();
  if (!cur) return refuseWithoutWriting(c, NOT_THIS_COMPANY, 404);
  const row = cur as {
    id: string; status: string; posted_at: string | null;
    grn_number: string; warehouse_id: string | null; total_sen: number | null;
  };
  /* An already-POSTED GRN is an idempotent no-op that commits nothing, so it
     records nothing — a history full of "confirmed an already-confirmed GRN"
     from the New-GRN form's unconditional follow-up call would be noise. */
  if (row.status === 'POSTED') {
    return c.json({ grn: row });
  }
  if (row.status === 'CANCELLED' || row.status === 'CLOSED') {
    return refuseWithoutWriting(c, { error: 'cannot_confirm', message: `GRN is ${row.status} — cannot confirm.` }, 409);
  }

  /* Over-receipt verification at confirm — the draft-create path SKIPS this
     guard (a draft consumes no PO headroom), so re-check it here before the
     stock IN / PO rollup commits. If confirming this draft would push a PO line
     past its cap, refuse + leave it DRAFT. */
  const { data: gLines } = await sb.from('grn_items')
    .select('purchase_order_item_id').eq('grn_id', id);
  const poItemIds = ((gLines ?? []) as Array<{ purchase_order_item_id: string | null }>)
    .map((l) => l.purchase_order_item_id);
  const over = await verifyGrnOverReceipt(sb, id, poItemIds);
  if (over) {
    return refuseWithoutWriting(c, { error: 'qty_exceeds_remaining', poItemId: over.poItemId, requested: over.requested, remaining: over.remaining }, 409);
  }

  const pf = await assertAuditWritable(sb, { entityType: 'GRN', entityId: id, action: 'POST', companyId: activeCompanyId(c) });
  if (!pf.ok) return refuseWithoutWriting(c, auditUnavailableBody(), 409);

  const res = await postGrnAndRollup(sb, id, user.id, co.companyId);
  /* Honour the chokepoint's own status. A lost confirm race (409
     'already_posting') is a normal outcome — the other call committed the stock —
     not a server fault; it used to surface as a 500 because res.status was
     discarded here. */
  if (!res.ok) {
    /* ZERO-COST refusal answers with the offending LINES, not a bare reason —
       the operator has to know which ones need a price off the supplier's
       goods-received document. Nothing was written, so the GRN is still DRAFT
       and re-confirmable once the prices are in. */
    if (res.zeroCost) return refuseZeroCostReceipt(c, res.zeroCost, { nothingWritten: true });
    if (res.status === 409) {
      const { data: now } = await scopeToCompanyId(sb.from('grns')
        .select('id, status, posted_at, total_sen').eq('id', id), co.companyId).maybeSingle();
      return c.json({ error: 'cannot_confirm', reason: res.reason, grn: now ?? undefined }, 409);
    }
    return c.json({ error: 'post_failed', reason: res.reason }, res.status === 404 ? 404 : 500);
  }
  // Header money rollup (no stock) — keep it in sync on confirm.
  await recomputeGrnTotals(sb, id);
  const { data } = await scopeToCompanyId(sb.from('grns').select('id, status, posted_at, total_sen').eq('id', id), co.companyId).single();

  /* The moment received goods become on-hand stock and PO received_qty moves.
     Recorded AFTER recomputeGrnTotals so totalSen is the rolled-up figure, in
     INTEGER SEN. */
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

  return c.json({ grn: data, movementErrors: res.movementErrors?.length ? res.movementErrors : undefined, recountError: res.recountError });
};
grns.patch('/:id/post', postGrnHandler);

/* ── POST /from-po-items ────────────────────────────────────────────────
   Multi-select GRN creator. Body: { picks: [{ poItemId, qty }], notes?,
   receivedDate? }. Groups picks by purchase_order_id (each GRN can only
   reference one PO via grns.purchase_order_id FK) and emits one GRN per
   PO. Each GRN is created in DRAFT then immediately posted via the shared
   `postGrnAndRollup` helper so inventory + received_qty + PO status flip
   atomically (per-doc; best-effort across docs).

   Returns { created: [{ id, grnNumber, purchaseOrderId, poNumber, lineCount }], total }. */
/* Exported so the company-scope tests can drive it without supabaseAuth, which
   cannot run in the vitest harness. The registration below is unchanged. */
export const createGrnsFromPoItemsHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  /* company-scope: the only by-id write here is the ROLLBACK of the header this
     handler just inserted; the insert stamps the active company, so the id is
     not caller-supplied. */
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { picks?: Array<{ poItemId: string; qty: number }>; notes?: string; receivedDate?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return refuseWithoutWriting(c, { error: 'invalid_json' }, 400); }
  const picks = body.picks ?? [];
  if (picks.length === 0) return refuseWithoutWriting(c, { error: 'picks_required' }, 400);

  /* SOURCE LOAD, SCOPED — the picked PO LINES are where the caller's ids enter,
     so this read is what the conversion can see. Another company's poItemId
     resolves to NO ROW and falls out at the per-pick `item_not_found` below; the
     parent PO rides the `!inner` embed, so it cannot arrive from outside the
     company either. That is also why the firstCrossCompanyPo refusal that used
     to stand below the validation loop can no longer fire.
     THE COST: `item_not_found` rather than "belongs to 2990, switch company" —
     same trade as /:id/convert-from-so. */
  const ids = picks.map((p) => p.poItemId);
  const { data: itemsData, error: itemsErr } = await scopeToCompany(sb
    .from('purchase_order_items')
    .select(`
      id, purchase_order_id, material_kind, item_code, material_name,
      item_group, description, description2, uom, qty, received_qty,
      unit_price_sen, variants, gap_inches, divan_height_inches, divan_price_sen,
      leg_height_inches, leg_price_sen, custom_specials, line_suffix,
      special_order_price_sen, discount_sen, delivery_date,
      supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4,
      po:purchase_orders!inner ( id, po_number, supplier_id, status, on_hold, purchase_location_id, currency )
    `)
    .in('id', ids), c);
  if (itemsErr) return refuseWithoutWriting(c, { error: 'load_failed', reason: itemsErr.message }, 500);

  type ItemRow = {
    id: string; purchase_order_id: string; material_kind: string; item_code: string;
    material_name: string; item_group: string | null; description: string | null;
    description2: string | null; uom: string | null;
    qty: number; received_qty: number; unit_price_sen: number;
    variants: unknown; gap_inches: number | null; divan_height_inches: number | null;
    divan_price_sen: number; leg_height_inches: number | null; leg_price_sen: number;
    custom_specials: unknown; line_suffix: string | null; special_order_price_sen: number;
    discount_sen: number; delivery_date: string | null;
    // Migration 0180 — per-line revised dates for the effective GRN line date.
    supplier_delivery_date_2: string | null;
    supplier_delivery_date_3: string | null;
    supplier_delivery_date_4: string | null;
    po: { id: string; po_number: string; supplier_id: string; status: string; purchase_location_id: string | null; currency?: string | null };
  };

  const itemList = (itemsData ?? []) as unknown as ItemRow[];
  const byId = new Map<string, ItemRow>();
  for (const r of itemList) byId.set(r.id, r);

  // Validate every pick — qty > 0 and qty ≤ remaining.
  for (const p of picks) {
    const row = byId.get(p.poItemId);
    if (!row) return refuseWithoutWriting(c, { error: 'item_not_found', poItemId: p.poItemId }, 400);
    if (p.qty <= 0) return refuseWithoutWriting(c, { error: 'qty_must_be_positive', poItemId: p.poItemId }, 400);
    const remaining = row.qty - (row.received_qty ?? 0);
    if (p.qty > remaining) {
      return refuseWithoutWriting(c, { error: 'qty_exceeds_remaining', poItemId: p.poItemId, requested: p.qty, remaining }, 409);
    }
    if (!isReceivablePo(row.po)) {
      return refuseWithoutWriting(c, { error: 'po_not_receivable', poItemId: p.poItemId, status: row.po.status, onHold: isDocumentHeld(row.po) }, 409);
    }
  }

  /* One probe for the whole batch, not one per bucket: every bucket below writes
     to the same sink, and a refusal here leaves the entire multi-GRN receive
     untouched rather than half-created. */
  const pf = await assertAuditWritable(sb, { entityType: 'GRN', action: 'CREATE', companyId: activeCompanyId(c) });
  if (!pf.ok) return refuseWithoutWriting(c, auditUnavailableBody(), 409);

  // Group picks by SUPPLIER → one GRN per supplier (Commander 2026-05-29:
  // "不同 supplier 不能 under 同一张 GRN" + "multi-select → 一张 GRN"). A
  // supplier's lines may span several POs; the GRN header references the first
  // PO (grns.purchase_order_id is single-FK) while each grn_item keeps its own
  // purchase_order_item_id, so received_qty still rolls up to EVERY source PO.
  /* `poIds` alongside `poNumbers` because the AutoCount transfer names its
     sources by ERP ROW, not by printed number: enqueueConvert resolves each
     ref through linked_ac_docno, and `primaryPoId` alone would name one of
     the several purchase orders this bucket actually received. */
  type Bucket = { supplierId: string; primaryPoId: string; poIds: Set<string>; poNumbers: Set<string>; warehouseId: string | null; currency: string | null; lines: Array<{ row: ItemRow; qty: number }> };
  const buckets = new Map<string, Bucket>();
  for (const p of picks) {
    const row = byId.get(p.poItemId)!;
    const key = row.po.supplier_id;
    const cur = buckets.get(key) ?? {
      supplierId: row.po.supplier_id, primaryPoId: row.po.id, poIds: new Set<string>(), poNumbers: new Set<string>(),
      warehouseId: row.po.purchase_location_id, currency: row.po.currency ?? null, lines: [],
    };
    cur.poIds.add(row.po.id);
    cur.poNumbers.add(row.po.po_number);
    cur.lines.push({ row, qty: p.qty });
    buckets.set(key, cur);
  }

  // Generate GRN numbers sequentially within this batch.
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  // Seed from max(suffix), NOT count — count+1 is non-self-healing (a mid-month
  // delete re-mints a surviving number → UNIQUE collision). Derive the next
  // suffix via mintMonthlyDocNo, then counter starts one below it.
  const cp = companyDocPrefix(c);
  const firstNext = await mintMonthlyDocNo(sb, 'grns', 'grn_number', `${cp}GRN-${yymm}`);
  let counter = parseInt(firstNext.slice(`${cp}GRN-${yymm}-`.length), 10) - 1;

  const receivedAt = dateOrNull(body.receivedDate) ?? todayMyt(); // "" is not undefined: nullish left it for Postgres, and a failed bucket here is dropped silently
  const created: Array<{ id: string; grnNumber: string; purchaseOrderId: string; poNumber: string; lineCount: number; posted?: boolean; postError?: string; movementErrors?: string[]; recountError?: string }> = [];
  // Track any bucket rolled back by the post-insert over-receipt verification so
  // we can surface a 409 with the same error shape the add-line path uses.
  let overReceipt: { poItemId: string; requested: number; remaining: number } | null = null;
  let zeroCostRefusal: ZeroCostRefusal | null = null;

  /* R2 money-path guard — validate EVERY bucket's currency up front, before any
     GRN is inserted, so an un-rated foreign PO can't leave a partially-committed
     batch. Each bucket inherits its primary PO currency with no operator rate. */
  for (const bucket of buckets.values()) {
    const rateGuard = await assertForeignRatePostable(sb, { currency: bucket.currency ?? undefined, operatorRate: undefined, docLabel: 'GRN' });
    if (!rateGuard.ok) return refuseWithoutWriting(c, rateGuard.body, 422);
  }

  for (const bucket of buckets.values()) {
    counter += 1;
    /* Migration 0082 — GRN currency = its primary PO's; rate auto-fills from the
       master; allocation_method defaults QTY. MYR ⇒ rate 1, no-op. */
    const bucketFx = await resolveGrnFx(sb, bucket.primaryPoId, bucket.currency ?? undefined, undefined);
    const grnPayload = {
      company_id: activeCompanyId(c), // multi-company: stamp the active company
      purchase_order_id: bucket.primaryPoId,
      supplier_id: bucket.supplierId,
      received_at: receivedAt,
      warehouse_id: bucket.warehouseId,
      currency: bucketFx.currency,
      exchange_rate: bucketFx.exchange_rate,
      allocation_method: normalizeAllocationMethod((body as { allocationMethod?: unknown }).allocationMethod),
      notes: body.notes
        ? `Received from ${[...bucket.poNumbers].join(', ')} · ${body.notes}`
        : `Received from ${[...bucket.poNumbers].join(', ')}`,
      created_by: user.id,
    };
    /* Audit (ported from 2990 b30f0bb1) — the GRN suffix is an in-memory counter
       off a non-locking COUNT snapshot, so a CONCURRENT multi-GRN receive can
       mint the same grn_number (UNIQUE). A collision previously hit
       `if (hErr) continue` and SILENTLY DROPPED the bucket (its inventory-IN
       lost, caller still got 201). Retry on 23505: re-derive the next free
       suffix from a fresh live count + bump. */
    let h: { id: string; grn_number: string; company_id: number } | null = null;
    for (let attempt = 0; attempt < 8 && !h; attempt += 1) {
      const grnNumber = `${cp}GRN-${yymm}-${String(counter).padStart(3, '0')}`;
      const { data: header, error: hErr } = await sb.from('grns')
        .insert({ grn_number: grnNumber, ...grnPayload })
        .select('id, grn_number, company_id').single();
      if (!hErr && header) { h = header as unknown as { id: string; grn_number: string; company_id: number }; break; }
      if (!hErr || (hErr as { code?: string }).code !== '23505') break;
      const liveNext = await mintMonthlyDocNo(sb, 'grns', 'grn_number', `${cp}GRN-${yymm}`);
      counter = parseInt(liveNext.slice(`${cp}GRN-${yymm}-`.length), 10);
    }
    if (!h) continue;

    const rows = bucket.lines.map(({ row, qty }) => {
      const discountSen = row.discount_sen ?? 0;
      return {
        grn_id: h.id,
        purchase_order_item_id: row.id,
        material_kind: row.material_kind,
        item_code: row.item_code,
        material_name: row.material_name,
        qty_received: qty,
        qty_accepted: qty,
        qty_rejected: 0,
        unit_price_sen: row.unit_price_sen,
        /* Migration 0101 — GRN line money: qty_received * unit - discount. */
        // Audit (ported from 2990 20190257) — clamp like the PO create path (negative-money guard).
        line_total_sen: Math.max(0, (qty * row.unit_price_sen) - discountSen),
        // PR #44 — preserve variants from PO line
        item_group: row.item_group,
        description: row.description,
        description2: row.description2,
        uom: row.uom ?? 'UNIT',
        variants: row.variants,
        gap_inches: row.gap_inches,
        divan_height_inches: row.divan_height_inches,
        divan_price_sen: row.divan_price_sen ?? 0,
        leg_height_inches: row.leg_height_inches,
        leg_price_sen: row.leg_price_sen ?? 0,
        custom_specials: row.custom_specials,
        line_suffix: row.line_suffix,
        special_order_price_sen: row.special_order_price_sen ?? 0,
        discount_sen: discountSen,
        /* Deliverable 5 — carry the PO line's delivery date into the GRN line.
           Migration 0180 — use the EFFECTIVE (latest revised) line date. */
        delivery_date: effectiveDelivery(
          row.delivery_date,
          row.supplier_delivery_date_2,
          row.supplier_delivery_date_3,
          row.supplier_delivery_date_4,
        ),
      };
    });
    const { error: iErr } = await sb.from('grn_items').insert(stampCompany(rows, c));
    if (iErr) {
      await sb.from('grns').delete().eq('id', h.id);
      continue;
    }
    /* Post-insert over-receipt verification — the per-pick pre-check above is a
       read-then-write race with concurrent receives. Re-sum live received per PO
       line; if THIS bucket's GRN broke a cap, roll it back (delete its lines +
       header) and record the over-receipt so we 409 below. Must run BEFORE
       postGrnAndRollup so no inventory IN / received_qty rollup is written for a
       rejected receipt. */
    const over = await verifyGrnOverReceipt(sb, h.id, bucket.lines.map(({ row }) => row.id));
    if (over) {
      await sb.from('grn_items').delete().eq('grn_id', h.id);
      await sb.from('grns').delete().eq('id', h.id);
      overReceipt = over;
      continue;
    }
    // Immediately post — rolls up received_qty, flips PO status, writes inventory.
    const postRes = await postGrnAndRollup(sb, h.id, user.id, h.company_id);
    /* ZERO-COST refusal — this path also inserts POSTED before posting, so roll
       the bucket's document back exactly like the over-receipt branch above and
       carry the refusal out of the loop. Buckets that received cleanly keep
       their documents; only the uncosted one is undone. */
    if (!postRes.ok && postRes.zeroCost) {
      await sb.from('grn_items').delete().eq('grn_id', h.id);
      await sb.from('grns').delete().eq('id', h.id);
      zeroCostRefusal = postRes.zeroCost;
      continue;
    }
    // Migration 0101 — populate header money rollups from the inserted lines.
    await recomputeGrnTotals(sb, h.id);
    if (!postRes.ok) {
      // Post failed — leave the GRN as DRAFT (it's created), report counts.
      // Don't delete — commander can inspect and post manually.
    }
    /* Per-bucket posted/error flag — a bucket can post-succeed but still have its
       inventory IN silently fail (writeMovements {ok:false}), or fail the post
       outright. Surface both per entry so a partial multi-PO receive is LOUD
       instead of the whole call returning a flat 201. */
    /* This bucket's GRN cleared its own over-receipt rollback (the `continue`
       above), so it survives the request even if a LATER bucket is rolled back —
       each bucket is its own document and its own CREATE row. */
    await recordGrnCreate(
      sb, c.get('houzsUser'), activeCompanyId(c), h.id, bucket.lines.length,
      `Received from ${[...bucket.poNumbers].join(', ')}`,
    );

    /* ERP -> AutoCount PO->GR, per bucket: each bucket IS its own document, and
       it names every purchase order it received against. The bucket is grouped
       by supplier, so all its sources share one creditor. */
    const bucketPoIds = bucket.poIds.size ? [...bucket.poIds] : (bucket.primaryPoId ? [bucket.primaryPoId] : []);
    const bucketAc = bucketPoIds.length ? await enqueueConvert(sb, {
        companyId: activeCompanyId(c),
        op: 'po_to_gr',
        from: bucketPoIds.map((id) => ({ table: 'purchase_orders' as const, keyCol: 'id', key: id })),
        to: { table: 'grns', keyCol: 'id', key: h.id },
        docType: 'GR',
        docNo: h.grn_number,
        docId: h.id,
        createdBy: c.get('houzsUser')?.id ?? null,
    }) : null;
    const postFailReason = postRes.ok ? undefined : postRes.reason;
    const bucketMovementErrors = postRes.ok ? postRes.movementErrors : undefined;
    const bucketRecountError = postRes.ok ? postRes.recountError : undefined;
    created.push({
      id: h.id, grnNumber: h.grn_number,
      purchaseOrderId: bucket.primaryPoId, poNumber: [...bucket.poNumbers].join(', '),
      lineCount: bucket.lines.length,
      posted: postRes.ok,
      ...(postFailReason ? { postError: postFailReason } : {}),
      ...(bucketMovementErrors?.length ? { movementErrors: bucketMovementErrors } : {}),
      ...(bucketRecountError ? { recountError: bucketRecountError } : {}),
      // PER BUCKET: each bucket IS its own receipt, with its own gaps.
      ...(bucketAc?.problems.length ? { acNotSent: bucketAc.problems } : {}),
    });
  }

  // A bucket refused for zero cost surfaces the offending lines, same shape the
  // single-doc paths return. Reported before the over-receipt 409 only because
  // a missing cost is the one the operator can fix from the paperwork in hand.
  if (zeroCostRefusal) {
    return refuseZeroCostReceipt(c, { ...zeroCostRefusal, created }, { nothingWritten: created.length === 0 });
  }

  // If any bucket over-received (race), surface a 409 with the add-line error
  // shape. Buckets that received cleanly were already committed + reported.
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

mountHoldRoute(grns, 'grn'); // the mig-0324 MARKER, never `status` — routes/document-hold-routes.ts

/* ── PATCH /:id/cancel — cancel a GRN + reverse its receipt ─────────────────
   Commander 2026-05-29 — the GRN module is a Confirmed-clone of the PO module,
   including a Cancel action. Cancelling a GRN:
     1. Sets status='CANCELLED' (idempotent — already-cancelled echoes back).
     2. Reverses the inventory IN: writes an OUT movement per line for
        qty_accepted (negating the original IN that postGrnAndRollup wrote).
     3. Decrements each linked PO item's received_qty by qty_accepted (clamp ≥0)
        and re-evaluates the parent PO status (any received remaining →
        PARTIALLY_RECEIVED, else back to SUBMITTED).
   Steps 2+3 are best-effort (mirrors postGrnAndRollup's best-effort write) — a
   movement/rollback failure does not un-cancel the GRN.
   NOTE: grns has no cancelled_at column, so we set status + updated_at only. */
/* Second GRN route in the PG command txn: the CANCELLED flip, the reversing
   stock OUT, the rack reversal, the audit rows, the AutoCount cancel and the
   allocation request commit together or not at all. 503s without DATABASE_URL
   by design. `sb` is the TRANSACTIONAL client - the body must not reach for
   c.get('supabase'). The body stays INSIDE the route on purpose: several checks
   scan grns.ts by route block, and hoisting it to a named handler moved it out
   of their sight. docs/modules/grn.md 7c. */
grns.patch('/:id/cancel', async (c) => runScmPgCommand(c, async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the pg command client is a PostgREST-shaped shim, not a SupabaseClient; typing it honestly needs schema.pg.ts to cover the SCM tables (drizzle-kit pull), the upstream fix ci.yml's lint job names. Same shape as the line DELETE below.
  sb: any,
) => {
  /* Surfaced in the response, like the POST path's movementErrors/recountError.
     The GRN stays CANCELLED either way; what changes is that a failed reversal
     or recount no longer reports a clean 200. */
  const cancelErrors: string[] = [];
  const id = c.req.param('id');
  const user = c.get('user');

  /* Cancelling reverses stock and re-opens a PO, so it must never reach another
     company's receipt. Same strict pattern as POST /:id/post above: refuse an
     unresolved company outright, then pin every read AND every status flip. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return refuseWithoutWriting(c, co.refusal, 409);

  // Read → guard → update → reverse (mirrors PO cancel's split-to-avoid-PGRST116).
  const { data: cur, error: readErr } = await scopeToCompanyId(sb.from('grns')
    .select('id, status, grn_number, warehouse_id')
    .eq('id', id), co.companyId).maybeSingle();
  if (readErr) return refuseWithoutWriting(c, { error: 'load_failed', reason: readErr.message }, 500);
  if (!cur) return refuseWithoutWriting(c, NOT_THIS_COMPANY, 404);
  const head = cur as { id: string; status: string; grn_number: string; warehouse_id: string | null };
  // Idempotent — already cancelled, echo back without re-reversing.
  if (head.status === 'CANCELLED') {
    const { data } = await scopeToCompanyId(sb.from('grns').select(HEADER).eq('id', id), co.companyId).maybeSingle();
    return c.json({ grn: data ?? { id, status: 'CANCELLED' } });
  }

  /* Ahead of the DRAFT short-circuit below, not just the main path: that branch
     flips status to CANCELLED itself, so a pre-flight placed after it would let
     a draft be voided with no record. Both exits record a CANCEL, so both are
     covered by this one probe. */
  const pf = await assertAuditWritable(sb, { entityType: 'GRN', entityId: id, action: 'CANCEL', companyId: activeCompanyId(c) });
  if (!pf.ok) return refuseWithoutWriting(c, auditUnavailableBody(), 409);

  /* LEAK GUARD (CRITICAL): a DRAFT GRN committed NOTHING (no inventory IN, no
     PO received-rollup), so cancelling one must NOT reverse anything — the
     inventory OUT + PO recount below would over-reverse (drive stock negative /
     wrongly re-open a PO). Short-circuit: just flip DRAFT → CANCELLED. */
  if (head.status === 'DRAFT') {
    const { data } = await scopeToCompanyId(sb.from('grns')
      .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'DRAFT'), co.companyId).select(HEADER).maybeSingle();
    /* Still recorded even though nothing was reversed: the document existed and
       someone voided it, and the note is what tells a reader why no stock moved. */
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
    return c.json({ grn: data ?? { id, status: 'CANCELLED' } });
  }

  // GRN child-lock: can't cancel a GRN that has a downstream PI/PR — the child
  // must be deleted first (unified model, migration 0106).
  const childLock = await grnHasDownstream(sb, id);
  if (childLock) return refuseWithoutWriting(c, childLock, 409);

  // Load the GRN lines once — needed by the downstream-consumption guard BELOW
  // and by both reversals further down.
  const { data: lines } = await sb.from('grn_items')
    .select('purchase_order_item_id, qty_accepted, item_code, material_name, unit_price_sen, item_group, variants')
    .eq('grn_id', id);
  const lineList = (lines ?? []) as Array<{
    purchase_order_item_id: string | null; qty_accepted: number;
    item_code: string; material_name: string | null; unit_price_sen: number | null;
    item_group?: string | null; variants?: VariantAttrs | null;
  }>;

  // Bug #2 — block the cancel if the received stock was already consumed
  // downstream (reversing it out would drive on-hand negative + corrupt COGS).
  const consumedLock = await grnReverseWouldGoNegative(sb, head.warehouse_id, lineList);
  if (consumedLock) return refuseWithoutWriting(c, consumedLock, 409);

  /* Bug #3/#11 — ATOMIC single ACTIVE→CANCELLED transition. The conditional
     UPDATE excludes CANCELLED so two concurrent cancels race on the row and
     only ONE flips it (the other gets no row back → idempotent no-op), so the
     inventory reversal + PO recount below run exactly once, never double. */
  const { data: updRow, error: updErr } = await scopeToCompanyId(sb.from('grns')
    .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
    .eq('id', id).neq('status', 'CANCELLED'), co.companyId).select('id').maybeSingle();
  if (updErr) return c.json({ error: 'cancel_failed', reason: updErr.message }, 500);
  if (!updRow) {
    // Lost the race — a concurrent cancel already flipped it. Echo idempotently.
    const { data } = await scopeToCompanyId(sb.from('grns').select(HEADER).eq('id', id), co.companyId).maybeSingle();
    return c.json({ grn: data ?? { id, status: 'CANCELLED' } });
  }

  /* Recorded immediately after the ATOMIC flip won the race — the losing
     concurrent cancel returned above, so exactly one CANCEL row exists per GRN.
     Placed BEFORE the best-effort reversals rather than after: those are wrapped
     in catch-and-continue blocks, and a cancel whose reversal silently failed
     must still leave a record that the cancel happened. */
  await recordEntityAudit(sb, {
    entityType: 'GRN',
    entityId: id,
    entityDocNo: head.grn_number,
    action: 'CANCEL',
    actor: c.get('houzsUser'),
    companyId: activeCompanyId(c),
    statusSnapshot: 'CANCELLED',
    note: `Reversing receipt of ${lineList.length} line(s)`,
    fieldChanges: compactChanges([
      ...statusChange(head.status, 'CANCELLED'),
      fieldChange('warehouseId', null, head.warehouse_id),
      fieldChange('qtyReversed', null, lineList.reduce((s, l) => s + Number(l.qty_accepted ?? 0), 0)),
    ]),
  });

  // (a) Inventory OUT per line — negate the original GRN IN. Best-effort.
  /* Set only where the reversal was actually attempted, so the DURABLE enqueue
     below can sit OUTSIDE this best-effort catch and still fire on exactly the
     condition the old inline recompute did. */
  let stockReversed = false;
  try {
    const warehouseId = head.warehouse_id ?? (await defaultWarehouseId(sb, activeCompanyId(c)));
    if (warehouseId) {
      const batchByItem = await resolvePoBatchByItem(sb, lineList.map((it) => it.purchase_order_item_id));
      const movements = buildGrnCancelReversals(lineList, batchByItem, {
        warehouseId, grnId: id, grnNumber: head.grn_number, performedBy: user.id,
      });
      if (movements.length > 0) {
        /* CHECKED. writeMovements NEVER THROWS — it logs and returns {ok:false}
           — so the enclosing best-effort catch caught nothing, and discarding the
           result left phantom received stock on the shelf behind a 200. The
           CANCEL audit row records the cancel, never the failed reversal. */
        const wrote = await writeMovements(sb, movements, activeCompanyId(c));
        if (!wrote.ok) {
          cancelErrors.push(
            `Stock reversal FAILED (${movements.length} row(s)): ${wrote.reason ?? 'unknown'}. ` +
            'The GRN is cancelled but its received stock is still on hand — run /inventory/reconcile.',
          );
        }
        stockReversed = true;
      }
    }
  } catch { /* best-effort: never un-cancel on a movement failure */ }
  /* DURABLE: GRN cancel pulled stock back out, so other READY SOs that relied
     on it may need to regress. The request commits with the OUT above, and it
     is NOT inside that best-effort catch — a failed enqueue must fail the
     cancel, because "stock pulled back, allocation never re-walked" is the
     exact state this transaction exists to make unreachable. grn.md 7c. */
  if (stockReversed) await scheduleStockAllocationAfterCommand(c, sb, `grn-cancel:${id}`);

  // (a2) Physical rack reversal — pull every rack item this GRN placed +
  //      log a STOCK_OUT, mirroring the inventory OUT above. Best-effort.
  try {
    const { reverseGrnRacks } = await import('../lib/grn-rack-sync');
    await reverseGrnRacks(sb, id, head.grn_number, user.id);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[grn-rack] reverse failed:', e); }

  // (b) Recount received_qty on each linked PO item from live GRN lines — this
  //     cancelled GRN's lines now drop out, auto-releasing the PO + re-evaluating
  //     its status.
  /* recomputePoReceived RETURNS its outcome and never throws, so discarding the
     result — and relying on the catch — left POs holding received goods with
     received_qty untouched, traced only by a console line nobody keeps. */
  try {
    const recount = await recomputePoReceived(sb, lineList.map((it) => it.purchase_order_item_id));
    if (!recount.ok) {
      cancelErrors.push(
        `PO recount FAILED: ${recount.reason ?? 'unknown'}. The GRN is cancelled but its PO lines ` +
        'still show the goods as received — reopen and re-save the PO, or run the recount.',
      );
    }
  } catch (e) {
    cancelErrors.push(`PO recount threw: ${(e as Error)?.message ?? 'unknown'}`);
  }

  const { data } = await sb.from('grns').select(HEADER).eq('id', id).maybeSingle();

  /* ERP -> AutoCount cancel. Reached only for a GRN the downstream lock let
     through (grnHasDownstream, checked above) — the same rule AutoCount
     applies, so this can never ask it to cancel an invoiced receipt. */
  await enqueueCancel(sb, {
    companyId: activeCompanyId(c),
    docType: 'GR',
    docNo: head.grn_number ?? id,
    docId: id,
    self: { table: 'grns', keyCol: 'id', key: id },
    createdBy: c.get('houzsUser')?.id ?? null,
  });

  return c.json({ grn: data ?? { id, status: 'CANCELLED' }, ...(cancelErrors.length ? { cancelErrors } : {}) });
}));

/* ════════════════════════════════════════════════════════════════════════
   GRN PO-clone CRUD (PATCH header + line add / edit / delete) — mirrors the
   PO detail page's draft-mode editing (apps/api/src/routes/mfg-purchase-orders.ts).
   The editable line quantity is qty_received; line_total_sen =
   qty_received * unit_price_sen - discount_sen; recomputeGrnTotals rolls the
   header subtotal/total. GRN lines hold no SO quota → delete needs no release.
   ════════════════════════════════════════════════════════════════════════ */

/* ── PATCH /:id — header update (mirror PO's PATCH /:id) ── */
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

  /* Multi-company: the service-role client bypasses RLS, so the app-level
     predicate is the ONLY isolation. This PATCH's read + UPDATE were unscoped
     until the 2026-08-10 audit hardened them (the GET was done first). */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return refuseWithoutWriting(c, co.refusal, 409);

  /* GRN_AUDIT_SELECT (not just the relocation's columns): this row is also the
     BEFORE half of every audit from->to pair, and the relocation reads its
     warehouse / status / rate out of the same row. One read serves all three. */
  const { data: beforeRow } = await scopeToCompanyId(sb.from('grns')
    .select(GRN_AUDIT_SELECT).eq('id', id), co.companyId).maybeSingle();
  if (!beforeRow) return refuseWithoutWriting(c, NOT_THIS_COMPANY, 404);
  const before = (beforeRow ?? {}) as unknown as Record<string, unknown>;

  /* Header inherited-field lock (owner 2026-08-20, §8 GAP-1; grn-inherited-lock.ts):
     supplier + costing basis freeze once a live PI/PR exists. Runs before the
     relocation block so a locked edit writes nothing. */
  const grnHeaderLocked = grnHeaderInheritedChanges(body, before, GRN_AUDIT_FIELDS);
  if (grnHeaderLocked.length > 0 && (await grnHasDownstream(sb, id))) {
    return refuseWithoutWriting(c, grnHeaderInheritedRefusal(grnHeaderLocked), 409);
  }

  /* Before the relocation block below, which writes inventory movements — those
     are a real stock change, so the last honest refusal point is above them, not
     above the header UPDATE further down. */
  const pf = await assertAuditWritable(sb, {
    entityType: 'GRN', entityId: id, action: 'UPDATE',
    companyId: (before.company_id as number | null) ?? activeCompanyId(c),
  });
  if (!pf.ok) return refuseWithoutWriting(c, auditUnavailableBody(), 409);

  /* Warehouse relocation — a posted GRN pushed its IN stock into the OLD
     warehouse, so a warehouse change must physically move it: OUT of old + IN to
     new, same cost + source-PO batch. Same downstream-consumption guard as cancel
     (block if the old-warehouse stock was already shipped); best-effort alloc
     re-walk after. */
  if (body.warehouseId !== undefined) {
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
      // Guard: can't relocate stock that's already gone from the old warehouse.
      const consumedLock = await grnReverseWouldGoNegative(sb, oldWh, lineList);
      if (consumedLock) return refuseWithoutWriting(c, consumedLock, 409);
      const batchByItem = await resolvePoBatchByItem(sb, lineList.map((it) => it.purchase_order_item_id));

      /* THE ORIGINAL LANDED COST, read back from this GRN's own IN movements.
         Pricing the IN below at `toMyrSen(unit_price_sen, rate)` — the BASE
         cost — while the receipt opened its lots at the LANDED cost (base +
         allocated freight) consumes at landed and re-opens at base, so the
         capitalised freight leaves inventory value permanently; on a container
         GRN that is the whole freight bill. Re-reading the movement beats
         recomputing the allocation: it is the basis those units actually entered
         at, and it survives a change to the allocation rule. */
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
          const variant_key = computeVariantKey(it.item_group, it.variants ?? null);
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
              // Landed cost from the original IN; base only when there is no
              // prior movement to read (a pre-0154 GRN, or a zero-cost line).
              unit_cost_sen: landedByBucket.get(`${it.item_code}::${variant_key}`)
                ?? toMyrSen(Number(it.unit_price_sen ?? 0), c0?.exchange_rate ?? 1),
              notes: 'GRN warehouse changed — into new warehouse',
            },
          ];
        });
      if (movements.length > 0) {
        try {
          await writeMovements(sb, movements, activeCompanyId(c));
          /* Oversell retro-cost (0154) — the relocate opens lots in the NEW
             warehouse, so a prior "ship anyway" DO that went out at RM0 there can
             now be costed from them. Wired 2026-07-29; until then only the GRN
             POST reconciled, so the edit paths that also open lots were blind to
             prior shorts (COE §2). Best-effort. */
          await reconcileUncostedAfterIn(sb, movements, user?.id ?? null);
          try {
            const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
            await recomputeSoStockAllocation(sb);
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
  // currency is stored upper-cased like the create paths.
  if (updates.currency !== undefined) updates.currency = normalizeCurrency(updates.currency);
  /* R2 EDIT-PATH GUARD (2026-07-30) — flipping this GRN to a foreign currency with no
     rate anywhere would leave exchange_rate at the 1 it holds because the GRN used to
     be ringgit, and capitalise the raw foreign figure into the lot. The create
     boundary has been guarded since the R2 fix; this is the same hole reached by
     editing. Fires ONLY on a real flip to a non-MYR code — an all-MYR GRN and any
     edit that does not touch the currency are untouched. */
  {
    const rateGuard = await assertForeignRatePatchable(sb, {
      fromCurrency: before.currency,
      toCurrency: updates.currency,
      operatorRate: body.exchangeRate,
      docLabel: 'GRN',
    });
    if (!rateGuard.ok) return c.json(rateGuard.body, 422);
  }
  /* Migration 0082 — landed-cost basis. Normalise the enum on write. */
  let methodChanged = false;
  if (body.allocationMethod !== undefined) {
    updates.allocation_method = normalizeAllocationMethod(body.allocationMethod);
    methodChanged = true;
  }
  /* Migration 0082 — keep exchange_rate consistent with the effective currency
     (mirrors PI's PATCH). Rate explicitly sent → normalise against the effective
     currency (finite > 0, else 1); currency flipped to MYR without a rate → reset
     to 1; neither → leave untouched. */
  let rateChanged = false;
  if (body.exchangeRate !== undefined || updates.currency !== undefined) {
    let effectiveCurrency = updates.currency as string | undefined;
    if (effectiveCurrency === undefined) {
      /* Taken from the row already read above — the round-trip this used to make
         read the same column of the same row. */
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
  /* maybeSingle, not single: the company predicate can legitimately match zero
     rows, and `single()` would turn that into a 500 rather than the 404 that
     tells the truth. */
  if (!data) return c.json(NOT_THIS_COMPANY, 404);

  /* Diff the NORMALISED values actually written (`updates`), not the raw body —
     currency is upper-cased, exchange_rate is derived from it and the allocation
     method is enum-normalised, so a log of what the client asked for rather than
     what was stored is a log of the wrong thing. */
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

  /* When the rate or the landed-cost basis moved, the lot was booked at the OLD
     figures. Re-allocate the freight (allocated_charge_sen) then recost the
     lots → consumptions → DO/SI so the landed MYR cost reflects the new rate /
     method. Best-effort; a no-op for an MYR GRN with no service lines. */
  if (rateChanged || methodChanged) {
    try {
      await reallocateGrnCharges(sb, id, activeCompanyId(c) ?? null);
      await recostFromGrn(sb, id);
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[grn-patch] re-alloc/recost failed:', id, e); }
  }
  await queueAcGrnEdit(c, sb, id);
  return c.json({ grn: data });
});

/* ── POST /:id/items — add one grn_item. qty maps to qty_received. ── */
grns.post('/:id/items', async (c) => {
  const grnId = c.req.param('id');
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

  // GRN child-lock: a GRN with any downstream PI/PR is read-only.
  const childLock = await grnHasDownstream(sb, grnId);
  if (childLock) return refuseWithoutWriting(c, childLock, 409);
  /* Audit 2026-06-10 #10 — line CRUD on a CANCELLED/CLOSED GRN was a silent
     stock door (an added line's IN never reverses again). Mirror prLineLock. */
  const { data: grnGate } = await sb.from('grns').select('status').eq('id', grnId).maybeSingle();
  const grnGateStatus = ((grnGate as { status?: string } | null)?.status ?? '').toUpperCase();
  if (grnGateStatus === 'CANCELLED' || grnGateStatus === 'CLOSED') {
    return refuseWithoutWriting(c, { error: 'grn_locked',
      message: `This GRN is ${grnGateStatus} — its lines can no longer be changed.` }, 409);
  }

  /* Non-finite guard — the clamp below cannot catch NaN (Math.max(0, NaN) is
     NaN). On a GRN this is worse than a bad total: qty_received also drives the
     over-receipt headroom check and the inventory movement, so a NaN qty writes
     a NaN into stock. */
  /* The add-a-line half of the same back door as the create path: receiving
     THIS PO's own material with no purchase_order_item_id takes the stock in
     while the PO's received_qty stays put, so it can be received again. */
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
  // Audit (ported from 2990 20190257) — clamp like the PO create path (negative-money guard).
  const lineTotal = Math.max(0, (qtyReceived * unitPriceSen) - discountSen);

  /* Over-receipt guard — a PO-linked added line can't accept more than the PO
     line's remaining (qty - received_qty). received_qty already counts every
     other live GRN line for this PO item, so remaining is the true headroom.
     Manual (no PO link) lines are uncapped. Same 409 the From-PO flows use. */
  const addLinePoItemId = (it.purchaseOrderItemId as string) ?? null;
  if (addLinePoItemId) {
    const xl = await assertSourceLinesInCompany(sb, c, 'purchase_order_items', [addLinePoItemId]);
    if (!xl.ok) return refuseWithoutWriting(c, xl.body, xl.status);
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
    // GRN line money meaning: qty = qty_received; accepted mirrors received.
    qty_received: qtyReceived,
    qty_accepted: qtyReceived,
    qty_rejected: 0,
    unit_price_sen: unitPriceSen,
    discount_sen: discountSen,
    line_total_sen: lineTotal,
    unit_cost_sen: Number(it.unitCostSen ?? 0),
    notes: (it.notes as string) ?? null,
    /* variant fields (mirror PO line) */
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
    /* migration 0280 — see the create path: this insert is a whitelist too. */
    ...zeroCostAckColumns(it, user.id),
  };
  /* co.companyId, not activeCompanyId(c): the parent GRN was proved above, so
     the line is stamped with the header's owner, not with the switcher. */
  const { data, error } = await sb.from('grn_items').insert({ ...row, company_id: co.companyId }).select(ITEM).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);

  /* Bug #3/#11 — POST-INSERT over-receipt verification. The pre-check above is a
     read-then-write race: two concurrent adds against the same PO line can each
     read remaining=10 and both insert → 20 received. After committing our row we
     re-read the PO line's qty + the LIVE sum of qty_accepted across all
     non-cancelled GRN lines for it; if that now exceeds qty, OUR insert is the
     one that broke the cap → delete it + 409. (Deterministic compensating guard;
     a fully DB-atomic claim needs an RPC — see report.) */
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

  /* UPDATE, not CREATE: the entity is the GRN and it already existed. The line's
     identity travels in the note and as the to-value of every pair. Recorded
     after the over-receipt rollback above, so a line that was inserted and then
     deleted by the race guard leaves no "added" row behind it. */
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

  /* LEAK GUARD: a DRAFT GRN commits NOTHING on line-add — no inventory IN, no PO
     received-rollup. The row's qty stays correct; the full IN + PO rollup happen
     once at confirm (postGrnAndRollup re-reads all live lines). Skip the
     per-line rollup/movement below for a draft. */
  const addedPoiId = (it.purchaseOrderItemId as string) ?? null;
  if (grnGateStatus !== 'DRAFT') {
  // A line added to a POSTED GRN must roll up exactly like one created at post
  // time, otherwise its PO line stays "outstanding" (re-appears in the convert
  // picker) and its stock never enters inventory — yet DELETE still writes an
  // OUT to reverse it, driving inventory negative. Mirror postGrnAndRollup for
  // this one line so add/edit/delete all converge. Best-effort throughout.
  try { await recomputePoReceived(sb, [addedPoiId]); } catch { /* best-effort */ }
  if (qtyReceived > 0) {
    try {
      const { data: grnHeader } = await sb.from('grns')
        .select('grn_number, warehouse_id, exchange_rate').eq('id', grnId).maybeSingle();
      const warehouseId = (grnHeader as { warehouse_id: string | null } | null)?.warehouse_id
        ?? (await defaultWarehouseId(sb, activeCompanyId(c)));
      // Migration 0082 — convert the line's own-currency unit price to MYR at the
      // GRN's rate (no-op for an MYR GRN).
      const addLineRate = (grnHeader as { exchange_rate?: string | number | null } | null)?.exchange_rate ?? 1;
      if (warehouseId) {
        // Migration 0120 — stamp this added line's IN with its source PO batch.
        const addedPoItemId = (it.purchaseOrderItemId as string) ?? null;
        const batchByItem = await resolvePoBatchByItem(sb, [addedPoItemId]);
        await writeMovements(sb, [{
          movement_type: 'IN' as const,
          warehouse_id: warehouseId,
          item_code: String(it.itemCode),
          variant_key: computeVariantKey((it.itemGroup as string) ?? null, (it.variants as VariantAttrs | null) ?? null),
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
        /* Oversell retro-cost (0154) — a line added to a POSTED GRN opens a lot
           outside postGrnAndRollup, so it needs the same reconcile the post does.
           Wired 2026-07-29 (COE §2). Best-effort. */
        await reconcileUncostedAfterIn(sb, [{
          movement_type: 'IN',
          warehouse_id: warehouseId,
          item_code: String(it.itemCode),
          variant_key: computeVariantKey((it.itemGroup as string) ?? null, (it.variants as VariantAttrs | null) ?? null),
          qty: qtyReceived,
        }], user.id);
        /* New stock landed → re-walk SO allocation. */
        try {
          const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
          await recomputeSoStockAllocation(sb);
        } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-grn-line-add failed:', e); }
      }
    } catch { /* best-effort */ }
  }
  } // end non-DRAFT line-add rollup/movement guard
  await queueAcGrnEdit(c, sb, grnId, [], ((data as { id?: unknown } | null)?.id ? [String((data as { id?: unknown }).id)] : []));
  return c.json({ item: data }, 201);
});

/* ── PATCH /:id/items/:itemId — partial line update. qty → qty_received. ── */
grns.patch('/:id/items/:itemId', async (c) => {
  const grnId = c.req.param('id'); const itemId = c.req.param('itemId');
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

  /* A line edit moves stock and money, so it gets the same strict company gate
     as the header writes: refuse an unresolved company, and pin the GRN gate
     read AND the line UPDATE to it. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return refuseWithoutWriting(c, co.refusal, 409);

  // GRN child-lock: a GRN with any downstream PI/PR is read-only.
  const childLock = await grnHasDownstream(sb, grnId);
  if (childLock) return refuseWithoutWriting(c, childLock, 409);
  /* Audit 2026-06-10 #10 — line CRUD on a CANCELLED/CLOSED GRN was a silent
     stock door (an added line's IN never reverses again). Mirror prLineLock. */
  const { data: grnGate } = await scopeToCompanyId(sb.from('grns').select('status, purchase_order_id').eq('id', grnId), co.companyId).maybeSingle();
  if (!grnGate) return refuseWithoutWriting(c, NOT_THIS_COMPANY, 404);
  const grnGateStatus = ((grnGate as { status?: string } | null)?.status ?? '').toUpperCase();
  if (grnGateStatus === 'CANCELLED' || grnGateStatus === 'CLOSED') {
    return refuseWithoutWriting(c, { error: 'grn_locked',
      message: `This GRN is ${grnGateStatus} — its lines can no longer be changed.` }, 409);
  }

  /* Audited columns + the ones the stock/money logic reads; also the BEFORE half
     of every from->to audit pair. `variants` / `purchase_order_item_id` are
     business-logic only (not in GRN_LINE_AUDIT_FIELDS — variants render into the
     audited description2). */
  const { data: prevRow } = await sb.from('grn_items')
    .select(GRN_LINE_AUDIT_SELECT + ', variants, purchase_order_item_id')
    .eq('id', itemId).maybeSingle();
  if (!prevRow) return refuseWithoutWriting(c, { error: 'not_found' }, 404);
  /* Cast through `unknown`: a concatenated-string .select() infers as
     GenericStringError on the scm client, so the row shape only exists after
     this (project-wide pattern). */
  const prev = prevRow as unknown as Record<string, unknown>;

  // The editable quantity is qty_received (also keep qty_accepted in lockstep).
  const prevAccepted = (prev as { qty_accepted: number }).qty_accepted ?? 0;
  /* Non-finite guard — see POST /:id/items. A NaN here would flow into the
     over-receipt headroom comparison (which NaN always fails silently, since
     every comparison against NaN is false) and into the posted-GRN inventory
     delta below. */
  const parsedQty = parseLineNumbers({
    /* `!== undefined`, NOT `??` — the two differ on an explicit null, and this
       path's existing contract is that null coerces to 0 rather than keeping
       the stored qty. Preserved exactly; this guard is about NaN, not semantics. */
    qty: { value: it.qty !== undefined ? it.qty : (prev as { qty_received: number }).qty_received },
  });
  if (!parsedQty.ok) return refuseWithoutWriting(c, invalidLineNumberBody(parsedQty.invalid), 400);
  const qtyReceived = parsedQty.nums.qty as number;

  /* Over-receipt guard on edit — a PO-linked line can't be raised past the PO
     line's headroom; stored received_qty already includes this line, so add its
     old qty back before comparing. Manual (no PO link) lines are uncapped. */
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

  // EDIT half of the back door — cap + recount are both gated on poItemId.
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
  // Audit (ported from 2990 20190257) — clamp like the PO create path (negative-money guard).
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
  /* migration 0280 — the zero-cost gate's escape hatch, and the ONLY route by
     which an operator clears the 409 without inventing a price. Deliberately
     NOT in the from->to loop above: the tick also stamps who and when, and the
     three columns must move together or the audit trail lies. */
  Object.assign(updates, zeroCostAckColumns(it, user.id));

  /* description2 is server-owned: recompute from effective itemGroup + variants. */
  {
    const effGroup = (it.itemGroup ?? (prev as { item_group?: string }).item_group) as string | null | undefined;
    const effVariants = (it.variants ?? (prev as { variants?: unknown }).variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  /* Bug #7 — emit the inventory delta for a posted GRN line qty edit. Before
     this, editing qty changed only the row + header money, NOT stock, leaving
     ghost stock (receive 10 → edit to 4 → on-hand still 10 → a later cancel
     reverses only 4 → +6 ghost). qty_accepted is the inventory-relevant qty and
     moves in lockstep with qty_received here, so the delta is newAccepted −
     prevAccepted. Variant-aware (bug C), cost follows the line's unit price.

     When item_group / variants ALSO change, the stock bucket changes too, so a
     plain delta would mis-bucket: reverse the FULL old bucket + re-add the FULL
     new bucket. When only qty changes, emit a single IN (delta>0) / OUT (delta<0).

     We GUARD then WRITE: any OUT we'd write (qty reduction, or the old-bucket
     reversal on a variant change) must not drive on-hand negative — that means
     the stock was already consumed downstream (bug #2). Guard runs BEFORE the
     row UPDATE so a block leaves the row untouched (no undo needed). */
  const newAccepted = updates.qty_accepted as number;
  const oldGroup = (prev as { item_group?: string | null }).item_group ?? null;
  const oldVariants = (prev as { variants?: VariantAttrs | null }).variants ?? null;
  const effGroup = (updates.item_group !== undefined ? (updates.item_group as string | null) : oldGroup);
  const effVariants = (updates.variants !== undefined ? (updates.variants as VariantAttrs | null) : oldVariants);
  const oldKey = computeVariantKey(oldGroup, oldVariants);
  const newKey = computeVariantKey(effGroup, effVariants);
  const matCode = (updates.item_code as string | undefined) ?? (prev as { item_code: string }).item_code;
  const matName = (updates.material_name as string | undefined) ?? (prev as { material_name: string | null }).material_name;
  const bucketChanged = oldKey !== newKey;
  const qtyChanged = newAccepted !== prevAccepted;
  /* LEAK GUARD: a DRAFT GRN has no committed stock, so editing a line writes NO
     inventory delta (and runs no on-hand guard) — the row + header money update,
     and the full IN is written once at confirm. inventoryChange stays false for
     a draft so the movement block + grnReverseWouldGoNegative guard are skipped. */
  const isDraftGrn = grnGateStatus === 'DRAFT';
  const inventoryChange = !isDraftGrn && (qtyChanged || bucketChanged) && (prevAccepted > 0 || newAccepted > 0);

  // Resolve warehouse once (needed by both the guard and the movement write).
  let editWarehouseId: string | null = null;
  let editGrnNo = grnId;
  let editRate: string | number | null = 1;
  if (inventoryChange) {
    const { data: grnHead } = await sb.from('grns').select('grn_number, warehouse_id, exchange_rate').eq('id', grnId).maybeSingle();
    editWarehouseId = (grnHead as { warehouse_id: string | null } | null)?.warehouse_id
      ?? (await defaultWarehouseId(sb, activeCompanyId(c)));
    editGrnNo = (grnHead as { grn_number: string } | null)?.grn_number ?? grnId;
    // Migration 0082 — convert the line unit price to MYR at the GRN's rate.
    editRate = (grnHead as { exchange_rate?: string | number | null } | null)?.exchange_rate ?? 1;

    // GUARD (bug #2) — pre-check any OUT against current on-hand BEFORE writing.
    if (editWarehouseId) {
      const guardLines: Array<{ qty_accepted: number; item_code: string; item_group?: string | null; variants?: VariantAttrs | null }> = [];
      if (bucketChanged) {
        if (prevAccepted > 0) guardLines.push({ qty_accepted: prevAccepted, item_code: matCode, item_group: oldGroup, variants: oldVariants });
      } else if (newAccepted < prevAccepted) {
        guardLines.push({ qty_accepted: prevAccepted - newAccepted, item_code: matCode, item_group: effGroup, variants: effVariants });
      }
      const consumedLock = await grnReverseWouldGoNegative(sb, editWarehouseId, guardLines);
      if (consumedLock) return refuseWithoutWriting(c, consumedLock, 409); // row untouched — safe
    }
  }

  const pf = await assertAuditWritable(sb, { entityType: 'GRN', entityId: grnId, action: 'UPDATE', companyId: activeCompanyId(c) });
  if (!pf.ok) return refuseWithoutWriting(c, auditUnavailableBody(), 409);

  const { error } = await scopeToCompanyId(sb.from('grn_items').update(coerceEmptyDates(updates)).eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);

  /* Diff `updates` — the EFFECTIVE values written — against the stored row.
     qty / price / discount / line total are recomputed above from the body OR
     the prior row, so the body alone would not say what changed. The camel names
     are the ones AUDIT_FINANCE_FIELDS gates (unitCostSen), so a non-finance
     reader of the history is stripped exactly as on the detail. */
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

  // Now write the inventory delta (best-effort, mirroring add/delete-line).
  if (inventoryChange && editWarehouseId) {
    const warehouseId = editWarehouseId;
    /* Carry the line's dye-lot batch (= its source PO number, like add/delete/
       cancel do) so a batched sofa edit moves the SAME lot, not a plain-FIFO one.
       Batch is per-PO so it applies to all four delta movements below. */
    const editPoItemId = (prev as { purchase_order_item_id: string | null }).purchase_order_item_id;
    const editBatch = editPoItemId
      ? ((await resolvePoBatchByItem(sb, [editPoItemId])).get(editPoItemId) ?? null)
      : null;
    const batchTag = editBatch ? { batch_no: editBatch } : {};
    const movements: Array<Parameters<typeof writeMovements>[1][number]> = [];
    if (bucketChanged) {
      if (prevAccepted > 0) movements.push({
        movement_type: 'OUT', warehouse_id: warehouseId, item_code: matCode,
        variant_key: oldKey, product_name: matName, qty: prevAccepted,
        source_doc_type: 'GRN', source_doc_id: grnId, source_doc_no: editGrnNo,
        performed_by: user.id, notes: 'GRN line edited — variant changed, reversing old bucket', ...batchTag,
      });
      if (newAccepted > 0) movements.push({
        movement_type: 'IN', warehouse_id: warehouseId, item_code: matCode,
        variant_key: newKey, product_name: matName, qty: newAccepted, unit_cost_sen: toMyrSen(unit, editRate),
        source_doc_type: 'GRN', source_doc_id: grnId, source_doc_no: editGrnNo,
        performed_by: user.id, notes: 'GRN line edited — variant changed, re-adding new bucket', ...batchTag,
      });
    } else {
      const delta = newAccepted - prevAccepted;
      if (delta > 0) movements.push({
        movement_type: 'IN', warehouse_id: warehouseId, item_code: matCode,
        variant_key: newKey, product_name: matName, qty: delta, unit_cost_sen: toMyrSen(unit, editRate),
        source_doc_type: 'GRN', source_doc_id: grnId, source_doc_no: editGrnNo,
        performed_by: user.id, notes: 'GRN line qty edited — receiving delta', ...batchTag,
      });
      else if (delta < 0) movements.push({
        movement_type: 'OUT', warehouse_id: warehouseId, item_code: matCode,
        variant_key: newKey, product_name: matName, qty: -delta,
        source_doc_type: 'GRN', source_doc_id: grnId, source_doc_no: editGrnNo,
        performed_by: user.id, notes: 'GRN line qty edited — reversing delta', ...batchTag,
      });
    }
    if (movements.length > 0) {
      try {
        await writeMovements(sb, movements, activeCompanyId(c));
        /* Oversell retro-cost (0154) — a line edit that RAISES the accepted qty
           (or moves it to a new variant bucket) opens a lot, so a prior "ship
           anyway" DO that went out at RM0 here can now be costed from it. Wired
           2026-07-29 (COE §2). Reversing OUTs are filtered out. Best-effort. */
        await reconcileUncostedAfterIn(sb, movements, user.id);
        try {
          const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
          await recomputeSoStockAllocation(sb);
        } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-grn-line-edit failed:', e); }
      } catch { /* best-effort */ }
    }
  }

  await recomputeGrnTotals(sb, grnId);
  /* LEAK GUARD: skip the PO received-recount + recost for a DRAFT GRN — its lines
     don't count toward any PO receipt and no lots exist to re-cost yet. Both run
     once the draft is confirmed (postGrnAndRollup / future edits on the POSTED
     row). */
  if (!isDraftGrn) {
    // Editing qty_accepted changes how much the PO counts as received — recount it.
    try { await recomputePoReceived(sb, [(prev as { purchase_order_item_id: string | null }).purchase_order_item_id]); } catch { /* best-effort */ }
    // Costing B — when the GR price (or its variant bucket) was corrected and no PI
    // has superseded it yet, re-cost this GRN's lots → consumptions → movements →
    // DO → SI so a shipped order's margin reflects the fix in real time.
    const prevUnit = (prev as { unit_price_sen: number | null }).unit_price_sen ?? 0;
    const priceChanged = Number(unit) !== Number(prevUnit);
    if (priceChanged || bucketChanged) await recostFromGrn(sb, grnId);
  }
  await queueAcGrnEdit(c, sb, grnId);
  return c.json({ ok: true });
});

/* ── DELETE /:id/items/:itemId — remove a line + roll back its PO receipt. ──
   Deliverable 4 (migration 0106): reading the line's qty_accepted +
   purchase_order_item_id BEFORE delete, then after delete decrementing the PO
   item's received_qty by qty_accepted (clamp ≥0) and re-evaluating the parent
   PO status. This fixes the PO staying RECEIVED after a GRN line is removed.
   Blocked by the GRN child-lock (any downstream PI/PR). */
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

  // Same strict company gate as the line PATCH — a delete reverses stock too.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return refuseWithoutWriting(c, co.refusal, 409);

  // GRN child-lock: a GRN with any downstream PI/PR is read-only.
  const childLock = await grnHasDownstream(sb, grnId);
  if (childLock) return refuseWithoutWriting(c, childLock, 409);
  /* Audit 2026-06-10 #10 — line CRUD on a CANCELLED/CLOSED GRN was a silent
     stock door (an added line's IN never reverses again). Mirror prLineLock. */
  const { data: grnGate } = await scopeToCompanyId(sb.from('grns').select('status').eq('id', grnId), co.companyId).maybeSingle();
  if (!grnGate) return refuseWithoutWriting(c, NOT_THIS_COMPANY, 404);
  const grnGateStatus = ((grnGate as { status?: string } | null)?.status ?? '').toUpperCase();
  if (grnGateStatus === 'CANCELLED' || grnGateStatus === 'CLOSED') {
    return refuseWithoutWriting(c, { error: 'grn_locked',
      message: `This GRN is ${grnGateStatus} — its lines can no longer be changed.` }, 409);
  }

  // Read the line's PO link + accepted qty + variant/cost fields BEFORE deleting
  // so we can roll back the PO receipt AND reverse the inventory IN the GRN post
  // wrote for this line.
  /* Read the audited columns too — after the delete the audit row is the only
     remaining evidence of what was received on this line, and there is nothing
     left to join back to. */
  const { data: lineRow } = await sb.from('grn_items')
    .select(GRN_LINE_AUDIT_SELECT + ', purchase_order_item_id, variants')
    .eq('id', itemId).maybeSingle();
  /* Cast through `unknown` — see the note on the line PATCH's `prev`. */
  const line = (lineRow ?? null) as unknown as Record<string, unknown> | null;

  /* LEAK GUARD: a DRAFT GRN's line never wrote an inventory IN, so deleting it
     reverses NOTHING — skip the consumed-downstream guard (there's no committed
     stock to over-reverse). The post-delete OUT + PO recount below are likewise
     gated on !isDraftGrn. */
  const isDraftGrn = grnGateStatus === 'DRAFT';
  // Bug #2 — deleting a posted GRN line writes an OUT to reverse its receipt.
  // If that line's received stock was already consumed downstream the OUT would
  // drive on-hand negative + corrupt COGS, so block it. Resolve the GRN's
  // warehouse the same way the reversal below does.
  if (line && !isDraftGrn) {
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

  /* The audit row is the ONLY remaining evidence of this line once the delete
     lands, so refusing here matters more than anywhere else in this file. */
  const pf = await assertAuditWritable(sb, { entityType: 'GRN', entityId: grnId, action: 'UPDATE', companyId: activeCompanyId(c) });
  if (!pf.ok) return refuseWithoutWriting(c, auditUnavailableBody(), 409);

  /* The AutoCount key of the line this save REMOVES. Read BEFORE the delete:
     afterwards the row is gone and its DtlKey with it, and an edit that does not
     NAME the removal leaves the line live and outstanding in the account book. */
  const retire = await retiredLineOf(sb, 'grn_items', itemId);

  const { error } = await scopeToCompanyId(sb.from('grn_items').delete().eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);

  /* UPDATE, not DELETE: the entity is the GRN and it still exists. DELETE on
     this entity type would tell a reader the whole receipt was destroyed. The
     line is the from-value of every pair, to-value null. */
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

  /* LEAK GUARD: for a DRAFT GRN there is no committed receipt — skip BOTH the PO
     received-recount and the reversing inventory OUT (the draft never wrote an
     IN). Only the row delete + header-money recompute below apply. */
  if (line && !isDraftGrn) {
    const l = line as {
      qty_accepted: number; purchase_order_item_id: string | null;
      item_code: string; material_name: string | null; unit_price_sen: number | null;
      item_group?: string | null; variants?: VariantAttrs | null;
    };
    // (a) Recount the PO receipt for the removed line's source (best-effort).
    //     Skip manual lines with no purchase_order_item_id.
    try { await recomputePoReceived(sb, [l.purchase_order_item_id]); } catch { /* best-effort */ }

    // (b) Reverse the inventory IN the GRN post wrote for THIS line: a direct
    //     OUT of qty_accepted (the helper reverses the whole doc; for one line a
    //     per-line OUT is precise). GRN is NOT under a same-key UNIQUE index, so
    //     this lands; the FIFO trigger consumes the line's lot + computes COGS.
    //     Best-effort — a movement failure never blocks the delete.
    if ((l.qty_accepted ?? 0) > 0) {
      /* Same reason as the cancel route's flag: the enqueue below must not sit
         inside this best-effort catch. It did until 2026-08-20, and the comment
         beside it claimed the opposite. BUG-HISTORY 2026-08-20. */
      let stockReversed = false;
      try {
        const { data: grnHeader } = await sb.from('grns')
          .select('grn_number, warehouse_id').eq('id', grnId).maybeSingle();
        const warehouseId = (grnHeader as { warehouse_id: string | null } | null)?.warehouse_id
          ?? (await defaultWarehouseId(sb, activeCompanyId(c)));
        if (warehouseId) {
          const variantKey = computeVariantKey(l.item_group, l.variants ?? null);
          // Carry THIS line's own dye-lot batch (= its source PO number) so the
          // reversing OUT depletes the EXACT lot the receipt created. Resolved
          // deterministically from the line's purchase_order_item_id — not a
          // .limit(1) bucket lookup, which could grab a sibling line's batch when
          // two lines of the same product/variant came from different POs.
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
      } catch { /* best-effort */ }
      /* DURABLE: queues with the OUT above, and is NOT caught - a failed
         enqueue must fail the delete. docs/modules/grn.md 7c. */
      if (stockReversed) await scheduleStockAllocationAfterCommand(c, sb, `grn-line-delete:${grnId}`);
    }
  }

  await recomputeGrnTotals(sb, grnId);
  await queueAcGrnEdit(c, sb, grnId, retire);
  return c.body(null, 204);
}));
