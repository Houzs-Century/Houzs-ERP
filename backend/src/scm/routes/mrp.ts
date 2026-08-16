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
import { computeVariantKey, buildVariantSummary, isServiceLine, splitSofaCode, effectiveDelivery, type VariantAttrs } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import { soDeliverableRemaining } from './delivery-orders-mfg';
import { activeCompanyId } from '../lib/companyScope';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { resolveLineWarehouseId, type SoWarehouseMasters } from '../lib/so-warehouse';
import {
  loadLeadTimeBase,
  resolveLeadDays,
  subtractCalendarDays,
  LEAD_TIME_SELECT,
  NO_BUFFERS,
  type LeadBuffers,
} from '../lib/lead-time';
import { loadLeadBuffers } from '../../services/agents/procurement-learning';
import {
  applyCommittedSupply,
  type PoSupplyEntry,
} from '../lib/ship-commitment';
import { WH_NONE, composite, loadCommittedShipments } from '../lib/committed-shipments';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import type { Env, Variables } from '../env';
import { SO_TERMINAL_STATES } from '../shared/so-terminal-states';

export const mrp = new Hono<{ Bindings: Env; Variables: Variables }>();
mrp.use('*', supabaseAuth);

/* SO statuses that no longer create demand (already shipped / closed).
   SHIPPED is included (MRP pairing audit D4, 2026-08-01): rank 4 on the SO
   ladder means the goods have left the building, and so-stock-allocation.ts
   already excluded it from allocation while MRP was still planning purchases
   for it. The audit measured ZERO live SHIPPED-status lines still demanding, so
   aligning changed no figure.

   THE SET IS shared/so-terminal-states.ts, not a literal. This line and the
   allocator's `not.in` filter were two of FOURTEEN hand-typed copies of it
   across ten files (four names, eight of them .mjs audits, four of those also
   holding an inline SQL copy of their own); the whole reason SHIPPED had to be
   "added" in the first place is that a set kept in fourteen places gets updated
   in thirteen.

   ONE CLAIM IN THIS COMMENT WAS FALSE AND IS CORRECTED (2026-08-13): it used to
   say "the /inventory/ reservations SO_DONE drops its claims" as if that
   consumer agreed. It does not. routes/inventory.ts holds TWO sets of its own —
   GET /reservations has FIVE (no DRAFT), GET /products has FOUR (no DRAFT, no
   SHIPPED) — so a DRAFT order is open demand on both Inventory surfaces and done
   here, and a SHIPPED order is open demand on one of them. Neither is collapsed
   into the shared file: resolving the disagreement moves numbers staff read, so
   it is the owner's call. */
const SO_DONE = new Set<string>(SO_TERMINAL_STATES);
/* PO statuses that no longer supply goods. DRAFT is included: a draft PO is
   not yet committed, so it must NOT count as incoming supply — otherwise a
   draft PO would make an SO line look "covered" and hide a real shortage from
   MRP + the From-SO shortage cap (leak guard, Draft/Confirmed rollout). */
const PO_DEAD = new Set(['CANCELLED', 'DRAFT']);

/* EVERY MULTI-ROW READ ON THIS PAGE IS PAGED (2026-08-16). It used to carry a
   `.limit(5000)` plus a `rows.length >= 5000` throw named `mrp_load_truncated`,
   and BOTH halves of that were wrong in the same way — they assumed the number
   the code asked for is the number PostgREST returns.

   It is not. PostgREST caps a response at `max-rows` (1000 on this project) and
   `.limit(5000)` does not lift it: the server hands back ≤1000 rows and drops
   the rest with NO error and no signal in the payload. So the ceiling was 1000,
   not 5000, and the guard that was supposed to catch truncation compared
   1000 >= 5000 — it could never fire, and never did. Measured against prod on
   2026-08-16: the demand read matches 13,920 rows, so the plan was computed over
   the first ~1000 by `id` ASC (a uuid order, i.e. arbitrary) and ~93% of open
   demand was invisible. The owner's symptom was the direct consequence — a
   brand-new sales order ranked 10,687th and simply did not appear in MRP, so it
   could not be converted to a PO.

   The remedy is lib/paginate-all.ts (`paginateAll` / `chunkIn`), which is this
   codebase's established answer to the same trap — it pages with `.range()`
   until a short page arrives. The cap and the guard are both GONE rather than
   re-tuned: a bigger `.limit()` would have been the same bug with a bigger
   wrong number, and a guard that cannot detect the thing it is named after is
   worse than no guard, because it reads as protection. paginateAll's own
   MAX_PAGES (50 pages = 50k rows) is the surviving runaway stop, and it is a
   real one — it counts pages actually fetched.

   PostgREST filter notes, because the syntax is the trap: the status columns
   live on the EMBEDDED (aliased, !inner-joined) parent, so the filter path is
   the alias ('so.status' / 'po.status') and the not-in list uses the quoted
   form so-delivery-sync.ts already proved in production. A NULL-status header
   is dropped by `not.in` (NULL never passes a NOT IN) — for demand that is
   exactly so-stock-allocation.ts's own SQL behaviour, so the two engines now
   agree on that edge too; the JS-side SO_DONE/PO_DEAD filters below remain the
   authoritative gate for everything the SQL cannot express. Pushing the status
   filter into SQL still matters: it keeps the paged read from walking every
   closed order in history. */
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
  /* SO line's ship-from warehouse (migration 0118). NULL on lines written by a
     path that never set it (amendment ADD lines, auto free gifts) and on old
     imported data — resolved from the SO header before bucketing, see the
     "warehouse follows the SO" block below. */
  warehouse_id: string | null;
  line_delivery_date: string | null;
  line_no: number | null;
  created_at: string | null;
  cancelled: boolean;
  so: {
    debtor_name: string | null;
    status: string;
    so_date: string | null;
    customer_delivery_date: string | null;
    processing_date: string | null; // processing date (drives when to order)
    customer_state: string | null;       // staff #8 — show the customer's state (info-only)
    sales_location: string | null;       // the SO's OWN warehouse of record (lib/so-warehouse.ts)
  } | null;
};

