
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { siPaymentIntentSearch } from "./siPaymentIntent";
import { salesInvoiceRowMenu } from "./row-menus";
import {
  siCreditNotesSen,
  siDepositAppliedSen,
  siOutstandingSen,
  siIsCancelled,
  siOwesNothing,
} from "../../vendor/scm/lib/si-outstanding";
import { brandingToneForLabel } from "../../lib/brandingTone";
import { transferFromLabel, transferFromColumnLabel } from "../../lib/convertScope";
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
import { fetchSiExportRows, type SiListLine } from "../../vendor/scm/lib/si-list-export";
import { siGridColumns } from "./si-list-columns";
import { PageHeader } from "../../components/Layout";
import { StatCard } from "../../components/StatCard";
import { FilterPills } from "../../components/FilterPills";
import { DataTable, type Column } from "../../components/DataTable";
import {
  DocumentLinesExpansion,
  sourcePoTitle,
  ChipOverflow,
  StockAdjChip,
  type DocumentDrillLine,
  type DrillItemFields,
} from "../../components/DocumentLinesExpansion";
import { ListPager } from "../../components/ListPager";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useVisibleRows } from "../../hooks/useVisibleRows";
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
import { useMfgCustomers } from "../../vendor/scm/lib/sales-order-queries";
import { useServerColumnFunnels, funnelValues } from "../../hooks/useServerColumnFunnels";
import { conditionDateRange } from "../../components/dataTableConditionFilters";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { useChoice } from "../../vendor/scm/components/ChoiceDialog";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "../../lib/utils";
import { isCancelledDocStatus } from "../../lib/scm";
import { ResizableDetailDrawer } from "../../components/ResizableDetailDrawer";
import { useAuth } from "../../auth/AuthContext";
import { buildVariantSummary, fmtSen, fmtDate, orderLineIdentity } from "@2990s/shared";
import { formatPhone } from "@2990s/shared/phone";
import { usePrintDocument } from "../../components/scm-v2/PrintChainProvider";
import { PrintPreviewBatchModal, usePrintPreview } from "../../components/scm-v2/PrintPreviewModal";
import type { PdfAction } from "../../vendor/scm/lib/pdf-common";
import { salesInvoicePrintChain } from "../../lib/printChain";
import { customerRefOf } from '../../../../shared/src/lib/customer-ref';
import { OVERDUE_CLASS, isPastDue } from '../../lib/tableHighlight';
import { todayMyt } from "../../vendor/scm/lib/dates";


type SiRow = {
  id: string;
  invoice_number: string;
  linked_ac_docno?: string | null;
  ac_agent?: string | null;
  lines?: SiListLine[];
  subtotal_sen?: number | null;
  tax_sen?: number | null;
  so_doc_no: string | null;
  delivery_order_id: string | null;
  do_number?: string | null;
  /** Source PO(s) the invoiced goods came from (batch_no = source PO on the SI's
   *  DO's OUT movements ∪ consumed FIFO lots). "—" for un-batched stock. A sales
   *  invoice shows Source PO, not an Assigned SO (owner 2026-07-31). */
  source_pos?: string[] | null;
  /** Shipped (at least partly) from a PO-less stock ADJUSTMENT lot — renders a
   *  "STOCK ADJ" chip so the cell is explained, never blank (owner 2026-08-01). */
  source_adj?: boolean;
  invoice_date: string;
  due_date: string | null;
  customer_delivery_date?: string | null;
  so_processing_date?: string | null;
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
  local_total_sen: number;
  total_sen: number;
  paid_sen: number;
  so_deposit_applied_sen?: number | null;
  credit_notes_sen?: number | null;
  status: string;
  currency: string;
  line_count?: number;
  venue: string | null;
  note: string | null;
  customer_type: string | null;
  building_type: string | null;
  mattress_sofa_sen?: number;
  bedframe_sen?: number;
  accessories_sen?: number;
  others_sen?: number;
  service_sen?: number;
  mattress_sofa_cost_sen?: number;
  bedframe_cost_sen?: number;
  accessories_cost_sen?: number;
  others_cost_sen?: number;
  service_cost_sen?: number;
  total_cost_sen?: number;
  total_margin_sen?: number;
  margin_pct_basis?: number;
};

