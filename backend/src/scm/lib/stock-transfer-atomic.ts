
/** One line as accepted by scm.fn_stock_transfer_apply's p_lines JSONB. */
export type TransferLinePayload = {
  item_code: string;
  product_name: string | null;
  variant_key: string;
  qty: number;
  batch_no: string | null;
};

type RawLine = {
  item_code: string;
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
    const batchNo = batchByBucket.get(`${ln.item_code}::${variantKey}`) ?? null;
    out.push({
      item_code: ln.item_code,
      product_name: ln.product_name ?? null,
      variant_key: variantKey,
      qty,
      batch_no: batchNo,
    });
  }
  return out;
}
