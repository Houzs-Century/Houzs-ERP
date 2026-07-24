// ----------------------------------------------------------------------------
// PurchaseConsignmentReceiveNew — full-page Create at
// /purchase-consignment-receive/new.
//
// Faithful clone of GrnNew.tsx. It reuses the SAME shared components UNCHANGED —
// MoneyInput, ActionResultDialog, ItemGroupPill, the supplier / product /
// maintenance / warehouse data hooks — and the SAME card-per-line editor with
// the per-category variant block. Only the create + post mutations are
// repointed at `/purchase-consignment-receives` (the pc-receive hooks) and the
// page title / back link point at /purchase-consignment-receive.
//
// Dropped from the GRN clone (per scope):
//   • the per-line Rack dropdown (racks place owned inventory; an off-ledger
//     consignment receive doesn't place into racks).
//   • the From-PO multi-picker that points at real POs. Instead the form accepts
//     a `?fromPcOrder=<id>` prefill from a Purchase Consignment Order (its
//     outstanding lines load), OR free manual entry (pick a supplier + add lines).
//
// The backend route `/purchase-consignment-receives` mirrors `/grns` 1:1;
// numbering is PCR-…
// ----------------------------------------------------------------------------

import { todayMyt } from '../../vendor/scm/lib/dates';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRightLeft, ListChecks, Plus, Save, Trash2, X, ChevronDown } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { buildVariantSummary, fmtDateOrDash } from '@2990s/shared';
import {
  useCreatePurchaseConsignmentReceive,
  usePostPurchaseConsignmentReceive,
} from '../../vendor/scm/lib/purchase-consignment-receive-queries';
import { useIdempotencyKey } from '../../lib/idempotency';
import { readScmHandoff, removeScmHandoff } from '../../lib/scmHandoffStorage';
import {
  usePurchaseConsignmentOrderDetail,
  usePurchaseConsignmentOrders,
} from '../../vendor/scm/lib/purchase-consignment-order-queries';
import { useSuppliers, useSupplierDetail } from '../../vendor/scm/lib/suppliers-queries';
import { useMfgProducts, useMaintenanceConfig } from '../../vendor/scm/lib/mfg-products-queries';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
import { useFabricTrackings } from '../../vendor/scm/lib/fabric-queries';
import { PcVariantEditor } from '../../vendor/scm/components/PcVariantEditor';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const parseInches = (s: unknown): number => {
  if (s == null) return 0;
  const m = String(s).match(/(-?\d+(?:\.\d+)?)/);
  return m && m[1] ? Number(m[1]) : 0;
};

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
          <option key={o.value} value={o.value}>
            {o.value}{o.priceSen > 0 ? ` (+${fmtRm(o.priceSen)})` : ''}
          </option>
        ))}
      </select>
      <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
    </span>
  </label>
);

type DraftLine = {
  rid:               string;
  purchaseOrderItemId: string | null;
  materialKind:      string;
  materialCode:      string;
  materialName:      string;
  itemGroup:         string | null;
  variants:          Record<string, unknown> | null;
  outstanding:       number | null;
  qtyReceived:       number;
  qtyAccepted:       number;
  qtyRejected:       number;
  unitPriceCenti:    number;
  notes:             string;
};

