// DeliveryOrderDetailV2 — Theme C ("Ink & Petrol") design of the Delivery
// Order detail page, matching the 2026-07-08 design handoff prototypes.
//
// The 4 primary actions in the sticky header all open real modal overlays:
//   · History         — change-history timeline
//   · Relationship Map — a node-graph modal showing the document chain
//     PO → SO → DO (current) → GRN → Invoice, NOT an inline pipeline
//   · Print PDF       — print-preview card + Download/Print
//   · Edit            — navigate to the New DO form
//
// Stateful DO transitions (Cancel DO / Mark signed / Transfer to Sales Invoice) are
// kept as CONDITIONAL secondary buttons within the same header, positioned
// between Print PDF and Edit so they don't hide from ops but also don't
// dominate the primary action bar.
//
// Aside dark hero flips from the earlier "Dispatch" (driver-info-forward)
// version to a "Delivery status" card — status label + scheduled date +
// Total items + Warehouse — because ops opens a DO detail asking "is it
// on the road yet?", not "who's driving". Driver info moves INTO the
// Delivery info section as an ink-tinted sub-card.
//
// Route: /scm/delivery-orders/:id. Data: useMfgDeliveryOrderDetail /
// useUpdateMfgDeliveryOrderStatus (unchanged from prior V2).

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { scmListReturnTo } from "../../lib/scmListReturn";
import {
  ArrowLeft,
  History,
  Printer,
  XCircle,
  Edit3,
  Warehouse,
  CircleDot,
  Phone as PhoneIcon,
  MoreHorizontal,
  CheckCircle2,
  Receipt,
  Share2,
  Undo2,
  X as XIcon,
} from "lucide-react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { NextStepNote } from "../../components/NextStepNote";
import {
  doAdvanceBlockReason,
  doAdvanceStep,
  siTransferBlockReason,
} from "../../vendor/scm/lib/do-next-step";
import { DataTable, type Column } from "../../components/DataTable";
import { DATA_TABLE_LAYOUT_FAMILIES } from "../../components/dataTableLayoutFamilies";
import { CommittedBatchCell } from "../../components/DocumentLinesExpansion";
import { DoLinePhotoStrip } from "../../components/scm-v2/DoLinePhotoStrip";
import {
  DetailGrid,
  DetailMain,
  DetailAside,
  Section,
} from "../../components/DetailLayout";
import {
  useMfgDeliveryOrderDetail,
  useUpdateMfgDeliveryOrderStatus,
  useRevertMfgDeliveryOrder,
  useUpdateMfgDeliveryOrderItem,
} from "../../vendor/scm/lib/delivery-order-queries";
import { useRacks } from "../../vendor/scm/lib/warehouse-queries";
import { useSetBreadcrumbs } from "../../hooks/useBreadcrumbs";
import { useStaffLookup } from "../../hooks/useStaffLookup";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { usePrompt } from "../../vendor/scm/components/PromptDialog";
import { useDoRelationshipMap } from "./sales-doc-relationship-map";
import {
  DocumentRelationshipMapModal,
  DocumentChoiceDialog,
  ModalOverlay,
} from "../../components/scm-v2/DocumentRelationshipMapModal";
import {
  PrintPreviewModal,
  useOpenPrintPreviewFromUrl,
  type PrintPreviewRow,
} from "../../components/scm-v2/PrintPreviewModal";
import type { PdfAction } from "../../vendor/scm/lib/pdf-common";
import { cn } from "../../lib/utils";
import { convertToLink, transferToLabel } from "../../lib/convertScope";
import { buildVariantSummary, fmtDate, orderLineIdentity } from "@2990s/shared";
import { formatPhone } from "@2990s/shared/phone";
import { useAuth } from "../../auth/AuthContext";
import { canOperateDeliveryOrders, canRevertDelivery } from "../../auth/salesAccess";
import { DO_SHIPPED_STATES } from '../../vendor/shared/do-shipped-states';
import { HoldChip, type HoldFields } from "../../vendor/scm/components/HoldChip";

// ─── Header + item shapes (subset — full 40-field row lives in the list V2) ─

type DoLifecycle = "shipped" | "invoiced" | "returned";

