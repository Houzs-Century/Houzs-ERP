// ----------------------------------------------------------------------------
// PurchaseInvoiceDetail — full-page route at /scm/purchase-invoices/:id.
//
// EXACT clone of PurchaseOrderDetail (the gold standard): a draft-style View →
// Edit → Save/Back machine, Print PDF, Cancel. A Purchase Invoice is CONFIRMED
// the moment it exists (no Draft lifecycle), so POSTED reads as "Confirmed".
//
//   1. Header: back button + Invoice# · supplier + status pill + actions
//   2. Supplier card: editable supplier + supplier invoice ref + invoice date +
//      due date + currency + notes (inputs in Edit, read-only InfoCells in View)
//   3. Line items: in View a read-only table; in Edit a PoLineCard per line — the
//      SAME rich editor as Create PI — plus a "+ add item" (PI is free-entry,
//      grnId:null is first-class). The PI card HIDES the PO-only fields
//      (per-line delivery, supplier-revised dates, ship-to, supplier SKU).
//   4. Totals card: subtotal (live) + tax (stored) + total + read-only Paid +
//      Balance (= total - paid). No payment-entry UI here.
//
// T12 (owner 2026-06-19) — Edit mode now drives one PoLineCard per line, the SAME
// rich editor as Create (mirrors PurchaseOrderDetail). A line that descends from
// a GRN (grn_item_id set) keeps its code + variants READ-ONLY (only qty/price
// editable); a free-entry line (grn_item_id null) gets full Create-style editing.
// The single top Save diffs each draft and add/update/deletes. The server 409s
// over-invoicing past a GRN-linked qty → surfaced via notify.
//
// purchase_invoice_status enum: POSTED / PARTIALLY_PAID / PAID / CANCELLED.
// POSTED → "Confirmed" (editable). isLocked = CANCELLED OR any payment recorded
// (paid_sen > 0) — migration 0106.
//
// HOUZS VENDOR — verbatim from apps/backend/src/pages/PurchaseInvoiceDetail.tsx.
// Import boundary only: react-router → react-router-dom; the PI hooks come from
// the vendored purchase-invoice-queries (Houzs split them out of flow-queries);
// suppliers + mfg-products + fabric + inventory queries + components + the
// @2990s/shared(/mfg-pricing) imports resolve under ../../vendor/scm/* (the
// @2990s ones verbatim); <Link>/navigate repointed to /scm/*.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, FileText, Pencil, Plus, Printer, Save, Ban, ChevronDown,
  PackageCheck, Search, X,
} from 'lucide-react';
import { Button } from '@2990s/design-system';
import { buildVariantSummary, fmtDateOrDash } from '@2990s/shared';
import { formatPhone } from '@2990s/shared/phone';
import { PrintPreviewModal, usePrintPreview } from '../../components/scm-v2/PrintPreviewModal';
import type { PdfAction } from '../../vendor/scm/lib/pdf-common';
import {
  usePurchaseInvoiceDetail,
  useUpdatePurchaseInvoiceHeader,
  useAddPurchaseInvoiceItem,
  useUpdatePurchaseInvoiceItem,
  useDeletePurchaseInvoiceItem,
  useCancelPurchaseInvoice,
  usePostPurchaseInvoice,
} from '../../vendor/scm/lib/purchase-invoice-queries';
import {
  useSuppliers, useSupplierDetail, useOutstandingGrnItems,
  type BindingRow, type SupplierRow, type OutstandingGrnItem,
} from '../../vendor/scm/lib/suppliers-queries';
import { filterOutstandingGrnLines } from '../../vendor/scm/lib/outstanding-grn-search';
import { VariantDescription } from '../../vendor/scm/components/VariantDescription';
import { SearchInput } from '../../components/Button';
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
import { LinePoRefLink } from '../../vendor/scm/components/LinePoRefLink';
import { PoPriceReference } from '../../vendor/scm/components/PoPriceReference';
import { linePoLink } from '../../vendor/scm/lib/line-po-link';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import { RelationshipMapButton } from '../../vendor/scm/components/RelationshipMapButton';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import styles from './SalesOrderDetail.module.css';
import { computeTotalHeight, isTotalHeightCategory, isTotalHeightPart } from '../../vendor/shared/total-height';
import { transferFromColumnLabel } from "../../lib/convertScope";
import { DateField } from "../../vendor/scm/components/DateField";

import { ADD_LINE_LABEL } from '../../vendor/scm/lib/add-line-handoff';
import { purchaseInvoiceLinesLocked } from '../../vendor/scm/lib/line-add-lock';
import { useAddLineHandoff } from '../../vendor/scm/lib/useAddLineHandoff';
const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
};

/* Draft state shapes (mirror PO #194). HeaderDraft mirrors the editable PI
   header fields. */
type HeaderDraft = {
  supplierId: string;
  supplierInvoiceRef: string;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  notes: string;
};

type PiItemRow = Record<string, unknown> & {
  id: string;
  item_code: string;
  material_name: string;
  qty: number;
  unit_price_sen: number;
  discount_sen?: number;
  line_total_sen?: number;
  item_group?: string | null;
  material_kind?: string | null;
  description?: string | null;
  variants?: Record<string, unknown> | null;
  binding_id?: string | null;
  supplier_sku?: string | null;
  /* GRN-sourced lines carry the source GRN line id; identity + variants on those
     stay read-only (only qty/price editable). Free-entry lines have it null. */
  grn_item_id?: string | null;
  /* #26 — the line's own purchase order, resolved by the detail GET. */
  source_po_id?: string | null;
  source_po_number?: string | null;
  /* The PO price trail (mig 20260914T0200), served by the detail GET. */
  po_unit_price_sen?: number | null;
};

