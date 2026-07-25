// ----------------------------------------------------------------------------
// PcLineCard — shared inline per-line editor for the Purchase Consignment family.
//
// T12 (owner 2026-06-19): "P/CO Edit 也要像 Create 那样可以整行编辑" — Consignment
// Order Edit must restore the full Create line editor. Extracted VERBATIM from
// PurchaseConsignmentOrderNew's inline line card (the §lines.map block) so BOTH
// PurchaseConsignmentOrderNew (Create) and PurchaseConsignmentOrderDetail (Edit)
// render the SAME rich editor. Mirrors the PoLineCard pattern (one component
// reused by PurchaseOrderNew + PurchaseOrderDetail Edit mode).
//
// It WRAPS the shared PcVariantEditor (the single, never-drift consignment-family
// variant editor) — never PoLineCard, which is reserved for PO + PI. Owns, per
// line:
//   - Item Code picker (supplier-binding-filtered datalist + catalogue fallback)
//   - bi-directional Supplier SKU picker
//   - Description (free text, auto-filled on bind)
//   - SOFA / BEDFRAME variant editor (via PcVariantEditor)
//   - the qty / unit-price / discount / delivery / ship-to row
//
// The COST auto-recompute stays in the PARENT (it runs ONE effect across all
// lines). This card only emits draft patches via onChange + the binding/variant
// callbacks. Bedframe Total Height (= Divan + Leg + Gap) auto-compute lives in
// the parent's onSetVariant so the rule stays single-sourced.
//
// HOUZS VENDOR — verbatim from apps/backend/src/components/PcLineCard.tsx. Import
// boundary only: ../lib/* + ./PcVariantEditor + ./MoneyInput stay (the vendored
// siblings), and the SalesOrderDetail.module.css resolves to pages/scm-v2/ (same
// path PcVariantEditor uses). NOTE: the Supplier Date 2/3/4 inputs (migration
// 0181) ride through on the draft only — Houzs's consignment schema lacks those
// columns, so the consignment-order Detail page neither seeds nor sends them.
// They render blank + harmless (display-only).
// ----------------------------------------------------------------------------

import { Trash2 } from 'lucide-react';
import type { MfgProductRow, MaintenanceConfig } from '../lib/mfg-products-queries';
import type { BindingRow, MaterialKind } from '../lib/suppliers-queries';
import type { FabricTrackingRow } from '../lib/fabric-queries';
import type { Warehouse } from '../lib/inventory-queries';
import { PcVariantEditor } from './PcVariantEditor';
import { MoneyInput } from './MoneyInput';
import styles from '../../../pages/scm-v2/SalesOrderDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
};

/** Per-line consignment draft. Mirrors PurchaseConsignmentOrderNew's DraftLine
 *  shape so the same card drives Create and Edit. `rid` is the client-side row
 *  id; on Edit the parent keys it by the persisted item id. */
export type PcLineDraft = {
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
  /* Supplier-revised per-line delivery dates (migration 0181). All optional;
     the supplier pushes the date back. Display-only on consignment (no MRP /
     outstanding / on-time) — the latest non-empty date is the effective one,
     computed at READ sites via the shared effectiveDelivery() helper. */
  supplierDeliveryDate2?: string;
  supplierDeliveryDate3?: string;
  supplierDeliveryDate4?: string;
  warehouseId?: string;
  /* Set when materialCode matches an mfg_product — drives which variant editor
     renders (sofa / bedframe). Lowercase to match itemGroup. */
  category?: string;
  /** Variant payload (fabric / gap / divan / leg / seat / total height /
      specials). Shipped to the API as NewPoItem.variants. */
  variants: Record<string, unknown>;
  /** true once the operator types into Unit Price — a manual override wins and
      the parent's supplier-price auto-fill stops touching this line's cost. */
  priceTouched?: boolean;
};

/** Factory for a fresh blank consignment line draft. */
export const emptyPcLine = (): PcLineDraft => ({
  rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  materialKind: 'mfg_product',
  materialCode: '',
  materialName: '',
  qty: 1,
  unitPriceCenti: 0,
  variants: {},
});

