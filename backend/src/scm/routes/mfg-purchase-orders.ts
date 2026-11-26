
import { isPoLineOverReceived } from '../lib/qty-cap';
import { Hono } from 'hono';
import { PO_STATUS_BUCKETS } from '../lib/po-status-buckets';
import { HELD_OR_TERM, isDocumentHeld } from '../lib/document-hold';
import { PO_HEADER_COLS, PO_LIST_SELECT, poListSelect, filterPoList, orderPoList, readPoListFilters, stampPoListGrns } from '../lib/po-list-read';
import { attachPoLines } from '../lib/po-line-export';
import { firstUnorderableSo, soNotOrderableResponse } from '../lib/source-document-gates';
import { soLinkItemMismatch, type SoSourceLine } from '../lib/so-link-item-identity';
import { mountHoldRoute } from './document-hold-routes';
import {
  buildVariantSummary, pickCostComboMatch, spreadComboTotal,
  splitSofaCode, sofaHeightKey, effectiveSoDelivery,
  type SofaComboRow, type SofaPriceTier,
} from '../shared';
import { findSofaSetSupplierSplits } from '../shared/sofa-set-identity';
import { computeMfgPoUnitCost, type MfgFabricTier, type MaintenanceConfig, type PoPriceMatrix } from '../shared/mfg-pricing';
import { orderSofaModuleRowsWithinBuilds, sortLinesByStoredLineNo, sortSoLinesByGroupRank } from '../shared/so-line-display';
import { inPoLineOrder, nextPoLineNo, sortBySourceSoLine, stampPoLineNos } from '../lib/po-line-order';
import { poConvertLineRows } from '../lib/po-convert-line';
import { parseLineNumbers, invalidLineNumberBody } from '../shared/line-numbers';
import { changedPoIdentityLockCols, poIdentityLockedRefusal } from '../shared/po-identity-lock';
import { resolvePoRecipients } from '../shared/supplier-emails';
import { poVariantGaps, poVariantCheckFailedBody, poVariantConfirmRefusal, poWarehouseGap, PO_WAREHOUSE_REQUIRED, poInactivePickRefusal } from './po-gates';
import { VALID_CURRENCIES, VALID_KINDS } from '../lib/purchase-doc-vocab';
import { resolveMaintenanceConfigForSupplier, poVariantPricingInput } from '../lib/po-pricing';
import { readMfgProductBindings } from '../lib/supplier-bindings';
import { loadOutstandingSoLines } from '../lib/outstanding-so-lines'; import { readFailure, readFailureError } from '../lib/read-failure';
import { poHasDownstream } from '../lib/downstream-lock';
import { claimPoVersion, poVersionRaced, poVersionRefusal } from '../lib/po-version';
import { readPoLinkedGrns } from '../lib/po-grn-links';
import { cascadePoSupplierDate, pickSupplierDateSlot, supplierDatePatchGate, SUPPLIER_DATE_SLOT_COL, type SupplierDateSlot } from '../lib/po-supplier-date-cascade'; import { movePoLinesToNewWarehouse } from '../lib/po-warehouse-move';
import { description2InputsChanged } from '../lib/po-line-description2';
import { dateOrNull, coerceEmptyDates } from '../lib/date-coerce';
import { todayMyt } from '../lib/my-time';
import { enqueuePoCreate, enqueueCancel, enqueueEdit, retiredLineOf, type AcRetiredLine } from '../lib/autocount-outbox';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { readStatusCounts } from '../lib/status-counts';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { loadSoWarehouseMasters, type SoWarehouseMasters, type SoWarehouseSource } from '../lib/so-warehouse';
import { computeSoDrift, type DriftLine } from '../lib/so-po-drift';
import {
  loadLeadTimeBase,
  loadSupplierCategoryOverrides,
  resolveLeadDays,
  subtractCalendarDays,
  LEAD_TIME_SELECT,
  LEAD_OVERRIDE_SELECT,
} from '../lib/lead-time';
import { groupKeyFor } from '../lib/po-grouping';
import { diningLineNote, diningPoHeaderNotes } from '../lib/po-dining-remark';
import { findOverConvertOffender, soLineHeadroom, soLineOverConvertRefusal, type OverConvertOffender, loadBoundOrderedQty, boundAwarePicked, isBoundForCompany } from '../lib/po-over-convert';
import {
  planAllocationCreate,
  planAllocationQtyUpdate,
  resequenceAfterDelete,
  allocationSubNumber,
  specMatches,
  specSignature,
  type AllocationRow,
} from '../lib/po-allocations';
import { loadLeadBuffers } from '../../services/agents/procurement-learning';
import { sendEmail, isChannelEnabled } from '../../services/email';
import { getBrandingForCompany } from '../../services/branding';
import {
  buildPurchaseOrderEmail, poEmailDocNo, poReplyTo,
  poSendRefusalForStatus,
  validatePoAttachment,
  PO_RESEND_WINDOW_MS,
  type PoEmailRow,
} from '../lib/po-email';
import { getSupabaseService } from '../../db/supabase';
import { signSoItemPhotoUrl, soItemPhotoBindings } from '../lib/r2';
import { baseKeyOf, thumbKeyFor } from '../../services/photoThumbs';
import { proxyFallbackPayload, type PhotoUrlPayload } from '../lib/photoProxyFallback';
import { markIdempotencyNoWrite } from '../../middleware/idempotency';
import { soHasPoGate } from '../lib/so-line-po-duplicate';
import { withMrpAssignments } from '../lib/so-has-po-assignments';
import type { Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { recordEntityAudit, diffFields, compactChanges, fieldChange, statusChange } from '../lib/entity-audit';
import { PO_LINE_AUDIT_FIELDS, PO_LINE_AUDIT_SELECT } from '../lib/entity-audit-fields';
import { computeMrp } from './mrp';
import { eager } from '../lib/concurrency';
import { provenanceNote } from '../shared/transfer-vocabulary';
import type { Env, Variables } from '../env';
import { skuCategoryResolver, lineIdentityFields } from '../lib/sku-category';
import { firstSoLinkCategoryMismatch, soLinkCategoryMismatch, hardBoundUnlinkRefusal, hardBoundSplitRefusal, editedLineGroup } from '../lib/hard-bound-po-line';
import { pgrestIn } from '../lib/pgrest-in-list';
import { withPoSearchIds } from '../lib/po-item-code-search';
import { releaseRequestFromCancelledPo } from '../lib/product-request-link';
import { deferMrpSnapshotRefresh } from '../lib/mrp-snapshot';
import { grnLineNetReceived } from '../lib/po-net-received';
import { yymmFor } from '../../services/documentRefs';
import { mrpPlanStaleRefusal, settleFromSosForMrp } from '../lib/mrp-plan-freshness';


async function loadSupplierSofaCombos(
  sb: any,
  supplierIds: readonly string[],
): Promise<Map<string, SofaComboRow[]>> {
  const out = new Map<string, SofaComboRow[]>();
  if (supplierIds.length === 0) return out;
  const { data } = await sb
    .from('sofa_combo_pricing')
    .select('id, base_model, modules, tier, customer_id, supplier_id, prices_by_height, label, effective_from, created_at, deleted_at')
    .is('deleted_at', null)
    .in('supplier_id', supplierIds);
  for (const r of (data ?? []) as Array<{
    id: string; base_model: string; modules: string[][]; tier: SofaPriceTier | null;
    customer_id: string | null; supplier_id: string; prices_by_height: Record<string, number | null>;
    label: string | null; effective_from: string; created_at: string; deleted_at: string | null;
  }>) {
    const row: SofaComboRow = {
      id: r.id, baseModel: r.base_model, modules: r.modules ?? [],
      tier: r.tier, customerId: r.customer_id,
      pricesByHeight: r.prices_by_height ?? {},
      label: r.label, effectiveFrom: r.effective_from, createdAt: r.created_at, deletedAt: r.deleted_at,
    };
    const arr = out.get(r.supplier_id) ?? [];
    arr.push(row);
    out.set(r.supplier_id, arr);
  }
  return out;
}

const PO_AUDIT_FIELDS: Array<[string, string]> = [
  ['poDate', 'po_date'], ['expectedAt', 'expected_at'], ['currency', 'currency'],
  ['notes', 'notes'], ['supplierId', 'supplier_id'], ['purchaseLocationId', 'purchase_location_id'],
  ['supplierDeliveryDate2', 'supplier_delivery_date_2'], ['supplierDeliveryDate3', 'supplier_delivery_date_3'],
  ['supplierDeliveryDate4', 'supplier_delivery_date_4'],
];

const PO_AUDIT_SELECT =
  `id, po_number, status, company_id, ${PO_AUDIT_FIELDS.map(([, snake]) => snake).join(', ')}`;


async function loadPoAuditMeta(
  sb: Variables['supabase'],
  poId: string,
): Promise<{ docNo: string | null; companyId: number | null; status: string | null }> {
  try {
    const { data } = await sb.from('purchase_orders')
      .select('po_number, company_id, status').eq('id', poId).maybeSingle();
    const row = (data ?? null) as { po_number?: string | null; company_id?: number | null; status?: string | null } | null;
    return { docNo: row?.po_number ?? null, companyId: row?.company_id ?? null, status: row?.status ?? null };
  } catch {
    return { docNo: null, companyId: null, status: null };
  }
}

async function recordPoCreate(
  sb: Variables['supabase'],
  actor: Variables['houzsUser'],
  fallbackCompanyId: number | null | undefined,
  poId: string,
  lineCount: number,
  note?: string,
): Promise<void> {
  let row: Record<string, unknown> | null = null;
  try {
    const { data } = await sb.from('purchase_orders')
      .select('id, po_number, status, company_id, supplier_id, po_date, expected_at, ' +
        'currency, purchase_location_id, notes, subtotal_sen, total_sen')
      .eq('id', poId).maybeSingle();
    row = (data ?? null) as Record<string, unknown> | null;
  } catch { }
  if (!row) return;
  await recordEntityAudit(sb, {
    entityType: 'PURCHASE_ORDER',
    entityId: poId,
    entityDocNo: (row.po_number as string | null) ?? null,
    action: 'CREATE',
    actor,
    companyId: (row.company_id as number | null) ?? fallbackCompanyId,
    statusSnapshot: (row.status as string | null) ?? null,
    note,
    fieldChanges: compactChanges([
      fieldChange('status', null, row.status ?? null),
      fieldChange('supplierId', null, row.supplier_id ?? null),
      fieldChange('poDate', null, row.po_date ?? null),
      fieldChange('expectedAt', null, row.expected_at ?? null),
      fieldChange('currency', null, row.currency ?? null),
      fieldChange('purchaseLocationId', null, row.purchase_location_id ?? null),
      fieldChange('notes', null, row.notes ?? null),
      fieldChange('totalSen', null, row.total_sen ?? null),
      fieldChange('lineCount', null, lineCount),
    ]),
  });
}

export const mfgPurchaseOrders = new Hono<{ Bindings: Env; Variables: Variables }>();

mfgPurchaseOrders.use('*', supabaseAuth);


async function queueAcPoEdit(c: any, poId: string, retire: AcRetiredLine[] = [], newLineIds: string[] = []): Promise<void> {
  await enqueueEdit(c.get('supabase'), {
    companyId: activeCompanyId(c),
    docType: 'PO',
    docId: poId,
    retire,
    newLineIds,
    createdBy: c.get('houzsUser')?.id ?? null,
  });
}

async function poHasOutstandingDropshipOut(
  sb: any,
  poNumber: string | null | undefined,
): Promise<{ error: string; message: string } | null> {
  if (!poNumber) return null;
  try {
    const { data: outs, error } = await sb.from('inventory_movements')
      .select('source_doc_id')
      .eq('movement_type', 'OUT')
      .eq('source_doc_type', 'DO')
      .eq('batch_no', poNumber);
    if (error) return null;
    const doIds = [...new Set(((outs ?? []) as Array<{ source_doc_id: string | null }>)
      .map((m) => m.source_doc_id).filter((x): x is string => !!x))];
    if (doIds.length === 0) return null;
    const { data: dos } = await sb.from('delivery_orders')
      .select('id, do_number, status').in('id', doIds);
    const live = ((dos ?? []) as Array<{ id: string; do_number: string | null; status: string | null }>)
      .filter((d) => (d.status ?? '').toUpperCase() !== 'CANCELLED');
    if (live.length === 0) return null;
    const doNos = [...new Set(live.map((d) => d.do_number).filter(Boolean))].join(', ');
    return {
      error: 'po_has_dropship_out',
      message:
        `A drop-ship Delivery Order (${doNos || 'unknown'}) has already shipped against this PO's expected batch. ` +
        `Cancelling the PO would strand that shipment with no incoming batch to net it out — ` +
        `cancel that Delivery Order first (or receive the goods, then handle the return).`,
    };
  } catch {
    return null;
  }
}

/* ON_HOLD added 2026-08-21 (owner: "PO 加 hold"). It is the REVERSIBLE answer
   the purchase side never had — CANCELLED is final and reaches AutoCount, where
   it cannot be un-cancelled. A held PO is not receivable, because
   RECEIVABLE_PO_STATUSES in grns.ts is an ALLOW-list. Exported because the
   list's exports (routes/purchase-order-exports.ts) filter through it too. */
export const VALID_STATUSES = new Set(['DRAFT', 'SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED', 'ON_HOLD']);
/* The header column list and the list's filter + sort live in
   lib/po-list-read.ts since 2026-09-15, so the two exports
   (routes/purchase-order-exports.ts) match exactly what this list matches.

   Filter-pill bucket → the raw purchase_orders.status values it covers: see
   lib/po-status-buckets.ts. `outstanding` (owner 2026-07-31) is the one ROLL-UP
   bucket and deliberately OVERLAPS open + partial, so the pill counts do not add
   up to `all`. */


const HEADER_COLS = PO_HEADER_COLS;

const ITEM_COLS =
  'line_no, id, purchase_order_id, binding_id, material_kind, item_code, material_name, ' +
  'supplier_sku, qty, unit_price_sen, line_total_sen, received_qty, notes, created_at, ' +
  'item_group, description, description2, uom, discount_sen, unit_cost_sen, ' +
  'gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, ' +
  'custom_specials, line_suffix, special_order_price_sen, variants, ' +
  'delivery_date, line_delivery_date_overridden, warehouse_id, ' +
  'supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4, ' +
  /* Migration 0098 — source SO line link. The detail route resolves it to a
     per-line so_doc_no for the PO PDF's "For SO" provenance column
     (relabelled from "Transferred SO", owner 2026-08-07). */
  'so_item_id, ' +
  'photo_urls';

mfgPurchaseOrders.get('/', async (c) => {
  const status = c.req.query('status');
  const supplierId = c.req.query('supplierId');
  const supabase = c.get('supabase');

  const pageRaw = c.req.query('page');
  const paginate = pageRaw !== undefined && pageRaw !== '';

  let data: unknown = null;
  let error: { message: string } | null = null;
  let total = 0;
  let page = 0;
  let pageSize = 50;
  let statusCounts: { all: number; draft: number; outstanding: number; open: number; partial: number; received: number; cancelled: number } | undefined;
  let countError: string | null = null;

  if (!paginate) {
    let q = supabase
      .from('purchase_orders')
      .select(PO_LIST_SELECT)
      .order('po_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500);
    if (status && VALID_STATUSES.has(status)) q = q.eq('status', status);
    if (supplierId) q = q.eq('supplier_id', supplierId);
    q = scopeToCompany(q, c);
    const res = await q;
    data = res.data;
    error = res.error;
  } else {
    page = Math.max(0, Math.trunc(Number(pageRaw)) || 0);
    const psRaw = Number(c.req.query('pageSize'));
    pageSize = Number.isFinite(psRaw) && psRaw > 0 ? Math.min(100, Math.max(1, Math.trunc(psRaw))) : 50;

    const filters = await withPoSearchIds(supabase, c, readPoListFilters((k) => c.req.query(k)));
    const q = filterPoList(
      orderPoList(supabase.from('purchase_orders').select(poListSelect(filters), { count: 'exact' }), filters.sort),
      filters,
      c,
      VALID_STATUSES,
    ).range(page * pageSize, page * pageSize + pageSize - 1);

    const countBase = () => {
      let cq = supabase.from('purchase_orders').select('*', { count: 'exact', head: true });
      if (supplierId) cq = cq.eq('supplier_id', supplierId);
      cq = scopeToCompany(cq, c);
      return cq;
    };
    const countsProm = eager(Promise.all([
      countBase(),
      countBase().in('status', PO_STATUS_BUCKETS.draft),
      countBase().in('status', PO_STATUS_BUCKETS.outstanding),
      countBase().in('status', PO_STATUS_BUCKETS.open),
      countBase().in('status', PO_STATUS_BUCKETS.partial),
      countBase().in('status', PO_STATUS_BUCKETS.received),
      countBase().in('status', PO_STATUS_BUCKETS.cancelled),
      countBase().or(HELD_OR_TERM),
    ]));
    const res = await q;
    data = res.data;
    error = res.error;
    total = res.count ?? (res.data?.length ?? 0);
    const [allC, draftC, outstandingC, openC, partialC, receivedC, cancelledC, onHoldC] = (await countsProm)();
    const counted = readStatusCounts({ all: allC, draft: draftC, outstanding: outstandingC, open: openC, partial: partialC, received: receivedC, cancelled: cancelledC, on_hold: onHoldC });
    if (counted.ok) statusCounts = counted.counts; else countError = counted.reason;
  }
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (countError) return c.json({ error: 'status_counts_failed', reason: countError }, 500);

  /* has_children (the downstream lock) + transfer_to_grns (the "GRN No" column)
     — one GRN read, shared with the export (lib/po-list-read.ts).
     Assigned SO / Delivered columns (owner 2026-07-31) are MRP-DERIVED and
     OMITTED here — not blanked (C16). The client heals them a beat after render
     via GET /mfg-purchase-orders/list-mrp-enrichment
     (routes/mfg-purchase-orders-list-enrichment.ts + lib/listMrpEnrichment.ts). */
  const stamped = await stampPoListGrns(supabase, (data ?? []) as Array<{ id: string } & Record<string, unknown>>, true);
  if (stamped.error) return c.json({ error: 'grn_read_failed', reason: stamped.error }, 500);
  if (paginate) {
    const withLines = await attachPoLines(supabase, c, stamped.rows, { outstandingOnly: status === 'outstanding' });
    if (withLines.error) return c.json({ error: 'lines_read_failed', reason: withLines.error }, 500);
    return c.json({ purchaseOrders: withLines.rows, total, page, pageSize, statusCounts });
  }
  const purchaseOrders = stamped.rows;
  return c.json({ purchaseOrders });
});

mfgPurchaseOrders.get('/outstanding-so-items', async (c) => {
  const supabase = c.get('supabase');
  /* PAGED — lib/outstanding-so-lines.ts. This read carried a `.limit(500)` with
     all three of the filters that decide the answer running after it in JS, so
     the picker offered at most 500 of the company's 15,050 live SO lines
     (measured 2026-09-08, docs/bugs/0677) chosen by document number. */
  const mrpProm = eager(loadLeadBuffers(c.env.DB).then((leadBuffers) => computeMrp(supabase, { catFilter: null, whFilter: null, includeUndated: true, companyId: activeCompanyId(c), leadBuffers })));
  const { data: items, error } = await loadOutstandingSoLines(supabase, (q) => scopeToCompany(q, c));
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  type Row = {
    id: string; doc_no: string; item_code: string; description: string | null;
    item_group: string; qty: number; po_qty_picked: number; unit_price_sen: number;
    variants: unknown; line_suffix: string | null; cancelled: boolean;
    line_delivery_date: string | null;
    so: {
      doc_no: string; debtor_name: string | null; branding: string | null; status: string;
      on_hold: boolean | null;
      so_date: string; customer_delivery_date: string | null;
      processing_date: string | null; sales_location: string | null;
      ref: string | null; customer_so_no: string | null;
    };
  };

  const skuCodes = [...new Set(((items ?? []) as unknown as Row[]).map((r) => r.item_code).filter(Boolean))] as string[];
  const mainSupplierByCode = new Map<string, { code: string; name: string }>();
  if (skuCodes.length > 0) {
    type PickerBind = { item_code: string; supplier: { code: string; name: string } | Array<{ code: string; name: string }> | null };
    const { data: binds, error: bindsErr } = await readMfgProductBindings<PickerBind>(supabase, {
      codes: skuCodes, companyId: activeCompanyId(c),
      select: 'item_code, is_main_supplier, supplier:suppliers(code, name)',
    });
    if (bindsErr) return c.json(readFailure('po_picker_suppliers', bindsErr), 500); for (const b of binds) {
      if (mainSupplierByCode.has(b.item_code)) continue;
      const s = Array.isArray(b.supplier) ? b.supplier[0] : b.supplier;
      if (s) mainSupplierByCode.set(b.item_code, { code: s.code, name: s.name });
    }
  }

  const shortageBySoItem = new Map<string, number>();
  let pooledOk = true;
  try {
    const mrpRes = (await mrpProm)();
    for (const sku of mrpRes.skus) {
      for (const l of sku.lines) shortageBySoItem.set(l.soItemId, l.shortageQty);
    }
    for (const s of mrpRes.sofaSets) shortageBySoItem.set(s.soItemId, s.shortageQty);
  } catch (e) {
    pooledOk = false;
    // eslint-disable-next-line no-console
    console.error('[outstanding-so-items] pooled shortage compute failed; falling back to picked cap', e);
  }

  const outstanding = ((items ?? []) as unknown as Row[])
    .filter((r) => !isDocumentHeld(r.so)
      && r.so.status !== 'CANCELLED' && r.so.status !== 'DRAFT' && r.so.status !== 'ON_HOLD')
    .filter((r) => (pooledOk ? (shortageBySoItem.get(r.id) ?? 0) > 0 : r.qty - r.po_qty_picked > 0))
    .map((r) => {
      const remaining = pooledOk ? (shortageBySoItem.get(r.id) ?? 0) : (r.qty - r.po_qty_picked);
      return {
        soItemId:        r.id,
        soDocNo:         r.doc_no,
        debtorName:      r.so.debtor_name,
        branding:        r.so.branding,
        soStatus:        r.so.status,
        soDate:          r.so.so_date,
        deliveryDate:    r.so.customer_delivery_date,
        itemCode:        r.item_code,
        description:     r.description,
        itemGroup:       r.item_group,
        qty:             r.qty,
        poQtyPicked:     r.po_qty_picked,
        remainingQty:    remaining,
        unitPriceSen:  r.unit_price_sen,
        variants:        r.variants,
        lineSuffix:      r.line_suffix,
        processingDate:   r.so.processing_date,
        salesLocation:    r.so.sales_location,
        lineDeliveryDate: r.line_delivery_date,
        mainSupplierCode: mainSupplierByCode.get(r.item_code)?.code ?? null,
        mainSupplierName: mainSupplierByCode.get(r.item_code)?.name ?? null,
        soRef:            r.so.ref ?? null,
        soCustomerSoNo:   r.so.customer_so_no ?? null,
      };
    });

  return c.json({ items: outstanding });
});

mfgPurchaseOrders.get('/so-line-candidates', async (c) => {
  const code = (c.req.query('code') ?? '').trim();
  if (!code) return c.json({ error: 'code_required' }, 400);
  const supabase = c.get('supabase');

  /* SPEC FILTER (owner 2026-08-08). The picker used to offer every same-CODE SO
     line; a consolidated PO line may only be attributed to the SAME PRODUCT —
     same code AND same variant summary (fabric + colour + SEAT/LEG/SPECIAL, no
     dye-lot). When poId+itemId are given we load that PO line's spec and keep
     only matching candidates. Omitted (older callers) -> code-only, unchanged. */
  const poId = (c.req.query('poId') ?? '').trim();
  const poItemId = (c.req.query('itemId') ?? '').trim();
  let poSpec: { itemGroup: string | null; variants: Record<string, unknown> | null } | null = null;
  if (poId && poItemId) {
    const { data: poLine, error: poLineErr } = await scopeToCompany(
      supabase.from('purchase_order_items').select('id, item_group, variants').eq('id', poItemId), c,
    ).maybeSingle();
    if (poLineErr) return c.json({ error: 'load_failed', reason: poLineErr.message }, 500);
    const pl = poLine as { item_group: string | null; variants: Record<string, unknown> | null } | null;
    if (pl) poSpec = { itemGroup: pl.item_group ?? null, variants: pl.variants ?? null };
  }

  const { data, error } = await scopeToCompany(
    supabase
      .from('mfg_sales_order_items')
      .select(`
        id, doc_no, item_code, item_group, variants, qty, po_qty_picked, cancelled,
        so:mfg_sales_orders!inner ( doc_no, debtor_name, status, customer_delivery_date, amended_delivery_date )
      `),
    c,
  )
    .eq('item_code', code)
    .eq('cancelled', false)
    .order('doc_no', { ascending: false })
    .limit(300);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  type CandRow = {
    id: string; doc_no: string; item_code: string; item_group: string | null; variants: Record<string, unknown> | null; qty: number; po_qty_picked: number;
    so: { doc_no: string; debtor_name: string | null; status: string | null; customer_delivery_date: string | null; amended_delivery_date: string | null };
  };
  const items = ((data ?? []) as unknown as CandRow[])
    .filter((r) => {
      const st = (r.so?.status ?? '').toUpperCase();
      return st !== 'CANCELLED' && st !== 'DRAFT';
    })
    .filter((r) => !poSpec || specMatches(poSpec, { itemGroup: r.item_group ?? null, variants: r.variants ?? null }))
    .map((r) => ({
      soItemId: r.id,
      soDocNo: r.doc_no,
      debtorName: r.so?.debtor_name ?? null,
      soStatus: r.so?.status ?? null,
      qty: r.qty,
      deliveryDate: r.so ? effectiveSoDelivery(r.so) : null,
    }));
  return c.json({ items });
});

async function loadAllocationsForItems(
  sb: any,
  poItemIds: string[],
): Promise<Map<string, Array<AllocationRow & { so_doc_no: string | null }>>> {
  const out = new Map<string, Array<AllocationRow & { so_doc_no: string | null }>>();
  if (poItemIds.length === 0) return out;
  try {
    const { data, error } = await sb
      .from('purchase_order_item_allocations')
      .select('id, purchase_order_item_id, seq, qty, so_item_id')
      .in('purchase_order_item_id', poItemIds)
      .order('seq', { ascending: true });
    if (error) return out;
    const rows = (data ?? []) as Array<AllocationRow & { purchase_order_item_id: string }>;
    const soItemIds = [...new Set(rows.map((r) => r.so_item_id).filter((x): x is string => !!x))];
    const soDocById = new Map<string, string>();
    for (let i = 0; i < soItemIds.length; i += 300) {
      const chunk = soItemIds.slice(i, i + 300);
      if (chunk.length === 0) continue;
      const { data: soLines } = await sb
        .from('mfg_sales_order_items').select('id, doc_no').in('id', chunk);
      for (const r of (soLines ?? []) as Array<{ id: string; doc_no: string | null }>) {
        if (r.doc_no) soDocById.set(r.id, r.doc_no);
      }
    }
    for (const r of rows) {
      const arr = out.get(r.purchase_order_item_id) ?? [];
      arr.push({
        id: r.id, seq: r.seq, qty: r.qty, so_item_id: r.so_item_id,
        so_doc_no: r.so_item_id ? soDocById.get(r.so_item_id) ?? null : null,
      });
      out.set(r.purchase_order_item_id, arr);
    }
  } catch { }
  return out;
}

export type PoLineReceipt = { grnNumber: string; qty: number; status: string };
async function poLineReceipts(
  sb: any,
  poItemIds: string[],
): Promise<Map<string, PoLineReceipt[]>> {
  const out = new Map<string, PoLineReceipt[]>();
  if (poItemIds.length === 0) return out;
  const { data: grnLines, error: grnLinesErr } = await sb
    .from('grn_items')
    .select('purchase_order_item_id, qty_accepted, returned_qty, returned_closed_qty, grn_id')
    .in('purchase_order_item_id', poItemIds); if (grnLinesErr) throw readFailureError('po_line_receipts', grnLinesErr);
  const rows = (grnLines ?? []) as Array<{ purchase_order_item_id: string | null; qty_accepted: number; returned_qty: number; returned_closed_qty: number; grn_id: string }>;
  const grnIds = [...new Set(rows.map((r) => r.grn_id).filter(Boolean))];
  if (grnIds.length === 0) return out;
  const { data: grns, error: grnsErr } = await sb.from('grns').select('id, grn_number, status').in('id', grnIds);
  if (grnsErr) throw readFailureError('po_line_receipts', grnsErr); const grnMeta = new Map<string, { grnNumber: string; status: string }>();
  for (const g of (grns ?? []) as Array<{ id: string; grn_number: string | null; status: string | null }>) {
    if ((g.status ?? '').toUpperCase() === 'CANCELLED') continue;
    grnMeta.set(g.id, { grnNumber: g.grn_number ?? '—', status: (g.status ?? '').toUpperCase() });
  }
  for (const r of rows) {
    if (!r.purchase_order_item_id) continue;
    const meta = grnMeta.get(r.grn_id);
    if (!meta) continue;
    const net = grnLineNetReceived(r);
    if (net <= 0) continue;
    const arr = out.get(r.purchase_order_item_id) ?? [];
    arr.push({ grnNumber: meta.grnNumber, qty: net, status: meta.status });
    out.set(r.purchase_order_item_id, arr);
  }
  return out;
}

const PO_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A PO route parameter as the PO's id: a uuid as it is, otherwise looked up as the PO number in this company. */
export async function resolvePoId(
  raw: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a supabase-js builder, untyped like the other scm readers
  scope: (q: any) => any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST client
  supabase: any,
): Promise<{ ok: true; id: string } | { ok: false; status: 404 | 500; body: Record<string, unknown> }> {
  const value = raw.trim();
  if (PO_UUID_RE.test(value)) return { ok: true, id: value };
  const notFound = { ok: false as const, status: 404 as const, body: { error: 'not_found', message: `Purchase order ${value || '(blank)'} was not found.` } };
  if (!value || value.length > 64) return notFound;
  const { data, error } = await scope(supabase.from('purchase_orders').select('id').eq('po_number', value)).limit(1).maybeSingle();
  if (error) return { ok: false, status: 500, body: { error: 'load_failed', reason: String((error as { message?: unknown }).message ?? error) } };
  const id = (data as { id?: string } | null)?.id;
  return id ? { ok: true, id } : notFound;
}

mfgPurchaseOrders.get('/:id', async (c) => {
  const supabase = c.get('supabase');
  const resolved = await resolvePoId(c.req.param('id'), (q) => scopeToCompany(q, c), supabase);
  if (!resolved.ok) return c.json(resolved.body, resolved.status);
  const id = resolved.id;

  const [headerRes, itemsRes, childLock] = await Promise.all([
    scopeToCompany(supabase
      .from('purchase_orders')
      .select(`${HEADER_COLS}, supplier:suppliers(id, code, name, contact_person, phone, email, email2, email3, address)`)
      .eq('id', id), c)
      .maybeSingle(),
    inPoLineOrder(supabase.from('purchase_order_items').select(ITEM_COLS).eq('purchase_order_id', id)),
    poHasDownstream(supabase, id),
  ]);

  if (headerRes.error) return c.json({ error: 'load_failed', reason: headerRes.error.message }, 500);
  if (!headerRes.data) return c.json({ error: 'not_found' }, 404);
  if (itemsRes.error) return c.json(readFailure('po_lines', itemsRes.error), 500);
  const purchaseOrder = {
    ...(headerRes.data as Record<string, unknown>),
    has_children: childLock !== null,
    has_open_amendment: false,
    open_amendment: null as { id: string; status: string; amendment_no: string } | null,
  };

  type PoItemRow = Record<string, unknown> & { id: string; item_code: string };
  const itemRows = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      sortLinesByStoredLineNo(
        (itemsRes.data as unknown as Array<Record<string, unknown> & { id: string; item_code: string }>)
          .map((it): PoItemRow => ({ ...it, item_code: it.item_code })),
      ),
      (r) => r.item_group as string | null | undefined,
    ),
  );
  /* 2026-06-12 — "For SO" provenance column on the PO PDF (DSL/AutoCount
     layout; relabelled from "Transferred SO", owner 2026-08-07):
     resolve each line's so_item_id (migration 0098) to the source SO doc_no.
     Best-effort: a lookup failure leaves so_doc_no null, never blocks the
     detail response. */
  const soDocByItem = new Map<string, string>();
  type SoSnap = { item_code: string; item_group: string | null; description: string | null; variants: Record<string, unknown> | null; warehouse_id: string | null };
  const soLineById = new Map<string, SoSnap>();
  const soHeaderByDoc = new Map<string, SoWarehouseSource>();
  let whMasters: SoWarehouseMasters = { warehouses: [], stateMappings: [] };
  const soItemIds = [...new Set(
    itemRows.map((it) => it.so_item_id as string | null | undefined).filter(Boolean),
  )] as string[];
  const [receiptsMap, allocationsMap] = await Promise.all([
    poLineReceipts(supabase, itemRows.map((it) => it.id)),
    loadAllocationsForItems(supabase, itemRows.map((it) => it.id)),
    (async () => {
      try {
        if (soItemIds.length > 0) {
          const { data: soLines } = await supabase
            .from('mfg_sales_order_items')
            .select('id, doc_no, item_code, item_group, description, variants, warehouse_id')
            .in('id', soItemIds);
          for (const r of (soLines ?? []) as Array<{ id: string; doc_no: string } & SoSnap>) {
            soDocByItem.set(r.id, r.doc_no);
            soLineById.set(r.id, { item_code: r.item_code, item_group: r.item_group, description: r.description, variants: r.variants, warehouse_id: r.warehouse_id });
          }
          const driftDocNos = [...new Set([...soDocByItem.values()].filter(Boolean))];
          if (driftDocNos.length > 0) {
            const [hdrRes, masters] = await Promise.all([
              supabase.from('mfg_sales_orders').select('doc_no, sales_location, customer_state').in('doc_no', driftDocNos),
              loadSoWarehouseMasters(supabase, (q) => scopeToCompany(q, c)),
            ]);
            for (const h of ((hdrRes.data ?? []) as Array<{ doc_no: string } & SoWarehouseSource>)) soHeaderByDoc.set(h.doc_no, { sales_location: h.sales_location, customer_state: h.customer_state });
            whMasters = masters;
          }
        }
      } catch { }
    })(),
  ]);

  try {
    const soDocNos = [...new Set([...soDocByItem.values()].filter(Boolean))];
    if (soDocNos.length > 0) {
      const { data: amRows, error: amErr } = await scopeToCompany(supabase
        .from('so_amendments')
        .select('id, status, amendment_no')
        .in('so_doc_no', soDocNos), c)
        .not('status', 'in', '("SENT","REJECTED")')
        .order('created_at', { ascending: false })
        .limit(1);
      if (amErr) return c.json(readFailure('so_amendments', amErr), 500); const am = (amRows as Array<Record<string, unknown>>)[0];
      if (am) {
        purchaseOrder.open_amendment = {
          id: String((am.id ?? (am as Record<string, unknown>).id) ?? ''),
          status: String(am.status ?? ''),
          amendment_no: String((am.amendment_no ?? (am as Record<string, unknown>).amendmentNo) ?? ''),
        };
        purchaseOrder.has_open_amendment = true;
      }
    }
  } catch { }

  const items = itemRows.map((it) => {
    const soId = it.so_item_id as string | null;
    const so = soId ? soLineById.get(soId) ?? null : null;
    const soHdr = soId ? soHeaderByDoc.get(soDocByItem.get(soId) ?? '') ?? null : null;
    const so_drift = so ? computeSoDrift(it as DriftLine, so as DriftLine, soHdr, whMasters) : null;
    return {
      ...it,
      receipts: receiptsMap.get(it.id) ?? [],
      allocations: allocationsMap.get(it.id) ?? [],
      so_doc_no: soId ? soDocByItem.get(soId) ?? null : null,
      so_drift,
    };
  });

  // Stamp each line's supplier fabric code so the on-screen line reads
  // "BF-01 (PC151-01)" (owner 2026-07-24). Runs AFTER so_drift is computed from
  // the raw variants above, so the drift compare stays apples-to-apples. ONE
  // batched query; fail-soft.
  await enrichLinesWithFabricSupplierCode(supabase, c, items);
  return c.json({ purchaseOrder, items });
});