type StatusTab = "all" | "draft" | "sent" | "partial" | "paid" | "cancelled";

const fmtPctBasis = (basis: number | null | undefined): string =>
  basis == null ? "—" : `${(basis / 100).toFixed(1)}%`;

const refOf = (r: SiRow): string => customerRefOf(r) || "—";

const soOf = (r: SiRow): string => r.so_doc_no || "—";
const doOf = (r: SiRow): string => r.do_number || "—";

const brandOf = (r: SiRow): string => r.branding || "—";
const brandTone = brandingToneForLabel;

const STATUS_TONE: Record<
  string,
  { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab }
> = {
  draft:           { tone: "warning", label: "Draft",       bucket: "draft" },
  sent:            { tone: "warning", label: "Submitted",   bucket: "sent" },
  issued:          { tone: "warning", label: "Submitted",   bucket: "sent" },
  overdue:         { tone: "error",   label: "Overdue",     bucket: "sent" },
  partially_paid:  { tone: "warning", label: "Partially paid", bucket: "partial" },
  partial:         { tone: "warning", label: "Partially paid", bucket: "partial" },
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

const outstandingOf = (r: SiRow): number => siOwesNothing(r.status) ? 0 :
  siOutstandingSen(r.total_sen || r.local_total_sen || 0, r.paid_sen || 0, siDepositAppliedSen(r), siCreditNotesSen(r));


function SplitDropdown({
  onFromDo,
}: {
  onFromDo: () => void;
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
                  Outstanding{siDepositAppliedSen(r) > 0 ? " · after SO deposit" : ""}{siCreditNotesSen(r) > 0 ? " · after credit notes" : ""}
                </div>
                <div
                  className={cn(
                    "mt-0.5 font-money text-[12.5px] font-semibold",
                    outstanding > 0 ? "text-err" : "text-synced"
                  )}
                >
                  {siIsCancelled(r.status) ? "—" : outstanding > 0 ? fmtSen(outstanding) : "Cleared"}
                </div>
              </div>
              <span className="font-money text-[15px] font-bold text-ink">
                {fmtSen(r.total_sen || r.local_total_sen)}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}


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
    item_code?: string;
    product_name?: string;
    description?: string;
    description2?: string;
    item_group?: string;
    variants?: Record<string, unknown> | null;
    qty?: number;
    unit_price_sen?: number;
    amount_sen?: number;
    total_sen?: number;
  }> =
    ((detailQ.data as { items?: unknown[] } | undefined)?.items as Array<{
      item_code?: string;
      product_name?: string;
      description?: string;
      description2?: string;
      item_group?: string;
      variants?: Record<string, unknown> | null;
      qty?: number;
      unit_price_sen?: number;
      amount_sen?: number;
      total_sen?: number;
    }>) ?? [];

  const open = !!row;
  const st = row ? statusFor(row.status) : null;

  const totalSen = row?.total_sen ?? row?.local_total_sen ?? 0;
  const paidSen = row?.paid_sen ?? 0;
  const depositSen = siDepositAppliedSen(row);
  const outstanding = siOwesNothing(row?.status) ? 0 : siOutstandingSen(totalSen, paidSen, depositSen, siCreditNotesSen(row));

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
                <MetaItem k={transferFromColumnLabel('so')} v={soOf(row)} mono />
                <MetaItem k={transferFromColumnLabel('do')} v={doOf(row)} mono />
                <MetaItem k="Ref No." v={refOf(row)} mono />
                <MetaItem k="Due date" v={fmtDate(row.due_date)} />
                {/* Owner 2026-07-24 — Processing (linked SO's
                    processing_date) + Delivery must be visible in every
                    quick view. Delivery prefers the SI's own snapshot, falling
                    back to the linked SO's date for pre-snapshot rows. */}
                <MetaItem k="Processing" v={fmtDate(row.so_processing_date ?? null)} />
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
                    l.amount_sen ??
                    l.total_sen ??
                    (l.qty ?? 0) * (l.unit_price_sen ?? 0);
                  const { primary, secondary } = orderLineIdentity({
                    code: l.item_code || l.item_code,
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
                        {fmtSen(l.unit_price_sen ?? 0)}
                      </span>
                      <span className="text-right font-money text-[12.5px] font-semibold text-ink">
                        {fmtSen(amt)}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 rounded-lg border border-border bg-surface px-5 py-4">
                <TotalRow k="Invoice total" v={fmtSen(totalSen)} strong />
                <TotalRow
                  k={depositSen > 0 ? "Paid on this invoice" : "Paid"}
                  v={fmtSen(paidSen)}
                  tone="success"
                />
                {depositSen > 0 && (
                  <TotalRow
                    k={`Deposit on ${row.so_doc_no ?? "the order"}`}
                    v={fmtSen(depositSen)}
                    tone="success"
                  />
                )}
                <TotalRow
                  k="Outstanding"
                  v={siIsCancelled(row.status) ? "—" : outstanding > 0 ? fmtSen(outstanding) : "Cleared"}
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

const SORT_COL_MAP: Record<string, string> = {
  amount: "total_sen",
};

function SiLinesExpansion({ id }: { id: string }) {
  const detailQ = useSalesInvoiceDetail(id);
  const items =
    ((detailQ.data as { items?: Array<DrillItemFields & { source_pos?: string[] | null; source_adj?: boolean }> } | undefined)?.items ?? []);
  const lines: DocumentDrillLine[] = items.map((l) => ({
    itemGroup: l.item_group ?? null,
    code: l.item_code || l.item_code || null,
    description: l.description || l.product_name || null,
    description2: l.description2 ?? null,
    variants: l.variants ?? null,
    qty: Number(l.qty ?? 0),
    amountSen:
      l.amount_sen ??
      l.total_sen ??
      Number(l.qty ?? 0) * (l.unit_price_sen ?? 0),
    // An SI is invoiced from a DO — show which PO the goods were procured on
    // (batch_no = source PO), not an Assigned SO (owner 2026-07-31).
    sourcePos: l.source_pos ?? [],
    sourceAdj: l.source_adj ?? false,
  }));
  return (
    <DocumentLinesExpansion
      isLoading={detailQ.isLoading}
      coverage="ready"
      isError={Boolean(detailQ.error)}
      errorMessage={detailQ.error instanceof Error ? detailQ.error.message : null}
      lines={lines}
      emptyLabel="No lines on this sales invoice."
      showSourcePo
    />
  );
}


export function SalesInvoicesListV2() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const notify = useNotify();
  const askChoice = useChoice();
  const askConfirm = useConfirm();
  const { nameOf: salespersonNameOf } = useStaffLookup();
  const branding = useBranding();
  const { user, can, pageAccess } = useAuth();
  const canFinance = canViewScmCosting(user);
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
  // Server-filterable funnels (owner 2026-09-16): Customer Name + Currency → list query (pager over the filtered set); Debtor CODE + line/MRP funnels stay client-side; Customer checklist seeded with every customer.
  const customersQ = useMfgCustomers();
  const customerNames = useMemo(() => [...new Set((customersQ.data?.customers ?? []).map((cst) => cst.name).filter((n): n is string => !!n))], [customersQ.data]);
  const { serverFunnels, onColFiltersChange } = useServerColumnFunnels(
    (cf) => ({ ...conditionDateRange(cf["invoice_date"]), debtorNames: funnelValues(cf, "debtor_name"), currencies: funnelValues(cf, "currency") }),
    () => setPageParam(0),
  );
  const { requestTerm: debouncedSearch } = useDebouncedSearchTerm(search);

  const apiStatus = status === "all" ? undefined : status;

  const { data, isLoading, isFetching, isPlaceholderData, error, refetch } = useSalesInvoicesPaged({
    page,
    pageSize,
    status: apiStatus,
    q: debouncedSearch,
    sort,
    ...serverFunnels,
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
  const statsFailed = Boolean(error);
  const statsPending =
    isLoading || isPlaceholderData || Boolean(error) || searchTransition.resultsAreStale;
  const updateStatus = useUpdateSalesInvoiceStatus();

  const rows = (data?.salesInvoices ?? []) as SiRow[];
  const total = data?.total ?? 0;
  const counts = data?.statusCounts ?? {
    all: 0,
    draft: 0,
    sent: 0,
    partial: 0,
    paid: 0,
    cancelled: 0,
  };

  /* The rows the TABLE is showing — the server page minus whatever the
     per-column funnels hide (owner 2026-08-13, following the Purchase Orders
     fix). See hooks/useVisibleRows for why summarising the server page put two
     contradictory numbers on one screen. */
  const visible = useVisibleRows(rows);

  const money = useMemo(() => {
    let revenueSen = 0;
    let outstandingSen = 0;
    let paidSen = 0;
    for (const r of visible.rows) {
      if (siIsCancelled(r.status)) continue;
      const t = r.total_sen ?? r.local_total_sen ?? 0;
      const paid = r.paid_sen ?? 0;
      revenueSen += t;
      paidSen += paid;
      outstandingSen += siOwesNothing(r.status) ? 0 : siOutstandingSen(t, paid, siDepositAppliedSen(r), siCreditNotesSen(r));
    }
    return { revenueSen, outstandingSen, paidSen };
  }, [visible.rows]);

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
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["sales-invoices"] }),
      queryClient.invalidateQueries({ queryKey: ["sales-invoices-paged"] }),
    ]);
  };

  /* The ONE Export (owner 2026-09-15): every invoice the list's tab + search +
     sort match, under the caller's sales scope — not the page on screen — one
     row per line, with the grid's visible columns, funnels and sort (DataTable
     `exportLines`). The filter is the one the list request is built from. */
  const exportFilters = { status: apiStatus, q: debouncedSearch, sort };
  const exportLines = {
    fetchRows: (need: { exportKeys: string[]; filterKeys: string[] }) => fetchSiExportRows<SiRow>(exportFilters, need),
    linesOf: (r: SiRow): readonly SiListLine[] => r.lines ?? [],
    sheetName: "Sales Invoices",
    onError: (e: Error) => {
      void notify({ title: "Export failed", body: e.message || "The export could not be completed.", tone: "error" });
    },
  };

  const goNewSi = () => navigate("/scm/sales-invoices/new");
  const goFromDo = () => navigate("/scm/sales-invoices/from-do");
  const goDoList = () => navigate("/scm/delivery-orders");
  const goOutstanding = () => navigate("/scm/outstanding");
  const goEdit = (r: SiRow) => navigate(`/scm/sales-invoices/${r.id}?edit=1`);
  const printDocument = usePrintDocument();
  const goFullPage = (r: SiRow) => navigate(`/scm/sales-invoices/${r.id}`);

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

  const fetchSiBundle = async (
    row: SiRow
  ): Promise<{ header: unknown; items: unknown[] }> => {
    const json = await authedFetch<{ salesInvoice: unknown; items: unknown[] }>(
      `/sales-invoices/${row.id}`
    );
    return { header: json.salesInvoice, items: json.items };
  };

  const deliverSelectedSis = async (action: PdfAction) => {
    if (printingDocs) return;
    const chosen = rows.filter((r) => selectedIds.has(r.id));
    if (chosen.length === 0) return;
    try {
      const { generateSalesInvoicePdf, generateCombinedSalesInvoicePdf } =
        await import("../../vendor/scm/lib/sales-invoice-pdf");
      if (chosen.length === 1) {
        setPrintingDocs(true);
        const b = await fetchSiBundle(chosen[0]!);
        await generateSalesInvoicePdf(b.header as never, b.items as never, { action });
        clearSelection();
        return;
      }
      const how = action !== "save" ? "one" : await askChoice({
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
          fileName: `sales-invoices-${todayMyt()}.pdf`,
          action,
        });
      } else {
        for (const b of bundles)
          await generateSalesInvoicePdf(b.header as never, b.items as never, { action });
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
  const batchPrint = usePrintPreview(deliverSelectedSis);
  const siContextMenu = salesInvoiceRowMenu<SiRow>({
    open: goFullPage, edit: goEdit, print: printDocument,
    recordPayment: (r) => goRecordPayment(r),
    canPay: (r) => canWriteSi && !["CANCELLED", "DRAFT", "PAID"].includes(r.status.toUpperCase()),
  });
  /* Mark paid used to `updateStatus.mutate({ status: "paid" })` from here —
     a hand-written status and no receipt, so the invoice read as settled with
     nothing banked and the server's own rollup reverted it on the next touch
     (docs/bugs/0528-…). It now opens the DETAIL screen's payment editor with the
     balance seeded, because the amount has to be computed where
     `orderDepositUnavailable` is known: a list row carries only
     `so_deposit_applied_sen`, which reads absent-or-null as 0, so an order this
     screen could not resolve would show the FULL total and book the customer's
     deposit a second time. */
  const goMarkPaid = (r: SiRow) => {
    setSelected(null);
    navigate(`/scm/sales-invoices/${r.id}${siPaymentIntentSearch("balance")}`);
  };
  const goRecordPayment = (r: SiRow) =>
    navigate(`/scm/sales-invoices/${r.id}${siPaymentIntentSearch("open")}`);
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

  const erpColumns: Column<SiRow>[] = [
    {
      key: "invoice_number",
      label: "SI No.",
      // 156 + font-docno (owner 2026-07-31): 132 clipped a full doc no by a
      // couple of px — see the measured DO No. note in MfgDeliveryOrdersListV2.
      width: "156px",
      alwaysVisible: true,
      getValue: (r) => r.invoice_number,
      render: (r) => (
        <span
          className={cn(
            "font-docno text-[12.5px] font-semibold text-ink",
            isCancelledDocStatus(r.status) && "dt-cancel-strike",
          )}
        >
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
      render: (r) => {
        const bucket = (STATUS_TONE[r.status.toLowerCase()] as (typeof STATUS_TONE)[string] | undefined)?.bucket;
        const late = isPastDue(r.due_date, bucket !== "paid" && bucket !== "cancelled");
        return (
          <span className={cn("text-[12.5px]", late ? OVERDUE_CLASS : "text-ink-secondary")} title={late ? "Past due and not paid" : undefined}>
            {fmtDate(r.due_date)}
          </span>
        );
      },
    },
    {
      key: "so_doc_no",
      label: transferFromColumnLabel('so'),
      width: "128px",
      disableSort: true,
      getValue: (r) => r.so_doc_no ?? "",
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">{soOf(r)}</span>
      ),
    },
    {
      key: "do_number",
      label: transferFromColumnLabel('do'),
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
      // (batch_no = source PO on the SI's DO, GRN-healed). "STOCK ADJ" when the
      // goods entered via a PO-less adjustment; "—" only when the ledger says
      // nothing. List cells overflow past a few chips into an in-place "+N"
      // toggle (owner 2026-08-01 scale ruling).
      key: "source_pos",
      label: "Source PO",
      width: "168px",
      disableSort: true,
      getValue: (r) => (r.source_pos ?? []).join(", "),
      render: (r) => {
        const pos = r.source_pos ?? [];
        if (pos.length === 0 && !r.source_adj) return <span className="text-[12px] text-ink-muted">—</span>;
        const chips = [
          ...pos.map((po) => (
            <button
              key={po}
              type="button"
              title={sourcePoTitle(po)}
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/scm/purchase-orders?q=${encodeURIComponent(po)}`);
              }}
              className="rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-docno text-[11px] font-semibold text-accent-ink hover:border-accent hover:text-accent"
            >
              {po}
            </button>
          )),
          ...(r.source_adj ? [<StockAdjChip key="adj" />] : []),
        ];
        return <ChipOverflow chips={chips} />;
      },
    },
    {
      key: "debtor_name",
      label: "Customer",
      getValue: (r) => r.debtor_name,
      filterSeedValues: customerNames,
      render: (r) => (
        <span className="text-[13px] font-semibold text-ink">
          {r.debtor_name || "—"}
        </span>
      ),
    },
    {
      key: "reference",
      label: "Ref No.",
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
      className: "dt-cancel-keep",
      // The export writes the word on screen (owner 2026-09-15).
      getValue: (r) => statusFor(r.status).label,
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
      disableSort: true,
      getValue: (r) => outstandingOf(r),
      render: (r) => {
        const outstanding = outstandingOf(r);
        const dep = siDepositAppliedSen(r);
        const credit = siCreditNotesSen(r);
        return (
          <span
            className={cn(
              "inline-flex items-center gap-1 font-money text-[13px] font-semibold",
              outstanding > 0 ? "text-err" : "text-synced"
            )}
            title={
              [dep > 0 ? `${fmtSen(dep)} was collected on ${r.so_doc_no ?? "the sales order"} and settles this invoice.` : "",
                credit > 0 ? `${fmtSen(credit)} was knocked off by credit notes.` : ""].filter(Boolean).join(" ") || undefined
            }
          >
            {siIsCancelled(r.status) ? "—" : outstanding > 0 ? fmtSen(outstanding) : "Cleared"}
            {[dep > 0 ? "dep" : "", credit > 0 ? "cn" : ""].filter(Boolean).map((m) => (
              <span key={m} className="rounded-sm bg-surface-2 px-1 font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
                {m}
              </span>
            ))}
          </span>
        );
      },
    },
    {
      key: "amount",
      label: "Total",
      width: "128px",
      align: "right",
      getValue: (r) => r.total_sen ?? r.local_total_sen,
      render: (r) => (
        <span className="font-money text-[13px] font-semibold text-ink">
          {fmtSen(r.total_sen || r.local_total_sen)}
        </span>
      ),
    },
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
      key: "so_deposit",
      label: "SO deposit",
      width: "120px",
      align: "right",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => siDepositAppliedSen(r),
      render: (r) => {
        const dep = siDepositAppliedSen(r);
        return dep > 0 ? (
          <span className="font-money text-[13px] text-synced" title={r.so_doc_no ?? undefined}>
            {fmtSen(dep)}
          </span>
        ) : (
          <span className="text-[12.5px] text-ink-muted">—</span>
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
      getValue: (r) => r.paid_sen ?? 0,
      render: (r) => (
        <span className="font-money text-[13px] text-ink">{fmtSen(r.paid_sen ?? 0)}</span>
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
              <span className="font-money text-[13px] text-ink">{fmtSen(r.mattress_sofa_sen ?? 0)}</span>
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
              <span className="font-money text-[13px] text-ink">{fmtSen(r.bedframe_sen ?? 0)}</span>
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
              <span className="font-money text-[13px] text-ink">{fmtSen(r.accessories_sen ?? 0)}</span>
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
              <span className="font-money text-[13px] text-ink">{fmtSen(r.others_sen ?? 0)}</span>
            ),
          },
          {
            key: "service_sen",
            label: "Service",
            width: "110px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.service_sen ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink">{fmtSen(r.service_sen ?? 0)}</span>
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
              <span className="font-money text-[13px] text-ink-secondary">{fmtSen(r.mattress_sofa_cost_sen ?? 0)}</span>
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
              <span className="font-money text-[13px] text-ink-secondary">{fmtSen(r.bedframe_cost_sen ?? 0)}</span>
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
              <span className="font-money text-[13px] text-ink-secondary">{fmtSen(r.accessories_cost_sen ?? 0)}</span>
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
              <span className="font-money text-[13px] text-ink-secondary">{fmtSen(r.others_cost_sen ?? 0)}</span>
            ),
          },
          {
            key: "service_cost_sen",
            label: "Service Cost",
            width: "130px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.service_cost_sen ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink-secondary">{fmtSen(r.service_cost_sen ?? 0)}</span>
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
              <span className="font-money text-[13px] text-ink-secondary">{fmtSen(r.total_cost_sen ?? 0)}</span>
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
              <span className="font-money text-[13px] text-ink">{fmtSen(r.total_margin_sen ?? 0)}</span>
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

  const columns = siGridColumns<SiRow>(erpColumns);

  const statusPillOptions: Array<{ value: StatusTab; label: string }> = [
    { value: "all", label: `All · ${counts.all}` },
    { value: "draft", label: `Draft · ${counts.draft}` },
    { value: "sent", label: `Sent · ${counts.sent}` },
    { value: "partial", label: `Partial · ${counts.partial}` },
    { value: "paid", label: `Paid · ${counts.paid}` },
    { value: "cancelled", label: `Cancelled · ${counts.cancelled}` },
  ];

  return (
    <PullToRefresh onRefresh={onPullToRefresh}>
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
            <span className="font-money">{fmtSen(money.revenueSen)}</span> billed
          </div>
        </div>
      </div>

      <div className="-mx-4 hidden pb-3 sm:-mx-6 md:block">
        <div className="px-4 sm:px-6">
          <PageHeader
            eyebrow="Supply Chain"
            title="Sales Invoices"
            description={`Every ${shortCompanyName(branding.companyName)} sales invoice — Sent to Paid. Click any row for the quick view; open the full page to edit or record a payment.`}
            primaryAction={
              <div className="flex items-stretch gap-2">
                {canWriteSi ? (
                  <>
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
                        onClick={goNewSi}
                        className="rounded-r-none"
                      >
                        New Sales Invoice
                      </Button>
                      <SplitDropdown
                        onFromDo={goFromDo}
                      />
                    </div>
                  </>
                ) : null}
              </div>
            }
            secondaryActions={[
              { label: "Delivery Orders", icon: Truck, onClick: goDoList },
              { label: "Outstanding Ledger", icon: Wrench, onClick: goOutstanding },
            ]}
          />

          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {/* Every tile describes the rows ON SCREEN and says so while a
                column funnel narrows them (owner 2026-08-13). The count tile
                switches SOURCE, not just wording: `total` is the server's full
                match count and contradicts the table the moment a client-side
                funnel hides part of the page. */}
            <StatCard
              pending={statsPending} failed={statsFailed} onRetry={() => void refetch()}
              label="Total Invoices"
              value={(visible.filtered ? visible.rows.length : total).toLocaleString("en-MY")}
              subtitle={visible.filtered ? "Filtered · shown below" : "All matching invoices"}
              rail="bg-primary"
              active
            />
            <StatCard
              pending={statsPending} failed={statsFailed} onRetry={() => void refetch()}
              label="Billed"
              value={fmtSen(money.revenueSen)}
              subtitle={visible.filtered ? "Filtered · sum shown below" : "Sum on this page"}
              rail="bg-accent"
            />
            <StatCard
              pending={statsPending} failed={statsFailed} onRetry={() => void refetch()}
              label="Outstanding"
              value={fmtSen(money.outstandingSen)}
              subtitle={visible.filtered ? "Balance · filtered" : "Balance on this page"}
              tone="error"
              rail="bg-err"
            />
            <StatCard
              pending={statsPending} failed={statsFailed} onRetry={() => void refetch()}
              label="Paid"
              value={fmtSen(money.paidSen)}
              subtitle={visible.filtered ? "Receipts · filtered" : "Receipts on this page"}
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
                  onClick={batchPrint.openPreview}
                >
                  {printingDocs ? "Printing…" : `Print all (${selectedIds.size})`}
                </Button>
                <PrintPreviewBatchModal
                  open={batchPrint.open}
                  onClose={batchPrint.close}
                  docTitle="Sales Invoices"
                  docNos={rows.filter((r) => selectedIds.has(r.id)).map((r) => r.invoice_number)}
                  {...batchPrint.handlers}
                />
                <Button variant="ghost" disabled={printingDocs} onClick={clearSelection}>
                  Clear
                </Button>
              </div>
            )}
            <DataTable<SiRow, SiListLine>
              tableId="sales-invoices-v2"
              rows={rows}
              onFilteredRowsChange={visible.onFilteredRowsChange}
              onColFiltersChange={onColFiltersChange}
              loading={listLoading}
              error={error ? (error as Error).message ?? "Failed to load" : null}
              columns={columns}
              getRowKey={(r) => r.id}
              getRowClassName={(r) =>
                isCancelledDocStatus(r.status) ? "dt-row-cancelled" : undefined
              }
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
              contextMenu={siContextMenu}
              exportName="sales-invoices"
              exportLines={exportLines}
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
        onPrint={() => selected && printDocument(salesInvoicePrintChain(selected).own)}
        onMarkPaid={() => selected && goMarkPaid(selected)}
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
