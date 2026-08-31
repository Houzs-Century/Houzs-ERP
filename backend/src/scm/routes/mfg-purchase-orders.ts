// ----------------------------------------------------------------------------
// /mfg-purchase-orders — manufacturer-side POs to suppliers.
//
// Separate from the existing /purchase-orders route (which serves the
// retail-order → supplier-PO flow via purchase_order_lines). This route
// serves manufacturer POs against purchase_order_items (the extended PO
// table from migration 0041).
//
// Endpoints:
//   GET   /mfg-purchase-orders                — list with filters
//   GET   /mfg-purchase-orders/:id            — detail (header + items)
//   POST  /mfg-purchase-orders                — create draft PO from items
//   PATCH /mfg-purchase-orders/:id            — update header (status/notes/etc)
//   PATCH /mfg-purchase-orders/:id/confirm    — flip DRAFT → SUBMITTED (commits)
//   PATCH /mfg-purchase-orders/:id/cancel     — flip → CANCELLED
//   PATCH /mfg-purchase-orders/:id/reopen     — flip CANCELLED → SUBMITTED
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { PO_STATUS_BUCKETS } from '../lib/po-status-buckets';
import { HELD_OR_TERM, HOLD_COLUMNS, isDocumentHeld } from '../lib/document-hold';
import { firstUnorderableSo, soNotOrderableResponse } from '../lib/source-document-gates';
import { mountHoldRoute } from './document-hold-routes';
import {
  buildVariantSummary, pickComboMatch, spreadComboTotal,
  splitSofaCode, sofaHeightKey, effectiveSoDelivery,
  type SofaComboRow, type SofaPriceTier,
} from '../shared';
import {
  computeMfgPoUnitCost,
  type MfgFabricTier,
  type MaintenanceConfig,
  type PoPriceMatrix,
} from '../shared/mfg-pricing';
import {
  orderSofaModuleRowsWithinBuilds,
  sortSoLinesByGroupRank,
} from '../shared/so-line-display';
import { parseLineNumbers, invalidLineNumberBody } from '../shared/line-numbers';
import { changedPoIdentityLockCols, poIdentityLockedRefusal } from '../shared/po-identity-lock';
import { poVariantGaps, poVariantCheckFailedBody, poVariantConfirmRefusal, poWarehouseGap, PO_WAREHOUSE_REQUIRED } from './po-gates';
import { VALID_CURRENCIES, VALID_KINDS } from '../lib/purchase-doc-vocab';
import { resolveMaintenanceConfigForSupplier, poVariantPricingInput } from '../lib/po-pricing';
import { readMfgProductBindings } from '../lib/supplier-bindings';
import { poHasDownstream } from '../lib/downstream-lock';
import { dateOrNull, coerceEmptyDates } from '../lib/date-coerce';
import { todayMyt } from '../lib/my-time';
import { enqueuePoCreate, enqueueCancel, enqueueEdit, retiredLineOf, type AcRetiredLine } from '../lib/autocount-outbox';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { escapeForOr } from '../lib/postgrest-search';
import { readStatusCounts } from '../lib/status-counts';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { loadSoWarehouseMasters, type SoWarehouseMasters, type SoWarehouseSource } from '../lib/so-warehouse';
import { computeSoDrift, type DriftLine } from '../lib/so-po-drift';
import {
  loadLeadTimeBase,
  resolveLeadDays,
  subtractCalendarDays,
  LEAD_TIME_SELECT,
} from '../lib/lead-time';
import { groupKeyFor } from '../lib/po-grouping';
import { findOverConvertOffender, soLineHeadroom, type OverConvertOffender } from '../lib/po-over-convert';
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
  buildPurchaseOrderEmail,
  isSendableEmail,
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
import { supabaseAuth } from '../middleware/auth';
import { recordEntityAudit, diffFields, compactChanges, fieldChange, statusChange } from '../lib/entity-audit';
import { PO_LINE_AUDIT_FIELDS, PO_LINE_AUDIT_SELECT } from '../lib/entity-audit-fields';
import { computeMrp } from './mrp';
import { eager } from '../lib/concurrency';
import { provenanceNote } from '../shared/transfer-vocabulary';
import type { Env, Variables } from '../env';
import { skuCategoryResolver, lineIdentityFields } from '../lib/sku-category';

/* ── Supplier sofa-combo auto-pricing (Commander 2026-05-29) ─────────────────
   The supplier prices a sofa SET (a colour-matched bundle of modules) as a
   single deal. When a PO sofa line's modules MATCH one of the supplier's own
   combo rows, the combo price is the cost — exactly mirroring how the sales
   order side overrides a sofa's à-la-carte total with a combo (sofa-build.ts
   `groupPrice`), but on the COST side and scoped to the supplier's combos
   (sofa_combo_pricing.supplier_id = the PO's supplier, NOT the NULL sales-side
   rows). When nothing matches, the line keeps its per-seat-size matrix cost. */

/** Load the involved suppliers' OWN combo rows, grouped by supplier_id. Sales-
    side rows (supplier_id IS NULL) are intentionally excluded — those are the
    Products-page master combos and must never leak into purchasing cost. */
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

/* ── Audit trail (migration 0139 / lib/entity-audit) ───────────────────────────
   Action vocabulary for this module:
     POST   — DRAFT -> SUBMITTED. The PO COMMITS here: it claims its SO lines'
              quota and becomes live supply to MRP and receivable by a GRN.
     CANCEL — status -> CANCELLED.
     UPDATE — header edits and the reopen (CANCELLED -> SUBMITTED).
     DELETE — the hard delete, whose subject no longer exists afterwards.
   No REVERSE: a PO posts nothing to the ledger, so there is nothing to contra. */
const PO_AUDIT_FIELDS: Array<[string, string]> = [
  ['poDate', 'po_date'], ['expectedAt', 'expected_at'], ['currency', 'currency'],
  ['notes', 'notes'], ['supplierId', 'supplier_id'], ['purchaseLocationId', 'purchase_location_id'],
  ['supplierDeliveryDate2', 'supplier_delivery_date_2'], ['supplierDeliveryDate3', 'supplier_delivery_date_3'],
  ['supplierDeliveryDate4', 'supplier_delivery_date_4'],
];

/* The BEFORE half of the header PATCH's from->to pairs, plus the identity
   columns every audit row on this entity needs. */
const PO_AUDIT_SELECT =
  `id, po_number, status, company_id, ${PO_AUDIT_FIELDS.map(([, snake]) => snake).join(', ')}`;

/* CREATE was added after the header/confirm/cancel/reopen/delete pass, and it is
   recorded LATE for a reason. Both create paths write the PO header first and
   DELETE it again when the line insert fails — POST / rolls back so it does not
   leak a no-items PO, and the SO->PO convert rolls the bucket back and reports
   it as `dropped`. A CREATE row emitted at insert time would describe a purchase
   order that never existed, against SO lines whose quota never moved.
   recordPoCreate re-reads the persisted row instead of echoing the payload,
   which makes that ordering self-enforcing: a rolled-back header reads back as
   nothing and no row is written.

   The line vocabulary lives in lib/entity-audit-fields (imported above) — the
   camelCase half is what AUDIT_FINANCE_FIELDS gates on and needs a test that can
   import it without dragging Hono along. */

/* The PO's identity for an audit row written from a LINE handler, which has the
   line in hand but not the parent. Best-effort by design: the writer is
   fail-open, so an unresolved doc number costs the row its human key and
   nothing else. */
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

/**
 * Record the CREATE of a PO that has SURVIVED its handler.
 *
 * Reads the row back rather than taking the caller's payload: the doc number is
 * minted server-side (and re-minted on a 23505 retry), the totals are derived
 * from the lines, and a header a compensating branch already deleted reads back
 * as nothing — so this cannot write a CREATE row for a PO that was rolled back.
 *
 * `actor` is optional and undefined on the headless path (the Procurement Agent
 * runs with no session). An unattributed row still records WHEN and WHAT, which
 * is the writer's documented degradation and better than no row at all — the
 * note says which engine raised it.
 */
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
  } catch { /* best-effort */ }
  if (!row) return; // rolled back (or unreadable): a CREATE row here would be a lie
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
      /* INTEGER SEN, straight off the column. */
      fieldChange('totalSen', null, row.total_sen ?? null),
      fieldChange('lineCount', null, lineCount),
    ]),
  });
}

export const mfgPurchaseOrders = new Hono<{ Bindings: Env; Variables: Variables }>();

mfgPurchaseOrders.use('*', supabaseAuth);

/* ── PO child-lock guard (Tier 2 — downstream lock) ─────────────────────────
   A PO locks (read-only — no header edit / no line edit / no cancel) once it
   has ANY non-cancelled GRN. The convert-to-GRN path is NOT gated by this:
   partial receiving is still allowed (i.e. the PO can keep emitting GRNs);
   only header/line MUTATIONS + CANCEL are blocked, mirroring grnHasDownstream.
   The rule now lives in scm/lib/downstream-lock.ts with its three siblings,
   which had drifted into four private copies in four route files. Same
   signature, same JSON, same behaviour — and see that module for why it is
   also the ERP half of AutoCount's transferred-document rule. */

/* -- ERP -> AutoCount edit --------------------------------------------------
   Every PO mutation route funnels through this, so exactly one snapshot of the
   SAVED order is queued per successful save -- header edits and line
   add/edit/delete alike. Only ever reached for a PO the downstream lock let
   through, which is the same rule AutoCount enforces on its side. Never
   throws. */
async function queueAcPoEdit(
  c: any,
  poId: string,
  retire: AcRetiredLine[] = [],
  /* Rows THIS request inserted. A line with no AutoCount key is otherwise
     indistinguishable from a legacy line the backfill missed, and guessing
     "new" appends a duplicate into a live account book — on a purchase order a
     duplicate cannot even be removed. Only the route that did the inserting can
     say, so only the route that did it passes this. Same contract as the sales
     order's `queueAcSoEdit`. */
  newLineIds: string[] = [],
): Promise<void> {
  await enqueueEdit(c.get('supabase'), {
    companyId: activeCompanyId(c),
    docType: 'PO',
    docId: poId,
    retire,
    newLineIds,
    createdBy: c.get('houzsUser')?.id ?? null,
  });
}

/* ── Drop-ship OUT guard (audit C3, 2026-07-13) ──────────────────────────────
   A drop-ship DO ships BEFORE receipt with its OUT movement stamped
   batch_no = this PO's po_number (the EXPECTED batch). Cancelling the PO while
   such an OUT is outstanding orphans it forever: no GRN will ever post an IN
   under that batch, so the negative stock never nets out and the drop-ship
   COGS stays 0 permanently. Mirror of the "cancel the GRN first" pattern:
   block the PO cancel until the drop-ship DO is cancelled (or delivered goods
   are handled via a Delivery Return + new paperwork).

   NOTE: poHasDownstream already blocks cancel once ANY non-cancelled GRN
   exists, so when this guard runs nothing has been received under this PO —
   any OUT movement carrying its po_number as batch_no can only be a drop-ship
   OUT (a normal batched ship needs a received lot, which needs a GRN).
   Best-effort forward-compat: absent batch_no column (pre-0120) → no
   drop-ship OUTs can exist → guard passes. */
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
    if (error) return null; // batch_no column absent (pre-0120) — nothing to guard
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
    return null; // best-effort — never block a cancel on a read hiccup
  }
}

/* NOT shared with the PCO — it has no DRAFT. See lib/purchase-doc-vocab.ts. */
/* ON_HOLD added 2026-08-21 (owner: "PO 加 hold"). It is the REVERSIBLE answer
   the purchase side never had — CANCELLED is final and reaches AutoCount, where
   it cannot be un-cancelled. A held PO is not receivable, because
   RECEIVABLE_PO_STATUSES in grns.ts is an ALLOW-list. */
const VALID_STATUSES = new Set(['DRAFT', 'SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED', 'ON_HOLD']);
/* Filter-pill bucket → the raw purchase_orders.status values it covers. Single
   source of truth for BOTH the status-count queries and the list `status`
   filter. Five buckets are 1:1, but their KEYS differ from the raw status
   (open→SUBMITTED, partial→PARTIALLY_RECEIVED, received→RECEIVED). The FE sends
   the BUCKET NAME as `status`; a raw DB status still works (backward-compatible
   fallback via VALID_STATUSES).

   `outstanding` (owner 2026-07-31) is the one ROLL-UP bucket: raised to a
   supplier but not yet received in full — i.e. exactly the money the
   Outstanding stat card sums. It deliberately OVERLAPS open + partial rather
   than replacing them, so the counts across the pills no longer add up to
   `all`; that's the point of a roll-up and why it sits right after All. */

/* THE SO-MUST-BE-ORDERABLE GATE MOVED to lib/source-document-gates.ts on
   2026-08-22 (mig 0324), beside the SO -> DO and PO -> GRN gates that ask the
   same question of the same row. All three had to learn to read the hold
   MARKER. Behaviour unchanged; that module's header has the trace. */

const HEADER_COLS =
  'id, po_number, supplier_id, status, po_date, expected_at, currency, ' +
  'subtotal_sen, tax_sen, total_sen, notes, submitted_at, received_at, ' +
  'cancelled_at, created_at, created_by, updated_at, ' +
  /* SO-amendment / revision workflow (2026-07-03) — bumped in place when a
     supplier-confirmed amendment revises this PO; prior versions snapshot to
     po_revisions. The PO Detail header shows a "Revised · rev N" badge when > 1. */
  'revision, ' +
  /* PR #77 — default ship-to warehouse for every line on this PO */
  'purchase_location_id, ' +
  /* Migration 0180 — supplier-revised delivery dates (header). The EFFECTIVE
     delivery date readers use = MAX over non-null of [expected_at, _2, _3, _4]
     (effectiveDelivery). expected_at keeps meaning the original earliest date. */
  'supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4, ' +
  /* Mig 0324 — the HOLD MARKER, rendered BESIDE the status pill. */
  HOLD_COLUMNS;

const ITEM_COLS =
  'id, purchase_order_id, binding_id, material_kind, item_code, material_name, ' +
  'supplier_sku, qty, unit_price_sen, line_total_sen, received_qty, notes, created_at, ' +
  /* PR #41 — variant fields (migration 0056) */
  'item_group, description, description2, uom, discount_sen, unit_cost_sen, ' +
  'gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, ' +
  'custom_specials, line_suffix, special_order_price_sen, variants, ' +
  /* PR #77 — per-line delivery date + ship-to warehouse */
  'delivery_date, warehouse_id, ' +
  /* Migration 0180 — supplier-revised per-line delivery dates. Effective line
     date = MAX over non-null of [delivery_date, _2, _3, _4]. */
  'supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4, ' +
  /* Migration 0098 — source SO line link. The detail route resolves it to a
     per-line so_doc_no for the PO PDF's "For SO" provenance column
     (relabelled from "Transferred SO", owner 2026-08-07). */
  'so_item_id, ' +
  /* Migration 0274 — per-line photo keys, carried from the source SO line on
     convert. Read like the SO's: the key alone is not viewable, so the client
     trades it for a short-lived signed URL via
     GET /:id/items/:itemId/photos/:photoKey/signed. */
  'photo_urls';

// ── List ──────────────────────────────────────────────────────────────
mfgPurchaseOrders.get('/', async (c) => {
  const status = c.req.query('status');
  const supplierId = c.req.query('supplierId');
  const supabase = c.get('supabase');

  // PR — Commander 2026-05-27: PO list rows now surface a per-row items
  // summary (AutoCount-style) so the buyer can see at a glance what's
  // inside each PO without drilling in. Nested select keeps it to one
  // query — Postgres / Supabase joins purchase_order_items on
  // purchase_order_id for every row.
  // purchase_location embeds the warehouse the PO ships to (PR #77 — the
  // column is an FK → warehouses.id); the list needs its NAME, not just the
  // id, for the "Purchase Location" column (Owner 2026-07-02).
  // Supplier CONTACT fields ride the list embed because the quick-view drawer
  // renders its SUPPLIER panel straight off the list row (owner 2026-07-24:
  // the panel showed "—" for contact/phone/email/address — the row simply
  // never carried them).
  // supplier_sku rides the items embed (owner 2026-08-05) — the list's
  // "Supplier SKU" column / Excel export shows the supplier's own codes.
  const SELECT = `${HEADER_COLS}, supplier:suppliers(id, code, name, contact_person, phone, email, address), items:purchase_order_items(item_code, material_name, qty, supplier_sku), purchase_location:warehouses!purchase_location_id(id, code, name)`;

  /* Opt-in server-side pagination + search + sort + status-counts (mirrors the
     SO list in mfg-sales-orders.ts). The PRESENCE of `page` switches paging on;
     when it is absent/empty the query below is BYTE-IDENTICAL to the historical
     behavior (order po_date desc, created_at desc, limit 500, status + supplierId
     params, company scope, `{ purchaseOrders }` shape). */
  const pageRaw = c.req.query('page');
  const paginate = pageRaw !== undefined && pageRaw !== '';

  let data: unknown = null;
  let error: { message: string } | null = null;
  let total = 0;
  let page = 0;
  let pageSize = 50;
  let statusCounts: { all: number; draft: number; outstanding: number; open: number; partial: number; received: number; cancelled: number } | undefined;
  let countError: string | null = null; // held, not returned here, so the LIST read's own error still wins the report

  if (!paginate) {
    /* --- LEGACY PATH (unchanged) --- */
    let q = supabase
      .from('purchase_orders')
      .select(SELECT)
      .order('po_date', { ascending: false })
      .order('created_at', { ascending: false })
      // Bound the result so PostgREST's default 1000-row cap can't silently
      // truncate the PO list — match the SO/DO/SI list convention.
      .limit(500);
    if (status && VALID_STATUSES.has(status)) q = q.eq('status', status);
    if (supplierId) q = q.eq('supplier_id', supplierId);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    const res = await q;
    data = res.data;
    error = res.error;
  } else {
    /* --- PAGINATED PATH (opt-in via `page`) --- */
    page = Math.max(0, Math.trunc(Number(pageRaw)) || 0);
    const psRaw = Number(c.req.query('pageSize'));
    pageSize = Number.isFinite(psRaw) && psRaw > 0 ? Math.min(100, Math.max(1, Math.trunc(psRaw))) : 50;

    const SORT_COLS = new Set(['po_date', 'po_number', 'status', 'total_sen']);
    const [rawCol, rawDir] = (c.req.query('sort') ?? 'po_date:desc').split(':');
    const sortCol = SORT_COLS.has(rawCol) ? rawCol : 'po_date';
    const sortAsc = rawDir === 'asc';

    let q = supabase.from('purchase_orders').select(SELECT, { count: 'exact' }).order(sortCol, { ascending: sortAsc });
    /* unique tiebreaker so range paging can't skip/repeat rows sharing the sort key */
    if (sortCol !== 'po_number') q = q.order('po_number', { ascending: sortAsc });
    /* Resolve the incoming `status`: a known bucket key → all its raw statuses;
       'all'/empty → no filter; otherwise a raw DB status (VALID_STATUSES guard). */
    /* The `on_hold` tab reads the MARKER (mig 0324). A held order appears under
       BOTH its real status and On Hold — the point of a marker — so the counts
       do not sum to `all`, exactly as `outstanding` already does not. */
    if (status && status !== 'all') {
      if (status === 'on_hold') q = q.or(HELD_OR_TERM);
      else if (PO_STATUS_BUCKETS[status]) q = q.in('status', PO_STATUS_BUCKETS[status]);
      else if (VALID_STATUSES.has(status)) q = q.eq('status', status);
    }
    if (supplierId) q = q.eq('supplier_id', supplierId);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    /* free-text search over the base-table text columns the FE searches
       (PurchaseOrdersListV2 hay). Supplier name / code are embedded resources,
       not base purchase_orders columns, so they can't be ilike'd here. */
    const search = c.req.query('q');
    if (search) {
      const s = escapeForOr(search);
      if (s) q = q.or(`po_number.ilike.%${s}%,notes.ilike.%${s}%`);
    }
    const from = c.req.query('from'); if (from) q = q.gte('po_date', from);
    const to = c.req.query('to'); if (to) q = q.lte('po_date', to);
    q = q.range(page * pageSize, page * pageSize + pageSize - 1);

    /* Status counts mirror the FE filter-pill buckets (draft / outstanding /
       open / partial / received / cancelled) over the SAME company + supplier
       filters but WITHOUT status / search / pagination. `outstanding` overlaps
       open + partial by design — see PO_STATUS_BUCKETS. */
    const countBase = () => {
      let cq = supabase.from('purchase_orders').select('*', { count: 'exact', head: true });
      if (supplierId) cq = cq.eq('supplier_id', supplierId);
      cq = scopeToCompany(cq, c);
      return cq;
    };
    /* PERF: the seven head-only counts read nothing the page query produces, so
       they are issued alongside it rather than after it. Semantics unchanged. */
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
    // A count that could not be READ is reported, never served as 0; an empty bucket still answers 0 (lib/status-counts.ts).
    const counted = readStatusCounts({ all: allC, draft: draftC, outstanding: outstandingC, open: openC, partial: partialC, received: receivedC, cancelled: cancelledC, on_hold: onHoldC });
    if (counted.ok) statusCounts = counted.counts; else countError = counted.reason;
  }
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (countError) return c.json({ error: 'status_counts_failed', reason: countError }, 500);

  /* Tier 2 downstream-lock (mirror computeGrnFlags in lib/grn-consumption-flags) — one
     extra query: pull the distinct purchase_order_ids that have any non-
     cancelled GRN, then stamp has_children on every PO row. The list grid uses
     this to hide Edit / Cancel from POs that are downstream-locked. */
  const rows = (data ?? []) as Array<{ id: string } & Record<string, unknown>>;
  const childIds = new Set<string>();
  // Owner 2026-07-02 — "GRN No" list column: collect the non-cancelled GRNs each
  // PO was received into, deduped + stable-ordered. Same one extra query that
  // already powers has_children — just carry the GRN identity too.
  //
  // Owner 2026-07-31 — carries `id` alongside `grnNumber` now: GRN detail routes
  // by UUID (/scm/grns/:id), so a number alone can't be linked. Shape widened
  // rather than duplicated into a parallel id array — nothing consumed the
  // string[] form.
  const grnsByPo = new Map<string, Array<{ id: string; grnNumber: string }>>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const { data: grnRows } = await supabase
      .from('grns')
      .select('id, purchase_order_id, grn_number')
      .in('purchase_order_id', ids)
      .neq('status', 'CANCELLED')
      .order('grn_number', { ascending: true });
    for (const g of (grnRows ?? []) as Array<{ id: string; purchase_order_id: string | null; grn_number: string | null }>) {
      if (!g.purchase_order_id) continue;
      childIds.add(g.purchase_order_id);
      if (!g.grn_number) continue;
      const arr = grnsByPo.get(g.purchase_order_id) ?? [];
      if (!arr.some((x) => x.grnNumber === g.grn_number)) arr.push({ id: g.id, grnNumber: g.grn_number });
      grnsByPo.set(g.purchase_order_id, arr);
    }
  }
  /* Assigned SO / Delivered columns (owner 2026-07-31) are MRP-DERIVED and now
     OMITTED here — not blanked (C16). Resolving them ran a company-wide
     computeMrp on this critical path (resolvePoSoCoverageForPos +
     resolveDeliveredDosForPos), the list's dominant cost (~4s). The client heals
     them a beat after render via GET /mfg-purchase-orders/list-mrp-enrichment
     (routes/mfg-purchase-orders-list-enrichment.ts + lib/listMrpEnrichment.ts).
     has_children + transfer_to_grns stay inline (cheap, non-MRP). */
  const purchaseOrders = rows.map((r) => ({
    ...r,
    has_children: childIds.has(r.id),
    transfer_to_grns: grnsByPo.get(r.id) ?? [],
  }));
  if (paginate) return c.json({ purchaseOrders, total, page, pageSize, statusCounts });
  return c.json({ purchaseOrders });
});

