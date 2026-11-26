
import { lazy, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { LazySlot } from "../../components/LazySlot";
import { scmListReturnTo } from "../../lib/scmListReturn";
import { buildVariantSummary, fmtDate, fmtMoneySen, orderLineIdentity, fmtQty } from "@2990s/shared";
import { formatPhone } from "@2990s/shared/phone";
import {
  ArrowLeft,
  Copy,
  History,
  Printer,
  Mail,
  XCircle,
  Edit3,
  CircleDot,
  Phone as PhoneIcon,
  MoreHorizontal,
  CheckCircle2,
  RotateCcw,
  Package,
  FilePenLine,
  Share2,
  Split,
  Plus,
  Undo2,
} from "lucide-react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { NextStepNote } from "../../components/NextStepNote";
import {
  grnTransferBlockReason,
  poConfirmBlockReason,
} from "../../vendor/scm/lib/po-next-step";
import { DataTable, type Column } from "../../components/DataTable";
import { DATA_TABLE_LAYOUT_FAMILIES } from "../../components/dataTableLayoutFamilies";
import {
  DetailGrid,
  DetailMain,
  DetailAside,
  Section,
} from "../../components/DetailLayout";
import {
  usePurchaseOrderDetail,
  useReopenPurchaseOrder,
  useConfirmPurchaseOrder,
  useSupplierDetail,
  type PoHeaderRow,
  type PoItemRow,
} from "../../vendor/scm/lib/suppliers-queries";
import {
  deletePoItemPhoto,
  isPoOwnedPhotoKey,
  uploadPoItemPhoto,
} from "../../vendor/scm/lib/sales-order-queries";
import { canOperatePurchaseOrders } from "../../auth/salesAccess";
import { skuMapFromBindings, supplierCodeFor } from "../../vendor/scm/lib/supplier-doc-data";
import { useWarehouses } from "../../vendor/scm/lib/inventory-queries";
import { poDisplayNumber } from "../../../../shared/src/vendor/scm/lib/po-status";
import { useSetBreadcrumbs } from "../../hooks/useBreadcrumbs";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { useAuth as useHouzsAuth } from "../../auth/AuthContext";
import { PoAmendmentCreateModal } from "../../components/scm-v2/PoAmendmentCreateModal";
// Relationship map (owner 2026-07-27) — the purchase-side twin of the SO/DO/
// SI/DR maps: same shared 5-node canvas, chain + clicks from the PO hook.
import { DocumentRelationshipMapModal, DocumentChoiceDialog } from "../../components/scm-v2/DocumentRelationshipMapModal";
import { usePoRelationshipMap } from "./po-relationship-map";
import { usePoCancelAction } from "./use-po-cancel-action";
import { PoLineAllocationsModal } from "../../components/scm-v2/PoLineAllocationsModal";
import { PrintPreviewModal, useOpenPrintPreviewFromUrl, usePrintPreview } from "../../components/scm-v2/PrintPreviewModal";
import { SoLinePhotoStrip } from "../../components/scm-v2/SoLinePhotoStrip";
import type { PdfAction } from "../../vendor/scm/lib/pdf-common";
import { cn } from "../../lib/utils";
import { convertToLink, transferToLabel } from "../../lib/convertScope";
import { HoldChip } from "../../vendor/scm/components/HoldChip";

import { DocumentHistoryDrawer } from "./DocumentHistoryDrawer";
import { FocAmount } from "../../vendor/scm/components/FocAmount";
import { ADD_LINE_LABEL, addLineHref } from "../../vendor/scm/lib/add-line-handoff";
import { resolvePoRecipients, supplierEmailList } from "../../vendor/shared/supplier-emails";
import { poEmailPhotosNote } from "../../vendor/scm/lib/po-email-photos";

const fmtMoney = (centi: number, currency = "MYR"): string => fmtMoneySen(centi, currency);

const supplierNameOf = (h: PoHeaderRow): string =>
  h.supplier?.name || h.supplier_id || "—";
const supplierCodeOf = (h: PoHeaderRow): string => h.supplier?.code || "—";

const totalOf = (h: PoHeaderRow): number =>
  h.total_sen ?? h.subtotal_sen ?? 0;

type Effective =
  | "on_hold"
  | "draft"
  | "submitted"
  | "partial"
  | "received"
  | "cancelled";
const effectiveOf = (h: PoHeaderRow): Effective => {
  const s = (h.status || "").toUpperCase();
  if (s === "DRAFT") return "draft";
  if (s === "SUBMITTED") return "submitted";
  if (s === "PARTIALLY_RECEIVED") return "partial";
  if (s === "RECEIVED") return "received";
  if (s === "ON_HOLD") return "on_hold";
  return "cancelled";
};

const EFFECTIVE_TONE: Record<
  Effective,
  { tone: "success" | "warning" | "error" | "neutral"; label: string; blurb: string }
> = {
  draft: { tone: "warning", label: "Draft", blurb: "Draft · not yet sent to supplier" },
  submitted: { tone: "warning", label: "Submitted", blurb: "Submitted · awaiting supplier delivery" },
  partial: { tone: "warning", label: "Partially received", blurb: "Partially received · balance still due" },
  received: { tone: "success", label: "Received", blurb: "Received · loop closed" },
  cancelled: { tone: "error", label: "Cancelled", blurb: "Cancelled · no further action" },
  on_hold: { tone: "warning", label: "On Hold", blurb: "On hold · receiving paused, reversible" },
};

const STAGE_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  PARTIALLY_RECEIVED: "Partially received",
  RECEIVED: "Received",
  CANCELLED: "Cancelled",
  ON_HOLD: "On Hold",
};

const initialsOf = (name: string | null | undefined): string => {
  if (!name) return "—";
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "—"
  );
};

const receivedOf = (items: PoItemRow[]): { orderedQty: number; receivedQty: number; pct: number } => {
  let orderedQty = 0;
  let receivedQty = 0;
  for (const l of items) {
    orderedQty += Number(l.qty ?? 0);
    receivedQty += Number(l.received_qty ?? 0);
  }
  const pct = orderedQty > 0 ? Math.round((receivedQty / orderedQty) * 100) : 0;
  return { orderedQty, receivedQty, pct };
};


function Field({
  label,
  value,
  span = 1,
  muted,
  mono,
}: {
  label: string;
  value: ReactNode;
  span?: 1 | 2 | 3 | 4;
  muted?: boolean;
  mono?: boolean;
}) {
  const spanCls = span === 1 ? "" : span === 2 ? "sm:col-span-2" : span === 3 ? "sm:col-span-3" : "sm:col-span-4";
  return (
    <div className={spanCls}>
      <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </div>
      <div className={cn("mt-1 text-[14px] font-semibold leading-snug", muted ? "text-ink-muted" : "text-ink", mono && "font-mono")}>
        {value}
      </div>
    </div>
  );
}


function AsideCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        {title}
      </div>
      {children}
    </div>
  );
}

function KeyDateRow({ k, v, muted }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-border-subtle py-2 last:border-b-0">
      <span className="text-[12.5px] text-ink-muted">{k}</span>
      <span className={cn("text-[13px] font-semibold", muted ? "text-ink-muted" : "text-ink")}>
        {v}
      </span>
    </div>
  );
}

function PersonRow({
  initials,
  name,
  role,
  tone = "accent",
}: {
  initials: string;
  name: string;
  role: string;
  tone?: "accent" | "neutral";
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border-subtle py-3 last:border-b-0">
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[12px] font-bold",
          tone === "accent" ? "bg-accent-soft text-accent-ink" : "bg-border-subtle text-ink-secondary"
        )}
      >
        {initials}
      </span>
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold text-ink">{name}</div>
        <div className="truncate text-[11.5px] text-ink-muted">{role}</div>
      </div>
    </div>
  );
}

type ActivityDot = "success" | "primary" | "muted";
const DOT_CLS: Record<ActivityDot, string> = {
  success: "bg-synced",
  primary: "bg-primary",
  muted: "bg-border-strong",
};
function ActivityRow({
  title,
  meta,
  dot,
  isLast,
}: {
  title: string;
  meta: string;
  dot: ActivityDot;
  isLast?: boolean;
}) {
  return (
    <div className="flex gap-3 pb-3.5">
      <div className="flex flex-col items-center">
        <span className={cn("mt-1 h-2 w-2 rounded-full", DOT_CLS[dot])} />
        {!isLast && <span className="mt-1 w-[2px] flex-1 bg-border-subtle" />}
      </div>
      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold text-ink">{title}</div>
        <div className="mt-0.5 text-[11px] text-ink-muted">{meta}</div>
      </div>
    </div>
  );
}


function PoTotalHeroCard({
  header,
  items,
}: {
  header: PoHeaderRow;
  items: PoItemRow[];
}) {
  const eff = effectiveOf(header);
  const t = EFFECTIVE_TONE[eff];
  const total = totalOf(header);
  const { orderedQty, receivedQty, pct } = receivedOf(items);
  return (
    <div className="rounded-lg bg-sidebar px-5 py-5 text-sidebar-ink shadow-stone">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-sidebar-ink-muted">
        PO total
      </div>
      <div className="mt-1.5 font-money text-[28px] font-bold leading-none tracking-tight text-white">
        {fmtMoney(total, header.currency)}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            t.tone === "success" ? "bg-synced"
              : t.tone === "warning" ? "bg-accent-bright"
                : t.tone === "error" ? "bg-err"
                  : "bg-sidebar-ink-muted"
          )}
        />
        <span className="text-[12.5px] text-sidebar-ink-muted">{t.blurb}</span>
      </div>

      <div className="mt-4 space-y-2 border-t border-white/10 pt-4">
        <HeroLine k="Subtotal" v={fmtMoney(header.subtotal_sen, header.currency)} />
        <HeroLine k="Tax" v={fmtMoney(header.tax_sen ?? 0, header.currency)} />
        <HeroLine k="Total" v={fmtMoney(total, header.currency)} strong />
      </div>

      <div className="mt-4 border-t border-white/10 pt-4">
        <div className="flex items-center justify-between text-[12px] text-sidebar-ink-muted">
          <span>Receipt progress</span>
          <span className="font-money text-[13px] font-semibold text-sidebar-ink">
            {receivedQty} / {orderedQty}
          </span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              pct >= 100 ? "bg-synced" : "bg-accent-bright"
            )}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function HeroLine({
  k,
  v,
  strong,
}: {
  k: string;
  v: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={cn("text-[12.5px] text-sidebar-ink-muted", strong && "font-semibold text-white")}>
        {k}
      </span>
      <span className={cn("font-money text-[13px] font-semibold text-sidebar-ink", strong && "text-[16px] font-bold text-accent-bright")}>
        {v}
      </span>
    </div>
  );
}

const PurchaseOrderDetailInlineEditor = lazy(() =>
  import("./PurchaseOrderDetail").then((m) => ({ default: m.PurchaseOrderDetail })),
);


export function PurchaseOrderDetailV2() {
  const [params] = useSearchParams();
  const location = useLocation();
  if (params.get("edit") === "1") {
    return (
      <LazySlot
        resetKey={`po-editor:${location.pathname}`}
        fallback={<div className="p-8 text-[13px] text-ink-muted">Loading editor…</div>}
      >
        <PurchaseOrderDetailInlineEditor />
      </LazySlot>
    );
  }
  return <PurchaseOrderDetailV2ReadOnly />;
}

