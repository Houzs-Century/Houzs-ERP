// ----------------------------------------------------------------------------
// /mrp — Material Requirements Planning (trading-company / finished-goods).
//
// Commander 2026-05-28: port the AutoCount "Stock Status Report". 2990 is a
// TRADING company (buys finished sofas/bedframes/mattresses and resells), so
// this is NOT a BOM-explosion MRP (that's HOOKKA, a manufacturer). It's a
// finished-goods demand-vs-supply reconciliation:
//
//   Demand   = outstanding Sales-Order line items (qty, delivery date, SO no)
//   Supply   = on-hand stock (inventory_balances) + outstanding PO lines
//              (qty - received, with ETA = line delivery_date ?? po.expected_at)
//   Allocate = greedy by SO delivery date (earliest first):
//                stock first → outstanding PO (earliest ETA) → shortage.
//
// Pure calculator — NO dedicated table, NO persistence (v1 per commander:
// "先做即时计算"). Recomputed on every GET.
//
// Commander 2026-05-31 — PER-WAREHOUSE rebuild:
//   · Every bucket is keyed by (warehouse_id, item_code, variant_key). Stock
//     NEVER crosses warehouses (a cross-WH pull needs a stock transfer), so the
//     warehouse is part of the demand AND the supply identity. The SO LINE's
//     warehouse_id (migration 0118) is the binding — each line can ship from a
//     different warehouse.
//   · warehouseId omitted / 'all' → return the UNION of every warehouse's
//     buckets (each warehouse computed independently), NOT a cross-WH pooled
//     recompute. warehouseId=<uuid> → only that warehouse's buckets.
//   · NO SO↔PO linkage. Supply is a pool of stock + ALL open PO lines (by
//     warehouse+variant), allocated greedy by delivery date. The old
//     po_qty_picked "lock" is gone — the same SO line is infinitely convertible
//     to PO from MRP (reference only; see purchase_order_items.from_mrp).
//
// 2026-07-31 — POOLED MATCHING STANDS; HARD COMMITMENTS ARE CARVED OUT.
//   The pooled model above is unchanged for FREE supply. What section 4 now
//   removes from the pool is the units a shipment ALREADY OWNS: a DO that
//   shipped before its goods arrived, bound to that PO's batch (see
//   scm/lib/ship-commitment.ts + migration 0230). Those units are going to be
//   consumed by scm.fn_reconcile_dropship_batch the moment the GRN posts, so
//   offering them to a second Sales Order promises stock that is already spoken
//   for. This is NOT a return of the SO↔PO lock — a committed unit is subtracted
//   from the pool, never reserved to a particular SO line, and everything left
//   is still matched by date alone.
//
//   ⚠ AND THE SAME UNITS ARE ADDED BACK TO ON-HAND STOCK, which is the part a
//   reader must not skip. The ship wrote a real OUT movement, so
//   scm.inventory_balances (SUM of IN - OUT) has ALREADY deducted it — the
//   ledger has always carried the commitment, just as a nameless negative in
//   whichever bucket the OUT landed in. Deducting from PO supply WITHOUT the
//   add-back would subtract it a second time and invent a shortage. Net
//   availability is therefore unchanged by this change; what changes is that the
//   commitment now shows against the PO that owes it instead of silently taxing
//   whichever SO sorts first. See applyCommittedSupply for the invariant.
//
// Output mirrors the xls the commander shared:
//   parent row  (per SKU+warehouse) : Qty Needed / Stock / PO Outstanding / Shortage
//   child rows  (per SO)            : SO No · Delivery Date · Qty · source tag
//                                     (stock | PO-xxxx + ETA | shortage → orange)
//
// Endpoint:
//   GET /mrp?category=BEDFRAME&warehouseId=<uuid>
//            category  omitted / 'all' → every category
//            warehouseId omitted / 'all' → every warehouse (union of per-WH buckets)
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { canonicalVariantKey, computeVariantKey, buildVariantSummary, isServiceLine, splitSofaCode, effectiveDelivery, effectiveSoDelivery, type VariantAttrs } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import { soDeliverableRemaining } from './delivery-orders-mfg';
import { activeCompanyId } from '../lib/companyScope';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { resolveLineWarehouseId, type SoWarehouseMasters } from '../lib/so-warehouse';
import {
  loadLeadTimeBase,
  loadSupplierCategoryOverrides,
  resolveLeadDays,
  subtractCalendarDays,
  LEAD_TIME_SELECT,
  LEAD_OVERRIDE_SELECT,
  NO_BUFFERS,
  type LeadBuffers,
} from '../lib/lead-time';
import { loadLeadBuffers } from '../../services/agents/procurement-learning';
import {
  applyCommittedSupply,
  commitmentKey,
  type OutstandingCommitment,
  type PoSupplyEntry,
} from '../lib/ship-commitment';
import { collectBatchClaims, openBucketStock, drawBucketStock } from '../lib/batch-claimed-stock';
import { loadSofaBatchStock } from '../lib/sofa-set-coverage';
import { planSofaSets, type SofaPlan, type SofaSetLine, type SofaSetPoSupply } from '../lib/sofa-set-plan';
import { WH_NONE, composite, loadCommittedShipments } from '../lib/committed-shipments';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { isDocumentHeld } from '../lib/document-hold';
import { MRP_DELIVERED_EMBED, compareDelivered, deliveredBySoItemFrom, readUnlinkedDoLines, type MrpDemandLine, type NettingCheck } from '../lib/mrp-delivered';
import { pgrestInList } from '../lib/pgrest-in-list';
import { readMfgProductBindings } from '../lib/supplier-bindings';
import { NB_FABRIC_SERIES, NB_SUPPLIER_CODE, needsNbSupplier } from '../lib/mrp-rule-supplier';
import { mapBounded, eager } from '../lib/concurrency';
import type { Env, Variables } from '../env';
import { SO_TERMINAL_STATES } from '../shared/so-terminal-states';
import { SO_PROCESSING_DATE_COLUMN } from '../shared/so-processing-date';
import { isDefaultMrpView, readMrpSnapshot, refreshMrpSnapshot } from '../lib/mrp-snapshot';
import { allocSourceOf, allocSourceCoveringPo, type AllocSource } from '../shared/mrp-alloc-source';
import { isHardBoundLine, HARD_BOUND_COMPANY_ID } from '../lib/so-stock-allocation';
import { variantTrackedCompany } from '../lib/binding-mode';

export const mrp = new Hono<{ Bindings: Env; Variables: Variables }>();
mrp.use('*', supabaseAuth);

const SO_DONE = new Set<string>(SO_TERMINAL_STATES);
const PO_DEAD = new Set(['CANCELLED', 'DRAFT']);

const MRP_READ_CONCURRENCY = 6;

const sqlNotInList = (statuses: Iterable<string>): string =>
  `(${[...statuses].map((s) => `"${s}"`).join(',')})`;
const SO_DONE_SQL = sqlNotInList(SO_DONE);
const PO_DEAD_SQL = sqlNotInList(PO_DEAD);

type DemandRow = {
  id: string;
  doc_no: string;
  item_code: string;
  description: string | null;
  item_group: string | null;
  variants: Record<string, unknown> | null;
  qty: number;
  warehouse_id: string | null;
  line_delivery_date: string | null;
  line_delivery_date_overridden: boolean | null;
  line_no: number | null;
  created_at: string | null;
  cancelled: boolean;
  allocated_batch_no: string | null;
  so: {
    debtor_name: string | null;
    status: string;
    on_hold?: boolean | null;
    so_date: string | null;
    customer_delivery_date: string | null;
    amended_delivery_date: string | null;
    processing_date: string | null; /* Release-for-purchasing signal (owner 2026-08-18: "Processing Date
       就代表这张单可以安排订货了"). GATES entry: a line whose order has none is
       not demand (see isReleased). Once in, "when to order" is orderByDate below,
       derived from the delivery date and the category lead time. NOT a
       production date: there is no production. */
    customer_state: string | null;
    sales_location: string | null;
  } | null;
};

type PoLineRow = {
  item_code: string;
  item_group: string | null;
  variants: Record<string, unknown> | null;
  qty: number;
  received_qty: number | null;
  delivery_date: string | null;
  supplier_delivery_date_2: string | null;
  supplier_delivery_date_3: string | null;
  supplier_delivery_date_4: string | null;
  warehouse_id: string | null;
  so_item_id: string | null;
  po: {
    po_number: string; status: string; expected_at: string | null;
    supplier_delivery_date_2: string | null;
    supplier_delivery_date_3: string | null;
    supplier_delivery_date_4: string | null;
    purchase_location_id: string | null; supplier_id: string | null;
  } | null;
};

type ProductRow = { code: string; name: string | null; category: string | null };
type BalanceRow = { item_code: string; warehouse_id: string; variant_key: string | null; qty: number };


const variantKeyOf = (itemGroup: string | null | undefined, variants: unknown): string =>
  computeVariantKey(itemGroup, (variants ?? null) as VariantAttrs | null);