export const PcLineCard = ({
  index,
  line,
  currency,
  supplierId,
  bindings,
  allSkus,
  warehouses,
  maint,
  fabrics,
  onChange,
  onPickBinding,
  onSetVariant,
  onPendingItemPick,
  onRemove,
  disabled = false,
  identityReadOnly = false,
}: {
  index: number;
  line: PcLineDraft;
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
  /** Patch arbitrary line fields. */
  onChange: (patch: Partial<PcLineDraft>) => void;
  /** Adopt a supplier binding (fills code + name + SKU + price + category). */
  onPickBinding: (b: BindingRow) => void;
  /** Patch one variant key (parent owns the bedframe Total-Height auto-compute). */
  onSetVariant: (k: string, v: unknown) => void;
  /** Item-first reverse lookup — fired when a code is typed before a supplier is
      picked. Pass null to clear. */
  onPendingItemPick: (code: string | null) => void;
  /** Remove this line. */
  onRemove: () => void;
  /** Read-only when true (locked doc). */
  disabled?: boolean;
  /** T12 — a line that descends from an upstream doc keeps its identity (code /
      SKU / description) + variants READ-ONLY; only qty/price/disc/delivery stay
      editable. Used by PCR for PCO-sourced lines. Defaults off. */
  identityReadOnly?: boolean;
}) => {
  const l = line;
  const lineTotalCenti = Math.max(0, l.qty * l.unitPriceCenti - (l.discountCenti ?? 0));
  const categoryLabel = l.category?.toUpperCase() ?? 'UNSET';
  const showVariants = Boolean(l.category) && ['sofa', 'bedframe'].includes(l.category ?? '') && Boolean(maint);
  // The whole card's `disabled` (locked doc) wins over everything; identityLocked
  // additionally freezes the identity + variant inputs on a sourced line.
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

      {/* Identity row — Internal code + Supplier SKU side by side */}
      <div className={styles.formGrid2}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Item Code (Internal)</span>
          <input
            type="text"
            list={`pc-bindings-${l.rid}`}
            value={l.materialCode}
            disabled={identityLocked}
            onChange={(e) => {
              const code = e.target.value;
              const match = supplierId
                ? bindings.find((b) => b.material_code === code)
                : undefined;
              if (match) { onPickBinding(match); return; }
              const sku = allSkus.find((p) => p.code === code);
              onChange({
                materialCode: code,
                materialName: sku?.name ?? l.materialName,
                bindingId: undefined,
                category: sku?.category.toLowerCase() ?? l.category,
              });
              if (!supplierId) onPendingItemPick(code || null);
            }}
            placeholder="Type or pick our internal SKU…"
            className={styles.fieldInput}
            style={{ fontFamily: 'var(--font-mono)' }}
          />
          <datalist id={`pc-bindings-${l.rid}`}>
            {supplierId && bindings.length > 0
              ? bindings.map((b) => (
                  <option key={b.id} value={b.material_code}>
                    {b.material_name} · {b.supplier_sku} · {fmtRm(b.unit_price_centi, b.currency)}
                  </option>
                ))
              : allSkus.map((p) => (
                  <option key={p.id} value={p.code}>
                    {p.name} · {p.category}
                  </option>
                ))
            }
          </datalist>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Supplier SKU</span>
          <input
            type="text"
            list={`pc-supplier-skus-${l.rid}`}
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
          <datalist id={`pc-supplier-skus-${l.rid}`}>
            {supplierId && bindings.map((b) => (
              <option key={b.id} value={b.supplier_sku || ''}>
                {b.material_code} · {b.material_name} · {fmtRm(b.unit_price_centi, b.currency)}
              </option>
            ))}
          </datalist>
        </label>
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

      {/* Per-category variant editor — the shared PcVariantEditor (never drifts
          from the rest of the consignment family). A sourced line freezes it by
          stubbing onChange when identityLocked. */}
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

          <PcVariantEditor
            category={l.category ?? ''}
            variants={l.variants}
            onChange={onSetVariant}
            fabrics={fabrics}
            maint={maint!}
            disabled={disabled}
            sourceLinked={identityReadOnly}
            sourceLabel="Purchase Consignment Order"
          />
        </div>
      )}

      {/* Pricing row — Qty · Unit Price · Discount · Delivery · Ship-to */}
      <div className={styles.formGrid4} style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
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
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Ship-to Location</span>
          <select
            value={l.warehouseId ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ warehouseId: e.target.value })}
            className={styles.fieldInput}
          >
            <option value="">— Inherit Purchase Location —</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.code}</option>
            ))}
          </select>
        </label>
      </div>

      {/* Supplier-revised delivery dates (migration 0181). The supplier pushes
          the delivery back; the latest non-empty date is the effective one.
          Display-only on consignment (no MRP / outstanding / on-time). All
          optional. HOUZS: display-only — Houzs's consignment schema lacks these
          columns, so the page neither seeds nor persists them. */}
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
    </div>
  );
};
