// DeliveryReturnDetailV2 — Theme C ("Ink & Petrol") redesign of the
// Delivery Return detail page, the third + final piece of the sales-chain
// detail sweep (SO/DO/SI/DR). Same DetailLayout shell as DO/SI detail V2
// but pivoted around a return-specific reality: money moves OUT of the
// biz (refund) and goods move BACK into stock.
//
// Key departures from the SI detail template (which itself pivoted the
// DO template around money):
//   · Aside dark hero swings from Outstanding to REFUND. A DR is a
//     money-out doc; the number to lead with is what the biz owes back
//     to the customer. Err-tinted while pending, synced (green) once
//     refunded. Line cost + margin ride as sub-lines so ops can see
//     the loss the return baked in.
//   · Reason gets a red-rail hero banner right below the customer
//     name — same shape as the listing drawer. Reason is what triage
//     reads first on any DR, so it can't hide inside a Note field.
//   · Line-items table adds a Condition column (RETURN-specific field
//     not on SO/DO/SI) rendered as a warning Badge next to the qty.
//     Warehouse code shows below the item code so ops can see which
//     branch the return will restock into.
//   · Status flow is the DR lifecycle: Pending/Received → Inspected
//     → Refunded / Credit noted, plus Rejected / Cancelled. Mirrors
//     DR listing V2.
//   · Header CTA:
//       Mark inspected — Pending/Received → INSPECTED
//       Mark refunded  — Inspected → REFUNDED
//   · Origin doc is a DO (returns come from delivered goods). Promoted
//     into the sticky header meta + the People card.
//   · No payments ledger (a return doesn't collect money — it pays
//     money out via a refund JE done on Mark refunded).
//
// The old ledger-style DeliveryReturnDetail.tsx stays; App.tsx flip on
// ScmDeliveryReturnDetailV2 is the whole switch. Data + mutations use
// the vendored delivery-return-queries slice.

import { useMemo, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { scmListReturnTo } from "../../lib/scmListReturn";
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
  ClipboardCheck,
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
  useDeliveryReturnDetail,
  useUpdateDeliveryReturnStatus,
} from "../../vendor/scm/lib/delivery-return-queries";
import { useSetBreadcrumbs } from "../../hooks/useBreadcrumbs";
import { useStaffLookup } from "../../hooks/useStaffLookup";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { useDrRelationshipMap } from "./sales-doc-relationship-map";
import {
  DocumentRelationshipMapModal,
  DocumentChoiceDialog,
} from "../../components/scm-v2/DocumentRelationshipMapModal";
import { PrintPreviewModal, useOpenPrintPreviewFromUrl, usePrintPreview } from "../../components/scm-v2/PrintPreviewModal";
import type { PdfAction } from "../../vendor/scm/lib/pdf-common";
import { cn } from "../../lib/utils";
import { buildVariantSummary, fmtDate, fmtMoneySen, orderLineIdentity } from "@2990s/shared";
import { formatPhone } from "@2990s/shared/phone";
import { transferFromColumnLabel } from "../../lib/convertScope";

// ─── Row shapes (subset — see DeliveryReturnDetail.tsx for full 40-field
// header) ────────────────────────────────────────────────────────────────

type DrStatus =
  | "PENDING"
  | "RECEIVED"
  | "INSPECTED"
  | "REFUNDED"
  | "CREDIT_NOTED"
  | "REJECTED"
  | "CANCELLED"
  | string;