type PoLineRow = {
  material_code: string;
  item_group: string | null;
  variants: Record<string, unknown> | null;
  qty: number;
  received_qty: number | null;
  delivery_date: string | null;
  // Migration 0180 — per-line supplier-revised delivery dates. The effective
  // line ETA = MAX over non-null of [delivery_date, _2, _3, _4].
  supplier_delivery_date_2: string | null;
  supplier_delivery_date_3: string | null;
  supplier_delivery_date_4: string | null;
  warehouse_id: string | null;        // per-line ship-to warehouse (overrides header)
  so_item_id: string | null;          // SO line this PO line was raised from (informational only now)
  po: {
    po_number: string; status: string; expected_at: string | null;
    // Migration 0180 — header revised dates, used as the fallback ETA when the
    // line carries no delivery date of its own.
    supplier_delivery_date_2: string | null;
    supplier_delivery_date_3: string | null;
    supplier_delivery_date_4: string | null;
    purchase_location_id: string | null; supplier_id: string | null;
  } | null;
};

type ProductRow = { code: string; name: string | null; category: string | null };
type BalanceRow = { product_code: string; warehouse_id: string; variant_key: string | null; qty: number };

type AllocSource = 'stock' | 'po' | 'shortage';

/* Commander 2026-05-29 — bedframe/sofa MRP must follow the variant: two lines
   of the same SKU but a different fabric/colour/divan/leg are DIFFERENT goods
   to stock + order. We key every bucket by (item_code + variant key), where the
   variant key is the shared inventory identity (computeVariantKey — same one
   inventory_balances.variant_key is built from, so stock matches byte-for-byte).
   Mattress/accessory have no soft attrs → key '' → behaves exactly as before. */
const variantKeyOf = (itemGroup: string | null | undefined, variants: unknown): string =>
  computeVariantKey(itemGroup, (variants ?? null) as VariantAttrs | null);
/* WH_NONE / composite / loadCommittedShipments moved VERBATIM to
   lib/committed-shipments.ts (2026-08-07, PR-4) so the DO-time live allocator
   folds outstanding commitments through the SAME read this engine uses — one
   definition of "still committed", not two. Behaviour here is unchanged. */


export type MrpLine = {
  soItemId: string;    // mfg_sales_order_items.id — lets the UI one-click PO this line
  soDocNo: string;
  debtorName: string | null;
  customerState: string | null;  // staff #8 — info-only, from the SO's customer_state
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
  shortageQty: number; // units still uncovered on this line (orange highlight)
  /* Owner 2026-07-25 (dead-stock view) — units of THIS line filled from ON-HAND
     stock by the greedy allocation (fromStock). This is the "assigned stock"
     signal: a lot is ASSIGNED to an SO iff MRP allocated on-hand stock to that
     SO's demand. A line can be part stock + part PO; `source` collapses to one
     tag, but stockQty carries the exact on-hand slice so the drawer's
     assigned-vs-free split reads off the SAME engine (not hard reservations). */
  stockQty: number;
  /* Commander 2026-05-31 — when this line is covered by a PO (source==='po'),
     the covering PO's supplier so the UI can show it READ-ONLY (a raised PO's
     supplier can't change). NULL for stock / shortage lines. */
  poSupplierId: string | null;
  poSupplierName: string | null;
};

export type MrpSku = {
  /* Commander 2026-05-31 — each row is scoped to ONE warehouse (per-WH MRP). The
     same SKU+variant in two warehouses produces two rows; the UI groups by
     warehouse. NULL when the demand line has no warehouse bound yet. */
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
  /* All suppliers bound to this SKU (main first) — lets the UI switch supplier
     in-place before posting the PO. */
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
  customerState: string | null;  // staff #8 — info-only, from the SO's customer_state
  soDate: string | null;
  deliveryDate: string | null;
  processingDate: string | null;
  orderByDate: string | null; // delivery date − category lead days
  itemCode: string;
  variantKey: string;  // shared inventory identity (computeVariantKey) — the bucket key
  description: string | null;
  variantLabel: string | null; // spec line e.g. "BF-15 / SEAT 24 / LEG 6\""
  modules: string[];   // e.g. ['2A','LL','2A'] from variants.cells
  colour: string | null; // fabricCode + colorCode
  qty: number;
  orderedQty: number;  // units covered by pooled stock+PO supply
  /* Owner 2026-07-25 (dead-stock view) — the on-hand-stock slice of orderedQty
     (fromStock), mirroring MrpLine.stockQty for the sofa path. */
  stockQty: number;
  shortageQty: number; // qty - orderedQty (still to order)
  poNumber: string | null; // pooled PO that covers this set (earliest ETA), if any
  poEta: string | null;    // earliest PO-line delivery date (when goods arrive)
  /* Commander 2026-05-31 — covering PO's supplier so a PO-covered sofa set can
     show it read-only (mirrors MrpLine.poSupplierId on the general path). The
     sofa Convert grid previously showed "—" because this wasn't carried. NULL
     for stock / shortage sets. */
  poSupplierId: string | null;
  poSupplierName: string | null;
  suppliers: Array<{ supplierId: string; code: string; name: string; isMain: boolean }>;
};

/* Earliest-first comparator that pushes NULL dates to the end. */
function byDateAsc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? -1 : 1;
}

/* A shipment that already took the goods, against a PO that has nothing left to
   hand over: fully received, dead (CANCELLED / DRAFT), or ordered into a
   different warehouse / variant bucket than the one it shipped from.
   `applyCommittedSupply` can deduct nothing for these, so they change no figure
   on this page — which is exactly why they have to be REPORTED rather than
   dropped. Each row is a real OUT the receipt-time reconcile will never net. */
export type UnmatchedCommitment = {
  warehouseId: string | null;
  warehouseCode: string | null;
  itemCode: string;
  variantKey: string;
  /** = the batch the OUT was stamped with = the PO that owes the units. */
  poNumber: string;
  qty: number;
};

