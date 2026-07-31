// /delivery-orders-mfg — DO sent to customers (B2B sales side).
//
// Rebuilt 2026-05-29 as a faithful clone of the Sales Order API
// (apps/api/src/routes/mfg-sales-orders.ts): editable SO-style header,
// line-item CRUD, a payments ledger, a recomputeTotals rollup, and ROBUST +
// IDEMPOTENT inventory deduction on the first transition into any shipped
// state. The plain per-category rollup is copied from the SO recomputeTotals;
// the SO-only sofa-combo cost spread is deliberately NOT copied (DO lines
// arrive already costed from the SO).
//
// Mounted at '/delivery-orders-mfg' in apps/api/src/index.ts.

import { Hono } from 'hono';
import { z } from 'zod';
import { normalizePhone } from '../shared/phone';
import { buildVariantSummary } from '../shared';
import { orderSofaModuleRowsWithinBuilds, sortSoLinesByGroupRank } from '../shared/so-line-display';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { writeMovements, defaultWarehouseId } from '../lib/inventory-movements';
import { reconcileUncostedAfterIn } from '../lib/oversell-retrocost';
import { computeVariantKey, isServiceLine, type VariantAttrs } from '../shared';
import { syncSoDeliveredFromDo } from '../lib/so-delivery-sync';
import { findOverDeliveredSoItems } from '../lib/do-over-delivery';
import { maybeSendDeliveryOrderEmail } from '../lib/do-email';
import { warehouseLabel } from '../lib/warehouse-label';
import { todayMyt } from '../lib/my-time';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { escapeForOr, phoneSearchOrParts } from '../lib/postgrest-search';
import { resolveSalesScopeIds, salesDocOutOfScope } from '../lib/salesScope';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { scopeToCompany, scopeToAllowedCompanies, activeCompanyId, stampCompany, companyDocPrefix, companyCodeMap,
  isCrossCompanySource, crossCompanyConversionBlocked,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import type { getSupabaseService } from '../../db/supabase';
import { SO_CONVERT_HEADER, soHeaderToDoSource, missingSourceFields } from '../lib/so-to-do-fields';
import { canViewAllSales, canViewScmFinance } from '../lib/houzs-perms';
import { SO_ITEM_FINANCE_KEYS } from '../lib/finance-keys';
import { freezeShipCost } from '../lib/fulfillment-costing';
import { validateItemCodes, unknownItemCodeResponse } from '../lib/validate-item-codes';
import { checkStockAvailability, shortStockResponse, type StockShortage } from '../lib/check-stock-availability';
import { findSofaLinesWithoutCompleteBatch, sofaNoCompleteBatchResponse, findIncompleteSofaSets, sofaIncompleteSetResponse, detectSofaSoItemIds } from '../lib/sofa-batch-guard';
import { resolveExpectedBatchBySoItem, buildDropshipOffenders } from '../lib/dropship-batch';
import { planShipCommitments, type ShipLineFact } from '../lib/ship-commitment';
import { loadSofaBatchStock, sofaStockKey } from '../lib/sofa-set-coverage';
import { buildDoReversalRows } from '../lib/do-reversal';
import { currentDocNoByKey, type CurrentEvent } from '../lib/current-doc';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { recordSoAudit, type FieldChange } from '../lib/so-audit';
import { advanceSoGeneration } from '../lib/so-generation';
import { recordEntityAudit, diffFields, compactChanges, fieldChange } from '../lib/entity-audit';
import { markIdempotencyNoWrite } from '../../middleware/idempotency';

export const deliveryOrdersMfg = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryOrdersMfg.use('*', supabaseAuth);

/* ── Audit trail (migration 0139 / lib/entity-audit) ───────────────────────────
   Everything this file records is an edit to the DO itself, so the action is
   UPDATE throughout — including the line add / edit / delete. DELETE is reserved
   for destroying the DOCUMENT, and this file has no such path; using it for a
   line would tell a reader the delivery order was deleted when it was not. The
   line's identity travels in field_changes and the note.

   ── THIS FILE ALREADY WRITES ONE AUDIT ROW, AND IT IS NOT A DUPLICATE ──
   prepareSoAmendMirrorAudit (above) writes to the SALES ORDER's log
   (scm.mfg_so_audit_log, keyed by so_doc_no) when the DO PATCH mirrors the
   amend fields onto the parent SO. That records a change to the SO HEADER, on
   the SO's own timeline, and it is left exactly as it is. The rows added here
   record changes to the DELIVERY ORDER, in scm.entity_audit_log, keyed by the
   DO id. The two never describe the same write: amend_date_from_customer /
   amended_delivery_date / amend_reason are not DO columns at all — the PATCH
   strips them from `updates` before the DO update and applies them only to the
   SO. So a PATCH carrying both kinds of field produces two rows on two
   documents, which is what a reader of either timeline needs to see. */

/* The auditable DO header fields, camel (API) -> snake (column). Deliberately
   the same list the PATCH's own map uses. */
const DO_AUDIT_FIELDS: Array<[string, string]> = [
  ['debtorCode', 'debtor_code'], ['debtorName', 'debtor_name'], ['agent', 'agent'],
  ['salesLocation', 'sales_location'], ['ref', 'ref'], ['poDocNo', 'po_doc_no'],
  ['venue', 'venue'], ['venueId', 'venue_id'], ['branding', 'branding'],
  ['address1', 'address1'], ['address2', 'address2'],
  ['city', 'city'], ['state', 'state'], ['postcode', 'postcode'], ['phone', 'phone'],
  ['note', 'note'], ['notes', 'notes'],
  ['doDate', 'do_date'], ['currency', 'currency'],
  ['customerState', 'customer_state'], ['customerCountry', 'customer_country'],
  ['customerSoNo', 'customer_so_no'],
  ['customerDeliveryDate', 'customer_delivery_date'],
  ['expectedDeliveryAt', 'expected_delivery_at'],
  ['timeRange', 'time_range'], ['timeConfirmed', 'time_confirmed'],
  ['arrivalAt', 'arrival_at'], ['departureAt', 'departure_at'],
  ['shipoutDate', 'shipout_date'], ['customerDeliveredDate', 'customer_delivered_date'],
  ['etaArrivingPort', 'eta_arriving_port'], ['deliverySubstatus', 'delivery_substatus'],
  ['arrivesEmWarehouseDate', 'arrives_em_warehouse_date'],
  ['email', 'email'], ['customerType', 'customer_type'],
  ['salespersonId', 'salesperson_id'], ['buildingType', 'building_type'],
  ['driverId', 'driver_id'], ['driverName', 'driver_name'], ['vehicle', 'vehicle'],
  ['emergencyContactName', 'emergency_contact_name'],
  ['emergencyContactPhone', 'emergency_contact_phone'],
  ['emergencyContactRelationship', 'emergency_contact_relationship'],
];

const DO_AUDIT_SELECT =
  `id, do_number, status, company_id, ${DO_AUDIT_FIELDS.map(([, snake]) => snake).join(', ')}`;

/* The auditable LINE fields. The camel names are deliberate: unitCostCenti,
   lineCostCenti and lineMarginCenti are the exact keys AUDIT_FINANCE_FIELDS
   (lib/finance-keys) strips from field_changes, so recording a line's cost here
   is gated on read by the same rule that gates it on the detail payload.
   Spelling one of them differently would leak cost to every reader. */
const DO_LINE_AUDIT_FIELDS: Array<[string, string]> = [
  ['qty', 'qty'],
  ['unitPriceCenti', 'unit_price_centi'],
  ['discountCenti', 'discount_centi'],
  ['unitCostCenti', 'unit_cost_centi'],
  ['lineTotalCenti', 'line_total_centi'],
  ['itemCode', 'item_code'],
  ['itemGroup', 'item_group'],
  ['description', 'description'],
  ['uom', 'uom'],
  ['notes', 'notes'],
  ['rackId', 'rack_id'],
  ['lineDeliveryDate', 'line_delivery_date'],
];

/* CREATE was added after the header/crew/line pass, and it is recorded LATE for
   a reason. Both create paths write the DO header first and DELETE it again —
   on a failed line insert, and again when the post-insert race recheck finds
   this DO over-delivered an SO line. A CREATE row emitted at insert time would
   describe a delivery that never happened, against an SO whose remaining qty
   never moved. recordDoCreate re-reads the persisted row rather than echoing the
   payload, which makes that ordering self-enforcing: a rolled-back header reads
   back as nothing and no row is written.

   It is also recorded BEFORE the stock deduction and the SO-delivered sync, and
   that ordering is deliberate the other way round: those are best-effort and
   report their failures in the response rather than undoing the DO, so the
   document exists either way and its history must say so. */

/**
 * Record the CREATE of a DO that has SURVIVED its handler.
 *
 * Reads the row back rather than taking the caller's payload: the doc number is
 * minted server-side, the totals come off the lines, and a header a compensating
 * branch already deleted reads back as nothing.
 */
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
        'driver_id, driver_name, vehicle, local_total_centi')
      .eq('id', doId).maybeSingle();
    row = (data ?? null) as Record<string, unknown> | null;
  } catch { /* best-effort */ }
  if (!row) return; // rolled back (or unreadable): a CREATE row here would be a lie
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
      /* INTEGER SEN, straight off the column. */
      fieldChange('localTotalCenti', null, row.local_total_centi ?? null),
      fieldChange('lineCount', null, lineCount),
    ]),
  });
}

/* The DO's identity for an audit row written from a LINE handler, which has the
   line in hand but not the parent. Best-effort by design: the writer is
   fail-open, so an unresolved doc number costs the row its human key and
   nothing else. */
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

/* HC "Remark 4" delivery sub-status — the known values (mirrors the whitelist in
   the Delivery Planning /fields route + HC_SUBSTATUS_VALUES on the frontend). Blank
   ('' / null) always clears it. */
const HC_SUBSTATUS_VALUES = [
  'Pending Pickup', 'Done Shipout', 'Arrives EM Warehouse',
  'Done Delivered', 'Confirm', 'House Not Ready', 'Request Hold',
] as const;

/* ── SO amend-mirror audit (owner's History requirement) ─────────────────────
   The DO create/PATCH handlers mirror the amend fields (amend_date_from_customer
   / amended_delivery_date / amend_reason) onto the parent SO. Those are SO
   header writes, so the SO History timeline must show them with a field-level
   old→new diff. Reads the BEFORE values, returns a callback the caller invokes
   AFTER the mirror update succeeds. Best-effort throughout — never blocks the
   DO write. */
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
  } catch { /* best-effort — diff will show only the new values */ }
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

/* ── DO child-lock guard (Tier 2 — downstream lock) ─────────────────────────
   A DO locks (read-only — no line edit / no CANCELLED transition) once it has
   ANY non-cancelled Delivery Return (DR) OR Sales Invoice (SI) referencing it.
   Convert-to-DR / convert-to-SI is NOT gated by this: the DO can keep emitting
   children; only line MUTATIONS + the CANCELLED status transition are blocked,
   mirroring grnHasDownstream in apps/api/src/routes/grns.ts. Returns the
   blocking JSON, or null if the DO is free to edit. */
async function doHasDownstream(sb: any, doId: string): Promise<{ error: string; message: string } | null> {
  const [{ count: drCount }, { count: siCount }] = await Promise.all([
    sb.from('delivery_returns')
      .select('id', { head: true, count: 'exact' })
      .eq('delivery_order_id', doId)
      .neq('status', 'CANCELLED'),
    sb.from('sales_invoices')
      .select('id', { head: true, count: 'exact' })
      .eq('delivery_order_id', doId)
      .neq('status', 'CANCELLED'),
  ]);
  if ((drCount ?? 0) > 0 || (siCount ?? 0) > 0) {
    return { error: 'do_has_downstream', message: 'DO has a Delivery Return / Sales Invoice — delete or cancel it first to edit' };
  }
  return null;
}

/* Full DO header — mirrors the editable SO header shape. The pre-rebuild
   columns (driver / vehicle / pod / signature / m3 / dispatched-signed-
   delivered timestamps) stay; the SO-clone fields added in migration 0100
   (salesperson / payment-via-ledger / sales_location / customer_type /
   building_type / email / emergency contact / branding / venue / ref /
   per-category totals + costs) extend it. */
const HEADER =
  'id, do_number, so_doc_no, debtor_code, debtor_name, do_date, expected_delivery_at, ' +
  'customer_delivery_date, signed_at, delivered_at, dispatched_at, ' +
  'driver_id, driver_name, vehicle, m3_total_milli, ' +
  'address1, address2, city, state, postcode, phone, ' +
  'salesperson_id, agent, email, customer_type, building_type, branding, venue, venue_id, ref, ' +
  'customer_so_no, po_doc_no, sales_location, customer_state, customer_country, note, ' +
  'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, ' +
  'mattress_sofa_centi, bedframe_centi, accessories_centi, others_centi, service_centi, ' +
  'mattress_sofa_cost_centi, bedframe_cost_centi, accessories_cost_centi, others_cost_centi, service_cost_centi, ' +
  'local_total_centi, total_cost_centi, total_margin_centi, margin_pct_basis, line_count, ' +
  'currency, warehouse_id, is_dropship, ' +
  /* Mig 0053 (port of 2990 0199) — DO-execution column: the date the goods
     arrive at the EM (East-Malaysia) holding warehouse on a sea-freight
     route. Surfaced read-only on the SO Detail mirror card and editable on
     the Delivery Planning board's /fields PATCH; the DO Detail GET / POST /
     PATCH must carry it too so the DO drawer can show + save it. */
  'arrives_em_warehouse_date, ' +
  'pod_r2_key, signature_data, status, notes, created_at, created_by, updated_at';

/* FINANCE-GATED header keys — cost / margin / per-category revenue+cost
   subtotals. All are in HEADER (so they travel in the DO list payload) but must
   reach ONLY a finance-viewer (lib/houzs-perms.canViewScmFinance). Stripped from
   every row for a non-finance caller. The DO total shown to everyone
   (local_total_centi) is deliberately NOT listed here. */
const DO_FINANCE_KEYS = [
  'mattress_sofa_centi', 'bedframe_centi', 'accessories_centi', 'others_centi', 'service_centi',
  'mattress_sofa_cost_centi', 'bedframe_cost_centi', 'accessories_cost_centi', 'others_cost_centi', 'service_cost_centi',
  'total_cost_centi', 'total_margin_centi', 'margin_pct_basis',
] as const;

/* KEPT LOCAL, deliberately — do NOT "converge" DO_FINANCE_KEYS onto
   SO_FINANCE_KEYS. It is the finance-shaped subset of THIS file's HEADER select.
   The DO carries service_centi / service_cost_centi (it delivers service lines)
   but NOT deposit_centi — a deposit is taken on the ORDER, not on the delivery,
   which is why SO_FINANCE_KEYS gates deposit and this list has nothing to gate.
   Importing the SO's list would make this gate depend on a vocabulary this
   document does not speak. The per-LINE keys ARE shared: byte-identical across
   all seven sales documents, so they live in lib/finance-keys
   (SO_ITEM_FINANCE_KEYS) and are imported above. */

const ITEM =
  'id, delivery_order_id, so_item_id, item_code, item_group, description, description2, ' +
  'uom, qty, m3_milli, unit_price_centi, discount_centi, line_total_centi, ' +
  'unit_cost_centi, line_cost_centi, line_margin_centi, variants, notes, ' +
  'line_delivery_date, line_delivery_date_overridden, rack_id, created_at, ' +
  /* Mig 0230 — the incoming PO batch this line shipped against before its goods
     arrived. Surfaced so the DO detail can say which PO a short line is bound to
     instead of leaving the operator to infer it from the header badge. */
  'committed_po_batch_no';

const PAYMENT_COLS =
  'id, delivery_order_id, paid_at, method, merchant_provider, installment_months, ' +
  'online_type, approval_code, amount_centi, account_sheet, collected_by, note, ' +
  'created_at, created_by';

/* scm.delivery_order_crew columns (created in migration 0053) — the FK ids + the
   assign-time name/ic/contact/plate snapshot. Read on the DO detail + returned
   by PUT /:id/crew. */
const crewSnapshotCols =
  'id, do_id, driver_1_id, driver_2_id, helper_1_id, helper_2_id, lorry_id, ' +
  'driver_1_name, driver_1_ic, driver_1_contact, driver_2_name, driver_2_ic, driver_2_contact, ' +
  'helper_1_name, helper_1_contact, helper_2_name, helper_2_contact, lorry_plate, ' +
  'assigned_at, assigned_by, updated_at';

/* DO statuses that count as "shipped" — goods have left our hands, so stock
   has been deducted. The FIRST transition into ANY of these fires the
   inventory OUT. Kept here as one list so deduction is robust no matter how
   the status is advanced (DISPATCHED step-by-step, or a jump to SIGNED). */
const SHIPPED_STATES = ['DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED'];

/* ── DO status vocabulary + legal-transition guard (audit gap #4) ──────────────
   The full set of raw delivery_orders.status values (union of DO_STATUS_BUCKETS +
   SHIPPED_STATES + the create paths). The PATCH /:id/status handler historically
   wrote body.status VERBATIM (only the CANCELLED edge was guarded), so a caller
   could post an unknown value, or fall a shipped DO back to a pre-ship status —
   e.g. DELIVERED→DRAFT — which leaves the stock OUT movement standing (a plain
   status write never reverses it) while the DO reads un-shipped. */
const DO_STATUSES = new Set([
  'DRAFT', 'LOADED', 'DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED',
  'COMPLETED', 'CANCELLED',
]);
/* Pre-ship statuses — no stock has left our hands yet. */
const DO_PRESHIP_STATUSES = new Set(['DRAFT', 'LOADED']);
/* Statuses in which the inventory OUT has already been written. Once a DO is in
   any of these, its stock is deducted, so it must NOT drop back to a pre-ship
   status (the OUT would be orphaned). COMPLETED sits past INVOICED, so goods
   have certainly shipped — include it alongside SHIPPED_STATES. */
const DO_STOCK_OUT_STATUSES = new Set([...SHIPPED_STATES, 'COMPLETED']);

const nextNum = async (sb: any, c: any, prefixOverride?: string): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  // prefixOverride lets the caller mint under a company OTHER than the active one
  // (Delivery-Planning convert stamps the SOURCE SO's company). Falls back to the
  // active company's prefix for the normal same-company paths.
  const p = prefixOverride ?? companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'delivery_orders', 'do_number', `${p}DO-${yymm}`);
};

/* Re-derive the DO header's per-category revenue/cost totals + grand total
   from its line items. Mirrors the SO recomputeTotals plain per-category
   rollup (NO sofa-combo cost spread — DO lines arrive already costed). Called
   after every item mutation.

   Fails CLOSED and never throws (2026-07-17) — same contract as the SO's
   recomputeTotals (mfg-sales-orders.ts), which carries the full rationale: a
   read it cannot vouch for must not become a written total, and it aborts by
   LOGGING because this roll-up only runs AFTER its triggering line write has
   committed (a throw becomes a 500 the client retries into a duplicate line).
   See BUG-HISTORY 2026-07-17 (fix/zeroing-twins). */
async function recomputeTotals(sb: any, deliveryOrderId: string) {
  const { data: items, error: itemsErr } = await sb.from('delivery_order_items')
    .select('item_code, item_group, line_total_centi, line_cost_centi')
    .eq('delivery_order_id', deliveryOrderId);
  /* A failed READ is not an empty DO, and `?? []` cannot tell them apart — it
     folded a transient blip into a ZERO header on a DO whose lines were intact,
     which then propagates: the Sales Invoice copies its costs from the DO. The
     ERROR is the signal, never the emptiness: a genuinely empty DO resolves
     error === null with data === [] and MUST still fall through to zero. */
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[do-recompute] item read failed — header left unchanged:', deliveryOrderId, itemsErr.message);
    return;
  }
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, service = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0, serviceCost = 0;
  for (const it of (items ?? []) as Array<{ item_code: string | null; item_group: string | null; line_total_centi: number | null; line_cost_centi: number | null }>) {
    const lineTotal = Number(it.line_total_centi ?? 0);
    const lineCost  = Number(it.line_cost_centi ?? 0);
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.item_group ?? '').toLowerCase();
    /* SO-SKU spec P2 (D1, migration 0155) — SERVICE lines ride the DO
       (D2 final) and bucket separately, never into "others". */
    if (isServiceLine({ itemGroup: g, itemCode: it.item_code })) { service += lineTotal; serviceCost += lineCost; }
    else if (g.includes('mattress') || g.includes('sofa')) { mattressSofa += lineTotal; mattressSofaCost += lineCost; }
    else if (g.includes('bedframe')) { bedframe += lineTotal; bedframeCost += lineCost; }
    else if (g.includes('accessor')) { accessories += lineTotal; accessoriesCost += lineCost; }
    else { others += lineTotal; othersCost += lineCost; }
  }
  const margin = total - totalCost;
  const { error: updErr } = await sb.from('delivery_orders').update({
    mattress_sofa_centi: mattressSofa,
    bedframe_centi: bedframe,
    accessories_centi: accessories,
    others_centi: others,
    service_centi: service,
    mattress_sofa_cost_centi: mattressSofaCost,
    bedframe_cost_centi: bedframeCost,
    accessories_cost_centi: accessoriesCost,
    others_cost_centi: othersCost,
    service_cost_centi: serviceCost,
    local_total_centi: total,
    total_cost_centi: totalCost,
    total_margin_centi: margin,
    margin_pct_basis: total > 0 ? Math.round((margin / total) * 10000) : 0,
    line_count: (items ?? []).length,
    updated_at: new Date().toISOString(),
  }).eq('id', deliveryOrderId);
  /* The write's own result was discarded until 2026-07-17: a rejected UPDATE left
     the header STALE with nothing logged and every caller reporting success. */
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[do-recompute] header update failed — totals left STALE:', deliveryOrderId, updErr.message);
  }
}

/* ── restampDoActualCost (Costing C, Commander 2026-06-01) ────────────────────
   Replace a shipped DO's line costs — copied from the SO Product-Maintenance
   BENCHMARK at build time — with the REAL FIFO cost the inventory trigger booked
   when the goods left. The SO keeps the benchmark (a reference snapshot); the DO
   — and the Sales Invoice that copies the DO — now carry the ACTUAL cost, so
   Margin reflects reality and the commander can compare order-time benchmark vs
   ship-time actual.

   actual unit cost per bucket = net OUT cost ÷ net OUT qty across THIS DO's own
   movements (ship OUT + any resync delta IN/OUT), matched to each line by
   (warehouse, product, variant, batch). A bucket with no booked cost yet (GR
   received with NO price and no Purchase Invoice) reads 0 for now — Stage A will
   surface that as "Pending"; Stage B re-runs this stamp when a price correction
   re-costs the lots, so the DO/Invoice cost reflects the fix in real time.

   Only SHIPPED DOs have OUT movements; un-shipped DOs keep the benchmark. A
   bucket with net_qty ≤ 0 (line fully returned/reversed) is left untouched.
   Best-effort: never throws into the caller (audit-DLQ pattern).

   EXPORTED (Costing B, 2026-06-01) so the recost engine (apps/api/src/lib/
   recost.ts) can re-run it after a PI/GR price correction re-costs the lots. */
/* ── resolveShipCommitments (2026-07-31) ──────────────────────────────────────
   THE ONE PLACE a ship decides whether it is binding an incoming PO.

   Owner's rule: "when they pick ship-anyway, that matched PO should be bound and
   go negative against it." So binding follows the FACT that the line resolves a
   PO — it is not a second question after the drop-ship dialog, and it is not
   gated on the DO header's is_dropship flag (which mig 0057 defines as the UI
   badge). The decision table itself is PURE and unit-tested in
   scm/lib/ship-commitment.ts; this helper only gathers the four facts it needs:

     · isSofa            — detectSofaSoItemIds (the same detector the cost paths use)
     · allocatedBatchNo  — mfg_sales_order_items.allocated_batch_no (a RECEIVED batch)
     · expectedBatchNo   — resolveExpectedBatchBySoItem in 'block' mode, so a line
                           bound to >1 live PO (audit H3) resolves to null and
                           binds NOTHING rather than guessing a dye lot
     · availableQty      — from the shortage list the short-stock guard just
                           produced, so the binding cannot disagree with the
                           question the operator was asked

   Returns lineRef -> the binding for the lines that bind (batch + ETA, so the
   ONE dialog the operator sees can name the incoming PO). Best-effort
   throughout: any read failure yields no commitments, i.e. exactly today's
   behaviour (ship, no binding) — a binding lookup must never block a shipment. */
type ShipCandidateLine = {
  lineRef: string;
  soItemId: string | null;
  itemCode: string;
  itemGroup: string | null;
  variantKey: string;
  qty: number;
};

type ShipBinding = { itemCode: string; poNumber: string; eta: string | null };

async function resolveShipCommitments(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  lines: ShipCandidateLine[],
  warehouseId: string | null,
  shortages: StockShortage[],
): Promise<Map<string, ShipBinding>> {
  const out = new Map<string, ShipBinding>();
  const linked = lines.filter((l) => l.soItemId && Number(l.qty) > 0);
  if (linked.length === 0) return out;
  try {
    const soItemIds = [...new Set(linked.map((l) => l.soItemId as string))];

    const [sofaIds, expected, allocRes] = await Promise.all([
      detectSofaSoItemIds(sb, linked.map((l) => ({
        itemCode: l.itemCode, itemGroup: l.itemGroup, soItemId: l.soItemId,
      }))),
      /* 'block', not 'latest': a NEW commitment must never be guessed. A line
         bound to two live POs resolves to null here and ships unbound, which is
         what the drop-ship offer path already does (audit H3). */
      resolveExpectedBatchBySoItem(sb, soItemIds, { onMultiPo: 'block' }),
      sb.from('mfg_sales_order_items').select('id, allocated_batch_no').in('id', soItemIds),
    ]);
    const allocated = new Map<string, string | null>(
      (((allocRes as { data?: Array<{ id: string; allocated_batch_no: string | null }> }).data ?? []))
        .map((r) => [r.id, r.allocated_batch_no ?? null]),
    );

    /* The short-stock guard reports only the buckets that are SHORT, with what
       was on hand. A bucket it did not report is covered, so anything > 0 marks
       it "stock on hand" for the decision table. */
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
      expectedBatchNo: (l.soItemId ? expected.get(l.soItemId)?.poNumber : null) ?? null,
      availableQty: availableByBucket.get(`${l.itemCode}::${l.variantKey}`) ?? Number(l.qty),
      shipQty: Number(l.qty),
    }));

    for (const d of planShipCommitments(facts)) {
      if (!d.bind || !d.batchNo) continue;
      out.set(d.lineRef, {
        itemCode: d.itemCode,
        poNumber: d.batchNo,
        eta: (d.soItemId ? expected.get(d.soItemId)?.eta : null) ?? null,
      });
    }
  } catch (e) {
    /* eslint-disable-next-line no-console */
    console.error('[ship-commitment] resolve failed (shipping unbound):', e);
    return new Map();
  }
  return out;
}

