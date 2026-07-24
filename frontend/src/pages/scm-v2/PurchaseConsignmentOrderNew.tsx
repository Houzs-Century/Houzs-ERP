// ----------------------------------------------------------------------------
// PurchaseConsignmentOrderNew — full-page Create at /scm/purchase-consignment-orders/new.
//
// Faithful clone of PurchaseOrderNew.tsx. It reuses the SAME shared components
// UNCHANGED — MoneyInput, ActionResultDialog, the supplier picker + supplier /
// product / fabric / maintenance / warehouse data hooks — and the SAME per-line
// card editor (item code · supplier SKU · description · per-category variant
// editor · pricing). Only the create mutation is repointed at
// `/purchase-consignment-orders` (useCreatePurchaseConsignmentOrder) and the
// page title / back link / post-save navigate point at /purchase-consignment.
//
// Dropped from the PO clone (per scope): the "From Sales Order" picker / MRP
// shortage flow / from-SO prefill + the one-supplier-per-PO From-SO guard. The
// full line / variant / colour / pricing + supplier entry are kept intact.
//
// The backend route `/purchase-consignment-orders` mirrors `/mfg-purchase-orders`
// 1:1; numbering is PCO-…
// ----------------------------------------------------------------------------

import { todayMyt } from '../../vendor/scm/lib/dates';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Save, Trash2, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { formatPhone } from '@2990s/shared/phone';
import { useCreatePurchaseConsignmentOrder } from '../../vendor/scm/lib/purchase-consignment-order-queries';
import { useIdempotencyKey } from '../../lib/idempotency';
import {
  useSuppliers,
  useSupplierDetail,
  useSuppliersForMaterial,
  type BindingRow,
  type NewPoItem,
  type MaterialKind,
} from '../../vendor/scm/lib/suppliers-queries';
import { useMfgProducts, useMaintenanceConfig } from '../../vendor/scm/lib/mfg-products-queries';
import { useFabricTrackings } from '../../vendor/scm/lib/fabric-queries';
import { PcVariantEditor } from '../../vendor/scm/components/PcVariantEditor';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import {
  computeMfgPoUnitCost,
  type MfgFabricTier,
  type PoPriceMatrix,
} from '@2990s/shared/mfg-pricing';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';

const ICON    = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
};

type DraftLine = {
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
  warehouseId?: string;
  category?: string;
  variants: Record<string, unknown>;
  priceTouched?: boolean;
};

