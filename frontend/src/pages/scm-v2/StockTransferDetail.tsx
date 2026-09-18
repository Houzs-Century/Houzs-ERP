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
// vendored stock-queries; css colocated.
// Back/Close → the parallel /scm/stock-transfers list.
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, History, X, Ban, Printer, Pencil, Save } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { fmtDate, fmtDateTime, fmtQty } from '@2990s/shared';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { useInventoryBuckets } from '../../vendor/scm/lib/stock-queries';
import { useMfgProducts } from '../../vendor/scm/lib/mfg-products-queries';
import { variantKeyLabel } from '../../vendor/scm/lib/variant-key-label';
import {
  useStockTransferDetail,
  useCancelStockTransfer,
  useUpdateStockTransferNotes,
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

type LineDraft = StockTransferItemInput & { _key: string; id: string };

const newKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Sentinel for "no bucket picked yet" — distinct from '' (a real, pickable
// unclassified bucket). Same contract as StockTransferNew's TransferLineRow.
const UNPICKED = '__UNPICKED__';
const humanizeVariantKey = (k: string): string => variantKeyLabel(k, '(unclassified)');

// One editable line: owns its own inventory-bucket query (at the transfer's
// fixed From warehouse) so it can show live "available: N" and refuse to let
// qty exceed it — same building blocks as StockTransferNew's TransferLineRow,
// trimmed (no add/remove line — this edits the existing lines, it does not
// resize the transfer). `onAvail` reports this row's picked-bucket qty up to
// the parent so the Save button can be disabled while any row is overdrawn.
function EditableTransferLineRow({
  line, fromWarehouseId, skus, onPickCode, setLine, onAvail,
}: {
  line: LineDraft;
  fromWarehouseId: string;
  skus: Array<{ id: string | number; code: string; name: string }>;
  onPickCode: (key: string, code: string) => void;
  setLine: (key: string, patch: Partial<LineDraft>) => void;
  onAvail: (key: string, avail: number | undefined) => void;
}) {
  const bucketsQ = useInventoryBuckets(line.itemCode || null, fromWarehouseId || null);
  const variantBuckets = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of (bucketsQ.data ?? [])) {
      m.set(b.variant_key, (m.get(b.variant_key) ?? 0) + b.qty);
    }
    return [...m.entries()]
      .map(([variantKey, qty]) => ({ variantKey, qty }))
      .sort((a, b) => b.qty - a.qty);
  }, [bucketsQ.data]);

  const avail = line.variantKey === undefined
    ? undefined
    : variantBuckets.find((v) => v.variantKey === line.variantKey)?.qty;
  // Availability here already accounts for THIS transfer's original qty at
  // this same bucket (the backend adds it back before comparing) only when
  // the SKU/variant is unchanged — if either changed, `avail` is simply
  // today's open stock at the new bucket, which is what the backend checks
  // too in that case. Either way this label and the server's 409 agree.
  const isOverdrawn = avail != null && line.qty > avail;
  const ready = Boolean(line.itemCode && fromWarehouseId);

  useEffect(() => { onAvail(line._key, avail); }, [line._key, avail, onAvail]);

  return (
    <tr>
      <td>
        <input
          type="text"
          list={`xfer-edit-skus-${line._key}`}
          value={line.itemCode}
          onChange={(e) => onPickCode(line._key, e.target.value)}
          placeholder="Type code…"
          className={styles.fieldInput}
          style={{ fontFamily: 'var(--font-mono)' }}
        />
        <datalist id={`xfer-edit-skus-${line._key}`}>
          {sortByText(skus).map((p) => (
            <option key={p.id} value={p.code}>{p.name}</option>
          ))}
        </datalist>
      </td>
      <td>{line.productName || <span className={styles.muted}>—</span>}</td>
      <td>
        <select
          value={line.variantKey === undefined ? UNPICKED : line.variantKey}
          onChange={(e) => setLine(line._key, {
            variantKey: e.target.value === UNPICKED ? undefined : e.target.value,
          })}
          className={styles.fieldInput}
          disabled={!ready}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}
        >
          <option value={UNPICKED} disabled>
            {!fromWarehouseId ? 'Pick From warehouse first'
              : !line.itemCode ? 'Pick SKU first'
              : bucketsQ.isLoading ? 'Loading…'
              : variantBuckets.length === 0 ? 'No stock at source'
              : 'Pick variant / bucket…'}
          </option>
          {variantBuckets.map((v) => (
            <option key={v.variantKey || '__plain__'} value={v.variantKey}>
              {humanizeVariantKey(v.variantKey)} — {v.qty.toLocaleString('en-MY')} avail
            </option>
          ))}
        </select>
      </td>
      <td className={styles.tableRight}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-13)' }}>
        {!ready ? <span className={styles.muted}>—</span>
          : bucketsQ.isLoading ? <span className={styles.muted}>…</span>
          : avail == null ? <span className={styles.muted}>—</span>
          : <span style={{ color: avail > 0 ? 'var(--c-ink)' : 'var(--fg-muted)' }}>
              {avail.toLocaleString('en-MY')}
            </span>}
      </td>
      <td className={styles.tableRight}>
        <input
          type="number"
          min={1}
          step={1}
          value={line.qty}
          onChange={(e) => setLine(line._key, {
            qty: Math.max(0, Math.floor(Number(e.target.value) || 0)),
          })}
          className={styles.fieldInput}
          style={{
            textAlign: 'right',
            fontFamily: 'var(--font-mono)',
            color: isOverdrawn ? 'var(--c-festive-b, #B8331F)' : 'var(--c-ink)',
          }}
        />
      </td>
      <td>
        <input
          type="text"
          value={line.notes ?? ''}
          onChange={(e) => setLine(line._key, { notes: e.target.value })}
          placeholder="(optional) — shown as Description 2"
          className={styles.fieldInput}
        />
      </td>
    </tr>
  );
}