export type MrpLine = {
  soItemId: string;
  soDocNo: string;
  debtorName: string | null;
  customerState: string | null;
  soDate: string | null;
  deliveryDate: string | null;
  processingDate: string | null;
  /* Commander 2026-05-29 — order-by date = delivery date − category lead days.
     "最迟下单日": place the PO by this date to hit the customer's delivery. */
  orderByDate: string | null;
  qty: number;
  source: AllocSource;
  poNumber: string | null;
  poEta: string | null;
  shortageQty: number;
  /* Owner 2026-07-25 (dead-stock view) — units of THIS line filled from ON-HAND
     stock by the greedy allocation (fromStock). This is the "assigned stock"
     signal: a lot is ASSIGNED to an SO iff MRP allocated on-hand stock to that
     SO's demand. A line can be part stock + part PO; `source` collapses to one
     tag, but stockQty carries the exact on-hand slice so the drawer's
     assigned-vs-free split reads off the SAME engine (not hard reservations). */
  stockQty: number;
  poSupplierId: string | null;
  poSupplierName: string | null;
  /* HC-0128 — the supplier this line's content routes to (Hydraulic / NB
     fabric -> NB FURNITURE), when that supplier is bound to the SKU; the UI
     pre-selects it instead of the SKU's main supplier. NULL = no rule fired. */
  ruleSupplierId: string | null;
};

export type MrpSku = {
  warehouseId: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  itemCode: string;
  variantKey: string;
  variantLabel: string | null;
  description: string | null;
  category: string | null;
  qtyNeeded: number;
  stock: number;
  poOutstanding: number;
  shortage: number;
  mainSupplierCode: string | null;
  mainSupplierName: string | null;
  suppliers: Array<{ supplierId: string; code: string; name: string; isMain: boolean }>;
  lines: MrpLine[];
};

/* Commander 2026-05-29 — sofa is ordered as a colour-matched SET, one per SO
   line ("每张 SO 一套"). The inventory variant key only covers fabric+seat+leg,
   NOT the module layout (cells), so two differently-built sofas with the same
   fabric collapse into one bucket. The set view keys per SO line for display.
   Commander 2026-05-31 — coverage now uses the SAME pooled (warehouse, code,
   variant) stock+PO supply as the SKU path (greedy by delivery date), NOT
   po_qty_picked — MRP ignores SO↔PO linkage. */
type SofaSet = {
  warehouseId: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  soItemId: string;
  soDocNo: string;
  lineNo: number | null;
  createdAt: string | null;
  debtorName: string | null;
  customerState: string | null;
  soDate: string | null;
  deliveryDate: string | null;
  processingDate: string | null;
  orderByDate: string | null;
  itemCode: string;
  variantKey: string;
  description: string | null;
  variantLabel: string | null;
  modules: string[];
  colour: string | null;
  qty: number;
  orderedQty: number;
  /* Owner 2026-07-25 (dead-stock view) — the on-hand-stock slice of orderedQty
     (fromStock), mirroring MrpLine.stockQty for the sofa path. */
  stockQty: number;
  shortageQty: number;
  poNumber: string | null;
  poEta: string | null;
  poSupplierId: string | null;
  poSupplierName: string | null;
  batchNo: string | null;
  suppliers: Array<{ supplierId: string; code: string; name: string; isMain: boolean }>;
};

/* THE date for one demand line — the shared reader, and the ONLY place this
   page decides "when is this due". Owner 2026-08-18: there is no production
   here, only the delivery date, and every screen must plan on the same one.
   This page used to read `line_delivery_date ?? so.customer_delivery_date`,
   which is the customer's ORIGINAL promise plus a line MIRROR of it — so a
   rescheduled order moved on the delivery board and did not move here, in the
   queue that decides who gets scarce stock and what is ordered first. See
   shared/effective-delivery.ts for the precedence and why the override flag
   is load-bearing. */
const deliveryOf = (r: DemandRow): string | null => effectiveSoDelivery({
  line_delivery_date: r.line_delivery_date,
  line_delivery_date_overridden: r.line_delivery_date_overridden,
  amended_delivery_date: r.so?.amended_delivery_date,
  customer_delivery_date: r.so?.customer_delivery_date,
});

function byDateAsc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? -1 : 1;
}

export type UnmatchedCommitment = {
  warehouseId: string | null;
  warehouseCode: string | null;
  itemCode: string;
  variantKey: string;
  poNumber: string;
  qty: number;
};

export type MrpResult = {
  asOf: string;
  nettingCheck?: NettingCheck;
  categories: string[];
  warehouses: unknown[];
  skus: MrpSku[];
  sofaSets: SofaSet[];
  unmatchedCommitments: UnmatchedCommitment[];
  /* How much of the demand this run walked has NO delivery date, counted
     ALWAYS — whether or not `includeUndated` let it into `skus[]`/`sofaSets[]`
     above. Same filter scope as those arrays (category + warehouse), so it is
     the honest denominator for the rows on screen.

     This exists because the omission was SILENT. `includeUndated=false` is a
     display filter with a real reason behind it (undated demand is not orderable
     yet, Commander 2026-05-29), but the page rendered the surviving half with
     nothing saying a half had been removed — so a shortage the operator had
     never seen read as a shortage that did not exist. Owner, 2026-08-16:
     "明明这个东西没有 ready,可是我的 MRP 却 show 不出来". Measured on production
     the same day: 82 of 163 live 2990 SO-item ids were absent by default, and
     the short-sofa count went 8 -> 68 with the flag on.

     A count is not a filter: nothing here feeds the allocation (audit D6).

     The two paths are counted SEPARATELY and must stay that way: section 7
     honours `catFilter`, section 8 is SOFA-by-construction and ignores it, so a
     blended total would overstate every non-sofa tab by the whole sofa book.
     Read `lines` on the general views and `sofaSets` on the sofa view. */
  undated: {
    lines: number;
    shortageUnits: number;
    sofaSets: number;
    sofaShortageUnits: number;
    hidden: boolean;
  };
  totals: {
    skuCount: number;
    shortageSkuCount: number;
    shortageUnits: number;
    sofaSetCount: number;
    sofaSetShortageCount: number;
    unmatchedCommitmentUnits: number;
  };
};

export type SoLineCoverage = { source: AllocSource; po: string | null; eta: string | null };

