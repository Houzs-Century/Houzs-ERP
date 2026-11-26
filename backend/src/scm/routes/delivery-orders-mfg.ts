
import { yymmFor } from '../../services/documentRefs';
import { Hono } from 'hono';
import { propagateDoCrewToTrip } from '../lib/trip-crew-sync';
import type { Context } from 'hono';
import { normalizePhone } from '../shared/phone';
import { lineDiscountShare } from '../shared/line-discount-share';
import { firstUndeliverableSo, soNotDeliverableResponse } from '../lib/source-document-gates';
import { HOLD_COLUMNS, isDocumentHeld } from '../lib/document-hold';
import { mountHoldRoute } from './document-hold-routes';
import { doListStatusCounts } from '../lib/do-status-counts';
import {
  DO_SHIPPED_STATES, DO_STOCK_OUT_STATES, DO_PRESHIP_STATES, doCountsAsDelivered,
  DO_STATUSES as SHARED_DO_STATUSES, CONFIRM_HOP_STATES, doHasArrived,
} from '../shared/do-shipped-states';
import { buildVariantSummary } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import { statusCapabilityRefusal, POD_STATES } from '../lib/do-status-capability';
import { resolveDeliveryScope, scopeMatchesAssignment, podWriteScopeCompany } from '../lib/deliveryScope';
import { resolveCrewSeats } from '../lib/crew-seats';
import { fetchDoCrewAssignment, doPodPhotoHandler } from './delivery-pod-context';
import { startTripIfPlanned } from './delivery-job-progress';
import { claimPodPhotos, doStopContext } from '../lib/pod-photo-claim';
import { mergePodPhotoKeys } from '../lib/do-pod-photos';
import { podPhotoKeysOf } from '../lib/do-pod-attempts';
import { alreadyDeliveredRefusal, houzsUserIdOf } from '../lib/crew-stop-complete';
import { revertDeliveryOrderHandler } from './delivery-order-revert';
import type { Env, Variables } from '../env';
import { writeMovements, defaultWarehouseId } from '../lib/inventory-movements';
import { dateOrNull, coerceEmptyDates, normalizeEventDay } from '../lib/date-coerce';
import { allocateAcrossBuckets } from '../lib/bucket-cost-allocation';
import { doCancelDbRefusal, doHasDownstream } from '../lib/downstream-lock';
import { claimedSoItemIdsOnDo, fillMissingSoItemIds } from '../lib/derive-do-so-item-id';
import { DO_AUDIT_FIELDS, DO_AUDIT_SELECT, DO_LINE_AUDIT_FIELDS, DO_IDENTITY_LABELS } from '../lib/do-audit-fields';
import { identityLockedRefusal } from '../shared/header-inherited-lock'; import { doLockedHeaderChanges, DO_HEADER_OPEN_DESCRIPTION } from '../shared/do-header-lock';
import { enqueueConvert, recordParentlessCreate, enqueueCancel, enqueueEdit, retiredLineOf, type AcRetiredLine, type AcEnqueueOutcome } from '../lib/autocount-outbox';

async function queueAcDoEdit(c: any, id: string, retire: AcRetiredLine[] = [], newLineIds: string[] = []): Promise<void> {  // newLineIds: docs/bugs/0588
  await enqueueEdit(c.get('supabase'), {
    companyId: activeCompanyId(c),
    docType: 'DO',
    docId: id,
    retire, newLineIds,
    createdBy: c.get('houzsUser')?.id ?? null,
  });
}
import { reconcileUncostedAfterIn } from '../lib/oversell-retrocost';
import { shippedDoSpecRefusal } from '../lib/do-spec-lock-check';
import { doSpecLocked } from '../shared/do-spec-lock';
import { returnDoUnitsAtCost, returnedAsInRow, describeFailedReturns, type DoUnitReturn } from '../lib/do-resync-return';
import { canonicalVariantKey, computeVariantKey, isServiceLine, effectiveSoDelivery, type VariantAttrs } from '../shared';
import { loadIncomingLines, subtractOutstanding, allocateExpectedBatches } from '../lib/do-live-allocator';
import { loadCommittedShipments } from '../lib/committed-shipments';
import { syncSoDeliveredFromDo } from '../lib/so-delivery-sync';
import { findOverDeliveredSoItems, findOverDeliveredUnlinkedItems } from '../lib/do-over-delivery';
import { findUnlinkedSoLines, unlinkedSoLinesResponse, itemCodeKey } from '../lib/do-unlinked-so-lines';
import { findNotReadySoLines, itemsNotReadyResponse } from '../lib/do-not-ready-lines';
import { unlinkedScanRefusal } from '../lib/unlinked-line-edit-guard';
import { maybeSendDeliveryOrderEmail } from '../lib/do-email';
import { maybeSendPodDeliveredWhatsApp } from '../lib/pod-delivered-message';
import { todayMyt } from '../lib/my-time';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { eager } from '../lib/concurrency';
import { buildDoListRows } from '../lib/do-list-rows';
import { attachDoLines } from '../lib/do-list-lines';
import {
  resolveDoLineSources,
  resolveDoLineSourcePosImpl,
  resolveDoSourcePosForDosImpl,
  soLineShippedSourcePosImpl,
} from '../lib/source-po-trace';
export { soLineShippedSources, resolveDoSources } from '../lib/source-po-trace';
import { filterDoList, fromDoList, orderDoList, readDoListParams, windowDoList } from '../lib/do-list-read';
import { resolveSalesScopeIds, salesDocOutOfScope } from '../lib/salesScope';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { scopeToCompany, scopeToAllowedCompanies, activeCompanyId, stampCompany, companyDocPrefix, docPrefixForCode, companyCodeMap,
  isCrossCompanySource, crossCompanyConversionBlocked,
  requireActiveCompanyId, scopeToCompanyId, scopeToCompanyIdOrOpen, NOT_THIS_COMPANY, scopeToGrantedCompanies } from '../lib/companyScope';
import { stampSoRefsCamel } from '../lib/so-ref-lookup';
import type { getSupabaseService } from '../../db/supabase';
import { SO_CONVERT_HEADER, soHeaderToDoSource, missingSourceFields } from '../lib/so-to-do-fields';
import { canViewAllSales, canViewScmFinance } from '../lib/houzs-perms';
import { SO_ITEM_FINANCE_KEYS } from '../lib/finance-keys';
import { freezeShipCost } from '../lib/fulfillment-costing';
import { validateItemCodes, unknownItemCodeResponse } from '../lib/validate-item-codes';
import { resolveItemGroups } from '../lib/sku-category';
import { foldTargetsIntoOwnBuckets, stockBucketKeyResolver } from '../lib/stock-bucket-key';
import { adoptSoLineSpecs } from '../lib/do-so-spec';
import { variantTrackedCompany } from '../lib/binding-mode';
import { buildDoItemRow as buildItemRow, loadCarriedSoLinePhotos, carriedPhotoUrls } from '../lib/do-item-row';
import { recomputeDoTotals as recomputeTotals } from '../lib/do-totals';
import { isSoLineOverDelivered, soRemainingByItemId } from '../lib/so-remaining-by-item';
import { lineLinkItemMismatch, assertLinkedLineItemsMatch } from '../lib/line-link-item-identity';
import { checkStockAvailability, shortStockResponse, stockCheckableLines, uncoveredStockCheckLines, type StockShortage } from '../lib/check-stock-availability';
import { findSofaLinesWithoutCompleteBatch, sofaNoCompleteBatchResponse, findIncompleteSofaSets, sofaIncompleteSetResponse, detectSofaSoItemIds } from '../lib/sofa-batch-guard';
import { resolveExpectedBatchBySoItem, buildDropshipOffenders } from '../lib/dropship-batch';
import {
  planShipCommitments,
  planSofaSetPoConflicts,
  type ShipLineFact,
  type SofaSetPoConflict,
} from '../lib/ship-commitment';
import { loadSofaBatchStock, sofaStockKey } from '../lib/sofa-set-coverage';
import { buildDoReversalRows } from '../lib/do-reversal';
import { resolveDoLineWarehouses, doShipFromWarehouseId } from '../lib/do-line-warehouses';
import { resolveHardBoundCostBatches, costBatchNoteText, type CostBatchMode, type CostBatchNote } from '../lib/hard-bound-cost-batch';
import { doWarehouseLabels } from '../lib/do-warehouse-labels';
import { isMigratedNoStock } from '../lib/migrated-no-stock';
import { doConfirmPreflight } from '../lib/do-confirm-preflight';
import { currentDocNoByKey, type CurrentEvent } from '../lib/current-doc';
import { doLifecycleFrom, type DoLifecycle, type DoLifecycleSi, type DoLifecycleDr } from '../lib/do-lifecycle';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { recordSoAudit, type FieldChange } from '../lib/so-audit';
import { advanceSoGeneration } from '../lib/so-generation';
import { recordEntityAudit, diffFields, compactChanges, fieldChange } from '../lib/entity-audit';
import { markIdempotencyNoWrite } from '../../middleware/idempotency';
import { resolveDoLineRacks, racksForDoLine, loadShippedFromRacks } from '../lib/do-line-racks';
import { queueDoShippedFromStamp, markDoShippedFromReturned, withShippedFromStamp, DO_RACK_OUT_REASON } from '../lib/do-shipped-from-stamp'; import { rackShipState, retireDoRackCycle, DO_RACK_IN_REASON } from '../lib/do-rack-cycle';
import { withSoRefDocNos } from '../lib/so-ref-search';
import { stockTxFor, type StockTx } from '../lib/stock-post-tx'; import { doShipCoreFailure, doShipFailureResponse, keepCreatedDoAsDraft, type DoShipFlip, type DoShipTail } from '../lib/do-ship-atomic';
import { hasUnreadableLines, unreadableMovementError } from '../lib/failed-read-refusal'; import { readFailure, readFailureError } from '../lib/read-failure'; import { noteResyncReadFailure, revertShipOnUnreadLines } from '../lib/do-read-guards'; import { reshipAfterRevert } from '../lib/do-stock-cycle';
import { stepClock, timed } from '../../lib/step-timing';

export const deliveryOrdersMfg = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryOrdersMfg.use('*', supabaseAuth);




async function recordDoCreate(
  sb: Variables['supabase'],
  actor: Variables['houzsUser'],
  fallbackCompanyId: number | null | undefined,
  doId: string,
  lineCount: number,
  note?: string,
): Promise<void> {
  let row: Record<string, unknown> | null = null;
  try {
    const { data } = await sb.from('delivery_orders')
      .select('id, do_number, status, company_id, so_doc_no, debtor_code, debtor_name, ' +
        'do_date, customer_delivery_date, expected_delivery_at, currency, salesperson_id, ' +
        'driver_id, driver_name, vehicle, local_total_sen')
      .eq('id', doId).maybeSingle();
    row = (data ?? null) as Record<string, unknown> | null;
  } catch { }
  if (!row) return;
  await recordEntityAudit(sb, {
    entityType: 'DELIVERY_ORDER',
    entityId: doId,
    entityDocNo: (row.do_number as string | null) ?? null,
    action: 'CREATE',
    actor,
    companyId: (row.company_id as number | null) ?? fallbackCompanyId,
    statusSnapshot: (row.status as string | null) ?? null,
    note,
    fieldChanges: compactChanges([
      fieldChange('status', null, row.status ?? null),
      fieldChange('soDocNo', null, row.so_doc_no ?? null),
      fieldChange('debtorCode', null, row.debtor_code ?? null),
      fieldChange('debtorName', null, row.debtor_name ?? null),
      fieldChange('doDate', null, row.do_date ?? null),
      fieldChange('customerDeliveryDate', null, row.customer_delivery_date ?? null),
      fieldChange('expectedDeliveryAt', null, row.expected_delivery_at ?? null),
      fieldChange('currency', null, row.currency ?? null),
      fieldChange('salespersonId', null, row.salesperson_id ?? null),
      fieldChange('driverId', null, row.driver_id ?? null),
      fieldChange('driverName', null, row.driver_name ?? null),
      fieldChange('vehicle', null, row.vehicle ?? null),
      fieldChange('localTotalSen', null, row.local_total_sen ?? null),
      fieldChange('lineCount', null, lineCount),
    ]),
  });
}

async function loadDoAuditMeta(
  sb: Variables['supabase'],
  doId: string,
): Promise<{ docNo: string | null; companyId: number | null; status: string | null }> {
  try {
    const { data } = await sb.from('delivery_orders')
      .select('do_number, company_id, status').eq('id', doId).maybeSingle();
    const row = (data ?? null) as { do_number?: string | null; company_id?: number | null; status?: string | null } | null;
    return { docNo: row?.do_number ?? null, companyId: row?.company_id ?? null, status: row?.status ?? null };
  } catch {
    return { docNo: null, companyId: null, status: null };
  }
}

const HC_SUBSTATUS_VALUES = [
  'Pending Pickup', 'Done Shipout', 'Arrives EM Warehouse',
  'Done Delivered', 'Confirm', 'House Not Ready', 'Request Hold',
] as const;

async function prepareSoAmendMirrorAudit(
  sb: Variables['supabase'],
  soDocNo: string,
  mirror: Record<string, unknown>,
  actor: { id: string | null; name: string | null },
  viaLabel: string,
): Promise<() => Promise<void>> {
  let before: Record<string, unknown> = {};
  try {
    const { data } = await sb.from('mfg_sales_orders')
      .select('amend_date_from_customer, amended_delivery_date, amend_reason, status')
      .eq('doc_no', soDocNo).maybeSingle();
    before = (data ?? {}) as Record<string, unknown>;
  } catch { }
  return async () => {
    const CAMEL: Array<[camel: string, snake: string]> = [
      ['amendDateFromCustomer', 'amend_date_from_customer'],
      ['amendedDeliveryDate',   'amended_delivery_date'],
      ['amendReason',           'amend_reason'],
    ];
    const fieldChanges: FieldChange[] = [];
    for (const [camel, snake] of CAMEL) {
      if (!(snake in mirror)) continue;
      const from = before[snake] ?? null;
      const to = mirror[snake] ?? null;
      if (String(from ?? '') !== String(to ?? '')) fieldChanges.push({ field: camel, from, to });
    }
    if (fieldChanges.length === 0) return;
    await recordSoAudit(sb, {
      docNo: soDocNo,
      action: 'UPDATE_DETAILS',
      actorId: actor.id,
      actorName: actor.name,
      fieldChanges,
      statusSnapshot: (before as { status?: string }).status ?? null,
      source: 'delivery-order',
      note: `Delivery amendment mirrored from ${viaLabel}`,
    });
  };
}


const HEADER =
  'id, do_number, so_doc_no, debtor_code, debtor_name, do_date, expected_delivery_at, ' +
  'customer_delivery_date, signed_at, delivered_at, dispatched_at, ' +
  'driver_id, driver_name, vehicle, time_range, m3_total_milli, ' +
  'address1, address2, city, state, postcode, phone, ' +
  'salesperson_id, agent, email, customer_type, building_type, branding, venue, venue_id, ref, ' +
  'customer_so_no, po_doc_no, sales_location, customer_state, customer_country, note, ' +
  'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, ' +
  'mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen, service_sen, ' +
  'mattress_sofa_cost_sen, bedframe_cost_sen, accessories_cost_sen, others_cost_sen, service_cost_sen, ' +
  'local_total_sen, total_cost_sen, total_margin_sen, margin_pct_basis, line_count, ' +
  'currency, warehouse_id, is_dropship, ' +
  'arrives_em_warehouse_date, ' +
  'pod_r2_key, pod_photo_keys, signature_data, departure_at, arrival_at, pod_lat, pod_lng, status, notes, created_at, created_by, updated_at, ' +
  /* Mig 0324 — the HOLD MARKER, the DO's first hold ever and the one that
     needed no enum change. docs/modules/delivery-order.md. */
  HOLD_COLUMNS;
export const DO_LIST_HEADER = HEADER;

const DO_FINANCE_KEYS = [
  'mattress_sofa_sen', 'bedframe_sen', 'accessories_sen', 'others_sen', 'service_sen',
  'mattress_sofa_cost_sen', 'bedframe_cost_sen', 'accessories_cost_sen', 'others_cost_sen', 'service_cost_sen',
  'total_cost_sen', 'total_margin_sen', 'margin_pct_basis',
] as const;

export const DO_LIST_ROW_DEPS = {
  financeKeys: DO_FINANCE_KEYS as readonly string[],
};


const ITEM =
  'id, delivery_order_id, so_item_id, item_code, item_group, description, description2, ' +
  'uom, qty, m3_milli, unit_price_sen, discount_sen, line_total_sen, ' +
  'photo_urls, ' +
  'unit_cost_sen, line_cost_sen, line_margin_sen, variants, notes, ' +
  'line_delivery_date, line_delivery_date_overridden, rack_id, created_at, ' +
  'committed_po_batch_no, ac_substituted, shipped_from';

const crewSnapshotCols =
  'id, do_id, driver_1_id, driver_2_id, helper_1_id, helper_2_id, lorry_id, ' +
  'driver_1_name, driver_1_ic, driver_1_contact, driver_2_name, driver_2_ic, driver_2_contact, ' +
  'helper_1_name, helper_1_contact, helper_2_name, helper_2_contact, lorry_plate, ' +
  'assigned_at, assigned_by, updated_at';

const SHIPPED_STATES: string[] = [...DO_SHIPPED_STATES];

const DO_STATUSES = new Set<string>(SHARED_DO_STATUSES);
const DO_PRESHIP_STATUSES = new Set<string>(DO_PRESHIP_STATES);
const DO_STOCK_OUT_STATUSES = new Set<string>(DO_STOCK_OUT_STATES);

const nextNum = async (sb: any, c: any, prefixOverride?: string): Promise<string> => {
  const yymm = yymmFor();
  const p = prefixOverride ?? companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'delivery_orders', 'do_number', `${p}DO-${yymm}`);
};

type ShipCandidateLine = {
  lineRef: string;
  soItemId: string | null;
  itemCode: string;
  itemGroup: string | null;
  variantKey: string;
  qty: number;
  priorShippedQty?: number;
  priorBatchNo?: string | null;
};

type ShipBinding = {
  itemCode: string;
  poNumber: string;
  eta: string | null;
  strictBatch: boolean;
  variantKey: string;
};

type ShipCommitmentPlan = {
  bindings: Map<string, ShipBinding>;
  setConflicts: SofaSetPoConflict[];
};

const NO_COMMITMENTS: ShipCommitmentPlan = { bindings: new Map(), setConflicts: [] };

async function resolveShipCommitments(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  lines: ShipCandidateLine[],
  warehouseId: string | null,
  shortages: StockShortage[],
  companyId: number | null,
  auditCtx?: { doId?: string | null; doNumber?: string | null },
): Promise<ShipCommitmentPlan> {
  const out = new Map<string, ShipBinding>();
  const linked = lines.filter((l) => l.soItemId && Number(l.qty) > 0);
  if (linked.length === 0) return { bindings: out, setConflicts: [] };
  try {
    const soItemIds = [...new Set(linked.map((l) => l.soItemId as string))];

    const storedProvenancePromise: Promise<Map<string, { poNumber: string | null; eta: string | null }>> =
      resolveExpectedBatchBySoItem(sb, soItemIds, { onMultiPo: 'block' }).catch((e: unknown) => {
        /* eslint-disable-next-line no-console */
        console.error('[bind-shadow] stored-link provenance read failed (evidence only):', e);
        return new Map();
      });

    const [sofaIds, allocRes] = await Promise.all([
      detectSofaSoItemIds(sb, linked.map((l) => ({
        itemCode: l.itemCode, itemGroup: l.itemGroup, soItemId: l.soItemId,
      })), companyId),
      sb.from('mfg_sales_order_items')
        .select('id, doc_no, allocated_batch_no, line_delivery_date, so:mfg_sales_orders ( customer_delivery_date )')
        .in('id', soItemIds),
    ]);
    const soRows = ((allocRes as {
      data?: Array<{
        id: string; doc_no: string | null; allocated_batch_no: string | null;
        line_delivery_date: string | null; so: { customer_delivery_date: string | null } | null;
      }>;
    }).data ?? []);
    const allocated = new Map<string, string | null>(soRows.map((r) => [r.id, r.allocated_batch_no ?? null]));
    const docNoBySoItem = new Map<string, string | null>(soRows.map((r) => [r.id, r.doc_no ?? null]));
    const demandDateBySoItem = new Map<string, string | null>(
      soRows.map((r) => [r.id, r.line_delivery_date ?? r.so?.customer_delivery_date ?? null]),
    );

    const codes = [...new Set(linked.map((l) => l.itemCode))];
    const incoming = await loadIncomingLines(sb, codes, warehouseId);
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const scoped = <Q>(q: Q): Q =>
      companyId != null ? (q as unknown as { eq(c: string, v: unknown): Q }).eq('company_id', companyId) : q;
    const committed = await loadCommittedShipments(
      sb, scoped, [...new Set(incoming.map((l) => l.poNumber))],
    );
    const pool = subtractOutstanding(incoming, committed.values());
    const picks = allocateExpectedBatches(pool, linked.map((l) => ({
      lineRef: l.lineRef,
      itemCode: l.itemCode,
      variantKey: l.variantKey,
      shipQty: Number(l.qty),
      isSofa: !!l.soItemId && sofaIds.has(l.soItemId),
      soDocNo: l.soItemId ? (docNoBySoItem.get(l.soItemId) ?? null) : null,
      allocatedBatchNo: l.soItemId ? (allocated.get(l.soItemId) ?? null) : null,
      deliveryDate: l.soItemId ? (demandDateBySoItem.get(l.soItemId) ?? null) : null,
    })));

    const availableByBucket = new Map<string, number>();
    for (const s of shortages) availableByBucket.set(`${s.itemCode}::${s.variantKey}`, s.available);

    const facts: ShipLineFact[] = linked.map((l) => ({
      lineRef: l.lineRef,
      soItemId: l.soItemId,
      itemCode: l.itemCode,
      variantKey: l.variantKey,
      warehouseId,
      isSofa: !!l.soItemId && sofaIds.has(l.soItemId),
      allocatedBatchNo: allocated.get(l.soItemId as string) ?? null,
      expectedBatchNo: picks.get(l.lineRef)?.poNumber ?? null,
      availableQty: availableByBucket.get(`${l.itemCode}::${l.variantKey}`) ?? Number(l.qty),
      shipQty: Number(l.qty),
      priorShippedQty: l.priorShippedQty ?? 0,
      priorBatchNo: l.priorBatchNo ?? null,
    }));

    const decisions = planShipCommitments(facts);
    const variantByRef = new Map(linked.map((l) => [l.lineRef, l.variantKey]));
    for (const d of decisions) {
      if (!d.bind || !d.batchNo) continue;
      out.set(d.lineRef, {
        itemCode: d.itemCode,
        poNumber: d.batchNo,
        eta: picks.get(d.lineRef)?.eta ?? null,
        strictBatch: d.strictBatch,
        variantKey: variantByRef.get(d.lineRef) ?? '',
      });
    }

    try {
      const stored = await storedProvenancePromise;
      const divergences: Array<{ itemCode: string; variantKey: string; stored: string | null; allocator: string | null; eta: string | null }> = [];
      for (const f of facts) {
        const storedPo = (f.soItemId ? stored.get(f.soItemId)?.poNumber : null) ?? null;
        if (storedPo !== (f.expectedBatchNo ?? null)) {
          divergences.push({
            itemCode: f.itemCode,
            variantKey: f.variantKey,
            stored: storedPo,
            allocator: f.expectedBatchNo ?? null,
            eta: picks.get(f.lineRef)?.eta ?? null,
          });
          /* eslint-disable-next-line no-console */
          console.info(`[bind-shadow] ${f.itemCode} [${f.variantKey}] stored=${storedPo ?? '—'} allocator=${f.expectedBatchNo ?? '—'} — divergence logged; the ALLOCATOR binds, the stored link is provenance`);
        }
      }
      const setPicks: Array<{ docNo: string; poNumber: string }> = [];
      {
        const seen = new Set<string>();
        for (const l of linked) {
          if (!(l.soItemId && sofaIds.has(l.soItemId))) continue;
          const docNo = docNoBySoItem.get(l.soItemId) ?? null;
          const pick = picks.get(l.lineRef);
          if (!docNo || !pick || seen.has(docNo)) continue;
          seen.add(docNo);
          setPicks.push({ docNo, poNumber: pick.poNumber });
          /* eslint-disable-next-line no-console */
          console.info(`[bind-shadow] sofa set ${docNo}: allocator whole-set pick = ${pick.poNumber}${pick.eta ? ` (eta ${pick.eta})` : ''}`);
        }
      }

      try {
        const entityId = auditCtx?.doId ?? 'pre-create';
        const entityDocNo = auditCtx?.doNumber ?? null;
        for (const d of divergences) {
          await recordEntityAudit(sb, {
            entityType: 'DELIVERY_ORDER',
            entityId,
            entityDocNo,
            action: 'BIND_SHADOW',
            companyId: companyId ?? null,
            statusSnapshot: 'DIVERGENCE',
            source: 'bind-shadow',
            fieldChanges: [{ field: `${d.itemCode} [${d.variantKey}]`, from: d.stored, to: d.allocator }],
            note:
              `[bind-shadow] ${d.itemCode} [${d.variantKey}] stored=${d.stored ?? 'none'} ` +
              `allocator=${d.allocator ?? 'none'}${d.eta ? ` (eta ${d.eta})` : ''} — the allocator binds; the stored link is provenance.`,
          });
        }
        await recordEntityAudit(sb, {
          entityType: 'DELIVERY_ORDER',
          entityId,
          entityDocNo,
          action: 'BIND_SHADOW',
          companyId: companyId ?? null,
          statusSnapshot: 'SUMMARY',
          source: 'bind-shadow',
          fieldChanges: [
            { field: 'lines_compared', from: null, to: facts.length },
            { field: 'diverged', from: null, to: divergences.length },
            ...setPicks.map((s) => ({ field: `sofa_set ${s.docNo}`, from: null, to: s.poNumber })),
          ],
          note:
            `[bind-shadow] compared ${facts.length} line(s): ${divergences.length} divergence(s)` +
            (setPicks.length > 0
              ? `; sofa whole-set pick(s): ${setPicks.map((s) => `${s.docNo} -> ${s.poNumber}`).join(', ')}`
              : '') +
            `.`,
        });
      } catch (e) {
        /* eslint-disable-next-line no-console */
        console.error('[bind-shadow] evidence persist failed (evidence only, shipping unaffected):', e);
      }
    } catch (e) {
      /* eslint-disable-next-line no-console */
      console.error('[bind-shadow] failed (evidence only, shipping unaffected):', e);
    }

    /* ONE PO IS ONE BATCH NUMBER (owner, 2026-07-31), so a sofa SET binds ONE
       PO. The pre-existing gate only asked whether every module had *a* PO, so
       two modules resolving two different POs were stamped with two batch
       numbers and the dye lot was split silently. */
    const byRef = new Map(decisions.map((d) => [d.lineRef, d]));
    const setConflicts = planSofaSetPoConflicts(linked.map((l) => ({
      lineRef: l.lineRef,
      soDocNo: l.soItemId ? (docNoBySoItem.get(l.soItemId) ?? null) : null,
      itemCode: l.itemCode,
      isSofa: !!l.soItemId && sofaIds.has(l.soItemId),
      allocatedBatchNo: allocated.get(l.soItemId as string) ?? null,
      boundBatchNo: byRef.get(l.lineRef)?.batchNo ?? null,
    })));
    if (setConflicts.length > 0) return { bindings: new Map(), setConflicts };

    return { bindings: out, setConflicts: [] };
  } catch (e) {
    /* eslint-disable-next-line no-console */
    console.error('[ship-commitment] resolve failed (shipping unbound):', e);
    return NO_COMMITMENTS;
  }
}

