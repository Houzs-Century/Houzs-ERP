// ----------------------------------------------------------------------------
// StockAdjustmentNew — manual stock correction form at /inventory/adjustments/new.
//
// LINE-BY-LINE (owner 2026-09-18): the items section is a ROW TABLE, the same
// look/pattern as New Stock Transfer — one row per SKU, "Add Line Item" appends
// another row. Columns: SKU · Product Name · Qty · Reason · Note · delete.
// Warehouse stays ONE shared field in the header (every row adjusts the same
// location, as before / as Transfer).
//
// SIGNED QTY — the direction of the correction is the SIGN of Qty, not a toggle:
//   • positive  = INCREASE  (found / recount up)
//   • negative  = DECREASE  (write-off / damage / loss)
// There is NO Increase/Decrease control any more. On Save each row's SIGNED qty
// is sent verbatim as `qtyDelta` (the POST already takes a signed delta), and a
// row with qty 0 or no SKU is rejected.
//
// The write contract is otherwise UNCHANGED, and everything a correct stock
// write needs is preserved: an INCREASE of a sofa / bedframe still carries its
// variant attributes + batch (backend 422s otherwise), and a DECREASE still
// picks the exact open lot it takes stock out of. Those live in an expandable
// detail row under a line (shown once its warehouse + SKU are set) so the main
// table keeps the five columns above.
//
// Save posts the whole form as ONE document (BUG-66): one POST, one number
// (`HC-SA-YYMM-NNN`), and the backend writes every line's movement in a single
// statement, so a failure moves nothing.
//
// EDIT (BUG-66, Sim chose "edit everything"): /scm/stock-adjustments/:id/edit
// mounts this same form seeded from the saved document. Save sends the full
// line list; the backend moves only the difference per bucket. Each loaded line
// remembers its saved qty + bucket so the balance hint and the "Take from" cap
// count the stock this document already took as available again. The
// warehouse is fixed once saved.
//
// HOUZS VENDOR chrome: PageHeader back + Cancel/Save, header card, items card
// with the shared `styles.table`. Save → a result dialog: open the saved
// adjustment, or "New stock adjustment", which REMOUNTS the form (FreshMount) so
// nothing from the saved one carries over (staff request 2026-09-14).
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Save, X, Plus, AlertTriangle, ChevronDown, Trash2 } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { AddLineButton } from '../../vendor/scm/components/AddLineButton';
import { useAddLineHotkey } from '../../vendor/scm/lib/useAddLineHotkey';
import { activeOptions, ADJUSTMENT_REASONS, adjustmentIncreaseErrors, maintPickerValues } from '@2990s/shared';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { bucketKey, NO_BUCKET_PICKED } from '../../vendor/scm/lib/stock-adjustment-buckets';
import {
  useStockAdjustment,
  useStockAdjustmentDoc,
  useUpdateStockAdjustment,
  useInventoryProductBreakdown,
  useInventoryBuckets,
  type StockAdjustmentDoc,
  type StockAdjustmentLine,
  type StockAdjustmentLineInput,
} from '../../vendor/scm/lib/stock-queries';
import { useMfgProducts, useMaintenanceConfig, useSpecialAddons, mfgCategoryLabel, type MaintenanceConfig, type SpecialAddonRow } from '../../vendor/scm/lib/mfg-products-queries';
import { sortByText, byText } from '../../vendor/scm/lib/sort-options';
import { useFabricTrackingsLite, fabricOptionLabel, type FabricLite } from '../../vendor/scm/lib/fabric-queries';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import { FreshMount } from '../../lib/freshMount';
import { useAuth } from '../../auth/AuthContext';
import { canViewProductCost } from '../../auth/salesAccess';
import { SpecialOrders } from '../../vendor/scm/components/SpecialOrders';
import { NumberInput } from '../../vendor/scm/components/NumberInput';
import { computeTotalHeight, isTotalHeightCategory, isTotalHeightPart } from '../../vendor/shared/total-height';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type AdjustmentType = 'increase' | 'decrease';
const directionOf = (qty: number): AdjustmentType => (qty < 0 ? 'decrease' : 'increase');