export async function computeMrp(
  sb: any,
  opts: {
    catFilter: string | null;
    whFilter: string | null;
    includeUndated: boolean;
    companyId: number | null | undefined;
    leadBuffers: LeadBuffers;
    nettingCheck?: boolean;
  },
): Promise<MrpResult> {
  const { catFilter, whFilter, includeUndated, companyId, leadBuffers } = opts;

  const scoped = <Q>(q: Q): Q =>
    companyId != null ? (q as unknown as { eq(c: string, v: unknown): Q }).eq('company_id', companyId) : q;
  /* A variant-tracked company (binding-mode.ts) compares bucket keys canonically,
     as the SO allocator has since #5617: stock keyed `...|legheight=2"` is the
     same goods as a line keyed `...|legheight=2"|totalheight=22"`. Without this the
     SO read READY while MRP read SHORT for the same line (2990-0059). Company 1
     keeps the exact string. */
  const bucketOf = (whId: string | null, code: string, vkey: string): string =>
    composite(whId, code, variantTrackedCompany(companyId) ? canonicalVariantKey(vkey) : vkey);

  const leadBaseProm = eager(loadLeadTimeBase(
    scoped(sb.from('mrp_category_lead_times').select(LEAD_TIME_SELECT)),
  ));
  /* The owner's MANUAL per-(supplier, category) overrides (owner 2026-09-11) —
     loaded here beside the base so the order-by HINT this page shows can never
     disagree with the date the convert commits (both read the same override).
     Empty until he sets one, so the hint is unchanged today. */
  const leadOverridesProm = eager(loadSupplierCategoryOverrides(
    scoped(sb.from('mrp_supplier_category_lead_times').select(LEAD_OVERRIDE_SELECT)),
  ));
  /* HC-0128 — the NB-series fabric codes (NB FURNITURE routing). Keyed off
     nothing but the company, so it rides this wave instead of adding a round
     trip after the bindings. */
  const nbFabricsProm = eager(Promise.resolve(scoped(sb
    .from('fabric_trackings')
    .select('fabric_code')
    .eq('series', NB_FABRIC_SERIES))));
  const catRowsProm = eager(paginateAll<{ category: string | null }>((from, to) =>
    scoped(sb.from('mfg_products').select('category')).order('id').range(from, to)));
  const balancesProm = eager(paginateAll<BalanceRow>((from, to) => {
    let q = scoped(sb.from('inventory_balances').select('item_code, warehouse_id, variant_key, qty'));
    if (whFilter) q = q.eq('warehouse_id', whFilter);
    return q.order('item_code').order('warehouse_id').order('variant_key').order('company_id').range(from, to);
  }));
  const poRawProm = eager(paginateAll<PoLineRow>((from, to) => scoped(sb
    .from('purchase_order_items')
    .select(`
      item_code, item_group, variants, qty, received_qty, delivery_date,
      supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4,
      warehouse_id, so_item_id,
      po:purchase_orders!inner ( po_number, status, expected_at, supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4, purchase_location_id, supplier_id )
    `)
    .not('po.status', 'in', PO_DEAD_SQL))
    .order('id')
    .range(from, to)));

  const leadBase = (await leadBaseProm)();
  const leadOverrides = (await leadOverridesProm)();
  const orderByOf = (
    deliveryDate: string | null,
    category: string | null,
    whId: string | null,
    supplierId: string | null,
    supplierCode: string | null,
  ): string | null =>
    subtractCalendarDays(
      deliveryDate,
      resolveLeadDays(leadBase, leadOverrides, leadBuffers, {
        warehouseId: whId,
        category,
        supplierId,
        supplierCode,
        deliveryDate,
      }).total,
    );

  const readDemand = (embedDelivered: boolean) => paginateAll<DemandRow>((from, to) => scoped(sb
    .from('mfg_sales_order_items')
    .select(`
      id, doc_no, item_code, description, item_group, variants, qty, warehouse_id, line_delivery_date, line_delivery_date_overridden, line_no, created_at, cancelled, allocated_batch_no,
      so:mfg_sales_orders!inner ( debtor_name, status, on_hold, so_date, customer_delivery_date, amended_delivery_date, processing_date, customer_state, sales_location )${embedDelivered ? `, ${MRP_DELIVERED_EMBED}` : ''}
    `)
    .eq('cancelled', false)
    .not('so.status', 'in', SO_DONE_SQL)
    .not(`so.${SO_PROCESSING_DATE_COLUMN}`, 'is', null))
    .order('id')
    .range(from, to));
  let demandRes = await readDemand(true);
  const deliveredEmbedded = !demandRes.error;
  if (!deliveredEmbedded) demandRes = await readDemand(false);
  const { data: demandRaw, error: demandErr } = demandRes;
  if (demandErr) throw new Error(`mrp_load_failed: ${demandErr.message}`);

  /* NO PROCESSING DATE, NO DEMAND (owner 2026-09-15, BUG-39 2026-09-29).
     「没有 Processing date 的单子就不进来」 — the Processing Date is the release
     for purchasing, so an order without one takes no stock, claims no PO and
     shows no shortage, on every consumer of this engine. Priority among the
     released orders is still the delivery date. The stock allocator applies the
     same gate (so-stock-allocation.ts); the SQL filter above only saves read
     budget, this one is authoritative. */
  const isReleased = (r: DemandRow): boolean => !!r.so?.processing_date;

  /* Undated lines (no line delivery date AND no SO delivery date) are not ready
     to order — the MRP page HIDES them by default (owner 2026-08-18;
     ?includeUndated=true shows them, marked "No date" and sorted last) and
     COUNTS them either way. They are STILL DEMAND either way, and audit D6
     (2026-08-01) proved the old shape of this switch let
     two screens disagree: excluding them from the ALLOCATION itself meant the
     page (includeUndated=false) and the SO drill-down / PO Assigned-SO
     (includeUndated=true) computed over two different demand sets, breaking
     po-so-coverage.ts's "ONE allocation, both sides" claim. Now there is ONE
     allocation, always over the FULL active set — undated lines sort LAST
     (null dates sort after every real date, see byDateAsc), so they can never
     take supply from a dated line and every dated line's coverage is IDENTICAL
     under both flag values. `includeUndated` only controls whether undated
     rows appear in the RESULT (visibility, not math). */
  const demandActive = ((demandRaw ?? []) as unknown as DemandRow[]).filter(
    (r) => r.item_code && r.so && !SO_DONE.has(r.so.status) && !isDocumentHeld(r.so) && isReleased(r) && r.qty > 0,
  );
  const isDatedLine = (r: DemandRow): boolean => deliveryOf(r) !== null;

  /* Delivered from the DO lines embedded in the demand read (lib/mrp-delivered.ts,
     HC-0002): the number soDeliverableRemaining gives, without re-reading every
     open order in 200-doc batches (~70 of the engine's ~90 round trips). The
     batched reading stays as the fallback and as `nettingCheck`'s yardstick —
     200 docs per call keeps each `.in()` request line under the gateway limit
     (~2,800 open orders would be a ~500KB URL), and the batches run BOUNDED
     because Hyperdrive pools a finite number of connections. */
  const demandDocNos = [...new Set(demandActive.map((d) => d.doc_no).filter(Boolean))];
  const deliveredBatched = async (): Promise<Map<string, number>> => {
    const docBatches: string[][] = [];
    for (let i = 0; i < demandDocNos.length; i += 200) docBatches.push(demandDocNos.slice(i, i + 200));
    const out = new Map<string, number>();
    for (const part of await mapBounded(docBatches, MRP_READ_CONCURRENCY, (batch) => soDeliverableRemaining(sb, batch))) {
      for (const [soItemId, d] of part) out.set(soItemId, d.delivered);
    }
    return out;
  };
  const demandDocSet = new Set(demandDocNos);
  const delivered = deliveredEmbedded
    ? deliveredBySoItemFrom(demandRaw as unknown as MrpDemandLine[], demandDocSet, await readUnlinkedDoLines(sb, scoped, demandDocSet))
    : await deliveredBatched();
  const deliveredOf = (soItemId: string): number => Math.max(0, delivered.get(soItemId) ?? 0);
  let nettingCheck: NettingCheck | undefined;
  if (opts.nettingCheck && deliveredEmbedded) {
    const batched = await deliveredBatched();
    nettingCheck = compareDelivered(demandActive, (id) => Math.max(0, batched.get(id) ?? 0), deliveredOf);
  }
  const effQtyOf = (r: DemandRow): number => Math.max(0, r.qty - deliveredOf(r.id));
  const demand = demandActive.filter((r) => effQtyOf(r) > 0);

  await enrichLinesWithFabricSupplierCode(
    sb,
    { get: (k: unknown) => (k === 'companyId' ? companyId ?? undefined : undefined) },
    demand as unknown as Array<Record<string, unknown>>,
  );

  const prodByCode = new Map<string, ProductRow>();
  const demandCodes = [...new Set(demand.map((d) => d.item_code).filter((c): c is string => !!c))];
  /* `.filter(… 'in', pgrestInList(batch))`, not `.in('code', batch)` — this is
     the read whose gap docs/bugs/0777 left open ("why prodByCode lacks those
     eight codes at all"). It is the SAME batching over the SAME code list as the
     supplier read, so it loses the SAME codes for the same reason: supabase-js
     cannot serialise an item code carrying a `"`, and everything after such a
     code in its batch silently matches nothing. All eight of 0777's codes are in
     the 38 the supplier map lost (run 34457477642). See lib/pgrest-in-list.ts. */
  const { data: prods, error: prodErr } = await chunkIn<ProductRow>(demandCodes, (batch, from, to) => scoped(sb
    .from('mfg_products')
    .select('code, name, category')
    .filter('code', 'in', pgrestInList(batch)))
    .order('id')
    .range(from, to));
  if (prodErr) throw new Error(`mrp_load_failed: ${prodErr.message}`);
  for (const p of prods) prodByCode.set(p.code, p);

  const categorySet = new Set<string>();
  const { data: catRows, error: catErr } = (await catRowsProm)();
  if (catErr) throw new Error(`mrp_load_failed: ${catErr.message}`);
  for (const c of catRows ?? []) {
    if (c.category) categorySet.add(c.category);
  }

  const { data: warehouses } = await scoped(sb
    .from('warehouses')
    .select('id, code, name')
    .eq('is_active', true))
    .order('code');
  const whById = new Map<string, { code: string; name: string }>();
  for (const w of (warehouses ?? []) as Array<{ id: string; code: string; name: string }>) {
    whById.set(w.id, { code: w.code, name: w.name });
  }

  /* ── THE WAREHOUSE FOLLOWS THE SALES ORDER (owner 2026-07-31) ─────────────
     "我们的 item 都不会有仓库, 还是跟着 SO 的" — a line never carries a warehouse
     of its own; the warehouse comes from the Sales Order. Several write paths
     insert a line with warehouse_id NULL (the amendment ADD line, the auto
     free-gift line), and imported history has them too, so the SAME order split
     into two MRP rows: the bound lines under their warehouse and the NULL ones
     under the WH_NONE bucket (Mrp.tsx keys every group on
     `${warehouseId ?? WH_NONE}|…`).

     Resolved HERE, server-side, so every consumer of computeMrp — the MRP page,
     the SO detail's coverage, po-so-coverage's reverse map — sees one answer.
     Papering over it in the UI would leave the backend's own allocation still
     split across two buckets.

     Only the SO's OWN header is consulted (see lib/so-warehouse.ts): never a
     SIBLING LINE's warehouse, because that would pool stock across the very
     warehouse boundary the null bucket exists to keep apart. `warehouses` is
     already loaded above; only the small state-mapping table is new, and it is
     read ONCE for the whole computation, not per line. */
  const soWarehouseMasters: SoWarehouseMasters = {
    warehouses: (warehouses ?? []) as Array<{ id: string; code: string; name: string }>,
    stateMappings: ((await scoped(
      sb.from('state_warehouse_mappings').select('state, warehouse_id'),
    )).data ?? []) as Array<{ state: string | null; warehouse_id: string | null }>,
  };
  for (const d of demand) {
    d.warehouse_id = resolveLineWarehouseId(d.warehouse_id, d.so, soWarehouseMasters);
  }

  const { data: balances, error: balErr } = (await balancesProm)();
  if (balErr) throw new Error(`mrp_load_failed: ${balErr.message}`);
  const stockByKey = new Map<string, number>();
  for (const b of balances ?? []) {
    const k = bucketOf(b.warehouse_id ?? null, b.item_code, b.variant_key ?? '');
    stockByKey.set(k, (stockByKey.get(k) ?? 0) + (b.qty ?? 0));
  }

  const { data: poRaw, error: poErr } = (await poRawProm)();
  if (poErr) throw new Error(`mrp_load_failed: ${poErr.message}`);
  type PoSupply = { poNumber: string; eta: string | null; qtyLeft: number; supplierId: string | null };
  const poByKey = new Map<string, PoSupply[]>();
  const poOutstandingByKey = new Map<string, number>();
  const poSupplierIds = new Set<string>();
  const poDrafts: PoSupplyEntry[] = [];
  /* ── DEDICATED SUPPLY (owner 2026-08-31, option 甲; company 1 only) ─────────
     A company-1 bedframe or `(SP)` mattress line is EXCLUSIVELY bound to its own
     purchase order in the stored allocator (`HARD_BOUND_COMPANY_ID`, bug 0572) —
     it lights from that PO's receipt and never from the pool. MRP did not know
     that, so it planned the same line against pooled stock and pooled PO supply,
     and the two engines answered differently about the same order.

     Which one was wrong was not a matter of taste: the AutoCount stock snapshot
     carries NO variant, so every migrated bedframe unit sits under a BLANK
     variant key while its sales-order line carries colour + heights. MRP's
     bucket key is exact, so the typed demand found an empty bucket and reported
     a shortage for goods that are physically in the warehouse and already
     spoken for. Owner: 「甲 可是针对的是 co1 而已 目前而已」.

     So the binding is honoured on BOTH sides here:
       · a bound PO line is DEDICATED — removed from the pool, because it belongs
         to one sales-order line and cannot cover anybody else's;
       · a bound demand line draws only from its own PO (received first, then its
         outstanding quantity), and the units it takes from a receipt are
         DECREMENTED from the pooled bucket so nothing is counted twice.

     SOFA IS HERE TOO SINCE 2026-09-09, and the sentence that used to stand in
     this paragraph — "SOFA IS DELIBERATELY NOT HERE … excluding sofa PO lines
     from the pool without rewriting that walk would starve it" — was correct
     about the mechanism and is what the rewrite in section 8 discharges. It read
     as a design choice; it was a piece of work not yet done, and leaving it
     undone made this page ask the owner to buy sofas standing in his warehouse.

     WHAT IT COST, measured on the live page 2026-09-09 (owner: "你确定在 MRP 显
     示出来的 sofa 跟 bed frame 都是 short、需要 order 的吗?"). The sofa tab asked
     for 70 units across 28 sales orders. Only 42 were really missing. Eight of
     those orders — 26 units — had their OWN purchase order fully received, and
     26 of those very lines read READY on the sales-order screen at the same
     moment. The STOCK column read 0 on all 136 sofa rows while 246 units of
     company-1 sofa sat in the warehouse. Bedframe, which went dedicated in
     docs/bugs/0736, was right to the unit on the same page: 50 short, and 50
     lines with no purchase order.

     The reason sofa was that much worse is the variant key. A fully received PO
     leaves nothing outstanding (`left <= 0` below), so before this change its
     receipt reached section 8 only through the pooled STOCK bucket — and sofa's
     key is fabricCode|seatHeight|legHeight|specials, four free-text fields that
     the order and the receipt spell differently far more often than not:

       HC-SO-011008 asks   fabriccode=modenza-01|seatheight=32|special=nylon fabric
       HC-PO-009881 landed fabriccode=modenza-06|seatheight=32|special=bottom wrap by nylon fabric,nylon fabric

     THE READINESS ENGINE WAS ALREADY DOING THIS. `isHardBoundLine` has named
     sofa a bound group since 2026-08-10 and `so-stock-allocation.ts` honours it.
     Measured on prod: of 1,240 open company-1 sofa lines, ZERO read READY
     without their own purchase order and ZERO carry a batch claim without one.
     So this is MRP catching up with the allocator, not a new rule — and it can
     take coverage away from no line the allocator currently lights. */
  const dedicatedReceivedByLine = new Map<string, number>();
  const dedicatedOpenByLine = new Map<string, PoSupply[]>();
  const boundCompany = companyId === HARD_BOUND_COMPANY_ID;
  /* EITHER SIDE BEING BOUND DEDICATES THE LINK (2026-09-15, owner 「我们明明已经开了
     PO，可是它又显示着 shortage」). This read the PO line's group alone, while the
     stored allocator binds by the SALES line's group and never looks at the PO's.
     So a link whose two lines disagree on category went SHORT here with the PO
     open: a bound PO on an unbound sales line was withheld from the pool the line
     reads (live: HC-PO-010086 SQUARE PILLOW `fabric_accessory` on HC-SO-013346
     `accessory`, the day after the pillows changed category), and an unbound PO on
     a bound sales line sat in a pool the line never reads. Every linked line now
     reads its own dedicated queue first (section 7), whichever side is bound. */
  const demandBoundById = new Set(
    demandActive.filter((d) => isHardBoundLine(d.item_group, d.item_code)).map((d) => d.id),
  );
  const isDedicated = (r: PoLineRow): boolean =>
    boundCompany
    && !!r.so_item_id
    && (isHardBoundLine(r.item_group, r.item_code) || demandBoundById.has(String(r.so_item_id)));
  const poRaisedFor = new Map<string, Set<string>>();
  for (const r of (poRaw ?? []) as unknown as PoLineRow[]) {
    if (!r.po || PO_DEAD.has(r.po.status)) continue;
    if (r.so_item_id) {
      const ids = poRaisedFor.get(r.po.po_number) ?? new Set<string>();
      ids.add(String(r.so_item_id));
      poRaisedFor.set(r.po.po_number, ids);
    }
    const rr = r as unknown as Record<string, string | null | undefined>;
    const poh = r.po as unknown as Record<string, string | null | undefined>;
    const lineEta = effectiveDelivery(
      r.delivery_date,
      rr.supplierDeliveryDate2 ?? r.supplier_delivery_date_2,
      rr.supplierDeliveryDate3 ?? r.supplier_delivery_date_3,
      rr.supplierDeliveryDate4 ?? r.supplier_delivery_date_4,
    );
    const headerEta = effectiveDelivery(
      r.po.expected_at,
      poh.supplierDeliveryDate2 ?? r.po.supplier_delivery_date_2,
      poh.supplierDeliveryDate3 ?? r.po.supplier_delivery_date_3,
      poh.supplierDeliveryDate4 ?? r.po.supplier_delivery_date_4,
    );
    const eta = lineEta ?? headerEta ?? null;
    const left = (r.qty ?? 0) - (r.received_qty ?? 0);
    if (isDedicated(r)) {
      const soItemId = String(r.so_item_id);
      const got = Number(r.received_qty ?? 0);
      if (got > 0) dedicatedReceivedByLine.set(soItemId, (dedicatedReceivedByLine.get(soItemId) ?? 0) + got);
      if (left > 0) {
        const open = dedicatedOpenByLine.get(soItemId) ?? [];
        open.push({ poNumber: r.po.po_number, eta, qtyLeft: left, supplierId: r.po.supplier_id ?? null });
        dedicatedOpenByLine.set(soItemId, open);
        if (r.po.supplier_id) poSupplierIds.add(r.po.supplier_id);
      }
      continue;
    }
    if (left <= 0) continue;
    const poWh = r.warehouse_id ?? r.po.purchase_location_id ?? null;
    if (whFilter && poWh !== whFilter) continue;
    const k = bucketOf(poWh, r.item_code, variantKeyOf(r.item_group, r.variants));
    poDrafts.push({
      bucketKey: k, poNumber: r.po.po_number, eta, qtyLeft: left, supplierId: r.po.supplier_id ?? null,
    });
    if (r.po.supplier_id) poSupplierIds.add(r.po.supplier_id);
  }

  const committed = new Map<string, OutstandingCommitment>();
  for (const c of (await loadCommittedShipments(sb, scoped, poDrafts.map((d) => d.poNumber))).values()) {
    const bucketKey = bucketOf(c.warehouseId, c.itemCode, c.variantKey);
    const k = commitmentKey(bucketKey, c.batchNo);
    committed.set(k, { ...c, bucketKey, qty: (committed.get(k)?.qty ?? 0) + c.qty });
  }
  const supply = applyCommittedSupply(poDrafts, committed);
  const unmatchedCommitments: UnmatchedCommitment[] = supply.unmatched.map((u) => ({
    warehouseId: u.warehouseId,
    warehouseCode: u.warehouseId ? (whById.get(u.warehouseId)?.code ?? null) : null,
    itemCode: u.itemCode,
    variantKey: u.variantKey,
    poNumber: u.batchNo,
    qty: u.qty,
  }));
  if (unmatchedCommitments.length > 0) {
    /* eslint-disable-next-line no-console */
    console.warn('[mrp] committed shipments with no open PO supply to deduct from:',
      unmatchedCommitments.map((u) => `${u.itemCode} x${u.qty} vs ${u.poNumber}`).join('; '));
  }
  for (const [bucketKey, addBack] of supply.stockAddBack) {
    stockByKey.set(bucketKey, (stockByKey.get(bucketKey) ?? 0) + addBack);
  }
  for (const e of supply.entries) {
    const arr = poByKey.get(e.bucketKey) ?? [];
    arr.push({ poNumber: e.poNumber, eta: e.eta, qtyLeft: e.qtyLeft, supplierId: e.supplierId });
    poByKey.set(e.bucketKey, arr);
    poOutstandingByKey.set(e.bucketKey, (poOutstandingByKey.get(e.bucketKey) ?? 0) + e.qtyLeft);
  }

  const batchClaims = collectBatchClaims(demand.map((d) => ({
    soItemId: d.id,
    bucketKey: bucketOf(d.warehouse_id ?? null, d.item_code, variantKeyOf(d.item_group, d.variants)),
    allocatedBatchNo: d.allocated_batch_no
      ?? (d as unknown as Record<string, string | null>).allocatedBatchNo ?? null,
    remainingQty: effQtyOf(d),
  })));

  const supplierNameById = new Map<string, string>();
  if (poSupplierIds.size > 0) {
    const { data: poSups, error: supErr } = await chunkIn<{ id: string; name: string }>(
      [...poSupplierIds],
      (batch, from, to) => scoped(sb.from('suppliers').select('id, name').in('id', batch)).order('id').range(from, to),
    );
    if (supErr) throw new Error(`mrp_load_failed: ${supErr.message}`);
    for (const s of poSups) supplierNameById.set(s.id, s.name);
  }
  for (const arr of poByKey.values()) arr.sort((a, b) => byDateAsc(a.eta, b.eta));

  type SupplierOpt = { supplierId: string; code: string; name: string; isMain: boolean };
  const codes = [...new Set(demand.map((d) => d.item_code))];
  const mainByCode = new Map<string, { id: string; code: string; name: string }>();
  const suppliersByCode = new Map<string, SupplierOpt[]>();
  if (codes.length > 0) {
    type BindRow = { item_code: string; is_main_supplier: boolean; supplier_id: string; supplier: { code: string; name: string } | Array<{ code: string; name: string }> | null };
    const { data: binds, error: bindErr } = await readMfgProductBindings<BindRow>(sb, {
      codes,
      companyId,
      select: 'item_code, is_main_supplier, supplier_id, supplier:suppliers(code, name)',
    });
    if (bindErr) throw new Error(`mrp_load_failed: ${bindErr.message}`);
    for (const b of binds) {
      const s = Array.isArray(b.supplier) ? b.supplier[0] : b.supplier;
      if (!s) continue;
      const arr = suppliersByCode.get(b.item_code) ?? [];
      arr.push({ supplierId: b.supplier_id, code: s.code, name: s.name, isMain: b.is_main_supplier });
      suppliersByCode.set(b.item_code, arr);
      if (!mainByCode.has(b.item_code)) mainByCode.set(b.item_code, { id: b.supplier_id, code: s.code, name: s.name });
    }
  }

  /* HC-0128 — NB-series fabrics (Fabric Converter) route to NB FURNITURE. A
     failed read fails the plan like every other read here: an empty set would
     silently send NB lines to the main supplier. */
  const nbFabricCodes = new Set<string>();
  {
    const { data: nbFabrics, error: nbErr } = (await nbFabricsProm)();
    if (nbErr) throw new Error(`mrp_load_failed: ${nbErr.message}`);
    for (const f of (nbFabrics ?? []) as Array<{ fabric_code: string | null }>) {
      if (f.fabric_code) nbFabricCodes.add(f.fabric_code.trim().toUpperCase());
    }
  }
  const nbSupplierIdOf = (code: string): string | null =>
    suppliersByCode.get(code)?.find((s) => s.code === NB_SUPPLIER_CODE)?.supplierId ?? null;

  type Bucket = { whId: string | null; code: string; vkey: string; vlabel: string; rows: DemandRow[] };
  const catFromGroup = (g: string | null | undefined): string | null => {
    const s = (g ?? '').trim().toUpperCase();
    if (s.includes('BEDFRAME')) return 'BEDFRAME';
    if (s.includes('SOFA')) return 'SOFA';
    if (s.includes('MATTRESS')) return 'MATTRESS';
    if (s.includes('ACCESSOR')) return 'ACCESSORY';
    if (s.includes('SERVICE')) return 'SERVICE';
    return null;
  };

  /* HC-0128 — once one bedframe of an SO goes to NB, every bedframe of that SO
     does too: two makers' bedframes side by side get compared by the customer
     (Sim 2026-10-20). Decided over ALL of the SO's open lines, so a line already
     on an NB PO still pulls its shortage siblings along. */
  const isBedframeLine = (r: DemandRow): boolean =>
    (prodByCode.get(r.item_code)?.category ?? catFromGroup(r.item_group)) === 'BEDFRAME';
  const nbBedframeDocs = new Set(
    demand
      .filter((r) => isBedframeLine(r) && nbSupplierIdOf(r.item_code) && needsNbSupplier(r.variants, nbFabricCodes))
      .map((r) => r.doc_no),
  );
  const ruleSupplierIdOf = (r: DemandRow): string | null => {
    const nb = nbSupplierIdOf(r.item_code);
    if (!nb) return null;
    if (needsNbSupplier(r.variants, nbFabricCodes)) return nb;
    return isBedframeLine(r) && nbBedframeDocs.has(r.doc_no) ? nb : null;
  };
  const demandByKey = new Map<string, Bucket>();
  for (const d of demand) {
    const prod = prodByCode.get(d.item_code);
    const cat = prod?.category ?? catFromGroup(d.item_group);
    if (isServiceLine({ itemGroup: d.item_group, itemCode: d.item_code, category: cat })) continue;
    if (catFilter && cat !== catFilter) continue;
    if (cat === 'SOFA') continue;
    if (whFilter && (d.warehouse_id ?? null) !== whFilter) continue;
    const whId = d.warehouse_id ?? null;
    const vkey = variantKeyOf(d.item_group, d.variants);
    const k = bucketOf(whId, d.item_code, vkey);
    const bucket = demandByKey.get(k)
      ?? { whId, code: d.item_code, vkey, vlabel: buildVariantSummary(d.item_group, d.variants), rows: [] };
    bucket.rows.push(d);
    demandByKey.set(k, bucket);
  }

  let undatedLines = 0;
  let undatedShortageUnits = 0;
  let undatedSofaSets = 0;
  let undatedSofaShortageUnits = 0;

  const skus: MrpSku[] = [];
  for (const [k, bucket] of demandByKey.entries()) {
    const { whId, code, vlabel, rows } = bucket;
    const prod = prodByCode.get(code);
    rows.sort((a, b) => {
      const byDate = byDateAsc(deliveryOf(a), deliveryOf(b));
      if (byDate !== 0) return byDate;
      return (a.doc_no ?? '').localeCompare(b.doc_no ?? '');
    });

    const bucketStock = openBucketStock(stockByKey.get(k) ?? 0, batchClaims.qtyByBucket.get(k) ?? 0);
    /* Clone PO supply so the greedy walk can mutate qtyLeft without touching the
       shared map. SUPPLY IS THIS BUCKET'S OWN PO LINES AND NOTHING ELSE.

       There used to be a fallback here (and a twin in section 8) that folded the
       same-warehouse EMPTY-variant ('') PO pool into a specific-variant bucket
       whenever that bucket had no PO of its own:

           const legacyKey = composite(whId, code, '');
           const useLegacy = bucket.vkey !== '' && legacyKey !== k && ownPo.length === 0;

       It is gone (owner, 2026-08-16). He was asked twice and ruled the same way
       both times — 「variant 不一样的话 应该不能拿来给那个SO 用不是吗?」 and
       「我们要求不是全部variant 全部spec都相同才是一样的东西?」 A purchase order
       whose variants differ is not the goods this sales-order line asked for, so
       it cannot cover it. Same-thing means EVERY variant and spec matches, which
       is exactly what the bucket key already encodes.

       The fallback also made this engine self-inconsistent, which is the part
       that shows up as a wrong number rather than a wrong policy. Stock has
       never had a fallback (`stockByKey.get(k)` on the line above — the exact
       key, no '' lookup), so demand, stock and supply now finally agree on what
       counts as the same thing. While it stood, a bedframe SO line for a
       specific fabric/gap/divan/leg read as covered by a PO for an unspecified
       bedframe, and the shortage that should have driven a purchase was hidden.

       ONE THING THIS DELIBERATELY DOES NOT DO: re-derive `item_group` from the
       product master to rescue a line whose group is NULL. `variantKeyOf` maps a
       null/unknown group through `ATTRS_BY_GROUP[group] ?? []`, so such a line
       emits no attributes and keys to '' even when it carries a real fabric —
       and that is true on BOTH sides here, demand and PO alike. Deriving the
       group would fix two of the three sides and break the third: stock's key is
       not computed here at all, it is the STORED inventory_balances.variant_key,
       written at movement time from whatever group that movement carried. MRP
       cannot re-derive that without re-writing history, so a derivation would
       move demand and supply off the stock they are supposed to match, and make
       this page disagree with every other consumer of computeVariantKey (GRN,
       DO, POS, the frontend). Null-group lines therefore keep bucketing exactly
       as they did before this change — mis-grouped, but mis-grouped IDENTICALLY
       on all three sides, which is the only property that keeps the arithmetic
       honest. Fixing the null groups themselves is a data repair, not a planning
       change. */
    const ownPo = poByKey.get(k) ?? [];
    const poQueue: PoSupply[] = ownPo.map((p) => ({ ...p })).sort((a, b) => byDateAsc(a.eta, b.eta));

    const lines: MrpLine[] = [];
    let qtyNeeded = 0;
    for (const r of rows) {
      const eff = effQtyOf(r);
      let need = eff;
      /* BOUND LINE (company 1, bedframe / `(SP)` mattress / custom pillow). Drawn at
         STOCK, and only at stock, and the distinction is the whole design:

           · STOCK IS A CLAIM ON GOODS THAT EXIST. The stored allocator decides
             READY/PENDING from it, and for company 1 it decides that a bound line
             lights only from its OWN received purchase order (bug 0572). So here
             a bound line takes its own receipt and never the bucket — which is
             what stops the migrated blank-variant units from covering a typed
             line that will never actually be handed them, and equally what stops
             a shortage being reported for goods already received on its own PO.
           · A PURCHASE ORDER IS A PLAN. MRP exists to answer "what must I buy",
             and a purchase order already on order for this exact bucket is a
             legitimate answer to "you do not need to buy this again" — but ONLY
             where that purchase order can actually become this line's supply.

         SO A BOUND LINE IS OFFERED ITS OWN DEDICATED PO AND NOTHING ELSE (owner
         2026-09-09, "修,但只能动 Houzs Century"). This used to fall through to the
         pooled queue after the dedicated one, and that produced the exact mirror
         of bug 0572 on the other screen: MRP reported the line as covered by a
         purchase order belonging to nobody, while the stored allocator — which
         accepts only the line's OWN purchase order — left it PENDING for ever.
         The buyer read "already on order", the order never moved, and nothing
         said so. Measured on prod 2026-09-09: 10 of the 126 proceeded company-1
         bedframe/sofa lines carrying no purchase order of their own were masked
         this way.

         THE OBJECTION THIS REPLACES, AND WHY IT NO LONGER STANDS. The previous
         comment kept the pooled fallback because removing it made
         `po-so-coverage` (layer c, the inverted MRP coverage) answer that an
         unlinked purchase order serves nobody — the screen the buyer uses to see
         who a PO is for. That reasoning was right about the mechanism and never
         measured its scale. The population it protects is every company-1 OPEN,
         UNLINKED purchase-order line on a hard-bound item, and on prod
         2026-09-09 that is FIVE lines on TWO purchase orders — `HC-PO-009024`
         and `HC-PO-010085` — neither carrying a "From SOs" provenance note, and
         both already on the repair list for the same underlying reason (their
         lines should be linked to the sales order they were raised for;
         docs/mrp-stock-vs-bound-rules-2026-09-09.md §3). A layer-(c) guess that
         the readiness engine will never honour is not worth keeping for two
         documents that need a layer-(b) link anyway.

         POOLED SUPPLY IS STILL REPORTED, which is the part that keeps the page
         honest: `poOutstanding` on the SKU row still counts that purchase order.
         What changes is only that it may no longer be named as THIS line's
         cover, so the line reads as the shortage it is. Company 2 is untouched —
         `boundCompany` gates the whole branch. */
      const bound = boundCompany && isHardBoundLine(r.item_group, r.item_code);
      const fromStock = bound
        ? Math.min(need, dedicatedReceivedByLine.get(r.id) ?? 0)
        : drawBucketStock(bucketStock, batchClaims.qtyByLine.get(r.id) ?? 0, need);
      need -= fromStock;

      let poNumber: string | null = null;
      let poEta: string | null = null;
      let poSupplierId: string | null = null;
      const queues = bound
        ? [dedicatedOpenByLine.get(r.id) ?? []]
        : [dedicatedOpenByLine.get(r.id) ?? [], poQueue];
      for (const queue of queues) {
        while (need > 0 && queue.length > 0) {
          const front = queue[0];
          if (!front) break;
          const take = Math.min(front.qtyLeft, need);
          if (poNumber == null) { poNumber = front.poNumber; poEta = front.eta; poSupplierId = front.supplierId; }
          front.qtyLeft -= take;
          need -= take;
          if (front.qtyLeft <= 0) queue.shift();
        }
      }

      if (!isDatedLine(r)) {
        undatedLines += 1;
        undatedShortageUnits += need;
        if (!includeUndated) continue;
      }
      qtyNeeded += eff;

      const source: AllocSource = allocSourceOf(need, poNumber);
      const lineDelivery = deliveryOf(r);
      lines.push({
        soItemId: r.id,
        soDocNo: r.doc_no,
        debtorName: r.so?.debtor_name ?? null,
        customerState: r.so?.customer_state ?? null,
        soDate: r.so?.so_date ?? null,
        deliveryDate: lineDelivery,
        processingDate: r.so?.processing_date ?? null,
        orderByDate: orderByOf(lineDelivery, prod?.category ?? null, whId, mainByCode.get(code)?.id ?? null, mainByCode.get(code)?.code ?? null),
        qty: eff,
        source,
        poNumber,
        poEta,
        shortageQty: need,
        stockQty: fromStock,
        poSupplierId: source === 'po' ? poSupplierId : null,
        poSupplierName: source === 'po' && poSupplierId ? (supplierNameById.get(poSupplierId) ?? null) : null,
        ruleSupplierId: ruleSupplierIdOf(r),
      });
    }

    if (lines.length === 0) continue;

    const stock = stockByKey.get(k) ?? 0;
    const poOutstanding = poOutstandingByKey.get(k) ?? 0;
    const shortage = lines.reduce((acc, l) => acc + l.shortageQty, 0);
    const main = mainByCode.get(code);
    const wh = whId ? whById.get(whId) : null;
    skus.push({
      warehouseId: whId,
      warehouseCode: wh?.code ?? null,
      warehouseName: wh?.name ?? null,
      itemCode: code,
      variantKey: bucket.vkey,
      variantLabel: vlabel || null,
      description: prod?.name ?? rows[0]?.description ?? null,
      /* THE SAME EXPRESSION THE FILTER USED, and it has to be — §6 keeps a line
         on `prod?.category ?? catFromGroup(d.item_group)`, so a line whose
         item_code is not in mfg_products is kept on its GROUP and was then
         emitted here as `?? null`. The frontend picks a tab's rows with
         `s.category === VIEW_CATEGORY[view]`, so an uncategorised row belongs to
         no tab and disappears from all four — while `qtyNeeded` on it proves the
         engine had planned it the whole time.
         Measured on prod 2026-09-10: EIGHT accessory codes, 62 dated open lines,
         110 units, absent from the page and present in the stored snapshot
         (docs/bugs/0777). Owner: 「除了 Category Service 不需要进来，其他基本上都
         需要」 — and silent disappearance is the half that is only found on
         delivery day.
         catFromGroup exists for exactly this case; its own comment (Wei Siang
         2026-06-16) says "so the demand still SHOWS under its category tab
         instead of silently vanishing". This emit site simply never called it.
         Still `null` when the group maps to nothing — that is honest, not a
         guess, and the filter let such a line through on the same reasoning. */
      category: prod?.category ?? rows.map((r) => catFromGroup(r.item_group)).find((c) => c !== null) ?? null,
      qtyNeeded,
      stock,
      poOutstanding,
      shortage,
      mainSupplierCode: main?.code ?? null,
      mainSupplierName: main?.name ?? null,
      suppliers: suppliersByCode.get(code) ?? [],
      lines,
    });
  }

  // Shortage SKUs first, then by code + variant — so the rows that need
  // ordering float to the top (the orange ones the commander acts on).
  // Commander 2026-05-29 — within the shortage group, the soonest ORDER-BY date
  // floats to the top ("插队": most-urgent-to-order first), then code/variant.
  const earliestOrderBy = (s: MrpSku): string | null =>
    s.lines.reduce<string | null>((min, l) => (l.orderByDate && (!min || l.orderByDate < min) ? l.orderByDate : min), null);
  skus.sort((a, b) => {
    if ((b.shortage > 0 ? 1 : 0) !== (a.shortage > 0 ? 1 : 0)) {
      return (b.shortage > 0 ? 1 : 0) - (a.shortage > 0 ? 1 : 0);
    }
    const byOrderBy = byDateAsc(earliestOrderBy(a), earliestOrderBy(b));
    if (byOrderBy !== 0) return byOrderBy;
    if (a.itemCode !== b.itemCode) return a.itemCode < b.itemCode ? -1 : 1;
    return (a.variantLabel ?? '') < (b.variantLabel ?? '') ? -1 : 1;
  });

  // ── 8. Sofa SETS — one per SO line ("每张 SO 一套"). ────────────────────
  // Commander 2026-05-31 — sets draw from the SAME pooled (warehouse, code,
  // variant) stock+PO supply as section 7, greedy by delivery date. Group the
  // sofa demand into per-bucket queues so two sets sharing a fabric+seat+leg
  // bucket compete for one stock pool (the variant key ignores module layout).
  const sstr = (v: unknown): string => (v == null ? '' : String(v).trim());
  type SofaBucket = { whId: string | null; code: string; vkey: string; rows: DemandRow[] };
  const sofaByKey = new Map<string, SofaBucket>();
  for (const d of demand) {
    const sofaCat = prodByCode.get(d.item_code)?.category ?? catFromGroup(d.item_group);
    if (sofaCat !== 'SOFA') continue;
    if (whFilter && (d.warehouse_id ?? null) !== whFilter) continue;
    const whId = d.warehouse_id ?? null;
    const vkey = variantKeyOf(d.item_group, d.variants);
    const k = bucketOf(whId, d.item_code, vkey);
    const bucket = sofaByKey.get(k) ?? { whId, code: d.item_code, vkey, rows: [] };
    bucket.rows.push(d);
    sofaByKey.set(k, bucket);
  }

  const sofaSets: SofaSet[] = [];
  const sofaPlanByLine = new Map<string, SofaPlan>();
  const lockOf = (d: DemandRow): string | null =>
    d.allocated_batch_no ?? (d as unknown as Record<string, string | null>).allocatedBatchNo ?? null;

  if (boundCompany) {
    for (const bucket of sofaByKey.values()) {
      for (const d of bucket.rows) {
        let need = effQtyOf(d);
        const fromStock = Math.min(need, dedicatedReceivedByLine.get(d.id) ?? 0);
        need -= fromStock;
        let poNumber: string | null = null;
        let poEta: string | null = null;
        let poSupplierId: string | null = null;
        const queue = dedicatedOpenByLine.get(d.id) ?? [];
        while (need > 0 && queue.length > 0) {
          const front = queue[0];
          if (!front) break;
          const take = Math.min(front.qtyLeft, need);
          if (poNumber == null) { poNumber = front.poNumber; poEta = front.eta; poSupplierId = front.supplierId; }
          front.qtyLeft -= take;
          need -= take;
          if (front.qtyLeft <= 0) queue.shift();
        }
        sofaPlanByLine.set(d.id, { fromStock, need, poNumber, poEta, poSupplierId, batchNo: poNumber });
      }
    }
  } else if (sofaByKey.size > 0) {
    /* THE SET WALK — company 2's pooled sofa model, planned the way it SHIPS:
       one batch (= one PO) covers the whole set or nothing does. Owner
       2026-10-05 on 2990-SO-2610-005: 「不能跨批次 1PO = 1batch 不能分开」. The
       rule, its four arms and the lock carve live in lib/sofa-set-plan.ts;
       this block only hands it the engine's lines, lots and PO supply. */
    const setLines: SofaSetLine[] = [];
    for (const [k, bucket] of sofaByKey) {
      for (const d of bucket.rows) {
        setLines.push({
          soItemId: d.id, docNo: d.doc_no, bucketKey: k, whId: bucket.whId, code: bucket.code, vkey: bucket.vkey,
          need: effQtyOf(d), lockedBatchNo: lockOf(d), delivery: deliveryOf(d),
        });
      }
    }
    const lots = await loadSofaBatchStock(sb, [...new Set(setLines.map((l) => l.code))]);
    /* A bucket's OWN PO lines only (no '' fallback — owner 2026-08-16), cloned
       so the walk's decrements never touch the shared map. */
    const poByBucket = new Map<string, SofaSetPoSupply[]>();
    for (const k of sofaByKey.keys()) {
      const own = poByKey.get(k);
      if (own && own.length > 0) poByBucket.set(k, own.map((p) => ({ ...p })));
    }
    for (const [id, plan] of planSofaSets(setLines, lots, poByBucket, poRaisedFor)) sofaPlanByLine.set(id, plan);
  }

  for (const [, bucket] of sofaByKey.entries()) {
    const { whId, rows } = bucket;
    const wh = whId ? whById.get(whId) : null;
    for (const d of rows) {
      const v = (d.variants ?? {}) as Record<string, unknown>;
      const cells = Array.isArray(v.cells) ? (v.cells as Array<{ moduleId?: string }>) : [];
      const modules = cells.length > 0
        ? cells.map((c) => sstr(c.moduleId)).filter(Boolean)
        : [sstr(splitSofaCode(d.item_code).sizeCode)].filter(Boolean);
      const colour = [sstr(v.fabricCode), sstr(v.colorCode) || sstr(v.colourCode)].filter(Boolean).join(' ');
      const eff = effQtyOf(d);
      const prod = prodByCode.get(d.item_code);
      const setDelivery = deliveryOf(d);
      const plan = sofaPlanByLine.get(d.id)
        ?? { fromStock: 0, need: eff, poNumber: null, poEta: null, poSupplierId: null, batchNo: null };
      const need = plan.need;
      const ordered = eff - need;

      if (!isDatedLine(d)) {
        undatedSofaSets += 1;
        undatedSofaShortageUnits += need;
        if (!includeUndated) continue;
      }

      sofaSets.push({
        variantKey: variantKeyOf(d.item_group, v),
        warehouseId: whId,
        warehouseCode: wh?.code ?? null,
        warehouseName: wh?.name ?? null,
        soItemId: d.id,
        soDocNo: d.doc_no,
        lineNo: d.line_no ?? null,
        createdAt: d.created_at ?? null,
        debtorName: d.so?.debtor_name ?? null,
        customerState: d.so?.customer_state ?? null,
        soDate: d.so?.so_date ?? null,
        deliveryDate: setDelivery,
        processingDate: d.so?.processing_date ?? null,
        orderByDate: orderByOf(setDelivery, prod?.category ?? null, whId, mainByCode.get(d.item_code)?.id ?? null, mainByCode.get(d.item_code)?.code ?? null),
        itemCode: d.item_code,
        description: prod?.name ?? d.description ?? null,
        variantLabel: buildVariantSummary(d.item_group, v) || null,
        modules,
        colour: colour || null,
        qty: eff,
        orderedQty: ordered,
        stockQty: plan.fromStock,
        shortageQty: need,
        poNumber: plan.poNumber,
        poEta: plan.poEta,
        poSupplierId: plan.poSupplierId,
        poSupplierName: plan.poSupplierId ? (supplierNameById.get(plan.poSupplierId) ?? null) : null,
        batchNo: plan.batchNo,
        suppliers: suppliersByCode.get(d.item_code) ?? [],
      });
    }
  }
  sofaSets.sort((a, b) => {
    const sa = a.shortageQty > 0 ? 1 : 0;
    const sb = b.shortageQty > 0 ? 1 : 0;
    if (sa !== sb) return sb - sa;
    return byDateAsc(a.orderByDate, b.orderByDate);
  });

  return {
    asOf: new Date().toISOString(),
    ...(nettingCheck ? { nettingCheck } : {}),
    categories: [...categorySet].sort(),
    warehouses: warehouses ?? [],
    skus,
    sofaSets,
    unmatchedCommitments,
    undated: {
      lines: undatedLines,
      shortageUnits: undatedShortageUnits,
      sofaSets: undatedSofaSets,
      sofaShortageUnits: undatedSofaShortageUnits,
      hidden: !includeUndated,
    },
    totals: {
      skuCount: skus.length,
      shortageSkuCount: skus.filter((s) => s.shortage > 0).length,
      shortageUnits: skus.reduce((acc, s) => acc + s.shortage, 0),
      sofaSetCount: sofaSets.length,
      sofaSetShortageCount: sofaSets.filter((s) => s.shortageQty > 0).length,
      unmatchedCommitmentUnits: unmatchedCommitments.reduce((acc, u) => acc + u.qty, 0),
    },
  };
}

