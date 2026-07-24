// ----------------------------------------------------------------------------
// PoLineCard — shared inline per-line editor for Purchase Orders.
//
// Owner 2026-06-19: "PO Edit 也要像 Create 那样可以整行编辑" — Edit mode must
// restore the full Create line editor. Extracted verbatim from
// PurchaseOrderNew's inline line card (the §lines.map block, PR #126/#129) so
// BOTH PurchaseOrderNew (Create) and PurchaseOrderDetail (Edit) render the SAME
// rich editor. Mirrors the SoLineCard pattern (one component reused by
// SalesOrderNew + SalesOrderDetail Edit mode).
//
// Owns, per line:
//   - Item Code picker (supplier-binding-filtered datalist + catalogue fallback)
//   - bi-directional Supplier SKU picker
//   - Description (free text, auto-filled on bind)
//   - SOFA / BEDFRAME variant selects (fabric / seat / leg · gap / divan / leg)
//   - Special Orders checkboxes
//   - the qty / unit-price / discount / delivery / ship-to row
//
// The COST auto-recompute (computeMfgPoUnitCost from the supplier price matrix +
// maintenance surcharges) stays in the PARENT, which runs ONE effect across all
// lines (it depends on bindings / fabrics / maint and the per-line priceTouched
// flag). This card only emits draft patches via onChange + the binding/variant
// callbacks; the parent's effect re-prices any non-touched line. Bedframe Total
// Height (= Divan + Leg + Gap) auto-compute lives in the parent's setVariant so
// the rule stays single-sourced; this card calls onSetVariant for it.
//
// HOUZS VENDOR — verbatim from apps/backend/src/components/PoLineCard.tsx. Import
// boundary only: ../lib/* + ./MoneyInput stay (the vendored siblings), the
// @2990s/shared import is verbatim, and the SalesOrderDetail.module.css resolves
// to pages/scm-v2/ (same path PcVariantEditor uses). The Supplier Date 2/3/4
// inputs (Houzs mig 0026) write through the line draft; PurchaseOrderNew +
// PurchaseOrderDetail now seed them from supplier_delivery_date_2/3/4 and send
// supplierDeliveryDate2/3/4 on create + item add/update.
// ----------------------------------------------------------------------------

import { Trash2 } from 'lucide-react';
import type { MfgProductRow, MaintenanceConfig, SpecialAddonRow } from '../lib/mfg-products-queries';
import { useModelAllowedOptionsByCode } from '../lib/mfg-products-queries';
import { SpecialOrders } from './SpecialOrders';
import type { BindingRow, MaterialKind } from '../lib/suppliers-queries';
import { activeOptions, maintPickerValues, restrictPricedToPool, restrictStringsToPool } from '@2990s/shared';
import { fabricOptionLabel, type FabricTrackingRow } from '../lib/fabric-queries';
import { sortByText, sortByNumeric, byText } from '../lib/sort-options';
import type { Warehouse } from '../lib/inventory-queries';
import { MoneyInput } from './MoneyInput';
import styles from '../../../pages/scm-v2/SalesOrderDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
};

/** Per-line PO draft. Mirrors PurchaseOrderNew's DraftLine shape so the same
 *  card drives Create and Edit. `rid` is the client-side row id; on Edit the
 *  parent keys it by the persisted item id. */
export type PoLineDraft = {
  rid: string;
  bindingId?: string;
  materialKind: MaterialKind;
  materialCode: string;
  materialName: string;
  supplierSku?: string;
  qty: number;
  unitPriceCenti: number;
  discountCenti?: number;
  deliveryDate?: string;
  /* Supplier-revised per-line delivery dates (migration 0180). All optional;
     the supplier pushes the date back. The EFFECTIVE line date readers use =
     MAX over non-null of [deliveryDate, date2, date3, date4]. */
  supplierDeliveryDate2?: string;
  supplierDeliveryDate3?: string;
  supplierDeliveryDate4?: string;
  warehouseId?: string;
  /* Set when materialCode matches an mfg_product — drives which variant editor
     renders (sofa / bedframe). Lowercase to match SoLineCard's itemGroup. */
  category?: string;
  /** Variant payload (fabric / gap / divan / leg / seat / total height /
      specials). Shipped to the API as NewPoItem.variants. */
  variants: Record<string, unknown>;
  /** true once the operator types into Unit Price — a manual override wins and
      the parent's supplier-price auto-fill stops touching this line's cost. */
  priceTouched?: boolean;
  /** Source SO line id when the line came from "From SO" (Create only). */
  soItemId?: string | null;
};

