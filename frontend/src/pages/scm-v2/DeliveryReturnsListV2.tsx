// DeliveryReturnsListV2 — Theme C redesign of the Delivery Returns listing.
// Third + final piece of the three-headed sales chain sweep (SO/DO/SI/DR):
// same PageHeader + StatCard + FilterPills + Table/Cards + right slide-over
// drawer template as MfgDeliveryOrdersListV2 / SalesInvoicesListV2. Data is
// the vendored delivery-return-queries slice, unchanged. See the DO V2 file
// for the deep dive on primitives + Theme C conventions.
//
// Route: /scm/delivery-returns (App.tsx flips ScmDeliveryReturnsV2 here).
//
// A Delivery Return = goods coming BACK from the customer → creating one
// INCREASES stock server-side. Money moves OUT of the business, so the
// chrome leans hard on that: the money stat card + drawer totals both use
// the error tone to signal "refund pending" versus the DO/SI green-when-good
// idiom. Return-reason is promoted to a first-class table column and a
// prominent meta row in the drawer — it's the field ops actually cares
// about when triaging a return.

import { useMemo, useState, type ReactNode } from "react";
import { brandingToneForLabel } from "../../lib/brandingTone";
import { transferFromLabel, transferFromColumnLabel } from "../../lib/convertScope";
import { canViewScmCosting } from "../../auth/salesAccess";
import { useNavigate, useSearchParams } from "react-router-dom";
import { buildVariantSummary, fmtSen, fmtDate, orderLineIdentity } from "@2990s/shared";
import { formatPhone } from "@2990s/shared/phone";
import {
  Plus,
  ChevronDown,
  Truck,
  Receipt,
  LayoutGrid,
  Table as TableIcon,
  X as XIcon,
  ExternalLink,
  Edit3,
  Printer,
  ClipboardCheck,
  CheckCircle2,
  RotateCcw,
  ArrowRightLeft,
} from "lucide-react";
import { PrintPreviewBatchModal, usePrintPreview } from "../../components/scm-v2/PrintPreviewModal";
import type { PdfAction } from "../../vendor/scm/lib/pdf-common";
import { PageHeader } from "../../components/Layout";
import { StatCard } from "../../components/StatCard";
import { FilterPills } from "../../components/FilterPills";
import { DataTable, type Column } from "../../components/DataTable";
import {
  DocumentLinesExpansion,
  type DocumentDrillLine,
  type DrillItemFields,
} from "../../components/DocumentLinesExpansion";
import { SearchScopeHint } from "../../components/SearchScopeHint";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { PullToRefresh } from "../../components/PullToRefresh";
import { useStaffLookup } from "../../hooks/useStaffLookup";
import {
  useDeliveryReturns,
  useDeliveryReturnDetail,
  useUpdateDeliveryReturnStatus,
} from "../../vendor/scm/lib/delivery-return-queries";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { useChoice } from "../../vendor/scm/components/ChoiceDialog";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "../../lib/utils";
import { ResizableDetailDrawer } from "../../components/ResizableDetailDrawer";
import { useAuth } from "../../auth/AuthContext";
import { deliveryReturnRowMenu } from "./row-menus";
import { usePrintDocument } from "../../components/scm-v2/PrintChainProvider";
import { deliveryReturnPrintChain } from "../../lib/printChain";
import { deliveryReturnPdfBundle } from "../../lib/printDocumentPdf";

// ─── Types ──────────────────────────────────────────────────────────────────
// Subset of the DR header (see DeliveryReturnsList.tsx for the full 40-field
// row). Fields not listed still exist on the API payload — V2 just doesn't
// render them.

type DrRow = {
  id: string;
  return_number: string;
  do_doc_no: string | null;
  delivery_order_id: string | null;
  /** Convert-from relation (display-only, audit R8): the Sales Order behind this
   *  return's DO, server-resolved via delivery_order_id → delivery_orders. */
  so_doc_no?: string | null;
  return_date: string;
  debtor_name: string;
  debtor_code: string | null;
  salesperson_id: string | null;
  sales_location: string | null;
  customer_so_no: string | null;
  ref: string | null;
  branding: string | null;
  venue: string | null;
  reason: string | null;
  phone: string | null;
  email: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  customer_state: string | null;
  status: string;
  currency: string;
  local_total_sen: number;
  line_count?: number;
  note: string | null;
  // ── Phase 2: NON-finance fields already on the DR list payload (HEADER).
  //    (venue + note are declared above from Phase 1.)
  customer_type: string | null;
  building_type: string | null;
  // ── Phase 2 FINANCE: backend OMITS these keys for non-finance callers
  //    (canViewScmFinance), so each is optional. The DR header carries FOUR
  //    categories (no service_*). margin_pct_basis = basis points.
  mattress_sofa_sen?: number;
  bedframe_sen?: number;
  accessories_sen?: number;
  others_sen?: number;
  mattress_sofa_cost_sen?: number;
  bedframe_cost_sen?: number;
  accessories_cost_sen?: number;
  others_cost_sen?: number;
  total_cost_sen?: number;
  total_margin_sen?: number;
  margin_pct_basis?: number;
};

type StatusTab = "all" | "open" | "inspected" | "refunded" | "cancelled";

// ─── Helpers ────────────────────────────────────────────────────────────────

const fmtRm = (centi: number): string => fmtSen(centi);

// margin_pct_basis is basis points (margin/total x 10000) → percent string.
const fmtPctBasis = (basis: number | null | undefined): string =>
  basis == null ? "—" : `${(basis / 100).toFixed(1)}%`;

// Customer's PO / Ref. Same fallback chain as SO / DO V2.
const refOf = (r: DrRow): string => r.customer_so_no || r.ref || "—";

const doOf = (r: DrRow): string => r.do_doc_no || "—";

const brandOf = (r: DrRow): string => r.branding || "—";
/* Colour says WHAT THE LINE IS; the label says whose brand it is.
   ../../lib/brandingTone is the one home for both. This copy had also lost
   the BEDFRAME arm — a THIRD spelling across the five lists. */
const brandTone = brandingToneForLabel;

// DR status flow: PENDING → RECEIVED (goods back, stock IN) → INSPECTED →
// REFUNDED / CREDIT_NOTED, plus REJECTED / CANCELLED. Compress into 4
// buckets for the pills; the row Badge still carries the raw stage label.
// The everyday chips finance / ops watch:
//   Open       = Pending + Received  (goods back, awaiting QC)
//   Inspected  = QC done, awaiting refund action
//   Refunded   = Refunded + Credit noted (loop closed)
//   Cancelled  = Rejected + Cancelled (loop closed unhappily)
const STATUS_TONE: Record<
  string,
  { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab }
