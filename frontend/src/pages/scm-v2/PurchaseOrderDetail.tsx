// ----------------------------------------------------------------------------
// PurchaseOrderDetail — full-page route at /scm/purchase-orders/:id (PR #41).
//
// Apply SO Detail template to PO so PO→GRN→PI conversions preserve all
// variant data (sofa color, bedframe D1/divan/leg/special).
//
//   1. Header: back button + PO# · supplier + status pill + actions
//   2. Supplier card: editable supplier picker + dates + currency + notes
//   3. Line items table: code + group + variants summary + qty + unit + total
//   4. Totals card: subtotal + total
//   5. Status flow: Draft → Submitted → Partially Received → Received | Cancelled
//
// Commander 2026-05-29 — PO Edit is a DRAFT (#194). Owner 2026-06-19 — Edit mode
// now drives one PoLineCard per line, the SAME rich editor as Create: per-line
// item/SKU picker, sofa/bedframe variant selects, Special Orders, +Add item,
// cost auto-recompute, and the qty/price/disc/delivery/ship-to row. Nothing
// persists until the single top Save:
//   • Save  → commits header changes + add/update/deletes every line draft
//   • Back  → leaves the page, discarding the draft (no auto-save)
//   • Delete (trash) asks an in-app confirm first, then removes the line on
//     confirm. A converted line's add/remove move SO quota server-side, so they
//     are immediate — deleting a converted line releases its SO quota straight
//     away so it reappears in the From-SO picker.
//   • Changing the header Expected Delivery cascades to every line's delivery.
//
// HOUZS VENDOR — verbatim from apps/backend/src/pages/PurchaseOrderDetail.tsx.
// Import boundary only: react-router → react-router-dom; ../lib/* + ../components/*
// → ../../vendor/scm/*; the @2990s/shared + @2990s/shared/mfg-pricing imports are
// verbatim; <Link>/navigate repointed to /scm/*. The migration-0180 supplier-
// revised header/line delivery-date inputs are DROPPED at the page level (Houzs's
// PO schema lacks those columns): PoLineCard still renders its Supplier Date 2/3/4
// inputs but the page never seeds or persists them (display-only, harmless).
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
// HOUZS VENDOR — Link + useSearchParams live on 'react-router-dom' in
// react-router v6 (the version Houzs ships); 2990 used v7 where they're on the
// unified 'react-router'. Only the import specifier changed.
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, FileText, Pencil, Plus, Trash2, Printer, Save, Ban, ArrowRightLeft,
  ChevronDown, RotateCcw, History, Check, Download, Send,
} from 'lucide-react';
import { Button } from '@2990s/design-system';
import { buildVariantSummary, fmtDateTime } from '@2990s/shared'; // Commander 2026-05-28 — Description 2
import { formatPhone } from '@2990s/shared/phone';
import {
  usePurchaseOrderDetail,
  useUpdatePurchaseOrderHeader,
  useAddPurchaseOrderItem,
  useUpdatePurchaseOrderItem,
  useDeletePurchaseOrderItem,
  useCancelPurchaseOrder,
  useConfirmPurchaseOrder,
  useReopenPurchaseOrder,
  useDeletePurchaseOrder,
  useSuppliers,
  useSupplierDetail,
  type BindingRow,
  type PoItemRow,
  type SupplierRow,
} from '../../vendor/scm/lib/suppliers-queries';
import { useMfgProducts, useMaintenanceConfig, useSpecialAddons } from '../../vendor/scm/lib/mfg-products-queries';
import { useFabricTrackings } from '../../vendor/scm/lib/fabric-queries';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import {
  computeMfgPoUnitCost,
  type MfgFabricTier,
  type PoPriceMatrix,
} from '@2990s/shared/mfg-pricing';
import { PoLineCard, emptyPoLine, type PoLineDraft } from '../../vendor/scm/components/PoLineCard';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import { RelationshipMapButton } from '../../vendor/scm/components/RelationshipMapButton';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import {
  useApprovePo,
  useSendAmendment,
  usePoRevisions,
  type SoRevisionRow,
} from '../../vendor/scm/lib/so-amendment-queries';
import styles from './SalesOrderDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
};

/* Draft state shapes (#194). HeaderDraft mirrors the editable header fields.
   Mig 0026 — supplier-revised header delivery dates ride through on save and
   fan down to lines that don't carry their own revised date. */
type HeaderDraft = {
  supplierId: string;
  poDate: string;
  expectedAt: string;
  supplierDeliveryDate2: string;
  supplierDeliveryDate3: string;
  supplierDeliveryDate4: string;
  currency: string;
  notes: string;
  purchaseLocationId: string;
};

/* Whole-line edit (owner 2026-06-19) — Edit mode now drives one PoLineCard per
   line, the SAME rich editor as Create. EditLine = the shared PoLineDraft +
   the persisted item id (absent on a freshly-added blank card). The page diffs
   each draft against the server row on Save and calls add / update / delete. */
type EditLine = PoLineDraft & { itemId?: string };

const headerSnapshot = (p: any): HeaderDraft => ({
  supplierId:            p.supplier_id ?? '',
  poDate:                p.po_date ?? '',
  expectedAt:            p.expected_at ?? '',
  supplierDeliveryDate2: p.supplier_delivery_date_2 ?? '',
  supplierDeliveryDate3: p.supplier_delivery_date_3 ?? '',
  supplierDeliveryDate4: p.supplier_delivery_date_4 ?? '',
  currency:              p.currency ?? 'MYR',
  notes:                 p.notes ?? '',
  purchaseLocationId:    p.purchase_location_id ?? '',
});

/* Map a persisted PO line → an editable PoLineCard draft. item_group is the
   PO's lowercase category convention; variants ride through untouched so the
   variant editor + Description-2 recompute see the full spec. Mig 0026 — the
   per-line supplier-revised dates are read so they round-trip on edit. */
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
  supplierDeliveryDate2: it.supplier_delivery_date_2 ?? undefined,
  supplierDeliveryDate3: it.supplier_delivery_date_3 ?? undefined,
  supplierDeliveryDate4: it.supplier_delivery_date_4 ?? undefined,
  warehouseId:    it.warehouse_id ?? undefined,
  category:       it.item_group ?? undefined,
  variants:       (it.variants as Record<string, unknown> | null) ?? {},
  /* An existing line's stored price is authoritative — don't let the cost
     auto-recompute clobber it on enter-edit. Editing the variants re-arms it. */
  priceTouched:   true,
});