/** Distinct incoming-PO bindings, for the "ship anyway?" dialog. */
const bindingList = (m: Map<string, ShipBinding>): ShipBinding[] => {
  const byKey = new Map<string, ShipBinding>();
  for (const b of m.values()) byKey.set(`${b.poNumber}::${b.itemCode}`, b);
  return [...byKey.values()];
};

/* ── resolveDoSofaBatchMap (Audit fix C1, 2026-07-13) ─────────────────────────
   SHARED sofa-batch resolution for every inventory seam of a DO — the single
   "which batch_no does each SO line's movement carry?" answer. Three sources,
   in precedence order:
     1. mfg_sales_order_items.allocated_batch_no — the allocator's lock, set
        once a covering batch is PHYSICALLY received (normal ship).
     2. delivery_order_items.committed_po_batch_no (mig 0230) — the STORED
        ship-before-arrival commitment, decided at ship time by
        planShipCommitments. This is the answer for every DO created from
        2026-07-31 on, sofa or not, and it does not depend on the header flag.
     3. Drop-ship (mig 0057) — the LEGACY fallback for DOs created before the
        marker existed: an is_dropship sofa line shipped BEFORE receipt, so the
        allocator never locked a batch; re-resolve its EXPECTED batch (= the
        bound live PO number). Kept so an old drop-ship DO keeps resolving the
        same bucket its OUT was stamped with.
   Previously deductInventoryForDo / restampDoActualCost each had their own
   copy of this logic while resyncInventoryForDo only knew source 1 — so the
   add-line / qty-increase PATCH paths wrote a drop-ship OUT UN-BATCHED (plain
   FIFO ate other lots, the receipt-time reconcile never matched it, COGS stayed
   0 forever). One helper, three callers, no drift. Best-effort throughout:
   absent columns → fewer batches → un-batched movement (never throws). */
async function resolveDoSofaBatchMap(
  sb: any,
  items: Array<{
    so_item_id?: string | null; item_code: string; item_group?: string | null;
    committed_po_batch_no?: string | null;
  }>,
  isDropship: boolean,
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
  } catch { /* column absent pre-0121 — no allocator batches */ }
  /* Source 2 (mig 0230) — the STORED per-line commitment. Decided once, at ship
     time, by planShipCommitments and written onto the DO line; every later seam
     (resync delta, restamp, recost) reads that stored answer instead of
     re-deriving it, so a PO cancelled or added AFTER the ship can never move the
     bucket an OUT was already stamped with. The allocator's physically-received
     batch still wins — if it is set, the line was not shipping short. */
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
      const sofaSoIds = await detectSofaSoItemIds(sb, sofaRows);
      if (sofaSoIds.size > 0) {
        /* 'latest' (default) — movement paths must stay deterministic even in
           the rare multi-PO window so a resync delta lands in the SAME bucket
           the original OUT was stamped with. New drop-ship APPROVALS block on
           multi-PO separately (buildDropshipOffenders, audit H3). */
        const expected = await resolveExpectedBatchBySoItem(sb, [...sofaSoIds]);
        for (const [sid, eb] of expected) if (eb.poNumber) batchBySoItem.set(sid, eb.poNumber);
      }
    }
  }
  return batchBySoItem;
}

