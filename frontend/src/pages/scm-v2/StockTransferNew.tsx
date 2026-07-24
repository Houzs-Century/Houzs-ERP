// ----------------------------------------------------------------------------
// StockTransferNew — full-page form at /inventory/transfers/new.
//
// Mirrors PurchaseOrderNew chrome: back link + title + Cancel/Save in the
// headerRow, header card with From/To/Date/Notes, items grid below with
// SKU picker + live current-balance lookup against the From warehouse.
// PR-DRAFT-removal (2026-05-27): Save creates as POSTED directly + writes
// inventory_movements inline; routes to /inventory/transfers/:id afterward.
//
// HOUZS VENDOR — verbatim from apps/backend/src/pages/StockTransferNew.tsx.
// Import boundary only: react-router → react-router-dom; ConfirmDialog/
// NotifyDialog + useWarehouses ← vendored; balances/transfer hooks ←
// vendored stock-queries; mfg-products-queries via vendored slice; css
// colocated. Back/Cancel → list, Save → /scm/stock-transfers/:id.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Save, X, Plus, Trash2, AlertTriangle } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { useInventoryBuckets } from '../../vendor/scm/lib/stock-queries';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useMfgProducts } from '../../vendor/scm/lib/mfg-products-queries';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import {
  useCreateStockTransfer,
  type StockTransferItemInput,
} from '../../vendor/scm/lib/stock-queries';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type LineDraft = StockTransferItemInput & { _key: string };

const newKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const blankLine = (): LineDraft => ({
  _key: newKey(),
  productCode: '',
  productName: '',
  qty: 1,
  notes: '',
});

const todayISO = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Humanise a variant_key ("fabriccode=bf-16|gap=16|legheight=2") into a compact
// bucket label for the picker. '' = the unclassified / plain-SKU bucket.
const humanizeVariantKey = (k: string): string =>
  k ? k.split('|').map((s) => s.replace('=', ' ')).join(' · ') : '(unclassified)';

// Sentinel for the "no bucket picked yet" option — distinct from '' (which is a
// real, pickable unclassified bucket).
const UNPICKED = '__UNPICKED__';

// One transfer line. Owns its OWN inventory-bucket query so each line offers only
// its SKU's real variant buckets (with on-hand qty) at the From warehouse — the
// operator moves the exact bucket, keeping stock + MRP accurate (owner 2026-07-20).
function TransferLineRow({
  line, fromWarehouseId, skus, onPickCode, setLine, removeLine, canRemove,
}: {
  line: LineDraft;
  fromWarehouseId: string;
  skus: Array<{ id: string | number; code: string; name: string }>;
  onPickCode: (key: string, code: string) => void;
  setLine: (key: string, patch: Partial<LineDraft>) => void;
  removeLine: (key: string) => void;
  canRemove: boolean;
}) {
  const bucketsQ = useInventoryBuckets(line.productCode || null, fromWarehouseId || null);
  // The line stores only variant_key (the backend picks the batch FIFO), so sum
  // the (variant_key, batch) buckets up to one row per variant_key.
  const variantBuckets = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of (bucketsQ.data ?? [])) {
      m.set(b.variant_key ?? '', (m.get(b.variant_key ?? '') ?? 0) + b.qty);
    }
    return [...m.entries()]
      .map(([variantKey, qty]) => ({ variantKey, qty }))
      .sort((a, b) => b.qty - a.qty);
  }, [bucketsQ.data]);

  const avail = line.variantKey === undefined
    ? undefined
    : variantBuckets.find((v) => v.variantKey === line.variantKey)?.qty;
  const isOverdrawn = avail != null && line.qty > avail;
  const ready = Boolean(line.productCode && fromWarehouseId);

  return (
    <tr>
      <td>
        <input
          type="text"
          list={`xfer-skus-${line._key}`}
          value={line.productCode}
          onChange={(e) => onPickCode(line._key, e.target.value)}
          placeholder="Type code…"
          className={styles.fieldInput}
          style={{ fontFamily: 'var(--font-mono)' }}
        />
        <datalist id={`xfer-skus-${line._key}`}>
          {sortByText(skus).map((p) => (
            <option key={p.id} value={p.code}>{p.name}</option>
          ))}
        </datalist>
      </td>
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
              : !line.productCode ? 'Pick SKU first'
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
      <td className={styles.actionsCell}>
        <button
          type="button"
          onClick={() => removeLine(line._key)}
          className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
          disabled={!canRemove}
          title="Remove line"
        >
          <Trash2 size={14} strokeWidth={1.75} />
        </button>
      </td>
    </tr>
  );
}

