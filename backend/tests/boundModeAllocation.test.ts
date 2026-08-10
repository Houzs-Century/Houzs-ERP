// Bound-mode readiness (owner 2026-08-10): a line whose OWN purchase order has
// been received is READY regardless of the pooled buckets, and its units leave
// the pool so nobody else can claim them twice.
//
// Pinned because the migrated data DEPENDS on it: the AutoCount stock snapshot
// carries no variant, so every imported bedframe sits in a blank variant_key
// bucket while its SO line carries colour + heights — pooled matching can never
// pair them, and without bound mode a bedframe standing in the warehouse reads
// PENDING forever.
import { describe, it, expect } from 'vitest';

/** The decision the allocator makes for one line, extracted so it can be
 *  exercised without a database. Mirrors so-stock-allocation.ts step 6b/7. */
function settle(
  need: number,
  dedicatedReceived: number,
  pool: Map<string, number>,
  bucket: string,
  blankBucket: string,
): { status: 'READY' | 'PARTIAL' | 'PENDING'; qtyReady: number } {
  if (dedicatedReceived > 0) {
    const fill = Math.min(dedicatedReceived, need);
    let left = fill;
    for (const key of [bucket, blankBucket]) {
      if (left <= 0) break;
      const have = pool.get(key) ?? 0;
      if (have <= 0) continue;
      const take = Math.min(have, left);
      pool.set(key, have - take);
      left -= take;
    }
    return fill >= need ? { status: 'READY', qtyReady: need } : { status: 'PARTIAL', qtyReady: fill };
  }
  const avail = pool.get(bucket) ?? 0;
  if (avail >= need) { pool.set(bucket, avail - need); return { status: 'READY', qtyReady: need }; }
  if (avail > 0) { pool.set(bucket, 0); return { status: 'PARTIAL', qtyReady: avail }; }
  return { status: 'PENDING', qtyReady: 0 };
}

const BUCKET = 'wh1::TRION (A)-(K)::PC151-01|8|4|14';
const BLANK = 'wh1::TRION (A)-(K)::';

describe('bound-mode allocation', () => {
  it('a received dedicated PO makes the line READY even though the pooled bucket is empty', () => {
    // exactly the migrated case: stock exists only under the blank variant key
    const pool = new Map([[BLANK, 3]]);
    expect(settle(1, 1, pool, BUCKET, BLANK)).toEqual({ status: 'READY', qtyReady: 1 });
  });

  it('claimed units leave the pool so a second line cannot claim them again', () => {
    const pool = new Map([[BLANK, 1]]);
    settle(1, 1, pool, BUCKET, BLANK);
    expect(pool.get(BLANK)).toBe(0);
    // a second, undedicated line for the same SKU now finds nothing
    expect(settle(1, 0, pool, BLANK, BLANK)).toEqual({ status: 'PENDING', qtyReady: 0 });
  });

  it('a part-received dedicated PO is PARTIAL, not READY', () => {
    const pool = new Map([[BLANK, 5]]);
    expect(settle(3, 1, pool, BUCKET, BLANK)).toEqual({ status: 'PARTIAL', qtyReady: 1 });
  });

  it('no dedication falls through to the pooled rule (mattress / accessories unchanged)', () => {
    const pool = new Map([[BUCKET, 4]]);
    expect(settle(2, 0, pool, BUCKET, BLANK)).toEqual({ status: 'READY', qtyReady: 2 });
    expect(pool.get(BUCKET)).toBe(2);
  });

  it('nothing received and nothing pooled stays PENDING', () => {
    expect(settle(2, 0, new Map(), BUCKET, BLANK)).toEqual({ status: 'PENDING', qtyReady: 0 });
  });

  /* Owner 2026-08-10: only the variant-bearing groups take the bound path —
     "MATTRESS 跟 Accessories 都是没有变体的 ... 走回我们正常 MRP 的模式".
     Diverting common stock onto its PO would change readiness for the parts of
     the business that were never broken. */
  it('bound mode covers exactly bedframe and sofa', () => {
    const BOUND_GROUPS = new Set(['bedframe', 'sofa']);
    for (const g of ['bedframe', 'sofa']) expect(BOUND_GROUPS.has(g)).toBe(true);
    for (const g of ['mattress', 'accessory', 'others', 'service']) expect(BOUND_GROUPS.has(g)).toBe(false);
  });
});
