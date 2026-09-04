// SalesOrderDetailV2 — Theme C ("Ink & Petrol") redesign of the Sales Order
// detail page. Read-first: the old page was a wall of empty inputs; this one
// treats an SO as an object you look at, and slides the edit / status
// mutations into the header action bar and (on Edit) into the existing
// SalesOrderDetail editor route.
//
// Scope of THIS file (Item B of the 4-part redesign):
//   · Sticky header (Back + customer name + status Badge + meta line + action
//     buttons: History · Relationship Map · Print PDF · Cancel SO · Edit)
//   · Two-column DetailGrid — main col of Section cards for Customer / Order
//     info (with amber Note callout) / Delivery address + Emergency contact /
//     Line items (DataTable with FOC badges); sticky aside with dark Order-
//     total card + Key dates + People + Recent activity.
//   · Wired to useMfgSalesOrderDetail; status mutation via useUpdateMfgSales-
//     OrderStatus. Edit navigates to the existing full editor (?edit=1).
//
// The old ledger-style SalesOrderDetail.tsx stays in the tree; App.tsx route
// swap on /scm/sales-orders/:docNo decides which one users see.

import { lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { coverageStateOf } from "../../components/coverage-state";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { LazySlot } from "../../components/LazySlot";
import { scmListReturnTo } from "../../lib/scmListReturn";
import {
  ArrowLeft,
  History,
  Share2,
  Printer,
  XCircle,
  Edit3,
  Warehouse,
  CircleDot,
  Phone as PhoneIcon,
  MoreHorizontal,
  Wallet,
} from "lucide-react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { SoSourceChips, SoStockPill } from "../../components/SoSourceChips";
import { DataTable, type Column } from "../../components/DataTable";
import { DATA_TABLE_LAYOUT_FAMILIES } from "../../components/dataTableLayoutFamilies";
import {
  DetailGrid,
  DetailMain,
  DetailAside,
  Section,
} from "../../components/DetailLayout";
import { overlaySoLineCoverage } from "../../vendor/scm/lib/so-coverage-overlay";
import {
  useMfgSalesOrderDetail,
  useSoLineCoverage,
  useUpdateMfgSalesOrderStatus,
  useSalesOrderPayments,
  useSalesOrderAuditLog,
  type SoLineCoverage,
} from "../../vendor/scm/lib/sales-order-queries";
/* The real audit trail — the same drawer and the same vocabulary the V1 detail
   page uses, so History means one thing across both (owner 2026-08-13). */
import { AuditHistoryPanel } from "../../components/audit/AuditHistoryPanel";
import { SO_AUDIT_LABELS } from "./so-audit-labels";
import { fmtDateTime } from "../../vendor/shared/format";
import { brandingLabel } from "../../vendor/shared/so-branding-label";
import { getBrandingCompanyCode } from "../../lib/branding";
import { useAuth as useHouzsAuth } from "../../auth/AuthContext";
import { useSetBreadcrumbs } from "../../hooks/useBreadcrumbs";
import { useStaffLookup } from "../../hooks/useStaffLookup";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { DocumentRelationshipMapModal, DocumentChoiceDialog } from "../../components/scm-v2/DocumentRelationshipMapModal";
import { PrintPreviewModal, useOpenPrintPreviewFromUrl, usePrintPreview } from "../../components/scm-v2/PrintPreviewModal";
import type { PdfAction } from "../../vendor/scm/lib/pdf-common";
import { useSoRelationshipMap } from "./so-relationship-map";
import { PaymentsTable, type PaymentDraft } from "../../vendor/scm/components/PaymentsTable";
import { fetchSoSlipUrl } from "../../vendor/scm/lib/slip";
import {
  completePaymentRetryDraft, consumePaymentRetryNavigationState,
  readPaymentRetryHandoff, readPaymentRetryNavigationState,
} from "../../lib/paymentRetryHandoff";
import { cn, formatDate } from "../../lib/utils";
import { SoLinePhotoStrip } from "../../components/scm-v2/SoLinePhotoStrip";
import { buildVariantSummary, fmtDate, fmtMoneySen, orderLineIdentity } from "@2990s/shared";
import { formatPhone } from "@2990s/shared/phone";
import {
  isLocked as isSoLocked,
  amendmentEligible as soAmendmentEligible,
} from "../../vendor/scm/lib/so-detail-gates";

// ─── Row types (subset — see MfgSalesOrdersList.tsx for the full SoRow) ────

type SoHeader = {
  doc_no: string;
  /* POS handover payment slip (migration 0143) — passed to PaymentsTable's
     optional Slip column; absent on non-POS orders. */
  slip_key?: string | null;
  so_date: string;
  debtor_name: string;
  debtor_code: string | null;
  agent: string | null;
  salesperson_id: string | null;
  sales_location: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  ref: string | null;
  branding: string | null;
  first_item_branding: string | null;
  first_item_category: string | null;
  status: string;
  local_total_sen: number;
  balance_sen: number;
  paid_sen: number;
  discount_sen?: number;
  phone: string | null;
  email: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  customer_state: string | null;
  customer_country: string | null;
  customer_type: string | null;
  building_type: string | null;
  venue: string | null;
  // The processing-date column the lock reads. Label, API field and column are
  // finally the same word (mig 0284 renamed it from internal_expected_dd).
  processing_date?: string | null;
  // Server-derived SO-lock / amendment flags (see the /:docNo detail handler).
  // has_children = a non-cancelled DO/SI references this SO (hard lock);
  // amendment_eligible = processing-locked but still amendable; has_open_amendment
  // = an in-flight amendment already exists.
  has_children?: boolean | null;
  amendment_eligible?: boolean | null;
  has_open_amendment?: boolean | null;
  customer_delivery_date: string | null;
  note: string | null;
  currency: string;
  payment_method: string | null;
  payment_methods_summary?: string;
  // Finance-gated cost / margin analytics (migration 0079). Present on the
  // DETAIL payload for every caller (only the LIST endpoint strips these —
  // #574); the UI gates the Totals·Margin card behind project_finance_viewer.
  // Cost columns are nullable for rows predating the cost backfill.
  total_cost_sen?: number | null;
  total_margin_sen?: number | null;
  margin_pct_basis?: number | null;
  mattress_sofa_sen?: number | null;
  bedframe_sen?: number | null;
  accessories_sen?: number | null;
  others_sen?: number | null;
  service_sen?: number | null;
  mattress_sofa_cost_sen?: number | null;
  bedframe_cost_sen?: number | null;
  accessories_cost_sen?: number | null;
  others_cost_sen?: number | null;
  service_cost_sen?: number | null;
};

type SoItem = {
  id: string;
  item_code: string;
  description: string | null;
  description2: string | null;
  uom: string;
  qty: number;
  unit_price_sen: number;
  discount_sen: number;
  total_sen: number;
  cancelled: boolean;
  item_group?: string;
  variants?: Record<string, unknown> | null;
  /* The operator's free-text instruction for whoever executes this line — the
     "Type remarks…" box on the line card, served by GET /:docNo all along and
     rendered nowhere. Owner 2026-08-11 (2990-SO-2608-016): a SVC-ADDON line
     added purely to say "Please take back Cody Bedframe (King Size) 2 units"
     showed as an RM0 line reading only its SKU code. */
  remark?: string | null;
  /* Per-line stock + source-PO trace (owner 2026-08-01: a READY/SHIPPED/
     DELIVERED line must name the PO its goods came from). All stamped by
     GET /mfg-sales-orders/:docNo — this page previously dropped them on the
     floor, which is why the detail showed no Stock / Incoming PO at all. */
  stock_status?: string | null;
  stock_state?: "stock" | "po" | "shortage" | null;
  /* R2 object keys for this line's reference photos — the AutoCount
     Further-Description shots the cutover imported, plus anything uploaded on
     the edit card. Served by GET /:docNo all along (ITEM_COLS carries
     photo_urls); this page never rendered them, so the only way to SEE a
     line's photo was to enter edit mode (owner 2026-08-10: "我在外面的 UI 看
     不到照片了吗?不能点开照片来看吗?"). */
  photo_urls?: string[] | null;
  coverage_po?: string | null;
  coverage_eta?: string | null;
  shipped_source_pos?: string[];
  shipped_source_adj?: boolean;
  ready_source_pos?: Array<{ po: string | null; qty: number; kind: "po" | "adjustment" }>;
  delivered_qty?: number | null;
  remaining_qty?: number | null;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/* Money display delegates to the ONE shared centi formatter (vendor/shared/
   format.ts). The page-local copy this replaces had no finite guard, so an
   absent / non-numeric cost rendered the literal "MYR NaN" at the user; the
   shared helper renders "—" for a number the ERP does not have. */
const fmtMoney = fmtMoneySen;

const refOf = (h: SoHeader): string =>
  h.po_doc_no || h.customer_so_no || h.ref || "—";

/* HEADER FIRST, then the SAME shared rule the SO list falls back to — byte-for-
   byte the list's brandOf. Owner 2026-08-18: "我要表头啊", so a filled header
   still wins on both companies; what changes here is the FALLBACK. This page
   used to end `|| "—"` over the raw brand TEXT, so an order with no header and a
   rep line carrying no brand text — every sofa — printed a dash while the list
   beside it printed a brand. */
const brandOf = (h: SoHeader): string =>
  (h.branding ?? "").trim() ||
  brandingLabel(h.first_item_category, h.first_item_branding, getBrandingCompanyCode());

const STATUS_TONE: Record<
  string,
  { tone: "success" | "warning" | "error" | "neutral"; label: string; blurb: string }
> = {
  draft: {
    tone: "warning",
    label: "Draft",
    blurb: "Draft · not yet confirmed",
  },
  confirmed: {
    tone: "success",
    label: "Confirmed",
    blurb: "Confirmed · awaiting payment",
  },
  cancelled: {
    tone: "error",
    label: "Cancelled",
    blurb: "Cancelled · no further action",
  },
  cancel: {
    tone: "error",
    label: "Cancelled",
    blurb: "Cancelled · no further action",
  },
  delivered: {
    tone: "success",
    label: "Delivered",
    blurb: "Delivered · goods handed over",
  },
  invoiced: {
    tone: "success",
    label: "Invoiced",
    blurb: "Invoiced · payment logged",
  },
  completed: {
    tone: "success",
    label: "Completed",
    blurb: "Completed",
  },
};
const statusFor = (
  s: string
): { tone: "success" | "warning" | "error" | "neutral"; label: string; blurb: string } =>
  STATUS_TONE[(s || "").toLowerCase()] ?? {
    tone: "neutral",
    label: s || "—",
    blurb: s || "—",
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
      <div
        className={cn(
          "mt-1 text-[14px] font-semibold leading-snug",
          muted ? "text-ink-muted" : "text-ink",
          mono && "font-mono"
        )}
      >
        {value}
      </div>
    </div>
  );
}

// ─── Sub-primitives for the aside cards ────────────────────────────────────

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
      <span
        className={cn(
          "text-[13px] font-semibold",
          muted ? "text-ink-muted" : "text-ink"
        )}
      >
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
          tone === "accent"
            ? "bg-accent-soft text-accent-ink"
            : "bg-border-subtle text-ink-secondary"
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

// ─── Recent activity timeline ─────────────────────────────────────────────
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

// ─── Order total card (dark aside hero) ────────────────────────────────────

function OrderTotalCard({
  header,
  subtotalSen,
  discountSen,
  totalSen,
}: {
  header: SoHeader;
  subtotalSen: number;
  discountSen: number;
  totalSen: number;
}) {
  /* The auto-derived delivery fee is inside `totalSen` but was not itemised,
     so an all-FOC order read "Subtotal 0 → Total 250" with nothing explaining
     the 250 (owner, 2026-08-07: "为什么会有 rm250?"). Derived as the remainder
     rather than read from a header field so the row is exactly the gap the
     reader is staring at, whatever fee components the server folds in. */
  const feeSen = totalSen - (subtotalSen - discountSen);
  const st = statusFor(header.status);
  return (
    <div className="rounded-lg bg-sidebar px-5 py-5 text-sidebar-ink shadow-stone">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-sidebar-ink-muted">
        Order total
      </div>
      <div className="mt-1.5 font-money text-[30px] font-bold leading-none tracking-tight text-white">
        {fmtMoney(totalSen, header.currency)}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            st.tone === "success"
              ? "bg-synced"
              : st.tone === "warning"
                ? "bg-accent-bright"
                : st.tone === "error"
                  ? "bg-err"
                  : "bg-sidebar-ink-muted"
          )}
        />
        <span className="text-[12.5px] text-sidebar-ink-muted">{st.blurb}</span>
      </div>

      <div className="mt-4 space-y-2 border-t border-white/10 pt-4">
        <TotalLine k="Subtotal" v={fmtMoney(subtotalSen, header.currency)} />
        <TotalLine k="Discount" v={fmtMoney(discountSen, header.currency)} />
        {feeSen > 0 && (
          <TotalLine k="Delivery fee" v={fmtMoney(feeSen, header.currency)} />
        )}
        <TotalLine k="SST" v="Inclusive" muted />
        <TotalLine
          k="Total"
          v={fmtMoney(totalSen, header.currency)}
          strong
        />
      </div>
    </div>
  );
}

