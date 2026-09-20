// PurchaseInvoicesListV2 — Theme C redesign of the Purchase Invoice listing.
// Procurement-side twin of SalesInvoicesListV2: same payment-lifecycle
// framing, but the money flows OUT to the supplier instead of in from the
// customer. Outstanding here is what WE owe, not what customers owe us.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { buildVariantSummary, fmtSen, fmtDate, orderLineIdentity } from "@2990s/shared";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Plus,
  ChevronDown,
  Users,
  Package,
  LayoutGrid,
  Table as TableIcon,
  X as XIcon,
  ExternalLink,
  Edit3,
  Printer,
  Wallet,
  ArrowRightLeft,
} from "lucide-react";
import { fetchPiExportRows, PI_DEFAULT_COLUMN_KEYS, PI_LABELS, senToRinggit, type PiListLine } from "../../vendor/scm/lib/pi-list-export";
import type { PiPoPriceSummary } from "../../vendor/scm/lib/pi-list-po-price";
import { piLineColumns } from "./pi-list-line-columns";
import { transferFromLabel } from '../../lib/convertScope';
import { PrintPreviewBatchModal, usePrintPreview } from "../../components/scm-v2/PrintPreviewModal";
import type { PdfAction } from "../../vendor/scm/lib/pdf-common";
import { PageHeader } from "../../components/Layout";
import { StatCard } from "../../components/StatCard";
import { FilterPills } from "../../components/FilterPills";
import { DataTable, type Column } from "../../components/DataTable";
import {
  DocumentLinesExpansion,
  AssignedSoCell,
  DeliveredCell,
  type DocumentDrillLine,
  type DrillItemFields,
} from "../../components/DocumentLinesExpansion";
import { coverageStateOf } from "../../components/coverage-state";
import { usePoSoCoverage, originsByCode, provenanceByCode, storedLinkSkus, deliveredByCode, type OriginAssignment } from "../../vendor/scm/lib/flow-queries";
import { ListPager } from "../../components/ListPager";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useVisibleRows } from "../../hooks/useVisibleRows";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { PullToRefresh } from "../../components/PullToRefresh";
import { ListErrorPanel, SearchPendingPanel, SearchProgress } from "../../components/SearchProgress";
import { SearchScopeHint } from "../../components/SearchScopeHint";
import { useDebouncedSearchTerm, useSearchResultTransition } from "../../hooks/useServerSearch";
import { useSuppliers } from "../../vendor/scm/lib/suppliers-queries";
import { useServerColumnFunnels, funnelValues } from "../../hooks/useServerColumnFunnels";
import { poPriceMarker, usePiListPoPriceMap } from "../../vendor/scm/lib/pi-list-po-price";
import {
  usePurchaseInvoicesPaged,
  useEnrichedPiListRows,
  usePurchaseInvoiceDetail,
  useCancelPurchaseInvoice,
  usePostPurchaseInvoice,
} from "../../vendor/scm/lib/purchase-invoice-queries";
import { useAuth as useHouzsAuth } from "../../auth/AuthContext";
import { apPaymentHrefFor, canOpenApPayment, piAwaitsPayment } from "../../vendor/scm/lib/pi-payment-path";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { useChoice } from "../../vendor/scm/components/ChoiceDialog";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "../../lib/utils";
import { isCancelledDocStatus } from "../../lib/scm";
import { purchaseInvoiceRowMenu } from "./row-menus";
import { ScanInvoiceModal } from "../../vendor/scm/components/ScanInvoiceModal";
import { useHoldAction } from "./use-hold-action";
import { ResizableDetailDrawer } from "../../components/ResizableDetailDrawer";
import { StatusWithHold, rowIsHeld, type HoldFields } from "../../vendor/scm/components/HoldChip";
import { usePrintDocument } from "../../components/scm-v2/PrintChainProvider";
import { purchaseInvoicePrintChain } from "../../lib/printChain";

// ─── Types ──────────────────────────────────────────────────────────────────

type PiRow = HoldFields & {
  /** The AutoCount invoice number, when the invoice is in the book. */
  linked_ac_docno?: string | null;
  supplier_invoice_ref?: string | null;
  exchange_rate?: number | string | null;
  subtotal_sen?: number | null;
  tax_sen?: number | null;
  /** Every line, AutoCount-spelled (GET /purchase-invoices?page= and /export/rows). */
  lines?: PiListLine[];
  /** The "vs PO price" summary, stamped on exported rows only (pi-list-export.ts). */
  po_price_summary?: PiPoPriceSummary;
  id: string;
  invoice_number: string;
  status: string;
  invoice_date: string | null;
  due_date: string | null;
  total_sen?: number;
  paid_sen?: number;
  currency?: string;
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
  line_count?: number;
  /** Collapsed "Assigned SO" column (owner 2026-07-31) — inherited from the
      parent PO (resolved pi.grn_id → grn → PO), server-side for the whole page. */
  assigned_sos?: OriginAssignment[];
  assigned_so_linked?: boolean;
  /** PR-3 (2026-08-07) — the parallel stored-origin "bought for" SO(s),
      rendered muted beside the precedence chips. Optional: older backend. */
  assigned_so_provenance?: OriginAssignment[];
  /** "Delivered" column (owner 2026-07-31) — the DO(s) that shipped the parent
      PO's goods + qty per DO. EVERY DO renders; empty when nothing shipped. */
  delivered_dos?: Array<{ doNo: string; qty: number }>;
};

type PiItem = {
  id: string;
  item_code?: string | null;
  description?: string | null;
  description2?: string | null;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
  uom?: string;
  qty?: number;
  unit_price_sen?: number;
  line_total_sen?: number;
};

type StatusTab = "all" | "draft" | "posted" | "partial" | "paid" | "cancelled" | "on_hold";

// ─── Helpers ────────────────────────────────────────────────────────────────

const fmtRm = (centi: number): string => fmtSen(centi);

const supplierNameOf = (r: PiRow): string => r.supplier?.name || "—";
const supplierCodeOf = (r: PiRow): string => r.supplier?.code || "—";