const bindingList = (m: Map<string, ShipBinding>): ShipBinding[] => {
  const byKey = new Map<string, ShipBinding>();
  for (const b of m.values()) byKey.set(`${b.poNumber}::${b.itemCode}`, b);
  return [...byKey.values()];
};

const sofaSetPoSplitResponse = (conflicts: SofaSetPoConflict[]) => ({
  error: 'sofa_set_po_split',
  message:
    `A sofa set is ONE dye lot, so it must ship against ONE purchase order — these modules resolve different ones: ` +
    conflicts.map((cf) =>
      `${cf.soDocNo}: ` + cf.modules
        .map((m) => `${m.itemCode} -> ${m.batchNo ?? 'no PO'}`)
        .join(', '),
    ).join('; ') +
    `. Point every module of the set at the same purchase order (Purchase Order -> the line -> Source Sales Order line), or ship none of it.`,
  conflicts,
});

async function resolveDoSofaBatchMap(
  sb: any,
  items: Array<{
    so_item_id?: string | null; item_code: string; item_group?: string | null;
    committed_po_batch_no?: string | null;
  }>,
  isDropship: boolean,
  companyId: number | null,
): Promise<Map<string, string>> {
  const batchBySoItem = new Map<string, string>();
  const soItemIds = [...new Set(items.map((it) => it.so_item_id ?? null).filter((x): x is string => !!x))];
  if (soItemIds.length === 0) return batchBySoItem;
  try {
    const { data: bRows, error } = await sb.from('mfg_sales_order_items')
      .select('id, allocated_batch_no').in('id', soItemIds);
    if (!error) for (const r of (bRows ?? []) as Array<{ id: string; allocated_batch_no: string | null }>) {
      if (r.allocated_batch_no) batchBySoItem.set(r.id, r.allocated_batch_no);
    }
  } catch { }
  for (const it of items) {
    const sid = it.so_item_id ?? null;
    const committed = it.committed_po_batch_no ?? null;
    if (sid && committed && !batchBySoItem.has(sid)) batchBySoItem.set(sid, committed);
  }
  if (isDropship) {
    const missing = new Set(soItemIds.filter((sid) => !batchBySoItem.has(sid)));
    if (missing.size > 0) {
      const sofaRows = items
        .filter((it) => it.so_item_id && missing.has(it.so_item_id))
        .map((it) => ({ itemCode: it.item_code, itemGroup: it.item_group ?? null, soItemId: it.so_item_id ?? null }));
      const sofaSoIds = await detectSofaSoItemIds(sb, sofaRows, companyId);
      if (sofaSoIds.size > 0) {
        const expected = await resolveExpectedBatchBySoItem(sb, [...sofaSoIds], { onMultiPo: 'latest' });
        for (const [sid, eb] of expected) if (eb.poNumber) batchBySoItem.set(sid, eb.poNumber);
      }
    }
  }
  return batchBySoItem;
}

/* The batch map every inventory seam of a DO keys on: the sofa / commitment /
   drop-ship answer above, plus (company 1 only) the hard-bound line's own PO,
   decided at the first ship and read back from the OUT afterwards
   (lib/hard-bound-cost-batch.ts, owner decision A 2026-11-10). For any other
   company the second half reads nothing and adds nothing. */
async function resolveDoCostBatchMap(
  sb: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- same untyped client as resolveDoSofaBatchMap
  items: Array<{
    id: string; so_item_id?: string | null; item_code: string; item_group?: string | null;
    variants?: VariantAttrs | null; qty?: number | null; committed_po_batch_no?: string | null;
  }>,
  isDropship: boolean,
  companyId: number | null,
  lineWh: Map<string, string | null>,
  deliveryOrderId: string,
  mode: CostBatchMode,
): Promise<{ batchBySoItem: Map<string, string>; notes: CostBatchNote[] }> {
  const batchBySoItem = await resolveDoSofaBatchMap(sb, items, isDropship, companyId);
  const hb = await resolveHardBoundCostBatches(sb, {
    companyId,
    deliveryOrderId,
    already: batchBySoItem,
    mode,
    lines: items
      .filter((it) => !isServiceLine({ itemGroup: it.item_group, itemCode: it.item_code }))
      .map((it) => ({
        soItemId: it.so_item_id ?? null,
        itemCode: it.item_code,
        itemGroup: it.item_group ?? null,
        variantKey: computeVariantKey(it.item_group ?? null, it.variants ?? null),
        warehouseId: lineWh.get(it.id) ?? null,
        qty: Number(it.qty ?? 0),
      })),
  });
  for (const [sid, b] of hb.batchBySoItem) batchBySoItem.set(sid, b);
  return { batchBySoItem, notes: hb.notes };
}

