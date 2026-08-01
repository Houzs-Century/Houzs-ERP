// SalesInvoicesListV2 — Theme C redesign of the Sales Invoices listing.
// Mirrors the DO V2 template (which mirrors SO V2); the three-headed sales
// chain (DO / SI / DR) shares the same chrome so this file focuses on the
// SI-specific bits: money-centric stats (Outstanding / Paid), a status flow
// biased around payment (SENT → PARTIALLY_PAID → PAID → CANCELLED), and the
// SI-specific cross-doc anchors (From SO + From DO instead of just From SO).
//
// Route: /scm/sales-invoices.
// Data:  useSalesInvoices / useSalesInvoiceDetail / useUpdateSalesInvoiceStatus
//        (all live in the vendored SCM lib; useRecordSiPayment is available
//         for a follow-up drawer action, not wired here to keep this PR to
//         chrome only.)

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { canViewScmCosting, canOperateSalesInvoices } from "../../auth/salesAccess";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Plus,
  ChevronDown,
  Wrench,
  Truck,
  LayoutGrid,
  Table as TableIcon,
  X as XIcon,
  ExternalLink,
  Edit3,
  Printer,
  CheckCircle2,
  Receipt,
  RotateCcw,
  ArrowRightLeft,
} from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { StatCard } from "../../components/StatCard";
import { FilterPills } from "../../components/FilterPills";
import { DataTable, type Column } from "../../components/DataTable";
import {
  DocumentLinesExpansion,
  sourcePoTitle,
  type DocumentDrillLine,
  type DrillItemFields,
} from "../../components/DocumentLinesExpansion";
import { ListPager } from "../../components/ListPager";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { PullToRefresh } from "../../components/PullToRefresh";
import { ListErrorPanel, SearchPendingPanel, SearchProgress } from "../../components/SearchProgress";
import { SearchScopeHint } from "../../components/SearchScopeHint";
import { useStaffLookup } from "../../hooks/useStaffLookup";
import { useBranding } from "../../hooks/useBranding";
import { shortCompanyName } from "../../lib/branding";
import { useDebouncedSearchTerm, useSearchResultTransition } from "../../hooks/useServerSearch";
import {
  useSalesInvoicesPaged,
  useSalesInvoiceDetail,
  useUpdateSalesInvoiceStatus,
} from "../../vendor/scm/lib/sales-invoice-queries";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { useChoice } from "../../vendor/scm/components/ChoiceDialog";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "../../lib/utils";
import { ResizableDetailDrawer } from "../../components/ResizableDetailDrawer";
import { useAuth } from "../../auth/AuthContext";
import { buildVariantSummary, fmtCenti, orderLineIdentity } from "@2990s/shared";
import { formatPhone } from "@2990s/shared/phone";

// ─── Types ──────────────────────────────────────────────────────────────────
// Subset of the full SiRow (see SalesInvoicesList.tsx for the 40-field shape).

type SiRow = {
  id: string;
  invoice_number: string;
  so_doc_no: string | null;
  delivery_order_id: string | null;
  /** Convert-from relation (display-only, audit R8): the readable DO number the
   *  SI was created from, server-resolved from delivery_order_id. */
  do_number?: string | null;
  /** Source PO(s) the invoiced goods came from (batch_no = source PO on the SI's
   *  DO's OUT movements ∪ consumed FIFO lots). "—" for un-batched stock. A sales
   *  invoice shows Source PO, not an Assigned SO (owner 2026-07-31). */
  source_pos?: string[] | null;
  invoice_date: string;
  due_date: string | null;
  /** SI's own snapshot of the customer delivery date (may be null on rows
   *  created before the snapshot column existed). */
  customer_delivery_date?: string | null;
  /** Linked SO's Processing date (mfg_sales_orders.internal_expected_dd),
   *  stamped server-side onto every list row for the quick-view drawer. */
  so_internal_expected_dd?: string | null;
  /** Linked SO's delivery date — fallback when the SI's own snapshot is null. */
  so_customer_delivery_date?: string | null;
  debtor_name: string;
  debtor_code: string | null;
  salesperson_id: string | null;
  sales_location: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  ref: string | null;
  branding: string | null;
  phone: string | null;
  email: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  customer_state: string | null;
  local_total_centi: number;
  total_centi: number;
  paid_centi: number;
  status: string;
  currency: string;
  line_count?: number;
  // ── Phase 2: NON-finance fields already on the SI list payload (HEADER).
  venue: string | null;
  note: string | null;
  customer_type: string | null;
  building_type: string | null;
  // ── Phase 2 FINANCE: backend OMITS these keys for non-finance callers
  //    (canViewScmFinance), so each is optional. margin_pct_basis = basis points.
  mattress_sofa_centi?: number;
  bedframe_centi?: number;
  accessories_centi?: number;
  others_centi?: number;
  service_centi?: number;
  mattress_sofa_cost_centi?: number;
  bedframe_cost_centi?: number;
  accessories_cost_centi?: number;
  others_cost_centi?: number;
  service_cost_centi?: number;
  total_cost_centi?: number;
  total_margin_centi?: number;
  margin_pct_basis?: number;
};

type StatusTab = "all" | "sent" | "partial" | "paid" | "cancelled";

// ─── Helpers ────────────────────────────────────────────────────────────────