/** Factory for a fresh blank PO line draft. */
export const emptyPoLine = (): PoLineDraft => ({
  rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  materialKind: 'mfg_product',
  materialCode: '',
  materialName: '',
  qty: 1,
  unitPriceCenti: 0,
  variants: {},
});


/* ──────────────────────────────────────────────────────────────────────
   PoLineCard
   ────────────────────────────────────────────────────────────────────── */

export const PoLineCard = ({
  index,
  line,
  currency,
  supplierId,
  bindings,
  allSkus,
  warehouses,
  maint,
  fabrics,
  specialsPools,
  onChange,
  onPickBinding,
  onSetVariant,
  onPendingItemPick,
  onRemove,
  disabled = false,
  hidePoFields = false,
  identityReadOnly = false,
}: {
  index: number;
  line: PoLineDraft;
  currency: string;
  /** Picked supplier id ('' when none yet). Gates the binding-filtered pickers. */
  supplierId: string;
  /** Bindings for the picked supplier (empty when no supplier / no bindings). */
  bindings: BindingRow[];
  /** Full mfg_products catalogue — the picker fallback when a supplier has no
      bindings (or no supplier is picked yet). */
  allSkus: MfgProductRow[];
  /** Warehouses for the per-line ship-to override. */
  warehouses: Warehouse[];
  /** Maintenance config (variant option pools). null until loaded. */
  maint: MaintenanceConfig | null;
  /** Fabric trackings (variant fabric dropdown). */
  fabrics: FabricTrackingRow[];
  /** Per-category Special Orders pools (full special_addons rows) — feed the
      shared SpecialOrders block (owner 2026-07-20 unification). */
  specialsPools: { bedframe: SpecialAddonRow[]; sofa: SpecialAddonRow[] };
  /** Patch arbitrary line fields (qty / price / discount / delivery / ship-to /
      supplierSku / description …). */
  onChange: (patch: Partial<PoLineDraft>) => void;
  /** Adopt a supplier binding (fills code + name + SKU + price + category and
      re-arms supplier-price auto-fill). */
  onPickBinding: (b: BindingRow) => void;
  /** Patch one variant key (parent owns the bedframe Total-Height auto-compute). */
  onSetVariant: (k: string, v: unknown) => void;
  /** Item-first reverse lookup — fired when a code is typed before a supplier is
      picked, so the parent can narrow the supplier list. Pass null to clear. */
  onPendingItemPick: (code: string | null) => void;
  /** Remove this line. */
  onRemove: () => void;
  /** Read-only when true (locked PO). */
  disabled?: boolean;
  /** T12 — PI reuse: hide the PO-only fields that don't apply to a Purchase
      Invoice (per-line delivery date, supplier-revised dates, ship-to warehouse,
      supplier SKU). Defaults off (PO renders them). */
  hidePoFields?: boolean;
  /** T12 — PI reuse: a line that descends from a GRN keeps its identity
      (item code + supplier SKU) and variants READ-ONLY; only qty/price/discount
      stay editable. Defaults off (full Create-style editing). */
  identityReadOnly?: boolean;
}) => {
  const l = line;
  /* Per-Model allowed_options for this line's SKU — the SAME by-code source
     SoLineCard reads, so a PO variant dropdown offers ONLY what the SKU's Model
     permits (owner 2026-07-15 "not a backdoor"). Null for legacy/unknown codes
     ⇒ no restriction, exactly the SoLineCard fallback. */
  const allowOpts = useModelAllowedOptionsByCode(l.materialCode || undefined).data ?? null;
  const lineTotalCenti = Math.max(0, l.qty * l.unitPriceCenti - (l.discountCenti ?? 0));
  const categoryLabel = l.category?.toUpperCase() ?? 'UNSET';
  // PR #135 — only sofa / bedframe carry a variant editor (mattress size +
  // branding are encoded in the SKU code itself).
  const showVariants = Boolean(l.category) && ['sofa', 'bedframe'].includes(l.category ?? '') && Boolean(maint);
  // T12 — identity (code/SKU/description) + variants lock for GRN-sourced PI
  // lines; the whole card's `disabled` (locked doc) still wins over everything.
  const identityLocked = disabled || identityReadOnly;

  return (
    <div
      style={{
        background: 'var(--c-paper)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-4)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      {/* Card header — Line N · category badge · line total · remove */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <span style={{
            fontFamily: 'var(--font-button)',
            fontSize: 'var(--fs-12)',
            fontWeight: 700,
            letterSpacing: '0.10em',
            color: 'var(--fg-muted)',
          }}>
            LINE {index + 1}
          </span>
          {l.category && (
            <span style={{
              fontFamily: 'var(--font-button)',
              fontSize: 'var(--fs-11)',
              fontWeight: 700,
              letterSpacing: '0.10em',
              padding: '2px 8px',
              borderRadius: 'var(--radius-pill)',
              background: 'rgba(166, 71, 30, 0.12)',
              color: 'var(--c-burnt)',
            }}>
              {categoryLabel}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <span className={styles.previewPrice}>{fmtRm(lineTotalCenti, currency)}</span>
          {!disabled && (
            <button
              type="button"
              onClick={onRemove}
              title="Remove line"
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--c-festive-b, #B8331F)',
                padding: 4,
                display: 'inline-flex',
              }}
            >
              <Trash2 {...ICON} />
            </button>
          )}
        </div>
      </div>

      {/* Identity row — Internal code + Supplier SKU side by side. T12: when
          hidePoFields (PI) the Supplier SKU column is dropped, so the code spans
          the row alone. */}
      <div className={hidePoFields ? undefined : styles.formGrid2}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Item Code (Internal)</span>
          <input
            type="text"
            list={`bindings-${l.rid}`}
            value={l.materialCode}
            disabled={identityLocked}
            onChange={(e) => {
              const code = e.target.value;
              // Bound match wins (autofills supplier SKU + price).
              const match = supplierId
                ? bindings.find((b) => b.material_code === code)
                : undefined;
              if (match) { onPickBinding(match); return; }
              // No binding (no supplier yet, OR supplier has no binding for this
              // code) → one-off line: pull name + category from the master SKU
              // list so the row isn't left blank.
              const sku = allSkus.find((p) => p.code === code);
              onChange({
                materialCode: code,
                materialName: sku?.name ?? l.materialName,
                bindingId: undefined,
                category: sku?.category.toLowerCase() ?? l.category,
              });
              // Reverse supplier lookup only matters before a supplier is chosen.
              if (!supplierId) onPendingItemPick(code || null);
            }}
            placeholder="Type or pick our internal SKU…"
            className={styles.fieldInput}
            style={{ fontFamily: 'var(--font-mono)' }}
          />
          <datalist id={`bindings-${l.rid}`}>
            {/* Only show bound SKUs when the supplier actually HAS bindings;
                otherwise fall back to the full catalogue so the picker is never
                dead. */}
            {supplierId && bindings.length > 0
              ? [...bindings].sort((a, b) => byText(a.material_name, b.material_name)).map((b) => (
                  <option key={b.id} value={b.material_code}>
                    {b.material_name} · {b.supplier_sku} · {fmtRm(b.unit_price_centi, b.currency)}
                  </option>
                ))
              : sortByText(allSkus).map((p) => (
                  <option key={p.id} value={p.code}>
                    {p.name} · {p.category}
                  </option>
                ))
            }
          </datalist>
        </label>
        {/* T12 — Supplier SKU is a PO-only field; hidden on the PI card. */}
        {!hidePoFields && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Supplier SKU</span>
          {/* Bi-directional picker: typing/picking a supplier_sku reverse-fills
              the matching binding's internal materialCode + name + price.
              Requires a supplier picked first (we only know which bindings to
              search). */}
          <input
            type="text"
            list={`supplier-skus-${l.rid}`}
            value={l.supplierSku ?? ''}
            disabled={identityLocked}
            onChange={(e) => {
              const sku = e.target.value;
              if (supplierId) {
                const match = bindings.find((b) => b.supplier_sku === sku);
                if (match) {
                  onPickBinding(match);
                } else {
                  onChange({ supplierSku: sku });
                }
              } else {
                onChange({ supplierSku: sku });
              }
            }}
            placeholder={supplierId
              ? 'Type or pick supplier’s code…'
              : 'Pick a supplier first to enable picker'}
            className={styles.fieldInput}
            style={{ fontFamily: 'var(--font-mono)' }}
          />
          <datalist id={`supplier-skus-${l.rid}`}>
            {supplierId && [...bindings].sort((a, b) => byText(a.material_code, b.material_code)).map((b) => (
              <option key={b.id} value={b.supplier_sku || ''}>
                {b.material_code} · {b.material_name} · {fmtRm(b.unit_price_centi, b.currency)}
              </option>
            ))}
          </datalist>
        </label>
        )}
      </div>

      {/* Description — full width */}
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Description</span>
        <input
          type="text"
          value={l.materialName}
          disabled={identityLocked}
          onChange={(e) => onChange({ materialName: e.target.value })}
          placeholder="(auto-filled if bound — editable for one-off purchases)"
          className={styles.fieldInput}
        />
      </label>

      {/* Per-category variant editor (PR #126 logic, PR #129 card layout) */}
      {showVariants && (
        <div style={{
          background: 'var(--c-cream)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-3)',
        }}>
          <div style={{
            fontFamily: 'var(--font-button)',
            fontSize: 'var(--fs-11)',
            fontWeight: 700,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
            marginBottom: 'var(--space-2)',
          }}>
            {l.category} Variants
          </div>

          {/* BEDFRAME — Fabrics · Gaps · Divan · Leg (dropdowns) + Special Orders.
              Total Height is AUTO-COMPUTED (Divan + Leg + Gap) in the parent's
              setVariant, so there's no manual Total picker here. */}
          {l.category === 'bedframe' && (
            <>
              <div className={styles.formGrid4}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Fabrics</span>
                  <select
                    className={styles.fieldSelect}
                    value={String(l.variants.fabricCode ?? '')}
                    disabled={identityLocked}
                    onChange={(e) => onSetVariant('fabricCode', e.target.value)}
                  >
                    <option value="" disabled>Select…</option>
                    {[...fabrics.filter((f) => f.is_active !== false || f.fabric_code === String(l.variants.fabricCode ?? ''))].sort((a, b) => byText(fabricOptionLabel(a), fabricOptionLabel(b))).map((f) => (
                      <option key={f.id} value={f.fabric_code}>
                        {fabricOptionLabel(f)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Gaps</span>
                  <select
                    className={styles.fieldSelect}
                    value={String(l.variants.gap ?? '')}
                    disabled={identityLocked}
                    onChange={(e) => onSetVariant('gap', e.target.value)}
                  >
                    <option value="" disabled>Select…</option>
                    {sortByNumeric(restrictStringsToPool(maintPickerValues(maint!.gaps, String(l.variants.gap ?? '')), allowOpts?.gaps, String(l.variants.gap ?? ''))).map((g) => (<option key={g} value={g}>{g}</option>))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Divan Heights</span>
                  <select
                    className={styles.fieldSelect}
                    value={String(l.variants.divanHeight ?? '')}
                    disabled={identityLocked}
                    onChange={(e) => onSetVariant('divanHeight', e.target.value)}
                  >
                    <option value="" disabled>Select…</option>
                    {sortByNumeric(restrictPricedToPool(activeOptions(maint!.divanHeights, String(l.variants.divanHeight ?? '')), allowOpts?.divan_heights, String(l.variants.divanHeight ?? ''))).map((o) => (<option key={o.value} value={o.value}>{o.value}</option>))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Leg Heights</span>
                  <select
                    className={styles.fieldSelect}
                    value={String(l.variants.legHeight ?? '')}
                    disabled={identityLocked}
                    onChange={(e) => onSetVariant('legHeight', e.target.value)}
                  >
                    <option value="" disabled>Select…</option>
                    {sortByNumeric(restrictPricedToPool(activeOptions(maint!.legHeights, String(l.variants.legHeight ?? '')), allowOpts?.leg_heights, String(l.variants.legHeight ?? ''))).map((o) => (<option key={o.value} value={o.value}>{o.value}</option>))}
                  </select>
                </label>
              </div>
              <SpecialOrders
                options={specialsPools.bedframe}
                variants={l.variants}
                onPatch={(patch) => onChange({ variants: { ...l.variants, ...patch } })}
                showPrices={false}
                disabled={identityLocked}
                sourceLinked={Boolean(l.soItemId)}
                sourceLabel="Sales Order"
              />
            </>
          )}

          {/* SOFA — Fabrics · Seat · Leg + Special Orders. */}
          {l.category === 'sofa' && (
            <>
              <div className={styles.formGrid4}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Fabrics</span>
                  <select
                    className={styles.fieldSelect}
                    value={String(l.variants.fabricCode ?? '')}
                    disabled={disabled}
                    onChange={(e) => onSetVariant('fabricCode', e.target.value)}
                  >
                    <option value="" disabled>Select…</option>
                    {[...fabrics.filter((f) => f.is_active !== false || f.fabric_code === String(l.variants.fabricCode ?? ''))].sort((a, b) => byText(fabricOptionLabel(a), fabricOptionLabel(b))).map((f) => (
                      <option key={f.id} value={f.fabric_code}>
                        {fabricOptionLabel(f)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Seat Size</span>
                  <select
                    className={styles.fieldSelect}
                    value={String(l.variants.seatHeight ?? '')}
                    disabled={identityLocked}
                    onChange={(e) => onSetVariant('seatHeight', e.target.value)}
                  >
                    <option value="" disabled>Select…</option>
                    {sortByNumeric(restrictStringsToPool(maintPickerValues(maint!.sofaSizes, String(l.variants.seatHeight ?? '')), allowOpts?.sizes, String(l.variants.seatHeight ?? ''))).map((s) => (<option key={s} value={s}>{s}</option>))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Leg Heights</span>
                  <select
                    className={styles.fieldSelect}
                    value={String(l.variants.legHeight ?? '')}
                    disabled={identityLocked}
                    onChange={(e) => onSetVariant('legHeight', e.target.value)}
                  >
                    <option value="" disabled>Select…</option>
                    {sortByNumeric(restrictPricedToPool(activeOptions(maint!.sofaLegHeights, String(l.variants.legHeight ?? '')), allowOpts?.leg_heights, String(l.variants.legHeight ?? ''))).map((o) => (<option key={o.value} value={o.value}>{o.value}</option>))}
                  </select>
                </label>
                <span />
              </div>
              <SpecialOrders
                options={specialsPools.sofa}
                variants={l.variants}
                onPatch={(patch) => onChange({ variants: { ...l.variants, ...patch } })}
                showPrices={false}
                disabled={identityLocked}
                sourceLinked={Boolean(l.soItemId)}
                sourceLabel="Sales Order"
              />
            </>
          )}
        </div>
      )}

      {/* Pricing row — Qty · Unit Price · Discount · Delivery · Ship-to. T12: on
          the PI card (hidePoFields) Delivery + Ship-to are dropped, so the row
          collapses to 3 columns. */}
      <div className={styles.formGrid4} style={{ gridTemplateColumns: hidePoFields ? 'repeat(3, 1fr)' : 'repeat(5, 1fr)' }}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Qty</span>
          <input
            type="number" min={0} step={1}
            value={l.qty}
            disabled={disabled}
            onChange={(e) => onChange({ qty: Number(e.target.value) })}
            className={styles.fieldInput}
            style={{ textAlign: 'right' }}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Unit Price ({currency})</span>
          {/* MoneyInput — free typing, no mid-keystroke reformat. Manual edit
              wins: flag priceTouched so the parent's supplier-price auto-fill
              stops overwriting this line. */}
          <MoneyInput
            bare
            valueSen={l.unitPriceCenti}
            disabled={disabled}
            onCommit={(sen) => onChange({ unitPriceCenti: sen ?? 0, priceTouched: true })}
            inputClassName={styles.fieldInput}
            selectOnFocus
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Discount ({currency})</span>
          <MoneyInput
            bare
            valueSen={l.discountCenti ?? 0}
            disabled={disabled}
            onCommit={(sen) => onChange({ discountCenti: sen ?? 0 })}
            inputClassName={styles.fieldInput}
            selectOnFocus
          />
        </label>
        {/* T12 — Delivery + Ship-to are PO-only; hidden on the PI card. */}
        {!hidePoFields && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Delivery Date</span>
          <input
            type="date"
            value={l.deliveryDate ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ deliveryDate: e.target.value })}
            className={styles.fieldInput}
          />
        </label>
        )}
        {!hidePoFields && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Ship-to Location</span>
          <select
            value={l.warehouseId ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ warehouseId: e.target.value })}
            className={styles.fieldInput}
          >
            <option value="">— Inherit Purchase Location —</option>
            {sortByText(warehouses).map((w) => (
              <option key={w.id} value={w.id}>{w.code}</option>
            ))}
          </select>
        </label>
        )}
      </div>

      {/* Supplier-revised delivery dates (Houzs mig 0026). The supplier pushes
          the delivery back; the latest non-empty date is the effective one used
          downstream (MRP / GRN / on-time). All optional. T12: PO-only — hidden
          on the PI card. Seeded + persisted by PurchaseOrderNew/Detail. */}
      {!hidePoFields && (
      <div className={styles.formGrid4} style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Supplier Date 2</span>
          <input
            type="date"
            value={l.supplierDeliveryDate2 ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ supplierDeliveryDate2: e.target.value })}
            className={styles.fieldInput}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Supplier Date 3</span>
          <input
            type="date"
            value={l.supplierDeliveryDate3 ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ supplierDeliveryDate3: e.target.value })}
            className={styles.fieldInput}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Supplier Date 4</span>
          <input
            type="date"
            value={l.supplierDeliveryDate4 ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ supplierDeliveryDate4: e.target.value })}
            className={styles.fieldInput}
          />
        </label>
      </div>
      )}
    </div>
  );
};