const totalOf = (r: PiRow): number => r.total_sen ?? 0;
const paidOf = (r: PiRow): number => r.paid_sen ?? 0;
const outstandingOf = (r: PiRow): number => Math.max(0, totalOf(r) - paidOf(r));

const sourceOf = (r: PiRow): string =>
  r.grn?.grn_number || r.purchase_order?.po_number || "—";

// PI lifecycle: DRAFT → POSTED → PARTIALLY_PAID → PAID / CANCELLED.
const STATUS_TONE: Record<
  string,
  { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab }
> = {
  DRAFT:          { tone: "warning", label: "Draft",           bucket: "draft" },
  POSTED:         { tone: "warning", label: "Submitted",       bucket: "posted" },
  PARTIALLY_PAID: { tone: "warning", label: "Partially paid",  bucket: "partial" },
  PAID:           { tone: "success", label: "Paid",            bucket: "paid" },
  CANCELLED:      { tone: "error",   label: "Cancelled",       bucket: "cancelled" },
  /* ON_HOLD (mig 0320) — the disputed bill that must not be paid while it is
     queried. This is the ONE hold of the three that needed a written guard:
     payment-vouchers.ts refuses to settle a held invoice (allocation_on_hold). */
  ON_HOLD:        { tone: "warning", label: "On Hold",         bucket: "on_hold" },
};

const statusFor = (
  s: string
): { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab } =>
  STATUS_TONE[(s || "").toUpperCase()] ?? {
    tone: "neutral",
    label: s || "—",
    bucket: "posted",
  };

// ─── Split-menu + view toggle ──────────────────────────────────────────────