/* ── PR — Outstanding SO items (qty > po_qty_picked) for the
 * "From SO" picker on the New PO page. Returns a flat list grouped by
 * doc_no so the frontend can render checkboxes per SO + per-line qty
 * inputs. Filters out:
 *   - cancelled SO line rows
 *   - cancelled SO header status (CANCELLED)
 *   - lines already fully picked (qty - po_qty_picked <= 0)
 * Caller can filter further by supplierId via ?supplierId= once item
 * → main supplier binding is known.
 *
 * IMPORTANT (route ordering): this STATIC path MUST be registered before
 * the `/:id` param route below — otherwise Hono matches `/:id` first and
 * tries to cast "outstanding-so-items" to a uuid → 500. (Bug fix
 * 2026-05-28: the PO-from-SO page showed "no outstanding lines" because
 * this endpoint was 500-ing from being shadowed by `/:id`.) */
mfgPurchaseOrders.get('/outstanding-so-items', async (c) => {
  const supabase = c.get('supabase');
  // Pull SO items with remaining qty > 0, joining the parent SO so we
  // can filter cancelled SOs + show debtor + branding + dates.
  /* Commander 2026-05-28 — PO-from-SO redesign. Surface three extra fields
     so the frontend grid can render Processing Date + derive each PO line's
     warehouse (from the SO's sales_location) + delivery date (from the SO
     LINE's own line_delivery_date). processing_date + sales_location
     come off the SO header; line_delivery_date off the item. */
  const { data: items, error } = await scopeToCompany(
    supabase
      .from('mfg_sales_order_items')
      .select(`
      id, doc_no, item_code, description, item_group, qty, po_qty_picked, unit_price_sen,
      variants, line_suffix, cancelled, line_delivery_date,
      so:mfg_sales_orders!inner ( doc_no, debtor_name, branding, status, on_hold, so_date, customer_delivery_date, processing_date, sales_location )
    `),
    c,
  )
    .eq('cancelled', false)
    .order('doc_no', { ascending: false })
    .limit(500);
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
    };
  };

  /* Commander 2026-05-28 — resolve each SKU's MAIN supplier so the PO-from-SO
     grid can show it (and the user sees which lines are even convertible — an
     unbound SKU can't be PO'd). One batched query over the distinct codes;
     prefer is_main_supplier, else first binding. */
  const skuCodes = [...new Set(((items ?? []) as unknown as Row[]).map((r) => r.item_code).filter(Boolean))] as string[];
  const mainSupplierByCode = new Map<string, { code: string; name: string }>();
  if (skuCodes.length > 0) {
    /* CHUNKED + PAGED — lib/supplier-bindings.ts. Un-chunked over every code in the
       picker, a binding past the 1,000-row cap showed "— none —" for a bound SKU. */
    type PickerBind = { item_code: string; supplier: { code: string; name: string } | Array<{ code: string; name: string }> | null };
    const { data: binds } = await readMfgProductBindings<PickerBind>(supabase, {
      codes: skuCodes, companyId: activeCompanyId(c),
      select: 'item_code, is_main_supplier, supplier:suppliers(code, name)',
    });
    for (const b of binds) {
      if (mainSupplierByCode.has(b.item_code)) continue;
      const s = Array.isArray(b.supplier) ? b.supplier[0] : b.supplier;
      if (s) mainSupplierByCode.set(b.item_code, { code: s.code, name: s.name });
    }
  }

  /* Commander 2026-05-31 — the picker is now a STOCK-AWARE shortage view, the
     SAME pooled (stock + open-PO) allocation MRP uses (computeMrp → per-line
     shortageQty), so it can never disagree with the MRP page. A line is shown
     ONLY if it still has an uncovered shortage:
       • an SO already ordered via MRP is covered by that open PO in the supply
         pool → shortage 0 → drops off the picker (the Commander's ask);
       • when that stock is later consumed by another order, MRP re-reports a
         shortage → the line re-appears (same SO can be converted again).
     remainingQty becomes the pooled shortage (what still needs a PO), not the
     raw qty − po_qty_picked. Best-effort: if the pooled compute fails we fall
     back to the per-line picked cap so the picker still works (degraded). */
  const shortageBySoItem = new Map<string, number>();
  let pooledOk = true;
  try {
    const mrpRes = await computeMrp(supabase, { catFilter: null, whFilter: null, includeUndated: true, companyId: activeCompanyId(c), leadBuffers: await loadLeadBuffers(c.env.DB) });
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
        // Commander 2026-05-28 — new fields for the redesigned PO-from-SO grid.
        processingDate:   r.so.processing_date,
        salesLocation:    r.so.sales_location,
        lineDeliveryDate: r.line_delivery_date,
        mainSupplierCode: mainSupplierByCode.get(r.item_code)?.code ?? null,
        mainSupplierName: mainSupplierByCode.get(r.item_code)?.name ?? null,
      };
    });

  return c.json({ items: outstanding });
});

/* ── SO-line candidates for the allocation editor (mig 0235) ─────────────────
   The split-a-line editor needs every company SO LINE carrying the PO line's
   item code — INCLUDING already-picked and already-delivered ones, because the
   whole point of allocations is attributing CONSOLIDATED (often historical,
   RECEIVED) purchases; the outstanding-so-items shortage view above hides
   exactly those. Excludes only cancelled lines and cancelled/draft SOs (a
   cancelled line has no demand to attribute; a draft order is not real yet).
   Read-only; the write-side gate is soLinkTargetRefusal on the allocation
   writes themselves.

   IMPORTANT (route ordering): STATIC path — must stay registered before the
   `/:id` param route below, same as /outstanding-so-items (2026-05-28 bug). */
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
    /* Bind the error. A NOT-FOUND here legitimately falls back to code-only
       (the comment above), but a READ FAILURE must not: silently leaving poSpec
       null on a database blip re-opens the picker to every same-code SO line,
       which is the exact gate this endpoint was changed to close. Not-found and
       could-not-tell are different answers and only one of them is safe. */
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
    // Spec gate: only lines describing the same product (fabric + spec). When
    // no PO spec was resolvable (older caller, or the line vanished) leave the
    // list at code-only rather than hiding everything.
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

/* ── Allocations read helper (mig 0235) ──────────────────────────────────────
   Batched: allocations for a set of PO line ids, each with its SO doc_no
   resolved for display (an allocation with so_item_id NULL is a STOCK slice).
   Best-effort forward-compat: before mig 0235 lands the table read fails —
   return an empty map so the detail response simply carries no allocations. */
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
  } catch { /* table absent pre-0235 — detail simply carries no allocations */ }
  return out;
}

/* Per-line goods-receipt breakdown — which GR(s) each PO line was received into
   (one entry per GRN line), carrying the GR number + net qty + status. The PO
   counterpart of soLineDeliveries: lets the PO list show a "Received" column
   identical to the SO "Delivered" column. Cancelled GRNs are excluded so the
   breakdown never shows a voided receipt. Net qty = qty_accepted − returned_qty;
   zero/negative nets (fully returned) are dropped. Read-only display aid. */
export type PoLineReceipt = { grnNumber: string; qty: number; status: string };
async function poLineReceipts(
  sb: any,
  poItemIds: string[],
): Promise<Map<string, PoLineReceipt[]>> {
  const out = new Map<string, PoLineReceipt[]>();
  if (poItemIds.length === 0) return out;
  const { data: grnLines } = await sb
    .from('grn_items')
    .select('purchase_order_item_id, qty_accepted, returned_qty, grn_id')
    .in('purchase_order_item_id', poItemIds);
  const rows = (grnLines ?? []) as Array<{ purchase_order_item_id: string | null; qty_accepted: number; returned_qty: number; grn_id: string }>;
  const grnIds = [...new Set(rows.map((r) => r.grn_id).filter(Boolean))];
  if (grnIds.length === 0) return out;
  const { data: grns } = await sb.from('grns').select('id, grn_number, status').in('id', grnIds);
  const grnMeta = new Map<string, { grnNumber: string; status: string }>();
  for (const g of (grns ?? []) as Array<{ id: string; grn_number: string | null; status: string | null }>) {
    if ((g.status ?? '').toUpperCase() === 'CANCELLED') continue;
    grnMeta.set(g.id, { grnNumber: g.grn_number ?? '—', status: (g.status ?? '').toUpperCase() });
  }
  for (const r of rows) {
    if (!r.purchase_order_item_id) continue;
    const meta = grnMeta.get(r.grn_id);
    if (!meta) continue; // cancelled GRN — excluded
    const net = Number(r.qty_accepted ?? 0) - Number(r.returned_qty ?? 0);
    if (net <= 0) continue;
    const arr = out.get(r.purchase_order_item_id) ?? [];
    arr.push({ grnNumber: meta.grnNumber, qty: net, status: meta.status });
    out.set(r.purchase_order_item_id, arr);
  }
  return out;
}

// ── Detail ────────────────────────────────────────────────────────────
mfgPurchaseOrders.get('/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');

  /* Perf (go-live) — the downstream-lock GRN count is independent of the
     header + items load, so fold it into the same parallel batch instead of a
     third sequential round-trip. */
  const [headerRes, itemsRes, childCountRes] = await Promise.all([
    scopeToCompany(supabase
      .from('purchase_orders')
      .select(`${HEADER_COLS}, supplier:suppliers(id, code, name, contact_person, phone, email, address)`)
      .eq('id', id), c)
      .maybeSingle(),
    supabase.from('purchase_order_items').select(ITEM_COLS).eq('purchase_order_id', id).order('created_at'),
    supabase.from('grns')
      .select('id', { head: true, count: 'exact' })
      .eq('purchase_order_id', id)
      .neq('status', 'CANCELLED'),
  ]);

  if (headerRes.error) return c.json({ error: 'load_failed', reason: headerRes.error.message }, 500);
  if (!headerRes.data) return c.json({ error: 'not_found' }, 404);

  /* Tier 2 downstream-lock — stamp has_children on the detail header so the
     PO Detail page can lock once any non-cancelled GRN exists. */
  const childCount = childCountRes.count;
  const purchaseOrder = {
    ...(headerRes.data as Record<string, unknown>),
    has_children: (childCount ?? 0) > 0,
    // Stamped below once the source SO is resolved (SO-amendment workflow).
    has_open_amendment: false,
    open_amendment: null as { id: string; status: string; amendment_no: string } | null,
  };

  /* Per-line GR breakdown so the PO list expansion can show a "Received" column
     (which GR took how much) identical to the SO "Delivered" column. */
  /* Rule-order the rows at READ — canonical SKU/build order (sofa modules
     LHF→NA→RHF, mains→accessories→services), mirroring the SO detail GET
     (mfg-sales-orders.ts). The shared helper keys on `item_code`; PO lines
     expose `item_code`, so sort a shimmed view that carries the original
     row back unchanged. `.order('created_at')` above stays as the stable
     tiebreaker — pure ordering, no persistence touched. */
  type PoItemRow = Record<string, unknown> & { id: string; item_code: string };
  const itemRows = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      ((itemsRes.data ?? []) as unknown as Array<Record<string, unknown> & { id: string; item_code: string }>)
        .map((it): PoItemRow => ({ ...it, item_code: it.item_code })),
      (r) => r.item_group as string | null | undefined,
    ),
  );
  /* 2026-06-12 — "For SO" provenance column on the PO PDF (DSL/AutoCount
     layout; relabelled from "Transferred SO", owner 2026-08-07):
     resolve each line's so_item_id (migration 0098) to the source SO doc_no.
     Best-effort: a lookup failure leaves so_doc_no null, never blocks the
     detail response. */
  const soDocByItem = new Map<string, string>();
  /* SO→PO drift (Commander 2026-06-16) — a PO line snapshots its source SO
     line's spec at proceed time. Their workflow allows raising a PO BEFORE the
     SO is locked (pre-ordering long-lead material), so the SO can still be
     edited afterwards and the PO silently goes stale → the factory builds the
     wrong thing. We deliberately do NOT auto-sync (the PO may already be
     printed / sent to the supplier); instead we SURFACE the drift so the
     purchaser re-sends. The variant summary is recomputed apples-to-apples
     (same helper both sides) so a formatter change can't false-trip it. */
  type SoSnap = { item_code: string; item_group: string | null; description: string | null; variants: Record<string, unknown> | null; warehouse_id: string | null };
  const soLineById = new Map<string, SoSnap>();
  /* Source-SO header warehouse + masters, so the drift check resolves a NULL SO
     line warehouse to the order's own before comparing (bug 0539). Best-effort,
     loaded beside the snapshot below. */
  const soHeaderByDoc = new Map<string, SoWarehouseSource>();
  let whMasters: SoWarehouseMasters = { warehouses: [], stateMappings: [] };
  /* Perf (go-live) — the per-line receipts fetch and the SO-drift snapshot
     fetch both depend only on `itemRows` and are independent of each other, so
     run them concurrently instead of back-to-back. The SO-drift leg keeps its
     own try/catch (best-effort) so a lookup failure still leaves so_doc_no /
     drift null without blocking the detail response. */
  const soItemIds = [...new Set(
    itemRows.map((it) => it.so_item_id as string | null | undefined).filter(Boolean),
  )] as string[];
  const [receiptsMap, allocationsMap] = await Promise.all([
    poLineReceipts(supabase, itemRows.map((it) => it.id)),
    /* mig 0235 — per-line allocations (consolidated-PO splits), each slice
       carrying its SO doc_no (NULL so_item_id = stock). Feeds the detail
       chips on both surfaces; empty array on an unallocated line. */
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
      } catch { /* leave so_doc_no / drift null */ }
    })(),
  ]);

  /* SO-amendment workflow (2026-07-03) — stamp the open amendment for THIS PO so
     the PO Detail page can show the green "Revision ready" banner + gate actions.
     Resolve this PO → its source SO doc_no (via the lines' so_item_id →
     mfg_sales_order_items.doc_no, already gathered into soDocByItem above), then
     find the so_amendments row for that SO with status NOT IN ('SENT','REJECTED').
     Mirrors the SO detail's open_amendment stamp (mfg-sales-orders.ts). A PO can
     only be raised from ONE SO in this flow, so the distinct doc_no set is size 1;
     if a stray multi-SO PO ever appears we key off the first resolved doc_no.
     scopeToCompany: the so_amendments table carries company_id (mig 0080); no-op
     pre-activation. Best-effort: any failure leaves open_amendment null, never
     blocks the detail. */
  try {
    const soDocNos = [...new Set([...soDocByItem.values()].filter(Boolean))];
    if (soDocNos.length > 0) {
      const { data: amRows } = await scopeToCompany(supabase
        .from('so_amendments')
        .select('id, status, amendment_no')
        .in('so_doc_no', soDocNos), c)
        .not('status', 'in', '("SENT","REJECTED")')
        .order('created_at', { ascending: false })
        .limit(1);
      const am = ((amRows ?? []) as Array<Record<string, unknown>>)[0];
      if (am) {
        purchaseOrder.open_amendment = {
          // Postgres.js/PostgREST may surface columns camelCased; dual-read to be safe.
          id: String((am.id ?? (am as Record<string, unknown>).id) ?? ''),
          status: String(am.status ?? ''),
          amendment_no: String((am.amendment_no ?? (am as Record<string, unknown>).amendmentNo) ?? ''),
        };
        purchaseOrder.has_open_amendment = true;
      }
    }
  } catch { /* leave open_amendment null */ }

  const items = itemRows.map((it) => {
    const soId = it.so_item_id as string | null;
    const so = soId ? soLineById.get(soId) ?? null : null;
    /* SO→PO drift (spec / item swap / warehouse), extracted to lib/so-po-drift.
       Its warehouse arm resolves a NULL SO-line warehouse to the order header
       before comparing, so an inherited warehouse no longer reads as "moved"
       (bug 0539). */
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

// ── Linked docs (Smart Buttons fan-out) ─────────────────────────────
// Returns the GRNs, Purchase Invoices and Purchase Returns that descend
// from this PO. Tiny shape per child — counters + clickable link only.
mfgPurchaseOrders.get('/:id/linked', async (c) => {
  const id = c.req.param('id');
  const sb = c.get('supabase');

  /* Prove the PO belongs to the active company BEFORE fanning out: unscoped, an
     id resolved another company's PO to its GRN / invoice / return numbers. All
     seven /:id/linked endpoints shared this gap. 404 rather than 403 — an
     unreachable row must not confirm its own existence. */
  const owner = await scopeToCompany(sb.from('purchase_orders').select('id').eq('id', id), c).maybeSingle();
  if (owner.error) return c.json({ error: 'load_failed', reason: owner.error.message }, 500);
  if (!owner.data) return c.json({ error: 'not_found' }, 404);

  const [grnRes, piRes, prRes] = await Promise.all([
    sb.from('grns')
      .select('id, grn_number, status, received_at')
      .eq('purchase_order_id', id)
      .order('received_at', { ascending: false }),
    sb.from('purchase_invoices')
      .select('id, invoice_number, status, invoice_date')
      .eq('purchase_order_id', id)
      .order('invoice_date', { ascending: false }),
    sb.from('purchase_returns')
      .select('id, return_number, status, return_date')
      .eq('purchase_order_id', id)
      .order('return_date', { ascending: false }),
  ]);

  if (grnRes.error) return c.json({ error: 'load_failed', reason: grnRes.error.message }, 500);
  if (piRes.error)  return c.json({ error: 'load_failed', reason: piRes.error.message  }, 500);
  if (prRes.error)  return c.json({ error: 'load_failed', reason: prRes.error.message  }, 500);

  return c.json({
    grns:     grnRes.data ?? [],
    invoices: piRes.data  ?? [],
    returns:  prRes.data  ?? [],
  });
});

// GET — list PO revision snapshots for the Detail "Revisions" tab (SO-amendment
// workflow, 2026-07-03). Each row is a full snapshot captured when an amendment's
// approve-po gate revised the bound PO in place (po_revisions, keyed on po_id +
// revision). Newest first so the tab lists the latest revision on top. Mirrors
// the SO /:docNo/revisions read (mfg-sales-orders.ts): bare supabase select,
// plain load_failed on error. scopeToCompany: po_revisions carries company_id
// (mig 0080); no-op pre-activation.
mfgPurchaseOrders.get('/:id/revisions', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const { data, error } = await scopeToCompany(sb.from('po_revisions')
    .select('id, revision, snapshot, created_at, created_by')
    .eq('po_id', id), c)
    .order('revision', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ revisions: data ?? [] });
});

