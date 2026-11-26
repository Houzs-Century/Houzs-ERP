
/** One open FIFO lot for a single (warehouse, product, variant) bucket. The
 *  caller has already filtered to the OUT's warehouse + item_code + variant_key
 *  (both consumers key on all three); batchNo is what the exact-batch pass keys on. */
export type OutLot = {
  lotId: string;
  receivedAt: string;
  qtyRemaining: number;
  unitCostSen: number;
  batchNo: string | null;
};

export type OutConsumeResult = {
  totalCostSen: number;
  unitCostSen: number;
  qtyShort: number;
  qtyConsumed: number;
  lotsAfter: OutLot[];
  usedFallback: boolean;
};

function fifo(a: OutLot, b: OutLot): number {
  if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1;
  return a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0;
}

function consume(lots: OutLot[], need: number, batchNo: string | null): { cost: number; taken: number } {
  let remaining = need;
  let cost = 0;
  let taken = 0;
  for (const lot of lots) {
    if (remaining <= 0) break;
    if (lot.qtyRemaining <= 0) continue;
    if (batchNo !== null && lot.batchNo !== batchNo) continue;
    const take = Math.min(lot.qtyRemaining, remaining);
    lot.qtyRemaining -= take;
    cost += take * lot.unitCostSen;
    taken += take;
    remaining -= take;
  }
  return { cost, taken };
}

/**
 * Model fn_inventory_movement_fifo's OUT branch for one OUT of `qty` units with an
 * optional dye-lot `batchNo`, against the bucket's open `lots`.
 *
 *   - batchNo != null → exact-batch consume (fn_consume_fifo_batch); if it shorts,
 *     the 0195 fallback consumes the residual via plain product+variant FIFO
 *     (fn_consume_fifo, any batch).
 *   - batchNo == null → plain product+variant FIFO only (unchanged pre/post 0195).
 *
 * qty is a positive count (the OUT stores it positive; the trigger uses ABS()).
 */
export function planOutConsume(qty: number, batchNo: string | null, lots: OutLot[]): OutConsumeResult {
  const absQty = Math.abs(qty);
  const lotsAfter = lots.map((l) => ({ ...l })).sort(fifo);

  let cost = 0;
  let short = absQty;
  let usedFallback = false;

  if (batchNo !== null) {
    const batchPass = consume(lotsAfter, absQty, batchNo);
    cost += batchPass.cost;
    short = absQty - batchPass.taken;
    if (short > 0) {
      usedFallback = true;
      const plainPass = consume(lotsAfter, short, null);
      cost += plainPass.cost;
      short -= plainPass.taken;
    }
  } else {
    const plainPass = consume(lotsAfter, absQty, null);
    cost += plainPass.cost;
    short = absQty - plainPass.taken;
  }

  const qtyConsumed = absQty - short;
  return {
    totalCostSen: cost,
    unitCostSen: absQty > 0 ? Math.trunc(cost / absQty) : 0,
    qtyShort: short,
    qtyConsumed,
    lotsAfter,
    usedFallback,
  };
}
