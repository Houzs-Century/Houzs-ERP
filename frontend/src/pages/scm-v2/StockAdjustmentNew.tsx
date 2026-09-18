// ----------------------------------------------------------------------------
// StockAdjustmentNew — manual stock correction form at /inventory/adjustments/new.
//
// Follows PurchaseOrderNew's full-page pattern: back link + title + Cancel/Save
// in the headerRow, header card with formGrid2 fields, soft hint rows for
// current/resulting balance, POST via useStockAdjustment.
//
// Multi-item (owner 2026-09-18): "+ Add Item" repeats the SAME item card —
// SKU, Adjustment Type, variant/batch/take-from detail, Qty, Reason, Notes —
// below the one before it. Warehouse stays ONE shared field above the cards
// (every item in a batch still adjusts the same location). Save posts each
// item through the SAME single-item POST /inventory/adjustments this form
// always used, one at a time — a failure stops the run and reports exactly
// how many items before it already moved stock, so nothing is
// double-submitted or silently half-done.
//
// +/- UX decision: the qty input is always a positive integer; the sign comes
// from a segmented "Adjustment Type" control (Increase / Decrease). Commander
// types absolute values + picks intent — eliminates negative-typed mistakes
// and surfaces the audit reason (write-off vs found stock) up front.
//
// HOUZS VENDOR — verbatim from apps/backend/src/pages/StockAdjustmentNew.tsx.
// Import boundary only: react-router → react-router-dom; useWarehouses ←
// vendored inventory-queries slice; adjustment/breakdown/buckets hooks ←
// vendored stock-queries; mfg-products-queries + shared via aliases; css
// colocated. Back/Cancel → the parallel /scm/stock-adjustments list. Save → a
// result dialog: open the list, or "New stock adjustment", which REMOUNTS the
// form (FreshMount) so nothing from the saved one carries over (staff request
// 2026-09-14).
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Save, X, Minus, Plus, AlertTriangle, ChevronDown, Trash2 } from 'lucide-react';
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

type AdjustmentType = 'increase' | 'decrease';

let seq = 0;
const newKey = () => `adj-${Date.now()}-${seq++}`;