function SplitDropdown({
  onFromGrn,
  onImport,
  onDuplicate,
  onScan,
}: {
  onFromGrn: () => void;
  onImport: () => void;
  onDuplicate: () => void;
  onScan: () => void;
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
          <div className="fixed inset-0 z-[80]" onClick={() => setOpen(false)} aria-hidden />
          <div role="menu" className="absolute right-0 top-full z-[81] mt-1.5 min-w-[220px] rounded-md border border-border bg-surface py-1 shadow-slab">
            <button type="button" className="block w-full px-3.5 py-2 text-left text-[12.5px] text-ink hover:bg-primary-soft" onClick={() => { setOpen(false); onFromGrn(); }}>
              New from GRN
            </button>
            <button type="button" className="block w-full px-3.5 py-2 text-left text-[12.5px] text-ink hover:bg-primary-soft" onClick={() => { setOpen(false); onScan(); }}>
              Scan invoice
            </button>
            <button type="button" className="block w-full px-3.5 py-2 text-left text-[12.5px] text-ink hover:bg-primary-soft" onClick={() => { setOpen(false); onImport(); }}>
              Import from file
            </button>
            <button type="button" className="block w-full px-3.5 py-2 text-left text-[12.5px] text-ink hover:bg-primary-soft" onClick={() => { setOpen(false); onDuplicate(); }}>
              Duplicate last invoice
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

// ─── Cards grid ────────────────────────────────────────────────────────────

function CardsGrid({ rows, onOpen }: { rows: PiRow[]; onOpen: (r: PiRow) => void }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-16 text-center shadow-stone">
        <div className="text-[13px] font-semibold text-ink">No purchase invoices</div>
        <div className="mt-1 text-[12px] text-ink-muted">
          No PIs match the current filters. Try Reset layout to clear the
          search and status tabs.
        </div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {rows.map((r) => {
        const st = statusFor(r.status);
        const outstanding = outstandingOf(r);
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpen(r)}
            className="group relative overflow-hidden rounded-lg border border-border bg-surface px-4 py-4 text-left shadow-stone transition-all duration-200 hover:-translate-y-px hover:border-primary/40 hover:shadow-slab focus:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[12.5px] font-semibold text-ink">
                {r.invoice_number}
              </span>
              <StatusWithHold tone={st.tone} label={st.label} row={r} />
            </div>
            <div className="mt-2 truncate text-[15px] font-semibold text-ink">
              {supplierNameOf(r)}
            </div>
            {/* Owner 2026-07-23: supplier code shown as its own line, not only
                buried in the drawer. */}
            <div className="truncate font-mono text-[11px] text-ink-muted">
              {supplierCodeOf(r)}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-[11.5px] text-ink-muted">{fmtDate(r.invoice_date)}</span>
              {r.due_date && (
                <span className="text-[11.5px] text-ink-muted">
                  · Due {fmtDate(r.due_date)}
                </span>
              )}
            </div>
            <div className="mt-3.5 flex items-end justify-between border-t border-border-subtle pt-3">
              <div className="min-w-0">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  Source
                </div>
                <div className="mt-0.5 truncate font-mono text-[12px] font-semibold text-ink-secondary">
                  {sourceOf(r)}
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  {outstanding === 0 ? "Cleared" : "Owed"}
                </div>
                <div
                  className={cn(
                    "mt-0.5 font-money text-[15px] font-bold",
                    outstanding === 0 ? "text-synced" : "text-err"
                  )}
                >
                  {fmtRm(outstanding === 0 ? totalOf(r) : outstanding)}
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
  onRecordPayment,
}: {
  row: PiRow | null;
  onClose: () => void;
  onOpenFull: () => void;
  onEdit: () => void;
  onPrint: () => void;
  onRecordPayment: () => void;
}) {
  const detailQ = usePurchaseInvoiceDetail(row?.id ?? null);
  const { can, pageAccess } = useHouzsAuth();
  const items: PiItem[] =
    ((detailQ.data as { items?: PiItem[] } | undefined)?.items ?? []);

  const open = !!row;
  const st = row ? statusFor(row.status) : null;
  const total = row ? totalOf(row) : 0;
  const paid = row ? paidOf(row) : 0;
  const outstanding = row ? outstandingOf(row) : 0;

  return (
    <ResizableDetailDrawer
      open={open}
      onClose={onClose}
      ariaLabel={row ? `Purchase invoice ${row.invoice_number}` : "Purchase invoice details"}
    >
        {row && st && (
          <>
            <div className="flex h-[60px] shrink-0 items-center gap-3 bg-sidebar px-5 text-sidebar-ink">
              <button type="button" onClick={onClose} className="text-sidebar-ink-muted hover:text-sidebar-ink" aria-label="Close details">
                <XIcon size={18} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[14px] font-bold tracking-wide">{row.invoice_number}</div>
                <div className="mt-0.5 text-[11px] text-sidebar-ink-muted">Purchase Invoice</div>
              </div>
              <button type="button" onClick={onOpenFull} className="inline-flex items-center gap-1.5 rounded-md border border-accent-bright/40 px-2.5 py-1.5 text-[11.5px] font-semibold text-accent-bright hover:bg-accent-bright/10">
                Open full page <ExternalLink size={12} />
              </button>
              <Badge tone={st.tone} variant="solid" size="xs">{st.label}</Badge>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5">
              <div className="text-[19px] font-bold text-ink">{supplierNameOf(row)}</div>
              <div className="mt-1.5 flex items-center gap-2.5">
                <span className="font-mono text-[11.5px] text-ink-muted">{supplierCodeOf(row)}</span>
                <span className="text-[12.5px] text-ink-muted">Invoiced {fmtDate(row.invoice_date)}</span>
              </div>

              <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2 px-4 py-4">
                <MetaItem k="Source" v={sourceOf(row)} mono />
                <MetaItem k="Invoice date" v={fmtDate(row.invoice_date)} />
                <MetaItem k="Due date" v={fmtDate(row.due_date)} />
                <MetaItem k="Supplier code" v={supplierCodeOf(row)} mono />
              </dl>

              <SectionHeading>Supplier</SectionHeading>
              <div className="overflow-hidden rounded-lg border border-border bg-surface">
                <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3.5">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[13px] font-bold text-accent-ink">
                    {(supplierNameOf(row) || "S")
                      .split(/\s+/)
                      .filter(Boolean)
                      .slice(0, 2)
                      .map((w) => w[0]?.toUpperCase())
                      .join("") || "S"}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[14px] font-bold text-ink">{supplierNameOf(row)}</div>
                    <div className="mt-0.5 font-mono text-[11.5px] text-ink-muted">{supplierCodeOf(row)}</div>
                  </div>
                </div>
                <RowKV k="Contact" v={row.supplier?.contact_person || "—"} />
                <RowKV k="Phone" v={row.supplier?.phone || "—"} />
                <RowKV k="Email" v={row.supplier?.email || "—"} />
                <RowKV k="Address" v={row.supplier?.address || "—"} />
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
                  <div className="px-4 py-8 text-center text-[12px] text-ink-muted">Loading lines…</div>
                )}
                {!detailQ.isLoading && items.length === 0 && (
                  <div className="px-4 py-8 text-center text-[12px] text-ink-muted">No lines</div>
                )}
                {items.map((l, i) => {
                  const { primary, secondary } = orderLineIdentity({
                    code: l.item_code || l.item_code,
                    description: l.description,
                    variant:
                      buildVariantSummary(l.item_group ?? "others", l.variants ?? null) ||
                      (l.description2 ?? ""),
                  });
                  return (
                  <div
                    key={l.id ?? i}
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
                    <span className="text-right font-money text-[12.5px] text-ink-secondary">{l.qty ?? 0}</span>
                    <span className="text-right font-money text-[12.5px] text-ink-secondary">
                      {fmtRm(l.unit_price_sen ?? 0)}
                    </span>
                    <span className="text-right font-money text-[12.5px] font-semibold text-ink">
                      {fmtRm(l.line_total_sen ?? 0)}
                    </span>
                  </div>
                  );
                })}
              </div>

              <div className="mt-4 rounded-lg border border-border bg-surface px-5 py-4">
                <TotalRow k="Invoice total" v={fmtRm(total)} />
                <TotalRow k="Paid" v={fmtRm(paid)} tone={paid > 0 ? "success" : "muted"} />
                <TotalRow k="Outstanding" v={fmtRm(outstanding)} tone={outstanding > 0 ? "err" : "success"} strong />
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-5 py-3">
              <Button variant="ghost" icon={<Edit3 size={14} />} onClick={onEdit}>Edit</Button>
              <Button variant="ghost" icon={<Printer size={14} />} onClick={onPrint}>Print</Button>
              <div className="flex-1" />
              {piAwaitsPayment(row) && canOpenApPayment(can, pageAccess) && (
                <Button variant="primary" icon={<Wallet size={14} />} onClick={onRecordPayment}>
                  Record payment
                </Button>
              )}
            </div>
          </>
        )}
    </ResizableDetailDrawer>
  );
}

function MetaItem({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{k}</dt>
      <dd className={cn("mt-0.5 text-[13px] font-semibold text-ink", mono && "font-mono")}>{v}</dd>
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
      <span className="w-20 shrink-0 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{k}</span>
      <span className="flex-1 text-[13px] font-semibold leading-relaxed text-ink">{v}</span>
    </div>
  );
}

function TotalRow({
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
    <div className="flex items-center justify-between py-1.5">
      <span className={cn("text-[12px] text-ink-muted", strong && "text-[13px] font-semibold text-ink")}>{k}</span>
      <span
        className={cn(
          "font-money text-[13px] font-semibold",
          tone === "success" ? "text-synced" : tone === "err" ? "text-err" : "text-ink",
          strong && "text-[15px] font-bold"
        )}
      >
        {v}
      </span>
    </div>
  );
}

// Table column key → backend sort-whitelist column. PI backend whitelist is
// { invoice_date, invoice_number, status, total_sen }; only `total` differs
// from its backend name. Non-whitelisted columns carry `disableSort`.
const SORT_COL_MAP: Record<string, string> = {
  total: "total_sen",
};

// ─── Row drill-down (DataTable `expandable`) ──────────────────────────────────
// Inline per-line breakdown for one PI, lazy-fetched via the SAME
// usePurchaseInvoiceDetail hook the drawer uses (TanStack-cached). Group + item
// code/variant + Qty + Amount (line value), via the shared
// DocumentLinesExpansion. A purchase invoice is a purchase-side money doc with
// no MRP coverage on its lines, so the SO/DO-only Stock + Incoming PO columns
// are absent.
function PiLinesExpansion({ id }: { id: string }) {
  const navigate = useNavigate();
  const detailQ = usePurchaseInvoiceDetail(id);
  const covQ = usePoSoCoverage("pi", id);
  const byCode = originsByCode(covQ.data);
  // PR-3: the parallel stored-origin "bought for" slot, per SKU.
  const provByCode = provenanceByCode(covQ.data);
  const linkedSkus = storedLinkSkus(covQ.data);
  const deliveredMap = deliveredByCode(covQ.data);
  const items =
    ((detailQ.data as { items?: DrillItemFields[] } | undefined)?.items ?? []);
  const lines: DocumentDrillLine[] = items.map((l) => {
    const code = (l.item_code || l.item_code || "").trim();
    return {
      itemGroup: l.item_group ?? null,
      code: l.item_code || l.item_code || null,
      description: l.description ?? null,
      description2: l.description2 ?? null,
      variants: l.variants ?? null,
      qty: Number(l.qty ?? 0),
      amountSen: l.line_total_sen ?? 0,
      assignedSos: byCode.get(code) ?? [],
      sourceLinked: linkedSkus.has(code),
      provenance: provByCode.get(code) ?? [],
      deliveredDos: deliveredMap.get(code) ?? [],
    };
  });
  return (
    <div className="flex flex-col gap-2">
      <DocumentLinesExpansion
        isLoading={detailQ.isLoading}
        coverage={coverageStateOf(covQ)}
        isError={Boolean(detailQ.error)}
        errorMessage={detailQ.error instanceof Error ? detailQ.error.message : null}
        lines={lines}
        emptyLabel="No lines on this purchase invoice."
        showAssignment
        showDelivered
        onOpenSo={(soDocNo) => navigate(`/scm/sales-orders/${encodeURIComponent(soDocNo)}`)}
        onOpenDo={(doNo) => navigate(`/scm/delivery-orders?q=${encodeURIComponent(doNo)}`)}
      />
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export function PurchaseInvoicesListV2() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const notify = useNotify();
  const askChoice = useChoice();
  const askConfirm = useConfirm();

  const status = (params.get("status") ?? "all") as StatusTab;
  const view = (params.get("view") ?? "table") as "table" | "cards";
  const search = params.get("q") ?? "";
  const page = Math.max(0, parseInt(params.get("page") ?? "0", 10) || 0);
  const [pageSize, setPageSize] = useLocalStorage<number>("scm:perpage:purchase-invoices", 50);

  const [selected, setSelected] = useState<PiRow | null>(null);
  const [sort, setSort] = useState<string | undefined>(undefined);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [printingDocs, setPrintingDocs] = useState(false);
  const [showScan, setShowScan] = useState(false);
  // Server-filterable funnels (owner 2026-09-16): Creditor Name/Code + Currency → list query (pager over the filtered set); line/MRP funnels stay client-side. Creditor checklists seeded with every supplier.
  const suppliersQ = useSuppliers();
  const supplierNames = useMemo(() => [...new Set((suppliersQ.data ?? []).map((s) => s.name).filter((n): n is string => !!n))], [suppliersQ.data]);
  const supplierCodes = useMemo(() => [...new Set((suppliersQ.data ?? []).map((s) => s.code).filter((c): c is string => !!c))], [suppliersQ.data]);
  const { serverFunnels, onColFiltersChange } = useServerColumnFunnels(
    (cf) => ({ creditorNames: funnelValues(cf, "supplier"), creditorCodes: funnelValues(cf, "supplier_code"), currencies: funnelValues(cf, "currency") }),
    () => setPageParam(0),
  );
  const { requestTerm: debouncedSearch } = useDebouncedSearchTerm(search);

  // Send the active tab's BUCKET NAME as `status`; the backend resolves it to
  // the raw status it covers (draft/posted/partial/paid/cancelled are 1:1).
  // `all` omits the filter.
  const apiStatus = status === "all" ? undefined : status;

  const { data, isLoading, isFetching, isPlaceholderData, error } = usePurchaseInvoicesPaged({
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
  // The list below is replaced by a pending panel while a search is in flight,
  // and these tiles summarise the SAME payload - so a settled-looking "RM 0.00"
  // (or the PREVIOUS term's money under a placeholder page) would outlive the
  // rows it describes. Same flag SearchScopeHint already uses for its count.
  const statsPending =
    isLoading || isPlaceholderData || Boolean(error) || searchTransition.resultsAreStale;
  const cancelPi = useCancelPurchaseInvoice();
  const postPi = usePostPurchaseInvoice();

  // Server already filtered + sorted this page — render verbatim. The four
  // MRP-derived columns (Assigned SO / Delivered) arrive from the deferred
  // enrichment endpoint a beat later and are merged in here, so opening the list
  // no longer waits on a company-wide computeMrp (perf/pi-list-mrp-off-load).
  const serverRows = (data?.purchaseInvoices ?? []) as PiRow[];
  const rows = useEnrichedPiListRows(serverRows, !listLoading);
  /* PO price vs invoice price, per invoice (owner 2026-09-14) — a quiet marker,
     fetched a beat after the page renders, never gating anything. */
  const poPriceById = usePiListPoPriceMap(useMemo(() => serverRows.map((r) => r.id).filter(Boolean) as string[], [serverRows]), !listLoading);
  const total = data?.total ?? 0;
  const counts = data?.statusCounts ?? {
    all: 0,
    draft: 0,
    posted: 0,
    partial: 0,
    paid: 0,
    cancelled: 0,
    on_hold: 0,
  };

  /* The rows the TABLE is showing — the server page minus whatever the
     per-column funnels hide (owner 2026-08-13, following the Purchase Orders
     fix). See hooks/useVisibleRows for why summarising the server page put two
     contradictory numbers on one screen. */
  const visible = useVisibleRows(rows);

  // Money KPIs sum the rows ON SCREEN (the paginated contract has no full-set
  // money sums), so the cards and the table can never disagree.
  const money = useMemo(() => {
    let billed = 0;
    let owed = 0;
    let paid = 0;
    for (const r of visible.rows) {
      billed += totalOf(r);
      owed += outstandingOf(r);
      paid += paidOf(r);
    }
    return { billed, owed, paid };
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
    await queryClient.invalidateQueries({ queryKey: ["purchase-invoices"] });
  };

  /* The ONE Export (owner 2026-09-15): every invoice the list's tab + search +
     sort match — not the page on screen — one row per line, with the grid's
     visible columns, funnels and sort (DataTable `exportLines`). The filter is
     the one the list request is built from: the settled search term. */
  const exportFilters = { status: apiStatus, q: debouncedSearch, sort };
  const exportLines = {
    fetchRows: (need: { exportKeys: string[]; filterKeys: string[] }) => fetchPiExportRows<PiRow>(exportFilters, need),
    linesOf: (r: PiRow): readonly PiListLine[] => r.lines ?? [],
    sheetName: "Purchase Invoices",
    onError: (e: Error) => {
      void notify({ title: "Export failed", body: e.message || "The export could not be completed.", tone: "error" });
    },
  };

  const goNewPi = () => navigate("/scm/purchase-invoices/new");
  const goFromGrn = () => navigate("/scm/purchase-invoices/from-grn");
  const goImport = () => navigate("/scm/purchase-invoices?import=1");
  const goDuplicate = () => navigate("/scm/purchase-invoices?duplicate=1");
  const goGrns = () => navigate("/scm/grns");
  const goSuppliers = () => navigate("/scm/suppliers");
  const goEdit = (r: PiRow) => navigate(`/scm/purchase-invoices/${r.id}?edit=1`);
  const printDocument = usePrintDocument();
  const goFullPage = (r: PiRow) => navigate(`/scm/purchase-invoices/${r.id}`);

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

  // One PI's full detail for the PDF generator, via the vendored authedFetch
  // (→ /api/scm); same endpoint + shape as the single-row detail page.
  const fetchPiBundle = async (
    row: PiRow
  ): Promise<{ header: unknown; items: unknown[] }> => {
    const json = await authedFetch<{ purchaseInvoice: unknown; items: unknown[] }>(
      `/purchase-invoices/${row.id}`
    );
    return { header: json.purchaseInvoice, items: json.items };
  };

  // Batch "Print all" — one ticked PI downloads straight; several prompt
  // combined-vs-separate.
  const deliverSelectedPis = async (action: PdfAction) => {
    if (printingDocs) return;
    const chosen = rows.filter((r) => selectedIds.has(r.id));
    if (chosen.length === 0) return;
    try {
      const { generatePurchaseInvoicePdf, generateCombinedPurchaseInvoicePdf } =
        await import("../../vendor/scm/lib/purchase-invoice-pdf");
      if (chosen.length === 1) {
        setPrintingDocs(true);
        const b = await fetchPiBundle(chosen[0]!);
        await generatePurchaseInvoicePdf(b.header as never, b.items as never, { action });
        clearSelection();
        return;
      }
      /* View / Print always render ONE document — a preview or a print run
         is about the stack, not N separate files. Only the download exit
         still asks combined-vs-separate. */
      const how = action !== "save" ? "one" : await askChoice({
        title: `Print ${chosen.length} purchase invoices`,
        options: [
          { value: "one", label: "One combined PDF" },
          { value: "many", label: "Separate files", detail: "One PDF per document" },
        ],
      });
      if (how == null) return;
      setPrintingDocs(true);
      const bundles: Array<{ header: unknown; items: unknown[] }> = [];
      for (const r of chosen) bundles.push(await fetchPiBundle(r));
      if (how === "one") {
        await generateCombinedPurchaseInvoicePdf(bundles as never, {
          fileName: `purchase-invoices-${new Date().toISOString().slice(0, 10)}.pdf`,
          action,
        });
      } else {
        for (const b of bundles)
          await generatePurchaseInvoicePdf(b.header as never, b.items as never, { action });
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
  const batchPrint = usePrintPreview(deliverSelectedPis);
  /* The AP Payment voucher, this invoice ticked (docs/bugs/0889). */
  const goRecordPayment = (r: PiRow) => navigate(apPaymentHrefFor(r));

  /* CONFIRM + CANCEL, from the right-click menu (owner 2026-08-22).

     Cancel needed no new endpoint and no new hook: `useCancelPurchaseInvoice()`
     was already called on this page and its result was used by nothing, so the
     capability sat here unreachable. Confirm calls the same `/:id/post` route
     the detail page's own Post button calls.

     Both carry an onError, because a refusal that reaches nobody reads to the
     operator as "the menu did nothing" — the exact bug class
     `check-silent-mutations.mjs` exists to stop. */
  const doConfirm = async (r: PiRow) => {
    if (!(await askConfirm({
      title: `Confirm invoice ${r.invoice_number}?`,
      body: "Inventory and Payables will be updated.",
      confirmLabel: "Confirm invoice",
    }))) return;
    postPi.mutate(r.id, {
      onSuccess: () => setSelected(null),
      onError: (e) =>
        notify({
          title: `Couldn't confirm ${r.invoice_number}`,
          body: `${e instanceof Error ? e.message : "Something went wrong."} The invoice is unchanged — please try again.`,
          tone: "error",
        }),
    });
  };
  const doCancelPi = async (r: PiRow) => {
    if (!(await askConfirm({
      title: `Cancel invoice ${r.invoice_number}?`,
      body: "Any posted amount will be reversed via a contra JE.",
      confirmLabel: "Cancel invoice",
      danger: true,
    }))) return;
    cancelPi.mutate(r.id, {
      onSuccess: () => setSelected(null),
      onError: (e) =>
        notify({
          title: `Couldn't cancel ${r.invoice_number}`,
          body: `${e instanceof Error ? e.message : "Something went wrong."} The invoice is unchanged — please try again.`,
          tone: "error",
        }),
    });
  };
  /* The server refuses a cancel once ANY money has been paid against the
     invoice (PAID, or paid_sen > 0 -> 409), so the menu must not offer it
     there. Mark paid and Record payment stay on the drawer, beside the
     outstanding figure that justifies them. */
  /* Keyed by `id`: the route is `PATCH /purchase-invoices/:id/hold`. Only the
     Sales Order's is keyed by document number (document-hold-routes.ts). */
  const holdAction = useHoldAction("pi");
  const setPiHold = (r: PiRow, onHold: boolean) => holdAction(r.id, r.invoice_number, onHold);

  const piContextMenu = purchaseInvoiceRowMenu<PiRow>({
    open: goFullPage,
    edit: goEdit,
    copyAsNew: (r) => navigate(`/scm/purchase-invoices/new?copyFrom=${r.id}`),
    print: printDocument,
    confirm: doConfirm,
    setHold: setPiHold,
    cancel: doCancelPi,
    canConfirm: (r) => (r.status || "").toUpperCase() === "DRAFT",
    canCancel: (r) => {
      const st = (r.status || "").toUpperCase();
      return st !== "CANCELLED" && st !== "PAID" && paidOf(r) === 0;
    },
  });

  /* Default view = AutoCount's Purchase Invoice Detail Listing, layout "SS", in
     its order (PI_DEFAULT_COLUMN_KEYS; owner 2026-09-15: a default export equals
     the AutoCount file). Every other column stays in the chooser, hidden until
     picked; the export follows whatever the operator shows. */
  const lineCols = piLineColumns<PiRow>();
  const docNoOf = (r: PiRow): string => r.linked_ac_docno?.trim() || r.invoice_number;
  const moneyCell = (sen: number | null | undefined) => <span className="font-money text-[13px] text-ink">{fmtRm(sen ?? 0)}</span>;
  const rateOf = (r: PiRow): number => { const n = Number(r.exchange_rate ?? 1); return Number.isFinite(n) && n > 0 ? n : 1; };
  const blankCol = (key: string, label: string): Column<PiRow, PiListLine> => ({
    key, label, width: "90px", disableSort: true, getValue: () => "", render: () => <span className="text-[12.5px] text-ink-muted">—</span>,
  });
  const byKey: Record<string, Column<PiRow, PiListLine>> = {
    ...lineCols,
    invoice_number: {
      key: "invoice_number",
      /* AutoCount's own invoice number when the invoice is in the book, else ours —
         the ERP number stays on ERP Doc No. */
      label: PI_LABELS.docNo,
      width: "140px",
      alwaysVisible: true,
      getValue: (r) => docNoOf(r),
      render: (r) => (
        <span className={cn("font-mono text-[12.5px] font-semibold text-ink", isCancelledDocStatus(r.status) && "dt-cancel-strike")}>
          {docNoOf(r)}
        </span>
      ),
    },
    supplier_invoice_ref: {
      key: "supplier_invoice_ref", label: PI_LABELS.supplierInvoiceNo, width: "140px", disableSort: true,
      getValue: (r) => r.supplier_invoice_ref ?? "",
      render: (r) => <span className="font-mono text-[12px] text-ink-secondary">{r.supplier_invoice_ref || "—"}</span>,
    },
    invoice_date: {
      key: "invoice_date", label: PI_LABELS.docDate, width: "108px", exportFormat: "date",
      getValue: (r) => r.invoice_date ?? "",
      render: (r) => <span className="text-[12.5px] text-ink-secondary">{fmtDate(r.invoice_date)}</span>,
    },
    supplier_code: {
      key: "supplier_code", label: PI_LABELS.creditorCode, width: "120px", disableSort: true,
      getValue: (r) => r.supplier?.code ?? "",
      filterSeedValues: supplierCodes, // server-filterable; seed with every creditor code
      render: (r) => <span className="font-mono text-[11.5px] text-ink-secondary">{supplierCodeOf(r)}</span>,
    },
    supplier: {
      key: "supplier", label: PI_LABELS.creditorName, disableSort: true,
      getValue: (r) => r.supplier?.name ?? "",
      filterSeedValues: supplierNames, // server-filterable; seed with every creditor name
      render: (r) => <div className="min-w-0 truncate text-[13px] font-semibold text-ink">{supplierNameOf(r)}</div>,
    },
    /* A purchase invoice names no purchase agent in this ERP. */
    agent: blankCol("agent", PI_LABELS.agent),
    currency: {
      key: "currency", label: PI_LABELS.currCode, width: "90px", disableSort: true,
      getValue: (r) => r.currency ?? "", render: (r) => <span className="text-[12.5px] text-ink-secondary">{r.currency || "—"}</span>,
    },
    exchange_rate: {
      key: "exchange_rate", label: PI_LABELS.currRate, width: "90px", disableSort: true, exportFormat: "number",
      getValue: (r) => rateOf(r), render: (r) => <span className="text-[12.5px] text-ink-secondary">{rateOf(r)}</span>,
    },
    /* This ERP keeps no tax-inclusive flag on the document: blank, never a guess. */
    inclusive: blankCol("inclusive", PI_LABELS.inclusive),
    subtotal: {
      key: "subtotal", label: PI_LABELS.subTotalEx, width: "128px", align: "right", disableSort: true,
      getValue: (r) => r.subtotal_sen ?? 0, exportValue: (r) => senToRinggit(r.subtotal_sen ?? 0, 2), exportFormat: "money",
      render: (r) => moneyCell(r.subtotal_sen),
    },
    tax: {
      key: "tax", label: PI_LABELS.tax, width: "100px", align: "right", disableSort: true,
      getValue: (r) => r.tax_sen ?? 0, exportValue: (r) => senToRinggit(r.tax_sen ?? 0, 2), exportFormat: "money",
      render: (r) => moneyCell(r.tax_sen),
    },
    total: {
      key: "total", label: PI_LABELS.total, width: "128px", align: "right",
      getValue: (r) => totalOf(r), exportValue: (r) => senToRinggit(totalOf(r), 2), exportFormat: "money",
      render: (r) => <span className="font-money text-[13px] font-semibold text-ink">{fmtRm(totalOf(r))}</span>,
    },
    local_total: {
      key: "local_total", label: PI_LABELS.localTotal, width: "128px", align: "right", disableSort: true,
      getValue: (r) => Math.round(totalOf(r) * rateOf(r)), exportValue: (r) => senToRinggit(totalOf(r) * rateOf(r), 2), exportFormat: "money",
      render: (r) => moneyCell(Math.round(totalOf(r) * rateOf(r))),
    },
    cancelled: {
      key: "cancelled", label: PI_LABELS.cancelled, width: "96px", disableSort: true,
      getValue: (r) => isCancelledDocStatus(r.status),
      render: (r) => <span className="text-[12.5px] text-ink-secondary">{isCancelledDocStatus(r.status) ? "Yes" : "No"}</span>,
    },
    erp_doc_no: {
      key: "erp_doc_no", label: PI_LABELS.erpDocNo, width: "140px", disableSort: true, defaultHidden: true,
      getValue: (r) => r.invoice_number, render: (r) => <span className="font-mono text-[12.5px] text-ink-secondary">{r.invoice_number}</span>,
    },
    due_date: {
      key: "due_date",
      label: "Due",
      defaultHidden: true,
      width: "108px",
      disableSort: true,
      getValue: (r) => r.due_date ?? "",
      render: (r) => <span className="text-[12.5px] text-ink-secondary">{fmtDate(r.due_date)}</span>,
    },
    source: {
      key: "source",
      label: "Source",
      defaultHidden: true,
      width: "132px",
      disableSort: true,
      getValue: (r) => sourceOf(r),
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">{sourceOf(r)}</span>
      ),
    },
    assigned_so: {
      // Owner 2026-07-31: the Sales Order(s) the parent PO's supply is assigned
      // to, inherited onto the PI. Server-resolved (one pass, same precedence as
      // the drill-down); dashed "~" chip flags an MRP guess vs a stored link.
      key: "assigned_so",
      label: "Assigned SO",
      defaultHidden: true,
      width: "168px",
      disableSort: true,
      getValue: (r) => (r.assigned_sos ?? []).map((a) => a.soDocNo).join(", "),
      render: (r) => (
        <AssignedSoCell
          assignments={r.assigned_sos}
          sourceLinked={r.assigned_so_linked}
          provenance={r.assigned_so_provenance}
          onOpenSo={(soDocNo) => navigate(`/scm/sales-orders/${encodeURIComponent(soDocNo)}`)}
          emptyMeans="stock"
        />
      ),
    },
    delivered: {
      // Owner 2026-07-31: what has been DELIVERED against this PI's parent PO —
      // the DO(s) that shipped its goods + qty. EVERY DO renders (no collapse).
      key: "delivered",
      label: "Delivered",
      defaultHidden: true,
      width: "180px",
      disableSort: true,
      getValue: (r) => (r.delivered_dos ?? []).map((d) => d.doNo).join(", "),
      render: (r) => (
        <DeliveredCell
          dos={r.delivered_dos}
          onOpenDo={(doNo) => navigate(`/scm/delivery-orders?q=${encodeURIComponent(doNo)}`)}
        />
      ),
    },
    status: {
      key: "status",
      label: "Status",
      defaultHidden: true,
      width: "132px",
      // Exempt from the cancelled-row fade — the pill is WHY the row is grey.
      className: "dt-cancel-keep",
      // The export writes the word on screen, hold included (owner 2026-09-15).
      getValue: (r) => { const w = statusFor(r.status).label; return rowIsHeld(r) && r.status.toUpperCase() !== "ON_HOLD" ? `${w} (On Hold)` : w; },
      render: (r) => {
        const st = statusFor(r.status);
        /* mig 0324 — the Hold marker sits BESIDE the real status pill. */
        return <StatusWithHold tone={st.tone} label={st.label} row={r} />;
      },
    },
    outstanding: {
      key: "outstanding",
      label: "Owed",
      defaultHidden: true,
      width: "128px",
      align: "right",
      // Derived (Total − Paid) — not a backend-sortable column.
      disableSort: true,
      getValue: (r) => outstandingOf(r),
      exportValue: (r) => senToRinggit(outstandingOf(r), 2),
      exportFormat: "money",
      render: (r) => {
        const o = outstandingOf(r);
        if (o === 0) {
          return <span className="font-money text-[13px] font-semibold text-synced">Cleared</span>;
        }
        return <span className="font-money text-[13px] font-semibold text-err">{fmtRm(o)}</span>;
      },
    },
    vs_po: {
      key: "vs_po",
      label: "vs PO price",
      defaultHidden: true,
      width: "132px",
      disableSort: true,
      getValue: (r) => poPriceMarker((r.po_price_summary ?? poPriceById.get(String(r.id))))?.label ?? "",
      render: (r) => {
        const m = poPriceMarker((r.po_price_summary ?? poPriceById.get(String(r.id))));
        if (!m) return <span className="text-[12px] text-ink-muted">…</span>;
        if (m.tone === "differs") {
          return (
            <span className="text-[12px] font-semibold" style={{ color: "#a16a2e" }} title={`Net ${m.diffSen > 0 ? "+" : "−"}${fmtRm(Math.abs(m.diffSen))} against the purchase order prices. For reference only.`}>
              {m.label}
            </span>
          );
        }
        return <span className={m.tone === "matches" ? "text-[12px] text-ink-secondary" : "text-[12px] text-ink-muted"}>{m.label}</span>;
      },
    },
  };
  const columns: Column<PiRow, PiListLine>[] = [
    ...PI_DEFAULT_COLUMN_KEYS.map((k) => byKey[k]!),
    ...Object.keys(byKey).filter((k) => !(PI_DEFAULT_COLUMN_KEYS as readonly string[]).includes(k)).map((k) => byKey[k]!),
  ];

  const statusPillOptions: Array<{ value: StatusTab; label: string }> = [
    { value: "all", label: `All · ${counts.all}` },
    { value: "draft", label: `Draft · ${counts.draft}` },
    { value: "posted", label: `Confirmed · ${counts.posted}` },
    { value: "partial", label: `Partial · ${counts.partial}` },
    { value: "paid", label: `Paid · ${counts.paid}` },
    { value: "cancelled", label: `Cancelled · ${counts.cancelled}` },
    { value: "on_hold", label: `On Hold · ${counts.on_hold ?? 0}` },
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
              Purchase Invoices
            </h1>
            <div className="mt-0.5 text-[12.5px] text-ink-muted">
              {total} PI{total === 1 ? "" : "s"} ·{" "}
              <span className="font-money text-err">{fmtRm(money.owed)}</span> owed
            </div>
          </div>
        </div>

        <div className="hidden md:block">
          <PageHeader
            eyebrow="Procurement"
            title="Purchase Invoices"
            description="Every invoice raised by a supplier — Draft through Paid. Click any row for the quick view; open the full page to edit or record a payment."
            primaryAction={
              <div className="flex items-stretch gap-2">
                <Button variant="secondary" icon={<ArrowRightLeft size={14} />} onClick={goFromGrn}>
                  {transferFromLabel('grn')}
                </Button>
                <div className="flex items-stretch">
                  <Button variant="primary" icon={<Plus size={14} />} onClick={goNewPi} className="rounded-r-none">
                    New Purchase Invoice
                  </Button>
                  <SplitDropdown onFromGrn={goFromGrn} onImport={goImport} onDuplicate={goDuplicate} onScan={() => setShowScan(true)} />
                </div>
              </div>
            }
            secondaryActions={[
              { label: "Goods Received", icon: Package, onClick: goGrns },
              { label: "Suppliers", icon: Users, onClick: goSuppliers },
            ]}
          />
        </div>

        <div className="mb-5 hidden grid-cols-2 gap-3 md:grid lg:grid-cols-4">
          {/* Every tile describes the rows ON SCREEN and says so while a column
              funnel narrows them (owner 2026-08-13). The count tile switches
              SOURCE, not just wording: `total` is the server's full match count
              and contradicts the table the moment a client-side funnel hides
              part of the page. */}
          <StatCard
            pending={statsPending}
            label="Total PIs"
            value={(visible.filtered ? visible.rows.length : total).toLocaleString("en-MY")}
            subtitle={visible.filtered ? "Filtered · shown below" : "All matching PIs"}
            rail="bg-primary"
            active
          />
          <StatCard
            pending={statsPending}
            label="Billed"
            value={fmtRm(money.billed)}
            subtitle={visible.filtered ? "Filtered · sum shown below" : "Sum on this page"}
            rail="bg-accent"
          />
          <StatCard
            pending={statsPending}
            label="Owed"
            value={fmtRm(money.owed)}
            subtitle={
              visible.filtered ? "Balance owed · filtered" : "Balance owed · on this page"
            }
            tone="error"
            rail="bg-err"
          />
          <StatCard
            pending={statsPending}
            label="Paid"
            value={fmtRm(money.paid)}
            subtitle={visible.filtered ? "Cash out · filtered" : "Cash out · on this page"}
            tone="success"
            rail="bg-synced"
          />
        </div>

        <div className="sticky top-0 z-10 -mx-4 mb-3 bg-bg/95 px-4 py-2 backdrop-blur-sm md:hidden">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search PI no, supplier invoice ref or notes…"
            className="h-10 w-full rounded-lg border border-border bg-surface px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          <SearchProgress active={searchTransition.isSearching} label={searchTransition.statusText} className="mt-1.5" />
          <SearchScopeHint scope="server" searching={searchTransition.isSearching} countPending={isLoading || isPlaceholderData || Boolean(error) || searchTransition.resultsAreStale} resultCount={total} term={search} className="mt-1" />
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <FilterPills
            options={statusPillOptions}
            value={status}
            onChange={(v) => setStatusChip(v)}
          />
          <div className="flex-1" />
          <div className="hidden md:block">
            <ViewToggle value={view} onChange={setView} />
          </div>
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
                    docTitle="Purchase Invoices"
                    docNos={rows.filter((r) => selectedIds.has(r.id)).map((r) => r.invoice_number)}
                    {...batchPrint.handlers}
                  />
                  <Button variant="ghost" disabled={printingDocs} onClick={clearSelection}>
                    Clear
                  </Button>
                </div>
              )}
              <DataTable<PiRow, PiListLine>
                tableId="purchase-invoices-v2"
                rows={rows}
                /* Feeds the stat strip so the tiles describe what is on screen. */
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
                contextMenu={piContextMenu}
                expandable={{
                  render: (r) => <PiLinesExpansion id={r.id} />,
                  rowKey: (r) => r.id,
                }}
                selection={{
                  selectedIds,
                  onToggle: toggleSelect,
                  onToggleAll: toggleSelectAll,
                }}
                exportName="purchase-invoices"
                exportLines={exportLines}
                serverSort
                onSortChange={setSortAndReset}
                emptyLabel={
                  filtersActive
                    ? "No purchase invoices match — try Reset layout to clear filters."
                    : "No purchase invoices yet."
                }
                search={{
                  value: search,
                  onChange: setSearch,
                  placeholder: "Search PI no, supplier invoice ref or notes…",
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
                    placeholder="Search PI no, supplier invoice ref or notes…"
                    className="h-9 max-w-[320px] flex-1 rounded-md border border-border bg-surface px-3.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
                  />
                  <SearchProgress active={searchTransition.isSearching} />
                  <SearchScopeHint scope="server" searching={searchTransition.isSearching} countPending={isLoading || isPlaceholderData || Boolean(error) || searchTransition.resultsAreStale} resultCount={total} term={search} />
                  {filtersActive && (
                    <button type="button" onClick={resetLayout} className="text-[12px] font-semibold text-primary hover:underline">
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
        onPrint={() => selected && printDocument(purchaseInvoicePrintChain(selected).own)}
        onRecordPayment={() => selected && goRecordPayment(selected)}
      />

      {showScan && <ScanInvoiceModal onClose={() => setShowScan(false)} />}
    </PullToRefresh>
  );
}

export default PurchaseInvoicesListV2;