let seq = 0;
const newKey = () => `adj-${Date.now()}-${seq++}`;

type LineDraft = {
  _key: string;
  itemCode: string;
  productName: string;
  qty: number;
  reasonCode: string;
  notes: string;
  itemGroup: string;
  variants: Record<string, unknown>;
  batchNo: string;
  variantKey: string;
  pickedKey: string;
  origQty: number;
  origBucketKey: string;
  storedKey: boolean;
  costRm: number | null;
};

export const blankLine = (): LineDraft => ({
  _key: newKey(),
  itemCode: '',
  productName: '',
  qty: 1,
  reasonCode: '',
  notes: '',
  itemGroup: '',
  variants: {},
  batchNo: '',
  variantKey: '',
  pickedKey: NO_BUCKET_PICKED,
  origQty: 0,
  origBucketKey: NO_BUCKET_PICKED,
  storedKey: false,
  costRm: null,
});

const lineFromDoc = (l: StockAdjustmentLine): LineDraft => {
  const key = bucketKey({ variant_key: l.variant_key, batch_no: l.batch_no });
  return {
    _key: newKey(),
    itemCode: l.item_code,
    productName: l.product_name ?? '',
    qty: l.qty,
    reasonCode: l.reason_code ?? '',
    notes: l.notes ?? '',
    itemGroup: l.item_group ?? '',
    variants: l.variants ?? {},
    batchNo: l.batch_no ?? '',
    variantKey: l.variant_key,
    pickedKey: l.qty < 0 ? key : NO_BUCKET_PICKED,
    origQty: l.qty,
    origBucketKey: key,
    storedKey: true,
    costRm: null,
  };
};

export const lineInput = (it: LineDraft): StockAdjustmentLineInput => {
  const hasVariantGroup = it.itemGroup === 'sofa' || it.itemGroup === 'bedframe';
  const isDecrease = directionOf(it.qty) === 'decrease';
  return {
    itemCode: it.itemCode.trim(),
    productName: it.productName.trim() || undefined,
    qty: it.qty,
    reasonCode: it.reasonCode,
    notes: it.notes.trim() || undefined,
    itemGroup: hasVariantGroup || it.storedKey ? it.itemGroup || undefined : undefined,
    variants: !isDecrease && (hasVariantGroup || it.storedKey) ? it.variants : undefined,
    batchNo: it.batchNo.trim() || undefined,
    variantKey: isDecrease ? (it.variantKey || undefined) : (it.storedKey ? it.variantKey : undefined),
    unitCostSen: !isDecrease && it.costRm != null && it.costRm > 0 ? Math.round(it.costRm * 100) : undefined,
  };
};

type LineState = { willGoNegative: boolean; needsBucketPick: boolean };

const VariantSelect = ({
  label, options, value, onChange,
}: {
  label: string;
  options: Array<{ value: string; priceSen: number }>;
  value: string;
  onChange: (v: string) => void;
}) => (
  <label className={styles.field}>
    <span className={styles.fieldLabel}>{label}</span>
    <span className={styles.selectWrap}>
      <select className={styles.fieldSelect} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value=""></option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.value}</option>
        ))}
      </select>
      <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
    </span>
  </label>
);

/* Fabric / Colour — a dropdown of the fabric master, the same list and label
   the PO / GRN forms offer (owner 2026-10-06: it was free text, unlike SO).
   Stored as fabricCode, the key the variant bucket and the required-axis gate
   read, so a typo here used to open stock in a bucket no order could match.
   A stored code missing from the list still renders, so it never blanks. */
const FabricSelect = ({
  fabrics, value, onChange,
}: {
  fabrics: FabricLite[];
  value: string;
  onChange: (v: string) => void;
}) => {
  const options = fabrics
    .filter((f) => f.is_active !== false || f.fabric_code === value)
    .sort((a, b) => byText(fabricOptionLabel(a), fabricOptionLabel(b)));
  const known = !value || options.some((f) => f.fabric_code === value);
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>Fabric / Colour</span>
      <span className={styles.selectWrap}>
        <select className={styles.fieldSelect} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select…</option>
          {!known && <option value={value}>{value}</option>}
          {options.map((f) => (
            <option key={f.id} value={f.fabric_code}>{fabricOptionLabel(f)}</option>
          ))}
        </select>
        <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
      </span>
    </label>
  );
};

