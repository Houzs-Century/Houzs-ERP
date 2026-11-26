
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