export const PurchaseOrderDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const detail = usePurchaseOrderDetail(id ?? null);
  const updateHeader = useUpdatePurchaseOrderHeader();
  // PR-DRAFT-removal — Submit button removed (POs are SUBMITTED on create).
  const cancel = useCancelPurchaseOrder();
  const confirm = useConfirmPurchaseOrder();
  const reopen = useReopenPurchaseOrder();
  const deletePo = useDeletePurchaseOrder();
  const addItem = useAddPurchaseOrderItem();
  const updateItem = useUpdatePurchaseOrderItem();
  const deleteItem = useDeletePurchaseOrderItem();
  const askConfirm = useConfirm();
  const notify = useNotify();
  // PR #102 — PO PDF (AutoCount layout) needs the Purchase Location's
  // human-readable name; the header only carries the warehouse id. Load
  // warehouses once at the top so the print handler can resolve it.
  const warehousesQTop = useWarehouses();

  /* Phase 1-C — SO-amendment workflow (approve-po / send gates + revisions
     list). The green "Revision ready" banner hosts Approve PO (at SO_APPROVED)
     then Send + Download Revised PO (at PO_APPROVED); the Revisions tab lists
     prior PO snapshots. Buttons are gated on the Houzs scm.amendment.approve_po
     permission (the server 403 stays the real gate). */
  const { can } = useHouzsAuth();
  const approvePo = useApprovePo();
  const sendAmendment = useSendAmendment();
  /* Main content tab — 'order' = the existing detail view; 'revisions' lists
     prior PO snapshots read-only. Default 'order' so never-revised POs are
     unchanged. */
  const [activeTab, setActiveTab] = useState<'order' | 'revisions'>('order');

  const po = detail.data?.purchaseOrder ?? null;
  /* Memoised so the edit-mode seed + cost-recompute effects don't re-fire on
     every render (detail.data?.items is a fresh array each time otherwise). */
  const items = useMemo(() => detail.data?.items ?? [], [detail.data?.items]);

  /* ── Whole-line editor data (owner 2026-06-19) — the SAME lookups Create
     uses so PoLineCard renders identically in Edit. Bindings come from the PO's
     supplier; allSkus is the catalogue fallback; maint + fabrics drive the
     variant dropdowns; specialsPools feeds the Special Orders checkboxes. The
     supplier-scoped maintenance surcharges feed the cost auto-recompute (same
     supplier-then-master fallback as Create). */
  const poSupplierId = po?.supplier_id ?? '';
  const supplierDetailQ = useSupplierDetail(poSupplierId || null);
  const bindings = useMemo(() => supplierDetailQ.data?.bindings ?? [], [supplierDetailQ.data?.bindings]);
  const allSkusQ = useMfgProducts();
  const allSkus = useMemo(() => allSkusQ.data ?? [], [allSkusQ.data]);
  const warehousesForLines = warehousesQTop.data ?? [];
  const supplierMaintQ = useMaintenanceConfig(
    poSupplierId ? `supplier:${poSupplierId}` : '',
    { enabled: Boolean(poSupplierId) },
  );
  const masterMaintQ = useMaintenanceConfig('master', {
    enabled: !poSupplierId || !supplierMaintQ.data?.data,
  });
  const maint = supplierMaintQ.data?.data ?? masterMaintQ.data?.data ?? null;
  const fabrics = useFabricTrackings().data ?? [];
  const specialAddonsQ = useSpecialAddons();
  const specialsPools = useMemo(() => {
    const rows = (specialAddonsQ.data ?? [])
      .filter((r) => r.active)
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.code ?? '').localeCompare(b.code ?? ''));
    const pick = (cat: string) => rows.filter((r) => r.categories.includes(cat));
    return { bedframe: pick('BEDFRAME'), sofa: pick('SOFA') };
  }, [specialAddonsQ.data]);

  /* code → category (lowercased) lookup, mirroring Create's categoryForCode.
     Tags a line with which variant editor to show when a SKU is picked. */
  const categoryForCode = (code: string): string | undefined =>
    allSkus.find((p) => p.code === code)?.category.toLowerCase();

  /* View → Edit gate (Commander 2026-05-29) — default is read-only View; click
     Edit to flip into draft mode. The PO list's right-click "Edit" lands here
     with ?edit=1, so open straight into Edit in that case. */
  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get('edit') === '1');

  /* #194 draft buffers. headerDraft is null until the first header field is
     touched (then seeded from the PO).
     Owner 2026-06-19 — line edits are now WHOLE-LINE drafts (editLines), one
     PoLineCard per line, mirroring Create + SalesOrderDetail. Existing lines
     carry their itemId; a freshly-added blank card has none until Save inserts
     it. None of this persists until the single top Save. */
  const [headerDraft, setHeaderDraft] = useState<HeaderDraft | null>(null);
  const [editLines, setEditLines] = useState<EditLine[]>([]);
  const [savingDraft, setSavingDraft] = useState(false);

  // PR-DRAFT-removal — POs are always SUBMITTED on create (no DRAFT). Header
  // edits stay open while the PO can still be received (SUBMITTED / PARTIALLY_RECEIVED).
  // Tier 2 downstream-lock — also lock once a non-cancelled GRN exists; the GRN
  // must be cancelled / deleted before editing again. Partial receiving (more
  // GRNs) is still allowed via the list's Convert-to-GRN action.
  const hasChildren = Boolean(po?.has_children);
  /* Draft/Confirmed — a DRAFT PO is also editable (review + correct before
     confirming), alongside SUBMITTED / PARTIALLY_RECEIVED. A DRAFT never has a
     GRN child, so hasChildren can't lock it. RECEIVED / CANCELLED stay locked. */
  const isEditableStatus = po ? (po.status === 'DRAFT' || po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED') : false;
  const isLocked = po ? (!isEditableStatus || hasChildren) : true;
  const lockedDueToChildren = po ? (isEditableStatus && hasChildren) : false;

  /* If a PO locks while we're in Edit mode (e.g. it's Received / Cancelled
     after a status change), drop back to View and discard the draft so the
     page can never present editable controls on a locked PO. */
  useEffect(() => {
    if (isLocked && isEditing) {
      setIsEditing(false);
      setHeaderDraft(null);
      setEditLines([]);
    }
  }, [isLocked, isEditing]);

  /* Seed/clear the whole-line drafts (owner 2026-06-19) — entering Edit
     populates a PoLineCard draft for EVERY current line; leaving Edit wipes
     them. Re-seeds whenever the underlying items change (e.g. after a Save
     re-fetch). Mirrors SalesOrderDetail's edit-mode seed effect. */
  useEffect(() => {
    if (!isEditing) { setEditLines([]); return; }
    setEditLines(items.map(draftFromItem));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, items]);

  /* Cost auto-recompute (mirrors Create) — resolve a line's supplier price
     matrix + maintenance surcharges into a unit cost. Defined above the early
     returns (rules-of-hooks) since the effect below depends on them; they only
     close over bindings / fabrics / maint, none of which need `po`. A
     manually-touched line (priceTouched) keeps its typed value. */
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

  /* Cost auto-recompute effect — re-price every non-touched editLine off the
     supplier matrix + maintenance surcharges whenever a binding / variant /
     the maint or fabrics data changes. Only writes lines whose computed cost
     differs, so it doesn't loop. Gated to Edit mode. */
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
      <div className={styles.page}>
        <Link to="/scm/purchase-orders" className={styles.backBtn}>
          <ArrowLeft {...ICON} />
          <span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Purchase order not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  /* ── Draft helpers (po is guaranteed non-null past the guards above) ── */
  /* Owner 2026-06-19 — View shows the live server items; Edit drives editLines
     (one PoLineCard per line). Deletes are immediate server actions (they move
     SO quota), so a removed line's draft is dropped immediately and the delete
     mutation fires straight away — only the field/variant edits are buffered
     until the single top Save. */
  const visibleItems = items;
  /* SO→PO drift (Commander 2026-06-16) — lines whose source SO was edited AFTER
     this PO was raised, so the PO no longer matches the live SO. Only actionable
     while the PO is still open (pre-receipt): a received / cancelled PO can't be
     re-sent anyway, so we hide the warning there. */
  const driftCount = visibleItems.filter((it) => it.so_drift).length;
  const showDrift = po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED';
  /* Totals — in Edit, sum the live editLines (incl. unsaved variant/qty/price
     edits) so the rail can't drift; in View, the stored line totals. */
  const itemsSubtotal = isEditing
    ? editLines.reduce((s, d) => s + Math.max(0, d.qty * d.unitPriceCenti - (d.discountCenti ?? 0)), 0)
    : visibleItems.reduce((s, it) => s + (it.line_total_centi ?? 0), 0);
  const grandTotal = itemsSubtotal + (po.tax_centi ?? 0);

  /* Per-line "Received" cell (View only) — which Goods Receipt took how much off
     this line, plus the live balance still outstanding. Mirrors the SO
     "Delivered" column. Cancelled GRNs are already excluded server-side. */
  const renderReceived = (it: PoItemRow) => {
    const receipts = it.receipts ?? [];
    if (receipts.length === 0) return <span className={styles.muted}>—</span>;
    const remaining = Math.max(0, it.qty - (it.received_qty ?? 0));
    return (
      <div>
        {receipts.map((r, ri) => (
          <div key={ri} style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
            {r.grnNumber} <span className={styles.muted} style={{ fontWeight: 400 }}>×{r.qty}</span>
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

  const headerView = headerDraft ?? headerSnapshot(po);

  const setHeaderField = (k: keyof HeaderDraft, v: string) => {
    setHeaderDraft((h) => ({ ...(h ?? headerSnapshot(po)), [k]: v }));
    // Commander 2026-05-29 — header Expected Delivery cascades to every line's
    // delivery date ("上面的 Expected Delivery Date 换了之后，下面 Item 的
    // Delivery Date 也要跟着跳").
    if (k === 'expectedAt') {
      setEditLines((prev) => prev.map((d) => ({ ...d, deliveryDate: v || undefined })));
    }
    /* Mig 0026 — header supplier-revised dates fan down to every line that
       doesn't already carry its own value for that slot. */
    if (k === 'supplierDeliveryDate2') {
      setEditLines((prev) => prev.map((d) => (d.supplierDeliveryDate2 ? d : { ...d, supplierDeliveryDate2: v || undefined })));
    }
    if (k === 'supplierDeliveryDate3') {
      setEditLines((prev) => prev.map((d) => (d.supplierDeliveryDate3 ? d : { ...d, supplierDeliveryDate3: v || undefined })));
    }
    if (k === 'supplierDeliveryDate4') {
      setEditLines((prev) => prev.map((d) => (d.supplierDeliveryDate4 ? d : { ...d, supplierDeliveryDate4: v || undefined })));
    }
  };

  /* Patch one editLine by rid (mirrors Create's setLine). */
  const patchLine = (rid: string, patch: Partial<EditLine>) =>
    setEditLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));

  /* Adopt a supplier binding into a line (mirrors Create's pickBinding) — fills
     code + name + SKU + price + category and re-arms supplier-price auto-fill. */
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

  /* Patch one variant key + auto-compute bedframe Total Height (= Divan + Leg +
     Gap), mirroring Create's setVariant. Editing a variant re-arms the cost
     auto-recompute (priceTouched ← false) so the line re-prices off the new spec. */
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

  /* Append a fresh blank PoLineCard (mirrors SalesOrderDetail.startAddLine) —
     seeded with the PO's default ship-to + expected delivery so the new line
     inherits the header context. Committed by the page-level Save. */
  const startAddLine = () =>
    setEditLines((prev) => [...prev, {
      ...emptyPoLine(),
      warehouseId:  po.purchase_location_id ?? undefined,
      deliveryDate: headerView.expectedAt || undefined,
    }]);

  /* Remove a line. A persisted line fires the delete mutation immediately (it
     releases SO quota back to the From-SO picker — same as the old trash
     handler); a never-saved blank card just drops from the draft array. */
  const removeLine = async (rid: string) => {
    const l = editLines.find((x) => x.rid === rid);
    if (!l) return;
    if (!l.itemId) { setEditLines((prev) => prev.filter((x) => x.rid !== rid)); return; }
    if (await askConfirm({
      title: 'Remove this line?',
      body: 'The line is deleted and its converted SO quantity is released back to the From-SO picker.',
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

  /* Single Save (owner 2026-06-19) — whole-line diff. For each draft:
       · no itemId → ADD (full payload incl. variants / materialCode / SKU)
       · itemId + changed any field → UPDATE (full payload)
     Deletes already fired server-side in removeLine. Then commit the header (if
     touched) and drop back to View. */
  const handleSave = async () => {
    if (savingDraft) return;
    // Guard: every line must reference a product before Save.
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
          // New line — full insert payload.
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
            /* Mig 0026 — per-line supplier-revised delivery dates. */
            supplierDeliveryDate2: d.supplierDeliveryDate2 || undefined,
            supplierDeliveryDate3: d.supplierDeliveryDate3 || undefined,
            supplierDeliveryDate4: d.supplierDeliveryDate4 || undefined,
            warehouseId:    d.warehouseId  || undefined,
            itemGroup:      d.category,
            variants:       Object.keys(d.variants).length ? d.variants : undefined,
            soItemId:       d.soItemId ?? null,
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
          (d.supplierDeliveryDate2 ?? null) !== (it.supplier_delivery_date_2 ?? null) ||
          (d.supplierDeliveryDate3 ?? null) !== (it.supplier_delivery_date_3 ?? null) ||
          (d.supplierDeliveryDate4 ?? null) !== (it.supplier_delivery_date_4 ?? null) ||
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
          /* Mig 0026 — per-line supplier-revised delivery dates. */
          supplierDeliveryDate2: d.supplierDeliveryDate2 ?? null,
          supplierDeliveryDate3: d.supplierDeliveryDate3 ?? null,
          supplierDeliveryDate4: d.supplierDeliveryDate4 ?? null,
          warehouseId:    d.warehouseId ?? null,
          itemGroup:      d.category,
          variants:       d.variants ?? {},
        });
      }
      setIsEditing(false);
      setHeaderDraft(null);
      setEditLines([]);
    } catch (e) {
      notify({ title: 'Save failed', body: `${e instanceof Error ? e.message : 'Something went wrong.'}`, tone: 'error' });
    } finally {
      setSavingDraft(false);
    }
  };

  /* Client-side PO PDF generator. Shared by the header "Print PDF" and the
     amendment banner's "Download Revised PO" — the same generator, just an
     optional docTitle so the revised copy prints "Revised Purchase Order". The
     operator downloads / prints / WhatsApps it themselves (Houzs's "Send" only
     marks the amendment SENT — mirroring 2990, no server email here). */
  const generatePoPdf = (docTitle?: string) => {
    // PR #102 — pre-resolve purchase_location name (PDF can't hit the API).
    const wh = (warehousesQTop.data ?? []).find((w) => w.id === po.purchase_location_id);
    const headerForPdf = {
      ...po,
      // Owner 2026-07-24: DELIVER TO shows the warehouse CODE only (was the
      // dual "code · name", which read as a duplicated warehouse name).
      purchase_location_name: wh ? wh.code : null,
      // #1 (Commander 2026-06-18) — deliver-to address = the bound warehouse's
      // location text, so the supplier knows where to ship.
      delivery_address: wh?.location ?? null,
      // your_ref_no / source_so_doc_no don't have columns yet; pass through
      // when present on po (forward-compat). Schema follow-up adds them.
      your_ref_no:      (po as unknown as { your_ref_no?: string | null }).your_ref_no      ?? null,
      source_so_doc_no: (po as unknown as { source_so_doc_no?: string | null }).source_so_doc_no ?? null,
    };
    import('../../vendor/scm/lib/purchase-order-pdf').then(({ generatePurchaseOrderPdf }) =>
      generatePurchaseOrderPdf(headerForPdf, items, docTitle ? { docTitle } : undefined),
    ).catch((e) => notify({ title: 'PDF generation failed', body: `${e instanceof Error ? e.message : 'Something went wrong.'}`, tone: 'error' }));
  };
  const handlePrint = () => generatePoPdf();

  /* ── SO-amendment banner state (Phase 1-C) ─────────────────────────────────
     The bound PO detail stamps `open_amendment` when its source SO has an
     in-flight amendment (status NOT IN SENT/REJECTED). Once the SO revision is
     approved the amendment reaches SO_APPROVED → the Approve PO gate (revises
     this PO in place, bumps `revision`, snapshots the prior version to
     po_revisions) → PO_APPROVED → Send (marks SENT) + Download Revised PO. Perm
     gate is FE-hint only; the server 403 is the real gate. */
  const openAmendment = (po as unknown as { open_amendment?: { id: string; status: string; amendment_no: string } | null }).open_amendment ?? null;
  const canAmendAction = can('scm.amendment.approve_po');

  const handleApprovePo = () => {
    if (!openAmendment) return;
    askConfirm({
      title: `Approve PO ${po.po_number}?`,
      body: 'This applies the supplier-confirmed changes to this Purchase Order: it is re-derived in place '
        + '(same PO number, revision bumped) and the current version is snapshotted into Revisions. This cannot be undone.',
      confirmLabel: 'Approve PO',
    }).then((ok) => {
      if (!ok) return;
      approvePo.mutate({ id: openAmendment.id }, {
        onError: (e) => {
          /* approve-po may 409 with { code:'received_floor', poItemId, revisedQty,
             receivedQty } — the revised qty on a line is below what's already been
             received, so a Purchase Return must clear the excess first. Read the
             structured body off the thrown error (authed-fetch rides err.body /
             err.status) and render ONE plain sentence naming the line — never the
             raw JSON. Any other error falls back to its humanised message. */
          const body = (e as { body?: Record<string, unknown> }).body ?? null;
          if (body && body.code === 'received_floor') {
            /* Name the line by its MATERIAL, not by `poItemId.slice(0,8)` — a
               truncated uuid is still a uuid, and the operator cannot match
               "4bb54684" to anything on the page (owner 2026-07-16: 白話文).
               The PO's items are already loaded, so resolve it; if the id
               somehow isn't among them, say "One PO line" rather than print
               the id. */
            const hit = items.find((it) => it.id === String(body.poItemId ?? ''));
            const lineName = (hit?.material_name || hit?.material_code || '').trim();
            const revised = Number(body.revisedQty ?? 0);
            const received = Number(body.receivedQty ?? 0);
            notify({
              title: 'Cannot approve — quantity already received',
              body: (lineName
                ? `The line for ${lineName} would be revised down to ${revised}, but ${received} have already been received. `
                : `One PO line would be revised down to ${revised}, but ${received} have already been received. `)
                + 'Raise a Purchase Return for the excess first, then approve the amendment again.',
              tone: 'error',
            });
            return;
          }
          notify({ title: 'Could not approve the PO', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
        },
        onSuccess: (res) => {
          /* The revision succeeded, but reconciliation may have left something for
             a human: an already-received removed line kept on the PO, an added
             item whose supplier has no open PO, or a PO now with no lines. Show
             those plain-language notes rather than a bare "approved". */
          const warns = (res as { warnings?: string[] } | undefined)?.warnings ?? [];
          if (warns.length) {
            notify({ title: 'PO revision approved — please check a few items', body: warns.join(' '), tone: 'info' });
          } else {
            notify({ title: 'PO revision approved' });
          }
        },
      });
    });
  };

  const handleSendAmendment = () => {
    if (!openAmendment) return;
    askConfirm({
      title: `Mark amendment ${openAmendment.amendment_no} as sent?`,
      body: 'This marks the amendment SENT. There is no automatic email — download the Revised PO below and send it to the supplier yourself (print / WhatsApp).',
      confirmLabel: 'Mark sent',
    }).then((ok) => {
      if (!ok) return;
      sendAmendment.mutate({ id: openAmendment.id }, {
        onError: (e) => notify({ title: 'Could not mark sent', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' }),
        onSuccess: () => notify({ title: 'Amendment marked sent' }),
      });
    });
  };

  return (
    <div className={styles.page}>
      {/* Commander 2026-05-29 — dropped the GRNs/Invoice/Returns smart-button
          row + the "PO date · N lines · Expected" subtitle (not needed). */}

      {/* ── Header ──────────────────────────────────────────────── */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/scm/purchase-orders" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              {/* PR — Commander 2026-05-27: icon shrinks from 20 → 14 to
                  balance the fs-15 title. */}
              <FileText size={14} strokeWidth={1.75} style={{ color: 'var(--c-burnt)' }} />
              {po.po_number} — {po.supplier?.name ?? po.supplier?.code ?? '—'}
            </h1>
          </div>
        </div>
        <div className={styles.actions}>
          {/* PR — Commander 2026-05-27: align with SO Detail PR #231 — total
              moves into a right-rail KPI tile next to the action group so the
              page title stays compact. Commander 2026-05-29 — the total tracks
              the live line items (incl. unsaved draft edits). */}
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Total</span>
            <span className={styles.totalRailValue}>{fmtRm(grandTotal, po.currency)}</span>
          </div>
          <StatusPill docType="po" status={po.status} />
          {/* SO-amendment workflow — "Revised · rev N" badge once this PO has been
              revised in place by an approved amendment (revision > 1). */}
          {((po as unknown as { revision?: number }).revision ?? 1) > 1 && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 8px', borderRadius: 'var(--radius-pill, 999px)',
              background: 'rgba(47, 93, 79, 0.12)', color: 'var(--c-secondary-a, #2F5D4F)',
              fontSize: 'var(--fs-11)', fontWeight: 700, whiteSpace: 'nowrap',
            }}>
              <History size={12} strokeWidth={1.75} />
              Revised · rev {(po as unknown as { revision?: number }).revision}
            </span>
          )}
          <RelationshipMapButton type="po" id={po.id} />
          <Button variant="ghost" size="md" onClick={handlePrint}>
            <Printer {...ICON} />
            <span>Print PDF</span>
          </Button>
          {/* PR #78 — Convert from Sales Order. Gated behind Edit mode (it
              mutates line items). Commander 2026-05-29 — opens the full "Pick
              Sales Orders for this PO" picker scoped to this PO's supplier. */}
          {isEditing && (po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED') && (
            <Button
              variant="ghost"
              size="md"
              onClick={() => navigate(`/scm/purchase-orders/from-so?poId=${po.id}`)}
            >
              <ArrowRightLeft {...ICON} />
              <span>From Sales Order</span>
            </Button>
          )}
          {/* Draft/Confirmed — a DRAFT PO shows a primary Confirm. Confirming
              flips DRAFT -> SUBMITTED (commits the SO-quota advance + makes the
              PO live MRP supply / GRN-receivable). Hidden once committed. */}
          {po.status === 'DRAFT' && !isEditing && (
            <Button variant="primary" size="md"
              onClick={async () => {
                if (!(await askConfirm({
                  title: `Confirm PO ${po.po_number}?`,
                  body: 'This turns the draft into a live Purchase Order — it counts as MRP supply, locks the source SO lines, and becomes receivable (GRN).',
                  confirmLabel: 'Confirm PO',
                }))) return;
                confirm.mutate(po.id, {
                  onError: (err) => notify({ title: 'Confirm failed', body: `${err instanceof Error ? err.message : 'Something went wrong.'}`, tone: 'error' }),
                });
              }}
              disabled={confirm.isPending}>
              <span>{confirm.isPending ? 'Confirming…' : 'Confirm PO'}</span>
            </Button>
          )}
          {/* PR — Commander 2026-05-27: "Cancel/Delete PO 没反应".
              Cancel: any pre-receipt status (incl. DRAFT). API blocks RECEIVED.
              Delete: only CANCELLED. */}
          {(po.status === 'DRAFT' || po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED') && (
            <Button variant="ghost" size="md"
              onClick={async () => {
                if (!(await askConfirm({ title: `Cancel PO ${po.po_number}?`, body: 'This sets status to CANCELLED — line items + linked docs stay for audit.', confirmLabel: 'Cancel PO', danger: true }))) return;
                cancel.mutate(po.id, {
                  onError: (err) => notify({ title: 'Cancel failed', body: `${err instanceof Error ? err.message : 'Something went wrong.'}`, tone: 'error' }),
                });
              }}
              disabled={cancel.isPending}>
              <Ban {...ICON} />
              <span>{cancel.isPending ? 'Cancelling…' : 'Cancel'}</span>
            </Button>
          )}
          {/* Reopen a cancelled PO (Commander 2026-06-16 — "PO cancel 了 不可以
              uncancel 回来吗?"). Inverse of Cancel: back to SUBMITTED and the
              converted SO lines re-claim their quota. In-app confirm (no 裸奔). */}
          {po.status === 'CANCELLED' && (
            <Button variant="ghost" size="md"
              onClick={async () => {
                if (await askConfirm({
                  title: `Reopen PO ${po.po_number}?`,
                  body: 'Status returns to SUBMITTED and this PO re-claims its Sales-Order quota (those lines leave the From-SO picker again).',
                  confirmLabel: 'Reopen',
                })) {
                  reopen.mutate(po.id, {
                    onError: (err) => notify({ title: 'Reopen failed', body: `${err instanceof Error ? err.message : 'Something went wrong.'}`, tone: 'error' }),
                  });
                }
              }}
              disabled={reopen.isPending}>
              <RotateCcw {...ICON} />
              <span>{reopen.isPending ? 'Reopening…' : 'Reopen'}</span>
            </Button>
          )}
          {po.status === 'CANCELLED' && (
            <Button variant="ghost" size="md"
              onClick={async () => {
                if (!(await askConfirm({ title: `Permanently delete PO ${po.po_number}?`, body: 'This removes the header + all line items and cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
                deletePo.mutate(po.id, {
                  onSuccess: () => navigate('/scm/purchase-orders'),
                  onError:   (err) => notify({ title: 'Delete failed', body: `${err instanceof Error ? err.message : 'Something went wrong.'}`, tone: 'error' }),
                });
              }}
              disabled={deletePo.isPending}>
              <Trash2 {...ICON} />
              <span>{deletePo.isPending ? 'Deleting…' : 'Delete'}</span>
            </Button>
          )}
          {/* PR — Phase 2: "Receive Goods" → /grns/new?poId=X. */}
          {(po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED') && (
            <Button variant="primary" size="md"
              onClick={() => navigate(`/scm/grns/new?poId=${po.id}`)}>
              <span>Receive Goods</span>
            </Button>
          )}
          {/* PR — Phase 4: "Raise Return" available once any qty has been
              received. Pre-fills the return page with this PO's lines +
              supplier. */}
          {(po.status === 'PARTIALLY_RECEIVED' || po.status === 'RECEIVED') && (
            <Button variant="ghost" size="md"
              onClick={() => navigate(`/scm/purchase-returns/new?poId=${po.id}`)}>
              <span>Raise Return</span>
            </Button>
          )}
          {/* View → Edit gate (Commander 2026-05-29). Default View shows a
              primary Edit button (disabled while the PO is locked). Editing
              flips into draft mode; the button becomes the single "Save" that
              commits the whole draft. Back (top-left) discards. */}
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
      </div>

      {/* ── Revision-ready banner (SO-amendment workflow, Phase 1-C) ───────────
          Once the source SO revision is approved the amendment reaches SO_APPROVED
          → this green banner hosts Approve PO (revises this PO in place). After
          Approve PO the amendment is PO_APPROVED → the banner swaps to Send (marks
          SENT — no server email) + Download Revised PO (the operator prints /
          WhatsApps it themselves). Perm gate is FE-hint only; server 403 is the
          real gate. Hidden for other amendment states (those are driven from the
          SO detail). Mirrors SalesOrderDetail's amendment-pending banner. */}
      {openAmendment && (openAmendment.status === 'SO_APPROVED' || openAmendment.status === 'PO_APPROVED') && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: 'var(--space-3)',
          marginBottom: 'var(--space-3)',
          padding: 'var(--space-3) var(--space-4)',
          background: 'rgba(47, 93, 79, 0.10)',
          border: '1px solid var(--c-secondary-a, #2F5D4F)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--fs-13)',
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <History {...ICON} />
            <span>Revision ready — amendment <strong>{openAmendment.amendment_no}</strong></span>
            <StatusPill docType="soAmendment" status={openAmendment.status} />
            {openAmendment.status === 'SO_APPROVED'
              ? <span className={styles.muted}>Approve this PO to apply the supplier-confirmed changes.</span>
              : <span className={styles.muted}>Mark sent, then download the Revised PO to send to the supplier.</span>}
          </span>
          {canAmendAction && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {openAmendment.status === 'SO_APPROVED' && (
                <Button variant="primary" size="sm" onClick={handleApprovePo} disabled={approvePo.isPending}>
                  <Check {...ICON} />
                  <span>{approvePo.isPending ? 'Approving…' : 'Approve PO'}</span>
                </Button>
              )}
              {openAmendment.status === 'PO_APPROVED' && (
                <>
                  <Button variant="ghost" size="sm" onClick={() => generatePoPdf('Revised Purchase Order')}>
                    <Download {...ICON} />
                    <span>Download Revised PO</span>
                  </Button>
                  <Button variant="primary" size="sm" onClick={handleSendAmendment} disabled={sendAmendment.isPending}>
                    <Send {...ICON} />
                    <span>{sendAmendment.isPending ? 'Sending…' : 'Send'}</span>
                  </Button>
                </>
              )}
            </span>
          )}
        </div>
      )}

      {/* ── Tab strip (SO-amendment workflow) — Order vs Revisions ────────────
          The Revisions tab lists prior PO snapshots read-only. Default is the
          Order view so nothing changes for never-revised POs. Mirrors the SO
          detail tab strip. */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--line)' }}>
        {(['order', 'revisions'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setActiveTab(t)}
            style={{
              padding: '8px 16px', border: 'none', background: 'none', cursor: 'pointer',
              fontSize: 'var(--fs-13)', fontWeight: 600,
              color: activeTab === t ? 'var(--c-burnt)' : 'var(--fg-muted)',
              borderBottom: `2px solid ${activeTab === t ? 'var(--c-burnt)' : 'transparent'}`,
              marginBottom: -1,
            }}>
            {t === 'order' ? 'Order' : 'Revisions'}
          </button>
        ))}
      </div>

      {activeTab === 'revisions' ? (
        <PoRevisionsTab poId={po.id} currency={po.currency} />
      ) : (
      <>

      {/* ── DRAFT banner + Confirm (Draft/Confirmed two-state) ──────────────
          A DRAFT PO is uncommitted: it does NOT count as MRP supply, does NOT
          lock its source SO lines, and is NOT GRN-receivable until confirmed.
          Review + correct, then Confirm to make it live. Mirrors the SO detail
          DRAFT banner. */}
      {po.status === 'DRAFT' && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 'var(--space-3)',
          padding: 'var(--space-3) var(--space-4)',
          background: 'rgba(232, 107, 58, 0.08)',
          border: '1px solid var(--c-orange)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--fs-13)',
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <FileText {...ICON} />
            <span>
              <strong>Draft — not yet confirmed.</strong>{' '}
              Review and Confirm to make it a live Purchase Order (it stays out of MRP supply, doesn't lock the source SO lines, and can't be received until then).
            </span>
          </span>
          <Button variant="primary" size="sm"
            onClick={async () => {
              if (!(await askConfirm({
                title: `Confirm PO ${po.po_number}?`,
                body: 'This turns the draft into a live Purchase Order — it counts as MRP supply, locks the source SO lines, and becomes receivable (GRN).',
                confirmLabel: 'Confirm PO',
              }))) return;
              confirm.mutate(po.id, {
                onError: (err) => notify({ title: 'Confirm failed', body: `${err instanceof Error ? err.message : 'Something went wrong.'}`, tone: 'error' }),
              });
            }}
            disabled={confirm.isPending}>
            <span>{confirm.isPending ? 'Confirming…' : 'Confirm PO'}</span>
          </Button>
        </div>
      )}

      {/* Tier 2 downstream-lock — once any GRN is created from this PO the page
          becomes read-only + un-cancellable. Partial receiving (more GRNs) is
          still allowed via the list's Convert-to-GRN. */}
      {lockedDueToChildren && (
        <div className={styles.bannerWarn} style={{ marginBottom: 'var(--space-3)' }}>
          <strong>Locked — has a Goods Receipt.</strong>{' '}
          Cancel or delete the downstream GRN to edit this PO again.
        </div>
      )}

      {/* ── Supplier / dates / currency / notes ─────────────────── */}
      {/* In View the card renders read-only text; in Edit it shows inputs bound
          to the draft (committed by the single top Save — the card no longer
          has its own Save button). */}
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
          {/* Owner 2026-06-19 — Edit mode restores the Create UI: a "+ Add item"
              that appends a blank PoLineCard (committed by the page-level Save).
              Hidden while the PO is locked. */}
          {isEditing && !isLocked && (
            <Button variant="primary" size="sm" onClick={startAddLine}>
              <Plus {...ICON} />
              <span>Add item</span>
            </Button>
          )}
        </header>

        {/* SO→PO drift banner — the source SO changed after this PO was raised.
            We never auto-edit a PO that may already be with the supplier; the
            purchaser syncs + re-sends. (Commander 2026-06-16.) */}
        {showDrift && driftCount > 0 && (
          <div className={styles.bannerWarn} style={{ margin: 'var(--space-2) var(--space-3)' }}>
            ⚠ 有 <strong>{driftCount}</strong> 行的来源 SO 在本 PO 开单后被改过。请核对下方红字、同步规格后<strong>重新发给供应商</strong>,以免工厂照旧规格生产。
          </div>
        )}

        {isEditing ? (
          /* Whole-line inline edit (owner 2026-06-19) — every line is a
             PoLineCard (the SAME editor as Create), all editable at once. The
             card owns the item/SKU picker, variant selects, special orders, cost
             auto-recompute, and the qty/price/disc/delivery/ship-to row. The ONE
             page-level Save diffs each draft and add/update/deletes. */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-3)' }}>
            {editLines.map((l, idx) => (
              <PoLineCard
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
                specialsPools={specialsPools}
                onChange={(patch) => patchLine(l.rid, patch)}
                onPickBinding={(b) => pickBinding(l.rid, b)}
                onSetVariant={(k, v) => setVariant(l.rid, k, v)}
                /* Item-first reverse lookup is a Create-only affordance (no
                   supplier to narrow on an existing PO) — no-op here. */
                onPendingItemPick={() => {}}
                onRemove={() => removeLine(l.rid)}
                disabled={isLocked}
              />
            ))}
            {editLines.length === 0 && (
              <p className={styles.emptyRow} style={{ padding: 'var(--space-3)' }}>
                No items yet — click "Add item" above, or "From Sales Order" to convert.
              </p>
            )}
          </div>
        ) : visibleItems.length === 0 ? (
          <p className={styles.emptyRow}>
            No items yet — click "Edit" then "Add item" (or "From Sales Order") to add lines.
          </p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                {/* Supplier-facing dual-code rule (Commander) — the supplier's
                    own code prints on every purchasing doc; surface the
                    snapshotted line supplier_sku here too. */}
                <th>Supplier Code</th>
                <th>Group</th>
                <th className={styles.tableRight}>Qty</th>
                <th>Transfer To (GRN)</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Disc</th>
                <th className={styles.tableRight}>Total</th>
                {/* Commander 2026-05-29 — a PO line has ONE price (Unit = what
                    we pay the supplier); the separate Unit Cost / Total Cost
                    columns were dropped ("它的价钱到底是哪一个"). Keep the
                    per-line delivery date. */}
                <th className={styles.tableRight}>Delivery</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((it) => (
                <tr key={it.id}>
                  <td>
                    {/* Commander 2026-05-29 — show the item CODE only; the
                        variant summary stays (that's WHAT was ordered). */}
                    <div className={styles.codeCell}>{it.material_code}</div>
                    {(() => {
                      const summary = buildVariantSummary(it.item_group, it.variants as Record<string, unknown> | null)
                        || it.description
                        || it.material_name;
                      return summary ? <div className={styles.muted} style={{ fontSize: 'var(--fs-11)' }}>{summary}</div> : null;
                    })()}
                    {showDrift && it.so_drift && (
                      <div style={{ marginTop: 3, fontSize: 'var(--fs-11)', fontWeight: 700, color: 'var(--c-danger, #b8331f)', display: 'grid', gap: 2 }}>
                        {it.so_drift.itemChanged && (
                          <div>⚠ SO 已换产品 → {it.so_drift.itemSo}(本单仍是 {it.so_drift.itemPo}),建议取消重开</div>
                        )}
                        {!it.so_drift.itemChanged && it.so_drift.specSo !== it.so_drift.specPo && (
                          <div>⚠ SO 现规格:{it.so_drift.specSo || '—'}(本单仍是 {it.so_drift.specPo || '—'})</div>
                        )}
                        {/* Staff #12 — SO line's ship-from warehouse moved after this PO
                            was raised; the PO still points at the old warehouse. Rebind
                            via Edit → change this line's warehouse → Save (the line PATCH
                            is GRN-gated, so a received PO can't be rebound). */}
                        {it.so_drift.warehouseChanged && (
                          <div>⚠ SO 仓库已改 —— 本单仍指向原仓库;请「编辑」把本行仓库改成 SO 的仓库后保存(已收货的 PO 不可改)。</div>
                        )}
                      </div>
                    )}
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{it.supplier_sku?.trim() || '—'}</td>
                  <td className={styles.muted}>{it.item_group ?? it.material_kind}</td>
                  <td className={styles.tableRight}>{it.qty}</td>
                  <td>{renderReceived(it)}</td>
                  <td className={styles.tableRight}>{fmtRm(it.unit_price_centi, po.currency)}</td>
                  <td className={styles.tableRight}>{(it.discount_centi ?? 0) > 0 ? fmtRm(it.discount_centi, po.currency) : '—'}</td>
                  <td className={styles.priceCell}>{fmtRm(it.line_total_centi, po.currency)}</td>
                  <td className={styles.tableRight}>{it.delivery_date ?? '—'}</td>
                </tr>
              ))}
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
          {/* Commander 2026-05-29 — subtotal/total computed LIVE from the visible
              line items (incl. unsaved draft edits) so they can never drift.
              Tax stays the stored header value. */}
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
      </>
      )}
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Supplier / header card — controlled by the page's draft (#194)
   ════════════════════════════════════════════════════════════════════════ */

const SupplierCard = ({
  po, draft, onField, locked, isEditing = true,
}: {
  po: any;
  /** Draft header values (page-owned). In View these mirror the saved PO. */
  draft: HeaderDraft;
  /** Update a single header field on the page draft. */
  onField: (k: keyof HeaderDraft, v: string) => void;
  locked: boolean;
  /** View → Edit gate. When false the card renders read-only display text. */
  isEditing?: boolean;
}) => {
  const suppliersQ = useSuppliers();
  const suppliers = suppliersQ.data ?? [];
  // PR #77 — header Purchase Location dropdown options.
  const warehousesQ = useWarehouses();
  const warehouses = warehousesQ.data ?? [];
  // PR #75 — auto-fill supplier info card from /suppliers/:id. In Edit follow
  // the draft's picked supplier; in View follow the saved PO.
  const supplierIdForDetail = isEditing ? (draft.supplierId || null) : (po.supplier_id ?? null);
  const supplierDetail = useSupplierDetail(supplierIdForDetail);
  const supplier: SupplierRow | null = supplierDetail.data?.supplier ?? null;

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Supplier · Dates · Notes</h2>
        {/* Commander 2026-05-29 — the card's own Save is gone; the single top
            "Save" commits the whole PO draft (header + line edits). */}
      </header>
      <div className={styles.cardBody}>
        {!isEditing ? (
          /* View mode — read-only display text sourced from the saved PO. */
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
            <InfoCell label="PO Date" value={po.po_date || null} />
            <InfoCell label="Expected Delivery" value={po.expected_at || null} />
            {/* Mig 0026 — supplier-revised header delivery dates (shown only
                when the supplier has pushed a revised date). */}
            {po.supplier_delivery_date_2 && <InfoCell label="Supplier Date 2" value={po.supplier_delivery_date_2} />}
            {po.supplier_delivery_date_3 && <InfoCell label="Supplier Date 3" value={po.supplier_delivery_date_3} />}
            {po.supplier_delivery_date_4 && <InfoCell label="Supplier Date 4" value={po.supplier_delivery_date_4} />}
            <InfoCell label="Purchase Location"
              value={(() => {
                const wh = warehouses.find((w) => w.id === po.purchase_location_id);
                return wh ? wh.code : null;
              })()} />
            <div style={{ gridColumn: 'span 2' }}>
              <InfoCell label="Deliver To"
                value={(() => {
                  const wh = warehouses.find((w) => w.id === po.purchase_location_id);
                  return wh?.location || null;
                })()} />
            </div>
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
            <span className={styles.fieldLabel}>PO Date</span>
            <input type="date" className={styles.fieldInput} value={draft.poDate} disabled={locked}
              onChange={(e) => onField('poDate', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Expected Delivery</span>
            {/* Commander 2026-05-29 — changing this cascades to every line's
                Delivery Date (handled in the page's setHeaderField). */}
            <input type="date" className={styles.fieldInput} value={draft.expectedAt} disabled={locked}
              onChange={(e) => onField('expectedAt', e.target.value)} />
          </label>
          {/* Mig 0026 — supplier-revised header delivery dates. Each fans down
              to lines without their own value (handled in setHeaderField). */}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Supplier Date 2</span>
            <input type="date" className={styles.fieldInput} value={draft.supplierDeliveryDate2} disabled={locked}
              onChange={(e) => onField('supplierDeliveryDate2', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Supplier Date 3</span>
            <input type="date" className={styles.fieldInput} value={draft.supplierDeliveryDate3} disabled={locked}
              onChange={(e) => onField('supplierDeliveryDate3', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Supplier Date 4</span>
            <input type="date" className={styles.fieldInput} value={draft.supplierDeliveryDate4} disabled={locked}
              onChange={(e) => onField('supplierDeliveryDate4', e.target.value)} />
          </label>
          {/* PR #77 — Purchase Location: default ship-to warehouse for
              every line on this PO. */}
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

        {/* PR #75 — supplier-info auto-fill card. Read-only display sourced
            from /suppliers/:id. */}
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

/* PR #75 — Read-only label/value cell for the supplier auto-fill card. */
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

/* ════════════════════════════════════════════════════════════════════════
   Phase 1-C — PO-amendment Revisions tab. HOUZS VENDOR port of 2990's
   PoRevisionsTab / PoRevisionSnapshot.
   ════════════════════════════════════════════════════════════════════════ */

/* Read-only Revisions tab — lists prior PO snapshots (newest first) via
   usePoRevisions. Clicking a revision expands its stored snapshot as read-only
   detail. Mirrors SalesOrderDetail's RevisionsTab; no writes. */
const PoRevisionsTab = ({ poId, currency }: { poId: string; currency: string }) => {
  const { data, isLoading, error } = usePoRevisions(poId);
  const [openId, setOpenId] = useState<string | null>(null);
  const revisions = (data?.revisions ?? []) as SoRevisionRow[];

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Revisions ({revisions.length})</h2>
      </header>
      <div className={styles.cardBody}>
        {isLoading ? (
          <p className={styles.muted}>Loading revisions…</p>
        ) : error ? (
          <div className={styles.bannerWarn}>
            <strong>Could not load revisions.</strong>{' '}
            {error instanceof Error ? error.message : 'Something went wrong.'}
          </div>
        ) : revisions.length === 0 ? (
          <p className={styles.muted}>
            No prior revisions — this Purchase Order hasn't been amended yet. Approved
            amendments snapshot the previous version here.
          </p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.tableRight}>Rev.</th>
                <th>Date</th>
                <th>Snapshot</th>
              </tr>
            </thead>
            <tbody>
              {revisions.map((r) => {
                const isOpen = openId === r.id;
                return (
                  <tr key={r.id}>
                    <td className={styles.tableRight}><strong>{r.revision}</strong></td>
                    <td>{r.created_at ? fmtDateTime(r.created_at) : '—'}</td>
                    <td>
                      <button type="button"
                        onClick={() => setOpenId(isOpen ? null : r.id)}
                        style={{
                          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                          color: 'var(--c-burnt)', fontWeight: 600, fontSize: 'var(--fs-13)',
                          textDecoration: 'underline',
                        }}>
                        {isOpen ? 'Hide snapshot' : 'View snapshot'}
                      </button>
                      {isOpen && (
                        <PoRevisionSnapshot snapshot={r.snapshot} currency={currency} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
};

/* Read-only render of a PO revision snapshot (header + lines). The snapshot JSON
   is the full PO at that revision; surface the key header fields + line list and
   keep the raw values available. Dual-reads snake/camel + snapshot key variants
   defensively (the approve-po snapshot shape isn't frozen). */
const PoRevisionSnapshot = ({ snapshot, currency }: { snapshot: unknown; currency: string }) => {
  const snap = (snapshot ?? {}) as Record<string, unknown>;
  const header = (snap.header ?? snap.purchaseOrder ?? snap) as Record<string, unknown>;
  const rawLines = (snap.lines ?? snap.items ?? []) as Array<Record<string, unknown>>;
  const lines = Array.isArray(rawLines) ? rawLines : [];
  const str = (v: unknown): string => (v == null ? '—' : String(v));
  const centi = (v: unknown): string =>
    typeof v === 'number' ? fmtRm(v, currency) : '—';

  return (
    <div style={{
      marginTop: 'var(--space-2)', padding: 'var(--space-3)',
      background: 'var(--bg-subtle, rgba(34,31,32,0.03))',
      border: '1px solid var(--line)', borderRadius: 'var(--radius-md)',
      fontSize: 'var(--fs-12)',
    }}>
      <div style={{ marginBottom: 'var(--space-2)' }}>
        <strong>Supplier:</strong> {str((header.supplier as { name?: string } | null)?.name ?? header.supplier_name ?? header.supplierName)}
        {' · '}<strong>Total:</strong> {centi(header.total_centi ?? header.totalCenti)}
      </div>
      {lines.length > 0 ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Item</th>
              <th className={styles.tableRight}>Qty</th>
              <th className={styles.tableRight}>Unit</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>{str(l.material_code ?? l.materialCode ?? l.item_code ?? l.itemCode)}</td>
                <td className={styles.tableRight}>{str(l.qty)}</td>
                <td className={styles.tableRight}>{centi(l.unit_price_centi ?? l.unitPriceCenti)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <span className={styles.muted}>Snapshot has no line detail.</span>
      )}
    </div>
  );
};
