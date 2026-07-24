// ----------------------------------------------------------------------------
// PurchaseConsignmentOrderDetail — full-page route at /scm/purchase-consignment-orders/:id.
//
// Faithful clone of PurchaseOrderDetail.tsx: a draft-style View → Edit →
// Save/Back machine. It reuses the SAME shared components UNCHANGED —
// MoneyInput, the supplier picker + supplier / warehouse data hooks — and (T12)
// the SAME rich line editor as Create via the shared PcLineCard.
//
// T12 (owner 2026-06-19) — Edit mode now drives one PcLineCard per line, the SAME
// rich editor as Create (mirrors PurchaseOrderDetail). PCO is the free-entry head
// of the consignment family, so Edit gets a "+ add item" too. The single top Save
// diffs each draft and add/update/deletes via the pc-order item hooks. PcLineCard
// wraps the shared PcVariantEditor (never PoLineCard — that's reserved for PO/PI).
//
// Dropped from the PO clone (per scope): the "From Sales Order" picker, the
// per-line "Received (GRN)" breakdown column (consignment receiving lives on
// the parallel Purchase Consignment Receive flow), Print PDF + Relationship Map
// stay (vendored). Receive Goods / Raise Return point at the parallel
// consignment receive / return New pages.
//
// HOUZS mig-0181 caveat: Houzs's consignment schema lacks the
// supplier_delivery_date_2/3/4 columns. PcLineCard's per-line "Supplier Date
// 2/3/4" inputs ride the draft only (display-only, harmless). At the PAGE level
// we do NOT read or send those columns — no header 0181 fields, no
// effectiveDelivery "revised" display; Expected Delivery is plain expected_at.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Pencil, Plus, Printer, Trash2, Save, Ban, ChevronDown,
} from 'lucide-react';
import { Button } from '@2990s/design-system';
import { formatPhone } from '@2990s/shared/phone';
import { buildVariantSummary } from '@2990s/shared';
import {
  usePurchaseConsignmentOrderDetail,
  useUpdatePurchaseConsignmentOrderHeader,
  useAddPurchaseConsignmentOrderItem,
  useUpdatePurchaseConsignmentOrderItem,
  useDeletePurchaseConsignmentOrderItem,
  useCancelPurchaseConsignmentOrder,
  useDeletePurchaseConsignmentOrder,
} from '../../vendor/scm/lib/purchase-consignment-order-queries';
import {
  useSuppliers,
  useSupplierDetail,
  type BindingRow,
  type PoItemRow,
  type SupplierRow,
} from '../../vendor/scm/lib/suppliers-queries';
import { useMfgProducts, useMaintenanceConfig } from '../../vendor/scm/lib/mfg-products-queries';
import { useFabricTrackings } from '../../vendor/scm/lib/fabric-queries';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import {
  computeMfgPoUnitCost,
  type MfgFabricTier,
  type PoPriceMatrix,
} from '@2990s/shared/mfg-pricing';
import { PcLineCard, emptyPcLine, type PcLineDraft } from '../../vendor/scm/components/PcLineCard';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import { RelationshipMapButton } from '../../vendor/scm/components/RelationshipMapButton';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
};

type HeaderDraft = {
  supplierId: string;
  poDate: string;
  expectedAt: string;
  currency: string;
  notes: string;
  purchaseLocationId: string;
};

/* Whole-line edit (T12) — Edit mode drives one PcLineCard per line, the SAME rich
   editor as Create. EditLine = the shared PcLineDraft + the persisted item id
   (absent on a freshly-added blank card). */