// ── Create ────────────────────────────────────────────────────────────
// body: {
//   supplierId, currency?, expectedAt?, notes?,
//   items: [{ materialKind, itemCode, materialName, supplierSku?, qty, unitPriceSen, bindingId? }]
// }
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

  /* Migration 0180 — supplier-revised header dates (all optional, default NULL).
     These fan out to each line below the same way expected_at fans to
     delivery_date, but a line's OWN override survives (mirrors the per-line
     delivery_date override pattern). */
  const headerD2 = dateOrNull(body.supplierDeliveryDate2);
  const headerD3 = dateOrNull(body.supplierDeliveryDate3);
  const headerD4 = dateOrNull(body.supplierDeliveryDate4);

  // PR #41 — allow blank-draft creation (no items). Commander 2026-05-26:
  // PO needs to be "raw" — start with just supplier + date, add items
  // line-by-line on the detail page (matches SO flow).
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

  // Generate human-readable PO number. Format: PO-YYMM-NNN (counts within month).
  const supabase = c.get('supabase');
  const user = c.get('user');

  /* PO/MRP only from CONFIRMED orders — a PO line sourced from an SO (carries a
     soItemId, e.g. the From-SO / MRP convert POSTing here) may only be raised
     when that SO is committed (CONFIRMED or beyond). Resolve every referenced
     SO line → its doc_no and reject if any source SO is not orderable. Purely
     manual lines (no soItemId) skip this — a PO can be raised with no SO link,
     unchanged. Mirror of the DO create-gate. */
  {
    const lineSoItemIds = items
      .map((it) => it.soItemId as string | undefined)
      .filter((x): x is string => !!x);
    if (lineSoItemIds.length > 0) {
      // Company scope (2026-08-19) — service-role bypasses RLS: scope the SO-item read and refuse a foreign soItemId BEFORE it is linked / photo-copied / po_qty_picked-rolled (mirrors soLinkTargetRefusal).
      const { data: lineSoRows } = await scopeToCompany(supabase.from('mfg_sales_order_items').select('id, doc_no, qty, po_qty_picked'), c).in('id', lineSoItemIds);
      const soRows = (lineSoRows ?? []) as Array<{
        id: string; doc_no: string | null; qty: number; po_qty_picked: number;
      }>;
      const foreignSoItemId = lineSoItemIds.find((id) => !new Set(soRows.map((r) => r.id)).has(id));
      if (foreignSoItemId) {
        return c.json({ error: 'so_line_not_found', reason: 'That Sales Order line does not exist on this company.', soItemId: foreignSoItemId }, 404);
      }
      const offender = await firstUnorderableSo(
        supabase,
        soRows.map((r) => r.doc_no),
      );
      if (offender) return c.json(soNotOrderableResponse(offender), 409);

      /* Remaining-qty cap — parity with the /from-sos guard (convertSosToPosCore,
         the `if (!fromMrp && p.qty > remaining)` check). The desktop "create new
         PO from SO" flow feeds SO-sourced lines through THIS generic create,
         which — unlike /from-sos — had no server-side cap, so a New-PO-form line
         could order more than the SO still needs (docs/2990-parity-allocation-
         costing.md, BUG-HISTORY 2026-07-24). Sum the requested qty per source SO
         line and reject when it exceeds (qty - po_qty_picked), overridable via
         confirmOverConvert. Purely-manual lines (no soItemId) never enter the map
         so manual POs are untouched; MRP never routes here (it uses /from-sos
         with fromMrp) so there is no MRP case to exclude. Pre-write guard: mark
         the idempotency claim no-write so the confirmed replay re-runs instead of
         replaying this 409 (mirrors the short_stock gate). */
      if (!confirmOverConvert) {
        const offender = findOverConvertOffender(items, soRows);
        if (offender) {
          markIdempotencyNoWrite(c);
          return c.json({ error: 'qty_exceeds_remaining', ...offender }, 409);
        }
      }
    }
  }

  const yymm = (() => {
    const d = new Date();
    return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();

  // PO# generation: max(suffix)+1 over the month's POs (see lib/doc-no.ts).
  // NOT count+1 — count+1 is non-self-healing (a mid-month delete leaves a gap
  // and re-mints a surviving number, jamming the NOT NULL UNIQUE po_number).
  const p = companyDocPrefix(c);
  let poNumber = await mintMonthlyDocNo(supabase, 'purchase_orders', 'po_number', `${p}PO-${yymm}`);

  // Compute totals
  let subtotal = 0;
  /* Commander 2026-05-29 (BUG 1) — collect (soItemId, qty) for any line that
     came from the From-SO picker so we can roll po_qty_picked forward AFTER the
     items insert (mirrors the /from-sos picks handler). Grouped by soItemId in
     case the same SO line shows up on more than one PO line. soItemId is NOT a
     purchase_order_items column — it's stripped from the insert payload. */
  const pickedQtyBySoItem = new Map<string, number>();
  /* Reject non-finite line numbers BEFORE the map. The Math.max(0, ...) clamps
     below stop a negative total but NOT a NaN — Math.max(0, NaN) is NaN — so a
     junk qty/price used to persist NaN into the INTEGER SEN columns and poison
     the PO subtotal. Checked up front rather than inside the map because a
     throw in there escapes to Hono as a generic 500 (the material_kind guard's
     behaviour) instead of a plain-language 400. */
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
  const groupOf = await skuCategoryResolver(supabase, items, activeCompanyId(c) ?? null); // SKU wins — lib/sku-category.ts
  const itemRows = items.map((it) => {
    const kind = it.materialKind as string;
    if (!VALID_KINDS.has(kind)) throw new Error(`invalid material_kind: ${kind}`);
    if (!it.itemCode || !it.materialName) throw new Error('item_code + material_name required per item');
    const qty = Math.max(0, Number(it.qty ?? 0));
    // BUG 1 — tally per-SO-line picked qty (only for From-SO lines).
    const soItemId = (it.soItemId as string | undefined) ?? null;
    if (soItemId && qty > 0) {
      pickedQtyBySoItem.set(soItemId, (pickedQtyBySoItem.get(soItemId) ?? 0) + qty);
    }
    const unit = Math.max(0, Number(it.unitPriceSen ?? 0));
    const discountSen = Math.max(0, Number(it.discountSen ?? 0));
    // PR #97 — line total honours per-line discount when computed up front
    // (matches the AutoCount "Total" column in the new full-page form).
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
      /* PR #97 — pass-through per-line variant + AutoCount fields. NULL
         when absent so the column default / nullable behaviour kicks in. */
      discount_sen: discountSen,
      delivery_date: dateOrNull(it.deliveryDate),
      /* Migration 0180 — line's own revised date wins, else the header's. */
      supplier_delivery_date_2: dateOrNull(it.supplierDeliveryDate2) ?? headerD2,
      supplier_delivery_date_3: dateOrNull(it.supplierDeliveryDate3) ?? headerD3,
      supplier_delivery_date_4: dateOrNull(it.supplierDeliveryDate4) ?? headerD4,
      warehouse_id:  (it.warehouseId  as string | undefined) ?? null,
      /* Commander 2026-05-28 — persist the per-line category + variants the PO
         form now collects (mirroring SO), and auto-generate Description 2 from
         them (server-owned, like the SO route). */
      variants:     (it.variants as unknown) ?? null,
      description:  (it.description as string | undefined) ?? null,
      ...lineIdentityFields(groupOf, it, buildVariantSummary), // item_group + description2, from ONE group
      /* Commander 2026-05-29 (BUG 1) — persist the source SO line (migration
         0098) so deleting this PO line can release po_qty_picked back to the
         From-SO picker. NULL for manually-added lines. */
      so_item_id:   soItemId,
    };
  });

  /* Draft/Confirmed two-state model — a PO is opt-in saveable as DRAFT
     (asDraft === true) for review before it commits, exactly like the SO
     template. A DRAFT PO: (a) carries status DRAFT + NULL submitted_at, and
     (b) does NOT advance the source SO lines' po_qty_picked (skipped below),
     so the SO stays in the From-SO picker and the draft is invisible to MRP
     supply (PO_DEAD includes DRAFT). Confirm (PATCH /:id/confirm) flips it to
     SUBMITTED and runs the SO-picked recount there. A manual PO with no
     asDraft flag still defaults to SUBMITTED so existing flows are unaffected.
     PATCH /submit — described here until 2026-08-18 as "an idempotent no-op for
     legacy callers" — has been deleted; it was neither idempotent nor harmless,
     it 409'd every draft, and the read-only PO page was still calling it. */
  const asDraft = body.asDraft === true;
  const headerInsert: Record<string, unknown> = {
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    po_number: poNumber,
    supplier_id: supplierId,
    status: asDraft ? 'DRAFT' : 'SUBMITTED',
    submitted_at: asDraft ? null : new Date().toISOString(),
    currency,
    expected_at: expectedAt,
    /* Migration 0180 — supplier-revised header delivery dates (default NULL). */
    supplier_delivery_date_2: headerD2,
    supplier_delivery_date_3: headerD3,
    supplier_delivery_date_4: headerD4,
    notes: (body.notes as string | undefined) ?? null,
    subtotal_sen: subtotal,
    tax_sen: 0,
    total_sen: subtotal,
    created_by: user.id,
    /* PR #97 — AutoCount Purchase Location at create time.
       PR #157 — now required (see validation above). */
    purchase_location_id: purchaseLocationId,
  };
  // Optional poDate — if absent, the column default (now()) wins.
  if (body.poDate) headerInsert.po_date = body.poDate;

  /* Doc-no collision retry (2026-07-14): two buyers cutting a PO in the same
     company + YYMM both read the same max and mint the same po_number; without a
     retry the loser hits the UNIQUE po_number (23505) and the PO 500s. Items key
     off the returned header.id (not po_number), so a re-mint needs no child
     re-stamp. Non-23505 errors (e.g. 42501) fall straight through unchanged. */
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
    /* DEAD BRANCH -- here and at every other 42501 site in this file. 42501 is
       Postgres permission-denied (RLS), and RLS cannot fire here: mig 0061
       enabled it on every scm table with NO policies, and the SCM client is the
       SERVICE-ROLE client, which bypasses RLS. No scm function RAISEs 42501
       either. Do NOT read this as a permission check or as scoping: the only
       boundary is this route's own predicate. */
    if (hErr.code === '42501') return c.json({ error: 'forbidden', reason: hErr.message }, 403);
    return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  }

  // Cast through `unknown` — Supabase JS without generated types returns
  // `GenericStringError` from `.select(string).single()` even when data is
  // populated. Project-wide pattern; see apps/api/src/routes/admin.ts L97.
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
    const itemsToInsert = itemRows.map((r) => ({
      ...r,
      purchase_order_id: header.id,
      photo_urls: (r.so_item_id ? photosBySoItem.get(r.so_item_id) : null) ?? [],
    }));
    const { error: iErr } = await supabase.from('purchase_order_items').insert(stampCompany(itemsToInsert, c));
    if (iErr) {
      // Best-effort rollback of header so we don't leak a no-items PO.
      await supabase.from('purchase_orders').delete().eq('id', header.id);
      return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500);
    }
  }

  /* The PO has survived the only branch that could undo it. The SO-quota recount
     below is best-effort and never deletes the header, so from here every exit
     is a success and this CREATE row is true. */
  await recordPoCreate(supabase, c.get('houzsUser'), activeCompanyId(c), header.id, itemRows.length);

  /* Commander 2026-05-30 — recount po_qty_picked from the live PO lines for
     every source SO line this PO just converted, so they drop out of the
     From-SO picker (qty - picked > 0). Self-healing — see recomputeSoPicked.
     Best-effort: never fail the PO if the recount errors.
     Leak guard (Draft/Confirmed) — a DRAFT PO must NOT advance the SO quota:
     it is reference-only until confirmed (recomputeSoPicked already excludes
     it, since recomputeSoPicked drops PO lines whose PO is not live — but the
     PO IS the one we just made, so skip the call entirely while DRAFT). The
     confirm transition runs this recount. */
  if (!asDraft && pickedQtyBySoItem.size > 0) {
    try { await recomputeSoPicked(supabase, [...pickedQtyBySoItem.keys()]); }
    catch { /* PO already created — don't fail on counter recount */ }
  }

  /* ERP -> AutoCount write-back. Queued, never pushed inline. No-op while the
     flag is off, which is how it ships. NOT for a DRAFT PO — it is
     reference-only until confirmed (the same reason recomputeSoPicked skips
     it above); PATCH /:id/confirm queues it. */
  /* AND IT SAYS SO WHEN THE ACCOUNTS WILL NOT TAKE IT. The compose runs HERE,
     in this request; it used to end in a skipped row and a bare 201. Never a
     422 — lib/ac-preflight.ts holds the block-or-warn ruling and its reason. */
  const acNotSent = asDraft ? [] : (await enqueuePoCreate(supabase, {
    companyId: activeCompanyId(c),
    poId: header.id,
    createdBy: c.get('houzsUser')?.id ?? null,
  })).problems;

  return c.json({ id: header.id, poNumber: header.po_number, ...(acNotSent.length ? { acNotSent } : {}) }, 201);
};
mfgPurchaseOrders.post('/', createMfgPurchaseOrderHandler);

// ── POST /from-sos ────────────────────────────────────────────────────
// Create POs from selected Sales Order items. For each SO item, looks up
// the MAIN supplier binding via supplier_material_bindings. Groups items
// by supplier_id and creates ONE PO per supplier. Returns the list of
// created PO ids/numbers so the UI can summarize.
//
// Body: { soItems: [{ soDocNo, itemCode, itemName, qty }] }
/* PR — Commander 2026-05-26: SO → PO multi-select + partial.
 * Body shape now: `{ picks: [{ soItemId, qty }] }` (camelCase).
 * Legacy shape `{ soItems: [{ soDocNo, itemCode, itemName, qty }] }`
 * still accepted — when given, we look up the SO items by (soDocNo, itemCode)
 * and convert. New shape is preferred because we can validate qty <= remaining
 * (qty - po_qty_picked) and increment po_qty_picked atomically. */
/* ── SO → PO convert core (agent factoring, 2026-07-17) ────────────────────
   The handler body below is the single authority for raising a PO from SO
   lines: supplier binding, warehouse resolution, lead-time subtraction, the
   per-category split, doc-no minting. The Procurement Agent's approved
   proposals must produce POs through THIS body and no other — a second path
   would drift from it, and the thing that drifts is the date we promise a
   supplier.

   So the body is factored MECHANICALLY (unchanged) to take a minimal
   structural context instead of the full Hono context. The HTTP route below
   wires the real context through verbatim; createDraftPosFromPicks feeds it a
   synthetic one built from Env.

   The synthetic context is the part with a scar. companyDocPrefix reads
   `companyCode` and expects a STRING — the scan background job once handed a
   reconstructed context a whole company object there and minted
   "[object Object]-SO-2607-001" into production. Hence PoConvertContext types
   every key it exposes, and the headless builder below returns explicit values
   for all of them rather than falling through to a default. */
export type PoConvertOutcome = { status: number; body: Record<string, unknown> };
export type PoConvertContext = {
  req: { json(): Promise<unknown> };
  /* supabase keeps the REAL client type — the body relies on the typed query
     builders for callback inference (an `any` turns every `.map((r) => ...)`
     inside into an implicit-any TS7006). Mirrors SoCreateContext. */
  get(key: 'supabase'): Variables['supabase'];
  get(key: 'user'): { id: string };
  /* The REAL Houzs caller, for the audit row's WHO. Undefined on the headless
     path — the Procurement Agent runs with no session, and the writer already
     degrades to an unattributed row that still records WHEN and WHAT. Declared
     here rather than reached for through the `user` shim because that shim is
     ONE pinned system staff uuid for every caller inside /api/scm/* (see
     entity-audit's actor-resolution note): using it would make the actor column
     a constant, which is exactly the bug this log was built to avoid. */
  get(key: 'houzsUser'): Variables['houzsUser'];
  /* Multi-company (mig 0061). Undefined pre-migration / cold-start / headless
     so the stamping and scoping no-op — see the sentinel in companyScope. */
  get(key: 'companyId'): number | undefined;
  get(key: 'allowedCompanyIds'): number[] | undefined;
  /** STRING or undefined. Never an object — see the doc-prefix scar above. */
  get(key: 'companyCode'): string | undefined;
  env: Env;
  json(body: unknown, status?: number): PoConvertOutcome;
};