type ItemDraft = {
  _key: string;
  itemCode: string;
  productName: string;
  type: AdjustmentType;
  qty: number;
  reasonCode: string;
  notes: string;
  // Variant + batch (sofa / bedframe). itemGroup is the picked SKU's
  // category, lowercased. variants holds the chosen attribute values (same
  // keys the GRN / PO store). batchNo is a plain text lot label. On
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

const blankItem = (): ItemDraft => ({
  _key: newKey(),
  itemCode: '',
  productName: '',
  type: 'decrease',
  qty: 1,
  reasonCode: '',
  notes: '',
  itemGroup: '',
  variants: {},
  batchNo: '',
  variantKey: '',
  pickedKey: NO_BUCKET_PICKED,
});

type ItemState = { willGoNegative: boolean; needsBucketPick: boolean };

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

// One item card — verbatim the original single-item form's fields (SKU,
// Adjustment Type, variant/batch/take-from detail, Qty, Reason, Notes),
// just parameterised over `item` instead of top-level state. Owns its OWN
// bucket + breakdown queries, same reason TransferLineRow does on Stock
// Transfer: rules of hooks forbid a variable-length loop of hook calls, so
// each repeated card has to be its own component.
function AdjustmentItemCard({
  item, index, warehouseId, allSkus, maint, specialsPools, setItem, removeItem, canRemove, reportState,
}: {
  item: ItemDraft;
  index: number;
  warehouseId: string;
  allSkus: Array<{ id: string | number; code: string; name: string; category?: string }>;
  maint: MaintenanceConfig | null;
  specialsPools: { bedframe: SpecialAddonRow[]; sofa: SpecialAddonRow[] };
  setItem: (key: string, patch: Partial<ItemDraft>) => void;
  removeItem: (key: string) => void;
  canRemove: boolean;
  // The parent owns Save and needs to know, for EVERY item, whether it's
  // missing a required DECREASE bucket pick and whether it will go negative
  // — but only this card has the bucket/breakdown data either verdict
  // depends on, so it reports up instead of the parent re-deriving it.
  reportState: (key: string, state: ItemState) => void;
}) {
  // Open stock buckets for the DECREASE "Take from" picker — only fires once
  // both warehouse + SKU are set (enabled guard inside the hook).
  const bucketsQ = useInventoryBuckets(item.itemCode || null, warehouseId || null);
  const buckets  = bucketsQ.data ?? [];
  // Drive the breakdown lookup off the picked code. The hook only fires
  // when itemCode is non-empty (enabled guard inside the hook).
  const breakdown  = useInventoryProductBreakdown(item.itemCode || null);

  // Current balance @ chosen warehouse. Pulls from showAll=true so even
  // zero-stock rows appear (commander needs to be able to adjust into
  // existence, e.g. recount up from 0).
  const currentBalance: number | null = useMemo(() => {
    if (!warehouseId || !item.itemCode) return null;
    const balances = breakdown.data?.balances ?? [];
    const row = balances.find((b) =>
      b.warehouse_id === warehouseId && b.item_code === item.itemCode,
    );
    if (!row) return breakdown.isLoading ? null : 0;
    return row.qty ?? 0;
  }, [warehouseId, item.itemCode, breakdown.data, breakdown.isLoading]);

  const qtyDelta = item.type === 'increase' ? item.qty : -item.qty;
  const resultingBalance: number | null = currentBalance == null ? null : currentBalance + qtyDelta;
  const willGoNegative = resultingBalance != null && resultingBalance < 0;
  // DECREASE gate — when there are open lots, the operator must say which one
  // the stock comes out of (so the right variant/batch is reduced). Mirrors
  // the ORIGINAL single-item Save-time check verbatim, just reported up
  // instead of read from local state at Save time.
  const needsBucketPick = item.type === 'decrease' && buckets.length > 0 && item.pickedKey === NO_BUCKET_PICKED;

  useEffect(() => {
    reportState(item._key, { willGoNegative, needsBucketPick });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reportState is a stable parent callback (useCallback); including it would re-fire every render for no behavioural change.
  }, [item._key, willGoNegative, needsBucketPick]);

  // SKU picker — when commander types/picks a code that matches an mfg
  // product, auto-fill product_name (kept editable for catalog-less SKUs).
  const onPickSku = (code: string) => {
    const sku = allSkus.find((p) => p.code === code);
    setItem(item._key, {
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
    setItem(item._key, {
      variants: (() => {
        const next: Record<string, unknown> = { ...item.variants, [key]: value };
        if (isTotalHeightCategory(item.itemGroup) && isTotalHeightPart(key)) {
          next.totalHeight = computeTotalHeight(item.itemGroup, next);
        }
        return next;
      })(),
    });

  // DECREASE — operator picks which existing lot to take from. Stores the exact
  // bucket's variant_key + batch_no and caps the qty input to that bucket.
  const hasVariantGroup = item.itemGroup === 'sofa' || item.itemGroup === 'bedframe';
  const onPickBucket = (key: string) => {
    const b = buckets.find((x) => bucketKey(x) === key);
    if (!b) { setItem(item._key, { pickedKey: key, variantKey: '', batchNo: '' }); return; }
    setItem(item._key, {
      pickedKey: key,
      variantKey: b.variant_key,
      batchNo: b.batch_no ?? '',
      // Cap the qty down so a decrease can't exceed the chosen lot.
      qty: Math.min(item.qty, b.qty),
    });
  };

  // Qty ceiling for a DECREASE — the picked lot's quantity (null = uncapped).
  const bucketQtyCap = useMemo(() => {
    if (item.type !== 'decrease' || item.pickedKey === NO_BUCKET_PICKED) return null;
    const b = buckets.find((x) => bucketKey(x) === item.pickedKey);
    return b ? b.qty : null;
  }, [item.type, item.pickedKey, buckets]);

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>{index === 0 ? 'Adjustment' : `Item ${index + 1}`}</h2>
        {canRemove && (
          <button
            type="button"
            onClick={() => removeItem(item._key)}
            className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
            title="Remove this item"
          >
            <Trash2 size={14} strokeWidth={1.75} />
          </button>
        )}
      </div>
      <div className={styles.cardBody}>
        <div className={styles.formGrid2}>
          {/* SKU */}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>SKU *</span>
            <input
              type="text"
              list={`stock-adjustment-skus-${item._key}`}
              value={item.itemCode}
              onChange={(e) => onPickSku(e.target.value)}
              placeholder="Type or pick a SKU code…"
              className={styles.fieldInput}
              style={{ fontFamily: 'var(--font-mono)' }}
            />
            <datalist id={`stock-adjustment-skus-${item._key}`}>
              {sortByText(allSkus).map((p) => (
                <option key={p.id} value={p.code}>{p.name} · {p.category}</option>
              ))}
            </datalist>
          </label>

          {/* Product name — read-only, auto-filled */}
          <label className={`${styles.field} ${styles.fieldFull}`}>
            <span className={styles.fieldLabel}>Product Name</span>
            <input
              type="text"
              value={item.productName}
              onChange={(e) => setItem(item._key, { productName: e.target.value })}
              placeholder="(auto-filled when SKU picked — editable for free-text adjustments)"
              className={styles.fieldInput}
              style={{ background: 'var(--c-cream)', color: 'var(--c-ink)' }}
            />
          </label>
        </div>

        {/* Current balance hint — appears once both warehouse + SKU are set */}
        {warehouseId && item.itemCode && (
          <div style={{
            marginTop: 'var(--space-3)',
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
            {resultingBalance != null && (
              <span>
                Resulting balance:{' '}
                <strong style={{
                  color: willGoNegative ? 'var(--c-festive-b, #B8331F)' : 'var(--c-ink)',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {(currentBalance ?? 0).toLocaleString('en-MY')}
                  {' '}{item.type === 'increase' ? '+' : '−'}{' '}{item.qty.toLocaleString('en-MY')}
                  {' = '}{resultingBalance.toLocaleString('en-MY')} PCS
                </strong>
              </span>
            )}
          </div>
        )}

        {/* Adjustment type — segmented (+/−) */}
        <div style={{ marginTop: 'var(--space-4)' }}>
          <div className={styles.fieldLabel} style={{ marginBottom: 6 }}>Adjustment Type *</div>
          <div style={{ display: 'inline-flex', gap: 0, borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--line)' }}>
            <button
              type="button"
              onClick={() => setItem(item._key, { type: 'increase' })}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: 'var(--space-2) var(--space-4)',
                fontFamily: 'var(--font-button)', fontSize: 'var(--fs-13)', fontWeight: 600,
                background: item.type === 'increase' ? 'var(--c-secondary-a, #2F5D4F)' : 'var(--c-paper)',
                color:      item.type === 'increase' ? 'var(--c-cream)' : 'var(--c-ink)',
                border: 'none', cursor: 'pointer',
              }}
            >
              <Plus size={14} strokeWidth={2} /> Increase (found / recount up)
            </button>
            <button
              type="button"
              onClick={() => setItem(item._key, { type: 'decrease' })}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: 'var(--space-2) var(--space-4)',
                fontFamily: 'var(--font-button)', fontSize: 'var(--fs-13)', fontWeight: 600,
                background: item.type === 'decrease' ? 'var(--c-festive-b, #B8331F)' : 'var(--c-paper)',
                color:      item.type === 'decrease' ? 'var(--c-cream)' : 'var(--c-ink)',
                border: 'none', borderLeft: '1px solid var(--line)', cursor: 'pointer',
              }}
            >
              <Minus size={14} strokeWidth={2} /> Decrease (write-off / damage / loss)
            </button>
          </div>
        </div>

        {/* INCREASE — variant editor + batch number for sofa / bedframe. The
            found stock must carry the same attributes a real order line needs,
            so it can be matched and allocated later. */}
        {item.type === 'increase' && hasVariantGroup && maint && (
          <div style={{
            marginTop: 'var(--space-4)',
            background: 'var(--c-cream)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-3)',
          }}>
            <div style={{
              fontFamily: 'var(--font-button)', fontSize: 'var(--fs-11)', fontWeight: 700,
              letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--fg-muted)',
              marginBottom: 'var(--space-2)',
            }}>{item.itemGroup} Variants</div>
            {item.itemGroup === 'bedframe' ? (
              <div className={styles.formGrid4}>
                <VariantSelect label="Divan Height" options={activeOptions(maint.divanHeights, String(item.variants.divanHeight ?? ''))}
                  value={String(item.variants.divanHeight ?? '')}
                  onChange={(v) => setVariant('divanHeight', v)} />
                <VariantSelect label="Gap"
                  options={maintPickerValues(maint.gaps, String(item.variants.gap ?? '')).map((g) => ({ value: g, priceSen: 0 }))}
                  value={String(item.variants.gap ?? '')}
                  onChange={(v) => setVariant('gap', v)} />
                <VariantSelect label="Leg Height" options={activeOptions(maint.legHeights, String(item.variants.legHeight ?? ''))}
                  value={String(item.variants.legHeight ?? '')}
                  onChange={(v) => setVariant('legHeight', v)} />
                {/* Fabric / Colour — stored as fabricCode (the key the variant
                    bucket + the required-axis gate read). Free text. */}
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Fabric / Colour</span>
                  <input className={styles.fieldInput}
                    value={String(item.variants.fabricCode ?? '')}
                    onChange={(e) => setVariant('fabricCode', e.target.value)} />
                </label>
              </div>
            ) : (
              <div className={styles.formGrid4}>
                <VariantSelect label="Seat Size"
                  options={maintPickerValues(maint.sofaSizes, String(item.variants.seatHeight ?? '')).map((s) => ({ value: s, priceSen: 0 }))}
                  value={String(item.variants.seatHeight ?? '')}
                  onChange={(v) => setVariant('seatHeight', v)} />
                <VariantSelect label="Leg Height" options={activeOptions(maint.sofaLegHeights, String(item.variants.legHeight ?? ''))}
                  value={String(item.variants.legHeight ?? '')}
                  onChange={(v) => setVariant('legHeight', v)} />
                {/* Fabric — stored as fabricCode (the key the variant bucket +
                    the required-axis gate read). Free text. */}
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Fabric / Colour</span>
                  <input className={styles.fieldInput}
                    value={String(item.variants.fabricCode ?? '')}
                    onChange={(e) => setVariant('fabricCode', e.target.value)} />
                </label>
              </div>
            )}
            {/* Special Orders — shared editor (owner 2026-07-20). A standalone
                adjustment has no parent, so it is directly editable and writes
                variants.specials (array). */}
            <div style={{ marginTop: 'var(--space-3)' }}>
              <SpecialOrders
                options={item.itemGroup === 'bedframe' ? specialsPools.bedframe : specialsPools.sofa}
                variants={item.variants}
                onPatch={(patch) => setItem(item._key, { variants: { ...item.variants, ...patch } })}
                showPrices={false}
              />
            </div>
            {/* Batch Number — required for sofa (so the stock can be allocated
                to an order later); optional for bedframe. */}
            <label className={`${styles.field} ${styles.fieldFull}`} style={{ marginTop: 'var(--space-3)' }}>
              <span className={styles.fieldLabel}>Batch Number{item.itemGroup === 'sofa' ? ' *' : ''}</span>
              <input
                type="text"
                value={item.batchNo}
                onChange={(e) => setItem(item._key, { batchNo: e.target.value })}
                placeholder="Lot / batch label for this found stock"
                className={styles.fieldInput}
              />
              {item.itemGroup === 'sofa' && (
                <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                  Required — sofa stock can't be allocated to an order without a batch.
                </span>
              )}
            </label>
          </div>
        )}

        {/* DECREASE — "Take from" picker. Pick which existing lot the stock
            comes out of (so the right variant/batch is reduced), instead of
            free variant entry. Shows only when warehouse + SKU are set. */}
        {item.type === 'decrease' && warehouseId && item.itemCode && (
          <div style={{ marginTop: 'var(--space-4)' }}>
            {bucketsQ.isLoading ? (
              <span style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>Loading open stock…</span>
            ) : buckets.length === 0 ? (
              <span style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>No open stock to take from.</span>
            ) : (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Take from *</span>
                <select
                  value={item.pickedKey}
                  onChange={(e) => onPickBucket(e.target.value)}
                  className={styles.fieldInput}
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

        <div className={styles.formGrid2} style={{ marginTop: 'var(--space-4)' }}>
          {/* Qty — absolute value. On DECREASE, capped to the chosen lot. */}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Qty * (positive integer)</span>
            <input
              type="number"
              min={1}
              max={bucketQtyCap ?? undefined}
              step={1}
              value={item.qty}
              onChange={(e) => {
                let n = Math.max(0, Math.floor(Number(e.target.value) || 0));
                if (bucketQtyCap != null) n = Math.min(bucketQtyCap, n);
                setItem(item._key, { qty: n });
              }}
              className={styles.fieldInput}
              style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}
            />
          </label>

          {/* Reason — structured, required for audit trail */}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Reason *</span>
            <select
              value={item.reasonCode}
              onChange={(e) => setItem(item._key, { reasonCode: e.target.value })}
              className={styles.fieldInput}
            >
              <option value="">— Pick a reason —</option>
              {sortByText(ADJUSTMENT_REASONS).map((r) => (
                <option key={r.code} value={r.code}>{r.label}</option>
              ))}
            </select>
          </label>

          {/* Notes — optional free-text detail */}
          <label className={`${styles.field} ${styles.fieldFull}`}>
            <span className={styles.fieldLabel}>Notes (optional)</span>
            <textarea
              value={item.notes}
              onChange={(e) => setItem(item._key, { notes: e.target.value })}
              placeholder="Extra detail — e.g. 'Lot #4, water damage', 'Found 2 PCS during recount on 27/05'"
              className={styles.fieldInput}
              rows={3}
              style={{ minHeight: 52, resize: 'vertical' }}
            />
          </label>
        </div>

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
      </div>
    </section>
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
  // double-click slip a second run in between two items.
  const [submitting, setSubmitting] = useState(false);

  // ── Form state ─────────────────────────────────────────────────────
  const [warehouseId, setWarehouseId] = useState<string>('');
  const [items, setItems] = useState<ItemDraft[]>([blankItem()]);

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

  const setItem = useCallback((key: string, patch: Partial<ItemDraft>) => {
    setItems((cur) => cur.map((it) => (it._key === key ? { ...it, ...patch } : it)));
  }, []);

  const addItem = () => setItems((cur) => [...cur, blankItem()]);

  // Partial, not Record: an item that hasn't reported yet (just added, or its
  // effect hasn't fired) genuinely has no entry.
  const [itemStateByKey, setItemStateByKey] = useState<Partial<Record<string, ItemState>>>({});
  const reportState = useCallback((key: string, state: ItemState) => {
    setItemStateByKey((prev) => {
      const before = prev[key];
      if (before && before.willGoNegative === state.willGoNegative && before.needsBucketPick === state.needsBucketPick) return prev;
      return { ...prev, [key]: state };
    });
  }, []);

  const removeItem = (key: string) => {
    setItems((cur) => (cur.length <= 1 ? cur : cur.filter((it) => it._key !== key)));
    setItemStateByKey((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const validItems = items.filter((it) => it.itemCode.trim() && it.qty > 0 && it.reasonCode);
  const blockedItems = validItems.filter((it) => itemStateByKey[it._key]?.needsBucketPick);
  const anyNegative = validItems.some((it) => itemStateByKey[it._key]?.willGoNegative);

  const canSave = Boolean(warehouseId) && validItems.length > 0 && blockedItems.length === 0 && !submitting;

  const onSave = async () => {
    if (!warehouseId || validItems.length === 0) {
      void notify({ title: 'Pick a Warehouse and fill in at least one item (SKU, Qty, Reason) before saving.', tone: 'error' });
      return;
    }
    // INCREASE gate — sofa / bedframe must carry their variant attributes (and
    // sofa a batch number) before the found stock can be saved. Same check
    // the ORIGINAL single-item Save ran, just walked across every item
    // before anything is sent.
    for (const it of validItems) {
      const hasVariantGroup = it.itemGroup === 'sofa' || it.itemGroup === 'bedframe';
      if (it.type === 'increase' && hasVariantGroup) {
        const errs = adjustmentIncreaseErrors(it.itemGroup, it.variants, it.batchNo, it.itemCode);
        if (errs.length > 0) {
          void notify({ title: `"${it.itemCode}" can't be saved yet`, body: errs.join('\n'), tone: 'error' });
          return;
        }
      }
    }
    // DECREASE gate — when an item has open lots, the operator must say
    // which one the stock comes out of. Each card reports this itself (only
    // it has the bucket data the check needs).
    if (blockedItems.length > 0) {
      void notify({
        title: 'Pick which batch or variant the stock comes out of',
        body: blockedItems.map((it) => `"${it.itemCode}" has more than one open batch.`).join('\n'),
        tone: 'error',
      });
      return;
    }
    if (anyNegative) {
      const proceed = await askConfirm({
        title: 'This will push a balance below zero',
        body: 'Check the "Resulting balance" line above — any item shown in red will go below zero. That usually means stock arrived without a Goods Received Note, or the wrong warehouse is selected.',
        confirmLabel: 'Save anyway',
        danger: true,
      });
      if (!proceed) return;
    }

    setSubmitting(true);
    let succeeded = 0;
    for (const it of validItems) {
      const hasVariantGroup = it.itemGroup === 'sofa' || it.itemGroup === 'bedframe';
      const trimmedBatch = it.batchNo.trim();
      try {
        // eslint-disable-next-line no-await-in-loop -- deliberately sequential: each POST is its own audited stock_adjustments row, and a failure must stop the run exactly where it happened (see header comment) rather than fire the rest concurrently.
        await adjust.mutateAsync({
          warehouseId,
          itemCode: it.itemCode.trim(),
          productName: it.productName.trim() || undefined,
          qtyDelta: it.type === 'increase' ? it.qty : -it.qty,
          reasonCode: it.reasonCode,
          notes: it.notes.trim() || undefined,
          // Variant + batch. On INCREASE the backend computes variant_key from
          // `variants`; on DECREASE the picker supplies the exact bucket.
          itemGroup: hasVariantGroup ? it.itemGroup : undefined,
          variants:  it.type === 'increase' && hasVariantGroup ? it.variants : undefined,
          batchNo:   trimmedBatch || undefined,
          variantKey: it.type === 'decrease' ? (it.variantKey || undefined) : undefined,
        });
        succeeded += 1;
      } catch (err) {
        setSubmitting(false);
        /* authedFetch already ran the response through humanApiError, so this
           arrives as a plain sentence. What the operator needs added is that
           anything already saved moved real stock, so re-running the whole
           batch would double it. */
        void notify({
          title: succeeded > 0 ? `Saved ${succeeded} of ${validItems.length} items — stopped at "${it.itemCode}"` : "Couldn't save this stock adjustment",
          body: `${err instanceof Error ? err.message : 'Something went wrong.'}${succeeded > 0 ? ` The ${succeeded} item(s) before this one already moved stock; this item and the rest were not saved. Remove the completed items and retry the rest.` : ' No stock was moved and your entries are still on this screen — please try again.'}`,
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
                {submitting ? 'Saving…' : `Save Adjustment${validItems.length > 1 ? `s (${validItems.length})` : ''}`}
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

      {items.map((it, i) => (
        <AdjustmentItemCard
          key={it._key}
          item={it}
          index={i}
          warehouseId={warehouseId}
          allSkus={allSkus.data ?? []}
          maint={maint}
          specialsPools={specialsPools}
          setItem={setItem}
          removeItem={removeItem}
          canRemove={items.length > 1}
          reportState={reportState}
        />
      ))}

      <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
        <Button variant="ghost" size="sm" onClick={addItem}>
          <Plus size={14} strokeWidth={1.75} /> Add Item
        </Button>
      </div>
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
