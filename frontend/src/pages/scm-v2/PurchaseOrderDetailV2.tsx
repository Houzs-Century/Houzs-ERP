// PurchaseOrderDetailV2 — Theme C redesign of the Purchase Order detail
// page. Twin of the sales-side detail V2 template, pivoted for procurement:
// money moves OUT to a supplier, receipt progresses through DRAFT → SUBMITTED
// → PARTIALLY_RECEIVED → RECEIVED. No customer, no delivery address; the
// relationship IS with the supplier.
//
// Route: /scm/purchase-orders/:id (App.tsx flips ScmPurchaseOrderDetailV2 here).
// Data: usePurchaseOrderDetail / useCancelPurchaseOrder /
//       useSubmitPurchaseOrder / useConfirmPurchaseOrder / useReopenPurchaseOrder
//       (vendored suppliers-queries slice).

import { Suspense, lazy, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { scmListReturnTo } from "../../lib/scmListReturn";
import { buildVariantSummary, fmtMoneyCenti, orderLineIdentity } from "@2990s/shared";
import { formatPhone } from "@2990s/shared/phone";
import {
  ArrowLeft,
  History,
  Printer,
  Mail,
  XCircle,
  Edit3,
  CircleDot,
  Phone as PhoneIcon,
  MoreHorizontal,
  CheckCircle2,
  Send,
  RotateCcw,
  Package,
  FilePenLine,
  Share2,
  Split,
} from "lucide-react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
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
  useCancelPurchaseOrder,
  useReopenPurchaseOrder,
  useSubmitPurchaseOrder,
  useConfirmPurchaseOrder,
  useSupplierDetail,
  type PoHeaderRow,
  type PoItemRow,
} from "../../vendor/scm/lib/suppliers-queries";
import { skuMapFromBindings, supplierCodeFor } from "../../vendor/scm/lib/supplier-doc-data";
import { useWarehouses } from "../../vendor/scm/lib/inventory-queries";
import { poDisplayNumber } from "../../vendor/scm/lib/po-status";
import { useSetBreadcrumbs } from "../../hooks/useBreadcrumbs";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { useAuth as useHouzsAuth } from "../../auth/AuthContext";
// PO amendment create flow (feat/amendment-ui). Localized entry point — the
// "Raise amendment" button + its modal. NOTE: this file is also edited by the
// concurrent relmap-clickable-amendment work; this addition is confined to the
// import + one button + modal state to keep the merge trivial.
import { PoAmendmentCreateModal } from "../../components/scm-v2/PoAmendmentCreateModal";
// Relationship map (owner 2026-07-27) — the purchase-side twin of the SO/DO/
// SI/DR maps: same shared 5-node canvas, chain + clicks from the PO hook.
import { DocumentRelationshipMapModal, DocumentChoiceDialog } from "../../components/scm-v2/DocumentRelationshipMapModal";
import { usePoRelationshipMap } from "./po-relationship-map";
// Per-line SO allocations (mig 0235) — split a consolidated line across the
// customers (and stock) it serves; sub-numbered PO-xxxx-yy-01, -02, ...
import { PoLineAllocationsModal } from "../../components/scm-v2/PoLineAllocationsModal";
import { PrintPreviewModal, useOpenPrintPreviewFromUrl, usePrintPreview } from "../../components/scm-v2/PrintPreviewModal";
import type { PdfAction } from "../../vendor/scm/lib/pdf-common";
import { cn } from "../../lib/utils";
import { convertToLink } from "../../lib/convertScope";

// ─── Helpers ────────────────────────────────────────────────────────────────

const fmtMoney = (centi: number, currency = "MYR"): string => fmtMoneyCenti(centi, currency);

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const s = iso.replace(/T.*$/, "");
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(s);
  if (!m) return s;
  return `${m[3]}/${m[2]}/${m[1]}`;
};

const supplierNameOf = (h: PoHeaderRow): string =>
  h.supplier?.name || h.supplier_id || "—";
const supplierCodeOf = (h: PoHeaderRow): string => h.supplier?.code || "—";

const totalOf = (h: PoHeaderRow): number =>
  h.total_centi ?? h.subtotal_centi ?? 0;

// PO effective lifecycle for hero + tone.
type Effective =
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
};