export async function convertSosToPosCore(c: PoConvertContext): Promise<PoConvertOutcome> {
  const supabase = c.get('supabase');
  const user = c.get('user');
  let body: {
    /* Commander 2026-05-31 — the MRP page now sends a per-pick supplierId so a
       single SO line can be split to an alternate supplier in-place. It wins
       over supplierByCode and the SKU's main-supplier binding (see
       effectiveSupplierId below). Optional → the general SO→PO picker omits it. */
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
    /* Commander 2026-05-29 — per-SKU supplier override. The MRP lets the user
       switch an item to an alternate supplier in-place; { itemCode: supplierId }
       wins over the SKU's main-supplier binding. */
    supplierByCode?: Record<string, string>;
    /* Commander 2026-05-29 — "Convert from SO" / "Add Line Item" on an EXISTING
       PO open this same picker scoped to that PO. When targetPoId is set we do
       NOT create new POs — we APPEND the picked lines to that PO (only the lines
       whose supplier matches the PO's supplier), keeping each line's so_item_id
       so a later delete releases the SO quota. */
    targetPoId?: string;
    /* Commander 2026-05-31 — when the convert is raised from the MRP page the PO
       line is REFERENCE-ONLY: it does NOT lock the source SO line via
       po_qty_picked. MRP pools all open PO as supply regardless of SO↔PO linkage,
       so the same SO line is infinitely convertible from MRP. This flag (a)
       bypasses the qty_exceeds_remaining cap and (b) tags the PO line from_mrp so
       the po_qty_picked recount excludes it. The "an MRP-ordered SO disappears
       from Convert-from-SO" expectation is met by the picker now hiding lines
       with no pooled shortage (stock+open-PO fully covers) — the from_mrp PO is
       part of that supply pool — NOT by per-line locking. The ordinary From-SO
       picker leaves this false → keeps its cap. */
    fromMrp?: boolean;
    /* Land the created POs as DRAFT instead of SUBMITTED (owner 2026-07-17 —
       the Procurement Agent's Stage 1: propose, then approve).

       Opt-in and defaulting FALSE, so every existing caller is byte-for-byte
       unaffected. `POST /` has taken this since PR #131 and the SO flow uses it;
       the bulk convert never could, which is the whole reason an agent could not
       raise a PO for review — see the header insert below for why a DRAFT is the
       right fuse rather than a new parallel mechanism. */
    asDraft?: boolean;
  };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const poMode: 'combined' | 'per-so' = body.mode === 'per-so' ? 'per-so' : 'combined';
  const fromMrp = body.fromMrp === true;
  const asDraft = body.asDraft === true;
  const supplierByCode = (body.supplierByCode ?? {}) as Record<string, string>;
  const targetPoId = body.targetPoId as string | undefined;

  /* Wei Siang 2026-06-11 — a SKU with NO supplier binding can still be PO'd:
     the cost is keyed in later at Purchase Invoice time. All we truly need is
     a SUPPLIER to put the line on. Resolve the append-target PO's supplier up
     front so it can serve as the fallback for unbound SKUs (the PO-scoped
     "Convert from SO" / "Add Line Item" pickers are locked to that supplier
     anyway). */
  /* asDraft only means anything on the CREATE path — the append path adds lines
     to a PO that already has a status and must not silently re-open it. Refuse
     the combination rather than accept it and ignore half of it: a caller that
     asked for a draft and got its lines appended to a live PO has been told
     nothing went wrong while the opposite of what it asked for happened. */
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

  /* Commander 2026-05-28 — PO-from-SO redesign. expectedAt + purchaseLocationId
     are NO LONGER asked or required. They are derived per-line from the source
     SO instead:
       - each PO line's warehouse  = the SO header's `sales_location` resolved
         to a warehouse id (case-insensitive name/code match; null if no match)
       - each PO line's delivery date = the SO LINE's `line_delivery_date`,
         falling back to the SO header `customer_delivery_date`
       - PO header expected_at = earliest non-null line delivery date, else null
       - PO header purchase_location_id = most-common resolved line warehouse,
         else null
     Optional overrides are still honoured if a caller sends them (defense-in-
     depth for legacy callers), but neither is mandatory. */
  const expectedAtOverride = body.expectedAt;
  const purchaseLocationOverride = body.purchaseLocationId;

  // Preload the warehouses list ONCE for the sales_location text → id match.
  const { data: whRows } = await scopeToCompany(
    supabase.from('warehouses').select('id, code, name'),
    c,
  );
  type Wh = { id: string; code: string | null; name: string | null };
  const warehouses = (whRows ?? []) as Wh[];

  // Commander 2026-06-18 — per-category MRP lead days. A PO line's delivery date
  // is pulled this many days EARLIER than the customer/SO delivery date so the
  // supplier delivers ahead of the customer date. Commander 2026-06-22
  // (migration 0184 / SCM mig 0036) — also per-WAREHOUSE.
  //
  // The rule now lives in scm/lib/lead-time.ts, shared with the MRP order-by
  // hint so the two can no longer disagree. It used to be a copy here, and the
  // copies HAD drifted: mrp.ts checked this query's error, this route discarded
  // it. A blip zeroed every lead day and the PO went out asking the supplier to
  // deliver ON the customer's own date — silently, because a zero lead day and a
  // failed read were the same number. loadLeadTimeBase THROWS instead; the
  // convert below fails loudly rather than committing a wrong-but-plausible date.
  const leadBase = await loadLeadTimeBase(
    scopeToCompany(supabase.from('mrp_category_lead_times').select(LEAD_TIME_SELECT), c),
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

  // ── Resolve picks → SO item rows ─────────────────────────────────
  // Commander 2026-05-28 — also load line_delivery_date + the parent SO's
  // sales_location + customer_delivery_date so we can derive per-line warehouse
  // + delivery date below.
  type SoItem = {
    id: string; doc_no: string; item_code: string; description: string | null;
    qty: number; po_qty_picked: number; unit_price_sen: number;
    line_delivery_date: string | null;
    // Phase 3 (2026-05-29) — carry the SO line's category + variant bag so the
    // PO line cost can auto-price from the supplier matrix + maintenance
    // surcharges (mirrors the client recompute), instead of a flat copy. Also
    // used by #300 to consolidate same SKU+variant lines + carry the variant
    // through to the PO line.
    item_group: string | null;
    variants: Record<string, unknown> | null;
    // Commander 2026-05-31 (warehouse-flow bug) — the SO LINE's OWN ship-to
    // warehouse (migration 0118). This is the AUTHORITATIVE per-line warehouse;
    // it must flow through to the PO line so a KL SO line never lands stock in
    // PG. The SO header sales_location is only a last-resort fallback now.
    warehouse_id: string | null;
    /* Owner 2026-08-10 (migration 0274) — the SO line's photos ride along to the
       PO line. R2 keys, not bytes: the PO points at the SAME objects. */
    photo_urls: string[] | null;
    so: { sales_location: string | null; customer_delivery_date: string | null } | null;
  };
  const SO_ITEM_SELECT =
    'id, doc_no, item_code, description, item_group, variants, qty, po_qty_picked, unit_price_sen, line_delivery_date, warehouse_id, photo_urls, cancelled, ' +
    /* No company_id on this embed: both source reads below are SCOPED, so a
       cross-company line is never returned and there is nothing to compare. */
    'so:mfg_sales_orders!inner ( sales_location, customer_delivery_date )';
  // supabase-js returns the embedded parent as an object OR a 1-element array
  // depending on the relationship — normalise to a single object.
  const normSo = (r: { so: unknown }): SoItem['so'] => {
    const raw = (r as { so: unknown }).so;
    if (Array.isArray(raw)) return (raw[0] as SoItem['so']) ?? null;
    return (raw as SoItem['so']) ?? null;
  };
  // Commander 2026-05-31 — pickSupplierId carries the per-pick supplier override
  // (MRP) through to effectiveSupplierId / the PO grouping key. null on the
  // legacy soItems path and the general picker (those have no per-pick supplier).
  const pickedItems: Array<{ row: SoItem; qty: number; pickSupplierId: string | null }> = [];

  if (body.picks && body.picks.length > 0) {
    const ids = body.picks.map((p) => p.soItemId);
    /* SOURCE LOAD, SCOPED — the caller's soItemIds enter this core here, so this
       read decides what the conversion can see: another company's line resolves
       to NO ROW and falls out at the per-pick `item_not_found` below. THE COST is
       the message, because naming the other company needs an UNSCOPED read this
       core otherwise never makes.

       Both call paths carry a usable context: the HTTP route wires the real Hono
       one, and createDraftPosFromPicks builds a synthetic one carrying companyId
       + allowedCompanyIds TOGETHER (procurement-execute passes both or neither),
       so the agent never hits scopeToCompany's fail-closed branch. */
    const { data: rows, error } = await scopeToCompany(supabase
      .from('mfg_sales_order_items')
      .select(SO_ITEM_SELECT)
      .in('id', ids), c);
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    const byId = new Map<string, SoItem>();
    for (const r of (rows ?? []) as unknown as SoItem[]) byId.set(r.id, { ...r, so: normSo(r) });
    // Validate qty ≤ (row.qty - row.po_qty_picked)
    for (const p of body.picks) {
      const row = byId.get(p.soItemId);
      if (!row) return c.json({ error: 'item_not_found', soItemId: p.soItemId }, 400);
      /* A retired line has no demand to purchase against. The line-level bind
         (soLinkTargetRefusal) has refused this since it was written and the
         From-SO picker never lists one, but THIS is the bulk create — reached by
         POST /from-sos and by the MRP agent, neither of which goes through
         either — so a cancelled line stayed purchasable here. Inert today
         (production holds two cancelled lines, both with zero demand) and the
         gate that has to exist before line retirement can ship. */
      if ((row as { cancelled?: boolean | null }).cancelled) {
        return c.json({
          error: 'so_line_cancelled',
          reason: `Sales Order line ${row.doc_no ?? ''} (${row.item_code ?? ''}) is cancelled — it has no demand to purchase against.`.trim(),
          soItemId: p.soItemId,
        }, 409);
      }
      const remaining = row.qty - row.po_qty_picked;
      if (p.qty <= 0)         return c.json({ error: 'qty_must_be_positive', soItemId: p.soItemId }, 400);
      // Commander 2026-05-31 — MRP-origin converts skip the remaining cap: the
      // line is reference-only and infinitely convertible (the pooled picker, not
      // this per-line cap, decides what still needs ordering). The ordinary
      // picker keeps the cap so a normal SO→PO can't over-order a single line.
      if (!fromMrp && p.qty > remaining)
        return c.json({ error: 'qty_exceeds_remaining', soItemId: p.soItemId, requested: p.qty, remaining }, 409);
      pickedItems.push({ row, qty: p.qty, pickSupplierId: p.supplierId ?? null });
    }
  } else {
    // Legacy soItems path — kept so old callers don't break.
    const soItems = body.soItems ?? [];
    if (soItems.length === 0) return c.json({ error: 'so_items_required' }, 400);
    // Best-effort match by (doc_no, item_code). Doesn't update po_qty_picked.
    const codes  = [...new Set(soItems.map((it) => it.itemCode))];
    const docNos = [...new Set(soItems.map((it) => it.soDocNo))];
    /* SOURCE LOAD, SCOPED — same rule as the picks branch, and it matters more
       here: this legacy branch FABRICATES a minimal row when the (doc_no,
       item_code) pair does not match, so an unscoped read would have used the
       other company's line verbatim. Scoped, it falls through to the fabricated
       row, which carries qty and price from the CALLER. */
    const { data: rows } = await scopeToCompany(supabase
      .from('mfg_sales_order_items')
      .select(SO_ITEM_SELECT)
      .in('doc_no', docNos)
      .in('item_code', codes), c);
    const byKey = new Map<string, SoItem>();
    for (const r of (rows ?? []) as unknown as SoItem[]) byKey.set(`${r.doc_no}|${r.item_code}`, { ...r, so: normSo(r) });
    for (const it of soItems) {
      const row = byKey.get(`${it.soDocNo}|${it.itemCode}`);
      // Even if no SO row found, fabricate a minimal one so PO still gets created.
      pickedItems.push({
        row: row ?? {
          id: '', doc_no: it.soDocNo, item_code: it.itemCode, description: it.itemName,
          qty: it.qty, po_qty_picked: 0, unit_price_sen: 0,
          line_delivery_date: null, item_group: null, variants: null,
          // No SO line warehouse on the legacy fabricated row → falls back to
          // the SO header sales_location resolution below.
          warehouse_id: null, photo_urls: null, so: null,
        },
        qty: it.qty,
        // Legacy path has no per-pick supplier → effectiveSupplierId falls back
        // to supplierByCode / the SKU main-supplier binding.
        pickSupplierId: null,
      });
    }
  }

  if (pickedItems.length === 0) return c.json({ error: 'no_pickable_lines' }, 400);

  /* PO/MRP only from CONFIRMED orders — every source SO must be committed
     (CONFIRMED or beyond) before its lines can be converted to a PO. Deny-list
     mirror of the DO create-gate; covers the general picker, the MRP convert
     (fromMrp) and the append-to-existing-PO (targetPoId) — all flow through
     pickedItems. The legacy soItems path fabricates rows for unknown docs;
     firstUnorderableSo only returns a match for a real, non-orderable SO, so a
     fabricated/unknown doc never over-blocks. */
  {
    const offender = await firstUnorderableSo(supabase, pickedItems.map((p) => p.row.doc_no));
    if (offender) return c.json(soNotOrderableResponse(offender), 409);
  }

  // Re-project into the legacy soItems shape for the rest of the handler.
  // Commander 2026-05-28 — carry the per-line derived warehouse + delivery
  // date so they survive the supplier grouping below.
  const soItems = pickedItems.map(({ row, qty, pickSupplierId }) => {
    // Commander 2026-05-31 (warehouse-flow bug) — per-line warehouse precedence:
    //   1. explicit caller override (purchaseLocationId) — defense-in-depth,
    //   2. the SO LINE's OWN warehouse_id (migration 0118) — AUTHORITATIVE,
    //   3. the SO header sales_location resolved to a warehouse id — last-resort
    //      fallback (legacy soItems path / SO lines that predate per-line wh).
    // This is the fix: previously (2) was ignored, so a KL SO line's PO could
    // land stock in PG. The SO line's warehouse now flows straight to the PO.
    const lineWarehouseId =
      (purchaseLocationOverride as string | undefined)
      ?? row.warehouse_id
      ?? resolveWarehouseId(row.so?.sales_location);
    // The CUSTOMER's date — SO LINE's own, falling back to the SO header.
    // The supplier's date is derived from it below, in the grouping loop.
    //
    // It is derived THERE and not here because the lead time now has a
    // per-SUPPLIER layer (the Procurement Agent's learned punctuality buffer),
    // and the effective supplier is not resolved until effectiveBindingFor runs
    // — a pick override, a supplierByCode override and the main binding all get
    // a say first. Computing the date here would silently apply the buffer of a
    // supplier we had not chosen yet, or none at all.
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
      // Phase 3 — carry the SO line's category + variants for PO auto-pricing
      // (#300 also uses these to consolidate same SKU+variant lines + carry the
      // variant through to the PO line).
      itemGroup: row.item_group,
      variants:  row.variants,
      // Commander 2026-05-29 — the source SO line id, threaded to the PO line so
      // the append-to-existing-PO path can persist so_item_id (release-on-delete).
      soItemId:  row.id || null,
      // Owner 2026-08-10 — the SO line's photo keys, carried to the PO line.
      photoUrls: row.photo_urls ?? [],
      // Commander 2026-05-31 — per-pick supplier override (MRP), the highest
      // precedence input to effectiveSupplierId below.
      pickSupplierId,
    };
  });

  // Resolve main supplier per item via supplier_material_bindings.
  // Phase 3 (2026-05-29) — also load price_matrix so the PO line cost can
  // auto-price from the supplier's own per-category price table.
  const codes = [...new Set(soItems.map((it) => it.itemCode))];
  type MainBindingRow = {
    item_code: string; supplier_id: string; supplier_sku: string;
    unit_price_sen: number; currency: string; price_matrix: Record<string, unknown> | null;
  };
  /* CHUNKED + PAGED — lib/supplier-bindings.ts. `is_main_supplier DESC` kept the
     MAINS in page one, so an un-paged read lost the ALTERNATES — what the MRP
     dropdown sends — and the PO went to the main supplier, at its price, silently. */
  const { data: bindings } = await readMfgProductBindings<MainBindingRow>(supabase, {
    codes, companyId: activeCompanyId(c),
    select: 'item_code, supplier_id, supplier_sku, unit_price_sen, currency, price_matrix, is_main_supplier',
  });
  /* Commander 2026-05-29 — drop ORPHANED bindings (supplier was deleted but the
     binding row survived, e.g. after a supplier reset). An orphan would slip a
     dead supplier_id into the PO insert → FK violation → silent 0-PO "success".
     Resolve which referenced suppliers actually exist and skip the rest, so the
     SKU is reported as "needs a supplier" via missing_bindings below. */
  const supplierIds = [...new Set(((bindings ?? []) as Array<{ supplier_id: string }>).map((b) => b.supplier_id))];
  const liveSupplierIds = new Set<string>();
  /* supplier uuid -> business code, filled by the liveness probes below. Feeds
     the lead-time supplier buffer, which is keyed on the code so a supplier row
     re-imported under a new uuid keeps its learned punctuality. A supplier with
     no code simply carries no buffer. */
  const supplierCodeById = new Map<string, string>();
  if (supplierIds.length > 0) {
    /* `code` rides along on the existing liveness probe — the lead-time
       supplier buffer is keyed on the business code, not the uuid, and this
       query already had to run. Zero extra round-trips. */
    const { data: liveSuppliers } = await supabase
      .from('suppliers').select('id, code').in('id', supplierIds);
    for (const s of (liveSuppliers ?? []) as Array<{ id: string; code: string | null }>) {
      liveSupplierIds.add(s.id);
      if (s.code) supplierCodeById.set(s.id, s.code);
    }
  }
  /* Wei Siang 2026-06-11 — also validate suppliers named OUTSIDE bindings (a
     per-pick supplierId, a supplierByCode override, or the append-target PO's
     supplier), so an unbound SKU can ride a zero-priced pseudo-binding on one
     of them instead of 400-ing the whole convert. */
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

  /* Group by item_code → the chosen supplier's binding. Commander
     2026-05-29: an explicit supplierByCode[itemCode] override (picked in the
     MRP) wins; otherwise the first LIVE row (is_main_supplier first via ORDER
     BY). Orphaned bindings (deleted supplier) are skipped.
     Phase 3 (2026-05-29) — the binding also carries price_matrix so the PO line
     cost can auto-price from the supplier's own per-category price table. */

  /* Commander 2026-05-31 — per-pick supplier support. A single SKU can now be
     split across suppliers within one convert (MRP per-line supplierId), so a
     single "main binding per code" is no longer enough to cost / group a line.
     Build BOTH:
       • mainByCode — the SKU's default (override/main) binding, used as the
         FINAL fallback when a line has no per-pick supplier;
       • bindingByCodeSupplier (`code|supplierId`) — every live binding, so a
         line bound to a specific effective supplier can resolve ITS binding
         (sku, price_matrix, currency) for costing + grouping. */
  const mainByCode = new Map<string, MainBindingRow>();
  const bindingByCodeSupplier = new Map<string, MainBindingRow>();
  for (const b of bindings) {
    if (!liveSupplierIds.has(b.supplier_id)) continue; // orphaned binding — skip
    bindingByCodeSupplier.set(`${b.item_code}|${b.supplier_id}`, b);
    const override = supplierByCode[b.item_code];
    const existing = mainByCode.get(b.item_code);
    if (override) {
      // Only accept the binding that matches the chosen supplier.
      if (b.supplier_id === override) mainByCode.set(b.item_code, b);
      continue;
    }
    if (!existing) mainByCode.set(b.item_code, b);
  }

  /* Commander 2026-05-31 — resolve the EFFECTIVE binding for a picked line.
     Supplier precedence (matches effectiveSupplierId):
       1. the line's per-pick supplierId (MRP),
       2. supplierByCode[itemCode] (general picker / MRP per-SKU override),
       3. the SKU's main-supplier binding (mainByCode).
     Returns null only when the SKU has NO live binding at all (→ surfaced via
     missing_bindings). If a per-pick/override supplier is named but has no live
     binding for this SKU, fall back to main so the convert still produces a PO
     against a valid supplier rather than silently dropping the line. */
  const effectiveBindingFor = (it: { itemCode: string; pickSupplierId: string | null }): MainBindingRow | null => {
    const chosen = it.pickSupplierId ?? supplierByCode[it.itemCode] ?? null;
    if (chosen) {
      const exact = bindingByCodeSupplier.get(`${it.itemCode}|${chosen}`);
      if (exact) return exact;
    }
    const main = mainByCode.get(it.itemCode);
    if (main) return main;
    /* Wei Siang 2026-06-11 — no live binding: don't block the PO. When the
       line still names a supplier (per-pick / override / the append-target
       PO), ride a zero-priced pseudo-binding: the line lands on that supplier
       at cost 0 and the real price is keyed in at Purchase Invoice time.
       Lines with NO resolvable supplier at all still fall through to the
       missing_bindings 400 — a PO cannot exist without a supplier. */
    const fallback = chosen ?? targetPoSupplierId;
    if (fallback && liveSupplierIds.has(fallback)) {
      return {
        item_code: it.itemCode, supplier_id: fallback, supplier_sku: '',
        unit_price_sen: 0, currency: 'MYR', price_matrix: null,
      };
    }
    return null;
  };

  /* Phase 3 — resolve the fabric tier for each SO line's fabricCode (split
     per category: sofa_price_tier vs bedframe_price_tier), mirroring the
     client. Load every distinct fabricCode that appears on a picked line so
     a PRICE_1 fabric flips the cost to the supplier's P1 cell. When no fabric
     / tier is set the cost engine defaults to P2. */
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

  /* Phase 3 — maintenance config per supplier (supplier scope → master
     fallback), resolved ONCE per supplier that owns a picked line. The cost
     engine reads each option's priceSen as the cost surcharge. */
  // Commander 2026-05-31 — derive from each picked line's EFFECTIVE binding so
  // a per-pick alternate supplier's maintenance config + combos are loaded too
  // (not just the main-supplier set).
  const supplierIdsInvolved = [...new Set(
    soItems
      .map((it) => effectiveBindingFor(it)?.supplier_id)
      .filter((x): x is string => Boolean(x)),
  )];
  const maintBySupplier = new Map<string, MaintenanceConfig | null>();
  await Promise.all(supplierIdsInvolved.map(async (sid) => {
    const { config } = await resolveMaintenanceConfigForSupplier(supabase, sid);
    maintBySupplier.set(sid, config);
  }));

  /* Commander 2026-05-29 — also load each involved supplier's own sofa combos
     so a sofa line whose modules MATCH a combo is costed at the combo price
     (the supplier's set deal) instead of the per-seat-size matrix. */
  const combosBySupplier = await loadSupplierSofaCombos(supabase, supplierIdsInvolved);

  // Items with NO resolvable supplier at all can't be PO'd (a PO must belong
  // to a supplier). Unbound SKUs that DO name a supplier (per-pick / override /
  // target PO) now pass on a zero-priced pseudo-binding — price keyed in at PI
  // time (Wei Siang 2026-06-11).
  const noBinding = soItems.filter((it) => !effectiveBindingFor(it));
  if (noBinding.length > 0) {
    return c.json({
      error: 'missing_bindings',
      message: 'No supplier could be resolved for some items — bind a main supplier or pick one for them',
      itemCodes: [...new Set(noBinding.map((it) => it.itemCode))],
    }, 400);
  }

  /* ── Per-line cost + sofa-combo redistribution (Commander 2026-05-29) ──────
     Step 1: base per-unit cost for EVERY pickable line — the supplier's
     price_matrix (P2 default; P1 when the fabric resolves to PRICE_1) + the
     supplier's maintenance surcharges, via computeMfgPoUnitCost. Falls back to
     the flat binding price when there's no category/matrix.

     Step 2: sofa-combo redistribution, a faithful cost-side port of HOOKKA's
     sales-order combo logic (src/pages/sales/create.tsx). A sectional sofa is
     bought as PER-MODULE lines (e.g. BOOQIT-1A(LHF), BOOQIT-L(LHF) …). We group
     those lines by (supplier, SO, base model), require a uniform tier + seat
     height, match the group's module set against that supplier's combo, and —
     when the combo total is cheaper than the matched lines' summed base cost —
     re-spread the combo total across the matched lines (spreadComboTotal).
     Extra modules outside the matched subset keep their full per-module cost.
     Simple seat-count sofas (BLATT-2S) carry no module/orientation → never
     match → untouched. */
  type SoLine = (typeof soItems)[number];
  const baseCostByItem = new Map<SoLine, number>();
  for (const it of soItems) {
    const b = effectiveBindingFor(it);
    if (!b) continue; // guarded by the missing_bindings check above
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
            /* The spec fields, from the ONE constructor — this call used to
               hand-copy them and, like both other backend copies, left out the
               priced totalHeight pool (po-pricing.ts carries the trace). */
            ...poVariantPricingInput(category, variants),
          },
          maintBySupplier.get(b.supplier_id) ?? null,
        ).unitPriceSen
      // No category on the SO line → can't project a matrix; keep the flat price.
      : b.unit_price_sen;
    baseCostByItem.set(it, base);
  }

  // Combo redistribution → overrides baseCostByItem for matched sofa lines.
  const adjustedCostByItem = new Map<SoLine, number>();
  const sofaGroups = new Map<string, SoLine[]>();
  for (const it of soItems) {
    if ((it.itemGroup?.toUpperCase() ?? '') !== 'SOFA') continue;
    const b = effectiveBindingFor(it);
    if (!b) continue;
    const { baseModel, sizeCode } = splitSofaCode(it.itemCode);
    /* Audit 2026-06-11 I-1 parity — the dash sniff was a legacy-vocabulary
       relic that skipped every canonical parens module (`1A(LHF)`) and the
       1S/2S/3S whole-unit codes. pickComboMatch rejects non-matching sets
       itself; only skip codes with no module token at all. */
    if (!sizeCode) continue; // bare model code → nothing to match
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
    // Uniform tier + seat height across the group, else the combo can't apply.
    const tiers = new Set(members.map((m) => resolveFabricTier(m.itemGroup, m.variants)));
    if (tiers.size !== 1) continue;
    const tier = [...tiers][0];
    if (!tier) continue;
    const heights = new Set(members.map((m) => sofaHeightKey(m.variants)));
    if (heights.size !== 1) continue;
    const height = [...heights][0]!;
    if (!height) continue;
    // Scope to this base model's combos (case-insensitive — products are
    // BOOQIT-… while combos store "Booqit"). Audit 2026-06-11 I2 — NO fallback
    // to the supplier's other Models' combos (owner rule: a combo must match
    // the same base model only; module codes are a shared vocabulary, so the
    // old fallback let another Model's combo price become this set's cost).
    const rows = supplierCombos.filter((cmb) => (cmb.baseModel ?? '').toUpperCase() === baseModelU);
    if (rows.length === 0) continue; // no combo named for this Model → no combo
    const match = pickComboMatch(
      { baseModel: '', modules: members.map((m) => splitSofaCode(m.itemCode).sizeCode), customerId: null, tier, height },
      rows,
    );
    if (!match) continue;
    const matched = match.matchedIndices.map((i) => members[i]).filter((m): m is SoLine => !!m);
    if (matched.length === 0) continue;
    // The combo price IS the supplier's set deal — on the COST side it's
    // authoritative whether or not it beats the sum of the individual modules
    // (unlike HOOKKA's SELLING side, which only applies a combo when it's
    // cheaper to avoid inflating the customer price — that guard is dropped
    // here). e.g. 2A+L = 2200 → those two lines cost 2200 together; an extra
    // 1NA outside the matched subset keeps its own per-module cost (2200 + 1NA).
    const comboTotal = match.comboPriceSen;
    if (comboTotal <= 0) continue; // no price for this height → keep base cost
    /* Audit 2026-06-11 I1 — this spread works in PER-UNIT costs (the spread
       results are stored as per-unit prices and re-multiplied by qty on the
       PO line), so with a UNIFORM qty q the set books q × comboTotal — already
       the owner's "combo cost × qty" rule, no multiplier needed here. MIXED
       qtys however have no clean set count (e.g. 2A×2 + L×1 = one set + a
       spare 2A): the extra units would book at the combo-discounted share
       instead of full per-module cost → SKIP the combo (never under-book). */
    const qtySet = new Set(matched.map((m) => Math.max(1, Number(m.qty) || 1)));
    if (qtySet.size !== 1) continue;
    const baseUnits = matched.map((m) => baseCostByItem.get(m) ?? 0);
    const spread = spreadComboTotal(baseUnits, comboTotal);
    matched.forEach((m, i) => adjustedCostByItem.set(m, spread[i] ?? 0));
  }

  // Group items into PO buckets.
  // Commander 2026-05-28 — each line carries its own derived warehouse +
  // delivery date (from the source SO), so they ride through to the insert.
  // Commander 2026-05-31 (warehouse-flow bug) — the grouping key is now
  // (lineWarehouseId, effectiveSupplierId), with soDocNo appended in 'per-so'
  // mode. Folding the LINE warehouse into the key guarantees every emitted PO
  // is SINGLE-WAREHOUSE: the downstream GRN receive-into (PO header
  // purchase_location_id) then always lands stock in the correct warehouse —
  // a KL line and a PG line of the same SKU+supplier now split into two POs
  // instead of one mixed-warehouse PO. effectiveSupplierId resolves per line as
  //   pick.supplierId ?? supplierByCode[itemCode] ?? <SKU main supplier id>.
  type Line = {
    itemCode: string; itemName: string; qty: number; supplierSku: string; unitPriceSen: number;
    warehouseId: string | null; deliveryDate: string | null;
    itemGroup: string | null; variants: Record<string, unknown> | null;
    soItemId: string | null;
    photoUrls: string[];
  };
  type Bucket = {
    supplierId: string; warehouseId: string | null; currency: string;
    lines: Line[]; soDocNos: Set<string>;
  };
  const byGroup = new Map<string, Bucket>();
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
    const lead = resolveLeadDays(leadBase, leadBuffers, {
      warehouseId: lineWarehouseId,
      category: it.itemGroup,
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
    );
    const bucket = byGroup.get(groupKey)
      ?? { supplierId: effectiveSupplierId, warehouseId: lineWarehouseId, currency: b.currency, lines: [], soDocNos: new Set<string>() };

    // Cost was resolved in the pre-pass above: a combo-redistributed cost wins,
    // else the per-line base cost (matrix + surcharges), else the flat price.
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
      photoUrls: it.photoUrls,
    });
    bucket.soDocNos.add(it.soDocNo);
    byGroup.set(groupKey, bucket);
  }

  /* Commander 2026-05-30 - every picked SO line stays as its OWN PO line (1:1
     so_item_id), whether appending to an existing PO or creating fresh ones.
     We no longer merge same-SKU lines from different SOs into one PO line: a
     merged line could carry only ONE source link, which broke the release-on-
     delete recount (recomputeSoPicked) for the other source SO lines. Keeping
     lines 1:1 makes the source link authoritative, the From-SO release exact,
     and every PO line traceable back to the exact SO line it serves. */

  /* ── Commander 2026-05-29 — APPEND to an existing PO ─────────────────────
     "Convert from SO" / "Add Line Item" on a PO open this picker scoped to that
     PO. Append the picked lines (only those whose supplier matches the PO's
     supplier — the picker locks to it) instead of creating new POs. */
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
    /* Commander 2026-05-31 — the grouping key is now (warehouse, supplier), so a
       target supplier can span multiple buckets (one per line warehouse). The
       append path targets a single existing PO, so gather EVERY bucket whose
       supplier matches the target and append all their lines. Each line keeps
       its own per-line warehouse_id (the SO line's warehouse); the target PO's
       header purchase_location_id is left as-is. */
    const targetLines = [...byGroup.values()]
      .filter((bk) => bk.supplierId === target.supplier_id)
      .flatMap((bk) => bk.lines);
    if (targetLines.length === 0) {
      return c.json({ error: 'supplier_mismatch', reason: 'None of the picked SO lines belong to this PO’s supplier.' }, 409);
    }
    const rows = targetLines.map((l) => ({
      purchase_order_id: target.id,
      material_kind: 'mfg_product',
      item_code: l.itemCode,
      material_name: l.itemName,
      supplier_sku: l.supplierSku,
      qty: l.qty,
      unit_price_sen: l.unitPriceSen,
      line_total_sen: l.qty * l.unitPriceSen,
      delivery_date: l.deliveryDate,
      warehouse_id:  l.warehouseId,
      item_group: l.itemGroup,
      variants: l.variants,
      description2: buildVariantSummary(String(l.itemGroup ?? ''), l.variants ?? null) || null,
      // Release-on-delete link (migration 0098).
      so_item_id: l.soItemId,
      // Owner 2026-08-10 (migration 0274) — the source SO line's photos.
      photo_urls: l.photoUrls,
      // Commander 2026-05-31 — MRP-origin lines are reference-only (no SO lock).
      from_mrp: fromMrp,
    }));
    const { error: iErr } = await supabase.from('purchase_order_items').insert(stampCompany(rows, c));
    if (iErr) return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500);
    await recomputePoTotals(supabase, target.id);
    // Recount po_qty_picked from the live PO lines for every appended SO line
    // (drops them from the picker). Self-healing — see recomputeSoPicked.
    try { await recomputeSoPicked(supabase, targetLines.map((l) => l.soItemId)); }
    catch { /* lines already inserted — don't fail on counter recount */ }
    return c.json({ targetPoId: target.id, poNumber: target.po_number, added: targetLines.length }, 200);
  }

  // Generate PO numbers + create one PO per supplier.
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  // Seed from max(suffix), NOT count — count+1 is non-self-healing (a mid-month
  // delete re-mints a surviving number → UNIQUE collision). Derive the next
  // suffix via mintMonthlyDocNo, then counter starts one below it.
  const p = companyDocPrefix(c);
  const firstNextPo = await mintMonthlyDocNo(supabase, 'purchase_orders', 'po_number', `${p}PO-${yymm}`);
  let counter = parseInt(firstNextPo.slice(`${p}PO-${yymm}-`.length), 10) - 1;

  const created: Array<{ id: string; poNumber: string; supplierId: string; lineCount: number }> = [];
  /* A bucket that fails to insert is dropped by `continue` below and the call
     still returns 201. So "created 3 POs" has always been capable of meaning
     "asked for 4, one supplier silently got nothing" — the same silent-drop the
     23505 retry note calls out, minus the retry's protection, for every other
     error. Reported rather than fixed here: swallowing the bucket is wrong, but
     changing this call to fail the whole convert would change how the operator's
     button behaves mid-flight, and that is not this commit's decision to make.
     Additive and omitted when empty, so the normal response is byte-identical
     and no existing caller sees a new field. */
  const dropped: Array<{ supplierId: string; lineCount: number; reason: string }> = [];
  for (const bucket of byGroup.values()) {
    const supplierId = bucket.supplierId;
    counter += 1;
    const subtotal = bucket.lines.reduce((s, l) => s + l.qty * l.unitPriceSen, 0);

    /* Commander 2026-05-28 — derive the PO HEADER fields from this PO's lines:
         expected_at          = earliest non-null line delivery date, else null
       Commander 2026-05-31 (warehouse-flow bug) — purchase_location_id is now
       the bucket's OWN warehouse. Because the grouping key folds in the line
       warehouse, every line in a bucket shares it, so the header location is
       unambiguous (no most-common heuristic needed). This is what makes the
       downstream GRN receive-into land stock in the SO LINE's warehouse. */
    const lineDates = bucket.lines
      .map((l) => l.deliveryDate)
      .filter((d): d is string => Boolean(d))
      .sort();
    const headerExpectedAt = lineDates[0] ?? null;
    const headerPurchaseLocationId: string | null = bucket.warehouseId;

    const headerPayload = {
      company_id: activeCompanyId(c), // multi-company: stamp the active company
      supplier_id: supplierId,
      /* PR #131 — Convert-from-SO bulk path also lands SUBMITTED. Still the
         default; `asDraft` is opt-in (see the body doc above), so every existing
         caller is unaffected.

         A DRAFT here is what makes the Procurement Agent's propose->approve
         real. The manual create has always taken asDraft and the SO flow has
         always used it, but the bulk convert — the ONLY path that turns MRP
         shortages into POs — could not produce one, so an agent had no way to
         raise a PO for review. It had to stop at a SKU-level suggestion and let
         a human retype it, which is why approving a reorder proposal creates
         nothing today.

         A DRAFT PO is inert by design and that is exactly why it is the right
         fuse: mrp.ts's PO_DEAD excludes DRAFT from supply, so a drafted PO
         cannot make a shortage look covered; and recomputeSoPicked excludes
         DRAFT lines, so it cannot lock the SO quota either. Nothing is
         committed until a human confirms it. */
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
      notes: provenanceNote('so', [...bucket.soDocNos]), // a STORED CONTRACT, 8 readers: transfer-vocabulary.ts
      created_by: user.id,
      expected_at: headerExpectedAt, // Commander 2026-05-28 — derived from the source SO lines, not asked.
      purchase_location_id: headerPurchaseLocationId,
    };
    /* Audit (ported from 2990) — the PO suffix is an in-memory counter off a
       non-locking snapshot, so a CONCURRENT SO→PO convert can mint the same
       po_number. It is UNIQUE, so a collision previously hit `if (hErr) continue`
       and SILENTLY DROPPED the whole bucket (the convert reported fewer POs with
       no error). Retry on 23505: re-derive the next free suffix from the live
       table + bump, so the loser re-mints instead of vanishing. */
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

    const rows = bucket.lines.map((l) => ({
      purchase_order_id: header.id,
      material_kind: 'mfg_product',
      item_code: l.itemCode,
      material_name: l.itemName,
      supplier_sku: l.supplierSku,
      qty: l.qty,
      unit_price_sen: l.unitPriceSen,
      line_total_sen: l.qty * l.unitPriceSen,
      /* Commander 2026-05-28 — per-line delivery date = the source SO LINE's
         date; per-line warehouse = the SO's sales_location warehouse. Both
         may be null when the SO didn't carry them — that's allowed. */
      delivery_date: l.deliveryDate,
      warehouse_id:  l.warehouseId,
      /* Commander 2026-05-29 — carry the variant through to the PO so the line
         shows its config + the MRP can match outstanding PO supply by variant. */
      item_group: l.itemGroup,
      variants: l.variants,
      description2: buildVariantSummary(String(l.itemGroup ?? ''), l.variants ?? null) || null,
      // Release-on-delete link (migration 0098) — every from-SO line carries
      // its source SO line so recomputeSoPicked can release it on delete/cancel.
      so_item_id: l.soItemId,
      /* Owner 2026-08-10 (migration 0274) — the source SO line's photo keys.
         The array is copied, the R2 objects are not: SO line and PO line point
         at the same objects, so a photo deleted on the SO also leaves the PO.
         PER LINE, never deduplicated across the bucket — one sofa build is many
         compartment lines that legitimately share the same build photo, and each
         PO line must carry it or that compartment shows no photo at all. Lines
         stay 1:1 with their SO line (see the merge note above), so this is
         simply each line's own array. */
      photo_urls: l.photoUrls,
      // Commander 2026-05-31 — MRP-origin lines are reference-only (no SO lock).
      from_mrp: fromMrp,
    }));
    const { error: iErr } = await supabase.from('purchase_order_items').insert(stampCompany(rows, c));
    if (iErr) {
      await supabase.from('purchase_orders').delete().eq('id', header.id);
      dropped.push({ supplierId, lineCount: bucket.lines.length, reason: `po_items_insert_failed: ${iErr.message}` });
      continue;
    }
    /* This bucket's PO cleared its own rollback (the `continue` above), so it
       survives the request even if a LATER bucket is dropped — each bucket is
       its own document and its own CREATE row. */
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
      /* The HOUZS user, not `user` — `user` is the one pinned system uuid the
         SCM bridge gives every caller, and created_by here is a bigint staff
         id. Undefined on the headless MRP-agent path, which degrades to an
         unattributed row exactly as recordPoCreate does. */
      createdBy: c.get('houzsUser')?.id ?? null,
    })).problems;
    /* PER PO: this route raises several, and WHICH one is refused is the point. */
    created.push({ id: header.id, poNumber: header.po_number, supplierId, lineCount: bucket.lines.length, ...(acNotSent.length ? { acNotSent } : {}) });
  }

  // Recount po_qty_picked from the live PO lines for every SO line we picked,
  // so converted lines drop out of the From-SO picker. Self-healing — see
  // recomputeSoPicked. Best-effort: never fail the response on a recount error.
  if (body.picks && created.length > 0) {
    try { await recomputeSoPicked(supabase, pickedItems.map(({ row }) => row.id)); }
    catch { /* POs already created — don't fail on counter recount */ }
  }

  return c.json({ created, total: created.length, ...(dropped.length ? { dropped } : {}) }, 201);
}

