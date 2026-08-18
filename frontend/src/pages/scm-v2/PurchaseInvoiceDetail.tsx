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
// (paid_centi > 0) — migration 0106.
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
  useSuppliers, useSupplierDetail,
  type BindingRow, type SupplierRow,
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
import styles from './SalesOrderDetail.module.css';
import { DateField } from "../../vendor/scm/components/DateField";

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
  material_code: string;
  material_name: string;
  qty: number;
  unit_price_centi: number;
  discount_centi?: number;
  line_total_centi?: number;
  item_group?: string | null;
  material_kind?: string | null;
  description?: string | null;
  variants?: Record<string, unknown> | null;
  binding_id?: string | null;
  supplier_sku?: string | null;
  /* GRN-sourced lines carry the source GRN line id; identity + variants on those
     stay read-only (only qty/price editable). Free-entry lines have it null. */
  grn_item_id?: string | null;
};

/* Whole-line edit (T12) — Edit mode drives one PoLineCard per line, the SAME rich
   editor as Create. EditLine = the shared PoLineDraft + the persisted item id
   (absent on a freshly-added blank card) + whether the line came from a GRN. */
type EditLine = PoLineDraft & { itemId?: string; grnLinked?: boolean };

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
  materialCode:   it.material_code,
  materialName:   it.material_name,
  supplierSku:    it.supplier_sku ?? undefined,
  qty:            it.qty,
  unitPriceCenti: it.unit_price_centi,
  discountCenti:  it.discount_centi ?? 0,
  category:       it.item_group ?? undefined,
  variants:       (it.variants as Record<string, unknown> | null) ?? {},
  /* An existing line's stored price is authoritative — don't let the cost
     auto-recompute clobber it on enter-edit. Editing variants re-arms it. */
  priceTouched:   true,
});

