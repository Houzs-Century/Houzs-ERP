// ----------------------------------------------------------------------------
// stock-bucket — which CLOSING STOCK a warehouse's goods belong to (owner
// 2026-09-21: stock 那边我要分三个东西, closing stock - customer / display /
// service; balakong warehouse - customer, 2990s PJ - display, the service
// warehouses - service; cash & carry segment 算顾客的).
//
// The rule reads the warehouse master: `stock_bucket` (mig 20260921T2000) is
// the per-warehouse override; blank falls back to the warehouse TYPE —
//   warehouse, others  → customer   (goods for sale, HQ stock)
//   showroom, display  → display    (sets standing on a floor)
//   service            → service    (away at the supplier being repaired)
// A warehouse no row answers for (a movement whose warehouse is gone) counts
// as customer — the goods are still ours, the bucket is a name for them.
// ----------------------------------------------------------------------------

export const STOCK_BUCKETS = ['customer', 'display', 'service'] as const;
export type StockBucket = (typeof STOCK_BUCKETS)[number];

export const isStockBucket = (v: unknown): v is StockBucket =>
  typeof v === 'string' && (STOCK_BUCKETS as readonly string[]).includes(v);

/** The bucket for a warehouse row: its override, else its type's default. */
export function stockBucketOf(w: { type?: string | null; stock_bucket?: string | null } | null | undefined): StockBucket {
  if (w && isStockBucket(w.stock_bucket)) return w.stock_bucket;
  const type = String(w?.type ?? '').toLowerCase();
  if (type === 'showroom' || type === 'display') return 'display';
  if (type === 'service') return 'service';
  return 'customer';
}

/** Every bucket at zero — the shape a replay fills. */
export const emptyBuckets = (): Record<StockBucket, number> => ({ customer: 0, display: 0, service: 0 });
