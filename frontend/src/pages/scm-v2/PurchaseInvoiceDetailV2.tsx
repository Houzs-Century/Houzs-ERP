// PurchaseInvoiceDetailV2 — Theme C redesign of the Purchase Invoice detail
// page. Procurement-side twin of SalesInvoiceDetailV2: money-forward,
// Outstanding-as-hero, but flipped — this is what WE owe to the supplier.

import { lazy, useMemo, type ReactNode } from "react";
import { buildVariantSummary, fmtDate, fmtMoneySen, orderLineIdentity } from "@2990s/shared";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { LazySlot } from "../../components/LazySlot";
import { scmListReturnTo } from "../../lib/scmListReturn";
import {
  ArrowLeft,
  History,
  Printer,
  XCircle,
  Edit3,
  CircleDot,
  Phone as PhoneIcon,
  MoreHorizontal,
  CheckCircle2,
  Wallet,
  AlertTriangle,
  Send,
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
  usePurchaseInvoiceDetail,
  useCancelPurchaseInvoice,
  usePostPurchaseInvoice,
  useRecordPiPayment,
} from "../../vendor/scm/lib/purchase-invoice-queries";
import { useSupplierDetail } from "../../vendor/scm/lib/suppliers-queries";
import { skuMapFromBindings, supplierCodeFor } from "../../vendor/scm/lib/supplier-doc-data";
import { useSetBreadcrumbs } from "../../hooks/useBreadcrumbs";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { PrintPreviewModal, useOpenPrintPreviewFromUrl, usePrintPreview } from "../../components/scm-v2/PrintPreviewModal";
import type { PdfAction } from "../../vendor/scm/lib/pdf-common";
import { cn } from "../../lib/utils";
import { resolveFxRate } from "./fx-rate";
import { HoldChip, type HoldFields } from "../../vendor/scm/components/HoldChip";

// ─── Types ──────────────────────────────────────────────────────────────────

type PiStatus =
  | "DRAFT"
  | "POSTED"
  | "PARTIALLY_PAID"
  | "PAID"
  | "CANCELLED"
  | string;

type PiHeader = HoldFields & {
  id: string;
  invoice_number: string;
  supplier_invoice_ref?: string | null;
  status: PiStatus;
  invoice_date: string | null;
  due_date: string | null;
  total_sen: number;
  paid_sen?: number;
  currency: string;
  /* Multi-currency / landed cost (Phase 1-A). exchange_rate = MYR per 1 unit of
     `currency`; allocation_method = the freight "平摊" basis for the SERVICE-line
     charge spread into each goods line's landed cost. */
  exchange_rate?: string | number | null;
  allocation_method?: string | null;
  notes?: string | null;
  supplier?: {
    id: string;
    code: string;
    name: string;
    contact_person?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
  } | null;
  purchase_order?: { id: string; po_number: string } | null;
  grn?: { id: string; grn_number: string } | null;
  posted_at?: string | null;
  created_at?: string;
};

type PiItem = {
  id: string;
  item_code?: string | null;
  /* Supplier's own code — PI has no column of its own; the detail GET carries it
     down from the source GRN line (grn_item_id → grn_items.supplier_sku). */
  supplier_sku?: string | null;
  description?: string | null;
  description2?: string | null;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
  uom?: string;
  qty?: number;
  unit_price_sen?: number;
  line_total_sen?: number;
  /* Landed-cost allocation (Phase 1-A) — freight (MYR sen) allocated to this line. */
  allocated_charge_sen?: number | null;
};

/* Landed-cost allocation (Phase 1-A) — human labels for the freight basis. */
const ALLOC_LABEL: Record<string, string> = { QTY: 'By quantity', VALUE: 'By value', CBM: 'By volume (CBM)' };


// ─── Helpers ────────────────────────────────────────────────────────────────

const fmtMoney = (centi: number, currency = "MYR"): string => fmtMoneySen(centi, currency);

const daysPast = (iso: string | null | undefined): number => {
  if (!iso) return -1;
  const s = iso.replace(/T.*$/, "");
  const t = Date.parse(s);
  if (Number.isNaN(t)) return -1;
  const now = Date.now();
  return Math.floor((now - t) / 86_400_000);
};

const supplierNameOf = (h: PiHeader): string => h.supplier?.name || "—";
const supplierCodeOf = (h: PiHeader): string => h.supplier?.code || "—";
const sourceOf = (h: PiHeader): string =>
  h.grn?.grn_number || h.purchase_order?.po_number || "—";

