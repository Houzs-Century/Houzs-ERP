
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Save, X, Plus, Trash2, AlertTriangle } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { AddLineButton } from '../../vendor/scm/components/AddLineButton';
import { useAddLineHotkey } from '../../vendor/scm/lib/useAddLineHotkey';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { useInventoryBuckets } from '../../vendor/scm/lib/stock-queries';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useMfgProducts } from '../../vendor/scm/lib/mfg-products-queries';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { variantKeyLabel } from '../../vendor/scm/lib/variant-key-label';
import {
  useCreateStockTransfer,
  type StockTransferItemInput,
} from '../../vendor/scm/lib/stock-queries';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { NumberInput } from '../../vendor/scm/components/NumberInput';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { FreshMount } from '../../lib/freshMount';
import { DateField } from "../../vendor/scm/components/DateField";
import { todayMyt } from '../../vendor/scm/lib/dates';
import { useRacks, type Rack } from '../../vendor/scm/lib/warehouse-queries';
import { heldOnRack, rackMovesSummary } from '../../vendor/scm/lib/stock-transfer-racks';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type LineDraft = StockTransferItemInput & { _key: string };

const newKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const blankLine = (): LineDraft => ({
  _key: newKey(),
  itemCode: '',
  productName: '',
  qty: 1,
  notes: '',
});

const humanizeVariantKey = (k: string): string => variantKeyLabel(k, '(unclassified)');

const UNPICKED = '__UNPICKED__';

const byRackLabel = (a: Rack, b: Rack) => a.rack.localeCompare(b.rack, 'en', { numeric: true });