export async function restampDoActualCost(sb: any, deliveryOrderId: string) {
  try {
    /* Forward-compat (mig 0057): is_dropship column may not exist yet — retry without it. */
    let hdrRes = await sb.from('delivery_orders')
      .select('status, warehouse_id, is_dropship').eq('id', deliveryOrderId).maybeSingle();
    if (hdrRes.error && (hdrRes.error.message ?? '').includes('is_dropship')) {
      hdrRes = await sb.from('delivery_orders')
        .select('status, warehouse_id').eq('id', deliveryOrderId).maybeSingle();
    }
    const doHeader = hdrRes.data;
    if (!doHeader) return;
    const status = ((doHeader as { status: string | null }).status ?? '').toUpperCase();
    if (!SHIPPED_STATES.includes(status)) return; // no OUT yet → keep benchmark
    const headerWarehouseId = (doHeader as { warehouse_id: string | null }).warehouse_id ?? null;
    const isDropship = (doHeader as { is_dropship?: boolean }).is_dropship === true;

    const { data: items } = await sb.from('delivery_order_items')
      .select('id, so_item_id, item_code, qty, item_group, variants, line_total_centi, ship_cost_centi, committed_po_batch_no')
      .eq('delivery_order_id', deliveryOrderId);
    if (!items || items.length === 0) return;

    const lineWh = await resolveDoLineWarehouses(
      sb, items as Array<{ id: string; so_item_id?: string | null }>, headerWarehouseId);

    /* Sofa batch per so_item — same shared resolution the ship used
       (allocated_batch_no + drop-ship expected batch), so the bucket key here
       always matches the OUT movement and a drop-ship line picks up the
       arriving lot's real cost after the receipt-time reconcile (C1 helper). */
    const batchBySoItem = await resolveDoSofaBatchMap(
      sb,
      items as Array<{ so_item_id?: string | null; item_code: string; item_group?: string | null }>,
      isDropship,
    );
    const batchAware = batchBySoItem.size > 0;

    // Net actual cost per (warehouse, product, variant, batch) bucket.
    const movSelect = batchAware
      ? 'movement_type, warehouse_id, product_code, variant_key, batch_no, qty, total_cost_sen'
      : 'movement_type, warehouse_id, product_code, variant_key, qty, total_cost_sen';
    const { data: movs } = await sb.from('inventory_movements')
      .select(movSelect)
      .eq('source_doc_type', 'DO')
      .eq('source_doc_id', deliveryOrderId);
    type Agg = { net_qty: number; net_cost: number };
    const aggByBucket = new Map<string, Agg>();
    for (const m of (movs ?? []) as Array<{
      movement_type: string; warehouse_id: string; product_code: string;
      variant_key: string | null; batch_no?: string | null; qty: number; total_cost_sen: number | null;
    }>) {
      const k = `${m.warehouse_id}::${m.product_code}::${m.variant_key ?? ''}::${m.batch_no ?? ''}`;
      let agg = aggByBucket.get(k);
      if (!agg) { agg = { net_qty: 0, net_cost: 0 }; aggByBucket.set(k, agg); }
      const q = Number(m.qty ?? 0);
      const cost = Number(m.total_cost_sen ?? 0);
      if (m.movement_type === 'OUT') { agg.net_qty += q; agg.net_cost += cost; }
      else if (m.movement_type === 'IN') { agg.net_qty -= q; agg.net_cost -= cost; }
    }

    // Restamp each line to its bucket's actual unit cost.
    for (const it of items as Array<{
      id: string; so_item_id?: string | null; item_code: string; qty: number;
      item_group?: string | null; variants?: VariantAttrs | null; line_total_centi: number | null;
      ship_cost_centi?: number | null;
    }>) {
      const warehouseId = lineWh.get(it.id) ?? null;
      if (!warehouseId) continue;
      const variantKey = computeVariantKey(it.item_group ?? null, it.variants ?? null);
      const batchNo = it.so_item_id ? (batchBySoItem.get(it.so_item_id) ?? null) : null;
      const k = `${warehouseId}::${it.item_code}::${variantKey}::${batchNo ?? ''}`;
      const agg = aggByBucket.get(k);
      if (!agg || agg.net_qty <= 0) continue; // no booked outflow — leave as-is
      const unitCost = Math.round(agg.net_cost / agg.net_qty);
      const qty = Number(it.qty ?? 0);
      const lineTotal = Number(it.line_total_centi ?? 0);
      const lineCost = unitCost * qty;
      const update: Record<string, number> = {
        unit_cost_centi: unitCost,
        line_cost_centi: lineCost,
        line_margin_centi: lineTotal - lineCost,
      };
      /* Freeze the ship-time FIFO unit cost ONCE (mig 0143). This path re-runs
         on line-set change and, via recost.ts, when a supplier PI lands — each
         re-run overwrites unit_cost_centi IN PLACE with the newest (landed)
         cost, which is what erases the ship-time ② and collapses it into ③.
         freezeShipCost writes ship_cost_centi only while it is still NULL, so
         the FIRST post-ship costing captures the true ② and every later recost
         leaves it untouched — the whole basis of the three-way Fulfillment
         Costing report. Nothing else about the cost numbers changes. */
      const shipFreeze = freezeShipCost(it.ship_cost_centi ?? null, unitCost);
      if (shipFreeze !== undefined) update.ship_cost_centi = shipFreeze;
      await sb.from('delivery_order_items').update(update).eq('id', it.id);
    }

    await recomputeTotals(sb, deliveryOrderId);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[restampDoActualCost] failed:', e); }
}

/* Deduct inventory for a DO exactly once. ROBUST: fires on the first
   transition into ANY shipped state (not only DISPATCHED). IDEMPOTENT: a
   pre-insert existence check on the DO id skips re-deduction, and the partial
   UNIQUE index uq_inv_mov_do_source (migration 0100) is the hard backstop
   against a race. Best-effort — a movement failure never rolls back the
   status change (audit-DLQ pattern, same as the rest of inventory-movements). */
/* ── resolveDoLineWarehouses (Agent D 2026-05-31, TASK #32) ───────────────────
   PER-WAREHOUSE CORRECTNESS for the OUTBOUND side. A DO line MUST deduct from
   the warehouse of the Sales Order LINE it delivers (mfg_sales_order_items.
   warehouse_id, migration 0118) — never a single DO-header default. A KL SO
   line must ship from KL stock even if the DO header (or the default) points at
   PG; stock never crosses warehouses (CLAUDE.md locked rule).

   Resolution order per DO line:
     1. the linked SO line's warehouse_id (so_item_id → mfg_sales_order_items)
     2. the DO header's warehouse_id (ad-hoc lines with no so_item_id)
     3. the global default warehouse (last-resort fallback)

   Returns a map of delivery_order_items.id → warehouse_id (or null when even
   the fallbacks are absent — the caller skips those lines so a wrong warehouse
   is never guessed). */
async function resolveDoLineWarehouses(
  sb: any,
  items: Array<{ id: string; so_item_id?: string | null }>,
  headerWarehouseId: string | null,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const soItemIds = [...new Set(items
    .map((it) => it.so_item_id ?? null)
    .filter((x): x is string => !!x))];
  const soWh = new Map<string, string | null>();
  if (soItemIds.length > 0) {
    const { data: soRows } = await sb.from('mfg_sales_order_items')
      .select('id, warehouse_id').in('id', soItemIds);
    for (const r of (soRows ?? []) as Array<{ id: string; warehouse_id: string | null }>) {
      soWh.set(r.id, r.warehouse_id ?? null);
    }
  }
  const fallback = headerWarehouseId ?? (await defaultWarehouseId(sb));
  for (const it of items) {
    const fromSo = it.so_item_id ? (soWh.get(it.so_item_id) ?? null) : null;
    out.set(it.id, fromSo ?? fallback);
  }
  return out;
}

/* warehouseCodeMap (Agent D 2026-05-31, TASK #32) — resolve a set of
   warehouse_ids to their display CODE so the detail GET can stamp a per-line
   Warehouse column. Read-only label lookup; never touches stock. */
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

/* Traceability (source-PO on a shipped DO line). Two ledger reads, unioned per
   (product_code, variant_key) bucket — the SAME bucket key the ship uses:

   1. This DO's OUT inventory movements' batch_no. Only SOFA lines carry a
      batch on the OUT (allocated_batch_no / drop-ship expected batch — see
      deductInventoryForDo: "non-sofa lines stay NULL → plain FIFO"), so this
      path alone covers sofa/drop-ship only.
   2. This DO's FIFO lot consumptions (inventory_lot_consumptions, written by
      fn_consume_fifo on every OUT) → the consumed lots' batch_no. GRN stamps
      batch_no = source PO number on EVERY received goods line (migration 0120),
      and the FIFO trigger copies it onto the lot — so this path recovers the
      source PO for plain-FIFO categories too (bed frame, mattress, accessories),
      which path 1 misses. This was the "Source PO blank for Bed Frame/Mattress"
      bug: those lines ship un-batched, but the lots they CONSUMED are batched.

   Best-effort: absent batch_no column, un-batched lots (opening balances /
   adjustments / pre-0120 stock) or negative-stock ships (no lot consumed) →
   empty set → the caller falls back to the SO line's bound PO, else a dash.
   Cancelled/reversed DOs carry a reversing IN row per OUT; we only read OUT
   rows/consumptions, so a fully reversed line still reports the PO(s) it
   originally shipped from (the shipment did happen).
   Returns a Map keyed `${product_code}::${variant_key}` → ordered PO numbers. */
async function resolveDoLineSourcePos(
  sb: any,
  deliveryOrderId: string,
): Promise<Map<string, string[]>> {
  const byBucket = new Map<string, Set<string>>();
  const add = (code: string, variantKey: string | null, batch: string | null) => {
    if (!batch) return;
    const k = `${code}::${variantKey ?? ''}`;
    const set = byBucket.get(k) ?? new Set<string>();
    set.add(batch);
    byBucket.set(k, set);
  };
  // 1. Batched OUT movements (sofa allocated batch / drop-ship expected batch).
  try {
    const { data: movs, error } = await sb.from('inventory_movements')
      .select('product_code, variant_key, batch_no')
      .eq('source_doc_type', 'DO')
      .eq('source_doc_id', deliveryOrderId)
      .eq('movement_type', 'OUT')
      .not('batch_no', 'is', null);
    if (!error) {
      for (const m of (movs ?? []) as Array<{ product_code: string; variant_key: string | null; batch_no: string | null }>) {
        add(m.product_code, m.variant_key, m.batch_no);
      }
    }
  } catch { /* column/table absent — fall through to the consumption path */ }
  // 2. FIFO lot consumptions → consumed lots' batch_no (plain-FIFO categories).
  try {
    const { data: cons } = await sb.from('inventory_lot_consumptions')
      .select('lot_id, product_code, variant_key')
      .eq('source_doc_type', 'DO')
      .eq('source_doc_id', deliveryOrderId);
    const consRows = (cons ?? []) as Array<{ lot_id: string; product_code: string; variant_key: string | null }>;
    const lotIds = [...new Set(consRows.map((r) => r.lot_id).filter(Boolean))];
    if (lotIds.length > 0) {
      const { data: lots } = await sb.from('inventory_lots')
        .select('id, batch_no')
        .in('id', lotIds)
        .not('batch_no', 'is', null);
      const batchByLot = new Map(
        ((lots ?? []) as Array<{ id: string; batch_no: string | null }>).map((l) => [l.id, l.batch_no]),
      );
      for (const r of consRows) {
        add(r.product_code, r.variant_key, batchByLot.get(r.lot_id) ?? null);
      }
    }
  } catch { /* consumption table/column absent — path 1 result stands */ }
  const out = new Map<string, string[]>();
  for (const [k, set] of byBucket.entries()) {
    out.set(k, [...set].sort());
  }
  return out;
}

/* Storekeeper picking — resolve the physical RACK(s) each DO line's goods sit on.
   The rack ledger (warehouse_racks / warehouse_rack_items, migration 0094 + the
   GRN→rack bridge 0151) is a SEPARATE placement ledger from the FIFO inventory
   ledger, keyed by (rack's warehouse_id, product_code, variant_key) — it is NOT
   batch-keyed (warehouse_rack_items has no batch_no), so batch is intentionally
   ignored here. For each DO line we match its resolved ship-from warehouse +
   item_code + variant_key against rack placements and collect the distinct rack
   labels. Best-effort and honest: no matching placement → empty set → the line
   shows a dash (never a guess). Note EVERY current writer of rack placements
   (GRN auto-placement placeGrnLinesOnRacks AND the manual /warehouse/stock-in)
   leaves variant_key at its '' default — so an exact variant match only ever
   succeeds for variant-less lines (mattress/accessory without specials). The
   caller therefore falls back to the '' (unclassified) placement bucket when
   the exact variant bucket is empty: the rack ledger simply does not know the
   variant, and "which rack(s) hold this product code in this warehouse" is the
   correct storekeeper answer. (This was the "Rack blank for Bed Frame" bug —
   bedframe lines carry a non-empty variant_key that no placement row has.)
   Returns a Map keyed `${warehouse_id}::${product_code}::${variant_key}` → rack
   labels (sorted). Takes the already-resolved per-line warehouses so it scopes
   racks to the SAME warehouse each line ships from (a product can be racked in
   more than one warehouse). */
async function resolveDoLineRacks(
  sb: any,
  rawItems: Array<{ id: string } & Record<string, unknown>>,
  lineWh: Map<string, string | null>,
): Promise<Map<string, string[]>> {
  const byBucket = new Map<string, Set<string>>();
  try {
    const whIds = new Set<string>();
    const codes = new Set<string>();
    for (const it of rawItems) {
      const wid = lineWh.get(it.id) ?? null;
      const code = (it.item_code as string | null) ?? null;
      if (!wid || !code) continue;
      whIds.add(wid);
      codes.add(code);
    }
    if (whIds.size === 0 || codes.size === 0) return new Map();

    // Racks in the ship-from warehouse(s) → id, label, warehouse_id.
    const { data: racks, error: rErr } = await sb.from('warehouse_racks')
      .select('id, rack, warehouse_id').in('warehouse_id', [...whIds]);
    if (rErr || !racks || racks.length === 0) return new Map();
    const rackById = new Map(
      (racks as Array<{ id: string; rack: string | null; warehouse_id: string | null }>)
        .map((r) => [r.id, r]),
    );

    // Placements for those racks limited to the codes this DO ships.
    const { data: items, error: iErr } = await sb.from('warehouse_rack_items')
      .select('rack_id, product_code, variant_key')
      .in('rack_id', [...rackById.keys()])
      .in('product_code', [...codes]);
    if (iErr) return new Map();
    for (const ri of (items ?? []) as Array<{ rack_id: string; product_code: string; variant_key: string | null }>) {
      const r = rackById.get(ri.rack_id) as { rack: string | null; warehouse_id: string | null } | undefined;
      if (!r || !r.rack || !r.warehouse_id) continue;
      const k = `${r.warehouse_id}::${ri.product_code}::${ri.variant_key ?? ''}`;
      const set = byBucket.get(k) ?? new Set<string>();
      set.add(r.rack);
      byBucket.set(k, set);
    }
  } catch { /* rack tables absent — every line shows a dash (no rack) */ }
  const out = new Map<string, string[]>();
  for (const [k, set] of byBucket.entries()) out.set(k, [...set].sort());
  return out;
}

async function deductInventoryForDo(sb: any, deliveryOrderId: string, performedBy: string): Promise<string[]> {
  // Idempotency guard #1 — has this DO already written OUT movements?
  const { count: existing } = await sb
    .from('inventory_movements')
    .select('id', { head: true, count: 'exact' })
    .eq('source_doc_type', 'DO')
    .eq('source_doc_id', deliveryOrderId)
    .eq('movement_type', 'OUT');
  if ((existing ?? 0) > 0) return []; // already deducted — no-op

  /* Forward-compat (mig 0057): is_dropship column may not exist yet — retry without it. */
  let doHeaderRes = await sb.from('delivery_orders')
    .select('do_number, warehouse_id, is_dropship, company_id')
    .eq('id', deliveryOrderId).maybeSingle();
  if (doHeaderRes.error && (doHeaderRes.error.message ?? '').includes('is_dropship')) {
    doHeaderRes = await sb.from('delivery_orders')
      .select('do_number, warehouse_id, company_id')
      .eq('id', deliveryOrderId).maybeSingle();
  }
  const doHeader = doHeaderRes.data;
  const { data: items } = await sb.from('delivery_order_items')
    .select('id, so_item_id, item_code, description, qty, item_group, variants, rack_id, committed_po_batch_no')
    .eq('delivery_order_id', deliveryOrderId);
  const headerWarehouseId = (doHeader as { warehouse_id: string | null } | null)?.warehouse_id ?? null;
  const doNo = (doHeader as { do_number: string } | null)?.do_number ?? deliveryOrderId;
  const isDropship = (doHeader as { is_dropship?: boolean } | null)?.is_dropship === true;
  if (!items) return [];

  // Per-line warehouse — each line ships from its SO line's warehouse (0118),
  // not a single DO-header default. Stock never crosses warehouses.
  const lineWh = await resolveDoLineWarehouses(sb, items as Array<{ id: string; so_item_id?: string | null }>, headerWarehouseId);

  /* Stage 3 (Commander 2026-05-31) — SOFA ships as a whole colour-matched set
     from ONE batch (= one dye lot). The allocator locked that batch onto the SO
     line as allocated_batch_no; carry it onto the OUT movement so the FIFO
     trigger consumes strictly from that batch (fn_consume_fifo_batch, 0121).
     Only sofa lines carry a batch — non-sofa lines stay NULL → plain FIFO.
     Drop-ship (mig 0057) — a drop-ship sofa line ships BEFORE receipt, so the
     allocator never locked allocated_batch_no. Stamp the OUT with the EXPECTED
     batch (= bound live PO number) so it (a) nets against the GRN's IN in
     inventory_balances and (b) routes through fn_consume_fifo_batch under the
     same batch the receipt-time reconcile keys on. Both sources resolve via
     the SHARED helper (audit C1) so this path can never drift from resync /
     restamp. Forward-compat: absent columns → un-batched, plain FIFO. */
  const batchBySoItem = await resolveDoSofaBatchMap(
    sb,
    items as Array<{ so_item_id?: string | null; item_code: string; item_group?: string | null }>,
    isDropship,
  );

  /* Collapse identical (warehouse_id, product_code, variant_key, batch_no) lines
     into one OUT row. A DO can legitimately list the same product across two
     lines (qty split) AND across two warehouses; bucketing by warehouse keeps
     each warehouse's deduction correct and idempotency-safe. batch_no joins the
     key so two batches of the same sofa SKU each consume their own lots. */
  const byKey = new Map<string, {
    warehouse_id: string; product_code: string; variant_key: string; product_name: string | null; qty: number; batch_no: string | null;
  }>();
  for (const it of (items as Array<{ id: string; so_item_id?: string | null; item_code: string; description: string | null; qty: number; item_group?: string | null; variants?: VariantAttrs | null }>)) {
    /* P1 SO-SKU spec §4.6 — SERVICE lines (delivery fee / dispose / lift) ride
       the DO for invoicing + driver visibility (D2 final) but are not goods:
       shipping them must not deduct stock. */
    if (isServiceLine({ itemGroup: it.item_group, itemCode: it.item_code })) continue;
    const qty = Number(it.qty ?? 0);
    if (qty <= 0) continue;
    const warehouseId = lineWh.get(it.id) ?? null;
    if (!warehouseId) continue; // no resolvable warehouse — skip rather than guess
    const variantKey = computeVariantKey(it.item_group ?? null, it.variants ?? null);
    const batchNo = it.so_item_id ? (batchBySoItem.get(it.so_item_id) ?? null) : null;
    const k = `${warehouseId}::${it.item_code}::${variantKey}::${batchNo ?? ''}`;
    const cur = byKey.get(k);
    if (cur) { cur.qty += qty; }
    else byKey.set(k, { warehouse_id: warehouseId, product_code: it.item_code, variant_key: variantKey, product_name: it.description, qty, batch_no: batchNo });
  }
  const movements = [...byKey.values()].map((m) => ({
    movement_type: 'OUT' as const,
    warehouse_id: m.warehouse_id,
    product_code: m.product_code,
    variant_key: m.variant_key,
    product_name: m.product_name,
    qty: m.qty,
    source_doc_type: 'DO' as const,
    source_doc_id: deliveryOrderId,
    source_doc_no: doNo,
    ...(m.batch_no ? { batch_no: m.batch_no } : {}),
    performed_by: performedBy,
  }));
  const movementErrors: string[] = [];
  if (movements.length > 0) {
    /* Capture the best-effort write result so the caller can surface a failed
       stock OUT (was silently swallowed — DO flipped DISPATCHED with stock NOT
       moved and the caller never told). No rollback; just make it loud. */
    const res = await writeMovements(sb, movements, (doHeader as { company_id?: number | null } | null)?.company_id ?? null);
    if (!res.ok) movementErrors.push(`OUT ${doNo}: ${res.reason ?? 'unknown'}`);
    /* Costing C — the OUT rows now carry their real FIFO cost (trigger filled
       total_cost_sen). Restamp the DO lines from that actual cost so Margin is
       real, not the SO benchmark copy. */
    await restampDoActualCost(sb, deliveryOrderId);
    /* B2C SO auto-allocation — stock just went out; other PENDING/READY SOs
       might lose their claim. Best-effort. */
    try {
      const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
      await recomputeSoStockAllocation(sb);
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-do-ship failed:', e); }
  }
  /* REC P4 — physical RACK stock-out. The DO just shipped, so pull the goods off
     the rack(s) they sat on (the storekeeper counterpart of the GRN placement).
     Best-effort + idempotent inside; a rack-ledger hiccup never blocks the ship. */
  try {
    await stockOutDoLinesFromRacks(sb, deliveryOrderId, doNo, performedBy, lineWh, items as Array<Record<string, unknown>>, (doHeader as { company_id?: number | null } | null)?.company_id ?? null);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[do-rack] stock-out failed:', e); }
  return movementErrors;
}

// ── DO rack stock-out (REC P4) ───────────────────────────────────────────────
// Mirror of grn-rack-sync.placeGrnLinesOnRacks, in reverse: on the DO's first
// ship, take each goods line's qty OFF a physical rack and log a STOCK_OUT
// warehouse_rack_movement. Source rack = the line's explicit rack_id (operator
// pick) when set, else auto-pick the rack(s) holding that product in the line's
// ship-from warehouse (FIFO by stocked_in_date). Called from the single
// deductInventoryForDo chokepoint (past its idempotency guard) so it runs once
// per DO regardless of which UI path dispatched. Best-effort throughout — the
// separate rack ledger must never break the FIFO stock OUT.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stockOutDoLinesFromRacks(
  sb: any,
  deliveryOrderId: string,
  doNo: string,
  performedBy: string,
  lineWh: Map<string, string | null>,
  items: Array<Record<string, unknown>>,
  companyId: number | null,
): Promise<void> {
  const RACK_REASON = 'Delivery order dispatch';
  // Idempotency — this DO already logged its rack stock-out?
  const { count: already } = await sb.from('warehouse_rack_movements')
    .select('id', { head: true, count: 'exact' })
    .eq('movement_type', 'STOCK_OUT').eq('source_doc_no', doNo).eq('reason', RACK_REASON);
  if ((already ?? 0) > 0) return;

  const companyCol = companyId != null ? { company_id: companyId } : {};
  const touchedRacks = new Set<string>();

  for (const it of items) {
    if (isServiceLine({ itemGroup: it.item_group as string | null, itemCode: it.item_code as string })) continue;
    const qty = Number(it.qty ?? 0);
    if (qty <= 0) continue;
    const productCode = (it.item_code as string | null) ?? null;
    if (!productCode) continue;
    const warehouseId = lineWh.get(it.id as string) ?? null;
    if (!warehouseId) continue;

    // Resolve the source rack row(s). Explicit pick first; else the racks in the
    // ship-from warehouse that actually hold this product, oldest stock first.
    const explicitRackId = (it.rack_id as string | null) ?? null;
    let rackRows: Array<{ id: string; rack: string | null; warehouse_id: string | null }> = [];
    if (explicitRackId) {
      const { data } = await sb.from('warehouse_racks')
        .select('id, rack, warehouse_id').eq('id', explicitRackId).limit(1);
      rackRows = (data ?? []) as typeof rackRows;
    } else {
      const { data: whRacks } = await sb.from('warehouse_racks')
        .select('id, rack, warehouse_id').eq('warehouse_id', warehouseId);
      rackRows = (whRacks ?? []) as typeof rackRows;
    }
    if (rackRows.length === 0) continue; // warehouse has no racks — nothing to move
    const rackIds = rackRows.map((r) => r.id);
    const rackById = new Map(rackRows.map((r) => [r.id, r]));

    // Placements of this product on the candidate rack(s), oldest first (FIFO).
    const { data: placements } = await sb.from('warehouse_rack_items')
      .select('id, rack_id, qty, stocked_in_date')
      .in('rack_id', rackIds).eq('product_code', productCode)
      .order('stocked_in_date', { ascending: true });
    const placementRows = (placements ?? []) as Array<{ id: string; rack_id: string; qty: number; stocked_in_date: string }>;

    let remaining = qty;
    const outByRack = new Map<string, number>();
    for (const p of placementRows) {
      if (remaining <= 0) break;
      const take = Math.min(p.qty, remaining);
      if (take >= p.qty) {
        await sb.from('warehouse_rack_items').delete().eq('id', p.id);
      } else {
        await sb.from('warehouse_rack_items').update({ qty: p.qty - take }).eq('id', p.id);
      }
      outByRack.set(p.rack_id, (outByRack.get(p.rack_id) ?? 0) + take);
      remaining -= take;
    }

    // No matching placement found (product never racked, or all consumed). When
    // the operator explicitly named a rack, still honour the pick by logging the
    // whole line off that rack so the ledger reflects their action; otherwise
    // skip silently (never invent a rack the goods were not on).
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
        product_code: productCode,
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

// Recompute + persist a rack's derived status (items win over the reserved
// flag). Local twin of warehouse.ts refreshRackStatus / grn-rack-sync's copy —
// kept here so the DO route has no cross-route import.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function refreshRackStatusInline(sb: any, rackId: string): Promise<void> {
  const { count } = await sb.from('warehouse_rack_items')
    .select('id', { head: true, count: 'exact' }).eq('rack_id', rackId);
  const { data: rack } = await sb.from('warehouse_racks')
    .select('reserved').eq('id', rackId).maybeSingle();
  const status = (count ?? 0) > 0 ? 'OCCUPIED' : (rack?.reserved ? 'RESERVED' : 'EMPTY');
  await sb.from('warehouse_racks').update({ status, updated_at: new Date().toISOString() }).eq('id', rackId);
}

// ── DO rack stock-out REVERSAL (on cancel) ───────────────────────────────────
// A cancelled DO returns its FIFO stock (reverseInventoryForDo); do the same for
// the physical rack ledger. For each STOCK_OUT this DO logged, log a balancing
// STOCK_IN and put the qty back on the same rack (best-effort: re-creates a rack
// item so occupancy recovers — original customer/date metadata is not restored).
// Idempotent on the STOCK_IN marker so a double-cancel never double-credits.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function returnDoRacksOnCancel(sb: any, deliveryOrderId: string, doNo: string, performedBy: string, companyId: number | null): Promise<void> {
  const OUT_REASON = 'Delivery order dispatch';
  const IN_REASON = 'DO cancelled';
  const { count: alreadyBack } = await sb.from('warehouse_rack_movements')
    .select('id', { head: true, count: 'exact' })
    .eq('movement_type', 'STOCK_IN').eq('source_doc_no', doNo).eq('reason', IN_REASON);
  if ((alreadyBack ?? 0) > 0) return;

  const { data: outs } = await sb.from('warehouse_rack_movements')
    .select('rack_id, rack_label, warehouse_id, product_code, product_name, quantity')
    .eq('movement_type', 'STOCK_OUT').eq('source_doc_no', doNo).eq('reason', OUT_REASON);
  const outRows = (outs ?? []) as Array<{ rack_id: string | null; rack_label: string | null; warehouse_id: string | null; product_code: string; product_name: string | null; quantity: number }>;
  if (outRows.length === 0) return;

  const companyCol = companyId != null ? { company_id: companyId } : {};
  const today = todayMyt();
  const touchedRacks = new Set<string>();

  for (const o of outRows) {
    if (o.rack_id) {
      await sb.from('warehouse_rack_items').insert({
        ...companyCol,
        rack_id: o.rack_id,
        product_code: o.product_code,
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
      product_code: o.product_code,
      product_name: o.product_name,
      source_doc_no: doNo,
      quantity: o.quantity,
      reason: IN_REASON,
      performed_by: performedBy,
    });
  }
  for (const rackId of touchedRacks) await refreshRackStatusInline(sb, rackId);
}

/* ── resyncInventoryForDo (Commander 2026-05-30, TASK #24) ────────────────────
   Bring inventory in line with the CURRENT shape of a SHIPPED DO's lines, after
   the operator edits a line qty / deletes a line / adds a line. The first ship
   already wrote OUT rows via deductInventoryForDo; this helper writes DELTA
   movements (IN to give stock back, OUT to take more) so the booked net OUT
   per (product_code, variant_key) bucket matches the live sum of active lines.

   Why DELTA inserts instead of UPDATE in place: the FIFO trigger (migration
   0053) fires AFTER INSERT, not UPDATE. Updating qty on an existing OUT row
   would leave the lot/consumption ledger stale. A fresh IN insert lets the
   trigger create a new lot at the original cost basis; a fresh OUT insert lets
   it consume more lots. Migration 0109 dropped the per-bucket UNIQUE so we can
   freely write multiple delta rows over time.

   IDEMPOTENT: re-running with no line changes yields delta 0 everywhere — no
   writes. Cancel-reversal still works via reverseMovements (it nets per
   bucket). Non-shipped DOs skip — deductInventoryForDo handles the first ship. */
async function resyncInventoryForDo(sb: any, deliveryOrderId: string, performedBy: string) {
  // Header — need warehouse_id, do_number, status, is_dropship (audit C1).
  /* Forward-compat (mig 0057): is_dropship column may not exist yet — retry without it. */
  let hdrRes = await sb.from('delivery_orders')
    .select('do_number, status, warehouse_id, is_dropship, company_id')
    .eq('id', deliveryOrderId).maybeSingle();
  if (hdrRes.error && (hdrRes.error.message ?? '').includes('is_dropship')) {
    hdrRes = await sb.from('delivery_orders')
      .select('do_number, status, warehouse_id, company_id')
      .eq('id', deliveryOrderId).maybeSingle();
  }
  const doHeader = hdrRes.data;
  if (!doHeader) return;
  const status = ((doHeader as { status: string | null }).status ?? '').toUpperCase();
  if (!SHIPPED_STATES.includes(status)) return; // not yet shipped → no OUT yet → nothing to sync
  const headerWarehouseId = (doHeader as { warehouse_id: string | null }).warehouse_id ?? null;
  const doNo = (doHeader as { do_number: string }).do_number;
  const isDropship = (doHeader as { is_dropship?: boolean }).is_dropship === true;

  // 1. Target qty per (warehouse_id, product_code, variant_key) bucket — sum of
  //    current active DO lines (mirror of deductInventoryForDo's collapsing).
  //    Each line's warehouse comes from its SO line (0118), not a header default,
  //    so a resync delta lands in the SAME warehouse the first ship debited.
  const { data: items } = await sb.from('delivery_order_items')
    .select('id, so_item_id, item_code, description, qty, item_group, variants, committed_po_batch_no')
    .eq('delivery_order_id', deliveryOrderId);
  const lineWh = await resolveDoLineWarehouses(sb, (items ?? []) as Array<{ id: string; so_item_id?: string | null }>, headerWarehouseId);

  /* Sofa batch per so_item — same SHARED resolution the first ship used
     (allocated_batch_no + drop-ship expected batch, audit C1). batch_no JOINS
     the bucket key so a resync delta consumes/returns the SAME dye-lot batch
     the original OUT drew from, not a random FIFO lot. Before C1 this only
     read allocated_batch_no, so an add-line / qty-increase on a DROP-SHIP DO
     (whose lines have no allocated batch) wrote its delta OUT UN-BATCHED —
     plain FIFO ate other lots and the receipt-time reconcile (keyed on
     batch_no) never costed it. Best-effort: absent columns (pre-0121) /
     non-sofa → empty map → plain non-batched resync, identical to the old
     behaviour. */
  const batchBySoItem = await resolveDoSofaBatchMap(
    sb,
    (items ?? []) as Array<{ so_item_id?: string | null; item_code: string; item_group?: string | null }>,
    isDropship,
  );
  const batchAware = batchBySoItem.size > 0;

  type Bucket = { warehouse_id: string; product_code: string; variant_key: string; product_name: string | null; qty: number; batch_no: string | null };
  const targetByBucket = new Map<string, Bucket>();
  for (const it of (items as Array<{ id: string; so_item_id?: string | null; item_code: string; description: string | null; qty: number; item_group?: string | null; variants?: VariantAttrs | null }> ?? [])) {
    /* P1 SO-SKU spec §4.6 — SERVICE lines never wrote OUT on first ship, so
       they must stay out of the resync TARGET too, or the delta walk would
       "correct" the net OUT upward and deduct phantom stock. */
    if (isServiceLine({ itemGroup: it.item_group, itemCode: it.item_code })) continue;
    const qty = Number(it.qty ?? 0);
    if (qty <= 0) continue;
    const warehouseId = lineWh.get(it.id) ?? null;
    if (!warehouseId) continue; // no resolvable warehouse — skip rather than guess
    const variant_key = computeVariantKey(it.item_group ?? null, it.variants ?? null);
    const batch_no = it.so_item_id ? (batchBySoItem.get(it.so_item_id) ?? null) : null;
    const k = `${warehouseId}::${it.item_code}::${variant_key}::${batch_no ?? ''}`;
    const cur = targetByBucket.get(k);
    if (cur) { cur.qty += qty; }
    else targetByBucket.set(k, { warehouse_id: warehouseId, product_code: it.item_code, variant_key, product_name: it.description, qty, batch_no });
  }

  // 2. Aggregate existing movements per (warehouse, product, variant) bucket —
  //    current OUT qty / IN qty. Also accumulate OUT total_cost_sen so the
  //    reversing IN re-introduces stock at the same weighted cost basis.
  /* Select batch_no too when we're batch-aware so existing OUT/IN rows aggregate
     into the SAME batched buckets as the target. Pre-0121 (not batch-aware) we
     skip the column entirely — it may not exist yet — and every bucket's batch
     segment is '' (matches the non-batched target keys above). */
  const movSelect = batchAware
    ? 'movement_type, warehouse_id, product_code, variant_key, batch_no, qty, unit_cost_sen, total_cost_sen, product_name'
    : 'movement_type, warehouse_id, product_code, variant_key, qty, unit_cost_sen, total_cost_sen, product_name';
  const { data: movs } = await sb.from('inventory_movements')
    .select(movSelect)
    .eq('source_doc_type', 'DO')
    .eq('source_doc_id', deliveryOrderId);
  type Agg = { out_qty: number; in_qty: number; out_total_cost: number; product_name: string | null };
  const aggByBucket = new Map<string, Agg>();
  for (const m of (movs ?? []) as Array<{
    movement_type: string; warehouse_id: string; product_code: string; variant_key: string | null; batch_no?: string | null;
    qty: number; unit_cost_sen: number | null; total_cost_sen: number | null; product_name: string | null;
  }>) {
    const k = `${m.warehouse_id}::${m.product_code}::${m.variant_key ?? ''}::${m.batch_no ?? ''}`;
    let agg = aggByBucket.get(k);
    if (!agg) { agg = { out_qty: 0, in_qty: 0, out_total_cost: 0, product_name: m.product_name }; aggByBucket.set(k, agg); }
    if (m.movement_type === 'OUT') {
      agg.out_qty += Number(m.qty ?? 0);
      agg.out_total_cost += Number(m.total_cost_sen ?? 0);
    } else if (m.movement_type === 'IN') {
      agg.in_qty += Number(m.qty ?? 0);
    }
    if (!agg.product_name) agg.product_name = m.product_name;
  }

  // 3. Per-bucket delta = target − current_net_out. Positive → need more OUT;
  //    negative → need more IN (return some stock). Bucket key is
  //    warehouse_id::product_code::variant_key.
  const allKeys = new Set<string>([...targetByBucket.keys(), ...aggByBucket.keys()]);
  type MovOut = Parameters<typeof writeMovements>[1][number];
  const writes: MovOut[] = [];
  for (const k of allKeys) {
    const t = targetByBucket.get(k);
    const a = aggByBucket.get(k) ?? { out_qty: 0, in_qty: 0, out_total_cost: 0, product_name: null };
    const target_qty = t?.qty ?? 0;
    const current_net_out = a.out_qty - a.in_qty;
    const delta = target_qty - current_net_out;
    if (delta === 0) continue;
    const parts = k.split('::');
    const warehouse_id = parts[0] ?? '';
    const product_code = parts[1] ?? '';
    const variant_key = parts[2] ?? '';
    const batch_no = parts[3] || null; // '' → null (non-sofa); else the bound dye-lot batch
    const product_name = t?.product_name ?? a.product_name ?? null;
    if (delta > 0) {
      // Need more OUT — operator increased a line qty or added a new line on a shipped DO.
      writes.push({
        movement_type: 'OUT',
        warehouse_id,
        product_code, variant_key, product_name,
        qty: delta,
        source_doc_type: 'DO',
        source_doc_id: deliveryOrderId,
        source_doc_no: doNo,
        performed_by: performedBy,
        notes: 'Resync: line qty increased / line added (shipped DO).',
        ...(batch_no ? { batch_no } : {}),
      });
    } else {
      // delta < 0 — operator reduced a line qty or deleted a line. Give stock back.
      // Cost basis = weighted average of the original OUTs so the reversing IN
      // re-opens the lot at the same cost (matches reverseMovements semantics).
      const unit_cost_sen = a.out_qty > 0 ? Math.round(a.out_total_cost / a.out_qty) : 0;
      writes.push({
        movement_type: 'IN',
        warehouse_id,
        product_code, variant_key, product_name,
        qty: -delta,
        unit_cost_sen,
        source_doc_type: 'DO',
        source_doc_id: deliveryOrderId,
        source_doc_no: doNo,
        performed_by: performedBy,
        notes: 'Resync: line qty reduced / line deleted (shipped DO).',
        ...(batch_no ? { batch_no } : {}),
      });
    }
  }
  if (writes.length > 0) {
    // Multi-company: resync movements inherit the DO's company.
    await writeMovements(sb, writes, (doHeader as { company_id?: number | null }).company_id ?? null);
    /* Oversell retro-cost (0154) — a reduced / deleted line on a shipped DO gives
       stock BACK (a lot-opening IN), so a prior "ship anyway" DO that went out at
       RM0 in this warehouse can now be costed from it. Wired 2026-07-29; until
       then only the GRN post reconciled (COE §2). Runs BEFORE this DO's own
       restamp so both read the same movement state. Best-effort. */
    await reconcileUncostedAfterIn(sb, writes, performedBy);
    /* Costing C — line set changed → re-derive each line's actual FIFO cost
       from the now-current movements (ship OUT + these resync deltas). */
    await restampDoActualCost(sb, deliveryOrderId);
    /* Resync changed stock — re-walk SO allocation. Best-effort. */
    try {
      const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
      await recomputeSoStockAllocation(sb);
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-do-resync failed:', e); }
  }
}

/* ── reverseInventoryForDo (Bug #1 twin of delivery-returns.reverseInventoryForReturn) ──
   REVERSE a DO's inventory OUT when it is CANCELLED. The DO wrote OUT movements
   on ship (consuming FIFO lots); cancelling must put that stock back so on-hand
   isn't permanently depleted.

   We CANNOT reuse reverseMovements: it writes a balancing IN that reuses the DO's
   (source_doc_type, source_doc_id, product_code, variant_key) key, which the
   partial UNIQUE index uq_inv_mov_do_source (migration 0100, keyed WITHOUT
   movement_type) rejects → the insert silently fails (swallowed by the cancel
   path's best-effort catch) and the shipped stock is left permanently deducted.

   Instead we write a POSITIVE ADJUSTMENT row per (product_code, variant_key)
   bucket (qty = +net_out). The inventory_balances view treats ADJUSTMENT as
   signed (migration 0095: `WHEN movement_type = 'ADJUSTMENT' THEN qty`), so a
   positive qty adds back exactly what the DO removed — net stock impact of the
   cancelled DO becomes zero. An ADJUSTMENT row is unindexed by the DO source key
   and FIFO-neutral (no spurious COGS, no arbitrary lot re-open).

   net_out per bucket = Σ OUT qty − Σ IN qty across THIS DO's own movements (the
   ship OUT plus any resync delta rows from line edits), so an edited DO reverses
   exactly its currently-booked outflow. variant_key is carried so it nets the
   right variant batch (Agent C makes the FIFO trigger variant-aware).

   IDEMPOTENT: an existence check for a prior ADJUSTMENT row tagged with this DO's
   id skips a re-reversal. Best-effort — a movement failure never un-cancels the
   DO (audit-DLQ pattern). */
async function reverseInventoryForDo(sb: any, deliveryOrderId: string, performedBy: string) {
  // Idempotency guard — has this DO already been reversed? Reversal rows are
  // tagged source_doc_type='ADJUSTMENT' + this DO's id. They may be ADJUSTMENT
  // (non-sofa) OR a batch-restoring IN (sofa, Stage 4), so DON'T filter on
  // movement_type — either kind means we already reversed.
  const { count: existing } = await sb
    .from('inventory_movements')
    .select('id', { head: true, count: 'exact' })
    .eq('source_doc_type', 'ADJUSTMENT')
    .eq('source_doc_id', deliveryOrderId);
  if ((existing ?? 0) > 0) return; // already reversed — no-op

  /* Forward-compat (mig 0057): is_dropship column may not exist yet — retry without it. */
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

  /* ── Drop-ship DO (audit C2 + H4, migration 0088) ──────────────────────────
     A drop-ship DO's BATCHED buckets must NOT be reversed with a batched IN:
       C2 — cancel BEFORE receive: the OUT consumed no lot (0 cost), so a
            batched IN makes the FIFO trigger mint a PHANTOM open lot (qty N,
            batch = the bound PO number) for stock that was never received —
            sofa coverage then sees shippable stock that doesn't exist.
       H4 — cancel AFTER receive: the receipt-time reconcile's
            inventory_lot_consumptions stay attributed to the now-cancelled DO
            (overstated COGS) and the restored unit sits in a synthetic lot
            that recost.ts never re-costs.
     fn_reverse_dropship_do_out instead restores + deletes the DO's lot
     consumptions (original lots come back at original cost), zeroes the OUT
     cost stamps, and writes a balance-only add-back per batched bucket (its
     trigger-minted lot is closed inside the fn). Unbatched buckets fall
     through to the plain ADJUSTMENT path below, unchanged. If the fn is
     missing (pre-0088) or errors, we fall back to the legacy batched-IN
     reversal so a cancel NEVER leaves stock permanently deducted. */
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

  /* ── NON-drop-ship DO cancel (audit R4, migration 0198) ────────────────────
     A cancelled NORMAL DO must restore its ORIGINAL lots at their ORIGINAL
     per-lot cost and DELETE its inventory_lot_consumptions rows, exactly as the
     drop-ship path does — otherwise a cancelled sale's COGS stays in the ledger
     and the stock re-enters as an average-cost lot at the BACK of the FIFO queue.
     fn_reverse_do_out(..., p_batched_only := FALSE) does this for ALL buckets
     (plain AND sofa). On success the route writes NO add-back rows below (the fn
     handled every bucket). If the fn is missing (pre-0198) or errors, we fall
     back to the legacy average-cost ADJUSTMENT / batch-restoring IN so a cancel
     NEVER leaves stock permanently deducted. */
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

  // Net OUT per (warehouse, product_code, variant_key, batch_no) bucket from THIS
  // DO's own IN/OUT movements. batch_no is read from the OUT rows themselves (the
  // ship stamped it), so a sofa reversal restores the EXACT dye-lot batch it drew
  // from. Forward-compat: pre-0120 the column doesn't exist → retry without it and
  // every bucket's batch is '' (plain ADJUSTMENT, identical to old behaviour).
  const sel = 'movement_type, warehouse_id, product_code, variant_key, batch_no, qty, total_cost_sen, product_name';
  let movsRes = await sb.from('inventory_movements').select(sel)
    .eq('source_doc_type', 'DO').eq('source_doc_id', deliveryOrderId);
  if (movsRes.error && (movsRes.error.message ?? '').includes('batch_no')) {
    movsRes = await sb.from('inventory_movements')
      .select('movement_type, warehouse_id, product_code, variant_key, qty, total_cost_sen, product_name')
      .eq('source_doc_type', 'DO').eq('source_doc_id', deliveryOrderId);
  }
  const movs = movsRes.data;

  /* Build the LEGACY route-side add-back rows (used only when the SQL reversal
     fn did not run — see buildDoReversalRows). For a BATCHED (sofa) bucket a
     reversing IN (carrying batch_no) re-OPENS a lot tagged with that exact batch;
     for a plain bucket a FIFO-neutral ADJUSTMENT. Both use
     source_doc_type='ADJUSTMENT' so neither collides with the DO source index
     (ix_inv_mov_do_source is scoped WHERE source_doc_type='DO'). When
     nonDropshipHandled (fn_reverse_do_out reversed every bucket) or, for a
     drop-ship DO, dropshipBatchedHandled (batched buckets reversed inside
     fn_reverse_dropship_do_out), those buckets are skipped and this returns []. */
  const movements = buildDoReversalRows(movs ?? [], {
    deliveryOrderId,
    doNo,
    performedBy,
    dropshipBatchedHandled,
    nonDropshipHandled,
  });
  // Multi-company: reversal movements inherit the DO's company.
  if (movements.length > 0) {
    await writeMovements(sb, movements, (doHeader as { company_id?: number | null } | null)?.company_id ?? null);
    /* Oversell retro-cost (0154) — a cancelled DO puts its shipment back on the
       shelf (a reversing IN, or a positive ADJUSTMENT for a plain bucket), so a
       prior "ship anyway" DO that went out at RM0 in this warehouse can now be
       costed from the re-opened lots. Wired 2026-07-29; until then only the GRN
       post reconciled (COE §2). Best-effort — never un-cancels the DO. */
    await reconcileUncostedAfterIn(sb, movements, performedBy);
  }
}

/* ── doLineConsumedQty (Commander 2026-05-30, TASK #24) ───────────────────────
   Σ invoiced + Σ returned for a DO line — the downstream-paper-consumption
   floor below which the line's qty can't shrink (and below which the line
   can't be deleted). Mirrors the do-line-remaining "invoiced / returned"
   formula but for a single line. Cancel-released → 0 (rows on cancelled
   SI/DR are excluded). */
async function doLineConsumedQty(sb: any, doItemId: string): Promise<number> {
  let invoiced = 0, returned = 0;
  // Σ invoiced via non-cancelled Sales Invoice.
  const { data: siLines } = await sb.from('sales_invoice_items')
    .select('qty, sales_invoice_id').eq('do_item_id', doItemId);
  const siRows = (siLines ?? []) as Array<{ qty: number; sales_invoice_id: string }>;
  const siIds = [...new Set(siRows.map((l) => l.sales_invoice_id).filter(Boolean))];
  if (siIds.length > 0) {
    const { data: sis } = await sb.from('sales_invoices').select('id, status').in('id', siIds);
    const active = new Set(((sis ?? []) as Array<{ id: string; status: string | null }>)
      .filter((s) => (s.status ?? '').toUpperCase() !== 'CANCELLED').map((s) => s.id));
    for (const l of siRows) if (active.has(l.sales_invoice_id)) invoiced += Number(l.qty ?? 0);
  }
  // Σ returned via non-cancelled Delivery Return.
  const { data: drLines } = await sb.from('delivery_return_items')
    .select('qty_returned, delivery_return_id').eq('do_item_id', doItemId);
  const drRows = (drLines ?? []) as Array<{ qty_returned: number; delivery_return_id: string }>;
  const drIds = [...new Set(drRows.map((l) => l.delivery_return_id).filter(Boolean))];
  if (drIds.length > 0) {
    const { data: drs } = await sb.from('delivery_returns').select('id, status').in('id', drIds);
    const active = new Set(((drs ?? []) as Array<{ id: string; status: string | null }>)
      .filter((d) => (d.status ?? '').toUpperCase() !== 'CANCELLED').map((d) => d.id));
    for (const l of drRows) if (active.has(l.delivery_return_id)) returned += Number(l.qty_returned ?? 0);
  }
  return invoiced + returned;
}

/* Commander 2026-05-30 — LINE-LEVEL, QUANTITY-BASED partial delivery.
   Replaces the old binary whole-SO conversion lock. For each SO line, the
   DELIVERABLE REMAINING quantity is DERIVED LIVE (no stored counter — that
   drifts):

     remaining(soItem) = soItem.qty
       − Σ delivery_order_items.qty   where so_item_id = soItem.id
                                      AND its delivery_orders.status != 'CANCELLED'
       + Σ delivery_return_items.qty_returned  where that return line traces
              (do_item_id → delivery_order_items.so_item_id = soItem.id) to a
              non-cancelled delivery_returns

   So a line is partially delivered (remaining > 0 → still convertible) or
   fully delivered (remaining == 0 → not convertible). Cancelling a DO,
   deleting a DO line, or processing a Delivery Return automatically RAISES
   remaining again, because the formula re-derives from the live rows.

   Returns one descriptor row per requested SO line (qty + remaining + the
   fields the picker / convert handler need), keyed by SO line id. */
type DeliverableLine = {
  soItemId: string;
  docNo: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  qty: number;
  unitPriceCenti: number;
  unitCostCenti: number;
  discountCenti: number;
  variants: unknown;
  /* Migration 0058 — dedicated sofa/bedframe variant-breakdown columns. Carried
     so the SO→DO convert keeps them (delivery_order_items has all 8); previously
     dropped here, so a converted DO lost the sofa/bedframe build breakdown. */
  gapInches: number | null;
  divanHeightInches: number | null;
  divanPriceSen: number;
  legHeightInches: number | null;
  legPriceSen: number;
  customSpecials: unknown;
  lineSuffix: string | null;
  specialOrderPriceSen: number;
  delivered: number;
  returned: number;
  remaining: number;
  /** Position of this line within ITS SO listing order (re-derived at read:
   *  rank mains→accessories→services + each build's left-to-right walk) — DO
   *  lines copy the SO's listing order instead of shuffling by uuid (Loo
   *  2026-06-12: mains first + sofa modules left-to-right survive onto the DO). */
  lineSeq: number;
};

export async function soDeliverableRemaining(
  sb: any,
  soDocNos: string[],
): Promise<Map<string, DeliverableLine>> {
  const out = new Map<string, DeliverableLine>();
  if (soDocNos.length === 0) return out;

  // 1. Load the non-cancelled SO lines of the requested SOs and re-derive
  //    each SO's listing order from the rows themselves (Loo 2026-06-12:
  //    mains → accessories → services, sofa modules left-to-right). The bulk
  //    insert gives every line the same created_at, so the timestamp can't
  //    recover the persisted order once routine updates relocate rows.
  const { data: soItems } = await paginateAll<Record<string, unknown>>((from, to) => sb
    .from('mfg_sales_order_items')
    .select(
      'id, doc_no, debtor_code, debtor_name, item_code, item_group, description, description2, ' +
      'uom, qty, unit_price_centi, unit_cost_centi, discount_centi, variants, ' +
      'gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, ' +
      'custom_specials, line_suffix, special_order_price_sen',
    )
    .in('doc_no', soDocNos)
    .eq('cancelled', false)
    .order('line_no', { ascending: true, nullsFirst: false })
    .order('created_at')
    .order('id')
    .range(from, to));
  const rawLines = (soItems ?? []) as Array<Record<string, unknown> & { id: string; doc_no: string; item_code: string; qty: number }>;
  if (rawLines.length === 0) return out;
  /* buildKey values are per-SO ('build-1', …) — the walk MUST run per doc;
     keyed across docs it would mix two SOs' builds into one group. */
  const orderByDoc = new Map<string, typeof rawLines>();
  for (const l of rawLines) {
    const arr = orderByDoc.get(l.doc_no) ?? [];
    arr.push(l);
    orderByDoc.set(l.doc_no, arr);
  }
  const lines = [...orderByDoc.values()].flatMap((docLines) =>
    orderSofaModuleRowsWithinBuilds(
      sortSoLinesByGroupRank(docLines, (r) => r.item_group as string | null | undefined),
    ),
  );
  const soItemIds = lines.map((l) => l.id);

  // 2. Σ delivered — DO lines linked by so_item_id whose parent DO is NOT
  //    cancelled (nor DRAFT — a draft hasn't shipped). PERF: collapsed from a
  //    two-step "pull DO lines, then re-fetch their parent DOs to read status"
  //    into ONE round-trip by embedding the parent status (PostgREST to-one
  //    embed → row count unchanged, so paginateAll stays exact). The
  //    CANCELLED/DRAFT decision is still made HERE in JS with the same
  //    .toUpperCase() compare, and a missing parent (orphan) is excluded exactly
  //    as before (its id used to be absent from the delivery_orders lookup, so
  //    it never entered activeDoIds) — the delivered sum is byte-identical.
  const { data: doLines } = await paginateAll<{ id: string; so_item_id: string | null; qty: number; parent: { status: string | null } | null }>((from, to) => sb
    .from('delivery_order_items')
    .select('id, so_item_id, qty, parent:delivery_orders(status)')
    .in('so_item_id', soItemIds)
    .order('id')
    .range(from, to));
  const doLineRows = (doLines ?? []) as Array<{ id: string; so_item_id: string | null; qty: number; parent: { status: string | null } | null }>;
  // DO line id → SO item id (only for active DOs), used to trace returns below.
  const doLineToSoItem = new Map<string, string>();
  const deliveredBySoItem = new Map<string, number>();
  for (const l of doLineRows) {
    if (!l.so_item_id || !l.parent) continue;
    /* LEAK GUARD (DRAFT): a DRAFT DO hasn't shipped — it must NOT consume the
       SO line's deliverable remaining (else the real DO can't be raised and
       the picker shows phantom-delivered qty). Treated like CANCELLED here. */
    const st = (l.parent.status ?? '').toUpperCase();
    if (st === 'CANCELLED' || st === 'DRAFT') continue;
    doLineToSoItem.set(l.id, l.so_item_id);
    deliveredBySoItem.set(l.so_item_id, (deliveredBySoItem.get(l.so_item_id) ?? 0) + Number(l.qty ?? 0));
  }

  // 3. Σ returned — DR lines whose do_item_id traces (via the active DO line)
  //    back to one of our SO items, and whose parent DR is NOT cancelled.
  //    PERF: same collapse as the delivered hop — the parent DR status is
  //    embedded so the "pull DR lines, then re-fetch parent DRs" two-step becomes
  //    ONE round-trip. The non-cancelled decision stays in JS (.toUpperCase()),
  //    and an orphan DR line (no parent) is excluded exactly as before (its id
  //    was never in activeDrIds), so the returned sum is byte-identical.
  const returnedBySoItem = new Map<string, number>();
  const activeDoLineIds = [...doLineToSoItem.keys()];
  if (activeDoLineIds.length > 0) {
    const { data: drLines } = await sb
      .from('delivery_return_items')
      .select('do_item_id, qty_returned, parent:delivery_returns(status)')
      .in('do_item_id', activeDoLineIds);
    const drLineRows = (drLines ?? []) as Array<{ do_item_id: string | null; qty_returned: number; parent: { status: string | null } | null }>;
    for (const l of drLineRows) {
      if (!l.do_item_id || !l.parent) continue;
      if ((l.parent.status ?? '').toUpperCase() === 'CANCELLED') continue;
      const soItemId = doLineToSoItem.get(l.do_item_id);
      if (!soItemId) continue;
      returnedBySoItem.set(soItemId, (returnedBySoItem.get(soItemId) ?? 0) + Number(l.qty_returned ?? 0));
    }
  }

  // 4. Assemble per-line descriptors with the live remaining. lineSeq counts
  //    per SO so the picker / DO create can keep each SO's listing order.
  const seqByDoc = new Map<string, number>();
  for (const l of lines) {
    const qty = Number(l.qty ?? 0);
    const delivered = deliveredBySoItem.get(l.id) ?? 0;
    const returned = returnedBySoItem.get(l.id) ?? 0;
    const lineSeq = seqByDoc.get(l.doc_no) ?? 0;
    seqByDoc.set(l.doc_no, lineSeq + 1);
    out.set(l.id, {
      soItemId: l.id,
      docNo: l.doc_no,
      debtorCode: (l.debtor_code as string | null) ?? null,
      debtorName: (l.debtor_name as string | null) ?? null,
      itemCode: l.item_code as string,
      itemGroup: (l.item_group as string | null) ?? null,
      description: (l.description as string | null) ?? null,
      description2: (l.description2 as string | null) ?? null,
      uom: (l.uom as string | null) ?? null,
      qty,
      unitPriceCenti: Number(l.unit_price_centi ?? 0),
      unitCostCenti: Number(l.unit_cost_centi ?? 0),
      discountCenti: Number(l.discount_centi ?? 0),
      variants: l.variants ?? null,
      /* Migration 0058 — carry the dedicated variant-breakdown columns onto the
         deliverable descriptor (supabase-js snake_case; dual-read stays safe). */
      gapInches: (l.gapInches ?? l.gap_inches ?? null) as number | null,
      divanHeightInches: (l.divanHeightInches ?? l.divan_height_inches ?? null) as number | null,
      divanPriceSen: Number(l.divanPriceSen ?? l.divan_price_sen ?? 0),
      legHeightInches: (l.legHeightInches ?? l.leg_height_inches ?? null) as number | null,
      legPriceSen: Number(l.legPriceSen ?? l.leg_price_sen ?? 0),
      customSpecials: l.customSpecials ?? l.custom_specials ?? null,
      lineSuffix: (l.lineSuffix ?? l.line_suffix ?? null) as string | null,
      specialOrderPriceSen: Number(l.specialOrderPriceSen ?? l.special_order_price_sen ?? 0),
      delivered,
      returned,
      remaining: qty - delivered + returned,
      lineSeq,
    });
  }
  return out;
}

/* Per-SO-line delivery breakdown — for each SO item id, the list of DO lines
   it was delivered into (one entry per DO line), carrying the parent DO number
   + qty + status. Cancelled DOs are excluded, mirroring soDeliverableRemaining
   so the "Delivered" column and the remaining math never disagree. Read-only
   display aid; the authoritative remaining stays in soDeliverableRemaining. */
export type SoLineDelivery = { doNumber: string; qty: number; status: string };
export async function soLineDeliveries(
  sb: any,
  soItemIds: string[],
): Promise<Map<string, SoLineDelivery[]>> {
  const out = new Map<string, SoLineDelivery[]>();
  if (soItemIds.length === 0) return out;
  const { data: doLines } = await sb
    .from('delivery_order_items')
    .select('so_item_id, qty, delivery_order_id')
    .in('so_item_id', soItemIds);
  const rows = (doLines ?? []) as Array<{ so_item_id: string | null; qty: number; delivery_order_id: string }>;
  const doIds = [...new Set(rows.map((r) => r.delivery_order_id).filter(Boolean))];
  if (doIds.length === 0) return out;
  const { data: dos } = await sb.from('delivery_orders').select('id, do_number, status').in('id', doIds);
  const doMeta = new Map<string, { doNumber: string; status: string }>();
  for (const d of (dos ?? []) as Array<{ id: string; do_number: string | null; status: string | null }>) {
    const st = (d.status ?? '').toUpperCase();
    // LEAK GUARD (DRAFT): a DRAFT DO hasn't shipped — exclude from the "Delivered"
    // display (mirrors soDeliverableRemaining so the two never disagree).
    if (st === 'CANCELLED' || st === 'DRAFT') continue;
    doMeta.set(d.id, { doNumber: d.do_number ?? '—', status: st });
  }
  for (const r of rows) {
    if (!r.so_item_id) continue;
    const meta = doMeta.get(r.delivery_order_id);
    if (!meta) continue; // cancelled DO — excluded
    const arr = out.get(r.so_item_id) ?? [];
    arr.push({ doNumber: meta.doNumber, qty: Number(r.qty ?? 0), status: meta.status });
    out.set(r.so_item_id, arr);
  }
  return out;
}

/* Per-DO-line downstream breakdown — for each DO item id, the list of documents
   it was carried into: Sales Invoices (via sales_invoice_items.do_item_id) and
   Delivery Returns (via delivery_return_items.do_item_id). Carries the parent
   doc number + kind (SI / DR) + qty + status. Cancelled SIs / DRs are excluded
   so the "Transfer To" column never shows a voided document. The DO counterpart
   of soLineDeliveries — read-only display aid, no writes. */
export type DoLineDownstream = { docNumber: string; docType: 'SI' | 'DR'; qty: number; status: string };
export async function doLineDownstream(
  sb: any,
  doItemIds: string[],
): Promise<Map<string, DoLineDownstream[]>> {
  const out = new Map<string, DoLineDownstream[]>();
  const ids = [...new Set(doItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return out;

  // chunkIn splits the do_item_id IN-list into ≤200 batches and pages each — a DO
  // line with >1000 downstream SI/DR lines would otherwise truncate at PostgREST's
  // 1000-row cap and corrupt the delivered/invoiced/returned reconcile.
  const [siLinesRes, drLinesRes] = await Promise.all([
    chunkIn<{ do_item_id: string | null; qty: number; sales_invoice_id: string }>(ids, (batch, from, to) =>
      sb.from('sales_invoice_items').select('do_item_id, qty, sales_invoice_id').in('do_item_id', batch).range(from, to)),
    chunkIn<{ do_item_id: string | null; qty_returned: number; delivery_return_id: string }>(ids, (batch, from, to) =>
      sb.from('delivery_return_items').select('do_item_id, qty_returned, delivery_return_id').in('do_item_id', batch).range(from, to)),
  ]);
  const siLines = siLinesRes.data;
  // delivery_return_items has NO `qty` column — it's `qty_returned` (the same
  // file reads it correctly elsewhere). Selecting `qty` returned 0 qty for every
  // DR in a DO line's downstream breakdown (bug-hunt 2026-06-20).
  const drLines = drLinesRes.data;

  const siIds = [...new Set(siLines.map((r) => r.sales_invoice_id).filter(Boolean))];
  const drIds = [...new Set(drLines.map((r) => r.delivery_return_id).filter(Boolean))];
  // Header lookups are also chunked+paged so a >1000 parent-doc set can't truncate.
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
    if (!meta) continue; // cancelled SI — excluded
    push(r.do_item_id, { docNumber: meta.docNumber, docType: 'SI', qty: Number(r.qty ?? 0), status: meta.status });
  }
  for (const r of drLines) {
    const meta = drMeta.get(r.delivery_return_id);
    if (!meta) continue; // cancelled DR — excluded
    push(r.do_item_id, { docNumber: meta.docNumber, docType: 'DR', qty: Number(r.qty_returned ?? 0), status: meta.status });
  }
  return out;
}

/* Traceability (source-PO on a SHIPPED SO line). For each SO line, resolve the
   supplier PO(s) that supplied the goods it actually shipped. Walk SO line → its
   DO line(s) → that DO's OUT inventory movements' batch_no (sofa/drop-ship) ∪
   its FIFO lot consumptions' lots' batch_no (plain-FIFO bed frame / mattress /
   accessories) — batch_no = source PO number, stamped by the GRN per migration
   0120 and copied onto the lot by the FIFO trigger. Because movements aren't keyed by
   so_item_id, we match within each DO by the SAME (product_code, variant_key)
   bucket the ship writes them under. This lets the SO detail keep showing which
   PO the line's goods came from even AFTER the line is delivered (the incoming-PO
   coverage is otherwise dropped by MRP once the demand is satisfied). Best-effort
   — un-batched (plain-FIFO) stock or a cancelled DO's fully-reversed OUT still
   reports the PO(s) the shipment drew from. Returns Map<so_item_id, PO numbers>. */
export async function soLineShippedSourcePos(
  sb: any,
  soItemIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(soItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return out;
  try {
    // SO line → DO line(s): the DO items carry the SKU + variants we bucket by.
    const { data: doItems } = await sb.from('delivery_order_items')
      .select('so_item_id, delivery_order_id, item_code, item_group, variants')
      .in('so_item_id', ids);
    const doLines = (doItems ?? []) as Array<{
      so_item_id: string | null; delivery_order_id: string; item_code: string;
      item_group: string | null; variants: VariantAttrs | null;
    }>;
    if (doLines.length === 0) return out;
    const doIds = [...new Set(doLines.map((r) => r.delivery_order_id).filter(Boolean))];
    const batchByBucket = new Map<string, Set<string>>();
    const add = (doId: string, code: string, variantKey: string | null, batch: string | null) => {
      if (!batch) return;
      const k = `${doId}::${code}::${variantKey ?? ''}`;
      const set = batchByBucket.get(k) ?? new Set<string>();
      set.add(batch);
      batchByBucket.set(k, set);
    };
    // OUT movements for those DOs, keyed by (do, product_code, variant_key) →
    // batches. Only sofa/drop-ship OUTs carry batch_no (deductInventoryForDo).
    const { data: movs } = await sb.from('inventory_movements')
      .select('source_doc_id, product_code, variant_key, batch_no')
      .eq('source_doc_type', 'DO')
      .eq('movement_type', 'OUT')
      .in('source_doc_id', doIds)
      .not('batch_no', 'is', null);
    for (const m of (movs ?? []) as Array<{ source_doc_id: string; product_code: string; variant_key: string | null; batch_no: string | null }>) {
      add(m.source_doc_id, m.product_code, m.variant_key, m.batch_no);
    }
    // FIFO lot consumptions for those DOs → the consumed lots' batch_no.
    // Plain-FIFO categories (bed frame / mattress / accessories) ship with an
    // un-batched OUT, but the lots they consumed ARE batched (GRN stamps
    // batch_no = source PO number, 0120) — without this union those lines
    // lose their source PO the moment they deliver.
    try {
      const { data: cons } = await sb.from('inventory_lot_consumptions')
        .select('source_doc_id, lot_id, product_code, variant_key')
        .eq('source_doc_type', 'DO')
        .in('source_doc_id', doIds);
      const consRows = (cons ?? []) as Array<{ source_doc_id: string; lot_id: string; product_code: string; variant_key: string | null }>;
      const lotIds = [...new Set(consRows.map((r) => r.lot_id).filter(Boolean))];
      if (lotIds.length > 0) {
        const { data: lots } = await sb.from('inventory_lots')
          .select('id, batch_no')
          .in('id', lotIds)
          .not('batch_no', 'is', null);
        const batchByLot = new Map(
          ((lots ?? []) as Array<{ id: string; batch_no: string | null }>).map((l) => [l.id, l.batch_no]),
        );
        for (const r of consRows) {
          add(r.source_doc_id, r.product_code, r.variant_key, batchByLot.get(r.lot_id) ?? null);
        }
      }
    } catch { /* consumption table absent — movement batches stand alone */ }
    const bySoItem = new Map<string, Set<string>>();
    for (const dl of doLines) {
      if (!dl.so_item_id) continue;
      const variantKey = computeVariantKey(dl.item_group ?? null, dl.variants ?? null);
      const k = `${dl.delivery_order_id}::${dl.item_code}::${variantKey}`;
      const batches = batchByBucket.get(k);
      if (!batches || batches.size === 0) continue;
      const acc = bySoItem.get(dl.so_item_id) ?? new Set<string>();
      for (const b of batches) acc.add(b);
      bySoItem.set(dl.so_item_id, acc);
    }
    for (const [sid, set] of bySoItem.entries()) out.set(sid, [...set].sort());
  } catch { /* movement/column absent — no shipped source PO (falls back to raised PO) */ }
  return out;
}

/* Per-SO lifecycle state by "latest event wins" (Wei Siang 2026-05-31).
   Walks every NON-cancelled downstream document for each Sales Order — Delivery
   Orders, Sales Invoices, Delivery Returns — and keeps the one with the most
   recent business date (do_date / invoice_date / return_date), tie-broken by
   created_at, then by a corrective-action priority (a return outranks an invoice
   outranks a delivery for the same instant). The winning document's KIND becomes
   the Sales Order's status badge:
     • no events       → 'none'      (badge shows the stored status, e.g. Confirmed)
     • latest is a DO   → 'delivered' (the view splits Partial / Full by quantity)
     • latest is a SI   → 'invoiced'
     • latest is a DR   → 'returned'  (Delivery Return)
   Because it is purely "latest wins", raising a fresh Delivery Order or Invoice
   after a return moves the badge straight back to Delivered / Invoiced — no
   stored status to unwind. Read-only display aid. */
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

  // DO id → so_doc_no, so a Delivery Return (which carries delivery_order_id but
  // no so_doc_no) can be attributed back to its Sales Order.
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
    const { data: drRows } = await sb.from('delivery_returns')
      .select('delivery_order_id, return_date, created_at, status')
      .in('delivery_order_id', doIds)
      .neq('status', 'CANCELLED');
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
      // Bug #10 — business dates mix plain 'YYYY-MM-DD' (do_date / invoice_date /
      // return_date) and full ISO timestamps (created_at fallback). Compare on a
      // normalized date-only key so a same-day return doesn't sort before a
      // shipment merely because one string is longer; ties fall to created_at.
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

/* Bug #10 — normalize a lifecycle event's business date to a single comparable
   representation. Inputs are a mix of plain 'YYYY-MM-DD' dates and full ISO
   timestamps; both share the leading 'YYYY-MM-DD', so truncating to the first 10
   chars yields a stable day-level key that sorts correctly regardless of which
   form the row carried. (created_at is the tie-breaker, applied separately.) */
function normalizeEventDay(d: string): string {
  return (d ?? '').slice(0, 10);
}

/* Per-DO lifecycle state by "latest event wins" (Wei Siang 2026-05-31). A
   Delivery Order ships on creation, so its baseline badge is 'shipped'. If a
   NON-cancelled Sales Invoice or Delivery Return points back at the DO, the one
   with the most recent business date (invoice_date / return_date, tie-broken by
   created_at, then return-over-invoice for the same instant) takes the badge:
     • no SI / DR     → 'shipped'
     • latest is a SI  → 'invoiced'
     • latest is a DR  → 'returned'   (Delivery Return)
   Cancelled DOs are handled by the stored status, not here. Read-only. */
export type DoLifecycle = 'shipped' | 'invoiced' | 'returned';
export async function computeDoLifecycle(
  sb: any,
  doIds: string[],
): Promise<Map<string, DoLifecycle>> {
  const out = new Map<string, DoLifecycle>();
  const ids = [...new Set(doIds.filter(Boolean))];
  if (ids.length === 0) return out;

  type Ev = { date: string; createdAt: string; kind: DoLifecycle };
  const events = new Map<string, Ev[]>();
  const push = (doId: string | null | undefined, ev: Ev) => {
    if (!doId) return;
    const arr = events.get(doId) ?? [];
    arr.push(ev);
    events.set(doId, arr);
  };

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
  for (const s of (siRes.data ?? []) as Array<{ delivery_order_id: string | null; invoice_date: string | null; created_at: string | null }>) {
    push(s.delivery_order_id, { date: s.invoice_date ?? s.created_at ?? '', createdAt: s.created_at ?? '', kind: 'invoiced' });
  }
  for (const r of (drRes.data ?? []) as Array<{ delivery_order_id: string | null; return_date: string | null; created_at: string | null }>) {
    push(r.delivery_order_id, { date: r.return_date ?? r.created_at ?? '', createdAt: r.created_at ?? '', kind: 'returned' });
  }

  const priority: Record<DoLifecycle, number> = { shipped: 0, invoiced: 1, returned: 2 };
  for (const id of ids) {
    const evs = events.get(id);
    if (!evs || evs.length === 0) { out.set(id, 'shipped'); continue; }
    let best: Ev | null = null;
    for (const ev of evs) {
      if (!best) { best = ev; continue; }
      // Bug #10 — normalize mixed plain-date / ISO-timestamp business dates to a
      // day-level key before comparing (created_at remains the tie-breaker).
      const dc = normalizeEventDay(ev.date).localeCompare(normalizeEventDay(best.date));
      if (dc > 0) { best = ev; continue; }
      if (dc < 0) continue;
      const cc = ev.createdAt.localeCompare(best.createdAt);
      if (cc > 0) { best = ev; continue; }
      if (cc < 0) continue;
      if (priority[ev.kind] > priority[best.kind]) best = ev;
    }
    out.set(id, best ? best.kind : 'shipped');
  }
  return out;
}

/* Current document per Sales Order — the number of the furthest-forward document
   the flow has reached (Wei Siang 2026-05-31). Same "latest event wins" ordering
   as computeSoLifecycle, but it returns the winning document's NUMBER instead of
   its kind, so the "Current" column never disagrees with the status badge.
   Events: Delivery Order (do_number, rank 1) → Sales Invoice (invoice_number,
   rank 2) → Delivery Return (return_number, rank 3, attributed back via the DO).
   Cancelled documents are excluded. Sales Orders with no downstream are ABSENT
   from the map — the caller falls back to the Sales Order's own number (the flow
   is still sitting at the order). Keyed by SO doc_no. Read-only display aid. */
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
    const { data: drRows } = await sb.from('delivery_returns')
      .select('delivery_order_id, return_number, return_date, created_at, status')
      .in('delivery_order_id', doIds)
      .neq('status', 'CANCELLED');
    for (const r of (drRows ?? []) as Array<{ delivery_order_id: string | null; return_number: string | null; return_date: string | null; created_at: string | null }>) {
      const so = r.delivery_order_id ? doToSo.get(r.delivery_order_id) : undefined;
      push(so, { date: r.return_date ?? r.created_at ?? '', createdAt: r.created_at ?? '', rank: 3, docNumber: r.return_number ?? '—' });
    }
  }

  return currentDocNoByKey(byKey);
}

/* Live remaining-deliverable qty per SO line id (qty − delivered + returned),
   resolved straight from the SO item ids. Used by the write-path guards below
   so every DO-line create / add / qty-increase respects the SAME cap the
   line-level picker enforces — no back door. SO lines that no longer exist map
   to 0 (treat as nothing left to deliver). */
async function soRemainingByItemId(
  sb: any,
  soItemIds: Array<string | null | undefined>,
): Promise<Map<string, number>> {
  const ids = [...new Set(soItemIds.filter((x): x is string => !!x))];
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const { data } = await sb.from('mfg_sales_order_items').select('doc_no').in('id', ids);
  const docNos = [...new Set(((data ?? []) as Array<{ doc_no: string | null }>).map((r) => r.doc_no).filter((d): d is string => !!d))];
  const remainingMap = await soDeliverableRemaining(sb, docNos);
  for (const id of ids) out.set(id, remainingMap.get(id)?.remaining ?? 0);
  return out;
}

/* ── SO-must-be-deliverable guard (audit gap #4) ──────────────────────────────
   A Delivery Order may only be raised against a Sales Order that is committed —
   i.e. CONFIRMED or beyond. A DRAFT (never-confirmed), CANCELLED, or ON_HOLD SO
   is NOT committed, so shipping goods against it (writing an OUT stock movement)
   is wrong. Mirrors the purchasing-side rule that a GRN's parent PO must be
   SUBMITTED / PARTIALLY_RECEIVED (grns.ts /outstanding-po-items). New SOs are
   CONFIRMED on insert (only asDraft lands DRAFT), so the normal deliver flow is
   unaffected — this only blocks a draft / on-hold / cancelled source. The block
   set is a DENY-list (not an allow-list) so any legitimate forward status
   (CONFIRMED, IN_PRODUCTION, DELIVERED, …) stays deliverable.
   OWNER FLAG: ON_HOLD is treated as NOT deliverable — an order paused mid-flight
   should not ship until it is taken off hold. */
const SO_UNDELIVERABLE_STATUSES = new Set(['DRAFT', 'CANCELLED', 'ON_HOLD']);
async function firstUndeliverableSo(
  sb: any,
  soDocNos: Array<string | null | undefined>,
): Promise<{ docNo: string; status: string } | null> {
  const docNos = [...new Set(soDocNos.filter((d): d is string => !!d))];
  if (docNos.length === 0) return null;
  const { data } = await sb.from('mfg_sales_orders').select('doc_no, status').in('doc_no', docNos);
  for (const r of (data ?? []) as Array<{ doc_no: string; status: string | null }>) {
    const st = (r.status ?? '').toUpperCase();
    // A row with no readable status is left to fall through (never over-block);
    // an unknown doc_no simply isn't returned here (FK rejects it downstream).
    if (SO_UNDELIVERABLE_STATUSES.has(st)) return { docNo: r.doc_no, status: st };
  }
  return null;
}
function soNotDeliverableResponse(offender: { docNo: string; status: string }) {
  const label =
    offender.status === 'DRAFT' ? 'is still a draft'
    : offender.status === 'CANCELLED' ? 'has been cancelled'
    : offender.status === 'ON_HOLD' ? 'is on hold'
    : `is ${offender.status.toLowerCase()}`;
  return {
    error: 'so_not_deliverable',
    message: `Sales Order ${offender.docNo} ${label}, so a Delivery Order cannot be created from it. Confirm the Sales Order first.`,
    soDocNo: offender.docNo,
    soStatus: offender.status,
  };
}

/* Filter-pill bucket → the raw delivery_orders.status values it covers. Single
   source of truth for BOTH the status-count queries and the list `status`
   filter. open / in_transit / delivered are MULTI-status buckets; cancelled is
   1:1. The FE sends the BUCKET NAME as `status`; a raw DB status still works
   (backward-compatible fallback). */
const DO_STATUS_BUCKETS: Record<string, string[]> = {
  open: ['DRAFT', 'LOADED'],
  in_transit: ['DISPATCHED', 'IN_TRANSIT'],
  delivered: ['SIGNED', 'DELIVERED', 'INVOICED', 'COMPLETED'],
  cancelled: ['CANCELLED'],
};

// ── List ────────────────────────────────────────────────────────────────
deliveryOrdersMfg.get('/', async (c) => {
  const sb = c.get('supabase');
  // Row-level "own / downline chain" scope (scm.staff uuids) — see lib/salesScope.ts.
  // Pass the REAL Houzs user id, NOT user.id (bridge-pinned staff uuid — was the non-admin 500).
  // view-all = scm.so.view_all permission OR a director position (Sales
  // Director / Super Admin / Finance Manager) via canViewAllSales.
  const canViewAll = canViewAllSales(c);
  const houzsUserId = c.get('houzsUser')?.id;
  if (!canViewAll && houzsUserId == null) {
    // No Houzs identity to scope by — say so plainly instead of silently
    // returning an empty list (the match-nothing scope hides the real cause).
    return c.json({ error: 'Your account is not linked to a Houzs user, so delivery orders cannot be shown — please contact IT.' }, 403);
  }
  const scopeIds = await resolveSalesScopeIds(sb, c.env, houzsUserId, canViewAll);

  /* Opt-in server-side pagination + search + sort + status-counts (mirrors the
     SO list in mfg-sales-orders.ts). The PRESENCE of `page` switches paging on;
     when it is absent/empty the query below is BYTE-IDENTICAL to the historical
     behavior (order do_date desc, limit 500, status param, `{ deliveryOrders }`
     shape) so nothing that calls this today changes. Status counts are computed
     over the FULL scoped set (no status/search/page filter) so tab counts stay
     stable while the user types or a status tab is active. */
  const pageRaw = c.req.query('page');
  const paginate = pageRaw !== undefined && pageRaw !== '';

  let data: unknown = null;
  let error: { message: string } | null = null;
  let total = 0;
  let page = 0;
  let pageSize = 50;
  let statusCounts: { all: number; open: number; in_transit: number; delivered: number; cancelled: number } | undefined;

  if (!paginate) {
    /* --- LEGACY PATH (unchanged) --- */
    let q = sb.from('delivery_orders').select(HEADER).order('do_date', { ascending: false }).limit(500);
    q = scopeToCompany(q, c); // DO is a per-company document — never leak the other company's DOs.
    if (scopeIds) q = q.in('salesperson_id', scopeIds);
    const status = c.req.query('status'); if (status) q = q.eq('status', status);
    const res = await q;
    data = res.data;
    error = res.error;
  } else {
    /* --- PAGINATED PATH (opt-in via `page`) --- */
    page = Math.max(0, Math.trunc(Number(pageRaw)) || 0);
    const psRaw = Number(c.req.query('pageSize'));
    pageSize = Number.isFinite(psRaw) && psRaw > 0 ? Math.min(100, Math.max(1, Math.trunc(psRaw))) : 50;

    const SORT_COLS = new Set(['do_date', 'do_number', 'debtor_name', 'status', 'customer_delivery_date']);
    const [rawCol, rawDir] = (c.req.query('sort') ?? 'do_date:desc').split(':');
    const sortCol = SORT_COLS.has(rawCol) ? rawCol : 'do_date';
    const sortAsc = rawDir === 'asc';

    let q = sb.from('delivery_orders').select(HEADER, { count: 'exact' }).order(sortCol, { ascending: sortAsc });
    /* unique tiebreaker so range paging can't skip/repeat rows sharing the sort key */
    if (sortCol !== 'do_number') q = q.order('do_number', { ascending: sortAsc });
    q = scopeToCompany(q, c); // per-company document — scope the paginated list too.
    if (scopeIds) q = q.in('salesperson_id', scopeIds);
    /* Resolve the incoming `status`: a known bucket key → all its raw statuses;
       'all'/empty → no filter; otherwise treat it as a raw DB status. */
    const status = c.req.query('status');
    if (status && status !== 'all') {
      if (DO_STATUS_BUCKETS[status]) q = q.in('status', DO_STATUS_BUCKETS[status]);
      else q = q.eq('status', status);
    }
    /* free-text search over the columns the FE list's client-side search matches
       (MfgDeliveryOrdersListV2 hay) that live on this base table. */
    const search = c.req.query('q');
    if (search) {
      const s = escapeForOr(search);
      // Match customer NAME (debtor_name), PHONE, and the linked SO REFERENCE
      // (ref, snapshotted onto the DO) — plus the doc numbers it already covered.
      if (s) q = q.or([
        `do_number.ilike.%${s}%`, `so_doc_no.ilike.%${s}%`, `debtor_name.ilike.%${s}%`,
        `debtor_code.ilike.%${s}%`, `ref.ilike.%${s}%`, `branding.ilike.%${s}%`,
        `sales_location.ilike.%${s}%`, `driver_name.ilike.%${s}%`,
        ...phoneSearchOrParts(s, search, normalizePhone),
      ].join(','));
    }
    const from = c.req.query('from'); if (from) q = q.gte('do_date', from);
    const to = c.req.query('to'); if (to) q = q.lte('do_date', to);
    q = q.range(page * pageSize, page * pageSize + pageSize - 1);
    const res = await q;
    data = res.data;
    error = res.error;
    total = res.count ?? (res.data?.length ?? 0);

    /* Status counts mirror the FE filter-pill buckets (open / in_transit /
       delivered / cancelled) over the SAME scope filter but WITHOUT status /
       search / pagination. Scoped to the active company like the list, so the
       tab counts can't leak the other company's DO totals. */
    const countBase = () => {
      let cq = scopeToCompany(sb.from('delivery_orders').select('*', { count: 'exact', head: true }), c);
      if (scopeIds) cq = cq.in('salesperson_id', scopeIds);
      return cq;
    };
    const [allC, openC, transitC, deliveredC, cancelledC] = await Promise.all([
      countBase(),
      countBase().in('status', DO_STATUS_BUCKETS.open),
      countBase().in('status', DO_STATUS_BUCKETS.in_transit),
      countBase().in('status', DO_STATUS_BUCKETS.delivered),
      countBase().in('status', DO_STATUS_BUCKETS.cancelled),
    ]);
    statusCounts = {
      all: allC.count ?? 0,
      open: openC.count ?? 0,
      in_transit: transitC.count ?? 0,
      delivered: deliveredC.count ?? 0,
      cancelled: cancelledC.count ?? 0,
    };
  }
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  /* Tier 2 downstream-lock — one extra batched read per doc set: pull every
     non-cancelled DR/SI that points back to a listed DO and stamp has_children
     on the row. The list grid uses this to hide Edit / Cancel actions on DOs
     that are downstream-locked (mirrors computeGrnFlags in routes/grns.ts). */
  const rows = (data ?? []) as unknown as Array<{ id: string } & Record<string, unknown>>;
  const childIds = new Set<string>();
  /* DISPLAY-ONLY transfer-to columns (audit R8): the SI number(s) each DO was
     invoiced into and the DR number(s) returned against it. Derived from the
     SAME batched child reads that already stamp has_children — one added column
     in each select, no extra round-trip, and never touches DO status/lifecycle
     (which stays computeDoLifecycle below). */
  const invoicedSiByDo = new Map<string, Set<string>>();
  const returnedDrByDo = new Map<string, Set<string>>();
  let lifecycleByDo = new Map<string, DoLifecycle>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const [drRes, siRes, lc] = await Promise.all([
      sb.from('delivery_returns').select('delivery_order_id, return_number').in('delivery_order_id', ids).neq('status', 'CANCELLED'),
      sb.from('sales_invoices').select('delivery_order_id, invoice_number').in('delivery_order_id', ids).neq('status', 'CANCELLED'),
      computeDoLifecycle(sb, ids),
    ]);
    lifecycleByDo = lc;
    for (const d of ((drRes.data ?? []) as Array<{ delivery_order_id: string | null; return_number: string | null }>)) {
      if (!d.delivery_order_id) continue;
      childIds.add(d.delivery_order_id);
      if (d.return_number) {
        const set = returnedDrByDo.get(d.delivery_order_id) ?? new Set<string>();
        set.add(d.return_number);
        returnedDrByDo.set(d.delivery_order_id, set);
      }
    }
    for (const s of ((siRes.data ?? []) as Array<{ delivery_order_id: string | null; invoice_number: string | null }>)) {
      if (!s.delivery_order_id) continue;
      childIds.add(s.delivery_order_id);
      if (s.invoice_number) {
        const set = invoicedSiByDo.get(s.delivery_order_id) ?? new Set<string>();
        set.add(s.invoice_number);
        invoicedSiByDo.set(s.delivery_order_id, set);
      }
    }
  }
  const sortedNos = (set: Set<string> | undefined): string[] =>
    set ? [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
  /* Linked-SO Processing date (mfg_sales_orders.internal_expected_dd — the one
     true user date since the legacy processing_date column was dropped, mig
     0189). The DO quick-view drawer shows it next to the DO's own delivery
     date; one batched read keyed by so_doc_no, same pattern as the DR/SI child
     reads above. */
  const soProcByDoc = new Map<string, string | null>();
  {
    const soDocNos = [...new Set(rows.map((r) => r.so_doc_no as string | null).filter((d): d is string => !!d))];
    if (soDocNos.length > 0) {
      const { data: soRows } = await sb.from('mfg_sales_orders')
        .select('doc_no, internal_expected_dd').in('doc_no', soDocNos);
      for (const s of ((soRows ?? []) as Array<{ doc_no: string | null; internal_expected_dd: string | null }>)) {
        if (s.doc_no) soProcByDoc.set(s.doc_no, s.internal_expected_dd ?? null);
      }
    }
  }
  /* Finance gate — cost / margin / per-category subtotals reach ONLY a
     finance-viewer; stripped from every row otherwise. */
  const showFinance = canViewScmFinance(c);
  const deliveryOrders = rows.map((r) => {
    const row: Record<string, unknown> = {
      ...r,
      has_children: childIds.has(r.id),
      lifecycle_state: lifecycleByDo.get(r.id) ?? 'shipped',
      so_internal_expected_dd: soProcByDoc.get((r.so_doc_no as string | null) ?? '') ?? null,
      // Transfer-to (display-only, audit R8): SI(s) invoiced / DR(s) returned.
      invoiced_si_nos: sortedNos(invoicedSiByDo.get(r.id)),
      return_nos: sortedNos(returnedDrByDo.get(r.id)),
    };
    if (!showFinance) for (const k of DO_FINANCE_KEYS) delete row[k];
    return row;
  });
  if (paginate) return c.json({ deliveryOrders, total, page, pageSize, statusCounts });
  return c.json({ deliveryOrders });
});

// ── Deliverable SO lines (line-level partial-delivery picker) ─────────────
/* Commander 2026-05-30 — feeds the line-level SO→DO picker. Returns each SO
   LINE that can still be delivered (remaining > 0), where remaining is derived
   live by soDeliverableRemaining (qty − delivered + returned). With ?docNos=
   it scopes to those SOs; without it, every non-cancelled SO is considered.

   IMPORTANT (route ordering): this STATIC path MUST be registered BEFORE the
   `/:id` param route below — otherwise Hono matches `/:id` first and tries to
   cast "deliverable-so-lines" to a uuid. */
deliveryOrdersMfg.get('/deliverable-so-lines', async (c) => {
  const sb = c.get('supabase');

  // Resolve the candidate SO doc_nos. Explicit ?docNos=A,B wins; otherwise
  // pull every non-cancelled SO (capped) so the picker can show all of them.
  const docNosParam = c.req.query('docNos');
  let docNos: string[];
  if (docNosParam && docNosParam.trim()) {
    docNos = [...new Set(docNosParam.split(',').map((d) => d.trim()).filter(Boolean))];
  } else {
    // Page through so PostgREST's 1000-row cap can't drop SOs from the picker
    // (a non-cancelled SO past row 1000 would be undeliverable via the UI).
    /* Per-company: the SO picker must offer only the active company's orders.
       Unscoped, this listed every 2990 mirrored SO to a Houzs operator — the
       visible half of the cross-company conversion bug, and how the operator
       reached a 2990 SO from the Houzs Create-DO screen at all. */
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
  return c.json({ lines });
});

/* ── SO → DO conversion source ────────────────────────────────────────────────
   THE FIELDS THAT CARRY ACROSS, from the ONE place that already knows them.

   WHY THIS ENDPOINT EXISTS. There are two SO→DO converters, and until now only
   one of them could read a MIRRORED SO:
     · POST /from-sos (below) loads the SO header with NO company predicate, on
       purpose — its own comment says "a 2990 SO may be converted while browsing
       as Houzs", because the Delivery Planning board is a shared cross-company
       queue.
     · The Create-DO FORM (DeliveryOrderNewV2) prefilled itself from
       GET /mfg-sales-orders/:docNo, which IS wrapped in scopeToCompany. For a
       2990- mirrored SO (company_id = 2, stamped by so-mirror.ts) read while the
       active company is HOUZS, that answers 404 — so the form rendered EMPTY
       while its "Converted from <doc>" badge and the document-flow strip, which
       are derived from the ?fromSo= query STRING and never touch the fetch, kept
       showing the linkage. Fields blank, linkage perfect. That is the bug.
   Pointing the form at this route makes the preview and the commit read the SAME
   columns through the SAME loader, so they cannot drift again.

   SCOPING IS DELIBERATELY the converter's, not the SO detail page's: a caller who
   is already allowed to CONVERT this SO must be able to SEE what conversion will
   copy. Narrower than "no predicate" — scopeToAllowedCompanies limits it to the
   companies this caller is actually granted (companyScope.ts's three-state
   sentinel: unresolved → no predicate, so single-company Houzs is unchanged).
   Read gating is the area guard's (scm.sales.delivery, readInheritsFrom
   scm.sales.orders), exactly as for every other read on this router.

   IMPORTANT (route ordering): STATIC path, so it MUST be registered BEFORE the
   `/:id` param route below — same reason as /deliverable-so-lines above. */
/** Load a source SO header for conversion. Shared by the form preview
 *  (GET /so-source/:docNo) and the commit (POST /from-sos) so the two can never
 *  copy different column sets. No company predicate — see the header above; the
 *  commit path has always read it this way and the preview now matches. */
async function loadSoHeaderForConversion(
  sb: ReturnType<typeof getSupabaseService>,
  docNo: string,
): Promise<{ head: Record<string, unknown> | null; error: string | null }> {
  const { data, error } = await sb
    .from('mfg_sales_orders')
    .select(SO_CONVERT_HEADER)
    .eq('doc_no', docNo)
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
    /* An honest 404 with the doc number in it. The form MUST be able to say
       "we could not read <doc>" instead of presenting a blank document that
       looks fresh — a blank form invites someone to retype the customer's
       address by hand and get it wrong. */
    return c.json({ error: 'so_not_found', docNo }, 404);
  }
  /* Same mapping the commit applies (lib/so-to-do-fields), so what the form
     previews is what POST /from-sos would have stored. `missing` names the
     fields the SOURCE genuinely lacks, so "we could not read the SO" and "the SO
     has no email" are never the same blank screen again. */
  const source = soHeaderToDoSource(row as unknown as Record<string, unknown>);
  return c.json({ source, missing: missingSourceFields(source) });
});

// ── Detail ──────────────────────────────────────────────────────────────
deliveryOrdersMfg.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    sb.from('delivery_orders').select(HEADER).eq('id', id).maybeSingle(),
    sb.from('delivery_order_items').select(ITEM).eq('delivery_order_id', id)
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  /* Own/downline sales scope (lib/salesScope.ts) — mirror the list scope. A
     scoped seller must not read another salesperson's DO/finance by
     enumerating ids; out-of-scope → 404. Directors/view-all bypass.
     HEADER carries salesperson_id already. */
  {
    const sp = (h.data as { salesperson_id?: number | string | null }).salesperson_id;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), sp)) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
  /* Tier 2 downstream-lock — stamp has_children so the DO Detail page can lock
     once any non-cancelled DR / SI references it. */
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
  /* Per-DO crew (scm.delivery_order_crew, migration 0053). One row per DO
     (UNIQUE do_id); null when no crew has been assigned yet. Surfaced on the
     detail so the Delivery Crew block can render the FK ids + assign-time
     snapshots without a second round-trip. */
  const { data: crew } = await sb.from('delivery_order_crew')
    .select(crewSnapshotCols).eq('do_id', id).maybeSingle();
  const deliveryOrder = {
    ...(h.data as unknown as Record<string, unknown>),
    has_children: (drCount ?? 0) > 0 || (siCount ?? 0) > 0,
    lifecycle_state: lifecycleByDo.get(id) ?? 'shipped',
    crew: crew ?? null,
  };
  /* Per-line Warehouse column (Agent D, TASK #32): resolve the SAME ship-from
     warehouse the inventory OUT uses (SO line → DO header → default) and stamp
     warehouse_id + warehouse_code on each item so the operator can see which
     warehouse each line moves. Display-only — does not alter stock. */
  const rawItems = (i.data ?? []) as unknown as Array<{ id: string; so_item_id?: string | null } & Record<string, unknown>>;
  const headerWh = (h.data as { warehouse_id?: string | null }).warehouse_id ?? null;
  const [lineWh, downstreamMap, sourcePosByBucket] = await Promise.all([
    resolveDoLineWarehouses(sb, rawItems, headerWh),
    doLineDownstream(sb, rawItems.map((it) => it.id)),
    /* Traceability — resolve which source PO(s) supplied each shipped line, from
       the ledger: batched OUT movements (sofa/drop-ship) ∪ FIFO lot consumptions
       → the consumed lots' batch_no (= source PO number, GRN-stamped per 0120;
       covers plain-FIFO bed frame/mattress/accessory lines too). Keyed by
       (product_code, variant_key). Best-effort — no batch → bound-PO fallback
       below, else a dash. */
    resolveDoLineSourcePos(sb, id),
  ]);
  const codeMap = await warehouseCodeMap(sb, [...lineWh.values()]);
  /* Storekeeper picking — physical rack(s) each line's goods sit on, scoped to
     the SAME ship-from warehouse resolved above (keyed warehouse::code::variant).
     Best-effort; unmapped lines get a dash. */
  const racksByBucket = await resolveDoLineRacks(sb, rawItems, lineWh);
  /* Bound-PO fallback — a line whose ledger walk found no batch (not yet
     shipped, negative-stock ship, or un-batched pre-0120 lots) still has a real
     procurement path when a PO was raised against its SO line (per-warehouse
     binding lives at SO-line level; purchase_order_items.so_item_id, 0098).
     Resolve those lines' bound PO number so every category shows its Source PO
     — the same chain the SO detail's incoming-PO coverage uses. */
  const unresolvedSoIds = rawItems
    .filter((it) => {
      const vk = computeVariantKey(
        (it.item_group as string | null) ?? null,
        (it.variants as VariantAttrs | null) ?? null,
      );
      return (sourcePosByBucket.get(`${(it.item_code as string) ?? ''}::${vk}`) ?? []).length === 0;
    })
    .map((it) => (it.so_item_id as string | null) ?? null)
    .filter((x): x is string => Boolean(x));
  const boundPoBySoItem = unresolvedSoIds.length > 0
    ? await resolveExpectedBatchBySoItem(sb, unresolvedSoIds)
    : new Map<string, { poNumber: string }>();
  const items = rawItems.map((it) => {
    const wid = lineWh.get(it.id) ?? null;
    const variantKey = computeVariantKey(
      (it.item_group as string | null) ?? null,
      (it.variants as VariantAttrs | null) ?? null,
    );
    const bucketKey = `${(it.item_code as string) ?? ''}::${variantKey}`;
    const rackKey = `${wid ?? ''}::${(it.item_code as string) ?? ''}::${variantKey}`;
    const ledgerPos = sourcePosByBucket.get(bucketKey) ?? [];
    const boundPo = ledgerPos.length === 0 && it.so_item_id
      ? (boundPoBySoItem.get(it.so_item_id as string)?.poNumber ?? null)
      : null;
    /* Rack lookup: exact variant bucket first; when empty, fall back to the ''
       (unclassified) bucket — every current rack writer (GRN auto-placement +
       manual stock-in) records placements with variant_key='', so variant lines
       (bedframe/sofa) would otherwise never match. Same warehouse + product
       code, so it's still the right physical answer. */
    const exactRacks = racksByBucket.get(rackKey) ?? [];
    const racks = exactRacks.length > 0 || variantKey === ''
      ? exactRacks
      : (racksByBucket.get(`${wid ?? ''}::${(it.item_code as string) ?? ''}::`) ?? []);
    return {
      ...it,
      warehouse_id: wid,
      warehouse_code: wid ? (codeMap.get(wid) ?? null) : null,
      downstream: downstreamMap.get(it.id) ?? [],
      /* Source PO number(s) the goods came from: shipped-ledger batches (OUT
         movements ∪ consumed lots), else the SO line's bound PO. Empty only
         for lines with no batch AND no bound PO (e.g. service lines, stock
         with no procurement trail). */
      source_pos: ledgerPos.length > 0 ? [...ledgerPos] : (boundPo ? [boundPo] : []),
      /* Physical rack label(s) the goods are stored on, for storekeeper picking.
         Empty when no rack placement matches (dash) — never guessed. */
      racks: [...racks],
    };
  });
  /* Finance gate — the DETAIL leaks cost/margin the same way the list did, so
     strip the header's DO_FINANCE_KEYS + every line's cost/margin for a
     non-finance caller (canViewScmFinance fails closed). Critical now that a
     scoped salesperson can open their own DOs (readInheritsFrom scm.sales.orders):
     they see the customer-facing DO but never cost or margin. */
  if (!canViewScmFinance(c)) {
    for (const k of DO_FINANCE_KEYS) delete (deliveryOrder as Record<string, unknown>)[k];
    for (const it of items) {
      for (const k of SO_ITEM_FINANCE_KEYS) delete (it as Record<string, unknown>)[k];
    }
  }
  // Stamp each line's supplier fabric code so the on-screen line reads
  // "BF-01 (PC151-01)" (owner 2026-07-24). ONE batched query; fail-soft.
  await enrichLinesWithFabricSupplierCode(sb, c, items);
  return c.json({ deliveryOrder, items });
});

