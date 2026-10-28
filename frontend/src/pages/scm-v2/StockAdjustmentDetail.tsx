// ----------------------------------------------------------------------------
// StockAdjustmentDetail — one stock adjustment document at
// /scm/stock-adjustments/:id (BUG-66: "cant open review item"). Read-only view
// of the header and every line with its variant / batch; Edit opens the same
// form the New page uses (/scm/stock-adjustments/:id/edit), and History shows
// the INVENTORY_ADJUSTMENT audit trail — who created or edited it and what
// changed.
// ----------------------------------------------------------------------------

import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { History, Pencil, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { adjustmentReasonLabel, fmtDateTime, fmtQty } from '@2990s/shared';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { useStockAdjustmentDoc } from '../../vendor/scm/lib/stock-queries';
import { useStaffLookup } from '../../hooks/useStaffLookup';
import { useSetBreadcrumbs } from '../../hooks/useBreadcrumbs';
import { PageHeader } from '../../components/Layout';
import { EntityHistoryPanel } from './EntityHistoryPanel';
import { STOCK_ADJUSTMENT_AUDIT_LABELS } from './entity-audit-labels';
import styles from './SalesOrderDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const qtyColor = (q: number) => (q < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--c-ink)');

export const StockAdjustmentDetail = () => {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const docQ = useStockAdjustmentDoc(id || null);
  const warehouses = useWarehouses();
  const { actorNameOf } = useStaffLookup();
  const [historyOpen, setHistoryOpen] = useState(false);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  const doc = docQ.data;
  useSetBreadcrumbs([
    { label: 'Inventory', to: '/scm/inventory' },
    { label: 'Stock Adjustments', to: '/scm/stock-adjustments' },
    { label: doc?.adjustment_no ?? '…' },
  ]);

  const warehouse = useMemo(
    () => (warehouses.data ?? []).find((w) => w.id === doc?.warehouse_id) ?? null,
    [warehouses.data, doc?.warehouse_id],
  );

  if (docQ.isPending) return <SkeletonDetailPage />;
  if (docQ.error || !doc) {
    return (
      <div className="space-y-4">
        <p>{docQ.error instanceof Error ? docQ.error.message : 'Stock adjustment not found.'}</p>
        <Link to="/scm/stock-adjustments">Back to Stock Adjustments</Link>
      </div>
    );
  }

  const net = doc.lines.reduce((s, l) => s + l.qty, 0);
  const edited = doc.updated_at && doc.updated_at !== doc.created_at;

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Inventory"
        title={doc.adjustment_no}
        description={`Created ${fmtDateTime(doc.created_at)}${edited ? ` · Edited ${fmtDateTime(doc.updated_at)}` : ''}`}
        actions={
          <div className={styles.actions}>
            <Button variant="ghost" size="md" onClick={() => setHistoryOpen(true)}>
              <History {...ICON} /> History
            </Button>
            <Button variant="primary" size="md" onClick={() => navigate(`/scm/stock-adjustments/${doc.id}/edit`)}>
              <Pencil {...ICON} /> Edit
            </Button>
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/stock-adjustments')}>
              <X {...ICON} /> Close
            </Button>
          </div>
        }
      />

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Adjustment</h2>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Warehouse</span>
              <span>{warehouse ? `${warehouse.code}${warehouse.name && warehouse.name !== warehouse.code ? ` · ${warehouse.name}` : ''}` : '—'}</span>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Performed By</span>
              <span>{actorNameOf(doc.created_by)}</span>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Net Qty</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: qtyColor(net) }}>
                {net > 0 ? '+' : ''}{fmtQty(net)}
              </span>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              <span>{doc.notes || '—'}</span>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items ({doc.lines.length})</h2>
        </div>
        <div className={styles.cardBody}>
          <table className={`${styles.table} ${styles.tableOwnWidths}`}>
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th style={{ width: '16%' }}>SKU</th>
                <th>Product Name</th>
                <th>Description 2</th>
                <th style={{ width: 110 }}>Batch</th>
                <th style={{ width: 90, textAlign: 'right' }}>Qty</th>
                <th style={{ width: 150 }}>Reason</th>
                <th style={{ width: 200 }}>Note</th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((l, i) => (
                <tr key={l.id}>
                  <td>{i + 1}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                    <Link to={`/scm/inventory/stock-card/${encodeURIComponent(l.item_code)}?warehouseId=${doc.warehouse_id}`}>{l.item_code}</Link>
                  </td>
                  <td>{l.product_name || '—'}</td>
                  <td className={styles.muted}>{l.description2 || (l.variant_key ? l.variant_key : '—')}</td>
                  <td>{l.batch_no || '—'}</td>
                  <td className={styles.tableRight} style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: qtyColor(l.qty) }}>
                    {l.qty > 0 ? '+' : ''}{fmtQty(l.qty)}
                  </td>
                  <td>{l.reason_code ? adjustmentReasonLabel(l.reason_code) : '—'}</td>
                  <td>{l.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {historyOpen && (
        <EntityHistoryPanel
          entityType="INVENTORY_ADJUSTMENT"
          entityId={doc.id}
          recordLabel={doc.adjustment_no}
          entityName="Stock adjustment"
          labels={STOCK_ADJUSTMENT_AUDIT_LABELS}
          statusDocType="stockTransfer"
          onClose={closeHistory}
        />
      )}
    </div>
  );
};