// One transfer line. Owns its OWN inventory-bucket query so each line offers only
// its SKU's real variant buckets (with on-hand qty) at the From warehouse — the
// operator moves the exact bucket, keeping stock + MRP accurate (owner 2026-07-20).
function TransferLineRow({
  line, fromWarehouseId, skus, onPickCode, setLine, removeLine, canRemove, fromRacks, toRacks,
}: {
  line: LineDraft;
  fromWarehouseId: string;
  fromRacks: Rack[];
  toRacks: Rack[];
  skus: Array<{ id: string | number; code: string; name: string }>;
  onPickCode: (key: string, code: string) => void;
  setLine: (key: string, patch: Partial<LineDraft>) => void;
  removeLine: (key: string) => void;
  canRemove: boolean;
}) {
  const bucketsQ = useInventoryBuckets(line.itemCode || null, fromWarehouseId || null);
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
  const ready = Boolean(line.itemCode && fromWarehouseId);
  const racksHolding = fromRacks
    .map((r) => ({ rack: r, held: heldOnRack(r, line.itemCode) }))
    .filter((x) => x.held > 0);
  const fromHeld = line.fromRackId ? racksHolding.find((x) => x.rack.id === line.fromRackId)?.held ?? 0 : null;
  const rackShort = fromHeld != null && line.qty > fromHeld;

  return (
    <tr>
      <td>
        <input
          type="text"
          list={`xfer-skus-${line._key}`}
          value={line.itemCode}
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
          aria-label={`Qty for ${line.itemCode || 'line'}`}
          className={styles.fieldInput}
          style={{
            textAlign: 'right',
            fontFamily: 'var(--font-mono)',
            color: isOverdrawn ? 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' : 'var(--c-ink)',
          }}
        />
      </td>
      <td>
        <select
          value={line.fromRackId ?? ''}
          onChange={(e) => setLine(line._key, { fromRackId: e.target.value || undefined })}
          className={styles.fieldInput}
          disabled={!ready}
          aria-label={`From rack for ${line.itemCode || 'line'}`}
          style={{ fontSize: 'var(--fs-12)' }}
        >
          <option value="">Not on a rack</option>
          {racksHolding.map(({ rack, held }) => (
            <option key={rack.id} value={rack.id}>{rack.rack} ({held.toLocaleString('en-MY')} here)</option>
          ))}
        </select>
        {rackShort && (
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' }}>
            Rack holds only {fromHeld}
          </div>
        )}
      </td>
      <td>
        <select
          value={line.toRackId ?? ''}
          onChange={(e) => setLine(line._key, { toRackId: e.target.value || undefined })}
          className={styles.fieldInput}
          disabled={toRacks.length === 0}
          aria-label={`To rack for ${line.itemCode || 'line'}`}
          style={{ fontSize: 'var(--fs-12)' }}
        >
          <option value="">Not on a rack</option>
          {toRacks.map((r) => (
            <option key={r.id} value={r.id}>{r.rack}{r.reserved ? ' (reserved)' : ''}</option>
          ))}
        </select>
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

export const StockTransferNew = () => (
  <FreshMount>{(startNew) => <StockTransferForm onStartNew={startNew} />}</FreshMount>
);

const StockTransferForm = ({ onStartNew }: { onStartNew: () => void }) => {
  const navigate = useNavigate();
  const create   = useCreateStockTransfer();
  const idemKey  = useIdempotencyKey();

  const notify = useNotify();
  const [created, setCreated] = useState<{ id: string; transferNo: string } | null>(null);
  const [resultOpen, setResultOpen] = useState(false);

  const [fromWarehouseId, setFromWarehouseId] = useState<string>('');
  const [toWarehouseId,   setToWarehouseId]   = useState<string>('');
  const [transferDate,    setTransferDate]    = useState<string>(todayMyt());
  const [notes,           setNotes]           = useState<string>('');

  const [lines, setLines] = useState<LineDraft[]>([blankLine()]);

  const warehouses = useWarehouses();
  const allSkus    = useMfgProducts();
  const fromRacksQ = useRacks({ warehouseId: fromWarehouseId || undefined });
  const toRacksQ   = useRacks({ warehouseId: toWarehouseId || undefined });
  const fromRacks = useMemo(
    () => (fromWarehouseId ? (fromRacksQ.data?.racks ?? []).filter((r) => r.warehouse_id === fromWarehouseId).sort(byRackLabel) : []),
    [fromRacksQ.data, fromWarehouseId],
  );
  const toRacks = useMemo(
    () => (toWarehouseId ? (toRacksQ.data?.racks ?? []).filter((r) => r.warehouse_id === toWarehouseId).sort(byRackLabel) : []),
    [toRacksQ.data, toWarehouseId],
  );
  const [postedRackMoves, setPostedRackMoves] = useState<string[]>([]);

  const pickFromWarehouse = (id: string) => {
    setFromWarehouseId(id);
    setLines((cur) => cur.map((l) => ({ ...l, fromRackId: undefined })));
  };
  const pickToWarehouse = (id: string) => {
    setToWarehouseId(id);
    setLines((cur) => cur.map((l) => ({ ...l, toRackId: undefined })));
  };

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
      itemCode: code,
      productName: sku?.name ?? '',
      variantKey: undefined,
      fromRackId: undefined,
    });
  };

  const addLine    = () => setLines((cur) => [...cur, blankLine()]);
  useAddLineHotkey(addLine, created == null);
  const removeLine = (key: string) =>
    setLines((cur) => (cur.length <= 1 ? cur : cur.filter((l) => l._key !== key)));

  const sameWarehouse = Boolean(
    fromWarehouseId && toWarehouseId && fromWarehouseId === toWarehouseId,
  );
  const validLines = lines.filter((l) => l.itemCode.trim() && l.qty > 0 && l.variantKey !== undefined);
  const needsBucket = lines.some((l) => l.itemCode.trim() && l.qty > 0 && l.variantKey === undefined);

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
        onSuccess: (res) => {
          const label = (id: string) => [...fromRacks, ...toRacks].find((r) => r.id === id)?.rack ?? 'rack';
          setPostedRackMoves(rackMovesSummary(validLines, label));
          setCreated(res);
          setResultOpen(true);
        },
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
          created ? (
            <div className={styles.actions}>
              <Button variant="ghost" size="md" onClick={onStartNew}>
                <Plus {...ICON} /> New stock transfer
              </Button>
              <Button variant="primary" size="md" onClick={() => navigate(`/scm/stock-transfers/${created.id}`)}>
                Open {created.transferNo}
              </Button>
            </div>
          ) : (
            <div className={styles.actions}>
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/stock-transfers')}>
                <X {...ICON} /> Cancel
              </Button>
              <Button variant="primary" size="md" onClick={onSave} disabled={create.isPending}>
                <Save {...ICON} />
                {create.isPending ? 'Posting…' : 'Post Transfer'}
              </Button>
            </div>
          )
        }
      />

      <fieldset disabled={created != null} className="space-y-4" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>

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
                onChange={(e) => pickFromWarehouse(e.target.value)}
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
                onChange={(e) => pickToWarehouse(e.target.value)}
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
              <DateField fullWidth value={transferDate} onChange={(iso) => setTransferDate(iso)} className={styles.fieldInput}/>
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
              color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))',
              display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
            }}>
              <AlertTriangle size={16} strokeWidth={1.75} />
              <span>Source and destination warehouses must be different.</span>
            </div>
          )}
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items</h2>
          <AddLineButton variant="ghost" onClick={addLine} />
        </div>
        <div className={styles.cardBody}>
          <table className={`${styles.table} ${styles.tableOwnWidths}`}>
            <thead>
              <tr>
                <th style={{ width: '22%' }}>SKU *</th>
                <th>Variant bucket *</th>
                <th style={{ width: 110, textAlign: 'right' }}>Available</th>
                <th style={{ width: 110, textAlign: 'right' }}>Qty *</th>
                <th style={{ width: 150 }}>From rack</th>
                <th style={{ width: 150 }}>To rack</th>
                <th style={{ width: 200 }}>Remarks</th>
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
                  fromRacks={fromRacks}
                  toRacks={toRacks}
                />
              ))}
            </tbody>
          </table>

          <div className={styles.addLineRow}>
            <AddLineButton variant="ghost" onClick={addLine} />
          </div>

          {needsBucket && (
            <div style={{
              marginTop: 'var(--space-3)',
              padding: 'var(--space-3) var(--space-4)',
              background: 'rgba(184, 51, 31, 0.08)',
              border: '1px solid var(--c-festive-b, #B8331F)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--fs-13)',
              color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))',
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
      </fieldset>

      {created && resultOpen && (
        <ActionResultDialog
          title={`Stock transfer ${created.transferNo} posted`}
          body={postedRackMoves.length === 0
            ? 'The stock has moved. Open the transfer, or start the next one.'
            : `The stock and the racks moved together: ${postedRackMoves.join('; ')}. Open the transfer, or start the next one.`}
          primaryLabel="Open transfer"
          onPrimary={() => navigate(`/scm/stock-transfers/${created.id}`)}
          secondaryLabel="New stock transfer"
          onSecondary={onStartNew}
          onClose={() => setResultOpen(false)}
        />
      )}
    </div>
  );
};