export type MrpResult = {
  asOf: string;
  categories: string[];
  warehouses: unknown[];
  skus: MrpSku[];
  sofaSets: SofaSet[];
  /** Commitments with no open PO supply left to deduct from — see the type. */
  unmatchedCommitments: UnmatchedCommitment[];
  totals: {
    skuCount: number;
    shortageSkuCount: number;
    shortageUnits: number;
    sofaSetCount: number;
    sofaSetShortageCount: number;
    /** Units on unmatchedCommitments — 0 is the healthy reading. */
    unmatchedCommitmentUnits: number;
  };
};

/* Per-SO-line coverage the drill-down needs: is this line covered by stock, by
   an outstanding PO (then which + when), or still short (shows as Pending). */
export type SoLineCoverage = { source: AllocSource; po: string | null; eta: string | null };

/* Shared MRP allocation engine. The /mrp route is a thin wrapper around this;
   the Sales-Order drill-down reads the SAME allocation (via mrpLineCoverage) so
   the Stock column and the MRP page can never disagree. */
export async function computeMrp(
  sb: any,
  opts: {
    catFilter: string | null;
    whFilter: string | null;
    /* VISIBILITY of undated demand lines in the returned rows — NOT a demand
       filter. The allocation always runs over the full active set (undated
       sorts last), so two callers with different flags still read the SAME
       allocation; false merely omits the undated rows/sets from the output
       (audit D6, 2026-08-01 — this is what makes po-so-coverage's "SO->PO and
       PO->SO can never disagree" claim hold across pages). */
    includeUndated: boolean;
    /* WHICH COMPANY'S BOOKS. REQUIRED — `null` is the explicit "no company
       scoping" (single-company Houzs / pre-migration / cold-start), and it must
       be TYPED OUT rather than achieved by silence.

       It was optional until 2026-07-17 and the comment below already argued why
       that is wrong; it just was not applied to this line. The cost, twice, in
       one day: both HEADLESS callers omitted it — an agent has no request and
       therefore no company, so the parameter's default answered for them.
       procurement-agent pooled Houzs + 2990 demand and would have filed one
       company's SO lines under the other's PO (#710); cs-agent promised
       customers delivery dates backed by the other company's stock (#712). Both
       looked exactly like working code, and this signature is what let them.

       An optional scoping parameter is a trap whose default is "wrong": it
       offers a correct answer and accepts no answer, and no-answer is
       indistinguishable from not-knowing-to-answer. Required means a new caller
       must decide; `null`/`undefined` says they did.

       `undefined` is in the type but the KEY IS NOT OPTIONAL — that is the whole
       mechanism. `companyId?:` lets a caller omit it and say nothing;
       `companyId: number | null | undefined` makes them type the word. Same
       runtime behaviour for the honest callers (activeCompanyId(c) returns
       `number | undefined` and still passes unchanged), but silence is no longer
       spellable. */
    companyId: number | null | undefined;
    /* The Procurement Agent's approved lead-time buffers (per-supplier
       punctuality, per-season). REQUIRED, not optional, on purpose: the PO
       convert applies these to the date it commits, so an order-by hint
       computed without them would tell you to order LATER than the PO asks the
       supplier to deliver — the two would disagree by exactly the buffer, which
       is the drift this codebase keeps paying for. Making it required means a
       new caller cannot forget; pass NO_BUFFERS explicitly to opt out. */
    leadBuffers: LeadBuffers;
  },
): Promise<MrpResult> {
  const { catFilter, whFilter, includeUndated, companyId, leadBuffers } = opts;

  /* Multi-company isolation: every per-company read (demand SO lines, PO supply,
     inventory balances, warehouses, suppliers, bindings, product master) is
     filtered to the ACTIVE company. Mirrors scopeToCompany's semantics — a NO-OP
     when companyId is null/undefined (unresolved / agent callers / single-company
     Houzs), so existing behaviour is unchanged where no company is passed. */
  const scoped = <Q>(q: Q): Q =>
    companyId != null ? (q as unknown as { eq(c: string, v: unknown): Q }).eq('company_id', companyId) : q;

  // ── 0. Per-category lead times (Commander 2026-05-29), now per-WAREHOUSE
  //       (Commander 2026-06-22, migration 0184 / SCM mig 0036) ────────────
  // order-by date = delivery date − lead_days[warehouse, category].
  //
  // The rule lives in scm/lib/lead-time.ts, shared with the PO-from-SO convert
  // that WRITES this date onto a real purchase order. It used to be a copy in
  // each, and the copies had drifted on error handling — this one surfaced the
  // query error (see below), the convert swallowed it. One module now, so the
  // hint on this page and the date on the PO cannot disagree.
  //
  // loadLeadTimeBase THROWS on a query error, which is the behaviour this route
  // already had and the reason for it is unchanged: a swallowed error silently
  // zeroed EVERY lead time -> order-by date = production date = delivery date
  // for the whole plan. Fail loudly rather than emit a wrong-but-plausible
  // schedule.
  const leadBase = await loadLeadTimeBase(
    scoped(sb.from('mrp_category_lead_times').select(LEAD_TIME_SELECT)),
  );
  /* supplierCode is the SKU's MAIN supplier — an approximation, and a stated
     one: the convert may end up on a different supplier via a per-pick or
     per-SKU override, in which case that supplier's buffer applies instead and
     the real PO date can differ from this hint. The main supplier is what this
     page shows and what the convert picks absent an override, so it is the
     honest default; the alternative (no supplier at all) would disagree with
     EVERY buffered PO rather than just the overridden ones. */
  const orderByOf = (
    deliveryDate: string | null,
    category: string | null,
    whId: string | null,
    supplierCode: string | null,
  ): string | null =>
    subtractCalendarDays(
      deliveryDate,
      resolveLeadDays(leadBase, leadBuffers, {
        warehouseId: whId,
        category,
        supplierCode,
        deliveryDate,
      }).total,
    );

  // ── 1. Demand — outstanding SO lines ──────────────────────────────────
  // Status filter pushed into SQL (see the paging note above) so done SOs never
  // spend read budget; ORDER BY id so the page boundaries are stable across
  // requests (paginateAll's `.range()` windows are only coherent under a total
  // order); PAGED so the plan sees every open line, not the first 1000.
  const { data: demandRaw, error: demandErr } = await paginateAll<DemandRow>((from, to) => scoped(sb
    .from('mfg_sales_order_items')
    .select(`
      id, doc_no, item_code, description, item_group, variants, qty, warehouse_id, line_delivery_date, line_no, created_at, cancelled,
      so:mfg_sales_orders!inner ( debtor_name, status, so_date, customer_delivery_date, processing_date, customer_state, sales_location )
    `)
    .eq('cancelled', false)
    .not('so.status', 'in', SO_DONE_SQL))
    .order('id')
    .range(from, to));
  if (demandErr) throw new Error(`mrp_load_failed: ${demandErr.message}`);

  /* Undated lines (no line delivery date AND no SO delivery date) are not
     ready to order, so the MRP page hides them by default — but they are STILL
     DEMAND, and audit D6 (2026-08-01) proved the old shape of this switch let
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
    (r) => r.item_code && r.so && !SO_DONE.has(r.so.status) && r.qty > 0,
  );
  const isDatedLine = (r: DemandRow): boolean =>
    Boolean(r.line_delivery_date ?? r.so?.customer_delivery_date);

  // A partially-delivered SO keeps its header status active (the header only
  // flips to DELIVERED once EVERY line is fully covered), so already-delivered
  // lines would otherwise phantom back in as demand and over-order. Subtract
  // delivered-net-of-returns per line and drop any line with nothing left to
  // fulfil. Single source of truth: soDeliverableRemaining (same query the DO
  // convert flow uses), so MRP can never disagree with the SO's remaining.
  const demandDocNos = [...new Set(demandActive.map((d) => d.doc_no).filter(Boolean))];
  const deliverable = await soDeliverableRemaining(sb, demandDocNos);
  const deliveredNetOf = (soItemId: string): number => {
    const d = deliverable.get(soItemId);
    if (!d) return 0;
    return Math.max(0, (d.delivered ?? 0) - (d.returned ?? 0));
  };
  const effQtyOf = (r: DemandRow): number => Math.max(0, r.qty - deliveredNetOf(r.id));
  const demand = demandActive.filter((r) => effQtyOf(r) > 0);

  // Stamp variants.fabricSupplierCode on the demand lines (ONE batched read,
  // fail-soft) BEFORE any label is built, so every variant summary this page
  // shows (bucket vlabel in section 6, sofa-set labels in section 8) renders
  // the shared final fabric format "CG-001 Pearl (KN390-1)" — owner
  // 2026-07-24, same READ enrichment as the document detail endpoints. The ctx
  // shim mirrors `scoped()` above: eq(company_id) when a company is resolved,
  // no filter otherwise. variantKeyOf is unaffected — fabricSupplierCode is
  // not a key attribute (see shared/variant-key.ts ATTRS_BY_GROUP).
  await enrichLinesWithFabricSupplierCode(
    sb,
    { get: (k: unknown) => (k === 'companyId' ? companyId ?? undefined : undefined) },
    demand as unknown as Array<Record<string, unknown>>,
  );

  // ── 2. Product master — category + name (bounded by the codes in demand) ─
  // The category lookup MUST be complete for every demanded SKU. An unbounded
  // `select()` is capped at ~1000 rows by PostgREST, so once the catalog grew
  // past the cap, non-sofa SO lines whose product fell outside the returned
  // slice resolved to a null category and were silently dropped by the category
  // filter below — the "No open Sales-Order demand / nothing needs ordering"
  // bug for Bedframe / Mattress / Accessories (sofa kept working because its
  // module SKUs are few and stay within the cap). Fetch BY the codes actually
  // in demand (bounded .in, chunked) so the map can never be clipped.
  //
  // chunkIn replaces a hand-rolled 300-at-a-time loop: it batches the IN-list
  // the same way AND pages each batch, which the hand-rolled loop did not. That
  // second half now matters — the demand read is paged, so `demandCodes` is no
  // longer bounded by a 1000-row demand slice.
  const prodByCode = new Map<string, ProductRow>();
  const demandCodes = [...new Set(demand.map((d) => d.item_code).filter((c): c is string => !!c))];
  const { data: prods, error: prodErr } = await chunkIn<ProductRow>(demandCodes, (batch, from, to) => scoped(sb
    .from('mfg_products')
    .select('code, name, category')
    .in('code', batch))
    // ORDER BY id, not code: `.range()` windows are only coherent under a TOTAL
    // order, and `code` is unique per COMPANY — with companyId null (the
    // no-scoping case) the same code appears once per company, so a tie at a
    // page boundary could drop or repeat a row. id is unique unconditionally.
    .order('id')
    .range(from, to));
  if (prodErr) throw new Error(`mrp_load_failed: ${prodErr.message}`);
  for (const p of prods) prodByCode.set(p.code, p);

  // The category dropdown lists every catalog category (a handful of enum
  // values), independent of current demand. The DISTINCT values are few, but
  // the read that finds them walks the whole catalogue (2,293 rows in prod on
  // 2026-08-16), so it must be paged — unpaged it saw the first 1000 products
  // and a category owned only by later rows would be missing from the tab list.
  const categorySet = new Set<string>();
  const { data: catRows, error: catErr } = await paginateAll<{ category: string | null }>((from, to) =>
    scoped(sb.from('mfg_products').select('category')).order('id').range(from, to));
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
  /* Stamped onto the row in place — the same enrichment idiom as
     enrichLinesWithFabricSupplierCode above — so every downstream bucket key,
     warehouse filter and label reads one resolved value and they cannot drift. */
  for (const d of demand) {
    d.warehouse_id = resolveLineWarehouseId(d.warehouse_id, d.so, soWarehouseMasters);
  }

  // ── 3. Stock on hand — inventory_balances keyed by (warehouse, code, variant) ──
  // Commander 2026-05-31 — warehouse is part of the bucket identity (no cross-WH
  // pooling). whFilter scopes the query to one warehouse; otherwise every
  // warehouse's balance lands in its own bucket.
  // PAGED: 1,065 balance rows in prod on 2026-08-16 — unpaged, the last ~65
  // buckets read as zero stock and MRP invented a shortage for each of them.
  const { data: balances, error: balErr } = await paginateAll<BalanceRow>((from, to) => {
    let q = scoped(sb.from('inventory_balances').select('product_code, warehouse_id, variant_key, qty'));
    if (whFilter) q = q.eq('warehouse_id', whFilter);
    // inventory_balances is a VIEW (migration 0084) grouped by
    // (warehouse_id, product_code, variant_key, company_id) and has no id, so
    // that four-column tuple IS its unique key — order by all four or the
    // paging is not total. company_id matters precisely when it is NOT filtered
    // (companyId null), which is the case that would otherwise tie.
    return q.order('product_code').order('warehouse_id').order('variant_key').order('company_id').range(from, to);
  });
  if (balErr) throw new Error(`mrp_load_failed: ${balErr.message}`);
  const stockByKey = new Map<string, number>();
  for (const b of balances ?? []) {
    const k = composite(b.warehouse_id ?? null, b.product_code, b.variant_key ?? '');
    stockByKey.set(k, (stockByKey.get(k) ?? 0) + (b.qty ?? 0));
  }

  // ── 4. Outstanding PO supply — open PO lines with ETA, keyed by (warehouse, code, variant) ──
  // Each PO line's ship-to warehouse = line warehouse_id, falling back to the PO
  // header's purchase_location_id. No SO↔PO linkage — supply is a pure pool.
  // Dead-PO filter pushed into SQL, deterministic ORDER BY, and PAGED (see the
  // paging note at the top). This read matched 873 rows in prod on 2026-08-16 —
  // under the 1000 ceiling TODAY, which is precisely why it must be paged now:
  // it is one busy month from silently dropping supply, and the failure mode is
  // invisible (phantom shortage on whichever buckets fall off the end).
  // The read error is THROWN: it used to be silently discarded, and a failed
  // supply read produced a plan with ZERO PO supply — phantom shortage
  // everywhere, rendered as if it were true.
  const { data: poRaw, error: poErr } = await paginateAll<PoLineRow>((from, to) => scoped(sb
    .from('purchase_order_items')
    .select(`
      material_code, item_group, variants, qty, received_qty, delivery_date,
      supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4,
      warehouse_id, so_item_id,
      po:purchase_orders!inner ( po_number, status, expected_at, supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4, purchase_location_id, supplier_id )
    `)
    .not('po.status', 'in', PO_DEAD_SQL))
    .order('id')
    .range(from, to));
  if (poErr) throw new Error(`mrp_load_failed: ${poErr.message}`);
  // Commander 2026-05-31 — carry the covering PO's supplier so a covered line
  // can display it read-only (a raised PO's supplier is fixed). Name resolved
  // from the suppliers map below.
  type PoSupply = { poNumber: string; eta: string | null; qtyLeft: number; supplierId: string | null };
  const poByKey = new Map<string, PoSupply[]>();
  const poOutstandingByKey = new Map<string, number>();
  const poSupplierIds = new Set<string>();
  /* Collected FLAT first so the hard-committed deduction can run over the whole
     set before anything is bucketed — a commitment is owed to a (bucket, PO)
     pair, and two PO lines can share one. */
  const poDrafts: PoSupplyEntry[] = [];
  for (const r of (poRaw ?? []) as unknown as PoLineRow[]) {
    if (!r.po || PO_DEAD.has(r.po.status)) continue;
    /* Migration 0180 — ETA is the EFFECTIVE (latest revised) delivery date: the
       line's own effective date (MAX over its delivery_date + revisions), else
       the header's effective date (MAX over expected_at + revisions). camelCase
       trap: the pg driver camelCases result cols, so dual-read snake_case. */
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
    if (left <= 0) continue;
    const poWh = r.warehouse_id ?? r.po.purchase_location_id ?? null;
    if (whFilter && poWh !== whFilter) continue;
    const k = composite(poWh, r.material_code, variantKeyOf(r.item_group, r.variants));
    poDrafts.push({
      bucketKey: k, poNumber: r.po.po_number, eta, qtyLeft: left, supplierId: r.po.supplier_id ?? null,
    });
    if (r.po.supplier_id) poSupplierIds.add(r.po.supplier_id);
  }

  /* ── 4b. Remove what is already spoken for (2026-07-31) ─────────────────────
     Units a ship-before-arrival already owns are not supply: the receipt is
     going to hand them to that shipment (fn_reconcile_dropship_batch), not to a
     new Sales Order. Deduct them from the PO pool and ADD THE SAME UNITS BACK to
     the bucket's on-hand figure — the OUT movement already took them off
     inventory_balances, so deducting alone would count the commitment twice.
     applyCommittedSupply guarantees the two are the same number in the same
     bucket; see its contract. */
  const committed = await loadCommittedShipments(
    sb, scoped, poDrafts.map((d) => d.poNumber),
  );
  const supply = applyCommittedSupply(poDrafts, committed);
  /* Deliberately NOT silent. These are commitments the deduction could not
     reach: the PO is fully received, went dead, or the shipment sits in a
     different bucket from the PO line meant to cover it. They alter no figure
     here, so if they were only "not dropped" nobody would ever see one. */
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

  // Resolve PO supplier ids → names for the read-only covered-line display.
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

  // ── 5. Suppliers per SKU — main + alternates (so the UI can switch supplier
  //       in-place before posting the PO, AutoCount-style). ────────────────
  type SupplierOpt = { supplierId: string; code: string; name: string; isMain: boolean };
  const codes = [...new Set(demand.map((d) => d.item_code))];
  const mainByCode = new Map<string, { code: string; name: string }>();
  const suppliersByCode = new Map<string, SupplierOpt[]>();
  /* CHUNKED + PAGED. Two separate ceilings were being crossed here: the IN-list
     was the FULL demand code list in one URL (unbounded now that demand is
     paged), and the result was 2,660 rows in prod on 2026-08-16 against a
     1000-row response cap — so ~⅔ of the bindings never arrived and the SKUs
     they belonged to showed no supplier at all, which is the difference between
     a row you can convert to a PO and a row you cannot.
     ORDER: is_main_supplier DESC stays FIRST because `mainByCode` takes the
     first binding it sees per code as the main one. material_code + supplier_id
     follow only to make the order total, which is what makes `.range()` pages
     coherent; they cannot displace a main binding from the front of its code. */
  if (codes.length > 0) {
    type BindRow = { material_code: string; is_main_supplier: boolean; supplier_id: string; supplier: { code: string; name: string } | Array<{ code: string; name: string }> | null };
    const { data: binds, error: bindErr } = await chunkIn<BindRow>(codes, (batch, from, to) => scoped(sb
      .from('supplier_material_bindings')
      .select('material_code, is_main_supplier, supplier_id, supplier:suppliers(code, name)')
      .eq('material_kind', 'mfg_product')
      .in('material_code', batch))
      .order('is_main_supplier', { ascending: false })
      .order('material_code')
      .order('id')
      .range(from, to));
    if (bindErr) throw new Error(`mrp_load_failed: ${bindErr.message}`);
    for (const b of binds) {
      const s = Array.isArray(b.supplier) ? b.supplier[0] : b.supplier;
      if (!s) continue; // orphaned binding (supplier deleted) — skip
      const arr = suppliersByCode.get(b.material_code) ?? [];
      arr.push({ supplierId: b.supplier_id, code: s.code, name: s.name, isMain: b.is_main_supplier });
      suppliersByCode.set(b.material_code, arr);
      // First (is_main_supplier first via ORDER BY) wins as the default main.
      if (!mainByCode.has(b.material_code)) mainByCode.set(b.material_code, { code: s.code, name: s.name });
    }
  }

  // ── 6. Group demand by (warehouse + SKU + variant), apply category filter ─
  // Commander 2026-05-31 — warehouse is part of the bucket: the same SKU+variant
  // in two warehouses is two rows (no cross-WH pooling). When whFilter is set,
  // only that warehouse's demand lines are grouped. Sofa is handled separately
  // as colour-matched SETS (section 8) so it isn't double-counted here.
  type Bucket = { whId: string | null; code: string; vkey: string; vlabel: string; rows: DemandRow[] };
  /* Category from the catalog (authoritative); when the SO line's item_code is
     NOT in mfg_products yet (an item ordered before it was added to the SKU
     Master), fall back to the line's own item_group so the demand still SHOWS
     under its category tab instead of silently vanishing. Wei Siang 2026-06-16:
     the Bedframe/Mattress tabs were dropping every line whose code wasn't
     catalogued — only the catalogued ones (e.g. BARON-(K)) survived. */
  const catFromGroup = (g: string | null | undefined): string | null => {
    const s = (g ?? '').trim().toUpperCase();
    if (s.includes('BEDFRAME')) return 'BEDFRAME';
    if (s.includes('SOFA')) return 'SOFA';
    if (s.includes('MATTRESS')) return 'MATTRESS';
    if (s.includes('ACCESSOR')) return 'ACCESSORY';
    if (s.includes('SERVICE')) return 'SERVICE';
    return null;
  };
  const demandByKey = new Map<string, Bucket>();
  for (const d of demand) {
    const prod = prodByCode.get(d.item_code);
    const cat = prod?.category ?? catFromGroup(d.item_group);
    /* P1 SO-SKU spec §4.6 — SERVICE lines (delivery fee / dispose / lift) are
       services, not goods: they never create purchase demand. Skip BEFORE the
       category filter so even ?category=SERVICE can't surface them. (Section 8
       below is SOFA-only by construction — SERVICE can't enter it.) */
    if (isServiceLine({ itemGroup: d.item_group, itemCode: d.item_code, category: cat })) continue;
    if (catFilter && cat !== catFilter) continue;
    if (cat === 'SOFA') continue;
    if (whFilter && (d.warehouse_id ?? null) !== whFilter) continue;
    const whId = d.warehouse_id ?? null;
    const vkey = variantKeyOf(d.item_group, d.variants);
    const k = composite(whId, d.item_code, vkey);
    const bucket = demandByKey.get(k)
      ?? { whId, code: d.item_code, vkey, vlabel: buildVariantSummary(d.item_group, d.variants), rows: [] };
    bucket.rows.push(d);
    demandByKey.set(k, bucket);
  }

  // ── 7. Allocate (greedy by SO delivery date) per (warehouse + SKU + variant) ─
  // Commander 2026-05-31 — pure date-priority pooling, NO po_qty_picked lock.
  // Supply = this bucket's stock + open PO lines (same warehouse+variant). The
  // earliest-delivery SO line claims stock first, then the earliest-ETA PO; what
  // remains is shortage. A line already on a PO is covered naturally because that
  // PO is in the supply pool — no special "own pick" handling needed.
  const skus: MrpSku[] = [];
  for (const [k, bucket] of demandByKey.entries()) {
    const { whId, code, vlabel, rows } = bucket;
    const prod = prodByCode.get(code);
    // Commander 2026-05-31 — deterministic same-day allocation: when two SO
    // lines share a delivery date, allocate by SO doc number ascending so the
    // greedy walk never flips nondeterministically (SO-2605-001 before -002).
    rows.sort((a, b) => {
      const byDate = byDateAsc(a.line_delivery_date ?? a.so?.customer_delivery_date ?? null,
                               b.line_delivery_date ?? b.so?.customer_delivery_date ?? null);
      if (byDate !== 0) return byDate;
      return (a.doc_no ?? '').localeCompare(b.doc_no ?? '');
    });

    let stockLeft = stockByKey.get(k) ?? 0;
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
      const eff = effQtyOf(r);                              // qty still to fulfil (ordered − delivered + returned)
      let need = eff;
      const fromStock = Math.min(stockLeft, need);
      stockLeft -= fromStock;
      need -= fromStock;

      let poNumber: string | null = null;
      let poEta: string | null = null;
      let poSupplierId: string | null = null;
      while (need > 0 && poQueue.length > 0) {
        const front = poQueue[0];
        if (!front) break;
        const take = Math.min(front.qtyLeft, need);
        if (poNumber == null) { poNumber = front.poNumber; poEta = front.eta; poSupplierId = front.supplierId; }
        front.qtyLeft -= take;
        need -= take;
        if (front.qtyLeft <= 0) poQueue.shift();
      }

      /* Audit D6 — the allocation above ALWAYS runs (undated rows sort last, so
         they only ever consume what dated rows left behind); visibility is the
         only thing the flag controls. A hidden row's consumption stands so the
         one allocation is identical for every caller. */
      if (!includeUndated && !isDatedLine(r)) continue;
      qtyNeeded += eff;

      // need>0 → still uncovered (SHORT). need==0 → covered by a pooled PO
      // (poNumber set) or by stock.
      const source: AllocSource =
        need > 0 ? 'shortage'
        : poNumber != null ? 'po'
        : 'stock';
      const lineDelivery = r.line_delivery_date ?? r.so?.customer_delivery_date ?? null;
      lines.push({
        soItemId: r.id,
        soDocNo: r.doc_no,
        debtorName: r.so?.debtor_name ?? null,
        customerState: r.so?.customer_state ?? null,
        soDate: r.so?.so_date ?? null,
        deliveryDate: lineDelivery,
        processingDate: r.so?.processing_date ?? null,
        orderByDate: orderByOf(lineDelivery, prod?.category ?? null, whId, mainByCode.get(code)?.code ?? null),
        qty: eff,
        source,
        poNumber,
        poEta,
        shortageQty: need,
        stockQty: fromStock, // on-hand units this line consumed (assigned-stock signal)
        // Only covered-by-PO lines carry a read-only supplier; stock/shortage = null.
        poSupplierId: source === 'po' ? poSupplierId : null,
        poSupplierName: source === 'po' && poSupplierId ? (supplierNameById.get(poSupplierId) ?? null) : null,
      });
    }

    // Every row of this bucket is hidden (undated demand, caller hides undated):
    // no visible line means no row — exactly what the old exclude-from-demand
    // shape produced, minus the divergent allocation.
    if (lines.length === 0) continue;

    const stock = stockByKey.get(k) ?? 0;
    // Mirrors the queue above: the '' bucket's outstanding qty used to be added
    // on when the fallback fired, which is what put units on the PO Outstanding
    // column that this row's variant was never going to receive.
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
      category: prod?.category ?? null,
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
    /* Audit 2026-06-20 — mirror section 6's catFromGroup fallback (line 468):
       a sofa SO line whose item_code isn't in mfg_products yet (ordered before
       it was added to the SKU Master) must still bucket as SOFA via its
       item_group, or it shows on NO MRP tab and never gets a PO. */
    const sofaCat = prodByCode.get(d.item_code)?.category ?? catFromGroup(d.item_group);
    if (sofaCat !== 'SOFA') continue;
    if (whFilter && (d.warehouse_id ?? null) !== whFilter) continue;
    const whId = d.warehouse_id ?? null;
    const vkey = variantKeyOf(d.item_group, d.variants);
    const k = composite(whId, d.item_code, vkey);
    const bucket = sofaByKey.get(k) ?? { whId, code: d.item_code, vkey, rows: [] };
    bucket.rows.push(d);
    sofaByKey.set(k, bucket);
  }

  const sofaSets: SofaSet[] = [];
  for (const [k, bucket] of sofaByKey.entries()) {
    // `code` and `vkey` were only ever read to build the '' legacy key; the
    // bucket still carries them, this loop no longer needs them.
    const { whId, rows } = bucket;
    const wh = whId ? whById.get(whId) : null;
    // Same deterministic tie-break as section 7: equal delivery date → SO doc
    // number ascending, so same-day sofa allocation is stable.
    rows.sort((a, b) => {
      const byDate = byDateAsc(a.line_delivery_date ?? a.so?.customer_delivery_date ?? null,
                               b.line_delivery_date ?? b.so?.customer_delivery_date ?? null);
      if (byDate !== 0) return byDate;
      return (a.doc_no ?? '').localeCompare(b.doc_no ?? '');
    });
    let stockLeft = stockByKey.get(k) ?? 0;
    /* Sofa draws its OWN bucket's PO supply only — the twin of section 7, and
       removed for the same reason on the same ruling (owner 2026-08-16). The
       fallback that stood here was added by audit D2 (2026-08-01) specifically
       to mirror section 7's; mirroring it in the other direction is what keeps
       the two paths from drifting. Sofa's key is fabricCode + seatHeight +
       legHeight (ATTRS_BY_GROUP), so a '' sofa PO is one with no fabric, no
       seat and no leg recorded — precisely the thing the owner says cannot
       stand in for a colour-matched set. See section 7 for the full reasoning,
       including why item_group is NOT re-derived from the product master. */
    const ownPo = poByKey.get(k) ?? [];
    const poQueue: PoSupply[] = ownPo.map((p) => ({ ...p })).sort((a, b) => byDateAsc(a.eta, b.eta));

    for (const d of rows) {
      const v = (d.variants ?? {}) as Record<string, unknown>;
      const cells = Array.isArray(v.cells) ? (v.cells as Array<{ moduleId?: string }>) : [];
      /* SO-SKU spec P3 — split module lines (and Backend hand-opened lines)
         carry no cells[]; the line ITSELF is one module. Derive its code from
         the SKU so the set-composition label stays filled. Display only — the
         allocation math above pools by (warehouse, item_code, variant_key). */
      const modules = cells.length > 0
        ? cells.map((c) => sstr(c.moduleId)).filter(Boolean)
        : [sstr(splitSofaCode(d.item_code).sizeCode)].filter(Boolean);
      const colour = [sstr(v.fabricCode), sstr(v.colorCode) || sstr(v.colourCode)].filter(Boolean).join(' ');
      const eff = effQtyOf(d);                        // set qty still to fulfil (ordered − delivered + returned)
      const prod = prodByCode.get(d.item_code);
      const setDelivery = d.line_delivery_date ?? d.so?.customer_delivery_date ?? null;

      let need = eff;
      const fromStock = Math.min(stockLeft, need);
      stockLeft -= fromStock;
      need -= fromStock;
      let poNumber: string | null = null;
      let poEta: string | null = null;
      let poSupplierId: string | null = null;
      while (need > 0 && poQueue.length > 0) {
        const front = poQueue[0];
        if (!front) break;
        const take = Math.min(front.qtyLeft, need);
        if (poNumber == null) { poNumber = front.poNumber; poEta = front.eta; poSupplierId = front.supplierId; }
        front.qtyLeft -= take;
        need -= take;
        if (front.qtyLeft <= 0) poQueue.shift();
      }
      const ordered = eff - need;                     // covered by pooled stock+PO

      /* Audit D6 — same rule as section 7: the allocation above always runs;
         the flag only controls whether the (undated) set is rendered. */
      if (!includeUndated && !isDatedLine(d)) continue;

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
        orderByDate: orderByOf(setDelivery, prod?.category ?? null, whId, mainByCode.get(d.item_code)?.code ?? null),
        itemCode: d.item_code,
        description: prod?.name ?? d.description ?? null,
        variantLabel: buildVariantSummary(d.item_group, v) || null,
        modules,
        colour: colour || null,
        qty: eff,
        orderedQty: ordered,
        stockQty: fromStock, // on-hand units this set consumed (assigned-stock signal)
        shortageQty: need,
        poNumber,
        poEta,
        // PO-covered sets carry the covering PO's supplier (read-only); it's
        // only non-null when a PO was actually consumed above. Name resolved
        // from the same map the general path uses, so sofa + general display
        // identically (fixes the sofa "—" supplier).
        poSupplierId,
        poSupplierName: poSupplierId ? (supplierNameById.get(poSupplierId) ?? null) : null,
        suppliers: suppliersByCode.get(d.item_code) ?? [],
      });
    }
  }
  // To-order sets float to the top, then by earliest delivery date.
  sofaSets.sort((a, b) => {
    const sa = a.shortageQty > 0 ? 1 : 0;
    const sb = b.shortageQty > 0 ? 1 : 0;
    if (sa !== sb) return sb - sa;
    // Commander 2026-05-29 — soonest order-by date first.
    return byDateAsc(a.orderByDate, b.orderByDate);
  });

  return {
    asOf: new Date().toISOString(),
    categories: [...categorySet].sort(),
    warehouses: warehouses ?? [],
    skus,
    sofaSets,
    unmatchedCommitments,
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

/* Flatten an MRP result into a per-SO-line coverage map (keyed by
   mfg_sales_order_items.id). The Sales-Order drill-down stamps each line from
   this so its Stock column shows the exact same Stock / PO·ETA / Pending the
   MRP page computed — one allocation, one source of truth. */
export function mrpLineCoverage(result: MrpResult): Map<string, SoLineCoverage> {
  const map = new Map<string, SoLineCoverage>();
  for (const sku of result.skus) {
    for (const l of sku.lines) {
      map.set(l.soItemId, { source: l.source, po: l.poNumber, eta: l.poEta });
    }
  }
  // Sofa SETS aren't in skus[].lines — derive their source from picked vs short.
  for (const s of result.sofaSets) {
    const source: AllocSource =
      s.shortageQty > 0 ? (s.poNumber ? 'po' : 'shortage')
      : s.poNumber ? 'po'
      : 'stock';
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
  assigned: number;            // on-hand units MRP allocated to SO demand in this bucket
  claims: MrpStockClaim[];     // which SO(s) the assigned units belong to
};

/* Key a stock-assignment bucket the SAME way the reservations endpoint keys a
   lot: `${warehouse}|${item_code}|${variant_key}` (WH_NONE for a null warehouse,
   matching composite() above). */
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
    // Collapse repeat SO docs (a split line) into one claim.
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
  // Sofa SETS aren't in skus[].lines — their stockQty is the assigned-stock slice.
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

/* One floating-coverage assignment, seen from the PURCHASE side: a PO's supply
   is currently covering this outstanding Sales-Order line. Advisory only. */
export type PoCoverageAssignment = {
  soItemId: string;      // mfg_sales_order_items.id (lets the UI deep-link the SO)
  soDocNo: string;       // Sales Order document number (clickable target)
  itemCode: string;      // the SKU the coverage matched on
  variantLabel: string | null;
  deliveryDate: string | null; // the covered SO LINE's delivery date (owner ask)
  debtorName: string | null;
  warehouseName: string | null;
  qty: number;           // the SO line's still-to-fulfil qty (advisory)
};

/* Reverse of mrpLineCoverage: group the SAME floating allocation by the COVERING
   PO number, so a purchase document (PO / GRN / PI) can show which outstanding
   Sales-Order line(s) its supply is currently floating-assigned to, and that SO
   line's delivery date — matched by SKU (coverage is computed per
   (warehouse, code, variant) bucket, so an assignment's itemCode always equals
   the covering PO line's material_code).

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
  // Sofa SETS aren't in skus[].lines — a set with a covering PO is an assignment.
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

mrp.get('/', async (c) => {
  const sb = c.get('supabase');
  const category = c.req.query('category');
  const warehouseId = c.req.query('warehouseId');
  const catFilter = category && category !== 'all' ? category.toUpperCase() : null;
  const whFilter = warehouseId && warehouseId !== 'all' ? warehouseId : null;
  // Commander 2026-05-29 — an SO line with NO delivery date means the customer
  // isn't ready for goods yet, so it shouldn't drive ordering. HIDE undated
  // demand by default; ?includeUndated=true shows it. Since audit D6
  // (2026-08-01) the flag is display-only: the allocation itself always runs
  // over the full demand set (undated last), so this page, the SO drill-down
  // and the PO Assigned-SO column read ONE identical allocation.
  const includeUndated = c.req.query('includeUndated') === 'true';
  try {
    const result = await computeMrp(sb, { catFilter, whFilter, includeUndated, companyId: activeCompanyId(c), leadBuffers: await loadLeadBuffers(c.env.DB) });
    return c.json(result);
  } catch (e) {
    return c.json({ error: 'load_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});
