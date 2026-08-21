// ----------------------------------------------------------------------------
// null-warehouse-signal — say something when a goods line is written with no
// warehouse, instead of letting it disappear.
//
// WHY. Stock allocation buckets by (warehouse, item, variant). A goods line
// with `warehouse_id = NULL` matches no bucket, so it can never be allocated:
// it never gets `allocated_batch_no`, never leaves PENDING, and never shows an
// incoming PO — while the goods for it may be received and sitting in the right
// bucket in the right warehouse. On 2990-SO-2607-028 that read to the operator
// as "the system did not capture the data" (2026-08-18), and 18 live lines were
// found in that state going back to June.
//
// THE FAILURE IS THAT NOTHING SAYS ANYTHING. The write succeeds, the row looks
// ordinary, and the line simply never appears in any bucket the allocator
// walks. Two of the three known causes were only identifiable afterwards, by
// timestamp forensics; one is still unexplained because there is no record of
// which path wrote it.
//
// SO THIS ONLY LOGS. It does not throw and does not block: a NULL warehouse is
// legitimate on an order that genuinely has no address yet (10 of those 18),
// and refusing the write would turn a reporting gap into an outage. What it
// buys is attribution — the next occurrence names its own route, document and
// item in the Worker log, and the hourly sentinel counts it.
// ----------------------------------------------------------------------------

import { isServiceLine } from '../shared';

/** Stable, greppable prefix — the sentinel's report and the Worker log agree. */
export const NULL_WAREHOUSE_TAG = '[null-warehouse]';

export type NullWarehouseLine = {
  itemCode?: string | null;
  itemGroup?: string | null;
  warehouseId?: string | null;
};

/**
 * Log every GOODS line in `lines` that is about to be written with no
 * warehouse. Service lines are excluded: they hold no stock, allocation skips
 * them by design, and a NULL there means nothing.
 *
 * @param where  the write path, e.g. 'POST /mfg-sales-orders' — this is the
 *               field that was missing when the 2026-08-18 line had to be
 *               attributed by comparing insert timestamps against audit rows.
 * @returns how many lines were flagged (0 = healthy), so a caller can assert.
 */
export function signalNullWarehouseLines(
  where: string,
  docNo: string | null | undefined,
  lines: NullWarehouseLine[],
): number {
  const offenders = lines.filter((l) =>
    (l.warehouseId ?? null) === null &&
    !isServiceLine({ itemGroup: l.itemGroup ?? null, itemCode: l.itemCode ?? null }));
  if (offenders.length === 0) return 0;
  const codes = offenders.map((l) => l.itemCode ?? '?').join(', ');
  /* eslint-disable-next-line no-console */
  console.error(
    `${NULL_WAREHOUSE_TAG} ${where} wrote ${offenders.length} goods line(s) with no warehouse on ` +
    `${docNo ?? '(unknown doc)'}: ${codes}. These can never be allocated stock — they will sit at ` +
    `PENDING with no incoming PO until a warehouse is set.`,
  );
  return offenders.length;
}

/** Row-shaped adapter so a route's call is one line: takes the raw insert
 *  payloads (snake_case, as handed to supabase) and maps them onto the
 *  signal's shape. Same behaviour, same return. */
export function signalNullWarehouseRows(
  where: string,
  docNo: string | null | undefined,
  rows: Array<Record<string, unknown>>,
): number {
  return signalNullWarehouseLines(where, docNo, rows.map((r) => ({
    itemCode: (r.item_code as string | null) ?? null,
    itemGroup: (r.item_group as string | null) ?? null,
    warehouseId: (r.warehouse_id as string | null) ?? null,
  })));
}
