// ----------------------------------------------------------------------------
// StockTransferDetail — header + lines at /inventory/transfers/:id.
//
// PR-DRAFT-removal (2026-05-27): Transfers post on create. Detail is now
// read-only for POSTED + CANCELLED rows. The Save / Post / Delete buttons
// were the DRAFT workflow and have been removed; Cancel remains for POSTED
// rows.
//
// HOUZS VENDOR — verbatim from apps/backend/src/pages/StockTransferDetail.tsx.
// Import boundary only: react-router → react-router-dom; Skeleton/ConfirmDialog/
// NotifyDialog/StatusPill + useWarehouses ← vendored; transfer hooks ←
// vendored stock-queries; buildVariantSummary via @2990s/shared; css colocated.
// Back/Close → the parallel /scm/stock-transfers list.
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, History, X, Ban, Printer } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { buildVariantSummary, fmtDate, fmtDateTime, fmtQty } from '@2990s/shared'; // Commander 2026-05-28 — Description 2
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import {
  useStockTransferDetail,
  useCancelStockTransfer,
  type StockTransferItemInput,
  type StockTransferStatus,
} from '../../vendor/scm/lib/stock-queries';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { EntityHistoryPanel } from './EntityHistoryPanel';
import { STOCK_TRANSFER_AUDIT_LABELS } from './entity-audit-labels';
import { DateField } from "../../vendor/scm/components/DateField";
import { PrintPreviewModal, useOpenPrintPreviewFromUrl, usePrintPreview } from '../../components/scm-v2/PrintPreviewModal';
import { warehouseLabel } from '../../vendor/scm/lib/warehouse-label';
import type { PdfAction } from '../../vendor/scm/lib/pdf-common';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type LineDraft = StockTransferItemInput & { _key: string };

const newKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const StockTransferDetail = () => {
  const { id }   = useParams<{ id: string }>();
  const navigate = useNavigate();

  /* History drawer. Stable close handler so the memoized panel is not
     re-created on every parent render. */
  const [historyOpen, setHistoryOpen] = useState(false);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  const detail = useStockTransferDetail(id ?? null);
  const cancel = useCancelStockTransfer();

  const askConfirm = useConfirm();
  const notify = useNotify();

  const warehouses = useWarehouses();

  // ── Read-only state mirrored from server (no edits post-0078) ────────
  const [fromWarehouseId, setFromWarehouseId] = useState('');
  const [toWarehouseId,   setToWarehouseId]   = useState('');
  const [transferDate,    setTransferDate]    = useState('');
  const [notes,           setNotes]           = useState('');
  const [lines,           setLines]           = useState<LineDraft[]>([]);

  // Hydrate when detail loads / refreshes.
  useEffect(() => {
    if (!detail.data) return;
    const t = detail.data.transfer;
    setFromWarehouseId(t.from_warehouse_id);
    setToWarehouseId(t.to_warehouse_id);
    setTransferDate(t.transfer_date);
    setNotes(t.notes ?? '');
    setLines(detail.data.lines.map((l) => ({
      _key:        newKey(),
      itemCode: l.item_code,
      productName: l.product_name ?? '',
      qty:         l.qty,
      notes:       l.notes ?? '',
    })));
  }, [detail.data]);

  const status: StockTransferStatus | undefined = detail.data?.transfer.status;
  const isPosted = status === 'POSTED';

  /* Print. This document had no print handler at all until now, on any
     surface. (A fabricated owner quote was attached here and has been removed —
     see row-menus.ts for the provenance note.)

     The SERVER rows, not the LineDraft state above: the draft drops
     `variant_key`, and which bucket moved is exactly what a warehouse hand-off
     sheet has to say. "Print now" goes through the PDF (action: 'print') and
     never window.print() — index.css's @media print block hides `body *`, so
     printing this page directly yields a blank sheet (PrintPreviewModal's own
     header records what that cost the Delivery Order). */
  const deliverPrintPdf = (action: PdfAction) => {
    const d = detail.data;
    if (!d) return;
    return import('../../vendor/scm/lib/stock-transfer-pdf')
      .then(({ generateStockTransferPdf }) =>
        generateStockTransferPdf(d.transfer, d.lines, { action }))
      .catch((e) => notify({
        title: 'PDF generation failed',
        body: e instanceof Error ? e.message : 'Something went wrong.',
        tone: 'error',
      }));
  };
  const print = usePrintPreview(deliverPrintPdf);
  /* The list's right-click Print navigates here with ?print=1 — same contract
     every other document's row menu uses. */
  useOpenPrintPreviewFromUrl(print.openPreview, !!detail.data);

  // ── Cancel ───────────────────────────────────────────────────────────
  const onCancel = async () => {
    if (!id) return;
    const proceed = await askConfirm({
      title: 'Cancel this transfer?',
      body: 'The paired stock movements (out of the source warehouse, into the destination) will be reversed automatically — the stock returns to where it started.',
      confirmLabel: 'Cancel transfer',
      danger: true,
    });
    if (!proceed) return;
    cancel.mutate(id, {
      onSuccess: () => detail.refetch(),
      onError: (err) => notify({ title: 'Cancel failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  // ── Render ───────────────────────────────────────────────────────────
  if (detail.isPending) {
    return <SkeletonDetailPage />;
  }
  if (detail.error || !detail.data) {
    return (
      <div className="space-y-4">
        <p className={styles.subtitle}>
          {detail.error instanceof Error ? detail.error.message : 'Transfer not found.'}
        </p>
        <Link to="/scm/stock-transfers">Back to Stock Transfers</Link>
      </div>
    );
  }

  const t = detail.data.transfer;

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Warehouse"
        title={t.transfer_no}
        description={`Created ${fmtDateTime(t.created_at)}${t.posted_at ? ` · Posted ${fmtDateTime(t.posted_at)}` : ''}${t.cancelled_at ? ` · Cancelled ${fmtDateTime(t.cancelled_at)}` : ''}`}
        actions={
          <>
            {status && <StatusPill docType="stockTransfer" status={status} />}
            <div className={styles.actions}>
              {/* History drawer toggle. Same header seat on every detail page,
                  and unconditional: a cancelled transfer is exactly when
                  someone needs to see who changed what. */}
              <Button variant="ghost" size="md" onClick={() => setHistoryOpen(true)}>
                <History {...ICON} /> History
              </Button>
              {/* Unconditional, like History: a cancelled transfer is still a
                  record somebody has to be able to put on paper. */}
              <Button variant="ghost" size="md" onClick={print.openPreview}>
                <Printer {...ICON} /> Print PDF
              </Button>
              {isPosted && (
                <Button variant="ghost" size="md" onClick={onCancel} disabled={cancel.isPending}>
                  <Ban {...ICON} /> {cancel.isPending ? 'Cancelling…' : 'Cancel'}
                </Button>
              )}
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/stock-transfers')}>
                <X {...ICON} /> Close
              </Button>
            </div>
          </>
        }
      />

      {/* ── Header card ─────────────────────────────────────────────── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Transfer</h2>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            {/* Read-only display since transfers post on create. */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>From Warehouse</span>
              <select value={fromWarehouseId} className={styles.fieldSelect} disabled>
                <option value="">—</option>
                {sortByText(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>{w.code}</option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                <ArrowRight size={11} strokeWidth={1.75} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                To Warehouse
              </span>
              <select value={toWarehouseId} className={styles.fieldSelect} disabled>
                <option value="">—</option>
                {sortByText(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>{w.code}</option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Transfer Date</span>
              {/* Read-only: the transfer date is stamped on post and never
                  edited here, so there is no onChange to give. */}
              <DateField fullWidth value={transferDate} onChange={() => {}} className={styles.fieldInput} disabled/>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              <input type="text" value={notes} className={styles.fieldInput} disabled />
            </label>
          </div>
        </div>
      </section>

      {/* ── Lines card (read-only post-0078) ────────────────────────── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items</h2>
        </div>
        <div className={styles.cardBody}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th style={{ width: '20%' }}>SKU</th>
                <th>Description</th>
                <th>Description 2</th>
                <th style={{ width: 110, textAlign: 'right' }}>Qty</th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={4} className={styles.emptyRow}>No lines.</td></tr>
              )}
              {lines.map((ln) => (
                <tr key={ln._key}>
                  <td><span className={styles.codeCell}>{ln.itemCode}</span></td>
                  <td>{ln.productName || <span className={styles.muted}>—</span>}</td>
                  {/* "Description 2": variant/spec summary in its own column.
                      Prefers a stored description2, falls back to the computed
                      variant summary, then a muted em-dash when both are empty. */}
                  <td>
                    {(() => {
                      const row = ln as unknown as {
                        description2?: string | null;
                        item_group?: string | null;
                        variants?: Record<string, unknown> | null;
                      };
                      const desc2 = (row.description2 && row.description2.trim())
                        ? row.description2
                        : buildVariantSummary(row.item_group, row.variants);
                      return desc2
                        ? <span>{desc2}</span>
                        : <span className={styles.muted}>—</span>;
                    })()}
                  </td>
                  <td className={styles.tableRight} style={{ fontFamily: 'var(--font-mono)' }}>
                    {fmtQty(ln.qty)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* History drawer — portals to <body>, so its position here is only
          about lifecycle, not layout. */}
      {historyOpen && (
        <EntityHistoryPanel
          entityType="STOCK_TRANSFER"
          entityId={String(t.id)}
          recordLabel={t.transfer_no}
          entityName="Stock transfer"
          labels={STOCK_TRANSFER_AUDIT_LABELS}
          statusDocType="stockTransfer"
          onClose={closeHistory}
        />
      )}

      <PrintPreviewModal
        open={print.open}
        onClose={print.close}
        docTitle="Stock Transfer"
        docNo={t.transfer_no}
        rows={[
          { label: 'From', value: warehouseLabel(t.from_warehouse) ?? t.from_warehouse_id },
          { label: 'To', value: warehouseLabel(t.to_warehouse) ?? t.to_warehouse_id },
          { label: 'Date', value: fmtDate(t.transfer_date) },
          {
            label: 'Items',
            value: `${detail.data.lines.length} line${detail.data.lines.length === 1 ? '' : 's'}`,
          },
        ]}
        {...print.handlers}
      />
    </div>
  );
};