type DoHeader = HoldFields & {
  id: string;
  do_number: string;
  so_doc_no: string | null;
  status: string;
  do_date: string;
  expected_delivery_at: string | null;
  customer_delivery_date: string | null;
  debtor_code: string | null;
  debtor_name: string;
  salesperson_id: string | null;
  salesperson_name?: string | null;
  agent: string | null;
  branding: string | null;
  venue: string | null;
  ref: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  sales_location: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  customer_state: string | null;
  customer_country: string | null;
  customer_type: string | null;
  building_type: string | null;
  phone: string | null;
  email: string | null;
  driver_id: string | null;
  driver_name: string | null;
  driver_ic: string | null;
  driver_phone: string | null;
  vehicle: string | null;
  note: string | null;
  notes: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  /* Proof of delivery, as stored. Both are on the detail payload already
     (delivery-orders-mfg.ts:305 selects `pod_r2_key, signature_data`); this
     page simply never declared them, which is part of why it could close a
     delivery without noticing there was no evidence on the row. */
  signature_data?: string | null;
  pod_r2_key?: string | null;
  lifecycle_state?: DoLifecycle;
  currency: string;
  created_at?: string;
  created_by?: string | null;
  issued_by_name?: string | null;
  // Finance-gated cost / margin analytics (migration 0079). The DO header
  // rolls line prices/costs up in recomputeTotals; present on the DETAIL
  // payload for every caller (only the LIST endpoint strips these — #574).
  // The UI gates the Totals·Margin card behind project_finance_viewer.
  local_total_sen?: number | null;
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

type DoItem = {
  id: string;
  item_code: string;
  description: string | null;
  description2: string | null;
  uom: string;
  qty: number;
  unit_price_sen?: number;
  cancelled?: boolean;
  item_group?: string;
  variants?: Record<string, unknown> | null;
  /* REC P4 — per-line source rack + storekeeper resolution (stamped by the
     detail GET: warehouse_id = ship-from warehouse, racks = candidate labels,
     rack_id = the operator's explicit pick). */
  rack_id?: string | null;
  racks?: string[];
  warehouse_id?: string | null;
  /* Mig 0230 — the incoming PO batch this line committed to at DO creation
     (ship-before-arrival). The hard-from-DO anchor (Decision, docs/modules/
     purchase-order.md 2026-08-06); returned by the detail GET's ITEM columns.
     Display-only here — rendered as an anchored CommittedBatchCell chip. */
  committed_po_batch_no?: string | null;
  /* Mig 20260828T0746 — R2 photo keys carried from the source SO line on
     convert (owner 2026-08-10: 送货时照片要跟着 line). Returned by the detail
     GET's ITEM columns; rendered read-only via DoLinePhotoStrip. */
  photo_urls?: string[];
};

// ─── Helpers ────────────────────────────────────────────────────────────────

// The DO document is quantity-only for customers. The centi money formatter
// (fmtMoneySen) that fed the finance-gated Totals·Margin card is gone with
// that card (owner 2026-07-17) — the DO detail renders no money figures.

const refOf = (h: DoHeader): string =>
  h.po_doc_no || h.customer_so_no || h.ref || "—";

const soOf = (h: DoHeader): string => h.so_doc_no || "—";

const brandOf = (h: DoHeader): string => h.branding || "—";

type Effective = "draft" | "shipped" | "invoiced" | "returned" | "cancelled";
const effectiveOf = (h: DoHeader): Effective => {
  const s = (h.status || "").toUpperCase();
  if (s === "CANCELLED") return "cancelled";
  if (s === "DRAFT") return "draft";
  if (h.lifecycle_state === "returned") return "returned";
  if (h.lifecycle_state === "invoiced") return "invoiced";
  return "shipped";
};

const EFFECTIVE_TONE: Record<
  Effective,
  { tone: "success" | "warning" | "error" | "neutral"; label: string; blurb: string }
> = {
  draft: {
    tone: "warning",
    label: "Draft",
    blurb: "Draft · not yet shipped",
  },
  shipped: {
    tone: "warning",
    label: "Ready to dispatch",
    blurb: "Scheduled · goods on the road",
  },
  invoiced: {
    tone: "success",
    label: "Invoiced",
    blurb: "Invoiced · SI issued",
  },
  returned: {
    tone: "error",
    label: "Returned",
    blurb: "Returned · goods came back",
  },
  cancelled: {
    tone: "error",
    label: "Cancelled",
    blurb: "Cancelled · no further action",
  },
};

// Fine-grained stage label — kept for the sticky header Badge so ops sees
// the exact stored status (Confirmed / Loaded / In transit / Signed / …)
// even when the effective bucket collapses to "shipped".
//
// DISPATCHED reads "Loaded" since 2026-08-26 (owner), matching status-pill.ts.
// It said "Dispatched" here and "Shipped" everywhere else — the same stored
// value under two words on two screens — and neither of them was what the step
// means on the three-scan flow: DISPATCHED is the pallet ON the lorry, and
// departure is IN_TRANSIT. The stored value is untouched.
const STAGE_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  LOADED: "Confirmed",
  DISPATCHED: "Loaded",
  IN_TRANSIT: "In transit",
  SIGNED: "Signed",
  DELIVERED: "Delivered",
  INVOICED: "Invoiced",
  RETURNED: "Returned",
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

const shipTo = (h: DoHeader): string[] =>
  [
    h.address1,
    h.address2,
    [h.city, h.postcode].filter(Boolean).join(" "),
    [h.customer_state, h.customer_country].filter(Boolean).join(", "),
  ].filter((s): s is string => !!s && s.trim().length > 0);

// ─── Field cell ────────────────────────────────────────────────────────────

function Field({
  label,
  value,
  muted,
  mono,
  accent,
}: {
  label: string;
  value: ReactNode;
  muted?: boolean;
  mono?: boolean;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-[14px] font-semibold leading-snug",
          muted ? "text-ink-muted" : accent ? "text-accent-ink" : "text-ink",
          mono && "font-mono"
        )}
      >
        {value}
      </div>
    </div>
  );
}

// ─── Aside primitives ──────────────────────────────────────────────────────

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
// The Revenue / Cost / Margin / Margin% aside card is gone from the DO document
// view for EVERYONE; costing moves to the separate Finance "Fulfillment
// Costing" module. The customer-facing totals are untouched.