// ── Create ──────────────────────────────────────────────────────────────
// Accepts the full SO-cloned header (debtor / salesperson / address /
// payment-as-drafts / line items) so the Create-DO screen (prefilled from an
// SO) can save in one shot. Line items + payments are optional.
deliveryOrdersMfg.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const debtorName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!debtorName) return c.json({ error: 'debtor_name_required' }, 400);
  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];

  const sb = c.get('supabase'); const user = c.get('user');

  /* Edge #4 — itemCode catalog guard. */
  if (items.length > 0) {
    const codeCheck = await validateItemCodes(sb, items.map((it) => it.itemCode as string | null | undefined));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* Audit gap #4 — the source SO must be committed (CONFIRMED or beyond) before a
     DO can ship against it. Check the header soDocNo AND every SO referenced by a
     line's soItemId (a line can carry an SO link without a header soDocNo). Purely
     manual/ad-hoc lines (no SO link at all) skip this — that path is unchanged. */
  {
    const refDocNos: Array<string | null | undefined> = [(body.soDocNo as string | undefined) ?? null];
    const lineSoItemIds = items
      .map((it) => it.soItemId as string | undefined)
      .filter((x): x is string => !!x);
    if (lineSoItemIds.length > 0) {
      const { data: lineSoRows } = await sb
        .from('mfg_sales_order_items').select('doc_no').in('id', lineSoItemIds);
      for (const r of (lineSoRows ?? []) as Array<{ doc_no: string | null }>) refDocNos.push(r.doc_no);
    }
    const offender = await firstUndeliverableSo(sb, refDocNos);
    if (offender) return c.json(soNotDeliverableResponse(offender), 409);

    /* CROSS-COMPANY GUARD — this create path stamps the ACTIVE company on the
       new DO (see the insert below), so converting another company's SO here
       would re-company the order: a 2990 SO shipped out as a HOUZS DO, moving
       2990's stock and revenue onto Houzs' books. The mirrored 2990 SO rows
       legitimately live in this database; claiming them as Houzs documents is
       what must not happen.

       Checked over the SAME refDocNos set as the deliverability guard above,
       so a cross-company SO reached only through a line's soItemId — with no
       header soDocNo at all — is caught too. The multi-SO POST /from-sos path
       is deliberately NOT guarded this way: it INHERITS the source SO's
       company and mints under the source's prefix, which is the correct
       cross-company behaviour for the shared Delivery Planning queue. */
    const soDocNos = [...new Set(refDocNos.filter((d): d is string => !!d))];
    if (soDocNos.length > 0) {
      const { data: soCoRows, error: soCoErr } = await sb
        .from('mfg_sales_orders').select('doc_no, company_id').in('doc_no', soDocNos);
      if (soCoErr) return c.json({ error: 'load_failed', reason: soCoErr.message }, 500);
      for (const r of (soCoRows ?? []) as Array<{ doc_no: string; company_id: number | null }>) {
        if (isCrossCompanySource(r.company_id, c)) {
          return c.json(crossCompanyConversionBlocked(r.doc_no, r.company_id, c), 409);
        }
      }
    }
  }

  /* Edge #1+#2 — soft stock check, gated by confirmShortStock.
     The check now runs even on the CONFIRMED replay, because its answer is what
     tells the binding decision below how much was actually on hand. It is the
     one question the operator was asked ("the goods are not here — ship
     anyway?"); deriving the binding from a second, separately-measured source
     is how the two would come to disagree. Only the 409 is gated. */
  const shipWarehouseId = (body.warehouseId as string | undefined) ?? (await defaultWarehouseId(sb));
  let shortages: StockShortage[] = [];
  let commitments = new Map<string, ShipBinding>();
  if (items.length > 0 && shipWarehouseId) {
    const stockLines = items.map((it) => ({
      itemCode: String(it.itemCode ?? ''),
      productName: (it.description as string | null) ?? null,
      variantKey: computeVariantKey((it.itemGroup as string | null) ?? null, (it.variants as VariantAttrs | null) ?? null),
      qty: Number(it.qty ?? 0),
    }));
    shortages = await checkStockAvailability(sb, shipWarehouseId, stockLines);
    /* Binding follows the fact (mig 0230): a line that ships before its goods
       arrive and resolves exactly one live bound PO carries that PO's batch,
       whichever dialog the operator happened to answer. Resolved BEFORE the 409
       so the single "ship anyway?" dialog can name the incoming PO. */
    commitments = await resolveShipCommitments(
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
    );
    if (shortages.length > 0 && !body.confirmShortStock) {
      markIdempotencyNoWrite(c);
      return c.json(shortStockResponse(shortages, bindingList(commitments)), 409);
    }
  }

  /* Commander 2026-05-30 — the old whole-SO "already_converted" binary lock is
     GONE. Delivery is now line-level + quantity-based (see
     soDeliverableRemaining): an SO line can be split across several DOs until
     its remaining hits 0. This single-SO prefill path creates a full-qty DO
     as before; the partial/multi path lives in POST /from-sos. */

  /* Remaining-qty guard (Wei Siang 2026-05-30) — any line that traces back to
     an SO line (soItemId set) may not push that SO line past its ordered qty.
     Mirrors the /from-sos picker's over_remaining gate so this create path
     can't become a back door. Ad-hoc lines (no soItemId) are uncapped. */
  {
    const additions = new Map<string, number>();
    for (const it of items) {
      const sid = it.soItemId as string | undefined;
      if (!sid) continue;
      additions.set(sid, (additions.get(sid) ?? 0) + Number(it.qty ?? 0));
    }
    if (additions.size > 0) {
      const remaining = await soRemainingByItemId(sb, [...additions.keys()]);
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

  /* Sofa batch guard (Wei Siang 2026-06-01) — a sofa set with NO production PO
     has no dye-lot batch; shipping it would pull another order's colour lot.
     Block here (applies even to a force-grab: confirmShortStock waives the soft
     stock check, NOT the no-batch rule). Non-sofa lines pass untouched. */
  let dropShipped = false;
  if (items.length > 0) {
    const sofaOffenders = await findSofaLinesWithoutCompleteBatch(sb, items.map((it) => ({
      itemCode: String(it.itemCode ?? ''),
      itemGroup: (it.itemGroup as string | null) ?? null,
      soItemId: (it.soItemId as string | null) ?? null,
    })));
    if (sofaOffenders.length > 0) {
      /* Drop-ship waiver (port of 2990 07c45728) — supplier ships the sofa
         direct, warehouse has no batch. Waive the Type-A no-batch block ONLY
         when the operator confirmed dropShip AND every affected line has a
         bound PO (the incoming dye-lot batch must be known). Without dropShip,
         surface the 409 enriched with each line's bound PO + ETA so the UI can
         offer the dialog. */
      const dropship = await buildDropshipOffenders(sb, sofaOffenders);
      const allHavePo = dropship.length > 0 && dropship.every((o) => !!o.poNumber);
      if (body.dropShip !== true || !allHavePo) {
        markIdempotencyNoWrite(c);
        return c.json(sofaNoCompleteBatchResponse(sofaOffenders, dropship), 409);
      }
      dropShipped = true;
    }
    /* Type B — a sofa set must ship WHOLE from one batch. Block a DO that takes
       only part of an SO's sofa set and leaves the rest behind (orphan dye lot).
       NEVER waived by drop-ship — half a set must never ship. */
    const partial = await findIncompleteSofaSets(sb, items.map((it) => (it.soItemId as string | null) ?? null));
    if (partial.length > 0) {
      markIdempotencyNoWrite(c);
      return c.json(sofaIncompleteSetResponse(partial), 409);
    }
  }

  const phoneRaw = (body.phone as string | undefined) ?? null;
  const emPhoneRaw = (body.emergencyContactPhone as string | undefined) ?? null;

  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; do_number: string }>(
    () => nextNum(sb, c),
    (doNumber) => sb.from('delivery_orders').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    do_number: doNumber,
    so_doc_no: (body.soDocNo as string) ?? null,
    debtor_code: (body.debtorCode as string) ?? null,
    debtor_name: debtorName,
    /* Coerce empty-string dates to null — an unfilled date input posts "" and
       `?? null` does NOT catch it (nullish only), so "" reached the date column
       and Postgres rejected it ("invalid input syntax for type date"). This was
       masked until the sofa drop-ship guard stopped hard-blocking before the insert. */
    do_date: emptyDate(body.doDate) ?? todayMyt(),
    expected_delivery_at: emptyDate(body.expectedDeliveryAt) ?? emptyDate(body.customerDeliveryDate),
    customer_delivery_date: emptyDate(body.customerDeliveryDate),
    /* Mig 0053 (port of 2990 0199) — sea-freight DO-execution column. */
    arrives_em_warehouse_date: emptyDate(body.arrivesEmWarehouseDate),
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
    ref: (body.ref as string) ?? null,
    customer_so_no: (body.customerSoNo as string) ?? null,
    po_doc_no: (body.poDocNo as string) ?? null,
    sales_location: (body.salesLocation as string) ?? null,
    note: (body.note as string) ?? null,
    emergency_contact_name: (body.emergencyContactName as string) ?? null,
    emergency_contact_phone: emPhoneRaw ? (normalizePhone(emPhoneRaw) ?? emPhoneRaw) : null,
    emergency_contact_relationship: (body.emergencyContactRelationship as string) ?? null,
    currency: (body.currency as string) ?? 'MYR',
    /* Commander 2026-05-29 — a DO means goods are OUT the moment it's created.
       Skip the LOADED→DISPATCHED→IN_TRANSIT… hand-walk: start at DISPATCHED
       (= shipped) and deduct stock right after the items insert below.
       DRAFT flow (2026-06-24) — opt-in asDraft lands the DO as DRAFT instead,
       with NO stock deduction and NO SO-delivered sync; the commit moves to the
       Confirm transition (PATCH /:id/status → DISPATCHED). Mirror of the SO. */
    status: (body.asDraft === true) ? 'DRAFT' : 'DISPATCHED',
    /* Drop-ship (mig 0057) — flags the UI badge; inventory reconcile is ledger-driven. */
    is_dropship: dropShipped,
    notes: (body.notes as string) ?? null,
    created_by: user.id,
    }).select(HEADER).single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; do_number: string };

  if (items.length > 0) {
    const rows = items.map((it, lineNo) => buildItemRow(h.id, it, lineNo, commitments.get(String(lineNo))?.poNumber ?? null));
    const { error: iErr } = await sb.from('delivery_order_items').insert(stampCompany(rows, c));
    if (iErr) { await sb.from('delivery_orders').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }
    await recomputeTotals(sb, h.id);
  }

  /* Audit gap #3 — post-insert race recheck on LINKED lines (mirrors the safe
     pattern already in /from-sos). The pre-insert remaining-qty guard above is
     read-before-write, so two concurrent creates on the same SO line could both
     pass and over-deliver. After inserting (and BEFORE any stock OUT), re-derive
     the live remaining for each SO-linked line and ROLL BACK the whole DO if any
     went negative. Ad-hoc (unlinked) lines are not tracked by soDeliverableRemaining,
     so they never trip this — the intentional manual-delivery path stays uncapped.
     Skipped for a DRAFT DO (its lines don't count toward remaining until Confirm). */
  if (body.asDraft !== true && items.length > 0) {
    const linkedSoItemIds = items
      .map((it) => it.soItemId as string | undefined)
      .filter((x): x is string => !!x);
    if (linkedSoItemIds.length > 0) {
      const recheck = await soRemainingByItemId(sb, linkedSoItemIds);
      const overcommitted = [...new Set(linkedSoItemIds)].filter((sid) => (recheck.get(sid) ?? 0) < 0);
      if (overcommitted.length > 0) {
        // Undo: delete the DO + its lines. No stock has been deducted yet.
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

  /* The DO has survived both compensating branches (items-insert rollback,
     race-conflict rollback). The stock deduction and the SO sync below report
     their failures rather than undoing the DO, so from here the document exists
     on every remaining exit and this CREATE row is true. */
  await recordDoCreate(sb, c.get('houzsUser'), activeCompanyId(c), h.id, items.length);

  /* A DO = goods shipped on creation → deduct stock now (idempotent: the
     existence check + UNIQUE index mean this never double-deducts even if the
     status is later advanced). LEAK GUARD (DRAFT): a DRAFT DO has NOT shipped —
     skip the deduction AND the SO-delivered sync; both fire on Confirm. */
  let movementErrors: string[] = [];
  let emailNotice: string | null = null;
  if (body.asDraft !== true) {
    movementErrors = await deductInventoryForDo(sb, h.id, user.id);

    /* Requirement #3 (Loo 2026-05-30) — if this DO now fully covers its SO,
       auto-advance the SO to DELIVERED (best-effort, never blocks the DO). The
       POS "My orders" board reflects the flip via Supabase realtime. */
    await syncSoDeliveredFromDo(sb, [(body.soDocNo as string) ?? null], user.id);

    /* Customer DO email (owner trigger "A", 2026-07-17). A non-draft create IS
       the confirm — the DO is born DISPATCHED — so this is the same event the
       deduction above fires on. Gated OFF and fail-closed inside; best-effort,
       never blocks the DO. */
    emailNotice = await maybeSendDeliveryOrderEmail(sb, c.env, h.id);
  }

  /* SO↔DO amend mirror (Houzs port of 2990 fc7f0900, extended) — same rule as
     the PATCH handler: if the DO-create payload carries any of the amend
     fields, mirror them onto the parent SO (NEVER overwriting
     customer_delivery_date). Best-effort + post-insert so a transient mirror
     failure never voids a successful DO create. The DO itself has no amend
     columns, so these are SO-only mirrors. */
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

  return c.json({
    id: h.id,
    doNumber: h.do_number,
    movementErrors: movementErrors.length ? movementErrors : undefined,
    emailNotice: emailNotice ?? undefined,
    so_amend_mirrored: soAmendMirrored,
    so_mirror_error: soAmendMirrorError,
  }, 201);
});

/* Build one delivery_order_items insert row from a client line payload.
   Shared by POST / (bulk create) and POST /:id/items (single add). Computes
   line_total / line_cost / margin so recomputeTotals can roll them up.
   `lineNo` (0165) = the DO's listing position; omit/null for un-numbered. */
/** Empty-string dates ("" from an unfilled input) become null; a real date passes
 *  through trimmed. Postgres date columns reject "" but accept null. */
function emptyDate(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
}

/* `committedPoBatchNo` is NEVER read off the request body — it is passed in by
   the route from planShipCommitments, so a client cannot claim a binding the
   ledger has not earned (it decides which receipt gets to net this OUT). */
function buildItemRow(
  deliveryOrderId: string,
  it: Record<string, unknown>,
  lineNo?: number | null,
  committedPoBatchNo?: string | null,
) {
  const qty = Number(it.qty ?? 1);
  const unitPrice = Number(it.unitPriceCenti ?? 0);
  const discount = Number(it.discountCenti ?? 0);
  const unitCost = Number(it.unitCostCenti ?? 0);
  // Audit 2026-06-20 — clamp like the PO create path (negative-money guard).
  const lineTotal = Math.max(0, (qty * unitPrice) - discount);
  const lineCost = qty * unitCost;
  const itemGroup = (it.itemGroup as string) ?? null;
  const variants = (it.variants as unknown) ?? null;
  return {
    delivery_order_id: deliveryOrderId,
    so_item_id: (it.soItemId as string | undefined) ?? null,
    item_code: it.itemCode,
    item_group: itemGroup,
    description: (it.description as string) ?? null,
    description2: buildVariantSummary(String(itemGroup ?? ''), (variants as Record<string, unknown> | null) ?? null) || (it.description2 as string) || null,
    uom: (it.uom as string) ?? 'UNIT',
    qty,
    m3_milli: Number(it.m3Milli ?? 0),
    unit_price_centi: unitPrice,
    discount_centi: discount,
    line_total_centi: lineTotal,
    unit_cost_centi: unitCost,
    line_cost_centi: lineCost,
    line_margin_centi: lineTotal - lineCost,
    variants,
    /* Migration 0058 — carry the dedicated variant-breakdown columns from the
       client line payload (manual add already carries variants + line date). */
    gap_inches: (it.gapInches as number | null) ?? null,
    divan_height_inches: (it.divanHeightInches as number | null) ?? null,
    divan_price_sen: Number(it.divanPriceSen ?? 0),
    leg_height_inches: (it.legHeightInches as number | null) ?? null,
    leg_price_sen: Number(it.legPriceSen ?? 0),
    custom_specials: (it.customSpecials as unknown) ?? null,
    line_suffix: (it.lineSuffix as string | null) ?? null,
    special_order_price_sen: Number(it.specialOrderPriceSen ?? 0),
    notes: (it.notes as string) ?? null,
    line_delivery_date: (it.lineDeliveryDate as string | null) ?? null,
    line_delivery_date_overridden: Boolean(it.lineDeliveryDateOverridden ?? false),
    /* REC P4 (mig 0118) — the SOURCE rack this line ships from. Null = let the
       dispatch chokepoint auto-pick the rack holding this product. */
    rack_id: (it.rackId as string | undefined) || null,
    /* Mig 0230 — the incoming PO batch this line is shipping AGAINST, when it
       ships before the goods arrive. */
    committed_po_batch_no: committedPoBatchNo ?? null,
    ...(typeof lineNo === 'number' ? { line_no: lineNo } : {}),
  };
}

// ── Convert picked SO LINES (partial qty) → ONE DO ────────────────────────
/* Commander 2026-05-30 — LINE-LEVEL, QUANTITY-BASED convert. Mirrors the PO's
   line-level from-SO picker. Pick individual SO LINES (each with a qty 1..
   remaining) belonging to ONE customer and combine them into ONE Delivery
   Order. An SO line can be delivered across SEVERAL DOs until its remaining
   (qty − delivered + returned, derived live) reaches 0.

   Body: { picks: [{ soItemId, qty }] }.

   Steps:
     1. Resolve every picked SO line's parent SO + live remaining via
        soDeliverableRemaining.
     2. Validate (a) all picks share ONE customer (else 400 mixed_customers),
        (b) each pick qty is 1..remaining (else 409 over_remaining with the
        offending line).
     3. Create ONE DO — header copied from the FIRST pick's SO; so_doc_no = that
        SO; ref = "Merged from <distinct SO doc_nos>" when the picks span >1 SO.
        One DO line per pick (qty = picked qty, so_item_id = soItemId).
     4. recomputeTotals + deductInventoryForDo (both idempotent). */
deliveryOrdersMfg.post('/from-sos', async (c) => {
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { picks?: Array<{ soItemId?: string; qty?: number }>; confirmShortStock?: boolean; warehouseId?: string; asDraft?: boolean; dropShip?: boolean };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }

  // Collapse duplicate soItemIds (sum their qty) so a line can't appear twice.
  const pickQtyById = new Map<string, number>();
  for (const p of (body.picks ?? [])) {
    if (!p || !p.soItemId) continue;
    const q = Number(p.qty ?? 0);
    if (!(q > 0)) continue;
    pickQtyById.set(p.soItemId, (pickQtyById.get(p.soItemId) ?? 0) + q);
  }
  if (pickQtyById.size === 0) return c.json({ error: 'picks_required' }, 400);

  // 1. Resolve the SO lines + their live remaining. We don't know the docNos
  //    yet, so first map picked SO item ids → their doc_no, then derive
  //    remaining scoped to exactly those SOs.
  const pickedIds = [...pickQtyById.keys()];
  const { data: pickedItemRows, error: pErr } = await sb
    .from('mfg_sales_order_items')
    .select('id, doc_no')
    .in('id', pickedIds);
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  const idToDoc = new Map<string, string>();
  for (const r of (pickedItemRows ?? []) as Array<{ id: string; doc_no: string }>) idToDoc.set(r.id, r.doc_no);
  const missing = pickedIds.filter((id) => !idToDoc.has(id));
  if (missing.length > 0) return c.json({ error: 'so_item_not_found', missing }, 404);

  const docNos = [...new Set([...idToDoc.values()])];

  /* Audit gap #4 — every source SO must be committed (CONFIRMED or beyond) before
     its lines can ship into a DO. Blocks a DRAFT / ON_HOLD / CANCELLED SO. */
  {
    const offender = await firstUndeliverableSo(sb, docNos);
    if (offender) return c.json(soNotDeliverableResponse(offender), 409);
  }

  const remainingMap = await soDeliverableRemaining(sb, docNos);

  // 2a. Same-customer guard — every picked line must share ONE customer
  //     (debtor_code, else debtor_name). A DO ships to ONE customer.
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

  // 2b. Per-line qty guard — 1..remaining. Reject the first offender (the
  //     picker shows remaining so this only trips on a stale view / race).
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

  // 3. Create ONE DO header from the FIRST pick's SO. "First" = the SO of the
  //    earliest-sorted picked line so the result is deterministic.
  const sortedPicks = pickedIds
    .map((id) => remainingMap.get(id)!)
    /* lineSeq = the SO's own listing order (mains first, sofa modules
       left-to-right) so the DO reads like its SO; the uuid tiebreak only
       guards determinism if two lines ever shared a seq. */
    .sort((a, b) => a.docNo.localeCompare(b.docNo) || (a.lineSeq - b.lineSeq) || a.soItemId.localeCompare(b.soItemId));
  const firstSoDocNo = sortedPicks[0]!.docNo;

  /* Sofa batch guard — block any picked sofa line with no production PO (no
     dye-lot batch ⇒ would steal another order's colour lot). Applies even to a
     force-grab (confirmShortStock waives soft stock, NOT the no-batch rule). */
  let dropShipped = false;
  {
    const sofaOffenders = await findSofaLinesWithoutCompleteBatch(sb, sortedPicks.map((line) => ({
      itemCode: line.itemCode,
      itemGroup: line.itemGroup ?? null,
      soItemId: line.soItemId,
    })));
    if (sofaOffenders.length > 0) {
      /* Drop-ship waiver (mig 0057) — waive Type-A only on confirmed dropShip +
         every affected line bound to a PO (the incoming batch must be known). */
      const dropship = await buildDropshipOffenders(sb, sofaOffenders);
      const allHavePo = dropship.length > 0 && dropship.every((o) => !!o.poNumber);
      if (body.dropShip !== true || !allHavePo) {
        markIdempotencyNoWrite(c);
        return c.json(sofaNoCompleteBatchResponse(sofaOffenders, dropship), 409);
      }
      dropShipped = true;
    }
    /* Type B — whole sofa set must ship together (no partial set / orphan).
       NEVER waived by drop-ship. */
    const partial = await findIncompleteSofaSets(sb, sortedPicks.map((line) => line.soItemId));
    if (partial.length > 0) {
      markIdempotencyNoWrite(c);
      return c.json(sofaIncompleteSetResponse(partial), 409);
    }
  }

  // Edge #1+#2 — soft stock check at the target warehouse, gated by
  // confirmShortStock. Returns 409 short_stock with cross-warehouse alternatives
  // so the picker can offer "ship anyway / switch warehouse / reduce qty".
  // Runs on the CONFIRMED replay too — its answer feeds the binding decision
  // below, so both come from the one measurement the operator was shown.
  const shipWarehouseId = body.warehouseId ?? (await defaultWarehouseId(sb));
  let shortages: StockShortage[] = [];
  if (shipWarehouseId) {
    const stockLines = sortedPicks.map((line) => ({
      itemCode: line.itemCode,
      productName: line.description,
      variantKey: computeVariantKey(line.itemGroup ?? null, (line.variants as VariantAttrs | null) ?? null),
      qty: pickQtyById.get(line.soItemId) ?? 0,
    }));
    shortages = await checkStockAvailability(sb, shipWarehouseId, stockLines);
  }

  /* Binding follows the fact (mig 0230) — per PICK, not per header flag. This is
     the path where the all-or-nothing header decision hurt most: a merged DO can
     span several SOs, and one unresolvable line used to deny the netting to
     every other line that could have had it. Resolved BEFORE the 409 so the one
     "ship anyway?" dialog can name the incoming PO. */
  const commitments = await resolveShipCommitments(
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
  );
  if (shortages.length > 0 && !body.confirmShortStock) {
    markIdempotencyNoWrite(c);
    return c.json(shortStockResponse(shortages, bindingList(commitments)), 409);
  }

  // Pull the FIRST SO's header for the DO header snapshot (address / salesperson
  // / branding / venue / contact). Lines carry their own debtor snapshot.
  // Column list + load are SHARED with GET /so-source/:docNo (see the header on
  // loadSoHeaderForConversion) so the form's preview and this commit can never
  // disagree about which SO fields carry across.
  const loaded = await loadSoHeaderForConversion(sb, firstSoDocNo);
  if (loaded.error) return c.json({ error: 'load_failed', reason: loaded.error }, 500);
  if (!loaded.head) return c.json({ error: 'not_found' }, 404);
  const head = loaded.head;

  const doAddress2 = (head.address2 as string | null)
    ?? ([head.address3, head.address4].filter(Boolean).join(', ') || null);
  const phoneRaw = head.phone as string | null;
  const emPhoneRaw = head.emergency_contact_phone as string | null;
  const today = todayMyt();

  // Mint the DO number under the SOURCE SO's company prefix (2990 SO → "2990-DO-…"),
  // matching the company_id stamp below, so a 2990 DO converted while browsing as
  // Houzs isn't a company-2 row with a Houzs-style bare number. undefined → nextNum
  // falls back to the active company's prefix (pre-migration SOs without company_id).
  const srcCode = head.company_id != null ? companyCodeMap(c).get(Number(head.company_id)) : undefined;
  const srcPrefix = srcCode != null ? (srcCode !== 'HOUZS' ? `${srcCode}-` : '') : undefined;

  const { data: doHeader, error: hErr } = await insertWithDocNoRetry<{ id: string; do_number: string }>(
    () => nextNum(sb, c, srcPrefix),
    (doNumber) => sb.from('delivery_orders').insert({
    /* multi-company: stamp the SOURCE SO's company, NOT the active one. The
       Delivery Planning board is a SHARED cross-company queue, so a 2990 SO may
       be converted while browsing as Houzs — the DO must inherit the SO's
       company (2990) regardless of who converts. Falls back to the active
       company only when the SO header carries no company_id (pre-migration). */
    company_id: (head.company_id as number | null) ?? activeCompanyId(c),
    do_number: doNumber,
    /* so_doc_no has a FK to mfg_sales_orders(doc_no) → one valid doc. The full
       set of source SOs is recorded in `ref` below when the picks span >1 SO. */
    so_doc_no: firstSoDocNo,
    debtor_code: (head.debtor_code as string | null) ?? null,
    debtor_name: (head.debtor_name as string | null) ?? null,
    do_date: today,
    expected_delivery_at: (head.customer_delivery_date as string | null) ?? today,
    customer_delivery_date: (head.customer_delivery_date as string | null) ?? null,
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
    /* A DO means goods are OUT the moment it's created — start at DISPATCHED
       (= shipped) and deduct stock below. DRAFT flow (2026-06-24) — opt-in
       asDraft lands the DO as DRAFT (no stock OUT, no SO sync); the commit
       moves to the Confirm transition. Mirror of the SO. */
    status: (body.asDraft === true) ? 'DRAFT' : 'DISPATCHED',
    /* Drop-ship (mig 0057) — flags the UI badge; inventory reconcile is ledger-driven. */
    is_dropship: dropShipped,
    created_by: user.id,
    }).select('id, do_number').single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const dh = doHeader as unknown as { id: string; do_number: string };

  // 3b. One DO line per pick — qty = the picked qty (NOT the full SO line qty).
  //     Carry cost so margins survive. line_no (0165) = the sortedPicks
  //     position, i.e. the SO's listing order carried onto the DO.
  const doRows = sortedPicks.map((line, lineNo) => {
    const qty = pickQtyById.get(line.soItemId)!;
    const unit = line.unitPriceCenti;
    const discount = line.discountCenti;
    const unitCost = line.unitCostCenti;
    // Audit 2026-06-20 — clamp like the PO create path (negative-money guard).
    const lineTotal = Math.max(0, (qty * unit) - discount);
    const lineCost = qty * unitCost;
    const itemGroup = line.itemGroup;
    const variants = line.variants ?? null;
    return {
      delivery_order_id: dh.id,
      line_no: lineNo,
      so_item_id: line.soItemId,
      item_code: line.itemCode,
      item_group: itemGroup,
      description: line.description ?? null,
      description2: buildVariantSummary(String(itemGroup ?? ''), (variants as Record<string, unknown> | null) ?? null) || line.description2 || null,
      uom: line.uom ?? 'UNIT',
      qty,
      m3_milli: 0,
      unit_price_centi: unit,
      discount_centi: discount,
      line_total_centi: lineTotal,
      unit_cost_centi: unitCost,
      line_cost_centi: lineCost,
      line_margin_centi: lineTotal - lineCost,
      variants,
      /* Migration 0058 — carry the dedicated variant-breakdown columns from the
         SO line onto the DO line (the picker previously dropped all 8, so sofa/
         bedframe builds lost their breakdown on SO→DO convert). */
      gap_inches: line.gapInches ?? null,
      divan_height_inches: line.divanHeightInches ?? null,
      divan_price_sen: line.divanPriceSen ?? 0,
      leg_height_inches: line.legHeightInches ?? null,
      leg_price_sen: line.legPriceSen ?? 0,
      custom_specials: line.customSpecials ?? null,
      line_suffix: line.lineSuffix ?? null,
      special_order_price_sen: line.specialOrderPriceSen ?? 0,
      committed_po_batch_no: commitments.get(line.soItemId)?.poNumber ?? null,
    };
  });
  const { error: iErr } = await sb.from('delivery_order_items').insert(stampCompany(doRows, c));
  if (iErr) {
    // Roll the header back so we don't leave a headerless DO.
    await sb.from('delivery_orders').delete().eq('id', dh.id);
    return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500);
  }

  /* Edge #E — race-condition guard. The Phase B over_remaining check above is
     read-before-write, so two parallel converts on the same SO line could both
     pass and over-allocate. After inserting, re-derive remaining for the picked
     SO lines and ROLLBACK (delete the just-created DO) when any line has gone
     negative. Cheap belt-and-suspenders on top of the front-end's optimism. */
  {
    const recheck = await soDeliverableRemaining(sb, docNos);
    const overcommitted = pickedIds
      .map((sid) => recheck.get(sid))
      .filter((l): l is DeliverableLine => l !== undefined && l.remaining < 0);
    if (overcommitted.length > 0) {
      // Undo: delete the DO + its lines. Inventory wasn't deducted yet — we
      // haven't called deductInventoryForDo at this point in the flow.
      await sb.from('delivery_order_items').delete().eq('delivery_order_id', dh.id);
      await sb.from('delivery_orders').delete().eq('id', dh.id);
      return c.json({
        error: 'race_conflict',
        message: 'Another operator just converted overlapping qty from this Sales Order. Refresh the picker and try again.',
        conflicts: overcommitted.map((l) => ({ docNo: l.docNo, itemCode: l.itemCode, remaining: l.remaining })),
      }, 409);
    }
  }

  // 4. Roll up the header totals + deduct stock (both idempotent). LEAK GUARD
  //    (DRAFT): a DRAFT DO has not shipped — roll up totals but SKIP the stock
  //    OUT and the SO-delivered sync; both fire on Confirm.
  await recomputeTotals(sb, dh.id);

  /* Past both compensating branches (items-insert rollback, race-conflict
     rollback) — the DO is permanent from here. Written after recomputeTotals so
     localTotalCenti is the rolled-up figure. */
  await recordDoCreate(
    sb, c.get('houzsUser'), activeCompanyId(c), dh.id, doRows.length,
    `Converted from Sales Order${docNos.length === 1 ? '' : 's'} ${docNos.join(', ')}`,
  );

  let movementErrors: string[] = [];
  let emailNotice: string | null = null;
  if (body.asDraft !== true) {
    movementErrors = await deductInventoryForDo(sb, dh.id, user.id);

    /* Requirement #3 — a multi-SO DO may complete several SOs at once; check each
       source SO for full coverage and auto-advance to DELIVERED (best-effort). */
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
  }, 201);
});