/* Whole-line edit (T12) — Edit mode drives one PoLineCard per line, the SAME rich
   editor as Create. EditLine = the shared PoLineDraft + the persisted item id
   (absent on a freshly-added blank card) + whether the line came from a GRN.
   grnItemId is set on a line ADDED via "Transfer from GRN" (below) — it has no
   itemId yet (never saved), but Save must still tell the server which GRN line
   it bills; a line loaded from the server already carries this on the item row
   itself, so draftFromItem doesn't need to set it (grnLinked alone locks it). */
type EditLine = PoLineDraft & { itemId?: string; grnLinked?: boolean; grnItemId?: string };

const headerSnapshot = (p: any): HeaderDraft => ({
  supplierId:         p.supplier_id ?? '',
  supplierInvoiceRef: p.supplier_invoice_ref ?? '',
  invoiceDate:        (p.invoice_date ?? '').slice(0, 10),
  dueDate:            (p.due_date ?? '').slice(0, 10),
  currency:           p.currency ?? 'MYR',
  notes:              p.notes ?? '',
});

/* Map a persisted PI line → an editable PoLineCard draft. A GRN-sourced line
   (grn_item_id set) is flagged grnLinked so the card locks its identity. */
const draftFromItem = (it: PiItemRow): EditLine => ({
  rid:            `i${it.id}`,
  itemId:         it.id,
  grnLinked:      Boolean(it.grn_item_id),
  bindingId:      it.binding_id ?? undefined,
  materialKind:   (it.material_kind as PoLineDraft['materialKind']) ?? 'mfg_product',
  itemCode:   it.item_code,
  materialName:   it.material_name,
  supplierSku:    it.supplier_sku ?? undefined,
  qty:            it.qty,
  unitPriceSen: it.unit_price_sen,
  discountSen:  it.discount_sen ?? 0,
  category:       it.item_group ?? undefined,
  variants:       (it.variants as Record<string, unknown> | null) ?? {},
  /* An existing line's stored price is authoritative — don't let the cost
     auto-recompute clobber it on enter-edit. Editing variants re-arms it. */
  priceTouched:   true,
});

/* Map one picked outstanding GRN line → an editable PoLineCard draft, for
   "Transfer from GRN" (addGrnLines below). Exported so the mapping itself —
   the one non-trivial piece of this feature — has a test independent of the
   page's many data hooks; see PurchaseInvoiceDetail.grnLine.test.ts. */
export const grnItemToEditLine = (it: OutstandingGrnItem, qty: number): EditLine => ({
  rid:            `g${it.grnItemId}`,
  grnItemId:      it.grnItemId,
  grnLinked:      true,
  materialKind:   'mfg_product',
  itemCode:   it.itemCode,
  materialName:   it.description || it.itemCode,
  category:       it.itemGroup ? it.itemGroup.toLowerCase() : undefined,
  variants:       (it.variants as Record<string, unknown> | null) ?? {},
  qty,
  unitPriceSen: it.unitPriceSen,
  priceTouched:   true,
});

