// ----------------------------------------------------------------------------
// check-stock-availability — soft "stock not enough" guard for DO ship paths
// (Commander 2026-05-30, Edge #1 + #2).
//
// Before a DO writes its OUT movements (or extends them via line-add / qty-up
// on a shipped DO), this helper aggregates the requested qty per
// (item_code, variant_key) bucket and compares to the live qty on hand at
// the target warehouse (inventory_balances). When short, it also looks up
// alternative warehouses that DO have stock so the operator can decide whether
// to ship anyway, switch warehouse, or stop.
//
// Soft check by design — caller gates on the operator's confirmShortStock
// flag (small-shop reality, "stock 不够, 继续吗?"). Never throws; an empty
// shortages array means everything fits at this warehouse.
// ----------------------------------------------------------------------------

import { isServiceLine } from '../shared';
import { isHardBoundLine, HARD_BOUND_COMPANY_ID } from './so-stock-allocation';

export type StockLineRequest = {
  itemCode: string;
  productName: string | null;
  variantKey: string;
  qty: number;
};

/**
 * THE CHECK MUST MEASURE EXACTLY WHAT THE MOVEMENT WILL TOUCH.
 *
 * Every bug this guard has produced is the same shape: the pre-flight question
 * and the inventory write disagreed about which lines, or which warehouse, were
 * in play — so the operator was asked to waive a shortage that could not exist,
 * and "Ship anyway" became the only way forward on lines that never move stock.
 *
 * SERVICE lines are the line-level half of that rule. A delivery fee or a
 * dispose / lift add-on is not goods: it holds no inventory and never produces a
 * movement (shared/service-sku.ts, P1 §4.6 — deductInventoryForDo,
 * resyncInventoryForDo and the DR return-IN all skip them). Measured against
 * inventory_balances it can only ever read "need N, available 0". Nico's DO for
 * 2990-SO-2606-034 was blocked exactly this way on SVC-DISPOSE-SOFA and
 * SVC-DELIVERY-CROSS at BALAKONG (2026-08-03) — a shortage no amount of stock
 * could have cleared.
 *
 * Zero-qty lines drop out for the same reason: nothing ships, nothing moves.
 *
 * AND A HARD-BOUND LINE WHOSE OWN PURCHASE ORDER HAS BEEN RECEIVED IS NOT A
 * POOL QUESTION. `dedicatedlyCovered` carries those sales-order line ids, and
 * they are dropped here for the same reason service lines are: the pool is the
 * wrong thing to measure them against.
 *
 * Company 1 binds a bedframe / sofa / (SP) mattress line to the purchase order
 * raised from it — readiness lights that line off its OWN
 * `purchase_order_items.received_qty` and never consults `inventory_balances`
 * (so-stock-allocation.ts step 6b). This guard did not know that, and measured
 * every line against the shared bucket. The two halves then disagreed by
 * design: the order read READY and its delivery order read "need 1, available
 * 0" — because another order's delivery had drawn the physical units out of a
 * bucket this line's receipt had put in. Owner 2026-09-11: 「哪一张 Sales Order
 * 出货，它就会拿哪一张 PO，它们之间的 relationship 都是 hard binding，不是吗?」
 * — yes, and now both halves say so.
 *
 * Worked case: HC-SO-013065 JAGER-(Q). Its own PO HC-PO-009766 received 1/1
 * through HC-GR-005232-PO-009766 with the full variant, the line read READY,
 * and the PG bucket for that exact variant stood at -1 because other shipments
 * had drained it. The operator's only way out was Ship anyway, which pushes the
 * bucket further negative and makes the next line worse — the loop this closes.
 *
 * `dedicatedlyCovered` is REQUIRED, never defaulted: a caller that says nothing
 * would keep the old pooled answer with no compile error and no runtime signal
 * (CLAUDE.md, BUG CLASS optional-param-noop). Pass an EMPTY set to mean "this
 * caller has no binding to honour" — company 2 pools, and that is what it sends.
 */
export function stockCheckableLines<
  T extends { itemCode: string; itemGroup?: string | null; qty: number; soItemId?: string | null },