type EditLine = PcLineDraft & { itemId?: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const headerSnapshot = (p: any): HeaderDraft => ({
  supplierId:            p.supplier_id ?? '',
  poDate:                p.po_date ?? '',
  expectedAt:            p.expected_at ?? '',
  currency:              p.currency ?? 'MYR',
  notes:                 p.notes ?? '',
  purchaseLocationId:    p.purchase_location_id ?? '',
});

/* Map a persisted PCO line → an editable PcLineCard draft. mig-0181: Houzs lacks
   supplier_delivery_date_2/3/4 on the line, so we don't read them here. */
const draftFromItem = (it: PoItemRow): EditLine => ({
  rid:            `i${it.id}`,
  itemId:         it.id,
  bindingId:      it.binding_id ?? undefined,
  materialKind:   it.material_kind,
  materialCode:   it.material_code,
  materialName:   it.material_name,
  supplierSku:    it.supplier_sku ?? undefined,
  qty:            it.qty,
  unitPriceCenti: it.unit_price_centi,
  discountCenti:  it.discount_centi ?? 0,
  deliveryDate:   it.delivery_date ?? undefined,
  warehouseId:    it.warehouse_id ?? undefined,
  category:       it.item_group ?? undefined,
  variants:       (it.variants as Record<string, unknown> | null) ?? {},
  /* An existing line's stored price is authoritative — don't let the cost
     auto-recompute clobber it on enter-edit. Editing variants re-arms it. */
  priceTouched:   true,
});

export const PurchaseConsignmentOrderDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const detail = usePurchaseConsignmentOrderDetail(id ?? null);
  const updateHeader = useUpdatePurchaseConsignmentOrderHeader();
  const cancel = useCancelPurchaseConsignmentOrder();
  const deletePo = useDeletePurchaseConsignmentOrder();
  const addItem = useAddPurchaseConsignmentOrderItem();
  const updateItem = useUpdatePurchaseConsignmentOrderItem();
  const deleteItem = useDeletePurchaseConsignmentOrderItem();
  const askConfirm = useConfirm();
  const notify = useNotify();

  const po = detail.data?.purchaseOrder ?? null;
  /* Backend (purchase-consignment-orders detail) returns pc_number, not the
     PO's po_number — the PoHeaderRow type is shared with real POs. Read
     pc_number first with a po_number fallback so the doc number renders. */
  const pcNo = (po as { pc_number?: string } | null)?.pc_number ?? po?.po_number ?? '';
  /* Memoised so the edit-mode seed + cost-recompute effects don't re-fire on
     every render. */
  const items = useMemo(() => detail.data?.items ?? [], [detail.data?.items]);

  /* ── Whole-line editor data (T12) — the SAME lookups Create uses so PcLineCard
     renders identically in Edit. Bindings come from the PCO's supplier; allSkus
     is the catalogue fallback; maint + fabrics drive the variant dropdowns. */
  const poSupplierId = po?.supplier_id ?? '';
  const supplierDetailQ = useSupplierDetail(poSupplierId || null);
  const bindings = useMemo(() => supplierDetailQ.data?.bindings ?? [], [supplierDetailQ.data?.bindings]);
  const allSkusQ = useMfgProducts();
  const allSkus = useMemo(() => allSkusQ.data ?? [], [allSkusQ.data]);
  const warehousesQ = useWarehouses();
  const warehousesForLines = warehousesQ.data ?? [];
  const supplierMaintQ = useMaintenanceConfig(
    poSupplierId ? `supplier:${poSupplierId}` : '',
    { enabled: Boolean(poSupplierId) },
  );
  const masterMaintQ = useMaintenanceConfig('master', {
    enabled: !poSupplierId || !supplierMaintQ.data?.data,
  });
  const maint = supplierMaintQ.data?.data ?? masterMaintQ.data?.data ?? null;
  const fabrics = useFabricTrackings().data ?? [];

  const categoryForCode = (code: string): string | undefined =>
    allSkus.find((p) => p.code === code)?.category.toLowerCase();

  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get('edit') === '1');

  const [headerDraft, setHeaderDraft] = useState<HeaderDraft | null>(null);
  const [editLines, setEditLines] = useState<EditLine[]>([]);
  const [savingDraft, setSavingDraft] = useState(false);

  const hasChildren = Boolean(po?.has_children);
  const isLocked = po ? (!(po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED') || hasChildren) : true;
  const lockedDueToChildren = po ? ((po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED') && hasChildren) : false;

  useEffect(() => {
    if (isLocked && isEditing) {
      setIsEditing(false);
      setHeaderDraft(null);
      setEditLines([]);
    }
  }, [isLocked, isEditing]);

  /* Seed/clear the whole-line drafts (T12) — entering Edit populates a PcLineCard
     draft for EVERY current line; leaving Edit wipes them. */
  useEffect(() => {
    if (!isEditing) { setEditLines([]); return; }
    setEditLines(items.map(draftFromItem));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, items]);

  /* Cost auto-recompute (mirrors Create) — resolve a line's supplier price
     matrix + maintenance surcharges into a unit cost. A manually-touched line
     keeps its typed value. */
  const fabricTierForLine = (line: EditLine): MfgFabricTier | null => {
    const code = String(line.variants.fabricCode ?? '');
    if (!code) return null;
    const f = fabrics.find((x) => x.fabric_code === code);
    if (!f) return null;
    const cat = line.category?.toLowerCase();
    if (cat === 'sofa')     return f.sofa_price_tier ?? f.price_tier ?? null;
    if (cat === 'bedframe') return f.bedframe_price_tier ?? f.price_tier ?? null;
    return null;
  };
  const recomputeLineCost = (line: EditLine): number => {
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

  useEffect(() => {
    if (!isEditing) return;
    setEditLines((prev) => {
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
  }, [isEditing, bindings, fabrics, maint, editLines]);

  if (detail.isPending) {
    return <SkeletonDetailPage />;
  }
  if (detail.isError || !po) {
    return (
      <div className="space-y-4">
        <Link to="/scm/purchase-consignment-orders" className={styles.backBtn}>
          <ArrowLeft {...ICON} />
          <span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Purchase consignment order not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  const visibleItems = items;

  /* Per-line "Received" drill-down — which PC Receive took how much (backend
     attaches `receipts` per item via pcoLineReceipts). Mirrors the PO detail. */
  const renderReceived = (it: PoItemRow) => {
    const row = it as unknown as {
      qty?: number;
      received_qty?: number;
      receipts?: Array<{ receiveNumber: string; qty: number; status: string }>;
    };
    const receipts = row.receipts ?? [];
    if (receipts.length === 0) return <span className={styles.muted}>—</span>;
    const remaining = Math.max(0, (it.qty ?? 0) - (row.received_qty ?? 0));
    return (
      <div>
        {receipts.map((r, ri) => (
          <div key={ri} style={{ fontWeight: 600, whiteSpace: 'nowrap', fontSize: 'var(--fs-12)' }}>
            {r.receiveNumber} <span className={styles.muted} style={{ fontWeight: 400 }}>×{r.qty}</span>
          </div>
        ))}
        <div style={{
          fontSize: 'var(--fs-11)', marginTop: 1,
          color: remaining > 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--c-secondary-a, #2F5D4F)',
        }}>
          {remaining > 0 ? `Balance ${remaining}` : 'Fully received'}
        </div>
      </div>
    );
  };

  /* Totals — in Edit, sum the live editLines; in View, the stored line totals. */
  const itemsSubtotal = isEditing
    ? editLines.reduce((s, d) => s + Math.max(0, d.qty * d.unitPriceCenti - (d.discountCenti ?? 0)), 0)
    : visibleItems.reduce((s, it) => s + (it.line_total_centi ?? 0), 0);
  const grandTotal = itemsSubtotal + (po.tax_centi ?? 0);

  const headerView = headerDraft ?? headerSnapshot(po);

  const handlePrint = () => {
    import('../../vendor/scm/lib/purchase-order-pdf')
      .then(({ generatePurchaseOrderPdf }) =>
        generatePurchaseOrderPdf(po as never, items as never, { docTitle: 'PURCHASE CONSIGNMENT ORDER' }))
      .catch((e) => notify({ title: 'PDF generation failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' }));
  };

  const setHeaderField = (k: keyof HeaderDraft, v: string) => {
    setHeaderDraft((h) => ({ ...(h ?? headerSnapshot(po)), [k]: v }));
    // Header Expected Delivery cascades to every line's delivery date.
    if (k === 'expectedAt') {
      setEditLines((prev) => prev.map((d) => ({ ...d, deliveryDate: v || undefined })));
    }
  };

  /* Patch one editLine by rid (mirrors Create's setLine). */
  const patchLine = (rid: string, patch: Partial<EditLine>) =>
    setEditLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));

  /* Adopt a supplier binding into a line (mirrors Create's pickBinding). */
  const pickBinding = (rid: string, b: BindingRow) =>
    patchLine(rid, {
      bindingId:      b.id,
      materialKind:   b.material_kind,
      materialCode:   b.material_code,
      materialName:   b.material_name,
      supplierSku:    b.supplier_sku,
      unitPriceCenti: b.unit_price_centi,
      category:       categoryForCode(b.material_code),
      priceTouched:   false,
    });

  /* Patch one variant key + auto-compute bedframe Total Height, mirroring
     Create's setVariant. Editing a variant re-arms the cost auto-recompute. */
  const parseInches = (s: unknown): number => {
    if (s == null) return 0;
    const m = String(s).match(/(-?\d+(?:\.\d+)?)/);
    return m && m[1] ? Number(m[1]) : 0;
  };
  const setVariant = (rid: string, k: string, v: unknown) =>
    setEditLines((prev) => prev.map((l) => {
      if (l.rid !== rid) return l;
      const variants: Record<string, unknown> = { ...l.variants, [k]: v };
      if (l.category === 'bedframe' && (k === 'divanHeight' || k === 'legHeight' || k === 'gap')) {
        const d = parseInches(variants.divanHeight);
        const lg = parseInches(variants.legHeight);
        const g = parseInches(variants.gap);
        variants.totalHeight = (d === 0 && lg === 0 && g === 0) ? '' : `${d + lg + g}"`;
      }
      return { ...l, variants, priceTouched: false };
    }));

  /* Append a fresh blank PcLineCard (PCO is the free-entry head) — seeded with
     the header's default ship-to + expected delivery. Committed by the page Save. */
  const startAddLine = () =>
    setEditLines((prev) => [...prev, {
      ...emptyPcLine(),
      warehouseId:  po.purchase_location_id ?? undefined,
      deliveryDate: headerView.expectedAt || undefined,
    }]);

  /* Remove a line. A persisted line fires the delete mutation immediately; a
     never-saved blank card just drops from the draft array. */
  const removeLine = async (rid: string) => {
    const l = editLines.find((x) => x.rid === rid);
    if (!l) return;
    if (!l.itemId) { setEditLines((prev) => prev.filter((x) => x.rid !== rid)); return; }
    if (await askConfirm({
      title: 'Remove this line?',
      body: 'The line is removed from this consignment order.',
      confirmLabel: 'Remove',
      danger: true,
    })) {
      deleteItem.mutate(
        { poId: po.id, itemId: l.itemId },
        { onSuccess: () => setEditLines((prev) => prev.filter((x) => x.rid !== rid)) },
      );
    }
  };

  const enterEdit = () => {
    setHeaderDraft(null);
    setEditLines(items.map(draftFromItem));
    setIsEditing(true);
  };

  /* Single Save (T12) — whole-line diff. For each draft:
       · no itemId → ADD (full payload incl. variants / materialCode / SKU)
       · itemId + changed any field → UPDATE (full payload)
     Deletes already fired server-side in removeLine. Then commit the header (if
     touched) and drop back to View.

     HOUZS mig-0181: no supplier_delivery_date_2/3/4 in the payload (those
     columns don't exist on Houzs's consignment schema). */
  const handleSave = async () => {
    if (savingDraft) return;
    const blankLine = editLines.find((d) => !d.materialCode.trim());
    if (blankLine) {
      notify({ title: 'Every line needs a product', body: 'Pick a product for each line, or remove the empty one before saving.', tone: 'error' });
      return;
    }
    setSavingDraft(true);
    try {
      if (headerDraft) {
        await updateHeader.mutateAsync({ id: po.id, ...(headerDraft as Record<string, unknown>) });
      }
      const byId = new Map(items.map((it) => [it.id, it]));
      for (const d of editLines) {
        if (!d.itemId) {
          await addItem.mutateAsync({
            poId: po.id,
            materialKind:   d.materialKind,
            materialCode:   d.materialCode,
            materialName:   d.materialName || d.materialCode,
            supplierSku:    d.supplierSku,
            qty:            d.qty,
            unitPriceCenti: d.unitPriceCenti,
            bindingId:      d.bindingId,
            discountCenti:  d.discountCenti,
            deliveryDate:   d.deliveryDate || undefined,
            warehouseId:    d.warehouseId  || undefined,
            itemGroup:      d.category,
            variants:       Object.keys(d.variants).length ? d.variants : undefined,
          });
          continue;
        }
        const it = byId.get(d.itemId);
        if (!it) continue;
        const changed =
          d.materialCode !== it.material_code ||
          (d.materialName || d.materialCode) !== it.material_name ||
          (d.supplierSku ?? '') !== (it.supplier_sku ?? '') ||
          (d.category ?? '') !== (it.item_group ?? '') ||
          d.qty !== it.qty ||
          d.unitPriceCenti !== it.unit_price_centi ||
          (d.discountCenti ?? 0) !== (it.discount_centi ?? 0) ||
          (d.deliveryDate ?? null) !== (it.delivery_date ?? null) ||
          (d.warehouseId ?? null) !== (it.warehouse_id ?? null) ||
          JSON.stringify(d.variants ?? {}) !== JSON.stringify((it.variants as Record<string, unknown> | null) ?? {});
        if (!changed) continue;
        await updateItem.mutateAsync({
          poId: po.id, itemId: d.itemId,
          materialCode:   d.materialCode,
          materialName:   d.materialName || d.materialCode,
          supplierSku:    d.supplierSku,
          qty:            d.qty,
          unitPriceCenti: d.unitPriceCenti,
          discountCenti:  d.discountCenti ?? 0,
          deliveryDate:   d.deliveryDate ?? null,
          warehouseId:    d.warehouseId ?? null,
          itemGroup:      d.category,
          variants:       d.variants ?? {},
        });
      }
      setIsEditing(false);
      setHeaderDraft(null);
      setEditLines([]);
    } catch (e) {
      notify({ title: 'Save failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    } finally {
      setSavingDraft(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* ── Header ──────────────────────────────────────────────── */}
      <PageHeader back
        eyebrow="Procurement"
        title={`${pcNo} — ${po.supplier?.name ?? po.supplier?.code ?? '—'}`}
        actions={
          <div className={styles.actions}>
            <div className={styles.totalRail}>
              <span className={styles.totalRailLabel}>Total</span>
              <span className={styles.totalRailValue}>{fmtRm(grandTotal, po.currency)}</span>
            </div>
            <StatusPill docType="po" status={po.status} />
            <RelationshipMapButton type="pco" id={po.id} />
            <Button variant="ghost" size="md" onClick={handlePrint}>
              <Printer {...ICON} /><span>Print PDF</span>
            </Button>
            {(po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED') && (
              <Button variant="ghost" size="md"
                onClick={async () => {
                  if (!(await askConfirm({
                    title: `Cancel ${pcNo}?`,
                    body: 'This sets status to CANCELLED — line items + linked docs stay for audit.',
                    confirmLabel: 'Cancel PO',
                    danger: true,
                  }))) return;
                  cancel.mutate(po.id, {
                    onError: (err) => notify({ title: 'Cancel failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
                  });
                }}
                disabled={cancel.isPending}>
                <Ban {...ICON} />
                <span>{cancel.isPending ? 'Cancelling…' : 'Cancel'}</span>
              </Button>
            )}
            {po.status === 'CANCELLED' && (
              <Button variant="ghost" size="md"
                onClick={async () => {
                  if (!(await askConfirm({
                    title: `Permanently delete ${pcNo}?`,
                    body: 'This removes the header + all line items and cannot be undone.',
                    confirmLabel: 'Delete',
                    danger: true,
                  }))) return;
                  deletePo.mutate(po.id, {
                    onSuccess: () => navigate('/scm/purchase-consignment-orders'),
                    onError:   (err) => notify({ title: 'Delete failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
                  });
                }}
                disabled={deletePo.isPending}>
                <Trash2 {...ICON} />
                <span>{deletePo.isPending ? 'Deleting…' : 'Delete'}</span>
              </Button>
            )}
            {/* Receive Goods → /scm/purchase-consignment-receives/new?fromPcOrder=X */}
            {(po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED') && (
              <Button variant="primary" size="md"
                onClick={() => navigate(`/scm/purchase-consignment-receives/new?fromPcOrder=${po.id}`)}>
                <span>Receive Goods</span>
              </Button>
            )}
            {/* Raise Return → /scm/purchase-consignment-returns/new?fromPcOrder=X */}
            {(po.status === 'PARTIALLY_RECEIVED' || po.status === 'RECEIVED') && (
              <Button variant="ghost" size="md"
                onClick={() => navigate(`/scm/purchase-consignment-returns/new?fromPcOrder=${po.id}`)}>
                <span>Raise Return</span>
              </Button>
            )}
            {!isEditing ? (
              <Button variant="primary" size="md" onClick={enterEdit} disabled={isLocked}>
                <Pencil {...ICON} />
                <span>Edit</span>
              </Button>
            ) : (
              <Button variant="primary" size="md" onClick={handleSave} disabled={savingDraft}>
                <Save {...ICON} />
                <span>{savingDraft ? 'Saving…' : 'Save'}</span>
              </Button>
            )}
          </div>
        }
      />

      {lockedDueToChildren && (
        <div className={styles.bannerWarn} style={{ marginBottom: 'var(--space-3)' }}>
          <strong>Locked — has a Purchase Consignment Receive.</strong>{' '}
          Cancel or delete the downstream receive to edit this order again.
        </div>
      )}

      {/* ── Supplier / dates / currency / notes ─────────────────── */}
      <SupplierCard
        po={po}
        draft={headerView}
        onField={setHeaderField}
        locked={isLocked}
        isEditing={isEditing}
      />

      {/* ── Line items ──────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({isEditing ? editLines.length : visibleItems.length})</h2>
          {/* T12 — Edit mode restores the Create UI: a "+ Add item" that appends a
              blank PcLineCard (PCO is the free-entry head). Hidden while locked. */}
          {isEditing && !isLocked && (
            <Button variant="primary" size="sm" onClick={startAddLine}>
              <Plus {...ICON} />
              <span>Add item</span>
            </Button>
          )}
        </header>

        {isEditing ? (
          /* Whole-line inline edit (T12) — every line is a PcLineCard (the SAME
             editor as Create). The ONE page-level Save diffs each draft and
             add/update/deletes. */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-3)' }}>
            {editLines.map((l, idx) => (
              <PcLineCard
                key={l.rid}
                index={idx}
                line={l}
                currency={po.currency}
                supplierId={poSupplierId}
                bindings={bindings}
                allSkus={allSkus}
                warehouses={warehousesForLines}
                maint={maint}
                fabrics={fabrics}
                onChange={(patch) => patchLine(l.rid, patch)}
                onPickBinding={(b) => pickBinding(l.rid, b)}
                onSetVariant={(k, v) => setVariant(l.rid, k, v)}
                onPendingItemPick={() => {}}
                onRemove={() => removeLine(l.rid)}
                disabled={isLocked}
              />
            ))}
            {editLines.length === 0 && (
              <p className={styles.emptyRow} style={{ padding: 'var(--space-3)' }}>
                No items yet — click "Add item" above.
              </p>
            )}
          </div>
        ) : visibleItems.length === 0 ? (
          <p className={styles.emptyRow}>No items yet.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Group</th>
                <th className={styles.tableRight}>Qty</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Disc</th>
                <th className={styles.tableRight}>Total</th>
                <th className={styles.tableRight}>Delivery</th>
                <th>Received</th>
                <th className={styles.tableRight}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((it) => {
                const receivedRow = it as unknown as { received_qty?: number };
                const balance = Math.max(0, (it.qty ?? 0) - (receivedRow.received_qty ?? 0));
                return (
                  <tr key={it.id}>
                    <td>
                      <div className={styles.codeCell}>{it.material_code}</div>
                      {(() => {
                        const summary = buildVariantSummary(it.item_group, it.variants as Record<string, unknown> | null)
                          || it.description
                          || it.material_name;
                        return summary ? <div className={styles.muted} style={{ fontSize: 'var(--fs-11)' }}>{summary}</div> : null;
                      })()}
                    </td>
                    <td className={styles.muted}>{it.item_group ?? it.material_kind}</td>
                    <td className={styles.tableRight}>{it.qty}</td>
                    <td className={styles.tableRight}>{fmtRm(it.unit_price_centi, po.currency)}</td>
                    <td className={styles.tableRight}>{(it.discount_centi ?? 0) > 0 ? fmtRm(it.discount_centi, po.currency) : '—'}</td>
                    <td className={styles.priceCell}>{fmtRm(it.line_total_centi, po.currency)}</td>
                    <td className={styles.tableRight}>{it.delivery_date ?? '—'}</td>
                    <td>{renderReceived(it)}</td>
                    <td className={styles.tableRight} style={{ fontWeight: balance > 0 ? 600 : 400, color: balance > 0 ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)' }}>
                      {balance > 0 ? balance : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Totals ────────────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Totals</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.totalsGrid}>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Subtotal</span>
              <span className={styles.totalValue}>{fmtRm(itemsSubtotal, po.currency)}</span>
            </div>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Tax</span>
              <span className={styles.totalValue}>{fmtRm(po.tax_centi, po.currency)}</span>
            </div>
            <div className={`${styles.totalRow} ${styles.grandTotalRow}`}>
              <span className={styles.totalLabel}>Total</span>
              <span className={`${styles.totalValue} ${styles.grandTotal}`}>{fmtRm(grandTotal, po.currency)}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Supplier / header card — controlled by the page's draft.
   ════════════════════════════════════════════════════════════════════════ */

const SupplierCard = ({
  po, draft, onField, locked, isEditing = true,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  po: any;
  draft: HeaderDraft;
  onField: (k: keyof HeaderDraft, v: string) => void;
  locked: boolean;
  isEditing?: boolean;
}) => {
  const suppliersQ = useSuppliers();
  const suppliers = suppliersQ.data ?? [];
  const warehousesQ = useWarehouses();
  const warehouses = warehousesQ.data ?? [];
  const supplierIdForDetail = isEditing ? (draft.supplierId || null) : (po.supplier_id ?? null);
  const supplierDetail = useSupplierDetail(supplierIdForDetail);
  const supplier: SupplierRow | null = supplierDetail.data?.supplier ?? null;

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Supplier · Dates · Notes</h2>
      </header>
      <div className={styles.cardBody}>
        {!isEditing ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 'var(--space-3) var(--space-4)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-13)',
            }}
          >
            <div style={{ gridColumn: 'span 2' }}>
              <InfoCell label="Supplier"
                value={po.supplier?.name ?? po.supplier?.code ?? supplier?.name ?? supplier?.code ?? null} />
            </div>
            <InfoCell label="Currency" value={po.currency || null} />
            <div />
            <InfoCell label="Contact" value={supplier?.contact_person ?? supplier?.attention ?? null} />
            <InfoCell label="Phone" value={formatPhone(supplier?.phone ?? supplier?.mobile) || null} />
            <InfoCell label="Email" value={supplier?.email ?? null} />
            <div />
            <div style={{ gridColumn: 'span 2' }}>
              <InfoCell label="Address"
                value={[supplier?.address, supplier?.area, supplier?.postcode].filter(Boolean).join(', ') || null} />
            </div>
            <InfoCell label="Date" value={po.po_date || null} />
            {/* HOUZS mig-0181: plain expected_at — no effectiveDelivery "revised"
                display (Houzs lacks the supplier_delivery_date_2/3/4 columns). */}
            <InfoCell label="Expected Delivery" value={po.expected_at || null} />
            <InfoCell label="Purchase Location"
              value={(() => {
                const wh = warehouses.find((w) => w.id === po.purchase_location_id);
                return wh ? wh.code : null;
              })()} />
            <div style={{ gridColumn: 'span 2' }}>
              <InfoCell label="Notes" value={po.notes || null} />
            </div>
          </div>
        ) : (
        <div className={styles.formGrid4}>
          <label className={styles.field} style={{ gridColumn: 'span 2' }}>
            <span className={styles.fieldLabel}>Supplier *</span>
            <span className={styles.selectWrap}>
              <select className={styles.fieldSelect} value={draft.supplierId} disabled={locked}
                onChange={(e) => onField('supplierId', e.target.value)}>
                <option value="">— Pick supplier —</option>
                {sortByText(suppliers).map((s) => (
                  <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
                ))}
              </select>
              <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
            </span>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Currency</span>
            <span className={styles.selectWrap}>
              <select className={styles.fieldSelect} value={draft.currency} disabled={locked}
                onChange={(e) => onField('currency', e.target.value)}>
                <option value="MYR">MYR</option>
                <option value="RMB">RMB</option>
                <option value="USD">USD</option>
                <option value="SGD">SGD</option>
              </select>
              <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
            </span>
          </label>
          <div />
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Date</span>
            <input type="date" className={styles.fieldInput} value={draft.poDate} disabled={locked}
              onChange={(e) => onField('poDate', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Expected Delivery</span>
            <input type="date" className={styles.fieldInput} value={draft.expectedAt} disabled={locked}
              onChange={(e) => onField('expectedAt', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Purchase Location</span>
            <span className={styles.selectWrap}>
              <select className={styles.fieldSelect} value={draft.purchaseLocationId} disabled={locked}
                onChange={(e) => onField('purchaseLocationId', e.target.value)}>
                <option value="">— No default —</option>
                {sortByText(warehouses.filter((w) => w.is_active)).map((w) => (
                  <option key={w.id} value={w.id}>{w.code}</option>
                ))}
              </select>
              <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
            </span>
          </label>
          <label className={styles.field} style={{ gridColumn: 'span 2' }}>
            <span className={styles.fieldLabel}>Notes</span>
            <input className={styles.fieldInput} value={draft.notes} disabled={locked}
              onChange={(e) => onField('notes', e.target.value)} />
          </label>
        </div>
        )}

        {supplier && (
          <div
            style={{
              marginTop: 'var(--space-3)',
              padding: 'var(--space-3) var(--space-4)',
              background: 'var(--c-cream)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-md)',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 'var(--space-3) var(--space-4)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--fs-13)',
            }}
          >
            <InfoCell label="Supplier code" value={supplier.code} />
            <InfoCell label="Contact"       value={supplier.contact_person ?? supplier.attention} />
            <InfoCell label="Phone"         value={formatPhone(supplier.phone ?? supplier.mobile)} />
            <InfoCell label="Payment terms" value={supplier.payment_terms} />
            <InfoCell label="Email"         value={supplier.email} />
            <InfoCell label="TIN"           value={supplier.tin_number} />
            <InfoCell label="Country / state" value={[supplier.country, supplier.state].filter(Boolean).join(' / ') || null} />
            <InfoCell label="Bindings count" value={String(supplierDetail.data?.bindings?.length ?? 0)} />
            <div style={{ gridColumn: '1 / -1', color: 'var(--fg-muted)' }}>
              <span style={{ fontSize: 'var(--fs-11)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Address ·
              </span>{' '}
              {[supplier.address, supplier.area, supplier.postcode].filter(Boolean).join(', ') || '—'}
            </div>
          </div>
        )}
      </div>
    </section>
  );
};

function InfoCell({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div style={{
        fontSize: "var(--fs-11)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--fg-muted)",
        marginBottom: 2,
      }}>{label}</div>
      <div style={{ color: value ? "var(--fg)" : "var(--fg-muted)" }}>{value || "—"}</div>
    </div>
  );
}
