// ----------------------------------------------------------------------------
// Pure reference model of the FIFO trigger's OUT / negative-ADJUSTMENT consume,
// AFTER the ledger-divergence fix (migration 0195 + the mirrored canonical port
// backend/scripts/scm-schema/inventory-fifo-trigger.sql).
//
// The real consume runs in PL/pgSQL (fn_inventory_movement_fifo → fn_consume_fifo
// / fn_consume_fifo_batch); this repo's vitest harness rebuilds only the D1 side
// and cannot run the scm Supabase-Postgres layer — the same limitation the
// oversell-retrocost + stock-transfer-atomic tests note. So this module is the
// executable specification the SQL is written against, and what fifo-out-consume
// .test.ts exercises. KEEP THE TWO IN LOCKSTEP: any change to the trigger's OUT
// branch must change this too.
//
// THE FIX MODELLED HERE. Before 0195 the OUT branch ran the exact-batch consume
// (fn_consume_fifo_batch) and DISCARDED the qty_short it returned — so a sofa OUT
// whose batch_no did not string-equal its open lots' batch matched zero lots and
// shipped uncosted + un-decremented forever (the MAKOTO false-short). After 0195,
// when the exact-batch consume shorts, it FALLS BACK to plain product+variant FIFO
// (any batch) for the residual, so present stock of the same SKU is consumed +
// costed. A genuine short (no stock at all) still returns qtyShort > 0.
// ----------------------------------------------------------------------------

/** One open FIFO lot for a single (warehouse, product, variant) bucket. The
 *  caller has already filtered to the OUT's warehouse + item_code + variant_key
 *  (both consumers key on all three); batchNo is what the exact-batch pass keys on. */
export type OutLot = {
  lotId: string;
  /** inventory_lots.received_at (ISO). FIFO order. */
  receivedAt: string;
  qtyRemaining: number;
  unitCostSen: number;
  /** inventory_lots.batch_no — the GRN-stamped source-PO batch (migration 0120),
   *  or null for un-batched stock (opening balances / plain categories). */
  batchNo: string | null;
};

export type OutConsumeResult = {
  /** total_cost_sen stamped onto the movement (batch cost + any fallback cost). */
  totalCostSen: number;
  /** unit_cost_sen stamped onto the movement (weighted avg over the shipped qty). */
  unitCostSen: number;
  /** Units still uncosted after the batch consume AND the plain-FIFO fallback —
   *  a GENUINE short (no open stock for the SKU). Left for the 0154 receipt-time
   *  retro-cost path, exactly as before. */
  qtyShort: number;
  /** Units actually consumed from lots (= abs(qty) − qtyShort). */
  qtyConsumed: number;
  /** Lots with qty_remaining decremented by what was consumed. */
  lotsAfter: OutLot[];
  /** true when the exact-batch pass shorted and the plain-FIFO fallback ran. */
  usedFallback: boolean;
};

/** FIFO order: oldest received first, lotId as the deterministic tiebreak (the SQL
 *  uses received_at ASC, id ASC). */
function fifo(a: OutLot, b: OutLot): number {
  if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1;
  return a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0;
}

/** Consume `need` units from `lots` (mutated in place, already FIFO-sorted),
 *  optionally restricted to a single batch. Returns cost booked + qty taken. */
function consume(lots: OutLot[], need: number, batchNo: string | null): { cost: number; taken: number } {
  let remaining = need;
  let cost = 0;
  let taken = 0;
  for (const lot of lots) {
    if (remaining <= 0) break;
    if (lot.qtyRemaining <= 0) continue;
    if (batchNo !== null && lot.batchNo !== batchNo) continue; // exact-batch pass
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
      // 0195 fallback — plain product+variant FIFO for whatever the batch shorted.
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
