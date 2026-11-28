
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, History, X, Ban, Printer, Pencil, Save, Trash2 } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { StockTransferPodSection } from './StockTransferPodSection';
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
import { NumberInput } from '../../vendor/scm/components/NumberInput';
import { AddLineButton } from '../../vendor/scm/components/AddLineButton';
import { useAddLineHotkey } from '../../vendor/scm/lib/useAddLineHotkey';
import { EntityHistoryPanel } from './EntityHistoryPanel';
import { STOCK_TRANSFER_AUDIT_LABELS } from './entity-audit-labels';
import { DateField } from "../../vendor/scm/components/DateField";
import { PrintPreviewModal, useOpenPrintPreviewFromUrl, usePrintPreview } from '../../components/scm-v2/PrintPreviewModal';
import { warehouseLabel } from '../../vendor/scm/lib/warehouse-label';
import type { PdfAction } from '../../vendor/scm/lib/pdf-common';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type LineDraft = StockTransferItemInput & { _key: string; id: string };

const newKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const blankLine = (): LineDraft => ({
  _key: newKey(),
  id: '',
  itemCode: '',
  productName: '',
  qty: 1,
  notes: '',
});

const UNPICKED = '__UNPICKED__';
const humanizeVariantKey = (k: string): string => variantKeyLabel(k, '(unclassified)');