/* ── Crew assignment (scm.delivery_order_crew, migration 0053) ────────────────
   PUT /:id/crew — assign up to 2 drivers + 2 helpers + 1 lorry to a DO. The body
   carries the chosen master ids (any nullable); the handler loads each master row
   and UPSERTS one delivery_order_crew row (UNIQUE do_id) writing the FK ids PLUS
   an assign-time SNAPSHOT of name/ic/contact/plate — the same denormalised
   pattern the DO header already uses for driver_name, so the crew record is
   stable if a master is later edited. The DO header's existing driver_id /
   driver_name / vehicle quick-fields are kept in sync with driver 1 so the
   "primary driver" field still reflects the first driver. */
deliveryOrdersMfg.put('/:id/crew', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  // The DO must exist (FK target + so the header sync below has a row to update).
  const { data: doRow, error: doErr } = await sb.from('delivery_orders')
    .select('id, company_id, do_number, status').eq('id', id).maybeSingle();
  if (doErr) return c.json({ error: 'load_failed', reason: doErr.message }, 500);
  if (!doRow) return c.json({ error: 'not_found' }, 404);

  /* The crew row as it stands BEFORE the upsert. This endpoint is a PUT, so a
     re-assign silently overwrites whoever was on the job — without this read the
     history could only say who is on it now, never who was taken off it. */
  const { data: crewBeforeRow } = await sb.from('delivery_order_crew')
    .select('driver_1_id, driver_2_id, helper_1_id, helper_2_id, lorry_id, driver_1_name, driver_2_name, helper_1_name, helper_2_name, lorry_plate')
    .eq('do_id', id).maybeSingle();
  const crewBefore = (crewBeforeRow ?? {}) as Record<string, unknown>;

  const str = (v: unknown): string | null => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
  };
  const driver1Id = str(body.driver1Id);
  const driver2Id = str(body.driver2Id);
  const helper1Id = str(body.helper1Id);
  const helper2Id = str(body.helper2Id);
  const lorryId   = str(body.lorryId);

  // Load the chosen master rows so the snapshot captures what's true at assign
  // time. Batched per master (PostgREST returns snake_case columns directly).
  const driverIds = [...new Set([driver1Id, driver2Id].filter((x): x is string => !!x))];
  const helperIds = [...new Set([helper1Id, helper2Id].filter((x): x is string => !!x))];

  type DriverRow = { id: string; name?: string | null; ic_number?: string | null; phone?: string | null; vehicle?: string | null };
  type HelperRow = { id: string; name?: string | null; contact?: string | null; ic_number?: string | null };
  type LorryRow  = { id: string; plate?: string | null };

  const driverById = new Map<string, DriverRow>();
  const helperById = new Map<string, HelperRow>();

  const [driverRes, helperRes, lorryRes] = await Promise.all([
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
  const doCompanyId = (doRow as { company_id?: number | null }).company_id ?? activeCompanyId(c);
  const crewRow = {
    // Multi-company: the crew row inherits its DO's company (a cross-company
    // planner may assign crew while a different company is active).
    ...(doCompanyId != null ? { company_id: doCompanyId } : {}),
    do_id: id,
    driver_1_id: driver1Id, driver_2_id: driver2Id,
    helper_1_id: helper1Id, helper_2_id: helper2Id,
    lorry_id: lorryId,
    // snapshots captured at assign time
    // Crew contacts are snapshotted from the drivers/helpers master, which
    // normalises on write — but a legacy/un-migrated master row could still be
    // raw, so re-normalise defensively (keeps an already-E.164 value unchanged).
    driver_1_name: d1?.name ?? null, driver_1_ic: d1?.ic_number ?? null, driver_1_contact: d1?.phone ? (normalizePhone(d1.phone) ?? d1.phone) : null,
    driver_2_name: d2?.name ?? null, driver_2_ic: d2?.ic_number ?? null, driver_2_contact: d2?.phone ? (normalizePhone(d2.phone) ?? d2.phone) : null,
    helper_1_name: h1?.name ?? null, helper_1_contact: h1?.contact ? (normalizePhone(h1.contact) ?? h1.contact) : null,
    helper_2_name: h2?.name ?? null, helper_2_contact: h2?.contact ? (normalizePhone(h2.contact) ?? h2.contact) : null,
    lorry_plate: lorry?.plate ?? null,
    assigned_by: user.id,
    updated_at: now,
  };

  // UPSERT on the UNIQUE do_id — idempotent (re-assign overwrites the crew row,
  // keeping a single row per DO). assigned_at defaults on first insert; we leave
  // it untouched on conflict so it records the original assign time, and bump
  // updated_at each save.
  const { data: crew, error: crewErr } = await sb.from('delivery_order_crew')
    .upsert(crewRow, { onConflict: 'do_id' })
    .select(crewSnapshotCols).maybeSingle();
  if (crewErr) {
    if (crewErr.code === '42501') return c.json({ error: 'forbidden', reason: crewErr.message }, 403);
    return c.json({ error: 'crew_save_failed', reason: crewErr.message }, 500);
  }

  /* Keep the DO header's primary-driver quick-fields in lock-step with driver 1
     (driver_id / driver_name / vehicle), so the existing Driver / Vehicle fields
     on the DO still reflect the first crew driver. Clearing driver 1 clears them. */
  await sb.from('delivery_orders').update({
    driver_id: driver1Id,
    driver_name: d1?.name ?? null,
    vehicle: d1?.vehicle ?? lorry?.plate ?? null,
    updated_at: now,
  }).eq('id', id);

  /* Who was assigned to drive the goods, and who they replaced. The NAMES are
     recorded alongside the ids for the same reason the crew row snapshots them:
     an id alone stops meaning anything once a master row is edited. A re-assign
     that changed nobody writes no row (compactChanges drops the no-ops). */
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

  return c.json({ crew });
});