mfgPurchaseOrders.get('/:id/linked', async (c) => {
  const id = c.req.param('id');
  const sb = c.get('supabase');

  const owner = await scopeToCompany(sb.from('purchase_orders').select('id').eq('id', id), c).maybeSingle();
  if (owner.error) return c.json({ error: 'load_failed', reason: owner.error.message }, 500);
  if (!owner.data) return c.json({ error: 'not_found' }, 404);

  const [grnRes, piRes, prRes] = await Promise.all([
    readPoLinkedGrns(sb, id),
    sb.from('purchase_invoices')
      .select('id, invoice_number, status, invoice_date')
      .eq('purchase_order_id', id)
      .order('invoice_date', { ascending: false }),
    sb.from('purchase_returns')
      .select('id, return_number, status, return_date')
      .eq('purchase_order_id', id)
      .order('return_date', { ascending: false }),
  ]);

  if (!grnRes.ok) return c.json({ error: 'load_failed', reason: grnRes.reason }, 500);
  if (piRes.error)  return c.json({ error: 'load_failed', reason: piRes.error.message  }, 500);
  if (prRes.error)  return c.json({ error: 'load_failed', reason: prRes.error.message  }, 500);

  return c.json({
    grns:     grnRes.grns,
    invoices: piRes.data  ?? [],
    returns:  prRes.data  ?? [],
  });
});

mfgPurchaseOrders.get('/:id/revisions', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const { data, error } = await scopeToCompany(sb.from('po_revisions')
    .select('id, revision, snapshot, created_at, created_by')
    .eq('po_id', id), c)
    .order('revision', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ revisions: data ?? [] });
});