export const StockTransferNew = () => {
  const navigate = useNavigate();
  const create   = useCreateStockTransfer();
  /* One key for the one transfer this page is open to raise (lib/idempotency.ts).
     Route-level form, navigates to the transfer detail on success, so the MOUNT
     is exactly one transfer. Its mobile twin (MobileStockTransferNew) mints its
     own — same document, both sides, one PR. */
  const idemKey  = useIdempotencyKey();

  const notify = useNotify();

  // ── Header state ─────────────────────────────────────────────────────
  const [fromWarehouseId, setFromWarehouseId] = useState<string>('');
  const [toWarehouseId,   setToWarehouseId]   = useState<string>('');
  const [transferDate,    setTransferDate]    = useState<string>(todayISO());
  const [notes,           setNotes]           = useState<string>('');

  // ── Lines ────────────────────────────────────────────────────────────
  const [lines, setLines] = useState<LineDraft[]>([blankLine()]);

  // ── Data ─────────────────────────────────────────────────────────────
  const warehouses = useWarehouses();
  const allSkus    = useMfgProducts();
  // Per-line variant buckets (available stock at the From warehouse) are pulled
  // inside <TransferLineRow> so each line offers only its own SKU's real buckets.

  // ── Helpers ──────────────────────────────────────────────────────────
  const skuByCode = useMemo(
    () => new Map((allSkus.data ?? []).map((p) => [p.code, p])),
    [allSkus.data],
  );

  const setLine = (key: string, patch: Partial<LineDraft>) => {
    setLines((cur) => cur.map((l) => (l._key === key ? { ...l, ...patch } : l)));
  };

  const onPickCode = (key: string, code: string) => {
    const sku = skuByCode.get(code);
    setLine(key, {
      productCode: code,
      productName: sku?.name ?? '',
      // A new SKU invalidates any previously picked variant bucket.
      variantKey: undefined,
    });
  };

  const addLine    = () => setLines((cur) => [...cur, blankLine()]);
  const removeLine = (key: string) =>
    setLines((cur) => (cur.length <= 1 ? cur : cur.filter((l) => l._key !== key)));

  // ── Validation ───────────────────────────────────────────────────────
  const sameWarehouse = Boolean(
    fromWarehouseId && toWarehouseId && fromWarehouseId === toWarehouseId,
  );
  // A line is valid only once its variant BUCKET is picked (variantKey set).
  // Transferring without it would move the unclassified bucket and desync stock.
  const validLines = lines.filter((l) => l.productCode.trim() && l.qty > 0 && l.variantKey !== undefined);
  const needsBucket = lines.some((l) => l.productCode.trim() && l.qty > 0 && l.variantKey === undefined);

  const canSave = Boolean(
    fromWarehouseId &&
    toWarehouseId &&
    !sameWarehouse &&
    transferDate &&
    validLines.length > 0 &&
    !needsBucket,
  );

  const onSave = async () => {
    if (!canSave) {
      notify({
        title: needsBucket
          ? 'Pick the variant bucket for every line — that is the exact stock the transfer moves.'
          : 'Pick From + To warehouses (must differ), date, and at least one valid line.',
        tone: 'error',
      });
      return;
    }
    // Over-quantity is enforced server-side per (product, variant_key) bucket —
    // the OUT movement rejects taking more than that bucket holds — so the client
    // no longer pre-checks an aggregate balance it no longer fetches.

    create.mutate(
      {
        idempotencyKey: idemKey,
        fromWarehouseId,
        toWarehouseId,
        transferDate,
        notes: notes.trim() || undefined,
        items: validLines.map(({ _key: _ignored, ...rest }) => ({
          ...rest,
          productName: rest.productName?.trim() || undefined,
          notes:       rest.notes?.trim()       || undefined,
        })),
      },
      {
        onSuccess: (res) => navigate(`/scm/stock-transfers/${res.id}`),
        onError:   (err) => notify({ title: 'Save failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
      },
    );
  };

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Warehouse"
        title="New Stock Transfer"
        actions={
          <>
            <div className={styles.actions}>
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/stock-transfers')}>
                <X {...ICON} /> Cancel
              </Button>
              <Button variant="primary" size="md" onClick={onSave} disabled={create.isPending}>
                <Save {...ICON} />
                {create.isPending ? 'Posting…' : 'Post Transfer'}
              </Button>
            </div>
          </>
        }
      />

      {/* ── Header card ──────────────────────────────────────────────── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Transfer</h2>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>From Warehouse *</span>
              <select
                value={fromWarehouseId}
                onChange={(e) => setFromWarehouseId(e.target.value)}
                className={styles.fieldSelect}
              >
                <option value="">— Pick source —</option>
                {sortByText(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>{w.code}</option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                <ArrowRight size={11} strokeWidth={1.75} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                To Warehouse *
              </span>
              <select
                value={toWarehouseId}
                onChange={(e) => setToWarehouseId(e.target.value)}
                className={styles.fieldSelect}
              >
                <option value="">— Pick destination —</option>
                {sortByText(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id} disabled={w.id === fromWarehouseId}>
                    {w.code}{w.id === fromWarehouseId ? ' (source)' : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Transfer Date *</span>
              <input
                type="date"
                value={transferDate}
                onChange={(e) => setTransferDate(e.target.value)}
                className={styles.fieldInput}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="(optional)"
                className={styles.fieldInput}
              />
            </label>
          </div>

          {sameWarehouse && (
            <div style={{
              marginTop: 'var(--space-3)',
              padding: 'var(--space-3) var(--space-4)',
              background: 'rgba(184, 51, 31, 0.08)',
              border: '1px solid var(--c-festive-b, #B8331F)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--fs-13)',
              color: 'var(--c-festive-b, #B8331F)',
              display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
            }}>
              <AlertTriangle size={16} strokeWidth={1.75} />
              <span>Source and destination warehouses must be different.</span>
            </div>
          )}
        </div>
      </section>

      {/* ── Items card ──────────────────────────────────────────────── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items</h2>
          <Button variant="ghost" size="sm" onClick={addLine}>
            <Plus size={14} strokeWidth={1.75} /> Add Line Item
          </Button>
        </div>
        <div className={styles.cardBody}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th style={{ width: '22%' }}>SKU *</th>
                <th>Variant bucket *</th>
                <th style={{ width: 110, textAlign: 'right' }}>Available</th>
                <th style={{ width: 110, textAlign: 'right' }}>Qty *</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((ln) => (
                <TransferLineRow
                  key={ln._key}
                  line={ln}
                  fromWarehouseId={fromWarehouseId}
                  skus={allSkus.data ?? []}
                  onPickCode={onPickCode}
                  setLine={setLine}
                  removeLine={removeLine}
                  canRemove={lines.length > 1}
                />
              ))}
            </tbody>
          </table>

          <div className={styles.addLineRow}>
            <Button variant="ghost" size="sm" onClick={addLine}>
              <Plus size={14} strokeWidth={1.75} /> Add Line Item
            </Button>
          </div>

          {needsBucket && (
            <div style={{
              marginTop: 'var(--space-3)',
              padding: 'var(--space-3) var(--space-4)',
              background: 'rgba(184, 51, 31, 0.08)',
              border: '1px solid var(--c-festive-b, #B8331F)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--fs-13)',
              color: 'var(--c-festive-b, #B8331F)',
              display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)',
            }}>
              <AlertTriangle size={16} strokeWidth={1.75} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>
                <strong>Pick the variant bucket on every line.</strong>
                {' '}That is the exact stock (fabric / height / special) the transfer moves —
                a transfer with no bucket would desync stock and MRP.
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
