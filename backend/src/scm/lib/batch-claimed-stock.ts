
export type ClaimedDemandLine = {
  soItemId: string;
  bucketKey: string;
  allocatedBatchNo: string | null;
  remainingQty: number;
};

export type BatchClaims = {
  qtyByLine: Map<string, number>;
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