export const createMfgPurchaseOrderHandler = async (c: any) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const supplierId = body.supplierId as string | undefined;
  if (!supplierId) return c.json({ error: 'supplier_id_required' }, 400);

  // Owner 2026-08-20 ("越松越好"): Expected Delivery must NOT block opening a PO —
  // a blank defaults to today (like po_date) instead of a 400; it still fans out
  // to per-line delivery_date / GRN. Purchase Location stays required (it fans to
  // per-line warehouse = stock location, an integrity field).
  const expectedAt = dateOrNull(body.expectedAt) ?? todayMyt();
  const purchaseLocationId = body.purchaseLocationId as string | undefined;
  if (!purchaseLocationId) return c.json({ error: 'purchase_location_id_required' }, 400);

  const headerD2 = dateOrNull(body.supplierDeliveryDate2);
  const headerD3 = dateOrNull(body.supplierDeliveryDate3);
  const headerD4 = dateOrNull(body.supplierDeliveryDate4);

  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];

  /* Convert-from-SO over-convert override (owner 2026-07-24). When the desktop
     New-PO-form create carries SO-sourced lines whose qty exceeds what the SO
     still needs, the remaining-qty cap below rejects with 409
     qty_exceeds_remaining — UNLESS the operator has confirmed the over-convert,
     in which case the client replays with this flag set. Mirrors the
     confirmShortStock soft-warn -> confirm -> proceed shape. */
  const confirmOverConvert = body.confirmOverConvert === true;

  const currency = ((body.currency as string) ?? 'MYR').toUpperCase();
  if (!VALID_CURRENCIES.has(currency)) return c.json({ error: 'invalid_currency' }, 400);

  const supabase = c.get('supabase');
  const user = c.get('user');

  const groupOf = await skuCategoryResolver(supabase, items, activeCompanyId(c) ?? null);
  { const inactive = await poInactivePickRefusal(supabase, activeCompanyId(c) ?? null, items); if (inactive) return c.json(inactive, 409); }
  {
    const lineSoItemIds = items
      .map((it) => it.soItemId as string | undefined)
      .filter((x): x is string => !!x);
    if (lineSoItemIds.length > 0) {
      const { data: lineSoRows } = await scopeToCompany(supabase.from('mfg_sales_order_items').select('id, doc_no, item_code, item_group, qty, po_qty_picked'), c).in('id', lineSoItemIds);
      const boundOrdered = await loadBoundOrderedQty(supabase, activeCompanyId(c) ?? null, (lineSoRows ?? []) as Array<SoSourceLine & { item_group: string | null }>);
      const soRows = ((lineSoRows ?? []) as Array<SoSourceLine & { item_group: string | null }>).map((r) => ({ ...r, po_qty_picked: boundAwarePicked(r, boundOrdered) }));
      const foreignSoItemId = lineSoItemIds.find((id) => !new Set(soRows.map((r) => r.id)).has(id));
      if (foreignSoItemId) return c.json({ error: 'so_line_not_found', reason: 'That Sales Order line does not exist on this company.', soItemId: foreignSoItemId }, 404);
      // ... and the IDENTITY half of soLinkTargetRefusal, which this path was missing (lib/so-link-item-identity.ts, docs/bugs/0672).
      const badSoLink = soLinkItemMismatch(items, soRows);
      if (badSoLink) return c.json(badSoLink, 409);
      const badCategory = firstSoLinkCategoryMismatch(items, soRows, groupOf);
      if (badCategory) return c.json(badCategory, 409);
      const offender = await firstUnorderableSo(
        supabase,
        soRows.map((r) => r.doc_no),
      );
      if (offender) return c.json(soNotOrderableResponse(offender), 409);

      const dupGate = await soHasPoGate(supabase, activeCompanyId(c) ?? null, soRows, body.confirmDuplicatePo);
      if (dupGate.refusal) { markIdempotencyNoWrite(c); return c.json(await withMrpAssignments(supabase, c, dupGate.refusal), 409); }
      if (!confirmOverConvert) {
        const offender = findOverConvertOffender(items.filter((it) => !dupGate.confirmed.has(it.soItemId as string)), soRows);
        if (offender) {
          markIdempotencyNoWrite(c);
          return c.json({ error: 'qty_exceeds_remaining', ...offender }, 409);
        }
      }
    }
  }

  const yymm = yymmFor();

  const p = companyDocPrefix(c);
  let poNumber = await mintMonthlyDocNo(supabase, 'purchase_orders', 'po_number', `${p}PO-${yymm}`);

  let subtotal = 0;
  const pickedQtyBySoItem = new Map<string, number>();
  for (const [i, it] of items.entries()) {
    const parsed = parseLineNumbers({
      qty: { value: it.qty },
      unitPriceSen: { value: it.unitPriceSen },
      discountSen: { value: it.discountSen },
    });
    if (!parsed.ok) {
      const b = invalidLineNumberBody(parsed.invalid);
      return c.json({ ...b, reason: `Line ${i + 1}: ${b.reason}` }, 400);
    }
  }
  const itemRows = items.map((it) => {
    const kind = it.materialKind as string;
    if (!VALID_KINDS.has(kind)) throw new Error(`invalid material_kind: ${kind}`);
    if (!it.itemCode || !it.materialName) throw new Error('item_code + material_name required per item');
    const qty = Math.max(0, Number(it.qty ?? 0));
    const soItemId = (it.soItemId as string | undefined) ?? null;
    if (soItemId && qty > 0) {
      pickedQtyBySoItem.set(soItemId, (pickedQtyBySoItem.get(soItemId) ?? 0) + qty);
    }
    const unit = Math.max(0, Number(it.unitPriceSen ?? 0));
    const discountSen = Math.max(0, Number(it.discountSen ?? 0));
    const lineTotal = Math.max(0, qty * unit - discountSen);
    subtotal += lineTotal;
    return {
      binding_id: (it.bindingId as string | undefined) ?? null,
      material_kind: kind,
      item_code: it.itemCode,
      material_name: it.materialName,
      supplier_sku: (it.supplierSku as string | undefined) ?? null,
      qty,
      unit_price_sen: unit,
      line_total_sen: lineTotal,
      notes: (it.notes as string | undefined) ?? null,
      discount_sen: discountSen,
      delivery_date: dateOrNull(it.deliveryDate),
      supplier_delivery_date_2: dateOrNull(it.supplierDeliveryDate2) ?? headerD2,
      supplier_delivery_date_3: dateOrNull(it.supplierDeliveryDate3) ?? headerD3,
      supplier_delivery_date_4: dateOrNull(it.supplierDeliveryDate4) ?? headerD4,
      warehouse_id:  (it.warehouseId  as string | undefined) ?? null,
      variants:     (it.variants as unknown) ?? null,
      description:  (it.description as string | undefined) ?? null,
      ...lineIdentityFields(groupOf, it, buildVariantSummary),
      so_item_id:   soItemId,
    };
  });

  const asDraft = body.asDraft === true;
  const headerInsert: Record<string, unknown> = {
    company_id: activeCompanyId(c),
    po_number: poNumber,
    supplier_id: supplierId,
    status: asDraft ? 'DRAFT' : 'SUBMITTED',
    submitted_at: asDraft ? null : new Date().toISOString(),
    currency,
    expected_at: expectedAt,
    supplier_delivery_date_2: headerD2,
    supplier_delivery_date_3: headerD3,
    supplier_delivery_date_4: headerD4,
    notes: (body.notes as string | undefined) ?? null,
    subtotal_sen: subtotal,
    tax_sen: 0,
    total_sen: subtotal,
    created_by: user.id,
    purchase_location_id: purchaseLocationId,
    // Service-case exchange link; key OMITTED for an ordinary PO so create works even before PostgREST reloads the new column (owner 2026-11-13).
    ...(Number.isInteger(Number(body.assrCaseId)) && Number(body.assrCaseId) > 0 ? { assr_case_id: Number(body.assrCaseId) } : {}),
  };
  headerInsert.po_date = body.poDate || todayMyt();

  let firstMint = true;
  const { data: headerData, error: hErr } = await insertWithDocNoRetry(
    async () => {
      if (firstMint) { firstMint = false; return poNumber; }
      poNumber = await mintMonthlyDocNo(supabase, 'purchase_orders', 'po_number', `${p}PO-${yymm}`);
      return poNumber;
    },
    (dn) => {
      headerInsert.po_number = dn;
      return supabase.from('purchase_orders').insert(headerInsert).select(HEADER_COLS).single();
    },
  );

  if (hErr) {
    if (hErr.code === '42501') return c.json({ error: 'forbidden', reason: hErr.message }, 403);
    return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  }

  const header = headerData as unknown as { id: string; po_number: string };

  if (itemRows.length > 0) {
    /* Owner 2026-08-10 (migration 0274) — a line raised from the From-SO picker
       carries its source SO line's photos, exactly as /from-sos and
       /:id/convert-from-so do. Derived SERVER-side from so_item_id rather than
       taken from the request: the client never holds these keys, and trusting a
       caller-supplied key array would let any PO line reference any R2 object.
       One extra select, only when a line is SO-sourced; manual lines stay '{}'. */
    const photoSoItemIds = [...new Set(
      itemRows.map((r) => r.so_item_id).filter((x): x is string => Boolean(x)),
    )];
    const photosBySoItem = new Map<string, string[]>();
    if (photoSoItemIds.length > 0) {
      const { data: photoRows } = await scopeToCompany(supabase.from('mfg_sales_order_items').select('id, photo_urls'), c).in('id', photoSoItemIds);
      for (const r of (photoRows ?? []) as Array<{ id: string; photo_urls: string[] | null }>) {
        photosBySoItem.set(r.id, r.photo_urls ?? []);
      }
    }
    const itemsToInsert = stampPoLineNos(itemRows.map((r) => ({
      ...r,
      purchase_order_id: header.id,
      photo_urls: (r.so_item_id ? photosBySoItem.get(r.so_item_id) : null) ?? [],
    })), 1);
    const { error: iErr } = await supabase.from('purchase_order_items').insert(stampCompany(itemsToInsert, c));
    if (iErr) {
      await supabase.from('purchase_orders').delete().eq('id', header.id);
      return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500);
    }
  }

  await recordPoCreate(supabase, c.get('houzsUser'), activeCompanyId(c), header.id, itemRows.length);

  if (!asDraft && pickedQtyBySoItem.size > 0) {
    try { await recomputeSoPicked(supabase, [...pickedQtyBySoItem.keys()]); }
    catch { }
  }

  const acNotSent = asDraft ? [] : (await enqueuePoCreate(supabase, {
    companyId: activeCompanyId(c),
    poId: header.id,
    createdBy: c.get('houzsUser')?.id ?? null,
  })).problems;

  return c.json({ id: header.id, poNumber: header.po_number, ...(acNotSent.length ? { acNotSent } : {}) }, 201);
};
mfgPurchaseOrders.post('/', createMfgPurchaseOrderHandler);

export type PoConvertOutcome = { status: number; body: Record<string, unknown> };
export type PoConvertContext = {
  req: { json(): Promise<unknown> };
  get(key: 'supabase'): Variables['supabase'];
  get(key: 'user'): { id: string };
  get(key: 'houzsUser'): Variables['houzsUser'];
  get(key: 'companyId'): number | undefined;
  get(key: 'allowedCompanyIds'): number[] | undefined;
  get(key: 'companyCode'): string | undefined;
  env: Env;
  json(body: unknown, status?: number): PoConvertOutcome;
};