// REC P4 — Source rack picker. Per goods line, choose which physical rack the
// stock ships FROM; the backend logs a rack STOCK_OUT on dispatch (honouring
// the pick, else auto-picking the rack holding the product). Lines whose
// warehouse has no racks are hidden. Once the DO has shipped the pick is
// locked (the stock-out already ran) and shown read-only.
function SourceRackCard({
  items,
  doId,
  locked,
  notify,
}: {
  items: DoItem[];
  doId: string;
  locked: boolean;
  notify: ReturnType<typeof useNotify>;
}) {
  const racksQ = useRacks();
  const updateItem = useUpdateMfgDeliveryOrderItem();
  const racksByWh = useMemo(() => {
    const m = new Map<string, { id: string; rack: string }[]>();
    for (const r of racksQ.data?.racks ?? []) {
      const arr = m.get(r.warehouse_id) ?? [];
      arr.push({ id: r.id, rack: r.rack });
      m.set(r.warehouse_id, arr);
    }
    return m;
  }, [racksQ.data]);

  const lines = items.filter(
    (l) => l.warehouse_id && (racksByWh.get(l.warehouse_id)?.length ?? 0) > 0
  );
  if (lines.length === 0) return null;

  const pick = (l: DoItem, rackId: string) => {
    updateItem.mutate(
      { id: doId, itemId: l.id, rackId: rackId || null },
      {
        onError: (e) =>
          notify({
            title: "Could not set source rack",
            body: e instanceof Error ? e.message : "Something went wrong.",
            tone: "error",
          }),
      }
    );
  };

  return (
    <AsideCard title="Source racks">
      <p className="mb-3 text-[11.5px] leading-snug text-ink-muted">
        {locked
          ? "This DO has shipped — stock was taken off these racks on dispatch."
          : "Pick which rack each line ships from. Applied when the DO is dispatched; leave on Auto to pull from the rack already holding it."}
      </p>
      <div className="space-y-3">
        {lines.map((l) => {
          const whRacks = racksByWh.get(l.warehouse_id as string) ?? [];
          return (
            <div key={l.id} className="border-b border-border-subtle pb-3 last:border-b-0 last:pb-0">
              <div className="truncate text-[12.5px] font-semibold text-ink">
                {l.description || l.item_code}
              </div>
              <div className="mb-1.5 text-[11px] text-ink-muted">
                {(l.racks?.length ?? 0) > 0 ? `On rack: ${l.racks!.join(", ")}` : "Not yet placed on a rack"}
              </div>
              <select
                className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[12.5px] text-ink disabled:opacity-60"
                value={l.rack_id ?? ""}
                disabled={locked || updateItem.isPending}
                onChange={(e) => pick(l, e.target.value)}
              >
                <option value="">Auto — rack holding it</option>
                {whRacks.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.rack}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </AsideCard>
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

// ─── Recent activity timeline (mirrors SalesOrderDetailV2) ─────────────────
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

// ─── Delivery-status aside hero (dark slab) ────────────────────────────────
//
// Replaces the earlier "Dispatch" driver-focused hero. Now surfaces the four
// signals ops opens a DO for: state label · scheduled date · total items ·
// warehouse. Matches the design handoff card exactly.

function DeliveryStatusCard({
  header,
  totalQty,
}: {
  header: DoHeader;
  totalQty: number;
}) {
  const eff = effectiveOf(header);
  const t = EFFECTIVE_TONE[eff];
  return (
    <div className="rounded-lg bg-sidebar px-5 py-5 text-sidebar-ink shadow-stone">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-sidebar-ink-muted">
        Delivery status
      </div>
      <div className="mt-2 font-display text-[22px] font-bold leading-tight tracking-tight text-white">
        {t.label}
      </div>
      <div className="mt-2.5 flex items-center gap-2">
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
        <span className="text-[12.5px] text-sidebar-ink-muted">
          {header.customer_delivery_date
            ? `Scheduled ${fmtDate(header.customer_delivery_date)}`
            : header.expected_delivery_at
              ? `Expected ${fmtDate(header.expected_delivery_at)}`
              : "Not yet scheduled"}
        </span>
      </div>

      <div className="mt-4 space-y-2.5 border-t border-white/10 pt-4">
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] text-sidebar-ink-muted">Total items</span>
          <span className="font-money text-[14px] font-bold text-white">
            {totalQty}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] text-sidebar-ink-muted">Warehouse</span>
          <span className="text-[13px] font-semibold text-sidebar-ink">
            {header.sales_location || "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Driver sub-card (embedded inside Delivery info) ───────────────────────

function DriverSubCard({ header }: { header: DoHeader }) {
  return (
    <div className="mt-4 rounded-lg border border-border-subtle bg-surface-2 px-4 py-4">
      <div className="mb-3 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-secondary">
        Driver
      </div>
      <div className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
        <Field label="Driver name" value={header.driver_name || "Unassigned"} muted={!header.driver_name} />
        <Field label="IC number" value={header.driver_ic || "—"} mono={!!header.driver_ic} muted={!header.driver_ic} />
        <Field
          label="Phone"
          value={formatPhone(header.driver_phone) || "—"}
          mono={!!header.driver_phone}
          muted={!header.driver_phone}
        />
        <Field label="Vehicle" value={header.vehicle || "—"} mono={!!header.vehicle} muted={!header.vehicle} />
      </div>
    </div>
  );
}

// ModalOverlay is now imported from the shared component so the SO/DO/SI/DR
// detail pages don't drift on modal chrome. HistoryModal + PrintPdfModal
// below both consume it.


// ─── Modal · Change history timeline ───────────────────────────────────────

function HistoryModal({
  open,
  onClose,
  header,
  itemsCount,
}: {
  open: boolean;
  onClose: () => void;
  header: DoHeader;
  itemsCount: number;
}) {
  /* `created_by` is a scm.staff uuid and `issued_by_name` is never actually
     sent by the DO detail endpoint, so the fallback chain printed the raw uuid
     in the Change-history modal (owner 2026-07-16, same class as the Amendments
     leak). Resolve through the shared roster; "System" stays the last resort. */
  const { actorNameOf } = useStaffLookup();

  // Derived timeline from the header's timestamps + status. A future backend
  // history endpoint can replace this with a proper audit log; for now the
  // detail endpoint doesn't return one, so we synthesize from what we know.
  const events: Array<{ title: string; at: string; by: string; dot: "success" | "primary" | "muted" }> =
    useMemo(() => {
      const list: Array<{ title: string; at: string; by: string; dot: "success" | "primary" | "muted" }> = [];
      list.push({
        title: header.so_doc_no
          ? `DO created from ${header.so_doc_no}`
          : "DO created",
        at: fmtDate(header.created_at || header.do_date),
        by: header.issued_by_name || actorNameOf(header.created_by, "System"),
        dot: "success",
      });
      if (header.driver_name) {
        list.push({
          title: `Driver ${header.driver_name} assigned`,
          at: fmtDate(header.do_date),
          by: header.issued_by_name || "System",
          dot: "primary",
        });
      }
      if (header.customer_delivery_date) {
        list.push({
          title: `Delivery scheduled ${fmtDate(header.customer_delivery_date)}`,
          at: fmtDate(header.do_date),
          by: header.issued_by_name || "System",
          dot: "primary",
        });
      }
      list.push({
        title: `Status → ${EFFECTIVE_TONE[effectiveOf(header)].label}`,
        at: fmtDate(header.do_date),
        by: "System",
        dot: "muted",
      });
      list.push({
        title: `${itemsCount} line item${itemsCount === 1 ? "" : "s"} on this DO`,
        at: fmtDate(header.do_date),
        by: "System",
        dot: "muted",
      });
      return list;
    }, [header, itemsCount, actorNameOf]);

  const DOT_CLS: Record<"success" | "primary" | "muted", string> = {
    success: "bg-synced",
    primary: "bg-primary",
    muted: "bg-border-strong",
  };

  return (
    <ModalOverlay open={open} onClose={onClose} title="Change history" icon={<History size={16} />}>
      <div className="flex flex-col">
        {events.map((e, i) => {
          const isLast = i === events.length - 1;
          return (
            <div key={i} className="flex gap-3 pb-4 last:pb-0">
              <div className="flex flex-col items-center">
                <span className={cn("mt-1 h-2.5 w-2.5 rounded-full", DOT_CLS[e.dot])} />
                {!isLast && <span className="mt-1 w-[2px] flex-1 bg-border-subtle" />}
              </div>
              <div className="min-w-0 flex-1 pb-1">
                <div className="text-[13px] font-semibold text-ink">{e.title}</div>
                <div className="mt-0.5 text-[11.5px] text-ink-muted">
                  {e.at} · {e.by}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </ModalOverlay>
  );
}

// Relationship map — the inline node-graph + ModalOverlay copies that used
// to live here were moved to a shared component (see the imports at the top
// of the file) so SO/DO/SI/DR detail pages share one renderer. Nodes are
// built in the main component below (chainNodes memo) and passed in as
// props; onNodeClick handles navigation to linked cross-docs.

// Print preview — this page's private PrintPdfModal was the app's ONLY print
// preview; it is now components/scm-v2/PrintPreviewModal, shared by every
// printable document (see that file's header).

// ─── Main page ─────────────────────────────────────────────────────────────

export function DeliveryOrderDetailV2() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const detail = useMfgDeliveryOrderDetail(id ?? null);
  const updateStatus = useUpdateMfgDeliveryOrderStatus();
  const { nameOf: salespersonNameOf } = useStaffLookup();
  const notify = useNotify();
  const askConfirm = useConfirm();
  const askPrompt = usePrompt();
  const revert = useRevertMfgDeliveryOrder();
  const { user, can, pageAccess } = useAuth();
  // showCustomerPo + node click handling now live inside useDoRelationshipMap.
  // Mutation gate — a salesperson opens this DO read-only via the sales inherit
  // hatch (allowSales; backend readInheritsFrom scm.sales.orders) and cannot
  // edit/cancel/convert it. Hide those controls (owner off-not-hide rule); Print
  // PDF stays so the rep can still send the document.
  // ONE gate, shared with the lists, the SO drawer and mobile — this was a
  // hand-copied `["edit","full"].includes(...)`, and the copies disagreed.
  const canWriteDo = canOperateDeliveryOrders(user, can, pageAccess);

  const deliveryOrder =
    (detail.data as { deliveryOrder?: DoHeader } | undefined)?.deliveryOrder ??
    null;
  const items: DoItem[] =
    ((detail.data as { items?: DoItem[] } | undefined)?.items ?? []).filter(
      (l) => !l.cancelled
    );

  const totalQty = useMemo(
    () => items.reduce((sum, l) => sum + Number(l.qty ?? 0), 0),
    [items]
  );

  useSetBreadcrumbs([
    { label: "Delivery Orders", to: "/scm/delivery-orders" },
    { label: deliveryOrder?.do_number ?? id ?? "Delivery Order" },
  ]);

  const [modal, setModal] = useState<"history" | "relmap" | "print" | null>(null);
  const closeModal = () => setModal(null);
  const openPrintPreview = useCallback(() => setModal("print"), []);
  useOpenPrintPreviewFromUrl(openPrintPreview, !!deliveryOrder);

  const eff = deliveryOrder ? effectiveOf(deliveryOrder) : null;
  const stageLabel = deliveryOrder
    ? STAGE_LABEL[(deliveryOrder.status || "").toUpperCase()] ??
      deliveryOrder.status
    : "";
  const badgeTone = eff ? EFFECTIVE_TONE[eff].tone : "neutral";

  const foldedNote = useMemo(
    () => deliveryOrder?.note || deliveryOrder?.notes || null,
    [deliveryOrder?.note, deliveryOrder?.notes]
  );

  // Chain nodes for the shared Relationship Map modal, read from the LIVE
  // `/document-flow` graph (the SO map's source) instead of a hand-built chain.
  // This is what fixes the DO's old hard-coded GRN "Not created" — the graph
  // resolves the real GRN(s) the DO's source SO was received on — and makes the
  // Sales Invoice + Sales Order nodes reflect the actual downstream/upstream
  // documents. Display-only: NONE of the DO status / delivery-planning state is
  // read here (audit R8; see sales-doc-relationship-map.ts).
  const relMapHeader = useMemo(
    () =>
      deliveryOrder
        ? {
            id: deliveryOrder.id,
            do_number: deliveryOrder.do_number,
            so_doc_no: deliveryOrder.so_doc_no,
            po_doc_no: deliveryOrder.po_doc_no,
            customer_so_no: deliveryOrder.customer_so_no,
          }
        : null,
    [deliveryOrder],
  );
  const {
    nodes: chainNodes,
    onNodeClick: onChainNodeClick,
    choice: chainChoice,
    closeChoice: closeChainChoice,
    pickChoice: pickChainChoice,
  } = useDoRelationshipMap(relMapHeader);

  // Back always returns to the Delivery Orders list (owner 2026-07-24: every
  // details page's back button goes to its relevant list, not wherever
  // browser history happens to point). The list restores its own sticky
  // filters, so the prior filtered view comes back — no context lost.
  const goBack = () => navigate(scmListReturnTo("/scm/delivery-orders"));
  const goEdit = () => id && navigate(`/scm/delivery-orders/new?edit=${id}`);
  const doCancel = async () => {
    if (!deliveryOrder) return;
    if (await askConfirm({
      title: `Cancel delivery order ${deliveryOrder.do_number}?`,
      body: "Stock allocated to this DO will be released back to the SO.",
      confirmLabel: "Cancel DO",
      danger: true,
    })) {
      updateStatus.mutate({ id: deliveryOrder.id, status: "CANCELLED" });
    }
  };
  /* The Ops-lead REVERT — the safety net for a wrong scan (LOADED) or an
     accidental dispatch (DISPATCHED). The plan is derived from the current
     status so the one control never changes meaning ambiguously: a LOADED order
     undoes the load (→ Draft, stock returns), a DISPATCHED one undoes the
     dispatch (→ Loaded, stock stays out — a full reset is then a second click).
     The server owns the legal transitions, the downstream lock and the stock
     reversal; a reason is mandatory (it lands in the audit trail). */
  const doStatusUpper = (deliveryOrder?.status || "").toUpperCase();
  const revertPlan: { to: "LOADED" | "DRAFT"; label: string; body: string } | null =
    doStatusUpper === "LOADED"
      ? { to: "DRAFT", label: "Undo load", body: "Returns the goods to warehouse stock and moves the delivery order back to Draft." }
      : doStatusUpper === "DISPATCHED"
        ? { to: "LOADED", label: "Undo dispatch", body: "Moves the delivery order back to Loaded. The goods stay out of stock — undo the load next to return them." }
        : null;
  const doRevert = async () => {
    if (!deliveryOrder || !revertPlan) return;
    const reason = await askPrompt({
      title: `${revertPlan.label} — ${deliveryOrder.do_number}?`,
      body: revertPlan.body,
      placeholder: "Reason (e.g. scanned the wrong order)",
      confirmLabel: revertPlan.label,
      multiline: true,
      validate: (v) => (v.trim() ? null : "A reason is required."),
    });
    if (reason == null) return; // cancelled
    revert.mutate({ id: deliveryOrder.id, toStatus: revertPlan.to, reason: reason.trim() });
  };
  /* The ONE status-advance control. Its verb and its target both come from
     do-next-step.ts, so a DRAFT delivery order gets the same "Confirm"
     (→ DISPATCHED) the mobile shell has always offered — until now the desktop
     had no way to advance a draft at all: `canMarkSigned` excluded DRAFT and no
     other control on this page or its editor writes a status. A draft raised on
     the desktop could only be moved forward by picking up a phone, which is
     precisely the "我又不是两套系统" complaint in a second costume. Same
     endpoint, same body, same permission gate the phone already uses. */
  const doAdvance = () => {
    if (!deliveryOrder) return;
    const step = doAdvanceStep(deliveryOrder.status);
    if (!step) return;
    /* The only advance step now is DRAFT → Confirm (owner 2026-08-21 removed
       "Mark signed"); closing a delivery with its signature is the driver's
       Proof-of-Delivery screen. So there is nothing to warn about here. */
    updateStatus.mutate({ id: deliveryOrder.id, status: step.status });
  };
  const goConvertToSi = () =>
    deliveryOrder && navigate(convertToLink('doToSi', deliveryOrder.id));

  // Render the DO PDF via the SAME generator the list's Export PDF and the V1
  // detail page use (jspdf, client-side). The old `?print=1` navigation was dead
  // — nothing consumed that param — so the button did nothing. Reuse the shared
  // helper instead of re-implementing.
  //
  // `action` is the preview dialog's three exits. "Print now" used to be a bare
  // window.print(), which prints a BLANK sheet here (index.css's @media print
  // reveals only .org-print-area); it now prints the real document.
  const doDeliverPdf = (action: PdfAction) => {
    return import("../../vendor/scm/lib/delivery-order-pdf")
      .then(async ({ generateDeliveryOrderPdf }) => {
        // armDoScanToken puts the PUBLIC scan token on the header — the print's
        // QR encodes /d/<token>, which opens with no login.
        const { armDoScanToken } = await import("../../vendor/scm/lib/do-scan-token-arm");
        const header = await armDoScanToken(
          deliveryOrder as Record<string, unknown>,
          (deliveryOrder as { id?: string }).id ?? "",
        );
        return generateDeliveryOrderPdf(header as never, items as never, { action });
      })
      .then(() => {
        // Downloads and prints are terminal — close behind them. A new-tab
        // preview leaves the dialog up so the operator can print after looking.
        if (action !== "preview") closeModal();
      })
      .catch((e) =>
        notify({
          title: "PDF generation failed",
          body: e instanceof Error ? e.message : "Something went wrong.",
          tone: "error",
        })
      );
  };

  // Summary lines for the print preview card — enough to confirm this is the
  // document you meant before it goes to a printer or a customer.
  const printRows: PrintPreviewRow[] = deliveryOrder
    ? [
        { label: "Deliver to", value: deliveryOrder.debtor_name },
        { value: shipTo(deliveryOrder).join(", ") || "No address on file" },
        {
          label: "Driver",
          value:
            (deliveryOrder.driver_name || "Unassigned") +
            (deliveryOrder.vehicle ? ` · ${deliveryOrder.vehicle}` : ""),
        },
        {
          label: "DO date",
          value:
            fmtDate(deliveryOrder.do_date) +
            (deliveryOrder.customer_delivery_date
              ? ` · Scheduled ${fmtDate(deliveryOrder.customer_delivery_date)}`
              : ""),
        },
        {
          label: "Items",
          value: `${items.length} line${items.length === 1 ? "" : "s"} · ${items.reduce(
            (sum, l) => sum + Number(l.qty ?? 0),
            0
          )} unit${items.reduce((sum, l) => sum + Number(l.qty ?? 0), 0) === 1 ? "" : "s"}`,
        },
      ]
    : [];

  // ── DO line item columns — Item (with variant chips) · Type (FOC/Sale) · Qty ─
  const lineColumns: Column<DoItem>[] = [
    {
      key: "item",
      label: "Item",
      alwaysVisible: true,
      getValue: (l) => l.item_code,
      /* Item CODE first, then the variant subtitle; description dropped (owner 2026-07-24) — the shared order-line rule
         (vendor/shared/line-identity.ts). Converged onto the helper from this
         page's own #647 copy: same behaviour, one source. The code still BINDS
         via getValue above. */
      render: (l) => {
        const { primary, secondary } = orderLineIdentity({
          code: l.item_code,
          description: l.description,
          variant: buildVariantSummary(l.item_group ?? "others", l.variants) || (l.description2 ?? ""),
        });
        return (
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-ink">
              {primary}
            </div>
            {secondary && (
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-muted">
                <span className="truncate text-ink-secondary">
                  {secondary}
                </span>
              </div>
            )}
            {/* Committed batch (mig 0230) — the hard-from-DO anchor. Renders
                ONLY when the line stored a commitment at DO creation; most
                lines never commit, so absence renders nothing (no dash). */}
            {l.committed_po_batch_no && (
              <div className="mt-1">
                <CommittedBatchCell poNo={l.committed_po_batch_no} />
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: "type",
      label: "Type",
      width: "88px",
      getValue: (l) => (Number(l.unit_price_sen ?? 0) === 0 ? "FOC" : "Sale"),
      render: (l) => {
        const isFoc = Number(l.unit_price_sen ?? 0) === 0;
        return (
          <Badge tone={isFoc ? "warning" : "neutral"} size="xs">
            {isFoc ? "FOC" : "Sale"}
          </Badge>
        );
      },
    },
    {
      key: "qty",
      label: "Qty to deliver",
      width: "132px",
      align: "right",
      getValue: (l) => l.qty,
      render: (l) => (
        <span className="font-money text-[14px] font-semibold text-ink">
          {l.qty}
          <span className="ml-1 text-[10.5px] font-normal text-ink-muted">
            {l.uom || ""}
          </span>
        </span>
      ),
    },
    /* Photos (mig 20260828T0746) — the line's carried SO reference shots,
       openable. Same column idiom as the SO detail's Photos column: getValue is
       the COUNT so the column sorts/filters/exports as a number; a `render`
       with no getValue is invisible to all three. */
    {
      key: "photos",
      label: "Photos",
      width: "110px",
      getValue: (l) => (l.photo_urls ?? []).length,
      render: (l) => (
        <DoLinePhotoStrip
          doId={id ?? ""}
          itemId={l.id}
          photoKeys={l.photo_urls ?? []}
        />
      ),
    },
  ];

  // ── Loading / error states ───────────────────────────────────────────
  if (!id) {
    return (
      <div className="p-8 text-center text-ink-muted">
        No delivery order specified.
      </div>
    );
  }
  if (detail.isPending) {
    return (
      <div className="animate-fade-in p-8 text-center text-ink-muted">
        Loading delivery order…
      </div>
    );
  }
  if (detail.error || !deliveryOrder) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div className="mb-2 font-display text-[18px] font-extrabold text-err">
          Couldn't load delivery order
        </div>
        <p className="text-[13px] text-ink-muted">
          {(detail.error as Error | undefined)?.message ??
            "The delivery order was not found."}
        </p>
        <div className="mt-4">
          <Button variant="secondary" onClick={goBack} icon={<ArrowLeft size={14} />}>
            Back to Delivery Orders
          </Button>
        </div>
      </div>
    );
  }

  const goCall = () => {
    if (!deliveryOrder?.phone) return;
    window.location.href = `tel:${deliveryOrder.phone.replace(/\s+/g, "")}`;
  };

  const rawStatus = (deliveryOrder.status || "").toLowerCase();
  /* Both questions this page asks about status now come from ONE module, which
     the list drawer, the phone bar below and the native mobile shell also
     import. They used to be re-derived here by hand, and the copies disagreed:
     on DISPATCHED this page offered "Mark signed" while the mobile shell offered
     "Mark In Transit" for the same document. See vendor/scm/lib/do-next-step.ts. */
  const advanceStep = doAdvanceStep(deliveryOrder.status);
  const advanceReason = doAdvanceBlockReason(deliveryOrder.status);
  const siReason = siTransferBlockReason(deliveryOrder.status);
  const canConvertToSi = siReason === null;
  const isCancelled = rawStatus === "cancelled";

  const soNo = deliveryOrder.so_doc_no;

  return (
    <div className="pb-56 md:pb-0">
      {/* ─── Mobile-only dark sticky header ─────────────────────────── */}
      <div className="sticky top-0 z-20 -mx-4 -mt-4 bg-sidebar text-sidebar-ink shadow-slab md:hidden">
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center gap-1 text-[14px] font-semibold text-accent-bright"
            aria-label="Back to Delivery Orders"
          >
            <ArrowLeft size={16} /> DOs
          </button>
          <span className="font-mono text-[12.5px] font-semibold text-sidebar-ink">
            {deliveryOrder.do_number}
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
            {deliveryOrder.debtor_name || "—"}
          </h1>
          <div className="mt-2">
            <span className="inline-flex items-center gap-1.5">
              <Badge tone={badgeTone} variant="solid" size="xs">
                {stageLabel}
              </Badge>
              {/* mig 0324 — the Delivery Order's first hold marker, BESIDE
                  the stage rather than instead of it: the warehouse still
                  needs to know where the goods are. */}
              <HoldChip onHold={deliveryOrder.on_hold} reason={deliveryOrder.hold_reason} />
            </span>
          </div>
        </div>
      </div>

      {/* ─── Desktop sticky header ─────────────────────────────────── */}
      <div className="sticky top-0 z-10 -mx-4 hidden border-b border-border bg-bg/95 px-4 py-4 backdrop-blur-sm sm:-mx-6 sm:px-6 md:block">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <button
              type="button"
              onClick={goBack}
              aria-label="Back to Delivery Orders"
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary hover:border-primary/50 hover:text-primary"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
                  {deliveryOrder.debtor_name || "—"}
                </h1>
                <span className="inline-flex items-center gap-1.5">
                  <Badge tone={badgeTone} size="sm">
                    {stageLabel}
                  </Badge>
                  {/* mig 0324 — the Delivery Order's first hold marker, BESIDE
                      the stage rather than instead of it: the warehouse still
                      needs to know where the goods are. */}
                  <HoldChip onHold={deliveryOrder.on_hold} reason={deliveryOrder.hold_reason} />
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-secondary">
                <span className="font-mono font-semibold text-accent-ink">
                  {deliveryOrder.do_number}
                </span>
                <Divider />
                <span>DO date {fmtDate(deliveryOrder.do_date)}</span>
                <Divider />
                <span>
                  {items.length} line{items.length === 1 ? "" : "s"}
                </span>
                {soNo && (
                  <>
                    <Divider />
                    <span className="inline-flex items-center gap-1">
                      ⇄ from{" "}
                      <span className="font-mono font-semibold text-ink-secondary">
                        {soNo}
                      </span>
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="ghost"
              icon={<History size={14} />}
              onClick={() => setModal("history")}
            >
              History
            </Button>
            <Button
              variant="ghost"
              icon={<Share2 size={14} />}
              onClick={() => setModal("relmap")}
            >
              Relationship Map
            </Button>
            <Button
              variant="secondary"
              icon={<Printer size={14} />}
              onClick={() => setModal("print")}
            >
              Print PDF
            </Button>
            {!isCancelled && canWriteDo && (
              <Button
                variant="danger"
                icon={<XCircle size={14} />}
                onClick={doCancel}
              >
                Cancel DO
              </Button>
            )}
            {/* Ops-lead exception power (scm.do.revert): undo a wrong scan or an
                accidental dispatch. Shown only when a revert is legal (LOADED or
                DISPATCHED); the server re-checks the capability and the rules. */}
            {canRevertDelivery(user) && revertPlan && (
              <Button
                variant="secondary"
                icon={<Undo2 size={14} />}
                onClick={doRevert}
                disabled={revert.isPending}
              >
                {revertPlan.label}
              </Button>
            )}
            {/* ── The two status-driven controls. BOTH ARE ALWAYS RENDERED for
                anyone who may operate a DO — disabled when the state forbids
                them, never removed, and each carrying the sentence that says
                why and what to do instead.

                Owner, 2026-08-18, holding one delivery order from each company
                side by side: "一个公司显示 Transfer to Sales Invoice，另一个公司
                却是 Mark signed，这不是同一个系统会统一的东西来的吗？我又不是两套
                系统." The code was correct — the two documents differed only in
                STATUS — but the transfer was not shown as unavailable, it was
                not shown at all, so from the second seat the product simply did
                not have the feature. Absence is not a message.

                The ADVANCE slot keeps one job (move THIS document along) and the
                TRANSFER slot keeps one job (produce the NEXT document), so the
                green button in this corner never changes meaning between two
                documents. That is the other half of the complaint: the operator
                should not have to read a status badge to learn what the primary
                button will do. ── */}
            {canWriteDo && advanceStep && (
              <Button
                variant="secondary"
                icon={<CheckCircle2 size={14} />}
                onClick={doAdvance}
              >
                {advanceStep.label}
              </Button>
            )}
            {/* The transfer takes the PRIMARY slot; the advance above stays
                secondary because it changes THIS document's own status rather
                than producing the next document (owner rule, 2026-08-17). */}
            {canWriteDo && (
              <Button
                variant="primary"
                icon={<Receipt size={14} />}
                onClick={goConvertToSi}
                disabled={!canConvertToSi}
                title={siReason ?? undefined}
                aria-describedby={siReason ? "do-si-reason" : undefined}
              >
                {transferToLabel('si')}
              </Button>
            )}
            {canWriteDo && (
              <Button
                variant="primary"
                icon={<Edit3 size={14} />}
                onClick={goEdit}
              >
                Edit
              </Button>
            )}
          </div>
          {/* The reasons, as TEXT. A `title` tooltip needs a hover and would
              have said nothing on a touch screen — and the ids below are what
              the disabled buttons point at with aria-describedby. */}
          {canWriteDo && (
            <div className="flex max-w-[420px] flex-col items-end gap-0.5 text-right">
              <NextStepNote id="do-advance-reason" reason={advanceReason} />
              <NextStepNote id="do-si-reason" reason={siReason} />
            </div>
          )}
          </div>
        </div>
      </div>

      {/* ─── Detail body ────────────────────────────────────────────── */}
      <div className="py-5">
        {/* Mobile-only Delivery status hero */}
        <div className="mb-3 rounded-lg border border-border bg-surface p-4 shadow-stone md:hidden">
          <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
            Delivery status
          </div>
          <div className="mt-1 font-display text-[22px] font-bold leading-tight text-ink">
            {EFFECTIVE_TONE[effectiveOf(deliveryOrder)].label}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-muted">
            <span>
              {deliveryOrder.customer_delivery_date
                ? `Scheduled ${fmtDate(deliveryOrder.customer_delivery_date)}`
                : deliveryOrder.expected_delivery_at
                  ? `Expected ${fmtDate(deliveryOrder.expected_delivery_at)}`
                  : "Not scheduled"}
            </span>
            <span>· {totalQty} items</span>
            {deliveryOrder.sales_location && (
              <span>· {deliveryOrder.sales_location}</span>
            )}
          </div>
        </div>

        <DetailGrid>
          <DetailMain>
            {/* Customer info — Customer SO No. first, per design */}
            <Section title="Customer info">
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
                <Field
                  label="Customer SO No."
                  value={soOf(deliveryOrder)}
                  mono={soOf(deliveryOrder) !== "—"}
                  accent={soOf(deliveryOrder) !== "—"}
                  muted={soOf(deliveryOrder) === "—"}
                />
                <Field
                  label="Customer name"
                  value={deliveryOrder.debtor_name || "—"}
                />
                <Field
                  label="Customer SO ref"
                  value={refOf(deliveryOrder)}
                  mono={refOf(deliveryOrder) !== "—"}
                  accent={refOf(deliveryOrder) !== "—"}
                  muted={refOf(deliveryOrder) === "—"}
                />
                <Field
                  label="Phone"
                  value={formatPhone(deliveryOrder.phone) || "Not provided"}
                  muted={!deliveryOrder.phone}
                  mono={!!deliveryOrder.phone}
                />
                <Field
                  label="Email"
                  value={deliveryOrder.email || "Not provided"}
                  muted={!deliveryOrder.email}
                />
                <Field
                  label="Customer type"
                  value={deliveryOrder.customer_type || "—"}
                  muted={!deliveryOrder.customer_type}
                />
                <Field
                  label="Salesperson"
                  value={
                    deliveryOrder.salesperson_name ||
                    salespersonNameOf(
                      deliveryOrder.agent,
                      deliveryOrder.salesperson_id,
                      "Unassigned"
                    )
                  }
                  muted={
                    !deliveryOrder.agent &&
                    !deliveryOrder.salesperson_name &&
                    !deliveryOrder.salesperson_id
                  }
                />
                <Field
                  label="Branding"
                  value={brandOf(deliveryOrder)}
                  muted={brandOf(deliveryOrder) === "—"}
                />
                <Field
                  label="Building / venue"
                  value={
                    [deliveryOrder.building_type, deliveryOrder.venue]
                      .filter(Boolean)
                      .join(" · ") || "—"
                  }
                  muted={!deliveryOrder.building_type && !deliveryOrder.venue}
                />
              </div>
            </Section>

            {/* Delivery address + Emergency contact */}
            <Section title="Delivery address">
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-[1.4fr_1fr] sm:divide-x sm:divide-border-subtle">
                <div className="sm:pr-6">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                    Ship to
                  </div>
                  <div className="mt-1.5 text-[14px] font-semibold leading-relaxed text-ink">
                    {shipTo(deliveryOrder).length > 0 ? (
                      shipTo(deliveryOrder).map((line, i) => (
                        <div key={i}>{line}</div>
                      ))
                    ) : (
                      <span className="text-ink-muted">Not provided</span>
                    )}
                  </div>
                  {deliveryOrder.sales_location && (
                    <div className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary-soft px-2.5 py-1 text-[11.5px] font-semibold text-primary-ink">
                      <Warehouse size={12} />
                      {deliveryOrder.sales_location}
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
                  <div className="mt-2.5 text-[14px] font-semibold text-ink">
                    {deliveryOrder.emergency_contact_name ||
                      deliveryOrder.emergency_contact_phone ||
                      "Not provided"}
                  </div>
                  {deliveryOrder.emergency_contact_phone && (
                    <div className="mt-1 font-mono text-[12.5px] text-ink-secondary">
                      {formatPhone(deliveryOrder.emergency_contact_phone)}
                    </div>
                  )}
                  {deliveryOrder.emergency_contact_relationship && (
                    <div className="mt-1 text-[12px] text-ink-muted">
                      {deliveryOrder.emergency_contact_relationship}
                    </div>
                  )}
                </div>
              </div>
            </Section>

            {/* Delivery info (with embedded Driver sub-card) */}
            <Section title="Delivery info">
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
                <Field label="DO date" value={fmtDate(deliveryOrder.do_date)} />
                <Field
                  label="Expected delivery"
                  value={fmtDate(deliveryOrder.expected_delivery_at)}
                  muted={!deliveryOrder.expected_delivery_at}
                />
                <Field
                  label="Customer delivery date"
                  value={
                    deliveryOrder.customer_delivery_date
                      ? fmtDate(deliveryOrder.customer_delivery_date)
                      : "Not scheduled"
                  }
                  muted={!deliveryOrder.customer_delivery_date}
                />
              </div>

              {/* Driver sub-card — moved into Delivery info per the new design */}
              <DriverSubCard header={deliveryOrder} />

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

            {/* Line items */}
            <Section
              title={`Line items · ${items.length}`}
              actions={
                <span className="text-[11.5px] text-ink-muted">
                  Delivery quantities — no pricing
                </span>
              }
            >
              <DataTable<DoItem>
                tableId={`do-lines-${id}`}
                layoutFamily={DATA_TABLE_LAYOUT_FAMILIES.deliveryOrderLines}
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
              <DeliveryStatusCard header={deliveryOrder} totalQty={totalQty} />

              {/* Owner 2026-07-17: Totals·Margin (Revenue/Cost/Margin) card
                  removed from the DO document view for EVERYONE — costing moves
                  to the separate Finance "Fulfillment Costing" module. */}

              <SourceRackCard
                items={items}
                doId={deliveryOrder.id}
                locked={(DO_SHIPPED_STATES as readonly string[]).some((s) => s.toLowerCase() === rawStatus)}
                notify={notify}
              />

              <AsideCard title="Key dates">
                <KeyDateRow k="DO date" v={fmtDate(deliveryOrder.do_date)} />
                <KeyDateRow
                  k="Scheduled"
                  v={
                    deliveryOrder.customer_delivery_date
                      ? fmtDate(deliveryOrder.customer_delivery_date)
                      : deliveryOrder.expected_delivery_at
                        ? fmtDate(deliveryOrder.expected_delivery_at)
                        : "Not set"
                  }
                  muted={
                    !deliveryOrder.customer_delivery_date &&
                    !deliveryOrder.expected_delivery_at
                  }
                />
                <KeyDateRow
                  k="Delivered"
                  v={effectiveOf(deliveryOrder) === "shipped" ? "Pending" : EFFECTIVE_TONE[effectiveOf(deliveryOrder)].label}
                  muted={effectiveOf(deliveryOrder) === "shipped" || effectiveOf(deliveryOrder) === "draft"}
                />
              </AsideCard>

              <AsideCard title="People">
                <PersonRow
                  initials={
                    deliveryOrder.driver_name
                      ? initialsOf(deliveryOrder.driver_name)
                      : "?"
                  }
                  name={deliveryOrder.driver_name || "Driver"}
                  role={
                    deliveryOrder.driver_name
                      ? `Driver${deliveryOrder.vehicle ? ` · ${deliveryOrder.vehicle}` : ""}`
                      : "Not yet assigned"
                  }
                  tone={deliveryOrder.driver_name ? "accent" : "neutral"}
                />
                <PersonRow
                  initials={initialsOf(
                    deliveryOrder.issued_by_name ||
                      deliveryOrder.issued_by_name ||
                      deliveryOrder.salesperson_name ||
                      salespersonNameOf(
                        deliveryOrder.agent,
                        deliveryOrder.salesperson_id,
                        ""
                      )
                  )}
                  name={
                    deliveryOrder.issued_by_name ||
                    deliveryOrder.salesperson_name ||
                    salespersonNameOf(
                      deliveryOrder.agent,
                      deliveryOrder.salesperson_id,
                      "Issued by"
                    )
                  }
                  role={
                    deliveryOrder.issued_by_name
                      ? "Issued by"
                      : deliveryOrder.agent || deliveryOrder.salesperson_id
                        ? "Salesperson"
                        : "Not recorded"
                  }
                  tone="neutral"
                />
              </AsideCard>

              {/* Recent activity — synthesized from the header's status +
                  origin info (same source as the History modal; no new
                  fetch), mirroring SalesOrderDetailV2's aside card. */}
              <AsideCard title="Recent activity">
                <ActivityRow
                  title={`Status · ${EFFECTIVE_TONE[effectiveOf(deliveryOrder)].label}`}
                  meta={fmtDate(deliveryOrder.do_date)}
                  dot={
                    EFFECTIVE_TONE[effectiveOf(deliveryOrder)].tone === "success"
                      ? "success"
                      : EFFECTIVE_TONE[effectiveOf(deliveryOrder)].tone === "error"
                        ? "muted"
                        : "primary"
                  }
                />
                {deliveryOrder.customer_delivery_date && (
                  <ActivityRow
                    title={`Delivery scheduled ${fmtDate(deliveryOrder.customer_delivery_date)}`}
                    meta={fmtDate(deliveryOrder.do_date)}
                    dot="primary"
                  />
                )}
                <ActivityRow
                  title={
                    deliveryOrder.so_doc_no
                      ? `Created from ${deliveryOrder.so_doc_no}`
                      : "Created"
                  }
                  meta={`${fmtDate(deliveryOrder.created_at || deliveryOrder.do_date)}${
                    deliveryOrder.issued_by_name
                      ? ` · ${deliveryOrder.issued_by_name}`
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

      {/* Fixed bottom action bar (phone only).

          THE SAME TWO CONTROLS AS THE DESKTOP HEADER, and for the same reason.
          This bar used to carry Edit / Print / Call and nothing else: at phone
          width this page offered no next step at ANY status — not even a
          disabled one — so a storeman looking at a signed delivery order saw a
          finished document and the Sales Invoice was never raised. A fix that
          lands on one breakpoint of one page reproduces exactly the defect it
          was written to end, which is how DateField came to be wired into 14 of
          189 date inputs. The reason renders as TEXT here because a `title`
          tooltip cannot be summoned on a touch screen. */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 px-3 pb-6 pt-2.5 shadow-slab backdrop-blur-sm md:hidden">
        {canWriteDo && (
          <div className="mb-1.5 flex flex-col gap-0.5">
            <NextStepNote id="do-advance-reason-phone" reason={advanceReason} />
            <NextStepNote id="do-si-reason-phone" reason={siReason} />
          </div>
        )}
        {canWriteDo && (
          <div className="mb-2 flex items-center gap-2">
            {advanceStep && (
            <button
              type="button"
              onClick={doAdvance}
              className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface text-[13.5px] font-bold text-ink hover:bg-surface-dim"
            >
              <CheckCircle2 size={16} /> {advanceStep.label}
            </button>
            )}
            <button
              type="button"
              onClick={goConvertToSi}
              disabled={!canConvertToSi}
              aria-describedby={siReason ? "do-si-reason-phone" : undefined}
              className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary text-[13.5px] font-bold text-white shadow-sm hover:bg-primary-ink disabled:bg-primary/40"
            >
              <Receipt size={16} /> {transferToLabel('si')}
            </button>
          </div>
        )}
        <div className="flex items-center gap-2">
          {canWriteDo && (
            <button
              type="button"
              onClick={goEdit}
              className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface text-[13.5px] font-bold text-ink hover:bg-surface-dim"
            >
              <Edit3 size={16} /> Edit
            </button>
          )}
          <button
            type="button"
            onClick={() => setModal("print")}
            className={cn(
              "inline-flex h-11 items-center justify-center gap-1.5 rounded-lg bg-surface-2 text-primary-ink hover:bg-primary-soft",
              canWriteDo ? "w-11" : "flex-1 text-[13.5px] font-bold"
            )}
            aria-label="Print PDF"
          >
            <Printer size={17} />
            {!canWriteDo && <span>Print PDF</span>}
          </button>
          <button
            type="button"
            onClick={goCall}
            disabled={!deliveryOrder.phone}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-surface-2 text-primary-ink hover:bg-primary-soft disabled:opacity-40"
            aria-label={
              deliveryOrder.phone
                ? `Call ${deliveryOrder.phone}`
                : "No phone on file"
            }
          >
            <PhoneIcon size={17} />
          </button>
        </div>
      </div>

      {/* Modals */}
      <HistoryModal
        open={modal === "history"}
        onClose={closeModal}
        header={deliveryOrder}
        itemsCount={items.length}
      />
      <DocumentRelationshipMapModal
        open={modal === "relmap"}
        onClose={closeModal}
        nodes={chainNodes}
        onNodeClick={(n) => {
          // The hook returns TRUE when the click navigated away, so the map
          // closes; an in-app notice keeps it open (renders over the map).
          if (onChainNodeClick(n)) closeModal();
        }}
      />
      {/* A chain slot standing for several documents opens this chooser instead
          of a notice that only named them. Picking a row navigates, so the map
          closes with it. */}
      <DocumentChoiceDialog
        prompt={chainChoice}
        onClose={closeChainChoice}
        onPick={(d) => {
          closeModal();
          pickChainChoice(d);
        }}
      />
      <PrintPreviewModal
        open={modal === "print"}
        onClose={closeModal}
        docTitle="Delivery Order"
        docNo={deliveryOrder.do_number}
        rows={printRows}
        onViewPdf={() => doDeliverPdf("preview")}
        onPrint={() => doDeliverPdf("print")}
        onDownload={() => doDeliverPdf("save")}
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

export default DeliveryOrderDetailV2;
