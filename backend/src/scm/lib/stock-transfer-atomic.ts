// ----------------------------------------------------------------------------
// Stock-transfer atomicity (audit finding R3).
//
// The OUT@source + IN@dest for a transfer used to be written as separate,
// independently-committed PostgREST inserts (supabase-js cannot open a
// multi-statement transaction), so a crash or a failed IN after the OUT
// committed DESTROYED stock. The atomic write now lives in the DB function
// scm.fn_stock_transfer_apply (migration 0192): every line's OUT + IN runs in
// ONE transaction and rolls back as a unit on any failure.
//
// This module carries only the PURE payload builder the route feeds to that
// RPC — batch resolution stays in the route (it needs the source lots), the
// transaction lives in Postgres. Kept pure so it is unit-testable without a DB.
// ----------------------------------------------------------------------------

/** One line as accepted by scm.fn_stock_transfer_apply's p_lines JSONB. */
export type TransferLinePayload = {
  product_code: string;
  product_name: string | null;
  /** '' = unclassified/legacy bucket (never null on the wire). */
  variant_key: string;
  /** Positive count. Lines with qty <= 0 are dropped by the builder. */
  qty: number;
  /** Source dye-lot to carry across the hop, or null for plain FIFO. */
  batch_no: string | null;
};

type RawLine = {
  product_code: string;
  product_name: string | null;
  variant_key: string | null;
  qty: number;
};

/**
 * Build the p_lines payload for scm.fn_stock_transfer_apply from the stored
 * transfer lines + the per-bucket resolved batch map (key `code::variant`).
 *
 * Pure. Mirrors the old JS loop's per-line decisions so behaviour is unchanged
 * except for where the OUT/IN now execute (atomically, in the DB):
 *   - drops qty <= 0 lines (a zero line moved nothing before either),
 *   - normalises variant_key null -> '' (the bucket key the FIFO layer uses),
 *   - carries the batch only when the source bucket resolved to a SINGLE batch
 *     (batchByBucket already collapses multi-batch/plain to null).
 */
export function buildTransferPayload(
  lines: RawLine[],
  batchByBucket: Map<string, string | null>,
): TransferLinePayload[] {
  const out: TransferLinePayload[] = [];
  for (const ln of lines) {
    const qty = Math.floor(Number(ln.qty ?? 0));
    if (qty <= 0) continue;
    const variantKey = ln.variant_key ?? '';
    const batchNo = batchByBucket.get(`${ln.product_code}::${variantKey}`) ?? null;
    out.push({
      product_code: ln.product_code,
      product_name: ln.product_name ?? null,
      variant_key: variantKey,
      qty,
      batch_no: batchNo,
    });
  }
  return out;
}
