import { fmtQty } from '@2990s/shared';
import type { Column } from '../../components/DataTable';
import type { InventoryProductTotal } from '../../vendor/scm/lib/inventory-queries';
import styles from './Inventory.module.css';

/* HC-0206 (Sim): "All warehouses" summed every location into one Stock figure,
   so finding WHERE a SKU sits meant picking warehouses one by one. Plain
   nowrap text, not chips: DataTable fixes column widths from the first paint,
   and wrapping chips let it shrink the column. */
export const LOCATION_COLUMN: Column<InventoryProductTotal> = {
  key: 'location',
  label: 'Location',
  width: '180px',
  getValue: (r) => (r.stock_by_warehouse ?? []).map((w) => `${w.code} ${w.qty}`).join(' · '),
  render: (r) => {
    const whs = r.stock_by_warehouse ?? [];
    if (whs.length === 0) return <span className={styles.numCellZero}>—</span>;
    return (
      <span
        style={{ whiteSpace: 'nowrap' }}
        title={whs.map((w) => `${w.code}${w.name ? ` (${w.name})` : ''}: ${fmtQty(w.qty)}${w.held_qty > 0 ? ` incl. ${fmtQty(w.held_qty)} consignment` : ''}`).join('\n')}
      >
        {whs.map((w, i) => (
          <span key={w.warehouse_id}>
            {i > 0 && <span className={styles.numCellZero}> · </span>}
            {w.code} <strong>{fmtQty(w.qty)}</strong>
          </span>
        ))}
      </span>
    );
  },
};