function TotalLine({
  k,
  v,
  muted,
  strong,
}: {
  k: string;
  v: string;
  muted?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span
        className={cn(
          "text-[12.5px] text-sidebar-ink-muted",
          strong && "text-white font-semibold"
        )}
      >
        {k}
      </span>
      <span
        className={cn(
          "font-money text-[13px] font-semibold text-sidebar-ink",
          muted && "text-sidebar-ink-muted",
          strong && "text-[16px] font-bold text-accent-bright"
        )}
      >
        {v}
      </span>
    </div>
  );
}

// ─── Totals · Margin card — REMOVED (owner 2026-07-17) ─────────────────────
// The Revenue / Cost / Margin / Margin% aside card (and its per-category cost
// breakdown) is gone from the SO document view for EVERYONE; costing moves to
// the separate Finance "Fulfillment Costing" module. The customer-facing
// OrderTotalCard (Subtotal / Discount / Total) is untouched.

// ─── Legacy inline editor (lazy) ───────────────────────────────────────────
// V2 is READ-ONLY by design (sticky header + section cards + Order-total
// aside). The full 2014-LOC inline editor lives in ./SalesOrderDetail — we
// forward to it whenever ?edit=1 lands on this route so Nick's Edit button
// actually opens editable fields (the whole read-first redesign left goEdit
// pointing at a URL nobody handled → the button was a dead-link on
// CONFIRMED SOs). Lazy-loaded so the editor bundle only ships when someone
// actually clicks Edit.
const SalesOrderDetailInlineEditor = lazy(() =>
  import("./SalesOrderDetail").then((m) => ({ default: m.SalesOrderDetail })),
);

