/* A lorry's warehouses (owner 2026-11-07): its HOME warehouse, where it starts and ends
   the day, is chosen on its own; the set it serves always includes the home. A body with
   no homeWarehouseId keeps the older rule, home = the first ticked. */
export function lorryWarehouseColumns(body: Record<string, unknown>): { warehouse_id: string | null; warehouse_ids: string[] } {
  const raw = Array.isArray(body.warehouseIds) ? body.warehouseIds : body.warehouseId ? [body.warehouseId] : [];
  const ids = [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))];
  if (body.homeWarehouseId === undefined) return { warehouse_id: ids[0] ?? null, warehouse_ids: ids };
  const home = typeof body.homeWarehouseId === 'string' && body.homeWarehouseId.trim() !== '' ? body.homeWarehouseId.trim() : null;
  return { warehouse_id: home, warehouse_ids: home ? [home, ...ids.filter((x) => x !== home)] : ids };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An optional id field: undefined = not sent, null/blank = clear, else a uuid. */
export function idOrNull(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null || v === '') return { ok: true, value: null };
  return typeof v === 'string' && UUID.test(v.trim()) ? { ok: true, value: v.trim() } : { ok: false };
}