const outstandingOf = (h: PiHeader): number =>
  Math.max(0, (h.total_sen ?? 0) - (h.paid_sen ?? 0));

// PI effective lifecycle.
type Effective = "draft" | "posted" | "partial" | "paid" | "overdue" | "cancelled" | "on_hold";
const effectiveOf = (h: PiHeader): Effective => {
  const s = (h.status || "").toUpperCase();
  if (s === "CANCELLED") return "cancelled";
  /* BEFORE the money checks (mig 0320). They read paid_sen, so a partly-paid
     invoice that was then put ON HOLD would have shown "Partially paid" and the
     hold would have been invisible on the one screen a person opens to decide
     whether to pay the rest. */
  if (s === "ON_HOLD") return "on_hold";
  if (s === "PAID" || outstandingOf(h) === 0) return "paid";
  if (s === "PARTIALLY_PAID" || (h.paid_sen ?? 0) > 0) return "partial";
  if (s === "DRAFT") return "draft";
  const overdueDays = daysPast(h.due_date);
  if (overdueDays > 0 && outstandingOf(h) > 0) return "overdue";
  return "posted";
};

const EFFECTIVE_TONE: Record<
  Effective,
  { tone: "success" | "warning" | "error" | "neutral"; label: string; blurb: string }
> = {
  draft: { tone: "warning", label: "Draft", blurb: "Draft · not yet posted" },
  posted: { tone: "warning", label: "Confirmed", blurb: "Confirmed · awaiting payment" },
  on_hold: { tone: "warning", label: "On Hold", blurb: "On hold · payment blocked until released" },
  partial: { tone: "warning", label: "Partially paid", blurb: "Partially paid · balance still due" },
  paid: { tone: "success", label: "Paid", blurb: "Paid · loop closed" },
  overdue: { tone: "error", label: "Overdue", blurb: "Overdue · past due date" },
  cancelled: { tone: "error", label: "Cancelled", blurb: "Cancelled · no further action" },
};

const STAGE_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  POSTED: "Posted",
  PARTIALLY_PAID: "Partially paid",
  PAID: "Paid",
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

// ─── Field cell + aside primitives (identical shape to sales-side V2) ─────

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
      <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className={cn("mt-1 text-[14px] font-semibold leading-snug", muted ? "text-ink-muted" : "text-ink", mono && "font-mono")}>
        {value}
      </div>
    </div>
  );
}

function AsideCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{title}</div>
      {children}
    </div>
  );
}

function KeyDateRow({ k, v, muted, danger }: { k: string; v: string; muted?: boolean; danger?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-border-subtle py-2 last:border-b-0">
      <span className="text-[12.5px] text-ink-muted">{k}</span>
      <span className={cn("text-[13px] font-semibold", danger ? "text-err" : muted ? "text-ink-muted" : "text-ink")}>{v}</span>
    </div>
  );
}