function AdjustmentLineRow({
  line, warehouseId, allSkus, maint, fabrics, specialsPools, setLine, removeLine, canRemove, reportState, canEnterCost,
}: {
  line: LineDraft;
  warehouseId: string;
  allSkus: Array<{ id: string | number; code: string; name: string; category?: string }>;
  maint: MaintenanceConfig | null;
  fabrics: FabricLite[];
  specialsPools: { bedframe: SpecialAddonRow[]; sofa: SpecialAddonRow[] };
  setLine: (key: string, patch: Partial<LineDraft>) => void;
  removeLine: (key: string) => void;
  canRemove: boolean;
  reportState: (key: string, state: LineState) => void;
  canEnterCost: boolean;
}) {
  const type = directionOf(line.qty);
  const magnitude = Math.abs(line.qty);

  const bucketsQ = useInventoryBuckets(line.itemCode || null, warehouseId || null);
  const credit = line.origQty < 0 ? -line.origQty : 0;
  const buckets = useMemo(() => {
    const open = (bucketsQ.data ?? []).map((b) => (
      credit && bucketKey(b) === line.origBucketKey ? { ...b, qty: b.qty + credit } : b
    ));
    if (credit && !open.some((b) => bucketKey(b) === line.origBucketKey)) {
      const [variant_key, batch_no] = JSON.parse(line.origBucketKey) as [string, string | null];
      open.push({ warehouse_id: warehouseId, variant_key, batch_no, product_name: line.productName || null, qty: credit });
    }
    return open;
  }, [bucketsQ.data, credit, line.origBucketKey, line.productName, warehouseId]);
  const breakdown  = useInventoryProductBreakdown(line.itemCode || null);

  const currentBalance: number | null = useMemo(() => {
    if (!warehouseId || !line.itemCode) return null;
    const balances = breakdown.data?.balances ?? [];
    const row = balances.find((b) =>
      b.warehouse_id === warehouseId && b.item_code === line.itemCode,
    );
    if (!row) return breakdown.isLoading ? null : 0;
    return row.qty ?? 0;
  }, [warehouseId, line.itemCode, breakdown.data, breakdown.isLoading]);

  const resultingBalance: number | null = currentBalance == null ? null : currentBalance + line.qty - line.origQty;
  const willGoNegative = resultingBalance != null && resultingBalance < 0;
  const needsBucketPick = type === 'decrease' && buckets.length > 0 && line.pickedKey === NO_BUCKET_PICKED;

  useEffect(() => {
    reportState(line._key, { willGoNegative, needsBucketPick });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reportState is a stable parent callback (useCallback); including it would re-fire every render for no behavioural change.
  }, [line._key, willGoNegative, needsBucketPick]);

  const onPickSku = (code: string) => {
    const sku = allSkus.find((p) => p.code === code);
    setLine(line._key, {
      itemCode: code,
      productName: sku?.name ?? '',
      itemGroup: sku?.category ? sku.category.toLowerCase() : '',
      variants: {},
      batchNo: '',
      variantKey: '',
      pickedKey: NO_BUCKET_PICKED,
      origQty: 0,
      origBucketKey: NO_BUCKET_PICKED,
      storedKey: false,
    });
  };

  const setVariant = (key: string, value: string) =>
    setLine(line._key, {
      storedKey: false,
      variants: (() => {
        const next: Record<string, unknown> = { ...line.variants, [key]: value };
        if (isTotalHeightCategory(line.itemGroup) && isTotalHeightPart(key)) {
          next.totalHeight = computeTotalHeight(line.itemGroup, next);
        }
        return next;
      })(),
    });

  const hasVariantGroup = line.itemGroup === 'sofa' || line.itemGroup === 'bedframe';
  const onPickBucket = (key: string) => {
    const b = buckets.find((x) => bucketKey(x) === key);
    if (!b) { setLine(line._key, { pickedKey: key, variantKey: '', batchNo: '' }); return; }
    setLine(line._key, {
      pickedKey: key,
      variantKey: b.variant_key,
      batchNo: b.batch_no ?? '',
      qty: -Math.min(magnitude || 1, b.qty),
    });
  };

  const bucketQtyCap = useMemo(() => {
    if (type !== 'decrease' || line.pickedKey === NO_BUCKET_PICKED) return null;
    const b = buckets.find((x) => bucketKey(x) === line.pickedKey);
    return b ? b.qty : null;
  }, [type, line.pickedKey, buckets]);

  const showDetail = Boolean(warehouseId && line.itemCode);

  return (
    <>
      <tr>
        <td>
          <input
            type="text"
            list={`stock-adjustment-skus-${line._key}`}
            value={line.itemCode}
            onChange={(e) => onPickSku(e.target.value)}
            placeholder="Type or pick a SKU code…"
            className={styles.fieldInput}
            style={{ fontFamily: 'var(--font-mono)' }}
          />
          <datalist id={`stock-adjustment-skus-${line._key}`}>
            {sortByText(allSkus).map((p) => (
              <option key={p.id} value={p.code}>{p.name} · {mfgCategoryLabel(p.category)}</option>
            ))}
          </datalist>
        </td>

        <td>
          <input
            type="text"
            value={line.productName}
            onChange={(e) => setLine(line._key, { productName: e.target.value })}
            placeholder="(auto-filled — editable)"
            className={styles.fieldInput}
            style={{ background: 'var(--c-cream)', color: 'var(--c-ink)' }}
          />
        </td>

        <td className={styles.tableRight}>
          <NumberInput
            value={line.qty}
            sign="signed"
            decimal={false}
            onValueChange={(n) => {
              let q = n ?? 0;
              if (q < 0 && bucketQtyCap != null) q = Math.max(q, -bucketQtyCap);
              setLine(line._key, { qty: q });
            }}
            className={styles.fieldInput}
            aria-label={`Qty for ${line.itemCode || 'line'}`}
            title="Positive = increase (found / recount up); negative = decrease (write-off / damage / loss)"
            style={{
              textAlign: 'right',
              fontFamily: 'var(--font-mono)',
              color: line.qty < 0 ? 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' : 'var(--c-ink)',
            }}
          />
          {canEnterCost && line.qty > 0 && (
            <NumberInput
              value={line.costRm}
              sign="unsigned"
              decimal
              onValueChange={(n) => setLine(line._key, { costRm: n })}
              className={styles.fieldInput}
              placeholder="Unit cost (RM)"
              aria-label={`Unit cost (RM) for ${line.itemCode || 'line'}`}
              title="Unit cost of the found stock, in RM. Blank = the cost this item already carries here."
              style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', marginTop: 4 }}
            />
          )}
        </td>

        <td>
          <select
            value={line.reasonCode}
            onChange={(e) => setLine(line._key, { reasonCode: e.target.value })}
            className={styles.fieldInput}
            aria-label={`Reason for ${line.itemCode || 'line'}`}
          >
            <option value="">— Pick a reason —</option>
            {sortByText(ADJUSTMENT_REASONS).map((r) => (
              <option key={r.code} value={r.code}>{r.label}</option>
            ))}
          </select>
        </td>

        <td>
          <input
            type="text"
            value={line.notes}
            onChange={(e) => setLine(line._key, { notes: e.target.value })}
            placeholder="(optional) — e.g. 'Lot #4, water damage'"
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

      {showDetail && (
        <tr>
          <td colSpan={6} style={{ background: 'var(--c-paper)', paddingTop: 0 }}>
            <div style={{
              background: 'var(--c-cream)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-2) var(--space-3)',
              fontSize: 'var(--fs-13)',
              color: 'var(--fg-muted)',
              display: 'flex',
              gap: 'var(--space-4)',
              flexWrap: 'wrap',
            }}>
              <span>
                Current balance:{' '}
                <strong style={{ color: 'var(--c-ink)', fontFamily: 'var(--font-mono)' }}>
                  {breakdown.isLoading ? '…' : (currentBalance ?? 0).toLocaleString('en-MY')} PCS
                </strong>
              </span>
              {resultingBalance != null && line.qty !== 0 && (
                <span>
                  Resulting balance:{' '}
                  <strong style={{
                    color: willGoNegative ? 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' : 'var(--c-ink)',
                    fontFamily: 'var(--font-mono)',
                  }}>
                    {(currentBalance ?? 0).toLocaleString('en-MY')}
                    {line.origQty !== 0 && <>{' '}{line.origQty > 0 ? '−' : '+'}{' '}{Math.abs(line.origQty).toLocaleString('en-MY')} saved</>}
                    {' '}{line.qty >= 0 ? '+' : '−'}{' '}{magnitude.toLocaleString('en-MY')}
                    {' = '}{resultingBalance.toLocaleString('en-MY')} PCS
                  </strong>
                </span>
              )}
            </div>

            {type === 'increase' && hasVariantGroup && maint && (
              <div style={{
                marginTop: 'var(--space-3)',
                background: 'var(--c-cream)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-md)',
                padding: 'var(--space-3)',
              }}>
                <div style={{
                  fontFamily: 'var(--font-button)', fontSize: 'var(--fs-11)', fontWeight: 700,
                  letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--fg-muted)',
                  marginBottom: 'var(--space-2)',
                }}>{line.itemGroup} Variants</div>
                {line.itemGroup === 'bedframe' ? (
                  <div className={styles.formGrid4}>
                    <VariantSelect label="Divan Height" options={activeOptions(maint.divanHeights, String(line.variants.divanHeight ?? ''))}
                      value={String(line.variants.divanHeight ?? '')}
                      onChange={(v) => setVariant('divanHeight', v)} />
                    <VariantSelect label="Gap"
                      options={maintPickerValues(maint.gaps, String(line.variants.gap ?? '')).map((g) => ({ value: g, priceSen: 0 }))}
                      value={String(line.variants.gap ?? '')}
                      onChange={(v) => setVariant('gap', v)} />
                    <VariantSelect label="Leg Height" options={activeOptions(maint.legHeights, String(line.variants.legHeight ?? ''))}
                      value={String(line.variants.legHeight ?? '')}
                      onChange={(v) => setVariant('legHeight', v)} />
                    <FabricSelect fabrics={fabrics}
                      value={String(line.variants.fabricCode ?? '')}
                      onChange={(v) => setVariant('fabricCode', v)} />
                  </div>
                ) : (
                  <div className={styles.formGrid4}>
                    <VariantSelect label="Seat Size"
                      options={maintPickerValues(maint.sofaSizes, String(line.variants.seatHeight ?? '')).map((s) => ({ value: s, priceSen: 0 }))}
                      value={String(line.variants.seatHeight ?? '')}
                      onChange={(v) => setVariant('seatHeight', v)} />
                    <VariantSelect label="Leg Height" options={activeOptions(maint.sofaLegHeights, String(line.variants.legHeight ?? ''))}
                      value={String(line.variants.legHeight ?? '')}
                      onChange={(v) => setVariant('legHeight', v)} />
                    <FabricSelect fabrics={fabrics}
                      value={String(line.variants.fabricCode ?? '')}
                      onChange={(v) => setVariant('fabricCode', v)} />
                  </div>
                )}
                {/* Special Orders — shared editor (owner 2026-07-20). A standalone
                    adjustment has no parent, so it is directly editable and writes
                    variants.specials (array). */}
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <SpecialOrders
                    options={line.itemGroup === 'bedframe' ? specialsPools.bedframe : specialsPools.sofa}
                    variants={line.variants}
                    onPatch={(patch) => setLine(line._key, { storedKey: false, variants: { ...line.variants, ...patch } })}
                    showPrices={false}
                  />
                </div>
                <label className={`${styles.field} ${styles.fieldFull}`} style={{ marginTop: 'var(--space-3)' }}>
                  <span className={styles.fieldLabel}>Batch Number{line.itemGroup === 'sofa' ? ' *' : ''}</span>
                  <input
                    type="text"
                    value={line.batchNo}
                    onChange={(e) => setLine(line._key, { batchNo: e.target.value })}
                    placeholder="Lot / batch label for this found stock"
                    className={styles.fieldInput}
                  />
                  {line.itemGroup === 'sofa' && (
                    <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                      Required — sofa stock can't be allocated to an order without a batch.
                    </span>
                  )}
                </label>
              </div>
            )}

            {type === 'decrease' && (
              <div style={{ marginTop: 'var(--space-3)', maxWidth: 480 }}>
                {bucketsQ.isLoading ? (
                  <span style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>Loading open stock…</span>
                ) : buckets.length === 0 ? (
                  <span style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>No open stock to take from.</span>
                ) : (
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Take from *</span>
                    <select
                      value={line.pickedKey}
                      onChange={(e) => onPickBucket(e.target.value)}
                      className={styles.fieldInput}
                      aria-label={`Take from for ${line.itemCode || 'line'}`}
                    >
                      <option value={NO_BUCKET_PICKED}>— Pick which batch / variant —</option>
                      {sortByText(buckets).map((b) => (
                        <option key={bucketKey(b)} value={bucketKey(b)}>
                          {(b.batch_no || 'No batch')} · {(b.variant_key || 'plain')} · {b.qty} PCS
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}

            {willGoNegative && (
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
                <span>
                  This will push the warehouse balance to <strong>{resultingBalance}</strong> (below zero).
                  You'll be asked to confirm on Save — proceed at your discretion.
                </span>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export const StockAdjustmentNew = () => (
  <FreshMount>{(startNew) => <StockAdjustmentForm onStartNew={startNew} existing={null} />}</FreshMount>
);

export const StockAdjustmentEdit = () => {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const docQ = useStockAdjustmentDoc(id || null);
  if (docQ.isLoading) return <SkeletonDetailPage />;
  if (!docQ.data) {
    return (
      <div className="space-y-4">
        <PageHeader back eyebrow="Inventory" title="Stock adjustment not found" />
        <Button variant="ghost" size="md" onClick={() => navigate('/scm/stock-adjustments')}>Back to stock adjustments</Button>
      </div>
    );
  }
  return <StockAdjustmentForm key={docQ.data.updated_at} onStartNew={() => navigate('/scm/stock-adjustments/new')} existing={docQ.data} />;
};

const StockAdjustmentForm = ({ onStartNew, existing }: { onStartNew: () => void; existing: StockAdjustmentDoc | null }) => {
  const navigate = useNavigate();
  const create = useStockAdjustment();
  const update = useUpdateStockAdjustment(existing?.id ?? '');
  const askConfirm = useConfirm();
  const notify = useNotify();
  const [saved, setSaved] = useState<{ id: string; adjustmentNo: string } | null>(null);
  const [resultOpen, setResultOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [warehouseId, setWarehouseId] = useState<string>(existing?.warehouse_id ?? '');
  const [notes, setNotes] = useState<string>(existing?.notes ?? '');
  const [lines, setLines] = useState<LineDraft[]>(() => (existing?.lines.length ? existing.lines.map(lineFromDoc) : [blankLine()]));

  const warehouses = useWarehouses();
  const allSkus    = useMfgProducts();
  const canEnterCost = canViewProductCost(useAuth().user);

  const maintQ = useMaintenanceConfig('master');
  const maint  = maintQ.data?.data ?? null;
  const fabricsQ = useFabricTrackingsLite();
  const fabrics  = useMemo(() => fabricsQ.data ?? [], [fabricsQ.data]);
  const specialAddonsQ = useSpecialAddons();
  const specialsPools = useMemo(() => {
    const rows = (specialAddonsQ.data ?? [])
      .filter((r) => r.active)
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.code ?? '').localeCompare(b.code ?? ''));
    // FULL rows feed the shared SpecialOrders block (owner 2026-07-20 unify).
    const pick = (cat: string) => rows.filter((r) => r.categories.includes(cat));
    return { bedframe: pick('BEDFRAME'), sofa: pick('SOFA') };
  }, [specialAddonsQ.data]);

  const setLine = useCallback((key: string, patch: Partial<LineDraft>) => {
    setLines((cur) => cur.map((it) => (it._key === key ? { ...it, ...patch } : it)));
  }, []);

  const addLine = () => setLines((cur) => [...cur, blankLine()]);
  useAddLineHotkey(addLine, !saved);

  const [lineStateByKey, setLineStateByKey] = useState<Partial<Record<string, LineState>>>({});
  const reportState = useCallback((key: string, state: LineState) => {
    setLineStateByKey((prev) => {
      const before = prev[key];
      if (before && before.willGoNegative === state.willGoNegative && before.needsBucketPick === state.needsBucketPick) return prev;
      return { ...prev, [key]: state };
    });
  }, []);

  const removeLine = (key: string) => {
    setLines((cur) => (cur.length <= 1 ? cur : cur.filter((it) => it._key !== key)));
    setLineStateByKey((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const validLines = lines.filter((it) => it.itemCode.trim() && Number.isFinite(it.qty) && it.qty !== 0 && it.reasonCode);
  const blockedLines = validLines.filter((it) => lineStateByKey[it._key]?.needsBucketPick);
  const anyNegative = validLines.some((it) => lineStateByKey[it._key]?.willGoNegative);

  const canSave = Boolean(warehouseId) && validLines.length > 0 && blockedLines.length === 0 && !submitting;

  const onSave = async () => {
    if (!warehouseId || validLines.length === 0) {
      void notify({ title: 'Pick a Warehouse and fill in at least one line (SKU, Qty, Reason) before saving.', tone: 'error' });
      return;
    }
    for (const it of validLines) {
      const hasVariantGroup = it.itemGroup === 'sofa' || it.itemGroup === 'bedframe';
      const unchanged = it.storedKey && it.qty === it.origQty;
      if (directionOf(it.qty) === 'increase' && hasVariantGroup && !unchanged) {
        const errs = adjustmentIncreaseErrors(it.itemGroup, it.variants, it.batchNo, it.itemCode);
        if (errs.length > 0) {
          void notify({ title: `"${it.itemCode}" can't be saved yet`, body: errs.join('\n'), tone: 'error' });
          return;
        }
      }
    }
    if (blockedLines.length > 0) {
      void notify({
        title: 'Pick which batch or variant the stock comes out of',
        body: blockedLines.map((it) => `"${it.itemCode}" has more than one open batch.`).join('\n'),
        tone: 'error',
      });
      return;
    }
    if (anyNegative) {
      const proceed = await askConfirm({
        title: 'This will push a balance below zero',
        body: 'Check the "Resulting balance" line above — any line shown in red will go below zero. That usually means stock arrived without a Goods Received Note, or the wrong warehouse is selected.',
        confirmLabel: 'Save anyway',
        danger: true,
      });
      if (!proceed) return;
    }

    setSubmitting(true);
    try {
      const body = { notes: notes.trim() || undefined, lines: validLines.map(lineInput) };
      if (existing) {
        await update.mutateAsync({ ...body, notes: notes.trim() || null });
        setSaved({ id: existing.id, adjustmentNo: existing.adjustment_no });
      } else {
        const r = await create.mutateAsync({ warehouseId, ...body });
        setSaved({ id: r.id, adjustmentNo: r.adjustmentNo });
      }
      setResultOpen(true);
    } catch (err) {
      void notify({
        title: existing ? `Couldn't save ${existing.adjustment_no}` : "Couldn't save this stock adjustment",
        body: `${err instanceof Error ? err.message : 'Something went wrong.'} No stock was moved and your entries are still on this screen — please try again.`,
        tone: 'error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const openSaved = () => (saved ? navigate(`/scm/stock-adjustments/${saved.id}`) : navigate('/scm/stock-adjustments'));
  const cancelTo = existing ? `/scm/stock-adjustments/${existing.id}` : '/scm/stock-adjustments';

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Inventory"
        title={existing ? `Edit ${existing.adjustment_no}` : 'New Stock Adjustment'}
        actions={
          saved ? (
            <div className={styles.actions}>
              <Button variant="ghost" size="md" onClick={onStartNew}>
                <Plus {...ICON} /> New stock adjustment
              </Button>
              <Button variant="primary" size="md" onClick={openSaved}>
                Open {saved.adjustmentNo}
              </Button>
            </div>
          ) : (
            <div className={styles.actions}>
              <Button variant="ghost" size="md" onClick={() => navigate(cancelTo)}>
                <X {...ICON} /> Cancel
              </Button>
              <Button variant="primary" size="md" onClick={onSave} disabled={!canSave || submitting}>
                <Save {...ICON} />
                {submitting ? 'Saving…' : existing ? 'Save Changes' : 'Save Adjustment'}
              </Button>
            </div>
          )
        }
      />

      <fieldset disabled={Boolean(saved)} className="space-y-4" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Warehouse</h2>
        </div>
        <div className={styles.cardBody}>
          <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
            <label className={styles.field} style={{ width: 320, maxWidth: '100%' }}>
              <span className={styles.fieldLabel}>Warehouse *</span>
              <select
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
                className={styles.fieldInput}
                disabled={Boolean(existing)}
                title={existing ? 'The warehouse of a saved adjustment cannot change' : undefined}
              >
                <option value="">— Pick a warehouse —</option>
                {sortByText(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>{w.code}</option>
                ))}
              </select>
            </label>
            <label className={styles.field} style={{ flex: 1, minWidth: 240 }}>
              <span className={styles.fieldLabel}>Notes</span>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="(optional) — what this adjustment is for"
                className={styles.fieldInput}
              />
            </label>
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items</h2>
          <AddLineButton variant="ghost" onClick={addLine} />
        </div>
        <div className={styles.cardBody}>
          <p style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>
            Qty is signed: a <strong style={{ color: 'var(--c-ink)' }}>positive</strong> number increases stock
            (found / recount up), a <strong style={{ color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' }}>negative</strong> number
            decreases it (write-off / damage / loss).
            {existing && ' Saving moves only the difference from what this adjustment already moved.'}
          </p>
          <table className={`${styles.table} ${styles.tableOwnWidths}`}>
            <thead>
              <tr>
                <th style={{ width: '20%' }}>SKU *</th>
                <th>Product Name</th>
                <th style={{ width: 110, textAlign: 'right' }}>Qty * (±)</th>
                <th style={{ width: 170 }}>Reason *</th>
                <th style={{ width: 220 }}>Note</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((ln) => (
                <AdjustmentLineRow
                  key={ln._key}
                  line={ln}
                  warehouseId={warehouseId}
                  allSkus={allSkus.data ?? []}
                  maint={maint}
                  fabrics={fabrics}
                  specialsPools={specialsPools}
                  setLine={setLine}
                  removeLine={removeLine}
                  canRemove={lines.length > 1}
                  reportState={reportState}
                  canEnterCost={canEnterCost}
                />
              ))}
            </tbody>
          </table>

          <div className={styles.addLineRow}>
            <AddLineButton variant="ghost" onClick={addLine} />
          </div>
        </div>
      </section>
      </fieldset>

      {saved && resultOpen && (
        <ActionResultDialog
          title={existing ? `${saved.adjustmentNo} updated` : `${saved.adjustmentNo} saved`}
          body="The stock balance is updated. Open the adjustment, or start the next one."
          primaryLabel={`Open ${saved.adjustmentNo}`}
          onPrimary={openSaved}
          secondaryLabel="New stock adjustment"
          onSecondary={onStartNew}
          onClose={() => setResultOpen(false)}
        />
      )}
    </div>
  );
};