const fmtRm = (centi: number): string =>
  `RM ${(centi / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

// margin_pct_basis is basis points (margin/total x 10000) → percent string.
const fmtPctBasis = (basis: number | null | undefined): string =>
  basis == null ? "—" : `${(basis / 100).toFixed(1)}%`;

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const s = iso.replace(/T.*$/, "").replace(/-/g, "/");
  return s;
};

// Customer's PO / Ref — same fallback chain as SO/DO V2.
const refOf = (r: SiRow): string =>
  r.po_doc_no || r.customer_so_no || r.ref || "—";

const soOf = (r: SiRow): string => r.so_doc_no || "—";
// Prefer the readable DO number (server-resolved); the raw UUID is not useful
// to show, so fall back to a dash rather than a uuid.
const doOf = (r: SiRow): string => r.do_number || "—";

const brandOf = (r: SiRow): string => r.branding || "—";
const brandTone = (b: string): "success" | "neutral" | "warning" => {
  const s = (b || "").toUpperCase();
  if (s.includes("2990") || s.includes("SOFA")) return "success";
  if (s.includes("AKEMI")) return "neutral";
  if (s === "—" || !s) return "neutral";
  return "warning";
};

// SI status → filter bucket. Business flow: DRAFT → SENT → PARTIALLY_PAID →
// PAID → CANCELLED. Buckets: sent (Draft + Sent) / partial / paid / cancelled.
const STATUS_TONE: Record<
  string,
  { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab }
> = {
  draft:           { tone: "warning", label: "Draft",       bucket: "sent" },
  sent:            { tone: "warning", label: "Sent",        bucket: "sent" },
  issued:          { tone: "warning", label: "Issued",      bucket: "sent" },
  partially_paid:  { tone: "warning", label: "Partial pay", bucket: "partial" },
  partial:         { tone: "warning", label: "Partial pay", bucket: "partial" },
  paid:            { tone: "success", label: "Paid",        bucket: "paid" },
  completed:       { tone: "success", label: "Paid",        bucket: "paid" },
  cancelled:       { tone: "error",   label: "Cancelled",   bucket: "cancelled" },
  cancel:          { tone: "error",   label: "Cancelled",   bucket: "cancelled" },
};

const statusFor = (
  s: string
): { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab } =>
  STATUS_TONE[(s || "").toLowerCase()] ?? {
    tone: "neutral",
    label: s || "—",
    bucket: "sent",
  };

// Derived outstanding (Total − Paid). Guards against negative from over-payment.
const outstandingOf = (r: SiRow): number =>
  Math.max(0, (r.total_centi || r.local_total_centi || 0) - (r.paid_centi || 0));

// ─── Split-menu dropdown ────────────────────────────────────────────────────

function SplitDropdown({
  onFromDo,
  onFromSo,
  onImport,
}: {
  onFromDo: () => void;
  onFromSo: () => void;
  onImport: () => void;
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
                onFromSo();
              }}
            >
              New from Sales Order
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

// ─── Cards grid ─────────────────────────────────────────────────────────────

function CardsGrid({ rows, onOpen }: { rows: SiRow[]; onOpen: (r: SiRow) => void }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-16 text-center shadow-stone">
        <div className="text-[13px] font-semibold text-ink">No sales invoices</div>
        <div className="mt-1 text-[12px] text-ink-muted">
          No invoices match the current filters. Try Reset layout to clear the
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
        const outstanding = outstandingOf(r);
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpen(r)}
            className="group relative overflow-hidden rounded-lg border border-border bg-surface px-4 py-4 text-left shadow-stone transition-all duration-200 hover:-translate-y-px hover:border-primary/40 hover:shadow-slab focus:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-docno text-[12.5px] font-semibold text-ink">
                {r.invoice_number}
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
              <span className="text-[11.5px] text-ink-muted">
                {fmtDate(r.invoice_date)}
              </span>
            </div>
            <div className="mt-3.5 flex items-end justify-between border-t border-border-subtle pt-3">
              <div className="min-w-0">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  Outstanding
                </div>
                <div
                  className={cn(
                    "mt-0.5 font-money text-[12.5px] font-semibold",
                    outstanding > 0 ? "text-err" : "text-synced"
                  )}
                >
                  {outstanding > 0 ? fmtRm(outstanding) : "Cleared"}
                </div>
              </div>
              <span className="font-money text-[15px] font-bold text-ink">
                {fmtRm(r.total_centi || r.local_total_centi)}
              </span>
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
  onMarkPaid,
  onRecordPayment,
  onReopen,
  salespersonName,
  canWrite,
}: {
  row: SiRow | null;
  onClose: () => void;
  onOpenFull: () => void;
  onEdit: () => void;
  onPrint: () => void;
  onMarkPaid: () => void;
  onRecordPayment: () => void;
  onReopen: () => void;
  salespersonName: string;
  canWrite: boolean;
}) {
  const detailQ = useSalesInvoiceDetail(row?.id ?? null);
  const items: Array<{
    product_code?: string;
    product_name?: string;
    item_code?: string;
    description?: string;
    description2?: string;
    item_group?: string;
    variants?: Record<string, unknown> | null;
    qty?: number;
    unit_price_centi?: number;
    amount_centi?: number;
    total_centi?: number;
  }> =
    ((detailQ.data as { items?: unknown[] } | undefined)?.items as Array<{
      product_code?: string;
      product_name?: string;
      item_code?: string;
      description?: string;
      description2?: string;
      item_group?: string;
      variants?: Record<string, unknown> | null;
      qty?: number;
      unit_price_centi?: number;
      amount_centi?: number;
      total_centi?: number;
    }>) ?? [];

  const open = !!row;
  const st = row ? statusFor(row.status) : null;

  const totalCenti = row?.total_centi ?? row?.local_total_centi ?? 0;
  const paidCenti = row?.paid_centi ?? 0;
  const outstanding = Math.max(0, totalCenti - paidCenti);

  return (
    <ResizableDetailDrawer
      open={open}
      onClose={onClose}
      ariaLabel={row ? `Sales invoice ${row.invoice_number}` : "Sales invoice details"}
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
                  {row.invoice_number}
                </div>
                <div className="mt-0.5 text-[11px] text-sidebar-ink-muted">Sales Invoice</div>
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
                  Issued {fmtDate(row.invoice_date)}
                </span>
              </div>

              <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2 px-4 py-4">
                <MetaItem k="From SO" v={soOf(row)} mono />
                <MetaItem k="From DO" v={doOf(row)} mono />
                <MetaItem k="Customer ref" v={refOf(row)} mono />
                <MetaItem k="Due date" v={fmtDate(row.due_date)} />
                {/* Owner 2026-07-24 — Processing (linked SO's
                    internal_expected_dd) + Delivery must be visible in every
                    quick view. Delivery prefers the SI's own snapshot, falling
                    back to the linked SO's date for pre-snapshot rows. */}
                <MetaItem k="Processing" v={fmtDate(row.so_internal_expected_dd ?? null)} />
                <MetaItem
                  k="Delivery"
                  v={fmtDate(row.customer_delivery_date ?? row.so_customer_delivery_date ?? null)}
                />
                <MetaItem k="Location" v={row.sales_location || "—"} />
                <MetaItem k="Salesperson" v={salespersonName} />
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

              <SectionHeading>Line items</SectionHeading>
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="grid grid-cols-[1fr_52px_82px_92px] gap-2 border-b border-border-subtle bg-surface-2 px-4 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  <span>Item</span>
                  <span className="text-right">Qty</span>
                  <span className="text-right">Unit</span>
                  <span className="text-right">Amount</span>
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
                    l.amount_centi ??
                    l.total_centi ??
                    (l.qty ?? 0) * (l.unit_price_centi ?? 0);
                  const { primary, secondary } = orderLineIdentity({
                    code: l.item_code || l.product_code,
                    description: l.description || l.product_name,
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
                      </div>
                      <span className="text-right font-money text-[12.5px] text-ink-secondary">
                        {l.qty ?? 0}
                      </span>
                      <span className="text-right font-money text-[12.5px] text-ink-secondary">
                        {fmtRm(l.unit_price_centi ?? 0)}
                      </span>
                      <span className="text-right font-money text-[12.5px] font-semibold text-ink">
                        {fmtRm(amt)}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* SI totals — payment-forward: Total / Paid / Outstanding are
                  what the operator actually reads on this doc. Subtotal / SST
                  are 6%-inclusive in Malaysia so we don't split them out. */}
              <div className="mt-4 rounded-lg border border-border bg-surface px-5 py-4">
                <TotalRow k="Invoice total" v={fmtRm(totalCenti)} strong />
                <TotalRow k="Paid" v={fmtRm(paidCenti)} tone="success" />
                <TotalRow
                  k="Outstanding"
                  v={outstanding > 0 ? fmtRm(outstanding) : "Cleared"}
                  tone={outstanding > 0 ? "error" : "success"}
                />
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-5 py-3">
              {canWrite && (
                <Button variant="ghost" icon={<Edit3 size={14} />} onClick={onEdit}>
                  Edit
                </Button>
              )}
              <Button variant="ghost" icon={<Printer size={14} />} onClick={onPrint}>
                Print
              </Button>
              <div className="flex-1" />
              {canWrite && (() => {
                const s = (row.status || "").toLowerCase();
                if (["draft", "sent", "issued", "partially_paid", "partial"].includes(s)) {
                  if (outstanding > 0) {
                    return (
                      <Button
                        variant="primary"
                        icon={<Receipt size={14} />}
                        onClick={onRecordPayment}
                      >
                        Record payment
                      </Button>
                    );
                  }
                  return (
                    <Button
                      variant="primary"
                      icon={<CheckCircle2 size={14} />}
                      onClick={onMarkPaid}
                    >
                      Mark paid
                    </Button>
                  );
                }
                // Reopen a cancelled invoice back to SENT/Issued (2990
                // SalesInvoicesList "Reopen Invoice" parity).
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
  tone?: "success" | "error";
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between py-1.5",
        strong && "border-b border-border-subtle pb-2.5 mb-1"
      )}
    >
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
          strong && "text-[15px] font-bold text-ink",
          tone === "success" && "text-synced",
          tone === "error" && "text-err"
        )}
      >
        {v}
      </span>
    </div>
  );
}

// Table column key → backend sort-whitelist column. SI backend whitelist is
// { invoice_date, invoice_number, debtor_name, status, total_centi }; only the
// `amount` (Total) column key differs from its backend name. Non-whitelisted
// columns carry `disableSort`.
const SORT_COL_MAP: Record<string, string> = {
  amount: "total_centi",
};

// ─── Row drill-down (DataTable `expandable`) ──────────────────────────────────
// Inline per-line breakdown for one SI, lazy-fetched via the SAME
// useSalesInvoiceDetail hook the drawer uses (TanStack-cached). Group + item
// code/variant + Qty + Amount (line value), via the shared
// DocumentLinesExpansion. Although a sales invoice is a sales-side surface, its
// detail payload carries no per-line MRP coverage (stock_state / coverage_po) —
// those ride the SO detail, not this one — so, per "do not invent a backend
// endpoint the hook doesn't already answer", the SO/DO-only Stock + Incoming PO
// columns are absent here.
function SiLinesExpansion({ id }: { id: string }) {
  const detailQ = useSalesInvoiceDetail(id);
  const items =
    ((detailQ.data as { items?: Array<DrillItemFields & { source_pos?: string[] | null }> } | undefined)?.items ?? []);
  const lines: DocumentDrillLine[] = items.map((l) => ({
    itemGroup: l.item_group ?? null,
    code: l.item_code || l.product_code || null,
    description: l.description || l.product_name || null,
    description2: l.description2 ?? null,
    variants: l.variants ?? null,
    qty: Number(l.qty ?? 0),
    amountCenti:
      l.amount_centi ??
      l.total_centi ??
      Number(l.qty ?? 0) * (l.unit_price_centi ?? 0),
    // An SI is invoiced from a DO — show which PO the goods were procured on
    // (batch_no = source PO), not an Assigned SO (owner 2026-07-31).
    sourcePos: l.source_pos ?? [],
  }));
  return (
    <DocumentLinesExpansion
      isLoading={detailQ.isLoading}
      isError={Boolean(detailQ.error)}
      errorMessage={detailQ.error instanceof Error ? detailQ.error.message : null}
      lines={lines}
      emptyLabel="No lines on this sales invoice."
      showSourcePo
    />
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export function SalesInvoicesListV2() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const notify = useNotify();
  const askChoice = useChoice();
  const askConfirm = useConfirm();
  const { nameOf: salespersonNameOf } = useStaffLookup();
  // Active company (top-bar switcher) — the header subtitle reflects it so a
  // per-company list is never mislabelled as another company's (e.g. Houzs).
  const branding = useBranding();
  // Finance-viewer gate (auth/me = isFinanceViewer). Finance columns below are
  // DECLARED only for a finance-viewer; the backend also omits their keys from
  // the payload for everyone else (canViewScmFinance).
  const { user, can, pageAccess } = useAuth();
  const canFinance = canViewScmCosting(user);
  // Write gate — a salesperson reaches this list read-only via the sales inherit
  // hatch (App.tsx allowSales; backend readInheritsFrom scm.sales.orders) and
  // cannot create/edit an invoice or record payments. Hide the create + row
  // mutation actions rather than render-then-deny (owner off-not-hide rule).
  // ONE gate, shared with the DO surfaces and mobile.
  const canWriteSi = canOperateSalesInvoices(user, can, pageAccess);

  const status = (params.get("status") ?? "all") as StatusTab;
  const view = (params.get("view") ?? "table") as "table" | "cards";
  const search = params.get("q") ?? "";
  const page = Math.max(0, parseInt(params.get("page") ?? "0", 10) || 0);
  const [pageSize, setPageSize] = useLocalStorage<number>("scm:perpage:sales-invoices", 50);

  const [selected, setSelected] = useState<SiRow | null>(null);
  const [sort, setSort] = useState<string | undefined>(undefined);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [printingDocs, setPrintingDocs] = useState(false);
  const { requestTerm: debouncedSearch } = useDebouncedSearchTerm(search);

  // Send the active tab's BUCKET NAME as `status`; the backend resolves each
  // bucket to the raw statuses it covers (sent = DRAFT+SENT+ISSUED, partial =
  // PARTIALLY_PAID+PARTIAL, paid = PAID+COMPLETED, cancelled = CANCELLED).
  // `all` omits the filter.
  const apiStatus = status === "all" ? undefined : status;

  const { data, isLoading, isFetching, isPlaceholderData, error } = useSalesInvoicesPaged({
    page,
    pageSize,
    status: apiStatus,
    q: debouncedSearch,
    sort,
  });
  const searchTransition = useSearchResultTransition({
    inputTerm: search,
    requestTerm: debouncedSearch,
    isFetching,
    isPlaceholderData,
    hasData: data !== undefined,
    hasError: Boolean(error),
  });
  const listLoading = isLoading || searchTransition.isSearching;
  // The list below is replaced by a pending panel while a search is in flight,
  // and these tiles summarise the SAME payload - so a settled-looking "RM 0.00"
  // (or the PREVIOUS term's money under a placeholder page) would outlive the
  // rows it describes. Same flag SearchScopeHint already uses for its count.
  const statsPending =
    isLoading || isPlaceholderData || Boolean(error) || searchTransition.resultsAreStale;
  const updateStatus = useUpdateSalesInvoiceStatus();

  // Server already filtered + sorted this page — render verbatim.
  const rows = (data?.salesInvoices ?? []) as SiRow[];
  const total = data?.total ?? 0;
  const counts = data?.statusCounts ?? {
    all: 0,
    sent: 0,
    partial: 0,
    paid: 0,
    cancelled: 0,
  };

  // Money KPIs are summed over the CURRENT page only (paginated contract has no
  // full-set money sums), so their cards are labelled "on this page".
  const money = useMemo(() => {
    let revenueCenti = 0;
    let outstandingCenti = 0;
    let paidCenti = 0;
    for (const r of rows) {
      const t = r.total_centi ?? r.local_total_centi ?? 0;
      const paid = r.paid_centi ?? 0;
      revenueCenti += t;
      paidCenti += paid;
      outstandingCenti += Math.max(0, t - paid);
    }
    return { revenueCenti, outstandingCenti, paidCenti };
  }, [rows]);

  const setPageParam = (p: number) => {
    const next = new URLSearchParams(params);
    if (p <= 0) next.delete("page");
    else next.set("page", String(p));
    setParams(next, { replace: true });
  };
  const setStatusChip = (s: StatusTab) => {
    const next = new URLSearchParams(params);
    if (s === "all") next.delete("status");
    else next.set("status", s);
    next.delete("page");
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
    next.delete("page");
    setParams(next, { replace: true });
  };
  const sortSyncedRef = useRef(false);
  const setSortAndReset = (s: { key: string; dir: "asc" | "desc" } | null) => {
    setSort(s ? `${SORT_COL_MAP[s.key] ?? s.key}:${s.dir}` : undefined);
    if (!sortSyncedRef.current) {
      sortSyncedRef.current = true;
      return;
    }
    setPageParam(0);
  };
  const resetLayout = () => {
    setSort(undefined);
    setParams(new URLSearchParams(), { replace: true });
  };
  const filtersActive =
    status !== "all" || view !== "table" || search.trim().length > 0;

  const onPullToRefresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["sales-invoices"] });
  };

  const goNewSi = () => navigate("/scm/sales-invoices/new");
  const goFromDo = () => navigate("/scm/sales-invoices/from-do");
  const goFromSo = () => navigate("/scm/sales-invoices/from-so");
  const goImport = () => navigate("/scm/sales-invoices?import=1");
  const goDoList = () => navigate("/scm/delivery-orders");
  const goOutstanding = () => navigate("/scm/outstanding");
  const goEdit = (r: SiRow) => navigate(`/scm/sales-invoices/${r.id}?edit=1`);
  const goPrint = (r: SiRow) => navigate(`/scm/sales-invoices/${r.id}?print=1`);
  const goFullPage = (r: SiRow) => navigate(`/scm/sales-invoices/${r.id}`);

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

  // One SI's full detail for the PDF generator, via the vendored authedFetch
  // (→ /api/scm); same endpoint + shape as the single-row detail page.
  const fetchSiBundle = async (
    row: SiRow
  ): Promise<{ header: unknown; items: unknown[] }> => {
    const json = await authedFetch<{ salesInvoice: unknown; items: unknown[] }>(
      `/sales-invoices/${row.id}`
    );
    return { header: json.salesInvoice, items: json.items };
  };

  // Batch "Print all" — one ticked SI downloads straight; several prompt
  // combined-vs-separate.
  const printSelectedSis = async () => {
    if (printingDocs) return;
    const chosen = rows.filter((r) => selectedIds.has(r.id));
    if (chosen.length === 0) return;
    try {
      const { generateSalesInvoicePdf, generateCombinedSalesInvoicePdf } =
        await import("../../vendor/scm/lib/sales-invoice-pdf");
      if (chosen.length === 1) {
        setPrintingDocs(true);
        const b = await fetchSiBundle(chosen[0]!);
        await generateSalesInvoicePdf(b.header as never, b.items as never);
        clearSelection();
        return;
      }
      const how = await askChoice({
        title: `Print ${chosen.length} sales invoices`,
        options: [
          { value: "one", label: "One combined PDF" },
          { value: "many", label: "Separate files", detail: "One PDF per document" },
        ],
      });
      if (how == null) return;
      setPrintingDocs(true);
      const bundles: Array<{ header: unknown; items: unknown[] }> = [];
      for (const r of chosen) bundles.push(await fetchSiBundle(r));
      if (how === "one") {
        await generateCombinedSalesInvoicePdf(bundles as never, {
          fileName: `sales-invoices-${new Date().toISOString().slice(0, 10)}.pdf`,
        });
      } else {
        for (const b of bundles)
          await generateSalesInvoicePdf(b.header as never, b.items as never);
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
  const doMarkPaid = (r: SiRow) =>
    updateStatus.mutate(
      { id: r.id, status: "paid" },
      {
        onSuccess: () => setSelected(null),
        /* The sibling Reopen below always had an onError; Mark paid never did,
           so a rejected write left the row unchanged and silent — and "paid" is
           the one status nobody re-checks. */
        onError: (e) =>
          notify({
            title: `Couldn't mark ${r.invoice_number} as paid`,
            body: `${e instanceof Error ? e.message : "Something went wrong."} The invoice is unchanged — please try again.`,
            tone: "error",
          }),
      }
    );
  const goRecordPayment = (r: SiRow) =>
    navigate(`/scm/sales-invoices/${r.id}?tab=payments&record=1`);
  // Reopen a cancelled invoice → SENT (2990 SalesInvoicesList "Reopen Invoice"
  // parity; reuses the status PATCH endpoint).
  const doReopen = async (r: SiRow) => {
    if (
      !(await askConfirm({
        title: `Reopen ${r.invoice_number} back to Issued?`,
        confirmLabel: "Reopen",
      }))
    )
      return;
    updateStatus.mutate(
      { id: r.id, status: "SENT" },
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

  const columns: Column<SiRow>[] = [
    {
      key: "invoice_number",
      label: "SI No.",
      // 156 + font-docno (owner 2026-07-31): 132 clipped a full doc no by a
      // couple of px — see the measured DO No. note in MfgDeliveryOrdersListV2.
      width: "156px",
      alwaysVisible: true,
      getValue: (r) => r.invoice_number,
      render: (r) => (
        <span className="font-docno text-[12.5px] font-semibold text-ink">
          {r.invoice_number}
        </span>
      ),
    },
    {
      key: "invoice_date",
      label: "Date",
      width: "108px",
      getValue: (r) => r.invoice_date,
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{fmtDate(r.invoice_date)}</span>
      ),
    },
    {
      key: "due_date",
      label: "Due",
      width: "108px",
      disableSort: true,
      getValue: (r) => r.due_date ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{fmtDate(r.due_date)}</span>
      ),
    },
    {
      key: "so_doc_no",
      label: "From SO",
      width: "128px",
      disableSort: true,
      getValue: (r) => r.so_doc_no ?? "",
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">{soOf(r)}</span>
      ),
    },
    {
      /* Convert-from relation (audit R8): the Delivery Order this SI was created
         from. Previously only the raw delivery_order_id UUID was on the row, so
         the list could not show a readable source DO. */
      key: "do_number",
      label: "From DO",
      width: "128px",
      disableSort: true,
      getValue: (r) => r.do_number ?? "",
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">{doOf(r)}</span>
      ),
    },
    {
      // Owner 2026-07-31: an SI is born FROM a Sales Order, so "Assigned SO" is
      // wrong here — the useful fact is which PO the invoiced goods came from
      // (batch_no = source PO on the SI's DO). EVERY source PO renders (no
      // collapse); "—" when un-batched (plain FIFO / pre-batch stock).
      key: "source_pos",
      label: "Source PO",
      width: "168px",
      disableSort: true,
      getValue: (r) => (r.source_pos ?? []).join(", "),
      render: (r) => {
        const pos = r.source_pos ?? [];
        if (pos.length === 0) return <span className="text-[12px] text-ink-muted">—</span>;
        return (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {pos.map((po) => (
              <button
                key={po}
                type="button"
                title={sourcePoTitle(po)}
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/scm/purchase-orders?q=${encodeURIComponent(po)}`);
                }}
                className="rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-accent-ink hover:border-accent hover:text-accent"
              >
                {po}
              </button>
            ))}
          </span>
        );
      },
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
      key: "reference",
      label: "Customer ref",
      width: "132px",
      disableSort: true,
      getValue: (r) => refOf(r),
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">{refOf(r)}</span>
      ),
    },
    {
      key: "status",
      label: "Status",
      width: "116px",
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
      key: "outstanding",
      label: "Outstanding",
      width: "128px",
      align: "right",
      // Derived (Total − Paid) — not a backend-sortable column.
      disableSort: true,
      getValue: (r) => outstandingOf(r),
      render: (r) => {
        const outstanding = outstandingOf(r);
        return (
          <span
            className={cn(
              "font-money text-[13px] font-semibold",
              outstanding > 0 ? "text-err" : "text-synced"
            )}
          >
            {outstanding > 0 ? fmtRm(outstanding) : "Cleared"}
          </span>
        );
      },
    },
    {
      key: "amount",
      label: "Total",
      width: "128px",
      align: "right",
      getValue: (r) => r.total_centi ?? r.local_total_centi,
      render: (r) => (
        <span className="font-money text-[13px] font-semibold text-ink">
          {fmtRm(r.total_centi || r.local_total_centi)}
        </span>
      ),
    },
    // ── Re-added columns (Phase 1) — data already on the SiRow payload, ported
    //    from the legacy SalesInvoicesList buildColumns (labels/widths). All
    //    default-hidden so the column chooser exposes them without changing the
    //    slim default view. disableSort because the SI list is server-sorted and
    //    these keys aren't in the backend sort whitelist.
    {
      key: "salesperson",
      label: "Salesperson",
      width: "148px",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => salespersonNameOf(null, r.salesperson_id, ""),
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">
          {salespersonNameOf(null, r.salesperson_id, "—")}
        </span>
      ),
    },
    {
      key: "sales_location",
      label: "Location",
      width: "120px",
      defaultHidden: true,
      disableSort: true,
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
      disableSort: true,
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
      key: "paid",
      label: "Paid",
      width: "110px",
      align: "right",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.paid_centi ?? 0,
      render: (r) => (
        <span className="font-money text-[13px] text-ink">{fmtRm(r.paid_centi ?? 0)}</span>
      ),
    },
    {
      key: "phone",
      label: "Phone",
      width: "130px",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.phone ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{formatPhone(r.phone) || "—"}</span>
      ),
    },
    {
      key: "debtor_code",
      label: "Customer Code",
      width: "120px",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.debtor_code ?? "",
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">{r.debtor_code || "—"}</span>
      ),
    },
    {
      key: "email",
      label: "Email",
      width: "180px",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.email ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.email || "—"}</span>
      ),
    },
    {
      key: "address1",
      label: "Address 1",
      width: "180px",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.address1 ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.address1 || "—"}</span>
      ),
    },
    {
      key: "city",
      label: "City",
      width: "130px",
      defaultHidden: true,
      disableSort: true,
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
      disableSort: true,
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
      disableSort: true,
      getValue: (r) => r.customer_state ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.customer_state || "—"}</span>
      ),
    },
    // ── Re-added columns (Phase 2) — NON-finance fields already on the SI
    //    payload (HEADER). Default-hidden + disableSort. Safe for everyone.
    {
      key: "venue",
      label: "Venue",
      width: "150px",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.venue ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.venue || "—"}</span>
      ),
    },
    {
      key: "note",
      label: "Note",
      width: "200px",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.note ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.note || "—"}</span>
      ),
    },
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
    // ── Phase 2 FINANCE columns — cost / margin / per-category subtotals.
    //    DECLARED ONLY for a finance-viewer (backend also omits the keys).
    ...(canFinance
      ? ([
          {
            key: "mattress_sofa_centi",
            label: "Mattress/Sofa",
            width: "120px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.mattress_sofa_centi ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink">{fmtRm(r.mattress_sofa_centi ?? 0)}</span>
            ),
          },
          {
            key: "bedframe_centi",
            label: "Bedframe",
            width: "110px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.bedframe_centi ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink">{fmtRm(r.bedframe_centi ?? 0)}</span>
            ),
          },
          {
            key: "accessories_centi",
            label: "Accessories",
            width: "110px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.accessories_centi ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink">{fmtRm(r.accessories_centi ?? 0)}</span>
            ),
          },
          {
            key: "others_centi",
            label: "Others",
            width: "110px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.others_centi ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink">{fmtRm(r.others_centi ?? 0)}</span>
            ),
          },
          {
            key: "service_centi",
            label: "Service",
            width: "110px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.service_centi ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink">{fmtRm(r.service_centi ?? 0)}</span>
            ),
          },
          {
            key: "mattress_sofa_cost_centi",
            label: "Mattress/Sofa Cost",
            width: "140px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.mattress_sofa_cost_centi ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink-secondary">{fmtRm(r.mattress_sofa_cost_centi ?? 0)}</span>
            ),
          },
          {
            key: "bedframe_cost_centi",
            label: "Bedframe Cost",
            width: "130px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.bedframe_cost_centi ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink-secondary">{fmtRm(r.bedframe_cost_centi ?? 0)}</span>
            ),
          },
          {
            key: "accessories_cost_centi",
            label: "Accessories Cost",
            width: "140px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.accessories_cost_centi ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink-secondary">{fmtRm(r.accessories_cost_centi ?? 0)}</span>
            ),
          },
          {
            key: "others_cost_centi",
            label: "Others Cost",
            width: "130px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.others_cost_centi ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink-secondary">{fmtRm(r.others_cost_centi ?? 0)}</span>
            ),
          },
          {
            key: "service_cost_centi",
            label: "Service Cost",
            width: "130px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.service_cost_centi ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink-secondary">{fmtRm(r.service_cost_centi ?? 0)}</span>
            ),
          },
          {
            key: "total_cost_centi",
            label: "Total Cost",
            width: "120px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.total_cost_centi ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink-secondary">{fmtRm(r.total_cost_centi ?? 0)}</span>
            ),
          },
          {
            key: "total_margin_centi",
            label: "Margin",
            width: "120px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.total_margin_centi ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink">{fmtRm(r.total_margin_centi ?? 0)}</span>
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
        ] satisfies Column<SiRow>[])
      : ([] satisfies Column<SiRow>[])),
  ];

  const statusPillOptions: Array<{ value: StatusTab; label: string }> = [
    { value: "all", label: `All · ${counts.all}` },
    { value: "sent", label: `Sent · ${counts.sent}` },
    { value: "partial", label: `Partial · ${counts.partial}` },
    { value: "paid", label: `Paid · ${counts.paid}` },
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
      <div className="mb-3 flex items-start justify-between gap-3 md:hidden">
        <div className="min-w-0">
          <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
            Sales Invoices
          </h1>
          <div className="mt-0.5 text-[12.5px] text-ink-muted">
            {total} invoice{total === 1 ? "" : "s"} ·{" "}
            <span className="font-money">{fmtRm(money.revenueCenti)}</span> billed
          </div>
        </div>
      </div>

      {/* Desktop sticky page chrome — matches SO/DO listing pattern. */}
      <div className="-mx-4 hidden pb-3 sm:-mx-6 md:block">
        <div className="px-4 sm:px-6">
          <PageHeader
            eyebrow="Supply Chain"
            title="Sales Invoices"
            description={`Every ${shortCompanyName(branding.companyName)} sales invoice — Sent to Paid. Click any row for the quick view; open the full page to edit or record a payment.`}
            primaryAction={
              canWriteSi ? (
                <div className="flex items-stretch gap-2">
                  <Button
                    variant="secondary"
                    icon={<ArrowRightLeft size={14} />}
                    onClick={goFromDo}
                  >
                    From Delivery Order
                  </Button>
                  <div className="flex items-stretch">
                    <Button
                      variant="primary"
                      icon={<Plus size={14} />}
                      onClick={goNewSi}
                      className="rounded-r-none"
                    >
                      New Sales Invoice
                    </Button>
                    <SplitDropdown
                      onFromDo={goFromDo}
                      onFromSo={goFromSo}
                      onImport={goImport}
                    />
                  </div>
                </div>
              ) : undefined
            }
            secondaryActions={[
              { label: "Delivery Orders", icon: Truck, onClick: goDoList },
              { label: "Outstanding Ledger", icon: Wrench, onClick: goOutstanding },
            ]}
          />

          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              pending={statsPending}
              label="Total Invoices"
              value={total.toLocaleString("en-MY")}
              subtitle="All matching invoices"
              rail="bg-primary"
              active
            />
            <StatCard
              pending={statsPending}
              label="Billed"
              value={fmtRm(money.revenueCenti)}
              subtitle="Sum on this page"
              rail="bg-accent"
            />
            <StatCard
              pending={statsPending}
              label="Outstanding"
              value={fmtRm(money.outstandingCenti)}
              subtitle="Balance on this page"
              tone="error"
              rail="bg-err"
            />
            <StatCard
              pending={statsPending}
              label="Paid"
              value={fmtRm(money.paidCenti)}
              subtitle="Receipts on this page"
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

      <div className="sticky top-0 z-10 -mx-4 mb-3 bg-bg/95 px-4 py-2 backdrop-blur-sm md:hidden">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search SI, customer, phone, ref…"
          className="h-10 w-full rounded-lg border border-border bg-surface px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
        <SearchProgress active={searchTransition.isSearching} label={searchTransition.statusText} className="mt-1.5" />
        <SearchScopeHint scope="server" searching={searchTransition.isSearching} countPending={isLoading || isPlaceholderData || Boolean(error) || searchTransition.resultsAreStale} resultCount={total} term={search} className="mt-1" />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 md:hidden">
        <FilterPills
          options={statusPillOptions}
          value={status}
          onChange={(v) => setStatusChip(v)}
        />
      </div>

      <div className="md:hidden">
        {error ? <ListErrorPanel message={(error as Error).message} /> : searchTransition.resultsAreStale ? <SearchPendingPanel label={searchTransition.statusText} /> : <CardsGrid rows={rows} onOpen={(r) => setSelected(r)} />}
        {!searchTransition.resultsAreStale && <div className="pb-24">
          <ListPager
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPageParam}
            onPageSizeChange={(n) => { setPageSize(n); setPageParam(0); }}
          />
        </div>}
      </div>

      <div className="hidden md:block">
        {view === "table" ? (
          <>
            {selectedIds.size > 0 && !searchTransition.resultsAreStale && (
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
                  onClick={() => void printSelectedSis()}
                >
                  {printingDocs ? "Printing…" : `Print all (${selectedIds.size})`}
                </Button>
                <Button variant="ghost" disabled={printingDocs} onClick={clearSelection}>
                  Clear
                </Button>
              </div>
            )}
            <DataTable<SiRow>
              tableId="sales-invoices-v2"
              rows={rows}
              loading={listLoading}
              error={error ? (error as Error).message ?? "Failed to load" : null}
              columns={columns}
              getRowKey={(r) => r.id}
              onRowClick={(r) => setSelected(r)}
              expandable={{
                render: (r) => <SiLinesExpansion id={r.id} />,
                rowKey: (r) => r.id,
              }}
              selection={{
                selectedIds,
                onToggle: toggleSelect,
                onToggleAll: toggleSelectAll,
              }}
              exportName="sales-invoices"
              serverSort
              onSortChange={setSortAndReset}
              emptyLabel={
                filtersActive
                  ? "No invoices match — try Reset layout to clear filters."
                  : "No sales invoices yet."
              }
              search={{
                value: search,
                onChange: setSearch,
                placeholder: "Search SI no, customer, phone, ref…",
                debounceMs: 0,
                searching: searchTransition.isSearching,
                countPending: isLoading || isPlaceholderData || Boolean(error) || searchTransition.resultsAreStale,
                scope: "server",
                totalRecords: total,
              }}
              resetFilters={{
                active: filtersActive,
                onReset: resetLayout,
                label: "Reset layout",
              }}
            />
            {!searchTransition.resultsAreStale && <ListPager
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPageParam}
              onPageSizeChange={(n) => { setPageSize(n); setPageParam(0); }}
            />}
          </>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex flex-1 items-center gap-2">
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search SI no, customer, phone, ref…"
                  className="h-9 max-w-[320px] flex-1 rounded-md border border-border bg-surface px-3.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
                <SearchProgress active={searchTransition.isSearching} />
                <SearchScopeHint scope="server" searching={searchTransition.isSearching} countPending={isLoading || isPlaceholderData || Boolean(error) || searchTransition.resultsAreStale} resultCount={total} term={search} />
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
            </div>
            {error ? <ListErrorPanel message={(error as Error).message} /> : searchTransition.resultsAreStale ? <SearchPendingPanel label={searchTransition.statusText} /> : <><CardsGrid rows={rows} onOpen={(r) => setSelected(r)} />
            <ListPager
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPageParam}
              onPageSizeChange={(n) => { setPageSize(n); setPageParam(0); }}
            /></>}
          </>
        )}
      </div>
      </div>

      <DetailDrawer
        row={selected}
        onClose={() => setSelected(null)}
        onOpenFull={() => selected && goFullPage(selected)}
        onEdit={() => selected && goEdit(selected)}
        onPrint={() => selected && goPrint(selected)}
        onMarkPaid={() => selected && doMarkPaid(selected)}
        onRecordPayment={() => selected && goRecordPayment(selected)}
        onReopen={() => selected && void doReopen(selected)}
        canWrite={canWriteSi}
        salespersonName={
          selected ? salespersonNameOf(null, selected.salesperson_id) : "—"
        }
      />
    </PullToRefresh>
  );
}

export default SalesInvoicesListV2;