// ── Header PATCH (editable SO-style fields) ───────────────────────────────
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
    /* HC delivery-sheet DO-execution raw-data fields — also editable from the
       Delivery Planning "Edit HC fields" drawer (same DO_FIELD_COLS columns);
       surfaced on the DO detail form's Delivery Execution card. */
    ['timeRange', 'time_range'],
    ['timeConfirmed', 'time_confirmed'],
    ['arrivalAt', 'arrival_at'],
    ['departureAt', 'departure_at'],
    ['shipoutDate', 'shipout_date'],
    ['customerDeliveredDate', 'customer_delivered_date'],
    ['etaArrivingPort', 'eta_arriving_port'],
    ['deliverySubstatus', 'delivery_substatus'],
    /* Mig 0053 (port of 2990 0199) — DO-side sea-freight execution date. */
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

  /* Whitelist the HC "Remark 4" delivery sub-status to the known values (blank /
     null always clears it) — mirrors the Delivery Planning /fields route, so the
     same column can't be set to a stray value from either edit surface. */
  if (updates.delivery_substatus != null && updates.delivery_substatus !== '' &&
      !(HC_SUBSTATUS_VALUES as readonly string[]).includes(String(updates.delivery_substatus))) {
    return c.json({ error: 'invalid_substatus', reason: `delivery_substatus must be one of: ${HC_SUBSTATUS_VALUES.join(', ')} (or blank).` }, 400);
  }
  if (updates.delivery_substatus === '') updates.delivery_substatus = null;

  /* SO↔DO amend mirror (Houzs port of 2990 fc7f0900, extended). The 2990 commit
     only wires read-only mirror cards in the frontend (each doc edits its own
     level). Houzs goes further: when the operator amends a delivery date from
     the DO drawer, we want the SO header to learn about it too — same set of
     amend columns (amend_date_from_customer / amended_delivery_date /
     amend_reason on mfg_sales_orders) that Delivery Planning's /fields and
     /schedule routes already write.

     Rule (matches the /schedule integrity rule above): the customer's ORIGINAL
     `customer_delivery_date` is NEVER overwritten. If the DO PATCH provides:
       • amendDateFromCustomer  → mirror to SO.amend_date_from_customer
       • amendedDeliveryDate    → mirror to SO.amended_delivery_date  (the
         coordinator's NEW firm date — drives Days Left / OVERDUE)
       • amendReason            → mirror to SO.amend_reason
     None of these are DO columns, so they're stripped from `updates` (no
     DO-write attempt for non-existent columns) and applied to the parent SO
     after the DO update succeeds. Mirror is best-effort (logged on failure)
     so a transient SO update never blocks a legitimate DO header edit. */
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

  /* Header is locked once a Sales Invoice / Delivery Return exists — mirrors the
     line-add / line-edit / cancel guards. Prevents editing a DO that a child
     document already snapshotted. */
  const headerLock = await doHasDownstream(sb, id);
  if (headerLock) return c.json(headerLock, 409);

  /* The BEFORE half of every from->to pair recorded after the DO write below.
     Read after the guards so a rejected PATCH costs nothing. */
  const { data: beforeRow } = await sb.from('delivery_orders')
    .select(DO_AUDIT_SELECT).eq('id', id).maybeSingle();
  const before = (beforeRow ?? {}) as unknown as Record<string, unknown>;

  /* DUAL-WRITE NOTE: Supabase REST has no client-side transaction primitive —
     the underlying postgrest call is one statement per HTTP request. We order
     the writes DO-FIRST so a failed DO update never produces a phantom SO
     amend. The SO mirror is best-effort + logged; an SO failure is surfaced in
     the response as `so_mirror_error` so the UI can decide whether to retry,
     but the DO write itself is already committed. This matches how
     delivery-planning's /fields route handles the inverse split. */
  let writtenSo = false;
  let soMirrorError: string | null = null;
  let mirrorSoDocNo: string | null = null;

  if (Object.keys(updates).length > 1) {
    const { data, error } = await sb.from('delivery_orders').update(updates).eq('id', id).select('id, so_doc_no').maybeSingle();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    if (!data) return c.json({ error: 'not_found' }, 404);
    mirrorSoDocNo = (data as { soDocNo?: string | null; so_doc_no?: string | null }).soDocNo
      ?? (data as { so_doc_no?: string | null }).so_doc_no ?? null;

    /* Only the DO columns, and only in the branch that actually wrote them. The
       amend fields are NOT here: they are never DO columns and the SO's own log
       records them (see the header note on double-recording). Diffing the
       normalised `updates` rather than the body keeps normalizePhone's rewrite
       out of the history as a phantom change. */
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
    /* No DO column changes — only the SO mirror payload was sent. Skip the DO
       UPDATE (Postgres would still touch updated_at, polluting the audit log)
       and just look up the parent doc_no for the mirror below. */
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
      /* Drift safety — an orphan DO (no so_doc_no) can't be mirrored. Surface
         it so the operator knows the amend fields weren't applied anywhere. */
      soMirrorError = 'do_has_no_parent_so';
    }
  }

  return c.json({
    ok: true,
    id,
    so_amend_mirrored: writtenSo || undefined,
    so_doc_no: mirrorSoDocNo || undefined,
    so_mirror_error: soMirrorError || undefined,
  });
});

