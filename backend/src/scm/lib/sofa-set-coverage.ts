
import { paginateAll } from './paginate-all';

export type SofaSetLine = { itemCode: string; variantKey: string; need: number };

/** key = `${warehouseId}|${batchNo}|${itemCode}|${variantKey}` → qty_remaining */
export type SofaBatchStock = {
  remaining: Map<string, number>;
  receivedAt: Map<string, string>;
  batches: Set<string>;
};

export function sofaStockKey(
  warehouseId: string,
  batchNo: string,
  itemCode: string,
  variantKey: string,
): string {
  return `${warehouseId}|${batchNo}|${itemCode}|${variantKey}`;
}

/** Load open-lot stock for `codes`, grouped per (warehouse, batch, code, variant).
 *  Only batched lots (batch_no NOT NULL) matter for sofa set matching. */
export async function loadSofaBatchStock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  codes: string[],
): Promise<SofaBatchStock> {
  const remaining = new Map<string, number>();
  const receivedAt = new Map<string, string>();
  const batches = new Set<string>();
  const wanted = new Set(codes.filter(Boolean));
  if (wanted.size === 0) return { remaining, receivedAt, batches };

  const { data: lots, error, truncated } = await paginateAll((from, to) => sb
    .from('v_inventory_lots_open')
    .select('warehouse_id, item_code, variant_key, batch_no, qty_remaining, received_at')
    .not('batch_no', 'is', null)
    .gt('qty_remaining', 0)
    .order('received_at', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to));
  if (error) throw new Error(`sofa batch stock load failed: ${error.message}`);
  if (truncated) throw new Error('sofa batch stock load failed: open batched lots exceed the page guard');

  for (const r of (lots ?? []) as Array<{
    warehouse_id: string; item_code: string; variant_key: string | null;
    batch_no: string; qty_remaining: number; received_at: string | null;
  }>) {
    if (!wanted.has(r.item_code)) continue;
    const v = r.variant_key ?? '';
    const k = sofaStockKey(r.warehouse_id, r.batch_no, r.item_code, v);
    remaining.set(k, (remaining.get(k) ?? 0) + Number(r.qty_remaining ?? 0));
    batches.add(r.batch_no);
    const rawRa: unknown = r.received_at;
    const ra = rawRa instanceof Date ? rawRa.toISOString() : (r.received_at ?? '');
    const prev = receivedAt.get(r.batch_no);
    if (prev === undefined || (ra && ra < prev)) receivedAt.set(r.batch_no, ra);
  }
  return { remaining, receivedAt, batches };
}

/** Find the single batch (in `warehouseId`) that completely covers EVERY line of
 *  the set — i.e. has qty_remaining ≥ need for each module. Returns the
 *  FIFO-oldest qualifying batch_no, or null if none covers the whole set.
 *  Does NOT mutate `stock`; call claimSofaBatch() after to decrement. */
export function findCoveringBatch(
  warehouseId: string | null,
  lines: SofaSetLine[],
  stock: SofaBatchStock,
): string | null {
  if (!warehouseId || lines.length === 0) return null;
  const needByKey = new Map<string, { itemCode: string; variantKey: string; need: number }>();
  for (const ln of lines) {
    const k = `${ln.itemCode}|${ln.variantKey}`;
    const e = needByKey.get(k) ?? { itemCode: ln.itemCode, variantKey: ln.variantKey, need: 0 };
    e.need += ln.need;
    needByKey.set(k, e);
  }
  const reqs = [...needByKey.values()];
  const candidates = [...stock.batches].sort((a, b) => {
    const ra = stock.receivedAt.get(a) ?? '';
    const rb = stock.receivedAt.get(b) ?? '';
    return ra !== rb ? ra.localeCompare(rb) : a.localeCompare(b);
  });
  for (const batch of candidates) {
    let coversAll = true;
    for (const r of reqs) {
      const have = stock.remaining.get(sofaStockKey(warehouseId, batch, r.itemCode, r.variantKey)) ?? 0;
      if (have < r.need) { coversAll = false; break; }
    }
    if (coversAll) return batch;
  }
  return null;
}

/** Decrement `stock.remaining` for a claimed batch so a later set in the same
 *  allocation walk can't double-claim the same units (cross-SO contention). */
export function claimSofaBatch(
  warehouseId: string,
  batch: string,
  lines: SofaSetLine[],
  stock: SofaBatchStock,
): void {
  for (const ln of lines) {
    const key = sofaStockKey(warehouseId, batch, ln.itemCode, ln.variantKey);
    stock.remaining.set(key, Math.max(0, (stock.remaining.get(key) ?? 0) - ln.need));
  }
}