>(lines: T[], dedicatedlyCovered: ReadonlySet<string>): T[] {
  return lines.filter(
    (l) =>
      Number(l.qty) > 0
      && !isServiceLine({ itemGroup: l.itemGroup ?? null, itemCode: l.itemCode })
      && !(l.soItemId != null && dedicatedlyCovered.has(l.soItemId)),
  );
}

export type WarehouseAlt = {
  warehouseId: string;
  warehouseCode: string | null;
  warehouseName: string | null;
  available: number;
};

export type StockShortage = {
  itemCode: string;
  productName: string | null;
  variantKey: string;
  warehouseId: string;
  warehouseName: string | null;
  needed: number;
  available: number;
  short: number;
  alternatives: WarehouseAlt[];
};

/**
 * Resolve which requested lines exceed available qty at the given warehouse.
 * Aggregates lines that share the same (item_code, variant_key) bucket so
 * two lines of the same SKU don't each pass the check on full bucket qty.
 *
 * Returns [] when everything fits, or one shortage per under-stocked bucket
 * with alternative-warehouse hints attached.
 */
export async function checkStockAvailability(
  sb: any,
  warehouseId: string,
  lines: StockLineRequest[],
  companyId: number | null | undefined,
): Promise<StockShortage[]> {
  // Aggregate requested per bucket. Drop zero-qty lines (not shipped).
  type Bucket = { item_code: string; variant_key: string; product_name: string | null; needed: number };
  const byBucket = new Map<string, Bucket>();
  for (const l of lines) {
    const qty = Number(l.qty || 0);
    if (qty <= 0) continue;
    const k = `${l.itemCode}::${l.variantKey ?? ''}`;
    const cur = byBucket.get(k);
    if (cur) { cur.needed += qty; }
    else byBucket.set(k, {
      item_code: l.itemCode,
      variant_key: l.variantKey ?? '',
      product_name: l.productName ?? null,
      needed: qty,
    });
  }
  const buckets = [...byBucket.values()];
  if (buckets.length === 0) return [];

  // Pull live qty at THIS warehouse per requested bucket.
  const itemCodes = [...new Set(buckets.map((b) => b.item_code))];
  const { data: balRows } = await sb
    .from('inventory_balances')
    .select('item_code, variant_key, qty')
    .eq('warehouse_id', warehouseId)
    .in('item_code', itemCodes);
  const balByBucket = new Map<string, number>();
  for (const r of (balRows ?? []) as Array<{ item_code: string; variant_key: string | null; qty: number }>) {
    balByBucket.set(`${r.item_code}::${r.variant_key ?? ''}`, Number(r.qty ?? 0));
  }

  const shortBuckets: Array<{ b: Bucket; available: number }> = [];
  for (const b of buckets) {
    const available = balByBucket.get(`${b.item_code}::${b.variant_key}`) ?? 0;
    if (available < b.needed) shortBuckets.push({ b, available });
  }
  if (shortBuckets.length === 0) return [];

  // Pull warehouse names (target + alternatives) in one shot — SCOPED to the
  // active company. In the merged Houzs/2990 DB an unscoped select advertises
  // the OTHER company's warehouse to this operator; scoping the name lookup and
  // the alternatives scan below to company_id closes that. Degrades to no
  // predicate when the company is unresolved (single-company Houzs / cold-start),
  // matching scopeToCompany's fail-open on a READ.
  const scoped = Number.isInteger(companyId) && Number(companyId) > 0;
  let whQuery = sb.from('warehouses').select('id, code, name');
  if (scoped) whQuery = whQuery.eq('company_id', companyId);
  const { data: whRows } = await whQuery;
  const whById = new Map(((whRows ?? []) as Array<{ id: string; code: string; name: string }>).map((w) => [w.id, w]));
  const targetWh = whById.get(warehouseId);

  // Cross-warehouse hint — qty available at OTHER warehouses for the short
  // buckets. A single inventory_balances scan filtered to the same product
  // codes + > 0 qty avoids the N+1.
  const shortCodes = [...new Set(shortBuckets.map((s) => s.b.item_code))];
  const altByBucket = new Map<string, WarehouseAlt[]>();
  if (shortCodes.length > 0) {
    let altQuery = sb
      .from('inventory_balances')
      .select('warehouse_id, item_code, variant_key, qty')
      .neq('warehouse_id', warehouseId)
      .in('item_code', shortCodes)
      .gt('qty', 0);
    if (scoped) altQuery = altQuery.eq('company_id', companyId);
    const { data: altRows } = await altQuery;
    for (const r of (altRows ?? []) as Array<{ warehouse_id: string; item_code: string; variant_key: string | null; qty: number }>) {
      const wh = whById.get(r.warehouse_id);
      const k = `${r.item_code}::${r.variant_key ?? ''}`;
      const arr = altByBucket.get(k) ?? [];
      arr.push({
        warehouseId: r.warehouse_id,
        warehouseCode: wh?.code ?? null,
        warehouseName: wh?.name ?? null,
        available: Number(r.qty ?? 0),
      });
      altByBucket.set(k, arr);
    }
  }

  return shortBuckets.map(({ b, available }) => ({
    itemCode: b.item_code,
    productName: b.product_name,
    variantKey: b.variant_key,
    warehouseId,
    warehouseName: targetWh?.name ?? null,
    needed: b.needed,
    available,
    short: b.needed - available,
    alternatives: (altByBucket.get(`${b.item_code}::${b.variant_key}`) ?? [])
      .sort((a, c) => c.available - a.available), // highest-qty alternative first
  }));
}