function PurchaseOrderDetailV2ReadOnly() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const detail = usePurchaseOrderDetail(id ?? null);
  const confirmPo = useConfirmPurchaseOrder();
  const { cancelPo, isPending: cancelling } = usePoCancelAction();
  const reopenPo = useReopenPurchaseOrder();
  const notify = useNotify();
  const confirm = useConfirm();
  const { can, pageAccess } = useHouzsAuth();
  /* Line-photo ADD-ONS (owner 2026-08-28): a purchaser may attach photos
     directly on a PO line. Carried SO keys stay read-only here (server refuses
     their deletion); only `po-items/...` keys grow a delete control. UI gate =
     the same cohort that may operate POs; the server's area guard is the
     boundary either way. */
  const mayEditPoPhotos = canOperatePurchaseOrders(can, pageAccess);
  const uploadLinePhoto = async (itemId: string, file: File) => {
    if (!purchaseOrder?.id) return;
    try {
      await uploadPoItemPhoto(purchaseOrder.id, itemId, file);
      await detail.refetch();
    } catch (e) {
      void notify({ title: "Photo not added", body: e instanceof Error ? e.message : "Upload failed.", tone: "error" });
    }
  };
  const deleteLinePhoto = async (itemId: string, photoKey: string) => {
    if (!purchaseOrder?.id) return;
    const ok = await confirm({
      title: "Delete this photo?",
      body: "Only photos added on this PO can be deleted here. This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deletePoItemPhoto(purchaseOrder.id, itemId, photoKey);
      await detail.refetch();
    } catch (e) {
      void notify({ title: "Photo not deleted", body: e instanceof Error ? e.message : "Delete failed.", tone: "error" });
    }
  };
  const [sendingToSupplier, setSendingToSupplier] = useState(false);
  const [showAmendModal, setShowAmendModal] = useState(false);
  const [relMapOpen, setRelMapOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [allocLineId, setAllocLineId] = useState<string | null>(null);

  const warehousesQ = useWarehouses({ includeInactive: true });
  const warehouseNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of warehousesQ.data ?? []) {
      m.set(w.id, w.code);
    }
    return m;
  }, [warehousesQ.data]);

  const purchaseOrder =
    (detail.data as { purchaseOrder?: PoHeaderRow } | undefined)?.purchaseOrder ??
    null;
  const resolvedPoId = purchaseOrder?.id;
  useEffect(() => {
    if (id && resolvedPoId && id !== resolvedPoId) navigate(`/scm/purchase-orders/${resolvedPoId}${window.location.search}`, { replace: true });
  }, [id, resolvedPoId, navigate]);
  const items: PoItemRow[] = useMemo(
    () => ((detail.data as { items?: PoItemRow[] } | undefined)?.items ?? []),
    [detail.data]
  );

  const {
    nodes: chainNodes,
    onNodeClick: onChainNodeClick,
    amendments: chainAmendments,
    onAmendmentClick: onChainAmendmentClick,
    pairing: chainPairing,
    choice: chainChoice,
    closeChoice: closeChainChoice,
    pickChoice: pickChainChoice,
  } = usePoRelationshipMap(purchaseOrder);

  useSetBreadcrumbs([
    { label: "Purchase Orders", to: "/scm/purchase-orders" },
    { label: purchaseOrder?.po_number ?? id ?? "Purchase Order" },
  ]);

  const needsSkuLookup = useMemo(
    () => items.some((l) => !(l.supplier_sku ?? "").trim()),
    [items]
  );
  const supplierForSku = useSupplierDetail(
    needsSkuLookup ? purchaseOrder?.supplier_id ?? null : null
  );
  const skuByMaterialCode = useMemo(
    () => skuMapFromBindings(supplierForSku.data?.bindings),
    [supplierForSku.data]
  );

  const eff = purchaseOrder ? effectiveOf(purchaseOrder) : null;
  const stageLabel = purchaseOrder
    ? STAGE_LABEL[(purchaseOrder.status || "").toUpperCase()] ??
      purchaseOrder.status
    : "";
  const badgeTone = eff ? EFFECTIVE_TONE[eff].tone : "neutral";

  // Back always returns to the Purchase Orders list (owner 2026-07-24: every
  // details page's back button goes to its relevant list, not wherever
  // browser history happens to point). The list restores its own sticky
  // filters, so the prior filtered view comes back — no context lost.
  const goBack = () => navigate(scmListReturnTo("/scm/purchase-orders"));
  const goEdit = () => id && navigate(`/scm/purchase-orders/${id}?edit=1`);
  /* "Add line" from the page you START on — the affordance lived only
     inside the editor, under a different name per document, so it read as
     missing (docs/bugs/0853). */
  const goAddLine = () => id && navigate(addLineHref(`/scm/purchase-orders/${id}`));
  const deliverPrintPdf = (action: PdfAction) => {
    if (!purchaseOrder) return;
    const wh = (warehousesQ.data ?? []).find(
      (w) => w.id === purchaseOrder.purchase_location_id
    );
    const headerForPdf = {
      ...purchaseOrder,
      // Owner 2026-07-24: DELIVER TO shows the warehouse CODE only (was the
      // dual "code · name", which read as a duplicated warehouse name).
      purchase_location_name: wh ? wh.code : null,
      delivery_address: wh?.location ?? null,
      your_ref_no:
        (purchaseOrder as unknown as { your_ref_no?: string | null })
          .your_ref_no ?? null,
      source_so_doc_no:
        (purchaseOrder as unknown as { source_so_doc_no?: string | null })
          .source_so_doc_no ?? null,
    };
    return import("../../vendor/scm/lib/purchase-order-pdf")
      .then(({ generatePurchaseOrderPdf }) =>
        generatePurchaseOrderPdf(headerForPdf as never, items as never, { action }))
      .catch((e) =>
        notify({
          title: "PDF generation failed",
          body: e instanceof Error ? e.message : "Something went wrong.",
          tone: "error",
        })
      );
  };
  const print = usePrintPreview(deliverPrintPdf);
  useOpenPrintPreviewFromUrl(print.openPreview, !!purchaseOrder);
  const goGrnFromPo = () =>
    id && navigate(convertToLink('poToGrn', id));

  /* Raise Return — the PO-sourced purchase return. The button existed only on
     the legacy detail page, which no route renders any more, so a received PO
     had NO way into a return at all (owner 2026-09-28, HC-PO-010114). The link
     goes through convertToLink so the scope params stay the ones
     lib/convertScope owns. */
  const goReturnFromPo = () =>
    id && navigate(convertToLink('poToPr', id));

  const doSendToSupplier = async () => {
    if (!id || !purchaseOrder) return;
    if (sendingToSupplier) return;
    const recipients = resolvePoRecipients(purchaseOrder.supplier);
    if (!recipients.ok && recipients.error === "no_supplier_email") {
      notify({
        title: "No supplier email",
        body: "This supplier has no email address on file. Add one on the supplier record, then send.",
        tone: "error",
      });
      return;
    }
    if (!recipients.ok) {
      void notify({
        title: "Supplier email not valid",
        body: `The supplier's email address (${recipients.address}) is not a valid address. Fix it on the supplier record, then send again.`,
        tone: "error",
      });
      return;
    }
    const recipientLine = recipients.cc.length
      ? `${recipients.to}, with a copy (Cc) to ${recipients.cc.join(", ")}`
      : recipients.to;
    const ok = await confirm({
      title: `Email PO ${purchaseOrder.po_number} to the supplier?`,
      body: `It will be sent to ${recipientLine} with the PO attached as a PDF. Check the addresses are the right ones for this supplier.`,
      confirmLabel: "Send to supplier",
    });
    if (!ok) return;
    setSendingToSupplier(true);
    try {
      const wh = (warehousesQ.data ?? []).find((w) => w.id === purchaseOrder.purchase_location_id);
      const headerForPdf = {
        ...purchaseOrder,
        // Owner 2026-07-24: DELIVER TO shows the warehouse CODE only (was the
      // dual "code · name", which read as a duplicated warehouse name).
      purchase_location_name: wh ? wh.code : null,
        delivery_address: wh?.location ?? null,
        your_ref_no: (purchaseOrder as unknown as { your_ref_no?: string | null }).your_ref_no ?? null,
        source_so_doc_no: (purchaseOrder as unknown as { source_so_doc_no?: string | null }).source_so_doc_no ?? null,
      };
      const { purchaseOrderPdfForEmail } = await import("../../vendor/scm/lib/purchase-order-pdf");
      const { pdfBase64, photos } = await purchaseOrderPdfForEmail(headerForPdf as never, items as never);
      const res = await authedFetch<{ sent: boolean; to: string; result: { reason?: string } }>(
        `/mfg-purchase-orders/${id}/send-to-supplier`,
        { method: "POST", body: JSON.stringify({ pdfBase64 }) },
      );
      if (res.sent) {
        notify({ title: "Sent to supplier", body: `PO emailed to ${res.to}.${poEmailPhotosNote(photos)}` });
      } else {
        notify({ title: "Not sent", body: res.result?.reason ?? "The email channel may be off — check email settings.", tone: "error" });
      }
    } catch (e) {
      notify({ title: "Send failed", body: e instanceof Error ? e.message : "Something went wrong.", tone: "error" });
    } finally {
      setSendingToSupplier(false);
    }
  };

  const doConfirm = async () => {
    if (!id) return;
    if (await confirm({
      title: "Confirm this PO?",
      body: "It becomes live supply and its sales-order lines leave the From-SO picker.",
      confirmLabel: "Confirm PO",
    })) {
      confirmPo.mutate(id);
    }
  };
  /* Owner 2026-09-09 — no approval, but the reason is compulsory: the prompt
     and the words are in ./use-po-cancel-action.ts, shared with the editor, the
     list menu and mobile, and the server refuses a cancel that carries none. */
  const doCancel = async () => {
    if (!purchaseOrder) return;
    void cancelPo(purchaseOrder.id, purchaseOrder.po_number);
  };
  const doReopen = async () => {
    if (!purchaseOrder) return;
    if (await confirm({
      title: `Reopen cancelled PO ${purchaseOrder.po_number}?`,
      confirmLabel: "Reopen",
    })) {
      reopenPo.mutate(purchaseOrder.id);
    }
  };

  /* SO→PO drift + pending amendment (owner 2026-07-27, "为什么没有 SO Request
     的相关信息?"). The View surface showed neither the pending SO revision nor
     what it now requests — both only lived in the ?edit=1 editor. so_drift is
     per-line (set by the detail endpoint when a line's source SO changed after
     this PO was raised); open_amendment is the best-effort pending-amendment
     stamp. Drift is only actionable pre-receipt (a received/cancelled PO can't
     be re-sent), mirroring the editor's gate. */
  const showDrift =
    purchaseOrder?.status === "SUBMITTED" || purchaseOrder?.status === "PARTIALLY_RECEIVED";
  const driftCount = showDrift ? items.filter((l) => l.so_drift).length : 0;
  const openAmendment =
    (purchaseOrder as unknown as {
      open_amendment?: { id: string; status: string; amendment_no: string } | null;
    })?.open_amendment ?? null;

  const lineColumns: Column<PoItemRow>[] = [
    {
      key: "item",
      label: "Item",
      alwaysVisible: true,
      getValue: (l) => l.item_code,
      /* Item CODE first, then the variant subtitle; description dropped (owner 2026-07-24) — the shared order-line rule
         (vendor/shared/line-identity.ts). JUDGEMENT CALL, stated rather than
         silently taken: this is PURCHASE vocabulary (item_code), and every
         owner precedent for the rule is sales-side, so it is not covered by the
         letter of any report. It is swept because the SHAPE is identical, not
         the vocabulary — this render was byte-for-byte the pre-#647
         SalesOrderDetailV2 line-item cell (bold description, then the code and
         `· description2` sharing one muted line), i.e. the exact thing the owner
         reported. The operator already reads the description on the bold line;
         the code beneath it is the same identity twice. The V1 purchase detail
         tables are deliberately NOT swept — there the code is the BOLD PRIMARY
         line and dropping it would leave the row identified only by a variant
         summary. The code still BINDS: getValue above keeps it the sort /
         search / export value. */
      render: (l) => {
        const { primary, secondary } = orderLineIdentity({
          code: l.item_code,
          description: l.description || l.material_name,
          variant: buildVariantSummary(l.item_group ?? "others", l.variants) || (l.description2 ?? ""),
        });
        const remark = (l.notes ?? "").trim();
        return (
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-ink">
              {primary}
            </div>
            {secondary && (
              <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-ink-muted">
                <span className="truncate text-ink-secondary">{secondary}</span>
              </div>
            )}
            {/* The line's REMARK (purchase_order_items.notes) — the SO line's
                twin, rendered the same way (SalesOrderDetailV2's Item cell).
                Owner 2026-09-04: 「SO line 和 PO line 的 remarks」. This is not
                a duplicate of the identity above: it is free text that appears
                nowhere else on the row, and on the 923 of 1,117 migrated
                company-1 PO lines that carry it (measured 2026-09-04), it is
                AutoCount's own Description 2 — the customer's spec text in the
                salesperson's own words. Nothing on
                this page rendered it before, so the migration's copy was
                invisible. It WRAPS rather than truncating: half an instruction
                is worse than none. */}
            {remark && (
              <div className="mt-1 whitespace-pre-wrap break-words text-[11.5px] italic leading-snug text-ink-secondary">
                {remark}
              </div>
            )}
            {showDrift && l.so_drift && (
              <div className="mt-1 grid gap-0.5 rounded border border-err/30 bg-err/5 px-2 py-1 text-[11px] font-semibold text-err">
                {l.so_drift.itemChanged && (
                  <span>⚠ SO now orders {l.so_drift.itemSo} (this PO still has {l.so_drift.itemPo}) — cancel &amp; re-raise is safer.</span>
                )}
                {!l.so_drift.itemChanged && l.so_drift.specSo !== l.so_drift.specPo && (
                  <span>⚠ SO spec now: {l.so_drift.specSo || "—"} (this PO still: {l.so_drift.specPo || "—"})</span>
                )}
                {l.so_drift.warehouseChanged && (
                  <span>⚠ SO warehouse moved — this PO still points at the old one.</span>
                )}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: "remark",
      label: "Remark",
      width: "220px",
      defaultHidden: true,
      getValue: (l) => (l.notes ?? "").trim(),
      render: (l) => {
        const remark = (l.notes ?? "").trim();
        return remark ? (
          <span className="whitespace-pre-wrap break-words text-[12px] text-ink-secondary">{remark}</span>
        ) : (
          <span className="text-ink-muted">—</span>
        );
      },
    },
    {
      key: "supplierSku",
      label: "Supplier SKU",
      width: "132px",
      getValue: (l) => {
        const code = supplierCodeFor(l, skuByMaterialCode);
        return code === "—" ? "" : code;
      },
      render: (l) => {
        const code = supplierCodeFor(l, skuByMaterialCode);
        if (code === "—") return <span className="text-ink-muted">—</span>;
        return (
          <span className="font-mono text-[12px] text-ink-secondary">{code}</span>
        );
      },
    },
    /* Photos — the reference shots the SO line brought along (mig 0274 carry,
       plus the AutoCount importer's keys), through the SAME strip + state
       machine the SO detail renders (components/scm-v2/SoLinePhotoStrip with
       source="po"). Since owner 2026-08-28 the PO also AUTHORS its own
       add-ons (`po-items/...` keys): operate-cohort users get an add tile and
       a delete control on PO-owned keys only — carried SO keys stay read-only
       here and are managed on the Sales Order.
       getValue is the COUNT so the column sorts/filters/exports as a number. */
    {
      key: "photos",
      label: "Photos",
      width: "110px",
      getValue: (l) => (l.photo_urls ?? []).length,
      render: (l) => (
        <SoLinePhotoStrip
          source="po"
          docId={purchaseOrder?.id ?? ""}
          itemId={l.id}
          photoKeys={l.photo_urls ?? []}
          edit={
            mayEditPoPhotos && purchaseOrder?.status !== "CANCELLED"
              ? {
                  onUpload: (file) => uploadLinePhoto(l.id, file),
                  onDelete: (key) => deleteLinePhoto(l.id, key),
                  canDeleteKey: isPoOwnedPhotoKey,
                }
              : null
          }
        />
      ),
    },
    {
      key: "qty",
      label: "Ordered",
      width: "84px",
      align: "right",
      getValue: (l) => l.qty,
      render: (l) => (
        <span className="font-money text-[13px] text-ink-secondary">
          {fmtQty(l.qty)} <span className="text-[10.5px] text-ink-muted">{l.uom || ""}</span>
        </span>
      ),
    },
    {
      key: "received",
      label: "Received",
      width: "92px",
      align: "right",
      getValue: (l) => l.received_qty ?? 0,
      render: (l) => {
        const received = Number(l.received_qty ?? 0);
        const ordered = Number(l.qty ?? 0);
        const full = received >= ordered && ordered > 0;
        return (
          <span className={cn("font-money text-[13px] font-semibold", full ? "text-synced" : "text-ink")}>
            {received}
          </span>
        );
      },
    },
    {
      key: "balance",
      label: "Balance",
      width: "84px",
      align: "right",
      getValue: (l) => (l.qty ?? 0) - (l.received_qty ?? 0),
      render: (l) => {
        const bal = (l.qty ?? 0) - (l.received_qty ?? 0);
        if (bal === 0) return <span className="text-ink-muted">—</span>;
        return (
          <span className="font-money text-[13px] font-semibold text-accent-bright">
            {bal}
          </span>
        );
      },
    },
    {
      key: "eta",
      label: "ETA",
      width: "96px",
      align: "right",
      getValue: (l) => l.delivery_date ?? "",
      render: (l) => (
        <span className="font-mono text-[12px] text-ink-secondary">
          {l.delivery_date ? fmtDate(l.delivery_date) : "—"}
        </span>
      ),
    },
    {
      /* Labelled "Transfer to" until 2026-08-17, which was the one place the
         document-lineage words named a WAREHOUSE. Once every conversion button
         says "Transfer to <Document>", that label meant two different things on
         one screen — and `?edit=1` on this same route heads a table "Transfer To
         (GRN)" meaning the downstream document. Now matches what
         StockTransferNew/Detail already call it: "To Warehouse".
         The `key` stays `transferTo`: it is persisted in the operator's saved
         column layout, so renaming it would silently reset their columns. It is
         listed for the identifier stage in docs/modules/document-conversion.md §9. */
      key: "transferTo",
      label: "To Warehouse",
      width: "132px",
      getValue: (l) => (l.warehouse_id ? warehouseNameById.get(l.warehouse_id) ?? "" : ""),
      render: (l) => {
        const label = l.warehouse_id ? warehouseNameById.get(l.warehouse_id) : null;
        if (!label) return <span className="text-ink-muted">—</span>;
        return (
          <span className="inline-flex items-center gap-0.5 rounded bg-primary-soft px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-primary-ink">
            {label}
          </span>
        );
      },
    },
    {
      key: "allocations",
      label: "Allocations",
      width: "230px",
      getValue: (l) =>
        (l.allocations ?? [])
          .map((a) => `${a.seq} ${a.so_doc_no ?? "STOCK"} ${a.qty}`)
          .join(" "),
      render: (l) => {
        const allocs = l.allocations ?? [];
        const poNo = purchaseOrder?.po_number ?? "";
        const sub = (seq: number) => `${poNo}-${String(seq).padStart(2, "0")}`;
        return (
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {allocs.map((a) => (
              <span
                key={a.id}
                title={
                  a.so_doc_no
                    ? `${sub(a.seq)} — ${a.qty} of this line bought for ${a.so_doc_no}. Procurement provenance, not the live assignment.`
                    : `${sub(a.seq)} — ${a.qty} of this line bought for stock (no customer)`
                }
                className={cn(
                  "rounded border px-1.5 py-0.5 font-mono text-[10.5px] font-semibold",
                  a.so_doc_no
                    ? "border-border-subtle bg-surface-dim text-ink-secondary"
                    : "border-dashed border-border text-ink-secondary"
                )}
              >
                {sub(a.seq)}
                {" -> "}
                {a.so_doc_no ?? "STOCK"}
                <span className="text-ink-muted">{` (qty ${a.qty})`}</span>
              </span>
            ))}
            {/* No explicit slices -> show the EFFECTIVE assignment instead of a
                dash. The coarse Source-SO link (or STOCK) is what actually
                governs this line, and rendering "—" while the list shows an
                Assigned SO read as a contradiction. Owner, 2026-08-06: "明明显示
                有 SO,可是 allocation 却显示没有". A stored Source-SO link wears the
                MUTED PROVENANCE dress even when implicit — under the three-identity
                language a dash means FLOATING, and this is a stored fact (owner,
                2026-08-07: the list and the editor read as two different answers).
                Only the no-link STOCK case stays dashed. */}
            {allocs.length === 0 && (
              <span
                title={
                  l.so_doc_no
                    ? `Whole line (qty ${l.qty}) bought for ${l.so_doc_no} — procurement provenance, not the live assignment; add a slice to split it.`
                    : `Whole line (qty ${l.qty}) bought for stock — no Source SO link; add a slice to attribute it.`
                }
                className={cn(
                  "rounded border px-1.5 py-0.5 font-mono text-[10.5px]",
                  l.so_doc_no
                    ? "border-border-subtle bg-surface-dim font-semibold text-ink-secondary"
                    : "border-dashed border-border text-ink-secondary"
                )}
              >
                {l.so_doc_no ?? "STOCK"}
                <span className="text-ink-muted">{` (qty ${l.qty})`}</span>
              </span>
            )}
            {(purchaseOrder?.status || "").toUpperCase() !== "CANCELLED" && (
              <button
                type="button"
                onClick={() => setAllocLineId(l.id)}
                title="Split this line across the Sales Orders it was bought for"
                aria-label={`Edit allocations for ${l.item_code}`}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary hover:border-primary/50 hover:text-primary"
              >
                <Split size={12} />
              </button>
            )}
          </div>
        );
      },
    },
    {
      key: "unit",
      label: "Unit price",
      width: "108px",
      align: "right",
      getValue: (l) => l.unit_price_sen,
      render: (l) => (
        <span className="font-money text-[13px] text-ink-secondary">
          {fmtMoney(l.unit_price_sen, purchaseOrder?.currency)}
        </span>
      ),
    },
    {
      key: "total",
      label: "Amount",
      width: "132px",
      align: "right",
      getValue: (l) => l.line_total_sen,
      render: (l) => (
        <FocAmount line={l} amount={fmtMoney(l.line_total_sen ?? 0, purchaseOrder?.currency)} />
      ),
    },
  ];

  if (!id) {
    return <div className="p-8 text-center text-ink-muted">No purchase order specified.</div>;
  }
  if (detail.isPending) {
    return (
      <div className="animate-fade-in p-8 text-center text-ink-muted">
        Loading purchase order…
      </div>
    );
  }
  if (detail.error || !purchaseOrder) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div className="mb-2 font-display text-[18px] font-extrabold text-err">
          Couldn't load purchase order
        </div>
        <p className="text-[13px] text-ink-muted">
          {(detail.error as Error | undefined)?.message ?? "The PO was not found."}
        </p>
        <div className="mt-4">
          <Button variant="secondary" onClick={goBack} icon={<ArrowLeft size={14} />}>
            Back to Purchase Orders
          </Button>
        </div>
      </div>
    );
  }

  const goCall = () => {
    if (!purchaseOrder?.supplier?.phone) return;
    window.location.href = `tel:${purchaseOrder.supplier.phone.replace(/\s+/g, "")}`;
  };

  const rawStatus = (purchaseOrder.status || "").toUpperCase();
  const confirmReason = poConfirmBlockReason(purchaseOrder.status);
  const canConfirm = confirmReason === null;
  const grnReason = grnTransferBlockReason(purchaseOrder.status);
  const canConvertToGrn = grnReason === null;
  const canCancel = rawStatus !== "CANCELLED" && rawStatus !== "RECEIVED" && rawStatus !== "PARTIALLY_RECEIVED";
  const canReopen = rawStatus === "CANCELLED";
  const isCancelled = rawStatus === "CANCELLED";

  return (
    <div className="pb-56 md:pb-0">
      <div className="sticky top-0 z-20 -mx-4 -mt-4 bg-sidebar text-sidebar-ink shadow-slab md:hidden">
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center gap-1 text-[14px] font-semibold text-accent-bright"
            aria-label="Back to Purchase Orders"
          >
            <ArrowLeft size={16} /> POs
          </button>
          <span className="font-mono text-[12.5px] font-semibold text-sidebar-ink">
            {purchaseOrder.po_number}
          </span>
          <button
            type="button"
            className="text-sidebar-ink-muted"
            aria-label="More actions"
          >
            <MoreHorizontal size={18} />
          </button>
        </div>
        <div className="px-4 pb-4 pt-3">
          <h1 className="font-display text-[19px] font-bold leading-tight text-white">
            {supplierNameOf(purchaseOrder)}
          </h1>
          <div className="mt-2">
            <span className="inline-flex items-center gap-1.5">
              <Badge tone={badgeTone} variant="solid" size="xs">
                {stageLabel}
              </Badge>
              <HoldChip onHold={purchaseOrder.on_hold} reason={purchaseOrder.hold_reason} />
            </span>
          </div>
        </div>
      </div>

      <div className="sticky top-0 z-10 -mx-4 hidden border-b border-border bg-bg/95 px-4 py-4 backdrop-blur-sm sm:-mx-6 sm:px-6 md:block">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <button
              type="button"
              onClick={goBack}
              aria-label="Back to Purchase Orders"
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary hover:border-primary/50 hover:text-primary"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
                  {supplierNameOf(purchaseOrder)}
                </h1>
                <span className="inline-flex items-center gap-1.5">
                  <Badge tone={badgeTone} size="sm">
                    {stageLabel}
                  </Badge>
                  <HoldChip onHold={purchaseOrder.on_hold} reason={purchaseOrder.hold_reason} />
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-secondary">
                {/* _R suffix (owner 2026-07-27): a revised PO's number shows its
                    revision marker everywhere it is read or printed. */}
                <span className="font-mono font-semibold text-primary-ink">
                  {poDisplayNumber(purchaseOrder.po_number, (purchaseOrder as unknown as { revision?: number | null }).revision)}
                </span>
                <Divider />
                <span>Ordered {fmtDate(purchaseOrder.po_date)}</span>
                {purchaseOrder.expected_at && (
                  <>
                    <Divider />
                    <span>Expected {fmtDate(purchaseOrder.expected_at)}</span>
                  </>
                )}
                <Divider />
                <span>{items.length} line{items.length === 1 ? "" : "s"}</span>
                <Divider />
                <span className="font-mono font-semibold text-ink-secondary">
                  {supplierCodeOf(purchaseOrder)}
                </span>
              </div>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" icon={<History size={14} />} onClick={() => setHistoryOpen(true)}>
              History
            </Button>
            <Button variant="ghost" icon={<Share2 size={14} />} onClick={() => setRelMapOpen(true)}>
              Relationship Map
            </Button>
            <Button variant="ghost" icon={<Copy size={14} />}
              onClick={() => navigate(`/scm/purchase-orders/new?copyFrom=${purchaseOrder.id}`)}>
              Copy as new
            </Button>
            <Button variant="secondary" icon={<Printer size={14} />} onClick={print.openPreview}>
              Print PDF
            </Button>
            {purchaseOrder.status !== "DRAFT" && purchaseOrder.status !== "CANCELLED" && (
              <Button
                variant="secondary"
                icon={<Mail size={14} />}
                onClick={doSendToSupplier}
                disabled={sendingToSupplier}
              >
                {sendingToSupplier ? "Sending..." : "Send to supplier"}
              </Button>
            )}
            {canCancel && (
              <Button variant="danger" icon={<XCircle size={14} />} onClick={doCancel} disabled={cancelling}>
                Cancel PO
              </Button>
            )}
            {canReopen && (
              <Button variant="secondary" icon={<RotateCcw size={14} />} onClick={doReopen}>
                Reopen
              </Button>
            )}
            <Button
              variant="secondary"
              icon={<CheckCircle2 size={14} />}
              onClick={doConfirm}
              disabled={!canConfirm}
              title={confirmReason ?? undefined}
              aria-describedby={confirmReason ? "po-confirm-reason" : undefined}
            >
              Confirm PO
            </Button>
            <Button
              variant="secondary"
              icon={<Package size={14} />}
              onClick={goGrnFromPo}
              disabled={!canConvertToGrn}
              title={grnReason ?? undefined}
              aria-describedby={grnReason ? "po-grn-reason" : undefined}
            >
              {transferToLabel('grn')}
            </Button>
            {purchaseOrder.status !== "DRAFT" && purchaseOrder.status !== "CANCELLED" && can("scm.po_amendment.create") && (
              <Button variant="secondary" icon={<FilePenLine size={14} />} onClick={() => setShowAmendModal(true)}>
                Raise amendment
              </Button>
            )}
            {(purchaseOrder.status === 'PARTIALLY_RECEIVED' || purchaseOrder.status === 'RECEIVED')
              && pageAccess('scm.procurement.pr') !== 'none' && (
              <Button variant="secondary" icon={<Undo2 size={14} />} onClick={goReturnFromPo}>
                Raise Return
              </Button>
            )}
            <Button variant="secondary" icon={<Plus size={14} />} onClick={goAddLine}>{ADD_LINE_LABEL}</Button>
            <Button variant="primary" icon={<Edit3 size={14} />} onClick={goEdit}>
              Edit
            </Button>
          </div>
          <div className="flex max-w-[440px] flex-col items-end gap-0.5 text-right">
            <NextStepNote id="po-confirm-reason" reason={confirmReason} />
            <NextStepNote id="po-grn-reason" reason={grnReason} />
          </div>
          </div>
        </div>
      </div>

      {showAmendModal && (
        <PoAmendmentCreateModal
          poId={purchaseOrder.id}
          poNumber={purchaseOrder.po_number}
          onClose={() => setShowAmendModal(false)}
          onCreated={(amendmentId) => navigate(`/scm/po-amendments/${amendmentId}`)}
        />
      )}

      {allocLineId && (
        <PoLineAllocationsModal
          poId={purchaseOrder.id}
          poNumber={purchaseOrder.po_number}
          lineId={allocLineId}
          onClose={() => setAllocLineId(null)}
        />
      )}

      <div className="py-5">
        <div className="mb-3 rounded-lg border border-border bg-surface p-4 shadow-stone md:hidden">
          <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
            PO total
          </div>
          <div className="mt-1 font-money text-[26px] font-bold leading-none tracking-tight text-ink">
            {fmtMoney(totalOf(purchaseOrder), purchaseOrder.currency)}
          </div>
          <div className="mt-1.5 text-[12px] text-ink-muted">
            {items.length} line{items.length === 1 ? "" : "s"} · {EFFECTIVE_TONE[effectiveOf(purchaseOrder)].blurb}
          </div>
        </div>

        <DetailGrid>
          <DetailMain>
            <Section title="Supplier">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-3">
                <Field label="Supplier" value={supplierNameOf(purchaseOrder)} />
                <Field label="Supplier code" value={supplierCodeOf(purchaseOrder)} mono />
                <Field
                  label="Contact"
                  value={purchaseOrder.supplier?.contact_person || "—"}
                  muted={!purchaseOrder.supplier?.contact_person}
                />
                <Field
                  label="Phone"
                  value={formatPhone(purchaseOrder.supplier?.phone) || "Not provided"}
                  muted={!purchaseOrder.supplier?.phone}
                  mono={!!purchaseOrder.supplier?.phone}
                />
                <Field
                  label="Email"
                  value={supplierEmailList(purchaseOrder.supplier).join(", ") || "Not provided"}
                  muted={supplierEmailList(purchaseOrder.supplier).length === 0}
                />
                <Field
                  label="Address"
                  value={purchaseOrder.supplier?.address || "—"}
                  muted={!purchaseOrder.supplier?.address}
                />
              </div>
            </Section>

            <Section title="PO info">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-4">
                <Field label="PO date" value={fmtDate(purchaseOrder.po_date)} />
                <Field
                  label="Expected"
                  value={
                    purchaseOrder.expected_at
                      ? fmtDate(purchaseOrder.expected_at)
                      : "Not set"
                  }
                  muted={!purchaseOrder.expected_at}
                />
                <Field label="Currency" value={purchaseOrder.currency} />
                <Field
                  label="Ship-to warehouse"
                  value={
                    purchaseOrder.purchase_location_id
                      ? (warehouseNameById.get(purchaseOrder.purchase_location_id)
                          ?? (warehousesQ.isLoading ? "Loading…" : "—"))
                      : "—"
                  }
                  muted={!purchaseOrder.purchase_location_id}
                />
                {/* Owner 2026-08-06 — supplier-revised delivery dates (mig 0180
                    lineage). Only render the slots the supplier actually pushed
                    ("如果有更新 supplier delivery date 2"); the raw dates show so
                    the desk sees each revision, not just the latest. */}
                {purchaseOrder.supplier_delivery_date_2 && (
                  <Field label="Supplier date 2" value={fmtDate(purchaseOrder.supplier_delivery_date_2)} />
                )}
                {purchaseOrder.supplier_delivery_date_3 && (
                  <Field label="Supplier date 3" value={fmtDate(purchaseOrder.supplier_delivery_date_3)} />
                )}
                {purchaseOrder.supplier_delivery_date_4 && (
                  <Field label="Supplier date 4" value={fmtDate(purchaseOrder.supplier_delivery_date_4)} />
                )}
              </div>

              {purchaseOrder.notes && (
                <div className="mt-4 rounded-lg border border-warning-text/25 bg-warning-bg px-4 py-3">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-warning-text">
                    Note
                  </div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-warning-text">
                    {purchaseOrder.notes}
                  </p>
                </div>
              )}
            </Section>

            <Section title={`Line items · ${items.length}`}>
              {/* Revision-pending / SO-drift banner (owner 2026-07-27). A pending
                  SO amendment means this PO must be re-approved before the
                  supplier builds the new spec; surface it here (the editor
                  already did) with a jump to the amendment. Shows when the PO
                  carries a pending amendment OR any line has drifted from its SO. */}
              {(openAmendment || driftCount > 0) && (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-accent-bright/40 bg-accent-bright/10 px-3.5 py-2.5 text-[12.5px] text-ink">
                  <span className="min-w-0">
                    ⚠{" "}
                    {driftCount > 0 ? (
                      <>
                        <strong>{driftCount}</strong> line{driftCount === 1 ? "'s" : "s"} source SO changed after this
                        PO was raised — check the red notes below, sync the specs, then <strong>re-send to the supplier</strong>.
                      </>
                    ) : (
                      <>
                        The source Sales Order has a pending revision — <strong>approve this PO</strong> to apply the
                        supplier-confirmed changes before the factory builds.
                      </>
                    )}
                  </span>
                  {openAmendment && (
                    <button
                      type="button"
                      onClick={() => navigate(`/scm/amendments/${openAmendment.id}`)}
                      className="shrink-0 rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] font-semibold text-ink hover:border-primary/50 hover:text-primary"
                    >
                      View amendment {openAmendment.amendment_no}
                    </button>
                  )}
                </div>
              )}
              <DataTable<PoItemRow>
                tableId={`po-lines-${id}`}
                layoutFamily={DATA_TABLE_LAYOUT_FAMILIES.purchaseOrderLines} persistSort={false} persistFilters={false}
                rows={items}
                loading={false}
                columns={lineColumns}
                getRowKey={(l) => l.id}
                emptyLabel="No line items"
              />
            </Section>
          </DetailMain>

          <DetailAside>
            <div className="hidden lg:sticky lg:top-[124px] space-y-3 md:block">
              <PoTotalHeroCard header={purchaseOrder} items={items} />

              <AsideCard title="Key dates">
                <KeyDateRow k="PO date" v={fmtDate(purchaseOrder.po_date)} />
                <KeyDateRow
                  k="Expected"
                  v={fmtDate(purchaseOrder.expected_at)}
                  muted={!purchaseOrder.expected_at}
                />
                {/* Owner 2026-08-06 — supplier-revised dates, mirrored from the
                    PO info card so the aside tells the same story. */}
                {purchaseOrder.supplier_delivery_date_2 && (
                  <KeyDateRow k="Supplier date 2" v={fmtDate(purchaseOrder.supplier_delivery_date_2)} />
                )}
                {purchaseOrder.supplier_delivery_date_3 && (
                  <KeyDateRow k="Supplier date 3" v={fmtDate(purchaseOrder.supplier_delivery_date_3)} />
                )}
                {purchaseOrder.supplier_delivery_date_4 && (
                  <KeyDateRow k="Supplier date 4" v={fmtDate(purchaseOrder.supplier_delivery_date_4)} />
                )}
                {purchaseOrder.submitted_at && (
                  <KeyDateRow
                    k="Submitted"
                    v={fmtDate(purchaseOrder.submitted_at)}
                  />
                )}
                {purchaseOrder.received_at && (
                  <KeyDateRow
                    k="Received"
                    v={fmtDate(purchaseOrder.received_at)}
                  />
                )}
                {purchaseOrder.cancelled_at && (
                  <KeyDateRow
                    k="Cancelled"
                    v={fmtDate(purchaseOrder.cancelled_at)}
                  />
                )}
              </AsideCard>

              <AsideCard title="People">
                <PersonRow
                  initials={initialsOf(supplierNameOf(purchaseOrder))}
                  name={supplierNameOf(purchaseOrder)}
                  role={`Supplier · ${supplierCodeOf(purchaseOrder)}`}
                  tone="accent"
                />
                {purchaseOrder.supplier?.contact_person && (
                  <PersonRow
                    initials={initialsOf(purchaseOrder.supplier.contact_person)}
                    name={purchaseOrder.supplier.contact_person}
                    role={formatPhone(purchaseOrder.supplier.phone) || "Contact"}
                    tone="neutral"
                  />
                )}
              </AsideCard>

              <AsideCard title="Recent activity">
                <ActivityRow
                  title={`PO ${EFFECTIVE_TONE[effectiveOf(purchaseOrder)].label.toLowerCase()}`}
                  meta={fmtDate(purchaseOrder.po_date)}
                  dot={EFFECTIVE_TONE[effectiveOf(purchaseOrder)].tone === "success" ? "success" : "primary"}
                />
                {purchaseOrder.submitted_at && (
                  <ActivityRow
                    title="Submitted to supplier"
                    meta={fmtDate(purchaseOrder.submitted_at)}
                    dot="primary"
                  />
                )}
                <ActivityRow
                  title="Created"
                  meta={fmtDate(purchaseOrder.created_at)}
                  dot="muted"
                  isLast
                />
              </AsideCard>
            </div>
          </DetailAside>
        </DetailGrid>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 px-3 pb-6 pt-2.5 shadow-slab backdrop-blur-sm md:hidden">
        <div className="mb-1.5 flex flex-col gap-0.5">
          <NextStepNote id="po-confirm-reason-phone" reason={confirmReason} />
          <NextStepNote id="po-grn-reason-phone" reason={grnReason} />
        </div>
        <div className="mb-2 flex items-center gap-2">
          <button
            type="button"
            onClick={doConfirm}
            disabled={!canConfirm}
            aria-describedby={confirmReason ? "po-confirm-reason-phone" : undefined}
            className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface text-[13.5px] font-bold text-ink hover:bg-surface-dim disabled:opacity-40"
          >
            <CheckCircle2 size={16} /> Confirm PO
          </button>
          <button
            type="button"
            onClick={goGrnFromPo}
            disabled={!canConvertToGrn}
            aria-describedby={grnReason ? "po-grn-reason-phone" : undefined}
            className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink disabled:bg-primary/40"
          >
            <Package size={16} /> {transferToLabel('grn')}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={goEdit}
            className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface text-[13.5px] font-bold text-ink hover:bg-surface-dim"
          >
            <Edit3 size={16} /> Edit
          </button>
          <button
            type="button"
            onClick={print.openPreview}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-surface-2 text-primary-ink hover:bg-primary-soft"
            aria-label="Print PDF"
          >
            <Printer size={17} />
          </button>
          <button
            type="button"
            onClick={goCall}
            disabled={!purchaseOrder.supplier?.phone}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-surface-2 text-primary-ink hover:bg-primary-soft disabled:opacity-40"
            aria-label={
              purchaseOrder.supplier?.phone
                ? `Call ${purchaseOrder.supplier.phone}`
                : "No phone on file"
            }
          >
            <PhoneIcon size={17} />
          </button>
        </div>
      </div>

      <DocumentRelationshipMapModal
        open={relMapOpen}
        onClose={() => setRelMapOpen(false)}
        nodes={chainNodes}
        onNodeClick={(n) => {
          if (onChainNodeClick(n)) setRelMapOpen(false);
        }}
        amendments={chainAmendments}
        onAmendmentClick={(a) => {
          if (onChainAmendmentClick(a)) setRelMapOpen(false);
        }}
        rowLabels={{ primary: "Purchase chain", secondary: "After goods receipt" }}
        amendmentsLabel="Related amendments (Sales Order & this PO)"
        pairing={chainPairing}
      />
      <DocumentChoiceDialog
        prompt={chainChoice}
        onClose={closeChainChoice}
        onPick={pickChainChoice}
      />
      {historyOpen && (
        <DocumentHistoryDrawer doc="PURCHASE_ORDER" id={String(purchaseOrder.id)}
          label={purchaseOrder.po_number} onClose={() => setHistoryOpen(false)} />
      )}
      <PrintPreviewModal
        open={print.open}
        onClose={print.close}
        docTitle="Purchase Order"
        docNo={poDisplayNumber(
          purchaseOrder.po_number,
          (purchaseOrder as unknown as { revision?: number | null }).revision
        )}
        rows={[
          { label: "Supplier", value: supplierNameOf(purchaseOrder) },
          { label: "PO date", value: fmtDate(purchaseOrder.po_date) },
          {
            label: "Expected",
            value: purchaseOrder.expected_at ? fmtDate(purchaseOrder.expected_at) : "Not set",
          },
          { label: "Items", value: `${items.length} line${items.length === 1 ? "" : "s"}` },
          {
            label: "Order total",
            value: fmtMoney(totalOf(purchaseOrder), purchaseOrder.currency),
          },
        ]}
        {...print.handlers}
      />
    </div>
  );
}

function Divider() {
  return (
    <span className="inline-flex items-center text-border-strong">
      <CircleDot size={4} className="mx-0.5 opacity-40" />
    </span>
  );
}

export default PurchaseOrderDetailV2;