function PersonRow({ initials, name, role, tone = "accent" }: { initials: string; name: string; role: string; tone?: "accent" | "neutral" }) {
  return (
    <div className="flex items-center gap-3 border-b border-border-subtle py-3 last:border-b-0">
      <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[12px] font-bold", tone === "accent" ? "bg-accent-soft text-accent-ink" : "bg-border-subtle text-ink-secondary")}>
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
const DOT_CLS: Record<ActivityDot, string> = { success: "bg-synced", primary: "bg-primary", muted: "bg-border-strong" };
function ActivityRow({ title, meta, dot, isLast }: { title: string; meta: string; dot: ActivityDot; isLast?: boolean }) {
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

// ─── Owed hero (dark aside slab) ──────────────────────────────────────────

function OwedHeroCard({ header }: { header: PiHeader }) {
  const eff = effectiveOf(header);
  const t = EFFECTIVE_TONE[eff];
  const total = header.total_sen ?? 0;
  const paid = header.paid_sen ?? 0;
  const outstanding = outstandingOf(header);
  const isPaid = outstanding === 0;
  // Multi-currency (Phase 1-A) — MYR-equivalent for a foreign PI (no-op for MYR).
  const isForeign = String(header.currency ?? "MYR").toUpperCase() !== "MYR";
  const rate = resolveFxRate(header.exchange_rate);
  return (
    <div className="rounded-lg bg-sidebar px-5 py-5 text-sidebar-ink shadow-stone">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-sidebar-ink-muted">
        {isPaid ? "Paid in full" : "Owed to supplier"}
      </div>
      <div className={cn("mt-1.5 font-money text-[28px] font-bold leading-none tracking-tight", isPaid ? "text-synced" : "text-err")}>
        {fmtMoney(isPaid ? total : outstanding, header.currency)}
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
        <HeroLine k="Invoice total" v={fmtMoney(total, header.currency)} />
        <HeroLine k="Paid" v={fmtMoney(paid, header.currency)} tone={paid > 0 ? "success" : "muted"} />
        <HeroLine k="Owed" v={fmtMoney(outstanding, header.currency)} tone={outstanding > 0 ? "err" : "success"} strong />
        {isForeign && (
          <>
            <HeroLine k={`Rate (MYR / 1 ${header.currency})`} v={String(rate)} />
            <HeroLine k="Posted to GL (MYR)" v={fmtMoney(Math.round(total * rate), "MYR")} />
          </>
        )}
      </div>
    </div>
  );
}

function HeroLine({ k, v, tone = "muted", strong }: { k: string; v: string; tone?: "muted" | "success" | "err"; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={cn("text-[12.5px] text-sidebar-ink-muted", strong && "font-semibold text-white")}>{k}</span>
      <span
        className={cn(
          "font-money text-[13px] font-semibold",
          tone === "success" ? "text-synced" : tone === "err" ? "text-err" : "text-sidebar-ink",
          strong && "text-[16px] font-bold"
        )}
      >
        {v}
      </span>
    </div>
  );
}

// ─── Legacy inline editor (lazy) ───────────────────────────────────────────
// V2 is READ-ONLY by design. The variant-capable draft editor (one PoLineCard
// per line — GRN-sourced lines keep code + variants read-only, free-entry lines
// get full Create-style editing) lives in the legacy ./PurchaseInvoiceDetail
// page — we forward to it whenever ?edit=1 lands on this route so the Edit
// button actually opens editable fields. Mirrors how GoodsReceivedDetailV2 /
// SalesOrderDetailV2 forward ?edit=1 to their legacy editor. Lazy-loaded so the
// editor bundle only ships when someone actually clicks Edit.
const PurchaseInvoiceDetailInlineEditor = lazy(() =>
  import("./PurchaseInvoiceDetail").then((m) => ({ default: m.PurchaseInvoiceDetail })),
);

// ─── Main page ─────────────────────────────────────────────────────────────

/* Thin router — the only hooks it calls are useSearchParams and useLocation
   (both unconditional, at the top), so Rules of Hooks
   are respected when the ?edit=1 flip swaps between the read-only body and the
   lazy inline editor (the two children have different hook counts). */
export function PurchaseInvoiceDetailV2() {
  const [params] = useSearchParams();
  const location = useLocation();
  if (params.get("edit") === "1") {
    /* Scoped, not bare: a boundary keyed on the document this slot is editing,
       so a failed editor chunk shows the panel in place of the editor and
       clears when the operator moves to another document, instead of leaning
       on a boundary in a file this one cannot see. */
    return (
      <LazySlot
        resetKey={`pi-editor:${location.pathname}`}
        fallback={<div className="p-8 text-[13px] text-ink-muted">Loading editor…</div>}
      >
        <PurchaseInvoiceDetailInlineEditor />
      </LazySlot>
    );
  }
  return <PurchaseInvoiceDetailV2ReadOnly />;
}

function PurchaseInvoiceDetailV2ReadOnly() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const detail = usePurchaseInvoiceDetail(id ?? null);
  const cancelPi = useCancelPurchaseInvoice();
  const postPi = usePostPurchaseInvoice();
  const recordPayment = useRecordPiPayment();
  const notify = useNotify();
  const askConfirm = useConfirm();

  const purchaseInvoice =
    (detail.data as { purchaseInvoice?: PiHeader } | undefined)?.purchaseInvoice ??
    null;
  const items: PiItem[] = useMemo(
    () => ((detail.data as { items?: PiItem[] } | undefined)?.items ?? []),
    [detail.data]
  );
  /* Every source note this invoice bills (owner 2026-08-06 multi-note) — the
     backend derives it from the LINES, so it covers notes the header's single
     grn_id doesn't name. Empty on a manual PI. */
  const sourceGrns = useMemo(
    () => ((detail.data as { sourceGrns?: Array<{ id: string; grn_number: string; delivery_note_ref: string | null }> } | undefined)?.sourceGrns ?? []),
    [detail.data]
  );
  const supplierDoRefs = useMemo(
    () => [...new Set(sourceGrns.map((g) => (g.delivery_note_ref ?? '').trim()).filter(Boolean))],
    [sourceGrns]
  );

  useSetBreadcrumbs([
    { label: "Purchase Invoices", to: "/scm/purchase-invoices" },
    { label: purchaseInvoice?.invoice_number ?? id ?? "Purchase Invoice" },
  ]);

  /* Supplier SKU — a PI line inherits the supplier's own code from its source
     GRN line (backend hops grn_item_id → grn_items.supplier_sku). Lines with no
     snapshot (older GRNs, or PI-native service lines) fall back to the live
     supplier↔material binding — the same two-step the GRN/PO detail use. The
     binding fetch is skipped when every line already carries a snapshot;
     useSupplierDetail(null) is disabled. */
  const needsSkuLookup = useMemo(
    () => items.some((l) => !(l.supplier_sku ?? "").trim()),
    [items]
  );
  const supplierForSku = useSupplierDetail(
    needsSkuLookup ? purchaseInvoice?.supplier?.id ?? null : null
  );
  const skuByMaterialCode = useMemo(
    () => skuMapFromBindings(supplierForSku.data?.bindings),
    [supplierForSku.data]
  );

  const eff = purchaseInvoice ? effectiveOf(purchaseInvoice) : null;
  const stageLabel = purchaseInvoice
    ? STAGE_LABEL[(purchaseInvoice.status || "").toUpperCase()] ??
      purchaseInvoice.status
    : "";
  const badgeTone = eff ? EFFECTIVE_TONE[eff].tone : "neutral";

  const outstanding = purchaseInvoice ? outstandingOf(purchaseInvoice) : 0;

  const overdueDays = purchaseInvoice ? daysPast(purchaseInvoice.due_date) : -1;
  const isOverdue = overdueDays > 0 && outstanding > 0;

  // Back always returns to the Purchase Invoices list (owner 2026-07-24: every
  // details page's back button goes to its relevant list, not wherever
  // browser history happens to point). The list restores its own sticky
  // filters, so the prior filtered view comes back — no context lost.
  const goBack = () => navigate(scmListReturnTo("/scm/purchase-invoices"));
  const goEdit = () => id && navigate(`/scm/purchase-invoices/${id}?edit=1`);
  const goHistory = () => id && navigate(`/scm/purchase-invoices/${id}?tab=history`);
  // Render + download the PI PDF via the shared jspdf generator (client-side),
  // mirroring the V1 PurchaseInvoiceDetail handler. The old `?print=1`
  // navigation was dead — nothing consumed that param — so the button did nothing.
  const deliverPrintPdf = (action: PdfAction) => {
    if (!purchaseInvoice) return;
    return import("../../vendor/scm/lib/purchase-invoice-pdf")
      .then(({ generatePurchaseInvoicePdf }) =>
        generatePurchaseInvoicePdf(purchaseInvoice as never, items as never, { action })
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
  useOpenPrintPreviewFromUrl(print.openPreview, !!purchaseInvoice);
  const goRecordPayment = () =>
    id && navigate(`/scm/purchase-invoices/${id}?tab=payments&record=1`);
  const doPost = async () => {
    if (!id) return;
    if (await askConfirm({
      title: "Post this purchase invoice?",
      body: "Revenue-side and AP will be updated.",
      confirmLabel: "Post invoice",
    })) {
      postPi.mutate(id);
    }
  };
  const doCancel = async () => {
    if (!purchaseInvoice) return;
    if (await askConfirm({
      title: `Cancel invoice ${purchaseInvoice.invoice_number}?`,
      body: "Any posted revenue will be reversed via a contra JE.",
      confirmLabel: "Cancel invoice",
      danger: true,
    })) {
      cancelPi.mutate(purchaseInvoice.id);
    }
  };
  const doMarkPaid = () => {
    if (!purchaseInvoice) return;
    recordPayment.mutate({ id: purchaseInvoice.id, amountSen: outstanding });
  };

  const lineColumns: Column<PiItem>[] = [
    {
      key: "item",
      label: "Item",
      alwaysVisible: true,
      getValue: (l) => l.item_code || l.item_code || "",
      /* Item CODE first, then the variant subtitle; description dropped (owner 2026-07-24) — the shared order-line rule
         (vendor/shared/line-identity.ts). Swept on SHAPE, not vocabulary: this
         was the pre-#647 SalesOrderDetailV2 cell exactly. The code still BINDS
         via getValue above. */
      render: (l) => {
        const { primary, secondary } = orderLineIdentity({
          code: l.item_code || l.item_code,
          description: l.description,
          variant: buildVariantSummary(l.item_group ?? "others", l.variants) || (l.description2 ?? ""),
        });
        return (
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-ink">
              {primary || "—"}
            </div>
            {secondary && (
              <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-muted">
                <span className="truncate text-ink-secondary">{secondary}</span>
              </div>
            )}
          </div>
        );
      },
    },
    {
      /* Our code and the supplier's code side by side — the pair the purchaser
         reconciles against the supplier's bill. Snapshot (from the source GRN
         line) first, else the live binding, else —. */
      key: "supplierSku",
      label: "Supplier SKU",
      width: "132px",
      getValue: (l) => {
        const code = supplierCodeFor(
          { item_code: (l.item_code || l.item_code) ?? "", supplier_sku: l.supplier_sku },
          skuByMaterialCode
        );
        return code === "—" ? "" : code;
      },
      render: (l) => {
        const code = supplierCodeFor(
          { item_code: (l.item_code || l.item_code) ?? "", supplier_sku: l.supplier_sku },
          skuByMaterialCode
        );
        if (code === "—") return <span className="text-ink-muted">—</span>;
        return <span className="font-mono text-[12px] text-ink-secondary">{code}</span>;
      },
    },
    {
      key: "qty",
      label: "Qty",
      width: "72px",
      align: "right",
      getValue: (l) => l.qty ?? 0,
      render: (l) => (
        <span className="font-money text-[13px] text-ink-secondary">
          {l.qty ?? 0} <span className="text-[10.5px] text-ink-muted">{l.uom || ""}</span>
        </span>
      ),
    },
    {
      key: "unit",
      label: "Unit price",
      width: "108px",
      align: "right",
      getValue: (l) => l.unit_price_sen ?? 0,
      render: (l) => (
        <span className="font-money text-[13px] text-ink-secondary">
          {fmtMoney(l.unit_price_sen ?? 0, purchaseInvoice?.currency)}
        </span>
      ),
    },
    {
      key: "total",
      label: "Amount",
      width: "132px",
      align: "right",
      getValue: (l) => l.line_total_sen ?? 0,
      render: (l) => {
        const freight = Number(l.allocated_charge_sen ?? 0);
        return (
          <span className="inline-flex flex-col items-end">
            <span className="font-money text-[13px] font-semibold text-ink">
              {fmtMoney(l.line_total_sen ?? 0, purchaseInvoice?.currency)}
            </span>
            {/* Landed-cost allocation (Phase 1-A) — per-line freight (MYR sen). */}
            {freight > 0 && (
              <span className="font-money text-[10.5px] text-accent-ink">+freight {fmtMoney(freight, "MYR")}</span>
            )}
          </span>
        );
      },
    },
  ];

  if (!id) {
    return <div className="p-8 text-center text-ink-muted">No purchase invoice specified.</div>;
  }
  if (detail.isPending) {
    return <div className="animate-fade-in p-8 text-center text-ink-muted">Loading purchase invoice…</div>;
  }
  if (detail.error || !purchaseInvoice) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div className="mb-2 font-display text-[18px] font-extrabold text-err">Couldn't load purchase invoice</div>
        <p className="text-[13px] text-ink-muted">
          {(detail.error as Error | undefined)?.message ?? "The invoice was not found."}
        </p>
        <div className="mt-4">
          <Button variant="secondary" onClick={goBack} icon={<ArrowLeft size={14} />}>
            Back to Purchase Invoices
          </Button>
        </div>
      </div>
    );
  }

  const goCall = () => {
    if (!purchaseInvoice?.supplier?.phone) return;
    window.location.href = `tel:${purchaseInvoice.supplier.phone.replace(/\s+/g, "")}`;
  };

  const rawStatus = (purchaseInvoice.status || "").toUpperCase();
  const isCancelled = rawStatus === "CANCELLED";
  const isTerminal = isCancelled || rawStatus === "PAID";
  const canPost = rawStatus === "DRAFT";
  const canRecordPayment = !isTerminal && outstanding > 0 && rawStatus !== "DRAFT";
  const canMarkPaid = !isTerminal && outstanding === 0 && rawStatus !== "DRAFT";

  return (
    <div className="pb-24 md:pb-0">
      <div className="sticky top-0 z-20 -mx-4 -mt-4 bg-sidebar text-sidebar-ink shadow-slab md:hidden">
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <button type="button" onClick={goBack} className="inline-flex items-center gap-1 text-[14px] font-semibold text-accent-bright" aria-label="Back to Purchase Invoices">
            <ArrowLeft size={16} /> PIs
          </button>
          <span className="font-mono text-[12.5px] font-semibold text-sidebar-ink">{purchaseInvoice.invoice_number}</span>
          <button type="button" className="text-sidebar-ink-muted" aria-label="More actions">
            <MoreHorizontal size={18} />
          </button>
        </div>
        <div className="px-4 pb-4 pt-3">
          <h1 className="font-display text-[19px] font-bold leading-tight text-white">{supplierNameOf(purchaseInvoice)}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5">
              <Badge tone={badgeTone} variant="solid" size="xs">{stageLabel}</Badge>
              {/* mig 0324 — BESIDE the status, never instead of it. */}
              <HoldChip onHold={purchaseInvoice.on_hold} reason={purchaseInvoice.hold_reason} />
            </span>
            {isOverdue && (
              <span className="inline-flex items-center gap-1 rounded-md bg-err/20 px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wider text-err">
                <AlertTriangle size={10} /> {overdueDays}d overdue
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="sticky top-0 z-10 -mx-4 hidden border-b border-border bg-bg/95 px-4 py-4 backdrop-blur-sm sm:-mx-6 sm:px-6 md:block">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <button
              type="button"
              onClick={goBack}
              aria-label="Back to Purchase Invoices"
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary hover:border-primary/50 hover:text-primary"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
                  {supplierNameOf(purchaseInvoice)}
                </h1>
                <span className="inline-flex items-center gap-1.5">
                  <Badge tone={badgeTone} size="sm">{stageLabel}</Badge>
                  {/* mig 0324 — BESIDE the status, never instead of it. */}
                  <HoldChip onHold={purchaseInvoice.on_hold} reason={purchaseInvoice.hold_reason} />
                </span>
                {isOverdue && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-err-soft px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-err">
                    <AlertTriangle size={11} /> {overdueDays}d overdue
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-secondary">
                <span className="font-mono font-semibold text-primary-ink">{purchaseInvoice.invoice_number}</span>
                <Divider />
                <span>Invoiced {fmtDate(purchaseInvoice.invoice_date)}</span>
                <Divider />
                <span className={cn(isOverdue && "font-semibold text-err")}>Due {fmtDate(purchaseInvoice.due_date)}</span>
                <Divider />
                <span>{items.length} line{items.length === 1 ? "" : "s"}</span>
                {sourceOf(purchaseInvoice) !== "—" && (
                  <>
                    <Divider />
                    <span>
                      From{" "}
                      <span className="font-mono font-semibold text-ink-secondary">
                        {sourceOf(purchaseInvoice)}
                      </span>
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" icon={<History size={14} />} onClick={goHistory}>History</Button>
            <Button variant="secondary" icon={<Printer size={14} />} onClick={print.openPreview}>Print PDF</Button>
            {!isCancelled && (
              <Button variant="danger" icon={<XCircle size={14} />} onClick={doCancel}>Cancel PI</Button>
            )}
            {canPost && (
              <Button variant="secondary" icon={<Send size={14} />} onClick={doPost}>Post</Button>
            )}
            {canRecordPayment && (
              <Button variant="secondary" icon={<Wallet size={14} />} onClick={goRecordPayment}>Record payment</Button>
            )}
            {canMarkPaid && (
              <Button variant="secondary" icon={<CheckCircle2 size={14} />} onClick={doMarkPaid}>Mark paid</Button>
            )}
            <Button variant="primary" icon={<Edit3 size={14} />} onClick={goEdit}>Edit</Button>
          </div>
        </div>
      </div>

      <div className="py-5">
        <div className="mb-3 rounded-lg border border-border bg-surface p-4 shadow-stone md:hidden">
          <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
            {outstanding === 0 ? "Paid in full" : "Owed to supplier"}
          </div>
          <div className={cn("mt-1 font-money text-[26px] font-bold leading-none tracking-tight", outstanding === 0 ? "text-synced" : "text-err")}>
            {fmtMoney(outstanding === 0 ? purchaseInvoice.total_sen : outstanding, purchaseInvoice.currency)}
          </div>
          <div className="mt-1.5 text-[12px] text-ink-muted">
            Total {fmtMoney(purchaseInvoice.total_sen, purchaseInvoice.currency)} · Paid {fmtMoney(purchaseInvoice.paid_sen ?? 0, purchaseInvoice.currency)}
          </div>
        </div>

        <DetailGrid>
          <DetailMain>
            <Section title="Supplier">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-3">
                <Field label="Supplier" value={supplierNameOf(purchaseInvoice)} />
                <Field label="Supplier code" value={supplierCodeOf(purchaseInvoice)} mono />
                <Field
                  label="Contact"
                  value={purchaseInvoice.supplier?.contact_person || "—"}
                  muted={!purchaseInvoice.supplier?.contact_person}
                />
                <Field
                  label="Phone"
                  value={purchaseInvoice.supplier?.phone || "Not provided"}
                  muted={!purchaseInvoice.supplier?.phone}
                  mono={!!purchaseInvoice.supplier?.phone}
                />
                <Field
                  label="Email"
                  value={purchaseInvoice.supplier?.email || "Not provided"}
                  muted={!purchaseInvoice.supplier?.email}
                />
                <Field
                  label="Address"
                  value={purchaseInvoice.supplier?.address || "—"}
                  muted={!purchaseInvoice.supplier?.address}
                />
              </div>
            </Section>

            <Section title="Invoice info">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-4">
                <Field label="Invoice date" value={fmtDate(purchaseInvoice.invoice_date)} />
                <Field
                  label="Due date"
                  value={
                    purchaseInvoice.due_date ? (
                      <span className={cn(isOverdue && "text-err")}>
                        {fmtDate(purchaseInvoice.due_date)}
                        {isOverdue && (
                          <span className="ml-2 text-[11px] font-bold uppercase tracking-wider">+{overdueDays}d</span>
                        )}
                      </span>
                    ) : (
                      "Not set"
                    )
                  }
                  muted={!purchaseInvoice.due_date}
                />
                <Field
                  label="Supplier invoice ref"
                  value={purchaseInvoice.supplier_invoice_ref || "—"}
                  muted={!purchaseInvoice.supplier_invoice_ref}
                  mono={!!purchaseInvoice.supplier_invoice_ref}
                />
                {/* Owner 2026-08-06 — a supplier invoice may bill SEVERAL
                    notes; the detail GET derives the full set from the LINES
                    (the header FK is only the primary ref). List them all, and
                    each note's supplier delivery-note ref alongside. */}
                <Field
                  label={sourceGrns.length > 1 ? `Source · ${sourceGrns.length} notes` : "Source"}
                  value={sourceGrns.length ? sourceGrns.map((g) => g.grn_number).join(", ") : sourceOf(purchaseInvoice)}
                  mono={sourceGrns.length > 0 || sourceOf(purchaseInvoice) !== "—"}
                  muted={!sourceGrns.length && sourceOf(purchaseInvoice) === "—"}
                />
                {supplierDoRefs.length > 0 && (
                  <Field
                    label={supplierDoRefs.length > 1 ? "Supplier DO #s" : "Supplier DO #"}
                    value={supplierDoRefs.join(", ")}
                    mono
                  />
                )}
                <Field label="Currency" value={purchaseInvoice.currency} />
                {/* Multi-currency / landed cost (Phase 1-A) — shown only for a
                    foreign PI; an MYR invoice is byte-for-byte the old layout. */}
                {String(purchaseInvoice.currency ?? "MYR").toUpperCase() !== "MYR" && (
                  <Field label={`Exchange rate (MYR / 1 ${purchaseInvoice.currency})`} value={String(resolveFxRate(purchaseInvoice.exchange_rate))} mono />
                )}
                <Field label="Charge allocation" value={ALLOC_LABEL[String(purchaseInvoice.allocation_method ?? "QTY")] ?? "By quantity"} />
              </div>

              {purchaseInvoice.notes && (
                <div className="mt-4 rounded-lg border border-warning-text/25 bg-warning-bg px-4 py-3">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-warning-text">Note</div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-warning-text">{purchaseInvoice.notes}</p>
                </div>
              )}
            </Section>

            <Section title={`Line items · ${items.length}`}>
              <DataTable<PiItem>
                tableId={`pi-lines-${id}`}
                layoutFamily={DATA_TABLE_LAYOUT_FAMILIES.purchaseInvoiceLines}
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
              <OwedHeroCard header={purchaseInvoice} />

              <AsideCard title="Key dates">
                <KeyDateRow k="Invoice" v={fmtDate(purchaseInvoice.invoice_date)} />
                <KeyDateRow
                  k="Due"
                  v={fmtDate(purchaseInvoice.due_date)}
                  muted={!purchaseInvoice.due_date}
                  danger={isOverdue}
                />
                {purchaseInvoice.posted_at && (
                  <KeyDateRow k="Posted" v={fmtDate(purchaseInvoice.posted_at)} />
                )}
              </AsideCard>

              <AsideCard title="People">
                <PersonRow
                  initials={initialsOf(supplierNameOf(purchaseInvoice))}
                  name={supplierNameOf(purchaseInvoice)}
                  role={`Supplier · ${supplierCodeOf(purchaseInvoice)}`}
                  tone="accent"
                />
                {purchaseInvoice.supplier?.contact_person && (
                  <PersonRow
                    initials={initialsOf(purchaseInvoice.supplier.contact_person)}
                    name={purchaseInvoice.supplier.contact_person}
                    role={purchaseInvoice.supplier.phone || "Contact"}
                    tone="neutral"
                  />
                )}
              </AsideCard>

              <AsideCard title="Recent activity">
                <ActivityRow
                  title={`Invoice ${EFFECTIVE_TONE[effectiveOf(purchaseInvoice)].label.toLowerCase()}`}
                  meta={fmtDate(purchaseInvoice.invoice_date)}
                  dot={EFFECTIVE_TONE[effectiveOf(purchaseInvoice)].tone === "success" ? "success" : "primary"}
                />
                {(purchaseInvoice.paid_sen ?? 0) > 0 && (
                  <ActivityRow
                    title={`Payment sent (${fmtMoney(purchaseInvoice.paid_sen ?? 0, purchaseInvoice.currency)})`}
                    meta={fmtDate(purchaseInvoice.invoice_date)}
                    dot="success"
                  />
                )}
                <ActivityRow
                  title="Created"
                  meta={fmtDate(purchaseInvoice.created_at)}
                  dot="muted"
                  isLast
                />
              </AsideCard>
            </div>
          </DetailAside>
        </DetailGrid>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 px-3 pb-6 pt-2.5 shadow-slab backdrop-blur-sm md:hidden">
        <div className="flex items-center gap-2">
          {canPost ? (
            <button type="button" onClick={doPost} className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink">
              <Send size={16} /> Post
            </button>
          ) : canRecordPayment ? (
            <button type="button" onClick={goRecordPayment} className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink">
              <Wallet size={16} /> Record payment
            </button>
          ) : (
            <button type="button" onClick={goEdit} className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink">
              <Edit3 size={16} /> Edit
            </button>
          )}
          <button type="button" onClick={print.openPreview} className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-surface-2 text-primary-ink hover:bg-primary-soft" aria-label="Print PDF">
            <Printer size={17} />
          </button>
          <button
            type="button"
            onClick={goCall}
            disabled={!purchaseInvoice.supplier?.phone}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-surface-2 text-primary-ink hover:bg-primary-soft disabled:opacity-40"
            aria-label={purchaseInvoice.supplier?.phone ? `Call ${purchaseInvoice.supplier.phone}` : "No phone on file"}
          >
            <PhoneIcon size={17} />
          </button>
        </div>
      </div>
      <PrintPreviewModal
        open={print.open}
        onClose={print.close}
        docTitle="Purchase Invoice"
        docNo={purchaseInvoice.invoice_number}
        rows={[
          { label: "Supplier", value: supplierNameOf(purchaseInvoice) },
          { label: "Against", value: sourceOf(purchaseInvoice) },
          { label: "Invoice date", value: fmtDate(purchaseInvoice.invoice_date) },
          { label: "Items", value: `${items.length} line${items.length === 1 ? "" : "s"}` },
          {
            label: "Invoice total",
            value: fmtMoney(purchaseInvoice.total_sen, purchaseInvoice.currency),
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

export default PurchaseInvoiceDetailV2;