export const PurchaseConsignmentReceiveNew = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // ── Source Purchase Consignment Order (inline single-order picker, or the
  //    ?fromPcOrder= deep link from a PC Order detail "Receive Goods"). ──────
  const [selPoId, setSelPoId] = useState<string>(params.get('fromPcOrder') ?? '');
  const fromPicks = params.get('fromPicks') === '1';
  const poListQ = usePurchaseConsignmentOrders();
  const poQ     = usePurchaseConsignmentOrderDetail(selPoId || null);

  // Manual-mode supplier (free entry, no source order).
  const [manualSupplierId, setManualSupplierId] = useState<string>('');
  const suppliersQ = useSuppliers({ status: 'ACTIVE' });

  const maintQ = useMaintenanceConfig('master');
  const maint  = maintQ.data?.data ?? null;
  const fabrics = useFabricTrackings().data ?? [];

  const outstanding = useMemo(
    () => (poListQ.data ?? []).filter((po) => po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED'),
    [poListQ.data],
  );

  /* One key for the one receive this page is open to raise (lib/idempotency.ts).
     Same create-then-post-then-dialog shape as GrnNew (which carries the full
     reasoning): the post below is unconditional here, so a failure in it reports
     "Save failed" while the receive already exists — the re-press must REPLAY
     rather than receive the consigned goods a second time. */
  const idemKey = useIdempotencyKey();
  const create = useCreatePurchaseConsignmentReceive();
  const post   = usePostPurchaseConsignmentReceive();
  const saving = create.isPending || post.isPending;

  const [receivedAt, setReceivedAt]           = useState<string>(() => todayMyt());
  const [deliveryNoteRef, setDeliveryNoteRef] = useState<string>('');
  const [notes, setNotes]                     = useState<string>('');
  const [lines, setLines]                     = useState<DraftLine[]>([]);
  const [warehouseId, setWarehouseId]         = useState<string>('');
  const warehousesQ = useWarehouses();
  const [dialog, setDialog] = useState<{ title: string; body: string; goTo?: string } | null>(null);
  // Multi-select item picker (purchaser 2026-06: "multiple select to choose item").
  const [pickerOpen, setPickerOpen]     = useState(false);
  const [pickerSel, setPickerSel]       = useState<Set<string>>(new Set());
  const [pickerSearch, setPickerSearch] = useState('');

  // From-Order multi-picker merge (fromPicks) — the operator chose specific PC
  // Order lines + quantities on /purchase-consignment-receive/from-pc-order. The
  // header still binds to the first picked order (via ?fromPcOrder=), but the
  // LINES come from the stash (picked subset + picked qty).
  const [picksLoaded, setPicksLoaded] = useState(false);
  useEffect(() => {
    if (!fromPicks || picksLoaded) return;
    type Stash = {
      orderItemId: string; purchaseConsignmentOrderId: string;
      materialKind: string; materialCode: string; materialName: string;
      supplierSku: string | null; itemGroup: string | null; description: string | null;
      uom: string | null; qty: number; unitPriceCenti: number; variants: unknown;
    };
    const stash = readScmHandoff<Stash[]>('pcrFromOrderPicks');
    if (!stash || stash.length === 0) return;
    setLines(stash.map((s) => ({
      rid:                 `p${s.orderItemId}`,
      purchaseOrderItemId: s.orderItemId,
      materialKind:        s.materialKind || 'mfg_product',
      materialCode:        s.materialCode,
      materialName:        s.materialName,
      itemGroup:           s.itemGroup,
      variants:            (s.variants as Record<string, unknown> | null) ?? null,
      outstanding:         Number(s.qty ?? 0),
      qtyReceived:         Number(s.qty ?? 0),
      qtyAccepted:         Number(s.qty ?? 0),
      qtyRejected:         0,
      unitPriceCenti:      Number(s.unitPriceCenti ?? 0),
      notes:               '',
    })));
    removeScmHandoff('pcrFromOrderPicks');
    setPicksLoaded(true);
  }, [fromPicks, picksLoaded]);

  // Load lines from the selected single PC Order (only outstanding qty > 0).
  useEffect(() => {
    if (fromPicks) return; // the picker stash drives the lines, not the full order
    if (!selPoId) {
      // Manual mode — seed ONE blank starter line so a LINE 1 card shows.
      setLines((prev) => prev.length > 0 ? prev : [{
        rid:                 `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        purchaseOrderItemId: null,
        materialKind:        'mfg_product',
        materialCode:        '',
        materialName:        '',
        itemGroup:           null,
        variants:            null,
        outstanding:         null,
        qtyReceived:         1,
        qtyAccepted:         1,
        qtyRejected:         0,
        unitPriceCenti:      0,
        notes:               '',
      }]);
      return;
    }
    if (!poQ.data) return;
    const next: DraftLine[] = poQ.data.items
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((it: any) => {
        const outstandingQty = (it.qty ?? 0) - (it.received_qty ?? 0);
        return {
          rid:               `r${it.id}`,
          purchaseOrderItemId: it.id,
          materialKind:      it.material_kind,
          materialCode:      it.material_code,
          materialName:      it.material_name,
          itemGroup:         it.item_group ?? null,
          variants:          (it.variants as Record<string, unknown> | null) ?? null,
          outstanding:       outstandingQty,
          qtyReceived:       outstandingQty,
          qtyAccepted:       outstandingQty,
          qtyRejected:       0,
          unitPriceCenti:    it.unit_price_centi ?? 0,
          notes:             '',
        };
      })
      .filter((l) => (l.outstanding ?? 0) > 0);
    setLines(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed-once from the nav prefill; the loaded-flag guard makes any re-run a no-op
  }, [poQ.data, selPoId]);

  const setLine  = (rid: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));

  const subtotalCenti = useMemo(
    () => lines.reduce((s, l) => s + l.qtyReceived * l.unitPriceCenti, 0),
    [lines],
  );
  const totalQty = useMemo(
    () => lines.reduce((s, l) => s + (Number(l.qtyReceived) || 0), 0),
    [lines],
  );

  // ── Mode + resolved supplier / header order. ───────────────────────────
  const po       = poQ.data?.purchaseOrder;
  const isManual = !selPoId;

  const supplierId =
    po       ? po.supplier_id
    : isManual ? (manualSupplierId || null)
    : null;
  const supplierName =
    po       ? (po.supplier?.name ?? po.supplier?.code ?? null)
    : isManual ? ((suppliersQ.data ?? []).find((s) => s.id === manualSupplierId)?.name ?? null)
    : null;
  const headerPoId = po?.id ?? null;
  const currency   = po?.currency ?? 'MYR';

  const supplierDetailQ = useSupplierDetail(supplierId);
  const bindings        = useMemo(() => supplierDetailQ.data?.bindings ?? [], [supplierDetailQ.data?.bindings]);
  const supplier        = supplierDetailQ.data?.supplier ?? null;

  // Default the Warehouse picker sensibly: prefer the source order's purchase
  // location, else the first warehouse. Only seeds when still blank.
  useEffect(() => {
    if (warehouseId) return;
    const poLoc = (po as { purchase_location_id?: string | null } | undefined)?.purchase_location_id ?? null;
    const fallback = poLoc ?? (warehousesQ.data?.[0]?.id ?? '');
    if (fallback) setWarehouseId(fallback);
  }, [warehouseId, po, warehousesQ.data]);

  const [productQuery, setProductQuery] = useState<string>('');
  /* Perf — debounce the datalist search so a fast typist fires one
     /mfg-products request per pause, not per keystroke. Native <datalist>
     renders <option>s directly, so no render cap is needed — only the refetch. */
  const debouncedProductQuery = useDebouncedValue(productQuery, 250);
  const productsQ = useMfgProducts({
    search: debouncedProductQuery,
    enabled: isManual && debouncedProductQuery.trim().length >= 2,
  });

  const allSkusQ = useMfgProducts({ enabled: isManual && !!supplierId });
  const categoryForCode = (code: string): string | undefined => {
    const sku = (allSkusQ.data ?? []).find((p) => p.code === code);
    return sku?.category ? sku.category.toLowerCase() : undefined;
  };

  const addEmptyManualLine = () => {
    setLines((prev) => [...prev, {
      rid:                 `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      purchaseOrderItemId: null,
      materialKind:        'mfg_product',
      materialCode:        '',
      materialName:        '',
      itemGroup:           null,
      variants:            null,
      outstanding:         null,
      qtyReceived:         1,
      qtyAccepted:         1,
      qtyRejected:         0,
      unitPriceCenti:      0,
      notes:               '',
    }]);
  };

  const pickItemForLine = (rid: string, code: string) => {
    const sku = (productsQ.data ?? []).find((p) => p.code === code);
    setLine(rid, {
      materialCode: code,
      materialName: sku?.name ?? code,
      itemGroup:    sku?.category ? sku.category.toLowerCase() : null,
    });
  };

  const pickBindingForLine = (rid: string, b: typeof bindings[number]) => {
    setLine(rid, {
      materialCode:   b.material_code,
      materialName:   b.material_name,
      unitPriceCenti: b.unit_price_centi,
      itemGroup:      categoryForCode(b.material_code) ?? null,
    });
  };

  // Append one manual line per checked SKU — prefilled from the supplier binding
  // (price) or the SKU master, deduped against lines already on the receipt.
  const addPickedItems = (codes: string[]) => {
    if (codes.length === 0) return;
    const mk = (code: string): DraftLine => {
      const b = supplierId ? bindings.find((x) => x.material_code === code) : undefined;
      const sku = (allSkusQ.data ?? []).find((p) => p.code === code);
      return {
        rid:                 `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${code}`,
        purchaseOrderItemId: null,
        materialKind:        'mfg_product',
        materialCode:        code,
        materialName:        b?.material_name ?? sku?.name ?? code,
        itemGroup:           categoryForCode(code) ?? (sku?.category ? sku.category.toLowerCase() : null),
        variants:            null,
        outstanding:         null,
        qtyReceived:         1,
        qtyAccepted:         1,
        qtyRejected:         0,
        unitPriceCenti:      b?.unit_price_centi ?? 0,
        notes:               '',
      };
    };
    setLines((prev) => {
      const kept = prev.filter((l) => l.materialCode.trim() !== '');
      const existing = new Set(kept.map((l) => l.materialCode));
      const fresh = codes.filter((c) => !existing.has(c)).map(mk);
      return [...kept, ...fresh];
    });
  };

  const pickerItems = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase();
    const base = (supplierId && bindings.length > 0)
      ? bindings.map((b) => ({ code: b.material_code, name: b.material_name, sub: `${b.supplier_sku ?? ''} · ${fmtRm(b.unit_price_centi, b.currency)}` }))
      : (allSkusQ.data ?? []).map((p) => ({ code: p.code, name: p.name, sub: p.category }));
    if (!q) return base;
    return base.filter((it) => it.code.toLowerCase().includes(q) || it.name.toLowerCase().includes(q));
  }, [supplierId, bindings, allSkusQ.data, pickerSearch]);

  const canSave = !!supplierId && lines.length > 0 &&
    lines.every((l) => l.qtyReceived >= 0);

  const onSave = async () => {
    if (!supplierId) {
      setDialog({ title: 'Pick a supplier', body: 'Choose the order you are receiving against, or pick a supplier for a manual receipt.' });
      return;
    }
    const realLines = lines.filter((l) => l.materialCode.trim());
    if (realLines.length === 0) {
      setDialog({ title: 'Add at least one item', body: 'Pick at least one SKU to receive.' });
      return;
    }
    if (!canSave) {
      setDialog({ title: 'Check the quantities', body: 'Each line must have a received qty of 0 or more.' });
      return;
    }
    try {
      const createRes = await create.mutateAsync({
        idempotencyKey: idemKey,
        // Backend (purchase-consignment-receives POST) reads
        // purchaseConsignmentOrderId / pcOrderItemId — NOT the PO's
        // purchaseOrderId / purchaseOrderItemId. Sending the wrong keys
        // dropped the PC-Order link (no pc_order_no snapshot) and silently
        // disabled the over-receipt guard.
        purchaseConsignmentOrderId: headerPoId,
        supplierId,
        warehouseId:     warehouseId || undefined,
        receivedAt,
        deliveryNoteRef: deliveryNoteRef || undefined,
        notes:           notes || undefined,
        items: realLines.map((l) => ({
          pcOrderItemId:       l.purchaseOrderItemId,
          materialKind:        l.materialKind,
          materialCode:        l.materialCode,
          materialName:        l.materialName,
          qtyReceived:         l.qtyReceived,
          qtyAccepted:         l.qtyReceived,
          qtyRejected:         0,
          unitPriceCenti:      l.unitPriceCenti,
          notes:               l.notes || undefined,
          itemGroup:           l.itemGroup,
          variants:            l.variants,
        })),
      });
      await post.mutateAsync(createRes.id);
      setDialog({
        title: `Receive ${createRes.grnNumber} created`,
        body: 'Received & posted.',
        goTo: `/scm/purchase-consignment-receives/${createRes.id}`,
      });
    } catch (err) {
      setDialog({ title: 'Save failed', body: err instanceof Error ? err.message : 'Something went wrong.' });
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Procurement"
        title={`New Purchase Consignment Receive${po?.po_number ? ` · ${po.po_number}` : ''}`}
        actions={
          <div className={styles.actions}>
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/purchase-consignment-receives/from-pc-order')}>
              <ArrowRightLeft {...ICON} /> From Purchase Consignment Order
            </Button>
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/purchase-consignment-receives')}>
              <X {...ICON} /> Cancel
            </Button>
            <Button variant="primary" size="md" onClick={onSave} disabled={saving}>
              <Save {...ICON} />
              {saving ? 'Saving…' : 'Create Purchase Consignment Receive'}
            </Button>
          </div>
        }
      />

      {/* Header card */}
      <section className={styles.card}>
        <div className={styles.cardHeader}><h2 className={styles.cardTitle}>Header</h2></div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid2}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Receive against Order</span>
              <select
                value={selPoId}
                onChange={(e) => setSelPoId(e.target.value)}
                className={styles.fieldInput}
                disabled={poListQ.isLoading || outstanding.length === 0}
              >
                <option value="">
                  {poListQ.isLoading ? 'Loading orders…'
                    : outstanding.length === 0 ? 'No outstanding orders — receive manually below'
                    : '— Pick an outstanding order (or leave blank for a manual receipt) —'}
                </option>
                {sortByText(outstanding).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.po_number} · {p.supplier?.name ?? p.supplier?.code ?? '—'} · {fmtDateOrDash(p.po_date)}
                    {p.status === 'PARTIALLY_RECEIVED' ? ' (partial)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Receive #</span>
              <input type="text" readOnly value="(assigned on Save)" className={styles.fieldInput} style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Supplier *</span>
              {isManual ? (
                <select
                  value={manualSupplierId}
                  onChange={(e) => setManualSupplierId(e.target.value)}
                  className={styles.fieldInput}
                  disabled={suppliersQ.isLoading}
                >
                  <option value="">{suppliersQ.isLoading ? 'Loading suppliers…' : '— Pick a supplier —'}</option>
                  {sortByText(suppliersQ.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
                  ))}
                </select>
              ) : (
                <input type="text" readOnly value={supplierName ?? '(auto-filled from order)'} className={styles.fieldInput} style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
              )}
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Name</span>
              <input
                type="text"
                readOnly
                value={supplier?.name ?? supplierName ?? ''}
                placeholder="(auto-filled when supplier selected)"
                className={styles.fieldInput}
                style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
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
              <span className={styles.fieldLabel}>Receive into</span>
              <select
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
                className={styles.fieldInput}
                disabled={warehousesQ.isLoading}
              >
                <option value="">{warehousesQ.isLoading ? 'Loading warehouses…' : '— Pick a warehouse —'}</option>
                {sortByText(warehousesQ.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>{w.code}</option>
                ))}
              </select>
              <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                Warehouse the received stock moves into.
              </span>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Received Date</span>
              <input type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} className={styles.fieldInput} />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Delivery Note Ref</span>
              <input type="text" value={deliveryNoteRef} onChange={(e) => setDeliveryNoteRef(e.target.value)} placeholder="Supplier's DN # (optional)" className={styles.fieldInput} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Receiving notes — visible on the detail page" className={styles.fieldInput} rows={2} style={{ resize: 'vertical', minHeight: 60 }} />
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
              {supplier.phone          && <span>Phone: <strong>{supplier.phone}</strong></span>}
              {supplier.email          && <span>Email: <strong>{supplier.email}</strong></span>}
              {supplier.payment_terms  && <span>Terms: <strong>{supplier.payment_terms}</strong></span>}
              <span>Currency: <strong>{supplier.currency ?? currency}</strong></span>
            </div>
          )}
        </div>
      </section>

      {/* Items card */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            {selPoId
              ? (poQ.isLoading
                  ? 'Loading order items…'
                  : lines.length === 0
                    ? 'No outstanding lines on this order (all qty already received)'
                    : `${lines.length} line${lines.length === 1 ? '' : 's'} · ${totalQty} qty · subtotal ${fmtRm(subtotalCenti, currency)}`)
              : lines.length === 0
                ? 'Manual receipt — pick a supplier above, then add items below'
                : `${lines.length} line${lines.length === 1 ? '' : 's'} · ${totalQty} qty · subtotal ${fmtRm(subtotalCenti, currency)}`}
            {isManual && supplierId && (
              <span style={{ display: 'block', marginTop: 2, color: 'var(--c-burnt)' }}>
                {bindings.length > 0
                  ? `${bindings.length} item${bindings.length === 1 ? '' : 's'} bound to this supplier — picker filters to these`
                  : 'No SKUs bound to this supplier yet — picker shows all SKUs (one-off receipt)'}
              </span>
            )}
          </span>
        </div>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {lines.length === 0 ? (
            <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)', padding: 'var(--space-3) 0' }}>
              {isManual
                ? 'Pick a supplier in the header, then use “Add another item” below to receive items by hand.'
                : 'Choose an order in the header to receive against it.'}
            </p>
          ) : (
            lines.map((l, idx) => {
              const lineValueCenti = l.qtyReceived * l.unitPriceCenti;
              const variantSummary = buildVariantSummary(l.itemGroup, l.variants);
              const cap = l.outstanding;
              const isManualLine = l.purchaseOrderItemId === null;
              const showVariantEditor =
                isManualLine &&
                (l.itemGroup === 'bedframe' || l.itemGroup === 'sofa') &&
                !!maint;
              const setVariant = (key: string, value: unknown) =>
                setLine(l.rid, { variants: (() => {
                  const variants: Record<string, unknown> = { ...(l.variants ?? {}), [key]: value };
                  if (l.itemGroup === 'bedframe' && (key === 'divanHeight' || key === 'legHeight' || key === 'gap')) {
                    const d = parseInches(variants.divanHeight);
                    const lg = parseInches(variants.legHeight);
                    const g = parseInches(variants.gap);
                    variants.totalHeight = (d === 0 && lg === 0 && g === 0) ? '' : `${d + lg + g}"`;
                  }
                  return variants;
                })() });

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
                      {l.itemGroup && <ItemGroupPill group={l.itemGroup} />}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                      <span className={styles.previewPrice}>{fmtRm(lineValueCenti, currency)}</span>
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

                  {/* Identity row — Item Code (Internal) + Description */}
                  <div className={styles.formGrid2}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Item Code (Internal)</span>
                      {isManualLine ? (
                        <>
                          <input
                            type="text"
                            list={`pcr-products-${l.rid}`}
                            value={l.materialCode}
                            onChange={(e) => {
                              const code = e.target.value;
                              setProductQuery(code);
                              const bound = supplierId
                                ? bindings.find((b) => b.material_code === code)
                                : undefined;
                              if (bound) { pickBindingForLine(l.rid, bound); return; }
                              const match = (productsQ.data ?? []).find((p) => p.code === code);
                              if (match) { pickItemForLine(l.rid, code); return; }
                              setLine(l.rid, { materialCode: code });
                            }}
                            placeholder={supplierId && bindings.length > 0
                              ? 'Pick one of this supplier’s bound SKUs…'
                              : 'Type ≥2 chars to search SKUs by code or name…'}
                            className={styles.fieldInput}
                            style={{ fontFamily: 'var(--font-mono)' }}
                          />
                          <datalist id={`pcr-products-${l.rid}`}>
                            {supplierId && bindings.length > 0
                              ? sortByText(bindings).map((b) => (
                                  <option key={b.id} value={b.material_code}>
                                    {b.material_name} · {b.supplier_sku} · {fmtRm(b.unit_price_centi, b.currency)}
                                  </option>
                                ))
                              : sortByText(productsQ.data ?? []).map((p) => (
                                  <option key={p.id} value={p.code}>{p.name} · {p.category}</option>
                                ))}
                          </datalist>
                        </>
                      ) : (
                        <input
                          type="text"
                          readOnly
                          value={l.materialCode}
                          className={styles.fieldInput}
                          style={{ fontFamily: 'var(--font-mono)', background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
                        />
                      )}
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Description</span>
                      <input
                        type="text"
                        value={l.materialName}
                        onChange={(e) => setLine(l.rid, { materialName: e.target.value })}
                        readOnly={!isManualLine}
                        placeholder={isManualLine ? '(auto-filled when an item is picked — editable)' : ''}
                        className={styles.fieldInput}
                        style={!isManualLine ? { background: 'var(--c-cream)', color: 'var(--fg-muted)' } : undefined}
                      />
                    </label>
                  </div>

                  {!isManualLine && variantSummary && (
                    <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{variantSummary}</div>
                  )}

                  {showVariantEditor && (
                    <div style={{
                      background: 'var(--c-cream)',
                      border: '1px solid var(--line)',
                      borderRadius: 'var(--radius-md)',
                      padding: 'var(--space-3)',
                    }}>
                      <div style={{
                        fontFamily: 'var(--font-button)', fontSize: 'var(--fs-11)', fontWeight: 700,
                        letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--fg-muted)',
                        marginBottom: 'var(--space-2)',
                      }}>{l.itemGroup} Variants</div>
                      <PcVariantEditor
                        category={l.itemGroup ?? ''}
                        itemCode={l.materialCode}
                        variants={(l.variants ?? {}) as Record<string, unknown>}
                        onChange={setVariant}
                        fabrics={fabrics}
                        maint={maint!}
                      />
                    </div>
                  )}

                  {/* Fields row — Outstanding · Received · Unit Price · Line Value. */}
                  <div className={styles.formGrid4}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Outstanding</span>
                      <input
                        type="text"
                        readOnly
                        value={cap ?? '—'}
                        className={styles.fieldInput}
                        style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Received</span>
                      <input type="number" min={0} max={cap ?? undefined} value={l.qtyReceived}
                        onChange={(e) => {
                          let v = Math.max(0, Number(e.target.value) || 0);
                          if (cap != null) v = Math.min(cap, v);
                          setLine(l.rid, { qtyReceived: v, qtyAccepted: v, qtyRejected: 0 });
                        }}
                        className={styles.fieldInput} style={{ textAlign: 'right' }} />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Unit Price ({currency})</span>
                      <MoneyInput bare valueSen={l.unitPriceCenti}
                        onCommit={(sen) => setLine(l.rid, { unitPriceCenti: sen ?? 0 })}
                        inputClassName={styles.fieldInput} selectOnFocus />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Line Value</span>
                      <input
                        type="text"
                        readOnly
                        value={fmtRm(lineValueCenti, currency)}
                        className={styles.fieldInput}
                        style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', background: 'var(--c-cream)', color: 'var(--fg-muted)' }}
                      />
                    </label>
                  </div>
                </div>
              );
            })
          )}

          {isManual && (
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <button
                type="button"
                onClick={() => { setPickerSel(new Set()); setPickerSearch(''); setPickerOpen(true); }}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  flex: 1, padding: '12px 14px',
                  border: '1px solid var(--c-orange)', borderRadius: 'var(--radius-md)',
                  background: 'rgba(232, 107, 58, 0.08)', color: 'var(--c-burnt)',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', fontWeight: 600, cursor: 'pointer',
                }}
              >
                <ListChecks {...ICON} /> Pick items (multi-select)
              </button>
              <button
                type="button"
                onClick={addEmptyManualLine}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  flex: 1, padding: '12px 14px',
                  border: '1px dashed var(--c-orange)', borderRadius: 'var(--radius-md)',
                  background: 'transparent', color: 'var(--c-orange)',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', fontWeight: 600, cursor: 'pointer',
                }}
              >
                <Plus {...ICON} /> Add another item
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Totals card aligned right — lg:pr-32 clears the fixed FAB cluster. */}
      <div className="lg:pr-32" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <section className={styles.card} style={{ maxWidth: 360, width: '100%' }}>
          <div className={styles.cardBody}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-14)', marginBottom: 'var(--space-2)' }}>
              <span>Total qty</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{totalQty}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-14)', marginBottom: 'var(--space-2)' }}>
              <span>Subtotal</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(subtotalCenti, currency)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-16)', fontWeight: 700, borderTop: '1px solid var(--line)', paddingTop: 'var(--space-2)' }}>
              <span>Total</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(subtotalCenti, currency)}</span>
            </div>
          </div>
        </section>
      </div>

      {pickerOpen && (
        <div
          onClick={() => setPickerOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(34,31,32,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 'var(--space-4)' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: 'var(--c-paper)', borderRadius: 'var(--radius-lg)', width: '100%', maxWidth: 560, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 32px rgba(0,0,0,0.18)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'var(--space-4)', borderBottom: '1px solid var(--line)' }}>
              <h3 style={{ margin: 0, fontSize: 'var(--fs-16)' }}>Pick items to receive</h3>
              <button type="button" onClick={() => setPickerOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-muted)', display: 'inline-flex' }}><X {...ICON} /></button>
            </div>
            <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
              <input
                type="text" autoFocus value={pickerSearch}
                onChange={(e) => setPickerSearch(e.target.value)}
                placeholder="Search by code or name…"
                className={styles.fieldInput}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ overflowY: 'auto', padding: '0 var(--space-4)', flex: 1 }}>
              {pickerItems.length === 0 ? (
                <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)', padding: 'var(--space-3) 0' }}>
                  {supplierId ? 'No items match.' : 'Pick a supplier in the header first.'}
                </p>
              ) : pickerItems.map((it) => {
                const on = pickerSel.has(it.code);
                const already = lines.some((l) => l.materialCode === it.code);
                return (
                  <label key={it.code} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: '8px 0', borderBottom: '1px solid var(--line)', cursor: already ? 'default' : 'pointer', opacity: already ? 0.5 : 1 }}>
                    <input
                      type="checkbox" checked={on} disabled={already}
                      onChange={() => setPickerSel((s) => { const n = new Set(s); if (n.has(it.code)) n.delete(it.code); else n.add(it.code); return n; })}
                    />
                    <span style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-13)' }}>{it.code}{already ? ' · added' : ''}</span>
                      <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{it.name}{it.sub ? ` · ${it.sub}` : ''}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', padding: 'var(--space-4)', borderTop: '1px solid var(--line)' }}>
              <Button variant="ghost" size="md" onClick={() => setPickerOpen(false)}>Cancel</Button>
              <Button
                variant="primary" size="md" disabled={pickerSel.size === 0}
                onClick={() => { addPickedItems([...pickerSel]); setPickerSel(new Set()); setPickerSearch(''); setPickerOpen(false); }}
              >
                Add {pickerSel.size > 0 ? `${pickerSel.size} ` : ''}item{pickerSel.size === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {dialog && (
        <ActionResultDialog
          title={dialog.title}
          body={dialog.body}
          primaryLabel={dialog.goTo ? 'Open Receive' : undefined}
          onPrimary={dialog.goTo ? () => { const g = dialog.goTo!; setDialog(null); navigate(g); } : undefined}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
};