> = {
  pending:      { tone: "warning", label: "Pending",      bucket: "open" },
  received:     { tone: "warning", label: "Received",     bucket: "open" },
  inspected:    { tone: "warning", label: "Inspected",    bucket: "inspected" },
  refunded:     { tone: "success", label: "Refunded",     bucket: "refunded" },
  credit_noted: { tone: "success", label: "Credit noted", bucket: "refunded" },
  rejected:     { tone: "error",   label: "Rejected",     bucket: "cancelled" },
  cancelled:    { tone: "error",   label: "Cancelled",    bucket: "cancelled" },
};

const statusFor = (
  s: string
): { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab } =>
  STATUS_TONE[(s || "").toLowerCase()] ?? {
    tone: "neutral",
    label: s || "—",
    bucket: "open",
  };

// ─── Split-menu dropdown (mirrors DO V2) ───────────────────────────────────

function SplitDropdown({
  onFromDo,
  onImport,
  onDuplicate,
}: {
  onFromDo: () => void;
  onImport: () => void;
  onDuplicate: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-9 items-center rounded-md border border-primary/60 bg-primary/10 px-2.5 text-primary hover:bg-primary/20"
      >
        <ChevronDown size={14} />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-[80]"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            role="menu"
            className="absolute right-0 top-full z-[81] mt-1.5 min-w-[220px] rounded-md border border-border bg-surface py-1 shadow-slab"
          >
            <button
              type="button"
              className="block w-full px-3.5 py-2 text-left text-[12.5px] text-ink hover:bg-primary-soft"
              onClick={() => {
                setOpen(false);
                onFromDo();
              }}
            >
              New from Delivery Order
            </button>
            <button
              type="button"
              className="block w-full px-3.5 py-2 text-left text-[12.5px] text-ink hover:bg-primary-soft"
              onClick={() => {
                setOpen(false);
                onImport();
              }}
            >
              Import from file
            </button>
            <button
              type="button"
              className="block w-full px-3.5 py-2 text-left text-[12.5px] text-ink hover:bg-primary-soft"
              onClick={() => {
                setOpen(false);
                onDuplicate();
              }}
            >
              Duplicate last return
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ViewToggle({
  value,
  onChange,
}: {
  value: "table" | "cards";
  onChange: (v: "table" | "cards") => void;
}) {
  const btn = (which: "table" | "cards", label: string, Icon: typeof TableIcon) => {
    const active = value === which;
    return (
      <button
        type="button"
        onClick={() => onChange(which)}
        aria-pressed={active}
        className={cn(
          "inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors",
          active
            ? "bg-primary text-white shadow-sm"
            : "text-ink-secondary hover:bg-primary-soft hover:text-primary"
        )}
      >
        <Icon size={13} />
        {label}
      </button>
    );
  };
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-border bg-surface p-1 shadow-stone">
      {btn("table", "Table", TableIcon)}
      {btn("cards", "Cards", LayoutGrid)}
    </div>
  );
}

// ─── Cards grid (shared shape with DO V2 — DR shows reason + refund) ───────

function CardsGrid({ rows, onOpen }: { rows: DrRow[]; onOpen: (r: DrRow) => void }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-16 text-center shadow-stone">
        <div className="text-[13px] font-semibold text-ink">No delivery returns</div>
        <div className="mt-1 text-[12px] text-ink-muted">
          No returns match the current filters. Try Reset layout to clear the
          search and status tabs.
        </div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {rows.map((r) => {
        const st = statusFor(r.status);
        const brand = brandOf(r);
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpen(r)}
            className="group relative overflow-hidden rounded-lg border border-border bg-surface px-4 py-4 text-left shadow-stone transition-all duration-200 hover:-translate-y-px hover:border-primary/40 hover:shadow-slab focus:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-docno text-[12.5px] font-semibold text-ink">
                {r.return_number}
              </span>
              <Badge tone={st.tone} size="xs">{st.label}</Badge>
            </div>
            <div className="mt-2 truncate text-[15px] font-semibold text-ink">
              {r.debtor_name || "—"}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <Badge tone={brandTone(brand)} variant="soft" size="xs">
                {brand}
              </Badge>
              <span className="text-[11.5px] text-ink-muted">{fmtDate(r.return_date)}</span>
            </div>
            {r.reason && (
              <div className="mt-2.5 truncate text-[12.5px] italic text-ink-secondary">
                “{r.reason}”
              </div>
            )}
            <div className="mt-3.5 flex items-end justify-between border-t border-border-subtle pt-3">
              <div className="min-w-0">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  {transferFromColumnLabel('do')}
                </div>
                <div className="mt-0.5 truncate font-mono text-[12px] font-semibold text-ink-secondary">
                  {doOf(r)}
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  Refund
                </div>
                <div className="mt-0.5 font-money text-[15px] font-bold text-err">
                  {fmtRm(r.local_total_sen)}
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Detail drawer ─────────────────────────────────────────────────────────

function DetailDrawer({
  row,
  onClose,
  onOpenFull,
  onEdit,
  onPrint,
  onMarkInspected,
  onMarkRefunded,
  onReopen,
  salespersonName,
}: {
  row: DrRow | null;
  onClose: () => void;
  onOpenFull: () => void;
  onEdit: () => void;
  onPrint: () => void;
  onMarkInspected: () => void;
  onMarkRefunded: () => void;
  onReopen: () => void;
  salespersonName: string;
}) {
  const detailQ = useDeliveryReturnDetail(row?.id ?? null);
  const items: Array<{
    item_code?: string | null;
    description?: string | null;
    description2?: string | null;
    item_group?: string | null;
    variants?: Record<string, unknown> | null;
    qty_returned?: number | null;
    condition?: string | null;
    unit_price_sen?: number | null;
    line_total_sen?: number | null;
  }> =
    ((detailQ.data as { items?: unknown[] } | undefined)?.items as Array<{
      item_code?: string | null;
      description?: string | null;
      description2?: string | null;
      item_group?: string | null;
      variants?: Record<string, unknown> | null;
      qty_returned?: number | null;
      condition?: string | null;
      unit_price_sen?: number | null;
      line_total_sen?: number | null;
    }>) ?? [];

  const open = !!row;
  const st = row ? statusFor(row.status) : null;

  const totalSen = row?.local_total_sen ?? 0;

  return (
    <ResizableDetailDrawer
      open={open}
      onClose={onClose}
      ariaLabel={row ? `Delivery return ${row.return_number}` : "Delivery return details"}
    >
        {row && st && (
          <>
            <div className="flex h-[60px] shrink-0 items-center gap-3 bg-sidebar px-5 text-sidebar-ink">
              <button
                type="button"
                onClick={onClose}
                className="text-sidebar-ink-muted hover:text-sidebar-ink"
                aria-label="Close details"
              >
                <XIcon size={18} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[14px] font-bold tracking-wide">
                  {row.return_number}
                </div>
                <div className="mt-0.5 text-[11px] text-sidebar-ink-muted">Delivery Return</div>
              </div>
              <button
                type="button"
                onClick={onOpenFull}
                className="inline-flex items-center gap-1.5 rounded-md border border-accent-bright/40 px-2.5 py-1.5 text-[11.5px] font-semibold text-accent-bright hover:bg-accent-bright/10"
              >
                Open full page <ExternalLink size={12} />
              </button>
              <Badge tone={st.tone} variant="solid" size="xs">
                {st.label}
              </Badge>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5">
              <div className="text-[19px] font-bold text-ink">{row.debtor_name || "—"}</div>
              <div className="mt-1.5 flex items-center gap-2.5">
                <Badge tone={brandTone(brandOf(row))} variant="soft" size="xs">
                  {brandOf(row)}
                </Badge>
                <span className="text-[12.5px] text-ink-muted">
                  Returned {fmtDate(row.return_date)}
                </span>
              </div>

              {/* Reason banner — DR's most distinctive field, pulled out
                  above the meta grid so triage doesn't have to scan for it. */}
              {row.reason && (
                <div className="mt-4 rounded-lg border-l-4 border-err bg-err-soft px-4 py-3">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                    Return reason
                  </div>
                  <div className="mt-1 text-[13.5px] font-semibold italic text-ink">
                    “{row.reason}”
                  </div>
                </div>
              )}

              <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2 px-4 py-4">
                <MetaItem k={transferFromColumnLabel('do')} v={doOf(row)} mono />
                <MetaItem k="Customer ref" v={refOf(row)} mono />
                <MetaItem k="Location" v={row.sales_location || "—"} />
                <MetaItem k="Salesperson" v={salespersonName} />
                <MetaItem k="Venue" v={row.venue || "—"} />
                <MetaItem k="Line count" v={row.line_count ?? "—"} />
              </dl>

              <SectionHeading>Customer</SectionHeading>
              <div className="overflow-hidden rounded-lg border border-border bg-surface">
                <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3.5">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[13px] font-bold text-accent-ink">
                    {(row.debtor_name || "C")
                      .split(/\s+/)
                      .filter(Boolean)
                      .slice(0, 2)
                      .map((w) => w[0]?.toUpperCase())
                      .join("") || "C"}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[14px] font-bold text-ink">{row.debtor_name}</div>
                    {row.debtor_code && (
                      <div className="mt-0.5 font-mono text-[11.5px] text-ink-muted">
                        {row.debtor_code}
                      </div>
                    )}
                  </div>
                </div>
                <RowKV k="Phone" v={formatPhone(row.phone) || "—"} />
                <RowKV k="Email" v={row.email || "—"} />
                <RowKV
                  k="Address"
                  v={
                    [row.address1, row.address2, row.city, row.postcode, row.customer_state]
                      .filter(Boolean)
                      .join(", ") || "—"
                  }
                />
              </div>

              <SectionHeading>Returned items</SectionHeading>
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="grid grid-cols-[1fr_52px_82px_92px] gap-2 border-b border-border-subtle bg-surface-2 px-4 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  <span>Item</span>
                  <span className="text-right">Qty</span>
                  <span className="text-right">Unit</span>
                  <span className="text-right">Refund</span>
                </div>
                {detailQ.isLoading && (
                  <div className="px-4 py-8 text-center text-[12px] text-ink-muted">
                    Loading lines…
                  </div>
                )}
                {!detailQ.isLoading && items.length === 0 && (
                  <div className="px-4 py-8 text-center text-[12px] text-ink-muted">
                    No lines
                  </div>
                )}
                {items.map((l, i) => {
                  const amt =
                    l.line_total_sen ??
                    (l.qty_returned ?? 0) * (l.unit_price_sen ?? 0);
                  const { primary, secondary } = orderLineIdentity({
                    code: l.item_code,
                    description: l.description,
                    variant:
                      buildVariantSummary(l.item_group ?? "others", l.variants ?? null) ||
                      (l.description2 ?? ""),
                  });
                  return (
                    <div
                      key={i}
                      className="grid grid-cols-[1fr_52px_82px_92px] items-start gap-2 border-b border-border-subtle px-4 py-3 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <div className="text-[12.5px] font-medium leading-snug text-ink">
                          {primary || "—"}
                        </div>
                        {secondary && (
                          <div className="mt-0.5 text-[11.5px] leading-snug text-ink-secondary">
                            {secondary}
                          </div>
                        )}
                        {l.condition && (
                          <div className="mt-0.5 flex items-center gap-2">
                            <Badge tone="warning" variant="soft" size="xs">
                              {l.condition}
                            </Badge>
                          </div>
                        )}
                      </div>
                      <span className="text-right font-money text-[12.5px] text-ink-secondary">
                        {l.qty_returned ?? 0}
                      </span>
                      <span className="text-right font-money text-[12.5px] text-ink-secondary">
                        {fmtRm(l.unit_price_sen ?? 0)}
                      </span>
                      <span className="text-right font-money text-[12.5px] font-semibold text-err">
                        {fmtRm(amt)}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Refund total — err-tinted since money leaves the biz. */}
              <div className="mt-4 rounded-lg border-l-4 border-err bg-err-soft px-5 py-4">
                <TotalRow k="Refund total" v={fmtRm(totalSen)} strong tone="err" />
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-5 py-3">
              <Button variant="ghost" icon={<Edit3 size={14} />} onClick={onEdit}>
                Edit
              </Button>
              <Button variant="ghost" icon={<Printer size={14} />} onClick={onPrint}>
                Print
              </Button>
              <div className="flex-1" />
              {(() => {
                const s = (row.status || "").toLowerCase();
                if (["pending", "received"].includes(s)) {
                  return (
                    <Button
                      variant="primary"
                      icon={<ClipboardCheck size={14} />}
                      onClick={onMarkInspected}
                    >
                      Mark inspected
                    </Button>
                  );
                }
                if (s === "inspected") {
                  return (
                    <Button
                      variant="primary"
                      icon={<CheckCircle2 size={14} />}
                      onClick={onMarkRefunded}
                    >
                      Mark refunded
                    </Button>
                  );
                }
                // Reopen a cancelled return back to RECEIVED (2990
                // DeliveryReturnsList "Reopen Return" parity).
                if (s === "cancelled" || s === "cancel") {
                  return (
                    <Button
                      variant="primary"
                      icon={<RotateCcw size={14} />}
                      onClick={onReopen}
                    >
                      Reopen
                    </Button>
                  );
                }
                return null;
              })()}
            </div>
          </>
        )}
    </ResizableDetailDrawer>
  );
}

function MetaItem({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
        {k}
      </dt>
      <dd
        className={cn(
          "mt-0.5 text-[13px] font-semibold text-ink",
          mono && "font-mono"
        )}
      >
        {v}
      </dd>
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2.5 mt-6 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
      {children}
    </div>
  );
}

function RowKV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-border-subtle px-4 py-2.5 last:border-b-0">
      <span className="w-20 shrink-0 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
        {k}
      </span>
      <span className="flex-1 text-[13px] font-semibold leading-relaxed text-ink">
        {v}
      </span>
    </div>
  );
}

function TotalRow({
  k,
  v,
  strong,
  tone,
}: {
  k: string;
  v: string;
  strong?: boolean;
  tone?: "err";
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span
        className={cn(
          "text-[12px] text-ink-muted",
          strong && "text-[13px] font-semibold text-ink"
        )}
      >
        {k}
      </span>
      <span
        className={cn(
          "font-money text-[13px] font-semibold",
          strong && "text-[15px] font-bold",
          tone === "err" ? "text-err" : "text-ink"
        )}
      >
        {v}
      </span>
    </div>
  );
}

// ─── Row drill-down (DataTable `expandable`) ──────────────────────────────────
// Inline per-line breakdown for one DR, lazy-fetched via the SAME
// useDeliveryReturnDetail hook the drawer uses (TanStack-cached). Group + item
// code/variant + Qty (returned) + Amount, via the shared DocumentLinesExpansion.
// A delivery return is a sales-side doc but its detail payload carries no
// per-line MRP coverage (that rides the SO detail, not this one), so the
// SO/DO-only Stock + Incoming PO columns are absent.
function DrLinesExpansion({ id }: { id: string }) {
  const detailQ = useDeliveryReturnDetail(id);
  const items =
    ((detailQ.data as { items?: DrillItemFields[] } | undefined)?.items ?? []);
  const lines: DocumentDrillLine[] = items.map((l) => ({
    itemGroup: l.item_group ?? null,
    code: l.item_code ?? null,
    description: l.description ?? null,
    description2: l.description2 ?? null,
    variants: l.variants ?? null,
    qty: Number(l.qty_returned ?? 0),
    amountSen:
      l.line_total_sen ??
      Number(l.qty_returned ?? 0) * (l.unit_price_sen ?? 0),
  }));
  return (
    <DocumentLinesExpansion
      isLoading={detailQ.isLoading}
      coverage="ready" /* one query fills this drill-down — coverage-state.tsx */
      isError={Boolean(detailQ.error)}
      errorMessage={detailQ.error instanceof Error ? detailQ.error.message : null}
      lines={lines}
      emptyLabel="No lines on this delivery return."
    />
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export function DeliveryReturnsListV2() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const notify = useNotify();
  const askChoice = useChoice();
  const askConfirm = useConfirm();
  const { nameOf: salespersonNameOf } = useStaffLookup();
  // Finance-viewer gate (auth/me = isFinanceViewer). Finance columns below are
  // DECLARED only for a finance-viewer; the backend also omits their keys from
  // the payload for everyone else (canViewScmFinance).
  const { user } = useAuth();
  const canFinance = canViewScmCosting(user);

  const status = (params.get("status") ?? "all") as StatusTab;
  const view = (params.get("view") ?? "table") as "table" | "cards";
  const search = params.get("q") ?? "";

  const [selected, setSelected] = useState<DrRow | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [printingDocs, setPrintingDocs] = useState(false);

  // The backend delivery-returns endpoint accepts a status arg but not our
  // compressed buckets — pull the full set and filter client-side (matches
  // the DO V2 pattern).
  const { data, isLoading, error } = useDeliveryReturns(undefined);
  // These tiles are reduces over a row set that is [] until the fetch lands (and
  // stays [] if it fails), so a settled-looking "Refund Value RM 0.00" would
  // describe a list nobody has read yet.
  const statsPending = isLoading || Boolean(error);
  const updateStatus = useUpdateDeliveryReturnStatus();

  const allRows = useMemo<DrRow[]>(
    () => ((data?.deliveryReturns ?? []) as DrRow[]),
    [data]
  );

  const scopedByBucket = useMemo(() => {
    if (status === "all") return allRows;
    return allRows.filter((r) => statusFor(r.status).bucket === status);
  }, [allRows, status]);

  const filtered = useMemo(() => {
    if (!search.trim()) return scopedByBucket;
    const q = search.toLowerCase();
    return scopedByBucket.filter((r) => {
      const hay = [
        r.return_number,
        r.do_doc_no,
        r.debtor_name,
        r.debtor_code,
        r.salesperson_id,
        refOf(r),
        r.branding,
        r.sales_location,
        r.reason,
        r.venue,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [scopedByBucket, search]);

  const counts = useMemo(() => {
    const acc = { all: allRows.length, open: 0, inspected: 0, refunded: 0, cancelled: 0 };
    for (const r of allRows) {
      const b = statusFor(r.status).bucket;
      if (b === "open") acc.open += 1;
      else if (b === "inspected") acc.inspected += 1;
      else if (b === "refunded") acc.refunded += 1;
      else if (b === "cancelled") acc.cancelled += 1;
    }
    return acc;
  }, [allRows]);

  // KPI stats — scoped to filtered rows. DR chrome leans money-out:
  //   Total returns · Refund value · Pending (open+inspected, needs action)
  //   Refunded (loop closed)
  const stats = useMemo(() => {
    let refundSen = 0;
    let pendingCount = 0;
    let refundedCount = 0;
    for (const r of filtered) {
      refundSen += r.local_total_sen ?? 0;
      const b = statusFor(r.status).bucket;
      if (b === "open" || b === "inspected") pendingCount += 1;
      if (b === "refunded") refundedCount += 1;
    }
    return {
      total: filtered.length,
      refundSen,
      pendingCount,
      refundedCount,
    };
  }, [filtered]);

  const setStatusChip = (s: StatusTab) => {
    const next = new URLSearchParams(params);
    if (s === "all") next.delete("status");
    else next.set("status", s);
    setParams(next, { replace: true });
  };
  const setView = (v: "table" | "cards") => {
    const next = new URLSearchParams(params);
    if (v === "table") next.delete("view");
    else next.set("view", v);
    setParams(next, { replace: true });
  };
  const setSearch = (q: string) => {
    const next = new URLSearchParams(params);
    if (!q.trim()) next.delete("q");
    else next.set("q", q);
    setParams(next, { replace: true });
  };
  const resetLayout = () => {
    setParams(new URLSearchParams(), { replace: true });
  };
  const filtersActive =
    status !== "all" || view !== "table" || search.trim().length > 0;

  const onPullToRefresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["delivery-returns"] });
  };

  // Wired actions
  const goNewDr = () => navigate("/scm/delivery-returns/new");
  const goFromDo = () => navigate("/scm/delivery-returns/from-do");
  const goImport = () => navigate("/scm/delivery-returns?import=1");
  const goDuplicate = () => navigate("/scm/delivery-returns?duplicate=1");
  const goDoList = () => navigate("/scm/delivery-orders");
  const goInvoiceList = () => navigate("/scm/sales-invoices");
  const goEdit = (r: DrRow) => navigate(`/scm/delivery-returns/${r.id}?edit=1`);
  const printDocument = usePrintDocument();
  const goFullPage = (r: DrRow) => navigate(`/scm/delivery-returns/${r.id}`);

  // ─── Multi-select → batch "Print all" ─────────────────────────────────────
  const toggleSelect = (rowId: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  const toggleSelectAll = (keys: string[], allSelected: boolean) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) for (const k of keys) next.delete(k);
      else for (const k of keys) next.add(k);
      return next;
    });
  const clearSelection = () => setSelectedIds(new Set());

  /* Delegated to lib/printDocumentPdf's `deliveryReturnPdfBundle`, the ONE home
     for the DR-record → DR-generator mapping (the generator takes a shape the
     record is not stored in, and migration 0102's address block has to be
     threaded through by hand). The row menu's print reads the same function. */
  const fetchDrBundle = async (id: string): Promise<{ header: unknown; items: unknown[] }> =>
    deliveryReturnPdfBundle(
      await authedFetch<{ deliveryReturn: Record<string, unknown>; items: Array<Record<string, unknown>> }>(
        `/delivery-returns/${id}`,
      ),
    );

  // Batch "Print all" — one ticked DR downloads straight; several prompt
  // combined-vs-separate.
  const deliverSelectedDrs = async (action: PdfAction) => {
    if (printingDocs) return;
    const chosen = filtered.filter((r) => selectedIds.has(r.id));
    if (chosen.length === 0) return;
    try {
      const { generateDeliveryReturnPdf, generateCombinedDeliveryReturnPdf } =
        await import("../../vendor/scm/lib/delivery-return-pdf");
      if (chosen.length === 1) {
        setPrintingDocs(true);
        const b = await fetchDrBundle(chosen[0]!.id);
        await generateDeliveryReturnPdf(b.header as never, b.items as never, { action });
        clearSelection();
        return;
      }
      /* View / Print always render ONE document — a preview or a print run
         is about the stack, not N separate files. Only the download exit
         still asks combined-vs-separate. */
      const how = action !== "save" ? "one" : await askChoice({
        title: `Print ${chosen.length} delivery returns`,
        options: [
          { value: "one", label: "One combined PDF" },
          { value: "many", label: "Separate files", detail: "One PDF per document" },
        ],
      });
      if (how == null) return;
      setPrintingDocs(true);
      const bundles: Array<{ header: unknown; items: unknown[] }> = [];
      for (const r of chosen) bundles.push(await fetchDrBundle(r.id));
      if (how === "one") {
        await generateCombinedDeliveryReturnPdf(bundles as never, {
          fileName: `delivery-returns-${new Date().toISOString().slice(0, 10)}.pdf`,
          action,
        });
      } else {
        for (const b of bundles)
          await generateDeliveryReturnPdf(b.header as never, b.items as never, { action });
      }
      clearSelection();
    } catch (e) {
      notify({
        title: "PDF generation failed",
        body: e instanceof Error ? e.message : "Something went wrong.",
        tone: "error",
      });
    } finally {
      setPrintingDocs(false);
    }
  };
  const batchPrint = usePrintPreview(deliverSelectedDrs);
  const doMarkInspected = (r: DrRow) =>
    updateStatus.mutate(
      { id: r.id, status: "INSPECTED" },
      {
        onSuccess: () => setSelected(null),
        onError: (e) =>
          notify({
            title: `Couldn't mark ${r.return_number} as inspected`,
            body: `${e instanceof Error ? e.message : "Something went wrong."} The return is unchanged — please try again.`,
            tone: "error",
          }),
      }
    );
  /* Refunded is a money statement — a rejected write that says nothing leaves
     the operator believing the customer has been refunded. */
  const doMarkRefunded = (r: DrRow) =>
    updateStatus.mutate(
      { id: r.id, status: "REFUNDED" },
      {
        onSuccess: () => setSelected(null),
        onError: (e) =>
          notify({
            title: `Couldn't mark ${r.return_number} as refunded`,
            body: `${e instanceof Error ? e.message : "Something went wrong."} The return is unchanged — please try again.`,
            tone: "error",
          }),
      }
    );
  // Reopen a cancelled return → RECEIVED (2990 DeliveryReturnsList "Reopen
  // Return" parity; reuses the status PATCH endpoint).
  const doReopen = async (r: DrRow) => {
    if (
      !(await askConfirm({
        title: `Reopen ${r.return_number} back to RECEIVED?`,
        confirmLabel: "Reopen",
      }))
    )
      return;
    updateStatus.mutate(
      { id: r.id, status: "RECEIVED" },
      {
        onSuccess: () => setSelected(null),
        onError: (e) =>
          notify({
            title: "Reopen failed",
            body: e instanceof Error ? e.message : "Something went wrong.",
            tone: "error",
          }),
      }
    );
  };

  /* Right-click (owner 2026-08-22): 「只要有 Cancel / On Hold 状态的，全部都可以
     右键 Cancel」. This list had no cancel of any kind — cancelling a return
     lived only on its detail page — but it needed no new endpoint: the status
     PATCH it already uses for Inspected, Refunded and Reopen is the same one
     the detail page's Cancel calls, with CANCELLED as the target.

     The words match the detail page's, because the consequence is the same one
     and the operator must read it in both places: creating the return put the
     goods back INTO stock, so cancelling takes them out again.

     Inspected and Refunded stay OFF the menu and on the drawer. Refunded in
     particular is a money statement, and the drawer is where the refund figure
     that justifies it is on screen. */
  const doCancelDr = async (r: DrRow) => {
    if (
      !(await askConfirm({
        title: `Cancel return ${r.return_number}?`,
        body: "The stock added on create will be reversed via a negative ADJUSTMENT. A cancelled return cannot be reopened.",
        confirmLabel: "Cancel return",
        danger: true,
      }))
    )
      return;
    updateStatus.mutate(
      { id: r.id, status: "CANCELLED" },
      {
        onSuccess: () => setSelected(null),
        onError: (e) =>
          notify({
            title: `Couldn't cancel ${r.return_number}`,
            body: `${e instanceof Error ? e.message : "Something went wrong."} The return is unchanged — please try again.`,
            tone: "error",
          }),
      }
    );
  };
  /* No Confirm entry: a Delivery Return is RECEIVED on create and has no draft
     step, so there is no confirm transition to offer. Cancelling is final — the
     server refuses to un-cancel — so an already cancelled row gets no entry. */
  const drContextMenu = deliveryReturnRowMenu<DrRow>({
    open: goFullPage,
    edit: goEdit,
    print: printDocument,
    cancel: doCancelDr,
    canCancel: (r) => (r.status || "").toUpperCase() !== "CANCELLED",
  });

  // Table columns — Reason gets a first-class spot (a DR-only signal).
  const columns: Column<DrRow>[] = [
    {
      key: "return_number",
      label: "Return No.",
      // 156 + font-docno (owner 2026-07-31): 140 sat on the clip threshold for
      // a full doc no — see the measured DO No. note in MfgDeliveryOrdersListV2.
      width: "156px",
      alwaysVisible: true,
      getValue: (r) => r.return_number,
      render: (r) => (
        <span className="font-docno text-[12.5px] font-semibold text-ink">
          {r.return_number}
        </span>
      ),
    },
    {
      key: "return_date",
      label: "Date",
      width: "108px",
      getValue: (r) => r.return_date,
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{fmtDate(r.return_date)}</span>
      ),
    },
    {
      key: "do_doc_no",
      label: transferFromColumnLabel('do'),
      width: "128px",
      getValue: (r) => r.do_doc_no ?? "",
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">{doOf(r)}</span>
      ),
    },
    {
      /* Convert-from relation (audit R8): the Sales Order behind this return's
         DO. Server-resolved (so_doc_no); mirrors the DO/SI lists' "From SO". */
      key: "so_doc_no",
      label: transferFromColumnLabel('so'),
      width: "128px",
      disableSort: true,
      getValue: (r) => r.so_doc_no ?? "",
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">{r.so_doc_no || "—"}</span>
      ),
    },
    {
      key: "debtor_name",
      label: "Customer",
      getValue: (r) => r.debtor_name,
      render: (r) => (
        <span className="text-[13px] font-semibold text-ink">
          {r.debtor_name || "—"}
        </span>
      ),
    },
    {
      key: "reason",
      label: "Reason",
      width: "180px",
      getValue: (r) => r.reason ?? "",
      render: (r) =>
        r.reason ? (
          <span className="truncate text-[12.5px] italic text-ink-secondary">
            {r.reason}
          </span>
        ) : (
          <span className="text-[12.5px] text-ink-muted">—</span>
        ),
    },
    {
      key: "reference",
      label: "Customer ref",
      width: "128px",
      getValue: (r) => refOf(r),
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">{refOf(r)}</span>
      ),
    },
    {
      key: "salesperson",
      label: "Salesperson",
      width: "148px",
      getValue: (r) => salespersonNameOf(null, r.salesperson_id, ""),
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">
          {salespersonNameOf(null, r.salesperson_id, "—")}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      width: "120px",
      getValue: (r) => r.status,
      render: (r) => {
        const st = statusFor(r.status);
        return (
          <Badge tone={st.tone} size="xs">
            {st.label}
          </Badge>
        );
      },
    },
    {
      key: "refund",
      label: "Refund",
      width: "128px",
      align: "right",
      getValue: (r) => r.local_total_sen,
      render: (r) => (
        <span className="font-money text-[13px] font-semibold text-err">
          {fmtRm(r.local_total_sen)}
        </span>
      ),
    },
    // ── Re-added columns (Phase 1) — data already on the DrRow payload, ported
    //    from the legacy DeliveryReturnsList buildColumns (labels/widths). All
    //    default-hidden so the column chooser exposes them without changing the
    //    slim default view. This list sorts client-side, so getValue keeps them
    //    sortable + CSV-exportable without a backend sort key.
    {
      key: "sales_location",
      label: "Location",
      width: "120px",
      defaultHidden: true,
      getValue: (r) => r.sales_location ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.sales_location || "—"}</span>
      ),
    },
    {
      key: "branding",
      label: "Branding",
      width: "130px",
      defaultHidden: true,
      getValue: (r) => brandOf(r),
      render: (r) => {
        const b = brandOf(r);
        return (
          <Badge tone={brandTone(b)} variant="soft" size="xs">
            {b}
          </Badge>
        );
      },
    },
    {
      key: "venue",
      label: "Venue",
      width: "180px",
      defaultHidden: true,
      getValue: (r) => r.venue ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.venue || "—"}</span>
      ),
    },
    {
      key: "phone",
      label: "Phone",
      width: "130px",
      defaultHidden: true,
      getValue: (r) => r.phone ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{formatPhone(r.phone) || "—"}</span>
      ),
    },
    {
      key: "email",
      label: "Email",
      width: "180px",
      defaultHidden: true,
      getValue: (r) => r.email ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.email || "—"}</span>
      ),
    },
    {
      key: "debtor_code",
      label: "Customer Code",
      width: "120px",
      defaultHidden: true,
      getValue: (r) => r.debtor_code ?? "",
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">{r.debtor_code || "—"}</span>
      ),
    },
    {
      key: "address1",
      label: "Address 1",
      width: "180px",
      defaultHidden: true,
      getValue: (r) => r.address1 ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.address1 || "—"}</span>
      ),
    },
    {
      key: "address2",
      label: "Address 2",
      width: "180px",
      defaultHidden: true,
      getValue: (r) => r.address2 ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.address2 || "—"}</span>
      ),
    },
    {
      key: "city",
      label: "City",
      width: "130px",
      defaultHidden: true,
      getValue: (r) => r.city ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.city || "—"}</span>
      ),
    },
    {
      key: "postcode",
      label: "Postcode",
      width: "100px",
      defaultHidden: true,
      getValue: (r) => r.postcode ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.postcode || "—"}</span>
      ),
    },
    {
      key: "customer_state",
      label: "State",
      width: "130px",
      defaultHidden: true,
      getValue: (r) => r.customer_state ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.customer_state || "—"}</span>
      ),
    },
    {
      key: "note",
      label: "Note",
      width: "200px",
      defaultHidden: true,
      getValue: (r) => r.note ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.note || "—"}</span>
      ),
    },
    // ── Re-added columns (Phase 2) — NON-finance fields already on the DR
    //    payload (HEADER). venue + note already exist (Phase 1); add the rest.
    {
      key: "customer_type",
      label: "Customer Type",
      width: "130px",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.customer_type ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.customer_type || "—"}</span>
      ),
    },
    {
      key: "building_type",
      label: "Building Type",
      width: "130px",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.building_type ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.building_type || "—"}</span>
      ),
    },
    // ── Phase 2 FINANCE columns — cost / margin / per-category subtotals (DR
    //    has FOUR categories, no service). DECLARED ONLY for a finance-viewer
    //    (backend also omits the keys).
    ...(canFinance
      ? ([
          {
            key: "mattress_sofa_sen",
            label: "Mattress/Sofa",
            width: "120px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.mattress_sofa_sen ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink">{fmtRm(r.mattress_sofa_sen ?? 0)}</span>
            ),
          },
          {
            key: "bedframe_sen",
            label: "Bedframe",
            width: "110px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.bedframe_sen ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink">{fmtRm(r.bedframe_sen ?? 0)}</span>
            ),
          },
          {
            key: "accessories_sen",
            label: "Accessories",
            width: "110px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.accessories_sen ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink">{fmtRm(r.accessories_sen ?? 0)}</span>
            ),
          },
          {
            key: "others_sen",
            label: "Others",
            width: "110px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.others_sen ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink">{fmtRm(r.others_sen ?? 0)}</span>
            ),
          },
          {
            key: "mattress_sofa_cost_sen",
            label: "Mattress/Sofa Cost",
            width: "140px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.mattress_sofa_cost_sen ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink-secondary">{fmtRm(r.mattress_sofa_cost_sen ?? 0)}</span>
            ),
          },
          {
            key: "bedframe_cost_sen",
            label: "Bedframe Cost",
            width: "130px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.bedframe_cost_sen ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink-secondary">{fmtRm(r.bedframe_cost_sen ?? 0)}</span>
            ),
          },
          {
            key: "accessories_cost_sen",
            label: "Accessories Cost",
            width: "140px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.accessories_cost_sen ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink-secondary">{fmtRm(r.accessories_cost_sen ?? 0)}</span>
            ),
          },
          {
            key: "others_cost_sen",
            label: "Others Cost",
            width: "130px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.others_cost_sen ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink-secondary">{fmtRm(r.others_cost_sen ?? 0)}</span>
            ),
          },
          {
            key: "total_cost_sen",
            label: "Total Cost",
            width: "120px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.total_cost_sen ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink-secondary">{fmtRm(r.total_cost_sen ?? 0)}</span>
            ),
          },
          {
            key: "total_margin_sen",
            label: "Margin",
            width: "120px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.total_margin_sen ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink">{fmtRm(r.total_margin_sen ?? 0)}</span>
            ),
          },
          {
            key: "margin_pct_basis",
            label: "Margin %",
            width: "100px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.margin_pct_basis ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink-secondary">{fmtPctBasis(r.margin_pct_basis)}</span>
            ),
          },
        ] satisfies Column<DrRow>[])
      : ([] satisfies Column<DrRow>[])),
  ];

  const statusPillOptions: Array<{ value: StatusTab; label: string }> = [
    { value: "all", label: `All · ${counts.all}` },
    { value: "open", label: `Open · ${counts.open}` },
    { value: "inspected", label: `Inspected · ${counts.inspected}` },
    { value: "refunded", label: `Refunded · ${counts.refunded}` },
    { value: "cancelled", label: `Cancelled · ${counts.cancelled}` },
  ];

  return (
    <PullToRefresh onRefresh={onPullToRefresh}>
      {/* When the drawer is open the desktop shell reflows into the left
          520 + gutter so stats/table are cleanly visible next to it instead
          of being half-covered. Mobile keeps the full-width overlay. */}
      <div
        className={cn(
          "transition-[padding] duration-200",
          selected ? "md:pr-[540px]" : ""
        )}
      >
      {/* Mobile-only compact header — hides at md+. */}
      <div className="mb-3 flex items-start justify-between gap-3 md:hidden">
        <div className="min-w-0">
          <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
            Delivery Returns
          </h1>
          <div className="mt-0.5 text-[12.5px] text-ink-muted">
            {stats.total} return{stats.total === 1 ? "" : "s"} ·{" "}
            <span className="font-money text-err">{fmtRm(stats.refundSen)}</span>
          </div>
        </div>
      </div>

      {/* Desktop sticky page chrome — matches SO/DO/SI listing pattern. */}
      <div className="-mx-4 hidden pb-3 sm:-mx-6 md:block">
        <div className="px-4 sm:px-6">
          <PageHeader
            eyebrow="Supply Chain"
            title="Delivery Returns"
            description="Goods returned by customers — Pending to Refunded. Click any row for the quick view; open the full page to edit."
            primaryAction={
              <div className="flex items-stretch gap-2">
                <Button
                  variant="secondary"
                  icon={<ArrowRightLeft size={14} />}
                  onClick={goFromDo}
                >
                  {transferFromLabel('do')}
                </Button>
                <div className="flex items-stretch">
                  <Button
                    variant="primary"
                    icon={<Plus size={14} />}
                    onClick={goNewDr}
                    className="rounded-r-none"
                  >
                    New Delivery Return
                  </Button>
                  <SplitDropdown
                    onFromDo={goFromDo}
                    onImport={goImport}
                    onDuplicate={goDuplicate}
                  />
                </div>
              </div>
            }
            secondaryActions={[
              { label: "Delivery Orders", icon: Truck, onClick: goDoList },
              { label: "Sales Invoices", icon: Receipt, onClick: goInvoiceList },
            ]}
          />

          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              pending={statsPending}
              label="Total Returns"
              value={stats.total.toLocaleString("en-MY")}
              subtitle="Scoped to current filter"
              rail="bg-primary"
              active
            />
            <StatCard
              pending={statsPending}
              label="Refund Value"
              value={fmtRm(stats.refundSen)}
              subtitle="Money owed back"
              tone="error"
              rail="bg-err"
            />
            <StatCard
              pending={statsPending}
              label="Pending"
              value={stats.pendingCount.toLocaleString("en-MY")}
              subtitle="Received · awaiting refund"
              tone="warning"
              rail="bg-accent-bright"
            />
            <StatCard
              pending={statsPending}
              label="Refunded"
              value={stats.refundedCount.toLocaleString("en-MY")}
              subtitle="Refunded / credit noted"
              tone="success"
              rail="bg-synced"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <FilterPills
              options={statusPillOptions}
              value={status}
              onChange={(v) => setStatusChip(v)}
            />
            <div className="flex-1" />
            <ViewToggle value={view} onChange={setView} />
          </div>
        </div>
      </div>

      {/* Mobile sticky search */}
      <div className="sticky top-0 z-10 -mx-4 mb-3 bg-bg/95 px-4 py-2 backdrop-blur-sm md:hidden">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search return, customer, reason…"
          className="h-10 w-full rounded-lg border border-border bg-surface px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
        <SearchScopeHint scope="loaded" loadedLimit={500} resultCount={filtered.length} term={search} className="mt-1 px-1" />
      </div>

      {/* Mobile filter row */}
      <div className="mb-4 flex flex-wrap items-center gap-3 md:hidden">
        <FilterPills
          options={statusPillOptions}
          value={status}
          onChange={(v) => setStatusChip(v)}
        />
      </div>

      {/* Phone → Cards */}
      <div className="md:hidden">
        <CardsGrid rows={filtered} onOpen={(r) => setSelected(r)} />
        {filtered.length > 0 && (
          <div className="mt-4 pb-24 text-center text-[11.5px] text-ink-muted">
            {filtered.length} return{filtered.length === 1 ? "" : "s"}
          </div>
        )}
      </div>

      {/* Desktop → Table / Cards */}
      <div className="hidden md:block">
        {view === "table" ? (
          <>
            {selectedIds.size > 0 && (
              <div className="mb-3 flex items-center gap-3 rounded-lg border border-primary/40 bg-primary-soft px-4 py-2.5 shadow-stone">
                <span className="text-[13px] font-semibold text-ink">
                  {selectedIds.size} selected
                </span>
                <span className="text-ink-muted">·</span>
                <span className="text-[12px] text-ink-secondary">
                  Combine into one PDF or download separately.
                </span>
                <div className="flex-1" />
                <Button
                  variant="primary"
                  icon={<Printer size={14} />}
                  disabled={printingDocs}
                  onClick={batchPrint.openPreview}
                >
                  {printingDocs ? "Printing…" : `Print all (${selectedIds.size})`}
                </Button>
                <PrintPreviewBatchModal
                  open={batchPrint.open}
                  onClose={batchPrint.close}
                  docTitle="Delivery Returns"
                  docNos={filtered.filter((r) => selectedIds.has(r.id)).map((r) => r.return_number)}
                  {...batchPrint.handlers}
                />
                <Button variant="ghost" disabled={printingDocs} onClick={clearSelection}>
                  Clear
                </Button>
              </div>
            )}
            <DataTable<DrRow>
              tableId="delivery-returns-v2"
              rows={filtered}
              loading={isLoading}
              error={error ? (error as Error).message ?? "Failed to load" : null}
              columns={columns}
              getRowKey={(r) => r.id}
              onRowClick={(r) => setSelected(r)}
              contextMenu={drContextMenu}
              expandable={{
                render: (r) => <DrLinesExpansion id={r.id} />,
                rowKey: (r) => r.id,
              }}
              selection={{
                selectedIds,
                onToggle: toggleSelect,
                onToggleAll: toggleSelectAll,
              }}
              exportName="delivery-returns"
              emptyLabel={
                filtersActive
                  ? "No delivery returns match — try Reset layout to clear filters."
                  : "No delivery returns yet."
              }
              search={{
                value: search,
                onChange: setSearch,
                placeholder: "Search return, customer, reason, salesperson…",
                loadedLimit: 500,
              }}
              resetFilters={{
                active: filtersActive,
                onReset: resetLayout,
                label: "Reset layout",
              }}
            />
          </>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex flex-1 items-center gap-2">
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search return, customer, reason, salesperson…"
                  className="h-9 max-w-[320px] flex-1 rounded-md border border-border bg-surface px-3.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
                <SearchScopeHint scope="loaded" loadedLimit={500} resultCount={filtered.length} term={search} />
                {filtersActive && (
                  <button
                    type="button"
                    onClick={resetLayout}
                    className="text-[12px] font-semibold text-primary hover:underline"
                  >
                    Reset layout
                  </button>
                )}
              </div>
              <span className="text-[12px] text-ink-muted">
                {filtered.length} return{filtered.length === 1 ? "" : "s"}
              </span>
            </div>
            <CardsGrid rows={filtered} onOpen={(r) => setSelected(r)} />
          </>
        )}
      </div>
      </div>

      <DetailDrawer
        row={selected}
        onClose={() => setSelected(null)}
        onOpenFull={() => selected && goFullPage(selected)}
        onEdit={() => selected && goEdit(selected)}
        onPrint={() => selected && printDocument(deliveryReturnPrintChain(selected).own)}
        onMarkInspected={() => selected && doMarkInspected(selected)}
        onMarkRefunded={() => selected && doMarkRefunded(selected)}
        onReopen={() => selected && void doReopen(selected)}
        salespersonName={
          selected ? salespersonNameOf(null, selected.salesperson_id) : "—"
        }
      />
    </PullToRefresh>
  );
}

export default DeliveryReturnsListV2;
