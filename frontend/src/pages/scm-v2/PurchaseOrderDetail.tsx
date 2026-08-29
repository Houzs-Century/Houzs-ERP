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
import { buildVariantSummary, fmtDate, fmtDateTime } from '@2990s/shared'; // Commander 2026-05-28 — Description 2
import { poDisplayNumber } from '../../vendor/scm/lib/po-status';
import { convertToLink } from '../../lib/convertScope';

/* dd/mm/yyyy — the one rule, under the name this file already uses. */
const fmtDmy = fmtDate;
import { formatPhone } from '@2990s/shared/phone';
import { PrintPreviewModal, usePrintPreview } from '../../components/scm-v2/PrintPreviewModal';
import type { PdfAction } from '../../vendor/scm/lib/pdf-common';
import {
  usePurchaseOrderDetail,
  useUpdatePurchaseOrderHeader,
  useAddPurchaseOrderItem,
  useUpdatePurchaseOrderItem,
  useDeletePurchaseOrderItem,
  useCancelPurchaseOrder,
  useConfirmPurchaseOrder,
  useReopenPurchaseOrder,
  useSuppliers,
  useSupplierDetail,
  useOutstandingSoItems,
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
import { SearchableSelect } from '../../vendor/scm/components/SearchableSelect';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { canOperatePurchaseOrders } from '../../auth/salesAccess';
import { SoLinePhotoStrip } from '../../components/scm-v2/SoLinePhotoStrip';
import {
  uploadPoItemPhoto,
  deletePoItemPhoto,
  isPoOwnedPhotoKey,
} from '../../vendor/scm/lib/sales-order-queries';
import {
  useApprovePo,
  useSendAmendment,
  usePoRevisions,
  type SoRevisionRow,
} from '../../vendor/scm/lib/so-amendment-queries';
import styles from './SalesOrderDetail.module.css';
import { computeTotalHeight, isTotalHeightCategory, isTotalHeightPart } from '../../vendor/shared/total-height';
import { DateField } from "../../vendor/scm/components/DateField";

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

/* The three supplier-revised date slots (mig 0026). Both the header draft and
   every line draft key them identically, which is what lets "Apply to all"
   copy one to the other by key. */
type SupplierDateKey = 'supplierDeliveryDate2' | 'supplierDeliveryDate3' | 'supplierDeliveryDate4';
const SUPPLIER_DATE_KEYS: readonly SupplierDateKey[] = [
  'supplierDeliveryDate2', 'supplierDeliveryDate3', 'supplierDeliveryDate4',
] as const;
const SUPPLIER_DATE_LABEL: Record<SupplierDateKey, string> = {
  supplierDeliveryDate2: 'Supplier Date 2',
  supplierDeliveryDate3: 'Supplier Date 3',
  supplierDeliveryDate4: 'Supplier Date 4',
};

/* An unfilled <input type="date"> holds '', and the header draft is spread
   straight into the PATCH — so a blank Supplier Date 2/3/4 posted "" and the
   whole save came back 500 "invalid input syntax for type date" (production,
   2026-08-17). The BACKEND is the fix (scm/lib/date-coerce coerces this on every
   date write, and the mobile app and any direct API caller never pass through
   this form at all); this is the second layer, so the payload says what it
   means: a cleared date is NULL. */
const blankDateToNull = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};

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
  itemCode:   it.item_code,
  materialName:   it.material_name,
  supplierSku:    it.supplier_sku ?? undefined,
  qty:            it.qty,
  unitPriceSen: it.unit_price_sen,
  discountSen:  it.discount_sen ?? 0,
  deliveryDate:   it.delivery_date ?? undefined,
  supplierDeliveryDate2: it.supplier_delivery_date_2 ?? undefined,
  supplierDeliveryDate3: it.supplier_delivery_date_3 ?? undefined,
  supplierDeliveryDate4: it.supplier_delivery_date_4 ?? undefined,
  warehouseId:    it.warehouse_id ?? undefined,
  category:       it.item_group ?? undefined,
  variants:       (it.variants as Record<string, unknown> | null) ?? {},
  /* Migration 0098 — the stored source SO line. Seeded so Edit can SHOW the
     existing binding (and change it) instead of silently dropping it: without
     this the draft always read null, so the Save diff could never tell a bound
     line from an unbound one. */
  soItemId:       it.so_item_id ?? null,
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
  const addItem = useAddPurchaseOrderItem();
  const updateItem = useUpdatePurchaseOrderItem();
  const deleteItem = useDeletePurchaseOrderItem();
  const askConfirm = useConfirm();
  const notify = useNotify();
  // PR #102 — PO PDF (AutoCount layout) needs the Purchase Location's
  // human-readable name; the header only carries the warehouse id. Load
  // warehouses once at the top so the print handler can resolve it.
  const warehousesQTop = useWarehouses();
  /* Candidate source SO lines for the per-line binder (2026-07-31). REUSES the
     stock-aware shortage view the From-SO picker and MobileConvertWizard read
     (GET /mfg-purchase-orders/outstanding-so-items) rather than a second query:
     it is already company-scoped, already drops cancelled / draft / on-hold SOs
     and already hides lines with no remaining shortage, which is exactly the
     "still short" rule this picker needs. */
  const outstandingSoQ = useOutstandingSoItems();

  /* Phase 1-C — SO-amendment workflow (approve-po / send gates + revisions
     list). The green "Revision ready" banner hosts Approve PO (at SO_APPROVED)
     then Send + Download Revised PO (at PO_APPROVED); the Revisions tab lists
     prior PO snapshots. Buttons are gated on the Houzs scm.amendment.approve_po
     permission (the server 403 stays the real gate). */
  const { can, pageAccess } = useHouzsAuth();
  /* LINE PHOTOS ON THE EDIT CARD (owner 2026-08-28: 「还是不能添加照片啊」).
     #2759 put the strip on the PO's TABLE view and gave the server its upload
     and delete routes; the rich line editor — the screen a purchaser is
     actually on when they want to attach a photo — never got one, because this
     card was written as "the same SHAPE as SoLineCard" rather than as a use of
     it, so the rail SoLineCard grew later never arrived here.

     Same component, same cohort gate and same helpers as the table view, so
     there is one behaviour rather than two. */
  const mayEditPoPhotos = canOperatePurchaseOrders(can, pageAccess);
  const uploadLinePhoto = async (itemId: string, file: File) => {
    if (!po?.id) return;
    await uploadPoItemPhoto(po.id, itemId, file);
    await detail.refetch();
  };
  const deleteLinePhoto = async (itemId: string, photoKey: string) => {
    if (!po?.id) return;
    await deletePoItemPhoto(po.id, itemId, photoKey);
    await detail.refetch();
  };
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
  /* Owner 2026-08-20 (§8 GAP-1) — a GRN no longer freezes the WHOLE PO. The
     lock is now field-level (matching the backend po-identity-lock):
       · hardLocked — RECEIVED / CANCELLED: everything read-only, no Edit at all.
       · lockedDueToChildren — a live GRN exists: only the INHERITED header
         fields (supplier / currency / purchase location) + the LINES freeze; the
         PO's own dates + notes stay editable. To change an inherited field,
         cancel the GRN and edit the PO.
     `isLocked` (= hard OR children) still gates the LINE editor + inherited
     fields; `hardLocked` gates the Edit button + the PO-own header fields. */
  const hardLocked = po ? !isEditableStatus : true;
  const isLocked = po ? (!isEditableStatus || hasChildren) : true;
  const lockedDueToChildren = po ? (isEditableStatus && hasChildren) : false;

  /* Only a HARD lock (Received / Cancelled) drops us out of Edit — a PO with a
     GRN stays editable for its own-stage fields, so children must NOT kick us
     back to View. */
  useEffect(() => {
    if (hardLocked && isEditing) {
      setIsEditing(false);
      setHeaderDraft(null);
      setEditLines([]);
    }
  }, [hardLocked, isEditing]);

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
        if (cost === l.unitPriceSen) return l;
        changed = true;
        return { ...l, unitPriceSen: cost };
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, bindings, fabrics, maint, editLines]);

  /* Client-side PO PDF generator. Shared by the header "Print PDF" and the
     amendment banner's "Download Revised PO" — the same generator, just an
     optional docTitle so the revised copy prints "Revised Purchase Order". The
     operator downloads / prints / WhatsApps it themselves (Houzs's "Send" only
     marks the amendment SENT — mirroring 2990, no server email here).

     HOOKS MUST ALL BE ABOVE THE GUARDS BELOW. usePrintPreview sat under them
     until 2026-08-17, so the loading render called fewer hooks than the loaded
     one and React threw #310 ("rendered more hooks than during the previous
     render") the moment the query resolved — a blank "Something went wrong
     loading this page." on every direct URL / refresh of a PO. Arriving from
     the list hid it: react-query already had the detail cached, so the
     isPending branch never rendered first. The generator therefore has to
     tolerate a null po; it can only ever be CALLED from a button that does not
     exist until the record has loaded. */
  const generatePoPdf = (docTitle?: string, action: PdfAction = 'save') => {
    if (!po) return;
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
      generatePurchaseOrderPdf(headerForPdf, items, { ...(docTitle ? { docTitle } : {}), action }),
    ).catch((e) => notify({ title: 'PDF generation failed', body: `${e instanceof Error ? e.message : 'Something went wrong.'}`, tone: 'error' }));
  };
  const print = usePrintPreview((action: PdfAction) => generatePoPdf(undefined, action));

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

  /* Source-SO-line options for one draft line. Only lines for the SAME SKU are
     offered (the server refuses a mismatch anyway, and offering one would just
     be a trap), and only lines the shortage view still reports as short. A line
     that is ALREADY bound keeps its own option even when it has dropped off the
     shortage view — otherwise a controlled select would fall back to the
     placeholder and the operator would read a real binding as "none". */
  const soLinkOptionsFor = (l: EditLine): Array<{ value: string; label: string }> => {
    const code = l.itemCode.trim().toUpperCase();
    const opts: Array<{ value: string; label: string }> = [];
    if (code) {
      for (const s of outstandingSoQ.data ?? []) {
        if ((s.itemCode ?? '').trim().toUpperCase() !== code) continue;
        const who = s.debtorName ? ` · ${s.debtorName}` : '';
        opts.push({ value: s.soItemId, label: `${s.soDocNo}${who} · ${s.remainingQty} short` });
      }
    }
    if (l.soItemId && !opts.some((o) => o.value === l.soItemId)) {
      const stored = items.find((it) => it.id === l.itemId);
      opts.unshift({
        value: l.soItemId,
        label: `${stored?.so_doc_no ?? 'Linked Sales Order'} · currently linked`,
      });
    }
    return opts;
  };

  /* SO→PO drift (Commander 2026-06-16) — lines whose source SO was edited AFTER
     this PO was raised, so the PO no longer matches the live SO. Only actionable
     while the PO is still open (pre-receipt): a received / cancelled PO can't be
     re-sent anyway, so we hide the warning there. */
  const driftCount = visibleItems.filter((it) => it.so_drift).length;
  const showDrift = po.status === 'SUBMITTED' || po.status === 'PARTIALLY_RECEIVED';
  /* Totals — in Edit, sum the live editLines (incl. unsaved variant/qty/price
     edits) so the rail can't drift; in View, the stored line totals. */
  const itemsSubtotal = isEditing
    ? editLines.reduce((s, d) => s + Math.max(0, d.qty * d.unitPriceSen - (d.discountSen ?? 0)), 0)
    : visibleItems.reduce((s, it) => s + (it.line_total_sen ?? 0), 0);
  const grandTotal = itemsSubtotal + (po.tax_sen ?? 0);

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
    /* Owner 2026-08-20 (§8 GAP-1) — when a GRN exists the LINES are locked
       (they were received), so a header date edit must NOT fan down into
       editLines: doing so would mark a locked line "changed" and Save would
       then 409 on the line PATCH. The header date still saves on its own; the
       backend fills only still-NULL line slots server-side. So skip every
       line cascade below while `lockedDueToChildren`. */
    if (lockedDueToChildren) return;
    // Commander 2026-05-29 — header Expected Delivery cascades to every line's
    // delivery date ("上面的 Expected Delivery Date 换了之后，下面 Item 的
    // Delivery Date 也要跟着跳").
    if (k === 'expectedAt') {
      setEditLines((prev) => prev.map((d) => ({ ...d, deliveryDate: v || undefined })));
    }
    /* Mig 0026 — header supplier-revised dates fan down to every line that
       doesn't already carry its own value for that slot. Lines that DO carry
       one are left alone here on purpose (a line can be revised on its own);
       to overwrite every line use "Apply to all" — see applySupplierDateToAll. */
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

  /* Batch the supplier-revised date across the whole PO (owner 2026-08-03).
     The fan-down above only fills EMPTY slots, which is right the first time a
     supplier quotes a revised date — but a supplier that pushes the date a
     SECOND time leaves every line already filled, so the header input moved
     nothing and the only way through was editing each line by hand. This is
     the explicit, opt-in overwrite: it exists as a button rather than as
     header-input behaviour so a line that was revised on its own is never
     silently flattened by someone touching the header. */
  const applySupplierDateToAll = (k: SupplierDateKey): number => {
    const v = (headerView[k] ?? '').trim();
    if (!v) return 0;                     // nothing to apply; the button is disabled too
    setEditLines((prev) => prev.map((d) => ({ ...d, [k]: v })));
    return editLines.length;
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
     (priceTouched ← false) so the line re-prices off the new spec. */
  const setVariant = (rid: string, k: string, v: unknown) =>
    setEditLines((prev) => prev.map((l) => {
      if (l.rid !== rid) return l;
      const variants: Record<string, unknown> = { ...l.variants, [k]: v };
      if (isTotalHeightCategory(l.category) && isTotalHeightPart(k)) {
        variants.totalHeight = computeTotalHeight(l.category, variants);
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
       · no itemId → ADD (full payload incl. variants / itemCode / SKU)
       · itemId + changed any field → UPDATE (full payload)
     Deletes already fired server-side in removeLine. Then commit the header (if
     touched) and drop back to View. */
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
        await updateHeader.mutateAsync({
          id: po.id,
          ...(headerDraft as Record<string, unknown>),
          /* Only the three OPTIONAL slots are nulled here. `po_date` is
             `date DEFAULT now() NOT NULL` (scm-schema/2990s-full-schema.sql)
             and both poDate and expectedAt are required inputs on this form, so
             nulling them would trade one refusal for another. */
          supplierDeliveryDate2: blankDateToNull(headerDraft.supplierDeliveryDate2),
          supplierDeliveryDate3: blankDateToNull(headerDraft.supplierDeliveryDate3),
          supplierDeliveryDate4: blankDateToNull(headerDraft.supplierDeliveryDate4),
        });
      }
      const byId = new Map(items.map((it) => [it.id, it]));
      for (const d of editLines) {
        if (!d.itemId) {
          // New line — full insert payload.
          await addItem.mutateAsync({
            poId: po.id,
            materialKind:   d.materialKind,
            itemCode:   d.itemCode,
            materialName:   d.materialName || d.itemCode,
            supplierSku:    d.supplierSku,
            qty:            d.qty,
            unitPriceSen: d.unitPriceSen,
            bindingId:      d.bindingId,
            discountSen:  d.discountSen,
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
          d.itemCode !== it.item_code ||
          (d.materialName || d.itemCode) !== it.material_name ||
          (d.supplierSku ?? '') !== (it.supplier_sku ?? '') ||
          (d.category ?? '') !== (it.item_group ?? '') ||
          d.qty !== it.qty ||
          d.unitPriceSen !== it.unit_price_sen ||
          (d.discountSen ?? 0) !== (it.discount_sen ?? 0) ||
          (d.deliveryDate ?? null) !== (it.delivery_date ?? null) ||
          (d.supplierDeliveryDate2 ?? null) !== (it.supplier_delivery_date_2 ?? null) ||
          (d.supplierDeliveryDate3 ?? null) !== (it.supplier_delivery_date_3 ?? null) ||
          (d.supplierDeliveryDate4 ?? null) !== (it.supplier_delivery_date_4 ?? null) ||
          (d.warehouseId ?? null) !== (it.warehouse_id ?? null) ||
          (d.soItemId ?? null) !== (it.so_item_id ?? null) ||
          JSON.stringify(d.variants ?? {}) !== JSON.stringify((it.variants as Record<string, unknown> | null) ?? {});
        if (!changed) continue;
        await updateItem.mutateAsync({
          poId: po.id, itemId: d.itemId,
          itemCode:   d.itemCode,
          materialName:   d.materialName || d.itemCode,
          supplierSku:    d.supplierSku,
          qty:            d.qty,
          unitPriceSen: d.unitPriceSen,
          discountSen:  d.discountSen ?? 0,
          deliveryDate:   blankDateToNull(d.deliveryDate),
          /* Mig 0026 — per-line supplier-revised delivery dates. */
          supplierDeliveryDate2: blankDateToNull(d.supplierDeliveryDate2),
          supplierDeliveryDate3: blankDateToNull(d.supplierDeliveryDate3),
          supplierDeliveryDate4: blankDateToNull(d.supplierDeliveryDate4),
          warehouseId:    d.warehouseId ?? null,
          itemGroup:      d.category,
          variants:       d.variants ?? {},
          /* Explicit null UNBINDS; the key is always sent so a cleared picker
             actually reaches the server (an absent key means "keep"). */
          soItemId:       d.soItemId ?? null,
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
            const lineName = (hit?.material_name || hit?.item_code || '').trim();
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

      {/* ── Header — V2-parity chrome (owner 2026-07-27 "这里设计不对"): the
          edit surface opens with the same header language as the V2 detail
          pages — square back button, display-weight supplier title, status
          pill, mono meta line (with the _R revision display number). The
          action buttons keep their existing logic untouched. ── */}
      <div className="mb-3 border-b border-border pb-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <button
              type="button"
              onClick={() => navigate('/scm/purchase-orders')}
              aria-label="Back to Purchase Orders"
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary hover:border-primary/50 hover:text-primary"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
                  {po.supplier?.name ?? po.supplier?.code ?? po.po_number}
                </h1>
                <StatusPill docType="po" status={po.status} />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-secondary">
                <span className="font-mono font-semibold text-primary-ink text-[15px]">
                  {poDisplayNumber(po.po_number, (po as unknown as { revision?: number | null }).revision)}
                </span>
                <span>·</span>
                <span>Ordered {fmtDmy(po.po_date)}</span>
                {po.expected_at && (
                  <>
                    <span>·</span>
                    <span>Expected {fmtDmy(po.expected_at)}</span>
                  </>
                )}
                <span>·</span>
                <span>{visibleItems.length} line{visibleItems.length === 1 ? '' : 's'}</span>
                {po.supplier?.code && (
                  <>
                    <span>·</span>
                    <span className="font-mono font-semibold">{po.supplier.code}</span>
                  </>
                )}
                <span>·</span>
                {/* Total rides the meta line (owner 2026-07-27) — out of the
                    action row so the buttons stop wrapping. Tracks live draft
                    edits. */}
                <span className="font-money font-semibold text-ink">
                  Total {fmtRm(grandTotal, po.currency)}
                </span>
              </div>
            </div>
          </div>
          {/* styles.actions / styles.totalRail were RETIRED from the module css
              ("header chrome is inline Tailwind now") but this page never
              followed — the classNames resolved to undefined and the whole
              action row rendered unstyled/overflowing. Real utilities now. */}
          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          {/* Total + status pill now live in the title / meta rows (V2-parity
              header, owner 2026-07-27) so this row carries ONLY action buttons
              and stops wrapping a lone Save onto a second line. */}
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
          {/* View-only actions (owner 2026-07-27): hidden while editing so the
              edit action row stays on ONE line — Receive Goods sits beside Save
              instead of wrapping. Both return in view mode. */}
          {!isEditing && <RelationshipMapButton type="po" id={po.id} />}
          {!isEditing && (
            <>
            <Button variant="ghost" size="md" onClick={print.openPreview}>
              <Printer {...ICON} />
              <span>Print PDF</span>
            </Button>
            <PrintPreviewModal
              open={print.open}
              onClose={print.close}
              docTitle="Purchase Order"
              docNo={poDisplayNumber(po.po_number, (po as unknown as { revision?: number | null }).revision)}
              rows={[
                { label: 'Supplier', value: po.supplier?.name ?? po.supplier?.code ?? '—' },
                { label: 'Items', value: `${items.length} line${items.length === 1 ? '' : 's'}` },
              ]}
              {...print.handlers}
            />
            </>
          )}
          {/* PR #78 — Transfer from Sales Order. Gated behind Edit mode (it
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
              The Delete half of that report no longer exists: the endpoint and
              both buttons were removed 2026-08-11 (#1939) under the owner rule
              不可以删只可以 cancel. Cancel + Reopen are the whole surface. */}
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
          {/* A CANCELLED PO used to offer "Permanently delete". Removed with its
              endpoint (owner rule 2026-08-11: 不可以删只可以 cancel). Cancel is
              the terminal state; the record stays so AutoCount can be
              reconciled against it. */}
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
              onClick={() => navigate(convertToLink('poToPr', po.id))}>
              <span>Raise Return</span>
            </Button>
          )}
          {/* View → Edit gate (Commander 2026-05-29). Default View shows a
              primary Edit button (disabled while the PO is locked). Editing
              flips into draft mode; the button becomes the single "Save" that
              commits the whole draft. Back (top-left) discards. */}
          {!isEditing ? (
            <Button variant="primary" size="md" onClick={enterEdit} disabled={hardLocked}>
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
            {/* Owner 2026-07-27 — the amendment number is a LINK to its detail,
                where the full WAS → REQUESTING diff (what the customer changed)
                lives. Approving the PO here doesn't show the change details
                inline, so the operator needs one click to see exactly what was
                revised. */}
            <span>
              Revision ready — amendment{' '}
              <button
                type="button"
                onClick={() => navigate(`/scm/amendments/${openAmendment.id}`)}
                style={{
                  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                  color: 'var(--c-secondary-a, #2F5D4F)', fontWeight: 700,
                  fontSize: 'inherit', textDecoration: 'underline',
                }}
              >
                {openAmendment.amendment_no}
              </button>
              {' '}(view change details)
            </span>
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
        onApplySupplierDateToAll={applySupplierDateToAll}
        locked={hardLocked}
        identityLocked={lockedDueToChildren}
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
          /* English copy (owner UI rule: no Chinese ships in the interface;
             swept 2026-07-27 while fixing the missing edit-mode redline). */
          <div className={styles.bannerWarn} style={{ margin: 'var(--space-2) var(--space-3)' }}>
            {/* bannerWarn is a COLUMN flex — bare text + <strong> children become
                separate flex rows (the old Chinese copy broke the same way), so
                the whole sentence rides in ONE span. */}
            <span>
              ⚠ <strong>{driftCount}</strong> line{driftCount === 1 ? "'s" : 's'} source SO changed after this
              PO was raised. Check the red notes below, sync the specs, then <strong>re-send to the
              supplier</strong> — otherwise the factory keeps building to the old spec.
            </span>
          </div>
        )}

        {isEditing ? (
          /* Whole-line inline edit (owner 2026-06-19) — every line is a
             PoLineCard (the SAME editor as Create), all editable at once. The
             card owns the item/SKU picker, variant selects, special orders, cost
             auto-recompute, and the qty/price/disc/delivery/ship-to row. The ONE
             page-level Save diffs each draft and add/update/deletes. */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-3)' }}>
            {editLines.map((l, idx) => {
              /* Owner 2026-07-27 ("为什么没有 SO Request 的相关信息?") — the
                 per-line SO-drift redline rendered ONLY in the View table, yet
                 the drift banner AND the amendment's bound-PO jump both land in
                 EDIT mode — the very place the spec must be synced before
                 Approve PO. Surface the same redline above each affected card
                 (matched by the draft's itemId; new manual lines have none). */
              const drift = showDrift
                ? (visibleItems.find((it) => it.id === l.itemId)?.so_drift ?? null)
                : null;
              return (
                <div key={l.rid} style={{ display: 'grid', gap: 4 }}>
                  {drift && (
                    <div style={{
                      fontSize: 'var(--fs-11)', fontWeight: 700,
                      color: 'var(--c-danger, #b8331f)',
                      background: 'rgba(184, 51, 31, 0.06)',
                      border: '1px solid rgba(184, 51, 31, 0.3)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '6px 10px',
                      display: 'grid', gap: 2,
                    }}>
                      {drift.itemChanged && (
                        <div>⚠ SO now orders {drift.itemSo} (this PO still has {drift.itemPo}) — cancel &amp; re-raise is safer than editing.</div>
                      )}
                      {!drift.itemChanged && drift.specSo !== drift.specPo && (
                        <div>⚠ SO spec now: {drift.specSo || '—'} (this PO still: {drift.specPo || '—'})</div>
                      )}
                      {drift.warehouseChanged && (
                        <div>⚠ SO warehouse moved — change this line's warehouse to the SO's, then Save.</div>
                      )}
                    </div>
                  )}
                  <PoLineCard
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
                    soLinkOptions={soLinkOptionsFor(l)}
                    photos={
                      /* A LINE THAT IS NOT SAVED YET HAS NOWHERE TO PUT A
                         PHOTO. The keys are `po-items/<po>/<item id>/…`, so
                         the item id is not a detail — it is the address. A
                         brand-new card therefore says so instead of showing a
                         control that would throw: silently omitting the rail
                         is what sent the owner looking for it in the first
                         place. Save the line, then attach. */
                      l.itemId ? (
                        <div style={{ display: 'grid', gap: 4 }}>
                          <span className={styles.fieldLabel}>Photos</span>
                          <SoLinePhotoStrip
                            source="po"
                            docId={po.id}
                            itemId={l.itemId}
                            photoKeys={
                              visibleItems.find((it) => it.id === l.itemId)?.photo_urls ?? []
                            }
                            edit={
                              mayEditPoPhotos && !isLocked && po.status !== 'CANCELLED'
                                ? {
                                    onUpload: (file) => uploadLinePhoto(l.itemId!, file),
                                    onDelete: (key) => deleteLinePhoto(l.itemId!, key),
                                    canDeleteKey: isPoOwnedPhotoKey,
                                  }
                                : null
                            }
                          />
                        </div>
                      ) : (
                        <div style={{ display: 'grid', gap: 4 }}>
                          <span className={styles.fieldLabel}>Photos</span>
                          <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
                            Save this line first, then attach photos to it.
                          </span>
                        </div>
                      )
                    }
                  />
                </div>
              );
            })}
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
                    <div className={styles.codeCell}>{it.item_code}</div>
                    {(() => {
                      const summary = buildVariantSummary(it.item_group, it.variants as Record<string, unknown> | null)
                        || it.description
                        || it.material_name;
                      return summary ? <div className={styles.muted} style={{ fontSize: 'var(--fs-11)' }}>{summary}</div> : null;
                    })()}
                    {showDrift && it.so_drift && (
                      /* English copy (owner UI rule; swept 2026-07-27 with the
                         edit-mode redline fix — both modes read identically). */
                      <div style={{ marginTop: 3, fontSize: 'var(--fs-11)', fontWeight: 700, color: 'var(--c-danger, #b8331f)', display: 'grid', gap: 2 }}>
                        {it.so_drift.itemChanged && (
                          <div>⚠ SO now orders {it.so_drift.itemSo} (this PO still has {it.so_drift.itemPo}) — cancel &amp; re-raise is safer than editing.</div>
                        )}
                        {!it.so_drift.itemChanged && it.so_drift.specSo !== it.so_drift.specPo && (
                          <div>⚠ SO spec now: {it.so_drift.specSo || '—'} (this PO still: {it.so_drift.specPo || '—'})</div>
                        )}
                        {/* Staff #12 — SO line's ship-from warehouse moved after this PO
                            was raised; the PO still points at the old warehouse. Rebind
                            via Edit → change this line's warehouse → Save (the line PATCH
                            is GRN-gated, so a received PO can't be rebound). */}
                        {it.so_drift.warehouseChanged && (
                          <div>⚠ SO warehouse moved — this PO still points at the old one. Edit → change this line's warehouse to the SO's → Save (blocked once received).</div>
                        )}
                      </div>
                    )}
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{it.supplier_sku?.trim() || '—'}</td>
                  <td className={styles.muted}>{it.item_group ?? it.material_kind}</td>
                  <td className={styles.tableRight}>{it.qty}</td>
                  <td>{renderReceived(it)}</td>
                  <td className={styles.tableRight}>{fmtRm(it.unit_price_sen, po.currency)}</td>
                  <td className={styles.tableRight}>{(it.discount_sen ?? 0) > 0 ? fmtRm(it.discount_sen, po.currency) : '—'}</td>
                  <td className={styles.priceCell}>{fmtRm(it.line_total_sen, po.currency)}</td>
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
              <span className={styles.totalValue}>{fmtRm(po.tax_sen, po.currency)}</span>
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
  po, draft, onField, onApplySupplierDateToAll, locked, identityLocked = false, isEditing = true,
}: {
  po: any;
  /** Draft header values (page-owned). In View these mirror the saved PO. */
  draft: HeaderDraft;
  /** Update a single header field on the page draft. */
  onField: (k: keyof HeaderDraft, v: string) => void;
  /** Overwrite this supplier-date slot on EVERY line. Returns the line count. */
  onApplySupplierDateToAll: (k: SupplierDateKey) => number;
  /** Hard lock — Received / Cancelled: every field read-only. */
  locked: boolean;
  /** A live GRN exists: the INHERITED fields (supplier / currency / purchase
   *  location) freeze because a GRN was received against them, but the PO's own
   *  dates + notes stay editable (owner 2026-08-20, §8 GAP-1). */
  identityLocked?: boolean;
  /** View → Edit gate. When false the card renders read-only display text. */
  isEditing?: boolean;
}) => {
  // Inherited fields freeze on EITHER a hard lock or a live GRN; own fields on
  // the hard lock only.
  const inheritedLocked = locked || identityLocked;
  /* "Applied to N lines" acknowledgement. Deliberately an inline flash and not
     a NotifyDialog: the dialog is modal with an OK button, which would turn a
     one-tap batch into two taps for something the line cards show anyway. */
  const [appliedFlash, setAppliedFlash] = useState<{ key: SupplierDateKey; count: number } | null>(null);
  useEffect(() => {
    if (!appliedFlash) return;
    const t = setTimeout(() => setAppliedFlash(null), 2600);
    return () => clearTimeout(t);
  }, [appliedFlash]);

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
        <>
        {identityLocked && (
          <div className={styles.bannerWarn} style={{ marginBottom: 'var(--space-3)' }}>
            <span>
              This PO has a Goods Receipt, so its <strong>supplier, currency, purchase location</strong> and
              line items are locked — a GRN was received against them. Its dates and notes are still editable.
              To change a locked field, cancel the GRN first, then edit the PO.
            </span>
          </div>
        )}
        <div className={styles.formGrid4}>
          <label className={styles.field} style={{ gridColumn: 'span 2' }}>
            <span className={styles.fieldLabel}>Supplier *</span>
            <span className={styles.selectWrap}>
              <SearchableSelect
                className={styles.fieldSelect}
                value={draft.supplierId}
                disabled={inheritedLocked}
                onChange={(v) => onField('supplierId', v)}
                placeholder="— Pick supplier —"
                options={sortByText(suppliers).map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))}
              />
              <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
            </span>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Currency</span>
            <span className={styles.selectWrap}>
              <SearchableSelect
                className={styles.fieldSelect}
                value={draft.currency}
                disabled={inheritedLocked}
                onChange={(v) => onField('currency', v)}
                options={[
                  { value: 'MYR', label: 'MYR' },
                  { value: 'RMB', label: 'RMB' },
                  { value: 'USD', label: 'USD' },
                  { value: 'SGD', label: 'SGD' },
                ]}
              />
              <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
            </span>
          </label>
          <div />
          <label className={styles.field}>
            <span className={styles.fieldLabel}>PO Date</span>
            <DateField fullWidth className={styles.fieldInput} value={draft.poDate} disabled={locked} onChange={(iso) => onField('poDate', iso)}/>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Expected Delivery</span>
            {/* Commander 2026-05-29 — changing this cascades to every line's
                Delivery Date (handled in the page's setHeaderField). */}
            <DateField
              fullWidth
              className={styles.fieldInput}
              value={draft.expectedAt}
              disabled={locked}
              onChange={(iso) => onField('expectedAt', iso)}
            />
          </label>
          {/* Mig 0026 — supplier-revised header delivery dates. Typing one fans
              it down to lines that have NO value in that slot (setHeaderField).
              "Apply to all" (owner 2026-08-03) is the explicit overwrite for a
              supplier who revises a second time, when every line is already
              filled and the fan-down therefore moves nothing. */}
          {SUPPLIER_DATE_KEYS.map((k) => (
            <label className={styles.field} key={k}>
              <span className={styles.fieldLabelRow}>
                <span className={styles.fieldLabel}>{SUPPLIER_DATE_LABEL[k]}</span>
                {/* "Apply to all" overwrites every LINE, which is locked once a
                    GRN exists — hide it then, though the header date field stays
                    editable (own-stage). */}
                {!inheritedLocked && (
                  appliedFlash?.key === k ? (
                    <span className={styles.applyAllDone} role="status">
                      Applied to {appliedFlash.count} {appliedFlash.count === 1 ? 'line' : 'lines'}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={styles.applyAllBtn}
                      disabled={!draft[k]}
                      title={draft[k]
                        ? `Overwrite ${SUPPLIER_DATE_LABEL[k]} on every line of this PO`
                        : `Pick a ${SUPPLIER_DATE_LABEL[k]} first`}
                      onClick={(e) => {
                        e.preventDefault();          // never let the <label> re-target the click
                        const n = onApplySupplierDateToAll(k);
                        if (n > 0) setAppliedFlash({ key: k, count: n });
                      }}
                    >
                      Apply to all
                    </button>
                  )
                )}
              </span>
              <DateField fullWidth className={styles.fieldInput} value={draft[k]} disabled={locked} onChange={(iso) => onField(k, iso)}/>
            </label>
          ))}
          {/* PR #77 — Purchase Location: default ship-to warehouse for
              every line on this PO. */}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Purchase Location</span>
            <span className={styles.selectWrap}>
              <SearchableSelect
                className={styles.fieldSelect}
                value={draft.purchaseLocationId}
                disabled={inheritedLocked}
                onChange={(v) => onField('purchaseLocationId', v)}
                options={[
                  { value: '', label: '— No default —' },
                  ...sortByText(warehouses.filter((w) => w.is_active)).map((w) => ({ value: w.id, label: w.code })),
                ]}
              />
              <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
            </span>
          </label>
          <label className={styles.field} style={{ gridColumn: 'span 2' }}>
            <span className={styles.fieldLabel}>Notes</span>
            <input className={styles.fieldInput} value={draft.notes} disabled={locked}
              onChange={(e) => onField('notes', e.target.value)} />
          </label>
        </div>
        </>
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
        {' · '}<strong>Total:</strong> {centi(header.total_sen ?? header.totalSen)}
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
            {lines.map((l, i) => {
              /* Owner 2026-07-27 — the snapshot listed only code/qty/price, so a
                 fabric change (the common amendment) was invisible in the prior
                 version. Show the spec: the stored variant summary if the
                 snapshot line carries variants, else its description2 string. */
              const itemGroup = str(l.item_group ?? l.itemGroup ?? 'others');
              const variants = (l.variants ?? null) as Record<string, unknown> | null;
              const spec =
                buildVariantSummary(itemGroup === '—' ? 'others' : itemGroup, variants) ||
                str(l.description2 ?? l.description ?? '').replace(/^—$/, '');
              return (
                <tr key={i}>
                  <td>
                    <div>{str(l.item_code ?? l.itemCode ?? l.item_code ?? l.itemCode)}</div>
                    {spec && (
                      <div style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', marginTop: 2 }}>
                        {spec}
                      </div>
                    )}
                  </td>
                  <td className={styles.tableRight}>{str(l.qty)}</td>
                  <td className={styles.tableRight}>{centi(l.unit_price_sen ?? l.unitPriceSen)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <span className={styles.muted}>Snapshot has no line detail.</span>
      )}
    </div>
  );
};