export function mrpLineCoverage(result: MrpResult): Map<string, SoLineCoverage> {
  const map = new Map<string, SoLineCoverage>();
  for (const sku of result.skus) {
    for (const l of sku.lines) {
      map.set(l.soItemId, { source: l.source, po: l.poNumber, eta: l.poEta });
    }
  }
  for (const s of result.sofaSets) {
    const source: AllocSource = allocSourceCoveringPo(s.shortageQty, s.poNumber);
    map.set(s.soItemId, { source, po: s.poNumber, eta: s.poEta });
  }
  return map;
}

/* Owner 2026-07-25 (dead-stock view) — the STOCK side of the SAME floating
   allocation: for each (warehouse, item_code, variant_key) bucket, how many
   ON-HAND units MRP assigned to Sales-Order demand, and to WHICH SO(s). This is
   the source of truth for "assigned vs free" in the Stock Breakdown drawer:
   a lot is ASSIGNED iff MRP allocated on-hand stock to an SO; genuinely
   unallocated stock is FREE = a dead-stock candidate. Reuses computeMrp's single
   allocation (MrpLine.stockQty / SofaSet.stockQty) — NOT a second coverage calc
   and NOT the hard READY reservations the drawer used to reflect.

   `free` is NOT computed here: the drawer/endpoint derives it from the bucket's
   actual open-lot sum minus `assigned` (so the lot feed it displays and the free
   figure can never disagree). `claims` is per-SO, earliest-delivery first. */