export async function restampDoActualCost(sb: any, deliveryOrderId: string): Promise<void> {
  return timed('restamp-do', () => restampDoActualCostInner(sb, deliveryOrderId));
}
async function restampDoActualCostInner(sb: Parameters<typeof restampDoActualCost>[0], deliveryOrderId: string) {
  try {
    let hdrRes = await sb.from('delivery_orders')
      .select('status, warehouse_id, is_dropship, company_id').eq('id', deliveryOrderId).maybeSingle();
    if (hdrRes.error && (hdrRes.error.message ?? '').includes('is_dropship')) {
      hdrRes = await sb.from('delivery_orders')
        .select('status, warehouse_id, company_id').eq('id', deliveryOrderId).maybeSingle();
    }
    const doHeader = hdrRes.data;
    if (!doHeader) return;
    const status = ((doHeader as { status: string | null }).status ?? '').toUpperCase();
    if (!SHIPPED_STATES.includes(status)) return;
    const headerWarehouseId = (doHeader as { warehouse_id: string | null }).warehouse_id ?? null;
    const isDropship = (doHeader as { is_dropship?: boolean }).is_dropship === true;

    const { data: items } = await sb.from('delivery_order_items')
      .select('id, so_item_id, item_code, qty, item_group, variants, line_total_sen, ship_cost_sen, committed_po_batch_no')
      .eq('delivery_order_id', deliveryOrderId);
    if (!items || items.length === 0) return;

    const lineWh = await resolveDoLineWarehouses(
      sb, items as Array<{ id: string; so_item_id?: string | null }>, headerWarehouseId,
      (doHeader as { company_id?: number | null }).company_id ?? undefined);

    const { batchBySoItem } = await resolveDoCostBatchMap(
      sb,
      items as Array<{ id: string; so_item_id?: string | null; item_code: string; item_group?: string | null; variants?: VariantAttrs | null; qty?: number | null }>,
      isDropship,
      (doHeader as { company_id?: number | null }).company_id ?? null,
      lineWh, deliveryOrderId, 'restamp',
    );
    const batchAware = batchBySoItem.size > 0;

    const movSelect = batchAware
      ? 'movement_type, warehouse_id, item_code, variant_key, batch_no, qty, total_cost_sen'
      : 'movement_type, warehouse_id, item_code, variant_key, qty, total_cost_sen';
    const { data: movs } = await sb.from('inventory_movements')
      .select(movSelect)
      .eq('source_doc_type', 'DO')
      .eq('source_doc_id', deliveryOrderId);
    type Agg = { net_qty: number; net_cost: number };
    const aggByBucket = new Map<string, Agg>();
    const costVk = (vk: string | null): string =>
      variantTrackedCompany((doHeader as { company_id?: number | null }).company_id ?? null) ? canonicalVariantKey(vk) : (vk ?? '');
    for (const m of (movs ?? []) as Array<{
      movement_type: string; warehouse_id: string; item_code: string;
      variant_key: string | null; batch_no?: string | null; qty: number; total_cost_sen: number | null;
    }>) {
      const k = `${m.warehouse_id}::${m.item_code}::${costVk(m.variant_key)}::${m.batch_no ?? ''}`;
      let agg = aggByBucket.get(k);
      if (!agg) { agg = { net_qty: 0, net_cost: 0 }; aggByBucket.set(k, agg); }
      const q = Number(m.qty ?? 0);
      const cost = Number(m.total_cost_sen ?? 0);
      if (m.movement_type === 'OUT') { agg.net_qty += q; agg.net_cost += cost; }
      else if (m.movement_type === 'IN') { agg.net_qty -= q; agg.net_cost -= cost; }
    }

    const allocByLine = allocateAcrossBuckets(items as Array<{ id: string; qty: number }>, aggByBucket,
      (it: any) => `${lineWh.get(it.id) ?? ''}::${it.item_code}::${costVk(computeVariantKey(it.item_group ?? null, it.variants ?? null))}::${it.so_item_id ? (batchBySoItem.get(it.so_item_id) ?? '') : ''}`);
    for (const it of items as Array<{
      id: string; so_item_id?: string | null; item_code: string; qty: number;
      item_group?: string | null; variants?: VariantAttrs | null; line_total_sen: number | null;
      ship_cost_sen?: number | null;
    }>) {
      const share = allocByLine.get(it.id);
      if (!share) continue;
      const unitCost = share.unitCostSen;
      const qty = Number(it.qty ?? 0);
      const lineTotal = Number(it.line_total_sen ?? 0);
      const lineCost = share.lineCostSen;
      const update: Record<string, number> = {
        unit_cost_sen: unitCost,
        line_cost_sen: lineCost,
        line_margin_sen: lineTotal - lineCost,
      };
      const shipFreeze = freezeShipCost(it.ship_cost_sen ?? null, unitCost);
      if (shipFreeze !== undefined) update.ship_cost_sen = shipFreeze;
      await sb.from('delivery_order_items').update(update).eq('id', it.id);
    }

    await recomputeTotals(sb, deliveryOrderId);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[restampDoActualCost] failed:', e); }
}


async function checkDoStockAvailability(
  sb: any,
  lines: Array<{
    lineRef: string; soItemId: string | null; itemCode: string; itemGroup?: string | null;
    productName: string | null; variantKey: string; qty: number;
  }>,
  headerWarehouseId: string | null,
  companyId: number | undefined,
): Promise<StockShortage[]> {
  const shippable = stockCheckableLines(lines, new Set());
  if (shippable.length === 0) return [];
  const lineWh = await resolveDoLineWarehouses(sb, shippable.map((l) => ({ id: l.lineRef, so_item_id: l.soItemId })), headerWarehouseId, companyId);
  const active = await uncoveredStockCheckLines(sb, shippable, lineWh, companyId);
  if (active.length === 0) return [];
  const byWh = new Map<string, Array<{ itemCode: string; productName: string | null; variantKey: string; qty: number }>>();
  for (const l of active) {
    const wh = lineWh.get(l.lineRef) ?? null;
    if (!wh) continue;
    const arr = byWh.get(wh) ?? [];
    arr.push({ itemCode: l.itemCode, productName: l.productName, variantKey: l.variantKey, qty: Number(l.qty) });
    byWh.set(wh, arr);
  }
  const shortages: StockShortage[] = [];
  for (const [wh, reqs] of byWh) shortages.push(...(await checkStockAvailability(sb, wh, reqs, companyId)));
  return shortages;
}

function primaryWarehouseOf(lineWarehouses: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const wh of lineWarehouses) {
    if (!wh) continue;
    counts.set(wh, (counts.get(wh) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [wh, n] of counts) if (n > bestN) { best = wh; bestN = n; }
  return best;
}


export async function resolveDoLineSourcePos(
  sb: any,
  deliveryOrderId: string,
): Promise<Map<string, string[]>> {
  return resolveDoLineSourcePosImpl(sb, deliveryOrderId);
}

export async function resolveDoSourcePosForDos(
  sb: any,
  doIds: Array<string | null | undefined>,
): Promise<Map<string, string[]>> {
  return resolveDoSourcePosForDosImpl(sb, doIds);
}

export async function deductInventoryForDo(sb: any, deliveryOrderId: string, performedBy: string): Promise<string[]> {
  const core = await deductInventoryCore(sb, deliveryOrderId, performedBy);
  await runDoShipTail(sb, core.tail);
  return core.errors;
}
async function deductInventoryCore(sb: Parameters<typeof writeMovements>[0], deliveryOrderId: string, performedBy: string): Promise<{ errors: string[]; tail: DoShipTail }> {
  const done = (errors: string[]) => ({ errors, tail: null });
  const { count: existing, error: existingErr } = await sb
    .from('inventory_movements')
    .select('id', { head: true, count: 'exact' })
    .eq('source_doc_type', 'DO')
    .eq('source_doc_id', deliveryOrderId)
    .eq('movement_type', 'OUT');
  if (existingErr) return done([unreadableMovementError('the stock already moved for this DO', existingErr)]);
  if ((existing ?? 0) > 0) {
    const reship = await reshipAfterRevert(sb, deliveryOrderId);
    if (reship === 'shipped') return done([]);
    if (reship !== 'deduct') return done([reship]);
  }

  let doHeaderRes = await sb.from('delivery_orders')
    .select('do_number, warehouse_id, is_dropship, company_id, migrated_no_stock')
    .eq('id', deliveryOrderId).maybeSingle();
  if (doHeaderRes.error && (doHeaderRes.error.message ?? '').includes('is_dropship')) {
    doHeaderRes = await sb.from('delivery_orders')
      .select('do_number, warehouse_id, company_id, migrated_no_stock')
      .eq('id', deliveryOrderId).maybeSingle();
  }
  if (doHeaderRes.error && (doHeaderRes.error.message ?? '').includes('migrated_no_stock')) {
    doHeaderRes = await sb.from('delivery_orders')
      .select('do_number, warehouse_id, company_id')
      .eq('id', deliveryOrderId).maybeSingle();
  }
  if (doHeaderRes.error) return done([unreadableMovementError('the delivery order', doHeaderRes.error)]);
  const doHeader = doHeaderRes.data;
  if (isMigratedNoStock(doHeader as { migrated_no_stock?: boolean | null } | null)) return done([]);
  const { data: items, error: itemsErr } = await sb.from('delivery_order_items')
    .select('id, so_item_id, item_code, description, qty, item_group, variants, rack_id, committed_po_batch_no')
    .eq('delivery_order_id', deliveryOrderId);
  if (itemsErr) return done([unreadableMovementError('the delivery order lines', itemsErr)]);
  const headerWarehouseId = (doHeader as { warehouse_id: string | null } | null)?.warehouse_id ?? null;
  const doNo = (doHeader as { do_number: string } | null)?.do_number ?? deliveryOrderId;
  const isDropship = (doHeader as { is_dropship?: boolean } | null)?.is_dropship === true;
  if (!items) return done([]);

  const lineWh = await resolveDoLineWarehouses(
    sb, items as Array<{ id: string; so_item_id?: string | null }>, headerWarehouseId,
    (doHeader as { company_id?: number | null } | null)?.company_id ?? undefined);

  const { batchBySoItem, notes: costNotes } = await resolveDoCostBatchMap(
    sb,
    items as Array<{ id: string; so_item_id?: string | null; item_code: string; item_group?: string | null; variants?: VariantAttrs | null; qty?: number | null }>,
    isDropship,
    (doHeader as { company_id?: number | null } | null)?.company_id ?? null,
    lineWh, deliveryOrderId, 'ship',
  );

  const byKey = new Map<string, {
    warehouse_id: string; item_code: string; variant_key: string; product_name: string | null; qty: number; batch_no: string | null;
    notes: CostBatchNote[];
  }>();
  const shipKeyLine = (it: { id: string; item_code: string; item_group?: string | null; variants?: VariantAttrs | null }) =>
    ({ item_code: it.item_code, item_group: it.item_group ?? null, variants: it.variants ?? null, warehouse_id: lineWh.get(it.id) ?? null });
  const shipKeyOf = await stockBucketKeyResolver(sb, (doHeader as { company_id?: number | null } | null)?.company_id ?? null,
    (items as Array<{ id: string; item_code: string; item_group?: string | null; variants?: VariantAttrs | null }>).map(shipKeyLine));
  for (const it of (items as Array<{ id: string; so_item_id?: string | null; item_code: string; description: string | null; qty: number; item_group?: string | null; variants?: VariantAttrs | null }>)) {
    if (isServiceLine({ itemGroup: it.item_group, itemCode: it.item_code })) continue;
    const qty = Number(it.qty ?? 0);
    if (qty <= 0) continue;
    const warehouseId = lineWh.get(it.id) ?? null;
    if (!warehouseId) continue;
    const variantKey = shipKeyOf(shipKeyLine(it));
    const batchNo = it.so_item_id ? (batchBySoItem.get(it.so_item_id) ?? null) : null;
    const k = `${warehouseId}::${it.item_code}::${variantKey}::${batchNo ?? ''}`;
    const lineNotes = it.so_item_id ? costNotes.filter((n) => n.soItemId === it.so_item_id) : [];
    const cur = byKey.get(k);
    if (cur) { cur.qty += qty; cur.notes.push(...lineNotes); }
    else byKey.set(k, { warehouse_id: warehouseId, item_code: it.item_code, variant_key: variantKey, product_name: it.description, qty, batch_no: batchNo, notes: [...lineNotes] });
  }
  for (const n of costNotes) {
    /* eslint-disable-next-line no-console */
    console.warn(`[hard-bound-cost] ${doNo} ${n.itemCode} @ ${n.warehouseId}: ${n.reason}${n.poNumbers.length ? ` (${n.poNumbers.join(', ')})` : ''}`);
  }
  const movements = [...byKey.values()].map((m) => ({
    movement_type: 'OUT' as const,
    warehouse_id: m.warehouse_id,
    item_code: m.item_code,
    variant_key: m.variant_key,
    product_name: m.product_name,
    qty: m.qty,
    source_doc_type: 'DO' as const,
    source_doc_id: deliveryOrderId,
    source_doc_no: doNo,
    ...(m.batch_no ? { batch_no: m.batch_no } : {}),
    ...(costBatchNoteText(m.notes) ? { notes: costBatchNoteText(m.notes)! } : {}),
    performed_by: performedBy,
  }));
  const movementErrors: string[] = [];
  if (movements.length > 0) {
    const res = await writeMovements(sb, movements, (doHeader as { company_id?: number | null } | null)?.company_id ?? null);
    if (!res.ok) movementErrors.push(`OUT ${doNo}: ${res.reason ?? 'unknown'}`);
  }
  try {
    await stockOutDoLinesFromRacks(sb, deliveryOrderId, doNo, performedBy, lineWh, items as Array<Record<string, unknown>>, (doHeader as { company_id?: number | null } | null)?.company_id ?? null);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[do-rack] stock-out failed:', e); }
  return { errors: movementErrors, tail: { deliveryOrderId, companyId: (doHeader as { company_id?: number | null } | null)?.company_id ?? null, wroteOut: movements.length > 0 } };
}

async function runDoShipTail(sb: Parameters<typeof writeMovements>[0], tail: DoShipTail): Promise<void> {
  if (!tail) return;
  if (tail.wroteOut) {
    await restampDoActualCost(sb, tail.deliveryOrderId);
    try {
      const { recomputeAllocationAfterSave } = await import('../lib/stock-allocation-job');
      await recomputeAllocationAfterSave(sb, 'post-do-ship');
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-do-ship failed:', e); }
  }
  await queueDoShippedFromStamp(sb, tail.deliveryOrderId, tail.companyId);
}

export async function shipDoAtomically(tx: StockTx, sb: Parameters<typeof writeMovements>[0], deliveryOrderId: string, performedBy: string, flip: DoShipFlip | null) {
  const out = await tx(async (t) => {
    const flipped = flip ? await flip(t) : { ok: true as const, data: null };
    if (!flipped.ok) return flipped;
    const core = await deductInventoryCore(t, deliveryOrderId, performedBy);
    if (core.errors.length > 0) return doShipCoreFailure(core.errors);
    return { ok: true as const, data: flipped.data, tail: core.tail };
  });
  if (out.ok) await runDoShipTail(sb, out.tail);
  return out;
}
async function shipCreatedDoAtomically(tx: StockTx, sb: Parameters<typeof writeMovements>[0], doId: string, doNo: string, companyId: number, performedBy: string): Promise<object | null> {
  const shipped = await shipDoAtomically(tx, sb, doId, performedBy, null);
  return shipped.ok ? null : { id: doId, doNumber: doNo, ...(await keepCreatedDoAsDraft(sb, doId, companyId, doNo, shipped)) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function stockOutDoLinesFromRacks(
  sb: any,
  deliveryOrderId: string,
  doNo: string,
  performedBy: string,
  lineWh: Map<string, string | null>,
  items: Array<Record<string, unknown>>,
  companyId: number | null,
): Promise<void> {
  const RACK_REASON = DO_RACK_OUT_REASON;
  const state = await rackShipState(sb, doNo, companyId);
  if (state === 'already_out') return;
  if (state !== 'stock_out') { /* eslint-disable-next-line no-console */ console.error(`[do-rack] ${doNo}: racks not touched:`, state); return; }

  const companyCol = companyId != null ? { company_id: companyId } : {};
  /* Every rack read/write below FILTERS on the companyId stamped above: the rack is caller-supplied and the predicate is the only boundary (docs/bugs/0497-*.md). */
  const touchedRacks = new Set<string>();

  for (const it of items) {
    if (isServiceLine({ itemGroup: it.item_group as string | null, itemCode: it.item_code as string })) continue;
    const qty = Number(it.qty ?? 0);
    if (qty <= 0) continue;
    const itemCode = (it.item_code as string | null) ?? null;
    if (!itemCode) continue;
    const warehouseId = lineWh.get(it.id as string) ?? null;
    if (!warehouseId) continue;

    const explicitRackId = (it.rack_id as string | null) ?? null;
    let rackRows: Array<{ id: string; rack: string | null; warehouse_id: string | null }> = [];
    if (explicitRackId) {
      const { data } = await scopeToCompanyIdOrOpen(sb.from('warehouse_racks').select('id, rack, warehouse_id').eq('id', explicitRackId), companyId).limit(1);
      rackRows = (data ?? []) as typeof rackRows;
    } else {
      const { data: whRacks } = await scopeToCompanyIdOrOpen(sb.from('warehouse_racks').select('id, rack, warehouse_id').eq('warehouse_id', warehouseId), companyId);
      rackRows = (whRacks ?? []) as typeof rackRows;
    }
    if (rackRows.length === 0) continue;
    const rackIds = rackRows.map((r) => r.id);
    const rackById = new Map(rackRows.map((r) => [r.id, r]));

    const { data: placements } = await scopeToCompanyIdOrOpen(sb.from('warehouse_rack_items')
      .select('id, rack_id, qty, stocked_in_date')
      .in('rack_id', rackIds).eq('item_code', itemCode), companyId)
      .order('stocked_in_date', { ascending: true });
    const placementRows = (placements ?? []) as Array<{ id: string; rack_id: string; qty: number; stocked_in_date: string }>;

    let remaining = qty;
    const outByRack = new Map<string, number>();
    for (const p of placementRows) {
      if (remaining <= 0) break;
      const take = Math.min(p.qty, remaining);
      if (take >= p.qty) {
        await scopeToCompanyIdOrOpen(sb.from('warehouse_rack_items').delete().eq('id', p.id), companyId);
      } else {
        await scopeToCompanyIdOrOpen(sb.from('warehouse_rack_items').update({ qty: p.qty - take }).eq('id', p.id), companyId);
      }
      outByRack.set(p.rack_id, (outByRack.get(p.rack_id) ?? 0) + take);
      remaining -= take;
    }

    if (outByRack.size === 0) {
      if (!explicitRackId) continue;
      outByRack.set(explicitRackId, qty);
    }

    const moveRows = [...outByRack.entries()].map(([rackId, movedQty]) => {
      const r = rackById.get(rackId);
      touchedRacks.add(rackId);
      return {
        ...companyCol,
        movement_type: 'STOCK_OUT',
        rack_id: rackId,
        rack_label: r?.rack ?? null,
        warehouse_id: r?.warehouse_id ?? warehouseId,
        item_code: itemCode,
        product_name: (it.description as string | null) ?? null,
        source_doc_no: doNo,
        quantity: movedQty,
        reason: RACK_REASON,
        performed_by: performedBy,
      };
    });
    if (moveRows.length > 0) await sb.from('warehouse_rack_movements').insert(moveRows);
  }

  for (const rackId of touchedRacks) await refreshRackStatusInline(sb, rackId);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function refreshRackStatusInline(sb: any, rackId: string): Promise<void> {
  const { count } = await sb.from('warehouse_rack_items')
    .select('id', { head: true, count: 'exact' }).eq('rack_id', rackId);
  const { data: rack } = await sb.from('warehouse_racks')
    .select('reserved').eq('id', rackId).maybeSingle();
  const status = (count ?? 0) > 0 ? 'OCCUPIED' : (rack?.reserved ? 'RESERVED' : 'EMPTY');
  await sb.from('warehouse_racks').update({ status, updated_at: new Date().toISOString() }).eq('id', rackId);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function returnDoRacksOnCancel(sb: any, deliveryOrderId: string, doNo: string, performedBy: string, companyId: number | null, why: 'revert' | 'cancel'): Promise<void> {
  await markDoShippedFromReturned(sb, deliveryOrderId, companyId, why);
  const OUT_REASON = DO_RACK_OUT_REASON, IN_REASON = DO_RACK_IN_REASON;
  const { count: alreadyBack } = await sb.from('warehouse_rack_movements')
    .select('id', { head: true, count: 'exact' })
    .eq('movement_type', 'STOCK_IN').eq('source_doc_no', doNo).eq('reason', IN_REASON);
  if ((alreadyBack ?? 0) > 0) return;

  const { data: outs } = await sb.from('warehouse_rack_movements')
    .select('rack_id, rack_label, warehouse_id, item_code, product_name, quantity')
    .eq('movement_type', 'STOCK_OUT').eq('source_doc_no', doNo).eq('reason', OUT_REASON);
  const outRows = (outs ?? []) as Array<{ rack_id: string | null; rack_label: string | null; warehouse_id: string | null; item_code: string; product_name: string | null; quantity: number }>;
  if (outRows.length === 0) return;

  const companyCol = companyId != null ? { company_id: companyId } : {};
  const today = todayMyt();
  const touchedRacks = new Set<string>();

  for (const o of outRows) {
    if (o.rack_id) {
      await sb.from('warehouse_rack_items').insert({
        ...companyCol,
        rack_id: o.rack_id,
        item_code: o.item_code,
        product_name: o.product_name,
        source_doc_no: doNo,
        qty: o.quantity,
        stocked_in_date: today,
        notes: 'Returned on DO cancel',
      });
      touchedRacks.add(o.rack_id);
    }
    await sb.from('warehouse_rack_movements').insert({
      ...companyCol,
      movement_type: 'STOCK_IN',
      rack_id: o.rack_id,
      rack_label: o.rack_label,
      warehouse_id: o.warehouse_id,
      item_code: o.item_code,
      product_name: o.product_name,
      source_doc_no: doNo,
      quantity: o.quantity,
      reason: IN_REASON,
      performed_by: performedBy,
    });
  }
  for (const rackId of touchedRacks) await refreshRackStatusInline(sb, rackId);
  if (why === 'revert') {
    const err = await retireDoRackCycle(sb, doNo, companyId);
    /* eslint-disable-next-line no-console */
    if (err) console.error(`[do-rack] ${doNo}: returned cycle not retired (the next ship retires it):`, err);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- unchanged from before the export; the PostgREST shim has no honest type until schema.pg.ts covers the SCM tables.
export async function resyncInventoryForDo(sb: any, deliveryOrderId: string, performedBy: string) {
  let hdrRes = await sb.from('delivery_orders')
    .select('do_number, status, warehouse_id, is_dropship, company_id, migrated_no_stock')
    .eq('id', deliveryOrderId).maybeSingle();
  if (hdrRes.error && (hdrRes.error.message ?? '').includes('is_dropship')) {
    hdrRes = await sb.from('delivery_orders')
      .select('do_number, status, warehouse_id, company_id, migrated_no_stock')
      .eq('id', deliveryOrderId).maybeSingle();
  }
  if (hdrRes.error && (hdrRes.error.message ?? '').includes('migrated_no_stock')) {
    hdrRes = await sb.from('delivery_orders')
      .select('do_number, status, warehouse_id, company_id')
      .eq('id', deliveryOrderId).maybeSingle();
  }
  const doHeader = hdrRes.data;
  if (!doHeader) return;
  const status = ((doHeader as { status: string | null }).status ?? '').toUpperCase();
  if (!SHIPPED_STATES.includes(status)) return;
  if (isMigratedNoStock(doHeader as { migrated_no_stock?: boolean | null })) return;
  const headerWarehouseId = (doHeader as { warehouse_id: string | null }).warehouse_id ?? null;
  const doNo = (doHeader as { do_number: string }).do_number;
  const isDropship = (doHeader as { is_dropship?: boolean }).is_dropship === true;

  const { data: items, error: itemsErr } = await sb.from('delivery_order_items')
    .select('id, so_item_id, item_code, description, qty, item_group, variants, committed_po_batch_no')
    .eq('delivery_order_id', deliveryOrderId);
  if (itemsErr) return noteResyncReadFailure(sb, deliveryOrderId, doHeader, 'the DO lines', itemsErr);
  const lineWh = await resolveDoLineWarehouses(
    sb, (items ?? []) as Array<{ id: string; so_item_id?: string | null }>, headerWarehouseId,
    (doHeader as { company_id?: number | null }).company_id ?? undefined);

  let costBatches: { batchBySoItem: Map<string, string>; notes: CostBatchNote[] };
  try {
    costBatches = await resolveDoCostBatchMap(
      sb,
      (items ?? []) as Array<{ id: string; so_item_id?: string | null; item_code: string; item_group?: string | null; variants?: VariantAttrs | null; qty?: number | null }>,
      isDropship,
      (doHeader as { company_id?: number | null }).company_id ?? null,
      lineWh, deliveryOrderId, 'resync',
    );
  } catch (e) {
    return noteResyncReadFailure(sb, deliveryOrderId, doHeader, 'the batches the DO shipped under', { message: e instanceof Error ? e.message : String(e) });
  }
  const { batchBySoItem, notes: costNotes } = costBatches;
  const batchAware = batchBySoItem.size > 0;

  type Bucket = { warehouse_id: string; item_code: string; variant_key: string; product_name: string | null; qty: number; batch_no: string | null };
  const targetByBucket = new Map<string, Bucket>();
  const resyncKeyLine = (it: { id: string; item_code: string; item_group?: string | null; variants?: VariantAttrs | null }) =>
    ({ item_code: it.item_code, item_group: it.item_group ?? null, variants: it.variants ?? null, warehouse_id: lineWh.get(it.id) ?? null });
  const resyncKeyOf = await stockBucketKeyResolver(sb, (doHeader as { company_id?: number | null }).company_id ?? null,
    ((items ?? []) as Array<{ id: string; item_code: string; item_group?: string | null; variants?: VariantAttrs | null }>).map(resyncKeyLine));
  for (const it of (items as Array<{ id: string; so_item_id?: string | null; item_code: string; description: string | null; qty: number; item_group?: string | null; variants?: VariantAttrs | null }> ?? [])) {
    if (isServiceLine({ itemGroup: it.item_group, itemCode: it.item_code })) continue;
    const qty = Number(it.qty ?? 0);
    if (qty <= 0) continue;
    const warehouseId = lineWh.get(it.id) ?? null;
    if (!warehouseId) continue;
    const variant_key = resyncKeyOf(resyncKeyLine(it));
    const batch_no = it.so_item_id ? (batchBySoItem.get(it.so_item_id) ?? null) : null;
    const k = `${warehouseId}::${it.item_code}::${variant_key}::${batch_no ?? ''}`;
    const cur = targetByBucket.get(k);
    if (cur) { cur.qty += qty; }
    else targetByBucket.set(k, { warehouse_id: warehouseId, item_code: it.item_code, variant_key, product_name: it.description, qty, batch_no });
  }

  const baseSelect = batchAware
    ? 'movement_type, warehouse_id, item_code, variant_key, batch_no, qty, unit_cost_sen, total_cost_sen, product_name'
    : 'movement_type, warehouse_id, item_code, variant_key, qty, unit_cost_sen, total_cost_sen, product_name';
  let movsRes = await sb.from('inventory_movements')
    .select(`${baseSelect}, correction_seq`)
    .eq('source_doc_type', 'DO')
    .eq('source_doc_id', deliveryOrderId);
  if (movsRes.error && (movsRes.error.message ?? '').includes('correction_seq')) {
    movsRes = await sb.from('inventory_movements')
      .select(baseSelect)
      .eq('source_doc_type', 'DO')
      .eq('source_doc_id', deliveryOrderId);
  }
  if (movsRes.error) return noteResyncReadFailure(sb, deliveryOrderId, doHeader, 'the DO stock movements', movsRes.error);
  const movs = movsRes.data;
  type Agg = { out_qty: number; in_qty: number; out_total_cost: number; product_name: string | null; max_seq: number };
  const aggByBucket = new Map<string, Agg>();
  for (const m of (movs ?? []) as Array<{
    movement_type: string; warehouse_id: string; item_code: string; variant_key: string | null; batch_no?: string | null;
    qty: number; unit_cost_sen: number | null; total_cost_sen: number | null; product_name: string | null;
    correction_seq?: number | null;
  }>) {
    const k = `${m.warehouse_id}::${m.item_code}::${m.variant_key ?? ''}::${m.batch_no ?? ''}`;
    let agg = aggByBucket.get(k);
    if (!agg) { agg = { out_qty: 0, in_qty: 0, out_total_cost: 0, product_name: m.product_name, max_seq: 0 }; aggByBucket.set(k, agg); }
    if (m.movement_type === 'OUT') {
      agg.out_qty += Number(m.qty ?? 0);
      agg.out_total_cost += Number(m.total_cost_sen ?? 0);
    } else if (m.movement_type === 'IN') {
      agg.in_qty += Number(m.qty ?? 0);
    }
    agg.max_seq = Math.max(agg.max_seq, Number(m.correction_seq ?? 0));
    if (!agg.product_name) agg.product_name = m.product_name;
  }

  foldTargetsIntoOwnBuckets(targetByBucket, aggByBucket.keys(), (doHeader as { company_id?: number | null }).company_id ?? null);

  const allKeys = new Set<string>([...targetByBucket.keys(), ...aggByBucket.keys()]);
  type MovOut = Parameters<typeof writeMovements>[1][number];
  const writes: MovOut[] = [];
  const returns: DoUnitReturn[] = [];
  for (const k of allKeys) {
    const t = targetByBucket.get(k);
    const a = aggByBucket.get(k) ?? { out_qty: 0, in_qty: 0, out_total_cost: 0, product_name: null, max_seq: 0 };
    const target_qty = t?.qty ?? 0;
    const current_net_out = a.out_qty - a.in_qty;
    const delta = target_qty - current_net_out;
    if (delta === 0) continue;
    const parts = k.split('::');
    const warehouse_id = parts[0] ?? '';
    const item_code = parts[1] ?? '';
    const variant_key = parts[2] ?? '';
    const batch_no = parts[3] || null;
    const product_name = t?.product_name ?? a.product_name ?? null;
    const correction_seq = a.max_seq + 1;
    if (delta > 0) {
      writes.push({
        movement_type: 'OUT',
        warehouse_id,
        item_code, variant_key, product_name,
        qty: delta,
        source_doc_type: 'DO',
        source_doc_id: deliveryOrderId,
        source_doc_no: doNo,
        correction_seq,
        performed_by: performedBy,
        notes: ['Resync: line qty increased / line added (shipped DO).', costBatchNoteText(costNotes.filter((n) =>
          n.warehouseId === warehouse_id && n.itemCode === item_code && n.variantKey === variant_key
          && (n.reason === 'own-po-lot-short' ? n.poNumbers[0] ?? null : null) === batch_no))].filter(Boolean).join(' '),
        ...(batch_no ? { batch_no } : {}),
      });
    } else {
      returns.push({ warehouse_id, item_code, variant_key, batch_no, qty: -delta, correction_seq });
    }
  }

  const { handled, failed } = await returnDoUnitsAtCost(sb, deliveryOrderId, returns, performedBy ?? null);
  const rpcHandled = handled.map(returnedAsInRow);
  if (failed.length > 0) writes.length = 0;

  if (writes.length > 0 || rpcHandled.length > 0 || failed.length > 0) {
    const wrote = writes.length > 0
      ? await writeMovements(sb, writes, (doHeader as { company_id?: number | null }).company_id ?? null)
      : { ok: true as const, reason: undefined };
    const failNote = !wrote.ok
      ? `the resync delta movements were NOT written (${writes.length} row(s)): ${wrote.reason ?? 'unknown'}`
      : failed.length > 0 ? `stock could not be returned to its lots, so no delta was written: ${describeFailedReturns(failed)}` : null;
    if (failNote) {
      /* eslint-disable-next-line no-console */
      console.error(`[do-resync] DO ${deliveryOrderId}: ${failNote}`);
      try {
        await recordEntityAudit(sb, {
          entityType: 'DELIVERY_ORDER',
          entityId: deliveryOrderId,
          entityDocNo: (doHeader as { do_number?: string | null }).do_number ?? null,
          action: 'RECOUNT_FAILED',
          companyId: (doHeader as { company_id?: number | null }).company_id ?? null,
          source: 'resyncInventoryForDo',
          note: `Line edit committed on a shipped DO but ${failNote}. The ledger does not reflect this edit until a re-save repairs it.`,
        });
      } catch { }
      if (!wrote.ok || rpcHandled.length === 0) return;
    }
    await reconcileUncostedAfterIn(sb, [...writes, ...rpcHandled], performedBy);
    await restampDoActualCost(sb, deliveryOrderId);
    await queueDoShippedFromStamp(sb, deliveryOrderId, (doHeader as { company_id?: number | null }).company_id ?? null);
    try {
      const { recomputeAllocationAfterSave } = await import('../lib/stock-allocation-job');
      await recomputeAllocationAfterSave(sb, 'post-do-line-change');
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-do-resync failed:', e); }
  }
}

export async function reverseInventoryForDo(sb: any, deliveryOrderId: string, performedBy: string): Promise<string[]> {
  const { count: existing } = await sb
    .from('inventory_movements')
    .select('id', { head: true, count: 'exact' })
    .eq('source_doc_type', 'ADJUSTMENT')
    .eq('source_doc_id', deliveryOrderId);
  if ((existing ?? 0) > 0) return [];

  let hdrRes = await sb.from('delivery_orders')
    .select('do_number, warehouse_id, is_dropship, company_id')
    .eq('id', deliveryOrderId).maybeSingle();
  if (hdrRes.error && (hdrRes.error.message ?? '').includes('is_dropship')) {
    hdrRes = await sb.from('delivery_orders')
      .select('do_number, warehouse_id, company_id')
      .eq('id', deliveryOrderId).maybeSingle();
  }
  const doHeader = hdrRes.data;
  const doNo = (doHeader as { do_number: string } | null)?.do_number ?? deliveryOrderId;
  const isDropship = (doHeader as { is_dropship?: boolean } | null)?.is_dropship === true;

  let dropshipBatchedHandled = false;
  if (isDropship) {
    try {
      const { error: dsErr } = await sb.rpc('fn_reverse_dropship_do_out', {
        p_do_id: deliveryOrderId,
        p_performed_by: performedBy ?? null,
      });
      if (!dsErr) {
        dropshipBatchedHandled = true;
      } else if (!(dsErr.message ?? '').includes('fn_reverse_dropship_do_out')) {
        /* eslint-disable-next-line no-console */
        console.error('[dropship] cancel reversal fn failed (falling back to batched IN):', dsErr.message);
      }
    } catch (e) {
      /* eslint-disable-next-line no-console */
      console.error('[dropship] cancel reversal fn exception (falling back to batched IN):', e);
    }
  }

  let nonDropshipHandled = false;
  if (!isDropship) {
    try {
      const { error: rvErr } = await sb.rpc('fn_reverse_do_out', {
        p_do_id: deliveryOrderId,
        p_performed_by: performedBy ?? null,
        p_batched_only: false,
      });
      if (!rvErr) {
        nonDropshipHandled = true;
      } else if (!(rvErr.message ?? '').includes('fn_reverse_do_out')) {
        /* eslint-disable-next-line no-console */
        console.error('[do-cancel] reversal fn failed (falling back to ADJUSTMENT):', rvErr.message);
      }
    } catch (e) {
      /* eslint-disable-next-line no-console */
      console.error('[do-cancel] reversal fn exception (falling back to ADJUSTMENT):', e);
    }
  }

  const sel = 'movement_type, warehouse_id, item_code, variant_key, batch_no, qty, total_cost_sen, product_name';
  let movsRes = await sb.from('inventory_movements').select(sel)
    .eq('source_doc_type', 'DO').eq('source_doc_id', deliveryOrderId);
  if (movsRes.error && (movsRes.error.message ?? '').includes('batch_no')) {
    movsRes = await sb.from('inventory_movements')
      .select('movement_type, warehouse_id, item_code, variant_key, qty, total_cost_sen, product_name')
      .eq('source_doc_type', 'DO').eq('source_doc_id', deliveryOrderId);
  }
  const movs = movsRes.data;

  const movements = buildDoReversalRows(movs ?? [], {
    deliveryOrderId,
    doNo,
    performedBy,
    dropshipBatchedHandled,
    nonDropshipHandled,
  });
  if (movements.length > 0) {
    const companyId = (doHeader as { company_id?: number | null } | null)?.company_id ?? null;
    const wrote = await writeMovements(sb, movements, companyId);
    if (!wrote.ok) {
      const reason = wrote.reason ?? 'unknown';
      /* eslint-disable-next-line no-console */
      console.error(`[do-reverse] reversal movements FAILED for DO ${deliveryOrderId}: ${reason}`);
      try {
        await recordEntityAudit(sb, {
          entityType: 'DELIVERY_ORDER',
          entityId: deliveryOrderId,
          entityDocNo: (doHeader as { do_number?: string | null } | null)?.do_number ?? null,
          action: 'RECOUNT_FAILED',
          companyId,
          source: 'reverseInventoryForDo',
          note:
            `DO cancelled but the reversing movements were NOT written (${movements.length} row(s)): ${reason}. ` +
            `The shipped stock is still deducted until /inventory/reconcile or a re-cancel repairs it.`,
        });
      } catch { }
      return [`DO reversal movements failed: ${reason}`];
    }
    await reconcileUncostedAfterIn(sb, movements, performedBy);
  }
  return [];
}

export async function doLineConsumedQty(sb: any, doItemId: string): Promise<number> {
  let invoiced = 0, returned = 0;
  const { data: siLines, error: siLinesErr } = await sb.from('sales_invoice_items')
    .select('qty, sales_invoice_id').eq('do_item_id', doItemId);
  if (siLinesErr) throw readFailureError('do_line_consumed', siLinesErr);
  const siRows = (siLines ?? []) as Array<{ qty: number; sales_invoice_id: string }>;
  const siIds = [...new Set(siRows.map((l) => l.sales_invoice_id).filter(Boolean))];
  if (siIds.length > 0) {
    const { data: sis, error: sisErr } = await sb.from('sales_invoices').select('id, status').in('id', siIds);
    if (sisErr) throw readFailureError('do_line_consumed', sisErr);
    const active = new Set(((sis ?? []) as Array<{ id: string; status: string | null }>)
      .filter((s) => (s.status ?? '').toUpperCase() !== 'CANCELLED').map((s) => s.id));
    for (const l of siRows) if (active.has(l.sales_invoice_id)) invoiced += Number(l.qty ?? 0);
  }
  const { data: drLines, error: drLinesErr } = await sb.from('delivery_return_items')
    .select('qty_returned, delivery_return_id').eq('do_item_id', doItemId);
  if (drLinesErr) throw readFailureError('do_line_consumed', drLinesErr);
  const drRows = (drLines ?? []) as Array<{ qty_returned: number; delivery_return_id: string }>;
  const drIds = [...new Set(drRows.map((l) => l.delivery_return_id).filter(Boolean))];
  if (drIds.length > 0) {
    const { data: drs, error: drsErr } = await sb.from('delivery_returns').select('id, status').in('id', drIds);
    if (drsErr) throw readFailureError('do_line_consumed', drsErr);
    const active = new Set(((drs ?? []) as Array<{ id: string; status: string | null }>)
      .filter((d) => (d.status ?? '').toUpperCase() !== 'CANCELLED').map((d) => d.id));
    for (const l of drRows) if (active.has(l.delivery_return_id)) returned += Number(l.qty_returned ?? 0);
  }
  return invoiced + returned;
}

export { soDeliverableRemaining, type DeliverableLine } from '../lib/so-deliverable-remaining';
import { soDeliverableRemaining, type DeliverableLine } from '../lib/so-deliverable-remaining';

export type SoLineDelivery = { doNumber: string; qty: number; status: string };
export async function soLineDeliveries(
  sb: any,
  soItemIds: string[],
): Promise<Map<string, SoLineDelivery[]>> {
  const out = new Map<string, SoLineDelivery[]>();
  if (soItemIds.length === 0) return out;
  const { data: doLines, error: doLinesErr } = await sb
    .from('delivery_order_items')
    .select('so_item_id, qty, delivery_order_id')
    .in('so_item_id', soItemIds);
  if (doLinesErr) throw readFailureError('so_line_deliveries', doLinesErr);
  const rows = (doLines ?? []) as Array<{ so_item_id: string | null; qty: number; delivery_order_id: string }>;
  const doIds = [...new Set(rows.map((r) => r.delivery_order_id).filter(Boolean))];
  if (doIds.length === 0) return out;
  const { data: dos, error: dosErr } = await sb.from('delivery_orders').select('id, do_number, status').in('id', doIds);
  if (dosErr) throw readFailureError('so_line_deliveries', dosErr);
  const doMeta = new Map<string, { doNumber: string; status: string }>();
  for (const d of (dos ?? []) as Array<{ id: string; do_number: string | null; status: string | null }>) {
    const st = (d.status ?? '').toUpperCase();
    if (!doCountsAsDelivered(d.status)) continue;
    doMeta.set(d.id, { doNumber: d.do_number ?? '—', status: st });
  }
  for (const r of rows) {
    if (!r.so_item_id) continue;
    const meta = doMeta.get(r.delivery_order_id);
    if (!meta) continue;
    const arr = out.get(r.so_item_id) ?? [];
    arr.push({ doNumber: meta.doNumber, qty: Number(r.qty ?? 0), status: meta.status });
    out.set(r.so_item_id, arr);
  }
  return out;
}

export type DoLineDownstream = { docNumber: string; docType: 'SI' | 'DR'; qty: number; status: string };
export async function doLineDownstream(
  sb: any,
  doItemIds: string[],
): Promise<Map<string, DoLineDownstream[]>> {
  const out = new Map<string, DoLineDownstream[]>();
  const ids = [...new Set(doItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return out;

  const [siLinesRes, drLinesRes] = await Promise.all([
    chunkIn<{ do_item_id: string | null; qty: number; sales_invoice_id: string }>(ids, (batch, from, to) =>
      sb.from('sales_invoice_items').select('do_item_id, qty, sales_invoice_id').in('do_item_id', batch).range(from, to)),
    chunkIn<{ do_item_id: string | null; qty_returned: number; delivery_return_id: string }>(ids, (batch, from, to) =>
      sb.from('delivery_return_items').select('do_item_id, qty_returned, delivery_return_id').in('do_item_id', batch).range(from, to)),
  ]);
  const siLines = siLinesRes.data;
  const drLines = drLinesRes.data;

  const siIds = [...new Set(siLines.map((r) => r.sales_invoice_id).filter(Boolean))];
  const drIds = [...new Set(drLines.map((r) => r.delivery_return_id).filter(Boolean))];
  const [siHeadRes, drHeadRes] = await Promise.all([
    siIds.length > 0
      ? chunkIn<{ id: string; invoice_number: string | null; status: string | null }>(siIds, (batch, from, to) =>
          sb.from('sales_invoices').select('id, invoice_number, status').in('id', batch).range(from, to))
      : Promise.resolve({ data: [] as Array<{ id: string; invoice_number: string | null; status: string | null }> }),
    drIds.length > 0
      ? chunkIn<{ id: string; return_number: string | null; status: string | null }>(drIds, (batch, from, to) =>
          sb.from('delivery_returns').select('id, return_number, status').in('id', batch).range(from, to))
      : Promise.resolve({ data: [] as Array<{ id: string; return_number: string | null; status: string | null }> }),
  ]);
  const siMeta = new Map<string, { docNumber: string; status: string }>();
  for (const s of siHeadRes.data as Array<{ id: string; invoice_number: string | null; status: string | null }>) {
    if ((s.status ?? '').toUpperCase() === 'CANCELLED') continue;
    siMeta.set(s.id, { docNumber: s.invoice_number ?? '—', status: (s.status ?? '').toUpperCase() });
  }
  const drMeta = new Map<string, { docNumber: string; status: string }>();
  for (const d of drHeadRes.data as Array<{ id: string; return_number: string | null; status: string | null }>) {
    if ((d.status ?? '').toUpperCase() === 'CANCELLED') continue;
    drMeta.set(d.id, { docNumber: d.return_number ?? '—', status: (d.status ?? '').toUpperCase() });
  }

  const push = (doItemId: string | null, entry: DoLineDownstream) => {
    if (!doItemId) return;
    const arr = out.get(doItemId) ?? [];
    arr.push(entry);
    out.set(doItemId, arr);
  };
  for (const r of siLines) {
    const meta = siMeta.get(r.sales_invoice_id);
    if (!meta) continue;
    push(r.do_item_id, { docNumber: meta.docNumber, docType: 'SI', qty: Number(r.qty ?? 0), status: meta.status });
  }
  for (const r of drLines) {
    const meta = drMeta.get(r.delivery_return_id);
    if (!meta) continue;
    push(r.do_item_id, { docNumber: meta.docNumber, docType: 'DR', qty: Number(r.qty_returned ?? 0), status: meta.status });
  }
  return out;
}

export async function soLineShippedSourcePos(
  sb: any,
  soItemIds: string[],
): Promise<Map<string, string[]>> {
  return soLineShippedSourcePosImpl(sb, soItemIds);
}

export type SoLifecycle = 'none' | 'delivered' | 'invoiced' | 'returned';
export async function computeSoLifecycle(
  sb: any,
  docNos: string[],
): Promise<Map<string, SoLifecycle>> {
  const out = new Map<string, SoLifecycle>();
  const ids = [...new Set(docNos.filter(Boolean))];
  if (ids.length === 0) return out;

  type Ev = { date: string; createdAt: string; kind: SoLifecycle };
  const events = new Map<string, Ev[]>();
  const push = (doc: string | null | undefined, ev: Ev) => {
    if (!doc) return;
    const arr = events.get(doc) ?? [];
    arr.push(ev);
    events.set(doc, arr);
  };

  const [doRes, siRes] = await Promise.all([
    sb.from('delivery_orders')
      .select('id, so_doc_no, do_date, created_at, status')
      .in('so_doc_no', ids)
      .neq('status', 'CANCELLED'),
    sb.from('sales_invoices')
      .select('so_doc_no, invoice_date, created_at, status')
      .in('so_doc_no', ids)
      .neq('status', 'CANCELLED'),
  ]);
  if (doRes.error || siRes.error) throw readFailureError('so_lifecycle', doRes.error ?? siRes.error);

  const doToSo = new Map<string, string>();
  for (const d of (doRes.data ?? []) as Array<{ id: string; so_doc_no: string | null; do_date: string | null; created_at: string | null }>) {
    if (d.so_doc_no) doToSo.set(d.id, d.so_doc_no);
    push(d.so_doc_no, { date: d.do_date ?? d.created_at ?? '', createdAt: d.created_at ?? '', kind: 'delivered' });
  }
  for (const s of (siRes.data ?? []) as Array<{ so_doc_no: string | null; invoice_date: string | null; created_at: string | null }>) {
    push(s.so_doc_no, { date: s.invoice_date ?? s.created_at ?? '', createdAt: s.created_at ?? '', kind: 'invoiced' });
  }

  const doIds = [...doToSo.keys()];
  if (doIds.length > 0) {
    const { data: drRows, error: drErr } = await sb.from('delivery_returns')
      .select('delivery_order_id, return_date, created_at, status')
      .in('delivery_order_id', doIds)
      .neq('status', 'CANCELLED');
    if (drErr) throw readFailureError('so_lifecycle', drErr);
    for (const r of (drRows ?? []) as Array<{ delivery_order_id: string | null; return_date: string | null; created_at: string | null }>) {
      const so = r.delivery_order_id ? doToSo.get(r.delivery_order_id) : undefined;
      push(so, { date: r.return_date ?? r.created_at ?? '', createdAt: r.created_at ?? '', kind: 'returned' });
    }
  }

  const priority: Record<SoLifecycle, number> = { none: 0, delivered: 1, invoiced: 2, returned: 3 };
  for (const [doc, evs] of events) {
    let best: Ev | null = null;
    for (const ev of evs) {
      if (!best) { best = ev; continue; }
      const dc = normalizeEventDay(ev.date).localeCompare(normalizeEventDay(best.date));
      if (dc > 0) { best = ev; continue; }
      if (dc < 0) continue;
      const cc = ev.createdAt.localeCompare(best.createdAt);
      if (cc > 0) { best = ev; continue; }
      if (cc < 0) continue;
      if (priority[ev.kind] > priority[best.kind]) best = ev;
    }
    out.set(doc, best ? best.kind : 'none');
  }
  return out;
}

export type { DoLifecycle };
export async function computeDoLifecycle(
  sb: any,
  doIds: string[],
): Promise<Map<string, DoLifecycle>> {
  const ids = [...new Set(doIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const [siRes, drRes] = await Promise.all([
    sb.from('sales_invoices')
      .select('delivery_order_id, invoice_date, created_at, status')
      .in('delivery_order_id', ids)
      .neq('status', 'CANCELLED'),
    sb.from('delivery_returns')
      .select('delivery_order_id, return_date, created_at, status')
      .in('delivery_order_id', ids)
      .neq('status', 'CANCELLED'),
  ]);
  return doLifecycleFrom(ids, (siRes.data ?? []) as DoLifecycleSi[], (drRes.data ?? []) as DoLifecycleDr[]);
}

export async function soCurrentDocNo(
  sb: any,
  docNos: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(docNos.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const byKey = new Map<string, CurrentEvent[]>();
  const push = (doc: string | null | undefined, ev: CurrentEvent) => {
    if (!doc) return;
    const arr = byKey.get(doc) ?? [];
    arr.push(ev);
    byKey.set(doc, arr);
  };

  const [doRes, siRes] = await Promise.all([
    sb.from('delivery_orders')
      .select('id, so_doc_no, do_number, do_date, created_at, status')
      .in('so_doc_no', ids)
      .neq('status', 'CANCELLED'),
    sb.from('sales_invoices')
      .select('so_doc_no, invoice_number, invoice_date, created_at, status')
      .in('so_doc_no', ids)
      .neq('status', 'CANCELLED'),
  ]);
  if (doRes.error || siRes.error) throw readFailureError('so_lifecycle', doRes.error ?? siRes.error);

  const doToSo = new Map<string, string>();
  for (const d of (doRes.data ?? []) as Array<{ id: string; so_doc_no: string | null; do_number: string | null; do_date: string | null; created_at: string | null }>) {
    if (d.so_doc_no) doToSo.set(d.id, d.so_doc_no);
    push(d.so_doc_no, { date: d.do_date ?? d.created_at ?? '', createdAt: d.created_at ?? '', rank: 1, docNumber: d.do_number ?? '—' });
  }
  for (const s of (siRes.data ?? []) as Array<{ so_doc_no: string | null; invoice_number: string | null; invoice_date: string | null; created_at: string | null }>) {
    push(s.so_doc_no, { date: s.invoice_date ?? s.created_at ?? '', createdAt: s.created_at ?? '', rank: 2, docNumber: s.invoice_number ?? '—' });
  }

  const doIds = [...doToSo.keys()];
  if (doIds.length > 0) {
    const { data: drRows, error: drErr } = await sb.from('delivery_returns')
      .select('delivery_order_id, return_number, return_date, created_at, status')
      .in('delivery_order_id', doIds)
      .neq('status', 'CANCELLED');
    if (drErr) throw readFailureError('so_lifecycle', drErr);
    for (const r of (drRows ?? []) as Array<{ delivery_order_id: string | null; return_number: string | null; return_date: string | null; created_at: string | null }>) {
      const so = r.delivery_order_id ? doToSo.get(r.delivery_order_id) : undefined;
      push(so, { date: r.return_date ?? r.created_at ?? '', createdAt: r.created_at ?? '', rank: 3, docNumber: r.return_number ?? '—' });
    }
  }

  return currentDocNoByKey(byKey);
}




deliveryOrdersMfg.get('/', async (c) => {
  const sb = c.get('supabase');
  const canViewAll = canViewAllSales(c);
  const houzsUserId = c.get('houzsUser')?.id;
  if (!canViewAll && houzsUserId == null) {
    return c.json({ error: 'Your account is not linked to a Houzs user, so delivery orders cannot be shown — please contact IT.' }, 403);
  }
  const scopeIds = await resolveSalesScopeIds(sb, c.env, houzsUserId, canViewAll);

  const pageRaw = c.req.query('page');
  const paginate = pageRaw !== undefined && pageRaw !== '';

  let data: unknown = null;
  let error: { message: string } | null = null;
  let total = 0;
  let page = 0;
  let pageSize = 50;
  let statusCounts: Record<string, number> | undefined;
  let countError: string | null = null;

  if (!paginate) {
    let q = sb.from('delivery_orders').select(HEADER).order('do_date', { ascending: false }).limit(500);
    q = scopeToCompany(q, c);
    if (scopeIds) q = q.in('salesperson_id', scopeIds);
    const status = c.req.query('status'); if (status) q = q.eq('status', status);
    const res = await q;
    data = res.data;
    error = res.error;
  } else {
    page = Math.max(0, Math.trunc(Number(pageRaw)) || 0);
    const psRaw = Number(c.req.query('pageSize'));
    pageSize = Number.isFinite(psRaw) && psRaw > 0 ? Math.min(100, Math.max(1, Math.trunc(psRaw))) : 50;

    const listParams = await withSoRefDocNos(sb, c, readDoListParams((k) => c.req.query(k)));
    let q = filterDoList(orderDoList(fromDoList(sb, HEADER, { count: 'exact' }), listParams.sort), listParams, c, scopeIds);
    q = q.range(page * pageSize, page * pageSize + pageSize - 1);
    const res = await q;
    data = res.data;
    error = res.error;
    total = res.count ?? (res.data?.length ?? 0);

    const counted = await doListStatusCounts((sel) => {
      let cq = scopeToCompany(sb.from('delivery_orders').select(sel), c);
      if (scopeIds) cq = cq.in('salesperson_id', scopeIds);
      return windowDoList(cq, listParams);
    });
    if (counted.ok) statusCounts = counted.counts; else countError = counted.reason;
  }
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (countError) return c.json({ error: 'status_counts_failed', reason: countError }, 500);

  const deliveryOrders = await buildDoListRows(sb, c, (data ?? []) as unknown as Array<{ id: string } & Record<string, unknown>>, DO_LIST_ROW_DEPS);
  if (paginate) {
    const withLines = await attachDoLines(sb, c, deliveryOrders, { charges: canViewScmFinance(c) });
    if (withLines.error) return c.json({ error: 'lines_read_failed', reason: withLines.error }, 500);
    return c.json({ deliveryOrders, total, page, pageSize, statusCounts });
  }
  return c.json({ deliveryOrders });
});

deliveryOrdersMfg.get('/deliverable-so-lines', async (c) => {
  const sb = c.get('supabase');

  const docNosParam = c.req.query('docNos');
  let docNos: string[];
  if (docNosParam && docNosParam.trim()) {
    docNos = [...new Set(docNosParam.split(',').map((d) => d.trim()).filter(Boolean))];
  } else {
    const { data: sos, error } = await paginateAll<{ doc_no: string; status: string }>((from, to) => scopeToCompany(sb
      .from('mfg_sales_orders')
      .select('doc_no, status')
      .neq('status', 'CANCELLED'), c)
      .order('doc_no', { ascending: false })
      .range(from, to));
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    docNos = ((sos ?? []) as Array<{ doc_no: string }>).map((s) => s.doc_no).filter(Boolean);
  }
  if (docNos.length === 0) return c.json({ lines: [] });

  const remainingMap = await soDeliverableRemaining(sb, docNos);
  const lines = [...remainingMap.values()].filter((l) => l.remaining > 0);
  // The order's customer reference, for the picker's search (owner 2026-09-25).
  // The not-ready read needs only the line ids, so it runs beside the reference stamp.
  const notReadyProm = eager(findNotReadySoLines(sb, lines.map((l) => l.soItemId), activeCompanyId(c) ?? null));
  await stampSoRefsCamel(sb, lines, (l) => l.docNo, (q) => scopeToAllowedCompanies(q, c), 'deliverable-so-lines');
  const notReady = new Map((await notReadyProm)().map((n) => [n.soItemId, n]));
  return c.json({ lines: lines.map((l) => ({ ...l, notReady: notReady.get(l.soItemId) ?? null })) });
});

async function loadSoHeaderForConversion(
  sb: ReturnType<typeof getSupabaseService>,
  docNo: string,
  sourceCompanyId: number | undefined,
): Promise<{ head: Record<string, unknown> | null; error: string | null }> {
  const q = sb
    .from('mfg_sales_orders')
    .select(SO_CONVERT_HEADER)
    .eq('doc_no', docNo);
  const { data, error } = await (sourceCompanyId != null ? scopeToCompanyId(q, sourceCompanyId) : q)
    .maybeSingle();
  if (error) return { head: null, error: error.message };
  return { head: (data as unknown as Record<string, unknown>) ?? null, error: null };
}

deliveryOrdersMfg.get('/so-source/:docNo', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  if (!docNo) return c.json({ error: 'doc_no_required' }, 400);

  const { data: row, error } = await scopeToAllowedCompanies(
    sb.from('mfg_sales_orders').select(SO_CONVERT_HEADER).eq('doc_no', docNo),
    c,
  ).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!row) {
    return c.json({ error: 'so_not_found', docNo }, 404);
  }
  const source = soHeaderToDoSource(row as unknown as Record<string, unknown>);
  return c.json({ source, missing: missingSourceFields(source) });
});

deliveryOrdersMfg.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    // Company-scoped (owner 2026-08-10 audit) — a bare uuid must not read
    // another company's delivery order.
    scopeToCompany(sb.from('delivery_orders').select(HEADER), c).eq('id', id).maybeSingle(),
    sb.from('delivery_order_items').select(ITEM).eq('delivery_order_id', id)
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  if (i.error) return c.json(readFailure('do_lines', i.error), 500);
  {
    const sp = (h.data as { salesperson_id?: number | string | null }).salesperson_id;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), sp)) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
  const [{ count: drCount }, { count: siCount }] = await Promise.all([
    sb.from('delivery_returns')
      .select('id', { head: true, count: 'exact' })
      .eq('delivery_order_id', id)
      .neq('status', 'CANCELLED'),
    sb.from('sales_invoices')
      .select('id', { head: true, count: 'exact' })
      .eq('delivery_order_id', id)
      .neq('status', 'CANCELLED'),
  ]);
  const lifecycleByDo = await computeDoLifecycle(sb, [id]);
  const { data: crew, error: crewErr } = await sb.from('delivery_order_crew')
    .select(crewSnapshotCols).eq('do_id', id).maybeSingle();
  if (crewErr) return c.json(readFailure('do_crew', crewErr), 500);
  const deliveryOrder = {
    ...(h.data as unknown as Record<string, unknown>),
    has_children: (drCount ?? 0) > 0 || (siCount ?? 0) > 0,
    lifecycle_state: lifecycleByDo.get(id) ?? 'shipped',
    crew: crew ?? null,
  };
  const rawItems = i.data as unknown as Array<{ id: string; so_item_id?: string | null } & Record<string, unknown>>;
  const headerWh = (h.data as { warehouse_id?: string | null }).warehouse_id ?? null;
  const [lineWh, downstreamMap, sourcePosByBucket] = await Promise.all([
    resolveDoLineWarehouses(sb, rawItems, headerWh, activeCompanyId(c)),
    doLineDownstream(sb, rawItems.map((it) => it.id)),
    resolveDoLineSources(sb, id),
  ]);
  const whLabels = await doWarehouseLabels(sb, c, [...lineWh.values(), headerWh]);
  (deliveryOrder as Record<string, unknown>).warehouse_code = headerWh ? (whLabels.get(headerWh)?.label ?? null) : null;
  (deliveryOrder as Record<string, unknown>).warehouse_name = headerWh ? (whLabels.get(headerWh)?.name ?? null) : null;
  const [doRacks, shippedFrom] = await Promise.all([resolveDoLineRacks(sb, rawItems, lineWh), loadShippedFromRacks(scopeToCompany(sb.from('warehouse_rack_movements').select('item_code, rack_label'), c), (h.data as { do_number?: string | null }).do_number ?? null)]);
  const unresolvedSoIds = rawItems
    .filter((it) => {
      const vk = computeVariantKey(
        (it.item_group as string | null) ?? null,
        (it.variants as VariantAttrs | null) ?? null,
      );
      const trace = sourcePosByBucket.get(`${(it.item_code as string) ?? ''}::${vk}`);
      return !trace || (trace.pos.length === 0 && trace.adjQty <= 0);
    })
    .map((it) => (it.so_item_id as string | null) ?? null)
    .filter((x): x is string => Boolean(x));
  const boundPoBySoItem = unresolvedSoIds.length > 0
    ? await resolveExpectedBatchBySoItem(sb, unresolvedSoIds, { onMultiPo: 'latest' })
    : new Map<string, { poNumber: string }>();
  /* Per-line Assigned SO (owner 2026-07-31): a DO is HARD-linked to its Sales
     Order — never an MRP guess — so the drill-down shows each line's intrinsic SO
     doc_no + that SO's effective delivery date (amended ?? customer), resolved
     from the line's so_item_id. ONE batched pair of reads; fail-soft to a dash. */
  const lineSoItemIds = [...new Set(
    rawItems.map((it) => (it.so_item_id as string | null) ?? null).filter((x): x is string => !!x),
  )];
  const soDocBySoItem = new Map<string, string>();
  const soDeliveryByDoc = new Map<string, string | null>();
  if (lineSoItemIds.length > 0) {
    const { data: soItemRows } = await sb.from('mfg_sales_order_items')
      .select('id, doc_no').in('id', lineSoItemIds);
    for (const r of (soItemRows ?? []) as Array<{ id: string; doc_no: string | null }>) {
      if (r.doc_no) soDocBySoItem.set(r.id, r.doc_no);
    }
    const docNos = [...new Set([...soDocBySoItem.values()])];
    if (docNos.length > 0) {
      const { data: soHdrs } = await sb.from('mfg_sales_orders')
        .select('doc_no, customer_delivery_date, amended_delivery_date').in('doc_no', docNos);
      for (const h of (soHdrs ?? []) as Array<{ doc_no: string | null; customer_delivery_date: string | null; amended_delivery_date: string | null }>) {
        if (h.doc_no) soDeliveryByDoc.set(h.doc_no, effectiveSoDelivery(h));
      }
    }
  }
  const items = rawItems.map((it) => {
    const wid = lineWh.get(it.id) ?? null;
    const variantKey = computeVariantKey(
      (it.item_group as string | null) ?? null,
      (it.variants as VariantAttrs | null) ?? null,
    );
    const bucketKey = `${(it.item_code as string) ?? ''}::${variantKey}`;
    const trace = sourcePosByBucket.get(bucketKey) ?? { pos: [], adjQty: 0 };
    const ledgerPos = trace.pos;
    const boundPo = ledgerPos.length === 0 && trace.adjQty <= 0 && it.so_item_id
      ? (boundPoBySoItem.get(it.so_item_id as string)?.poNumber ?? null)
      : null;
    const sourcePos = ledgerPos.length > 0 ? [...ledgerPos] : (boundPo ? [boundPo] : []);
    const racks = racksForDoLine(doRacks, {
      warehouseId: wid,
      itemCode: (it.item_code as string | null) ?? null,
      rackId: (it.rack_id as string | null) ?? null,
      sourcePos,
    }, shippedFrom);
    return {
      ...it,
      warehouse_id: wid,
      warehouse_code: wid ? (whLabels.get(wid)?.label ?? null) : null,
      downstream: downstreamMap.get(it.id) ?? [],
      source_pos: sourcePos,
      source_adj: trace.adjQty > 0,
      racks,
      so_doc_no: it.so_item_id ? (soDocBySoItem.get(it.so_item_id as string) ?? null) : null,
      so_delivery_date: it.so_item_id
        ? (soDeliveryByDoc.get(soDocBySoItem.get(it.so_item_id as string) ?? '') ?? null)
        : null,
    };
  });
  if (!canViewScmFinance(c)) {
    for (const k of DO_FINANCE_KEYS) delete (deliveryOrder as Record<string, unknown>)[k];
    for (const it of items) {
      for (const k of SO_ITEM_FINANCE_KEYS) delete (it as Record<string, unknown>)[k];
    }
  }
  // Stamp each line's supplier fabric code so the on-screen line reads
  // "BF-01 (PC151-01)" (owner 2026-07-24). ONE batched query; fail-soft.
  await enrichLinesWithFabricSupplierCode(sb, c, items);
  return c.json({ deliveryOrder, items: withShippedFromStamp(items) });
});

export const createDeliveryOrderHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const lap = stepClock();
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const debtorName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!debtorName) return c.json({ error: 'debtor_name_required' }, 400);
  let items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];

  const sb = c.get('supabase'); const user = c.get('user');

  if (items.length > 0) {
    const codeCheck = await validateItemCodes(sb, items.map((it) => it.itemCode as string | null | undefined), activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  {
    const linked = await fillMissingSoItemIds(sb, (body.soDocNo as string | null) ?? null, items);
    if (!linked.ok) return c.json({ error: linked.error, message: linked.message }, 400);
    /* THE GROUP IS THE SKU'S, AND IT IS DECIDED ONCE — docs/bugs/0524.
       `item_group` is not a label, it is the input to the stock bucket
       (shared/variant-key.ts), so a client that sends a blank or wrong one
       chooses which bucket this delivery checks AND deducts from. Rewritten
       here, above every reader: the stock check, the ship-commitment planner,
       the service/sofa guards and buildItemRow all read these same objects, so
       the answer they get cannot differ. #2660 closed the inbound half. */
    items = await resolveItemGroups(sb, linked.items, activeCompanyId(c) ?? null);
    if (variantTrackedCompany(activeCompanyId(c) ?? null)) {
      try { items = await adoptSoLineSpecs(sb, items, activeCompanyId(c) ?? null); } catch (e) {
        return c.json({ error: 'lookup_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
      }
    }
  }

  const headerWarehouseId = (body.warehouseId as string | undefined) ?? null;
  const stockLines = items.map((it, idx) => ({
    lineRef: String(idx),
    soItemId: (it.soItemId as string | null) ?? null,
    itemCode: String(it.itemCode ?? ''),
    itemGroup: (it.itemGroup as string | null) ?? null,
    productName: (it.description as string | null) ?? null,
    variantKey: computeVariantKey((it.itemGroup as string | null) ?? null, (it.variants as VariantAttrs | null) ?? null),
    qty: Number(it.qty ?? 0),
  }));
  const additions = new Map<string, number>();
  for (const it of items) {
    const sid = it.soItemId as string | undefined;
    if (!sid) continue;
    additions.set(sid, (additions.get(sid) ?? 0) + Number(it.qty ?? 0));
  }
  const notReadyProm = (body.confirmNotReady || body.asDraft === true) ? null : eager(findNotReadySoLines(sb, items.map((it) => String(it.soItemId ?? '')), activeCompanyId(c) ?? null));
  const lineWarehousesProm = eager(resolveDoLineWarehouses(sb, stockLines.map((l) => ({ id: l.lineRef, so_item_id: l.soItemId })), headerWarehouseId, activeCompanyId(c)));
  const shortagesProm = items.length > 0 ? eager(checkDoStockAvailability(sb, stockLines, headerWarehouseId, activeCompanyId(c))) : null;
  const remainingProm = additions.size > 0 ? eager(soRemainingByItemId(sb, [...additions.keys()])) : null;
  const unlinkedProm = eager(findUnlinkedSoLines(sb, (body.soDocNo as string | null) ?? null,
    items.map((it, idx) => ({
      lineRef: String(idx),
      itemCode: String(it.itemCode ?? ''),
      qty: Number(it.qty ?? 0),
      soItemId: (it.soItemId as string | null) ?? null,
    }))));
  const sofaProm = items.length > 0 ? eager(findSofaLinesWithoutCompleteBatch(sb, items.map((it) => ({
    itemCode: String(it.itemCode ?? ''),
    itemGroup: (it.itemGroup as string | null) ?? null,
    soItemId: (it.soItemId as string | null) ?? null,
    fromStock: it.soItemId ? null : {
      variantKey: computeVariantKey((it.itemGroup as string | null) ?? null, (it.variants ?? null) as VariantAttrs | null),
      qty: Number(it.qty ?? 0),
      warehouseId: (it.warehouseId as string | null) ?? headerWarehouseId,
    },
  })), activeCompanyId(c))) : null;
  const partialProm = items.length > 0 ? eager(findIncompleteSofaSets(sb, items.map((it) => (it.soItemId as string | null) ?? null), activeCompanyId(c))) : null;

  {
    const refDocNos: Array<string | null | undefined> = [(body.soDocNo as string | undefined) ?? null];
    const lineSoItemIds = items
      .map((it) => it.soItemId as string | undefined)
      .filter((x): x is string => !!x);
    if (lineSoItemIds.length > 0) {
      const { data: lineSoRows } = await sb
        .from('mfg_sales_order_items').select('id, doc_no, item_code').in('id', lineSoItemIds);
      const soRows = (lineSoRows ?? []) as Array<{ id: string; doc_no: string | null; item_code: string | null }>;
      for (const r of soRows) refDocNos.push(r.doc_no);
      /* IDENTITY too — docs/bugs/0672 site 15; the rows are already in hand. A
         wrong so_item_id ships against the wrong order line, prints that line's
         photos, and (HARD-BOUND sofa/bedframe) lights the wrong stock. */
      const idBad = lineLinkItemMismatch(
        items.filter((it) => it.soItemId).map((it) => ({ linkId: it.soItemId as string, itemCode: it.itemCode })),
        new Map(soRows.map((r) => [r.id, r.item_code])), { source: 'Sales Order line' });
      if (idBad) { markIdempotencyNoWrite(c); return c.json(idBad, 409); }
    }
    const soDocNos = [...new Set(refDocNos.filter((d): d is string => !!d))];
    const soCoProm = soDocNos.length > 0 ? eager(Promise.resolve(sb.from('mfg_sales_orders').select('doc_no, company_id').in('doc_no', soDocNos))) : null;
    const offender = await firstUndeliverableSo(sb, refDocNos);
    if (offender) return c.json(soNotDeliverableResponse(offender), 409);

    if (soCoProm) {
      const { data: soCoRows, error: soCoErr } = (await soCoProm)() as { data: unknown; error: { message: string } | null };
      if (soCoErr) return c.json({ error: 'load_failed', reason: soCoErr.message }, 500);
      for (const r of (soCoRows ?? []) as Array<{ doc_no: string; company_id: number | null }>) {
        if (isCrossCompanySource(r.company_id, c)) {
          return c.json(crossCompanyConversionBlocked(r.doc_no, r.company_id, c), 409);
        }
      }
    }
  }

  if (notReadyProm) {
    const notReady = (await notReadyProm)();
    if (notReady.length > 0) { markIdempotencyNoWrite(c); return c.json(itemsNotReadyResponse(notReady), 409); }
  }

  const lineWarehouses = (await lineWarehousesProm)();
  const shipWarehouseId = headerWarehouseId
    ?? primaryWarehouseOf([...lineWarehouses.values()])
    ?? (await defaultWarehouseId(sb, activeCompanyId(c)));
  let shortages: StockShortage[] = [];
  let commitments = new Map<string, ShipBinding>();
  if (items.length > 0 && shipWarehouseId) {
    shortages = (await shortagesProm!)();
    const plan = await resolveShipCommitments(
      sb,
      items.map((it, idx) => ({
        lineRef: String(idx),
        soItemId: (it.soItemId as string | null) ?? null,
        itemCode: String(it.itemCode ?? ''),
        itemGroup: (it.itemGroup as string | null) ?? null,
        variantKey: computeVariantKey((it.itemGroup as string | null) ?? null, (it.variants as VariantAttrs | null) ?? null),
        qty: Number(it.qty ?? 0),
      })),
      shipWarehouseId,
      shortages,
      activeCompanyId(c) ?? null,
    );
    if (plan.setConflicts.length > 0) {
      markIdempotencyNoWrite(c);
      return c.json(sofaSetPoSplitResponse(plan.setConflicts), 409);
    }
    commitments = plan.bindings;
    if (shortages.length > 0 && !body.confirmShortStock && body.asDraft !== true) {
      markIdempotencyNoWrite(c);
      return c.json(shortStockResponse(shortages, bindingList(commitments)), 409);
    }
  }


  {
    if (remainingProm) {
      const remaining = (await remainingProm)();
      for (const [sid, addQty] of additions) {
        const rem = remaining.get(sid) ?? 0;
        if (addQty > rem) {
          return c.json({
            error: 'over_remaining',
            message: `Pick qty ${addQty} exceeds remaining ${rem} on the linked Sales Order line.`,
            soItemId: sid, remaining: rem, requested: addQty,
          }, 409);
        }
      }
    }
  }

  {
    const unlinked = (await unlinkedProm)();
    const bad = unlinkedScanRefusal(unlinked, unlinkedSoLinesResponse);
    if (bad) { markIdempotencyNoWrite(c); return c.json(bad, 409); }
  }

  let dropShipped = false;
  if (items.length > 0) {
    const sofaOffenders = (await sofaProm!)();
    if (sofaOffenders.length > 0) {
      const dropship = await buildDropshipOffenders(sb, sofaOffenders);
      const allHavePo = dropship.length > 0 && dropship.every((o) => !!o.poNumber);
      if (body.dropShip !== true || !allHavePo) {
        markIdempotencyNoWrite(c);
        return c.json(sofaNoCompleteBatchResponse(sofaOffenders, dropship), 409);
      }
      dropShipped = true;
    }
    const partial = (await partialProm!)();
    if (partial.length > 0) {
      markIdempotencyNoWrite(c);
      return c.json(sofaIncompleteSetResponse(partial), 409);
    }
  }

  const phoneRaw = (body.phone as string | undefined) ?? null;
  const emPhoneRaw = (body.emergencyContactPhone as string | undefined) ?? null;

  lap('do-checks');
  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; do_number: string }>(
    () => nextNum(sb, c),
    (doNumber) => sb.from('delivery_orders').insert({
    company_id: activeCompanyId(c),
    do_number: doNumber,
    warehouse_id: doShipFromWarehouseId(headerWarehouseId, lineWarehouses),
    so_doc_no: (body.soDocNo as string) ?? null,
    debtor_code: (body.debtorCode as string) ?? null,
    debtor_name: debtorName,
    do_date: dateOrNull(body.doDate) ?? todayMyt(),
    expected_delivery_at: dateOrNull(body.expectedDeliveryAt) ?? dateOrNull(body.customerDeliveryDate),
    customer_delivery_date: dateOrNull(body.customerDeliveryDate),
    arrives_em_warehouse_date: dateOrNull(body.arrivesEmWarehouseDate),
    driver_id: (body.driverId as string) ?? null,
    driver_name: (body.driverName as string) ?? null,
    vehicle: (body.vehicle as string) ?? null,
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
    ref: (body.ref as string) || (body.customerSoNo as string) || null,
    customer_so_no: (body.customerSoNo as string) ?? null,
    po_doc_no: (body.poDocNo as string) ?? null,
    sales_location: (body.salesLocation as string) ?? null,
    note: (body.note as string) ?? null,
    emergency_contact_name: (body.emergencyContactName as string) ?? null,
    emergency_contact_phone: emPhoneRaw ? (normalizePhone(emPhoneRaw) ?? emPhoneRaw) : null,
    emergency_contact_relationship: (body.emergencyContactRelationship as string) ?? null,
    currency: (body.currency as string) ?? 'MYR',
    status: (body.asDraft === true) ? 'DRAFT' : 'LOADED',
    is_dropship: dropShipped,
    notes: (body.notes as string) ?? null,
    created_by: user.id,
    }).select(HEADER).single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; do_number: string };

  if (items.length > 0) {
    const linePhotos = await loadCarriedSoLinePhotos(sb, items as Array<{ soItemId?: unknown }>, (q) => scopeToCompany(q, c));
    const rows = items.map((it, lineNo) => buildItemRow(h.id, it, lineNo, commitments.get(String(lineNo)) ?? null, linePhotos));
    const { error: iErr } = await sb.from('delivery_order_items').insert(stampCompany(rows, c));
    if (iErr) {
      await sb.from('delivery_orders').delete().eq('id', h.id);
      // HC-0004: the DB cap (mig 20261014T1300) refused a line past its SO line's qty.
      if (isSoLineOverDelivered(iErr)) return c.json({ error: 'race_conflict', message: 'Another operator just delivered overlapping qty from this Sales Order. Refresh and try again.', reason: iErr.message }, 409);
      return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500);
    }
    await recomputeTotals(sb, h.id);
  }

  if (body.asDraft !== true && items.length > 0) {
    const linkedSoItemIds = items
      .map((it) => it.soItemId as string | undefined)
      .filter((x): x is string => !!x);
    if (linkedSoItemIds.length > 0) {
      const recheck = await soRemainingByItemId(sb, linkedSoItemIds);
      const overcommitted = [...new Set(linkedSoItemIds)].filter((sid) => (recheck.get(sid) ?? 0) < 0);
      if (overcommitted.length > 0) {
        await sb.from('delivery_order_items').delete().eq('delivery_order_id', h.id);
        await sb.from('delivery_orders').delete().eq('id', h.id);
        return c.json({
          error: 'race_conflict',
          message: 'Another operator just delivered overlapping qty from this Sales Order. Refresh and try again.',
          conflicts: overcommitted,
        }, 409);
      }
    }
  }

  await recordDoCreate(sb, c.get('houzsUser'), activeCompanyId(c), h.id, items.length);
  lap('do-write');

  let ac: AcEnqueueOutcome | null = null;   // #2499's shape, the OTHER verdict
  if ((body.soDocNo as string | undefined) ?? null) {
    ac = (await enqueueConvert(sb, {
      companyId: activeCompanyId(c),
      op: 'so_to_do',
      from: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: String(body.soDocNo) },
      to: { table: 'delivery_orders', keyCol: 'id', key: h.id },
      docType: 'DO',
      docNo: h.do_number,
      docId: h.id,
      createdBy: c.get('houzsUser')?.id ?? null,
    }));
  } else {
    await recordParentlessCreate(sb, {
      companyId: activeCompanyId(c),
      docType: 'DO',
      docNo: h.do_number,
      docId: h.id,
      missing: 'no source Sales Order',
      createdBy: c.get('houzsUser')?.id ?? null,
    });
  }

  lap('do-ac-queue');
  let movementErrors: string[] = [];
  let emailNotice: string | null = null;
  if (body.asDraft !== true) {
    const shipTx = stockTxFor(c.env, 'DO_SHIP_MODE');
    const refused = shipTx ? await shipCreatedDoAtomically(shipTx, sb, h.id, h.do_number, activeCompanyId(c) ?? 0, user.id) : null;
    if (refused) return c.json(refused, 503);
    if (!shipTx) movementErrors = await deductInventoryForDo(sb, h.id, user.id);
    if (hasUnreadableLines(movementErrors)) return c.json({ id: h.id, doNumber: h.do_number, ...(await revertShipOnUnreadLines(sb, h.id, activeCompanyId(c) ?? 0, 'LOADED', 'DRAFT', {}, null, movementErrors, h.do_number)) }, 503);
    lap('do-ship');

    await syncSoDeliveredFromDo(sb, [(body.soDocNo as string) ?? null], user.id);
    lap('do-so-sync');

    /* Customer DO email (owner trigger "A", 2026-07-17). A non-draft create IS
       the confirm — the DO is born DISPATCHED — so this is the same event the
       deduction above fires on. Gated OFF and fail-closed inside; best-effort,
       never blocks the DO. */
    emailNotice = await maybeSendDeliveryOrderEmail(sb, c.env, h.id);
    lap('do-email');
  }

  const createSoDocNo = (body.soDocNo as string | null | undefined) ?? null;
  let soAmendMirrored: boolean | undefined;
  let soAmendMirrorError: string | undefined;
  if (createSoDocNo) {
    const createSoMirror: Record<string, unknown> = {};
    if (body.amendDateFromCustomer !== undefined) {
      createSoMirror.amend_date_from_customer = (body.amendDateFromCustomer === '' ? null : body.amendDateFromCustomer);
    }
    if (body.amendedDeliveryDate !== undefined) {
      createSoMirror.amended_delivery_date = (body.amendedDeliveryDate === '' ? null : body.amendedDeliveryDate);
    }
    if (body.amendReason !== undefined) {
      createSoMirror.amend_reason = (body.amendReason === '' ? null : body.amendReason);
    }
    if (Object.keys(createSoMirror).length > 0) {
      const emitMirrorAudit = await prepareSoAmendMirrorAudit(
        sb, createSoDocNo, createSoMirror,
        { id: user.id, name: (user.user_metadata as { name?: string } | undefined)?.name ?? null },
        `Delivery Order ${h.do_number ?? h.id}`,
      );
      const generation = await advanceSoGeneration(sb, createSoDocNo, createSoMirror);
      if (!generation.applied) {
        /* eslint-disable-next-line no-console */
        console.error('[so_amend_mirror] create-path conflict', { doId: h.id, soDocNo: createSoDocNo, reason: generation.reason });
        soAmendMirrorError = `so_${generation.reason}`;
      } else {
        soAmendMirrored = true;
        await emitMirrorAudit();
      }
    }
  }

  lap('do-amend-mirror');
  return c.json({
    id: h.id,
    doNumber: h.do_number,
    movementErrors: movementErrors.length ? movementErrors : undefined,
    emailNotice: emailNotice ?? undefined,
    so_amend_mirrored: soAmendMirrored,
    so_mirror_error: soAmendMirrorError, ...(ac?.problems.length ? { acNotSent: ac.problems } : {}),
  }, 201);
};
deliveryOrdersMfg.post('/', createDeliveryOrderHandler);


export const createDoFromSoLinesHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  /* company-scope: the only by-id write here is the ROLLBACK of the header this
     handler just inserted; the insert stamps the SOURCE company, so the id is
     not caller-supplied. */
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { picks?: Array<{ soItemId?: string; qty?: number }>; confirmShortStock?: boolean; confirmNotReady?: boolean; warehouseId?: string; asDraft?: boolean; dropShip?: boolean };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const pickQtyById = new Map<string, number>();
  for (const p of (body.picks ?? [])) {
    if (!p || !p.soItemId) continue;
    const q = Number(p.qty ?? 0);
    if (!(q > 0)) continue;
    pickQtyById.set(p.soItemId, (pickQtyById.get(p.soItemId) ?? 0) + q);
  }
  if (pickQtyById.size === 0) return c.json({ error: 'picks_required' }, 400);

  const pickedIds = [...pickQtyById.keys()];
  const { data: pickedItemRows, error: pErr } = await scopeToAllowedCompanies(sb
    .from('mfg_sales_order_items')
    .select('id, doc_no, company_id')
    .in('id', pickedIds), c);
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  const idToDoc = new Map<string, string>();
  const pickedRows = (pickedItemRows ?? []) as Array<{ id: string; doc_no: string; company_id: number | null }>;
  for (const r of pickedRows) idToDoc.set(r.id, r.doc_no);
  const missing = pickedIds.filter((id) => !idToDoc.has(id));
  if (missing.length > 0) return c.json({ error: 'so_item_not_found', missing }, 404);

  const docNos = [...new Set([...idToDoc.values()])];

  const sourceCompanies = new Set<number>();
  let sourceCompanyMissing = false;
  for (const r of pickedRows) {
    const n = Number(r.company_id);
    if (r.company_id == null || !Number.isInteger(n) || n <= 0) sourceCompanyMissing = true;
    else sourceCompanies.add(n);
  }
  if (sourceCompanies.size > 1) {
    const codes = companyCodeMap(c);
    return c.json({
      error: 'mixed_source_companies',
      message: 'These Sales Order lines belong to different companies. One Delivery Order can only ship one company\'s orders.',
      companies: [...sourceCompanies].map((id) => codes.get(id) ?? String(id)),
    }, 400);
  }
  const sourceCompanyId: number | undefined =
    (!sourceCompanyMissing && sourceCompanies.size === 1) ? [...sourceCompanies][0] : undefined;
  const doCompanyId = sourceCompanyId ?? activeCompanyId(c);

  const remainingProm = eager(soDeliverableRemaining(sb, docNos));
  {
    const offender = await firstUndeliverableSo(sb, docNos);
    if (offender) return c.json(soNotDeliverableResponse(offender), 409);
  }

  const remainingMap = (await remainingProm)();

  const custKey = (l: DeliverableLine): string =>
    (l.debtorCode && l.debtorCode.trim())
      ? `code:${l.debtorCode.trim().toUpperCase()}`
      : `name:${(l.debtorName ?? '').trim().toUpperCase()}`;
  const customers = new Set<string>();
  const customerNames = new Set<string>();
  for (const id of pickedIds) {
    const line = remainingMap.get(id);
    if (!line) return c.json({ error: 'so_item_not_found', missing: [id] }, 404);
    customers.add(custKey(line));
    customerNames.add(line.debtorName ?? line.debtorCode ?? '(none)');
  }
  if (customers.size > 1) {
    return c.json({
      error: 'mixed_customers',
      message: 'All picked Sales Order lines must belong to the same customer to combine into one Delivery Order.',
      customers: [...customerNames],
    }, 400);
  }

  for (const id of pickedIds) {
    const line = remainingMap.get(id)!;
    const qty = pickQtyById.get(id)!;
    if (qty < 1 || qty > line.remaining) {
      return c.json({
        error: 'over_remaining',
        message: `${line.itemCode} on ${line.docNo}: pick qty ${qty} exceeds remaining ${line.remaining}.`,
        soItemId: id,
        docNo: line.docNo,
        itemCode: line.itemCode,
        remaining: line.remaining,
        requested: qty,
      }, 409);
    }
  }

  const sortedPicks = pickedIds
    .map((id) => remainingMap.get(id)!)
    .sort((a, b) => a.docNo.localeCompare(b.docNo) || (a.lineSeq - b.lineSeq) || a.soItemId.localeCompare(b.soItemId));
  const firstSoDocNo = sortedPicks[0]!.docNo;

  const headerWarehouseId = (body.warehouseId as string | undefined) ?? null;
  const stockLines = sortedPicks.map((line) => ({
    lineRef: line.soItemId,
    soItemId: line.soItemId,
    itemCode: line.itemCode,
    itemGroup: line.itemGroup ?? null,
    productName: line.description,
    variantKey: computeVariantKey(line.itemGroup ?? null, (line.variants as VariantAttrs | null) ?? null),
    qty: pickQtyById.get(line.soItemId) ?? 0,
  }));
  const sofaProm = eager(findSofaLinesWithoutCompleteBatch(sb, sortedPicks.map((line) => ({
    itemCode: line.itemCode,
    itemGroup: line.itemGroup ?? null,
    soItemId: line.soItemId,
    fromStock: null,
  })), doCompanyId));
  const partialProm = eager(findIncompleteSofaSets(sb, sortedPicks.map((line) => line.soItemId), doCompanyId));
  const notReadyProm = (body.confirmNotReady || body.asDraft === true) ? null : eager(findNotReadySoLines(sb, sortedPicks.map((line) => line.soItemId), doCompanyId ?? null));
  const lineWarehousesProm = eager(resolveDoLineWarehouses(sb, stockLines.map((l) => ({ id: l.lineRef, so_item_id: l.soItemId })), headerWarehouseId, doCompanyId));
  const shortagesProm = eager(checkDoStockAvailability(sb, stockLines, headerWarehouseId, doCompanyId));
  const loadedProm = eager(loadSoHeaderForConversion(sb, firstSoDocNo, sourceCompanyId));

  let dropShipped = false;
  {
    const sofaOffenders = (await sofaProm)();
    if (sofaOffenders.length > 0) {
      const dropship = await buildDropshipOffenders(sb, sofaOffenders);
      const allHavePo = dropship.length > 0 && dropship.every((o) => !!o.poNumber);
      if (body.dropShip !== true || !allHavePo) {
        markIdempotencyNoWrite(c);
        return c.json(sofaNoCompleteBatchResponse(sofaOffenders, dropship), 409);
      }
      dropShipped = true;
    }
    const partial = (await partialProm)();
    if (partial.length > 0) {
      markIdempotencyNoWrite(c);
      return c.json(sofaIncompleteSetResponse(partial), 409);
    }
  }

  if (notReadyProm) {
    const notReady = (await notReadyProm)();
    if (notReady.length > 0) { markIdempotencyNoWrite(c); return c.json(itemsNotReadyResponse(notReady), 409); }
  }

  const lineWarehouses = (await lineWarehousesProm)();
  const shipWarehouseId = headerWarehouseId
    ?? primaryWarehouseOf([...lineWarehouses.values()])
    ?? (await defaultWarehouseId(sb, doCompanyId));
  const shortages: StockShortage[] = (await shortagesProm)();

  const commitmentPlan = await resolveShipCommitments(
    sb,
    sortedPicks.map((line) => ({
      lineRef: line.soItemId,
      soItemId: line.soItemId,
      itemCode: line.itemCode,
      itemGroup: line.itemGroup ?? null,
      variantKey: computeVariantKey(line.itemGroup ?? null, (line.variants as VariantAttrs | null) ?? null),
      qty: pickQtyById.get(line.soItemId) ?? 0,
    })),
    shipWarehouseId ?? null,
    shortages,
    doCompanyId ?? null,
  );
  if (commitmentPlan.setConflicts.length > 0) {
    markIdempotencyNoWrite(c);
    return c.json(sofaSetPoSplitResponse(commitmentPlan.setConflicts), 409);
  }
  const commitments = commitmentPlan.bindings;
  if (shortages.length > 0 && !body.confirmShortStock && body.asDraft !== true) {
    markIdempotencyNoWrite(c);
    return c.json(shortStockResponse(shortages, bindingList(commitments)), 409);
  }

  const loaded = (await loadedProm)();
  if (loaded.error) return c.json({ error: 'load_failed', reason: loaded.error }, 500);
  if (!loaded.head) return c.json({ error: 'not_found' }, 404);
  const head = loaded.head;

  const doAddress2 = (head.address2 as string | null)
    ?? ([head.address3, head.address4].filter(Boolean).join(', ') || null);
  const phoneRaw = head.phone as string | null;
  const emPhoneRaw = head.emergency_contact_phone as string | null;
  const today = todayMyt();

  const srcCode = doCompanyId != null ? companyCodeMap(c).get(Number(doCompanyId)) : undefined;
  const srcPrefix = srcCode != null ? docPrefixForCode(srcCode) : undefined;

  const { data: doHeader, error: hErr } = await insertWithDocNoRetry<{ id: string; do_number: string }>(
    () => nextNum(sb, c, srcPrefix),
    (doNumber) => sb.from('delivery_orders').insert({
    company_id: doCompanyId,
    do_number: doNumber,
    warehouse_id: doShipFromWarehouseId(headerWarehouseId, lineWarehouses),
    so_doc_no: firstSoDocNo,
    debtor_code: (head.debtor_code as string | null) ?? null,
    debtor_name: (head.debtor_name as string | null) ?? null,
    // Owner 2026-09-11 (0807 supersedes 0804): DO dates default to SO's.
    do_date: (head.customer_delivery_date as string | null) ?? today,
    expected_delivery_at: (head.customer_delivery_date as string | null) ?? today,
    customer_delivery_date: (head.customer_delivery_date as string | null) ?? today,
    address1: (head.address1 as string | null) ?? null,
    address2: doAddress2,
    city: (head.city as string | null) ?? null,
    state: (head.customer_state as string | null) ?? null,
    customer_state: (head.customer_state as string | null) ?? null,
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
    ref: docNos.length > 1
      ? `Merged from ${[...docNos].sort().join(', ')}`
      : ((head.ref as string | null) ?? null),
    sales_location: (head.sales_location as string | null) ?? null,
    emergency_contact_name: (head.emergency_contact_name as string | null) ?? null,
    emergency_contact_phone: emPhoneRaw ? (normalizePhone(emPhoneRaw) ?? emPhoneRaw) : null,
    emergency_contact_relationship: (head.emergency_contact_relationship as string | null) ?? null,
    currency: (head.currency as string | null) ?? 'MYR',
    status: (body.asDraft === true) ? 'DRAFT' : 'LOADED',
    is_dropship: dropShipped,
    created_by: user.id,
    }).select('id, do_number').single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const dh = doHeader as unknown as { id: string; do_number: string };

  const linePhotos = await loadCarriedSoLinePhotos(sb, sortedPicks, (q) => scopeToAllowedCompanies(q, c));
  const doRows = sortedPicks.map((line, lineNo) => {
    const qty = pickQtyById.get(line.soItemId)!;
    const unit = line.unitPriceSen;
    const discount = lineDiscountShare(line.discountSen, line.qty, line.qty - line.remaining, qty);
    const unitCost = line.unitCostSen;
    const lineTotal = Math.max(0, (qty * unit) - discount);
    const lineCost = qty * unitCost;
    const itemGroup = line.itemGroup;
    const variants = line.variants ?? null;
    return {
      delivery_order_id: dh.id,
      line_no: lineNo,
      so_item_id: line.soItemId,
      photo_urls: carriedPhotoUrls(linePhotos, line.soItemId),
      item_code: line.itemCode,
      item_group: itemGroup,
      description: line.description ?? null,
      description2: buildVariantSummary(String(itemGroup ?? ''), (variants as Record<string, unknown> | null) ?? null) || line.description2 || null,
      uom: line.uom ?? 'UNIT',
      qty,
      m3_milli: 0,
      unit_price_sen: unit,
      discount_sen: discount,
      line_total_sen: lineTotal,
      unit_cost_sen: unitCost,
      line_cost_sen: lineCost,
      line_margin_sen: lineTotal - lineCost,
      variants,
      line_delivery_date: (head.customer_delivery_date as string | null) ?? null,
      gap_inches: line.gapInches ?? null,
      divan_height_inches: line.divanHeightInches ?? null,
      divan_price_sen: line.divanPriceSen ?? 0,
      leg_height_inches: line.legHeightInches ?? null,
      leg_price_sen: line.legPriceSen ?? 0,
      custom_specials: line.customSpecials ?? null,
      line_suffix: line.lineSuffix ?? null,
      special_order_price_sen: line.specialOrderPriceSen ?? 0,
      committed_po_batch_no: commitments.get(line.soItemId)?.poNumber ?? null,
      committed_variant_key: commitments.has(line.soItemId)
        ? (commitments.get(line.soItemId)?.variantKey ?? '') : null,
      committed_batch_strict: commitments.get(line.soItemId)?.strictBatch === true,
      ...(doCompanyId != null ? { company_id: doCompanyId } : {}),
    };
  });
  const { error: iErr } = await sb.from('delivery_order_items').insert(doRows);
  if (iErr) {
    await sb.from('delivery_orders').delete().eq('id', dh.id);
    if (isSoLineOverDelivered(iErr)) return c.json({ error: 'race_conflict', message: 'Another operator just converted overlapping qty from this Sales Order. Refresh the picker and try again.', reason: iErr.message }, 409);
    return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500);
  }

  {
    const recheck = await soDeliverableRemaining(sb, docNos);
    const overcommitted = pickedIds
      .map((sid) => recheck.get(sid))
      .filter((l): l is DeliverableLine => l !== undefined && l.remaining < 0);
    if (overcommitted.length > 0) {
      await sb.from('delivery_order_items').delete().eq('delivery_order_id', dh.id);
      await sb.from('delivery_orders').delete().eq('id', dh.id);
      return c.json({
        error: 'race_conflict',
        message: 'Another operator just converted overlapping qty from this Sales Order. Refresh the picker and try again.',
        conflicts: overcommitted.map((l) => ({ docNo: l.docNo, itemCode: l.itemCode, remaining: l.remaining })),
      }, 409);
    }
  }

  await recomputeTotals(sb, dh.id);

  await recordDoCreate(
    sb, c.get('houzsUser'), doCompanyId, dh.id, doRows.length,
    `Converted from Sales Order${docNos.length === 1 ? '' : 's'} ${docNos.join(', ')}`,
  );

  const mergeAc = docNos.length ? await enqueueConvert(sb, {
      companyId: doCompanyId,
      op: 'so_to_do',
      from: docNos.map((n) => ({ table: 'mfg_sales_orders' as const, keyCol: 'doc_no', key: n })),
      to: { table: 'delivery_orders', keyCol: 'id', key: dh.id },
      docType: 'DO',
      docNo: dh.do_number,
      docId: dh.id,
      createdBy: c.get('houzsUser')?.id ?? null,
  }) : null;

  let movementErrors: string[] = [];
  let emailNotice: string | null = null;
  if (body.asDraft !== true) {
    const shipTx = stockTxFor(c.env, 'DO_SHIP_MODE');
    const refused = shipTx ? await shipCreatedDoAtomically(shipTx, sb, dh.id, dh.do_number, doCompanyId ?? 0, user.id) : null;
    if (refused) return c.json(refused, 503);
    if (!shipTx) movementErrors = await deductInventoryForDo(sb, dh.id, user.id);
    if (hasUnreadableLines(movementErrors)) return c.json({ id: dh.id, doNumber: dh.do_number, ...(await revertShipOnUnreadLines(sb, dh.id, doCompanyId ?? 0, 'LOADED', 'DRAFT', {}, null, movementErrors, dh.do_number)) }, 503);

    await syncSoDeliveredFromDo(sb, [...docNos], user.id);

    /* Customer DO email (owner trigger "A", 2026-07-17). ONE email per DO, not
       per source SO: this is the merge path, so the DO carries a single
       recipient snapshot and the customer gets one notice for the one delivery.
       Gated OFF and fail-closed inside; best-effort, never blocks the DO. */
    emailNotice = await maybeSendDeliveryOrderEmail(sb, c.env, dh.id);
  }

  return c.json({
    id: dh.id,
    doNumber: dh.do_number,
    movementErrors: movementErrors.length ? movementErrors : undefined,
    emailNotice: emailNotice ?? undefined,
    ...(mergeAc?.problems.length ? { acNotSent: mergeAc.problems } : {}),
  }, 201);
};
deliveryOrdersMfg.post('/from-sos', createDoFromSoLinesHandler);

deliveryOrdersMfg.put('/:id/crew', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: doRow, error: doErr } = await scopeToGrantedCompanies(sb.from('delivery_orders')
    .select('id, company_id, do_number, status').eq('id', id), c, co.companyId).maybeSingle();
  if (doErr) return c.json({ error: 'load_failed', reason: doErr.message }, 500);
  if (!doRow) return c.json(NOT_THIS_COMPANY, 404);
  const { data: crewBeforeRow } = await sb.from('delivery_order_crew')
    .select('driver_1_id, driver_2_id, helper_1_id, helper_2_id, lorry_id, driver_1_name, driver_2_name, helper_1_name, helper_2_name, lorry_plate')
    .eq('do_id', id).maybeSingle();
  const crewBefore = (crewBeforeRow ?? {}) as Record<string, unknown>;

  /* Partial re-assign (owner 2026-09-26): a seat named in the body is set (an
     explicit null / '' clears it); a seat the body omits keeps who was on it, so a
     single-seat board edit never wipes the rest, while FleetDay — which sends all
     five — re-assigns fully. Pure + tested in crew-seats.test.ts. */
  const { driver1Id, driver2Id, helper1Id, helper2Id, lorryId } = resolveCrewSeats(body, crewBefore);

  const driverIds = [...new Set([driver1Id, driver2Id].filter((x): x is string => !!x))];
  const helperIds = [...new Set([helper1Id, helper2Id].filter((x): x is string => !!x))];

  type DriverRow = { id: string; name?: string | null; ic_number?: string | null; phone?: string | null; vehicle?: string | null };
  type HelperRow = { id: string; name?: string | null; contact?: string | null; ic_number?: string | null };
  type LorryRow  = { id: string; plate?: string | null };

  const driverById = new Map<string, DriverRow>();
  const helperById = new Map<string, HelperRow>();

  const [driverRes, helperRes, lorryRes] = await Promise.all([ // company-scope: ONE shared fleet master (delivery-tms.md), so a 2990 order reads a Houzs-made driver's IC
    driverIds.length > 0
      ? sb.from('drivers').select('id, name, ic_number, phone, vehicle').in('id', driverIds)
      : Promise.resolve({ data: [] as DriverRow[] }),
    helperIds.length > 0
      ? sb.from('helpers').select('id, name, contact, ic_number').in('id', helperIds)
      : Promise.resolve({ data: [] as HelperRow[] }),
    lorryId
      ? sb.from('lorries').select('id, plate').eq('id', lorryId).maybeSingle()
      : Promise.resolve({ data: null as LorryRow | null }),
  ]);
  for (const d of (driverRes.data ?? []) as DriverRow[]) driverById.set(d.id, d);
  for (const h of (helperRes.data ?? []) as HelperRow[]) helperById.set(h.id, h);
  const lorry = (lorryRes.data ?? null) as LorryRow | null;

  const d1 = driver1Id ? driverById.get(driver1Id) ?? null : null;
  const d2 = driver2Id ? driverById.get(driver2Id) ?? null : null;
  const h1 = helper1Id ? helperById.get(helper1Id) ?? null : null;
  const h2 = helper2Id ? helperById.get(helper2Id) ?? null : null;

  const now = new Date().toISOString();
  const doCompanyId = Number((doRow as { company_id?: number | null }).company_id) || co.companyId;
  const crewRow = {
    ...(doCompanyId != null ? { company_id: doCompanyId } : {}),
    do_id: id,
    driver_1_id: driver1Id, driver_2_id: driver2Id,
    helper_1_id: helper1Id, helper_2_id: helper2Id,
    lorry_id: lorryId,
    driver_1_name: d1?.name ?? null, driver_1_ic: d1?.ic_number ?? null, driver_1_contact: d1?.phone ? (normalizePhone(d1.phone) ?? d1.phone) : null,
    driver_2_name: d2?.name ?? null, driver_2_ic: d2?.ic_number ?? null, driver_2_contact: d2?.phone ? (normalizePhone(d2.phone) ?? d2.phone) : null,
    helper_1_name: h1?.name ?? null, helper_1_contact: h1?.contact ? (normalizePhone(h1.contact) ?? h1.contact) : null,
    helper_2_name: h2?.name ?? null, helper_2_contact: h2?.contact ? (normalizePhone(h2.contact) ?? h2.contact) : null,
    lorry_plate: lorry?.plate ?? null,
    assigned_by: user.id,
    updated_at: now,
  };

  const { data: crew, error: crewErr } = await sb.from('delivery_order_crew')
    .upsert(crewRow, { onConflict: 'do_id' })
    .select(crewSnapshotCols).maybeSingle();
  if (crewErr) {
    if (crewErr.code === '42501') return c.json({ error: 'forbidden', reason: crewErr.message }, 403);
    return c.json({ error: 'crew_save_failed', reason: crewErr.message }, 500);
  }

  await scopeToCompanyId(sb.from('delivery_orders').update({
    driver_id: driver1Id,
    driver_name: d1?.name ?? null,
    vehicle: d1?.vehicle ?? lorry?.plate ?? null,
    updated_at: now,
  }).eq('id', id), doCompanyId);

  {
    const crewChanges = compactChanges([
      fieldChange('driver1', crewBefore.driver_1_name ?? crewBefore.driver_1_id ?? null, d1?.name ?? driver1Id),
      fieldChange('driver2', crewBefore.driver_2_name ?? crewBefore.driver_2_id ?? null, d2?.name ?? driver2Id),
      fieldChange('helper1', crewBefore.helper_1_name ?? crewBefore.helper_1_id ?? null, h1?.name ?? helper1Id),
      fieldChange('helper2', crewBefore.helper_2_name ?? crewBefore.helper_2_id ?? null, h2?.name ?? helper2Id),
      fieldChange('lorry', crewBefore.lorry_plate ?? crewBefore.lorry_id ?? null, lorry?.plate ?? lorryId),
    ]);
    if (crewChanges.length > 0) {
      const head = doRow as { do_number?: string | null; status?: string | null };
      await recordEntityAudit(sb, {
        entityType: 'DELIVERY_ORDER',
        entityId: id,
        entityDocNo: head.do_number ?? null,
        action: 'UPDATE',
        actor: c.get('houzsUser'),
        companyId: doCompanyId,
        statusSnapshot: head.status ?? null,
        note: 'Delivery crew assigned',
        fieldChanges: crewChanges,
      });
    }
  }

  const tripSync = await propagateDoCrewToTrip(sb, id, { driver1Id, driver2Id, helper1Id, helper2Id, lorryId }, user.id)
    .then(() => null, (e: Error) => String(e.message).slice(0, 160));
  return c.json({ crew, ...(tripSync ? { tripSyncError: tripSync } : {}) });
});

deliveryOrdersMfg.patch('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const map: Array<[string, string]> = [
    ['debtorCode', 'debtor_code'], ['debtorName', 'debtor_name'], ['agent', 'agent'],
    ['salesLocation', 'sales_location'], ['ref', 'ref'], ['poDocNo', 'po_doc_no'],
    ['venue', 'venue'], ['venueId', 'venue_id'], ['branding', 'branding'],
    ['address1', 'address1'], ['address2', 'address2'],
    ['city', 'city'], ['state', 'state'], ['postcode', 'postcode'], ['phone', 'phone'],
    ['note', 'note'], ['notes', 'notes'],
    ['soDate', 'do_date'], ['doDate', 'do_date'], ['currency', 'currency'],
    ['customerState', 'customer_state'], ['customerCountry', 'customer_country'],
    ['customerSoNo', 'customer_so_no'],
    ['customerDeliveryDate', 'customer_delivery_date'],
    ['expectedDeliveryAt', 'expected_delivery_at'],
    ['timeRange', 'time_range'],
    ['timeConfirmed', 'time_confirmed'],
    ['arrivalAt', 'arrival_at'],
    ['departureAt', 'departure_at'],
    ['shipoutDate', 'shipout_date'],
    ['customerDeliveredDate', 'customer_delivered_date'],
    ['etaArrivingPort', 'eta_arriving_port'],
    ['deliverySubstatus', 'delivery_substatus'],
    ['arrivesEmWarehouseDate', 'arrives_em_warehouse_date'],
    ['email', 'email'], ['customerType', 'customer_type'],
    ['salespersonId', 'salesperson_id'], ['buildingType', 'building_type'],
    ['driverId', 'driver_id'], ['driverName', 'driver_name'], ['vehicle', 'vehicle'],
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

  if (updates.delivery_substatus != null && updates.delivery_substatus !== '' &&
      !(HC_SUBSTATUS_VALUES as readonly string[]).includes(String(updates.delivery_substatus))) {
    return c.json({ error: 'invalid_substatus', reason: `delivery_substatus must be one of: ${HC_SUBSTATUS_VALUES.join(', ')} (or blank).` }, 400);
  }
  if (updates.delivery_substatus === '') updates.delivery_substatus = null;

  const soAmendMirror: Record<string, unknown> = {};
  if (body.amendDateFromCustomer !== undefined) {
    soAmendMirror.amend_date_from_customer = (body.amendDateFromCustomer === '' ? null : body.amendDateFromCustomer);
  }
  if (body.amendedDeliveryDate !== undefined) {
    soAmendMirror.amended_delivery_date = (body.amendedDeliveryDate === '' ? null : body.amendedDeliveryDate);
  }
  if (body.amendReason !== undefined) {
    soAmendMirror.amend_reason = (body.amendReason === '' ? null : body.amendReason);
  }

  if (Object.keys(updates).length === 1 && Object.keys(soAmendMirror).length === 0) {
    return c.json({ ok: true, changed: 0 });
  }

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: beforeRow } = await scopeToCompanyId(sb.from('delivery_orders')
    .select(DO_AUDIT_SELECT).eq('id', id), co.companyId).maybeSingle();
  if (!beforeRow) return c.json(NOT_THIS_COMPANY, 404);
  const before = (beforeRow ?? {}) as unknown as Record<string, unknown>;

  /* Header lock (owner ruling 2026-09-14, supersedes 2026-08-20): once a live SI/DR
     exists the customer / address / contact / commercial block freezes; only the
     dispatch-execution fields stay open. ONE rule, shared/do-header-lock.ts, which
     both screens read too. Downstream read paid only when a locked column changed. */
  const doLocked = doLockedHeaderChanges(updates, before);
  if (doLocked.length > 0 && (await doHasDownstream(sb, id))) {
    return c.json(identityLockedRefusal({
      error: 'do_identity_locked', fields: doLocked, labels: DO_IDENTITY_LABELS,
      what: 'Delivery Order', child: 'Sales Invoice or Delivery Return', ownFields: DO_HEADER_OPEN_DESCRIPTION,
    }), 409);
  }

  let writtenSo = false;
  let soMirrorError: string | null = null;
  let mirrorSoDocNo: string | null = null;

  if (Object.keys(updates).length > 1) {
    const { data, error } = await scopeToCompanyId(sb.from('delivery_orders').update(updates).eq('id', id), co.companyId).select('id, so_doc_no').maybeSingle();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    if (!data) return c.json(NOT_THIS_COMPANY, 404);
    mirrorSoDocNo = (data as { soDocNo?: string | null; so_doc_no?: string | null }).soDocNo
      ?? (data as { so_doc_no?: string | null }).so_doc_no ?? null;

    const auditPatch: Record<string, unknown> = {};
    for (const [camel, snake] of DO_AUDIT_FIELDS) {
      if (updates[snake] !== undefined) auditPatch[camel] = updates[snake];
    }
    await recordEntityAudit(sb, {
      entityType: 'DELIVERY_ORDER',
      entityId: id,
      entityDocNo: (before.do_number as string | null) ?? null,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: (before.company_id as number | null) ?? activeCompanyId(c),
      statusSnapshot: (before.status as string | null) ?? null,
      fieldChanges: diffFields(before, auditPatch, DO_AUDIT_FIELDS),
    });
  } else {
    const { data: doRow, error: doErr } = await sb.from('delivery_orders').select('id, so_doc_no').eq('id', id).maybeSingle();
    if (doErr) return c.json({ error: 'load_failed', reason: doErr.message }, 500);
    if (!doRow) return c.json({ error: 'not_found' }, 404);
    mirrorSoDocNo = (doRow as { soDocNo?: string | null; so_doc_no?: string | null }).soDocNo
      ?? (doRow as { so_doc_no?: string | null }).so_doc_no ?? null;
  }

  if (Object.keys(soAmendMirror).length > 0) {
    if (mirrorSoDocNo) {
      const patchUser = c.get('user');
      const emitMirrorAudit = await prepareSoAmendMirrorAudit(
        sb, mirrorSoDocNo, soAmendMirror,
        { id: patchUser.id, name: (patchUser.user_metadata as { name?: string } | undefined)?.name ?? null },
        `Delivery Order ${id}`,
      );
      const generation = await advanceSoGeneration(sb, mirrorSoDocNo, soAmendMirror);
      if (!generation.applied) {
        /* eslint-disable-next-line no-console */
        console.error('[so_amend_mirror] conflict', { doId: id, soDocNo: mirrorSoDocNo, reason: generation.reason });
        soMirrorError = `so_${generation.reason}`;
      } else {
        writtenSo = true;
        await emitMirrorAudit();
      }
    } else {
      soMirrorError = 'do_has_no_parent_so';
    }
  }

  await queueAcDoEdit(c, id);
  return c.json({
    ok: true,
    id,
    so_amend_mirrored: writtenSo || undefined,
    so_doc_no: mirrorSoDocNo || undefined,
    so_mirror_error: soMirrorError || undefined,
  });
});

const addOneDeliveryOrderItem = async (c: Context<{ Bindings: Env; Variables: Variables }, '/:id/items'>, it0: Record<string, unknown>, batchSoItemIds: string[]): Promise<Response> => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  let it = it0;
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);

  {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  const childLock = await doHasDownstream(sb, id);
  if (childLock) return c.json(childLock, 409);

  /* company-scope: prove the PARENT DO, the gate the line PATCH and DELETE
     already carry. Without it company A holding B's DO uuid pushes a line onto
     B's delivery stamped with A's company, and on a shipped DO the resync moves
     B's stock out. The selected company_id feeds the audit row, not a predicate. */
  const { data: header, error: headerErr } = await scopeToCompany(
    sb.from('delivery_orders')
      .select('id, status, warehouse_id, do_number, company_id, so_doc_no, debtor_code, debtor_name').eq('id', id), c,
  ).maybeSingle();
  if (headerErr) return c.json({ error: 'lookup_failed', reason: headerErr.message }, 500);
  if (!header) return c.json({ error: 'not_found' }, 404);

  const h = header as { id: string; status: string | null; warehouse_id: string | null; so_doc_no: string | null };
  {
    const claimed = await claimedSoItemIdsOnDo(sb, id);
    if (!claimed.ok) return c.json({ error: claimed.error, message: claimed.message }, 500);
    const linked = await fillMissingSoItemIds(sb, h.so_doc_no, [it], claimed.ids);
    if (!linked.ok) return c.json({ error: linked.error, message: linked.message }, 400);
    /* SKU wins, decided once — docs/bugs/0524. Same reasoning as the create
       path: the stock check below, the commitment planner and buildItemRow all
       read this one object. */
    it = (await resolveItemGroups(sb, [linked.items[0] as typeof it], activeCompanyId(c) ?? null))[0]!;
    if (variantTrackedCompany(activeCompanyId(c) ?? null)) {
      try { it = (await adoptSoLineSpecs(sb, [it], activeCompanyId(c) ?? null))[0]!; } catch (e) {
        return c.json({ error: 'lookup_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
      }
    }
  }

  if (it.soItemId) {
    const { data: soLine, error: soLineErr } = await sb.from('mfg_sales_order_items').select('doc_no').eq('id', it.soItemId as string).maybeSingle();
    if (soLineErr) return c.json({ error: 'lookup_failed', reason: soLineErr.message }, 500);
    const { data: soHead, error: soHeadErr } = soLine
      ? await scopeToCompany(sb.from('mfg_sales_orders').select('debtor_code, debtor_name').eq('doc_no', (soLine as { doc_no: string }).doc_no), c).maybeSingle()
      : { data: null, error: null };
    if (soHeadErr) return c.json({ error: 'lookup_failed', reason: soHeadErr.message }, 500);
    const so = soHead as { debtor_code: string | null; debtor_name: string | null } | null;
    const doH = header as { debtor_code: string | null; debtor_name: string | null };
    const norm = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
    const [cs, cd, ns, nd] = so ? [norm(so.debtor_code), norm(doH.debtor_code), norm(so.debtor_name), norm(doH.debtor_name)] : ['', '', '', ''];
    const same = !so ? false : cs && cd ? cs === cd : (cs || cd || !ns || !nd) ? true : ns === nd;
    if (!same) {
      return c.json({
        error: 'mixed_customers',
        message: 'This Sales Order line belongs to a different customer than the Delivery Order.',
        customers: [doH.debtor_name ?? doH.debtor_code ?? '(none)', so?.debtor_name ?? so?.debtor_code ?? '(unknown)'],
      }, 400);
    }
  }
  const addShipsNow = SHIPPED_STATES.includes((h.status ?? '').toUpperCase());
  const addWarehouseId = (await resolveDoLineWarehouses(
    sb,
    [{ id: 'add', so_item_id: (it.soItemId as string | null) ?? null }],
    h.warehouse_id ?? null,
    activeCompanyId(c),
  )).get('add') ?? null;
  let addShortages: StockShortage[] = [];
  const addIsService = isServiceLine({
    itemGroup: (it.itemGroup as string | null) ?? null,
    itemCode: (it.itemCode as string | null) ?? null,
  });
  if (addWarehouseId && !addIsService) {
    const stockLines = [{
      itemCode: String(it.itemCode ?? ''),
      productName: (it.description as string | null) ?? null,
      variantKey: computeVariantKey((it.itemGroup as string | null) ?? null, (it.variants as VariantAttrs | null) ?? null),
      qty: Number(it.qty ?? 0),
    }];
    addShortages = await checkStockAvailability(sb, addWarehouseId, stockLines, activeCompanyId(c));
  }

  const addPlan = await resolveShipCommitments(sb, [{
    lineRef: 'add',
    soItemId: (it.soItemId as string | null) ?? null,
    itemCode: String(it.itemCode ?? ''),
    itemGroup: (it.itemGroup as string | null) ?? null,
    variantKey: computeVariantKey((it.itemGroup as string | null) ?? null, (it.variants as VariantAttrs | null) ?? null),
    qty: Number(it.qty ?? 0),
  }], addWarehouseId ?? null, addShortages, activeCompanyId(c) ?? null,
  { doId: id, doNumber: (header as { do_number?: string | null }).do_number ?? null });
  if (addPlan.setConflicts.length > 0) {
    return c.json(sofaSetPoSplitResponse(addPlan.setConflicts), 409);
  }
  const addCommitments = addPlan.bindings;

  if (addShipsNow && addShortages.length > 0 && !(it as { confirmShortStock?: boolean }).confirmShortStock) {
    return c.json(shortStockResponse(addShortages, bindingList(addCommitments)), 409);
  }

  {
    const sid = it.soItemId as string | undefined;
    if (sid) {
      const remaining = await soRemainingByItemId(sb, [sid]);
      const rem = remaining.get(sid) ?? 0;
      const addQty = Number(it.qty ?? 0);
      if (addQty > rem) {
        return c.json({
          error: 'over_remaining',
          message: `Add qty ${addQty} exceeds remaining ${rem} on the linked Sales Order line.`,
          soItemId: sid, remaining: rem, requested: addQty,
        }, 409);
      }
    }
  }

  {
    const unlinked = await findUnlinkedSoLines(sb, h.so_doc_no, [{
      lineRef: 'add',
      itemCode: String(it.itemCode ?? ''),
      qty: Number(it.qty ?? 0),
      soItemId: (it.soItemId as string | null) ?? null,
    }]);
    const bad = unlinkedScanRefusal(unlinked, unlinkedSoLinesResponse);
    if (bad) return c.json(bad, 409);
  }

  let dropShipped = false;
  {
    const sofaOffenders = await findSofaLinesWithoutCompleteBatch(sb, [{
      itemCode: String(it.itemCode ?? ''),
      itemGroup: (it.itemGroup as string | null) ?? null,
      soItemId: (it.soItemId as string | null) ?? null,
      fromStock: null,
    }], activeCompanyId(c));
    if (sofaOffenders.length > 0) {
      const dropship = await buildDropshipOffenders(sb, sofaOffenders);
      const allHavePo = dropship.length > 0 && dropship.every((o) => !!o.poNumber);
      if ((it as { dropShip?: boolean }).dropShip !== true || !allHavePo) {
        return c.json(sofaNoCompleteBatchResponse(sofaOffenders, dropship), 409);
      }
      dropShipped = true;
    }
    const { data: existingDoLines } = await sb
      .from('delivery_order_items').select('so_item_id').eq('delivery_order_id', id);
    const soIds = [
      ...((existingDoLines ?? []) as Array<{ so_item_id: string | null }>).map((r) => r.so_item_id),
      (it.soItemId as string | null) ?? null,
      ...batchSoItemIds,
    ];
    const partial = await findIncompleteSofaSets(sb, soIds, activeCompanyId(c));
    if (partial.length > 0) return c.json(sofaIncompleteSetResponse(partial), 409);
  }

  const { data: maxNoRow } = await sb
    .from('delivery_order_items')
    .select('line_no')
    .eq('delivery_order_id', id)
    .order('line_no', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const nextLineNo = typeof (maxNoRow as { line_no?: number | null } | null)?.line_no === 'number'
    ? (maxNoRow as { line_no: number }).line_no + 1
    : null;
  /* IDENTITY — docs/bugs/0672 site 15, the add-line twin of the create guard. */
  const soIdc = await assertLinkedLineItemsMatch(sb, 'mfg_sales_order_items', [{ linkId: (it.soItemId as string | undefined) ?? null, itemCode: it.itemCode }], { source: 'Sales Order line' });
  if (!soIdc.ok) return c.json(soIdc.body, soIdc.status);
  const addPhotos = await loadCarriedSoLinePhotos(sb, [it as { soItemId?: unknown }], (q) => scopeToCompany(q, c));
  const row = buildItemRow(id, it, nextLineNo, addCommitments.get('add') ?? null, addPhotos);
  const { data, error } = await sb.from('delivery_order_items').insert({ ...row, company_id: activeCompanyId(c) }).select(ITEM).single();
  if (isSoLineOverDelivered(error)) return c.json({ error: 'over_remaining', message: 'Add qty exceeds remaining on the linked Sales Order line.', soItemId: it.soItemId ?? null, reason: error?.message }, 409);
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  if (dropShipped) {
    const { error: dsErr } = await sb.from('delivery_orders').update({ is_dropship: true }).eq('id', id);
    if (dsErr && !(dsErr.message ?? '').includes('is_dropship')) {
      /* eslint-disable-next-line no-console */ console.error('[dropship] flag DO failed:', dsErr.message);
    }
  }
  await recomputeTotals(sb, id);
  await resyncInventoryForDo(sb, id, user?.id);

  {
    const line = data as unknown as Record<string, unknown>;
    const head = header as { do_number?: string | null; status?: string | null; company_id?: number | null };
    await recordEntityAudit(sb, {
      entityType: 'DELIVERY_ORDER',
      entityId: id,
      entityDocNo: head.do_number ?? null,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: head.company_id ?? activeCompanyId(c),
      statusSnapshot: head.status ?? null,
      note: `Line added: ${String(line.item_code ?? it.itemCode ?? '')}`,
      fieldChanges: compactChanges([
        fieldChange('itemCode', null, line.item_code ?? null),
        fieldChange('description', null, line.description ?? null),
        fieldChange('qty', null, line.qty ?? null),
        fieldChange('unitPriceSen', null, line.unit_price_sen ?? null),
        fieldChange('discountSen', null, line.discount_sen ?? null),
        fieldChange('lineTotalSen', null, line.line_total_sen ?? null),
      ]),
    });
  }

  await queueAcDoEdit(c, id, [], ((data as { id?: unknown } | null)?.id ? [String((data as { id?: unknown }).id)] : []));
  return c.json({ item: data }, 201);
};

export const addDeliveryOrderItemHandler = async (c: Context<{ Bindings: Env; Variables: Variables }, '/:id/items'>) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!Array.isArray(body.items)) return addOneDeliveryOrderItem(c, body, []);
  const lines = body.items as Array<Record<string, unknown>>;
  const batchSoItemIds = lines.map((l) => l?.soItemId).filter((x): x is string => typeof x === 'string' && !!x);
  const items: unknown[] = [];
  for (const [i, l] of lines.entries()) {
    const res = await addOneDeliveryOrderItem(c, l ?? {}, batchSoItemIds);
    if (res.status >= 400) {
      return c.json({ ...((await res.json()) as object), failedIndex: i, failedItemCode: l?.itemCode ?? null, savedBefore: i }, res.status as 400);
    }
    items.push(((await res.json()) as { item: unknown }).item);
  }
  return c.json({ items }, 201);
};
deliveryOrdersMfg.post('/:id/items', addDeliveryOrderItemHandler);

deliveryOrdersMfg.patch('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId'); const user = c.get('user');
  /* company-scope: prove the PARENT DO first. The (itemId, delivery_order_id)
     pair every write below keys on is caller-supplied: it proves the two belong
     together, never whose they are. A line edit re-prices, re-binds its batch
     and re-syncs inventory. */
  const { data: own, error: ownErr } = await scopeToCompany(
    sb.from('delivery_orders').select('id, status').eq('id', id), c,
  ).maybeSingle();
  if (ownErr) return c.json({ error: 'lookup_failed', reason: ownErr.message }, 500);
  if (!own) return c.json({ error: 'not_found' }, 404);
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  if (it.itemCode !== undefined) {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const childLock = await doHasDownstream(sb, id);
  if (childLock) return c.json(childLock, 409);

  const { data: prev } = await scopeToCompanyId(sb.from('delivery_order_items')
    .select('qty, unit_price_sen, discount_sen, unit_cost_sen, item_code, item_group, description, uom, variants, notes, so_item_id, line_total_sen, rack_id, line_delivery_date, committed_po_batch_no, committed_variant_key, committed_batch_strict')
    .eq('id', itemId), co.companyId).maybeSingle();
  if (!prev) return c.json(NOT_THIS_COMPANY, 404);
  if (it.variants !== undefined && prev.so_item_id && variantTrackedCompany(co.companyId)
    && !doSpecLocked((own as { status: string | null }).status)) {
    try {
      const [adopted] = await adoptSoLineSpecs(sb, [{ soItemId: prev.so_item_id, itemCode: it.itemCode ?? prev.item_code, variants: it.variants }], co.companyId);
      it.variants = adopted?.variants ?? it.variants;
    } catch (e) {
      return c.json({ error: 'lookup_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
    }
  }
  // Owner 2026-11-10: a shipped line keeps its product and spec (shared/do-spec-lock.ts).
  const specLock = shippedDoSpecRefusal((own as { status: string | null }).status, prev, it);
  if (specLock) return c.json(specLock, 409);

  /* SKU wins on the EDIT half too — docs/bugs/0524. An edit that names a group,
     or re-points the code, decides the bucket resyncInventoryForDo will move
     this line's stock in and out of; the group stored is the SKU's. Every
     reader below takes `it.itemGroup ?? prev.item_group`, so one assignment
     here settles the sofa-set guard, the stock check's variant key, the stored
     column and description2 together.
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

  const qty = it.qty !== undefined ? Number(it.qty) : Number(prev.qty);
  let patchCommitment: ShipBinding | null = null;

  if (it.qty !== undefined && qty > Number(prev.qty) && prev.so_item_id) {
    const remaining = await soRemainingByItemId(sb, [prev.so_item_id as string]);
    const cap = (remaining.get(prev.so_item_id as string) ?? 0) + Number(prev.qty);
    if (qty > cap) {
      return c.json({
        error: 'over_remaining',
        message: `New qty ${qty} exceeds the most this line can deliver (${cap}) for the linked Sales Order line.`,
        soItemId: prev.so_item_id, remaining: cap, requested: qty,
      }, 409);
    }
  }

  if (it.qty !== undefined && qty > Number(prev.qty) && prev.so_item_id) {
    const effGroup = (it.itemGroup ?? prev.item_group) as string | null;
    const effCode = String((it.itemCode as string | undefined) ?? (prev.item_code as string) ?? '');
    const isSofaLine = (effGroup ?? '').toUpperCase().includes('SOFA');
    if (isSofaLine) {
      const { data: soRow } = await sb.from('mfg_sales_order_items')
        .select('warehouse_id, allocated_batch_no').eq('id', prev.so_item_id).maybeSingle();
      const so = (soRow ?? null) as { warehouse_id: string | null; allocated_batch_no: string | null } | null;
      const batch = so?.allocated_batch_no ?? null;
      const variantKey = computeVariantKey(effGroup, (it.variants ?? prev.variants) as VariantAttrs | null);
      const delta = qty - Number(prev.qty);
      let have = 0;
      if (batch && so?.warehouse_id) {
        const sofaStock = await loadSofaBatchStock(sb, [effCode]);
        have = sofaStock.remaining.get(sofaStockKey(so.warehouse_id, batch, effCode, variantKey)) ?? 0;
      }
      if (!batch || !so?.warehouse_id || have < delta) {
        const offender = { itemCode: effCode, soItemId: prev.so_item_id as string };
        const dropship = await buildDropshipOffenders(sb, [offender]);
        const allHavePo = dropship.length > 0 && dropship.every((o) => !!o.poNumber);
        if ((it as { dropShip?: boolean }).dropShip !== true || !allHavePo) {
          return c.json(sofaNoCompleteBatchResponse([offender], dropship), 409);
        }
        const { error: dsErr } = await sb.from('delivery_orders').update({ is_dropship: true }).eq('id', id);
        if (dsErr && !(dsErr.message ?? '').includes('is_dropship')) {
          /* eslint-disable-next-line no-console */ console.error('[dropship] flag DO failed:', dsErr.message);
        }
      }
    }
  }

  if (it.qty !== undefined && qty > Number(prev.qty)) {
    const { data: doHeader } = await sb.from('delivery_orders').select('status, warehouse_id').eq('id', id).maybeSingle();
    const dh = (doHeader ?? { status: null, warehouse_id: null }) as { status: string | null; warehouse_id: string | null };
    if (SHIPPED_STATES.includes((dh.status ?? '').toUpperCase())) {
      const targetWh = (await resolveDoLineWarehouses(
        sb,
        [{ id: 'delta', so_item_id: (prev.so_item_id as string | null) ?? null }],
        dh.warehouse_id ?? null,
        activeCompanyId(c),
      )).get('delta') ?? null;
      if (targetWh) {
        const delta = qty - Number(prev.qty);
        const effGroup = (it.itemGroup ?? prev.item_group) as string | null;
        const effVariants = (it.variants ?? prev.variants) as VariantAttrs | null;
        const effCode = (it.itemCode as string | undefined) ?? (prev.item_code as string);
        const effVariantKey = computeVariantKey(effGroup, effVariants);
        const stockLines = [{
          itemCode: effCode,
          productName: (prev.description as string | null) ?? null,
          variantKey: effVariantKey,
          qty: delta,
        }];
        const shortages = isServiceLine({ itemGroup: effGroup, itemCode: effCode })
          ? []
          : await checkStockAvailability(sb, targetWh, stockLines, activeCompanyId(c));
        const patchPlan = await resolveShipCommitments(sb, [{
          lineRef: 'patch',
          soItemId: (prev.so_item_id as string | null) ?? null,
          itemCode: effCode,
          itemGroup: effGroup,
          variantKey: effVariantKey,
          qty: delta,
          priorShippedQty: Number(prev.qty ?? 0),
          priorBatchNo: (prev.committed_po_batch_no as string | null) ?? null,
        }], targetWh, shortages, activeCompanyId(c) ?? null, { doId: id });
        if (patchPlan.setConflicts.length > 0) {
          return c.json(sofaSetPoSplitResponse(patchPlan.setConflicts), 409);
        }
        patchCommitment = patchPlan.bindings.get('patch') ?? null;
        if (shortages.length > 0 && !(it as { confirmShortStock?: boolean }).confirmShortStock) {
          return c.json(shortStockResponse(shortages, bindingList(patchPlan.bindings)), 409);
        }
      }
    }
  }

  if (it.qty !== undefined && qty < Number(prev.qty)) {
    const consumed = await doLineConsumedQty(sb, itemId);
    if (qty < consumed) {
      return c.json({
        error: 'qty_below_downstream_consumption',
        message: `Cannot reduce qty to ${qty} — ${consumed} unit${consumed === 1 ? ' has' : 's have'} already been invoiced or returned for this line. Cancel the related Invoice / Delivery Return first.`,
        currentQty: Number(prev.qty), newQty: qty, consumed,
      }, 409);
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
    qty, unit_price_sen: unitPrice, discount_sen: discount, unit_cost_sen: unitCost,
    line_total_sen: lineTotal, line_cost_sen: lineCost, line_margin_sen: lineTotal - lineCost,
  };
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['itemGroup', 'item_group'], ['description', 'description'],
    ['uom', 'uom'], ['variants', 'variants'], ['notes', 'notes'],
    ['lineDeliveryDate', 'line_delivery_date'],
    ['rackId', 'rack_id'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  coerceEmptyDates(updates);
  if (patchCommitment) {
    updates['committed_po_batch_no'] = patchCommitment.poNumber;
    updates['committed_variant_key'] = patchCommitment.variantKey;
    updates['committed_batch_strict'] = patchCommitment.strictBatch;
  }
  if (it.lineDeliveryDate !== undefined) updates['line_delivery_date_overridden'] = true;
  if (it.lineDeliveryDateOverridden !== undefined) updates['line_delivery_date_overridden'] = Boolean(it.lineDeliveryDateOverridden);
  {
    const effGroup = (it.itemGroup ?? prev.item_group) as string | null | undefined;
    const effVariants = (it.variants ?? prev.variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  const { error } = await scopeToCompanyId(sb.from('delivery_order_items').update(updates).eq('id', itemId), co.companyId);
  if (isSoLineOverDelivered(error)) return c.json({ error: 'over_remaining', message: 'New qty exceeds the most this line can deliver for the linked Sales Order line.', soItemId: prev.so_item_id ?? null, reason: error?.message }, 409);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);

  {
    const meta = await loadDoAuditMeta(sb, id);
    const auditPatch: Record<string, unknown> = {};
    for (const [camel, snake] of DO_LINE_AUDIT_FIELDS) {
      if (updates[snake] !== undefined) auditPatch[camel] = updates[snake];
    }
    const lineChanges = diffFields(prev as unknown as Record<string, unknown>, auditPatch, DO_LINE_AUDIT_FIELDS);
    if (lineChanges.length > 0) {
      await recordEntityAudit(sb, {
        entityType: 'DELIVERY_ORDER',
        entityId: id,
        entityDocNo: meta.docNo,
        action: 'UPDATE',
        actor: c.get('houzsUser'),
        companyId: meta.companyId ?? activeCompanyId(c),
        statusSnapshot: meta.status,
        note: `Line edited: ${String((prev as { item_code?: string | null }).item_code ?? itemId)}`,
        fieldChanges: lineChanges,
      });
    }
  }

  await recomputeTotals(sb, id);
  await resyncInventoryForDo(sb, id, user?.id);
  try {
    const { data: doRow } = await sb.from('delivery_orders').select('so_doc_no').eq('id', id).maybeSingle();
    await syncSoDeliveredFromDo(sb, [(doRow as { so_doc_no?: string } | null)?.so_doc_no], user?.id);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-sync] post-do-line-edit failed:', e); }
  await queueAcDoEdit(c, id);
  return c.json({ ok: true });
});

deliveryOrdersMfg.delete('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId'); const user = c.get('user');
  // company-scope: prove the parent DO — same reasoning as the line PATCH above.
  // Deleting a shipped line reverses inventory, so this is a stock write too.
  {
    const { data: own, error: ownErr } = await scopeToCompany(
      sb.from('delivery_orders').select('id').eq('id', id), c,
    ).maybeSingle();
    if (ownErr) return c.json({ error: 'lookup_failed', reason: ownErr.message }, 500);
    if (!own) return c.json({ error: 'not_found' }, 404);
  }

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const consumed = await doLineConsumedQty(sb, itemId);
  if (consumed > 0) {
    return c.json({
      error: 'line_has_downstream_consumption',
      message: `Cannot delete this line — ${consumed} unit${consumed === 1 ? ' has' : 's have'} already been invoiced or returned. Cancel the related Invoice / Delivery Return first to release the quantity.`,
      consumed,
    }, 409);
  }

  const { data: doomedRow } = await scopeToCompanyId(sb.from('delivery_order_items')
    .select('item_code, description, qty, unit_price_sen, discount_sen, line_total_sen')
    .eq('id', itemId), co.companyId).maybeSingle();
  if (!doomedRow) return c.json(NOT_THIS_COMPANY, 404);
  const doomed = (doomedRow ?? {}) as Record<string, unknown>;

  const retire = await retiredLineOf(sb, 'delivery_order_items', itemId);

  const { error } = await scopeToCompanyId(sb.from('delivery_order_items').delete().eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);

  {
    const meta = await loadDoAuditMeta(sb, id);
    await recordEntityAudit(sb, {
      entityType: 'DELIVERY_ORDER',
      entityId: id,
      entityDocNo: meta.docNo,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: meta.companyId ?? activeCompanyId(c),
      statusSnapshot: meta.status,
      note: `Line removed: ${String(doomed.item_code ?? itemId)}`,
      fieldChanges: compactChanges([
        fieldChange('itemCode', doomed.item_code ?? null, null),
        fieldChange('description', doomed.description ?? null, null),
        fieldChange('qty', doomed.qty ?? null, null),
        fieldChange('unitPriceSen', doomed.unit_price_sen ?? null, null),
        fieldChange('discountSen', doomed.discount_sen ?? null, null),
        fieldChange('lineTotalSen', doomed.line_total_sen ?? null, null),
      ]),
    });
  }

  await recomputeTotals(sb, id);
  await resyncInventoryForDo(sb, id, user?.id);
  try {
    const { data: doRow } = await sb.from('delivery_orders').select('so_doc_no').eq('id', id).maybeSingle();
    await syncSoDeliveredFromDo(sb, [(doRow as { so_doc_no?: string } | null)?.so_doc_no], user?.id);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-sync] post-do-line-delete failed:', e); }
  await queueAcDoEdit(c, id, retire);
  return c.json({ ok: true });
});

/* No payment ledger on the delivery order. The sales order is the one place a
   payment is taken (owner, 2026-09-12: 「SO 的付款要带去 DO 跟 SI」); the DO and
   the SI show the order's ledger. A DO-side GET/POST/DELETE used to live here
   over scm.delivery_order_payments, a table production never had — see
   docs/bugs/0888-the-delivery-order-payment-ledger-served-a-table-production.md. */

const CANCEL_RETRY_AFTER_MS = 60_000;
export const cancelReversalRetryDue = (updatedAt: string | null | undefined, nowMs: number): boolean =>
  Boolean(updatedAt) && nowMs - Date.parse(String(updatedAt)) >= CANCEL_RETRY_AFTER_MS;

export const patchDeliveryOrderStatusHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  let body: {
    status?: string; signatureData?: string; podKey?: string; podKeys?: unknown;
    podLat?: number; podLng?: number; podAccuracyM?: number; podLocatedAt?: string;
    confirmShortStock?: boolean; confirmNotReady?: boolean;
  }; try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.status) return c.json({ error: 'status_required' }, 400);
  /* NORMALISE FIRST, exactly as the Sales Order handler does
     (`const toStatus = String(body.status).trim().toUpperCase()`,
     mfg-sales-orders.ts). The two sibling handlers disagreed on this, and only
     one of them was right.

     Owner, 2026-08-04, trying to cancel 2990-DO-2607-005 — the remediation for
     the duplicate-delivery incident — and getting: **"cancelled" is not a valid
     Delivery Order status.** Cancel DO and Mark signed on the V2 detail page
     both post LOWERCASE, so both had been dead since that page shipped, and the
     one document that most needed cancelling could not be.

     The comment that used to sit here said "The FE only ever sends the canonical
     UPPERCASE values below." That was an assumption about callers, written into
     the guard as if it were a fact, and three desktop call sites had already
     broken it. Case is not what audit gap #4 was defending against — a garbage
     status is. Normalising costs nothing and removes a whole class of caller
     bug, including one from a browser still running a cached bundle. */
  const toStatus = String(body.status).trim().toUpperCase();
  if (!DO_STATUSES.has(toStatus)) {
    return c.json({
      error: 'invalid_status',
      reason: `"${body.status}" is not a valid Delivery Order status.`,
    }, 400);
  }

  if (c.get('scmWriteBypassed')) {
    const capRefusal = statusCapabilityRefusal(c.get('houzsUser'), toStatus);
    if (capRefusal) return c.json(capRefusal, 403);
  }

  const bypassPod = c.get('scmWriteBypassed') && POD_STATES.has(toStatus);
  let doCompanyIdWhenGranted: number | null = null;
  if (bypassPod) {
    const { data: own, error: ownErr } = await scopeToAllowedCompanies(
      sb.from('delivery_orders').select('company_id').eq('id', id), c,
    ).maybeSingle();
    if (ownErr) return c.json({ error: 'load_failed', reason: ownErr.message }, 500);
    doCompanyIdWhenGranted = (own as { company_id?: number | null } | null)?.company_id ?? null;
  }
  const podCo = podWriteScopeCompany(bypassPod, doCompanyIdWhenGranted);
  let scopeCompanyId: number;
  if (podCo.kind === 'not_your_job') {
    return c.json({ error: 'not_your_job', reason: 'You can only complete a delivery assigned to you.' }, 403);
  } else if (podCo.kind === 'do_company') {
    scopeCompanyId = podCo.companyId;
  } else {
    const co = requireActiveCompanyId(c);
    if (!co.ok) return c.json(co.refusal, 409);
    scopeCompanyId = co.companyId;
  }
  const { data: cur } = await scopeToCompanyId(
    sb.from('delivery_orders').select('status, so_doc_no, updated_at, customer_delivered_date, pod_r2_key, pod_photo_keys').eq('id', id), scopeCompanyId,
  ).maybeSingle();
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const prevStatus = (cur as { status: string }).status;

  if (bypassPod) {
    if (!(DO_STOCK_OUT_STATES as readonly string[]).includes((prevStatus ?? '').toUpperCase()))
      return c.json({ error: 'illegal_status_transition', reason: 'A delivery can only be completed after it has been dispatched.' }, 409);
    const podScope = await resolveDeliveryScope(sb, c.get('houzsUser'));
    if (podScope.mode !== 'all' && !scopeMatchesAssignment(podScope, await fetchDoCrewAssignment(sb, id)))
      return c.json({ error: 'not_your_job', reason: 'You can only complete a delivery assigned to you.' }, 403);
  }

  /* The crew share one stop (owner, 2026-11-10): a second Complete must not file
     a second delivery over the first (new photos, delivered time, SO sync). */
  const prevUp = (prevStatus ?? '').toUpperCase();
  if (toStatus !== 'CANCELLED' && doHasArrived(prevUp) && doHasArrived(toStatus) && (prevUp === toStatus || bypassPod)) {
    const { data: doneRow, error: doneErr } = await scopeToCompanyId(sb.from('delivery_orders').select('delivered_at').eq('id', id), scopeCompanyId).maybeSingle();
    if (doneErr) return c.json({ error: 'load_failed', reason: doneErr.message }, 500);
    return c.json(alreadyDeliveredRefusal((doneRow as { delivered_at?: string | null } | null)?.delivered_at ?? null), 409);
  }

  if (toStatus === 'CANCELLED' && prevStatus === 'CANCELLED') {
    const retried = cancelReversalRetryDue((cur as { updated_at?: string | null }).updated_at, Date.now())
      ? await reverseInventoryForDo(sb, id, user.id).catch((e: unknown) => [`DO reversal threw: ${e instanceof Error ? e.message : 'unknown'}`])
      : [];
    return c.json({ deliveryOrder: { id, status: 'CANCELLED' }, movementErrors: retried.length ? retried : undefined });
  }
  if (prevStatus === 'CANCELLED') {
    return c.json({
      error: 'do_cancelled_final',
      reason: 'A cancelled Delivery Order cannot be reactivated — its stock was already returned. Create a new DO to deliver again.',
    }, 409);
  }

  {
    const prevUpper = (prevStatus ?? '').toUpperCase();
    if (DO_STOCK_OUT_STATUSES.has(prevUpper) && DO_PRESHIP_STATUSES.has(toStatus)) {
      return c.json({
        error: 'illegal_status_transition',
        reason: 'This Delivery Order has already shipped, so it cannot be moved back to a not-shipped status. Cancel it and create a new Delivery Order instead.',
      }, 409);
    }
    if (doHasArrived(prevUpper) && !doHasArrived(toStatus) && toStatus !== 'CANCELLED') {
      return c.json({
        error: 'use_revert',
        reason: 'This Delivery Order is marked Delivered. To take it back to Loaded, use "Undo delivered" on the Delivery Order and give the reason.',
      }, 409);
    }
  }

  if (toStatus === 'CANCELLED') {
    const childLock = await doHasDownstream(sb, id);
    if (childLock) return c.json(childLock, 409);
  }

  const now = new Date().toISOString();
  const ts: Record<string, string> = { updated_at: now };
  const tsNum: Record<string, number> = {};
  if (toStatus === 'DISPATCHED') ts.dispatched_at = now;
  const startsRun = toStatus === 'IN_TRANSIT' && (prevStatus ?? '').toUpperCase() !== 'IN_TRANSIT';
  if (startsRun) ts.departure_at = now;
  if (toStatus === 'SIGNED')     ts.signed_at = now;
  if (toStatus === 'DELIVERED')  ts.delivered_at = now;
  if (toStatus === 'DELIVERED' && !(cur as { customer_delivered_date?: string | null }).customer_delivered_date) {
    ts.customer_delivered_date = todayMyt();
  }
  if (typeof body.signatureData === 'string' && body.signatureData) ts.signature_data = body.signatureData;
  const podRaw = [body.podKey, ...(Array.isArray(body.podKeys) ? body.podKeys : [])].filter((k) => typeof k === 'string' && k);
  let podKeys: string[] = [];
  if (podRaw.length) {
    const claim = await claimPodPhotos(sb, c, { houzsUserId: houzsUserIdOf(c), stopContext: doStopContext(id) }, podRaw);
    if (!claim.ok) return c.json({ error: 'photo_not_accepted', reason: claim.reason }, 400);
    podKeys = claim.keys;
  }
  if (podKeys.length) podKeys = mergePodPhotoKeys(podPhotoKeysOf(cur as { pod_r2_key: string | null; pod_photo_keys: unknown }), podKeys);
  if (podKeys.length) ts.pod_r2_key = podKeys[0]!;
  const tsJson: Record<string, string[]> = podKeys.length ? { pod_photo_keys: podKeys } : {};

  const lat = typeof body.podLat === 'number' && Number.isFinite(body.podLat) ? body.podLat : null;
  const lng = typeof body.podLng === 'number' && Number.isFinite(body.podLng) ? body.podLng : null;
  if (lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    tsNum.pod_lat = lat;
    tsNum.pod_lng = lng;
    if (typeof body.podAccuracyM === 'number' && Number.isFinite(body.podAccuracyM) && body.podAccuracyM >= 0) {
      tsNum.pod_accuracy_m = body.podAccuracyM;
    }
    ts.pod_located_at = typeof body.podLocatedAt === 'string' && body.podLocatedAt ? body.podLocatedAt : now;
  }

  if (SHIPPED_STATES.includes(toStatus) && DO_PRESHIP_STATUSES.has((prevStatus ?? '').toUpperCase())) {
    const { data: shipLines } = await sb.from('delivery_order_items')
      .select('so_item_id, item_code, qty').eq('delivery_order_id', id);
    const rows = (shipLines ?? []) as Array<{ so_item_id: string | null; item_code: string | null; qty: number | null }>;
    const linkedQty = new Map<string, number>();
    const unlinkedByItemCode = new Map<string, number>();
    for (const l of rows) {
      if (l.so_item_id) {
        linkedQty.set(l.so_item_id, (linkedQty.get(l.so_item_id) ?? 0) + Number(l.qty ?? 0));
      } else if (l.item_code) {
        unlinkedByItemCode.set(l.item_code, (unlinkedByItemCode.get(l.item_code) ?? 0) + Number(l.qty ?? 0));
      }
    }
    const overDeliveryRefusal = {
      error: 'over_delivery',
      message: 'This delivery would ship more than the Sales Order ordered — another DO already covers it. Refresh and check the Sales Order.',
    };
    if (linkedQty.size > 0) {
      const remaining = await soRemainingByItemId(sb, [...linkedQty.keys()]);
      const over = findOverDeliveredSoItems(linkedQty, remaining);
      if (over.length > 0) {
        return c.json({ ...overDeliveryRefusal, conflicts: over }, 409);
      }
    }
    if (unlinkedByItemCode.size > 0) {
      const soDocNo = (cur as { so_doc_no?: string | null }).so_doc_no ?? null;
      if (soDocNo) {
        const remainingMap = await soDeliverableRemaining(sb, [soDocNo]);
        const openByItemCode = new Map<string, number>();
        for (const line of remainingMap.values()) {
          const key = itemCodeKey(line.itemCode);
          if (!key) continue;
          openByItemCode.set(key, (openByItemCode.get(key) ?? 0) + line.remaining);
        }
        const overCodes = findOverDeliveredUnlinkedItems(unlinkedByItemCode, openByItemCode);
        if (overCodes.length > 0) {
          return c.json({ ...overDeliveryRefusal, conflicts: overCodes }, 409);
        }
      }
    }
  }

  if (SHIPPED_STATES.includes(toStatus) && DO_PRESHIP_STATUSES.has((prevStatus ?? '').toUpperCase())) {
    const refused = await doConfirmPreflight(sb, id, scopeCompanyId, { confirmShortStock: body.confirmShortStock === true, confirmNotReady: body.confirmNotReady === true }, checkDoStockAvailability);
    if (refused) return c.json(refused.body, refused.status);
  }

  let data: { id: string; status: string } | null;
  let shippedAtomically = false;
  if (toStatus === 'CANCELLED') {
    const { data: updated, error } = await scopeToCompanyId(sb.from('delivery_orders')
      .update({ status: toStatus, ...ts, ...tsNum, ...tsJson })
      .eq('id', id), scopeCompanyId).neq('status', 'CANCELLED')
      .select('id, status').maybeSingle();
    // HC-0004 T2: an SI line raced in after the doHasDownstream check above.
    const dbLock = doCancelDbRefusal(error);
    if (dbLock) return c.json(dbLock, 409);
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    if (!updated) {
      return c.json({ deliveryOrder: { id, status: 'CANCELLED' } });
    }
    data = updated as { id: string; status: string };
  } else {
    type Written = { data: { id: string; status: string } | null; error: { message: string; code?: string } | null };
    const write = (db: Parameters<typeof writeMovements>[0]): Promise<Written> => scopeToCompanyId(db.from('delivery_orders')
      .update({ status: toStatus, ...ts, ...tsNum, ...tsJson }).eq('id', id), scopeCompanyId)
      .eq('status', prevStatus).select('id, status').maybeSingle()
      .then((r: unknown) => r as Written, (e: { message: string; code?: string }) => ({ data: null, error: e }));
    const checked = (w: Written) => (isSoLineOverDelivered(w.error) ? { ok: false as const, reason: 'over_delivery', detail: w.error?.message }
      : w.error ? { ok: false as const, reason: 'update_failed', detail: w.error.message }
      : w.data ? { ok: true as const, data: w.data } : { ok: false as const, reason: 'status_changed' });
    const shipTx = SHIPPED_STATES.includes(toStatus) && DO_PRESHIP_STATUSES.has((prevStatus ?? '').toUpperCase()) ? stockTxFor(c.env, 'DO_SHIP_MODE') : null;
    const res = shipTx
      ? await shipDoAtomically(shipTx, sb, id, user.id, async (t) => checked(await write(t)))
      : checked(await write(sb));
    if (!res.ok) { const r = doShipFailureResponse(res); return c.json(r.body, r.status); }
    data = res.data;
    shippedAtomically = shipTx !== null;
  }

  let movementErrors: string[] = [];
  let emailNotice: string | null = null;
  if (SHIPPED_STATES.includes(toStatus)) {
    if (!shippedAtomically) movementErrors = await deductInventoryForDo(sb, id, user.id);
    if (hasUnreadableLines(movementErrors)) return c.json(await revertShipOnUnreadLines(sb, id, scopeCompanyId, toStatus, prevStatus, ts, (cur as { customer_delivered_date?: string | null }).customer_delivered_date ?? null, movementErrors, null), 503);
    if (DO_PRESHIP_STATUSES.has(prevStatus)) {
      const { data: doRow } = await sb.from('delivery_orders').select('so_doc_no').eq('id', id).maybeSingle();
      await syncSoDeliveredFromDo(sb, [(doRow as { so_doc_no?: string } | null)?.so_doc_no], user.id);
    }

    /* Customer DO email (owner trigger "A", 2026-07-17). Owner ruled "send on
       CONFIRMED, NOT on delivered": every shipped state deducts, but "on its way"
       is false once arrived, so this fires only on the CONFIRM hop out of a
       pre-ship status. Once-per-DO (do_email_sent_at, claimed atomically inside);
       gated OFF and fail-closed. CONFIRM_HOP_STATES gained LOADED 2026-08-22. */
    if ((CONFIRM_HOP_STATES as readonly string[]).includes(toStatus) && DO_PRESHIP_STATUSES.has((prevStatus ?? '').toUpperCase())) {
      emailNotice = await maybeSendDeliveryOrderEmail(sb, c.env, id);
    }
  }

  if (toStatus === 'DELIVERED') {
    const { data: doRow } = await sb.from('delivery_orders').select('so_doc_no').eq('id', id).maybeSingle();
    await syncSoDeliveredFromDo(sb, [(doRow as { so_doc_no?: string } | null)?.so_doc_no], user.id);
    await maybeSendPodDeliveredWhatsApp(c, id);
  }

  if (toStatus === 'CANCELLED') {
    try {
      movementErrors.push(...(await reverseInventoryForDo(sb, id, user.id)));
    } catch (e) {
      movementErrors.push(`DO reversal threw: ${(e as Error)?.message ?? 'unknown'}`);
    }
    try {
      const { data: doRow } = await scopeToCompanyId(sb.from('delivery_orders').select('do_number, company_id').eq('id', id), scopeCompanyId).maybeSingle();
      const doNo = (doRow as { do_number?: string } | null)?.do_number ?? null;
      if (doNo) await returnDoRacksOnCancel(sb, id, doNo, user.id, (doRow as { company_id?: number | null } | null)?.company_id ?? null, 'cancel');
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[do-rack] cancel reversal failed:', e); }
    try {
      const { data: doRow } = await sb.from('delivery_orders').select('so_doc_no').eq('id', id).maybeSingle();
      await syncSoDeliveredFromDo(sb, [(doRow as { so_doc_no?: string } | null)?.so_doc_no], user.id);
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-sync] post-do-cancel failed:', e); }
    try {
      const { recomputeAllocationAfterSave } = await import('../lib/stock-allocation-job');
      await recomputeAllocationAfterSave(sb, 'post-do-cancel');
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-do-cancel failed:', e); }
    const { data: doRow } = await sb.from('delivery_orders').select('do_number').eq('id', id).maybeSingle();
    await enqueueCancel(sb, {
      companyId: scopeCompanyId,
      docType: 'DO',
      docNo: (doRow as { do_number?: string } | null)?.do_number ?? id,
      docId: id,
      self: { table: 'delivery_orders', keyCol: 'id', key: id },
      createdBy: c.get('houzsUser')?.id ?? null,
    });
  }

  if (startsRun) {
    try {
      const { data: stop, error: stopErr } = await sb.from('trip_stops').select('trip_id').eq('do_id', id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (stopErr) throw new Error(stopErr.message);
      await startTripIfPlanned(sb, (stop as { trip_id: string | null } | null)?.trip_id ?? null);
    } catch (e) { console.error('[do-status] could not start the trip:', e); }
  }

  return c.json({
    deliveryOrder: data,
    movementErrors: movementErrors.length ? movementErrors : undefined,
    emailNotice: emailNotice ?? undefined,
  });
};
deliveryOrdersMfg.patch('/:id/status', patchDeliveryOrderStatusHandler);

export const patchDeliveryOrderArrivalHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  if (c.get('scmWriteBypassed')) {
    const capRefusal = statusCapabilityRefusal(c.get('houzsUser'), 'IN_TRANSIT');
    if (capRefusal) return c.json(capRefusal, 403);
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: cur, error: readErr } = await scopeToCompanyId(
    sb.from('delivery_orders').select('status, arrival_at').eq('id', id), co.companyId,
  ).maybeSingle();
  if (readErr) return c.json({ error: 'load_failed', reason: readErr.message }, 500);
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const row = cur as { status: string | null; arrival_at: string | null };
  const status = (row.status ?? '').toUpperCase();
  if (status !== 'DISPATCHED' && status !== 'IN_TRANSIT')
    return c.json({ error: 'illegal_status_transition', reason: 'Arrival can only be recorded for a delivery that is on the road.' }, 409);
  if (c.get('scmWriteBypassed')) {
    const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
    if (scope.mode !== 'all' && !scopeMatchesAssignment(scope, await fetchDoCrewAssignment(sb, id)))
      return c.json({ error: 'not_your_job', reason: 'You can only update a delivery assigned to you.' }, 403);
  }
  if (row.arrival_at) return c.json({ deliveryOrder: { id, arrival_at: row.arrival_at } });
  const now = new Date().toISOString();
  const { error } = await scopeToCompanyId(
    sb.from('delivery_orders').update({ arrival_at: now, updated_at: now }).eq('id', id).is('arrival_at', null),
    co.companyId,
  );
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  return c.json({ deliveryOrder: { id, arrival_at: now } });
};
deliveryOrdersMfg.patch('/:id/arrival', patchDeliveryOrderArrivalHandler);
deliveryOrdersMfg.get('/:id/pod-photo/:n', doPodPhotoHandler);
deliveryOrdersMfg.post('/:id/revert', revertDeliveryOrderHandler);

mountHoldRoute(deliveryOrdersMfg, 'do');