// ─── Main page ─────────────────────────────────────────────────────────────

/* Thin router — the only hooks it calls are useSearchParams and useLocation
   (both unconditional, at the top), so Rules of Hooks
   are respected when the ?edit=1 flip swaps between the read-only body and
   the lazy inline editor (the two children have different hook counts;
   letting either side call hooks conditionally inside the same function
   would break on navigation). */
export function SalesOrderDetailV2() {
  const [params] = useSearchParams();
  const location = useLocation();
  /* `payments=1` used to forward to the legacy editor; since 2026-08-09 the
     read page hosts the SAME PaymentsTable component (owner: "点选 collect
     payment … 全部 UI 都不一样" — one page, one look; the flag now just seeds
     the payments Edit toggle below). Only full `edit=1` swaps bodies. */
  if (params.get("edit") === "1") {
    /* Scoped, not bare: a boundary keyed on the document this slot is editing,
       so a failed editor chunk shows the panel in place of the editor and
       clears when the operator moves to another document, instead of leaning
       on a boundary in a file this one cannot see. */
    return (
      <LazySlot
        resetKey={`so-editor:${location.pathname}`}
        fallback={<div className="p-8 text-[13px] text-ink-muted">Loading editor…</div>}
      >
        <SalesOrderDetailInlineEditor />
      </LazySlot>
    );
  }
  return <SalesOrderDetailV2ReadOnly />;
}

