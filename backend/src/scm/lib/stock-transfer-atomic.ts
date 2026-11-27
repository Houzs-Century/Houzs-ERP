
/** One line as accepted by scm.fn_stock_transfer_apply's p_lines JSONB. */
export type TransferLinePayload = {
  item_code: string;
  product_name: string | null;
  variant_key: string;
  qty: number;
  batch_no: string | null;
  from_rack_id?: string;
  to_rack_id?: string;
};

type RawLine = {
  item_code: string;
  product_name: string | null;
  variant_key: string | null;
  qty: number;
  from_rack_id?: string | null;
  to_rack_id?: string | null;
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
 *     (batchByBucket already collapses multi-batch/plain to null),
 *   - carries a line's From / To rack only when it has one, so a transfer with
 *     no rack builds the same payload it always did.
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
      ...(ln.from_rack_id ? { from_rack_id: ln.from_rack_id } : {}),
      ...(ln.to_rack_id ? { to_rack_id: ln.to_rack_id } : {}),
    });
  }
  return out;
}

/** True when any line names a rack: the transfer then posts through scm.fn_stock_transfer_apply_racked. */
export function payloadMovesRacks(payload: readonly TransferLinePayload[]): boolean {
  return payload.some((l) => l.from_rack_id !== undefined || l.to_rack_id !== undefined);
}