const newLine = (): DraftLine => ({
  rid: `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  materialKind: 'mfg_product',
  materialCode: '',
  materialName: '',
  qty: 1,
  unitPriceCenti: 0,
  variants: {},
});

export const PurchaseConsignmentOrderNew = () => {
  const navigate = useNavigate();
  const create   = useCreatePurchaseConsignmentOrder();
  /* One key for the one order this page is open to raise (lib/idempotency.ts).
     Route-level form, navigates to the order detail on success, so the MOUNT is
     exactly one order: stable across re-renders and across a re-press after a
     stalled submit, fresh on remount. */
  const idemKey  = useIdempotencyKey();

  // ── Header state ────────────────────────────────────────────────────
  const [supplierId, setSupplierId]   = useState<string>('');
  const [poDate, setPoDate]           = useState<string>(() => todayMyt());
  const [expectedAt, setExpectedAt]   = useState<string>('');
  const [purchaseLocationId, setPurchaseLocationId] = useState<string>('');
  const [notes, setNotes]             = useState<string>('');

  // ── Items state ─────────────────────────────────────────────────────
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);

  const [dialog, setDialog] = useState<{ title: string; body: string } | null>(null);

  // ── Data ────────────────────────────────────────────────────────────
  const suppliers       = useSuppliers({ status: 'ACTIVE' });
  const supplierDetail  = useSupplierDetail(supplierId || null);
  const warehouses      = useWarehouses();
  const supplier        = supplierDetail.data?.supplier ?? null;
  const bindings        = useMemo(() => supplierDetail.data?.bindings ?? [], [supplierDetail.data?.bindings]);
  const currency        = supplier?.currency ?? 'MYR';

  // Item-first picking — item input is enabled even when supplier is unset; the
  // datalist falls back to the full mfg_products list when no supplier is picked.
  const allSkus = useMfgProducts();
  const supplierMaintQ = useMaintenanceConfig(
    supplierId ? `supplier:${supplierId}` : '',
    { enabled: Boolean(supplierId) },
  );
  const masterMaintQ = useMaintenanceConfig('master', {
    enabled: !supplierId || !supplierMaintQ.data?.data,
  });
  const maint =
    supplierMaintQ.data?.data ?? masterMaintQ.data?.data ?? null;
  const fabrics = useFabricTrackings().data ?? [];

  const categoryForCode = (code: string): string | undefined => {
    const sku = (allSkus.data ?? []).find((p) => p.code === code);
    return sku?.category.toLowerCase();
  };
  const [pendingItemPick, setPendingItemPick] = useState<{ rid: string; code: string } | null>(null);
  const itemSuppliersQuery = useSuppliersForMaterial(
    pendingItemPick ? 'mfg_product' : null,
    pendingItemPick?.code ?? null,
  );
  useEffect(() => {
    if (!pendingItemPick) return;
    if (supplierId) { setPendingItemPick(null); return; }
    if (itemSuppliersQuery.isLoading) return;
    const matches = itemSuppliersQuery.data?.bindings ?? [];
    const b = matches[0];
    if (matches.length === 1 && b) {
      setSupplierId(b.supplier.id);
      setLines((prev) => prev.map((l) => (l.rid === pendingItemPick.rid ? {
        ...l,
        bindingId:      b.id,
        materialKind:   b.material_kind,
        materialCode:   b.material_code,
        materialName:   b.material_name,
        supplierSku:    b.supplier_sku,
        unitPriceCenti: b.unit_price_centi,
        category:       categoryForCode(b.material_code) ?? l.category,
      } : l)));
      setPendingItemPick(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- categoryForCode is a stable code→category lookup, not a reactive trigger
  }, [pendingItemPick, supplierId, itemSuppliersQuery.isLoading, itemSuppliersQuery.data]);

  // Once a supplier resolves, backfill any line whose materialCode matches a
  // binding but lacks a bindingId.
  useEffect(() => {
    if (!supplierId || bindings.length === 0) return;
    setLines((prev) => prev.map((l) => {
      if (l.bindingId || !l.materialCode) return l;
      const b = bindings.find((x) => x.material_code === l.materialCode);
      if (!b) return l;
      return {
        ...l,
        bindingId:      b.id,
        materialKind:   b.material_kind,
        materialName:   b.material_name,
        supplierSku:    b.supplier_sku,
        unitPriceCenti: l.unitPriceCenti || b.unit_price_centi,
        category:       l.category ?? categoryForCode(b.material_code),
      };
    }));
    setPendingItemPick(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- categoryForCode is a stable code→category lookup, not a reactive trigger
  }, [supplierId, bindings]);

  // Header Purchase Location / Expected Delivery fan out to all lines.
  useEffect(() => {
    if (!purchaseLocationId) return;
    setLines((prev) => prev.map((l) => ({ ...l, warehouseId: purchaseLocationId })));
  }, [purchaseLocationId]);
  useEffect(() => {
    if (!expectedAt) return;
    setLines((prev) => prev.map((l) => ({ ...l, deliveryDate: expectedAt })));
  }, [expectedAt]);

  const fabricTierForLine = (line: DraftLine): MfgFabricTier | null => {
    const code = String(line.variants.fabricCode ?? '');
    if (!code) return null;
    const f = fabrics.find((x) => x.fabric_code === code);
    if (!f) return null;
    const cat = line.category?.toLowerCase();
    if (cat === 'sofa')     return f.sofa_price_tier ?? f.price_tier ?? null;
    if (cat === 'bedframe') return f.bedframe_price_tier ?? f.price_tier ?? null;
    return null;
  };

  const recomputeLineCost = (line: DraftLine): number => {
    const binding = line.bindingId
      ? bindings.find((b) => b.id === line.bindingId)
      : bindings.find((b) => b.material_code === line.materialCode);
    if (!binding) return line.unitPriceCenti;
    const category = (line.category?.toUpperCase() ?? '') as
      'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'ACCESSORY' | 'SERVICE' | '';
    if (!category) return binding.unit_price_centi;
    const v = line.variants;
    const specials = Array.isArray(v.specials) ? (v.specials as string[]) : [];
    const breakdown = computeMfgPoUnitCost(
      {
        category,
        priceMatrix:    (binding.price_matrix ?? null) as PoPriceMatrix,
        unitPriceCenti: binding.unit_price_centi,
        fabricTier:     fabricTierForLine(line),
        seatSize:       category === 'SOFA' ? (v.seatHeight as string | undefined) ?? null : null,
        divanHeight:    (v.divanHeight as string | undefined) ?? null,
        legHeight:      category === 'BEDFRAME' ? (v.legHeight as string | undefined) ?? null : null,
        sofaLegHeight:  category === 'SOFA' ? (v.legHeight as string | undefined) ?? null : null,
        totalHeight:    (v.totalHeight as string | undefined) ?? null,
        specials,
      },
      maint,
    );
    return breakdown.unitPriceSen;
  };

  // ── Helpers ─────────────────────────────────────────────────────────
  const setLine  = (rid: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const addLine  = () => setLines((prev) => [...prev, { ...newLine(), warehouseId: purchaseLocationId || undefined, deliveryDate: expectedAt || undefined }]);
  const dropLine = (rid: string) => setLines((prev) =>
    prev.length === 1 ? [newLine()] : prev.filter((l) => l.rid !== rid),
  );

  const pickBinding = (rid: string, b: BindingRow) => {
    setLine(rid, {
      bindingId:      b.id,
      materialKind:   b.material_kind,
      materialCode:   b.material_code,
      materialName:   b.material_name,
      supplierSku:    b.supplier_sku,
      unitPriceCenti: b.unit_price_centi,
      category:       categoryForCode(b.material_code),
      priceTouched:   false,
    });
  };

  const parseInches = (s: unknown): number => {
    if (s == null) return 0;
    const m = String(s).match(/(-?\d+(?:\.\d+)?)/);
    return m && m[1] ? Number(m[1]) : 0;
  };
  const setVariant = (rid: string, k: string, v: unknown) =>
    setLines((prev) => prev.map((l) => {
      if (l.rid !== rid) return l;
      const variants: Record<string, unknown> = { ...l.variants, [k]: v };
      if (l.category === 'bedframe' && (k === 'divanHeight' || k === 'legHeight' || k === 'gap')) {
        const d = parseInches(variants.divanHeight);
        const lg = parseInches(variants.legHeight);
        const g = parseInches(variants.gap);
        variants.totalHeight = (d === 0 && lg === 0 && g === 0) ? '' : `${d + lg + g}"`;
      }
      return { ...l, variants };
    }));

  useEffect(() => {
    setLines((prev) => {
      let changed = false;
      const next = prev.map((l) => {
        if (l.priceTouched) return l;
        const cost = recomputeLineCost(l);
        if (cost === l.unitPriceCenti) return l;
        changed = true;
        return { ...l, unitPriceCenti: cost };
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindings, fabrics, maint, lines]);

  const subtotalCenti = useMemo(
    () => lines.reduce(
      (s, l) => s + Math.max(0, l.qty * l.unitPriceCenti - (l.discountCenti ?? 0)),
      0,
    ),
    [lines],
  );

  const onSave = () => {
    if (!supplierId) {
      setDialog({ title: 'Pick a Creditor', body: 'Pick a Creditor (supplier) first.' });
      return;
    }
    if (!expectedAt) {
      setDialog({ title: 'Expected Delivery required', body: 'Expected Delivery date is required.' });
      return;
    }
    if (!purchaseLocationId) {
      setDialog({ title: 'Purchase Location required', body: 'Purchase Location is required.' });
      return;
    }
    const validLines = lines.filter((l) => l.materialCode.trim() && l.qty > 0);
    const items: NewPoItem[] = validLines.map((l) => ({
      materialKind:   l.materialKind,
      materialCode:   l.materialCode,
      materialName:   l.materialName || l.materialCode,
      supplierSku:    l.supplierSku,
      qty:            l.qty,
      unitPriceCenti: l.unitPriceCenti,
      bindingId:      l.bindingId,
      discountCenti:  l.discountCenti,
      deliveryDate:   l.deliveryDate || undefined,
      warehouseId:    l.warehouseId  || undefined,
      itemGroup:      l.category,
      variants:       Object.keys(l.variants).length ? l.variants : undefined,
    }));

    create.mutate(
      {
        idempotencyKey: idemKey,
        supplierId,
        currency,
        poDate,
        expectedAt,
        notes: notes || undefined,
        purchaseLocationId,
        items,
      },
      {
        onSuccess: (res) => navigate(`/scm/purchase-consignment-orders/${res.id}`),
        onError:   (err) => setDialog({ title: 'Save failed', body: err instanceof Error ? err.message : 'Something went wrong.' }),
      },
    );
  };

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Procurement"
        title="New Purchase Consignment Order"
        actions={
          <div className={styles.actions}>
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/purchase-consignment-orders')}>
              <X {...ICON} /> Cancel
            </Button>
            <Button
              variant="primary" size="md"
              onClick={onSave}
              disabled={create.isPending}
            >
              <Save {...ICON} />
              {create.isPending ? 'Saving…' : 'Create Purchase Consignment Order'}
            </Button>
          </div>
        }
      />

      {/* Header card — 2-column grid */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Header</h2>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid2}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Creditor *</span>
              <select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                className={styles.fieldInput}
              >
                <option value="">— Pick a supplier —</option>
                {sortByText(suppliers.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>P/CO No</span>
              <input
                type="text"
                readOnly
                value="(assigned on Save)"
                className={styles.fieldInput}
                style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Name</span>
              <input
                type="text"
                readOnly
                value={supplier?.name ?? ''}
                placeholder="(auto-filled when supplier selected)"
                className={styles.fieldInput}
                style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Date *</span>
              <input
                type="date"
                value={poDate}
                onChange={(e) => setPoDate(e.target.value)}
                className={styles.fieldInput}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Address</span>
              <textarea
                readOnly
                value={[supplier?.address, supplier?.area, supplier?.postcode, supplier?.state, supplier?.country]
                  .filter(Boolean).join(', ')}
                placeholder="(auto-filled when supplier selected)"
                className={styles.fieldInput}
                style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)', minHeight: 52, resize: 'vertical' }}
                rows={3}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Expected Delivery *</span>
              <input
                type="date"
                value={expectedAt}
                onChange={(e) => setExpectedAt(e.target.value)}
                className={styles.fieldInput}
                required
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Purchase Location *</span>
              <select
                value={purchaseLocationId}
                onChange={(e) => setPurchaseLocationId(e.target.value)}
                className={styles.fieldInput}
                required
              >
                <option value="">— Pick a warehouse —</option>
                {sortByText(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>{w.code}</option>
                ))}
              </select>
              <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                Default ship-to warehouse for every line; each line can override below.
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Free text — supplier instructions, internal notes…"
                className={styles.fieldInput}
                rows={3}
                style={{ minHeight: 52, resize: 'vertical' }}
              />
            </label>
          </div>

          {supplier && (
            <div style={{
              marginTop: 'var(--space-3)',
              background: 'var(--c-cream)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-2) var(--space-3)',
              fontSize: 'var(--fs-12)',
              color: 'var(--fg-muted)',
              display: 'flex',
              gap: 'var(--space-4)',
              flexWrap: 'wrap',
            }}>
              {supplier.contact_person && <span>Contact: <strong>{supplier.contact_person}</strong></span>}
              {supplier.phone          && <span>Phone: <strong>{formatPhone(supplier.phone)}</strong></span>}
              {supplier.email          && <span>Email: <strong>{supplier.email}</strong></span>}
              {supplier.payment_terms  && <span>Terms: <strong>{supplier.payment_terms}</strong></span>}
              <span>Currency: <strong>{currency}</strong></span>
            </div>
          )}
        </div>
      </section>

      {/* Item-first lookup hint */}
      {pendingItemPick && !supplierId && !itemSuppliersQuery.isLoading && (() => {
        const matches = itemSuppliersQuery.data?.bindings ?? [];
        if (matches.length === 0) {
          return (
            <div style={{
              padding: 'var(--space-3) var(--space-4)',
              background: 'var(--c-cream)',
              border: '1px solid var(--line)',
              borderLeft: '3px solid var(--fg-muted)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--fs-13)',
              color: 'var(--fg)',
            }}>
              <strong style={{ fontFamily: 'var(--font-mono)' }}>{pendingItemPick.code}</strong> isn't bound to any supplier yet. Pick any Creditor above for a one-off purchase, or add a binding from the supplier detail page first.
            </div>
          );
        }
        return (
          <div style={{
            padding: 'var(--space-3) var(--space-4)',
            background: 'rgba(213, 90, 40, 0.06)',
            border: '1px solid var(--c-orange)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--fs-13)',
            color: 'var(--fg)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}>
            <div>
              <strong style={{ fontFamily: 'var(--font-mono)' }}>{pendingItemPick.code}</strong> is bound to {matches.length} suppliers — pick one above to auto-fill price + supplier SKU.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
              {matches.map((b) => (
                <span key={b.id}>
                  <button
                    type="button"
                    onClick={() => setSupplierId(b.supplier.id)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      color: 'var(--c-orange)',
                      cursor: 'pointer',
                      fontWeight: 600,
                      textDecoration: 'underline',
                    }}
                  >
                    {b.supplier.code} · {b.supplier.name}
                  </button>
                  {' '}({fmtRm(b.unit_price_centi, b.currency)})
                </span>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Items card */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            {supplierId
              ? (bindings.length > 0
                  ? `${bindings.length} item(s) bound to this supplier — picker filters to these`
                  : `No SKUs bound to this supplier yet — picker shows all ${(allSkus.data ?? []).length} SKUs (one-off purchase)`)
              : `Pick any item from ${(allSkus.data ?? []).length} SKUs — supplier auto-narrows`}
          </span>
        </div>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {lines.map((l, idx) => {
            const lineTotalCenti = Math.max(0, l.qty * l.unitPriceCenti - (l.discountCenti ?? 0));
            const categoryLabel = l.category?.toUpperCase() ?? 'UNSET';
            const showVariants  = l.category && ['sofa', 'bedframe'].includes(l.category) && maint;

            return (
              <div
                key={l.rid}
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
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <span style={{
                      fontFamily: 'var(--font-button)',
                      fontSize: 'var(--fs-12)',
                      fontWeight: 700,
                      letterSpacing: '0.10em',
                      color: 'var(--fg-muted)',
                    }}>
                      LINE {idx + 1}
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
                    <button
                      type="button"
                      onClick={() => dropLine(l.rid)}
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
                  </div>
                </div>

                {/* Identity row — Internal code + Supplier SKU side by side */}
                <div className={styles.formGrid2}>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Item Code (Internal)</span>
                    <input
                      type="text"
                      list={`bindings-${l.rid}`}
                      value={l.materialCode}
                      onChange={(e) => {
                        const code = e.target.value;
                        const match = supplierId
                          ? bindings.find((b) => b.material_code === code)
                          : undefined;
                        if (match) { pickBinding(l.rid, match); return; }
                        const sku = (allSkus.data ?? []).find((p) => p.code === code);
                        setLine(l.rid, {
                          materialCode: code,
                          materialName: sku?.name ?? l.materialName,
                          bindingId: undefined,
                          category: sku?.category.toLowerCase() ?? categoryForCode(code),
                        });
                        if (!supplierId) setPendingItemPick(code ? { rid: l.rid, code } : null);
                      }}
                      placeholder="Type or pick our internal SKU…"
                      className={styles.fieldInput}
                      style={{ fontFamily: 'var(--font-mono)' }}
                    />
                    <datalist id={`bindings-${l.rid}`}>
                      {supplierId && bindings.length > 0
                        ? sortByText(bindings).map((b) => (
                            <option key={b.id} value={b.material_code}>
                              {b.material_name} · {b.supplier_sku} · {fmtRm(b.unit_price_centi, b.currency)}
                            </option>
                          ))
                        : sortByText(allSkus.data ?? []).map((p) => (
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
                      list={`supplier-skus-${l.rid}`}
                      value={l.supplierSku ?? ''}
                      onChange={(e) => {
                        const sku = e.target.value;
                        if (supplierId) {
                          const match = bindings.find((b) => b.supplier_sku === sku);
                          if (match) {
                            pickBinding(l.rid, match);
                          } else {
                            setLine(l.rid, { supplierSku: sku });
                          }
                        } else {
                          setLine(l.rid, { supplierSku: sku });
                        }
                      }}
                      placeholder={supplierId
                        ? 'Type or pick supplier’s code…'
                        : 'Pick a supplier first to enable picker'}
                      className={styles.fieldInput}
                      style={{ fontFamily: 'var(--font-mono)' }}
                    />
                    <datalist id={`supplier-skus-${l.rid}`}>
                      {supplierId && sortByText(bindings).map((b) => (
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
                    onChange={(e) => setLine(l.rid, { materialName: e.target.value })}
                    placeholder="(auto-filled if bound — editable for one-off purchases)"
                    className={styles.fieldInput}
                  />
                </label>

                {/* Per-category variant editor */}
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
                      itemCode={l.materialCode}
                      variants={l.variants as Record<string, unknown>}
                      onChange={(k, v) => setVariant(l.rid, k, v)}
                      fabrics={fabrics}
                      maint={maint!}
                    />
                  </div>
                )}

                {/* Pricing row — Qty · Unit Price · Discount · Delivery · Ship-to */}
                <div className={styles.formGrid4} style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))' }}>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Qty</span>
                    <input
                      type="number" min={0} step={1}
                      value={l.qty}
                      onChange={(e) => setLine(l.rid, { qty: Number(e.target.value) })}
                      className={styles.fieldInput}
                      style={{ textAlign: 'right' }}
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Unit Price ({currency})</span>
                    <MoneyInput
                      bare
                      valueSen={l.unitPriceCenti}
                      onCommit={(sen) => setLine(l.rid, { unitPriceCenti: sen ?? 0, priceTouched: true })}
                      inputClassName={styles.fieldInput}
                      selectOnFocus
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Discount ({currency})</span>
                    <MoneyInput
                      bare
                      valueSen={l.discountCenti ?? 0}
                      onCommit={(sen) => setLine(l.rid, { discountCenti: sen ?? 0 })}
                      inputClassName={styles.fieldInput}
                      selectOnFocus
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Delivery Date</span>
                    <input
                      type="date"
                      value={l.deliveryDate ?? ''}
                      onChange={(e) => setLine(l.rid, { deliveryDate: e.target.value })}
                      className={styles.fieldInput}
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Ship-to Location</span>
                    <select
                      value={l.warehouseId ?? ''}
                      onChange={(e) => setLine(l.rid, { warehouseId: e.target.value })}
                      className={styles.fieldInput}
                    >
                      <option value="">— Inherit Purchase Location —</option>
                      {sortByText(warehouses.data ?? []).map((w) => (
                        <option key={w.id} value={w.id}>{w.code}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            );
          })}

          <button
            type="button"
            onClick={addLine}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              width: '100%',
              padding: '12px 14px',
              border: '1px dashed var(--c-orange)',
              borderRadius: 'var(--radius-md)',
              background: 'transparent',
              color: 'var(--c-orange)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-13)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <Plus {...ICON} /> Add another item
          </button>
        </div>
      </section>

      {/* Totals card aligned right — lg:pr-32 clears the fixed FAB cluster. */}
      <div className="lg:pr-32" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <section className={styles.card} style={{ maxWidth: 360, width: '100%' }}>
          <div className={styles.cardBody}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-14)', marginBottom: 'var(--space-2)' }}>
              <span>Subtotal</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(subtotalCenti, currency)}</span>
            </div>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 'var(--fs-16)',
              fontWeight: 700,
              borderTop: '1px solid var(--line)',
              paddingTop: 'var(--space-2)',
            }}>
              <span>Total</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(subtotalCenti, currency)}</span>
            </div>
          </div>
        </section>
      </div>

      {dialog && (
        <ActionResultDialog
          title={dialog.title}
          body={dialog.body}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
};
