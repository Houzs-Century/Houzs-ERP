// SalesInvoiceDetailV2 — Theme C ("Ink & Petrol") redesign of the Sales
// Invoice detail page. Money-forward twin of DeliveryOrderDetailV2 —
// same DetailLayout shell, but the SI is the point in the chain where
// money actually enters the ledger, so the entire chrome pivots around
// Outstanding vs Paid.
//
// Key departures from the DO detail template:
//   · Aside dark hero flips from Dispatch (driver + vehicle + date) back
//     to a MONEY hero — total + outstanding + paid, err-tinted when
//     outstanding > 0 and success-tinted when it's cleared. Outstanding
//     is the number finance reads first when opening an SI.
//   · Status flow = payment lifecycle (Sent → Partially paid → Paid /
//     Overdue, plus Cancelled). Mirrors SI listing V2.
//   · Header CTA by payment state. BOTH record money; neither writes a
//     status (the server derives it from the payments ledger):
//       Record payment — payable + balance > 0, opens an empty ledger row
//       Mark paid      — payable + balance > 0 + the order's deposit is
//                        readable; opens ONE row pre-filled at the balance
//                        (markPaidPlan.ts). Was `balance == 0` until
//                        2026-08-23, when it wrote a status and no payment.
//   · Line-items get the SO detail's 5-column layout back — Item · Qty ·
//     Unit price · Disc · Amount — with the FOC badge on zero-price
//     lines. An SI without money is a design bug, not a valid state.
//   · Origin doc is a DO (not an SO). Both are promoted into the sticky
//     header meta line: "From DO XYZ · From SO ABC".
//   · Invoice-specific dates (invoice_date + due_date) live in the Key
//     dates aside; due_date renders in err colour when overdue.
//
// The old ledger-style SalesInvoiceDetail.tsx stays; App.tsx flip on
// ScmSalesInvoiceDetailV2 is the whole switch. Data + mutations use the
// vendored sales-invoice-queries slice (useSalesInvoiceDetail /
// useUpdateSalesInvoiceStatus).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { scmListReturnTo } from "../../lib/scmListReturn";
import { siSettledSen, siOutstandingSen } from "../../vendor/scm/lib/si-outstanding";
import {
  ArrowLeft,
  History,
  Printer,
  Share2,
  XCircle,
  Edit3,
  Warehouse,
  CircleDot,
  Phone as PhoneIcon,
  MoreHorizontal,
  CheckCircle2,
  Wallet,
  AlertTriangle,
  Check,
  RotateCcw,
  FileText,
  Save,
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
  useSalesInvoiceDetail,
  useUpdateSalesInvoiceStatus,
  useUpdateSalesInvoiceHeader,
  useSalesInvoicePayments,
  useAddSalesInvoicePayment,
  useDeleteSalesInvoicePayment,
} from "../../vendor/scm/lib/sales-invoice-queries";
import { useSetBreadcrumbs } from "../../hooks/useBreadcrumbs";
import { useStaffLookup } from "../../hooks/useStaffLookup";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { DateField } from "../../vendor/scm/components/DateField";
import { useSiRelationshipMap } from "./sales-doc-relationship-map";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import {
  PaymentsTable,
  labelToApi,
  draftMethodFields,
  newPaymentDraft,
  type PaymentDraft,
} from "../../vendor/scm/components/PaymentsTable";
import {
  MARK_PAID_REFUSAL_MESSAGE,
  canOfferMarkPaid,
  planMarkPaid,
} from "./markPaidPlan";
import { useSiPaymentIntent } from "./siPaymentIntent";
import { useAuth } from "../../auth/AuthContext";
import {
  DocumentRelationshipMapModal,
  DocumentChoiceDialog,
} from "../../components/scm-v2/DocumentRelationshipMapModal";
import { PrintPreviewModal, useOpenPrintPreviewFromUrl, usePrintPreview } from "../../components/scm-v2/PrintPreviewModal";
import type { PdfAction } from "../../vendor/scm/lib/pdf-common";
import { cn } from "../../lib/utils";
import { buildVariantSummary, fmtDate, fmtMoneySen, orderLineIdentity } from "@2990s/shared";
import { formatPhone } from "@2990s/shared/phone";
import { clearPaymentRetryHandoff, completePaymentRetryDraft, consumePaymentRetryNavigationState, planPaymentDraftFlush, readPaymentRetryHandoff, readPaymentRetryNavigationState } from "../../lib/paymentRetryHandoff";
import { transferFromColumnLabel } from "../../lib/convertScope";

// ─── Row shapes (subset — see SalesInvoiceDetail.tsx for the full 40-field
// header) ───────────────────────────────────────────────────────────────

type SiStatus =
  | "DRAFT"
  | "SENT"
  | "PARTIALLY_PAID"
  | "PAID"
  | "OVERDUE"
  | "CANCELLED"
  | string;

type SiHeader = {
  id: string;
  invoice_number: string;
  so_doc_no: string | null;
  delivery_order_id: string | null;
  do_number?: string | null;
  status: SiStatus;
  invoice_date: string;
  due_date: string | null;
  customer_delivery_date: string | null;
  debtor_code: string | null;
  debtor_name: string;
  salesperson_id: string | null;
  agent: string | null;
  branding: string | null;
  venue: string | null;
  ref: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  sales_location: string | null;
  customer_state: string | null;
  customer_country: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  customer_type: string | null;
  building_type: string | null;
  phone: string | null;
  email: string | null;
  note: string | null;
  notes: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  local_total_sen: number;
  total_sen: number;
  paid_sen: number;
  line_count: number;
  currency: string;
  // Finance-gated cost / margin fields (served on the detail payload; shown only
  // to a project_finance_viewer — same rule as the SI list columns, #574).
  mattress_sofa_sen?: number;
  bedframe_sen?: number;
  accessories_sen?: number;
  others_sen?: number;
  service_sen?: number | null;
  mattress_sofa_cost_sen?: number;
  bedframe_cost_sen?: number;
  accessories_cost_sen?: number;
  others_cost_sen?: number;
  service_cost_sen?: number | null;
  total_cost_sen?: number;
  total_margin_sen?: number;
  margin_pct_basis?: number;
};

