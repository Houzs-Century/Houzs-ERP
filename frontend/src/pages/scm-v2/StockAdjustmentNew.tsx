// ----------------------------------------------------------------------------
// StockAdjustmentNew — manual stock correction form at /inventory/adjustments/new.
//
// Follows PurchaseOrderNew's full-page pattern: back link + title + Cancel/Save
// in the headerRow, header card with formGrid2 fields, soft hint rows for
// current/resulting balance, POST via useStockAdjustment.
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
// colocated. Back/Cancel/Save → the parallel /scm/stock-adjustments list.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Save, X, Minus, Plus, AlertTriangle, ChevronDown } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { activeOptions, ADJUSTMENT_REASONS, adjustmentIncreaseErrors, maintPickerValues } from '@2990s/shared';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import {
  useStockAdjustment,
  useInventoryProductBreakdown,
  useInventoryBuckets,
} from '../../vendor/scm/lib/stock-queries';
import { useMfgProducts, useMaintenanceConfig, useSpecialAddons } from '../../vendor/scm/lib/mfg-products-queries';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { SpecialOrders } from '../../vendor/scm/components/SpecialOrders';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type AdjustmentType = 'increase' | 'decrease';

/* Total Height is AUTO-COMPUTED for bedframe = Divan + Leg + Gap (mirrors the
   GRN / PO variant editor); it is never a manual pick. */
const parseInches = (s: unknown): number => {
  if (s == null) return 0;
  const m = String(s).match(/(-?\d+(?:\.\d+)?)/);
  return m && m[1] ? Number(m[1]) : 0;
};

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

