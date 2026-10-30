export type WarehouseStock = { warehouse_id: string; warehouse_code: string | null; qty: number };

/* One SKU's owned stock split by warehouse for the Inventory list (HC-0187):
   non-zero only, largest first, ties by warehouse code. */
export function warehouseStockList(
  byWarehouse: Map<string, number> | undefined,
  codeById: Map<string, string>,
): WarehouseStock[] {
  return [...(byWarehouse ?? new Map<string, number>())]
    .map(([id, qty]) => ({ warehouse_id: id, warehouse_code: codeById.get(id) ?? null, qty: Math.round(qty) }))
    .filter((w) => w.qty !== 0)
    .sort((a, b) => b.qty - a.qty || (a.warehouse_code ?? '').localeCompare(b.warehouse_code ?? ''));
}
