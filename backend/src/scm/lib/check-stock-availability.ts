// ----------------------------------------------------------------------------
// check-stock-availability — soft "stock not enough" guard for DO ship paths
// (Commander 2026-05-30, Edge #1 + #2).
//
// Before a DO writes its OUT movements (or extends them via line-add / qty-up
// on a shipped DO), this helper aggregates the requested qty per
// (product_code, variant_key) bucket and compares to the live qty on hand at
// the target warehouse (inventory_balances). When short, it also looks up
// alternative warehouses that DO have stock so the operator can decide whether
// to ship anyway, switch warehouse, or stop.
//
// Soft check by design — caller gates on the operator's confirmShortStock
// flag (small-shop reality, "stock 不够, 继续吗?"). Never throws; an empty
// shortages array means everything fits at this warehouse.
// ----------------------------------------------------------------------------

import { isServiceLine } from '../shared';

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
 */
export function stockCheckableLines<
  T extends { itemCode: string; itemGroup?: string | null; qty: number },
>(lines: T[]): T[] {
  return lines.filter(
    (l) =>
      Number(l.qty) > 0
      && !isServiceLine({ itemGroup: l.itemGroup ?? null, itemCode: l.itemCode }),
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
 * Aggregates lines that share the same (product_code, variant_key) bucket so
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
  type Bucket = { product_code: string; variant_key: string; product_name: string | null; needed: number };
  const byBucket = new Map<string, Bucket>();
  for (const l of lines) {
    const qty = Number(l.qty || 0);
    if (qty <= 0) continue;
    const k = `${l.itemCode}::${l.variantKey ?? ''}`;
    const cur = byBucket.get(k);
    if (cur) { cur.needed += qty; }
    else byBucket.set(k, {
      product_code: l.itemCode,
      variant_key: l.variantKey ?? '',
      product_name: l.productName ?? null,
      needed: qty,
    });
  }
  const buckets = [...byBucket.values()];
  if (buckets.length === 0) return [];

  // Pull live qty at THIS warehouse per requested bucket.
  const productCodes = [...new Set(buckets.map((b) => b.product_code))];
  const { data: balRows } = await sb
    .from('inventory_balances')
    .select('product_code, variant_key, qty')
    .eq('warehouse_id', warehouseId)
    .in('product_code', productCodes);
  const balByBucket = new Map<string, number>();
  for (const r of (balRows ?? []) as Array<{ product_code: string; variant_key: string | null; qty: number }>) {
    balByBucket.set(`${r.product_code}::${r.variant_key ?? ''}`, Number(r.qty ?? 0));
  }

  const shortBuckets: Array<{ b: Bucket; available: number }> = [];
  for (const b of buckets) {
    const available = balByBucket.get(`${b.product_code}::${b.variant_key}`) ?? 0;
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
  const shortCodes = [...new Set(shortBuckets.map((s) => s.b.product_code))];
  const altByBucket = new Map<string, WarehouseAlt[]>();
  if (shortCodes.length > 0) {
    let altQuery = sb
      .from('inventory_balances')
      .select('warehouse_id, product_code, variant_key, qty')
      .neq('warehouse_id', warehouseId)
      .in('product_code', shortCodes)
      .gt('qty', 0);
    if (scoped) altQuery = altQuery.eq('company_id', companyId);
    const { data: altRows } = await altQuery;
    for (const r of (altRows ?? []) as Array<{ warehouse_id: string; product_code: string; variant_key: string | null; qty: number }>) {
      const wh = whById.get(r.warehouse_id);
      const k = `${r.product_code}::${r.variant_key ?? ''}`;
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
    itemCode: b.product_code,
    productName: b.product_name,
    variantKey: b.variant_key,
    warehouseId,
    warehouseName: targetWh?.name ?? null,
    needed: b.needed,
    available,
    short: b.needed - available,
    alternatives: (altByBucket.get(`${b.product_code}::${b.variant_key}`) ?? [])
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