export const StockAdjustmentNew = () => {
  const navigate = useNavigate();
  const adjust   = useStockAdjustment();
  /* Off native browser dialogs onto the house dialog system — this screen
     writes stock, so its warnings must look like the rest of the ERP rather
     than like OS chrome the operator has learned to dismiss. */
  const askConfirm = useConfirm();
  const notify = useNotify();

  // ── Form state ─────────────────────────────────────────────────────
  const [warehouseId, setWarehouseId] = useState<string>('');
  const [productCode, setProductCode] = useState<string>('');
  const [productName, setProductName] = useState<string>('');
  const [type, setType]               = useState<AdjustmentType>('decrease');
  const [qty, setQty]                 = useState<number>(1);
  const [reasonCode, setReasonCode]   = useState<string>('');
  const [notes, setNotes]             = useState<string>('');

  // ── Variant + batch (sofa / bedframe) ──────────────────────────────
  // itemGroup is the picked SKU's category, lowercased. variants holds the
  // chosen attribute values (same keys the GRN / PO store). batchNo is a plain
  // text lot label. On DECREASE the picker fills variantKey + batchNo from an
  // existing stock bucket instead of free entry.
  const [itemGroup, setItemGroup]   = useState<string>('');
  const [variants, setVariants]     = useState<Record<string, unknown>>({});
  const [batchNo, setBatchNo]       = useState<string>('');
  const [variantKey, setVariantKey] = useState<string>('');

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

  // Open stock buckets for the DECREASE "Take from" picker — only fires once
  // both warehouse + SKU are set (enabled guard inside the hook).
  const bucketsQ = useInventoryBuckets(productCode || null, warehouseId || null);
  const buckets  = bucketsQ.data ?? [];
  // Drive the breakdown lookup off the picked code. The hook only fires
  // when productCode is non-empty (enabled guard inside the hook).
  const breakdown  = useInventoryProductBreakdown(productCode || null);

  // Current balance @ chosen warehouse. Pulls from showAll=true so even
  // zero-stock rows appear (commander needs to be able to adjust into
  // existence, e.g. recount up from 0).
  const currentBalance: number | null = useMemo(() => {
    if (!warehouseId || !productCode) return null;
    const balances = breakdown.data?.balances ?? [];
    const row = balances.find((b) =>
      b.warehouse_id === warehouseId && b.product_code === productCode,
    );
    if (!row) return breakdown.isLoading ? null : 0;
    return row.qty ?? 0;
  }, [warehouseId, productCode, breakdown.data, breakdown.isLoading]);

  const qtyDelta = type === 'increase' ? qty : -qty;
  const resultingBalance: number | null = currentBalance == null ? null : currentBalance + qtyDelta;
  const willGoNegative = resultingBalance != null && resultingBalance < 0;

  const canSave = Boolean(
    warehouseId &&
    productCode.trim() &&
    qty > 0 &&
    reasonCode,
  );

  // SKU picker — when commander types/picks a code that matches an mfg
  // product, auto-fill product_name (kept editable for catalog-less SKUs).
  const onPickSku = (code: string) => {
    setProductCode(code);
    const sku = (allSkus.data ?? []).find((p) => p.code === code);
    if (sku) setProductName(sku.name);
    // Category drives the variant editor below (only sofa / bedframe have one).
    setItemGroup(sku?.category ? sku.category.toLowerCase() : '');
    // Fresh SKU → clear any variant / batch / bucket carried from the last pick.
    setVariants({});
    setBatchNo('');
    setVariantKey('');
  };

  // Set one variant value; auto-compute bedframe Total Height = Divan + Leg + Gap.
  const setVariant = (key: string, value: string) =>
    setVariants((prev) => {
      const next: Record<string, unknown> = { ...prev, [key]: value };
      if (itemGroup === 'bedframe' && (key === 'divanHeight' || key === 'legHeight' || key === 'gap')) {
        const d  = parseInches(next.divanHeight);
        const lg = parseInches(next.legHeight);
        const g  = parseInches(next.gap);
        next.totalHeight = (d === 0 && lg === 0 && g === 0) ? '' : `${d + lg + g}"`;
      }
      return next;
    });

  // DECREASE — operator picks which existing lot to take from. Stores the exact
  // bucket's variant_key + batch_no and caps the qty input to that bucket.
  const hasVariantGroup = itemGroup === 'sofa' || itemGroup === 'bedframe';
  const onPickBucket = (value: string) => {
    if (!value) { setVariantKey(''); setBatchNo(''); return; }
    const b = buckets.find((x) => `${x.variant_key} ${x.batch_no ?? ''}` === value);
    if (!b) return;
    setVariantKey(b.variant_key);
    setBatchNo(b.batch_no ?? '');
    // Cap the qty down so a decrease can't exceed the chosen lot.
    setQty((q) => Math.min(q, b.qty));
  };

  // Qty ceiling for a DECREASE — the picked lot's quantity (null = uncapped).
  const bucketQtyCap = useMemo(() => {
    if (type !== 'decrease' || (!variantKey && !batchNo)) return null;
    const b = buckets.find((x) => x.variant_key === variantKey && (x.batch_no ?? '') === batchNo);
    return b ? b.qty : null;
  }, [type, variantKey, batchNo, buckets]);

  const onSave = async () => {
    if (!canSave) {
      void notify({ title: 'Fill in Warehouse, SKU, Qty and Reason before saving.', tone: 'error' });
      return;
    }
    // INCREASE gate — sofa / bedframe must carry their variant attributes (and
    // sofa a batch number) before the found stock can be saved.
    if (type === 'increase' && hasVariantGroup) {
      const errs = adjustmentIncreaseErrors(itemGroup, variants, batchNo);
      if (errs.length > 0) {
        void notify({ title: "This adjustment can't be saved yet", body: errs.join('\n'), tone: 'error' });
        return;
      }
    }
    // DECREASE gate — when there are open lots, the operator must say which one
    // the stock comes out of (so the right variant/batch is reduced).
    if (type === 'decrease' && buckets.length > 0 && !variantKey && !batchNo) {
      void notify({
        title: 'Pick which batch or variant the stock comes out of',
        body: 'This item has more than one open batch, so we need to know which one to reduce.',
        tone: 'error',
      });
      return;
    }
    if (willGoNegative) {
      const proceed = await askConfirm({
        title: 'This will push the balance below zero',
        body: `Saving this adjustment leaves the balance at ${resultingBalance}. That usually means stock arrived without a Goods Received Note, or the wrong warehouse is selected.`,
        confirmLabel: 'Save anyway',
        danger: true,
      });
      if (!proceed) return;
    }
    const trimmedBatch = batchNo.trim();
    adjust.mutate(
      {
        warehouseId,
        productCode: productCode.trim(),
        productName: productName.trim() || undefined,
        qtyDelta,
        reasonCode,
        notes: notes.trim() || undefined,
        // Variant + batch. On INCREASE the backend computes variant_key from
        // `variants`; on DECREASE the picker supplies the exact bucket.
        itemGroup: hasVariantGroup ? itemGroup : undefined,
        variants:  type === 'increase' && hasVariantGroup ? variants : undefined,
        batchNo:   trimmedBatch || undefined,
        variantKey: type === 'decrease' ? (variantKey || undefined) : undefined,
      },
      {
        onSuccess: () => navigate('/scm/stock-adjustments'),
        /* authedFetch already ran the response through humanApiError, so this
           arrives as a plain sentence. What the operator needs added is that
           NOTHING moved — otherwise they re-key the adjustment on top of one
           they think might have half-landed. */
        onError: (err) => void notify({
          title: "Couldn't save this stock adjustment",
          body: `${err instanceof Error ? err.message : 'Something went wrong.'} No stock was moved and your entries are still on this screen — please try again.`,
          tone: 'error',
        }),
      },
    );
  };

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Inventory"
        title="New Stock Adjustment"
        actions={
          <>
            <div className={styles.actions}>
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/stock-adjustments')}>
                <X {...ICON} /> Cancel
              </Button>
              <Button variant="primary" size="md" onClick={onSave} disabled={adjust.isPending}>
                <Save {...ICON} />
                {adjust.isPending ? 'Saving…' : 'Save Adjustment'}
              </Button>
            </div>
          </>
        }
      />

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Adjustment</h2>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid2}>
            {/* Warehouse */}
            <label className={styles.field}>
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

            {/* SKU */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>SKU *</span>
              <input
                type="text"
                list="stock-adjustment-skus"
                value={productCode}
                onChange={(e) => onPickSku(e.target.value)}
                placeholder="Type or pick a SKU code…"
                className={styles.fieldInput}
                style={{ fontFamily: 'var(--font-mono)' }}
              />
              <datalist id="stock-adjustment-skus">
                {sortByText(allSkus.data ?? []).map((p) => (
                  <option key={p.id} value={p.code}>{p.name} · {p.category}</option>
                ))}
              </datalist>
            </label>

            {/* Product name — read-only, auto-filled */}
            <label className={`${styles.field} ${styles.fieldFull}`}>
              <span className={styles.fieldLabel}>Product Name</span>
              <input
                type="text"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                placeholder="(auto-filled when SKU picked — editable for free-text adjustments)"
                className={styles.fieldInput}
                style={{ background: 'var(--c-cream)', color: 'var(--c-ink)' }}
              />
            </label>
          </div>

          {/* Current balance hint — appears once both warehouse + SKU are set */}
          {warehouseId && productCode && (
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
                    {' '}{type === 'increase' ? '+' : '−'}{' '}{qty.toLocaleString('en-MY')}
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
                onClick={() => setType('increase')}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: 'var(--space-2) var(--space-4)',
                  fontFamily: 'var(--font-button)', fontSize: 'var(--fs-13)', fontWeight: 600,
                  background: type === 'increase' ? 'var(--c-secondary-a, #2F5D4F)' : 'var(--c-paper)',
                  color:      type === 'increase' ? 'var(--c-cream)' : 'var(--c-ink)',
                  border: 'none', cursor: 'pointer',
                }}
              >
                <Plus size={14} strokeWidth={2} /> Increase (found / recount up)
              </button>
              <button
                type="button"
                onClick={() => setType('decrease')}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: 'var(--space-2) var(--space-4)',
                  fontFamily: 'var(--font-button)', fontSize: 'var(--fs-13)', fontWeight: 600,
                  background: type === 'decrease' ? 'var(--c-festive-b, #B8331F)' : 'var(--c-paper)',
                  color:      type === 'decrease' ? 'var(--c-cream)' : 'var(--c-ink)',
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
          {type === 'increase' && hasVariantGroup && maint && (
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
              }}>{itemGroup} Variants</div>
              {itemGroup === 'bedframe' ? (
                <div className={styles.formGrid4}>
                  <VariantSelect label="Divan Height" options={activeOptions(maint.divanHeights, String(variants.divanHeight ?? ''))}
                    value={String(variants.divanHeight ?? '')}
                    onChange={(v) => setVariant('divanHeight', v)} />
                  <VariantSelect label="Gap"
                    options={maintPickerValues(maint.gaps, String(variants.gap ?? '')).map((g) => ({ value: g, priceSen: 0 }))}
                    value={String(variants.gap ?? '')}
                    onChange={(v) => setVariant('gap', v)} />
                  <VariantSelect label="Leg Height" options={activeOptions(maint.legHeights, String(variants.legHeight ?? ''))}
                    value={String(variants.legHeight ?? '')}
                    onChange={(v) => setVariant('legHeight', v)} />
                  {/* Fabric / Colour — stored as fabricCode (the key the variant
                      bucket + the required-axis gate read). Free text. */}
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Fabric / Colour</span>
                    <input className={styles.fieldInput}
                      value={String(variants.fabricCode ?? '')}
                      onChange={(e) => setVariant('fabricCode', e.target.value)} />
                  </label>
                </div>
              ) : (
                <div className={styles.formGrid4}>
                  <VariantSelect label="Seat Size"
                    options={maintPickerValues(maint.sofaSizes, String(variants.seatHeight ?? '')).map((s) => ({ value: s, priceSen: 0 }))}
                    value={String(variants.seatHeight ?? '')}
                    onChange={(v) => setVariant('seatHeight', v)} />
                  <VariantSelect label="Leg Height" options={activeOptions(maint.sofaLegHeights, String(variants.legHeight ?? ''))}
                    value={String(variants.legHeight ?? '')}
                    onChange={(v) => setVariant('legHeight', v)} />
                  {/* Fabric — stored as fabricCode (the key the variant bucket +
                      the required-axis gate read). Free text. */}
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Fabric / Colour</span>
                    <input className={styles.fieldInput}
                      value={String(variants.fabricCode ?? '')}
                      onChange={(e) => setVariant('fabricCode', e.target.value)} />
                  </label>
                </div>
              )}
              {/* Special Orders — shared editor (owner 2026-07-20). A standalone
                  adjustment has no parent, so it is directly editable and writes
                  variants.specials (array). */}
              <div style={{ marginTop: 'var(--space-3)' }}>
                <SpecialOrders
                  options={itemGroup === 'bedframe' ? specialsPools.bedframe : specialsPools.sofa}
                  variants={variants}
                  onPatch={(patch) => setVariants((prev) => ({ ...prev, ...patch }))}
                  showPrices={false}
                />
              </div>
              {/* Batch Number — required for sofa (so the stock can be allocated
                  to an order later); optional for bedframe. */}
              <label className={`${styles.field} ${styles.fieldFull}`} style={{ marginTop: 'var(--space-3)' }}>
                <span className={styles.fieldLabel}>Batch Number{itemGroup === 'sofa' ? ' *' : ''}</span>
                <input
                  type="text"
                  value={batchNo}
                  onChange={(e) => setBatchNo(e.target.value)}
                  placeholder="Lot / batch label for this found stock"
                  className={styles.fieldInput}
                />
                {itemGroup === 'sofa' && (
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
          {type === 'decrease' && warehouseId && productCode && (
            <div style={{ marginTop: 'var(--space-4)' }}>
              {bucketsQ.isLoading ? (
                <span style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>Loading open stock…</span>
              ) : buckets.length === 0 ? (
                <span style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>No open stock to take from.</span>
              ) : (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Take from *</span>
                  <select
                    value={variantKey || batchNo ? `${variantKey} ${batchNo}` : ''}
                    onChange={(e) => onPickBucket(e.target.value)}
                    className={styles.fieldInput}
                  >
                    <option value="">— Pick which batch / variant —</option>
                    {sortByText(buckets).map((b) => (
                      <option key={`${b.variant_key} ${b.batch_no ?? ''}`} value={`${b.variant_key} ${b.batch_no ?? ''}`}>
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
                value={qty}
                onChange={(e) => {
                  let n = Math.max(0, Math.floor(Number(e.target.value) || 0));
                  if (bucketQtyCap != null) n = Math.min(bucketQtyCap, n);
                  setQty(n);
                }}
                className={styles.fieldInput}
                style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}
              />
            </label>

            {/* Reason — structured, required for audit trail */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Reason *</span>
              <select
                value={reasonCode}
                onChange={(e) => setReasonCode(e.target.value)}
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
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
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
    </div>
  );
};
