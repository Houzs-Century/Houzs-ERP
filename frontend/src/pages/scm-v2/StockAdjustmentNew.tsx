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
// Save posts each row through the SAME single-row POST /inventory/adjustments
// this form always used, one at a time — a failure stops the run and reports
// exactly how many rows before it already moved stock, so nothing is
// double-submitted or silently half-done.
//
// HOUZS VENDOR chrome: PageHeader back + Cancel/Save, header card, items card
// with the shared `styles.table`. Back/Cancel → the parallel
// /scm/stock-adjustments list. Save → a result dialog: open the list, or "New
// stock adjustment", which REMOUNTS the form (FreshMount) so nothing from the
// saved one carries over (staff request 2026-09-14).
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Save, X, Plus, AlertTriangle, ChevronDown, Trash2 } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { activeOptions, ADJUSTMENT_REASONS, adjustmentIncreaseErrors, maintPickerValues } from '@2990s/shared';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { bucketKey, NO_BUCKET_PICKED } from '../../vendor/scm/lib/stock-adjustment-buckets';
import {
  useStockAdjustment,
  useInventoryProductBreakdown,
  useInventoryBuckets,
} from '../../vendor/scm/lib/stock-queries';
import { useMfgProducts, useMaintenanceConfig, useSpecialAddons, type MaintenanceConfig, type SpecialAddonRow } from '../../vendor/scm/lib/mfg-products-queries';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { FreshMount } from '../../lib/freshMount';
import { SpecialOrders } from '../../vendor/scm/components/SpecialOrders';
import { computeTotalHeight, isTotalHeightCategory, isTotalHeightPart } from '../../vendor/shared/total-height';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

// The direction is derived from the sign of qty (see header). Kept as a tiny
// helper so the row and the Save loop read the same rule.
type AdjustmentType = 'increase' | 'decrease';
const directionOf = (qty: number): AdjustmentType => (qty < 0 ? 'decrease' : 'increase');

let seq = 0;
const newKey = () => `adj-${Date.now()}-${seq++}`;

type LineDraft = {
  _key: string;
  itemCode: string;
  productName: string;
  // SIGNED: positive = increase, negative = decrease, 0 = invalid.
  qty: number;
  reasonCode: string;
  notes: string;
  // Variant + batch (sofa / bedframe). itemGroup is the picked SKU's
  // category, lowercased. variants holds the chosen attribute values (same
  // keys the GRN / PO store). batchNo is a plain text lot label. On a
  // DECREASE the picker fills variantKey + batchNo from an existing stock
  // bucket instead of free entry.
  itemGroup: string;
  variants: Record<string, unknown>;
  batchNo: string;
  variantKey: string;
  // Which open bucket the DECREASE picker points at, as its stable key. Kept
  // apart from variantKey/batchNo because the no-variant, no-batch bucket has
  // both empty: without this, picking it read as picking nothing and that lot
  // could never be decreased. NO_BUCKET_PICKED ('') = nothing chosen.
  pickedKey: string;
};

const blankLine = (): LineDraft => ({
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
});

type LineState = { willGoNegative: boolean; needsBucketPick: boolean };

/* Per-category dropdown — a small local copy of the GRN/PO variant picker so a
   found sofa/bedframe carries the same attributes a real order line needs. */
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