const STAGE_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  PARTIALLY_RECEIVED: "Partially received",
  RECEIVED: "Received",
  CANCELLED: "Cancelled",
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

// Received-vs-ordered breakdown from live line items.
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

// ─── Field cell ────────────────────────────────────────────────────────────

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

// ─── Aside primitives ───────────────────────────────────────────────────────

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

// ─── PO total hero — money-out slab ────────────────────────────────────────
//
// PO is a money-out doc. The hero shows the committed total; while pending
// it renders in accent-bright (warning), once fully received it flips to
// success (green). Ordered + received qty ride as sub-lines so ops can see
// how far the PO is through its receipt lifecycle without opening any line.

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
        <HeroLine k="Subtotal" v={fmtMoney(header.subtotal_centi, header.currency)} />
        <HeroLine k="Tax" v={fmtMoney(header.tax_centi ?? 0, header.currency)} />
        <HeroLine k="Total" v={fmtMoney(total, header.currency)} strong />
      </div>

      {/* Receipt progress — the PO's most operational signal. */}
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

// ─── Legacy inline editor (lazy) ───────────────────────────────────────────
// V2 is READ-ONLY by design. The full inline editor — which also hosts the
// SO-amendment "Revision ready" banner (Approve PO + Send) + Revisions tab —
// lives in ./PurchaseOrderDetail. We forward to it whenever ?edit=1 lands on
// this route so the Edit button (and the Amendments queue's PO rows) actually
// open editable fields + the amendment banner. Mirrors SalesOrderDetailV2's
// forward. Lazy-loaded so the editor bundle only ships when someone edits.
const PurchaseOrderDetailInlineEditor = lazy(() =>
  import("./PurchaseOrderDetail").then((m) => ({ default: m.PurchaseOrderDetail })),
);

// ─── Main page ─────────────────────────────────────────────────────────────

/* Thin router — only calls useSearchParams so Rules of Hooks are respected when
   the ?edit=1 flip swaps between the read-only body and the lazy inline editor
   (the two children have different hook counts). */
export function PurchaseOrderDetailV2() {
  const [params] = useSearchParams();
  if (params.get("edit") === "1") {
    return (
      <Suspense
        fallback={<div className="p-8 text-[13px] text-ink-muted">Loading editor…</div>}
      >
        <PurchaseOrderDetailInlineEditor />
      </Suspense>
    );
  }
  return <PurchaseOrderDetailV2ReadOnly />;
}