// ── Item CRUD ─────────────────────────────────────────────────────────────
deliveryOrdersMfg.post('/:id/items', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);

  /* Edge #4 — itemCode catalog guard. */
  {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string]);
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* Tier 2 downstream-lock — line-add is blocked once a DR / SI exists. */
  const childLock = await doHasDownstream(sb, id);
  if (childLock) return c.json(childLock, 409);

  const { data: header } = await sb.from('delivery_orders')
    .select('id, status, warehouse_id, do_number, company_id').eq('id', id).maybeSingle();
  if (!header) return c.json({ error: 'not_found' }, 404);

  /* Edge #1+#2 — if the DO is already shipped, an added line ships immediately
     via resync; check stock first, gated by confirmShortStock. Skipped on a
     not-yet-shipped DO (no OUT yet — first-ship deduction handles it). */
  const h = header as { id: string; status: string | null; warehouse_id: string | null };
  const addShipsNow = SHIPPED_STATES.includes((h.status ?? '').toUpperCase());
  const addWarehouseId = h.warehouse_id ?? (await defaultWarehouseId(sb));
  let addShortages: StockShortage[] = [];
  if (addWarehouseId) {
    const stockLines = [{
      itemCode: String(it.itemCode ?? ''),
      productName: (it.description as string | null) ?? null,
      variantKey: computeVariantKey((it.itemGroup as string | null) ?? null, (it.variants as VariantAttrs | null) ?? null),
      qty: Number(it.qty ?? 0),
    }];
    addShortages = await checkStockAvailability(sb, addWarehouseId, stockLines);
  }

  /* Binding follows the fact (mig 0230). Decided at WRITE time on every path,
     the same way is_dropship has always been decided at create and applied at
     confirm — one model, not two. Resolved before the 409 so the dialog names
     the incoming PO. */
  const addCommitments = await resolveShipCommitments(sb, [{
    lineRef: 'add',
    soItemId: (it.soItemId as string | null) ?? null,
    itemCode: String(it.itemCode ?? ''),
    itemGroup: (it.itemGroup as string | null) ?? null,
    variantKey: computeVariantKey((it.itemGroup as string | null) ?? null, (it.variants as VariantAttrs | null) ?? null),
    qty: Number(it.qty ?? 0),
  }], addWarehouseId ?? null, addShortages);

  /* Only a line on an ALREADY-SHIPPED DO moves stock on add, so only that case
     asks the operator. The measurement is taken either way — it is what the
     binding decision reads, and it must be the same measurement. */
  if (addShipsNow && addShortages.length > 0 && !(it as { confirmShortStock?: boolean }).confirmShortStock) {
    return c.json(shortStockResponse(addShortages, bindingList(addCommitments)), 409);
  }

  /* Remaining-qty guard (Wei Siang 2026-05-30) — if the added line traces back
     to an SO line, it may not push that SO line past its ordered qty. Same cap
     as the /from-sos picker; ad-hoc lines (no soItemId) stay uncapped. */
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

  /* Sofa batch guard — a sofa line with no production PO has no dye-lot batch
     and must not ship (would pull another order's colour lot). */
  let dropShipped = false;
  {
    const sofaOffenders = await findSofaLinesWithoutCompleteBatch(sb, [{
      itemCode: String(it.itemCode ?? ''),
      itemGroup: (it.itemGroup as string | null) ?? null,
      soItemId: (it.soItemId as string | null) ?? null,
    }]);
    if (sofaOffenders.length > 0) {
      /* Drop-ship waiver (mig 0057) — waive Type-A only on confirmed dropShip +
         the line bound to a PO (the incoming batch must be known). */
      const dropship = await buildDropshipOffenders(sb, sofaOffenders);
      const allHavePo = dropship.length > 0 && dropship.every((o) => !!o.poNumber);
      if ((it as { dropShip?: boolean }).dropShip !== true || !allHavePo) {
        return c.json(sofaNoCompleteBatchResponse(sofaOffenders, dropship), 409);
      }
      dropShipped = true;
    }
    /* Type B — after this add, the DO must hold the SO's WHOLE sofa set, not a
       partial one. Combine the DO's existing SO links with the new line.
       NEVER waived by drop-ship. */
    const { data: existingDoLines } = await sb
      .from('delivery_order_items').select('so_item_id').eq('delivery_order_id', id);
    const soIds = [
      ...((existingDoLines ?? []) as Array<{ so_item_id: string | null }>).map((r) => r.so_item_id),
      (it.soItemId as string | null) ?? null,
    ];
    const partial = await findIncompleteSofaSets(sb, soIds);
    if (partial.length > 0) return c.json(sofaIncompleteSetResponse(partial), 409);
  }

  /* 0165 — continue the DO's numbering; a pre-0165 DO (max NULL) stays
     un-numbered so its lines keep one consistent ordering regime. */
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
  const row = buildItemRow(id, it, nextLineNo, addCommitments.get('add')?.poNumber ?? null);
  const { data, error } = await sb.from('delivery_order_items').insert({ ...row, company_id: activeCompanyId(c) }).select(ITEM).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  /* Drop-ship (mig 0057) — once a drop-shipped line is added, stamp the DO so
     the "batch not received" badge shows. Best-effort (never blocks the add). */
  if (dropShipped) {
    const { error: dsErr } = await sb.from('delivery_orders').update({ is_dropship: true }).eq('id', id);
    if (dsErr && !(dsErr.message ?? '').includes('is_dropship')) {
      /* eslint-disable-next-line no-console */ console.error('[dropship] flag DO failed:', dsErr.message);
    }
  }
  await recomputeTotals(sb, id);
  // TASK #24 — if the DO is already shipped, adding a line MUST extend the
  // OUT booking for that bucket (otherwise the new line ships but inventory
  // doesn't move). No-op when not shipped — deductInventoryForDo handles ship.
  await resyncInventoryForDo(sb, id, user?.id);

  /* A line added to an ALREADY-SHIPPED DO moves stock out immediately (the
     resync above), so this is a stock event as much as a paperwork one. The
     stored row is the source of the recorded values, not the request body, so
     the log matches what buildItemRow actually wrote. Money is INTEGER SEN. */
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
        fieldChange('unitPriceCenti', null, line.unit_price_centi ?? null),
        fieldChange('discountCenti', null, line.discount_centi ?? null),
        fieldChange('lineTotalCenti', null, line.line_total_centi ?? null),
      ]),
    });
  }

  return c.json({ item: data }, 201);
});