/* HTTP route — router-level supabaseAuth already ran; the real Hono context is
   wired into the core verbatim, so the request path behaves exactly as it did
   before the factoring. The dynamic-status cast is safe: every outcome status
   is a contentful JSON status the old inline c.json calls already returned. */
mfgPurchaseOrders.post('/from-sos', async (c) => {
  const out = await convertSosToPosCore({
    req: { json: () => c.req.json() },
    get: ((key: 'supabase' | 'user' | 'houzsUser' | 'companyId' | 'allowedCompanyIds' | 'companyCode') =>
      c.get(key as 'supabase')) as unknown as PoConvertContext['get'],
    env: c.env,
    json: (b, status) => ({ status: status ?? 200, body: b as Record<string, unknown> }),
  });
  return c.json(out.body, out.status as 201);
});

/* ── createDraftPosFromPicks — headless SO→PO for an approved proposal ──────
   Runs the SAME core an operator's click runs: identical supplier resolution,
   combo redistribution, per-category split, lead-time subtraction, doc-no
   minting. Not a parallel PO writer — there is one body that knows how to raise
   a PO and this is it.

   Authorization happened before this is called: a human approved the proposal
   in the agent console, and this executes that decision. There is no request
   here, so the service-role client is the only client available — the same
   arrangement createDraftSalesOrder uses for the scan job.

   ALWAYS DRAFT. That is the fuse, and it is hard-coded rather than an option:
   the agent's output is a PO the owner still has to confirm (PATCH /:id/confirm)
   before it is real, so nothing reaches a supplier on an agent's say-so. Stage 2
   (auto-approve) and Stage 3 (auto-send to the supplier) are separate decisions
   and are NOT enabled by this function existing.

   fromMrp: true matches these picks' provenance — they are MRP shortage lines,
   and the MRP page's own convert button sends exactly this (Mrp.tsx:544). Same
   input, same flags, so the agent's PO and a human's MRP convert are the same
   act. `mode` is left at the route default: the three ruled categories are split
   by rule regardless (po-grouping.ts), and 'combined' is what the operator's
   picker defaults to for everything else. */