export async function convertSosToPosCore(c: PoConvertContext): Promise<PoConvertOutcome> {
  const supabase = c.get('supabase');
  const user = c.get('user');
  let body: {
    picks?:    Array<{ soItemId: string; qty: number; supplierId?: string | null }>;
    soItems?:  Array<{ soDocNo: string; itemCode: string; itemName: string; qty: number }>;
    expectedAt?: string;
    purchaseLocationId?: string;
    /* Commander 2026-05-28 — PO generation mode:
         'combined' (default) = one PO per supplier (all picked SOs merged) —
                                 good for mattresses (dozens of SOs → 1 PO).
         'per-so'             = one PO per (supplier × SO) — good for sofa /
                                 bedframe where 1 SO → 1 PO.

       SUPERSEDED FOR THE THREE RULED CATEGORIES (owner 2026-07-17). The note
       above was always a description of WHICH MODE TO PICK for which category —
       so the operator had to know the rule and choose correctly, and a mixed
       pick could only ever get one behaviour. The rule is now applied
       automatically per category in scm/lib/po-grouping.ts:
         sofa, bedframe -> per-SO      (as the note says; sofa also for dye lot)
         mattress       -> merged, but bounded by a delivery-date WINDOW
       The window is the 07-17 refinement of the note's unbounded "dozens of SOs
       -> 1 PO": merging a mattress due next quarter into this week's PO lands
       stock three months early, which is the opposite of the turnover the merge
       exists to improve.

       `mode` still decides the categories he has NOT ruled on (accessory,
       service, anything else item_group carries). */
    mode?: 'combined' | 'per-so';
    supplierByCode?: Record<string, string>;
    targetPoId?: string;
    fromMrp?: boolean;
    planAsOf?: string | null;
    /* Land the created POs as DRAFT instead of SUBMITTED (owner 2026-07-17 —
       the Procurement Agent's Stage 1: propose, then approve).

       Opt-in and defaulting FALSE, so every existing caller is byte-for-byte
       unaffected. `POST /` has taken this since PR #131 and the SO flow uses it;
       the bulk convert never could, which is the whole reason an agent could not
       raise a PO for review — see the header insert below for why a DRAFT is the
       right fuse rather than a new parallel mechanism. */
    asDraft?: boolean;
    allowSofaSupplierSplit?: boolean;
    confirmDuplicatePo?: boolean;
  };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const poMode: 'combined' | 'per-so' = body.mode === 'per-so' ? 'per-so' : 'combined';
  const fromMrp = body.fromMrp === true;
  const asDraft = body.asDraft === true;
  const supplierByCode = (body.supplierByCode ?? {}) as Record<string, string>;
  const targetPoId = body.targetPoId as string | undefined;

  if (targetPoId && asDraft) {
    return c.json(
      { error: 'as_draft_not_supported_on_append', message: 'asDraft cannot be combined with targetPoId — appending to an existing PO cannot change its status.' },
      400,
    );
  }

  let targetPoSupplierId: string | null = null;
  if (targetPoId) {
    const { data: tpo } = await supabase
      .from('purchase_orders').select('supplier_id').eq('id', targetPoId).maybeSingle();
    targetPoSupplierId = (tpo as { supplier_id?: string | null } | null)?.supplier_id ?? null;
  }

  const expectedAtOverride = body.expectedAt;
  const purchaseLocationOverride = body.purchaseLocationId;

  const { data: whRows } = await scopeToCompany(
    supabase.from('warehouses').select('id, code, name'),
    c,
  );
  type Wh = { id: string; code: string | null; name: string | null };
  const warehouses = (whRows ?? []) as Wh[];

  const leadBase = await loadLeadTimeBase(
    scopeToCompany(supabase.from('mrp_category_lead_times').select(LEAD_TIME_SELECT), c),
  );
  /* The owner's MANUAL per-(supplier, category) overrides (owner 2026-09-11).
     When a row exists for a line's supplier + category it REPLACES the category
     base — highest priority — when this convert computes the PO delivery date.
     Empty until he sets one, so no change to any existing PO. Throws on a read
     error for the same reason as the base above. */
  const leadOverrides = await loadSupplierCategoryOverrides(
    scopeToCompany(supabase.from('mrp_supplier_category_lead_times').select(LEAD_OVERRIDE_SELECT), c),
  );
  /* The buffers the owner has APPROVED on top of his table — per-supplier
     punctuality and per-season, learned by the Procurement Agent from actual
     receipts (owner 2026-07-17: "要根据不同的供应商准时程度、不同的季节... 来制定
     提前的 Delivery Date"). Empty until he approves one, in which case this is
     exactly the base lead, i.e. today's behaviour. Applied per line below, once
     the effective supplier is known. */
  const leadBuffers = await loadLeadBuffers(c.env.DB);

  const resolveWarehouseId = (salesLocation: string | null | undefined): string | null => {
    const needle = (salesLocation ?? '').trim().toLowerCase();
    if (!needle) return null;
    const hit = warehouses.find(
      (w) => (w.name ?? '').trim().toLowerCase() === needle
          || (w.code ?? '').trim().toLowerCase() === needle,
    );
    return hit?.id ?? null;
  };

  type SoItem = {
    id: string; doc_no: string; item_code: string; description: string | null;
    line_no: number | null; qty: number; po_qty_picked: number; unit_price_sen: number;
    line_delivery_date: string | null;
    item_group: string | null;
    variants: Record<string, unknown> | null;
    warehouse_id: string | null;
    /* Owner 2026-08-10 (migration 0274) — the SO line's photos ride along to the
       PO line. R2 keys, not bytes: the PO points at the SAME objects. */
    photo_urls: string[] | null; remark: string | null;
    so: { sales_location: string | null; customer_delivery_date: string | null; note: string | null } | null;
  };
  const SO_ITEM_SELECT =
    'id, doc_no, line_no, item_code, description, item_group, variants, qty, po_qty_picked, unit_price_sen, line_delivery_date, warehouse_id, photo_urls, cancelled, remark, ' +
    'so:mfg_sales_orders!inner ( sales_location, customer_delivery_date, note )';
  const normSo = (r: { so: unknown }): SoItem['so'] => {
    const raw = (r as { so: unknown }).so;
    if (Array.isArray(raw)) return (raw[0] as SoItem['so']) ?? null;
    return (raw as SoItem['so']) ?? null;
  };
  const pickedItems: Array<{ row: SoItem; qty: number; pickSupplierId: string | null }> = [];

  if (body.picks && body.picks.length > 0) {
    const ids = body.picks.map((p) => p.soItemId);
    const { data: rows, error } = await scopeToCompany(supabase
      .from('mfg_sales_order_items')
      .select(SO_ITEM_SELECT)
      .in('id', ids), c);
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    const byId = new Map<string, SoItem>();
    for (const r of (rows ?? []) as unknown as SoItem[]) byId.set(r.id, { ...r, so: normSo(r) });
    const boundOrdered = await loadBoundOrderedQty(supabase, activeCompanyId(c) ?? null, [...byId.values()]);
    for (const p of body.picks) {
      const row = byId.get(p.soItemId);
      if (!row) return c.json({ error: 'item_not_found', soItemId: p.soItemId }, 400);
      if ((row as { cancelled?: boolean | null }).cancelled) {
        return c.json({
          error: 'so_line_cancelled',
          reason: `Sales Order line ${row.doc_no ?? ''} (${row.item_code ?? ''}) is cancelled — it has no demand to purchase against.`.trim(),
          soItemId: p.soItemId,
        }, 409);
      }
      const remaining = row.qty - boundAwarePicked(row, boundOrdered);
      if (p.qty <= 0)         return c.json({ error: 'qty_must_be_positive', soItemId: p.soItemId }, 400);
      // Commander 2026-05-31 — an MRP-origin convert skips the cap on a POOLED line (the
      // pooled picker decides). A company-1 BOUND line is capped on every path against
      // every live PO on it, MRP-origin included (owner 2026-09-14; lib/bound-line-ordered.ts).
      if ((!fromMrp || isBoundForCompany(activeCompanyId(c) ?? null, row)) && p.qty > remaining)
        return c.json({ error: 'qty_exceeds_remaining', soItemId: p.soItemId, requested: p.qty, remaining }, 409);
      pickedItems.push({ row, qty: p.qty, pickSupplierId: p.supplierId ?? null });
    }
    const stale = await mrpPlanStaleRefusal(supabase, activeCompanyId(c) ?? null, ids, fromMrp ? body.planAsOf : null);
    if (stale) return c.json(stale.body, stale.status);
  } else {
    const soItems = body.soItems ?? [];
    if (soItems.length === 0) return c.json({ error: 'so_items_required' }, 400);
    const codes  = [...new Set(soItems.map((it) => it.itemCode))];
    const docNos = [...new Set(soItems.map((it) => it.soDocNo))];
    const { data: rows } = await scopeToCompany(pgrestIn(supabase
      .from('mfg_sales_order_items')
      .select(SO_ITEM_SELECT)
      .in('doc_no', docNos), 'item_code', codes), c);
    const byKey = new Map<string, SoItem>();
    for (const r of (rows ?? []) as unknown as SoItem[]) byKey.set(`${r.doc_no}|${r.item_code}`, { ...r, so: normSo(r) });
    for (const it of soItems) {
      const row = byKey.get(`${it.soDocNo}|${it.itemCode}`);
      pickedItems.push({
        row: row ?? {
          id: '', doc_no: it.soDocNo, line_no: null, item_code: it.itemCode, description: it.itemName,
          qty: it.qty, po_qty_picked: 0, unit_price_sen: 0,
          line_delivery_date: null, item_group: null, variants: null, remark: null,
          warehouse_id: null, photo_urls: null, so: null,
        },
        qty: it.qty,
        pickSupplierId: null,
      });
    }
  }

  if (pickedItems.length === 0) return c.json({ error: 'no_pickable_lines' }, 400);

  {
    const offender = await firstUnorderableSo(supabase, pickedItems.map((p) => p.row.doc_no));
    if (offender) return c.json(soNotOrderableResponse(offender), 409);
  }

  const dupGate = await soHasPoGate(supabase, activeCompanyId(c) ?? null, pickedItems.map((p) => p.row), body.confirmDuplicatePo);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the HTTP route passes its real Context here; the headless agent never reaches the prompt
  if (dupGate.refusal) return c.json(await withMrpAssignments(supabase, c as unknown as Context<any>, dupGate.refusal), 409);

  const soItems = pickedItems.map(({ row, qty, pickSupplierId }) => {
    const lineWarehouseId =
      (purchaseLocationOverride as string | undefined)
      ?? row.warehouse_id
      ?? resolveWarehouseId(row.so?.sales_location);
    const rawDeliveryDate =
      row.line_delivery_date
      ?? row.so?.customer_delivery_date
      ?? null;
    return {
      soDocNo:  row.doc_no,
      itemCode: row.item_code,
      itemName: row.description ?? row.item_code,
      qty,
      lineWarehouseId,
      rawDeliveryDate,
      itemGroup: row.item_group,
      variants:  row.variants,
      soItemId:  row.id || null,
      soLineNo:  row.line_no ?? null,
      // Owner 2026-08-10 — the SO line's photo keys, carried to the PO line.
      photoUrls: row.photo_urls ?? [],
      lineRemark: row.remark ?? null, soNote: row.so?.note ?? null,
      pickSupplierId,
    };
  });

  const codes = [...new Set(soItems.map((it) => it.itemCode))];
  type MainBindingRow = {
    item_code: string; supplier_id: string; supplier_sku: string;
    unit_price_sen: number; currency: string; price_matrix: Record<string, unknown> | null;
  };
  const { data: bindings } = await readMfgProductBindings<MainBindingRow>(supabase, {
    codes, companyId: activeCompanyId(c),
    select: 'item_code, supplier_id, supplier_sku, unit_price_sen, currency, price_matrix, is_main_supplier',
  });
  const supplierIds = [...new Set(((bindings ?? []) as Array<{ supplier_id: string }>).map((b) => b.supplier_id))];
  const liveSupplierIds = new Set<string>();
  const supplierCodeById = new Map<string, string>();
  if (supplierIds.length > 0) {
    const { data: liveSuppliers } = await supabase
      .from('suppliers').select('id, code').in('id', supplierIds);
    for (const s of (liveSuppliers ?? []) as Array<{ id: string; code: string | null }>) {
      liveSupplierIds.add(s.id);
      if (s.code) supplierCodeById.set(s.id, s.code);
    }
  }
  const extraCandidates = [...new Set([
    ...soItems.map((it) => it.pickSupplierId).filter((x): x is string => Boolean(x)),
    ...Object.values(supplierByCode),
    ...(targetPoSupplierId ? [targetPoSupplierId] : []),
  ])].filter((id) => !liveSupplierIds.has(id));
  if (extraCandidates.length > 0) {
    const { data: extraLive } = await supabase
      .from('suppliers').select('id, code').in('id', extraCandidates);
    for (const s of (extraLive ?? []) as Array<{ id: string; code: string | null }>) {
      liveSupplierIds.add(s.id);
      if (s.code) supplierCodeById.set(s.id, s.code);
    }
  }


  const mainByCode = new Map<string, MainBindingRow>();
  const bindingByCodeSupplier = new Map<string, MainBindingRow>();
  for (const b of bindings) {
    if (!liveSupplierIds.has(b.supplier_id)) continue;
    bindingByCodeSupplier.set(`${b.item_code}|${b.supplier_id}`, b);
    const override = supplierByCode[b.item_code];
    const existing = mainByCode.get(b.item_code);
    if (override) {
      if (b.supplier_id === override) mainByCode.set(b.item_code, b);
      continue;
    }
    if (!existing) mainByCode.set(b.item_code, b);
  }

  const effectiveBindingFor = (it: { itemCode: string; pickSupplierId: string | null }): MainBindingRow | null => {
    const chosen = it.pickSupplierId ?? supplierByCode[it.itemCode] ?? null;
    if (chosen) {
      const exact = bindingByCodeSupplier.get(`${it.itemCode}|${chosen}`);
      if (exact) return exact;
    }
    const main = mainByCode.get(it.itemCode);
    if (main) return main;
    const fallback = chosen ?? targetPoSupplierId;
    if (fallback && liveSupplierIds.has(fallback)) {
      return {
        item_code: it.itemCode, supplier_id: fallback, supplier_sku: '',
        unit_price_sen: 0, currency: 'MYR', price_matrix: null,
      };
    }
    return null;
  };

  const fabricCodes = [...new Set(
    soItems
      .map((it) => String((it.variants as Record<string, unknown> | null)?.fabricCode ?? ''))
      .filter(Boolean),
  )];
  type FabricTierRow = {
    fabric_code: string;
    price_tier: MfgFabricTier | null;
    sofa_price_tier: MfgFabricTier | null;
    bedframe_price_tier: MfgFabricTier | null;
  };
  const fabricByCode = new Map<string, FabricTierRow>();
  if (fabricCodes.length > 0) {
    const { data: fabricRows } = await supabase
      .from('fabric_trackings')
      .select('fabric_code, price_tier, sofa_price_tier, bedframe_price_tier')
      .in('fabric_code', fabricCodes)
      .eq('company_id', activeCompanyId(c));
    for (const f of (fabricRows ?? []) as FabricTierRow[]) fabricByCode.set(f.fabric_code, f);
  }
  const resolveFabricTier = (
    category: string | null,
    variants: Record<string, unknown> | null,
  ): MfgFabricTier | null => {
    const code = String(variants?.fabricCode ?? '');
    if (!code) return null;
    const f = fabricByCode.get(code);
    if (!f) return null;
    const cat = (category ?? '').toLowerCase();
    if (cat === 'sofa')     return f.sofa_price_tier ?? f.price_tier ?? null;
    if (cat === 'bedframe') return f.bedframe_price_tier ?? f.price_tier ?? null;
    return null;
  };

  const supplierIdsInvolved = [...new Set(
    soItems
      .map((it) => effectiveBindingFor(it)?.supplier_id)
      .filter((x): x is string => Boolean(x)),
  )];
  const maintBySupplier = new Map<string, MaintenanceConfig | null>();
  await Promise.all(supplierIdsInvolved.map(async (sid) => {
    const { config } = await resolveMaintenanceConfigForSupplier(supabase, sid, activeCompanyId(c) ?? null);
    maintBySupplier.set(sid, config);
  }));

  const combosBySupplier = await loadSupplierSofaCombos(supabase, supplierIdsInvolved);

  const noBinding = soItems.filter((it) => !effectiveBindingFor(it));
  if (noBinding.length > 0) {
    return c.json({
      error: 'missing_bindings',
      message: 'No supplier could be resolved for some items — bind a main supplier or pick one for them',
      itemCodes: [...new Set(noBinding.map((it) => it.itemCode))],
    }, 400);
  }

  type SoLine = (typeof soItems)[number];
  const baseCostByItem = new Map<SoLine, number>();
  for (const it of soItems) {
    const b = effectiveBindingFor(it);
    if (!b) continue;
    const category = (it.itemGroup?.toUpperCase() ?? '') as
      'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'ACCESSORY' | 'SERVICE' | '';
    const variants = (it.variants ?? {}) as Record<string, unknown>;
    const base = category
      ? computeMfgPoUnitCost(
          {
            category,
            priceMatrix:    (b.price_matrix ?? null) as PoPriceMatrix,
            unitPriceSen: b.unit_price_sen,
            fabricTier:     resolveFabricTier(it.itemGroup, it.variants),
            ...poVariantPricingInput(category, variants),
          },
          maintBySupplier.get(b.supplier_id) ?? null,
        ).unitPriceSen
      : b.unit_price_sen;
    baseCostByItem.set(it, base);
  }

  const adjustedCostByItem = new Map<SoLine, number>();
  const sofaGroups = new Map<string, SoLine[]>();
  for (const it of soItems) {
    if ((it.itemGroup?.toUpperCase() ?? '') !== 'SOFA') continue;
    const b = effectiveBindingFor(it);
    if (!b) continue;
    const { baseModel, sizeCode } = splitSofaCode(it.itemCode);
    if (!sizeCode) continue;
    const key = `${b.supplier_id}|${it.soDocNo}|${baseModel.toUpperCase()}`;
    const arr = sofaGroups.get(key) ?? [];
    arr.push(it);
    sofaGroups.set(key, arr);
  }
  for (const [key, members] of sofaGroups) {
    const supplierId = key.slice(0, key.indexOf('|'));
    const baseModelU = key.slice(key.lastIndexOf('|') + 1);
    const supplierCombos = combosBySupplier.get(supplierId) ?? [];
    if (supplierCombos.length === 0) continue;
    const tiers = new Set(members.map((m) => resolveFabricTier(m.itemGroup, m.variants)));
    if (tiers.size !== 1) continue;
    const tier = [...tiers][0];
    if (!tier) continue;
    const heights = new Set(members.map((m) => sofaHeightKey(m.variants)));
    if (heights.size !== 1) continue;
    const height = [...heights][0]!;
    if (!height) continue;
    const rows = supplierCombos.filter((cmb) => (cmb.baseModel ?? '').toUpperCase() === baseModelU);
    if (rows.length === 0) continue;
    const match = pickCostComboMatch(
      { baseModel: '', modules: members.map((m) => splitSofaCode(m.itemCode).sizeCode), customerId: null, tier, height },
      rows,
    );
    if (!match) continue;
    const matched = match.matchedIndices.map((i) => members[i]).filter((m): m is SoLine => !!m);
    if (matched.length === 0) continue;
    const comboTotal = match.comboPriceSen;
    if (comboTotal <= 0) continue;
    const qtySet = new Set(matched.map((m) => Math.max(1, Number(m.qty) || 1)));
    if (qtySet.size !== 1) continue;
    const baseUnits = matched.map((m) => baseCostByItem.get(m) ?? 0);
    const spread = spreadComboTotal(baseUnits, comboTotal);
    matched.forEach((m, i) => adjustedCostByItem.set(m, spread[i] ?? 0));
  }

  type Line = {
    itemCode: string; itemName: string; qty: number; supplierSku: string; unitPriceSen: number;
    warehouseId: string | null; deliveryDate: string | null;
    itemGroup: string | null; variants: Record<string, unknown> | null;
    soItemId: string | null; soDocNo: string | null; soLineNo: number | null;
    photoUrls: string[]; notes: string | null; soNote: string | null;
  };
  type Bucket = {
    supplierId: string; warehouseId: string | null; currency: string;
    lines: Line[]; soDocNos: Set<string>;
  };
  const byGroup = new Map<string, Bucket>();
  /* Owner 2026-09-11 — under 'combined', a sofa order's accessories (pillow /
     皮套) ride onto the sofa's PO. That is BATCH context: an accessory line rides
     with the sofa only if its SO carries a sofa line in this convert. Compute
     the set once, pass it to every groupKeyFor call below. */
  const sofaSoDocNos = new Set(
    soItems
      .filter((it) => (it.itemGroup ?? '').trim().toLowerCase() === 'sofa')
      .map((it) => it.soDocNo),
  );
  /* 1 PO = 1 batch (owner 2026-10-05): a sofa set (one model on one order) is
     one dye lot, so it must land in ONE purchase order. Two models on two
     suppliers are two sets, allowed once the operator confirms. */
  const sofaSplits = findSofaSetSupplierSplits(soItems.filter((it) => (it.itemGroup ?? '').trim().toLowerCase() === 'sofa')
    .map((it) => ({ soDocNo: it.soDocNo, itemCode: it.itemCode, supplierId: effectiveBindingFor(it)!.supplier_id })));
  if (sofaSplits.sameModel.length > 0) {
    return c.json({
      error: 'sofa_set_supplier_split',
      reason: `A sofa model ships from one batch, so every module of one model on one order goes on ONE purchase order. Pick one supplier for each model of: ${sofaSplits.sameModel.join(', ')}.`,
      soDocNos: sofaSplits.sameModel,
    }, 409);
  }
  if (sofaSplits.crossModel.length > 0 && body.allowSofaSupplierSplit !== true) {
    const reason = `These orders put different sofa models on different suppliers, which raises one PO per supplier. Confirm to proceed: ${sofaSplits.crossModel.join(', ')}.`;
    return c.json({ error: 'sofa_set_suppliers_unconfirmed', reason, soDocNos: sofaSplits.crossModel }, 409);
  }
  for (const it of soItems) {
    const b = effectiveBindingFor(it)!;
    const effectiveSupplierId = b.supplier_id;
    const lineWarehouseId = it.lineWarehouseId;

    /* THE SUPPLIER'S DATE — derived here, the first point where every input
       exists: the warehouse, the category, the customer's date, and (only now)
       the chosen supplier.

       Commander 2026-06-18: pull the date EARLIER than the customer's so the
       supplier delivers ahead of it. Owner 2026-07-17 adds the two axes he
       cannot maintain by hand — this supplier's measured punctuality, and the
       season — as buffers ON TOP of his (warehouse, category) table. His number
       is untouched; see scm/lib/lead-time.ts.

       An explicit caller override still wins outright, unchanged: if the
       operator typed a date, that is the date. */
    const supplierCode = supplierCodeById.get(effectiveSupplierId) ?? null;
    const lead = resolveLeadDays(leadBase, leadOverrides, leadBuffers, {
      warehouseId: lineWarehouseId,
      category: it.itemGroup,
      supplierId: effectiveSupplierId,
      supplierCode,
      deliveryDate: it.rawDeliveryDate,
    });
    const lineDeliveryDate =
      (expectedAtOverride as string | undefined)
      ?? subtractCalendarDays(it.rawDeliveryDate, lead.total);

    // The split is per-CATEGORY (owner 2026-07-17) — see scm/lib/po-grouping.ts
    // for the rule and its reasoning. Every key still starts (warehouse,
    // supplier), which is what keeps each emitted PO single-warehouse.
    //
    // This was a single global toggle with one hardcoded exception (SOFA), so a
    // mixed pick could only ever get ONE behaviour. It now gets all three in one
    // convert: bedframe + sofa per-SO, mattress merged within a delivery-date
    // window, everything he did not rule on still following `poMode`.
    //
    // The window is passed the SUPPLIER's date, not the customer's — the bucket
    // must reflect when the goods actually land in the warehouse, which is what
    // the turnover rule is about.
    const groupKey = groupKeyFor(
      {
        warehouseId: lineWarehouseId,
        supplierId: effectiveSupplierId,
        soDocNo: it.soDocNo,
        itemGroup: it.itemGroup,
        deliveryDate: lineDeliveryDate,
      },
      poMode,
      { sofaSoDocNos },
    );
    const bucket = byGroup.get(groupKey)
      ?? { supplierId: effectiveSupplierId, warehouseId: lineWarehouseId, currency: b.currency, lines: [], soDocNos: new Set<string>() };

    const autoCostSen = adjustedCostByItem.get(it)
      ?? baseCostByItem.get(it)
      ?? b.unit_price_sen;

    bucket.lines.push({
      itemCode: it.itemCode,
      itemName: it.itemName,
      qty: it.qty,
      supplierSku: b.supplier_sku,
      unitPriceSen: autoCostSen,
      warehouseId: lineWarehouseId,
      deliveryDate: lineDeliveryDate,
      itemGroup: it.itemGroup,
      variants: it.variants,
      soItemId: it.soItemId,
      soDocNo: it.soDocNo, soLineNo: it.soLineNo,
      photoUrls: it.photoUrls, notes: diningLineNote(it.itemGroup, it.lineRemark), soNote: it.soNote,
    });
    bucket.soDocNos.add(it.soDocNo);
    byGroup.set(groupKey, bucket);
  }


  if (targetPoId) {
    const { data: po, error: poErr } = await supabase
      .from('purchase_orders')
      .select('id, status, supplier_id, po_number')
      .eq('id', targetPoId)
      .maybeSingle();
    if (poErr) return c.json({ error: 'load_failed', reason: poErr.message }, 500);
    if (!po) return c.json({ error: 'po_not_found' }, 404);
    const target = po as { id: string; status: string; supplier_id: string; po_number: string };
    if (target.status !== 'SUBMITTED' && target.status !== 'PARTIALLY_RECEIVED') {
      return c.json({ error: 'po_not_editable', reason: `Cannot add lines to a ${target.status} PO.` }, 409);
    }
    const targetLines = sortBySourceSoLine([...byGroup.values()]
      .filter((bk) => bk.supplierId === target.supplier_id)
      .flatMap((bk) => bk.lines));
    if (targetLines.length === 0) {
      return c.json({ error: 'supplier_mismatch', reason: 'None of the picked SO lines belong to this PO’s supplier.' }, 409);
    }
    const appendFrom = await nextPoLineNo(supabase, target.id);
    const rows = await poConvertLineRows(
      supabase, target.id, targetLines, fromMrp, activeCompanyId(c) ?? null, appendFrom);
    const { error: iErr } = await supabase.from('purchase_order_items').insert(stampCompany(rows, c));
    if (iErr) return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500);
    await recomputePoTotals(supabase, target.id);
    try { await recomputeSoPicked(supabase, targetLines.map((l) => l.soItemId)); }
    catch { }
    return c.json({ targetPoId: target.id, poNumber: target.po_number, added: targetLines.length }, 200);
  }

  const yymm = yymmFor();
  const p = companyDocPrefix(c);
  const firstNextPo = await mintMonthlyDocNo(supabase, 'purchase_orders', 'po_number', `${p}PO-${yymm}`);
  let counter = parseInt(firstNextPo.slice(`${p}PO-${yymm}-`.length), 10) - 1;

  const created: Array<{ id: string; poNumber: string; supplierId: string; lineCount: number }> = [];
  const dropped: Array<{ supplierId: string; lineCount: number; reason: string }> = [];
  for (const bucket of byGroup.values()) {
    const supplierId = bucket.supplierId;
    counter += 1;
    const subtotal = bucket.lines.reduce((s, l) => s + l.qty * l.unitPriceSen, 0);

    const lineDates = bucket.lines
      .map((l) => l.deliveryDate)
      .filter((d): d is string => Boolean(d))
      .sort();
    const headerExpectedAt = lineDates[0] ?? null;
    const headerPurchaseLocationId: string | null = bucket.warehouseId;

    const headerPayload = {
      company_id: activeCompanyId(c),
      supplier_id: supplierId,
      /* Owner 2026-08-02 — a bucket with no resolved warehouse (its SO line had
         none) must NOT land as a live SUBMITTED PO: a warehouse-less PO receives
         into the wrong place. Force it to DRAFT so it stays inert until someone
         sets the warehouse; confirm/submit then re-check via poWarehouseGap. */
      status: (asDraft || !headerPurchaseLocationId) ? 'DRAFT' : 'SUBMITTED',
      submitted_at: (asDraft || !headerPurchaseLocationId) ? null : new Date().toISOString(),
      currency: bucket.currency,
      subtotal_sen: subtotal,
      tax_sen: 0,
      total_sen: subtotal,
      // Owner 2026-11-10 — provenance on line 1 (the stored contract its 8 readers parse) + any DINING SO header notes (po-dining-remark.ts).
      notes: diningPoHeaderNotes(provenanceNote('so', [...bucket.soDocNos]), bucket.lines, bucket.soDocNos.size),
      created_by: user.id,
      expected_at: headerExpectedAt,
      purchase_location_id: headerPurchaseLocationId,
      po_date: todayMyt(),
    };
    let header: { id: string; po_number: string } | null = null;
    for (let attempt = 0; attempt < 8 && !header; attempt += 1) {
      const poNumber = `${p}PO-${yymm}-${String(counter).padStart(3, '0')}`;
      const { data: hd, error: hErr } = await supabase
        .from('purchase_orders')
        .insert({ po_number: poNumber, ...headerPayload })
        .select('id, po_number')
        .single();
      if (!hErr && hd) { header = hd as unknown as { id: string; po_number: string }; break; }
      if (!hErr || (hErr as { code?: string }).code !== '23505') break;
      const liveNextPo = await mintMonthlyDocNo(supabase, 'purchase_orders', 'po_number', `${p}PO-${yymm}`);
      counter = parseInt(liveNextPo.slice(`${p}PO-${yymm}-`.length), 10);
    }
    if (!header) {
      dropped.push({ supplierId, lineCount: bucket.lines.length, reason: 'po_header_insert_failed' });
      continue;
    }

    const rows = await poConvertLineRows(
      supabase, header.id, sortBySourceSoLine(bucket.lines), fromMrp, activeCompanyId(c) ?? null, 1);
    const { error: iErr } = await supabase.from('purchase_order_items').insert(stampCompany(rows, c));
    if (iErr) {
      await supabase.from('purchase_orders').delete().eq('id', header.id);
      dropped.push({ supplierId, lineCount: bucket.lines.length, reason: `po_items_insert_failed: ${iErr.message}` });
      continue;
    }
    await recordPoCreate(
      supabase, c.get('houzsUser'), c.get('companyId'), header.id, bucket.lines.length,
      `Raised from Sales Order${bucket.soDocNos.size === 1 ? '' : 's'} ${[...bucket.soDocNos].join(', ')}`,
    );
    /* ERP -> AutoCount PO create. THE LARGEST CREATE-SIDE HOLE IN THE SYSTEM
       until now: this is the converter behind POST /from-sos and the MRP
       agent's createDraftPosFromPicks, i.e. every purchase order the ERP raises
       from a Sales Order — and it queued nothing. It is not covered by the
       confirm-time hook either, because the status literal above writes
       'SUBMITTED' directly whenever a warehouse resolved, so PATCH /:id/confirm
       never runs for these and could not act as a backstop.

       Same DRAFT rule as POST / : a draft PO is inert by design (mrp.ts's
       PO_DEAD excludes it from supply, recomputeSoPicked ignores its lines), so
       it does not belong in the account book until a human confirms it — and
       confirm does queue it. Gated on headerPayload.status, the LITERAL that was
       inserted, rather than on `asDraft` — because this route has a SECOND way
       to become a draft that `asDraft` does not describe: a bucket whose SO line
       resolved no warehouse is forced to DRAFT above (owner 2026-08-02).
       Re-deriving the condition would have queued exactly those. */
    const acNotSent = headerPayload.status === 'DRAFT' ? [] : (await enqueuePoCreate(supabase, {
      companyId: activeCompanyId(c),
      poId: header.id,
      createdBy: c.get('houzsUser')?.id ?? null,
    })).problems;
    created.push({ id: header.id, poNumber: header.po_number, supplierId, lineCount: bucket.lines.length, ...(acNotSent.length ? { acNotSent } : {}) });
  }

  if (body.picks && created.length > 0) {
    try { await recomputeSoPicked(supabase, pickedItems.map(({ row }) => row.id)); }
    catch { }
  }

  return c.json({ created, total: created.length, ...(dropped.length ? { dropped } : {}) }, 201);
}