function PurchaseOrderDetailV2ReadOnly() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const detail = usePurchaseOrderDetail(id ?? null);
  const submitPo = useSubmitPurchaseOrder();
  const confirmPo = useConfirmPurchaseOrder();
  const cancelPo = useCancelPurchaseOrder();
  const reopenPo = useReopenPurchaseOrder();
  const notify = useNotify();
  const confirm = useConfirm();
  const { can } = useHouzsAuth();
  // In-flight guard for the supplier send — see doSendToSupplier.
  const [sendingToSupplier, setSendingToSupplier] = useState(false);
  // PO amendment create modal (feat/amendment-ui) — localized state.
  const [showAmendModal, setShowAmendModal] = useState(false);
  // Relationship map modal — open state only; the chain itself comes from
  // usePoRelationshipMap below (after the header row resolves).
  const [relMapOpen, setRelMapOpen] = useState(false);
  // Allocation editor (mig 0235) — which line's split is open. Deliberately
  // available at every status except CANCELLED (backend rule): the historical
  // consolidated lines the owner wants to attribute live on RECEIVED POs.
  const [allocLineId, setAllocLineId] = useState<string | null>(null);

  /* Nick 2026-07-09 — Ship-to warehouse cell was rendering the raw
     `purchase_location_id` UUID because the field only carries the id;
     the backend join for the name/code hasn't been surfaced on this
     header shape. Look it up client-side via the same useWarehouses
     hook every other PO screen uses. includeInactive so a warehouse
     that was toggled off after the PO was raised still resolves. */
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
  const items: PoItemRow[] = useMemo(
    () => ((detail.data as { items?: PoItemRow[] } | undefined)?.items ?? []),
    [detail.data]
  );

  // The 5-node purchase chain + what each node does when clicked (shared hook,
  // one logic layer — mirrors how the SO detail pages consume their map).
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

  /* Supplier SKU — the code the SUPPLIER acts on, and the one the purchaser
     quotes on the phone. Lines SNAPSHOT it at PO creation (`supplier_sku`);
     lines raised before that column existed didn't, so fall back to the live
     supplier↔material binding — the same two-step the PRINTED PO already runs
     (supplierCodeFor). The screen must not say "—" where the PDF prints a code.

     The binding fetch is skipped entirely when every line carries a snapshot,
     which is the normal case; `useSupplierDetail(null)` is disabled, so this
     costs nothing on a modern PO. */
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
  const goHistory = () => id && navigate(`/scm/purchase-orders/${id}?tab=history`);
  // Render + download the PO PDF via the shared jspdf generator (client-side),
  // mirroring the V1 PurchaseOrderDetail handler. The old `?print=1` navigation
  // was dead — nothing consumed that param — so the button did nothing.
  const deliverPrintPdf = (action: PdfAction) => {
    if (!purchaseOrder) return;
    // PR #102 — pre-resolve purchase_location name + deliver-to address (the
    // PDF can't hit the API), same as the V1 detail page.
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
        generatePurchaseOrderPdf(headerForPdf as never, items as never, { action })
      )
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

  /* Email this PO to its supplier — a HUMAN action (the agent only drafts). The
     PDF is rendered here in the browser (the backend has no PDF engine) and posted
     as base64; the backend attaches it and sends via the gated purchase_order
     channel. Confirm first — it goes to an external party.

     The confirm SHOWS THE ADDRESS, because "send to the supplier" is not the
     decision the operator is actually making: the supplier record may carry a
     stale or wrong contact, and the moment to catch that is before the send, not
     from the audit trail afterwards. */
  const doSendToSupplier = async () => {
    if (!id || !purchaseOrder) return;
    if (sendingToSupplier) return;
    const recipient = purchaseOrder.supplier?.email?.trim();
    if (!recipient) {
      notify({
        title: "No supplier email",
        body: "This supplier has no email address on file. Add one on the supplier record, then send.",
        tone: "error",
      });
      return;
    }
    const ok = await confirm({
      title: `Email PO ${purchaseOrder.po_number} to the supplier?`,
      body: `It will be sent to ${recipient} with the PO attached as a PDF. Check the address is the right one for this supplier.`,
      confirmLabel: "Send to supplier",
    });
    if (!ok) return;
    /* Guard the double-click at the source as well as at the backend claim. The
       backend refusal is the one that is authoritative (a second tab, a retried
       request); this only spares the operator a confusing error for the common
       case of clicking twice on a slow send. */
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
      const { purchaseOrderPdfBase64 } = await import("../../vendor/scm/lib/purchase-order-pdf");
      const pdfBase64 = await purchaseOrderPdfBase64(headerForPdf as never, items as never);
      const res = await authedFetch<{ sent: boolean; to: string; result: { reason?: string } }>(
        `/mfg-purchase-orders/${id}/send-to-supplier`,
        { method: "POST", body: JSON.stringify({ pdfBase64 }) },
      );
      if (res.sent) {
        notify({ title: "Sent to supplier", body: `PO emailed to ${res.to}.` });
      } else {
        notify({ title: "Not sent", body: res.result?.reason ?? "The email channel may be off — check email settings.", tone: "error" });
      }
    } catch (e) {
      /* The backend's refusals (cancelled PO, bad address, oversize PDF, a send
         moments ago) reach here already in plain language: authedFetch runs the
         response through humanApiError and throws an Error carrying that
         sentence, so e.message is the operator-facing text. */
      notify({ title: "Send failed", body: e instanceof Error ? e.message : "Something went wrong.", tone: "error" });
    } finally {
      setSendingToSupplier(false);
    }
  };

  const doSubmit = () => {
    if (!id) return;
    if (window.confirm("Submit this PO to the supplier?")) {
      submitPo.mutate(id);
    }
  };
  const doConfirm = () => {
    if (!id) return;
    confirmPo.mutate(id);
  };
  const doCancel = () => {
    if (!purchaseOrder) return;
    if (window.confirm(`Cancel PO ${purchaseOrder.po_number}? Any GRN raised against this PO must be cancelled first.`)) {
      cancelPo.mutate(purchaseOrder.id);
    }
  };
  const doReopen = () => {
    if (!purchaseOrder) return;
    if (window.confirm(`Reopen cancelled PO ${purchaseOrder.po_number}?`)) {
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

  // Line item columns — carries a Received and a Balance column so ops can see
  // per-line where the PO stands vs the supplier's shipments. Any of these can
  // be hidden from the Columns drawer; only Item is alwaysVisible.
  const lineColumns: Column<PoItemRow>[] = [
    {
      key: "item",
      label: "Item",
      alwaysVisible: true,
      getValue: (l) => l.material_code,
      /* Item CODE first, then the variant subtitle; description dropped (owner 2026-07-24) — the shared order-line rule
         (vendor/shared/line-identity.ts). JUDGEMENT CALL, stated rather than
         silently taken: this is PURCHASE vocabulary (material_code), and every
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
          code: l.material_code,
          description: l.description || l.material_name,
          variant: buildVariantSummary(l.item_group ?? "others", l.variants) || (l.description2 ?? ""),
        });
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
            {/* SO-drift redline — what the source SO now requests vs what this
                PO still holds. The same note the editor shows, so the reader
                sees the pending change without opening the SO. */}
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
      /* Sits next to Item deliberately: the two codes for the same thing —
         ours on the left, theirs on the right — read as a pair, which is how
         the purchaser uses them when chasing a line with the supplier. */
      key: "supplierSku",
      label: "Supplier SKU",
      width: "132px",
      getValue: (l) => {
        const code = supplierCodeFor(l, skuByMaterialCode);
        // getValue feeds sort / search / export — an em dash is a RENDER
        // fallback, not a value, so unknown sorts and exports as empty.
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
    {
      key: "qty",
      label: "Ordered",
      width: "84px",
      align: "right",
      getValue: (l) => l.qty,
      render: (l) => (
        <span className="font-money text-[13px] text-ink-secondary">
          {l.qty} <span className="text-[10.5px] text-ink-muted">{l.uom || ""}</span>
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
      key: "transferTo",
      label: "Transfer to",
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
      /* mig 0235 — the consolidated-PO split: which customer (or STOCK) each
         slice of this line was BOUGHT for, as sub-numbered chips. The Split
         button opens the editor; it stays available on RECEIVED POs on purpose
         (the backend refuses only CANCELLED) — attributing historical
         consolidated buys by hand is what the editor exists for. Slices are
         procurement provenance (Decision, purchase-order.md 2026-08-06: soft
         until DO) — muted tone, "bought for" wording, never "assigned". */
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
                aria-label={`Edit allocations for ${l.material_code}`}
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
      getValue: (l) => l.unit_price_centi,
      render: (l) => (
        <span className="font-money text-[13px] text-ink-secondary">
          {fmtMoney(l.unit_price_centi, purchaseOrder?.currency)}
        </span>
      ),
    },
    {
      key: "total",
      label: "Amount",
      width: "132px",
      align: "right",
      getValue: (l) => l.line_total_centi,
      render: (l) => (
        <span className="font-money text-[13px] font-semibold text-ink">
          {fmtMoney(l.line_total_centi ?? 0, purchaseOrder?.currency)}
        </span>
      ),
    },
  ];

  // ── Loading / error states ───────────────────────────────────────────
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
  const canSubmit = rawStatus === "DRAFT";
  const canConfirm = rawStatus === "SUBMITTED";
  const canConvertToGrn = rawStatus === "SUBMITTED" || rawStatus === "PARTIALLY_RECEIVED";
  const canCancel = rawStatus !== "CANCELLED" && rawStatus !== "RECEIVED";
  const canReopen = rawStatus === "CANCELLED";
  const isCancelled = rawStatus === "CANCELLED";

  return (
    <div className="pb-24 md:pb-0">
      {/* Mobile-only dark sticky header */}
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
            <Badge tone={badgeTone} variant="solid" size="xs">
              {stageLabel}
            </Badge>
          </div>
        </div>
      </div>

      {/* Desktop sticky header */}
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
                <Badge tone={badgeTone} size="sm">
                  {stageLabel}
                </Badge>
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
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" icon={<History size={14} />} onClick={goHistory}>
              History
            </Button>
            <Button variant="ghost" icon={<Share2 size={14} />} onClick={() => setRelMapOpen(true)}>
              Relationship Map
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
              <Button variant="danger" icon={<XCircle size={14} />} onClick={doCancel}>
                Cancel PO
              </Button>
            )}
            {canReopen && (
              <Button variant="secondary" icon={<RotateCcw size={14} />} onClick={doReopen}>
                Reopen
              </Button>
            )}
            {canSubmit && (
              <Button variant="secondary" icon={<Send size={14} />} onClick={doSubmit}>
                Submit
              </Button>
            )}
            {canConfirm && (
              <Button variant="secondary" icon={<CheckCircle2 size={14} />} onClick={doConfirm}>
                Confirm
              </Button>
            )}
            {canConvertToGrn && (
              <Button variant="secondary" icon={<Package size={14} />} onClick={goGrnFromPo}>
                Convert to GRN
              </Button>
            )}
            {/* Raise amendment — a live (confirmed, non-cancelled) PO can be
                revised through the single-approver amendment flow. The backend
                one-open guard 409s a second request; the modal surfaces that. */}
            {purchaseOrder.status !== "DRAFT" && purchaseOrder.status !== "CANCELLED" && can("scm.po_amendment.create") && (
              <Button variant="secondary" icon={<FilePenLine size={14} />} onClick={() => setShowAmendModal(true)}>
                Raise amendment
              </Button>
            )}
            <Button variant="primary" icon={<Edit3 size={14} />} onClick={goEdit}>
              Edit
            </Button>
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

      {/* Allocation editor (mig 0235) — split ONE line across its customers +
          stock. Lives on the read-only V2 page (not the ?edit=1 editor) because
          it must stay reachable on RECEIVED POs, where the editor is locked. */}
      {allocLineId && (
        <PoLineAllocationsModal
          poId={purchaseOrder.id}
          poNumber={purchaseOrder.po_number}
          lineId={allocLineId}
          onClose={() => setAllocLineId(null)}
        />
      )}

      {/* Detail body */}
      <div className="py-5">
        {/* Mobile-only PO total hero */}
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
            {/* Supplier */}
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
                  value={purchaseOrder.supplier?.email || "Not provided"}
                  muted={!purchaseOrder.supplier?.email}
                />
                <Field
                  label="Address"
                  value={purchaseOrder.supplier?.address || "—"}
                  muted={!purchaseOrder.supplier?.address}
                />
              </div>
            </Section>

            {/* PO info */}
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

            {/* Line items */}
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
                layoutFamily={DATA_TABLE_LAYOUT_FAMILIES.purchaseOrderLines}
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

      {/* Fixed bottom action bar (phone) */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 px-3 pb-6 pt-2.5 shadow-slab backdrop-blur-sm md:hidden">
        <div className="flex items-center gap-2">
          {canSubmit ? (
            <button
              type="button"
              onClick={doSubmit}
              className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink"
            >
              <Send size={16} /> Submit
            </button>
          ) : canConvertToGrn ? (
            <button
              type="button"
              onClick={goGrnFromPo}
              className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink"
            >
              <Package size={16} /> Convert to GRN
            </button>
          ) : (
            <button
              type="button"
              onClick={goEdit}
              className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink"
            >
              <Edit3 size={16} /> Edit
            </button>
          )}
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

      {/* Relationship map modal — the purchase-side twin of the SO map (same
          shared 5-node canvas, read as the purchase chain). */}
      <DocumentRelationshipMapModal
        open={relMapOpen}
        onClose={() => setRelMapOpen(false)}
        nodes={chainNodes}
        onNodeClick={(n) => {
          // Close only when the click actually navigated away; an in-app
          // notice (multi-doc lists / access gates) renders OVER the map.
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
      {/* A chain slot standing for several documents opens this chooser instead
          of a notice that only named them. Picking a row navigates, so the map
          closes with it. */}
      <DocumentChoiceDialog
        prompt={chainChoice}
        onClose={closeChainChoice}
        onPick={(d) => {
          setRelMapOpen(false);
          pickChainChoice(d);
        }}
      />
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
