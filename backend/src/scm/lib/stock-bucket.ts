// ----------------------------------------------------------------------------
// stock-bucket — which CLOSING STOCK a warehouse's goods belong to (owner
// 2026-09-21: stock 那边我要分三个东西, closing stock - customer / display /
// service; balakong warehouse - customer, the service warehouses - service;
// cash & carry segment 算顾客的. 2026-09-30: Inventory - Showroom and
// Inventory - Others get their own, showroom 和 display 分开).
//
// The rule reads the warehouse master: `stock_bucket` (mig 20260921T2000) is
// the per-warehouse override; blank falls back to the warehouse TYPE —
//   warehouse → customer   (goods for sale)
//   display   → display    (partner display sets standing on a floor)
//   showroom  → showroom   (our own showrooms: 2990s PJ, the sleep studios)
//   service   → service    (away at the supplier being repaired)
//   others    → others     (HQ and the like)
// A warehouse no row answers for (a movement whose warehouse is gone) counts
// as customer — the goods are still ours, the bucket is a name for them.
// Bucket order is account-code order: -0001 … -0005 (acc/rules.ts).
// ----------------------------------------------------------------------------

export const STOCK_BUCKETS = ['customer', 'display', 'service', 'showroom', 'others'] as const;
export type StockBucket = (typeof STOCK_BUCKETS)[number];

export const isStockBucket = (v: unknown): v is StockBucket =>
  typeof v === 'string' && (STOCK_BUCKETS as readonly string[]).includes(v);

/** The bucket for a warehouse row: its override, else its type's default. */
export function stockBucketOf(w: { type?: string | null; stock_bucket?: string | null } | null | undefined): StockBucket {
  if (w && isStockBucket(w.stock_bucket)) return w.stock_bucket;
  const type = String(w?.type ?? '').toLowerCase();
  if (type === 'showroom') return 'showroom';
  if (type === 'display') return 'display';
  if (type === 'service') return 'service';
  if (type === 'others') return 'others';
  return 'customer';
}

/** Every bucket at zero — the shape a replay fills. */
export const emptyBuckets = (): Record<StockBucket, number> => ({ customer: 0, display: 0, service: 0, showroom: 0, others: 0 });