type SiItem = {
  id: string;
  item_code: string;
  description: string | null;
  description2: string | null;
  uom: string;
  qty: number;
  unit_price_sen: number;
  discount_sen: number;
  line_total_sen: number;
  unit_cost_sen?: number;
  cancelled?: boolean;
  item_group?: string;
  variants?: Record<string, unknown> | null;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/* ONE shared centi formatter (vendor/shared/format.ts) — the page-local copy
   this replaces had no finite guard, so an absent / non-numeric cost rendered
   the literal "MYR NaN"; the shared helper renders "—" instead. */
const fmtMoney = fmtMoneySen;

// Days between today and an ISO date; positive when the date is in the past.
// Only used for the due-date overdue check, so time-of-day noise is fine.
const daysPast = (iso: string | null | undefined): number => {
  if (!iso) return -1;
  const s = iso.replace(/T.*$/, "");
  const t = Date.parse(s);
  if (Number.isNaN(t)) return -1;
  const now = Date.now();
  return Math.floor((now - t) / 86_400_000);
};

const refOf = (h: SiHeader): string =>
  h.po_doc_no || h.customer_so_no || h.ref || "—";

const soOf = (h: SiHeader): string => h.so_doc_no || "—";

/* `do_number` is stamped on by the server (stampDoNumber) and is the field the
   SI LIST already reads. This page read `do_doc_no` — a DELIVERY-RETURN column
   that never existed here — and fell through to `delivery_order_id.slice(0,8)`,
   printing a uuid fragment where a document number belongs. A dash is the
   honest answer: it says we have nothing, not something false. docs/bugs/0526. */
const doOf = (h: SiHeader): string => h.do_number || "—";

const brandOf = (h: SiHeader): string => h.branding || "—";

// The header-carried total is the source of truth (server-stamped); line rows
// exist for display. If for any reason the header total is 0 while the lines
// aren't, fall back to the line sum so the drawer never lies.
const totalOf = (h: SiHeader, items: SiItem[]): number =>
  h.total_sen || h.local_total_sen || items.reduce((s, l) => s + (l.line_total_sen ?? 0), 0);

/* The deposit taken on the SALES ORDER this invoice came from, served beside
   paid_sen by GET /sales-invoices/:id (backend lib/si-order-deposit). It is NOT
   folded into paid_sen anywhere: the two are different money, banked against
   different documents, and the office reading this screen has to be able to see
   which document took it. */
type OrderDeposit = {
  so_doc_no: string;
  order_collected_sen: number;
  applied_sen: number;
  transactions: Array<{
    id: string;
    paid_at: string | null;
    method: string | null;
    amount_sen: number;
    account_sheet: string | null;
    note: string | null;
  }>;
};

/* Everything settling this invoice: its own receipts PLUS the slice of the
   order's deposit allocated to it. `depositSen` is a REQUIRED argument on both
   helpers below, not an optional one — its absence changes the answer, so an
   optional parameter would leave every caller that forgot it silently showing
   the old, wrong figure with no compile error (CLAUDE.md, optional-param-noop).

   The arithmetic itself is the SHARED rule (vendor/scm/lib/si-outstanding.ts),
   not a local copy: this page held the only deposit-aware formula in the app
   for one day, and the list, the cards, the mobile card and the customer's PDF
   all disagreed with it. `totalOf` stays local because only this screen has the
   line items to fall back on. */
/* ONE site reads the column, so the runtime guard on a hand-typed payload lives
   in one place instead of once per formula. */
const paidOf = (h: SiHeader): number => h.paid_sen ?? 0;

const settledOf = (h: SiHeader, depositSen: number): number =>
  siSettledSen(paidOf(h), depositSen);

const outstandingOf = (h: SiHeader, items: SiItem[], depositSen: number): number =>
  siOutstandingSen(totalOf(h, items), paidOf(h), depositSen);

// Payment-lifecycle bucket for tone + blurb.
type Effective = "draft" | "sent" | "partial" | "paid" | "overdue" | "cancelled";
/* The pill and the Outstanding figure are computed from the SAME `settledOf`,
   so they cannot disagree: an invoice covered by the order's deposit cannot
   read "Outstanding 0" beside a "Sent · awaiting payment" pill. */
const effectiveOf = (h: SiHeader, items: SiItem[], depositSen: number): Effective => {
  const s = (h.status || "").toUpperCase();
  if (s === "CANCELLED") return "cancelled";
  if (s === "PAID" || outstandingOf(h, items, depositSen) === 0) return "paid";
  if (s === "PARTIALLY_PAID" || settledOf(h, depositSen) > 0) return "partial";
  if (s === "OVERDUE") return "overdue";
  if (s === "DRAFT") return "draft";
  // Sent + anything else with no payment yet.
  const overdueDays = daysPast(h.due_date);
  if (overdueDays > 0 && outstandingOf(h, items, depositSen) > 0) return "overdue";
  return "sent";
};

const EFFECTIVE_TONE: Record<
  Effective,
  { tone: "success" | "warning" | "error" | "neutral"; label: string; blurb: string }
> = {
  draft: {
    tone: "warning",
    label: "Draft",
    blurb: "Draft · not yet sent",
  },
  sent: {
    tone: "warning",
    label: "Sent",
    blurb: "Sent · awaiting payment",
  },
  partial: {
    tone: "warning",
    label: "Partially paid",
    blurb: "Partially paid · balance outstanding",
  },
  paid: {
    tone: "success",
    label: "Paid",
    blurb: "Paid · loop closed",
  },
  overdue: {
    tone: "error",
    label: "Overdue",
    blurb: "Overdue · past due date",
  },
  cancelled: {
    tone: "error",
    label: "Cancelled",
    blurb: "Cancelled · no further action",
  },
};

// Raw-stage label so the header Badge still shows the exact stored status
// instead of the bucketed effective label.
const STAGE_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  SENT: "Sent",
  PARTIALLY_PAID: "Partially paid",
  PAID: "Paid",
  OVERDUE: "Overdue",
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

// ─── Field cell (identical to SO/DO detail V2) ─────────────────────────────

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

// ─── Aside sub-primitives ───────────────────────────────────────────────────

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

function KeyDateRow({
  k,
  v,
  muted,
  danger,
}: {
  k: string;
  v: string;
  muted?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border-subtle py-2 last:border-b-0">
      <span className="text-[12.5px] text-ink-muted">{k}</span>
      <span
        className={cn(
          "text-[13px] font-semibold",
          danger ? "text-err" : muted ? "text-ink-muted" : "text-ink"
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


// ─── Invoice total / outstanding hero (dark aside slab) ────────────────────
//
// SO detail's hero is Order total; DO detail's hero is Dispatch; SI detail's
// hero is Outstanding. Big number is what's still owed — a red beacon while
// non-zero, a green Paid stamp once cleared. Total + Paid render as sub-lines
// so the three canonical figures stay together.

function OutstandingHeroCard({
  header,
  items,
  orderDeposit,
}: {
  header: SiHeader;
  items: SiItem[];
  orderDeposit: OrderDeposit | null;
}) {
  const depositSen = orderDeposit?.applied_sen ?? 0;
  const eff = effectiveOf(header, items, depositSen);
  const t = EFFECTIVE_TONE[eff];
  const total = totalOf(header, items);
  const paid = header.paid_sen ?? 0;
  const outstanding = outstandingOf(header, items, depositSen);
  const isPaid = outstanding === 0;
  return (
    <div className="rounded-lg bg-sidebar px-5 py-5 text-sidebar-ink shadow-stone">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-sidebar-ink-muted">
        {isPaid ? "Paid in full" : "Outstanding"}
      </div>
      <div
        className={cn(
          "mt-1.5 font-money text-[28px] font-bold leading-none tracking-tight",
          isPaid ? "text-synced" : "text-err"
        )}
      >
        {fmtMoney(isPaid ? total : outstanding, header.currency)}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            t.tone === "success"
              ? "bg-synced"
              : t.tone === "warning"
                ? "bg-accent-bright"
                : t.tone === "error"
                  ? "bg-err"
                  : "bg-sidebar-ink-muted"
          )}
        />
        <span className="text-[12.5px] text-sidebar-ink-muted">{t.blurb}</span>
      </div>

      <div className="mt-4 space-y-2 border-t border-white/10 pt-4">
        <HeroLine k="Invoice total" v={fmtMoney(total, header.currency)} />
        <HeroLine
          k={depositSen > 0 ? "Paid on this invoice" : "Paid"}
          v={fmtMoney(paid, header.currency)}
          tone={paid > 0 ? "success" : "muted"}
        />
        {/* Named for the document that actually took the money — the office
            reads this line to know it does not have to chase it. */}
        {depositSen > 0 && (
          <HeroLine
            k={`Deposit on ${orderDeposit!.so_doc_no}`}
            v={fmtMoney(depositSen, header.currency)}
            tone="success"
          />
        )}
        <HeroLine
          k="Outstanding"
          v={fmtMoney(outstanding, header.currency)}
          tone={outstanding > 0 ? "err" : "success"}
          strong
        />
      </div>
    </div>
  );
}

function HeroLine({
  k,
  v,
  tone = "muted",
  strong,
}: {
  k: string;
  v: string;
  tone?: "muted" | "success" | "err";
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span
        className={cn(
          "text-[12.5px] text-sidebar-ink-muted",
          strong && "font-semibold text-white"
        )}
      >
        {k}
      </span>
      <span
        className={cn(
          "font-money text-[13px] font-semibold",
          tone === "success"
            ? "text-synced"
            : tone === "err"
              ? "text-err"
              : "text-sidebar-ink",
          strong && "text-[16px] font-bold"
        )}
      >
        {v}
      </span>
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────

export function SalesInvoiceDetailV2() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();

  const detail = useSalesInvoiceDetail(id ?? null);
  const updateStatus = useUpdateSalesInvoiceStatus();
  const { nameOf: salespersonNameOf } = useStaffLookup();
  const notify = useNotify();
  const askConfirm = useConfirm();
  const { pageAccess } = useAuth();
  // Mutation gate — a salesperson opens this invoice read-only via the sales
  // inherit hatch (allowSales; backend readInheritsFrom scm.sales.orders) and
  // cannot confirm/cancel/edit or record payments. Hide those controls (owner
  // off-not-hide rule); Print PDF + Relationship Map stay so the rep can still
  // find + send the invoice. `*` resolves to "full".
  const canWriteSi = ["edit", "full"].includes(pageAccess("scm.sales.invoices"));

  // ── Payments (shared DRAFT-mode PaymentsTable + manual flush) ──────────
  // Mirrors the vendored ledger SalesInvoiceDetail.tsx: the SAVED PaymentsTable
  // mode is hardwired to the SO payment endpoints, so an SI records payments via
  // DRAFT mode — persisted rows are mapped into PaymentDraft[] and adds/deletes
  // flush through the SI payment hooks on Save.
  const paymentsQ = useSalesInvoicePayments(id ?? null);
  const addPayment = useAddSalesInvoicePayment();
  const deletePayment = useDeleteSalesInvoicePayment();
  const [paymentDrafts, setPaymentDrafts] = useState<PaymentDraft[]>([]);
  const [editingPayments, setEditingPayments] = useState(false);
  const [savingPayments, setSavingPayments] = useState(false);
  const paymentsSectionRef = useRef<HTMLDivElement | null>(null);

  // ── Header-only edit (owner 2026-08-20) ──────────────────────────────────
  // An SI's LINES are read-only — they are what the Delivery Order actually
  // shipped (industry standard: an invoice's lines are locked to the delivery).
  // The "Edit" button used to navigate to a dead ?edit=1 that nothing consumed.
  // It now opens an inline HEADER editor: invoice date (only while DRAFT — the
  // backend freezes it once issued, SI_ISSUED_FROZEN_FIELDS), due date and notes.
  // Payments are edited in their own inline editor below; nothing here touches a
  // line or a variant.
  const updateHeader = useUpdateSalesInvoiceHeader();
  const [editingHeader, setEditingHeader] = useState(false);
  const [hdrInvoiceDate, setHdrInvoiceDate] = useState("");
  const [hdrDueDate, setHdrDueDate] = useState("");
  const [hdrNotes, setHdrNotes] = useState("");
  const headerSectionRef = useRef<HTMLDivElement | null>(null);

  const salesInvoice =
    (detail.data as { salesInvoice?: SiHeader } | undefined)?.salesInvoice ??
    null;
  const items: SiItem[] = useMemo(
    () =>
      ((detail.data as { items?: SiItem[] } | undefined)?.items ?? []).filter(
        (l) => !l.cancelled
      ),
    [detail.data]
  );
  /* The order's deposit, served alongside the invoice. `undefined` here is the
     server saying it could not read the order (orderDepositUnavailable) — NOT
     "there is no deposit", which is why the banner below exists: an invoice
     whose order we cannot see must not quietly claim the customer owes
     everything. That is the bug this whole screen change is about. */
  const orderDeposit =
    (detail.data as { orderDeposit?: OrderDeposit | null } | undefined)
      ?.orderDeposit ?? null;
  const orderDepositUnavailable = Boolean(
    (detail.data as { orderDepositUnavailable?: boolean } | undefined)
      ?.orderDepositUnavailable
  );
  const depositSen = orderDeposit?.applied_sen ?? 0;

  // Persisted SI payment row → the shared PaymentsTable draft shape.
  const apiToDraft = useCallback(
    (p: NonNullable<typeof paymentsQ.data>[number]): PaymentDraft => {
      /* `credit` and `installment` deliberately fall through to "Merchant" —
         owner 2026-08-13, asked directly. An audit flagged it as a mislabel and
         I changed it; the owner reverted the call. Left as a note so the next
         reader does not re-open it. */
      const methodLabel =
        p.method === "cash" ? "Cash" : p.method === "transfer" ? "Online" : "Merchant";
      const installmentLabel =
        p.installment_months && p.installment_months > 0
          ? `${p.installment_months} months`
          : "";
      return {
        uid: p.id,
        paidAt: p.paid_at,
        methodLabel,
        merchantProvider: p.merchant_provider ?? "",
        installmentMonthsLabel: installmentLabel,
        onlineType: p.online_type ?? "",
        amountSen: p.amount_sen,
        accountSheet: p.account_sheet ?? "",
        approvalCode: p.approval_code ?? "",
        collectedBy: p.collected_by ?? "",
        // SI payments carry no per-payment slip (Spec D4 is SO-only).
        slipUploadSessionId: null,
      };
    },
    []
  );
  const persistedDrafts = useMemo(
    () => (paymentsQ.data ?? []).map(apiToDraft),
    [paymentsQ.data, apiToDraft]
  );
  const [paymentRetryDrafts, setPaymentRetryDrafts] = useState<PaymentDraft[]>([]);
  const paymentRetrySeededFor = useRef<string | null>(null);
  const paymentEditBaselineIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!id || !paymentsQ.isSuccess) return;
    if (paymentRetrySeededFor.current === id) return;
    paymentRetrySeededFor.current = id;
    const stored = readPaymentRetryHandoff("si", id)?.drafts ?? [];
    const navigated = readPaymentRetryNavigationState(location.state, "si", id);
    const retry = [...new Map([...stored, ...navigated].map((draft) => [draft.idempotencyKey, draft])).values()];
    paymentEditBaselineIds.current = new Set(persistedDrafts.map((draft) => draft.uid));
    setPaymentRetryDrafts(retry);
    setPaymentDrafts([]);
    setEditingPayments(false);
    if (location.state && typeof location.state === "object" && "paymentRetry" in location.state) {
      navigate(
        { pathname: location.pathname, search: location.search, hash: location.hash },
        { replace: true, state: consumePaymentRetryNavigationState(location.state) },
      );
    }
    if (retry.length === 0) return;
    setPaymentDrafts([...persistedDrafts, ...retry]);
    setEditingPayments(true);
  }, [id, location.hash, location.pathname, location.search, location.state, navigate, paymentsQ.isSuccess, persistedDrafts]);

  useSetBreadcrumbs([
    { label: "Sales Invoices", to: "/scm/sales-invoices" },
    { label: salesInvoice?.invoice_number ?? id ?? "Sales Invoice" },
  ]);

  const eff = salesInvoice ? effectiveOf(salesInvoice, items, depositSen) : null;
  const stageLabel = salesInvoice
    ? STAGE_LABEL[(salesInvoice.status || "").toUpperCase()] ??
      salesInvoice.status
    : "";
  const badgeTone = eff ? EFFECTIVE_TONE[eff].tone : "neutral";

  const foldedNote = useMemo(
    () => salesInvoice?.note || salesInvoice?.notes || null,
    [salesInvoice?.note, salesInvoice?.notes]
  );

  const total = salesInvoice ? totalOf(salesInvoice, items) : 0;
  const outstanding = salesInvoice ? outstandingOf(salesInvoice, items, depositSen) : 0;
  const paid = salesInvoice?.paid_sen ?? 0;

  const overdueDays = salesInvoice ? daysPast(salesInvoice.due_date) : -1;
  const isOverdue = overdueDays > 0 && outstanding > 0;

  // Back always returns to the Sales Invoices list (owner 2026-07-24: every
  // details page's back button goes to its relevant list, not wherever
  // browser history happens to point). The list restores its own sticky
  // filters, so the prior filtered view comes back — no context lost.
  const goBack = () => navigate(scmListReturnTo("/scm/sales-invoices"));
  // Header-only edit — seed the drafts from the invoice and reveal the inline
  // editor (no navigation; ?edit=1 was dead). invoice_date is only editable
  // while DRAFT; the backend rejects it once issued.
  const siIsDraft = (salesInvoice?.status || "").toUpperCase() === "DRAFT";
  const startEditHeader = () => {
    if (!salesInvoice) return;
    setHdrInvoiceDate(salesInvoice.invoice_date.slice(0, 10));
    setHdrDueDate((salesInvoice.due_date ?? "").slice(0, 10));
    setHdrNotes(salesInvoice.note ?? salesInvoice.notes ?? "");
    setEditingHeader(true);
    setTimeout(() => headerSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
  };
  const cancelEditHeader = () => setEditingHeader(false);
  const saveEditHeader = () => {
    if (!id || !salesInvoice) return;
    const body: Record<string, unknown> = {
      dueDate: hdrDueDate || null,
      notes: hdrNotes,
    };
    // Only send invoice date when it may change (DRAFT) — the backend freezes it
    // once issued and rejects the whole PATCH if a frozen field is present.
    if (siIsDraft) body.invoiceDate = hdrInvoiceDate || null;
    updateHeader.mutate(
      { id, ...body },
      {
        onSuccess: () => {
          setEditingHeader(false);
          void notify({ title: "Invoice updated", tone: "info" });
        },
        onError: (err) =>
          notify({ title: "Update failed", body: err instanceof Error ? err.message : "Something went wrong.", tone: "error" }),
      },
    );
  };
  // Status transitions post to the same server endpoint the ledger page uses.
  // The endpoint keys off UPPERCASE status values (SENT / CANCELLED / PAID) — a
  // lowercase value silently misroutes (e.g. cancel would write "cancelled" and
  // skip the revenue reversal), so all four transitions send UPPERCASE.
  const doCancel = async () => {
    if (!salesInvoice) return;
    if (
      await askConfirm({
        title: `Cancel invoice ${salesInvoice.invoice_number}?`,
        body: "This reverses any posted revenue via a contra JE. You can reopen it later.",
        confirmLabel: "Cancel invoice",
        danger: true,
      })
    ) {
      updateStatus.mutate({ id: salesInvoice.id, status: "CANCELLED" });
    }
  };
  // Confirm a DRAFT SI → SENT. The server posts the AR/GL revenue JE
  // (Dr AR / Cr Sales) and auto-applies any customer credit ONCE on this
  // transition; both were skipped on draft create. Mirrors the SO/DO Confirm.
  const doConfirm = async () => {
    if (!salesInvoice) return;
    if (
      await askConfirm({
        title: `Confirm ${salesInvoice.invoice_number}?`,
        body: "This issues the invoice — it records revenue (Dr AR / Cr Sales) and applies any customer credit, then lets you record payments. You can still cancel it afterwards.",
        confirmLabel: "Confirm Invoice",
      })
    ) {
      updateStatus.mutate({ id: salesInvoice.id, status: "SENT" });
    }
  };
  // Reopen a CANCELLED SI → SENT. The server re-posts revenue and reverses the
  // cancel-credit; payment status is re-derived from the ledger.
  const doReopen = async () => {
    if (!salesInvoice) return;
    if (
      await askConfirm({
        title: `Reopen ${salesInvoice.invoice_number}?`,
        body: "Reopens the cancelled invoice back to Sent and re-posts revenue. Payment status is re-derived from the ledger.",
        confirmLabel: "Reopen invoice",
      })
    ) {
      updateStatus.mutate({ id: salesInvoice.id, status: "SENT" });
    }
  };
  const [relMapOpen, setRelMapOpen] = useState(false);
  const goHistory = () => id && navigate(`/scm/sales-invoices/${id}?tab=history`);
  const goRelationshipMap = () => setRelMapOpen(true);
  // Render + download the SI PDF via the shared jspdf generator (client-side),
  // mirroring the V1 SalesInvoiceDetail handler. The old `?print=1` navigation
  // was dead — nothing consumed that param — so the button did nothing.
  const deliverPrintPdf = (action: PdfAction) => {
    if (!salesInvoice) return;
    return import("../../vendor/scm/lib/sales-invoice-pdf")
      .then(({ generateSalesInvoicePdf }) =>
        generateSalesInvoicePdf(salesInvoice as never, items as never, { action })
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
  useOpenPrintPreviewFromUrl(print.openPreview, !!salesInvoice);

  // Chain nodes for the shared Relationship Map modal, read from the LIVE
  // `/document-flow` graph (the SO map's source) instead of a hand-built chain.
  // The 5-node shape's downstream slot is now the AR Payments the graph carries
  // off this invoice — the old chain dropped them for a dead "no GRN" tile
  // (audit R8). Upstream SO / DO nodes reflect the real family documents.
  const relMapHeader = useMemo(
    () =>
      salesInvoice
        ? {
            id: salesInvoice.id,
            invoice_number: salesInvoice.invoice_number,
            so_doc_no: salesInvoice.so_doc_no,
            customer_so_no: salesInvoice.customer_so_no,
            po_doc_no: salesInvoice.po_doc_no,
          }
        : null,
    [salesInvoice],
  );
  const {
    nodes: chainNodes,
    onNodeClick: onChainNodeClick,
    choice: chainChoice,
    closeChoice: closeChainChoice,
    pickChoice: pickChainChoice,
  } = useSiRelationshipMap(relMapHeader);

  // Open the in-place payments editor (seeded from persisted rows) and scroll it
  // into view. Replaces the old dead `?tab=payments&record=1` navigation —
  // nothing consumed that param, so the button did nothing.
  const goRecordPayment = () => {
    paymentEditBaselineIds.current = new Set(persistedDrafts.map((draft) => draft.uid));
    setPaymentDrafts([...persistedDrafts, ...paymentRetryDrafts]);
    setEditingPayments(true);
    requestAnimationFrame(() =>
      paymentsSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      })
    );
  };
  const startEditPayments = () => {
    paymentEditBaselineIds.current = new Set(persistedDrafts.map((draft) => draft.uid));
    setPaymentDrafts([...persistedDrafts, ...paymentRetryDrafts]);
    setEditingPayments(true);
  };
  const cancelEditPayments = () => {
    paymentEditBaselineIds.current = new Set();
    setEditingPayments(false);
    setPaymentDrafts([]);
  };
  // Flush the draft ledger against the persisted rows: delete removed rows, POST
  // new ones. Existing (unchanged) rows keep their persisted uid and are skipped
  // — parity with the vendored ledger SalesInvoiceDetail (no in-place edit of a
  // persisted SI payment; add / delete only).
  const flushPaymentDrafts = async () => {
    if (!salesInvoice) return;
    /* `paymentsQ.data ?? []` here was a money bug, not a cosmetic one. This
       flush decides what to POST by DIFFERENCE against what is already stored.
       If the payments read failed, `data` is undefined, so `persisted` became
       empty, `persistedIds` became empty, and every draft — including rows that
       are already in the ledger — was re-POSTed: duplicate payment rows against
       a real invoice. An empty array means "no payments"; undefined means "we do
       not know", and you must not diff against a set you never read. */
    const persisted = paymentsQ.data;
    if (!Array.isArray(persisted)) {
      throw new Error(
        "We couldn't check which payments are already saved, so nothing was changed. Please refresh and try again.",
      );
    }
    const plan = planPaymentDraftFlush(
      paymentEditBaselineIds.current,
      persisted.map((payment) => payment.id),
      paymentDrafts,
    );
    for (const paymentId of plan.deleteIds) {
      await deletePayment.mutateAsync({ id: salesInvoice.id, paymentId });
    }
    for (const d of plan.draftsToPost) {
      if (d.amountSen <= 0) continue;
      const { method } = labelToApi(d.methodLabel);
      const body: { id: string } & Record<string, unknown> = {
        id: salesInvoice.id,
        paidAt: d.paidAt,
        method,
        amountSen: d.amountSen,
        accountSheet: d.accountSheet || null,
        approvalCode: d.approvalCode || null,
        collectedBy: d.collectedBy || null,
        // Per-draft key (lib/idempotency.ts). This flush posts rows one by one
        // and aborts on the first throw, so a re-press of Save re-posts the ones
        // that already landed — the key replays them instead of duplicating.
        idempotencyKey: d.idempotencyKey,
      };
      Object.assign(body, draftMethodFields(method, d));
      await addPayment.mutateAsync(body);
      if (d.idempotencyKey && paymentRetryDrafts.some((retry) => retry.idempotencyKey === d.idempotencyKey)) {
        completePaymentRetryDraft("si", salesInvoice.id, d.idempotencyKey);
        setPaymentRetryDrafts((current) =>
          current.filter((retry) => retry.idempotencyKey !== d.idempotencyKey),
        );
      }
    }
  };
  const saveEditPayments = () => {
    setSavingPayments(true);
    flushPaymentDrafts()
      .then(() => {
        if (salesInvoice) clearPaymentRetryHandoff("si", salesInvoice.id);
        setPaymentRetryDrafts([]);
        setEditingPayments(false);
      })
      .catch((e) =>
        notify({
          title: "Failed to save payments",
          body: e instanceof Error ? e.message : "Something went wrong.",
          tone: "error",
        })
      )
      .finally(() => setSavingPayments(false));
  };
  /* Mark paid RECORDS THE MONEY and writes NO status; markPaidPlan.ts holds the
     trace and the four refusals. It stops at the editor rather than committing
     because the METHOD is the operator's — a guessed `cash` lands in the daily
     cash-up and leaves the drawer short. */
  const doMarkPaid = () => {
    if (!salesInvoice) return;
    const plan = planMarkPaid({
      status: salesInvoice.status,
      outstandingSen: outstanding,
      depositUnavailable: orderDepositUnavailable,
    });
    if (!plan.ok) {
      // Fire-and-forget: the dialog's own OK button closes it (NotifyDialog).
      void notify({
        title: "Nothing to record",
        body: MARK_PAID_REFUSAL_MESSAGE[plan.reason],
        tone: "error",
      });
      return;
    }
    paymentEditBaselineIds.current = new Set(persistedDrafts.map((draft) => draft.uid));
    setPaymentDrafts([
      ...persistedDrafts,
      ...paymentRetryDrafts,
      { ...newPaymentDraft(), amountSen: plan.amountSen },
    ]);
    setEditingPayments(true);
    requestAnimationFrame(() =>
      paymentsSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      })
    );
  };

  /* The LIST's two payment entries land here (siPaymentIntent.ts). They delegate
     because a receipt's amount must be decided where `orderDepositUnavailable`
     is known: a list row cannot tell "the order collected nothing" from "we
     could not read the order", and the second books the deposit twice. */
  useSiPaymentIntent({
    invoiceId: id ?? null,
    ready: paymentsQ.isSuccess,
    onOpen: goRecordPayment,
    onBalance: doMarkPaid,
  });

  // ── SI line item columns — money-forward, 5 cols like SO detail ────────
  const lineColumns: Column<SiItem>[] = [
    {
      key: "item",
      label: "Item",
      alwaysVisible: true,
      getValue: (l) => l.item_code,
      /* Item CODE first, then the variant subtitle; description dropped (owner 2026-07-24) — the shared order-line rule
         (vendor/shared/line-identity.ts). Converged onto the helper from this
         page's own #647 copy: same behaviour, but the rule now comes from the
         one module instead of a per-page comment that the next sibling would
         have to remember to copy. The code still BINDS via getValue above. */
      render: (l) => {
        const { primary, secondary } = orderLineIdentity({
          code: l.item_code,
          description: l.description,
          variant: buildVariantSummary(l.item_group ?? "others", l.variants) || (l.description2 ?? ""),
        });
        return (
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-ink">{primary}</div>
            {secondary && (
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-muted">
                <span className="truncate text-ink-secondary">{secondary}</span>
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
          {fmtMoney(l.unit_price_sen, salesInvoice?.currency)}
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
        const isFoc =
          l.unit_price_sen === 0 && (l.line_total_sen ?? 0) === 0;
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
              {fmtMoney(l.discount_sen, salesInvoice?.currency)}
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
      getValue: (l) => l.line_total_sen,
      render: (l) => (
        <span className="font-money text-[13px] font-semibold text-ink">
          {fmtMoney(l.line_total_sen ?? 0, salesInvoice?.currency)}
        </span>
      ),
    },
  ];

  // ── Loading / error states ───────────────────────────────────────────
  if (!id) {
    return (
      <div className="p-8 text-center text-ink-muted">
        No sales invoice specified.
      </div>
    );
  }
  if (detail.isPending) {
    return (
      <div className="animate-fade-in p-8 text-center text-ink-muted">
        Loading sales invoice…
      </div>
    );
  }
  if (detail.error || !salesInvoice) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div className="mb-2 font-display text-[18px] font-extrabold text-err">
          Couldn't load sales invoice
        </div>
        <p className="text-[13px] text-ink-muted">
          {(detail.error as Error | undefined)?.message ??
            "The invoice was not found."}
        </p>
        <div className="mt-4">
          <Button variant="secondary" onClick={goBack} icon={<ArrowLeft size={14} />}>
            Back to Sales Invoices
          </Button>
        </div>
      </div>
    );
  }

  const goCall = () => {
    if (!salesInvoice?.phone) return;
    window.location.href = `tel:${salesInvoice.phone.replace(/\s+/g, "")}`;
  };

  const rawStatus = (salesInvoice.status || "").toUpperCase();
  const isCancelled = rawStatus === "CANCELLED";
  const isDraft = rawStatus === "DRAFT";
  const isTerminal = isCancelled || rawStatus === "PAID";
  // A DRAFT SI is not payable (the server 409s any payment) until Confirm issues
  // it — so payment actions are hidden until it leaves DRAFT.
  const canRecordPayment = !isTerminal && !isDraft && outstanding > 0;
  /* WAS `outstanding === 0` — offered ONLY where there was no money to record,
     which is why it could not have been recording any. Same rule `doMarkPaid`
     re-checks on click, so a stale screen refuses rather than books. */
  const canMarkPaid = canOfferMarkPaid({
    status: salesInvoice.status,
    outstandingSen: outstanding,
    depositUnavailable: orderDepositUnavailable,
  });

  return (
    <div className="pb-24 md:pb-0">
      {/* ─── Mobile-only dark sticky header ─────────────────────────── */}
      <div className="sticky top-0 z-20 -mx-4 -mt-4 bg-sidebar text-sidebar-ink shadow-slab md:hidden">
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center gap-1 text-[14px] font-semibold text-accent-bright"
            aria-label="Back to Sales Invoices"
          >
            <ArrowLeft size={16} /> SIs
          </button>
          <span className="font-mono text-[12.5px] font-semibold text-sidebar-ink">
            {salesInvoice.invoice_number}
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
            {salesInvoice.debtor_name || "—"}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone={badgeTone} variant="solid" size="xs">
              {stageLabel}
            </Badge>
            {isOverdue && (
              <span className="inline-flex items-center gap-1 rounded-md bg-err/20 px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wider text-err">
                <AlertTriangle size={10} /> {overdueDays}d overdue
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ─── Desktop sticky header ─────────────────────────────────── */}
      <div className="sticky top-0 z-10 -mx-4 hidden border-b border-border bg-bg/95 px-4 py-4 backdrop-blur-sm sm:-mx-6 sm:px-6 md:block">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <button
              type="button"
              onClick={goBack}
              aria-label="Back to Sales Invoices"
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary hover:border-primary/50 hover:text-primary"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
                  {salesInvoice.debtor_name || "—"}
                </h1>
                <Badge tone={badgeTone} size="sm">
                  {stageLabel}
                </Badge>
                {isOverdue && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-err-soft px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-err">
                    <AlertTriangle size={11} /> {overdueDays}d overdue
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-secondary">
                <span className="font-mono font-semibold text-primary-ink">
                  {salesInvoice.invoice_number}
                </span>
                <Divider />
                <span>Invoiced {fmtDate(salesInvoice.invoice_date)}</span>
                <Divider />
                <span
                  className={cn(
                    isOverdue && "font-semibold text-err"
                  )}
                >
                  Due {fmtDate(salesInvoice.due_date)}
                </span>
                <Divider />
                <span>{items.length} line{items.length === 1 ? "" : "s"}</span>
                {doOf(salesInvoice) !== "—" && (
                  <>
                    <Divider />
                    <span>
                      {transferFromColumnLabel('do')}{" "}
                      <span className="font-mono font-semibold text-ink-secondary">
                        {doOf(salesInvoice)}
                      </span>
                    </span>
                  </>
                )}
                {soOf(salesInvoice) !== "—" && (
                  <>
                    <Divider />
                    <span>
                      {transferFromColumnLabel('so')}{" "}
                      <span className="font-mono font-semibold text-ink-secondary">
                        {soOf(salesInvoice)}
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
              onClick={goHistory}
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
            {isDraft && canWriteSi && (
              <Button
                variant="primary"
                icon={<Check size={14} />}
                onClick={doConfirm}
                disabled={updateStatus.isPending}
              >
                Confirm Invoice
              </Button>
            )}
            {isCancelled && canWriteSi && (
              <Button
                variant="secondary"
                icon={<RotateCcw size={14} />}
                onClick={doReopen}
                disabled={updateStatus.isPending}
              >
                Reopen
              </Button>
            )}
            {!isCancelled && canWriteSi && (
              <Button
                variant="danger"
                icon={<XCircle size={14} />}
                onClick={doCancel}
              >
                Cancel SI
              </Button>
            )}
            {canRecordPayment && canWriteSi && (
              <Button
                variant="secondary"
                icon={<Wallet size={14} />}
                onClick={goRecordPayment}
              >
                Record payment
              </Button>
            )}
            {canMarkPaid && canWriteSi && (
              <Button
                variant="secondary"
                icon={<CheckCircle2 size={14} />}
                onClick={doMarkPaid}
              >
                Mark paid
              </Button>
            )}
            {canWriteSi && (
              <Button
                variant="primary"
                icon={<Edit3 size={14} />}
                onClick={startEditHeader}
              >
                Edit
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* ─── Detail body ────────────────────────────────────────────── */}
      <div className="py-5">
        {/* Header-only edit panel (owner 2026-08-20). Lines stay read-only — an
            invoice's lines are what the DO shipped. Only invoice date (DRAFT
            only), due date and notes are editable here. */}
        {editingHeader && (
          <div ref={headerSectionRef} className="mb-4 rounded-lg border border-border bg-surface p-4 shadow-stone">
            <div className="mb-3 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
              Edit invoice header
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1">
                <span className="text-[12px] text-ink-muted">
                  Invoice date{!siIsDraft && <span className="italic"> (locked once issued)</span>}
                </span>
                <DateField
                  fullWidth
                  value={hdrInvoiceDate}
                  disabled={!siIsDraft}
                  onChange={(iso) => setHdrInvoiceDate(iso)}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[12px] text-ink-muted">Due date</span>
                <DateField fullWidth value={hdrDueDate} onChange={(iso) => setHdrDueDate(iso)} />
              </label>
              <label className="flex flex-col gap-1 sm:col-span-3">
                <span className="text-[12px] text-ink-muted">Notes</span>
                <textarea
                  value={hdrNotes}
                  rows={2}
                  onChange={(e) => setHdrNotes(e.target.value)}
                  className="rounded-md border border-border bg-canvas px-2 py-1.5 text-[13px]"
                />
              </label>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button variant="primary" icon={<Save size={14} />} onClick={saveEditHeader} disabled={updateHeader.isPending}>
                {updateHeader.isPending ? "Saving…" : "Save"}
              </Button>
              <Button variant="ghost" onClick={cancelEditHeader} disabled={updateHeader.isPending}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {/* Mobile-only Outstanding hero — sits at the top of the scroll body.
            On md+ the dark aside hero replaces this. */}
        <div className="mb-3 rounded-lg border border-border bg-surface p-4 shadow-stone md:hidden">
          <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
            {outstanding === 0 ? "Paid in full" : "Outstanding"}
          </div>
          <div
            className={cn(
              "mt-1 font-money text-[26px] font-bold leading-none tracking-tight",
              outstanding === 0 ? "text-synced" : "text-err"
            )}
          >
            {fmtMoney(
              outstanding === 0 ? total : outstanding,
              salesInvoice.currency
            )}
          </div>
          <div className="mt-1.5 text-[12px] text-ink-muted">
            Total {fmtMoney(total, salesInvoice.currency)} · Paid{" "}
            {fmtMoney(paid, salesInvoice.currency)}
          </div>
        </div>

        {/* Draft banner — a DRAFT SI has posted no revenue / AR and can't take a
            payment yet. Confirm issues it (posts revenue + applies credit). */}
        {isDraft && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning-text/30 bg-warning-bg px-4 py-3">
            <div className="flex items-start gap-2 text-warning-text">
              <FileText size={15} className="mt-0.5 shrink-0" />
              <p className="text-[13px] leading-relaxed">
                <span className="font-bold">Draft — not yet confirmed.</span> No
                revenue has been recorded and it can't take a payment yet. Confirm
                to issue the invoice (posts revenue / AR and applies customer
                credit), then record payments.
              </p>
            </div>
            <Button
              variant="primary"
              icon={<Check size={14} />}
              onClick={doConfirm}
              disabled={updateStatus.isPending}
            >
              Confirm Invoice
            </Button>
          </div>
        )}
        <DetailGrid>
          <DetailMain>
            {/* Customer */}
            <Section title="Customer">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-3">
                <Field
                  label="Customer name"
                  value={salesInvoice.debtor_name || "—"}
                />
                <Field
                  label="Phone"
                  value={formatPhone(salesInvoice.phone) || "Not provided"}
                  muted={!salesInvoice.phone}
                  mono={!!salesInvoice.phone}
                />
                <Field
                  label="Email"
                  value={salesInvoice.email || "Not provided"}
                  muted={!salesInvoice.email}
                />
                <Field
                  label={transferFromColumnLabel('do')}
                  value={doOf(salesInvoice)}
                  mono={doOf(salesInvoice) !== "—"}
                  muted={doOf(salesInvoice) === "—"}
                />
                <Field
                  label={transferFromColumnLabel('so')}
                  value={soOf(salesInvoice)}
                  mono={soOf(salesInvoice) !== "—"}
                  muted={soOf(salesInvoice) === "—"}
                />
                <Field
                  label="Customer ref"
                  value={refOf(salesInvoice)}
                  mono={refOf(salesInvoice) !== "—"}
                  muted={refOf(salesInvoice) === "—"}
                />
              </div>
            </Section>

            {/* Invoice info — the SI's editorial primary section. */}
            <Section title="Invoice info">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-4">
                <Field
                  label="Invoice date"
                  value={fmtDate(salesInvoice.invoice_date)}
                />
                <Field
                  label="Due date"
                  value={
                    salesInvoice.due_date ? (
                      <span className={cn(isOverdue && "text-err")}>
                        {fmtDate(salesInvoice.due_date)}
                        {isOverdue && (
                          <span className="ml-2 text-[11px] font-bold uppercase tracking-wider">
                            +{overdueDays}d
                          </span>
                        )}
                      </span>
                    ) : (
                      "Not set"
                    )
                  }
                  muted={!salesInvoice.due_date}
                />
                <Field
                  label="Delivery Date"
                  value={
                    salesInvoice.customer_delivery_date
                      ? fmtDate(salesInvoice.customer_delivery_date)
                      : "—"
                  }
                  muted={!salesInvoice.customer_delivery_date}
                />
                <Field
                  label="Branding"
                  value={brandOf(salesInvoice)}
                  muted={brandOf(salesInvoice) === "—"}
                />
                <Field
                  label="Venue"
                  value={salesInvoice.venue || "—"}
                  muted={!salesInvoice.venue}
                />
                <Field
                  label="Salesperson"
                  value={salespersonNameOf(
                    salesInvoice.agent,
                    salesInvoice.salesperson_id,
                    "Unassigned"
                  )}
                  muted={
                    !salesInvoice.agent && !salesInvoice.salesperson_id
                  }
                />
                <Field
                  label="Customer type"
                  value={salesInvoice.customer_type || "—"}
                  muted={!salesInvoice.customer_type}
                />
                <Field
                  label="Building type"
                  value={salesInvoice.building_type || "—"}
                  muted={!salesInvoice.building_type}
                />
              </div>

              {foldedNote && (
                <div className="mt-4 rounded-lg border border-warning-text/25 bg-warning-bg px-4 py-3">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-warning-text">
                    Note
                  </div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-warning-text">
                    {foldedNote}
                  </p>
                </div>
              )}
            </Section>

            {/* Delivery address + Emergency contact — identical layout to DO
                detail V2 (the DO's fields carry through to the SI on convert). */}
            <Section title="Delivery address">
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-[1.4fr_1fr] sm:divide-x sm:divide-border-subtle">
                <div className="sm:pr-6">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                    Ship to
                  </div>
                  <div className="mt-1.5 text-[14px] font-semibold leading-relaxed text-ink">
                    {[
                      salesInvoice.address1,
                      salesInvoice.address2,
                      [salesInvoice.city, salesInvoice.postcode]
                        .filter(Boolean)
                        .join(" "),
                      [salesInvoice.customer_state, salesInvoice.customer_country]
                        .filter(Boolean)
                        .join(", "),
                    ]
                      .filter(Boolean)
                      .map((line, i) => (
                        <div key={i}>{line}</div>
                      ))}
                    {!salesInvoice.address1 && !salesInvoice.city && (
                      <span className="text-ink-muted">Not provided</span>
                    )}
                  </div>
                  {salesInvoice.sales_location && (
                    <div className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary-soft px-2.5 py-1 text-[11.5px] font-semibold text-primary-ink">
                      <Warehouse size={12} />
                      {salesInvoice.sales_location}
                    </div>
                  )}
                </div>
                <div className="sm:pl-6">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                    Emergency contact
                  </div>
                  <div className="mt-1.5 text-[12.5px] text-ink-muted">
                    Copied from the origin DO
                  </div>
                  <div className="mt-2.5 text-[14px] font-semibold text-ink">
                    {salesInvoice.emergency_contact_name || "Not provided"}
                  </div>
                  <div className="mt-1 font-mono text-[12.5px] text-ink-secondary">
                    {formatPhone(salesInvoice.emergency_contact_phone) || "—"}
                  </div>
                  {salesInvoice.emergency_contact_relationship && (
                    <div className="mt-1 text-[12px] text-ink-muted">
                      {salesInvoice.emergency_contact_relationship}
                    </div>
                  )}
                </div>
              </div>
            </Section>

            {/* Line items — money-forward, 5 cols. FOC badge on zero-price. */}
            <Section title={`Line items · ${items.length}`}>
              <DataTable<SiItem>
                tableId={`si-lines-${id}`}
                layoutFamily={DATA_TABLE_LAYOUT_FAMILIES.salesInvoiceLines}
                rows={items}
                loading={false}
                columns={lineColumns}
                getRowKey={(l) => l.id}
                emptyLabel="No line items"
              />
            </Section>

            {/* Owner 2026-07-17: Totals·Margin (Revenue/Cost/Margin/Margin%)
                card removed from the SI document view for EVERYONE — costing
                moves to the separate Finance "Fulfillment Costing" module. The
                customer-facing invoice totals are untouched. */}

            {/* Payments — shared ledger. DRAFT-mode PaymentsTable seeded from the
                persisted rows; adds / deletes flush on Save. A DRAFT SI isn't
                payable until Confirm; a cancelled SI shows its ledger read-only. */}
            <div ref={paymentsSectionRef}>
              {paymentRetryDrafts.length > 0 && (
                <div className="mb-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-ink" role="status">
                  This invoice exists, but {paymentRetryDrafts.length} payment row{paymentRetryDrafts.length === 1 ? "" : "s"} were not confirmed saved.
                  The editor includes a temporary retry copy; Save payments to confirm it on the server.
                </div>
              )}
              <Section
                title="Payments"
                actions={
                  canWriteSi && !isDraft && !isCancelled ? (
                    editingPayments ? (
                      <>
                        <Button
                          variant="ghost"
                          onClick={cancelEditPayments}
                          disabled={savingPayments}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="primary"
                          icon={<Save size={14} />}
                          onClick={saveEditPayments}
                          disabled={savingPayments}
                        >
                          {savingPayments ? "Saving…" : "Save payments"}
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="secondary"
                        icon={<Wallet size={14} />}
                        onClick={startEditPayments}
                      >
                        Manage payments
                      </Button>
                    )
                  ) : undefined
                }
              >
                {isDraft ? (
                  <p className="px-1 py-2 text-[13px] text-ink-muted">
                    Confirm the invoice before recording payments — a draft has
                    posted no revenue yet.
                  </p>
                ) : (
                  <PaymentsTable
                    docNo={null}
                    payments={editingPayments ? paymentDrafts : persistedDrafts}
                    onChange={setPaymentDrafts}
                    grandTotalSen={total}
                    currency={salesInvoice.currency}
                    locked={!editingPayments || isCancelled}
                    receiptFor={{ source: "SIPAY", persistedIds: new Set(persistedDrafts.map((d) => d.uid)) }}
                  />
                )}
              </Section>
            </div>

            {/* Collected on the ORDER — deliberately its own section rather than
                extra rows in the table above. These receipts were banked against
                the Sales Order, not this invoice, and merging the two lists would
                lose exactly the fact the office needs: which document took the
                money. Read-only here; it is edited on the order. */}
            {orderDepositUnavailable && (
              <div className="mt-4 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-ink" role="status">
                We could not read the sales order behind this invoice, so any
                deposit taken on the order is not counted in the figures above.
                The outstanding amount shown may be too high. Please refresh.
              </div>
            )}
            {orderDeposit && (
              <Section title={`Collected on ${orderDeposit.so_doc_no}`}>
                <p className="px-1 pb-2 text-[12.5px] text-ink-muted">
                  Taken on the sales order, not on this invoice.{" "}
                  <span className="font-semibold text-ink">
                    {fmtMoney(orderDeposit.applied_sen, salesInvoice.currency)}
                  </span>{" "}
                  of it settles this invoice
                  {orderDeposit.order_collected_sen > orderDeposit.applied_sen && (
                    <>
                      {" "}
                      — the remaining{" "}
                      {fmtMoney(
                        orderDeposit.order_collected_sen - orderDeposit.applied_sen,
                        salesInvoice.currency
                      )}{" "}
                      goes to the order&apos;s other invoices, earliest first
                    </>
                  )}
                  .
                </p>
                <div className="divide-y divide-border">
                  {orderDeposit.transactions.map((t) => (
                    <div key={t.id} className="flex items-center justify-between gap-3 px-1 py-2 text-[13px]">
                      <span className="text-ink-muted">
                        {fmtDate(t.paid_at)}
                        {t.method ? ` · ${t.method}` : ""}
                        {t.account_sheet ? ` · ${t.account_sheet}` : ""}
                      </span>
                      <span className="font-money font-semibold text-ink">
                        {fmtMoney(t.amount_sen, salesInvoice.currency)}
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </DetailMain>

          <DetailAside>
            <div className="hidden lg:sticky lg:top-[124px] space-y-3 md:block">
              <OutstandingHeroCard header={salesInvoice} items={items} orderDeposit={orderDeposit} />

              <AsideCard title="Key dates">
                <KeyDateRow
                  k="Invoice"
                  v={fmtDate(salesInvoice.invoice_date)}
                />
                <KeyDateRow
                  k="Due"
                  v={fmtDate(salesInvoice.due_date)}
                  muted={!salesInvoice.due_date}
                  danger={isOverdue}
                />
                <KeyDateRow
                  k="Delivery"
                  v={
                    salesInvoice.customer_delivery_date
                      ? fmtDate(salesInvoice.customer_delivery_date)
                      : "Not set"
                  }
                  muted={!salesInvoice.customer_delivery_date}
                />
              </AsideCard>

              <AsideCard title="People">
                <PersonRow
                  initials={
                    salesInvoice.agent || salesInvoice.salesperson_id
                      ? initialsOf(
                          salespersonNameOf(
                            salesInvoice.agent,
                            salesInvoice.salesperson_id,
                            ""
                          )
                        )
                      : "?"
                  }
                  name={salespersonNameOf(
                    salesInvoice.agent,
                    salesInvoice.salesperson_id,
                    "Salesperson"
                  )}
                  role={
                    salesInvoice.agent || salesInvoice.salesperson_id
                      ? "Salesperson"
                      : "Not yet assigned"
                  }
                  tone={
                    salesInvoice.agent || salesInvoice.salesperson_id
                      ? "accent"
                      : "neutral"
                  }
                />
                <PersonRow
                  initials={initialsOf(salesInvoice.debtor_name)}
                  name={salesInvoice.debtor_name || "—"}
                  role={`Customer${
                    doOf(salesInvoice) !== "—"
                      ? ` · DO ${doOf(salesInvoice)}`
                      : soOf(salesInvoice) !== "—"
                        ? ` · SO ${soOf(salesInvoice)}`
                        : ""
                  }`}
                  tone="accent"
                />
              </AsideCard>

              <AsideCard title="Recent activity">
                <ActivityRow
                  title={`Invoice ${
                    EFFECTIVE_TONE[effectiveOf(salesInvoice, items, depositSen)].label.toLowerCase()
                  }`}
                  meta={fmtDate(salesInvoice.invoice_date)}
                  dot={
                    EFFECTIVE_TONE[effectiveOf(salesInvoice, items, depositSen)].tone ===
                    "success"
                      ? "success"
                      : "primary"
                  }
                />
                {paid > 0 && (
                  <ActivityRow
                    title={`Payment received (${fmtMoney(paid, salesInvoice.currency)})`}
                    meta={fmtDate(salesInvoice.invoice_date)}
                    dot="success"
                  />
                )}
                <ActivityRow
                  title="Created"
                  meta={`${fmtDate(salesInvoice.invoice_date)}${
                    salesInvoice.sales_location
                      ? ` · ${salesInvoice.sales_location}`
                      : ""
                  }`}
                  dot="muted"
                  isLast
                />
              </AsideCard>
            </div>
          </DetailAside>
        </DetailGrid>
      </div>

      {/* ─── Fixed bottom action bar (phone only) ───────────────────── */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 px-3 pb-6 pt-2.5 shadow-slab backdrop-blur-sm md:hidden">
        <div className="flex items-center gap-2">
          {canWriteSi &&
            (canRecordPayment ? (
              <button
                type="button"
                onClick={goRecordPayment}
                className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink"
              >
                <Wallet size={16} /> Record payment
              </button>
            ) : (
              <button
                type="button"
                onClick={startEditHeader}
                className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink"
              >
                <Edit3 size={16} /> Edit
              </button>
            ))}
          <button
            type="button"
            onClick={print.openPreview}
            className={cn(
              "inline-flex h-11 items-center justify-center gap-1.5 rounded-lg bg-surface-2 text-primary-ink hover:bg-primary-soft",
              canWriteSi ? "w-11" : "flex-1 text-[13.5px] font-bold"
            )}
            aria-label="Print PDF"
          >
            <Printer size={17} />
            {!canWriteSi && <span>Print PDF</span>}
          </button>
          <button
            type="button"
            onClick={goCall}
            disabled={!salesInvoice.phone}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-surface-2 text-primary-ink hover:bg-primary-soft disabled:opacity-40"
            aria-label={
              salesInvoice.phone
                ? `Call ${salesInvoice.phone}`
                : "No phone on file"
            }
          >
            <PhoneIcon size={17} />
          </button>
        </div>
      </div>

      {/* Relationship map modal — shared 5-node graph, live `/document-flow` */}
      <DocumentRelationshipMapModal
        open={relMapOpen}
        onClose={() => setRelMapOpen(false)}
        nodes={chainNodes}
        onNodeClick={(n) => {
          // TRUE = the click navigated away, so close the map; a notice keeps it
          // open (renders over the map).
          if (onChainNodeClick(n)) setRelMapOpen(false);
        }}
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
        docTitle="Sales Invoice"
        docNo={salesInvoice.invoice_number}
        rows={[
          { label: "Bill to", value: salesInvoice.debtor_name || "—" },
          { label: "Invoice date", value: fmtDate(salesInvoice.invoice_date) },
          {
            label: "Items",
            value: `${items.length} line${items.length === 1 ? "" : "s"}`,
          },
          {
            label: "Invoice total",
            value: fmtMoney(totalOf(salesInvoice, items), salesInvoice.currency),
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

// ─── Totals · Margin card — REMOVED (owner 2026-07-17) ─────────────────────
// The Revenue / Cost / Margin / Margin% section (and its per-category cost
// breakdown) is gone from the SI document view for EVERYONE; costing moves to
// the separate Finance "Fulfillment Costing" module. Customer-facing invoice
// totals are untouched.

export default SalesInvoiceDetailV2;