export type MrpStockClaim = { soDocNo: string; deliveryDate: string | null; qty: number };
export type MrpStockAssignment = {
  warehouseId: string | null;
  itemCode: string;
  variantKey: string;
  assigned: number;
  claims: MrpStockClaim[];
};

export function stockAssignmentKey(
  warehouseId: string | null,
  itemCode: string,
  variantKey: string,
): string {
  return `${warehouseId ?? WH_NONE}|${itemCode}|${variantKey}`;
}

export function mrpStockAssignment(result: MrpResult): Map<string, MrpStockAssignment> {
  const map = new Map<string, MrpStockAssignment>();
  const add = (
    warehouseId: string | null,
    itemCode: string,
    variantKey: string,
    stockQty: number,
    soDocNo: string,
    deliveryDate: string | null,
  ): void => {
    if (!(stockQty > 0) || !itemCode || !soDocNo) return;
    const key = stockAssignmentKey(warehouseId, itemCode, variantKey);
    const bucket = map.get(key)
      ?? { warehouseId, itemCode, variantKey, assigned: 0, claims: [] as MrpStockClaim[] };
    bucket.assigned += stockQty;
    const existing = bucket.claims.find((cl) => cl.soDocNo === soDocNo);
    if (existing) {
      existing.qty += stockQty;
      if (deliveryDate && (!existing.deliveryDate || deliveryDate < existing.deliveryDate)) {
        existing.deliveryDate = deliveryDate;
      }
    } else {
      bucket.claims.push({ soDocNo, deliveryDate, qty: stockQty });
    }
    map.set(key, bucket);
  };
  for (const sku of result.skus) {
    for (const l of sku.lines) {
      add(sku.warehouseId, sku.itemCode, sku.variantKey, l.stockQty, l.soDocNo, l.deliveryDate);
    }
  }
  for (const s of result.sofaSets) {
    add(s.warehouseId, s.itemCode, s.variantKey, s.stockQty, s.soDocNo, s.deliveryDate);
  }
  for (const bucket of map.values()) {
    bucket.claims.sort((a, b) => {
      if (a.deliveryDate === b.deliveryDate) return a.soDocNo.localeCompare(b.soDocNo);
      if (!a.deliveryDate) return 1;
      if (!b.deliveryDate) return -1;
      return a.deliveryDate < b.deliveryDate ? -1 : 1;
    });
  }
  return map;
}