type DrHeader = {
  id: string;
  return_number: string;
  do_doc_no: string | null;
  delivery_order_id: string | null;
  status: DrStatus;
  return_date: string;
  reason: string | null;
  debtor_code: string | null;
  debtor_name: string;
  salesperson_id: string | null;
  agent: string | null;
  branding: string | null;
  venue: string | null;
  ref: string | null;
  customer_so_no: string | null;
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
  total_cost_sen: number;
  total_margin_sen: number;
  line_count: number;
  currency: string;
  // Finance-gated cost / margin analytics (migration 0079). Present on the
  // DETAIL payload for every caller (only the LIST endpoint strips these —
  // #574); the UI gates cost/margin behind project_finance_viewer. DR has NO
  // service bucket (see DR_FINANCE_KEYS server-side). Cost columns are
  // nullable for rows predating the cost backfill.
  margin_pct_basis?: number | null;
  mattress_sofa_sen?: number | null;
  bedframe_sen?: number | null;
  accessories_sen?: number | null;
  others_sen?: number | null;
  mattress_sofa_cost_sen?: number | null;
  bedframe_cost_sen?: number | null;
  accessories_cost_sen?: number | null;
  others_cost_sen?: number | null;
};

type DrItem = {
  id: string;
  item_code: string;
  description: string | null;
  description2: string | null;
  uom: string;
  qty_returned: number;
  condition: string | null;
  unit_price_sen: number;
  discount_sen: number;
  line_total_sen: number;
  cancelled?: boolean;
  item_group?: string;
  variants?: Record<string, unknown> | null;
  warehouse_code?: string | null;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/* ONE shared centi formatter (vendor/shared/format.ts) — the page-local copy
   this replaces had no finite guard, so an absent / non-numeric cost rendered
   the literal "MYR NaN"; the shared helper renders "—" instead. */
const fmtMoney = fmtMoneySen;

// Ref chain matches the DR list V2 — customer SO no > free-text ref.
const refOf = (h: DrHeader): string =>
  h.customer_so_no || h.ref || "—";

const doOf = (h: DrHeader): string => {
  if (h.do_doc_no) return h.do_doc_no;
  if (h.delivery_order_id) return h.delivery_order_id.slice(0, 8);
  return "—";
};

const brandOf = (h: DrHeader): string => h.branding || "—";

const refundOf = (h: DrHeader, items: DrItem[]): number =>
  h.local_total_sen || items.reduce((s, l) => s + (l.line_total_sen ?? 0), 0);

// DR effective lifecycle:
//   open      = PENDING + RECEIVED  (goods back, refund still owed)
//   inspected = INSPECTED           (QC done, awaiting refund action)
//   refunded  = REFUNDED + CREDIT_NOTED (loop closed happily)
//   cancelled = REJECTED + CANCELLED (loop closed unhappily)
type Effective = "open" | "inspected" | "refunded" | "cancelled";
const effectiveOf = (h: DrHeader): Effective => {
  const s = (h.status || "").toUpperCase();
  if (s === "REFUNDED" || s === "CREDIT_NOTED") return "refunded";
  if (s === "REJECTED" || s === "CANCELLED") return "cancelled";
  if (s === "INSPECTED") return "inspected";
  return "open";
};

const EFFECTIVE_TONE: Record<
  Effective,
  { tone: "success" | "warning" | "error" | "neutral"; label: string; blurb: string }
> = {
  open: {
    tone: "warning",
    label: "Awaiting inspection",
    blurb: "Goods back · awaiting QC",
  },
  inspected: {
    tone: "warning",
    label: "Ready to refund",
    blurb: "Inspected · awaiting refund",
  },
  refunded: {
    tone: "success",
    label: "Refunded",
    blurb: "Loop closed · money returned",
  },
  cancelled: {
    tone: "error",
    label: "Closed",
    blurb: "Closed · no further action",
  },
};

// Fine-grained stage label — keeps the exact stored status readable in
// the header Badge even when the effective bucket collapses it.
const STAGE_LABEL: Record<string, string> = {
  PENDING: "Pending",
  RECEIVED: "Received",
  INSPECTED: "Inspected",
  REFUNDED: "Refunded",
  CREDIT_NOTED: "Credit noted",
  REJECTED: "Rejected",
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

// ─── Field cell (identical to SO/DO/SI detail V2) ───────────────────────

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

// ─── Totals · Margin card — REMOVED (owner 2026-07-17) ─────────────────────
// The Returned value / Cost / Margin / Margin% aside card is gone from the DR
// document view for EVERYONE; costing moves to the separate Finance
// "Fulfillment Costing" module. The customer-facing Refund figure is untouched.

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

// ─── Refund hero (dark aside slab) ─────────────────────────────────────────
//
// SO detail = Order total, DO detail = Dispatch, SI detail = Outstanding.
// The DR detail hero is REFUND — the money the biz owes back. Big red
// while pending, big green stamp once actually refunded. (Owner 2026-07-17:
// the Line cost / Margin hit sub-lines were removed for EVERYONE — costing
// moves to the separate Finance "Fulfillment Costing" module.)

function RefundHeroCard({
  header,
  items,
}: {
  header: DrHeader;
  items: DrItem[];
}) {
  const eff = effectiveOf(header);
  const t = EFFECTIVE_TONE[eff];
  const refund = refundOf(header, items);
  const isRefunded = eff === "refunded";
  return (
    <div className="rounded-lg bg-sidebar px-5 py-5 text-sidebar-ink shadow-stone">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-sidebar-ink-muted">
        {isRefunded ? "Refunded" : "Refund pending"}
      </div>
      <div
        className={cn(
          "mt-1.5 font-money text-[28px] font-bold leading-none tracking-tight",
          isRefunded ? "text-synced" : "text-err"
        )}
      >
        {fmtMoney(refund, header.currency)}
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
        <HeroLine k="Refund" v={fmtMoney(refund, header.currency)} strong />
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

export function DeliveryReturnDetailV2() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const detail = useDeliveryReturnDetail(id ?? null);
  const updateStatus = useUpdateDeliveryReturnStatus();
  const { nameOf: salespersonNameOf } = useStaffLookup();
  const notify = useNotify();
  const askConfirm = useConfirm();

  const deliveryReturn =
    (detail.data as { deliveryReturn?: DrHeader } | undefined)?.deliveryReturn ??
    null;
  const items: DrItem[] = useMemo(
    () =>
      ((detail.data as { items?: DrItem[] } | undefined)?.items ?? []).filter(
        (l) => !l.cancelled
      ),
    [detail.data]
  );

  useSetBreadcrumbs([
    { label: "Delivery Returns", to: "/scm/delivery-returns" },
    { label: deliveryReturn?.return_number ?? id ?? "Delivery Return" },
  ]);

  const eff = deliveryReturn ? effectiveOf(deliveryReturn) : null;
  const stageLabel = deliveryReturn
    ? STAGE_LABEL[(deliveryReturn.status || "").toUpperCase()] ??
      deliveryReturn.status
    : "";
  const badgeTone = eff ? EFFECTIVE_TONE[eff].tone : "neutral";

  const foldedNote = useMemo(
    () => deliveryReturn?.note || deliveryReturn?.notes || null,
    [deliveryReturn?.note, deliveryReturn?.notes]
  );

  const refund = deliveryReturn ? refundOf(deliveryReturn, items) : 0;

  // Back always returns to the Delivery Returns list (owner 2026-07-24: every
  // details page's back button goes to its relevant list, not wherever
  // browser history happens to point). The list restores its own sticky
  // filters, so the prior filtered view comes back — no context lost.
  const goBack = () => navigate(scmListReturnTo("/scm/delivery-returns"));
  const goEdit = () => id && navigate(`/scm/delivery-returns/${id}?edit=1`);
  const doCancel = async () => {
    if (!deliveryReturn) return;
    if (await askConfirm({
      title: `Cancel return ${deliveryReturn.return_number}?`,
      body: "The stock added on create will be reversed via a negative ADJUSTMENT.",
      confirmLabel: "Cancel return",
      danger: true,
    })) {
      updateStatus.mutate({ id: deliveryReturn.id, status: "CANCELLED" });
    }
  };
  const [relMapOpen, setRelMapOpen] = useState(false);
  const goHistory = () => id && navigate(`/scm/delivery-returns/${id}?tab=history`);
  const goRelationshipMap = () => setRelMapOpen(true);
  // Render + download the DR PDF via the shared jspdf generator (client-side),
  // mirroring the V1 DeliveryReturnDetail handler (which maps the header + items
  // into the generator's shape). The old `?print=1` navigation was dead —
  // nothing consumed that param — so the button did nothing.
  const deliverPrintPdf = (action: PdfAction) => {
    if (!deliveryReturn) return;
    return import("../../vendor/scm/lib/delivery-return-pdf")
      .then(({ generateDeliveryReturnPdf }) =>
        generateDeliveryReturnPdf(
          {
            return_number: deliveryReturn.return_number,
            status: deliveryReturn.status,
            return_date: deliveryReturn.return_date,
            debtor_code: deliveryReturn.debtor_code,
            debtor_name: deliveryReturn.debtor_name,
            reason: deliveryReturn.reason,
            refund_sen: deliveryReturn.local_total_sen,
            notes: deliveryReturn.note ?? deliveryReturn.notes,
            delivery_order_id: deliveryReturn.delivery_order_id,
            sales_invoice_id: null,
            /* Feed the DO-clone address block (migration 0102) into the PDF's
               unified BILL TO — the fields have always been on the DR record
               but the printout ignored them, so a DR left the building with
               no customer address on it (owner UI audit Item #9). */
            address1: deliveryReturn.address1,
            address2: deliveryReturn.address2,
            city: deliveryReturn.city,
            state: deliveryReturn.customer_state,
            postcode: deliveryReturn.postcode,
            phone: deliveryReturn.phone,
            email: deliveryReturn.email,
          },
          items.map((it) => ({
            item_code: it.item_code,
            description: it.description,
            qty_returned: it.qty_returned,
            condition: it.condition,
            unit_price_sen: it.unit_price_sen,
            refund_sen: it.line_total_sen,
          })),
          { action }
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
  useOpenPrintPreviewFromUrl(print.openPreview, !!deliveryReturn);

  // Chain nodes for the shared Relationship Map modal, read from the LIVE
  // `/document-flow` graph (the SO map's source) instead of a hand-built chain.
  // The old chain hard-coded "Upstream of DO" / "Upstream doc" for the Sales
  // Order + Sales Invoice — neither showed the real number nor was clickable.
  // The graph resolves them off this return's DO (audit R8).
  const relMapHeader = useMemo(
    () =>
      deliveryReturn
        ? {
            id: deliveryReturn.id,
            return_number: deliveryReturn.return_number,
            do_doc_no: deliveryReturn.do_doc_no,
            customer_so_no: deliveryReturn.customer_so_no,
          }
        : null,
    [deliveryReturn],
  );
  const {
    nodes: chainNodes,
    onNodeClick: onChainNodeClick,
    choice: chainChoice,
    closeChoice: closeChainChoice,
    pickChoice: pickChainChoice,
  } = useDrRelationshipMap(relMapHeader);

  const doMarkInspected = () => {
    if (!deliveryReturn) return;
    updateStatus.mutate({ id: deliveryReturn.id, status: "INSPECTED" });
  };
  const doMarkRefunded = () => {
    if (!deliveryReturn) return;
    updateStatus.mutate({ id: deliveryReturn.id, status: "REFUNDED" });
  };

  // ── DR line item columns — item · condition (DR-specific) · qty · refund
  const lineColumns: Column<DrItem>[] = [
    {
      key: "item",
      label: "Item",
      alwaysVisible: true,
      getValue: (l) => l.item_code,
      /* Item CODE first, then the variant subtitle; description dropped (owner 2026-07-24) — the shared order-line rule
         (vendor/shared/line-identity.ts). Converged onto the helper from this
         page's own #647 copy: same behaviour, one source. The variant and the
         warehouse pill stay — this row shows them nowhere else — and their row
         is kept when only the pill is present. The code still BINDS via
         getValue above. */
      render: (l) => {
        const { primary, secondary } = orderLineIdentity({
          code: l.item_code,
          description: l.description,
          variant: buildVariantSummary(l.item_group ?? "others", l.variants) || (l.description2 ?? ""),
        });
        return (
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-ink">
            {primary}
          </div>
          {(secondary || l.warehouse_code) && (
            <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-ink-muted">
              {secondary && (
                <span className="truncate text-ink-secondary">
                  {secondary}
                </span>
              )}
              {l.warehouse_code && (
                <span className="inline-flex items-center gap-0.5 rounded bg-primary-soft px-1.5 py-0 text-[10px] font-semibold text-primary-ink">
                  <Warehouse size={9} />
                  {l.warehouse_code}
                </span>
              )}
            </div>
          )}
        </div>
        );
      },
    },
    {
      key: "condition",
      label: "Condition",
      width: "108px",
      getValue: (l) => l.condition ?? "",
      render: (l) =>
        l.condition ? (
          <Badge tone="warning" size="xs">
            {l.condition}
          </Badge>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: "qty",
      label: "Qty",
      width: "72px",
      align: "right",
      getValue: (l) => l.qty_returned,
      render: (l) => (
        <span className="font-money text-[13px] text-ink-secondary">
          {l.qty_returned}{" "}
          <span className="text-[10.5px] text-ink-muted">{l.uom}</span>
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
          {fmtMoney(l.unit_price_sen, deliveryReturn?.currency)}
        </span>
      ),
    },
    {
      key: "total",
      label: "Refund",
      width: "132px",
      align: "right",
      getValue: (l) => l.line_total_sen,
      render: (l) => (
        <span className="font-money text-[13px] font-semibold text-err">
          {fmtMoney(l.line_total_sen ?? 0, deliveryReturn?.currency)}
        </span>
      ),
    },
  ];

  // ── Loading / error states ───────────────────────────────────────────
  if (!id) {
    return (
      <div className="p-8 text-center text-ink-muted">
        No delivery return specified.
      </div>
    );
  }
  if (detail.isPending) {
    return (
      <div className="animate-fade-in p-8 text-center text-ink-muted">
        Loading delivery return…
      </div>
    );
  }
  if (detail.error || !deliveryReturn) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div className="mb-2 font-display text-[18px] font-extrabold text-err">
          Couldn't load delivery return
        </div>
        <p className="text-[13px] text-ink-muted">
          {(detail.error as Error | undefined)?.message ??
            "The return was not found."}
        </p>
        <div className="mt-4">
          <Button variant="secondary" onClick={goBack} icon={<ArrowLeft size={14} />}>
            Back to Delivery Returns
          </Button>
        </div>
      </div>
    );
  }

  const goCall = () => {
    if (!deliveryReturn?.phone) return;
    window.location.href = `tel:${deliveryReturn.phone.replace(/\s+/g, "")}`;
  };

  const rawStatus = (deliveryReturn.status || "").toUpperCase();
  const isCancelled = rawStatus === "CANCELLED" || rawStatus === "REJECTED";
  const isTerminal =
    isCancelled || rawStatus === "REFUNDED" || rawStatus === "CREDIT_NOTED";
  const canInspect =
    rawStatus === "PENDING" || rawStatus === "RECEIVED";
  const canRefund = rawStatus === "INSPECTED";

  return (
    <div className="pb-24 md:pb-0">
      {/* ─── Mobile-only dark sticky header ─────────────────────────── */}
      <div className="sticky top-0 z-20 -mx-4 -mt-4 bg-sidebar text-sidebar-ink shadow-slab md:hidden">
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center gap-1 text-[14px] font-semibold text-accent-bright"
            aria-label="Back to Delivery Returns"
          >
            <ArrowLeft size={16} /> Returns
          </button>
          <span className="font-mono text-[12.5px] font-semibold text-sidebar-ink">
            {deliveryReturn.return_number}
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
            {deliveryReturn.debtor_name || "—"}
          </h1>
          <div className="mt-2">
            <Badge tone={badgeTone} variant="solid" size="xs">
              {stageLabel}
            </Badge>
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
              aria-label="Back to Delivery Returns"
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary hover:border-primary/50 hover:text-primary"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
                  {deliveryReturn.debtor_name || "—"}
                </h1>
                <Badge tone={badgeTone} size="sm">
                  {stageLabel}
                </Badge>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-secondary">
                <span className="font-mono font-semibold text-primary-ink">
                  {deliveryReturn.return_number}
                </span>
                <Divider />
                <span>Returned {fmtDate(deliveryReturn.return_date)}</span>
                <Divider />
                <span>{items.length} line{items.length === 1 ? "" : "s"}</span>
                {doOf(deliveryReturn) !== "—" && (
                  <>
                    <Divider />
                    <span>
                      {transferFromColumnLabel('do')}{" "}
                      <span className="font-mono font-semibold text-ink-secondary">
                        {doOf(deliveryReturn)}
                      </span>
                    </span>
                  </>
                )}
                {refOf(deliveryReturn) !== "—" && (
                  <>
                    <Divider />
                    <span>
                      Ref{" "}
                      <span className="font-mono font-semibold text-ink-secondary">
                        {refOf(deliveryReturn)}
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
            {!isCancelled && !isTerminal && (
              <Button
                variant="danger"
                icon={<XCircle size={14} />}
                onClick={doCancel}
              >
                Cancel return
              </Button>
            )}
            {canInspect && (
              <Button
                variant="secondary"
                icon={<ClipboardCheck size={14} />}
                onClick={doMarkInspected}
              >
                Mark inspected
              </Button>
            )}
            {canRefund && (
              <Button
                variant="secondary"
                icon={<CheckCircle2 size={14} />}
                onClick={doMarkRefunded}
              >
                Mark refunded
              </Button>
            )}
            <Button
              variant="primary"
              icon={<Edit3 size={14} />}
              onClick={goEdit}
            >
              Edit
            </Button>
          </div>
        </div>
      </div>

      {/* ─── Detail body ────────────────────────────────────────────── */}
      <div className="py-5">
        {/* Mobile-only Refund hero — sits at the top of the scroll body. */}
        <div className="mb-3 rounded-lg border border-border bg-surface p-4 shadow-stone md:hidden">
          <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
            {effectiveOf(deliveryReturn) === "refunded" ? "Refunded" : "Refund pending"}
          </div>
          <div
            className={cn(
              "mt-1 font-money text-[26px] font-bold leading-none tracking-tight",
              effectiveOf(deliveryReturn) === "refunded" ? "text-synced" : "text-err"
            )}
          >
            {fmtMoney(refund, deliveryReturn.currency)}
          </div>
          <div className="mt-1.5 text-[12px] text-ink-muted">
            {items.length} line{items.length === 1 ? "" : "s"} · {EFFECTIVE_TONE[effectiveOf(deliveryReturn)].blurb}
          </div>
        </div>

        <DetailGrid>
          <DetailMain>
            {/* Reason — DR's most distinctive field. Red-rail banner up top so
                triage doesn't have to scan for it. Same shape as the listing
                drawer + the SI overdue banner. */}
            {deliveryReturn.reason && (
              <div className="mb-4 rounded-lg border-l-4 border-err bg-err-soft px-4 py-3">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  Return reason
                </div>
                <div className="mt-1 text-[14px] font-semibold italic text-ink">
                  “{deliveryReturn.reason}”
                </div>
              </div>
            )}

            {/* Customer */}
            <Section title="Customer">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-3">
                <Field
                  label="Customer name"
                  value={deliveryReturn.debtor_name || "—"}
                />
                <Field
                  label="Phone"
                  value={formatPhone(deliveryReturn.phone) || "Not provided"}
                  muted={!deliveryReturn.phone}
                  mono={!!deliveryReturn.phone}
                />
                <Field
                  label="Email"
                  value={deliveryReturn.email || "Not provided"}
                  muted={!deliveryReturn.email}
                />
                <Field
                  label={transferFromColumnLabel('do')}
                  value={doOf(deliveryReturn)}
                  mono={doOf(deliveryReturn) !== "—"}
                  muted={doOf(deliveryReturn) === "—"}
                />
                <Field
                  label="Customer ref"
                  value={refOf(deliveryReturn)}
                  mono={refOf(deliveryReturn) !== "—"}
                  muted={refOf(deliveryReturn) === "—"}
                />
                <Field
                  label="Customer type"
                  value={deliveryReturn.customer_type || "—"}
                  muted={!deliveryReturn.customer_type}
                />
              </div>
            </Section>

            {/* Return info — DR's editorial primary section. */}
            <Section title="Return info">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-4">
                <Field
                  label="Return date"
                  value={fmtDate(deliveryReturn.return_date)}
                />
                <Field
                  label="Salesperson"
                  value={salespersonNameOf(
                    deliveryReturn.agent,
                    deliveryReturn.salesperson_id,
                    "Unassigned"
                  )}
                  muted={
                    !deliveryReturn.agent && !deliveryReturn.salesperson_id
                  }
                />
                <Field
                  label="Branding"
                  value={brandOf(deliveryReturn)}
                  muted={brandOf(deliveryReturn) === "—"}
                />
                <Field
                  label="Venue"
                  value={deliveryReturn.venue || "—"}
                  muted={!deliveryReturn.venue}
                />
                <Field
                  label="Building type"
                  value={deliveryReturn.building_type || "—"}
                  muted={!deliveryReturn.building_type}
                />
                <Field
                  label="Sales location"
                  value={deliveryReturn.sales_location || "—"}
                  muted={!deliveryReturn.sales_location}
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

            {/* Delivery address + Emergency contact — same layout as DO/SI
                V2. The return may involve a driver going back out to
                collect goods, so the address is genuinely useful. */}
            <Section title="Pickup / Return address">
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-[1.4fr_1fr] sm:divide-x sm:divide-border-subtle">
                <div className="sm:pr-6">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                    From
                  </div>
                  <div className="mt-1.5 text-[14px] font-semibold leading-relaxed text-ink">
                    {[
                      deliveryReturn.address1,
                      deliveryReturn.address2,
                      [deliveryReturn.city, deliveryReturn.postcode]
                        .filter(Boolean)
                        .join(" "),
                      [deliveryReturn.customer_state, deliveryReturn.customer_country]
                        .filter(Boolean)
                        .join(", "),
                    ]
                      .filter(Boolean)
                      .map((line, i) => (
                        <div key={i}>{line}</div>
                      ))}
                    {!deliveryReturn.address1 && !deliveryReturn.city && (
                      <span className="text-ink-muted">Not provided</span>
                    )}
                  </div>
                  {deliveryReturn.sales_location && (
                    <div className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary-soft px-2.5 py-1 text-[11.5px] font-semibold text-primary-ink">
                      <Warehouse size={12} />
                      {deliveryReturn.sales_location}
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
                    {deliveryReturn.emergency_contact_name || "Not provided"}
                  </div>
                  <div className="mt-1 font-mono text-[12.5px] text-ink-secondary">
                    {formatPhone(deliveryReturn.emergency_contact_phone) || "—"}
                  </div>
                  {deliveryReturn.emergency_contact_relationship && (
                    <div className="mt-1 text-[12px] text-ink-muted">
                      {deliveryReturn.emergency_contact_relationship}
                    </div>
                  )}
                </div>
              </div>
            </Section>

            {/* Line items — DR-specific: Item · Condition · Qty · Unit ·
                Refund (err-tinted). Condition + warehouse code on each row
                are the two fields only a return page carries. */}
            <Section title={`Returned items · ${items.length}`}>
              <DataTable<DrItem>
                tableId={`dr-lines-${id}`}
                layoutFamily={DATA_TABLE_LAYOUT_FAMILIES.deliveryReturnLines}
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
              <RefundHeroCard header={deliveryReturn} items={items} />

              {/* Owner 2026-07-17: Totals·Margin (Returned value / Cost / Margin)
                  card removed from the DR document view for EVERYONE — costing
                  moves to the separate Finance "Fulfillment Costing" module. The
                  customer-facing Refund figure is untouched. */}

              <AsideCard title="Key dates">
                <KeyDateRow
                  k="Return date"
                  v={fmtDate(deliveryReturn.return_date)}
                />
              </AsideCard>

              <AsideCard title="People">
                <PersonRow
                  initials={
                    deliveryReturn.agent || deliveryReturn.salesperson_id
                      ? initialsOf(
                          salespersonNameOf(
                            deliveryReturn.agent,
                            deliveryReturn.salesperson_id,
                            ""
                          )
                        )
                      : "?"
                  }
                  name={salespersonNameOf(
                    deliveryReturn.agent,
                    deliveryReturn.salesperson_id,
                    "Salesperson"
                  )}
                  role={
                    deliveryReturn.agent || deliveryReturn.salesperson_id
                      ? "Salesperson"
                      : "Not yet assigned"
                  }
                  tone={
                    deliveryReturn.agent || deliveryReturn.salesperson_id
                      ? "accent"
                      : "neutral"
                  }
                />
                <PersonRow
                  initials={initialsOf(deliveryReturn.debtor_name)}
                  name={deliveryReturn.debtor_name || "—"}
                  role={`Customer${
                    doOf(deliveryReturn) !== "—"
                      ? ` · DO ${doOf(deliveryReturn)}`
                      : ""
                  }`}
                  tone="accent"
                />
              </AsideCard>

              <AsideCard title="Recent activity">
                <ActivityRow
                  title={`Return ${EFFECTIVE_TONE[effectiveOf(deliveryReturn)].label.toLowerCase()}`}
                  meta={fmtDate(deliveryReturn.return_date)}
                  dot={
                    EFFECTIVE_TONE[effectiveOf(deliveryReturn)].tone === "success"
                      ? "success"
                      : "primary"
                  }
                />
                <ActivityRow
                  title={`Lines received (${items.length})`}
                  meta={fmtDate(deliveryReturn.return_date)}
                  dot="primary"
                />
                <ActivityRow
                  title="Created"
                  meta={`${fmtDate(deliveryReturn.return_date)}${
                    deliveryReturn.sales_location
                      ? ` · ${deliveryReturn.sales_location}`
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
          {canInspect ? (
            <button
              type="button"
              onClick={doMarkInspected}
              className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink"
            >
              <ClipboardCheck size={16} /> Mark inspected
            </button>
          ) : canRefund ? (
            <button
              type="button"
              onClick={doMarkRefunded}
              className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink"
            >
              <CheckCircle2 size={16} /> Mark refunded
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
            disabled={!deliveryReturn.phone}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-surface-2 text-primary-ink hover:bg-primary-soft disabled:opacity-40"
            aria-label={
              deliveryReturn.phone
                ? `Call ${deliveryReturn.phone}`
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
        docTitle="Delivery Return"
        docNo={deliveryReturn.return_number}
        rows={[
          { label: "Customer", value: deliveryReturn.debtor_name || "—" },
          { label: "Return date", value: fmtDate(deliveryReturn.return_date) },
          { label: "Reason", value: deliveryReturn.reason || "—" },
          {
            label: "Items",
            value: `${items.length} line${items.length === 1 ? "" : "s"}`,
          },
          {
            label: "Refund",
            value: fmtMoney(refundOf(deliveryReturn, items), deliveryReturn.currency),
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

export default DeliveryReturnDetailV2;
