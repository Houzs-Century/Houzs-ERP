// ----------------------------------------------------------------------------
// batch-claimed-stock — units the sofa-set allocator ALREADY LOCKED onto a
// received batch are not free supply.
//
// THE CONTRADICTION THIS ENDS (prod 2026-08-24 — 2990-SO-2607-019 vs
// 2990-SO-2608-006, XAMMAR EZ-001 / SEAT28 / LEG6"): two engines answered
// "whose unit is this?" differently.
//
//   · so-stock-allocation.ts + sofa-set-coverage.ts are batch-STRICT: a sofa
//     set is filled whole from ONE batch or not at all, and the winning batch
//     is stamped onto every module line as
//     mfg_sales_order_items.allocated_batch_no (stock_status READY). The DO
//     ship-gate enforces the same lock — those units WILL ship on that SO.
//   · computeMrp was batch-BLIND: pooled greedy by delivery date per
//     (warehouse, item_code, variant_key). It handed -006's claimed 2A(RHF)
//     unit to -019 (earlier delivery date), so the page showed -019's RHF as
//     "stock" it could never ship and -006's RHF as SHORT when its unit was
//     never in danger.
//   · Worse than two wrong chips: the From-SO picker reads the SAME coverage
//     (outstanding-so-items → computeMrp shortageQty), so the line that
//     actually needed ordering (-019's RHF, coverage stolen by the claim)
//     reported shortage 0 and could not be picked — while the single-side
//     order the page did suggest (1A(LHF) only) could never make -019 READY,
//     because no single batch would ever hold both of its modules: the RHF
//     would sit in the old batch, the LHF in the new one. A deadlock the
//     operator cannot see, not a display bug.
//
// THE RULE, the same carve-out shape as applyCommittedSupply gives ship
// commitments (ship-commitment.ts): a claimed unit is REMOVED from the free
// pool and SERVED to the line that owns the claim, never rationed by date.
// Unlike a ship commitment there is no add-back leg: allocated_batch_no is
// only ever stamped once the batch is physically received, so the claimed
// units are still ON HAND — demand and units coexist in the same bucket, and
// the fix is to PAIR them instead of letting the date-greedy walk hand the
// units to whoever sorts first.
//
// Pure decisions only — no database. mrp.ts feeds these functions the demand
// rows it already reads and walks its buckets exactly as before; the tests
// (mrpBatchClaimedStock.test.ts) drive the same functions with the two-SO
// scenario above.
// ----------------------------------------------------------------------------

export type ClaimedDemandLine = {
  /** mfg_sales_order_items.id — the walk's handle for the line. */
  soItemId: string;
  /** composite(warehouse, item_code, variant_key) — the MRP bucket. Opaque
   *  here; built by the caller with the SAME composite() the buckets use, so
   *  a claim can never land beside the pool it is meant to reduce. */
  bucketKey: string;
  /** mfg_sales_order_items.allocated_batch_no — non-null means the allocator
   *  locked a PHYSICALLY RECEIVED batch onto this line (sofa whole-set rule,
   *  so-stock-allocation.ts section 7b). */
  allocatedBatchNo: string | null;
  /** Units still to fulfil (qty − delivered + returned), the same effQty the
   *  walk allocates. The claim is only as big as what is still owed: a line
   *  that part-shipped already gave those units back to the ledger (the OUT
   *  movement took them off inventory_balances), so counting the ORIGINAL qty
   *  would reserve stock that no longer exists. */
  remainingQty: number;
};

export type BatchClaims = {
  /** soItemId → units the allocator locked for that line. */
  qtyByLine: Map<string, number>;
  /** bucketKey → total locked units, carved out of that bucket's pool. */
  qtyByBucket: Map<string, number>;
};

/** Fold the demand lines into "units the allocator already spoke for", per
 *  line and per bucket. Lines with no batch lock, or nothing left to fulfil,
 *  contribute nothing — a shipped-out claim disappears on its own because the
 *  remaining qty reaches 0, mirroring how outstandingCommitments lets a netted
 *  shipment drop out of the MRP deduction without anything being un-set. */
export function collectBatchClaims(lines: ClaimedDemandLine[]): BatchClaims {
  const qtyByLine = new Map<string, number>();
  const qtyByBucket = new Map<string, number>();
  for (const l of lines) {
    if (!l.allocatedBatchNo) continue;
    const qty = Number(l.remainingQty ?? 0);
    if (qty <= 0) continue;
    qtyByLine.set(l.soItemId, (qtyByLine.get(l.soItemId) ?? 0) + qty);
    qtyByBucket.set(l.bucketKey, (qtyByBucket.get(l.bucketKey) ?? 0) + qty);
  }
  return { qtyByLine, qtyByBucket };
}

/** One bucket's on-hand, split into the claim RESERVE (only the lines that own
 *  a claim may draw it) and the FREE pool (everyone, by date, as always). */
export type BucketStock = { reserve: number; free: number };

/** Split a bucket's on-hand figure when the walk opens the bucket.
 *
 *  The reserve is capped on BOTH sides. By the claims, obviously; by the
 *  on-hand too, because a claim can outlive its stock — the batch's units may
 *  have been transferred, stock-taken or oversold since the allocator last
 *  recomputed. A stale claim reserves only what is actually there, and the
 *  claiming line falls through to the free pool / PO queue for the rest,
 *  exactly like any other line.
 *
 *  A NEGATIVE balance carves no reserve and rides the free pool untouched:
 *  the walk has always let a bucket's nameless negative tax whichever line
 *  walks first (see mrp.ts section 4b on that phrase), and this split must
 *  not move that tax onto the claim. */
export function openBucketStock(onHand: number, claimedQty: number): BucketStock {
  const reserve = Math.min(Math.max(claimedQty, 0), Math.max(onHand, 0));
  return { reserve, free: onHand - reserve };
}

/** Serve one line's stock draw: its own claim first (out of the reserve),
 *  then the free pool for whatever the claim did not cover. Mutates `stock`,
 *  the walk's per-bucket counters. Returns the units taken — the walk's
 *  `fromStock`, byte-compatible with the `Math.min(stockLeft, need)` it
 *  replaces: an unclaimed line (lineClaim 0) draws `Math.min(free, need)`
 *  including the pre-existing negative-balance behaviour, and a fully-claimed
 *  line never touches the free pool at all. */
export function drawBucketStock(stock: BucketStock, lineClaim: number, need: number): number {
  const fromReserve = Math.max(0, Math.min(lineClaim, stock.reserve, need));
  stock.reserve -= fromReserve;
  const remainder = need - fromReserve;
  const fromFree = remainder > 0 ? Math.min(stock.free, remainder) : 0;
  stock.free -= fromFree;
  return fromReserve + fromFree;
}