export type PoCoverageAssignment = {
  soItemId: string;
  soDocNo: string;
  itemCode: string;
  variantLabel: string | null;
  deliveryDate: string | null;
  debtorName: string | null;
  warehouseName: string | null;
  qty: number;
};

/* Reverse of mrpLineCoverage: group the SAME floating allocation by the COVERING
   PO number, so a purchase document (PO / GRN / PI) can show which outstanding
   Sales-Order line(s) its supply is currently floating-assigned to, and that SO
   line's delivery date — matched by SKU (coverage is computed per
   (warehouse, code, variant) bucket, so an assignment's itemCode always equals
   the covering PO line's item_code).

   ADVISORY, NOT A BINDING. This is linkage A (pooled, read-time, evaporates on
   delivery), never a stored PO↔SO link — the owner raises POs against the PO,
   not the SO ("我拿货是根据PO而不是看SO"). One source of truth with the MRP page
   and the SO drill-down: all three read computeMrp's single allocation.

   LIMITATION (stated, not hidden): MrpLine/SofaSet record only the FIRST
   (earliest-ETA) covering PO of a split line, so a line fed by multiple POs is
   attributed to just one of them here — an under-attribution, never a wrong
   attribution. */
export function mrpReverseCoverage(result: MrpResult): Map<string, PoCoverageAssignment[]> {
  const map = new Map<string, PoCoverageAssignment[]>();
  const push = (po: string | null, a: PoCoverageAssignment): void => {
    if (!po) return;
    const arr = map.get(po) ?? [];
    arr.push(a);
    map.set(po, arr);
  };
  for (const sku of result.skus) {
    for (const l of sku.lines) {
      if (l.source !== 'po' || !l.poNumber) continue;
      push(l.poNumber, {
        soItemId: l.soItemId,
        soDocNo: l.soDocNo,
        itemCode: sku.itemCode,
        variantLabel: sku.variantLabel,
        deliveryDate: l.deliveryDate,
        debtorName: l.debtorName,
        warehouseName: sku.warehouseName,
        qty: l.qty,
      });
    }
  }
  for (const s of result.sofaSets) {
    if (!s.poNumber) continue;
    push(s.poNumber, {
      soItemId: s.soItemId,
      soDocNo: s.soDocNo,
      itemCode: s.itemCode,
      variantLabel: s.variantLabel,
      deliveryDate: s.deliveryDate,
      debtorName: s.debtorName,
      warehouseName: s.warehouseName,
      qty: s.qty,
    });
  }
  return map;
}

