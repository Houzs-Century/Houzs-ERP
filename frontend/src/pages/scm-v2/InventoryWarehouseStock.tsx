import { fmtQty } from '@2990s/shared';
import type { Column } from '../../components/DataTable';
import type { InventoryProductTotal, InventoryWarehouseStock } from '../../vendor/scm/lib/inventory-queries';
import styles from './Inventory.module.css';

const warehouseStockText = (list: InventoryWarehouseStock[] | null | undefined): string =>
  (list ?? []).map((w) => `${w.warehouse_code ?? 'Unknown'} ${fmtQty(w.qty)}`).join(', ');

/* Where the Stock figure stands, without picking each warehouse in the filter
   (Sim, HC-0187: a PG DISPLAY piece read as free stock for a PG WAREHOUSE
   order). Own stock only, same as the Stock column. */
export const BY_WAREHOUSE_COLUMN: Column<InventoryProductTotal> = {
  key: 'by_warehouse',
  label: 'By Warehouse',
  width: '220px',
  getValue: (r) => warehouseStockText(r.stock_by_warehouse),
  render: (r) => {
    const list = r.stock_by_warehouse ?? [];
    if (list.length === 0) return <span className={styles.numCellZero}>—</span>;
    return (
      <span className="inline-flex flex-wrap gap-1">
        {list.map((w) => (
          <span key={w.warehouse_id}
            className="whitespace-nowrap rounded border border-border bg-surface-2 px-1.5 py-px text-[11px]">
            {w.warehouse_code ?? 'Unknown'} <strong className={w.qty < 0 ? styles.numCellNeg : undefined}>{fmtQty(w.qty)}</strong>
          </span>
        ))}
      </span>
    );
  },
};
