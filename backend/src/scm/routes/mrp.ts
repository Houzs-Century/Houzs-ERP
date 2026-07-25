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
import {
  loadLeadTimeBase,
  resolveLeadDays,
  subtractCalendarDays,
  LEAD_TIME_SELECT,
  NO_BUFFERS,
  type LeadBuffers,
} from '../lib/lead-time';
import { loadLeadBuffers } from '../../services/agents/procurement-learning';
import type { Env, Variables } from '../env';

export const mrp = new Hono<{ Bindings: Env; Variables: Variables }>();
mrp.use('*', supabaseAuth);

/* SO statuses that no longer create demand (already shipped / closed). */
const SO_DONE = new Set(['DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED', 'DRAFT']);
/* PO statuses that no longer supply goods. DRAFT is included: a draft PO is
   not yet committed, so it must NOT count as incoming supply — otherwise a
   draft PO would make an SO line look "covered" and hide a real shortage from
   MRP + the From-SO shortage cap (leak guard, Draft/Confirmed rollout). */
const PO_DEAD = new Set(['CANCELLED', 'DRAFT']);

type DemandRow = {
  id: string;
  doc_no: string;
  item_code: string;
  description: string | null;
  item_group: string | null;
  variants: Record<string, unknown> | null;
  qty: number;
  warehouse_id: string | null; // SO line's ship-from warehouse (migration 0118)
  line_delivery_date: string | null;
  line_no: number | null;
  created_at: string | null;
  cancelled: boolean;
  so: {
    debtor_name: string | null;
    status: string;
    so_date: string | null;
    customer_delivery_date: string | null;
    internal_expected_dd: string | null; // processing date (drives when to order)
    customer_state: string | null;       // staff #8 — show the customer's state (info-only)
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
/* Commander 2026-05-31 — every bucket is scoped by warehouse: stock can't cross
   warehouses, so a (code, variant) pair in KL is a DIFFERENT bucket from the
   same pair in PJ. NULL warehouse (unmapped state / pre-backfill line) gets its
   own WH_NONE bucket so it never silently shares another warehouse's stock. */
const WH_NONE = 'NOWH';
const composite = (whId: string | null, code: string, vkey: string): string =>
  `${whId ?? WH_NONE}|${code}|${vkey}`;

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

export type MrpResult = {
  asOf: string;
  categories: string[];
  warehouses: unknown[];
  skus: MrpSku[];
  sofaSets: SofaSet[];
  totals: {
    skuCount: number;
    shortageSkuCount: number;
    shortageUnits: number;
    sofaSetCount: number;
    sofaSetShortageCount: number;
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
  const { data: demandRaw, error: demandErr } = await scoped(sb
    .from('mfg_sales_order_items')
    .select(`
      id, doc_no, item_code, description, item_group, variants, qty, warehouse_id, line_delivery_date, line_no, created_at, cancelled,
      so:mfg_sales_orders!inner ( debtor_name, status, so_date, customer_delivery_date, internal_expected_dd, customer_state )
    `)
    .eq('cancelled', false))
    .limit(5000);
  if (demandErr) throw new Error(`mrp_load_failed: ${demandErr.message}`);

  const demandActive = ((demandRaw ?? []) as unknown as DemandRow[]).filter(
    (r) => r.item_code && r.so && !SO_DONE.has(r.so.status) && r.qty > 0
      // Undated lines (no line delivery date AND no SO delivery date) are not
      // ready to order — drop them unless the caller explicitly asks for them.
      && (includeUndated || Boolean(r.line_delivery_date ?? r.so.customer_delivery_date)),
  );

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
  const prodByCode = new Map<string, ProductRow>();
  const demandCodes = [...new Set(demand.map((d) => d.item_code).filter((c): c is string => !!c))];
  for (let i = 0; i < demandCodes.length; i += 300) {
    const chunk = demandCodes.slice(i, i + 300);
    if (chunk.length === 0) continue;
    const { data: prods } = await scoped(sb
      .from('mfg_products')
      .select('code, name, category')
      .in('code', chunk));
    for (const p of (prods ?? []) as ProductRow[]) prodByCode.set(p.code, p);
  }

  // The category dropdown lists every catalog category (a handful of enum
  // values), independent of current demand — derive it from a lightweight
  // category-only fetch (the few distinct values all surface within the cap).
  const categorySet = new Set<string>();
  const { data: catRows } = await scoped(sb.from('mfg_products').select('category'));
  for (const c of (catRows ?? []) as Array<{ category: string | null }>) {
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

  // ── 3. Stock on hand — inventory_balances keyed by (warehouse, code, variant) ──
  // Commander 2026-05-31 — warehouse is part of the bucket identity (no cross-WH
  // pooling). whFilter scopes the query to one warehouse; otherwise every
  // warehouse's balance lands in its own bucket.
  let balQ = scoped(sb.from('inventory_balances').select('product_code, warehouse_id, variant_key, qty'));
  if (whFilter) balQ = balQ.eq('warehouse_id', whFilter);
  const { data: balances } = await balQ;
  const stockByKey = new Map<string, number>();
  for (const b of (balances ?? []) as BalanceRow[]) {
    const k = composite(b.warehouse_id ?? null, b.product_code, b.variant_key ?? '');
    stockByKey.set(k, (stockByKey.get(k) ?? 0) + (b.qty ?? 0));
  }

  // ── 4. Outstanding PO supply — open PO lines with ETA, keyed by (warehouse, code, variant) ──
  // Each PO line's ship-to warehouse = line warehouse_id, falling back to the PO
  // header's purchase_location_id. No SO↔PO linkage — supply is a pure pool.
  const { data: poRaw } = await scoped(sb
    .from('purchase_order_items')
    .select(`
      material_code, item_group, variants, qty, received_qty, delivery_date,
      supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4,
      warehouse_id, so_item_id,
      po:purchase_orders!inner ( po_number, status, expected_at, supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4, purchase_location_id, supplier_id )
    `))
    .limit(5000);
  // Commander 2026-05-31 — carry the covering PO's supplier so a covered line
  // can display it read-only (a raised PO's supplier is fixed). Name resolved
  // from the suppliers map below.
  type PoSupply = { poNumber: string; eta: string | null; qtyLeft: number; supplierId: string | null };
  const poByKey = new Map<string, PoSupply[]>();
  const poOutstandingByKey = new Map<string, number>();
  const poSupplierIds = new Set<string>();
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
    const arr = poByKey.get(k) ?? [];
    arr.push({ poNumber: r.po.po_number, eta, qtyLeft: left, supplierId: r.po.supplier_id ?? null });
    poByKey.set(k, arr);
    poOutstandingByKey.set(k, (poOutstandingByKey.get(k) ?? 0) + left);
    if (r.po.supplier_id) poSupplierIds.add(r.po.supplier_id);
  }
  // Resolve PO supplier ids → names for the read-only covered-line display.
  const supplierNameById = new Map<string, string>();
  if (poSupplierIds.size > 0) {
    const { data: poSups } = await scoped(sb
      .from('suppliers')
      .select('id, name')
      .in('id', [...poSupplierIds]));
    for (const s of (poSups ?? []) as Array<{ id: string; name: string }>) {
      supplierNameById.set(s.id, s.name);
    }
  }
  for (const arr of poByKey.values()) arr.sort((a, b) => byDateAsc(a.eta, b.eta));

  // ── 5. Suppliers per SKU — main + alternates (so the UI can switch supplier
  //       in-place before posting the PO, AutoCount-style). ────────────────
  type SupplierOpt = { supplierId: string; code: string; name: string; isMain: boolean };
  const codes = [...new Set(demand.map((d) => d.item_code))];
  const mainByCode = new Map<string, { code: string; name: string }>();
  const suppliersByCode = new Map<string, SupplierOpt[]>();
  if (codes.length > 0) {
    const { data: binds } = await scoped(sb
      .from('supplier_material_bindings')
      .select('material_code, is_main_supplier, supplier_id, supplier:suppliers(code, name)')
      .eq('material_kind', 'mfg_product')
      .in('material_code', codes))
      .order('is_main_supplier', { ascending: false });
    for (const b of (binds ?? []) as Array<{ material_code: string; is_main_supplier: boolean; supplier_id: string; supplier: { code: string; name: string } | Array<{ code: string; name: string }> | null }>) {
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
    // Clone PO supply so the greedy walk can mutate qtyLeft without touching the
    // shared map. Fold in the same-warehouse EMPTY-variant PO pool (legacy POs
    // created before SO→PO carried variants → key ''), so a PO raised for a
    // bedframe still shows as supply against the variant row.
    //
    // Audit R4 (legacy-variant double-count) — the legacy '' pool is a FALLBACK,
    // NOT an addition. It is folded in ONLY when this real-variant bucket has no
    // PO supply of its own; it must never be added ON TOP of the variant's own
    // PO. Adding both let a single physical legacy PO line count its quantity
    // twice — once against the real-variant row (as extra supply) and again as
    // the '' bucket's own supply / against every other variant row of the SKU —
    // inflating PO Outstanding and over-covering demand (understating shortage).
    // Prefer the real variant; '' answers only when the real one is silent.
    const legacyKey = composite(whId, code, '');
    const ownPo = poByKey.get(k) ?? [];
    const useLegacy = bucket.vkey !== '' && legacyKey !== k && ownPo.length === 0;
    const poQueue: PoSupply[] = [
      ...ownPo,
      ...(useLegacy ? (poByKey.get(legacyKey) ?? []) : []),
    ].map((p) => ({ ...p })).sort((a, b) => byDateAsc(a.eta, b.eta));

    const lines: MrpLine[] = [];
    let qtyNeeded = 0;
    for (const r of rows) {
      const eff = effQtyOf(r);                              // qty still to fulfil (ordered − delivered + returned)
      qtyNeeded += eff;
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
        processingDate: r.so?.internal_expected_dd ?? null,
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

    const stock = stockByKey.get(k) ?? 0;
    const poOutstanding = (poOutstandingByKey.get(k) ?? 0)
      + (useLegacy ? (poOutstandingByKey.get(legacyKey) ?? 0) : 0);
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
  type SofaBucket = { whId: string | null; rows: DemandRow[] };
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
    const k = composite(whId, d.item_code, variantKeyOf(d.item_group, d.variants));
    const bucket = sofaByKey.get(k) ?? { whId, rows: [] };
    bucket.rows.push(d);
    sofaByKey.set(k, bucket);
  }

  const sofaSets: SofaSet[] = [];
  for (const [k, bucket] of sofaByKey.entries()) {
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
    const poQueue: PoSupply[] = [...(poByKey.get(k) ?? [])]
      .map((p) => ({ ...p }))
      .sort((a, b) => byDateAsc(a.eta, b.eta));

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
        processingDate: d.so?.internal_expected_dd ?? null,
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
    totals: {
      skuCount: skus.length,
      shortageSkuCount: skus.filter((s) => s.shortage > 0).length,
      shortageUnits: skus.reduce((acc, s) => acc + s.shortage, 0),
      sofaSetCount: sofaSets.length,
      sofaSetShortageCount: sofaSets.filter((s) => s.shortageQty > 0).length,
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
  // isn't ready for goods yet, so it shouldn't drive ordering. Exclude undated
  // demand by default; ?includeUndated=true brings it back for a full view.
  const includeUndated = c.req.query('includeUndated') === 'true';
  try {
    const result = await computeMrp(sb, { catFilter, whFilter, includeUndated, companyId: activeCompanyId(c), leadBuffers: await loadLeadBuffers(c.env.DB) });
    return c.json(result);
  } catch (e) {
    return c.json({ error: 'load_failed', reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});