const UNDATED_TRUE = new Set(['true', '1', 'yes', 'on']);
const UNDATED_FALSE = new Set(['false', '0', 'no', 'off']);

export class InvalidQueryFlag extends Error {
  constructor(readonly param: string, readonly value: string) {
    super(
      `${param}: "${value}" is not a boolean. Use one of ` +
      `${[...UNDATED_TRUE].join(' / ')} (on) or ${[...UNDATED_FALSE].join(' / ')} (off), ` +
      `or omit the parameter.`,
    );
    this.name = 'InvalidQueryFlag';
  }
}

/* THE DEFAULT IS FALSE — undated demand is HIDDEN until the operator asks for
   it. Owner, 2026-08-18, ruling directly on a build that had flipped it to
   shown: "这个应该是要把没有日期的藏起来的,不过我点 show no date 它才会出来."

   THE EARLIER READING WAS WRONG, and the record should say so rather than
   quietly changing. Measured on production 2026-08-16, the hidden-by-default
   view returned 82 of 163 live 2990 SO-item ids and 8 of 68 short sofa sets, so
   roughly half the demand was off-screen — and the owner's complaint that
   started this work was "明明这个东西没有 ready,可是我的 MRP 却 show 不出来".
   The inference drawn from that was that the rows should be shown by default.
   It was the wrong inference. What he could not see was not the ROWS but the
   FACT THAT ROWS EXISTED: nothing on the page said anything was being withheld.
   The banner fixes that; the default does not need to move to fix it, and this
   page is the ordering worklist, where undated demand is not yet orderable.

   SO THE CONTRACT IS: hidden by default, ALWAYS counted and always announced,
   one click away. Hiding is legitimate. Hiding SILENTLY is not.

   43% of 2990's sales orders carry no delivery date, flat across June/July/
   August — a habit, not an import artefact. Requiring a date was considered and
   REJECTED: a forced date gets a fake one typed into it, and a fake date is
   worse than a null one because allocation is BY DELIVERY DATE — a fake promise
   would jump the queue ahead of a real one. So undated demand keeps its null
   and stops being invisible instead.

   SAFE ONLY BECAUSE THE FLAG IS DISPLAY-ONLY (audit D6, 2026-08-01). The
   allocation always ran over the full active set with undated sorted LAST
   (byDateAsc returns 1 for null), so flipping this changes which rows are
   RENDERED and cannot change who gets supply. mrp.test.ts pins both halves. */