mfgPurchaseOrders.post('/from-sos', async (c) => {
  const out = await convertSosToPosCore({
    req: { json: () => c.req.json() },
    get: ((key: 'supabase' | 'user' | 'houzsUser' | 'companyId' | 'allowedCompanyIds' | 'companyCode') =>
      c.get(key as 'supabase')) as unknown as PoConvertContext['get'],
    env: c.env,
    json: (b, status) => ({ status: status ?? 200, body: b as Record<string, unknown> }),
  });
  settleFromSosForMrp(c, activeCompanyId(c) ?? null, out);
  if (out.body.error === 'so_has_po') markIdempotencyNoWrite(c);
  return c.json(out.body, out.status as 201);
});

export async function createDraftPosFromPicks(
  env: Env,
  opts: {
    userId: string;
    companyId: number | null;
    allowedCompanyIds?: number[] | null;
    companyCode?: string | null;
    picks: Array<{ soItemId: string; qty: number }>;
  },
): Promise<PoConvertOutcome> {
  const svc = getSupabaseService(env);
  const syntheticGet = (key: string): unknown => {
    if (key === 'supabase') return svc;
    if (key === 'user') return { id: opts.userId };
    if (key === 'houzsUser') return undefined;
    if (key === 'companyId') return opts.companyId ?? undefined;
    if (key === 'allowedCompanyIds') return opts.allowedCompanyIds ?? undefined;
    if (key === 'companyCode') return typeof opts.companyCode === 'string' ? opts.companyCode : undefined;
    return undefined;
  };
  return convertSosToPosCore({
    req: { json: async () => ({ picks: opts.picks, asDraft: true, fromMrp: true, confirmDuplicatePo: true }) }, // shortcut: agent not prompted (no person; DRAFT only), 2990-0065
    get: syntheticGet as unknown as PoConvertContext['get'],
    env,
    json: (b, status) => ({ status: status ?? 200, body: b as Record<string, unknown> }),
  });
}

mfgPurchaseOrders.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: beforeRow } = await scopeToCompanyId(sb.from('purchase_orders')
    .select(`${PO_AUDIT_SELECT}, updated_at, version`).eq('id', id), co.companyId).maybeSingle();
  if (!beforeRow) return c.json(NOT_THIS_COMPANY, 404);
  const before = (beforeRow ?? {}) as unknown as Record<string, unknown>;
  const prevExpectedAt = before.expected_at ?? null;
  const stale = poVersionRefusal(body, before.updated_at);
  if (stale) return c.json(stale.body, stale.status);

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [from, to] of PO_AUDIT_FIELDS) {
    if (body[from] !== undefined) updates[to] = body[from];
  }

  /* Tier-2 lock — FIELD-LEVEL (owner 2026-08-20, §8 GAP-1; po-identity-lock.ts):
     only GRN-inherited columns freeze once a GRN exists; dates + notes stay
     editable. Downstream read paid only when an inherited column changes. */
  const lockedChanges = changedPoIdentityLockCols(updates, before);
  if (lockedChanges.length > 0 && (await poHasDownstream(sb, id))) return c.json(poIdentityLockedRefusal(lockedChanges), 409);
  const sdGate = supplierDatePatchGate(before, updates); // HC-0090: recorded Date 2/3/4 are history
  if (sdGate.refusal) return c.json(sdGate.refusal, 409);
  const claim = await claimPoVersion(sb, id, co.companyId, before.version);
  if (!claim.ok) return c.json(claim.body, claim.status);
  { const m = await movePoLinesToNewWarehouse(sb, id, co.companyId, before, updates); if (m) return c.json(m.body, m.status); }
  const { data, error } = await sdGate.onlyIfEmpty(scopeToCompanyId(sb.from('purchase_orders').update(coerceEmptyDates(updates)).eq('id', id).eq('version', claim.version), co.companyId)).select('*').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return sdGate.fill.length ? c.json(sdGate.raced, 409) : c.json(poVersionRaced(), 409);
  const touchOnly = Object.keys(updates).length === 1;
  if (!touchOnly) {
    const auditPatch: Record<string, unknown> = {};
    for (const [camel, snake] of PO_AUDIT_FIELDS) {
      if (updates[snake] !== undefined) auditPatch[camel] = updates[snake];
    }
    await recordEntityAudit(sb, {
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      entityDocNo: (before.po_number as string | null) ?? null,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: (before.company_id as number | null) ?? activeCompanyId(c),
      statusSnapshot: (before.status as string | null) ?? null,
      fieldChanges: diffFields(before, auditPatch, PO_AUDIT_FIELDS),
    });
  }

  for (const [bodyKey, col] of [
    ['supplierDeliveryDate2', 'supplier_delivery_date_2'],
    ['supplierDeliveryDate3', 'supplier_delivery_date_3'],
    ['supplierDeliveryDate4', 'supplier_delivery_date_4'],
  ] as const) {
    const v = body[bodyKey];
    if (v === undefined || v === null || v === '') continue;
    try {
      await scopeToCompanyId(sb.from('purchase_order_items')
        .update({ [col]: v })
        .eq('purchase_order_id', id), co.companyId)
        .is(col, null);
    } catch (e) {
      console.error('[mfg-po PATCH] header date cascade failed', { id, col, error: e });
    }
  }

  /* Owner 2026-10-06, last edit wins (as SO) — a header Delivery Date change moves
     every line, hand-set ones included (flag resets), except a fully received one. JS
     filter: PostgREST cannot compare two columns. Keyed on the date CHANGING:
     the editor re-sends the whole header. Best-effort, as above. */
  if (updates['expected_at'] !== undefined && (updates['expected_at'] ?? null) !== prevExpectedAt) {
    const { data: lines, error: readErr } = await scopeToCompanyId(sb.from('purchase_order_items')
      .select('id, qty, received_qty').eq('purchase_order_id', id), co.companyId);
    const openIds = ((lines ?? []) as Array<{ id: string; qty: number; received_qty: number | null }>)
      .filter((l) => (l.received_qty ?? 0) < l.qty)
      .map((l) => l.id);
    const { error: lineErr } = readErr ? { error: readErr } : openIds.length === 0 ? { error: null }
      : await scopeToCompanyId(sb.from('purchase_order_items')
        .update({ delivery_date: updates['expected_at'], line_delivery_date_overridden: false }).in('id', openIds), co.companyId);
    if (lineErr) console.error('[mfg-po PATCH] delivery date line cascade failed', { id, error: lineErr });
  }
  if (!touchOnly) await queueAcPoEdit(c, id);

  return c.json({ purchaseOrder: data });
});

/* ── Bulk supplier-revised date across SEVERAL POs (owner 2026-08-03) ────────
   A supplier who pushes one delivery date usually pushes it for every order in
   flight, which meant opening each PO and (before the sibling PR) each line.
   This sets ONE revised-date slot on a picked set of POs in one call.

   Two deliberate differences from the header PATCH above:
     • the line write is UNCONDITIONAL (no `.is(col, null)`), because the whole
       point is the SECOND revision, when every line already carries the first
       one and the null-guarded cascade therefore moves nothing;
     • it is opt-in per call (`applyToLines`), so a caller can move only the
       header when the lines are individually managed.

   Per-PO isolation is the contract: a PO that is downstream-locked, or not in
   the active company, is REPORTED and skipped — one bad pick never costs the
   operator the rest of the batch. Every updated PO still writes its own audit
   row, exactly as the single PATCH does. */

const BULK_SUPPLIER_DATE_MAX = 100;

export type BulkSupplierDateRequest = {
  slot: SupplierDateSlot | 'next';
  col: (typeof SUPPLIER_DATE_SLOT_COL)[SupplierDateSlot] | null;
  date: string;
  poIds: string[];
  applyToLines: boolean;
};

export function parseBulkSupplierDateBody(
  body: Record<string, unknown>,
): { ok: true; req: BulkSupplierDateRequest }
  | { ok: false; status: 400; payload: { error: string; reason: string } } {
  const slot = body.slot === 'next' ? 'next' : Number(body.slot) as SupplierDateSlot;
  if (slot !== 'next' && !(slot in SUPPLIER_DATE_SLOT_COL)) {
    return { ok: false, status: 400, payload: { error: 'invalid_slot', reason: 'slot must be 2, 3, 4 or "next".' } };
  }

  const date = typeof body.date === 'string' ? body.date.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))
      || !date.startsWith(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10))) {
    return { ok: false, status: 400, payload: { error: 'invalid_date', reason: 'date must be a calendar date (YYYY-MM-DD).' } };
  }

  const poIds = Array.isArray(body.poIds)
    ? [...new Set(body.poIds.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))]
    : [];
  if (poIds.length === 0) {
    return { ok: false, status: 400, payload: { error: 'no_purchase_orders', reason: 'Pick at least one purchase order.' } };
  }
  if (poIds.length > BULK_SUPPLIER_DATE_MAX) {
    return {
      ok: false,
      status: 400,
      payload: {
        error: 'too_many_purchase_orders',
        reason: `Up to ${BULK_SUPPLIER_DATE_MAX} purchase orders per batch — you sent ${poIds.length}.`,
      },
    };
  }

  return {
    ok: true,
    req: {
      slot,
      col: slot === 'next' ? null : SUPPLIER_DATE_SLOT_COL[slot],
      date,
      poIds,
      applyToLines: body.applyToLines === undefined ? true : Boolean(body.applyToLines),
    },
  };
}

mfgPurchaseOrders.post('/bulk-supplier-date', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const parsed = parseBulkSupplierDateBody(body);
  if (!parsed.ok) return c.json(parsed.payload, parsed.status);
  const { slot, date, poIds, applyToLines } = parsed.req;

  const updated: Array<{ id: string; poNumber: string | null; slot: SupplierDateSlot }> = [];
  const skipped: Array<{ id: string; poNumber: string | null; reason: string }> = [];

  for (const id of poIds) {
    const { data: beforeRow } = await scopeToCompanyId(
      sb.from('purchase_orders').select(PO_AUDIT_SELECT).eq('id', id), co.companyId,
    ).maybeSingle();
    if (!beforeRow) { skipped.push({ id, poNumber: null, reason: 'Not found in this company.' }); continue; }
    const before = beforeRow as unknown as Record<string, unknown>;
    const poNumber = (before.po_number as string | null) ?? null;

    const childLock = await poHasDownstream(sb, id);
    if (childLock) { skipped.push({ id, poNumber, reason: childLock.message }); continue; }
    const pick = pickSupplierDateSlot(slot, before);
    if (!pick.ok) { skipped.push({ id, poNumber, reason: pick.reason }); continue; }

    const written = await cascadePoSupplierDate(sb, {
      companyId: co.companyId, poId: id, before, slot: pick.slot, date, applyToLines, actor: c.get('houzsUser') ?? null, note: null, requireEmpty: true,
    });
    if (!written.ok) { skipped.push({ id, poNumber, reason: written.reason }); continue; }
    await queueAcPoEdit(c, id);
    updated.push({ id, poNumber, slot: pick.slot });
  }

  return c.json({ slot, date, applyToLines, updated, skipped });
});

async function recomputePoTotals(sb: any, poId: string) {
  const { data: items, error: itemsErr } = await sb.from('purchase_order_items')
    .select('line_total_sen')
    .eq('purchase_order_id', poId);
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[po-recompute] item read failed — header left unchanged:', poId, itemsErr.message);
    return;
  }
  const subtotal = (items ?? []).reduce((s: number, r: any) => s + (r.line_total_sen ?? 0), 0);
  const { error: updErr } = await sb.from('purchase_orders').update({
    subtotal_sen: subtotal,
    total_sen: subtotal,
    updated_at: new Date().toISOString(),
  }).eq('id', poId);
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[po-recompute] header update failed — totals left STALE:', poId, updErr.message);
  }
}

export async function recomputePoExpectedAt(sb: any, poId: string) {
  try {
    const { data: lines, error: linesErr } = await sb.from('purchase_order_items')
      .select('delivery_date')
      .eq('purchase_order_id', poId);
    if (linesErr) throw linesErr;
    const dates = ((lines ?? []) as Array<{ delivery_date: string | null }>)
      .map((r) => r.delivery_date)
      .filter((d): d is string => Boolean(d))
      .sort();
    await sb.from('purchase_orders')
      .update({ expected_at: dates[0] ?? null, updated_at: new Date().toISOString() })
      .eq('id', poId);
  } catch (e) {
    console.error('[recomputePoExpectedAt] best-effort failed', { poId, error: e });
  }
}