export const StockTransferDetail = () => {
  const { id }   = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  /* History drawer. Stable close handler so the memoized panel is not
     re-created on every parent render. */
  const [historyOpen, setHistoryOpen] = useState(false);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  const detail = useStockTransferDetail(id ?? null);
  const cancel = useCancelStockTransfer();
  const updateNotes = useUpdateStockTransferNotes();

  const askConfirm = useConfirm();
  const notify = useNotify();

  const warehouses = useWarehouses();
  const allSkus = useMfgProducts();
  const skuByCode = useMemo(
    () => new Map((allSkus.data ?? []).map((p) => [p.code, p])),
    [allSkus.data],
  );

  // ── Read-only state mirrored from server (no edits post-0078) ────────
  const [fromWarehouseId, setFromWarehouseId] = useState('');
  const [toWarehouseId,   setToWarehouseId]   = useState('');
  const [transferDate,    setTransferDate]    = useState('');
  const [notes,           setNotes]           = useState('');
  const [lines,           setLines]           = useState<LineDraft[]>([]);

  // Header Notes edits at any status. Line SKU/variant/qty/notes edit only
  // while POSTED (backend refuses items on a CANCELLED transfer, since there
  // are no movements left to reverse cleanly).
  const [editing, setEditing] = useState(false);
  // Per-line "available at source" reported up by EditableTransferLineRow —
  // Save is blocked while any row would go negative (owner: never let this
  // push a warehouse's stock below zero).
  const [availByLine, setAvailByLine] = useState<Record<string, number | undefined>>({});
  const onAvail = useCallback((key: string, avail: number | undefined) => {
    setAvailByLine((m) => (m[key] === avail ? m : { ...m, [key]: avail }));
  }, []);

  const hydrateFromServer = useCallback(() => {
    if (!detail.data) return;
    const t = detail.data.transfer;
    setFromWarehouseId(t.from_warehouse_id);
    setToWarehouseId(t.to_warehouse_id);
    setTransferDate(t.transfer_date);
    setNotes(t.notes ?? '');
    setLines(detail.data.lines.map((l) => ({
      _key:        newKey(),
      id:          l.id,
      itemCode:    l.item_code,
      productName: l.product_name ?? '',
      variantKey:  l.variant_key ?? '',
      qty:         l.qty,
      notes:       l.notes ?? '',
    })));
    setAvailByLine({});
  }, [detail.data]);

  // Hydrate when detail loads / refreshes.
  useEffect(() => { hydrateFromServer(); }, [hydrateFromServer]);

  const status: StockTransferStatus | undefined = detail.data?.transfer.status;
  const isPosted = status === 'POSTED';
  const itemsEditable = editing && isPosted;

  /* The list's row Edit action navigates here with ?edit=1 — same contract as
     ?print=1 above — so a click from the main table lands straight in the
     edit state instead of a second click once the detail loads. */
  useEffect(() => {
    if (detail.data && searchParams.get('edit') === '1') setEditing(true);
  }, [detail.data, searchParams]);

  const setLine = (key: string, patch: Partial<LineDraft>) => {
    setLines((cur) => cur.map((l) => (l._key === key ? { ...l, ...patch } : l)));
  };
  const onPickCode = (key: string, code: string) => {
    const sku = skuByCode.get(code);
    // A new SKU invalidates any previously picked variant bucket — same rule
    // as StockTransferNew, and for the same reason (the old bucket may not
    // even exist for the new SKU).
    setLine(key, { itemCode: code, productName: sku?.name ?? '', variantKey: undefined });
  };

  // A changed line needs its bucket re-picked (variantKey !== undefined);
  // qty must be positive; and no row may exceed what EditableTransferLineRow
  // reported as available. Only gates Save while items are actually editable.
  const itemsInvalid = itemsEditable && lines.some((l) => {
    if (!l.itemCode.trim() || l.qty <= 0 || l.variantKey === undefined) return true;
    const avail = availByLine[l._key];
    return avail != null && l.qty > avail;
  });

  const onSave = () => {
    if (!id) return;
    updateNotes.mutate({
      id,
      notes,
      ...(itemsEditable ? {
        items: lines.map((l) => ({
          itemCode: l.itemCode, productName: l.productName,
          variantKey: l.variantKey, qty: l.qty, notes: l.notes,
        })),
      } : {}),
    }, {
      onSuccess: () => { setEditing(false); void detail.refetch(); },
      // The hook's own onError (writeFailed) already toasts the server's
      // message — including, for insufficient_stock, exactly which SKU/
      // bucket and by how much (backend builds that sentence per-document).
      // No second toast needed here.
    });
  };

  const onDiscardEdit = () => {
    setEditing(false);
    hydrateFromServer();
  };

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
            {status && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <StatusPill docType="stockTransfer" status={status} />
                {/* Rightmost-of-status edit entry (owner request) — same
                    edit state as the action-bar Edit button below. */}
                {!editing && (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(true)} title="Edit">
                    <Pencil size={13} strokeWidth={1.75} />
                  </Button>
                )}
              </div>
            )}
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
              {!editing ? (
                <Button variant="ghost" size="md" onClick={() => setEditing(true)}>
                  <Pencil {...ICON} /> Edit
                </Button>
              ) : (
                <>
                  <Button variant="ghost" size="md" onClick={onDiscardEdit} disabled={updateNotes.isPending}>
                    <X {...ICON} /> Discard
                  </Button>
                  <Button variant="primary" size="md" onClick={onSave} disabled={updateNotes.isPending || itemsInvalid}
                    title={itemsInvalid ? 'Fix the highlighted line(s) first — a bucket must be picked and qty cannot exceed what is available' : undefined}>
                    <Save {...ICON} /> {updateNotes.isPending ? 'Saving…' : 'Save'}
                  </Button>
                </>
              )}
              {isPosted && !editing && (
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
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className={styles.fieldInput}
                disabled={!editing}
              />
            </label>
          </div>
        </div>
      </section>

      {/* ── Lines card ───────────────────────────────────────────────
          Read-only post-0078 UNLESS Edit is on and the transfer is POSTED
          (itemsEditable) — then SKU/variant/qty/notes open up, each row
          showing live on-hand at the source warehouse so a qty that would
          take it negative is caught before Save, not after. */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items</h2>
        </div>
        <div className={styles.cardBody}>
          {editing && !isPosted && (
            <p className={styles.muted} style={{ marginBottom: 8 }}>
              This transfer is {status} — only Notes can be changed here. SKU/qty edits need a POSTED transfer.
            </p>
          )}
          <table className={styles.table}>
            <thead>
              <tr>
                <th style={{ width: '18%' }}>SKU</th>
                <th>Description</th>
                {itemsEditable && <th style={{ width: '20%' }}>Variant / bucket</th>}
                {itemsEditable && <th style={{ width: 90, textAlign: 'right' }}>Available</th>}
                <th style={{ width: 110, textAlign: 'right' }}>Qty</th>
                <th>Description 2</th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={itemsEditable ? 6 : 4} className={styles.emptyRow}>No lines.</td></tr>
              )}
              {itemsEditable
                ? lines.map((ln) => (
                    <EditableTransferLineRow
                      key={ln._key}
                      line={ln}
                      fromWarehouseId={fromWarehouseId}
                      skus={allSkus.data ?? []}
                      onPickCode={onPickCode}
                      setLine={setLine}
                      onAvail={onAvail}
                    />
                  ))
                : lines.map((ln) => (
                    <tr key={ln._key}>
                      <td><span className={styles.codeCell}>{ln.itemCode}</span></td>
                      <td>{ln.productName || <span className={styles.muted}>—</span>}</td>
                      <td className={styles.tableRight} style={{ fontFamily: 'var(--font-mono)' }}>
                        {fmtQty(ln.qty)}
                      </td>
                      {/* "Description 2": the Remarks typed on this line at
                          creation (StockTransferNew's per-line Remarks
                          column) — editable text-only while `editing`, on any
                          status, via the same PATCH /:id that touches the
                          header notes. */}
                      <td>
                        {editing ? (
                          <input
                            type="text"
                            value={ln.notes ?? ''}
                            onChange={(e) => setLine(ln._key, { notes: e.target.value })}
                            className={styles.fieldInput}
                          />
                        ) : ln.notes?.trim()
                          ? <span>{ln.notes}</span>
                          : <span className={styles.muted}>—</span>}
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