export async function createDraftPosFromPicks(
  env: Env,
  opts: {
    /** scm.staff UUID — the SCM auth-bridge identity, stamped as created_by.
     *  NOT the public users bigint (see the SCM staff-UUID trap). */
    userId: string;
    /** The company the proposal was raised under. Undefined → unresolved, and
     *  the stamping no-ops exactly as it does pre-migration. */
    companyId: number | null;
    allowedCompanyIds?: number[] | null;
    /** MUST be the company CODE string, never the company row. companyDocPrefix
     *  stringifies whatever it is handed: the scan job's rebuilt context passed
     *  an object through this exact key and minted "[object Object]-SO-2607-001"
     *  into production. Typed narrowly here, and re-checked below, because the
     *  cost of getting it wrong is permanent — it lands in a document number. */
    companyCode?: string | null;
    picks: Array<{ soItemId: string; qty: number }>;
  },
): Promise<PoConvertOutcome> {
  const svc = getSupabaseService(env);
  /* EXPLICIT per key, with no default fall-through. A fall-through is how the
     scar above happened: an unhandled key returned the wrong object and nothing
     said so. An unknown key here returns undefined, which every consumer already
     treats as "unresolved" and degrades on. */
  const syntheticGet = (key: string): unknown => {
    if (key === 'supabase') return svc;
    if (key === 'user') return { id: opts.userId };
    /* No session here — the agent is not a person. The audit row degrades to an
       unattributed one (WHEN + WHAT, no WHO), which is the writer's documented
       behaviour; the CREATE note names the agent so the row is not anonymous in
       substance. Do NOT substitute the pinned `user` shim to fill this in. */
    if (key === 'houzsUser') return undefined;
    if (key === 'companyId') return opts.companyId ?? undefined;
    if (key === 'allowedCompanyIds') return opts.allowedCompanyIds ?? undefined;
    if (key === 'companyCode') return typeof opts.companyCode === 'string' ? opts.companyCode : undefined;
    return undefined;
  };
  return convertSosToPosCore({
    req: { json: async () => ({ picks: opts.picks, asDraft: true, fromMrp: true }) },
    get: syntheticGet as unknown as PoConvertContext['get'],
    env,
    json: (b, status) => ({ status: status ?? 200, body: b as Record<string, unknown> }),
  });
}

/* ── PR #41 — PATCH header (po_date, expected_at, currency, notes) ── */
mfgPurchaseOrders.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  /* Read BEFORE writing — this row is the from-value of every pair recorded
     below. PO_AUDIT_FIELDS is the same column list the loop writes (PR #77 =
     purchase_location_id, migration 0180 = the supplier-revised dates), kept in
     one place so a field added to the PATCH cannot silently escape the log. */
  const { data: beforeRow } = await scopeToCompanyId(sb.from('purchase_orders')
    .select(PO_AUDIT_SELECT).eq('id', id), co.companyId).maybeSingle();
  if (!beforeRow) return c.json(NOT_THIS_COMPANY, 404);
  const before = (beforeRow ?? {}) as unknown as Record<string, unknown>;

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [from, to] of PO_AUDIT_FIELDS) {
    if (body[from] !== undefined) updates[to] = body[from];
  }

  /* Tier-2 lock — FIELD-LEVEL (owner 2026-08-20, §8 GAP-1; po-identity-lock.ts):
     only GRN-inherited columns freeze once a GRN exists; dates + notes stay
     editable. Downstream read paid only when an inherited column changes. */
  const lockedChanges = changedPoIdentityLockCols(updates, before);
  if (lockedChanges.length > 0 && (await poHasDownstream(sb, id))) {
    return c.json(poIdentityLockedRefusal(lockedChanges), 409);
  }
  /* A cleared Supplier Date 2/3/4 posts "", which Postgres rejects on a date
     column, so every PO that left one blank failed to save (production,
     2026-08-17). It mutates `updates`, so the audit below records the NULL. */
  const { data, error } = await scopeToCompanyId(sb.from('purchase_orders').update(coerceEmptyDates(updates)).eq('id', id), co.companyId).select('*').single();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);

  {
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

  /* Migration 0180 — fan a header revised date down to its lines, mirroring the
     way the create/new flow cascades expected_at → each line's delivery_date.
     A line's OWN override must survive, so we only stamp lines whose matching
     per-line column is still NULL. Best-effort: never fail the header save on
     this. Only runs for the header dates the caller actually sent (non-null). */
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
  await queueAcPoEdit(c, id);

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
const SUPPLIER_DATE_SLOT_COL = {
  2: 'supplier_delivery_date_2',
  3: 'supplier_delivery_date_3',
  4: 'supplier_delivery_date_4',
} as const;
type SupplierDateSlot = keyof typeof SUPPLIER_DATE_SLOT_COL;

/* Cap the batch. The handler walks POs sequentially (each needs its own lock
   check + audit row), so an unbounded list is a request that never returns. */
const BULK_SUPPLIER_DATE_MAX = 100;

/* Request validation, split out so it can be tested without a Hono context or
   a database. Rejects with the exact {status, payload} the handler returns. */
export type BulkSupplierDateRequest = {
  slot: SupplierDateSlot;
  col: (typeof SUPPLIER_DATE_SLOT_COL)[SupplierDateSlot];
  date: string;
  poIds: string[];
  applyToLines: boolean;
};

export function parseBulkSupplierDateBody(
  body: Record<string, unknown>,
): { ok: true; req: BulkSupplierDateRequest }
  | { ok: false; status: 400; payload: { error: string; reason: string } } {
  const slot = Number(body.slot) as SupplierDateSlot;
  if (!(slot in SUPPLIER_DATE_SLOT_COL)) {
    return { ok: false, status: 400, payload: { error: 'invalid_slot', reason: 'slot must be 2, 3 or 4.' } };
  }

  /* Both halves matter: the shape check rejects "2026-8-3" / free text, and the
     parse check rejects a well-shaped impossible day like 2026-02-31. */
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
      col: SUPPLIER_DATE_SLOT_COL[slot],
      date,
      poIds,
      // Default ON: the operator picked POs to move the date on, and leaving
      // the lines behind is what made this tedious in the first place.
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
  const { slot, col, date, poIds, applyToLines } = parsed.req;

  const updated: Array<{ id: string; poNumber: string | null }> = [];
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

    const { error } = await scopeToCompanyId(
      sb.from('purchase_orders').update({ [col]: date, updated_at: new Date().toISOString() }).eq('id', id),
      co.companyId,
    );
    if (error) { skipped.push({ id, poNumber, reason: error.message }); continue; }

    if (applyToLines) {
      // Unconditional on purpose — see the header note above.
      const { error: lineErr } = await scopeToCompanyId(
        sb.from('purchase_order_items').update({ [col]: date }).eq('purchase_order_id', id),
        co.companyId,
      );
      /* The header already moved, so a line failure is reported rather than
         swallowed: the operator has to know this PO is half-applied. */
      if (lineErr) { skipped.push({ id, poNumber, reason: `Header updated but lines failed: ${lineErr.message}` }); continue; }
    }

    await recordEntityAudit(sb, {
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      entityDocNo: poNumber,
      action: 'UPDATE',
      actor: c.get('houzsUser'),
      companyId: (before.company_id as number | null) ?? activeCompanyId(c),
      statusSnapshot: (before.status as string | null) ?? null,
      fieldChanges: diffFields(before, { [`supplierDeliveryDate${slot}`]: date }, PO_AUDIT_FIELDS),
    });
    /* ERP -> AutoCount edit, ONE PER PO THAT ACTUALLY MOVED — inside the loop
       and after `continue`s, so a PO that was skipped (not found, downstream-
       locked, or a failed write) queues nothing. A bulk route that queued one
       edit for the whole batch would be wrong in both directions: it would send
       POs that did not change and would name only one of the ones that did.

       This matters because `applyToLines` cascades the date down to every line
       (purchase_order_items.delivery_date), and DeliveryDate is a real AutoCount
       detail field — so the account book's own promised dates were left behind
       by every bulk date change the ERP has ever made. */
    await queueAcPoEdit(c, id);
    updated.push({ id, poNumber });
  }

  return c.json({ slot, date, applyToLines, updated, skipped });
});

/* ── PR #41 — PO line items: add / edit / delete ───────────────────────
   Fails CLOSED and never throws (2026-07-17) — same contract as the SO's
   recomputeTotals (mfg-sales-orders.ts), which carries the full rationale.
   See BUG-HISTORY 2026-07-17 (fix/zeroing-twins). */