/** Exported for `mrp.test.ts` — the spellings are the contract, so they get a test. */
export function parseIncludeUndated(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  if (UNDATED_TRUE.has(v)) return true;
  if (UNDATED_FALSE.has(v)) return false;
  throw new InvalidQueryFlag('includeUndated', raw);
}

mrp.get('/', async (c) => {
  const sb = c.get('supabase');
  const category = c.req.query('category');
  const warehouseId = c.req.query('warehouseId');
  const catFilter = category && category !== 'all' ? category.toUpperCase() : null;
  const whFilter = warehouseId && warehouseId !== 'all' ? warehouseId : null;
  let includeUndated: boolean;
  try {
    includeUndated = parseIncludeUndated(c.req.query('includeUndated'));
  } catch (e) {
    return c.json({ error: 'bad_request', reason: e instanceof Error ? e.message : String(e) }, 400);
  }
  const companyId = activeCompanyId(c);
  try {
    if (isDefaultMrpView(catFilter, whFilter, includeUndated)) {
      const snap = await readMrpSnapshot(sb, companyId);
      if (snap) return c.json({ ...snap.result, computedAt: snap.computedAt, stored: true });
    }
    const result = await computeMrp(sb, { catFilter, whFilter, includeUndated, companyId, leadBuffers: await loadLeadBuffers(c.env.DB), nettingCheck: c.req.query('nettingCheck') === '1' });
    return c.json({ ...result, computedAt: new Date().toISOString(), stored: false });
  } catch (e) {
    return c.json({ error: 'load_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});

mrp.post('/regenerate', async (c) => {
  const sb = c.get('supabase');
  const companyId = activeCompanyId(c);
  if (companyId == null) return c.json({ error: 'no_company' }, 400);
  try {
    const { result, computedAt } = await refreshMrpSnapshot(
      sb, companyId, await loadLeadBuffers(c.env.DB), new Date().toISOString(),
    );
    return c.json({ ...result, computedAt, stored: true });
  } catch (e) {
    return c.json({ error: 'regenerate_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});