deliveryOrdersMfg.patch('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId'); const user = c.get('user');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  /* Edge #4 — itemCode catalog guard (only when caller is changing it). */
  if (it.itemCode !== undefined) {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string]);
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* Tier 2 downstream-lock — line-edit is blocked once a DR / SI exists. */
  const childLock = await doHasDownstream(sb, id);
  if (childLock) return c.json(childLock, 409);

  const { data: prev } = await sb.from('delivery_order_items')
    .select('qty, unit_price_centi, discount_centi, unit_cost_centi, item_code, item_group, description, uom, variants, notes, so_item_id, line_total_centi, rack_id, line_delivery_date')
    .eq('id', itemId).maybeSingle();
  if (!prev) return c.json({ error: 'not_found' }, 404);

  const qty = it.qty !== undefined ? Number(it.qty) : Number(prev.qty);

  /* Remaining-qty guard (Wei Siang 2026-05-30) — raising the qty of an
     SO-linked line may not push the SO line past its ordered qty. remaining is
     derived live and already counts THIS line's current qty, so the cap is
     remaining + prevQty. Decreases / ad-hoc lines (no so_item_id) skip. */
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

  /* Sofa whole-set guard on a qty INCREASE (Audit fix 2026-06-03). The three
     DO-create paths enforce "a sofa set ships only from its ONE bound dye-lot
     batch"; editing a shipped DO's sofa line up must not bypass that. The extra
     units (the delta) must come from the SAME bound batch with live stock — else
     the FIFO trigger would over-consume the batch (or pull another order's lot).
     Checks the DELTA (not the full qty) since the prior qty is already consumed. */
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
        /* Drop-ship waiver (mig 0057) — the extra units ship supplier-direct
           against the expected (bound PO) batch. Waive only on confirmed
           dropShip + a bound PO on this line. Type B is unaffected (a qty
           bump can't orphan a set). */
        const offender = { itemCode: effCode, soItemId: prev.so_item_id as string };
        const dropship = await buildDropshipOffenders(sb, [offender]);
        const allHavePo = dropship.length > 0 && dropship.every((o) => !!o.poNumber);
        if ((it as { dropShip?: boolean }).dropShip !== true || !allHavePo) {
          return c.json(sofaNoCompleteBatchResponse([offender], dropship), 409);
        }
        /* Stamp the DO drop-ship flag for the badge (best-effort). */
        const { error: dsErr } = await sb.from('delivery_orders').update({ is_dropship: true }).eq('id', id);
        if (dsErr && !(dsErr.message ?? '').includes('is_dropship')) {
          /* eslint-disable-next-line no-console */ console.error('[dropship] flag DO failed:', dsErr.message);
        }
      }
    }
  }

  /* Edge #1+#2 — when qty is being INCREASED on a shipped DO, the delta
     needs more stock OUT. Check that delta against the warehouse, gated by
     confirmShortStock. Decreases and non-qty edits skip the check. */
  if (it.qty !== undefined && qty > Number(prev.qty) && !(it as { confirmShortStock?: boolean }).confirmShortStock) {
    const { data: doHeader } = await sb.from('delivery_orders').select('status, warehouse_id').eq('id', id).maybeSingle();
    const dh = (doHeader ?? { status: null, warehouse_id: null }) as { status: string | null; warehouse_id: string | null };
    if (SHIPPED_STATES.includes((dh.status ?? '').toUpperCase())) {
      const targetWh = dh.warehouse_id ?? (await defaultWarehouseId(sb));
      if (targetWh) {
        const delta = qty - Number(prev.qty);
        const effGroup = (it.itemGroup ?? prev.item_group) as string | null;
        const effVariants = (it.variants ?? prev.variants) as VariantAttrs | null;
        const effCode = (it.itemCode as string | undefined) ?? (prev.item_code as string);
        const stockLines = [{
          itemCode: effCode,
          productName: (prev.description as string | null) ?? null,
          variantKey: computeVariantKey(effGroup, effVariants),
          qty: delta,
        }];
        const shortages = await checkStockAvailability(sb, targetWh, stockLines);
        if (shortages.length > 0) return c.json(shortStockResponse(shortages), 409);
      }
    }
  }

  // TASK #24 — guard against orphaning downstream papers. If the operator is
  // shrinking qty below what's already been invoiced + returned, those Invoice /
  // Delivery Return rows would point at qty that no longer exists on the DO.
  // Reject with a clear 409; the operator must cancel the SI / DR first.
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
  const unitPrice = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : Number(prev.unit_price_centi);
  const discount = it.discountCenti !== undefined ? Number(it.discountCenti) : Number(prev.discount_centi);
  /* A caller who cannot READ the cost must not WRITE it. GET /:id strips
     unit_cost_centi for a non-finance caller (#600), so a client that seeds its
     line draft off the detail payload and echoes it back would round-trip the
     stripped field as a genuine 0 and wipe the line's cost basis — the DR bug
     #632, on the DO. Latent today (the routed DeliveryOrderDetailV2 sends only
     rackId on this PATCH), but the endpoint accepts any caller's body and the
     un-repointed 2990 POS/admin app is a live consumer of these APIs. Keep the
     stored cost instead; a finance caller is unaffected. DO NOT relax this to a
     bare `!== undefined` — that test IS the trap. */
  const unitCost = (canViewScmFinance(c) && it.unitCostCenti !== undefined)
    ? Number(it.unitCostCenti)
    : Number(prev.unit_cost_centi);
  // Audit 2026-06-20 — clamp like the PO create path (negative-money guard).
  const lineTotal = Math.max(0, (qty * unitPrice) - discount);
  const lineCost = qty * unitCost;

  const updates: Record<string, unknown> = {
    qty, unit_price_centi: unitPrice, discount_centi: discount, unit_cost_centi: unitCost,
    line_total_centi: lineTotal, line_cost_centi: lineCost, line_margin_centi: lineTotal - lineCost,
  };
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['itemGroup', 'item_group'], ['description', 'description'],
    ['uom', 'uom'], ['variants', 'variants'], ['notes', 'notes'],
    ['lineDeliveryDate', 'line_delivery_date'],
    /* REC P4 (mig 0118) — operator picks/changes the source rack per line. */
    ['rackId', 'rack_id'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  if (it.lineDeliveryDate !== undefined) updates['line_delivery_date_overridden'] = true;
  if (it.lineDeliveryDateOverridden !== undefined) updates['line_delivery_date_overridden'] = Boolean(it.lineDeliveryDateOverridden);
  /* Description 2 is always the server-generated variant summary. */
  {
    const effGroup = (it.itemGroup ?? prev.item_group) as string | null | undefined;
    const effVariants = (it.variants ?? prev.variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  const { error } = await sb.from('delivery_order_items').update(updates).eq('id', itemId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);

  /* Diff `updates` — the EFFECTIVE values written — against the stored row. qty
     / price / discount / cost are recomputed above from the body OR the prior
     row, so the body alone would not say what changed. The camel names are the
     ones AUDIT_FINANCE_FIELDS gates (unitCostCenti et al), so a non-finance
     reader of the history is stripped exactly as they are on the detail. */
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
  // TASK #24 — if the DO has shipped, propagate the qty change to inventory
  // (delta OUT for increase, delta IN for decrease). No-op when not shipped.
  await resyncInventoryForDo(sb, id, user?.id);
  /* SO #4 — a qty change on a DO line shifts how much of the SO line is
     delivered. Re-derive the SO's stored delivery status from live qtys so a
     DECREASE can release the SO from DELIVERED back to a partial/booked status
     (bidirectional + idempotent). Without this the SO stays latched DELIVERED
     against a quantity that no longer exists. Best-effort. */
  try {
    const { data: doRow } = await sb.from('delivery_orders').select('so_doc_no').eq('id', id).maybeSingle();
    await syncSoDeliveredFromDo(sb, [(doRow as { so_doc_no?: string } | null)?.so_doc_no], user?.id);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-sync] post-do-line-edit failed:', e); }
  return c.json({ ok: true });
});

/* ── DELETE /:id/items/:itemId — remove a DO line. ──────────────────────────
   Commander 2026-05-30 (TASK #24): unblocked on shipped DOs.

   Earlier this returned 409 do_shipped_line_locked because the partial UNIQUE
   index uq_inv_mov_do_source (migration 0100) made a per-line balancing IN
   structurally impossible — a reversing IN that reused the DO's bucket key
   collided with the original OUT. Migrations 0108 (key includes movement_type)
   and 0109 (drop the per-bucket UNIQUE so multiple delta rows can coexist)
   removed that constraint, and resyncInventoryForDo writes the per-bucket
   delta IN here. The FIFO trigger handles the new IN row by creating a fresh
   lot at the original cost basis (weighted avg from the OUT rows).

   Guard: if the deleted line has already been invoiced or returned (downstream
   papers reference its do_item_id and qty), we refuse the delete — those Invoice
   / DR rows would orphan. The operator must cancel the SI / DR first; that
   releases the qty and the delete then succeeds. */
deliveryOrdersMfg.delete('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId'); const user = c.get('user');

  // Per-line downstream guard (PR #24) — block delete only if THIS line's qty
  // has been invoiced or returned. Tier 2's doc-level doHasDownstream is too
  // coarse here (would block deleting any line if any OTHER line had children);
  // PR #24's per-line check is the right granularity. The Tier-1 shipped-DO
  // 409 block is also superseded: PR #24 added inventory re-sync on shipped-DO
  // line delete, so deleting a non-consumed line on a shipped DO is now safe.
  const consumed = await doLineConsumedQty(sb, itemId);
  if (consumed > 0) {
    return c.json({
      error: 'line_has_downstream_consumption',
      message: `Cannot delete this line — ${consumed} unit${consumed === 1 ? ' has' : 's have'} already been invoiced or returned. Cancel the related Invoice / Delivery Return first to release the quantity.`,
      consumed,
    }, 409);
  }

  /* Read the line BEFORE destroying it — afterwards the audit row is the only
     remaining evidence of what was on the delivery order, and there is nothing
     left to join back to. */
  const { data: doomedRow } = await sb.from('delivery_order_items')
    .select('item_code, description, qty, unit_price_centi, discount_centi, line_total_centi')
    .eq('id', itemId).maybeSingle();
  const doomed = (doomedRow ?? {}) as Record<string, unknown>;

  const { error } = await sb.from('delivery_order_items').delete().eq('id', itemId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);

  /* UPDATE, not DELETE: the entity is the DELIVERY ORDER and it still exists.
     DELETE on this entity type would tell a reader the whole document was
     destroyed. The line is the from-value of every pair, to-value null. */
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
        fieldChange('unitPriceCenti', doomed.unit_price_centi ?? null, null),
        fieldChange('discountCenti', doomed.discount_centi ?? null, null),
        fieldChange('lineTotalCenti', doomed.line_total_centi ?? null, null),
      ]),
    });
  }

  await recomputeTotals(sb, id);
  // TASK #24 — give the deleted qty back to stock (delta IN per bucket). No-op
  // when the DO hasn't shipped yet.
  await resyncInventoryForDo(sb, id, user?.id);
  /* SO #4 — deleting a DO line drops its delivered qty to zero for that SO
     line. Re-derive the SO's stored delivery status so it releases from
     DELIVERED back to a partial/booked status (bidirectional + idempotent).
     Best-effort. */
  try {
    const { data: doRow } = await sb.from('delivery_orders').select('so_doc_no').eq('id', id).maybeSingle();
    await syncSoDeliveredFromDo(sb, [(doRow as { so_doc_no?: string } | null)?.so_doc_no], user?.id);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-sync] post-do-line-delete failed:', e); }
  return c.json({ ok: true });
});

// ── Payments (mirror SO payments ledger) ──────────────────────────────────
deliveryOrdersMfg.get('/:id/payments', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  /* Own/downline sales scope (lib/salesScope.ts) — resolve the DO's
     salesperson_id first so a scoped seller can't read another
     salesperson's payment ledger by enumerating ids. Out-of-scope /
     missing → 404. Directors/view-all bypass. */
  {
    const { data: hdr } = await sb.from('delivery_orders').select('salesperson_id').eq('id', id).maybeSingle();
    if (!hdr) return c.json({ error: 'not_found' }, 404);
    const sp = (hdr as { salesperson_id?: number | string | null }).salesperson_id;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), sp)) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
  const { data, error } = await sb
    .from('delivery_order_payments')
    .select(`${PAYMENT_COLS}, staff:collected_by ( name )`)
    .eq('delivery_order_id', id)
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
  /* 2026-06-06 payment-method unify — 'installment' is first-class L1. */
  method:             z.enum(['merchant', 'transfer', 'cash', 'installment']),
  merchantProvider:   z.string().trim().min(1).optional().nullable(),
  installmentMonths:  z.number().int().min(0).max(60).optional().nullable(),
  onlineType:         z.string().trim().min(1).optional().nullable(),
  approvalCode:       z.string().optional().nullable(),
  amountCenti:        z.number().int().nonnegative(),
  accountSheet:       z.string().optional().nullable(),
  collectedBy:        z.string().uuid().optional().nullable(),
  note:               z.string().optional().nullable(),
});

deliveryOrdersMfg.post('/:id/payments', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');

  const { data: doc } = await sb.from('delivery_orders').select('id').eq('id', id).maybeSingle();
  if (!doc) return c.json({ error: 'delivery_order_not_found' }, 404);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = paymentCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  const merchantLike      = p.method === 'merchant' || p.method === 'installment';
  const merchantProvider  = merchantLike ? (p.merchantProvider ?? null) : null;
  const installmentMonths = merchantLike
    ? (typeof p.installmentMonths === 'number' && p.installmentMonths > 0 ? p.installmentMonths : null)
    : null;
  const onlineType        = p.method === 'transfer' ? (p.onlineType ?? null) : null;

  const { data, error } = await sb.from('delivery_order_payments').insert({
    delivery_order_id:  id,
    paid_at:            p.paidAt,
    method:             p.method,
    merchant_provider:  merchantProvider,
    installment_months: installmentMonths,
    online_type:        onlineType,
    approval_code:      p.approvalCode ?? null,
    amount_centi:       p.amountCenti,
    account_sheet:      p.accountSheet ?? null,
    collected_by:       p.collectedBy ?? null,
    note:               p.note ?? null,
    created_by:         user.id,
  }).select(PAYMENT_COLS).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  return c.json({ payment: data }, 201);
});

deliveryOrdersMfg.delete('/:id/payments/:paymentId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const paymentId = c.req.param('paymentId');
  const { data: row } = await sb.from('delivery_order_payments').select('delivery_order_id').eq('id', paymentId).maybeSingle();
  if (!row) return c.json({ error: 'not_found' }, 404);
  if ((row as { delivery_order_id: string }).delivery_order_id !== id) return c.json({ error: 'payment_doc_mismatch' }, 400);
  const { error } = await sb.from('delivery_order_payments').delete().eq('id', paymentId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

// ── Status transition + inventory deduction / reversal ────────────────────
export const patchDeliveryOrderStatusHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  let body: { status?: string; signatureData?: string; podKey?: string }; try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.status) return c.json({ error: 'status_required' }, 400);
  /* Audit gap #4 — reject an unknown status value outright. Historically the
     handler wrote body.status verbatim, so a typo / lowercase value (the SI #77
     class) or a bogus status persisted to the row. The FE only ever sends the
     canonical UPPERCASE values below. */
  if (!DO_STATUSES.has(body.status)) {
    return c.json({
      error: 'invalid_status',
      reason: `"${body.status}" is not a valid Delivery Order status.`,
    }, 400);
  }

  /* Scoped load. Every guard this handler already had — the status whitelist,
     CANCELLED-is-final, the shipped→pre-ship block, doHasDownstream — is a
     STATE guard; none of them was a tenancy guard. Downstream of the flip sit
     the inventory deduct/reverse, the SO delivered-qty resync, a customer-facing
     DO email and the rack return, so the flip is the right place to stop a
     cross-company caller. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: cur } = await scopeToCompanyId(
    sb.from('delivery_orders').select('status').eq('id', id), co.companyId,
  ).maybeSingle();
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const prevStatus = (cur as { status: string }).status;
  // Already cancelled → echo back without re-reversing (would double-credit).
  if (body.status === 'CANCELLED' && prevStatus === 'CANCELLED') {
    return c.json({ deliveryOrder: { id, status: 'CANCELLED' } });
  }
  /* Audit 2026-06-10 #1 (CRITICAL) — a CANCELLED DO is FINAL. Un-cancelling
     re-shipped goods with ZERO net stock deduction: the cancel's add-back
     ADJUSTMENT rows stand while deductInventoryForDo no-ops (original DO OUT
     rows still exist) → stock permanently inflated by the whole DO. Re-deliver
     via a NEW DO instead. */
  if (prevStatus === 'CANCELLED') {
    return c.json({
      error: 'do_cancelled_final',
      reason: 'A cancelled Delivery Order cannot be reactivated — its stock was already returned. Create a new DO to deliver again.',
    }, 409);
  }

  /* Audit gap #4 — legal-transition guard. Once a DO has shipped (an inventory
     OUT was written), it must NOT fall back to a pre-ship status (DRAFT / LOADED):
     a plain status write does NOT reverse the OUT movement, so the DO would read
     un-shipped while its stock stays deducted (e.g. DELIVERED→DRAFT left stock
     out of balance). Cancel it (which DOES reverse) and raise a new DO instead.
     Forward + lateral moves among shipped states, the DRAFT/LOADED→shipped
     confirm, and the CANCELLED transition (handled below) are all unaffected. */
  {
    const prevUpper = (prevStatus ?? '').toUpperCase();
    if (DO_STOCK_OUT_STATUSES.has(prevUpper) && DO_PRESHIP_STATUSES.has(body.status)) {
      return c.json({
        error: 'illegal_status_transition',
        reason: 'This Delivery Order has already shipped, so it cannot be moved back to a not-shipped status. Cancel it and create a new Delivery Order instead.',
      }, 409);
    }
  }

  /* Tier 2 downstream-lock — only the CANCELLED transition is gated. Other
     status transitions ride through untouched so the existing state machine
     (LOADED→DISPATCHED→IN_TRANSIT→SIGNED→DELIVERED→INVOICED) keeps working. */
  if (body.status === 'CANCELLED') {
    const childLock = await doHasDownstream(sb, id);
    if (childLock) return c.json(childLock, 409);
  }

  const now = new Date().toISOString();
  const ts: Record<string, string> = { updated_at: now };
  if (body.status === 'DISPATCHED') ts.dispatched_at = now;
  if (body.status === 'SIGNED')     ts.signed_at = now;
  if (body.status === 'DELIVERED')  ts.delivered_at = now;
  /* POD capture — the mobile app posts the proof-of-delivery signature +
     photo alongside the status flip. Persist them to the existing columns
     (signature_data, pod_r2_key) so a DELIVERED DO keeps its signature +
     photo. Only write when present so a plain status change never blanks
     an existing POD. */
  if (typeof body.signatureData === 'string' && body.signatureData) ts.signature_data = body.signatureData;
  if (typeof body.podKey === 'string' && body.podKey) ts.pod_r2_key = body.podKey;

  /* Over-delivery guard on FIRST ship (pre-ship -> shipped). The create path
     caps this (Audit gap #3, the asDraft-gated recheck) but a DRAFT DO SKIPS
     that cap and can land its full qty; the DRAFT->shipped confirm below is the
     single point where a draft's stock actually leaves, so the SAME cap is
     re-checked HERE, before the flip and the OUT. Reject 409 if any linked SO
     line would ship past its live remaining. Ad-hoc (unlinked) lines stay
     uncapped, exactly as at create. Read-only: no flip, no stock moved yet. */
  if (SHIPPED_STATES.includes(body.status) && DO_PRESHIP_STATUSES.has((prevStatus ?? '').toUpperCase())) {
    const { data: shipLines } = await sb.from('delivery_order_items')
      .select('so_item_id, qty').eq('delivery_order_id', id);
    const linkedQty = new Map<string, number>();
    for (const l of (shipLines ?? []) as Array<{ so_item_id: string | null; qty: number }>) {
      if (l.so_item_id) linkedQty.set(l.so_item_id, (linkedQty.get(l.so_item_id) ?? 0) + Number(l.qty ?? 0));
    }
    if (linkedQty.size > 0) {
      const remaining = await soRemainingByItemId(sb, [...linkedQty.keys()]);
      const over = findOverDeliveredSoItems(linkedQty, remaining);
      if (over.length > 0) {
        return c.json({
          error: 'over_delivery',
          message: 'This delivery would ship more than the Sales Order ordered — another DO already covers it. Refresh and check the Sales Order.',
          conflicts: over,
        }, 409);
      }
    }
  }

  /* Bug #3/#11 — ATOMIC cancel guard. The read-then-write above has a TOCTOU
     window: two concurrent cancels can both read a non-cancelled status and both
     fall through to reverse inventory (double-reverse). For the CANCELLED
     transition we make the write conditional on the row still being non-cancelled
     (status != CANCELLED) and treat "no row returned" as "someone else already
     cancelled" → idempotent echo, NO second reversal. Postgres serialises the two
     UPDATEs, so exactly one wins the row and fires the single reversal. */
  let data: { id: string; status: string } | null;
  if (body.status === 'CANCELLED') {
    const { data: updated, error } = await scopeToCompanyId(sb.from('delivery_orders')
      .update({ status: body.status, ...ts })
      .eq('id', id), co.companyId).neq('status', 'CANCELLED')
      .select('id, status').maybeSingle();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    if (!updated) {
      // Lost the race — another concurrent cancel already flipped it. Do NOT
      // reverse again; echo the cancelled state.
      return c.json({ deliveryOrder: { id, status: 'CANCELLED' } });
    }
    data = updated as { id: string; status: string };
  } else {
    const { data: updated, error } = await scopeToCompanyId(sb.from('delivery_orders')
      .update({ status: body.status, ...ts }).eq('id', id), co.companyId).select('id, status').single();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    data = updated as { id: string; status: string };
  }

  /* Inventory OUT — fire on the first transition into ANY shipped state.
     deductInventoryForDo is idempotent (existence check + UNIQUE index), so a
     DO that jumps straight to SIGNED/DELIVERED still deducts exactly once, and
     re-advancing through later shipped states never double-deducts.
     DRAFT CONFIRM (2026-06-24) — the Confirm action is exactly DRAFT→DISPATCHED:
     DISPATCHED ∈ SHIPPED_STATES so the deduction (skipped on draft create) fires
     HERE, the single chokepoint. This is the commit moving create→confirm. */
  let movementErrors: string[] = [];
  let emailNotice: string | null = null;
  if (SHIPPED_STATES.includes(body.status)) {
    movementErrors = await deductInventoryForDo(sb, id, user.id);
    /* Mirror the create path: once stock goes out, re-check the source SO for
       full coverage and auto-advance to DELIVERED (best-effort). A DRAFT confirm
       reaches this for the first time here, so the SO sync that was skipped on
       draft-create runs now. Idempotent + best-effort. */
    if (prevStatus === 'DRAFT') {
      const { data: doRow } = await sb.from('delivery_orders').select('so_doc_no').eq('id', id).maybeSingle();
      await syncSoDeliveredFromDo(sb, [(doRow as { so_doc_no?: string } | null)?.so_doc_no], user.id);
    }

    /* Customer DO email (owner trigger "A", 2026-07-17) — the DRAFT-confirm
       half of the same event the create path fires on.
       NARROWER than the deduction above, deliberately: the owner ruled "send on
       CONFIRMED, NOT on delivered". The deduction fires on any shipped state
       because stock leaves whichever way the DO gets there; the EMAIL says "your
       order is on its way", which is false once it has arrived. So it fires only
       on entering DISPATCHED from a pre-ship status — a DO that jumps
       DRAFT→DELIVERED (the mobile POD path) deducts stock here but does NOT
       email, because the goods are already with the customer.
       Once-per-DO by construction, not merely by the stamp: the guard at :3708
       bars a shipped DO from returning to a pre-ship status, so this transition
       cannot repeat. Gated OFF and fail-closed inside; best-effort. */
    if (body.status === 'DISPATCHED' && DO_PRESHIP_STATUSES.has((prevStatus ?? '').toUpperCase())) {
      emailNotice = await maybeSendDeliveryOrderEmail(sb, c.env, id);
    }
  }

  /* Requirement #3 — if a DO is explicitly marked DELIVERED, re-check its SO
     for full coverage and auto-advance the SO to DELIVERED (best-effort). */
  if (body.status === 'DELIVERED') {
    const { data: doRow } = await sb.from('delivery_orders').select('so_doc_no').eq('id', id).maybeSingle();
    await syncSoDeliveredFromDo(sb, [(doRow as { so_doc_no?: string } | null)?.so_doc_no], user.id);
  }

  /* Bug #1 — cancelling a DO AUTO-REVERSES the stock OUT: the create/dispatch
     wrote an OUT (source_doc_type:'DO'), so cancel must put the goods back on the
     shelf. We do NOT use reverseMovements here: its balancing IN reuses the DO's
     (source_doc_type, source_doc_id, product_code, variant_key) key, which the
     partial UNIQUE index uq_inv_mov_do_source (migration 0100, keyed WITHOUT
     movement_type) rejects → the insert silently fails and the shipped stock is
     left permanently deducted. reverseInventoryForDo writes a FIFO-neutral
     positive ADJUSTMENT (unindexed by the DO source key, carrying variant_key) so
     the reversal actually lands. Idempotent (ADJUSTMENT existence check) +
     best-effort (a movement failure never un-cancels the DO). */
  if (body.status === 'CANCELLED') {
    try { await reverseInventoryForDo(sb, id, user.id); } catch { /* best-effort */ }
    /* REC P4 — put the physical rack stock back (mirror of the dispatch
       stock-out). Best-effort + idempotent; never blocks the cancel. */
    try {
      const { data: doRow } = await scopeToCompanyId(sb.from('delivery_orders').select('do_number, company_id').eq('id', id), co.companyId).maybeSingle();
      const doNo = (doRow as { do_number?: string } | null)?.do_number ?? null;
      if (doNo) await returnDoRacksOnCancel(sb, id, doNo, user.id, (doRow as { company_id?: number | null } | null)?.company_id ?? null);
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[do-rack] cancel reversal failed:', e); }
    /* SO #4 — this DO's cancellation may release its SO from DELIVERED back to a
       partial/booked status. Recompute the SO's delivery status from live
       delivered qtys (bidirectional + idempotent). Best-effort. */
    try {
      const { data: doRow } = await sb.from('delivery_orders').select('so_doc_no').eq('id', id).maybeSingle();
      await syncSoDeliveredFromDo(sb, [(doRow as { so_doc_no?: string } | null)?.so_doc_no], user.id);
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-sync] post-do-cancel failed:', e); }
    /* DO cancel reversed stock — re-walk SO lines so previously-PENDING orders
       can flip back to READY now that stock is available again. Best-effort. */
    try {
      const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
      await recomputeSoStockAllocation(sb);
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-do-cancel failed:', e); }
  }

  return c.json({
    deliveryOrder: data,
    movementErrors: movementErrors.length ? movementErrors : undefined,
    emailNotice: emailNotice ?? undefined,
  });
};
deliveryOrdersMfg.patch('/:id/status', patchDeliveryOrderStatusHandler);