/** An incoming PO a short line WILL be bound to if the operator ships anyway
 *  (scm/lib/ship-commitment.ts). Advisory payload for the dialog only — the
 *  binding itself is decided server-side on the confirmed replay, never from
 *  anything the client sends back. */
export type ShortStockBinding = { itemCode: string; poNumber: string; eta: string | null };

/** Canonical 409 response body for short-stock rejections. Caller should
 *  c.json(shortStockResponse(shortages, bindings), 409). The frontend catches
 *  this, shows a "stock not enough — continue?" dialog with the shortages, the
 *  cross-warehouse alternatives and (2026-07-31) the incoming PO each short line
 *  will bind to, then retries with confirmShortStock: true.
 *
 *  `bindings` is why the operator is only asked ONCE. "Ship anyway?" and "ship
 *  as drop-ship?" were the same question — the goods are not here — and the
 *  second one existed only to authorise the binding. Naming the incoming PO here
 *  puts that information in the first dialog, so the answer can carry it. */
export const shortStockResponse = (
  shortages: StockShortage[],
  bindings: ShortStockBinding[] = [],
) => ({
  error: 'short_stock',
  message:
    `Stock not enough at the selected warehouse for ${shortages.length} line${shortages.length === 1 ? '' : 's'}. ` +
    `Confirm to ship anyway, or switch warehouse / reduce qty first.`,
  shortages,
  ...(bindings.length > 0 ? { bindings } : {}),
});

/* WHICH LINES ALREADY HOLD THEIR OWN GOODS, so the shared pool is the wrong
   question for them. Company 1 binds a bedframe / sofa / (SP) mattress line to
   the purchase order raised from it; readiness lights that line off its own
   `received_qty` and never reads `inventory_balances`. Returns the sales-order
   line ids whose own purchase order has received at least what this delivery
   ships, for `stockCheckableLines` to drop.

   COMPANY 2 GETS AN EMPTY SET, and that is the whole of the company gate: 2990
   pools, so every line of theirs stays a pool question exactly as before.

   A cancelled purchase order proves nothing and is excluded. `received_qty` is
   summed because one sales-order line can be split across several purchase
   lines (allocations, mig 0235).

   Best-effort by construction: a failed read yields an empty set, which returns
   the guard to its previous, stricter behaviour rather than waving a line
   through — the safe direction when we cannot tell. */
export async function dedicatedlyCoveredSoItemIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client is untyped throughout this file
  sb: any,
  lines: Array<{ soItemId: string | null; itemCode: string; itemGroup?: string | null; qty: number }>,
  companyId: number | undefined,
): Promise<Set<string>> {
  if (companyId !== HARD_BOUND_COMPANY_ID) return new Set();
  const needBySoItem = new Map<string, number>();
  for (const l of lines) {
    if (!l.soItemId) continue;
    if (!isHardBoundLine(l.itemGroup ?? null, l.itemCode)) continue;
    needBySoItem.set(l.soItemId, (needBySoItem.get(l.soItemId) ?? 0) + Number(l.qty || 0));
  }
  if (needBySoItem.size === 0) return new Set();
  const { data, error } = await sb
    .from('purchase_order_items')
    .select('so_item_id, received_qty, po:purchase_orders!inner(status)')
    .in('so_item_id', [...needBySoItem.keys()]);
  if (error) {
    /* eslint-disable-next-line no-console */
    console.warn('[do-stock] dedicated-cover read failed, falling back to the pooled check:', error.message);
    return new Set();
  }
  const receivedBySoItem = new Map<string, number>();
  for (const r of (data ?? []) as Array<{ so_item_id: string | null; received_qty: number | null; po: { status?: string } | Array<{ status?: string }> | null }>) {
    if (!r.so_item_id) continue;
    const po = Array.isArray(r.po) ? r.po[0] : r.po;
    if ((po?.status ?? '') === 'CANCELLED') continue;
    receivedBySoItem.set(r.so_item_id, (receivedBySoItem.get(r.so_item_id) ?? 0) + Number(r.received_qty ?? 0));
  }
  /* AND THE WAREHOUSE MUST ACTUALLY HOLD THE GOODS — the earmark says which
     units are this line's, not that they exist. Measured before shipping this:
     of 462 lines the receipt test alone would wave through, 432 have the stock
     sitting in that warehouse under SOME variant key (the bucket is the wrong
     place to look, which is the whole point) and **30 do not** — for those the
     goods are genuinely not there and the old warning was RIGHT. Waving those
     through would trade a false "no stock" for a silent over-ship, which is the
     worse of the two errors. So the bucket-blind total is the second half of
     the test: skip the variant bucket, never skip the warehouse. */
  const covered = new Set<string>();
  const candidates = [...needBySoItem].filter(([id, need]) => (receivedBySoItem.get(id) ?? 0) >= need);
  if (candidates.length === 0) return covered;
  const byLine = new Map(lines.filter((l) => l.soItemId).map((l) => [l.soItemId as string, l]));
  const codes = [...new Set(candidates.map(([id]) => byLine.get(id)?.itemCode).filter((c): c is string => !!c))];
  const { data: bal, error: balError } = await sb
    .from('inventory_balances')
    .select('item_code, warehouse_id, qty')
    .in('item_code', codes);
  if (balError) {
    /* eslint-disable-next-line no-console */
    console.warn('[do-stock] on-hand read failed, falling back to the pooled check:', balError.message);
    return covered;
  }
  const onHand = new Map<string, number>();
  for (const b of (bal ?? []) as Array<{ item_code: string; warehouse_id: string | null; qty: number }>) {
    const k = `${b.warehouse_id ?? ''}::${b.item_code}`;
    onHand.set(k, (onHand.get(k) ?? 0) + Number(b.qty ?? 0));
  }
  for (const [soItemId, need] of candidates) {
    const l = byLine.get(soItemId);
    if (!l) continue;
    const wh = (l as { warehouseId?: string | null }).warehouseId ?? null;
    if ((onHand.get(`${wh ?? ''}::${l.itemCode}`) ?? 0) >= need) covered.add(soItemId);
  }
  return covered;
}

/* THE TWO-STEP THE DO PRE-FLIGHT RUNS, AND THE ORDER IS THE POINT — which is
   why it lives here rather than in the route. The cover test above asks whether
   THIS line's warehouse holds the goods, and a line's warehouse is
   `resolveDoLineWarehouses`'s answer, not a field on the request. So the caller
   resolves warehouses FIRST and hands the map in. The first cut of this fix
   computed cover before the warehouses were known, asked about warehouse
   `null`, and covered nothing — it typechecked, it passed its tests, and it did
   exactly nothing. Taking the map as a REQUIRED argument is what makes that
   mistake unwritable. */
export async function uncoveredStockCheckLines<
  T extends { lineRef: string; soItemId: string | null; itemCode: string; itemGroup?: string | null; qty: number },
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client is untyped throughout this file
  sb: any,
  shippable: T[],
  lineWh: Map<string, string | null>,
  companyId: number | undefined,
): Promise<T[]> {
  const covered = await dedicatedlyCoveredSoItemIds(
    sb,
    shippable.map((l) => ({ ...l, warehouseId: lineWh.get(l.lineRef) ?? null })),
    companyId,
  );
  return stockCheckableLines(shippable, covered);
}