export const PurchaseInvoiceDetail = () => {
  const { id } = useParams<{ id: string }>();
  /* "Add line" from the detail page. At the TOP with the other hooks: this
     editor returns early while the document loads, and a hook written below
     that return is the rules-of-hooks violation the linter caught when this
     was first pasted in per-file (docs/bugs/0853). */
  const addLineHandoff = useAddLineHandoff();
  const detail = usePurchaseInvoiceDetail(id ?? null);
  const updateHeader = useUpdatePurchaseInvoiceHeader();
  const addItem = useAddPurchaseInvoiceItem();
  const updateItem = useUpdatePurchaseInvoiceItem();
  const deleteItem = useDeletePurchaseInvoiceItem();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const cancel = useCancelPurchaseInvoice();
  const confirmPi = usePostPurchaseInvoice();

  const pi = detail.data?.purchaseInvoice ?? null;
  /* Memoised so the edit-mode seed + cost-recompute effects don't re-fire on
     every render (detail.data?.items is a fresh array each time otherwise). */
  const items = useMemo(() => (detail.data?.items ?? []) as PiItemRow[], [detail.data?.items]);
  // OUR delivery order(s) this purchase covers (owner 2026-07-23 "要的") —
  // server-resolved through the so_item_id chain; empty for stock POs.
  const customerDos = detail.data?.customerDos ?? [];

  /* ── Whole-line editor data (T12) — the SAME lookups Create uses so PoLineCard
     renders identically in Edit. Bindings come from the PI's supplier; allSkus is
     the catalogue fallback; maint + fabrics drive the variant dropdowns;
     specialsPools feeds the Special Orders checkboxes. */
  const piSupplierId = pi?.supplier_id ?? '';
  const supplierDetailQ = useSupplierDetail(piSupplierId || null);
  const bindings = useMemo(() => supplierDetailQ.data?.bindings ?? [], [supplierDetailQ.data?.bindings]);
  const allSkusQ = useMfgProducts();
  const allSkus = useMemo(() => allSkusQ.data ?? [], [allSkusQ.data]);
  const warehousesQ = useWarehouses();
  const warehousesForLines = warehousesQ.data ?? [];
  const supplierMaintQ = useMaintenanceConfig(
    piSupplierId ? `supplier:${piSupplierId}` : '',
    { enabled: Boolean(piSupplierId) },
  );
  const masterMaintQ = useMaintenanceConfig('master', {
    enabled: !piSupplierId || !supplierMaintQ.data?.data,
  });
  const maint = supplierMaintQ.data?.data ?? masterMaintQ.data?.data ?? null;
  const fabrics = useFabricTrackings().data ?? [];
  const specialAddonsQ = useSpecialAddons();
  const specialsPools = useMemo(() => {
    const rows = (specialAddonsQ.data ?? [])
      .filter((r) => r.active)
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.code ?? '').localeCompare(b.code ?? ''));
    // FULL rows feed the shared SpecialOrders block via PoLineCard (owner 2026-07-20).
    const pick = (cat: string) => rows.filter((r) => r.categories.includes(cat));
    return { bedframe: pick('BEDFRAME'), sofa: pick('SOFA') };
  }, [specialAddonsQ.data]);

  /* code → category (lowercased) lookup, mirroring Create's categoryForCode. */
  const categoryForCode = (code: string): string | undefined =>
    allSkus.find((p) => p.code === code)?.category.toLowerCase();

  /* View → Edit gate (mirror PO/GRN) — default read-only View; click Edit to
     flip into draft mode. The PI list's right-click "Edit" lands here with
     ?edit=1. */
  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(() => searchParams.get('edit') === '1');

  /* #194 draft buffers. headerDraft is null until the first header field is
     touched (then seeded from the PI). Line edits are WHOLE-LINE drafts
     (editLines), one PoLineCard per line. Existing lines carry their itemId; a
     freshly-added blank card has none until Save inserts it. None of this
     persists until the single top Save. */
  const [headerDraft, setHeaderDraft] = useState<HeaderDraft | null>(null);
  const [editLines, setEditLines] = useState<EditLine[]>([]);
  const [savingDraft, setSavingDraft] = useState(false);

  // Unified edit-lock (migration 0106): a PI is read-only once it has ANY
  // payment recorded (paid_sen > 0) OR is CANCELLED. POSTED with zero payment
  // stays editable.
  const isLocked = pi ? purchaseInvoiceLinesLocked({ status: pi.status, paid_sen: pi.paid_sen ?? null }) : true;
  // DRAFT lifecycle — a DRAFT PI is editable (not locked) and shows a Confirm
  // banner; confirming flips DRAFT → POSTED (where AP/GL post + GRN consume run).
  const isDraft = (pi?.status as string) === 'DRAFT';

  /* If the PI locks while we're in Edit mode (e.g. cancelled in another tab),
     drop back to View + discard the draft. */
  useEffect(() => {
    if (isLocked && isEditing) {
      setIsEditing(false);
      setHeaderDraft(null);
      setEditLines([]);
    }
  }, [isLocked, isEditing]);

  /* Seed/clear the whole-line drafts (T12) — entering Edit populates a PoLineCard
     draft for EVERY current line; leaving Edit wipes them. Re-seeds whenever the
     underlying items change (e.g. after a Save re-fetch). */
  useEffect(() => {
    if (!isEditing) { setEditLines([]); return; }
    setEditLines(items.map(draftFromItem));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, items]);

  /* Cost auto-recompute (mirrors Create) — resolve a line's supplier price
     matrix + maintenance surcharges into a unit cost. A manually-touched line
     (priceTouched) keeps its typed value; a GRN-linked line keeps its billed
     price (its identity/variants are locked, so it never re-prices). */
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
      : bindings.find((b) => b.item_code === line.itemCode);
    if (!binding) return line.unitPriceSen;
    const category = (line.category?.toUpperCase() ?? '') as
      'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'ACCESSORY' | 'SERVICE' | '';
    if (!category) return binding.unit_price_sen;
    const v = line.variants;
    const specials = Array.isArray(v.specials) ? (v.specials as string[]) : [];
    const breakdown = computeMfgPoUnitCost(
      {
        category,
        priceMatrix:    (binding.price_matrix ?? null) as PoPriceMatrix,
        unitPriceSen: binding.unit_price_sen,
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

  /* Cost auto-recompute effect — re-price every non-touched, non-GRN-linked
     editLine off the supplier matrix + maintenance surcharges. Gated to Edit. */
  useEffect(() => {
    if (!isEditing) return;
    setEditLines((prev) => {
      let changed = false;
      const next = prev.map((l) => {
        if (l.priceTouched || l.grnLinked) return l;
        const cost = recomputeLineCost(l);
        if (cost === l.unitPriceSen) return l;
        changed = true;
        return { ...l, unitPriceSen: cost };
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, bindings, fabrics, maint, editLines]);

  /* HOOKS MUST ALL BE ABOVE THE GUARDS BELOW. usePrintPreview sat under them
     until 2026-08-17, so the loading render called fewer hooks than the loaded
     one and React threw #310 ("rendered more hooks than during the previous
     render") the moment the query resolved — a blank "Something went wrong
     loading this page." on every direct URL / refresh of a PI. Arriving from
     the list hid it: react-query already had the detail cached, so the
     isPending branch never rendered first. `deliverPrintPdf` therefore has to
     tolerate a null pi; it can only ever be CALLED from the preview dialog,
     which does not exist until the record has loaded. */
  const deliverPrintPdf = (action: PdfAction) => {
    if (!pi) return;
    // PI PDF (AutoCount layout) — mirrors PO/GRN's print wiring its own
    // purchase-invoice-pdf helper.
    return import('../../vendor/scm/lib/purchase-invoice-pdf').then(({ generatePurchaseInvoicePdf }) =>
      generatePurchaseInvoicePdf(pi, items as any, { action }),
    ).catch((e) => notify({ title: 'PDF generation failed', body: `${e instanceof Error ? e.message : 'Something went wrong.'}`, tone: 'error' }));
  };
  const print = usePrintPreview(deliverPrintPdf);

  if (detail.isPending) {
    return <SkeletonDetailPage />;
  }
  if (detail.isError || !pi) {
    return (
      <div className={styles.page}>
        <Link to="/scm/purchase-invoices" className={styles.backBtn}>
          <ArrowLeft {...ICON} />
          <span>Back</span>
        </Link>
        <div className={styles.bannerWarn}>
          <strong>Purchase invoice not found.</strong>
          {detail.error instanceof Error ? ` ${detail.error.message}` : null}
        </div>
      </div>
    );
  }

  /* ── Draft helpers (pi is guaranteed non-null past the guards above) ── */
  /* View shows the live server items; Edit drives editLines (one PoLineCard per
     line). Deletes fire immediately server-side; only the field/variant edits
     are buffered until the single top Save. */
  const visibleItems = items;
  /* Totals — in Edit, sum the live editLines (incl. unsaved edits); in View, the
     stored line totals. */
  const itemsSubtotal = isEditing
    ? editLines.reduce((s, d) => s + Math.max(0, d.qty * d.unitPriceSen - (d.discountSen ?? 0)), 0)
    : visibleItems.reduce((s, it) => s + (it.line_total_sen ?? (it.qty * it.unit_price_sen - (it.discount_sen ?? 0))), 0);
  const taxSen = pi.tax_sen ?? 0;
  const grandTotal = itemsSubtotal + taxSen;
  const paidSen = pi.paid_sen ?? 0;
  const balanceSen = grandTotal - paidSen;

  const headerView = headerDraft ?? headerSnapshot(pi);

  const setHeaderField = (k: keyof HeaderDraft, v: string) => {
    setHeaderDraft((h) => ({ ...(h ?? headerSnapshot(pi)), [k]: v }));
  };

  /* Patch one editLine by rid (mirrors Create's setLine). */
  const patchLine = (rid: string, patch: Partial<EditLine>) =>
    setEditLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));

  /* Adopt a supplier binding into a line (mirrors Create's pickBinding). */
  const pickBinding = (rid: string, b: BindingRow) =>
    patchLine(rid, {
      bindingId:      b.id,
      materialKind:   b.material_kind,
      itemCode:   b.item_code,
      materialName:   b.material_name,
      supplierSku:    b.supplier_sku,
      unitPriceSen: b.unit_price_sen,
      category:       categoryForCode(b.item_code),
      priceTouched:   false,
    });

  /* Patch one variant key + auto-compute bedframe Total Height (= Divan + Leg +
     Gap, from vendor/shared/total-height.ts — the one home, no longer a copy of
     Create's). Editing a variant re-arms the cost auto-recompute
     (priceTouched ← false). */
  const setVariant = (rid: string, k: string, v: unknown) =>
    setEditLines((prev) => prev.map((l) => {
      if (l.rid !== rid) return l;
      const variants: Record<string, unknown> = { ...l.variants, [k]: v };
      if (isTotalHeightCategory(l.category) && isTotalHeightPart(k)) {
        variants.totalHeight = computeTotalHeight(l.category, variants);
      }
      return { ...l, variants, priceTouched: false };
    }));

  /* Append a fresh blank PoLineCard (PI is free-entry — grn_item_id null).
     Committed by the page-level Save. */
  const startAddLine = () =>
    setEditLines((prev) => [...prev, { ...emptyPoLine() }]);
  addLineHandoff.current = { enabled: isEditing && !isLocked, onTrigger: startAddLine };

  /* Transfer from GRN (mirrors AutoCount's "Transfer From Goods Receive Note"
     on an already-saved PI) — pulls more outstanding GRN lines onto THIS
     invoice, alongside the free-entry "+ Add item" above. Each picked line
     becomes a grnLinked draft; Save sends its grnItemId to POST /:id/items,
     which already validates + caps + recomputes the GRN's invoiced_qty (T12's
     endpoint was built for this, just never had a button). */
  const [showGrnPicker, setShowGrnPicker] = useState(false);
  const linkedGrnItemIds = useMemo(
    () => new Set(editLines.map((l) => l.grnItemId).filter((x): x is string => Boolean(x))),
    [editLines],
  );
  const addGrnLines = (picked: Array<{ it: OutstandingGrnItem; qty: number }>) => {
    setEditLines((prev) => [...prev, ...picked.map(({ it, qty }) => grnItemToEditLine(it, qty))]);
    setShowGrnPicker(false);
  };

  /* Remove a line. A persisted line fires the delete mutation immediately; a
     never-saved blank card just drops from the draft array. */
  const removeLine = async (rid: string) => {
    const l = editLines.find((x) => x.rid === rid);
    if (!l) return;
    if (!l.itemId) { setEditLines((prev) => prev.filter((x) => x.rid !== rid)); return; }
    if (await askConfirm({
      title: 'Remove this line?',
      body: 'The line is removed from this invoice.',
      confirmLabel: 'Remove',
      danger: true,
    })) {
      deleteItem.mutate(
        { id: pi.id, itemId: l.itemId },
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
       · no itemId → ADD (full payload incl. variants / itemCode)
       · itemId + changed any field → UPDATE (full payload)
     Deletes already fired server-side in removeLine. Then commit the header (if
     touched) and drop back to View. The server 409s over-invoicing a GRN-linked
     line → surfaced via notify. */
  const handleSave = async () => {
    if (savingDraft) return;
    // Guard: every line must reference a product before Save.
    const blankLine = editLines.find((d) => !d.itemCode.trim());
    if (blankLine) {
      notify({ title: 'Every line needs a product', body: 'Pick a product for each line, or remove the empty one before saving.', tone: 'error' });
      return;
    }
    setSavingDraft(true);
    try {
      if (headerDraft) {
        await updateHeader.mutateAsync({ id: pi.id, ...(headerDraft as Record<string, unknown>) });
      }
      const byId = new Map(items.map((it) => [it.id, it]));
      for (const d of editLines) {
        if (!d.itemId) {
          // New line — free-entry (grnItemId undefined) or GRN-transferred
          // (set by addGrnLines above); the server caps/consumes either way.
          await addItem.mutateAsync({
            id: pi.id,
            grnItemId:      d.grnItemId,
            materialKind:   d.materialKind,
            itemCode:   d.itemCode,
            materialName:   d.materialName || d.itemCode,
            qty:            d.qty,
            unitPriceSen: d.unitPriceSen,
            discountSen:  d.discountSen ?? 0,
            bindingId:      d.bindingId,
            itemGroup:      d.category,
            variants:       Object.keys(d.variants).length ? d.variants : undefined,
          });
          continue;
        }
        const it = byId.get(d.itemId);
        if (!it) continue;
        const changed =
          d.itemCode !== it.item_code ||
          (d.materialName || d.itemCode) !== it.material_name ||
          (d.category ?? '') !== (it.item_group ?? '') ||
          d.qty !== it.qty ||
          d.unitPriceSen !== it.unit_price_sen ||
          (d.discountSen ?? 0) !== (it.discount_sen ?? 0) ||
          JSON.stringify(d.variants ?? {}) !== JSON.stringify((it.variants as Record<string, unknown> | null) ?? {});
        if (!changed) continue;
        await updateItem.mutateAsync({
          id: pi.id, itemId: d.itemId,
          itemCode:   d.itemCode,
          materialName:   d.materialName || d.itemCode,
          qty:            d.qty,
          unitPriceSen: d.unitPriceSen,
          discountSen:  d.discountSen ?? 0,
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

  return (
    <div className={styles.page}>
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/scm/purchase-invoices" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>
              <FileText size={14} strokeWidth={1.75} style={{ color: 'var(--c-burnt)' }} />
              {pi.invoice_number} — {pi.supplier?.name ?? pi.supplier?.code ?? '—'}
            </h1>
          </div>
        </div>
        <div className={styles.actions}>
          {/* Total KPI tile — tracks the live line items (incl. unsaved draft
              edits) + stored tax. */}
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Total</span>
            <span className={styles.totalRailValue}>{fmtRm(grandTotal, pi.currency)}</span>
          </div>
          {/* A PI is Confirmed the moment it exists (no Draft/lifecycle). */}
          <StatusPill docType="pi" status={pi.status} />
          <RelationshipMapButton type="pi" id={id} />
          <Button variant="ghost" size="md" onClick={print.openPreview}>
            <Printer {...ICON} />
            <span>Print PDF</span>
          </Button>
          <PrintPreviewModal
            open={print.open}
            onClose={print.close}
            docTitle="Purchase Invoice"
            docNo={pi.invoice_number}
            rows={[
              { label: 'Supplier', value: pi.supplier?.name ?? pi.supplier?.code ?? '—' },
              { label: 'Invoice date', value: fmtDateOrDash(pi.invoice_date) },
              { label: 'Items', value: `${items.length} line${items.length === 1 ? '' : 's'}` },
            ]}
            {...print.handlers}
          />
          {/* Cancel — only when the PI is not locked (no payment recorded, not
              already cancelled). */}
          {!isLocked && (
            <Button variant="ghost" size="md"
              onClick={async () => {
                if (!(await askConfirm({
                  title: `Cancel invoice ${pi.invoice_number}?`,
                  body: `This sets status to CANCELLED — line items stay for audit.`,
                  confirmLabel: 'Cancel invoice',
                  danger: true,
                }))) return;
                cancel.mutate(pi.id, {
                  onError: (err) => notify({ title: 'Cancel failed', body: `${err instanceof Error ? err.message : 'Something went wrong.'}`, tone: 'error' }),
                });
              }}
              disabled={cancel.isPending}>
              <Ban {...ICON} />
              <span>{cancel.isPending ? 'Cancelling…' : 'Cancel'}</span>
            </Button>
          )}
          {/* View → Edit gate. Default View shows Edit (disabled while locked);
              editing flips into draft mode and the button becomes the single
              "Save" that commits the whole draft. Back (top-left) discards. */}
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

      {/* ── DRAFT banner + Confirm (DRAFT flow) ─────────────────────
          A PI created with Save as Draft lands as DRAFT: no AP/GL post, no GRN
          consume, no recost happened yet. Review + Confirm flips DRAFT → POSTED
          (PATCH /:id/post), which is where the AP liability posts + the GRN lines
          are consumed. Mirrors the SO detail DRAFT banner. */}
      {isDraft && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)',
          background: 'rgba(232, 107, 58, 0.08)',
          border: '1px solid var(--c-orange)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--fs-13)',
          marginBottom: 'var(--space-3)',
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <FileText {...ICON} />
            <span>
              <strong>Draft — not yet confirmed.</strong>{' '}
              Review and Confirm to post the AP liability (it stays out of payables / GL until then).
            </span>
          </span>
          <Button variant="primary" size="sm"
            onClick={async () => {
              if (!(await askConfirm({
                title: `Confirm invoice ${pi.invoice_number}?`,
                body: 'This posts the supplier AP liability and consumes the linked GRN lines. The invoice becomes payable.',
                confirmLabel: 'Confirm Invoice',
              }))) return;
              confirmPi.mutate(pi.id, {
                onError: (err) => notify({ title: 'Confirm failed', body: `${err instanceof Error ? err.message : 'Something went wrong.'}`, tone: 'error' }),
              });
            }}
            disabled={confirmPi.isPending}>
            <span>{confirmPi.isPending ? 'Confirming…' : 'Confirm Invoice'}</span>
          </Button>
        </div>
      )}

      {/* ── Supplier / ref / dates / currency / notes ───────────── */}
      {/* In View the card renders read-only text; in Edit it shows inputs bound
          to the draft (committed by the single top Save). */}
      <SupplierCard
        pi={pi}
        draft={headerView}
        onField={setHeaderField}
        locked={isLocked}
        isEditing={isEditing}
        customerDos={customerDos}
      />

      {/* ── Line items ──────────────────────────────────────────── */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({isEditing ? editLines.length : visibleItems.length})</h2>
          {/* T12 — Edit mode restores the Create UI: a "+ Add item" that appends a
              blank PoLineCard (PI is free-entry). Hidden while the PI is locked.
              "Transfer from GRN" beside it mirrors AutoCount's own PI ribbon
              button — pulls more outstanding lines from this supplier's
              goods-received notes onto this SAME saved invoice. */}
          {isEditing && !isLocked && (
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Button variant="ghost" size="sm" onClick={() => setShowGrnPicker(true)} disabled={!piSupplierId}
                title={piSupplierId ? undefined : 'Pick a supplier first'}>
                <PackageCheck {...ICON} />
                <span>Transfer from GRN</span>
              </Button>
              <Button variant="primary" size="sm" onClick={startAddLine}>
                <Plus {...ICON} />
                <span>{ADD_LINE_LABEL}</span>
              </Button>
            </div>
          )}
        </header>

        {isEditing ? (
          /* Whole-line inline edit (T12) — every line is a PoLineCard (the SAME
             editor as Create), all editable at once. GRN-sourced lines keep their
             identity + variants read-only (identityReadOnly); free-entry lines get
             full editing. The PI card hides the PO-only fields (hidePoFields). The
             ONE page-level Save diffs each draft and add/update/deletes. */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-3)' }}>
            {editLines.map((l, idx) => (
              <div key={l.rid}>
              {/* #26 — which PO this line came from, above its editor. A new or
                  free-entry line has none and shows nothing. */}
              {(() => {
                const src = l.itemId ? items.find((it) => it.id === l.itemId) : undefined;
                /* Beside the #26 PO link: the PO's price against the price being
                   typed now (owner 2026-09-14). Reference only — Save is never
                   gated on it. */
                return src && (linePoLink(src) || src.grn_item_id) ? (
                  <div className={styles.muted} style={{ fontSize: 'var(--fs-12)', margin: '0 0 var(--space-1) var(--space-1)', display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline', flexWrap: 'wrap' }}>
                    {linePoLink(src) && <span>From PO <LinePoRefLink line={src} /></span>}
                    <PoPriceReference poUnitPriceSen={src.po_unit_price_sen} piUnitPriceSen={l.unitPriceSen} fmt={(sen) => fmtRm(sen, pi.currency)} />
                  </div>
                ) : null;
              })()}
              <PoLineCard
                index={idx}
                line={l}
                currency={pi.currency}
                supplierId={piSupplierId}
                bindings={bindings}
                allSkus={allSkus}
                warehouses={warehousesForLines}
                maint={maint}
                fabrics={fabrics}
                specialsPools={specialsPools}
                onChange={(patch) => patchLine(l.rid, patch)}
                onPickBinding={(b) => pickBinding(l.rid, b)}
                onSetVariant={(k, v) => setVariant(l.rid, k, v)}
                onPendingItemPick={() => {}}
                onRemove={() => removeLine(l.rid)}
                disabled={isLocked}
                hidePoFields
                identityReadOnly={Boolean(l.grnLinked)}
              />
              </div>
            ))}
            {editLines.length === 0 && (
              <p className={styles.emptyRow} style={{ padding: 'var(--space-3)' }}>
                No items yet — click "Add item" above.
              </p>
            )}
          </div>
        ) : visibleItems.length === 0 ? (
          <p className={styles.emptyRow}>No items on this invoice.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Group</th>
                <th>PO</th>
                <th className={styles.tableRight}>Qty</th>
                <th className={styles.tableRight}>PO price</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Disc</th>
                <th className={styles.tableRight}>Total</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((it) => (
                <tr key={it.id}>
                  <td>
                    <div className={styles.codeCell}>{it.item_code}</div>
                    {(() => {
                      const summary = buildVariantSummary(it.item_group ?? null, it.variants as Record<string, unknown> | null)
                        || it.description
                        || it.material_name;
                      return summary ? <div className={styles.muted} style={{ fontSize: 'var(--fs-11)' }}>{summary}</div> : null;
                    })()}
                  </td>
                  <td className={styles.muted}>{it.item_group ?? it.material_kind ?? '—'}</td>
                  <td><LinePoRefLink line={it} /></td>
                  <td className={styles.tableRight}>{it.qty}</td>
                  <td className={styles.tableRight}><PoPriceReference poUnitPriceSen={it.po_unit_price_sen} piUnitPriceSen={it.unit_price_sen} fmt={(sen) => fmtRm(sen, pi.currency)} align="right" /></td>
                  <td className={styles.tableRight}>{fmtRm(it.unit_price_sen, pi.currency)}</td>
                  <td className={styles.tableRight}>{(it.discount_sen ?? 0) > 0 ? fmtRm(it.discount_sen, pi.currency) : '—'}</td>
                  <td className={styles.priceCell}>{fmtRm(it.line_total_sen ?? (it.qty * it.unit_price_sen - (it.discount_sen ?? 0)), pi.currency)}</td>
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
          {/* Subtotal computed LIVE from the visible line items (incl. unsaved
              draft edits); tax is the stored header value; total = subtotal +
              tax. Paid + Balance are read-only (no payment-entry UI here). */}
          <div className={styles.totalsGrid}>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Subtotal</span>
              <span className={styles.totalValue}>{fmtRm(itemsSubtotal, pi.currency)}</span>
            </div>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Tax</span>
              <span className={styles.totalValue}>{fmtRm(taxSen, pi.currency)}</span>
            </div>
            <div className={`${styles.totalRow} ${styles.grandTotalRow}`}>
              <span className={styles.totalLabel}>Total</span>
              <span className={`${styles.totalValue} ${styles.grandTotal}`}>{fmtRm(grandTotal, pi.currency)}</span>
            </div>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Paid</span>
              <span className={styles.totalValue}>{fmtRm(paidSen, pi.currency)}</span>
            </div>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Balance</span>
              <span className={styles.totalValue}>{fmtRm(balanceSen, pi.currency)}</span>
            </div>
          </div>
        </div>
      </section>

      {showGrnPicker && (
        <GrnLinePickerModal
          supplierId={piSupplierId}
          currency={pi.currency}
          excludeGrnItemIds={linkedGrnItemIds}
          onAdd={addGrnLines}
          onClose={() => setShowGrnPicker(false)}
        />
      )}
    </div>
  );
};

/* ════════════════════════════════════════════════════════════════════════
   Supplier / header card — controlled by the page's draft (mirror PO/GRN).
   In View it renders read-only InfoCells; in Edit it shows inputs bound to the
   page draft (committed by the single top Save).
   ════════════════════════════════════════════════════════════════════════ */

const SupplierCard = ({
  pi, draft, onField, locked, isEditing = true, customerDos = [],
}: {
  pi: any;
  /** Draft header values (page-owned). In View these mirror the saved PI. */
  draft: HeaderDraft;
  /** Update a single header field on the page draft. */
  onField: (k: keyof HeaderDraft, v: string) => void;
  locked: boolean;
  /** View → Edit gate. When false the card renders read-only display text. */
  isEditing?: boolean;
  /** OUR delivery order(s) this purchase covers (so_item_id chain). */
  customerDos?: Array<{ id: string; do_number: string }>;
}) => {
  const suppliersQ = useSuppliers();
  const suppliers = suppliersQ.data ?? [];
  // In Edit follow the draft's picked supplier; in View follow the saved PI.
  const supplierIdForDetail = isEditing ? (draft.supplierId || null) : (pi.supplier_id ?? null);
  const supplierDetail = useSupplierDetail(supplierIdForDetail);
  const supplier: SupplierRow | null = supplierDetail.data?.supplier ?? null;

  return (
    <section className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Supplier · Dates · Notes</h2>
      </header>
      <div className={styles.cardBody}>
        {!isEditing ? (
          /* View mode — read-only display text sourced from the saved PI. */
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
                value={pi.supplier?.name ?? pi.supplier?.code ?? supplier?.name ?? supplier?.code ?? null} />
            </div>
            <InfoCell label="Currency" value={pi.currency || null} />
            <div />
            <InfoCell label="Supplier Invoice Ref" value={pi.supplier_invoice_ref || null} />
            <InfoCell label="Invoice Date" value={pi.invoice_date ? fmtDateOrDash(pi.invoice_date) : null} />
            <InfoCell label="Due Date" value={pi.due_date ? fmtDateOrDash(pi.due_date) : null} />
            {/* Owner 2026-07-23: "PI need show Do number" — the source GRN and
                the supplier's delivery-note (DO) ref recorded on it. Manual
                PIs have no GRN, so both cells fall back to the dash. */}
            <InfoCell label={transferFromColumnLabel('grn')} value={pi.grn?.grn_number || null} />
            <InfoCell label="Supplier DO #" value={pi.grn?.delivery_note_ref || null} />
            {/* Owner 2026-07-23 ("要的") — OUR delivery to the customer this
                purchase covers. Dash for stock POs (no so_item linkage). */}
            <InfoCell label="Customer DO" value={customerDos.length ? customerDos.map((d) => d.do_number).join(', ') : null} />
            <div style={{ gridColumn: 'span 2' }}>
              <InfoCell label="Notes" value={pi.notes || null} />
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
                {/* CNY — same currency as RMB under its ISO code; a purchase
                    invoice raised against a CNY purchase order carries it. */}
                <option value="CNY">CNY</option>
                <option value="USD">USD</option>
                <option value="SGD">SGD</option>
              </select>
              <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
            </span>
          </label>
          <div />
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Supplier Invoice Ref</span>
            <input className={styles.fieldInput} value={draft.supplierInvoiceRef} disabled={locked}
              onChange={(e) => onField('supplierInvoiceRef', e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Invoice Date</span>
            <DateField
              fullWidth
              className={styles.fieldInput}
              value={draft.invoiceDate}
              disabled={locked}
              onChange={(iso) => onField('invoiceDate', iso)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Due Date</span>
            <DateField fullWidth className={styles.fieldInput} value={draft.dueDate} disabled={locked} onChange={(iso) => onField('dueDate', iso)}/>
          </label>
          <label className={styles.field} style={{ gridColumn: 'span 2' }}>
            <span className={styles.fieldLabel}>Notes</span>
            <input className={styles.fieldInput} value={draft.notes} disabled={locked}
              onChange={(e) => onField('notes', e.target.value)} />
          </label>
        </div>
        )}

        {/* Supplier-info auto-fill card. Read-only display from /suppliers/:id. */}
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

/* Read-only label/value cell for the supplier auto-fill card. */
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
   GrnLinePickerModal — "Transfer from GRN" on an already-saved PI. Same data
   source as the create-time picker (PurchaseInvoiceFromGrn.tsx), locked to
   THIS invoice's supplier + currency instead of letting the operator pick
   any — a saved PI already has both fixed. Picks are handed straight to the
   caller's editLines (addGrnLines above), not stashed through a handoff.
   ════════════════════════════════════════════════════════════════════════ */

const GrnLinePickerModal = ({
  supplierId, currency, excludeGrnItemIds, onAdd, onClose,
}: {
  supplierId: string;
  currency: string;
  /** GRN lines already on this invoice (persisted or picked this session) —
      hidden so the same line can't be added twice. */
  excludeGrnItemIds: Set<string>;
  onAdd: (picked: Array<{ it: OutstandingGrnItem; qty: number }>) => void;
  onClose: () => void;
}) => {
  const itemsQ = useOutstandingGrnItems();
  const [query, setQuery] = useState('');
  const [picks, setPicks] = useState<Record<string, number>>({});

  const items = useMemo(
    () => (itemsQ.data?.items ?? [])
      .filter((it) => it.supplierId === supplierId)
      .filter((it) => (it.currency ?? 'MYR') === (currency || 'MYR'))
      .filter((it) => !excludeGrnItemIds.has(it.grnItemId)),
    [itemsQ.data, supplierId, currency, excludeGrnItemIds],
  );
  const visible = useMemo(() => filterOutstandingGrnLines(items, query), [items, query]);

  const togglePick = (it: OutstandingGrnItem) =>
    setPicks((s) => {
      const next = { ...s };
      if (it.grnItemId in next) delete next[it.grnItemId];
      else next[it.grnItemId] = it.remaining;
      return next;
    });
  const setQty = (it: OutstandingGrnItem, qty: number) =>
    setPicks((s) => ({ ...s, [it.grnItemId]: Math.min(it.remaining, Math.max(0, qty)) }));

  const pickedCount = Object.keys(picks).length;
  const confirm = () => {
    const chosen = items
      .filter((it) => (picks[it.grnItemId] ?? 0) > 0)
      .map((it) => ({ it, qty: picks[it.grnItemId] }));
    if (chosen.length === 0) return;
    onAdd(chosen);
  };

  return (
    <div role="presentation" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-4)',
    }}>
      <div role="dialog" aria-label="Transfer lines from GRN" style={{
        background: 'var(--c-paper, #fff)', borderRadius: 'var(--radius-md)',
        border: '1px solid var(--line)', width: 'min(720px, 96vw)', maxHeight: '86vh',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--line)',
        }}>
          <strong>Transfer from GRN</strong>
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--fg-muted)' }}>
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>
        <div style={{ padding: 'var(--space-2) var(--space-4)' }}>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search GRN, item…"
            aria-label="Search outstanding GRN lines"
            leadingIcon={<Search size={14} strokeWidth={1.75} />}
          />
        </div>
        <div style={{ overflowY: 'auto', padding: '0 var(--space-4) var(--space-3)', flex: 1 }}>
          {itemsQ.isLoading ? (
            <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>Loading…</p>
          ) : itemsQ.isError ? (
            <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>
              We couldn&rsquo;t load the outstanding GRN lines — close this and try again.
            </p>
          ) : visible.length === 0 ? (
            <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>
              No outstanding GRN lines left to bill for this supplier
              {currency ? ` in ${currency}` : ''}.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              {visible.map((it) => {
                const on = it.grnItemId in picks;
                const qty = picks[it.grnItemId] ?? 0;
                return (
                  <div key={it.grnItemId} style={{
                    display: 'grid', gridTemplateColumns: '24px 1fr 90px 80px 110px', gap: 'var(--space-2)',
                    alignItems: 'center', padding: 'var(--space-2) 0', borderBottom: '1px solid var(--line)',
                    background: on ? 'rgba(213, 90, 40, 0.04)' : 'transparent',
                  }}>
                    <input type="checkbox" checked={on} onChange={() => togglePick(it)} />
                    <div style={{ fontSize: 'var(--fs-13)' }}>
                      <div style={{ fontFamily: 'var(--font-mono)' }}>{it.itemCode}</div>
                      <VariantDescription
                        itemCode={it.itemCode} itemGroup={it.itemGroup}
                        variants={it.variants} description={it.description}
                      />
                      <div style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-11)' }}>
                        {it.grnDocNo}{it.poDocNo ? ` · PO ${it.poDocNo}` : ''}
                      </div>
                    </div>
                    <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-13)' }}>
                      {it.remaining}
                    </span>
                    <input
                      type="number" min={0} max={it.remaining}
                      value={on ? qty : ''} placeholder={String(it.remaining)}
                      disabled={!on}
                      onChange={(e) => setQty(it, Number(e.target.value) || 0)}
                      className={styles.fieldInput}
                      style={{ textAlign: 'right', padding: '4px 6px', fontSize: 'var(--fs-13)' }}
                    />
                    <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}>
                      {fmtRm(qty * it.unitPriceSen, currency)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)',
          padding: 'var(--space-3) var(--space-4)', borderTop: '1px solid var(--line)',
        }}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={confirm} disabled={pickedCount === 0}>
            {pickedCount === 0 ? 'Pick at least 1 line' : `Add ${pickedCount} line${pickedCount === 1 ? '' : 's'}`}
          </Button>
        </div>
      </div>
    </div>
  );
};