export async function recomputeSoPicked(sb: any, soItemIds: Array<string | null | undefined>) {
  const ids = [...new Set(soItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return;
  try {
    const { data: lines, error: linesErr } = await sb
      .from('purchase_order_items')
      .select('so_item_id, qty, purchase_order_id, from_mrp')
      .in('so_item_id', ids);
    if (linesErr) throw linesErr;
    const rows = ((lines ?? []) as Array<{ so_item_id: string; qty: number; purchase_order_id: string; from_mrp: boolean | null }>)
      .filter((r) => r.from_mrp !== true);
    const poIds = [...new Set(rows.map((r) => r.purchase_order_id).filter(Boolean))];
    const deadPo = new Set<string>();
    if (poIds.length > 0) {
      const { data: pos, error: posErr } = await sb.from('purchase_orders').select('id, status').in('id', poIds);
      if (posErr) throw posErr;
      for (const p of (pos ?? []) as Array<{ id: string; status: string }>) {
        if (p.status === 'CANCELLED' || p.status === 'DRAFT') deadPo.add(p.id);
      }
    }
    const pickedBySo = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const r of rows) {
      if (deadPo.has(r.purchase_order_id)) continue;
      pickedBySo.set(r.so_item_id, (pickedBySo.get(r.so_item_id) ?? 0) + Number(r.qty ?? 0));
    }
    await Promise.all([...pickedBySo.entries()].map(([soItemId, picked]) =>
      sb.from('mfg_sales_order_items').update({ po_qty_picked: picked }).eq('id', soItemId),
    ));
  } catch (e) {
    console.error('[recomputeSoPicked] best-effort recount failed', { soItemIds: ids, error: e });
  }
}

/* ── SO-link target gate ────────────────────────────────────────────────────
   `purchase_order_items.so_item_id` is procurement PROVENANCE under the
   2026-08-06 decision (soft until DO, hard from DO — see docs/modules/
   purchase-order.md §Decision): the record of WHY we bought. Transitionally it
   still feeds the drop-ship batch expectation and the per-line quota (staged
   demotion in progress), and it is displayed and audited everywhere — so the
   operator-facing bind (add-line and line-edit) must still not be able to
   point a PO line at just any SO line. Three
   things are checked, and a failure is a 409 the UI can show verbatim:

     • the SO line exists and belongs to the ACTIVE COMPANY (a foreign uuid
       resolves to nothing, exactly like every other cross-company read here);
     • it is not cancelled — a cancelled line has no demand to fulfil;
     • its item_code equals the PO line's item_code. Binding a PO line for
       one SKU to an SO line for another makes every downstream reader lie.

   Returns null when the link is acceptable (including when there is none). */
async function soLinkTargetRefusal(
  sb: any,
  c: any,
  soItemId: string | null,
  itemCode: string,
  poGroup: string | null,
  poSpec: string | null = null,
): Promise<{ body: Record<string, unknown>; status: 404 | 409 } | null> {
  if (!soItemId) return null;
  const { data } = await scopeToCompany(
    sb.from('mfg_sales_order_items').select('id, doc_no, item_code, item_group, variants, cancelled').eq('id', soItemId), c,
  ).maybeSingle();
  const row = data as { id: string; doc_no: string | null; item_code: string | null; item_group: string | null; variants: Record<string, unknown> | null; cancelled: boolean | null } | null;
  if (!row) {
    return {
      body: { error: 'so_line_not_found', reason: 'That Sales Order line does not exist on this company.' },
      status: 404,
    };
  }
  if (row.cancelled) {
    return {
      body: {
        error: 'so_line_cancelled',
        reason: `Sales Order line ${row.doc_no ?? ''} is cancelled — it has no demand to purchase against.`.trim(),
      },
      status: 409,
    };
  }
  const soCode = String(row.item_code ?? '').trim().toUpperCase();
  const poCode = String(itemCode ?? '').trim().toUpperCase();
  if (!soCode || soCode !== poCode) {
    return {
      body: {
        error: 'so_link_material_mismatch',
        reason: `This line orders ${itemCode}, but the picked Sales Order line is for ${row.item_code ?? '(no item)'}. Pick the matching line, or leave the source blank.`,
        soItemCode: row.item_code,
        itemCode,
      },
      status: 409,
    };
  }
  const badCategory = soLinkCategoryMismatch({ itemCode, itemGroup: poGroup }, row);
  if (badCategory) return { body: badCategory, status: 409 };
  /* SPEC GATE (owner 2026-08-08). Same code is not enough — the SO line must be
     the SAME PRODUCT (fabric + colour + SEAT/LEG/SPECIAL). poSpec is the PO
     line's summary, resolved by the caller; when absent (forward-compat) the
     code check above still holds. Dye-lot is deliberately not in the signature. */
  if (poSpec) {
    const soSpec = specSignature(row.item_group ?? null, row.variants ?? null);
    if (soSpec !== poSpec) {
      return {
        body: {
          error: 'so_link_spec_mismatch',
          reason: `The picked Sales Order line is the same item code but a different spec. Pick a line whose fabric and options match, or leave the source blank.`,
          soItemCode: row.item_code,
          itemCode,
        },
        status: 409,
      };
    }
  }
  return null;
}

mfgPurchaseOrders.post('/:id/items', async (c) => {
  const poId = c.req.param('id');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);
  if (!it.materialName) return c.json({ error: 'material_name_required' }, 400);

  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: parentPo } = await scopeToCompanyId(sb.from('purchase_orders').select('id').eq('id', poId), co.companyId).maybeSingle();
  if (!parentPo) return c.json(NOT_THIS_COMPANY, 404);
  const childLock = await poHasDownstream(sb, poId);
  if (childLock) return c.json(childLock, 409);

  const addGroupOf = await skuCategoryResolver(sb, [it], co.companyId ?? null);
  const parsedLine = parseLineNumbers({
    qty: { value: it.qty, fallback: 1 },
    unitPriceSen: { value: it.unitPriceSen },
    discountSen: { value: it.discountSen },
  });
  if (!parsedLine.ok) return c.json(invalidLineNumberBody(parsedLine.invalid), 400);
  const { qty, unitPriceSen, discountSen } = parsedLine.nums as {
    qty: number; unitPriceSen: number; discountSen: number;
  };
  const lineTotal = Math.max(0, (qty * unitPriceSen) - discountSen);

  const soItemId = (((it.soItemId ?? it.so_item_id) as string | null | undefined) || null);
  {
    const refusal = await soLinkTargetRefusal(sb, c, soItemId, String(it.itemCode ?? ''), addGroupOf(it));
    if (refusal) return c.json(refusal.body, refusal.status);
  }
  { const inactive = await poInactivePickRefusal(sb, co.companyId ?? null, [{ materialKind: it.materialKind, itemCode: it.itemCode, soItemId }]); if (inactive) return c.json(inactive, 409); }
  const dupGate = await soHasPoGate(sb, co.companyId ?? null, soItemId ? [{ id: soItemId, doc_no: null, item_code: String(it.itemCode ?? ''), item_group: addGroupOf(it) }] : [], it.confirmDuplicatePo);
  if (dupGate.refusal) { markIdempotencyNoWrite(c); return c.json(await withMrpAssignments(sb, c, dupGate.refusal), 409); }
  if (it.confirmOverConvert !== true) {
    const over = await soLineOverConvertRefusal(sb, soItemId, qty, 0);
    if (over) return c.json({ error: 'qty_exceeds_remaining', ...over }, 409);
  }

  const row: Record<string, unknown> = {
    purchase_order_id: poId,
    so_item_id: soItemId,
    binding_id: (it.bindingId as string) ?? null,
    material_kind: (it.materialKind as string) ?? 'mfg_product',
    item_code: it.itemCode,
    material_name: it.materialName,
    supplier_sku: (it.supplierSku as string) ?? null,
    qty,
    unit_price_sen: unitPriceSen,
    line_total_sen: lineTotal,
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
    ...lineIdentityFields(addGroupOf, it, buildVariantSummary), // same rule as create — docs/bugs/0514
    uom: (it.uom as string) ?? 'UNIT',
    discount_sen: discountSen,
    unit_cost_sen: Number(it.unitCostSen ?? 0),
    delivery_date: dateOrNull(it.deliveryDate),
    line_delivery_date_overridden: it.lineDeliveryDateOverridden === true,
    supplier_delivery_date_2: dateOrNull(it.supplierDeliveryDate2),
    supplier_delivery_date_3: dateOrNull(it.supplierDeliveryDate3),
    supplier_delivery_date_4: dateOrNull(it.supplierDeliveryDate4),
    warehouse_id: (it.warehouseId as string) ?? null,
  };
  const lineNo = await nextPoLineNo(sb, poId);
  const { data, error } = await sb.from('purchase_order_items').insert({ ...row, line_no: lineNo, company_id: activeCompanyId(c) }).select('*').single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  await recomputePoTotals(sb, poId);
  await recomputePoExpectedAt(sb, poId);
  if (soItemId) {
    try { await recomputeSoPicked(sb, [soItemId]); }
    catch { }
  }

  {
    const added = (data ?? {}) as unknown as Record<string, unknown>;
    const meta = await loadPoAuditMeta(sb, poId);
    await recordEntityAudit(sb, {
      entityType: 'PURCHASE_ORDER',
      entityId: poId,
      entityDocNo: meta.docNo,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: meta.companyId ?? activeCompanyId(c),
      statusSnapshot: meta.status,
      note: `Line added: ${String(it.itemCode ?? '')}`,
      fieldChanges: compactChanges(
        PO_LINE_AUDIT_FIELDS.map(([camel, snake]) => fieldChange(camel, null, added[snake] ?? null)),
      ),
    });
  }

  await queueAcPoEdit(c, poId, [], data?.id ? [String(data.id)] : []);

  return c.json({ item: data }, 201);
});