function EditableTransferLineRow({
  line, fromWarehouseId, skus, onPickCode, setLine, onAvail, removeLine, canRemove,
}: {
  line: LineDraft;
  fromWarehouseId: string;
  skus: Array<{ id: string | number; code: string; name: string }>;
  onPickCode: (key: string, code: string) => void;
  setLine: (key: string, patch: Partial<LineDraft>) => void;
  onAvail: (key: string, avail: number | undefined) => void;
  removeLine: (key: string) => void;
  canRemove: boolean;
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
          title={line.variantKey === undefined ? undefined : humanizeVariantKey(line.variantKey)}
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
        {/* The picked bucket in full, wrapped: two buckets often differ only at
            the END of the label ("... special hb fully covered"), which is the
            part a closed select cuts off (owner 2026-10-06). */}
        {line.variantKey !== undefined && (
          <div className={styles.bucketPicked}>{humanizeVariantKey(line.variantKey)}</div>
        )}
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
        <NumberInput
          sign="unsigned"
          decimal={false}
          value={line.qty}
          onValueChange={(n) => setLine(line._key, { qty: Math.max(0, n ?? 0) })}
          className={styles.fieldInput}
          style={{
            textAlign: 'right',
            fontFamily: 'var(--font-mono)',
            color: isOverdrawn ? 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' : 'var(--c-ink)',
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
      <td>
        <span className={styles.actionsCell}>
          <button
            type="button"
            onClick={() => removeLine(line._key)}
            className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
            disabled={!canRemove}
            title="Remove line"
          >
            <Trash2 size={14} strokeWidth={1.75} />
          </button>
        </span>
      </td>
    </tr>
  );
}

export const StockTransferDetail = () => {
  const { id }   = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

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

  const [fromWarehouseId, setFromWarehouseId] = useState('');
  const [toWarehouseId,   setToWarehouseId]   = useState('');
  const [transferDate,    setTransferDate]    = useState('');
  const [notes,           setNotes]           = useState('');
  const [lines,           setLines]           = useState<LineDraft[]>([]);

  const [editing, setEditing] = useState(false);
  const [availByLine, setAvailByLine] = useState<Record<string, number | undefined>>({});
  const onAvail = useCallback((key: string, avail: number | undefined) => {
    setAvailByLine((m) => (m[key] === avail ? m : { ...m, [key]: avail }));
  }, []);

  const [originalLines, setOriginalLines] = useState<Record<string, { itemCode: string; variantKey: string | undefined; qty: number }>>({});

  const hydrateFromServer = useCallback(() => {
    if (!detail.data) return;
    const t = detail.data.transfer;
    setFromWarehouseId(t.from_warehouse_id);
    setToWarehouseId(t.to_warehouse_id);
    setTransferDate(t.transfer_date);
    setNotes(t.notes ?? '');
    const hydrated = detail.data.lines.map((l) => ({
      _key:        newKey(),
      id:          l.id,
      itemCode:    l.item_code,
      productName: l.product_name ?? '',
      variantKey:  l.variant_key ?? '',
      qty:         l.qty,
      notes:       l.notes ?? '',
    }));
    setLines(hydrated);
    setOriginalLines(Object.fromEntries(hydrated.map((l) => [l._key, {
      itemCode: l.itemCode, variantKey: l.variantKey, qty: l.qty,
    }])));
    setAvailByLine({});
  }, [detail.data]);

  useEffect(() => { hydrateFromServer(); }, [hydrateFromServer]);

  const status: StockTransferStatus | undefined = detail.data?.transfer.status;
  const isPosted = status === 'POSTED';
  const itemsEditable = editing && isPosted;

  useEffect(() => {
    if (detail.data && searchParams.get('edit') === '1') setEditing(true);
  }, [detail.data, searchParams]);

  const setLine = (key: string, patch: Partial<LineDraft>) => {
    setLines((cur) => cur.map((l) => (l._key === key ? { ...l, ...patch } : l)));
  };
  const onPickCode = (key: string, code: string) => {
    const sku = skuByCode.get(code);
    setLine(key, { itemCode: code, productName: sku?.name ?? '', variantKey: undefined });
  };
  const addLine = () => setLines((cur) => [...cur, blankLine()]);
  useAddLineHotkey(addLine, itemsEditable);
  const removeLine = (key: string) =>
    setLines((cur) => (cur.length <= 1 ? cur : cur.filter((l) => l._key !== key)));

  const itemsInvalid = itemsEditable && lines.some((l) => {
    if (!l.itemCode.trim() || l.qty <= 0 || l.variantKey === undefined) return true;
    const avail = availByLine[l._key];
    return avail != null && l.qty > avail;
  });

  const linesChanged = itemsEditable && (
    lines.length !== (detail.data?.lines.length ?? 0)
    || lines.some((l) => {
      const o = originalLines[l._key] as (typeof originalLines)[string] | undefined;
      if (!o) return true;
      return o.itemCode !== l.itemCode || o.variantKey !== l.variantKey || o.qty !== l.qty
        || (l.notes ?? '') !== (detail.data?.lines.find((sl) => sl.id === l.id)?.notes ?? '');
    })
  );

  const onSave = () => {
    if (!id) return;
    updateNotes.mutate({
      id,
      notes,
      ...(linesChanged ? {
        items: lines.map((l) => ({
          itemCode: l.itemCode, productName: l.productName,
          variantKey: l.variantKey, qty: l.qty, notes: l.notes,
        })),
      } : {}),
    }, {
      onSuccess: () => { setEditing(false); void detail.refetch(); },
    });
  };

  const onDiscardEdit = () => {
    setEditing(false);
    hydrateFromServer();
  };

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
  useOpenPrintPreviewFromUrl(print.openPreview, !!detail.data);

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
                {!editing && (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(true)} title="Edit">
                    <Pencil size={13} strokeWidth={1.75} />
                  </Button>
                )}
              </div>
            )}
            <div className={styles.actions}>
              <Button variant="ghost" size="md" onClick={() => setHistoryOpen(true)}>
                <History {...ICON} /> History
              </Button>
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
              {status === 'CANCELLED' && detail.data.stockNotBack && (
                <Button variant="primary" size="md" disabled={cancel.isPending}
                  title="The cancel did not move all the stock back; this moves the rest"
                  onClick={() => id && cancel.mutate(id, {
                    onSuccess: () => detail.refetch(),
                    onError: (err) => notify({ title: 'Finish cancel failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
                  })}>
                  <Ban {...ICON} /> {cancel.isPending ? 'Moving stock back…' : 'Finish cancel'}
                </Button>
              )}
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/stock-transfers')}>
                <X {...ICON} /> Close
              </Button>
            </div>
          </>
        }
      />

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Transfer</h2>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
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

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items</h2>
          {itemsEditable && <AddLineButton variant="ghost" onClick={addLine} />}
        </div>
        <div className={styles.cardBody}>
          {editing && !isPosted && (
            <p className={styles.muted} style={{ marginBottom: 8 }}>
              This transfer is {status} — only Notes can be changed here. SKU/qty edits need a POSTED transfer.
            </p>
          )}
          <table className={`${styles.table} ${styles.tableOwnWidths}`}>
            <thead>
              <tr>
                <th style={{ width: '18%' }}>SKU</th>
                <th>Description</th>
                {itemsEditable && <th style={{ width: '20%' }}>Variant / bucket</th>}
                {itemsEditable && <th style={{ width: 90, textAlign: 'right' }}>Available</th>}
                <th style={{ width: 110, textAlign: 'right' }}>Qty</th>
                <th>Description 2</th>
                {itemsEditable && <th style={{ width: 40 }} />}
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={itemsEditable ? 7 : 4} className={styles.emptyRow}>No lines.</td></tr>
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
                      removeLine={removeLine}
                      canRemove={lines.length > 1}
                    />
                  ))
                : lines.map((ln) => (
                    <tr key={ln._key}>
                      <td><span className={styles.codeCell}>{ln.itemCode}</span></td>
                      <td>{ln.productName || <span className={styles.muted}>—</span>}</td>
                      <td className={styles.tableRight} style={{ fontFamily: 'var(--font-mono)' }}>
                        {fmtQty(ln.qty)}
                      </td>
                      <td>
                        {ln.notes?.trim()
                          ? <span>{ln.notes}</span>
                          : <span className={styles.muted}>—</span>}
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
          {itemsEditable && (
            <div className={styles.addLineRow}>
              <AddLineButton variant="ghost" onClick={addLine} />
            </div>
          )}
        </div>
      </section>

      {id && <StockTransferPodSection id={id} />}

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