async function recomputePoTotals(sb: any, poId: string) {
  const { data: items, error: itemsErr } = await sb.from('purchase_order_items')
    .select('line_total_sen')
    .eq('purchase_order_id', poId);
  /* A failed READ is not an empty PO, and `?? []` cannot tell them apart — it
     folded a transient blip into subtotal_sen / total_sen ZERO on an order
     whose lines were intact, i.e. a PO the supplier is owed for silently claimed
     to be worth nothing. The ERROR is the signal, never the emptiness: a
     genuinely empty PO resolves error === null with data === [] and MUST still
     fall through to zero the header. */
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

/* Keep header expected_at in sync with the lines: earliest non-null line
   delivery_date, else null. Mirrors the PO-create rule so a per-line Delivery
   Date edit shows on the PO list + PDF (both read the header expected_at).
   Best-effort: never fail the line write on this. (Commander 2026-06-18 #2/#3) */
async function recomputePoExpectedAt(sb: any, poId: string) {
  try {
    const { data: lines } = await sb.from('purchase_order_items')
      .select('delivery_date')
      .eq('purchase_order_id', poId);
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

/* ── Commander 2026-05-30 — self-healing SO "picked" counter ──────────────
   Replaces the old scattered "+qty on create / -qty on delete" arithmetic on
   mfg_sales_order_items.po_qty_picked. For each given SO line, recount how many
   units LIVE (non-cancelled) PO lines claim from it via so_item_id, and write
   that exact sum back. Because it recounts from the actual PO lines every time:
     • delete / cancel a PO ⇒ those lines drop out of the count ⇒ the SO line
       reappears in the From-SO picker automatically (qty - picked > 0 again);
     • the counter can never get permanently stuck the way a forgotten -= could
       — any later mutation that touches the SO line self-corrects it.
   MRP keeps reading po_qty_picked, now always accurate. Two plain queries (no
   PostgREST embedding) so behaviour is predictable in production. Best-effort:
   callers wrap in try/catch and never fail the PO mutation on a recount error. */
async function recomputeSoPicked(sb: any, soItemIds: Array<string | null | undefined>) {
  const ids = [...new Set(soItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return;
  // Best-effort, never throws (Commander 2026-05-30): the primary write already
  // committed. If this secondary recount hiccups we log + skip — the live-count
  // model self-heals on the next operation that touches these SO lines.
  try {
    const { data: lines } = await sb
      .from('purchase_order_items')
      .select('so_item_id, qty, purchase_order_id, from_mrp')
      .in('so_item_id', ids);
    /* Commander 2026-05-31 — MRP-origin PO lines are reference-only: they do NOT
       lock the source SO line via po_qty_picked, so the recount excludes them.
       The Commander's "an MRP-ordered SO must drop off the Convert-from-SO
       picker" is instead handled by POOLED SUPPLY: the picker now hides any line
       whose pooled stock+open-PO coverage leaves no shortage (computeMrp), and
       the from_mrp PO is part of that supply pool — so a converted line drops
       off because it's covered, and re-appears if stock is later consumed. Using
       po_qty_picked for that would break the pure-pool model (a PO raised for a
       late SO can cover an earlier one). */
    const rows = ((lines ?? []) as Array<{ so_item_id: string; qty: number; purchase_order_id: string; from_mrp: boolean | null }>)
      .filter((r) => r.from_mrp !== true);
    const poIds = [...new Set(rows.map((r) => r.purchase_order_id).filter(Boolean))];
    /* Leak guard (Draft/Confirmed) — a DRAFT PO is reference-only: it must NOT
       lock the source SO line's po_qty_picked (else a draft would drop the SO
       from the From-SO picker before it commits). Exclude DRAFT alongside
       CANCELLED from the picked recount; the line re-counts once the PO
       confirms (DRAFT -> SUBMITTED). */
    const deadPo = new Set<string>();
    if (poIds.length > 0) {
      const { data: pos } = await sb.from('purchase_orders').select('id, status').in('id', poIds);
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
  /* The PO line's spec signature (specSignature of its item_group+variants).
     When provided, the SO line must match it, not just the item code. Null =
     spec gate skipped (the code check still applies). */
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

/* ── SO-link remaining-qty cap (LINE level) ─────────────────────────────────
   soLinkTargetRefusal above proves a bind is POINTED at a legitimate SO line;
   it says nothing about HOW MUCH that line may order. The batch paths all cap
   it — /from-sos via `!fromMrp && p.qty > remaining`, the generic create via
   findOverConvertOffender, /:id/convert-from-so by deriving qty server-side as
   the unpicked remainder — but add-line and line-edit did not, so an operator
   could append (or edit up to) any qty against an SO line that was already
   fully converted. That is the same double-ordering the F1 audit closed on
   /:id/convert-from-so in 2026-06-10, reachable through the two paths that
   accept an operator-supplied qty.

   Repeat conversion stays legal — the business splits one SO across several POs
   on purpose. The ceiling is what is capped, never the second conversion.

   Overridable with confirmOverConvert, the SAME escape hatch the generic create
   documents, so a deliberate over-order is still one explicit flag away. */
export async function soLineOverConvertRefusal(
  sb: any,
  soItemId: string | null,
  requestedQty: number,
  ownCurrentQty: number,
): Promise<OverConvertOffender | null> {
  if (!soItemId) return null;
  const { data } = await sb
    .from('mfg_sales_order_items')
    .select('id, qty, po_qty_picked')
    .eq('id', soItemId)
    .maybeSingle();
  const row = data as { qty: number; po_qty_picked: number } | null;
  /* Unknown / cross-company line: soLinkTargetRefusal already refused it with a
     404 before we get here, so there is nothing left to cap. */
  if (!row) return null;
  const remaining = soLineHeadroom(row, ownCurrentQty);
  const requested = Math.max(0, Number(requestedQty ?? 0));
  return requested > remaining ? { soItemId, requested, remaining } : null;
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
  /* The new line is stamped with the active company; the PO it hangs off must
     be this company's too, or a line lands on another company's PO. */
  const { data: parentPo } = await scopeToCompanyId(sb.from('purchase_orders').select('id').eq('id', poId), co.companyId).maybeSingle();
  if (!parentPo) return c.json(NOT_THIS_COMPANY, 404);
  /* Tier 2 downstream-lock — line-add is blocked once a GRN exists. */
  const childLock = await poHasDownstream(sb, poId);
  if (childLock) return c.json(childLock, 409);

  const addGroupOf = await skuCategoryResolver(sb, [it], co.companyId ?? null); // SKU wins — lib/sku-category.ts
  /* Non-finite guard — the clamp below cannot catch NaN (Math.max(0, NaN) is
     NaN), so a junk qty/price reached line_total_sen and the PO total. */
  const parsedLine = parseLineNumbers({
    qty: { value: it.qty, fallback: 1 },
    unitPriceSen: { value: it.unitPriceSen },
    discountSen: { value: it.discountSen },
  });
  if (!parsedLine.ok) return c.json(invalidLineNumberBody(parsedLine.invalid), 400);
  const { qty, unitPriceSen, discountSen } = parsedLine.nums as {
    qty: number; unitPriceSen: number; discountSen: number;
  };
  // Audit (ported from 2990 21163bde) — clamp like the create path (mfg-purchase-orders POST /):
  // a per-line discount exceeding qty×price must not persist a negative
  // line_total_sen (it sums straight into the PO subtotal/total).
  const lineTotal = Math.max(0, (qty * unitPriceSen) - discountSen);

  /* Audit fix — Add-item dropped the source SO link. Without so_item_id the
     line never counts toward the SO's po_qty_picked, so the From-SO picker
     keeps offering an already-covered line. Dual-read camelCase??snake_case. */
  const soItemId = (((it.soItemId ?? it.so_item_id) as string | null | undefined) || null);
  {
    const refusal = await soLinkTargetRefusal(sb, c, soItemId, String(it.itemCode ?? ''));
    if (refusal) return c.json(refusal.body, refusal.status);
  }
  /* Remaining-qty cap — a NEW line contributes nothing to po_qty_picked yet, so
     its own headroom is the raw remainder (ownCurrentQty = 0). */
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
    /* PR #41 — variant fields */
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
    // PR #77 — per-line ship-to. Both nullable; empty = inherit from header.
    delivery_date: dateOrNull(it.deliveryDate),
    // Migration 0180 — per-line supplier-revised dates (nullable, default NULL).
    supplier_delivery_date_2: dateOrNull(it.supplierDeliveryDate2),
    supplier_delivery_date_3: dateOrNull(it.supplierDeliveryDate3),
    supplier_delivery_date_4: dateOrNull(it.supplierDeliveryDate4),
    warehouse_id: (it.warehouseId as string) ?? null,
  };
  const { data, error } = await sb.from('purchase_order_items').insert({ ...row, company_id: activeCompanyId(c) }).select('*').single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  await recomputePoTotals(sb, poId);
  await recomputePoExpectedAt(sb, poId);
  /* A newly-bound line consumes SO quota, so the source line must drop out of
     the From-SO picker — the same recount the line-edit and delete paths run.
     Best-effort: the line is already stored, never fail the add on a counter. */
  if (soItemId) {
    try { await recomputeSoPicked(sb, [soItemId]); }
    catch { /* don't fail the add on a counter recount */ }
  }

  /* UPDATE, not CREATE: the entity is the PURCHASE ORDER and it already existed.
     The line's identity travels in the note and as the to-value of every pair. */
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

  /* Tier 2 downstream-lock — line-edit is blocked once a GRN exists. */
  const childLock = await poHasDownstream(sb, poId);
  if (childLock) return c.json(childLock, 409);

  /* The audited columns as well as the ones the money logic reads: this row is
     also the BEFORE half of every from->to pair recorded after the update lands.
     `variants` and `so_item_id` are business-logic only and deliberately not in
     PO_LINE_AUDIT_FIELDS — variants render into description2, which is
     server-owned and derived, not an operator edit. */
  const { data: prevRow } = await scopeToCompanyId(sb.from('purchase_order_items')
    .select(PO_LINE_AUDIT_SELECT + ', variants, so_item_id')
    .eq('id', itemId), co.companyId).maybeSingle();
  if (!prevRow) return c.json(NOT_THIS_COMPANY, 404);
  /* Cast through `unknown`: a .select() built from a concatenated string infers
     as GenericStringError on the SupabaseClient<any> the scm client is, so the
     row shape only exists after this. Project-wide pattern in these routes. */
  const prev = prevRow as unknown as Record<string, unknown>;

  /* Non-finite guard — see POST /:id/items. `undefined` means "not supplied on
     this partial PATCH" and keeps the stored value; a supplied NaN is rejected. */
  /* `!== undefined`, NOT `??` — the two differ on an explicit null, and the
     contract here is that an absent key keeps the stored value. Preserved
     exactly; this guard is about NaN, not semantics. */
  const parsedEdit = parseLineNumbers({
    qty: { value: it.qty !== undefined ? it.qty : prev.qty },
    unitPriceSen: { value: it.unitPriceSen !== undefined ? it.unitPriceSen : prev.unit_price_sen },
    discountSen: { value: it.discountSen !== undefined ? it.discountSen : prev.discount_sen },
  });
  if (!parsedEdit.ok) return c.json(invalidLineNumberBody(parsedEdit.invalid), 400);
  const { qty, unitPriceSen: unit, discountSen: discount } = parsedEdit.nums as {
    qty: number; unitPriceSen: number; discountSen: number;
  };
  // Audit (ported from 2990 21163bde) — clamp like the create path (see POST /:id/items).
  const lineTotal = Math.max(0, (qty * unit) - discount);

  /* mig 0235 — a qty SHRINK below the line's allocated sum would break
     SUM(allocations) <= qty. The DB trigger (fn_po_item_qty_guard) is the
     backstop; this pre-check turns it into a 409 the operator can act on.
     Best-effort read: pre-0235 the table is absent — skip, nothing to guard. */
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
    } catch { /* table absent pre-0235 — nothing to guard */ }
  }

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
    // PR #77 — per-line delivery + ship-to overrides
    ['deliveryDate', 'delivery_date'], ['warehouseId', 'warehouse_id'],
    // Migration 0180 — per-line supplier-revised delivery dates.
    ['supplierDeliveryDate2', 'supplier_delivery_date_2'], ['supplierDeliveryDate3', 'supplier_delivery_date_3'],
    ['supplierDeliveryDate4', 'supplier_delivery_date_4'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  /* Commander 2026-05-28 — Description 2 is server-owned: recompute from the
     effective itemGroup + variants (incoming patch, else stored row). */
  {
    const effGroup = (it.itemGroup ?? (prev as { item_group?: string }).item_group) as string | null | undefined;
    const effVariants = (it.variants ?? (prev as { variants?: unknown }).variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  /* Bind / unbind the source SO line (2026-07-31). Add-item has accepted
     soItemId since the earlier audit fix, but a line already saved had NO way
     back: 67 of 101 live PO lines carry no link, and without one the drop-ship
     offer never appears and the shipment cannot bind its incoming PO. Explicit
     null / '' UNBINDS (a genuine stock-replenishment PO must stay valid); an
     ABSENT key keeps the stored link, the same partial-PATCH contract as every
     other field above. */
  const prevSoItemId = ((prev as { so_item_id?: string | null }).so_item_id) ?? null;
  let nextSoItemId = prevSoItemId;
  const soItemKeySent = it.soItemId !== undefined || it.so_item_id !== undefined;
  if (soItemKeySent) {
    nextSoItemId = (((it.soItemId ?? it.so_item_id) as string | null | undefined) || null);
    const effCode = String((it.itemCode ?? (prev as { item_code?: string }).item_code) ?? '');
    const refusal = await soLinkTargetRefusal(sb, c, nextSoItemId, effCode);
    if (refusal) return c.json(refusal.body, refusal.status);
    updates['so_item_id'] = nextSoItemId;
  }

  /* Remaining-qty cap — runs even when the bind key is ABSENT, because raising
     qty on an ALREADY-bound line over-orders just as surely as binding a new
     one. This line's own stored qty is credited back only while it stays on the
     SAME SO line (that qty already sits inside po_qty_picked, so without the
     credit a no-op edit would refuse itself); a REBIND onto a different SO line
     gets no credit, since the new target's counter holds none of it yet. */
  if (it.confirmOverConvert !== true) {
    const ownCurrentQty = nextSoItemId && nextSoItemId === prevSoItemId
      ? Number(prev.qty ?? 0)
      : 0;
    const over = await soLineOverConvertRefusal(sb, nextSoItemId, qty, ownCurrentQty);
    if (over) return c.json({ error: 'qty_exceeds_remaining', ...over }, 409);
  }

  const { error } = await scopeToCompanyId(sb.from('purchase_order_items').update(coerceEmptyDates(updates)).eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);

  /* Diff `updates` — the EFFECTIVE values written — against the stored row. qty,
     price, discount and the line total are recomputed above from the body OR the
     prior row, so the body alone would not say what was actually stored. */
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
  /* Recount po_qty_picked on the source SO line. If this edit reduced qty, the
     SO line releases that quota back to the From-SO picker (qty - picked > 0
     again); if it raised qty, picked rises. Self-healing — see recomputeSoPicked.
     Best-effort: never fail the edit on a recount error. */
  /* BOTH sides when the link itself moved: the line the PO stopped serving has
     to release its quota back to the picker, and the one it now serves has to
     claim it. Same recount, two ids. */
  const touchedSoItems = [...new Set([prevSoItemId, nextSoItemId].filter((x): x is string => !!x))];
  if (touchedSoItems.length > 0) {
    try { await recomputeSoPicked(sb, touchedSoItems); }
    catch { /* don't fail the edit on a counter recount */ }
  }

  await queueAcPoEdit(c, poId);

  return c.json({ ok: true });
});

mfgPurchaseOrders.delete('/:id/items/:itemId', async (c) => {
  const poId = c.req.param('id'); const itemId = c.req.param('itemId');
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  /* Tier 2 downstream-lock — line-delete is blocked once a GRN exists. */
  const childLock = await poHasDownstream(sb, poId);
  if (childLock) return c.json(childLock, 409);

  /* Commander 2026-05-29 (BUG 1) — before deleting, read the source SO line
     (migration 0098) + this line's qty so we can hand the quota back. */
  /* The audited columns too — after the delete the audit row is the only
     remaining evidence of what was ordered on this line, and there is nothing
     left to join back to. */
  const { data: doomedRow } = await scopeToCompanyId(sb.from('purchase_order_items')
    .select(PO_LINE_AUDIT_SELECT + ', so_item_id')
    .eq('id', itemId), co.companyId)
    .maybeSingle();
  if (!doomedRow) return c.json(NOT_THIS_COMPANY, 404);
  /* Cast through `unknown` — see the note on the line PATCH's `prev`. */
  const doomed = (doomedRow ?? null) as unknown as Record<string, unknown> | null;

  /* The AutoCount key of the line this save REMOVES. Read BEFORE the delete:
     afterwards the row is gone and its DtlKey with it, and an edit that does not
     NAME the removal leaves the line live and outstanding in the account book. */
  const retire = await retiredLineOf(sb, 'purchase_order_items', itemId);

  const { error } = await scopeToCompanyId(sb.from('purchase_order_items').delete().eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);

  /* UPDATE, not DELETE: the entity is the PURCHASE ORDER and it still exists.
     DELETE on this entity type is reserved for the hard delete of the document
     itself (DELETE /:id), whose subject no longer exists afterwards. */
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

  /* Recount po_qty_picked from the live PO lines so this SO line reappears in
     the From-SO picker (qty - picked > 0 again). The deleted line is already
     gone, so the recount naturally excludes it. Self-healing — see
     recomputeSoPicked. Best-effort: never fail the delete on a recount error. */
  const releasedSoItem = (doomed as { so_item_id?: string | null } | null)?.so_item_id ?? null;
  if (releasedSoItem) {
    try { await recomputeSoPicked(sb, [releasedSoItem]); }
    catch { /* line already deleted — don't fail on counter recount */ }
  }

  await queueAcPoEdit(c, poId, retire);

  return c.body(null, 204);
});

/* ── Per-line SO allocations (mig 0235) — the consolidated-PO split ──────────
   One PO line can serve SEVERAL customers plus stock (2990-PO-2606-023's qty-5
   MAKOTO line = SO-036 x1 + SO-029 x1 + 3 stock); so_item_id is single-valued
   and has NO correct value for such a line. Allocations split the line into
   1-based sub-numbered slices (PO-2606-001-01, -02, ...): each slice is a qty
   plus either an SO line (soItemId) or STOCK (null).

   Semantics: when a line HAS allocations they are the authoritative
   finer-grained answer — po-so-coverage layer (b) reads them INSTEAD of the
   line's so_item_id (never both, so never a double count). A line without
   allocations keeps the 1:1 so_item_id fast path untouched.

   Deliberately NOT behind poHasDownstream: allocations are attribution
   metadata (no stock, no money, no po_qty_picked — recomputeSoPicked never
   reads this table), and the contended historical lines the owner wants to
   split by hand live on RECEIVED POs. CANCELLED POs are refused — there is
   nothing real to attribute on a voided purchase.

   Validation: qty is a positive integer; SUM(slice qty) per line never
   exceeds the line qty (friendly 409 here; DB trigger fn_po_item_alloc_guard
   is the concurrency backstop); an SO target passes the SAME
   soLinkTargetRefusal gate as the line-level bind (company-owned, not
   cancelled, item_code matches). seq is auto-assigned dense 1..n; deletes
   resequence. Writes need `edit` on scm.procurement.po (the router mount's
   area guard), exactly like every other PO write here. */

/* Shared parent resolution + company scope for the three allocation writes.
   Returns the line row (id, qty, item_code) + PO meta, or the refusal. */
async function resolveAllocationParent(
  sb: any,
  c: any,
  poId: string,
  itemId: string,
): Promise<
  /* companyId travels back with the parent so the allocation writers can put the
     predicate on their OWN statement rather than trusting this lookup to have
     covered them — the client is service-role, so nothing re-checks between the
     two round trips. */
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

/* The line's current allocations, seq-ordered — the base every write plans on. */
async function currentAllocations(sb: any, itemId: string): Promise<AllocationRow[]> {
  const { data } = await sb.from('purchase_order_item_allocations')
    .select('id, seq, qty, so_item_id')
    .eq('purchase_order_item_id', itemId)
    .order('seq', { ascending: true });
  return (data ?? []) as AllocationRow[];
}

/* One audit row per allocation mutation — same UPDATE-on-the-PO vocabulary as
   the line CRUD (the entity is the PURCHASE ORDER; the slice's identity travels
   in the note). Best-effort like every audit write here. */
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

// GET — the line's allocations (view level via the router's area guard).
mfgPurchaseOrders.get('/:id/items/:itemId/allocations', async (c) => {
  const poId = c.req.param('id'); const itemId = c.req.param('itemId');
  const sb = c.get('supabase');
  const parent = await resolveAllocationParent(sb, c, poId, itemId);
  if (!parent.ok) return c.json(parent.body, parent.status);
  const map = await loadAllocationsForItems(sb, [itemId]);
  return c.json({ allocations: map.get(itemId) ?? [], lineQty: parent.item.qty, poNumber: parent.poNumber });
});

// POST — add one slice: { qty, soItemId | null } (null / absent = STOCK).
mfgPurchaseOrders.post('/:id/items/:itemId/allocations', async (c) => {
  const poId = c.req.param('id'); const itemId = c.req.param('itemId');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const user = c.get('user');
  const parent = await resolveAllocationParent(sb, c, poId, itemId);
  if (!parent.ok) return c.json(parent.body, parent.status);

  const soItemId = (((body.soItemId ?? body.so_item_id) as string | null | undefined) || null);
  if (soItemId) {
    const poSpec = specSignature(parent.item.item_group, parent.item.variants);
    const refusal = await soLinkTargetRefusal(sb, c, soItemId, parent.item.item_code, poSpec);
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
    /* 23505 = a concurrent writer took this seq; P0001 = the DB cap guard
       out-raced the app check. Both are "someone else moved first" — the
       client refetches and retries with fresh numbers. */
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

// PATCH — edit one slice: { qty?, soItemId? } (explicit null soItemId -> STOCK;
// absent key keeps the stored value — the same partial-PATCH contract as the
// line edit above).
mfgPurchaseOrders.patch('/:id/items/:itemId/allocations/:allocationId', async (c) => {
  const poId = c.req.param('id'); const itemId = c.req.param('itemId'); const allocationId = c.req.param('allocationId');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const parent = await resolveAllocationParent(sb, c, poId, itemId);
  if (!parent.ok) return c.json(parent.body, parent.status);

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
      const refusal = await soLinkTargetRefusal(sb, c, nextSoItemId, parent.item.item_code, poSpec);
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

// DELETE — remove one slice, then close the seq gap (dense 1..n stays true).
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

  /* Close the gap: survivors move DOWN in ascending order, so each UPDATE
     lands in a seq the delete (or the previous move) just freed and the
     UNIQUE (item, seq) constraint can never collide mid-resequence. */
  for (const move of resequenceAfterDelete(existing, allocationId)) {
    const { error: seqErr } = await scopeToCompanyId(sb.from('purchase_order_item_allocations')
      .update({ seq: move.seq }).eq('id', move.id).eq('purchase_order_item_id', itemId), parent.companyId);
    if (seqErr) break; // leave a gap rather than fail the delete — display-only cosmetics
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
    // Signed thumb sibling. A photo uploaded before thumbnails existed has no
    // `.thumb` object — the URL 404s and the client falls back to signedUrl.
    const { signedUrl: thumbUrl } = await signSoItemPhotoUrl(bindings, thumbKeyFor(photoKey));
    const payload: PhotoUrlPayload = { mode: 'signed', signedUrl, thumbUrl, expiresAt };
    return c.json(payload);
  } catch (e) {
    /* 2026-08-10: R2 S3 creds unset in prod => signing throws for every photo.
       Fall back to the proxy route below (R2 binding, no creds needed) rather
       than 500. See scm/lib/photoProxyFallback.ts for why this is not returned
       as `signedUrl`. */
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

/* ── PO photo PROXY — the credential-free read path ────────────────────────
   Added 2026-08-10 alongside the signing outage. The SO and consignment
   surfaces already had a proxy; the PO side had ONLY /signed, so when signing
   broke there was nothing to fall back to.

   Streams the object from the R2 BINDING (c.env.SO_ITEM_PHOTOS), which needs no
   S3 credential. PO photos live in the same bucket as SO photos — both the
   convert-carried `so-items/...` keys and the AutoCount importer's
   `po-items/...` keys — so one binding serves both.

   AUTHZ is a copy of the /signed route's, deliberately including
   scopeToCompany. The SO proxy does NOT company-scope (its /signed twin does
   not either), but the PO /signed route DOES, so omitting it here would make
   this proxy strictly MORE permissive than the route it backs up — a
   cross-company read leak. Membership, never key shape: the key must be listed
   in THIS line's photo_urls and the line must belong to THIS PO. A `.thumb`
   sibling is authorised against its BASE key, because thumbs are never
   themselves listed in photo_urls.

   NOTE: this sits behind the global auth gate, so it is NOT usable as a bare
   <img src> — see scm/lib/photoProxyFallback.ts. */
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
      // Keys are immutable per object (uuid / ac-<DtlKey>-<n>), so a replaced
      // photo is a different key. `private` — PO photos are not public.
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
  try { body = (await c.req.json().catch(() => ({}))) as typeof body; } catch { /* allow empty */ }
  const soDocNo = (body.soDocNo ?? '').trim();
  if (!soDocNo) return c.json({ error: 'so_doc_no_required' }, 400);
  const filterIds = Array.isArray(body.itemIds) && body.itemIds.length > 0
    ? new Set(body.itemIds)
    : null;

  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  // Verify the target PO exists + is editable — and belongs to the active
  // company, so lines can't be appended onto another company's PO.
  const { data: po, error: poErr } = await scopeToCompanyId(sb
    .from('purchase_orders')
    .select('id, status, supplier_id')
    .eq('id', poId), co.companyId)
    .maybeSingle();
  if (poErr) return c.json({ error: 'load_failed', reason: poErr.message }, 500);
  if (!po) return c.json(NOT_THIS_COMPANY, 404);
  // PR-DRAFT-removal — DRAFT no longer exists. SUBMITTED + PARTIALLY_RECEIVED
  // are both editable for convert-from-so (commander can keep adding lines
  // until the PO is fully received or cancelled).
  if (po.status !== 'SUBMITTED' && po.status !== 'PARTIALLY_RECEIVED') {
    return c.json({ error: 'po_not_editable', reason: `Cannot convert into a ${po.status} PO.` }, 409);
  }

  // Read SO items (non-cancelled only). po_qty_picked rides along so this
  // path converts only the UNPICKED remainder (F1 audit fix 2026-06-10 —
  // it used to re-copy full qty on every call → double-ordering).
  const { data: soItems, error: soErr } = await scopeToCompany(sb
    .from('mfg_sales_order_items')
    .select('id, item_code, description, description2, item_group, qty, po_qty_picked, unit_price_sen, discount_sen, unit_cost_sen, variants, uom, remark, photo_urls')
    .eq('doc_no', soDocNo)
    .eq('cancelled', false), c);
  if (soErr) return c.json({ error: 'so_load_failed', reason: soErr.message }, 500);
  if (!soItems || soItems.length === 0) {
    /* THE MODEL for every conversion in this repo: closed by CONSTRUCTION, not by
       a refusal. The destination PO loads through scopeToCompanyId and the source
       SO items through scopeToCompany, so another company's SO yields zero rows
       and lands here — there is no unscoped read for a cross-company source to
       arrive through.

       THE TRADE-OFF, since it is the one thing this shape is worse at: a refusal
       could answer "that document belongs to 2990, switch company", and this
       answers "has no items". Accepted deliberately — naming the other company
       would need an UNSCOPED read of a document this handler never touches, and
       widening the read surface to improve a message is the wrong trade on a
       conversion path. Every converted sibling records the same trade. */
    return c.json({ error: 'so_has_no_items', reason: `Sales Order ${soDocNo} has no items to convert.` }, 404);
  }

  const wanted = filterIds
    ? (soItems as Array<{ id: string }>).filter((r) => filterIds!.has(r.id))
    : soItems;

  if (wanted.length === 0) {
    return c.json({ error: 'no_items_selected', reason: 'None of the picked SO items matched.' }, 400);
  }

  // Find which item_codes already exist on the PO so we don't double-insert.
  const codes = (wanted as Array<{ item_code: string }>).map((r) => r.item_code);
  const { data: existing } = await sb
    .from('purchase_order_items')
    .select('item_code')
    .eq('purchase_order_id', poId)
    .in('item_code', codes);
  const existingSet = new Set((existing ?? []).map((r: { item_code: string }) => r.item_code));

  type SoItem = {
    id: string;
    item_code: string; description: string | null; description2: string | null;
    item_group: string | null; qty: number; po_qty_picked: number | null;
    unit_price_sen: number;
    discount_sen: number | null; unit_cost_sen: number | null;
    variants: unknown; uom: string | null; remark: string | null;
    photo_urls: string[] | null;
  };
  const notOnPo = (wanted as SoItem[]).filter((r) => !existingSet.has(r.item_code));
  /* F1 audit fix (2026-06-10) — convert ONLY the unpicked remainder. This path
     used to re-copy the FULL qty on every call regardless of po_qty_picked,
     so converting the same SO into a second PO double-ordered the supplier. */
  const toInsert = notOnPo.filter((r) => (Number(r.qty ?? 0) - Number(r.po_qty_picked ?? 0)) > 0);
  if (toInsert.length === 0) {
    return c.json({ copied: 0, skipped: wanted.length, reason: 'All matching SO items are already on a PO (or on this one).' });
  }

  /* Supplier-cost pricing (F1 audit fix 2026-06-10) — this path used to copy
     the SO line's SELLING price into the PO. Now each line is priced like the
     From-SO picker: the PO supplier's binding price_matrix (P2; P1 when the
     fabric resolves to PRICE_1) + the supplier's maintenance surcharges, via
     computeMfgPoUnitCost; falls back to the flat binding price; unbound SKUs
     ride at cost 0 (price keyed in at Purchase Invoice time — Wei Siang
     2026-06-11). Sofa-combo redistribution stays exclusive to the From-SO
     picker; this legacy append path prices per-module. */
  const codesToPrice = toInsert.map((r) => r.item_code);
  type BindLite = {
    item_code: string; supplier_sku: string | null;
    unit_price_sen: number; price_matrix: Record<string, unknown> | null;
  };
  const bindByCode = new Map<string, BindLite>();
  if (codesToPrice.length > 0) {
    const { data: binds } = await readMfgProductBindings<BindLite>(sb, {   // same reader
      codes: codesToPrice as string[],
      companyId: activeCompanyId(c),
      select: 'item_code, supplier_sku, unit_price_sen, price_matrix, is_main_supplier',
      supplierId: po.supplier_id as string,
    });
    for (const b of binds) {
      if (!bindByCode.has(b.item_code)) bindByCode.set(b.item_code, b);
    }
  }
  const { config: maintCfg } = await resolveMaintenanceConfigForSupplier(sb, po.supplier_id as string);
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
    if (!b) return { cost: 0, supplierSku: null }; // unbound — key in at PI
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
        ...poVariantPricingInput(category, variants), // incl. the totalHeight this path dropped
      },
      maintCfg ?? null,
    ).unitPriceSen;
    return { cost, supplierSku: b.supplier_sku };
  };

  const rows = toInsert.map((it) => {
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
      // Release-on-delete link (migration 0098) — convert-from-SO now stamps the
      // source SO line too, so these lines drop the SO from the picker and get
      // released on delete/cancel, consistent with the From-SO picker paths.
      so_item_id:       it.id,
      // Owner 2026-08-10 (migration 0274) — carry the SO line's photos, same as
      // the From-SO picker paths above.
      photo_urls:       it.photo_urls ?? [],
    };
  });

  const { data: inserted, error: insErr } = await sb
    .from('purchase_order_items')
    .insert(stampCompany(rows, c))
    .select(ITEM_COLS);
  if (insErr) return c.json({ error: 'insert_failed', reason: insErr.message }, 500);

  await recomputePoTotals(sb, poId);
  // Recount po_qty_picked from the live PO lines for every converted SO line.
  try { await recomputeSoPicked(sb, toInsert.map((it) => it.id)); }
  catch { /* lines already inserted — don't fail on counter recount */ }

  /* ERP -> AutoCount edit, NOT a convert. AutoCount has no SO->PO transfer at
     all (Convert_ targets only DO/IV/GR/PI — AcSyncService.cs:305-353), so this
     route is not a conversion in AutoCount's sense however it is named here: it
     APPENDS lines to a purchase order that may already exist in the account
     book, which is an edit of that document.

     A PO still in DRAFT has no AutoCount counterpart, so this folds into the
     create that confirm will queue. A PO already in the book gets a real edit,
     and these lines are brand new, so they are DECLARED as such: composeEdit
     marks them IsNewLine and AcSyncService appends them with AddDetail. The
     declaration is what makes that safe — a keyless line the route did not name
     is still refused, because guessing a key would make AcSyncService rewrite
     somebody else's line in a live book, and 0273's own header says a wrong key
     is strictly worse than NULL. (Until 2026-08-31 nothing declared them here,
     so this append refused the whole document and wrote a visible skipped row.) */
  await queueAcPoEdit(c, poId, [], ((inserted ?? []) as Array<{ id?: unknown }>)
    .map((r) => String(r?.id ?? ''))
    .filter(Boolean));

  return c.json({
    copied: rows.length,
    skipped: existingSet.size,
    sourceDocNo: soDocNo,
    items: inserted ?? [],
  });
});

// ── Submit / cancel ──────────────────────────────────────────────────
// PR-DRAFT-removal — POST creates SUBMITTED directly. This endpoint is kept
// as an idempotent no-op so legacy callers still work.
//
// DELIBERATELY NOT AUDITED: it writes nothing. Every path either echoes the row
// back unchanged or 409s. An audit row here would record an edit that did not
// happen, which is worse than no row — the log's value is that its entries are
// all real.
/* Owner 2026-08-02 — a PO with no ship-to WAREHOUSE cannot go live. The
   receiving warehouse flows from the PO (grns.ts:442), so a warehouse-less PO
   receives into the default/China landing and its goods end up in the wrong
   place (the AKEMI/TRION-into-C&C-DISPLAY class). Block it at the source: a PO
   is missing its warehouse when the header purchase_location_id is blank AND at
   least one line has no warehouse_id of its own. Returns the offending line
   codes so the operator knows what to fix. */

/* PATCH /:id/submit was DELETED on 2026-08-18. It had no write path: it read
   the row, echoed an already-SUBMITTED PO, 409'd on a missing warehouse and then
   returned `cannot_submit` unconditionally — so the DRAFT it existed to advance
   was the one case it could never serve. Its last caller was the read-only PO
   detail page, whose "Submit" button therefore failed on every draft while the
   editor and the phone used /confirm and worked; the operator met one system
   behaving two ways. /confirm below is the single verb that commits a draft.

   Kept as a note rather than a redirect because there is no legacy caller left
   to redirect: a whole-tree grep for the path at deletion time found only this
   handler, the frontend hook removed with it, and generated docs. */

/* ── Confirm (Draft/Confirmed two-state) ──────────────────────────────────
   DRAFT -> SUBMITTED. This is where a draft PO COMMITS: it stamps submitted_at
   and runs recomputeSoPicked so its converted SO lines drop out of the From-SO
   picker (the SO-quota advance that the create path skips while DRAFT). Once
   SUBMITTED the PO becomes live supply in MRP (PO_DEAD no longer hides it) and
   GRN-receivable (the GRN-from-PO picker accepts SUBMITTED). Idempotent on an
   already-live PO; rejects RECEIVED/CANCELLED. Split read -> guard -> update ->
   re-read so the RETURNING-coercion PGRST116 can't 500 it (mirrors cancel). */
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
  // Idempotent — an already-live PO is already confirmed, echo back.
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

  /* Recorded before the SO-quota recount below, which is itself best-effort:
     the PO is SUBMITTED from this point regardless of whether the counter
     recount lands, and that is the fact worth keeping. totalSen is the
     INTEGER SEN the supplier is now owed. */
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

  /* Commit the SO-quota advance that the DRAFT create deliberately skipped: the
     PO is SUBMITTED now, so recomputeSoPicked counts this PO's lines and the
     converted SO lines drop from the From-SO picker. Best-effort — never fail
     the confirm on a counter recount. */
  try {
    const { data: lines } = await supabase
      .from('purchase_order_items')
      .select('so_item_id')
      .eq('purchase_order_id', id);
    await recomputeSoPicked(supabase, ((lines ?? []) as Array<{ so_item_id: string | null }>).map((l) => l.so_item_id));
  } catch { /* PO already confirmed — don't fail on counter recount */ }

  const { data: after } = await scopeToCompanyId(supabase
    .from('purchase_orders')
    .select('id, status, submitted_at')
    .eq('id', id), co.companyId)
    .maybeSingle();

  /* The draft just became a real order — this is the moment it belongs in
     AutoCount. enqueuePoCreate refuses a PO that already has an AutoCount
     counterpart, so a re-entered confirm cannot duplicate it. */
  const { problems: acNotSent } = await enqueuePoCreate(supabase, {
    companyId: co.companyId,
    poId: id,
    createdBy: c.get('houzsUser')?.id ?? null,
  });

  return c.json({ purchaseOrder: after ?? { id, status: 'SUBMITTED' }, ...(acNotSent.length ? { acNotSent } : {}) });
};
mfgPurchaseOrders.patch('/:id/confirm', confirmMfgPurchaseOrderHandler);

/* ── POST /:id/send-to-supplier — email the PO to its supplier (HUMAN action) ──
   The Procurement agent only ever raises a DRAFT PO; a person confirms it and,
   separately, chooses to send it. This is that send. It is NOT automatic and NOT
   the agent's — an operator triggers it from the PO page. Nothing in this file
   calls this handler; there is no scheduled caller and there must never be one.

   The PO PDF is rendered in the BROWSER (the owner bars a backend PDF engine), so
   the frontend posts the rendered PDF as base64 and this attaches it. Without a
   pdf, a summary-only email still goes (documentEmailHtml).

   FAIL-CLOSED: the `purchase_order` channel is seeded OFF (mig 0132) — a PO leaves
   for an external supplier only when the owner has turned the channel on.

   ── THE ORDER OF THE GUARDS IS THE DESIGN ──
   Every refusal below happens BEFORE the claim, which happens BEFORE the send.
   The claim is a WRITE, so a refusal that ran after it would leave a "sent"
   stamp on a PO nobody emailed. Authorization is upstream: scm/index.ts mounts
   this router behind scmAreaGuard('scm.procurement.po'), so a POST here already
   required `edit` on the Procurement PO area. */
mfgPurchaseOrders.post('/:id/send-to-supplier', async (c) => {
  const id = c.req.param('id');
  const supabase = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  let body: { pdfBase64?: unknown; message?: unknown } = {};
  try { body = (await c.req.json()) as typeof body; } catch { body = {}; }

  /* THE CHANNEL GATE IS FIRST, before the PO is even read — same posture as
     do-email.ts. With the channel off this endpoint must do literally nothing:
     no read, no claim, no audit row, no email_log entry about a switched-off
     feature. Checked again independently inside sendEmail. */
  if (!(await isChannelEnabled(c.env, 'purchase_order'))) {
    return c.json({ error: 'channel_off', message: 'The purchase-order email channel is off. Turn it on in email settings to send.' }, 409);
  }

  const { data: po, error } = await scopeToCompanyId(supabase
    .from('purchase_orders')
    .select('id, po_number, status, total_sen, currency, po_date, company_id, po_email_sent_at, po_email_sent_to, supplier:suppliers(name, email)')
    .eq('id', id), co.companyId)
    .maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!po) return c.json(NOT_THIS_COMPANY, 404);

  const row = po as unknown as PoEmailRow & {
    company_id?: number | null;
    po_email_sent_at?: string | null;
    po_email_sent_to?: string | null;
  };

  /* Status. Bars DRAFT (uncommitted) and CANCELLED (telling a supplier to ship
     goods the company has decided not to buy) — see poSendRefusalForStatus. */
  const statusRefusal = poSendRefusalForStatus(row.status);
  if (statusRefusal) return c.json({ error: 'not_sendable', message: statusRefusal }, 409);

  /* Recipient. Checked as a real address, not just "contains @" — this is the
     last point before an external send. */
  const supplierEmail = (row.supplier?.email ?? '').trim();
  if (!supplierEmail) {
    return c.json({ error: 'no_supplier_email', message: 'This supplier has no email address on file.' }, 400);
  }
  if (!isSendableEmail(supplierEmail)) {
    return c.json({
      error: 'bad_supplier_email',
      message: `The supplier's email address (${supplierEmail}) is not a valid address. Fix it on the supplier record, then send again.`,
    }, 400);
  }

  /* Attachment, validated BEFORE anything is claimed or sent: absent is legal
     (summary-only), present-but-wrong is refused with a readable reason. */
  const poNo = row.po_number ?? id;
  const attachmentCheck = validatePoAttachment(body.pdfBase64, poNo);
  if (!attachmentCheck.ok) {
    return c.json({ error: 'bad_attachment', message: attachmentCheck.message }, 400);
  }

  const branding = await getBrandingForCompany(c.env, row.company_id ?? null);
  const msg = buildPurchaseOrderEmail(
    row,
    branding.companyName,
    typeof body.message === 'string' ? body.message : null,
  );
  /* Unreachable given the recipient check above — buildPurchaseOrderEmail's only
     null is a bad address. Handled rather than asserted: the two checks are in
     different files and a future edit could separate them. */
  if (!msg) {
    return c.json({ error: 'no_supplier_email', message: 'This supplier has no usable email address on file.' }, 400);
  }

  /* ── THE CLAIM: the double-click guard ──
     Two clicks (or a click and the browser's retry of a slow request) can both
     pass every check above and both send. Claim the row atomically: Postgres
     serialises the two UPDATEs and the filter means exactly one gets a row back.

     The filter is "never sent, OR last sent more than a minute ago", so this
     blocks the accident WITHOUT making the send once-only — a deliberate resend
     is a normal, supported action (see PO_RESEND_WINDOW_MS for why HOOKKA's
     one-shot design had to be undone).

     String comparison on po_email_sent_at is sound because every value in the
     column is written by toISOString() here: same length, same UTC 'Z' suffix,
     so lexical order is chronological order. The column is text to match the
     text-timestamp rule mig 0008 established for this schema. */
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
    subject: msg.subject,
    html: msg.html,
    purpose: 'purchase_order',
    refType: 'purchase_order',
    // po id is a uuid; email_log.ref_id is INTEGER, so identity lives in the subject.
    companyCode: row.company_id != null ? String(row.company_id) : null,
    attachments: attachmentCheck.attachment ? [attachmentCheck.attachment] : undefined,
    /* NO CRON RETRY when a PDF is attached. email_outbox has no attachment
       column (services/email.ts SendOptions.attachments), so a drained retry
       would deliver the PO body WITHOUT the order document — and the operator,
       having already seen "not sent", would send again, leaving the supplier
       with a bodyless copy plus a real one. Better that the failure stays a
       failure the operator can act on. A summary-only send has nothing to lose
       and keeps the durable retry. */
    outboxRetry: attachmentCheck.attachment == null,
  });

  if (res.status !== 'sent') {
    /* NOT sent -> RELEASE the claim back to its previous value, so the stamp
       only ever means "this supplier was successfully emailed at this time" and
       the operator can retry immediately instead of waiting out the window. */
    await scopeToCompanyId(supabase
      .from('purchase_orders')
      .update({ po_email_sent_at: previousSentAt, po_email_sent_to: previousSentTo })
      .eq('id', id), co.companyId)
      .eq('po_email_sent_at', claimedAt);
  }

  /* ── WHO SENT IT ──
     Recorded for BOTH outcomes, and that is deliberate: a failed send to an
     external party is exactly as much a fact about who did what as a successful
     one, and the attempt is the thing a later question ("did anyone email this
     supplier?") is really asking about. recordEntityAudit is best-effort and
     never throws (lib/entity-audit.ts), so it cannot turn a delivered email into
     a 500. The actor is c.get('houzsUser') — the REAL person; c.get('user') is
     the pinned scm.staff system identity shared by every caller. */
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

  /* Commander 2026-05-29 — BUGFIX: the old `.update(...).select().single()`
     threw "Cannot coerce the result to a single JSON object" (PostgREST
     PGRST116) whenever the UPDATE's RETURNING yielded ≠ 1 visible rows. Split
     into read → guard → update → re-read so the cancel can't 500 on that. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: cur, error: readErr } = await scopeToCompanyId(supabase
    .from('purchase_orders').select('id, status, po_number, company_id, total_sen')
    .eq('id', id), co.companyId).maybeSingle();
  if (readErr) return c.json({ error: 'load_failed', reason: readErr.message }, 500);
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const curStatus = (cur as { status: string }).status;
  if (curStatus === 'RECEIVED') return c.json({ error: 'cannot_cancel', message: 'PO already received' }, 409);
  // Idempotent echo. ADVISORY — this read cannot see a cancel that lands after it; the atomic gate on the UPDATE below is what decides.
  if (curStatus === 'CANCELLED') return c.json({ purchaseOrder: { id, status: 'CANCELLED' } });

  /* Tier 2 downstream-lock — can't cancel a PO that has a downstream GRN; the
     GRN must be cancelled/deleted first (mirrors grnHasDownstream cancel guard). */
  const childLock = await poHasDownstream(supabase, id);
  if (childLock) return c.json(childLock, 409);

  /* Audit C3 — a drop-ship DO may have shipped against this PO's number as its
     EXPECTED batch (no GRN yet, so poHasDownstream can't see it). Cancelling
     would orphan that OUT forever (permanent negative + 0 COGS). */
  const dropshipLock = await poHasOutstandingDropshipOut(
    supabase, (cur as { po_number?: string | null }).po_number);
  if (dropshipLock) return c.json(dropshipLock, 409);

  /* ATOMIC ACTIVE->CANCELLED: only one of two concurrent cancels flips the row, so the audit row + SO-quota release below fire once (full note at grns.ts:2566). */
  const { data: updRow, error: updErr } = await scopeToCompanyId(supabase
    .from('purchase_orders')
    .update({ status: 'CANCELLED', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id).neq('status', 'CANCELLED'), co.companyId).select('id').maybeSingle();
  if (updErr) return c.json({ error: 'cancel_failed', reason: updErr.message }, 500);
  if (!updRow) return c.json({ purchaseOrder: { id, status: 'CANCELLED' } });   // lost the race

  /* The prior status comes from the guarded read above, so this records the real
     transition (SUBMITTED / PARTIALLY_RECEIVED -> CANCELLED) rather than
     asserting a fixed from-value. Cancelling releases the SO quota below —
     recorded here so the release always has an author even if the recount
     hiccups. */
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
    // The PO is now CANCELLED, so recomputeSoPicked recounts every affected SO
    // line excluding this PO's lines — releasing them back to the picker.
    await recomputeSoPicked(supabase, lineRows.map((l) => l.so_item_id));

    /* 2026-08-02 (over-order audit H0) — the quota release above frees the SO
       lines, but the finer-grained mig-0235 allocation sub-lines (PO-xxxx-yy-NN)
       were left stranded: a CANCELLED PO kept rows still naming a live SO, so its
       reverse-coverage surface would attribute goods it will never deliver. The
       owner's rule is explicit — "cancelled POs are never attribution targets" —
       so clear this PO's allocations here, the same transition that releases the
       quota. The coarse so_item_id on the line survives (reopen re-claims quota
       and falls back to the 1:1 link); a consolidated split, if ever needed
       again after a reopen, is re-entered in the allocation editor. */
    const poItemIds = lineRows.map((l) => l.id).filter(Boolean);
    if (poItemIds.length > 0) {
      await scopeToCompanyId(supabase
        .from('purchase_order_item_allocations')
        .delete()
        .in('purchase_order_item_id', poItemIds), co.companyId);
    }
  } catch { /* best-effort — PO already cancelled, don't fail on counter recount */ }

  const { data: after } = await scopeToCompanyId(supabase
    .from('purchase_orders')
    .select('id, status, cancelled_at, po_number')
    .eq('id', id), co.companyId)
    .maybeSingle();

  /* ERP -> AutoCount cancel. Reached only for a PO the downstream lock let
     through (poHasDownstream, checked above) — the same rule AutoCount applies
     on its side, so this can never ask it to cancel a received PO. */
  await enqueueCancel(supabase, {
    companyId: co.companyId,
    docType: 'PO',
    docNo: (after as { po_number?: string } | null)?.po_number ?? id,
    docId: id,
    self: { table: 'purchase_orders', keyCol: 'id', key: id },
    createdBy: c.get('houzsUser')?.id ?? null,
  });

  return c.json({ purchaseOrder: after ?? { id, status: 'CANCELLED' } });
};
mfgPurchaseOrders.patch('/:id/cancel', cancelPurchaseOrderHandler);

/* PATCH .../hold — the mig-0324 MARKER, never `status`. routes/document-hold-routes.ts. */
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

  /* A CANCEL THAT REACHED AUTOCOUNT CANNOT BE TAKEN BACK. The 2.2 SDK has no
     un-cancel - CancelDocument is a command, not a flag, and a whole-file grep
     of the reflected surface for uncancel / set_Cancelled returns nothing. A
     reopen here would leave the PO live in the ERP and cancelled in the account
     book, with nothing able to close the gap. Raise a new PO instead. */
  const acDocNo = (cur as { linked_ac_docno?: string | null }).linked_ac_docno;
  if (curStatus === 'CANCELLED' && acDocNo) {
    return c.json({
      error: 'cancel_is_final',
      message: 'This purchase order was cancelled in AutoCount too, and AutoCount has no '
        + 'un-cancel. Raise a new purchase order instead.',
      acDocNo,
    }, 409);
  }
  // Idempotent — a live PO is already open, echo back.
  if (curStatus === 'SUBMITTED' || curStatus === 'PARTIALLY_RECEIVED') {
    return c.json({ purchaseOrder: { id, status: curStatus } });
  }
  if (curStatus !== 'CANCELLED') {
    return c.json({ error: 'cannot_reopen', message: `Only a cancelled PO can be reopened (this is ${curStatus})` }, 409);
  }

  /* REOPEN IS A THIRD DOOR TO 'SUBMITTED', and it was the only one with no
     warehouse gate. Create forces a warehouse-less PO to DRAFT, and /submit and
     /confirm both run poWarehouseGap; cancel accepts a DRAFT, so cancel-then-
     reopen (two buttons on the same screen) turned a warehouse-less DRAFT into a
     live, GRN-receivable PO whose receipt then falls through to the company
     default warehouse — the AKEMI/TRION-into-C&C-DISPLAY class.

     submitted_at is stamped here for the same reason: reopen left it NULL, so a
     live PO carried no submission timestamp. */
  const gap = await poWarehouseGap(supabase, id);
  if (gap.missing) return c.json(PO_WAREHOUSE_REQUIRED(gap.codes), 409);

  const { error: updErr } = await scopeToCompanyId(supabase
    .from('purchase_orders')
    .update({
      status: 'SUBMITTED',
      cancelled_at: null,
      submitted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id), co.companyId);
  if (updErr) return c.json({ error: 'reopen_failed', reason: updErr.message }, 500);

  /* UPDATE, not REVERSE: nothing was posted to reverse. A reopen re-claims the
     SO quota the cancel released, which is a document-state move. */
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

  /* Re-claim every converted SO line's quota: the PO is SUBMITTED again, so
     recomputeSoPicked now counts this PO's lines (it excludes only CANCELLED
     POs) — the exact inverse of the release cancel did. Best-effort: never fail
     the reopen on a counter recount. */
  try {
    const { data: lines } = await supabase
      .from('purchase_order_items')
      .select('so_item_id')
      .eq('purchase_order_id', id);
    await recomputeSoPicked(supabase, ((lines ?? []) as Array<{ so_item_id: string | null }>).map((l) => l.so_item_id));
  } catch { /* best-effort — PO already reopened, don't fail on counter recount */ }

  const { data: after } = await scopeToCompanyId(supabase
    .from('purchase_orders')
    .select('id, status, cancelled_at')
    .eq('id', id), co.companyId)
    .maybeSingle();
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