function SalesOrderDetailV2ReadOnly() {
  const { docNo } = useParams<{ docNo: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const detail = useMfgSalesOrderDetail(docNo ?? null);
  /* Live stock coverage is fetched SEPARATELY so this page paints on the fast
     detail response (stored verdict, null live fields) and never blocks on it;
     the badge + source-PO chips upgrade in place when this arrives. */
  const coverage = useSoLineCoverage(docNo ?? null);
  const updateStatus = useUpdateMfgSalesOrderStatus();
  const { nameOf: salespersonNameOf } = useStaffLookup();
  const notify = useNotify();
  const askConfirm = useConfirm();
  // Followup #81 — the printed SO reads payments from the ledger, not the
  // deprecated header columns; fetch them for the Print PDF handler.
  const printPaymentsQ = useSalesOrderPayments(docNo ?? null);

  // Replace the auto-derived "Scm" module crumb with the actual SO doc no.
  // Falls back to the raw route param while detail is loading so the top bar
  // never flashes back to "Scm".
  useSetBreadcrumbs([
    { label: "Sales Orders", to: "/scm/sales-orders" },
    { label: docNo ?? "Sales Order" },
  ]);

  const salesOrder = (detail.data as { salesOrder?: SoHeader } | undefined)?.salesOrder ?? null;
  // Coverage keyed by line id; empty until the async coverage query returns (or
  // when the endpoint 404s on an older backend). Overlaid onto the lines below.
  /* The overlay is SHARED with the list drill-down (vendor/scm/lib/
     so-coverage-overlay) — two hand-written merges is how the board and the
     drill-down drifted apart in docs/bugs/0269-*. */
  const items: SoItem[] = useMemo(
    () => overlaySoLineCoverage(
      ((detail.data as { items?: SoItem[] } | undefined)?.items ?? []).filter((l) => !l.cancelled),
      coverage.data?.coverage,
    ),
    [detail.data, coverage.data]
  );

  const st = salesOrder ? statusFor(salesOrder.status) : null;

  // Totals — subtotal from live items; discount from header (aggregate); total
  // = header.local_total_sen if the API stamped it, else recomputed.
  const subtotalSen = useMemo(
    () => items.reduce((s, l) => s + l.total_sen + l.discount_sen, 0),
    [items]
  );
  const discountSen = useMemo(
    () =>
      salesOrder?.discount_sen ??
      items.reduce((s, l) => s + l.discount_sen, 0),
    [items, salesOrder?.discount_sen]
  );
  const totalSen =
    salesOrder?.local_total_sen ?? subtotalSen - discountSen;

  const focCount = useMemo(
    () => items.filter((l) => l.unit_price_sen === 0 && l.total_sen === 0).length,
    [items]
  );

  // ── SO lock / amendment gating (shared with the full editor + mobile) ────
  // A proceeded SO whose processing day has passed is locked: line/field edits
  // must go through the SO Amendment workflow, not a direct edit. Reflect that
  // on the PRIMARY Edit affordance here so the button routes to the amendment
  // flow (or is disabled when the SO is hard-locked by a downstream DO/SI)
  // instead of always presenting a plain "Edit" that opens editable fields.
  const hardLocked = salesOrder
    ? isSoLocked(salesOrder.status, Boolean(salesOrder.has_children))
    : false;
  const canAmend = salesOrder ? soAmendmentEligible(salesOrder, hardLocked) : false;
  const hasOpenAmend = Boolean(salesOrder?.has_open_amendment);
  /* Owner 2026-08-17 — a hard-locked order still opens for the ONE change a
     DO / SI does not snapshot: who owns it. The editor keeps every other field
     disabled (SalesOrderDetail's `inputsDisabled` still reads the lock), so
     this door leads to exactly one dropdown. Without it, handing a delivered
     order to a resigning rep's replacement meant Override — which unlocks the
     whole order, addresses and lines included. */
  const canAttributeOther = useHouzsAuth().can("scm.so.attribute_other");
  const editDisabled = hardLocked && !canAttributeOther;
  const lockedEditHint = hardLocked && canAttributeOther
    ? "This order is locked by a downstream Delivery Order / Sales Invoice — only the Salesperson can still be changed."
    : "This order is locked — it already has a downstream Delivery Order / Sales Invoice.";
  const editLabel = canAmend
    ? hasOpenAmend
      ? "View amendment"
      : "Submit SO Amendment"
    : "Edit";

  // Back always returns to the Sales Orders list (owner 2026-07-24: every
  // details page's back button goes to its relevant list, not wherever
  // browser history happens to point). The list restores its own sticky
  // filters, so the prior filtered view comes back — no context lost.
  const goBack = async () => {
    if (unsavedPayments > 0 && !(await askConfirm({
      title: "Leave without saving payments?",
      body: `${unsavedPayments} payment row${unsavedPayments === 1 ? " is" : "s are"} typed but not saved.`,
      confirmLabel: "Leave anyway",
      danger: true,
    }))) return;
    navigate(scmListReturnTo("/scm/sales-orders"));
  };
  // Edit always forwards to the full editor (?edit=1). When the SO is
  // amendment-eligible the editor opens in amendment mode (Save submits an
  // amendment request); when hard-locked the button is disabled here.
  const goEdit = () => docNo && navigate(`/scm/sales-orders/${docNo}?edit=1`);
  /* Payments editing now lives ON this page (same PaymentsTable the editor
     uses) — "Collect payment" just unlocks the card and scrolls to it. */
  const location = useLocation();
  const [payEditing, setPayEditing] = useState(params.get("payments") === "1");
  const [unsavedPayments, setUnsavedPayments] = useState(0);
  const paymentsRef = useRef<HTMLDivElement>(null);
  const [paymentRetryState, setPaymentRetryState] = useState<{ documentId: string; drafts: PaymentDraft[] } | null>(null);
  const paymentRetryDrafts = paymentRetryState && paymentRetryState.documentId === docNo
    ? paymentRetryState.drafts
    : [];
  useEffect(() => {
    if (!docNo) return;
    const stored = readPaymentRetryHandoff("so", docNo)?.drafts ?? [];
    const navigated = readPaymentRetryNavigationState(location.state, "so", docNo);
    const byKey = new Map([...stored, ...navigated].map((draft) => [draft.idempotencyKey, draft]));
    setPaymentRetryState({ documentId: docNo, drafts: [...byKey.values()] });
    if (navigated.length > 0) {
      navigate(
        { pathname: location.pathname, search: location.search, hash: location.hash },
        { replace: true, state: consumePaymentRetryNavigationState(location.state) },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docNo]);
  const paymentRetryCommitted = (draft: PaymentDraft) => {
    if (!docNo || !draft.idempotencyKey) return;
    completePaymentRetryDraft("so", docNo, draft.idempotencyKey);
    setPaymentRetryState((current) => current?.documentId === docNo
      ? { ...current, drafts: current.drafts.filter((row) => row.idempotencyKey !== draft.idempotencyKey) }
      : current);
  };
  const goPayments = () => {
    setPayEditing(true);
    paymentsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const doCancel = async () => {
    if (!salesOrder) return;
    if (await askConfirm({
      title: `Cancel sales order ${salesOrder.doc_no}?`,
      body: "This cannot be undone.",
      confirmLabel: "Cancel order",
      danger: true,
    })) {
      updateStatus.mutate({
        docNo: salesOrder.doc_no,
        status: "cancelled",
        expectedStatus: salesOrder.status,
      });
    }
  };
  /* History (owner 2026-08-13: "点history的时候没有反应").
     This used to `navigate(\`…/${docNo}?tab=history\`)` — to the route we are
     ALREADY on, with a param nothing anywhere reads. Two independent reasons
     for nothing to happen, which is exactly what happened. It is the same
     disease as the dead `?print=1` this file already records two handlers
     below; a navigate to a param no one consumes is not a feature, it is a
     no-op wearing a button.

     Now it opens the real audit drawer — the same AuditHistoryPanel over the
     same mfg_so_audit_log the V1 detail page uses, so "History" means one
     thing in both places rather than two. */
  const [historyOpen, setHistoryOpen] = useState(false);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  const auditQ = useSalesOrderAuditLog(docNo ?? null);
  const auditEntries = auditQ.data ?? [];
  const [relMapOpen, setRelMapOpen] = useState(false);
  const goRelationshipMap = () => setRelMapOpen(true);
  // Render + download the SO PDF via the shared jspdf generator (client-side),
  // mirroring the V1 SalesOrderDetail handler. The old `?print=1` navigation
  // was dead — nothing consumed that param — so the button did nothing.
  const deliverPrintPdf = (action: PdfAction) => {
    if (!salesOrder) return;
    /* The guard below used to be keyed on `isLoading` alone with a `?? []`
       fallback. On a FAILED payments read react-query leaves `isLoading` false
       and `data` undefined, so the guard passed and this printed the
       CUSTOMER-FACING PDF with an empty Payments table — telling the customer
       they had paid nothing and owed the full total. V1 (SalesOrderDetail.tsx)
       was fixed on 2026-07-19; this twin never was.

       An empty array is an ANSWER (a genuinely unpaid order correctly prints an
       empty table). The ABSENCE of an array is not — `data` is set only by a
       successful fetch. So print only once we actually know what was paid, and
       distinguish "still loading" from "we asked and it failed", because those
       need different actions from the operator. */
    const paymentRows = printPaymentsQ.data;
    if (!Array.isArray(paymentRows)) {
      if (printPaymentsQ.isFetching) {
        notify({ title: "Loading payments… please try again in a moment." });
      } else {
        notify({
          title: "Cannot print — payments could not be loaded",
          body: "We couldn't read the payments for this order. Printing now would show the customer an empty Payments table. Please refresh and try again.",
          tone: "error",
        });
      }
      return;
    }
    const payments = paymentRows;
    // `pwpCodes` rides on the same GET /:docNo payload — vouchers this SO's
    // trigger items issued, so the printed PDF can mark the trigger lines.
    const pwpCodes = ((detail.data as { pwpCodes?: unknown[] } | undefined)
      ?.pwpCodes ?? []) as never;
    return import("../../vendor/scm/lib/sales-order-pdf")
      .then(({ generateSalesOrderPdf }) =>
        generateSalesOrderPdf(
          salesOrder as never,
          items as never,
          payments as never,
          action,
          pwpCodes
        )
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
  useOpenPrintPreviewFromUrl(print.openPreview, !!salesOrder);

  // The 5-node document chain + what each node does when clicked now come from
  // the shared hook, so this page and the ?edit=1 editor cannot drift again
  // (they already had — see so-relationship-map.ts).
  const {
    nodes: chainNodes,
    onNodeClick: onChainNodeClick,
    amendments: chainAmendments,
    onAmendmentClick: onChainAmendmentClick,
    pairing: chainPairing,
    choice: chainChoice,
    closeChoice: closeChainChoice,
    pickChoice: pickChainChoice,
  } = useSoRelationshipMap(salesOrder);

  // ── Line item columns ────────────────────────────────────────────────
  const lineColumns: Column<SoItem>[] = [
    {
      key: "item",
      label: "Item",
      alwaysVisible: true,
      getValue: (l) => l.item_code,
      render: (l) => {
        /* Item CODE first, then the variant subtitle; description dropped (owner 2026-07-24) — the shared order-line rule
           (vendor/shared/line-identity.ts, which carries the four-report history
           this table was the fourth of). The item CODE still BINDS: getValue
           above keeps it the sort / search / export value. Live variant summary
           wins over the stored description2, which can be stale on older rows
           that carry no variants blob. */
        const { primary, secondary } = orderLineIdentity({
          code: l.item_code,
          description: l.description,
          variant:
            buildVariantSummary(l.item_group ?? "", l.variants ?? null) ||
            (l.description2 ?? ""),
        });
        const remark = (l.remark ?? "").trim();
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
            {/* The line's REMARK — the operator's instruction for whoever
                executes this line. Owner 2026-08-11: a SVC-ADDON line whose whole
                purpose was "Please take back Cody Bedframe (King Size) 2 units"
                rendered as an RM0 row showing only its SKU code, so the job was
                invisible to everyone downstream. It is NOT a duplicate of the
                identity above (line-identity's rule governs the code / description
                / variant trio; this is free text that appears nowhere else on the
                row), and it WRAPS rather than truncating — a half-shown
                instruction is worse than none. */}
            {remark && (
              <div className="mt-1 whitespace-pre-wrap break-words text-[11.5px] italic leading-snug text-ink-secondary">
                {remark}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: "qty",
      label: "Qty",
      width: "72px",
      align: "right",
      getValue: (l) => l.qty,
      render: (l) => (
        <span className="font-money text-[13px] text-ink-secondary">
          {l.qty} <span className="text-[10.5px] text-ink-muted">{l.uom}</span>
        </span>
      ),
    },
    {
      key: "unit",
      label: "Unit price",
      width: "108px",
      align: "right",
      getValue: (l) => l.unit_price_sen,
      render: (l) => (
        <span className="font-money text-[13px] text-ink-secondary">
          {fmtMoney(l.unit_price_sen, salesOrder?.currency)}
        </span>
      ),
    },
    {
      key: "disc",
      label: "Disc",
      width: "88px",
      align: "right",
      getValue: (l) => l.discount_sen,
      render: (l) => {
        const isFoc = l.unit_price_sen === 0 && l.total_sen === 0;
        if (isFoc) {
          return (
            <Badge tone="warning" size="xs">
              FOC
            </Badge>
          );
        }
        if (l.discount_sen > 0) {
          return (
            <span className="font-money text-[13px] text-ink-secondary">
              {fmtMoney(l.discount_sen, salesOrder?.currency)}
            </span>
          );
        }
        return <span className="text-ink-muted">—</span>;
      },
    },
    {
      key: "total",
      label: "Amount",
      width: "132px",
      align: "right",
      getValue: (l) => l.total_sen,
      render: (l) => (
        <span className="font-money text-[13px] font-semibold text-ink">
          {fmtMoney(l.total_sen, salesOrder?.currency)}
        </span>
      ),
    },
    /* Remark as its OWN column — hidden by default because the text already
       renders under the item above, where it is read. This column exists so the
       remark is SEARCHABLE, filterable and lands in the CSV export: a `render`
       has no getValue, so without it the instruction is invisible to every one
       of those (the same reason the Stock / Incoming PO pair below carry one). */
    {
      key: "remark",
      label: "Remark",
      width: "220px",
      defaultHidden: true,
      getValue: (l) => (l.remark ?? "").trim(),
      render: (l) => {
        const remark = (l.remark ?? "").trim();
        return remark ? (
          <span className="whitespace-pre-wrap break-words text-[12px] text-ink-secondary">{remark}</span>
        ) : (
          <span className="text-ink-muted">—</span>
        );
      },
    },
    /* Photos (owner 2026-08-10) — the line's reference shots, openable. Same
       resolver as the edit card's tiles (vendor/scm/lib/so-line-photo), so the
       read page cannot drift into a second, differently-broken loading path.
       getValue is the COUNT so the column sorts/filters/exports as a number;
       a `render` with no getValue is invisible to all three. */
    {
      key: "photos",
      label: "Photos",
      width: "110px",
      getValue: (l) => (l.photo_urls ?? []).length,
      render: (l) => (
        <SoLinePhotoStrip
          source="so"
          docId={docNo ?? ""}
          itemId={l.id}
          photoKeys={l.photo_urls ?? []}
        />
      ),
    },
    /* Stock + Incoming PO (owner 2026-08-01) — the SAME per-line readiness +
       source-PO trace the SO list drill-down shows, through the ONE shared
       renderer (components/SoSourceChips.tsx). The detail payload has carried
       these fields all along; this page just never rendered them, so an
       operator opening the full page lost the trace the drill-down had. */
    {
      key: "stock",
      label: "Stock",
      width: "96px",
      getValue: (l) => l.stock_state ?? l.stock_status ?? "",
      render: (l) => <SoStockPill line={l} />,
    },
    {
      key: "source",
      label: "Incoming PO",
      width: "200px",
      getValue: (l) =>
        [
          ...(l.shipped_source_pos ?? []),
          ...(l.ready_source_pos ?? []).map((r) => r.po ?? "STOCK ADJ"),
          ...(l.coverage_po ? [l.coverage_po] : []),
        ].join(", "),
      render: (l) => <SoSourceChips line={l} coverage={coverageStateOf(coverage)} />,
    },
  ];

  // ── Loading / error states ───────────────────────────────────────────
  if (!docNo) {
    return (
      <div className="p-8 text-center text-ink-muted">No sales order specified.</div>
    );
  }
  /* isPending, NOT isLoading — the same rule as SalesOrderDetail.tsx:1207, which
     carries the full write-up. isLoading is (isPending && isFetching), so it is
     FALSE while a query is pending but not actively fetching: disabled, or PAUSED
     because the device is briefly offline. Gating on isLoading let those states
     fall through to the error branch below and paint "Couldn't load <docNo>"
     before the fetch had ever run, then swap to the real order once it resolved —
     the "打開會 error 先然後再 loading 出來" the owner reported (BUG-HISTORY
     2026-07-16). The V2 rewrite of this page regressed it; this restores it. */
  if (detail.isPending) {
    return (
      <div className="animate-fade-in p-8 text-center text-ink-muted">
        Loading {docNo}…
      </div>
    );
  }
  if (detail.error || !salesOrder) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div className="mb-2 font-display text-[18px] font-extrabold text-err">
          Couldn't load {docNo}
        </div>
        <p className="text-[13px] text-ink-muted">
          {(detail.error as Error | undefined)?.message ??
            "The sales order was not found."}
        </p>
        <div className="mt-4">
          <Button variant="secondary" onClick={goBack} icon={<ArrowLeft size={14} />}>
            Back to Sales Orders
          </Button>
        </div>
      </div>
    );
  }

  // Bottom-bar CTA on phone opens tel: with the customer's phone if present.
  const goCall = () => {
    if (!salesOrder?.phone) return;
    window.location.href = `tel:${salesOrder.phone.replace(/\s+/g, "")}`;
  };

  return (
    <div className="pb-24 md:pb-0">
      {/* ─── Mobile-only dark sticky header ─────────────────────────── */}
      <div className="sticky top-0 z-20 -mx-4 -mt-4 bg-sidebar text-sidebar-ink shadow-slab md:hidden">
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center gap-1 text-[14px] font-semibold text-accent-bright"
            aria-label="Back to Sales Orders"
          >
            <ArrowLeft size={16} /> Orders
          </button>
          <span className="font-mono text-[12.5px] font-semibold text-sidebar-ink">
            {salesOrder.doc_no}
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
            {salesOrder.debtor_name || "—"}
          </h1>
          {st && (
            <div className="mt-2">
              <Badge tone={st.tone} variant="solid" size="xs">
                {st.label}
              </Badge>
            </div>
          )}
        </div>
      </div>

      {/* ─── Desktop sticky header (hidden on phone) ────────────────── */}
      {/* Nick 2026-07-09 — "这个圈起来的需要 pin 起来".
          TopNavbar (components/TopNavbar.tsx) sits sticky top-0 z-30 h-12
          inside the SAME <main class="overflow-y-auto"> that scrolls this
          page — so a naive top-0 here parks the SO title BEHIND the top
          nav. z-20 stacks above the section cards while staying below the
          top nav. At lg the chrome is the single 52px 2b bar → lg:top-[52px];
          at md (bar hidden, mobile top bar) top-12 holds. */}
      <div className="sticky top-12 lg:top-[52px] z-20 -mx-4 hidden border-b border-border bg-bg/95 px-4 py-4 backdrop-blur-sm sm:-mx-6 sm:px-6 md:block">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <button
              type="button"
              onClick={goBack}
              aria-label="Back to Sales Orders"
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary hover:border-primary/50 hover:text-primary"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
                  {salesOrder.debtor_name || "—"}
                </h1>
                {st && (
                  <Badge tone={st.tone} size="sm">
                    {st.label}
                  </Badge>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-secondary">
                <span className="font-mono font-semibold text-primary-ink">
                  {salesOrder.doc_no}
                </span>
                <Divider />
                <span>SO date {fmtDate(salesOrder.so_date)}</span>
                <Divider />
                <span>{items.length} line{items.length === 1 ? "" : "s"}</span>
                {refOf(salesOrder) !== "—" && (
                  <>
                    <Divider />
                    <span>
                      Ref{" "}
                      <span className="font-mono font-semibold text-ink-secondary">
                        {refOf(salesOrder)}
                      </span>
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              icon={<History size={14} />}
              onClick={() => setHistoryOpen(true)}
            >
              History
            </Button>
            <Button
              variant="ghost"
              icon={<Share2 size={14} />}
              onClick={goRelationshipMap}
            >
              Relationship Map
            </Button>
            <Button
              variant="secondary"
              icon={<Printer size={14} />}
              onClick={print.openPreview}
            >
              Print PDF
            </Button>
            {/* Collect payment (owner 2026-08-07) — the direct door to the
                payments ledger. The ledger lives on the ?edit=1 editor, so
                without this the only way to key money is the Edit button
                below, and Edit answers to the LINE/HEADER lock rather than to
                anything about money:
                  · hard-locked (DELIVERED / SHIPPED / has a DO-SI) → disabled,
                    so a delivered order had NO reachable Payments section at
                    all — the balance could not be keyed and its proof had
                    nowhere to go, on the exact order state where a balance is
                    normally collected;
                  · amendment-eligible → it becomes "Submit SO Amendment", so
                    keying a payment means going through the amendment flow;
                  · otherwise → it opens every field to edit a row of numbers.
                Hence the gate here is about the MONEY, not the lock: only a
                CANCELLED order takes none, which is the same rule the payments
                card, the mobile screen and the server all use. DRAFT is left
                out on the owner's standing "no payments on drafts" ruling — and
                a draft is never locked, so Edit reaches it anyway.
                Owner 2026-08-07, on Houzs (every SO CONFIRMED, several still
                owing): "houzs也是需要collect payment功能" — the first cut gated
                this on `hardLocked`, which is a 2990 delivery-flow assumption,
                not a rule about collecting money.
                `?payments=1` opens the editor with the Payments card unlocked
                and NOTHING else: it does not set ?edit=1, so lines, header and
                addresses stay read-only under their own `isLocked` gate, which
                is the lock that genuinely belongs to them. */}
            {!["cancelled", "draft"].includes(salesOrder.status?.toLowerCase() ?? "") && (
              <Button
                variant="secondary"
                icon={<Wallet size={14} />}
                onClick={goPayments}
                title="Record a payment against this order — everything else stays as it is."
              >
                Collect payment
              </Button>
            )}
            {salesOrder.status?.toLowerCase() !== "cancelled" && (
              <Button
                variant="danger"
                icon={<XCircle size={14} />}
                onClick={doCancel}
              >
                Cancel SO
              </Button>
            )}
            <Button
              variant="primary"
              icon={<Edit3 size={14} />}
              onClick={goEdit}
              disabled={editDisabled}
              title={
                hardLocked
                  ? lockedEditHint
                  : canAmend
                    ? "This order is processing-locked — changes go through the SO Amendment workflow."
                    : undefined
              }
            >
              {editLabel}
            </Button>
          </div>
        </div>
      </div>

      {/* ─── Detail body ────────────────────────────────────────────── */}
      <div className="py-5">
        {/* Mobile-only Order total hero — sits at the very top of the scroll
            body, above the Customer section. On md+ the dark Order total lives
            in the sticky aside instead (below). */}
        <div className="mb-3 rounded-lg border border-border bg-surface p-4 shadow-stone md:hidden">
          <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
            Order total
          </div>
          <div className="mt-1 font-money text-[26px] font-bold leading-none tracking-tight text-ink">
            {fmtMoney(totalSen, salesOrder.currency)}
          </div>
          <div className="mt-1.5 text-[12px] text-ink-muted">
            {items.length} line{items.length === 1 ? "" : "s"} · {st?.blurb}
          </div>
        </div>
        <DetailGrid>
          <DetailMain>
            {/* Customer */}
            <Section title="Customer">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-3">
                <Field
                  label="Customer name"
                  value={salesOrder.debtor_name || "—"}
                />
                <Field
                  label="Phone"
                  value={formatPhone(salesOrder.phone) || "Not provided"}
                  muted={!salesOrder.phone}
                  mono={!!salesOrder.phone}
                />
                <Field
                  label="Email"
                  value={salesOrder.email || "Not provided"}
                  muted={!salesOrder.email}
                />
                <Field
                  label="Customer type"
                  value={salesOrder.customer_type || "—"}
                  muted={!salesOrder.customer_type}
                />
                <Field
                  label="Customer SO ref"
                  value={refOf(salesOrder)}
                  mono={refOf(salesOrder) !== "—"}
                  muted={refOf(salesOrder) === "—"}
                />
                <Field
                  label="Salesperson"
                  value={salespersonNameOf(
                    salesOrder.agent,
                    salesOrder.salesperson_id,
                    "Unassigned"
                  )}
                  muted={
                    !salesOrder.agent && !salesOrder.salesperson_id
                  }
                />
              </div>
            </Section>

            {/* Order info + optional amber Note callout */}
            <Section title="Order info">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-4">
                <Field
                  label="Building type"
                  value={salesOrder.building_type || "—"}
                  muted={!salesOrder.building_type}
                />
                <Field
                  label="Venue"
                  value={salesOrder.venue || "—"}
                  muted={!salesOrder.venue}
                />
                <Field
                  label="Processing Date"
                  value={fmtDate(salesOrder.processing_date)}
                  muted={!salesOrder.processing_date}
                />
                <Field
                  label="Delivery Date"
                  value={
                    salesOrder.customer_delivery_date
                      ? fmtDate(salesOrder.customer_delivery_date)
                      : "Not scheduled"
                  }
                  muted={!salesOrder.customer_delivery_date}
                />
                <Field
                  label="Branding"
                  value={brandOf(salesOrder)}
                  muted={brandOf(salesOrder) === "—"}
                />
                <Field
                  label="Payment"
                  value={
                    salesOrder.payment_methods_summary ||
                    salesOrder.payment_method ||
                    "—"
                  }
                  muted={
                    !salesOrder.payment_methods_summary &&
                    !salesOrder.payment_method
                  }
                />
              </div>

              {salesOrder.note && (
                <div className="mt-4 rounded-lg border border-warning-text/25 bg-warning-bg px-4 py-3">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-warning-text">
                    Note
                  </div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-warning-text">
                    {salesOrder.note}
                  </p>
                </div>
              )}
            </Section>

            {/* Delivery address + Emergency contact */}
            <Section title="Delivery address">
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-[1.4fr_1fr] sm:divide-x sm:divide-border-subtle">
                <div className="sm:pr-6">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                    Ship to
                  </div>
                  <div className="mt-1.5 text-[14px] font-semibold leading-relaxed text-ink">
                    {[
                      salesOrder.address1,
                      salesOrder.address2,
                      [salesOrder.city, salesOrder.postcode]
                        .filter(Boolean)
                        .join(" "),
                      [salesOrder.customer_state, salesOrder.customer_country]
                        .filter(Boolean)
                        .join(", "),
                    ]
                      .filter(Boolean)
                      .map((line, i) => (
                        <div key={i}>{line}</div>
                      ))}
                    {!salesOrder.address1 && !salesOrder.city && (
                      <span className="text-ink-muted">Not provided</span>
                    )}
                  </div>
                  {salesOrder.sales_location && (
                    <div className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary-soft px-2.5 py-1 text-[11.5px] font-semibold text-primary-ink">
                      <Warehouse size={12} />
                      {salesOrder.sales_location}
                    </div>
                  )}
                </div>
                <div className="sm:pl-6">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                    Emergency contact
                  </div>
                  <div className="mt-1.5 text-[12.5px] text-ink-muted">
                    Only if unreachable on delivery day
                  </div>
                  <div className="mt-2.5 font-mono text-[14px] font-semibold text-ink">
                    {formatPhone(salesOrder.phone) || "Not provided"}
                  </div>
                  <div className="mt-1 text-[12px] text-ink-muted">
                    Contact — relationship not set
                  </div>
                </div>
              </div>
            </Section>

            {/* Line items */}
            <Section
              title={`Line items · ${items.length}`}
              actions={
                focCount > 0 ? (
                  <span className="text-[11.5px] text-ink-muted">
                    {focCount} FOC line{focCount === 1 ? "" : "s"} included
                  </span>
                ) : undefined
              }
            >
              <DataTable<SoItem>
                tableId={`so-lines-${docNo}`}
                layoutFamily={DATA_TABLE_LAYOUT_FAMILIES.salesOrderLines}
                rows={items}
                loading={false}
                columns={lineColumns}
                getRowKey={(l) => l.id}
                emptyLabel="No line items"
              />
            </Section>

            {/* Payments — the SAME PaymentsTable the editor renders (Task #105
                one-source rule), mounted here since 2026-08-09 so "Collect
                payment" no longer swaps the whole page for the legacy editor
                (owner: unify the SO surfaces). Adding/editing money follows the
                no-naked-edits rule via the card's own Edit toggle; `?payments=1`
                deep-links land with the toggle already open. */}
            {(() => {
              const soStatus = salesOrder.status?.toLowerCase() ?? "";
              const canOfferPayEdit = !["cancelled", "draft"].includes(soStatus);
              const canEditPayments = soStatus === "draft" || (soStatus !== "cancelled" && payEditing);
              return (
                <div ref={paymentsRef}>
                  <PaymentsTable
                    key={salesOrder.doc_no}
                    docNo={salesOrder.doc_no}
                    grandTotalSen={salesOrder.local_total_sen ?? 0}
                    currency={salesOrder.currency}
                    locked={!canEditPayments}
                    draftUnlocked={soStatus === "draft"}
                    slip={{ slipKey: salesOrder.slip_key ?? null, fetcher: fetchSoSlipUrl }}
                    initialDrafts={paymentRetryDrafts}
                    onDraftCommitted={paymentRetryCommitted}
                    onUnsavedChange={setUnsavedPayments}
                    headerAction={canOfferPayEdit ? (
                      <Button variant="secondary" onClick={() => setPayEditing((v) => !v)} icon={<Wallet size={14} />}>
                        {payEditing ? "Done" : "Collect payment"}
                      </Button>
                    ) : null}
                  />
                </div>
              );
            })()}
          </DetailMain>

          <DetailAside>
            {/* Aside is hidden on phone (Order total is a light card at the
                top of main; Key dates / People / Recent activity are omitted
                on mobile per the design). Reappears from md up. */}
            <div className="hidden lg:sticky lg:top-[124px] space-y-3 md:block">
              <OrderTotalCard
                header={salesOrder}
                subtotalSen={subtotalSen}
                discountSen={discountSen}
                totalSen={totalSen}
              />

              {/* Owner 2026-07-17: the Totals·Margin (Revenue/Cost/Margin) card
                  is removed from the SO document view for EVERYONE — costing
                  moves to the separate Finance "Fulfillment Costing" module.
                  The customer-facing OrderTotalCard above (Subtotal / Discount /
                  Total) stays; only cost/margin is gone. */}

              <AsideCard title="Key dates">
                <KeyDateRow k="SO date" v={fmtDate(salesOrder.so_date)} />
                <KeyDateRow
                  k="Processing"
                  v={fmtDate(salesOrder.processing_date)}
                  muted={!salesOrder.processing_date}
                />
                <KeyDateRow
                  k="Delivery"
                  v={
                    salesOrder.customer_delivery_date
                      ? fmtDate(salesOrder.customer_delivery_date)
                      : "Not set"
                  }
                  muted={!salesOrder.customer_delivery_date}
                />
              </AsideCard>

              <AsideCard title="People">
                <PersonRow
                  initials={
                    salesOrder.agent || salesOrder.salesperson_id
                      ? initialsOf(
                          salespersonNameOf(
                            salesOrder.agent,
                            salesOrder.salesperson_id,
                            ""
                          )
                        )
                      : "?"
                  }
                  name={salespersonNameOf(
                    salesOrder.agent,
                    salesOrder.salesperson_id,
                    "Salesperson"
                  )}
                  role={
                    salesOrder.agent || salesOrder.salesperson_id
                      ? "Salesperson"
                      : "Not yet assigned"
                  }
                  tone={
                    salesOrder.agent || salesOrder.salesperson_id
                      ? "accent"
                      : "neutral"
                  }
                />
                <PersonRow
                  initials={initialsOf(salesOrder.debtor_name)}
                  name={salesOrder.debtor_name || "—"}
                  role={`Customer${
                    refOf(salesOrder) !== "—"
                      ? ` · ${refOf(salesOrder)}`
                      : ""
                  }`}
                  tone="accent"
                />
              </AsideCard>

              {/* Owner 2026-08-13: "recent activity 加上时间".
                  It could not show one. All three rows read `so_date`, which is
                  a DATE column with no time in it — so every entry restated the
                  same day, and two of the three ("Lines added", the status row)
                  were guesses at events nobody had recorded here anyway.

                  The audit log has what the card was pretending to have: real
                  events, real actors, real timestamps. Same source as the
                  History drawer this header now opens, so the summary and the
                  full trail cannot tell different stories. The synthesized rows
                  remain as the fallback for an order with no audit entries yet
                  (pre-audit history, or the log still loading) — losing the
                  card entirely would be a worse answer than a dateless one. */}
              <AsideCard title="Recent activity">
                {auditEntries.length > 0 ? (
                  auditEntries.slice(0, 4).map((e, i, shown) => (
                    <ActivityRow
                      key={e.id}
                      title={SO_AUDIT_LABELS.actions[e.action] ?? e.action.replace(/_/g, " ")}
                      meta={`${fmtDateTime(e.created_at)}${
                        e.actor_name_snapshot ? ` · ${e.actor_name_snapshot}` : ""
                      }`}
                      dot={i === 0 ? "success" : i === shown.length - 1 ? "muted" : "primary"}
                      isLast={i === shown.length - 1}
                    />
                  ))
                ) : (
                  <>
                    <ActivityRow
                      title={`Order ${statusFor(salesOrder.status).label.toLowerCase()}`}
                      meta={fmtDate(salesOrder.so_date)}
                      dot={
                        statusFor(salesOrder.status).tone === "success"
                          ? "success"
                          : "primary"
                      }
                    />
                    <ActivityRow
                      title={`Lines added (${items.length})`}
                      meta={fmtDate(salesOrder.so_date)}
                      dot="primary"
                    />
                    <ActivityRow
                      title="Created"
                      meta={`${fmtDate(salesOrder.so_date)}${
                        salesOrder.customer_type
                          ? ` · ${salesOrder.customer_type}`
                          : ""
                      }`}
                      dot="muted"
                      isLast
                    />
                  </>
                )}
              </AsideCard>
            </div>
          </DetailAside>
        </DetailGrid>
      </div>

      {/* ─── Fixed bottom action bar (phone only) ───────────────────── */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 px-3 pb-6 pt-2.5 shadow-slab backdrop-blur-sm md:hidden">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={goEdit}
            disabled={editDisabled}
            title={hardLocked ? lockedEditHint : undefined}
            className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink disabled:opacity-40"
          >
            <Edit3 size={16} /> {editLabel}
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
            disabled={!salesOrder.phone}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-surface-2 text-primary-ink hover:bg-primary-soft disabled:opacity-40"
            aria-label={salesOrder.phone ? `Call ${salesOrder.phone}` : "No phone on file"}
          >
            <PhoneIcon size={17} />
          </button>
        </div>
      </div>

      {/* History drawer — the shared audit panel, same entries the Recent
          activity card summarises above. */}
      {historyOpen && (
        <AuditHistoryPanel
          recordLabel={salesOrder.doc_no}
          entityName="Sales order"
          entries={auditEntries}
          isLoading={auditQ.isLoading}
          labels={SO_AUDIT_LABELS}
          onClose={closeHistory}
        />
      )}

      {/* Relationship map modal — 5-node graph per Nick's 2026-07-08 handoff */}
      <DocumentRelationshipMapModal
        open={relMapOpen}
        onClose={() => setRelMapOpen(false)}
        nodes={chainNodes}
        onNodeClick={(n) => {
          // Close only when the click actually navigated away; an in-app notice
          // (Customer PO / a GRN we may not open) must render OVER the map, not
          // dismiss it.
          if (onChainNodeClick(n)) setRelMapOpen(false);
        }}
        amendments={chainAmendments}
        onAmendmentClick={(a) => {
          if (onChainAmendmentClick(a)) setRelMapOpen(false);
        }}
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
        docTitle="Sales Order"
        docNo={salesOrder.doc_no}
        rows={[
          { label: "Customer", value: salesOrder.debtor_name || "—" },
          { label: "Order date", value: fmtDate(salesOrder.so_date) },
          {
            label: "Items",
            value: `${items.length} line${items.length === 1 ? "" : "s"}`,
          },
          {
            label: "Order total",
            value: fmtMoney(salesOrder.local_total_sen, salesOrder.currency),
          },
          {
            label: "Balance",
            value: fmtMoney(salesOrder.balance_sen, salesOrder.currency),
          },
        ]}
        {...print.handlers}
      />
    </div>
  );
}

// ─── Small utility dot separator ──────────────────────────────────────────

function Divider() {
  return (
    <span className="inline-flex items-center text-border-strong">
      <CircleDot size={4} className="mx-0.5 opacity-40" />
    </span>
  );
}

export default SalesOrderDetailV2;
