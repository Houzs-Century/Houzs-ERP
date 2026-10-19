import { Link } from 'react-router-dom';
import { fmtDate, fmtQty } from '@2990s/shared';
import type { InventoryDemandSo } from '../../vendor/scm/lib/inventory-queries';
import styles from './Inventory.module.css';

/* The Sales Orders behind a Balances row's Scheduled / Unscheduled figures, in
   the row expansion next to the Incoming PO drill. Sim (HC-0115): "unscheduled
   13pcs, how can I know for which SO" — the figure alone sent her back to
   AutoCount's SO detail listing. Hidden when the SKU has no open SO demand. */
export const DemandSoPanel = ({ sos }: { sos: InventoryDemandSo[] | null | undefined }) => {
  const list = sos ?? [];
  if (list.length === 0) return null;
  return (
    <table className={`${styles.table} bg-surface-2`}>
      <tbody>
        {list.map((s) => (
          <tr key={`${s.doc_no}|${s.delivery_date ?? ''}`}>
            <td style={{ paddingLeft: 22, width: 200 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span className={styles.numCellZero}>{s.delivery_date ? '↳ scheduled' : '↳ unscheduled'}</span>
                <Link to={`/scm/sales-orders/${encodeURIComponent(s.doc_no)}`} className={styles.docLink}
                  onClick={(e) => e.stopPropagation()}>
                  {s.doc_no}
                </Link>
              </span>
            </td>
            {/* Qty sits beside the SO, not at the far right: the expansion is as
                wide as all 14 columns, so a right-hand cell scrolls out of view. */}
            <td className={styles.numCell} style={{ width: 60, textAlign: 'right' }}>
              {fmtQty(s.qty)}
            </td>
            <td className={styles.numCellZero} style={{ paddingLeft: 16 }}>
              {s.debtor_name ?? '—'}
              {s.so_date ? ` · SO ${fmtDate(s.so_date)}` : ''}
              {s.delivery_date ? ` · delivery ${fmtDate(s.delivery_date)}` : ' · no delivery date'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};