export const PurchaseInvoiceDetail = () => {
  const { id } = useParams<{ id: string }>();
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
  // payment recorded (paid_centi > 0) OR is CANCELLED. POSTED with zero payment
  // stays editable.
  const isLocked = pi ? (pi.status === 'CANCELLED' || (pi.paid_centi ?? 0) > 0) : true;
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

  /* Cost auto-recompute effect — re-price every non-touched, non-GRN-linked
     editLine off the supplier matrix + maintenance surcharges. Gated to Edit. */
  useEffect(() => {
    if (!isEditing) return;
    setEditLines((prev) => {
      let changed = false;
      const next = prev.map((l) => {
        if (l.priceTouched || l.grnLinked) return l;
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
    ? editLines.reduce((s, d) => s + Math.max(0, d.qty * d.unitPriceCenti - (d.discountCenti ?? 0)), 0)
    : visibleItems.reduce((s, it) => s + (it.line_total_centi ?? (it.qty * it.unit_price_centi - (it.discount_centi ?? 0))), 0);
  const taxCenti = pi.tax_centi ?? 0;
  const grandTotal = itemsSubtotal + taxCenti;
  const paidCenti = pi.paid_centi ?? 0;
  const balanceCenti = grandTotal - paidCenti;

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
      materialCode:   b.material_code,
      materialName:   b.material_name,
      supplierSku:    b.supplier_sku,
      unitPriceCenti: b.unit_price_centi,
      category:       categoryForCode(b.material_code),
      priceTouched:   false,
    });

  /* Patch one variant key + auto-compute bedframe Total Height (= Divan + Leg +
     Gap), mirroring Create's setVariant. Editing a variant re-arms the cost
     auto-recompute (priceTouched ← false). */
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

  /* Append a fresh blank PoLineCard (PI is free-entry — grn_item_id null).
     Committed by the page-level Save. */
  const startAddLine = () =>
    setEditLines((prev) => [...prev, { ...emptyPoLine() }]);

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
       · no itemId → ADD (full payload incl. variants / materialCode)
       · itemId + changed any field → UPDATE (full payload)
     Deletes already fired server-side in removeLine. Then commit the header (if
     touched) and drop back to View. The server 409s over-invoicing a GRN-linked
     line → surfaced via notify. */
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
        await updateHeader.mutateAsync({ id: pi.id, ...(headerDraft as Record<string, unknown>) });
      }
      const byId = new Map(items.map((it) => [it.id, it]));
      for (const d of editLines) {
        if (!d.itemId) {
          // New free-entry line — full insert payload (grnItemId null).
          await addItem.mutateAsync({
            id: pi.id,
            materialKind:   d.materialKind,
            materialCode:   d.materialCode,
            materialName:   d.materialName || d.materialCode,
            qty:            d.qty,
            unitPriceCenti: d.unitPriceCenti,
            discountCenti:  d.discountCenti ?? 0,
            bindingId:      d.bindingId,
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
          (d.category ?? '') !== (it.item_group ?? '') ||
          d.qty !== it.qty ||
          d.unitPriceCenti !== it.unit_price_centi ||
          (d.discountCenti ?? 0) !== (it.discount_centi ?? 0) ||
          JSON.stringify(d.variants ?? {}) !== JSON.stringify((it.variants as Record<string, unknown> | null) ?? {});
        if (!changed) continue;
        await updateItem.mutateAsync({
          id: pi.id, itemId: d.itemId,
          materialCode:   d.materialCode,
          materialName:   d.materialName || d.materialCode,
          qty:            d.qty,
          unitPriceCenti: d.unitPriceCenti,
          discountCenti:  d.discountCenti ?? 0,
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

  const deliverPrintPdf = (action: PdfAction) => {
    // PI PDF (AutoCount layout) — mirrors PO/GRN's print wiring its own
    // purchase-invoice-pdf helper.
    return import('../../vendor/scm/lib/purchase-invoice-pdf').then(({ generatePurchaseInvoicePdf }) =>
      generatePurchaseInvoicePdf(pi, items as any, { action }),
    ).catch((e) => notify({ title: 'PDF generation failed', body: `${e instanceof Error ? e.message : 'Something went wrong.'}`, tone: 'error' }));
  };
  const print = usePrintPreview(deliverPrintPdf);

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
              blank PoLineCard (PI is free-entry). Hidden while the PI is locked. */}
          {isEditing && !isLocked && (
            <Button variant="primary" size="sm" onClick={startAddLine}>
              <Plus {...ICON} />
              <span>Add item</span>
            </Button>
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
              <PoLineCard
                key={l.rid}
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
                <th className={styles.tableRight}>Qty</th>
                <th className={styles.tableRight}>Unit</th>
                <th className={styles.tableRight}>Disc</th>
                <th className={styles.tableRight}>Total</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((it) => (
                <tr key={it.id}>
                  <td>
                    <div className={styles.codeCell}>{it.material_code}</div>
                    {(() => {
                      const summary = buildVariantSummary(it.item_group ?? null, it.variants as Record<string, unknown> | null)
                        || it.description
                        || it.material_name;
                      return summary ? <div className={styles.muted} style={{ fontSize: 'var(--fs-11)' }}>{summary}</div> : null;
                    })()}
                  </td>
                  <td className={styles.muted}>{it.item_group ?? it.material_kind ?? '—'}</td>
                  <td className={styles.tableRight}>{it.qty}</td>
                  <td className={styles.tableRight}>{fmtRm(it.unit_price_centi, pi.currency)}</td>
                  <td className={styles.tableRight}>{(it.discount_centi ?? 0) > 0 ? fmtRm(it.discount_centi, pi.currency) : '—'}</td>
                  <td className={styles.priceCell}>{fmtRm(it.line_total_centi ?? (it.qty * it.unit_price_centi - (it.discount_centi ?? 0)), pi.currency)}</td>
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
              <span className={styles.totalValue}>{fmtRm(taxCenti, pi.currency)}</span>
            </div>
            <div className={`${styles.totalRow} ${styles.grandTotalRow}`}>
              <span className={styles.totalLabel}>Total</span>
              <span className={`${styles.totalValue} ${styles.grandTotal}`}>{fmtRm(grandTotal, pi.currency)}</span>
            </div>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Paid</span>
              <span className={styles.totalValue}>{fmtRm(paidCenti, pi.currency)}</span>
            </div>
            <div className={styles.totalRow}>
              <span className={styles.totalLabel}>Balance</span>
              <span className={styles.totalValue}>{fmtRm(balanceCenti, pi.currency)}</span>
            </div>
          </div>
        </div>
      </section>
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
            <InfoCell label="Source GRN" value={pi.grn?.grn_number || null} />
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
            <DateField
              fullWidth
              className={styles.fieldInput}
              value={draft.dueDate}
              disabled={locked}
              onChange={(iso) => onField('dueDate', iso)}
            />
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