mfgPurchaseOrders.patch('/:id/items/:itemId', async (c) => {
  const poId = c.req.param('id'); const itemId = c.req.param('itemId');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const childLock = await poHasDownstream(sb, poId);
  if (childLock) return c.json(childLock, 409);

  const { data: prevRow } = await scopeToCompanyId(sb.from('purchase_order_items')
    .select(PO_LINE_AUDIT_SELECT + ', variants, so_item_id, material_kind')
    .eq('id', itemId), co.companyId).maybeSingle();
  if (!prevRow) return c.json(NOT_THIS_COMPANY, 404);
  const prev = prevRow as unknown as Record<string, unknown>;

  const parsedEdit = parseLineNumbers({
    qty: { value: it.qty !== undefined ? it.qty : prev.qty },
    unitPriceSen: { value: it.unitPriceSen !== undefined ? it.unitPriceSen : prev.unit_price_sen },
    discountSen: { value: it.discountSen !== undefined ? it.discountSen : prev.discount_sen },
  });
  if (!parsedEdit.ok) return c.json(invalidLineNumberBody(parsedEdit.invalid), 400);
  const { qty, unitPriceSen: unit, discountSen: discount } = parsedEdit.nums as {
    qty: number; unitPriceSen: number; discountSen: number;
  };
  const lineTotal = Math.max(0, (qty * unit) - discount);

  if (it.qty !== undefined && Number(qty) < Number(prev.qty ?? 0)) {
    try {
      const { data: allocRows, error: allocErr } = await sb
        .from('purchase_order_item_allocations')
        .select('qty').eq('purchase_order_item_id', itemId);
      if (!allocErr) {
        const allocated = ((allocRows ?? []) as Array<{ qty: number }>)
          .reduce((s, a) => s + Number(a.qty ?? 0), 0);
        if (allocated > Number(qty)) {
          return c.json({
            error: 'line_qty_below_allocated',
            message: `This line already has ${allocated} allocated across its sub-numbers — shrink or delete the allocations first, then lower the qty.`,
            allocatedQty: allocated,
          }, 409);
        }
      }
    } catch { }
  }

  const editedGroup = await editedLineGroup(sb, co.companyId ?? null, prev, it);
  if (editedGroup !== undefined) it.itemGroup = editedGroup;
  const updates: Record<string, unknown> = {
    qty, unit_price_sen: unit, discount_sen: discount, line_total_sen: lineTotal,
  };
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['materialName', 'material_name'],
    ['supplierSku', 'supplier_sku'], ['itemGroup', 'item_group'],
    ['description', 'description'], ['description2', 'description2'],
    ['uom', 'uom'], ['unitCostSen', 'unit_cost_sen'], ['notes', 'notes'],
    ['gapInches', 'gap_inches'], ['divanHeightInches', 'divan_height_inches'],
    ['divanPriceSen', 'divan_price_sen'], ['legHeightInches', 'leg_height_inches'],
    ['legPriceSen', 'leg_price_sen'], ['customSpecials', 'custom_specials'],
    ['lineSuffix', 'line_suffix'], ['specialOrderPriceSen', 'special_order_price_sen'],
    ['variants', 'variants'],
    ['deliveryDate', 'delivery_date'], ['warehouseId', 'warehouse_id'],
    ['supplierDeliveryDate2', 'supplier_delivery_date_2'], ['supplierDeliveryDate3', 'supplier_delivery_date_3'],
    ['supplierDeliveryDate4', 'supplier_delivery_date_4'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  /* Owner 2026-10-06 — a user-saved line date is hand-set, and the header
     cascade then leaves it alone. Only a CHANGED date counts: the editor
     re-sends every field of a changed line. An explicit flag (the editor sends
     false for a date it copied from the header) wins. */
  if (it.lineDeliveryDateOverridden !== undefined) {
    updates['line_delivery_date_overridden'] = it.lineDeliveryDateOverridden === true;
  } else if (it.deliveryDate !== undefined && dateOrNull(it.deliveryDate) !== (prev.delivery_date ?? null)) {
    updates['line_delivery_date_overridden'] = true;
  }
  if (description2InputsChanged(prev, it)) {
    const effGroup = (it.itemGroup ?? (prev as { item_group?: string }).item_group) as string | null | undefined;
    const effVariants = (it.variants ?? (prev as { variants?: unknown }).variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  const prevSoItemId = ((prev as { so_item_id?: string | null }).so_item_id) ?? null;
  let nextSoItemId = prevSoItemId;
  const soItemKeySent = it.soItemId !== undefined || it.so_item_id !== undefined;
  const effCode = String((it.itemCode ?? (prev as { item_code?: string }).item_code) ?? '');
  const effGroup = (editedGroup !== undefined ? editedGroup : prev.item_group ?? null) as string | null;
  if (soItemKeySent) nextSoItemId = (((it.soItemId ?? it.so_item_id) as string | null | undefined) || null);
  if (soItemKeySent || effCode !== String(prev.item_code ?? '') || effGroup !== (prev.item_group ?? null)) {
    const refusal = await soLinkTargetRefusal(sb, c, nextSoItemId, effCode, effGroup);
    if (refusal) return c.json(refusal.body, refusal.status);
    if (soItemKeySent) updates['so_item_id'] = nextSoItemId;
  }
  const lineRefusal = hardBoundUnlinkRefusal(co.companyId ?? null, { item_group: effGroup, item_code: effCode }, prevSoItemId, nextSoItemId) ?? (effCode !== String(prev.item_code ?? '') ? await poInactivePickRefusal(sb, co.companyId ?? null, [{ materialKind: prev.material_kind, itemCode: effCode, soItemId: nextSoItemId }]) : null);
  if (lineRefusal) return c.json(lineRefusal, 409);

  if (it.confirmOverConvert !== true) {
    const ownCurrentQty = nextSoItemId && nextSoItemId === prevSoItemId
      ? Number(prev.qty ?? 0)
      : 0;
    const over = await soLineOverConvertRefusal(sb, nextSoItemId, qty, ownCurrentQty);
    if (over) return c.json({ error: 'qty_exceeds_remaining', ...over }, 409);
  }

  const { error } = await scopeToCompanyId(sb.from('purchase_order_items').update(coerceEmptyDates(updates)).eq('id', itemId), co.companyId);
  // HC-0004: the DB floor (mig 20261014T1430) refused a cut below what a GRN, posted after the lock read above, received.
  if (isPoLineOverReceived(error)) return c.json({ error: 'received_floor', message: 'A goods received note has just received this line. Its qty can no longer be cut below what was received. Refresh and check the order.', reason: error!.message }, 409);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);

  {
    const auditPatch: Record<string, unknown> = {};
    for (const [camel, snake] of PO_LINE_AUDIT_FIELDS) {
      if (updates[snake] !== undefined) auditPatch[camel] = updates[snake];
    }
    const lineChanges = diffFields(prev, auditPatch, PO_LINE_AUDIT_FIELDS);
    if (lineChanges.length > 0) {
      const meta = await loadPoAuditMeta(sb, poId);
      await recordEntityAudit(sb, {
        entityType: 'PURCHASE_ORDER',
        entityId: poId,
        entityDocNo: meta.docNo,
        action: 'UPDATE',
        actor: c.get('houzsUser'),
        companyId: meta.companyId ?? activeCompanyId(c),
        statusSnapshot: meta.status,
        note: `Line edited: ${String(prev.item_code ?? itemId)}`,
        fieldChanges: lineChanges,
      });
    }
  }

  await recomputePoTotals(sb, poId);
  await recomputePoExpectedAt(sb, poId);
  const touchedSoItems = [...new Set([prevSoItemId, nextSoItemId].filter((x): x is string => !!x))];
  if (touchedSoItems.length > 0) {
    try { await recomputeSoPicked(sb, touchedSoItems); }
    catch { }
  }

  await queueAcPoEdit(c, poId);

  return c.json({ ok: true });
});

mfgPurchaseOrders.delete('/:id/items/:itemId', async (c) => {
  const poId = c.req.param('id'); const itemId = c.req.param('itemId');
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const childLock = await poHasDownstream(sb, poId);
  if (childLock) return c.json(childLock, 409);

  const { data: doomedRow } = await scopeToCompanyId(sb.from('purchase_order_items')
    .select(PO_LINE_AUDIT_SELECT + ', so_item_id')
    .eq('id', itemId), co.companyId)
    .maybeSingle();
  if (!doomedRow) return c.json(NOT_THIS_COMPANY, 404);
  const doomed = (doomedRow ?? null) as unknown as Record<string, unknown> | null;

  const retire = await retiredLineOf(sb, 'purchase_order_items', itemId);

  const { error } = await scopeToCompanyId(sb.from('purchase_order_items').delete().eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);

  {
    const gone = doomed ?? {};
    const meta = await loadPoAuditMeta(sb, poId);
    await recordEntityAudit(sb, {
      entityType: 'PURCHASE_ORDER',
      entityId: poId,
      entityDocNo: meta.docNo,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: meta.companyId ?? activeCompanyId(c),
      statusSnapshot: meta.status,
      note: `Line removed: ${String(gone.item_code ?? itemId)}`,
      fieldChanges: compactChanges(
        PO_LINE_AUDIT_FIELDS.map(([camel, snake]) => fieldChange(camel, gone[snake] ?? null, null)),
      ),
    });
  }

  await recomputePoTotals(sb, poId);
  await recomputePoExpectedAt(sb, poId);

  const releasedSoItem = (doomed as { so_item_id?: string | null } | null)?.so_item_id ?? null;
  if (releasedSoItem) {
    try { await recomputeSoPicked(sb, [releasedSoItem]); }
    catch { }
  }

  await queueAcPoEdit(c, poId, retire);

  return c.body(null, 204);
});


async function resolveAllocationParent(
  sb: any,
  c: any,
  poId: string,
  itemId: string,
): Promise<
  | { ok: true; item: { id: string; qty: number; item_code: string; item_group: string | null; variants: Record<string, unknown> | null }; poNumber: string | null; companyId: number }
  | { ok: false; body: Record<string, unknown>; status: 404 | 409 }
> {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return { ok: false, body: co.refusal, status: 409 };
  const { data: po } = await scopeToCompanyId(
    sb.from('purchase_orders').select('id, po_number, status').eq('id', poId), co.companyId,
  ).maybeSingle();
  const poRow = po as { id: string; po_number: string | null; status: string | null } | null;
  if (!poRow) return { ok: false, body: NOT_THIS_COMPANY, status: 404 };
  if ((poRow.status ?? '').toUpperCase() === 'CANCELLED') {
    return {
      ok: false,
      body: { error: 'po_cancelled', message: 'This purchase order is cancelled — there is nothing to allocate.' },
      status: 409,
    };
  }
  const { data: item } = await sb.from('purchase_order_items')
    .select('id, qty, item_code, item_group, variants, purchase_order_id')
    .eq('id', itemId)
    .maybeSingle();
  const itemRow = item as { id: string; qty: number; item_code: string; item_group: string | null; variants: Record<string, unknown> | null; purchase_order_id: string } | null;
  if (!itemRow || itemRow.purchase_order_id !== poId) {
    return { ok: false, body: { error: 'line_not_found', message: 'That line is not on this purchase order.' }, status: 404 };
  }
  return { ok: true, item: { id: itemRow.id, qty: itemRow.qty, item_code: itemRow.item_code, item_group: itemRow.item_group ?? null, variants: itemRow.variants ?? null }, poNumber: poRow.po_number, companyId: co.companyId };
}

async function currentAllocations(sb: any, itemId: string): Promise<AllocationRow[]> {
  const { data } = await sb.from('purchase_order_item_allocations')
    .select('id, seq, qty, so_item_id')
    .eq('purchase_order_item_id', itemId)
    .order('seq', { ascending: true });
  return (data ?? []) as AllocationRow[];
}

async function recordAllocationAudit(
  sb: any,
  c: any,
  poId: string,
  note: string,
  changes: Array<{ field: string; from: unknown; to: unknown }>,
): Promise<void> {
  const meta = await loadPoAuditMeta(sb, poId);
  await recordEntityAudit(sb, {
    entityType: 'PURCHASE_ORDER',
    entityId: poId,
    entityDocNo: meta.docNo,
    action: 'UPDATE',
    actor: c.get('houzsUser'),
    companyId: meta.companyId ?? activeCompanyId(c),
    statusSnapshot: meta.status,
    note,
    fieldChanges: compactChanges(changes.map((ch) => fieldChange(ch.field, ch.from, ch.to))),
  });
}

mfgPurchaseOrders.get('/:id/items/:itemId/allocations', async (c) => {
  const poId = c.req.param('id'); const itemId = c.req.param('itemId');
  const sb = c.get('supabase');
  const parent = await resolveAllocationParent(sb, c, poId, itemId);
  if (!parent.ok) return c.json(parent.body, parent.status);
  const map = await loadAllocationsForItems(sb, [itemId]);
  return c.json({ allocations: map.get(itemId) ?? [], lineQty: parent.item.qty, poNumber: parent.poNumber });
});

mfgPurchaseOrders.post('/:id/items/:itemId/allocations', async (c) => {
  const poId = c.req.param('id'); const itemId = c.req.param('itemId');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const user = c.get('user');
  const parent = await resolveAllocationParent(sb, c, poId, itemId);
  if (!parent.ok) return c.json(parent.body, parent.status);
  const splitRefusal = hardBoundSplitRefusal(parent.companyId, parent.item);
  if (splitRefusal) return c.json(splitRefusal, 409);

  const soItemId = (((body.soItemId ?? body.so_item_id) as string | null | undefined) || null);
  if (soItemId) {
    const poSpec = specSignature(parent.item.item_group, parent.item.variants);
    const refusal = await soLinkTargetRefusal(sb, c, soItemId, parent.item.item_code, parent.item.item_group, poSpec);
    if (refusal) return c.json(refusal.body, refusal.status);
  }
  const existing = await currentAllocations(sb, itemId);
  const plan = planAllocationCreate(parent.item.qty, existing, body.qty);
  if (plan.refusal) {
    return c.json(plan.refusal, plan.refusal.error === 'invalid_qty' ? 400 : 409);
  }
  const { data, error } = await sb.from('purchase_order_item_allocations')
    .insert({
      company_id: activeCompanyId(c),
      purchase_order_item_id: itemId,
      seq: plan.seq,
      qty: plan.qty,
      so_item_id: soItemId,
      created_by: user.id,
    })
    .select('id, seq, qty, so_item_id')
    .single();
  if (error) {
    const transient = (error.code === '23505') || /allocation_exceeds_line_qty/.test(error.message ?? '');
    if (transient) {
      return c.json({ error: 'allocation_conflict', message: "The line's allocations changed underneath this edit — reload and try again." }, 409);
    }
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  const created = data as unknown as AllocationRow;
  await recordAllocationAudit(sb, c, poId, `Line allocation added: ${parent.item.item_code} ${allocationSubNumber(parent.poNumber, created.seq)}`, [
    { field: 'allocation', from: null, to: `${allocationSubNumber(parent.poNumber, created.seq)} qty ${created.qty}` },
    { field: 'allocationTarget', from: null, to: soItemId ?? 'STOCK' },
  ]);
  const map = await loadAllocationsForItems(sb, [itemId]);
  return c.json({ allocation: (map.get(itemId) ?? []).find((a) => a.id === created.id) ?? created, allocations: map.get(itemId) ?? [] }, 201);
});

mfgPurchaseOrders.patch('/:id/items/:itemId/allocations/:allocationId', async (c) => {
  const poId = c.req.param('id'); const itemId = c.req.param('itemId'); const allocationId = c.req.param('allocationId');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const parent = await resolveAllocationParent(sb, c, poId, itemId);
  if (!parent.ok) return c.json(parent.body, parent.status);
  const splitRefusal = hardBoundSplitRefusal(parent.companyId, parent.item);
  if (splitRefusal) return c.json(splitRefusal, 409);

  const existing = await currentAllocations(sb, itemId);
  const prev = existing.find((a) => a.id === allocationId);
  if (!prev) return c.json({ error: 'allocation_not_found', message: 'That allocation no longer exists on this line.' }, 404);

  const plan = planAllocationQtyUpdate(parent.item.qty, existing, allocationId, body.qty);
  if (plan.refusal) {
    return c.json(plan.refusal, plan.refusal.error === 'invalid_qty' ? 400 : plan.refusal.error === 'allocation_not_found' ? 404 : 409);
  }
  const updates: Record<string, unknown> = { qty: plan.qty };
  const soItemKeySent = body.soItemId !== undefined || body.so_item_id !== undefined;
  let nextSoItemId = prev.so_item_id;
  if (soItemKeySent) {
    nextSoItemId = (((body.soItemId ?? body.so_item_id) as string | null | undefined) || null);
    if (nextSoItemId) {
      const poSpec = specSignature(parent.item.item_group, parent.item.variants);
      const refusal = await soLinkTargetRefusal(sb, c, nextSoItemId, parent.item.item_code, parent.item.item_group, poSpec);
      if (refusal) return c.json(refusal.body, refusal.status);
    }
    updates.so_item_id = nextSoItemId;
  }
  const { error } = await scopeToCompanyId(sb.from('purchase_order_item_allocations')
    .update(updates).eq('id', allocationId).eq('purchase_order_item_id', itemId), parent.companyId);
  if (error) {
    if (/allocation_exceeds_line_qty/.test(error.message ?? '')) {
      return c.json({ error: 'allocation_conflict', message: "The line's allocations changed underneath this edit — reload and try again." }, 409);
    }
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
  if (plan.qty !== prev.qty) changes.push({ field: 'allocationQty', from: prev.qty, to: plan.qty });
  if (soItemKeySent && nextSoItemId !== prev.so_item_id) {
    changes.push({ field: 'allocationTarget', from: prev.so_item_id ?? 'STOCK', to: nextSoItemId ?? 'STOCK' });
  }
  if (changes.length > 0) {
    await recordAllocationAudit(sb, c, poId, `Line allocation edited: ${parent.item.item_code} ${allocationSubNumber(parent.poNumber, prev.seq)}`, changes);
  }
  const map = await loadAllocationsForItems(sb, [itemId]);
  return c.json({ ok: true, allocations: map.get(itemId) ?? [] });
});

mfgPurchaseOrders.delete('/:id/items/:itemId/allocations/:allocationId', async (c) => {
  const poId = c.req.param('id'); const itemId = c.req.param('itemId'); const allocationId = c.req.param('allocationId');
  const sb = c.get('supabase');
  const parent = await resolveAllocationParent(sb, c, poId, itemId);
  if (!parent.ok) return c.json(parent.body, parent.status);

  const existing = await currentAllocations(sb, itemId);
  const doomed = existing.find((a) => a.id === allocationId);
  if (!doomed) return c.json({ error: 'allocation_not_found', message: 'That allocation no longer exists on this line.' }, 404);

  const { error } = await scopeToCompanyId(sb.from('purchase_order_item_allocations')
    .delete().eq('id', allocationId).eq('purchase_order_item_id', itemId), parent.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);

  for (const move of resequenceAfterDelete(existing, allocationId)) {
    const { error: seqErr } = await scopeToCompanyId(sb.from('purchase_order_item_allocations')
      .update({ seq: move.seq }).eq('id', move.id).eq('purchase_order_item_id', itemId), parent.companyId);
    if (seqErr) break;
  }
  await recordAllocationAudit(sb, c, poId, `Line allocation removed: ${parent.item.item_code} ${allocationSubNumber(parent.poNumber, doomed.seq)}`, [
    { field: 'allocation', from: `${allocationSubNumber(parent.poNumber, doomed.seq)} qty ${doomed.qty}`, to: null },
    { field: 'allocationTarget', from: doomed.so_item_id ?? 'STOCK', to: null },
  ]);
  const map = await loadAllocationsForItems(sb, [itemId]);
  return c.json({ ok: true, allocations: map.get(itemId) ?? [] });
});

/* ── Per-line photos — read path (migration 0274) ──────────────────────
   Owner 2026-08-10: a PO raised from an SO carries the SO line's photos, so the
   PO detail must be able to SHOW them. The keys ride on the detail row
   (ITEM_COLS), and this endpoint trades one key for a short-lived signed R2 GET
   URL — the exact contract the SO side already uses
   (mfg-sales-orders.ts `/:docNo/items/:itemId/photos/:photoKey/signed`), so a
   client can drive both surfaces with one code path.

   Deliberately READ-ONLY. Photos are authored elsewhere — the SO upload route
   (`so-items/...` keys, copied here by the convert) and the AutoCount importer
   (`po-items/<po_number>/<po item id>/ac-<DtlKey>-<n>.jpg`, appended directly).
   Both land in the SAME bucket (SO_ITEM_PHOTOS), so this route signs either.

   AUTHZ is MEMBERSHIP, never key shape: the key must be listed in THIS line's
   photo_urls and the line must belong to THIS PO (and, unlike the SO route, to
   the active company). A guessed key signs nothing, and no prefix rule exists to
   lock out a producer — the importer's `po-items/...` keys are served unchanged.
   The SO endpoint is untouched: it validates against mfg_sales_order_items and
   would have had to be loosened to serve a PO line. */
export const poItemPhotoSignedHandler = async (c: any) => {
  const sb = c.get('supabase');
  const poId = c.req.param('id');
  const itemId = c.req.param('itemId');
  const photoKey = decodeURIComponent(c.req.param('photoKey'));

  const { data: item } = await scopeToCompany(sb
    .from('purchase_order_items')
    .select('purchase_order_id, photo_urls')
    .eq('id', itemId), c)
    .maybeSingle();
  if (!item) return c.json({ error: 'item_not_found' }, 404);
  const i = item as { purchase_order_id: string; photo_urls: string[] | null };
  if (i.purchase_order_id !== poId) return c.json({ error: 'item_doc_mismatch' }, 400);
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
        'po-item-photo',
        `/mfg-purchase-orders/${poId}/items/${itemId}`,
        photoKey,
        e,
      ),
    );
  }
};

mfgPurchaseOrders.get('/:id/items/:itemId/photos/:photoKey/signed', poItemPhotoSignedHandler);

export const poItemPhotoProxyHandler = async (c: any) => {
  const sb = c.get('supabase');
  const poId = c.req.param('id');
  const itemId = c.req.param('itemId');
  const photoKey = decodeURIComponent(c.req.param('photoKey'));

  if (!c.env.SO_ITEM_PHOTOS) {
    return c.json({ error: 'photo_bucket_not_configured' }, 500);
  }

  const { data: item } = await scopeToCompany(sb
    .from('purchase_order_items')
    .select('purchase_order_id, photo_urls')
    .eq('id', itemId), c)
    .maybeSingle();
  if (!item) return c.json({ error: 'item_not_found' }, 404);
  const i = item as { purchase_order_id: string; photo_urls: string[] | null };
  if (i.purchase_order_id !== poId) return c.json({ error: 'item_doc_mismatch' }, 400);
  if (!(i.photo_urls ?? []).includes(baseKeyOf(photoKey))) {
    return c.json({ error: 'photo_not_in_item' }, 404);
  }

  const obj = await c.env.SO_ITEM_PHOTOS.get(photoKey);
  if (!obj) return c.json({ error: 'photo_not_found_in_r2' }, 404);

  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'private, max-age=31536000, immutable',
    },
  });
};

mfgPurchaseOrders.get('/:id/items/:itemId/photos/:photoKey', poItemPhotoProxyHandler);

/* ── PR #78 — Convert from Sales Order ─────────────────────────────────
   Commander 2026-05-26 (AutoCount parity): "可以点击 Convert from Sales
   Order，也可以点击 Convert from Purchase Request 或者 Quotation 这种
   类型的". Copies an SO's items into the current draft PO. SO items
   keep their existing variants / description / pricing as snapshots.

   Body: { soDocNo: string, itemIds?: string[] }
   - When itemIds is omitted, every non-cancelled SO item is copied.
   - When provided, only those item ids get copied.
   - Skips SO items whose item_code is already on this PO (no dupes).
   - Returns count copied + skipped + the new PO item rows.
   ────────────────────────────────────────────────────────────────────── */
mfgPurchaseOrders.post('/:id/convert-from-so', async (c) => {
  const poId = c.req.param('id');
  let body: { soDocNo?: string; itemIds?: string[] } = {};
  try { body = (await c.req.json().catch(() => ({}))) as typeof body; } catch { }
  const soDocNo = (body.soDocNo ?? '').trim();
  if (!soDocNo) return c.json({ error: 'so_doc_no_required' }, 400);
  const filterIds = Array.isArray(body.itemIds) && body.itemIds.length > 0
    ? new Set(body.itemIds)
    : null;

  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: po, error: poErr } = await scopeToCompanyId(sb
    .from('purchase_orders')
    .select('id, status, supplier_id')
    .eq('id', poId), co.companyId)
    .maybeSingle();
  if (poErr) return c.json({ error: 'load_failed', reason: poErr.message }, 500);
  if (!po) return c.json(NOT_THIS_COMPANY, 404);
  if (po.status !== 'SUBMITTED' && po.status !== 'PARTIALLY_RECEIVED') {
    return c.json({ error: 'po_not_editable', reason: `Cannot convert into a ${po.status} PO.` }, 409);
  }

  const { data: soItems, error: soErr } = await scopeToCompany(sb
    .from('mfg_sales_order_items')
    .select('id, line_no, item_code, description, description2, item_group, qty, po_qty_picked, unit_price_sen, discount_sen, unit_cost_sen, variants, uom, remark, photo_urls')
    .eq('doc_no', soDocNo)
    .eq('cancelled', false), c);
  if (soErr) return c.json({ error: 'so_load_failed', reason: soErr.message }, 500);
  if (!soItems || soItems.length === 0) {
    return c.json({ error: 'so_has_no_items', reason: `Sales Order ${soDocNo} has no items to convert.` }, 404);
  }

  const wanted = filterIds
    ? (soItems as Array<{ id: string }>).filter((r) => filterIds!.has(r.id))
    : soItems;

  if (wanted.length === 0) {
    return c.json({ error: 'no_items_selected', reason: 'None of the picked SO items matched.' }, 400);
  }

  const codes = (wanted as Array<{ item_code: string }>).map((r) => r.item_code);
  const { data: existing } = await pgrestIn(sb
    .from('purchase_order_items')
    .select('item_code')
    .eq('purchase_order_id', poId), 'item_code', codes);
  const existingSet = new Set((existing ?? []).map((r: { item_code: string }) => r.item_code));

  type SoItem = {
    id: string;
    item_code: string; description: string | null; description2: string | null;
    item_group: string | null; qty: number; po_qty_picked: number | null;
    unit_price_sen: number;
    discount_sen: number | null; unit_cost_sen: number | null;
    variants: unknown; uom: string | null; remark: string | null;
    photo_urls: string[] | null; line_no: number | null;
  };
  const notOnPo = sortBySourceSoLine((wanted as SoItem[]).map((r) => ({ ...r, soDocNo, soLineNo: r.line_no })))
    .filter((r) => !existingSet.has(r.item_code));
  const toInsert = notOnPo.filter((r) => (Number(r.qty ?? 0) - Number(r.po_qty_picked ?? 0)) > 0);
  if (toInsert.length === 0) {
    return c.json({ copied: 0, skipped: wanted.length, reason: 'All matching SO items are already on a PO (or on this one).' });
  }

  const codesToPrice = toInsert.map((r) => r.item_code);
  type BindLite = {
    item_code: string; supplier_sku: string | null;
    unit_price_sen: number; price_matrix: Record<string, unknown> | null;
  };
  const bindByCode = new Map<string, BindLite>();
  if (codesToPrice.length > 0) {
    const { data: binds } = await readMfgProductBindings<BindLite>(sb, {
      codes: codesToPrice as string[],
      companyId: activeCompanyId(c),
      select: 'item_code, supplier_sku, unit_price_sen, price_matrix, is_main_supplier',
      supplierId: po.supplier_id as string,
    });
    for (const b of binds) {
      if (!bindByCode.has(b.item_code)) bindByCode.set(b.item_code, b);
    }
  }
  const { config: maintCfg } = await resolveMaintenanceConfigForSupplier(sb, po.supplier_id as string, activeCompanyId(c) ?? null);
  const fabCodes = [...new Set(
    toInsert
      .map((r) => String((r.variants as Record<string, unknown> | null)?.fabricCode ?? ''))
      .filter(Boolean),
  )];
  type FabTier = { sofa: MfgFabricTier | null; bedframe: MfgFabricTier | null };
  const tierByFabric = new Map<string, FabTier>();
  if (fabCodes.length > 0) {
    const { data: fabs } = await sb
      .from('fabric_trackings')
      .select('fabric_code, price_tier, sofa_price_tier, bedframe_price_tier')
      .in('fabric_code', fabCodes)
      .eq('company_id', activeCompanyId(c));
    for (const f of (fabs ?? []) as Array<{
      fabric_code: string; price_tier: MfgFabricTier | null;
      sofa_price_tier: MfgFabricTier | null; bedframe_price_tier: MfgFabricTier | null;
    }>) {
      tierByFabric.set(f.fabric_code, {
        sofa: f.sofa_price_tier ?? f.price_tier ?? null,
        bedframe: f.bedframe_price_tier ?? f.price_tier ?? null,
      });
    }
  }
  const supplierCostFor = (it: SoItem): { cost: number; supplierSku: string | null } => {
    const b = bindByCode.get(it.item_code);
    if (!b) return { cost: 0, supplierSku: null };
    const category = (it.item_group ?? '').toUpperCase() as
      'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'ACCESSORY' | 'SERVICE' | '';
    if (!category) return { cost: b.unit_price_sen, supplierSku: b.supplier_sku };
    const variants = (it.variants ?? {}) as Record<string, unknown>;
    const fc = String(variants.fabricCode ?? '');
    const ft = fc ? (tierByFabric.get(fc) ?? null) : null;
    const fabricTier = category === 'SOFA' ? (ft?.sofa ?? null)
      : category === 'BEDFRAME' ? (ft?.bedframe ?? null) : null;
    const cost = computeMfgPoUnitCost(
      {
        category,
        priceMatrix:    (b.price_matrix ?? null) as PoPriceMatrix,
        unitPriceSen: b.unit_price_sen,
        fabricTier,
        ...poVariantPricingInput(category, variants),
      },
      maintCfg ?? null,
    ).unitPriceSen;
    return { cost, supplierSku: b.supplier_sku };
  };

  const convertFrom = await nextPoLineNo(sb, poId);
  const rows = stampPoLineNos(toInsert.map((it) => {
    const remaining = Math.max(0, Number(it.qty ?? 0) - Number(it.po_qty_picked ?? 0));
    const { cost, supplierSku } = supplierCostFor(it);
    return {
      purchase_order_id: poId,
      material_kind:    'mfg_product',
      item_code:    it.item_code,
      material_name:    it.description ?? it.item_code,
      supplier_sku:     supplierSku,
      qty:              remaining,
      unit_price_sen: cost,
      line_total_sen: remaining * cost,
      received_qty:     0,
      notes:            it.remark ?? null,
      item_group:       it.item_group ?? null,
      description:      it.description ?? null,
      description2:     it.description2 ?? null,
      uom:              it.uom ?? 'UNIT',
      discount_sen:   0,
      unit_cost_sen:  cost,
      variants:         (it.variants as unknown) ?? null,
      so_item_id:       it.id,
      // Owner 2026-08-10 (migration 0274) — carry the SO line's photos, same as
      // the From-SO picker paths above.
      photo_urls:       it.photo_urls ?? [],
    };
  }), convertFrom);

  const { data: inserted, error: insErr } = await sb
    .from('purchase_order_items')
    .insert(stampCompany(rows, c))
    .select(ITEM_COLS);
  if (insErr) return c.json({ error: 'insert_failed', reason: insErr.message }, 500);

  await recomputePoTotals(sb, poId);
  try { await recomputeSoPicked(sb, toInsert.map((it) => it.id)); }
  catch { }

  await queueAcPoEdit(c, poId, [], ((inserted ?? []) as Array<{ id?: unknown }>).map((r) => String(r?.id ?? '')).filter(Boolean));

  return c.json({
    copied: rows.length,
    skipped: existingSet.size,
    sourceDocNo: soDocNo,
    items: inserted ?? [],
  });
});