// One adjustment line — the main <tr> holds the five requested columns; a
// full-width detail <tr> below it holds everything a correct stock write still
// needs (current/resulting balance, the sofa/bedframe variant editor on an
// INCREASE, the "Take from" lot picker on a DECREASE, the below-zero warning).
// Owns its OWN bucket + breakdown queries, the same reason TransferLineRow does:
// rules of hooks forbid a variable-length loop of hook calls, so each repeated
// row has to be its own component.
function AdjustmentLineRow({
  line, warehouseId, allSkus, maint, specialsPools, setLine, removeLine, canRemove, reportState,
}: {
  line: LineDraft;
  warehouseId: string;
  allSkus: Array<{ id: string | number; code: string; name: string; category?: string }>;
  maint: MaintenanceConfig | null;
  specialsPools: { bedframe: SpecialAddonRow[]; sofa: SpecialAddonRow[] };
  setLine: (key: string, patch: Partial<LineDraft>) => void;
  removeLine: (key: string) => void;
  canRemove: boolean;
  // The parent owns Save and needs to know, for EVERY line, whether it's
  // missing a required DECREASE bucket pick and whether it will go negative
  // — but only this row has the bucket/breakdown data either verdict depends
  // on, so it reports up instead of the parent re-deriving it.
  reportState: (key: string, state: LineState) => void;
}) {
  const type = directionOf(line.qty);
  const magnitude = Math.abs(line.qty);

  // Open stock buckets for the DECREASE "Take from" picker — only fires once
  // both warehouse + SKU are set (enabled guard inside the hook).
  const bucketsQ = useInventoryBuckets(line.itemCode || null, warehouseId || null);
  const buckets  = bucketsQ.data ?? [];
  // Drive the breakdown lookup off the picked code. The hook only fires when
  // itemCode is non-empty (enabled guard inside the hook).
  const breakdown  = useInventoryProductBreakdown(line.itemCode || null);

  // Current balance @ chosen warehouse. Pulls from showAll=true so even
  // zero-stock rows appear (commander needs to be able to adjust into
  // existence, e.g. recount up from 0).
  const currentBalance: number | null = useMemo(() => {
    if (!warehouseId || !line.itemCode) return null;
    const balances = breakdown.data?.balances ?? [];
    const row = balances.find((b) =>
      b.warehouse_id === warehouseId && b.item_code === line.itemCode,
    );
    if (!row) return breakdown.isLoading ? null : 0;
    return row.qty ?? 0;
  }, [warehouseId, line.itemCode, breakdown.data, breakdown.isLoading]);

  // qty is already signed, so the resulting balance is a straight add.
  const resultingBalance: number | null = currentBalance == null ? null : currentBalance + line.qty;
  const willGoNegative = resultingBalance != null && resultingBalance < 0;
  // DECREASE gate — when there are open lots, the operator must say which one
  // the stock comes out of (so the right variant/batch is reduced). Mirrors the
  // single-row Save-time check verbatim, just reported up.
  const needsBucketPick = type === 'decrease' && buckets.length > 0 && line.pickedKey === NO_BUCKET_PICKED;

  useEffect(() => {
    reportState(line._key, { willGoNegative, needsBucketPick });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reportState is a stable parent callback (useCallback); including it would re-fire every render for no behavioural change.
  }, [line._key, willGoNegative, needsBucketPick]);

  // SKU picker — when commander types/picks a code that matches an mfg
  // product, auto-fill product_name (kept editable for catalog-less SKUs).
  const onPickSku = (code: string) => {
    const sku = allSkus.find((p) => p.code === code);
    setLine(line._key, {
      itemCode: code,
      productName: sku?.name ?? '',
      // Category drives the variant editor below (only sofa / bedframe have one).
      itemGroup: sku?.category ? sku.category.toLowerCase() : '',
      // Fresh SKU → clear any variant / batch / bucket carried from the last pick.
      variants: {},
      batchNo: '',
      variantKey: '',
      pickedKey: NO_BUCKET_PICKED,
    });
  };

  // Set one variant value; auto-compute bedframe Total Height = Divan + Leg + Gap.
  const setVariant = (key: string, value: string) =>
    setLine(line._key, {
      variants: (() => {
        const next: Record<string, unknown> = { ...line.variants, [key]: value };
        if (isTotalHeightCategory(line.itemGroup) && isTotalHeightPart(key)) {
          next.totalHeight = computeTotalHeight(line.itemGroup, next);
        }
        return next;
      })(),
    });

  // DECREASE — operator picks which existing lot to take from. Stores the exact
  // bucket's variant_key + batch_no and caps the magnitude to that bucket.
  const hasVariantGroup = line.itemGroup === 'sofa' || line.itemGroup === 'bedframe';
  const onPickBucket = (key: string) => {
    const b = buckets.find((x) => bucketKey(x) === key);
    if (!b) { setLine(line._key, { pickedKey: key, variantKey: '', batchNo: '' }); return; }
    setLine(line._key, {
      pickedKey: key,
      variantKey: b.variant_key,
      batchNo: b.batch_no ?? '',
      // Cap the magnitude down so a decrease can't exceed the chosen lot; keep
      // it negative (a decrease).
      qty: -Math.min(magnitude || 1, b.qty),
    });
  };

  // Magnitude ceiling for a DECREASE — the picked lot's quantity (null = uncapped).
  const bucketQtyCap = useMemo(() => {
    if (type !== 'decrease' || line.pickedKey === NO_BUCKET_PICKED) return null;
    const b = buckets.find((x) => bucketKey(x) === line.pickedKey);
    return b ? b.qty : null;
  }, [type, line.pickedKey, buckets]);

  const showDetail = Boolean(warehouseId && line.itemCode);

  return (
    <>
      <tr>
        {/* SKU */}
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
              <option key={p.id} value={p.code}>{p.name} · {p.category}</option>
            ))}
          </datalist>
        </td>

        {/* Product Name — auto-filled, editable for free-text adjustments */}
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

        {/* Qty — SIGNED. + increases, − decreases. On a DECREASE capped to the picked lot. */}
        <td className={styles.tableRight}>
          <input
            type="number"
            step={1}
            min={bucketQtyCap != null ? -bucketQtyCap : undefined}
            value={line.qty}
            onChange={(e) => {
              let n = Math.trunc(Number(e.target.value) || 0);
              // Keep a picked-lot decrease from exceeding the lot.
              if (n < 0 && bucketQtyCap != null) n = Math.max(n, -bucketQtyCap);
              setLine(line._key, { qty: n });
            }}
            className={styles.fieldInput}
            aria-label={`Qty for ${line.itemCode || 'line'}`}
            title="Positive = increase (found / recount up); negative = decrease (write-off / damage / loss)"
            style={{
              textAlign: 'right',
              fontFamily: 'var(--font-mono)',
              color: line.qty < 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--c-ink)',
            }}
          />
        </td>

        {/* Reason — structured, required for audit trail */}
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

        {/* Note — optional free-text detail */}
        <td>
          <input
            type="text"
            value={line.notes}
            onChange={(e) => setLine(line._key, { notes: e.target.value })}
            placeholder="(optional) — e.g. 'Lot #4, water damage'"
            className={styles.fieldInput}
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

      {/* Detail row — appears once warehouse + SKU are set. Holds the balance
          hint and, depending on the sign, the INCREASE variant editor or the
          DECREASE lot picker, plus the below-zero warning. */}
      {showDetail && (
        <tr>
          <td colSpan={6} style={{ background: 'var(--c-paper)', paddingTop: 0 }}>
            {/* Current / resulting balance */}
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
                    color: willGoNegative ? 'var(--c-festive-b, #B8331F)' : 'var(--c-ink)',
                    fontFamily: 'var(--font-mono)',
                  }}>
                    {(currentBalance ?? 0).toLocaleString('en-MY')}
                    {' '}{line.qty >= 0 ? '+' : '−'}{' '}{magnitude.toLocaleString('en-MY')}
                    {' = '}{resultingBalance.toLocaleString('en-MY')} PCS
                  </strong>
                </span>
              )}
            </div>

            {/* INCREASE — variant editor + batch number for sofa / bedframe. The
                found stock must carry the same attributes a real order line
                needs, so it can be matched and allocated later. */}
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
                    {/* Fabric / Colour — stored as fabricCode (the key the variant
                        bucket + the required-axis gate read). Free text. */}
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Fabric / Colour</span>
                      <input className={styles.fieldInput}
                        value={String(line.variants.fabricCode ?? '')}
                        onChange={(e) => setVariant('fabricCode', e.target.value)} />
                    </label>
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
                    {/* Fabric — stored as fabricCode (the key the variant bucket +
                        the required-axis gate read). Free text. */}
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Fabric / Colour</span>
                      <input className={styles.fieldInput}
                        value={String(line.variants.fabricCode ?? '')}
                        onChange={(e) => setVariant('fabricCode', e.target.value)} />
                    </label>
                  </div>
                )}
                {/* Special Orders — shared editor (owner 2026-07-20). A standalone
                    adjustment has no parent, so it is directly editable and writes
                    variants.specials (array). */}
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <SpecialOrders
                    options={line.itemGroup === 'bedframe' ? specialsPools.bedframe : specialsPools.sofa}
                    variants={line.variants}
                    onPatch={(patch) => setLine(line._key, { variants: { ...line.variants, ...patch } })}
                    showPrices={false}
                  />
                </div>
                {/* Batch Number — required for sofa (so the stock can be allocated
                    to an order later); optional for bedframe. */}
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

            {/* DECREASE — "Take from" picker. Pick which existing lot the stock
                comes out of (so the right variant/batch is reduced), instead of
                free variant entry. */}
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

            {/* Negative balance warning — non-blocking, commander can still save */}
            {willGoNegative && (
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
  <FreshMount>{(startNew) => <StockAdjustmentForm onStartNew={startNew} />}</FreshMount>
);

/* One mount = one batch of adjustments. Once it saves the form LOCKS (no Save
   button), and another batch is a remount via onStartNew — the same shape as
   StockTransferNew, which needs it for its idempotency key. */
const StockAdjustmentForm = ({ onStartNew }: { onStartNew: () => void }) => {
  const navigate = useNavigate();
  const adjust   = useStockAdjustment();
  /* Off native browser dialogs onto the house dialog system — this screen
     writes stock, so its warnings must look like the rest of the ERP rather
     than like OS chrome the operator has learned to dismiss. */
  const askConfirm = useConfirm();
  const notify = useNotify();
  const [saved, setSaved] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  // Own submit-in-progress flag — adjust.isPending flickers between each
  // sequential mutateAsync call in the Save loop, which would let a
  // double-click slip a second run in between two rows.
  const [submitting, setSubmitting] = useState(false);

  // ── Form state ─────────────────────────────────────────────────────
  const [warehouseId, setWarehouseId] = useState<string>('');
  const [lines, setLines] = useState<LineDraft[]>([blankLine()]);

  // ── Data ───────────────────────────────────────────────────────────
  const warehouses = useWarehouses();
  const allSkus    = useMfgProducts();

  // Dropdown pools for the sofa / bedframe variant editor — same sources the
  // GRN / PO forms use (divan/leg height, gap, seat size; specials by category).
  const maintQ = useMaintenanceConfig('master');
  const maint  = maintQ.data?.data ?? null;
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

  // Partial, not Record: a line that hasn't reported yet (just added, or its
  // effect hasn't fired) genuinely has no entry.
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

  // A line is valid with a SKU, a non-zero (signed) qty, and a reason.
  const validLines = lines.filter((it) => it.itemCode.trim() && Number.isFinite(it.qty) && it.qty !== 0 && it.reasonCode);
  const blockedLines = validLines.filter((it) => lineStateByKey[it._key]?.needsBucketPick);
  const anyNegative = validLines.some((it) => lineStateByKey[it._key]?.willGoNegative);

  const canSave = Boolean(warehouseId) && validLines.length > 0 && blockedLines.length === 0 && !submitting;

  const onSave = async () => {
    if (!warehouseId || validLines.length === 0) {
      void notify({ title: 'Pick a Warehouse and fill in at least one line (SKU, Qty, Reason) before saving.', tone: 'error' });
      return;
    }
    // INCREASE gate — sofa / bedframe must carry their variant attributes (and
    // sofa a batch number) before the found stock can be saved. Same check the
    // backend runs, walked across every line before anything is sent.
    for (const it of validLines) {
      const hasVariantGroup = it.itemGroup === 'sofa' || it.itemGroup === 'bedframe';
      if (directionOf(it.qty) === 'increase' && hasVariantGroup) {
        const errs = adjustmentIncreaseErrors(it.itemGroup, it.variants, it.batchNo, it.itemCode);
        if (errs.length > 0) {
          void notify({ title: `"${it.itemCode}" can't be saved yet`, body: errs.join('\n'), tone: 'error' });
          return;
        }
      }
    }
    // DECREASE gate — when a line has open lots, the operator must say which
    // one the stock comes out of. Each row reports this itself (only it has the
    // bucket data the check needs).
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
    let succeeded = 0;
    for (const it of validLines) {
      const hasVariantGroup = it.itemGroup === 'sofa' || it.itemGroup === 'bedframe';
      const isDecrease = directionOf(it.qty) === 'decrease';
      const trimmedBatch = it.batchNo.trim();
      try {
        // eslint-disable-next-line no-await-in-loop -- deliberately sequential: each POST is its own audited stock_adjustments row, and a failure must stop the run exactly where it happened (see header comment) rather than fire the rest concurrently.
        await adjust.mutateAsync({
          warehouseId,
          itemCode: it.itemCode.trim(),
          productName: it.productName.trim() || undefined,
          // SIGNED delta — the sign IS the direction (see header). The POST
          // takes qtyDelta signed and has since this form was written.
          qtyDelta: it.qty,
          reasonCode: it.reasonCode,
          notes: it.notes.trim() || undefined,
          // Variant + batch. On INCREASE the backend computes variant_key from
          // `variants`; on DECREASE the picker supplies the exact bucket.
          itemGroup: hasVariantGroup ? it.itemGroup : undefined,
          variants:  !isDecrease && hasVariantGroup ? it.variants : undefined,
          batchNo:   trimmedBatch || undefined,
          variantKey: isDecrease ? (it.variantKey || undefined) : undefined,
        });
        succeeded += 1;
      } catch (err) {
        setSubmitting(false);
        /* authedFetch already ran the response through humanApiError, so this
           arrives as a plain sentence. What the operator needs added is that
           anything already saved moved real stock, so re-running the whole
           batch would double it. */
        void notify({
          title: succeeded > 0 ? `Saved ${succeeded} of ${validLines.length} lines — stopped at "${it.itemCode}"` : "Couldn't save this stock adjustment",
          body: `${err instanceof Error ? err.message : 'Something went wrong.'}${succeeded > 0 ? ` The ${succeeded} line(s) before this one already moved stock; this line and the rest were not saved. Remove the completed lines and retry the rest.` : ' No stock was moved and your entries are still on this screen — please try again.'}`,
          tone: 'error',
        });
        return;
      }
    }
    setSubmitting(false);
    setSavedCount(succeeded);
    setSaved(true);
    setResultOpen(true);
  };

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Inventory"
        title="New Stock Adjustment"
        actions={
          saved ? (
            <div className={styles.actions}>
              <Button variant="ghost" size="md" onClick={onStartNew}>
                <Plus {...ICON} /> New stock adjustment
              </Button>
              <Button variant="primary" size="md" onClick={() => navigate('/scm/stock-adjustments')}>
                Open stock adjustments
              </Button>
            </div>
          ) : (
            <div className={styles.actions}>
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/stock-adjustments')}>
                <X {...ICON} /> Cancel
              </Button>
              <Button variant="primary" size="md" onClick={onSave} disabled={!canSave || submitting}>
                <Save {...ICON} />
                {submitting ? 'Saving…' : `Save Adjustment${validLines.length > 1 ? `s (${validLines.length})` : ''}`}
              </Button>
            </div>
          )
        }
      />

      {/* Saved: readable, not editable — there is no Save left to press. */}
      <fieldset disabled={saved} className="space-y-4" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Warehouse</h2>
        </div>
        <div className={styles.cardBody}>
          <label className={styles.field} style={{ maxWidth: 320 }}>
            <span className={styles.fieldLabel}>Warehouse *</span>
            <select
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              className={styles.fieldInput}
            >
              <option value="">— Pick a warehouse —</option>
              {sortByText(warehouses.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>{w.code}</option>
              ))}
            </select>
          </label>
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
          <p style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>
            Qty is signed: a <strong style={{ color: 'var(--c-ink)' }}>positive</strong> number increases stock
            (found / recount up), a <strong style={{ color: 'var(--c-festive-b, #B8331F)' }}>negative</strong> number
            decreases it (write-off / damage / loss).
          </p>
          <table className={styles.table}>
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
                  specialsPools={specialsPools}
                  setLine={setLine}
                  removeLine={removeLine}
                  canRemove={lines.length > 1}
                  reportState={reportState}
                />
              ))}
            </tbody>
          </table>

          <div className={styles.addLineRow}>
            <Button variant="ghost" size="sm" onClick={addLine}>
              <Plus size={14} strokeWidth={1.75} /> Add Line Item
            </Button>
          </div>
        </div>
      </section>
      </fieldset>

      {saved && resultOpen && (
        <ActionResultDialog
          title={`${savedCount} stock ${savedCount === 1 ? 'adjustment' : 'adjustments'} saved`}
          body="The stock balance is updated. Open the adjustments list, or start the next one."
          primaryLabel="Open stock adjustments"
          onPrimary={() => navigate('/scm/stock-adjustments')}
          secondaryLabel="New stock adjustment"
          onSecondary={onStartNew}
          onClose={() => setResultOpen(false)}
        />
      )}
    </div>
  );
};
