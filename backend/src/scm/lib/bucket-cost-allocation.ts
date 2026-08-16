// ----------------------------------------------------------------------------
// bucket-cost-allocation — split a bucket's ACTUAL booked cost across the lines
// that drew from it, so the lines sum back to what was booked.
//
// THE RULE THIS IMPLEMENTS (owner, 2026-08-14): money is carried to the sen, and
// anything finer rounds to the nearest sen. A unit cost is therefore a DERIVED
// figure — the total is the authority, not the other way round. That is also
// ordinary ERP practice: a receipt's landed cost is a total, and the per-unit
// number is what you get when you divide it.
//
// WHAT WENT WRONG WITHOUT IT. `delivery-orders-mfg` restamped each line as
// `round(bucket_cost / bucket_qty) * line_qty`. Rounding to the sen is correct;
// multiplying the ROUNDED figure back out is not, and it is the same defect the
// ledger recorded as B5:
//
//     bucket: 50 sen booked over 100 units
//     unit  : round(50 / 100) = round(0.5) = 1 sen        <- correct so far
//     line  : 1 sen x 100 units = 100 sen                 <- 50 sen invented
//
// The other direction is worse and quieter: 0.4 sen a unit rounds to 0, and the
// whole cost disappears. Both only bite when the per-unit cost is SUB-SEN, which
// is exactly what a small freight allocation or a partly-uncosted batch looks
// like.
//
// The remainder goes to the LAST line, matching `landed-allocation.ts:133` —
// this repo already had one house pattern for "make the column sum exactly" and
// a second one would just be a second thing to keep in step.
// ----------------------------------------------------------------------------

export interface BucketLine {
  /** Caller's line id. Returned untouched as the map key. */
  id: string;
  /** This line's quantity out of the bucket. Non-positive lines get 0. */
  qty: number;
}

export interface AllocatedCost {
  /** This line's share of the bucket, in sen. The shares sum to `netCost`. */
  lineCostSen: number;
  /** Derived, for display and for the ship-cost freeze: round(share / qty). */
  unitCostSen: number;
}

/**
 * Split `netCostSen` across `lines` in proportion to qty.
 *
 * Guarantees, in this order of priority:
 *   1. the shares sum EXACTLY to `netCostSen` — never more, never less;
 *   2. every share is a whole number of sen;
 *   3. each share is as close to its proportional value as (1) and (2) allow.
 *
 * A bucket with no positive quantity allocates nothing: there is no basis to
 * split on, and inventing one would put cost on a line that took no stock.
 */
export function allocateBucketCost(
  lines: readonly BucketLine[],
  netCostSen: number,
): Map<string, AllocatedCost> {
  const out = new Map<string, AllocatedCost>();
  const positive = lines.filter((l) => Number(l.qty) > 0);
  const totalQty = positive.reduce((s, l) => s + Number(l.qty), 0);

  if (totalQty <= 0) {
    for (const l of lines) out.set(l.id, { lineCostSen: 0, unitCostSen: 0 });
    return out;
  }

  let allocated = 0;
  const lastId = positive[positive.length - 1]!.id;
  for (const l of positive) {
    const qty = Number(l.qty);
    /* The last line takes what is left rather than its own rounded share, so
       the column sums to netCostSen exactly. Rounding every line independently
       leaves a remainder of up to (lines - 1) sen unaccounted for. */
    const share = l.id === lastId
      ? netCostSen - allocated
      : Math.round((netCostSen * qty) / totalQty);
    if (l.id !== lastId) allocated += share;
    out.set(l.id, { lineCostSen: share, unitCostSen: Math.round(share / qty) });
  }
  for (const l of lines) {
    if (!out.has(l.id)) out.set(l.id, { lineCostSen: 0, unitCostSen: 0 });
  }
  return out;
}

/**
 * Group `items` by bucket and allocate each bucket's booked cost across them.
 *
 * A line whose bucket has no booked outflow is ABSENT from the result, not zero
 * — the caller leaves those alone rather than restamping them to nothing, which
 * is the behaviour the DO restamp loop already had and must keep.
 */
export function allocateAcrossBuckets<T extends { id: string; qty?: unknown }>(
  items: readonly T[],
  buckets: ReadonlyMap<string, { net_qty: number; net_cost: number }>,
  keyOf: (item: T) => string,
): Map<string, AllocatedCost> {
  const byBucket = new Map<string, BucketLine[]>();
  for (const it of items) {
    const b = buckets.get(keyOf(it));
    if (!b || b.net_qty <= 0) continue;
    const list = byBucket.get(keyOf(it)) ?? [];
    list.push({ id: it.id, qty: Number(it.qty ?? 0) });
    byBucket.set(keyOf(it), list);
  }
  const out = new Map<string, AllocatedCost>();
  for (const [key, lines] of byBucket) {
    for (const [id, v] of allocateBucketCost(lines, buckets.get(key)!.net_cost)) out.set(id, v);
  }
  return out;
}