/* Owner 2026-08-02 — a PO with no ship-to WAREHOUSE cannot go live. The
   receiving warehouse flows from the PO (grns.ts:442), so a warehouse-less PO
   receives into the default/China landing and its goods end up in the wrong
   place (the AKEMI/TRION-into-C&C-DISPLAY class). Block it at the source: a PO
   is missing its warehouse when the header purchase_location_id is blank AND at
   least one line has no warehouse_id of its own. Returns the offending line
   codes so the operator knows what to fix. */


export const confirmMfgPurchaseOrderHandler = async (c: any) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: cur, error: readErr } = await scopeToCompanyId(supabase
    .from('purchase_orders')
    .select('id, status, po_number, company_id, supplier_id, total_sen, currency')
    .eq('id', id), co.companyId)
    .maybeSingle();
  if (readErr) return c.json({ error: 'load_failed', reason: readErr.message }, 500);
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const curStatus = (cur as { status: string }).status;
  if (curStatus === 'SUBMITTED' || curStatus === 'PARTIALLY_RECEIVED') {
    return c.json({ purchaseOrder: { id, status: curStatus } });
  }
  if (curStatus !== 'DRAFT') {
    return c.json({ error: 'cannot_confirm', message: `Only a draft PO can be confirmed (this is ${curStatus})` }, 409);
  }

  /* Confirm gates (owner 2026-08-20): core variants + a ship-to warehouse, shown
     together, variant check fails CLOSED. See po-gates.ts. */
  const variantCheck = await poVariantGaps(supabase, id);
  if ('checkFailed' in variantCheck) return c.json(poVariantCheckFailedBody(variantCheck.checkFailed), 503);
  const gap = await poWarehouseGap(supabase, id);
  if (variantCheck.gaps.length > 0) return c.json(poVariantConfirmRefusal(variantCheck.gaps, gap), 422);
  if (gap.missing) return c.json(PO_WAREHOUSE_REQUIRED(gap.codes), 409);

  const { error: updErr } = await scopeToCompanyId(supabase
    .from('purchase_orders')
    .update({ status: 'SUBMITTED', submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id), co.companyId);
  if (updErr) return c.json({ error: 'confirm_failed', reason: updErr.message }, 500);

  {
    const po = cur as { po_number?: string | null; company_id?: number | null; supplier_id?: string | null; total_sen?: number | null; currency?: string | null };
    await recordEntityAudit(supabase, {
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      entityDocNo: po.po_number ?? null,
      action: 'POST',
      actor: c.get('houzsUser'),
      companyId: po.company_id ?? activeCompanyId(c),
      statusSnapshot: 'SUBMITTED',
      fieldChanges: compactChanges([
        ...statusChange('DRAFT', 'SUBMITTED'),
        fieldChange('supplierId', null, po.supplier_id ?? null),
        fieldChange('totalSen', null, Number(po.total_sen ?? 0)),
        fieldChange('currency', null, po.currency ?? null),
      ]),
    });
  }

  try {
    const { data: lines } = await supabase
      .from('purchase_order_items')
      .select('so_item_id')
      .eq('purchase_order_id', id);
    await recomputeSoPicked(supabase, ((lines ?? []) as Array<{ so_item_id: string | null }>).map((l) => l.so_item_id));
  } catch { }

  const { data: after } = await scopeToCompanyId(supabase
    .from('purchase_orders')
    .select('id, status, submitted_at')
    .eq('id', id), co.companyId)
    .maybeSingle();

  const { problems: acNotSent } = await enqueuePoCreate(supabase, {
    companyId: co.companyId,
    poId: id,
    createdBy: c.get('houzsUser')?.id ?? null,
  });

  return c.json({ purchaseOrder: after ?? { id, status: 'SUBMITTED' }, ...(acNotSent.length ? { acNotSent } : {}) });
};
mfgPurchaseOrders.patch('/:id/confirm', confirmMfgPurchaseOrderHandler);

mfgPurchaseOrders.post('/:id/send-to-supplier', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  let body: { pdfBase64?: unknown; message?: unknown } = {};
  try { body = (await c.req.json()) as typeof body; } catch { body = {}; }

  if (!(await isChannelEnabled(c.env, 'purchase_order'))) {
    return c.json({ error: 'channel_off', message: 'The purchase-order email channel is off. Turn it on in email settings to send.' }, 409);
  }

  const { data: po, error } = await scopeToCompanyId(supabase
    .from('purchase_orders')
    .select('id, po_number, revision, status, total_sen, currency, po_date, company_id, po_email_sent_at, po_email_sent_to, supplier:suppliers(name, email, email2, email3)')
    .eq('id', id), co.companyId)
    .maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!po) return c.json(NOT_THIS_COMPANY, 404);

  const row = po as unknown as PoEmailRow & {
    company_id?: number | null;
    po_email_sent_at?: string | null;
    po_email_sent_to?: string | null;
  };

  const statusRefusal = poSendRefusalForStatus(row.status);
  if (statusRefusal) return c.json({ error: 'not_sendable', message: statusRefusal }, 409);

  /* Recipients, checked as real addresses (the last point before an external
     send): To = Email, Cc = Email 2 / 3 (owner 2026-11-09, shared/supplier-emails.ts). */
  const recipients = resolvePoRecipients(row.supplier);
  if (!recipients.ok && recipients.error === 'no_supplier_email') {
    return c.json({ error: 'no_supplier_email', message: 'This supplier has no email address on file.' }, 400);
  }
  if (!recipients.ok) {
    return c.json({ error: 'bad_supplier_email',
      message: `The supplier's email address (${recipients.address}) is not a valid address. Fix it on the supplier record, then send again.` }, 400);
  }
  const supplierEmail = [recipients.to, ...recipients.cc].join(', ');

  const poNo = poEmailDocNo(row);
  const attachmentCheck = validatePoAttachment(body.pdfBase64, poNo);
  if (!attachmentCheck.ok) {
    return c.json({ error: 'bad_attachment', message: attachmentCheck.message }, 400);
  }

  const branding = await getBrandingForCompany(c.env, row.company_id ?? null);
  const note = typeof body.message === 'string' ? body.message : null;
  const msg = buildPurchaseOrderEmail(row, branding.companyName, note);
  if (!msg) {
    return c.json({ error: 'no_supplier_email', message: 'This supplier has no usable email address on file.' }, 400);
  }

  const claimedAt = new Date().toISOString();
  const windowStart = new Date(Date.now() - PO_RESEND_WINDOW_MS).toISOString();
  const previousSentAt = row.po_email_sent_at ?? null;
  const previousSentTo = row.po_email_sent_to ?? null;

  const { data: claimed } = await scopeToCompanyId(supabase
    .from('purchase_orders')
    .update({ po_email_sent_at: claimedAt, po_email_sent_to: supplierEmail })
    .eq('id', id), co.companyId)
    .or(`po_email_sent_at.is.null,po_email_sent_at.lt.${windowStart}`)
    .select('id')
    .maybeSingle();
  if (!claimed) {
    return c.json({
      error: 'already_sending',
      message: 'This PO was just emailed to the supplier. Wait a moment before sending it again.',
    }, 409);
  }

  const res = await sendEmail(c.env, {
    to: msg.to,
    cc: msg.cc.length ? msg.cc : null,
    subject: msg.subject,
    html: msg.html,
    replyTo: poReplyTo(c.get('houzsUser')),
    purpose: 'purchase_order',
    refType: 'purchase_order',
    companyCode: row.company_id != null ? String(row.company_id) : null,
    attachments: attachmentCheck.attachment ? [attachmentCheck.attachment] : undefined,
    outboxRetry: attachmentCheck.attachment == null,
  });

  if (res.status !== 'sent') {
    await scopeToCompanyId(supabase
      .from('purchase_orders')
      .update({ po_email_sent_at: previousSentAt, po_email_sent_to: previousSentTo })
      .eq('id', id), co.companyId)
      .eq('po_email_sent_at', claimedAt);
  }

  await recordEntityAudit(supabase, {
    entityType: 'PURCHASE_ORDER',
    entityId: id,
    entityDocNo: row.po_number ?? null,
    action: 'SEND',
    actor: c.get('houzsUser'),
    companyId: row.company_id ?? activeCompanyId(c),
    statusSnapshot: row.status ?? null,
    fieldChanges: compactChanges([
      fieldChange('emailedTo', previousSentTo, supplierEmail),
      fieldChange('emailStatus', null, res.status),
      fieldChange('emailAttachment', null, attachmentCheck.attachment ? 'PDF' : 'summary only'),
      ...(res.status === 'sent' ? [] : [fieldChange('emailError', null, res.reason ?? null)]),
    ]),
    note: res.status === 'sent'
      ? `Purchase Order emailed to ${supplierEmail}`
      : `Purchase Order email to ${supplierEmail} did not go out`,
  });

  return c.json({ sent: res.status === 'sent', result: res, to: supplierEmail });
});

export const cancelPurchaseOrderHandler = async (c: any) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: cur, error: readErr } = await scopeToCompanyId(supabase
    .from('purchase_orders').select('id, status, po_number, company_id, total_sen')
    .eq('id', id), co.companyId).maybeSingle();
  if (readErr) return c.json({ error: 'load_failed', reason: readErr.message }, 500);
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const curStatus = (cur as { status: string }).status;
  if (curStatus === 'RECEIVED') return c.json({ error: 'cannot_cancel', message: 'PO already received' }, 409);
  if (curStatus === 'CANCELLED') return c.json({ purchaseOrder: { id, status: 'CANCELLED' } });

  const childLock = await poHasDownstream(supabase, id);
  if (childLock) return c.json(childLock, 409);

  const dropshipLock = await poHasOutstandingDropshipOut(
    supabase, (cur as { po_number?: string | null }).po_number);
  if (dropshipLock) return c.json(dropshipLock, 409);

  const { data: updRow, error: updErr } = await scopeToCompanyId(supabase
    .from('purchase_orders')
    .update({ status: 'CANCELLED', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id).neq('status', 'CANCELLED'), co.companyId).select('id').maybeSingle();
  if (updErr) return c.json({ error: 'cancel_failed', reason: updErr.message }, 500);
  if (!updRow) return c.json({ purchaseOrder: { id, status: 'CANCELLED' } });

  {
    const po = cur as { po_number?: string | null; company_id?: number | null; total_sen?: number | null };
    await recordEntityAudit(supabase, {
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      entityDocNo: po.po_number ?? null,
      action: 'CANCEL',
      actor: c.get('houzsUser'),
      companyId: po.company_id ?? activeCompanyId(c),
      statusSnapshot: 'CANCELLED',
      fieldChanges: compactChanges([
        ...statusChange(curStatus, 'CANCELLED'),
        fieldChange('totalSen', null, Number(po.total_sen ?? 0)),
      ]),
    });
    await releaseRequestFromCancelledPo(supabase, co.companyId, { id, po_number: po.po_number ?? null }, c.get('houzsUser'));
  }

  /* Commander 2026-05-29 (BUG 1) — "cancel 了之后 代表这些 SO 有释放出来了是吧":
     YES. Cancelling a PO releases EVERY converted SO line's quota back so they
     reappear in the From-SO picker (mirrors the per-line delete release).
     Read each line's so_item_id + qty, then decrement po_qty_picked (clamped
     ≥ 0). Best-effort — never fail the cancel on a counter roll-back. */
  try {
    const { data: lines } = await supabase
      .from('purchase_order_items')
      .select('id, so_item_id')
      .eq('purchase_order_id', id);
    const lineRows = (lines ?? []) as Array<{ id: string; so_item_id: string | null }>;
    await recomputeSoPicked(supabase, lineRows.map((l) => l.so_item_id));

    const poItemIds = lineRows.map((l) => l.id).filter(Boolean);
    if (poItemIds.length > 0) {
      await scopeToCompanyId(supabase
        .from('purchase_order_item_allocations')
        .delete()
        .in('purchase_order_item_id', poItemIds), co.companyId);
    }
  } catch { }

  const { data: after } = await scopeToCompanyId(supabase
    .from('purchase_orders').select('id, status, cancelled_at, po_number')
    .eq('id', id), co.companyId).maybeSingle();

  await enqueueCancel(supabase, {
    companyId: co.companyId,
    docType: 'PO',
    docNo: (after as { po_number?: string } | null)?.po_number ?? id,
    docId: id,
    self: { table: 'purchase_orders', keyCol: 'id', key: id },
    createdBy: c.get('houzsUser')?.id ?? null,
  });

  deferMrpSnapshotRefresh(c, supabase, co.companyId, 'po-cancel');
  return c.json({ purchaseOrder: after ?? { id, status: 'CANCELLED' } });
};
mfgPurchaseOrders.patch('/:id/cancel', cancelPurchaseOrderHandler);

mountHoldRoute(mfgPurchaseOrders, 'po');

/* Reopen — the inverse of cancel (Commander 2026-06-16: "PO cancel 了,不可以
   uncancel 回来吗?"). Only a CANCELLED PO can be reopened; it returns to
   SUBMITTED and its converted SO lines RE-CLAIM their quota. Same
   read → guard → update → re-read split as cancel so the RETURNING-coercion
   PGRST116 can't 500 it. A cancellable PO never has a GRN (poHasDownstream
   blocks cancel once one exists), so a CANCELLED PO was always SUBMITTED —
   reopening to SUBMITTED is correct. */
mfgPurchaseOrders.patch('/:id/reopen', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: cur, error: readErr } = await scopeToCompanyId(supabase
    .from('purchase_orders')
    .select('id, status, po_number, company_id, linked_ac_docno')
    .eq('id', id), co.companyId)
    .maybeSingle();
  if (readErr) return c.json({ error: 'load_failed', reason: readErr.message }, 500);
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const curStatus = (cur as { status: string }).status;

  const acDocNo = (cur as { linked_ac_docno?: string | null }).linked_ac_docno;
  if (curStatus === 'CANCELLED' && acDocNo) {
    return c.json({
      error: 'cancel_is_final',
      message: 'This purchase order was cancelled in AutoCount too, and AutoCount has no '
        + 'un-cancel. Raise a new purchase order instead.',
      acDocNo,
    }, 409);
  }
  if (curStatus === 'SUBMITTED' || curStatus === 'PARTIALLY_RECEIVED') {
    return c.json({ purchaseOrder: { id, status: curStatus } });
  }
  if (curStatus !== 'CANCELLED') {
    return c.json({ error: 'cannot_reopen', message: `Only a cancelled PO can be reopened (this is ${curStatus})` }, 409);
  }

  const gap = await poWarehouseGap(supabase, id);
  if (gap.missing) return c.json(PO_WAREHOUSE_REQUIRED(gap.codes), 409);

  const { error: updErr } = await scopeToCompanyId(supabase
    .from('purchase_orders')
    .update({ status: 'SUBMITTED', cancelled_at: null, submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id), co.companyId);
  if (updErr) return c.json({ error: 'reopen_failed', reason: updErr.message }, 500);

  {
    const po = cur as { po_number?: string | null; company_id?: number | null };
    await recordEntityAudit(supabase, {
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      entityDocNo: po.po_number ?? null,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: po.company_id ?? activeCompanyId(c),
      statusSnapshot: 'SUBMITTED',
      note: 'PO reopened',
      fieldChanges: statusChange('CANCELLED', 'SUBMITTED'),
    });
  }

  try {
    const { data: lines } = await supabase
      .from('purchase_order_items')
      .select('so_item_id')
      .eq('purchase_order_id', id);
    await recomputeSoPicked(supabase, ((lines ?? []) as Array<{ so_item_id: string | null }>).map((l) => l.so_item_id));
  } catch { }

  const { data: after } = await scopeToCompanyId(supabase
    .from('purchase_orders')
    .select('id, status, cancelled_at')
    .eq('id', id), co.companyId)
    .maybeSingle();
  deferMrpSnapshotRefresh(c, supabase, co.companyId, 'po-reopen');
  return c.json({ purchaseOrder: after ?? { id, status: 'SUBMITTED' } });
});

/* ── Delete: REMOVED (owner rule, 2026-08-11) ──────────────────────────────
   There was a DELETE /:id here that hard-purged a CANCELLED PO, header and
   lines, from the database. It is gone, and it must not come back.

   The owner's rule is 不可以删只可以 cancel — nothing is ever deleted, only
   cancelled. This endpoint was the one place in the purchase chain that broke
   it, and its own code said so: the audit row it wrote was documented as "the
   ONLY remaining evidence that the PO existed", with number, supplier and
   total snapshotted into field_changes precisely because nothing could be
   joined back to afterwards. An audit row that has to carry a copy of the
   document is not an audit trail, it is an obituary.

   It is also a cancel-divergence generator the moment AutoCount sync goes
   live. AutoCount keeps a cancelled PO; a purged one has no row to reconcile
   against, so the two systems disagree with no way to tell whether the ERP
   ever had that document. CANCELLED already achieves everything the delete was
   used for: the PO leaves every working list, releases its SO quota, and
   clears its allocation sub-lines. The only thing delete added was the loss of
   the record.

   NOT touched, deliberately: the create-time rollback deletes at :1342 and
   :2351. supabase-js has no transaction, so those compensating deletes are the
   ONLY thing standing between a failed line insert and a headerless orphan
   document. They remove a document that never successfully existed; this
   endpoint removed one that did.

   The SO equivalent (mfg-sales-orders.ts DELETE /:docNo) is DRAFT-only and
   stays: discarding a draft that was never confirmed is not deleting a
   business record, and it refuses anything else with so_not_draft ("A
   confirmed order must be cancelled, not deleted"). */
