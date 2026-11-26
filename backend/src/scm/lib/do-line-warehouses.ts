/* company-scope-file: this module WRITES NOTHING. Its two reads are keyed on
   ids the caller resolved under its own company predicate, and the company is
   a REQUIRED argument on the default-warehouse fallback — which is the whole
   point of that signature; see inventory-movements.ts defaultWarehouseId. */
import { defaultWarehouseId } from './inventory-movements';

export async function resolveDoLineWarehouses(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unchanged from delivery-orders-mfg.ts: the PostgREST-shaped client has no honest type until schema.pg.ts covers the SCM tables.
  sb: any,
  items: Array<{ id: string; so_item_id?: string | null }>,
  headerWarehouseId: string | null,
  companyId: number | undefined,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const soItemIds = [...new Set(items
    .map((it) => it.so_item_id ?? null)
    .filter((x): x is string => !!x))];
  const soWh = new Map<string, string | null>();
  if (soItemIds.length > 0) {
    const { data: soRows, error } = await sb.from('mfg_sales_order_items')
      .select('id, warehouse_id').in('id', soItemIds);
    if (error) {
      // eslint-disable-next-line no-console
      console.error('[do-warehouse] SO-line warehouse read failed; every line falls back to the DO header:', error.message);
    }
    for (const r of (soRows ?? []) as Array<{ id: string; warehouse_id: string | null }>) {
      soWh.set(r.id, r.warehouse_id ?? null);
    }
  }
  const fallback = headerWarehouseId ?? (await defaultWarehouseId(sb, companyId));
  for (const it of items) {
    const fromSo = it.so_item_id ? (soWh.get(it.so_item_id) ?? null) : null;
    out.set(it.id, fromSo ?? fallback);
  }
  return out;
}

export function doShipFromWarehouseId(
  headerWarehouseId: string | null,
  lineWarehouses: ReadonlyMap<string, string | null>,
): string | null {
  if (headerWarehouseId) return headerWarehouseId;
  const all = [...lineWarehouses.values()];
  if (all.length === 0 || all.some((w) => !w)) return null;
  const uniq = new Set(all);
  return uniq.size === 1 ? (all[0] as string) : null;
}
