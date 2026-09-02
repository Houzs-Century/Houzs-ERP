// MfgSalesOrdersListV2 — Theme C ("Ink & Petrol") redesign of the Sales Orders
// listing (Supply Chain). Composed with the real Houzs DS primitives:
// PageHeader / StatCard grid / FilterPills / DataTable / Badge / Button + a
// right slide-over detail drawer built with the same tokens.
//
// Scope of THIS file (Item A of the 4-part redesign):
//   · Desktop listing (table + cards toggle)
//   · Row/card click → quick-view detail drawer (dark header, meta grid,
//     order lines, totals, action buttons)
//   · Wired to the existing useMfgSalesOrders query so status tab / search
//     narrow the same data the old grid uses. Status mutations still route
//     through useUpdateMfgSalesOrderStatus.
//
// Follow-ups (separate PRs):
//   · Full Detail page (DetailLayout + two-col grid + sticky aside)
//   · Phone card list + FAB + PullToRefresh
//   · iPad 340px master-detail rail
//
// The old ledger-style page (MfgSalesOrdersList.tsx, DataGrid-based) stays in
// the tree; App.tsx route swap decides which one users see.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { shippedProgressColumn, ShippedProgressPill } from "./so-list-shipped-column";
import { SO_STATUS_TABS, statusFor, soRowStatus, type StatusTab } from "./so-list-status";
import { soStatusDisplay } from "../../vendor/scm/lib/so-status";
import { salesOrderRowMenu } from "./row-menus";
import { brandingToneForCategory, type BrandTone } from "../../lib/brandingTone";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Plus,
  ChevronDown,
  ScanLine,
  Wrench,
  LayoutGrid,
  Table as TableIcon,
  X as XIcon,
  ExternalLink,
  Edit3,
  Printer,
  CheckCircle2,
  Truck,
  RotateCcw,
} from "lucide-react";
import { PrintPreviewBatchModal, usePrintPreview } from "../../components/scm-v2/PrintPreviewModal";
import { usePrintDocument } from "../../components/scm-v2/PrintChainProvider";
import { salesOrderPrintChain } from "../../lib/printChain";
import { fetchPrintBundle } from "../../lib/printDocumentPdf";
import type { PdfAction } from "../../vendor/scm/lib/pdf-common";
import { PageHeader } from "../../components/Layout";
import { SoListPoCell, SoSourceChips, SoStockPill } from "../../components/SoSourceChips";
import { coverageStateOf } from "../../components/coverage-state";
import { overlaySoLineCoverage } from "../../vendor/scm/lib/so-coverage-overlay";
import { StockRemarkPill, stockRemarkSortScore } from "../../components/StockRemarkPill";
import { SoListDoCell } from "../../components/SoListDoCell";
import { StockAdjChip } from "../../components/DocumentLinesExpansion";
import { StatCard } from "../../components/StatCard";
import { FilterPills } from "../../components/FilterPills";
import {
  DataTable,
  type Column,
  type ColumnLayoutPreset,
} from "../../components/DataTable";
import { ListPager } from "../../components/ListPager";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { PullToRefresh } from "../../components/PullToRefresh";
import { ListErrorPanel, SearchPendingPanel, SearchProgress } from "../../components/SearchProgress";
import { SearchScopeHint } from "../../components/SearchScopeHint";
import { useStaffLookup } from "../../hooks/useStaffLookup";
import { useBranding } from "../../hooks/useBranding";
import { shortCompanyName, getBrandingCompanyCode } from "../../lib/branding";
import { brandingLabel, isPlaceholderBrandText } from "../../vendor/shared/so-branding-label";
import { soCanRaiseDo } from "../../vendor/shared/so-deliverable-states";
import { useDebouncedSearchTerm, useSearchResultTransition } from "../../hooks/useServerSearch";
import { useMfgSalesOrdersPaged, useUpdateMfgSalesOrderStatus, useMfgSalesOrderDetail, useEnrichedSoListRows, useSoLineCoverage } from "../../vendor/scm/lib/sales-order-queries";
import { useSetDocumentHold } from "../../vendor/scm/lib/document-hold-queries";
import { holdPrompt } from "./use-hold-action";
import { makeCloseAction } from "./use-close-action";
import { StatusWithHold, type HoldFields } from "../../vendor/scm/components/HoldChip";
import { ScanOrderModal } from "../../vendor/scm/components/ScanOrderModal";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { useChoice } from "../../vendor/scm/components/ChoiceDialog";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "../../lib/utils";
import { convertToLink, transferToLabel } from "../../lib/convertScope";
import { isCancelledDocStatus } from "../../lib/scm";
import { ResizableDetailDrawer } from "../../components/ResizableDetailDrawer";
import { ItemGroupPill } from "../../vendor/scm/lib/category-badges";
import { resolveSoLocation } from "../../lib/soLocation";
import { poCellChips } from "../../lib/soPoChips";
import { useAuth } from "../../auth/AuthContext";
import { canViewScmCosting, canOperateDeliveryOrders } from "../../auth/salesAccess";
import { capability } from "../../auth/capabilities";
import { buildVariantSummary, fmtSen, fmtDate, orderLineIdentity } from "@2990s/shared";
import { formatPhone } from "@2990s/shared/phone";

// ─── Types ──────────────────────────────────────────────────────────────────
// Minimal row shape the listing needs. The full SoRow (in MfgSalesOrdersList
// .tsx) has 60+ fields; we pluck what the redesign shows. Everything is
// typed loosely as any-safe (nullable) because the backend legacy fields.

type SoRow = HoldFields & {
  doc_no: string;
  so_date: string;
  debtor_name: string;
  debtor_code: string | null;
  agent: string | null;
  salesperson_id: string | null;
  sales_location: string | null;
  warehouse_name: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  ref: string | null;
  branding: string | null;
  first_item_branding: string | null; first_item_category: string | null;
  status: string;
  local_total_sen: number;
  /* Stored snapshots — NOT the truth, and never read without the live
     fallbacks below. `balance_sen` is rewritten to the gross grandTotal by
     the backend's recomputeTotals on every edit (so it never reflects a
     payment) and `paid_sen` is a deprecated column no writer maintains. The
     list payload carries the ledger-derived pair; prefer them. */
  balance_sen: number;
  paid_sen: number;
  /* Ledger-derived, from mfg_sales_orders_with_payment_totals — already in the
     backend's LIST_COLS. paid_total_sen = Σ payments, balance_sen_live =
     local_total − Σ payments. Same source the mobile SO list and Delivery
     Planning read. Optional so an absent view row falls back, not crashes. */
  paid_total_sen?: number | null;
  balance_sen_live?: number | null;
  phone: string | null;
  email: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  customer_state: string | null;
  payment_method: string | null;
  payment_methods_summary?: string;
  // ── Phase 2: extra fields already present on the list payload (HEADER +
  //    server-computed), previously untyped so the columns couldn't be built.
  venue: string | null;
  note: string | null;
  customer_type: string | null;
  building_type: string | null;
  customer_country: string | null;
  shipped_qty?: number | null;   // §0.4b — how much has LEFT
  deliverable_qty?: number | null;
  /* Server-derived on this same response (mfg-sales-orders.ts:1800-1806) and
     until 0619 UNDECLARED here, so the Status column could not read them and
     fell back to the stored column while the Delivered column beside it used
     the live figures. Optional: an older cached bundle carries neither, and
     that must read as "nothing derived to say", never as "nothing shipped". */
  delivery_state?: "none" | "partial" | "full" | null;
  lifecycle_state?: "none" | "delivered" | "invoiced" | "returned" | null;
  do_nos?: string[] | null;
  /** The same delivery orders and the sales invoices raised against this order,
   *  each with the id the right-click "Print Delivery Order" needs — a PDF is
   *  fetched by ADDRESS and `do_nos` carries only the number. Optional: a page
   *  and the Worker deploy independently, so a bundle can talk to a worker that
   *  does not send them yet, and the menu simply offers fewer entries. */
  do_refs?: Array<{ id: string; docNo: string }> | null;
  si_refs?: Array<{ id: string; docNo: string }> | null;
  stock_remark?: string;
  /** System Purchase Order numbers this SO was converted into (empty when
   *  none). Server-derived via the SO-line→PO-item→PO chain. LEGACY raise-link
   *  since 2026-08-02 — shown in the PO No. column's tooltip when it differs
   *  from the source union below. */
  converted_po_nos?: string[] | null;
  /** Union of the per-line source-PO chips the drill shows (owner 2026-08-02,
   *  "他拿的货是谁的货"): SHIPPED/DELIVERED consumed batches ∪ READY FIFO
   *  projections, via the ONE shared resolver. Drives the visible PO No.
   *  chips — an accessories/CS SO fulfilled from stock bought under another
   *  PO finally names that PO instead of a dash. */
  source_po_union?: string[] | null;
  /** Any line shipped/allocated from a PO-less stock ADJUSTMENT — renders a
   *  "STOCK ADJ" chip so the cell is explained, never blank. */
  source_po_adj?: boolean;
  processing_date: string | null;
  customer_delivery_date: string | null;
  // ── Phase 2 FINANCE: cost / margin / per-category subtotals + deposit. The
  //    backend OMITS these keys entirely for non-finance callers
  //    (canViewScmFinance), so every one is optional. margin_pct_basis is
  //    basis points (margin/total x 10000).
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
  deposit_sen?: number;
};



// ─── Helpers ────────────────────────────────────────────────────────────────

const fmtRm = (centi: number): string => fmtSen(centi);

// margin_pct_basis is basis points (margin/total x 10000) → percent string.
const fmtPctBasis = (basis: number | null | undefined): string =>
  basis == null ? "—" : `${(basis / 100).toFixed(1)}%`;

// Customer's PO / Ref number — spec: "Every list must show the customer SO
// Ref number". Prefer po_doc_no (populated by the SO New form's "Customer
// PO #"), then customer_so_no, then the legacy `ref` column, then dash.
const refOf = (r: SoRow): string =>
  r.po_doc_no || r.customer_so_no || r.ref || "—";

// Branding badge tone. Spec: 2990 SOFA = success (green), AKEMI = neutral,
// BEDFRAME = accent, other brands = warning (amber). brandOf's old `|| "—"`
// dashed every sofa; the one shared rule cannot return blank (owner 2026-08-17).
/* The header wins ONLY when it carries a real brand. The book's free-text
   branding field is often a placeholder — "NONE" on 170 imported orders —
   and a placeholder that out-ranks the derived label printed NONE on a
   TRION bedframe (owner 2026-08-31, HC-SO-013402). isPlaceholderBrandText
   is the shared rule; the mobile twin below uses the same one. */
const brandOf = (r: SoRow): string => (isPlaceholderBrandText(r.branding) ? "" : (r.branding ?? "").trim())
  || brandingLabel(r.first_item_category, r.first_item_branding, getBrandingCompanyCode());
/* This surface carries the line's CATEGORY, so it uses the accurate entry
   point: colour and label then share one bucket rule and cannot disagree.
   ../../lib/brandingTone has the whole story. */
const brandTone = (r: SoRow): BrandTone => brandingToneForCategory(r.first_item_category);


// ─── Salesperson dropdown / split-menu ──────────────────────────────────────

/** Small controlled dropdown that renders under the "New Sales Order" split
 *  button. Simple menu — no portal, no keyboard-nav layer; the target this
 *  redesign is showing off is the visual composition, not menu wizardry. */
function SplitDropdown({
  onFromQuotation,
  onImport,
  onDuplicate,
  canMaintain,
}: {
  onFromQuotation: () => void;
  onImport: () => void;
  onDuplicate: () => void;
  /* SO Maintenance is director-only (owner 2026-07-15). Import-from-file and
     Duplicate-last-SO both land on /scm/sales-orders/maintenance, so they are
     hidden from a non-director (OFF, not hide — no menu entry, and the route
     itself Forbids). "New from quotation" stays for everyone. */
  canMaintain: boolean;
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
                onFromQuotation();
              }}
            >
              New from quotation
            </button>
            {canMaintain && (
              <>
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
                  Duplicate last SO
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Table / Cards view toggle ──────────────────────────────────────────────

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

function CardsGrid({ rows, onOpen }: { rows: SoRow[]; onOpen: (r: SoRow) => void }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-16 text-center shadow-stone">
        <div className="text-[13px] font-semibold text-ink">No sales orders</div>
        <div className="mt-1 text-[12px] text-ink-muted">
          No orders match the current filters. Try Reset layout to clear the search
          and status tabs.
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
            key={r.doc_no}
            type="button"
            onClick={() => onOpen(r)}
            className="group relative overflow-hidden rounded-lg border border-border bg-surface px-4 py-4 text-left shadow-stone transition-all duration-200 hover:-translate-y-px hover:border-primary/40 hover:shadow-slab focus:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-docno text-[12.5px] font-semibold text-ink">
                {r.doc_no}
              </span>
              <StatusWithHold tone={st.tone} label={st.label} row={r} />
            </div>
            <div className="mt-2 truncate text-[15px] font-semibold text-ink">
              {r.debtor_name || "—"}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <Badge tone={brandTone(r)} variant="soft" size="xs">
                {brand}
              </Badge>
              <span className="text-[11.5px] text-ink-muted">{fmtDate(r.so_date)}</span>
            </div>
            <div className="mt-3.5 flex items-end justify-between border-t border-border-subtle pt-3">
              <div className="min-w-0">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  Ref
                </div>
                <div className="mt-0.5 truncate font-mono text-[12px] font-semibold text-ink-secondary">
                  {refOf(r)}
                </div>
              </div>
              <span className="font-money text-[15px] font-bold text-ink">
                {fmtRm(r.local_total_sen)}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Detail drawer ──────────────────────────────────────────────────────────

function DetailDrawer({
  row,
  onClose,
  onOpenFull,
  onEdit,
  onPrint,
  onConfirm,
  onDeliver,
  onReopen,
  canDeliver,
  salespersonName,
}: {
  row: SoRow | null;
  onClose: () => void;
  onOpenFull: () => void;
  onEdit: () => void;
  onPrint: () => void;
  onConfirm: () => void;
  onDeliver: () => void;
  onReopen: () => void;
  /** Sales may raise the SO but not operate the DO (owner 2026-07-17). False
   *  makes the Deliver CTA ABSENT — the destination route is guarded on
   *  scm.sales.delivery with no Sales bypass, so rendering it only ever led a
   *  salesperson to <Forbidden>. */
  canDeliver: boolean;
  salespersonName: string;
}) {
  const detailQ = useMfgSalesOrderDetail(row?.doc_no ?? null);
  // API (GET /mfg-sales-orders/:docNo) returns raw item columns: description,
  // item_code, qty, unit_price_sen, discount_sen, total_sen. Read those
  // exact names (matches SalesOrderDetailV2). The old product_name/item_code/
  // amount_sen names never existed → "—" for every SO, and for mirrored 2990
  // POS lines (money in total_sen, unit_price_sen≈0) the qty×unit fallback
  // rendered RM 0.00. Prefer the authoritative total_sen.
  // Owner 2026-07-15 — the quick-view line must read like the customer doc:
  // "order line must show description, colour, divan etc." The detail response
  // already carries item_group / description2 / variants for every line (they
  // were simply not read here), so widen the local type and render the LIVE
  // variant summary (shared buildVariantSummary, same helper the SO full page +
  // mobile use) under the item name.
  const items: Array<{
    item_code?: string;
    description?: string;
    description2?: string | null;
    item_group?: string | null;
    variants?: Record<string, unknown> | null;
    qty?: number;
    unit_price_sen?: number;
    total_sen?: number;
  }> =
    (detailQ.data as { items?: unknown[] } | undefined)?.items as Array<{
      item_code?: string;
      description?: string;
      description2?: string | null;
      item_group?: string | null;
      variants?: Record<string, unknown> | null;
      qty?: number;
      unit_price_sen?: number;
      total_sen?: number;
    }> ?? [];

  const open = !!row;
  const st = row ? statusFor(row.status) : null;

  // Totals from live line items when the detail query has resolved; fall back
  // to header totals otherwise so the drawer still reads immediately.
  // Nick 2026-07-09 — SST used to be ADDED at 6 % on top of subtotal, but SO
  // prices are quoted SST-inclusive (mirrors SalesOrderDetailV2's "SST ·
  // Inclusive" line). Adding another 6 % double-taxed the drawer's Total
  // against the aside on the detail page. Total is now just subtotal.
  const subtotalSen =
    items.length > 0
      ? items.reduce((sum, l) => sum + (l.total_sen ?? (l.qty ?? 0) * (l.unit_price_sen ?? 0)), 0)
      : row?.local_total_sen ?? 0;
  const totalSen = subtotalSen;
  // Ledger-derived paid (Σ payments); the stored paid_sen is a deprecated
  // column no writer maintains, kept only as the absent-view fallback.
  const paidSen = row?.paid_total_sen ?? row?.paid_sen ?? 0;
  const outstandingSen = totalSen - paidSen;

  return (
    <ResizableDetailDrawer
      open={open}
      onClose={onClose}
      ariaLabel={row ? `Sales order ${row.doc_no}` : "Sales order details"}
    >
        {row && st && (
          <>
            {/* dark header */}
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
                  {row.doc_no}
                </div>
                <div className="mt-0.5 text-[11px] text-sidebar-ink-muted">Sales Order</div>
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

            {/* scroll body */}
            <div className="flex-1 overflow-y-auto px-5 py-5">
              {/* customer + brand + date */}
              <div className="text-[19px] font-bold text-ink">{row.debtor_name || "—"}</div>
              <div className="mt-1.5 flex items-center gap-2.5">
                <Badge tone={brandTone(row)} variant="soft" size="xs">
                  {brandOf(row)}
                </Badge>
                <span className="text-[12.5px] text-ink-muted">
                  Ordered {fmtDate(row.so_date)}
                </span>
              </div>

              {/* meta grid */}
              <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2 px-4 py-4">
                <MetaItem k="Salesperson" v={salespersonName} />
                <MetaItem k="Location" v={<LocationText row={row} />} />
                <MetaItem k="Reference" v={refOf(row)} mono />
                <MetaItem k="Branding" v={brandOf(row)} />
                <MetaItem k="Order date" v={fmtDate(row.so_date)} />
                {/* Owner 2026-07-24 — the quick view showed only the order
                    date; operators need Processing (processing_date, the one
                    true user date) and Delivery at a glance. Both already ride
                    the list payload (HEADER). */}
                <MetaItem k="Processing" v={fmtDate(row.processing_date)} />
                <MetaItem k="Delivery" v={fmtDate(row.customer_delivery_date)} />
                <MetaItem
                  k="Payment"
                  v={row.payment_methods_summary || row.payment_method || "—"}
                />
              </dl>

              {/* customer & delivery card */}
              <SectionHeading>Customer &amp; delivery</SectionHeading>
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

              {/* order lines */}
              <SectionHeading>Order lines</SectionHeading>
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="grid grid-cols-[1fr_52px_92px] gap-2 border-b border-border-subtle bg-surface-2 px-4 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  <span>Item</span>
                  <span className="text-right">Qty</span>
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
                  const amt = l.total_sen ?? (l.qty ?? 0) * (l.unit_price_sen ?? 0);
                  /* Item CODE first, then the variant subtitle; description
                     dropped (owner 2026-07-24) — the shared order-line rule
                     (vendor/shared/line-identity.ts). Live variant summary wins
                     over the stored description2, which can be stale on older
                     rows with no variants blob. */
                  const { primary, secondary } = orderLineIdentity({
                    code: l.item_code,
                    description: l.description,
                    variant:
                      buildVariantSummary(l.item_group ?? "", l.variants ?? null) ||
                      (l.description2 ?? ""),
                  });
                  return (
                    <div
                      key={i}
                      className="grid grid-cols-[1fr_52px_92px] items-start gap-2 border-b border-border-subtle px-4 py-3 last:border-b-0"
                    >
                      <div className="min-w-0">
                        {/* Weight/size tuned down to sit with the qty/amount
                            columns instead of shouting over them. */}
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
                      <span className="text-right font-money text-[12.5px] font-semibold text-ink">
                        {fmtRm(amt)}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* totals */}
              <div className="mt-4 rounded-lg border border-border bg-surface px-5 py-4">
                <TotalRow k="Subtotal" v={fmtRm(subtotalSen)} />
                <TotalRow k="Total" v={fmtRm(totalSen)} strong />
                {paidSen > 0 ? (
                  <TotalRow k="Paid" v={fmtRm(paidSen)} tone="success" />
                ) : null}
                {outstandingSen !== 0 ? ( // `> 0` hid the row on exactly the orders that need it: an over-collection is not "nothing outstanding"
                  <TotalRow k={outstandingSen < 0 ? "Over-collected" : "Outstanding"} v={fmtRm(outstandingSen)} tone="error" />
                ) : null}
              </div>
            </div>

            {/* footer actions */}
            <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-5 py-3">
              <Button variant="ghost" icon={<Edit3 size={14} />} onClick={onEdit}>
                Edit
              </Button>
              <Button variant="ghost" icon={<Printer size={14} />} onClick={onPrint}>
                Print
              </Button>
              <div className="flex-1" />
              {(() => {
                // Backend can hand back status in any case ("Draft" / "draft" /
                // "DRAFT"); normalise once so the CTA switch works regardless.
                const s = (row.status || "").toLowerCase();
                if (s === "draft") {
                  return (
                    <Button
                      variant="primary"
                      icon={<CheckCircle2 size={14} />}
                      onClick={onConfirm}
                    >
                      Confirm
                    </Button>
                  );
                }
                if (soCanRaiseDo(row.status, row.on_hold ?? null)) {
                  // ABSENT, not disabled, for anyone who may not operate a DO.
                  if (!canDeliver) return null;
                  /* Renamed from "Deliver" 2026-08-17 — the SO already reports a
                     "Delivered" STATUS, and statuses report while buttons act. */
                  return (
                    <Button
                      variant="primary"
                      icon={<Truck size={14} />}
                      onClick={onDeliver}
                    >
                      {transferToLabel('do')}
                    </Button>
                  );
                }
                // Reopen a cancelled SO back to CONFIRMED so it can proceed
                // again (2990 MfgSalesOrdersList "Reopen SO" parity).
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

// ─── Drawer sub-primitives ──────────────────────────────────────────────────

/* The free-text fallback is a create-time snapshot that no relation backs — it
   is styled apart so a guess is never indistinguishable from a real warehouse. */
function LocationText({ row, className }: { row: SoRow; className?: string }) {
  const { label, isWarehouse } = resolveSoLocation(row);
  if (!label) return <span className={cn("text-ink-secondary", className)}>—</span>;
  if (isWarehouse)
    return <span className={cn("text-ink-secondary", className)}>{label}</span>;
  return (
    <span
      className={cn("italic text-ink-muted", className)}
      title="Unverified location text from this order's header — no warehouse is set on its lines."
    >
      {label}
    </span>
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
        strong && "border-t border-border-subtle pt-2.5 mt-1"
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

// Table column key → backend sort-whitelist column. Only the mismatched key
// ("amount" → "local_total_sen") needs a map; doc_no / so_date / debtor_name
// / status already match the backend names 1:1. Columns not in this map that
// are also not backend-sortable are marked `disableSort` on the column def.
const SORT_COL_MAP: Record<string, string> = {
  amount: "local_total_sen",
};

// ─── Row drill-down (DataTable `expandable`) ──────────────────────────────────
// Inline per-line breakdown for one SO, rendered under its parent row when the
// chevron is toggled (2990 MfgSalesOrdersList drill-down parity, trimmed to the
// fields the Houzs list needs). Lazy-fetches the SO detail via the same
// useMfgSalesOrderDetail hook the drawer uses — TanStack caches it, so
// expanding a row the drawer already opened (or re-expanding) is instant. Live
// variant summary via buildVariantSummary, matching the drawer + SO full page.

type DrillItem = {
  /* The coverage overlay keys on it (vendor/scm/lib/so-coverage-overlay); the
     detail payload has always carried it, this shape just never named it. */
  id?: string;
  item_code?: string;
  description?: string;
  description2?: string | null;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
  qty?: number;
  unit_price_sen?: number;
  total_sen?: number;
  /* Per-line readiness — all already stamped by GET /mfg-sales-orders/:docNo
     (the same payload this expansion fetches); the old four-column layout just
     dropped them on the floor (owner 2026-07-24: "怎么没有每一个 line 的
     stock status,还有 incoming PO?"). */
  stock_status?: string | null; // READY | PARTIAL | PENDING (stored)
  stock_state?: "stock" | "po" | "shortage" | null; // live MRP verdict
  coverage_po?: string | null; // incoming PO covering this line…
  coverage_eta?: string | null; // …and its effective ETA
  shipped_source_pos?: string[]; // actual source PO(s) once shipped
  shipped_source_adj?: boolean; // shipped from a PO-less stock adjustment
  ready_source_pos?: Array<{ po: string | null; qty: number; kind: "po" | "adjustment" }>;
  delivered_qty?: number | null;
  remaining_qty?: number | null;
};
/* The stock pill + the Incoming PO/source cell both render through the ONE
   shared SO-source renderer (components/SoSourceChips.tsx) — the same one the
   SO detail page and the editor use, so the four surfaces can never drift
   (owner 2026-08-01). The old page-local drillStock moved there as
   soLineStockPill. */

function SoLinesExpansion({ docNo }: { docNo: string }) {
  const detailQ = useMfgSalesOrderDetail(docNo);
  /* THE MRP-DERIVED HALF ARRIVES SEPARATELY. Since #2834 the detail payload
     hard-codes `coverage_po: null` / `ready_source_pos: []` and fills them from
     GET /:docNo/coverage. The detail PAGE made that call and this drill-down did
     not, so its "Incoming PO" column went permanently blank — chips 3 and 4 both
     read those fields (docs/modules/sales-order.md §0.8 documents all four).
     Owner 2026-09-01: 「明明我的 PO No. 那边是有的，可是 Incoming PO 却没有」.
     Same overlay as the detail page, deliberately — docs/bugs/0596-*. */
  const coverageQ = useSoLineCoverage(docNo);
  const items = overlaySoLineCoverage(
    ((detailQ.data as { items?: unknown[] } | undefined)?.items as DrillItem[]) ?? [],
    coverageQ.data?.coverage,
  );

  if (detailQ.isLoading) {
    return (
      <div className="py-4 text-center text-[12px] text-ink-muted">
        Loading lines…
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="py-4 text-center text-[12px] text-ink-muted">
        No lines on this order.
      </div>
    );
  }

  /* 2990 drill-down parity (owner 2026-07-24): Group, per-line stock status
     and the covering incoming PO + ETA belong ON the line — the payload has
     carried them all along. Min-width + horizontal scroll keeps the grid
     honest on narrow desktop panes. */
  const grid = "grid grid-cols-[92px_minmax(220px,1fr)_56px_100px_110px_96px_92px_190px] items-start gap-2";
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <div className="min-w-[880px]">
        <div className={cn(grid, "border-b border-border-subtle bg-surface-2 px-4 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted")}>
          <span>Group</span>
          <span>Item</span>
          <span className="text-right">Qty</span>
          <span className="text-right">Unit</span>
          <span className="text-right">Amount</span>
          <span>Stock</span>
          <span>Delivered</span>
          <span>Incoming PO</span>
        </div>
        {items.map((l, i) => {
          const amt = l.total_sen ?? (l.qty ?? 0) * (l.unit_price_sen ?? 0);
          /* Item CODE first, then the variant subtitle; description dropped
             (owner 2026-07-24) — the shared order-line rule
             (vendor/shared/line-identity.ts). This drill-down row is the TWIN
             of the quick-view drawer above in this same file. */
          const { primary, secondary } = orderLineIdentity({
            code: l.item_code,
            description: l.description,
            variant:
              buildVariantSummary(l.item_group ?? "", l.variants ?? null) ||
              (l.description2 ?? ""),
          });
          return (
            <div
              key={i}
              className={cn(grid, "border-b border-border-subtle px-4 py-2.5 last:border-b-0")}
            >
              <span><ItemGroupPill group={l.item_group ?? null} /></span>
              <div className="min-w-0">
                <div className="text-[12.5px] font-semibold text-ink">
                  {primary || "—"}
                </div>
                {secondary && (
                  <div className="mt-0.5 text-[11px] leading-snug text-ink-secondary">
                    {secondary}
                  </div>
                )}
              </div>
              <span className="text-right font-money text-[12px] text-ink-secondary">
                {l.qty ?? 0}
              </span>
              <span className="text-right font-money text-[12px] text-ink-secondary">
                {fmtRm(l.unit_price_sen ?? 0)}
              </span>
              <span className="text-right font-money text-[12px] font-semibold text-ink">
                {fmtRm(amt)}
              </span>
              <span>
                <SoStockPill line={l} />
              </span>
              <span><ShippedProgressPill line={l} /></span>
              {/* The ONE shared renderer, identical to the SO detail page —
                  the four chips are documented at sales-order.md §0.8. */}
              <span className="min-w-0">
                <SoSourceChips line={l} coverage={coverageStateOf(coverageQ)} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export function MfgSalesOrdersListV2() {
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
  // Finance-viewer gate — same signal the PMS finance sections use
  // (auth/me = isFinanceViewer). The cost/margin/subtotal columns below are
  // only DECLARED for a finance-viewer, so the column chooser never lists an
  // always-empty finance column for a non-finance user (the backend also omits
  // those keys from the payload — see canViewScmFinance).
  const { user, can, pageAccess } = useAuth();
  const canFinance = canViewScmCosting(user);
  // SO Maintenance (bulk import / duplicate / renumber) — the BACKEND's answer,
  // `scm.maintenance.open`, resolved once on /auth/me and read verbatim.
  //
  // WAS `isDirectorUser(user)`, which the route guard and both mobile sites also
  // asked independently. That cohort ({`*`, Super Admin, Sales Director, Finance
  // Manager}) is not the one the API serves: the page's writes pass
  // houzs-perms.canWriteScmConfig, which also admits Procurement/Purchasing,
  // Operation Manager, Operation Executive and Logistic Admin — so those four
  // could not even see this button over a page the API would have let them edit.
  // Owner 2026-07-15's exclusion of non-director SALES is unchanged: the sales
  // cohort satisfies neither term of the capability.
  const canMaintain = capability(user, "scm.maintenance.open");
  // Converting an SO into a Delivery Order is the Office department's job — the
  // ONE gate, shared with every other DO/SI control on both platforms.
  const canDeliver = canOperateDeliveryOrders(user, can, pageAccess);

  const status = (params.get("status") ?? "all") as StatusTab;
  // View toggle applies at md+; on phones we always render the card list
  // regardless of the URL param (a 9-col DataTable is unreadable on 360dpi).
  const view = (params.get("view") ?? "table") as "table" | "cards";
  const search = params.get("q") ?? "";
  // URL is state — the page index lives in `?page=` (0-based). pageSize is a
  // fixed 50 (backend caps at 100). Both feed the server-pagination hook so
  // search / status counts / sort span the FULL set, not the visible page.
  const page = Math.max(0, parseInt(params.get("page") ?? "0", 10) || 0);
  // Per-page is now the operator's choice (owner 2026-07-24), persisted per
  // list. Backend caps at 100, so the options stay ≤100.
  const [pageSize, setPageSize] = useLocalStorage<number>("scm:perpage:sales-orders", 50);

  const [selected, setSelected] = useState<SoRow | null>(null);
  // Server-side sort, formatted "<col>:<dir>" for the backend whitelist
  // (so_date/doc_no/debtor_name/status/local_total_sen/customer_delivery_date).
  const [sort, setSort] = useState<string | undefined>(undefined);
  // Gate the list query until the DataTable has reported its localStorage-
  // restored sort up to us (its one-shot mount effect → setSortAndReset below).
  // Without this the first fetch fires sort-less, then the restored sort lands
  // and immediately aborts+re-fires it — one wasted round trip on every open.
  // The report ALWAYS arrives once (even null when nothing is persisted), so
  // this never hangs the no-persisted-sort case.
  const [sortReady, setSortReady] = useState(false);
  // Debounced search — the URL `q` updates on every keystroke (so the input
  // stays controlled + shareable) but we only re-query the server 300ms after
  // the user stops typing.
  const { requestTerm: debouncedSearch } = useDebouncedSearchTerm(search);
  // Scan Order — handwritten slip OCR → DRAFT SO (ScanOrderModal). The modal
  // owns the whole flow: it enqueues a BACKGROUND job per slip (the same
  // /scan-so/enqueue path the mobile Scan screen uses) and the draft lands in
  // this list on its own. We only toggle its visibility.
  const [showScan, setShowScan] = useState(false);
  // Multi-select → batch "Print all". Keys are doc_no (the DataTable rowKey).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [printingDocs, setPrintingDocs] = useState(false);

  const { data, isLoading, isFetching, isPlaceholderData, error } = useMfgSalesOrdersPaged({
    page,
    pageSize,
    status,
    q: debouncedSearch,
    sort,
    enabled: sortReady,
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
  const updateStatus = useUpdateMfgSalesOrderStatus();
  const setHold = useSetDocumentHold("so");

  // The server already filtered (status + search) and sorted this page; the
  // rows are rendered verbatim — NO client re-filter / re-sort (that would be
  // wrong on a partial page).
  const rows = useEnrichedSoListRows((data?.salesOrders ?? []) as SoRow[], !listLoading); // SHIPPED chips + stored placeholders; deferred MRP heals 4 fields a beat later
  const total = data?.total ?? 0;
  // Status tab counts come from the server over the FULL scoped set (not the
  // page), so the pills stay correct while paging / searching.
  const counts: Record<string, number> = data?.statusCounts ?? { all: 0 };

  // KPI money stats — the backend paginated contract returns `aggregates` with
  // FULL-SET revenue/outstanding/paid sums (computed server-side over the same
  // scope+company+status+search filters, all rows), byte-identical to the old
  // pre-pagination client sum. We use those directly. Total Orders uses `total`.
  // Defensive fallback: if `aggregates` is absent (old backend / mid-deploy),
  // fall back to summing the CURRENT page's rows and label it "on this page".
  const aggregates = data?.aggregates;
  const stats = useMemo(() => {
    if (aggregates) return { ...aggregates, fullSet: true };
    let revenueSen = 0;
    let outstandingSen = 0;
    let paidSen = 0;
    // Client-side fallback sum (legacy non-paginated path only — the paginated
    // path uses the server's full-set `aggregates`). Same ledger-derived
    // columns the server now sums, so both paths agree.
    for (const r of rows) {
      revenueSen += r.local_total_sen ?? 0;
      outstandingSen += r.balance_sen_live ?? r.balance_sen ?? 0;
      paidSen += r.paid_total_sen ?? r.paid_sen ?? 0;
    }
    return { revenueSen, outstandingSen, paidSen, fullSet: false };
  }, [aggregates, rows]);

  // Write the page index to the URL. p<=0 drops the param (clean default).
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
    next.delete("page"); // status change → back to page 0
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
    next.delete("page"); // typing → back to page 0
    setParams(next, { replace: true });
  };
  // The DataTable fires onSortChange once on mount to sync any localStorage-
  // persisted sort up to us. That first call must ADOPT the sort without
  // resetting the page (so a deep-linked ?page=N survives a refresh); only
  // subsequent user-initiated header clicks reset back to page 0.
  const sortSyncedRef = useRef(false);
  const setSortAndReset = (
    s: { key: string; dir: "asc" | "desc" } | null
  ) => {
    setSort(s ? `${SORT_COL_MAP[s.key] ?? s.key}:${s.dir}` : undefined);
    if (!sortSyncedRef.current) {
      sortSyncedRef.current = true;
      // First (mount) report: the restored sort is now in state, so release the
      // gate — the one and only list fetch fires with `sort` already applied.
      setSortReady(true);
      return;
    }
    setPageParam(0); // sort change → back to page 0
  };
  const resetLayout = () => {
    setSort(undefined);
    setParams(new URLSearchParams(), { replace: true });
  };
  const filtersActive =
    status !== "all" || view !== "table" || search.trim().length > 0;

  // ── Actions wired to real routes / mutations ──────────────────────────
  const goNewSo = () => navigate("/scm/sales-orders/new");
  const goScanOrder = () => setShowScan(true);
  const goSoMaintenance = () => navigate("/scm/sales-orders/maintenance");
  const goFromQuotation = () => navigate("/scm/sales-orders/new/guided");
  const goImport = () => navigate("/scm/sales-orders/maintenance?tab=import");
  const goDuplicate = () => navigate("/scm/sales-orders/maintenance?tab=duplicate");
  const goEdit = (r: SoRow) => navigate(`/scm/sales-orders/${r.doc_no}?edit=1`);
  const printDocument = usePrintDocument();
  const goFullPage = (r: SoRow) => navigate(`/scm/sales-orders/${r.doc_no}`);
  const doConfirm = (r: SoRow) =>
    updateStatus.mutate(
      { docNo: r.doc_no, status: "confirmed", expectedStatus: r.status },
      { onSuccess: () => setSelected(null) }
    );
  const doDeliver = (r: SoRow) => navigate(convertToLink('soToDo', r.doc_no));
  // Reopen a cancelled SO → CONFIRMED so it can proceed again (2990
  // MfgSalesOrdersList "Reopen SO" parity; reuses the status PATCH endpoint).
  const doReopen = async (r: SoRow) => {
    if (
      !(await askConfirm({
        title: `Reopen ${r.doc_no}?`,
        body: "Back to CONFIRMED so it can proceed again.",
        confirmLabel: "Reopen",
      }))
    )
      return;
    updateStatus.mutate(
      { docNo: r.doc_no, status: "CONFIRMED", expectedStatus: r.status },
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

  /* The four statuses the route accepted and no screen ever sent — the owner's
     own lifecycle, minus the two the machine writes. See row-menus.ts. */
  const setSoStatus = async (r: SoRow, status: string) => {
    if (!(await askConfirm({
      title: `${r.doc_no} → ${status.replace(/_/g, " ").toLowerCase()}?`,
      body: "This changes the order's status. It does not move stock or create any document.",
      confirmLabel: "Change status",
    }))) return;
    updateStatus.mutate({ docNo: r.doc_no, status, expectedStatus: r.status }, {
      onError: (e) => notify({ title: "Status not changed", body: e instanceof Error ? e.message : "Something went wrong.", tone: "error" }),
    });
  };
  /* Not setSoStatus: the WORDS are the point — Close sits one menu entry from
     Cancel and they do opposite things to the money. Both live in ./use-close-action. */
  const doCloseSo = makeCloseAction({ askConfirm, notify, mutate: updateStatus.mutate });
  const doCancelSo = async (r: SoRow) => {
    if (!(await askConfirm({
      title: `Cancel ${r.doc_no}?`,
      body: "A cancelled sales order cannot be reactivated — any deposit becomes customer credit.",
      confirmLabel: "Cancel Sales Order",
    }))) return;
    updateStatus.mutate({ docNo: r.doc_no, status: "CANCELLED", expectedStatus: r.status }, {
      onError: (e) => notify({ title: "Cancel failed", body: e instanceof Error ? e.message : "Something went wrong.", tone: "error" }),
    });
  };
  /* Put On Hold / Take Off Hold — the mig-0324 MARKER, never the status. The
     wording lives in ./use-hold-action; this screen runs it through askConfirm
     because every other action here does. */
  const setSoHold = async (r: SoRow, onHold: boolean) => {
    if (!(await askConfirm(holdPrompt(r.doc_no, onHold)))) return;
    setHold.mutate({ key: r.doc_no, onHold });
  };
  const soContextMenu = salesOrderRowMenu<SoRow>({
    open: goFullPage, edit: goEdit, print: printDocument,
    confirm: doConfirm, transferToDo: doDeliver, reopen: doReopen,
    setStatus: setSoStatus, close: doCloseSo, setHold: setSoHold, cancel: doCancelSo, canDeliver,
  });

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

  // One SO's full PDF bundle — detail (header + items + pwpCodes) and the
  // payments ledger. Delegated to lib/printDocumentPdf, the ONE place that
  // knows a Sales Order is addressed by its NUMBER and that a failed payments
  // read must PROPAGATE rather than render a PDF claiming nothing was paid —
  // that reasoning now lives beside the fetch it governs. The row menu's print
  // calls the same function, so batch and single cannot drift apart.
  const fetchSoBundle = async (docNo: string) => {
    const b = await fetchPrintBundle({ doc: "so", docNo, key: docNo });
    return { ...b, payments: b.payments ?? [], pwpCodes: b.pwpCodes ?? [] };
  };

  // Batch "Print all" — one ticked SO downloads straight; several prompt
  // combined-vs-separate. Mirrors the V1 exportSelected.
  const deliverSelectedSos = async (action: PdfAction) => {
    if (printingDocs) return;
    const chosen = rows.filter((r) => selectedIds.has(r.doc_no));
    if (chosen.length === 0) return;
    try {
      const { generateSalesOrderPdf, generateCombinedSalesOrderPdf } =
        await import("../../vendor/scm/lib/sales-order-pdf");
      if (chosen.length === 1) {
        setPrintingDocs(true);
        const b = await fetchSoBundle(chosen[0]!.doc_no);
        await generateSalesOrderPdf(
          b.header as never,
          b.items as never,
          b.payments as never,
          action,
          b.pwpCodes as never
        );
        clearSelection();
        return;
      }
      /* View / Print always render ONE document — a preview or a print run
         is about the stack, not N separate files. Only the download exit
         still asks combined-vs-separate. */
      const how = action !== "save" ? "one" : await askChoice({
        title: `Print ${chosen.length} sales orders`,
        options: [
          { value: "one", label: "One combined PDF" },
          { value: "many", label: "Separate files", detail: "One PDF per document" },
        ],
      });
      if (how == null) return;
      setPrintingDocs(true);
      const bundles: Array<Awaited<ReturnType<typeof fetchSoBundle>>> = [];
      for (const r of chosen) bundles.push(await fetchSoBundle(r.doc_no));
      if (how === "one") {
        await generateCombinedSalesOrderPdf(
          bundles.map((b) => ({
            header: b.header as never,
            items: b.items as never,
            payments: b.payments as never,
            pwpCodes: b.pwpCodes as never,
          })),
          { fileName: `sales-orders-${new Date().toISOString().slice(0, 10)}.pdf`, action }
        );
      } else {
        for (const b of bundles)
          await generateSalesOrderPdf(
            b.header as never,
            b.items as never,
            b.payments as never,
            action,
            b.pwpCodes as never
          );
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
  const batchPrint = usePrintPreview(deliverSelectedSos);

  /* ── Table columns ───────────────────────────────────────────────────────
     `group` puts each column under a header in the Columns drawer. The design
     handoff's example listed Basic / Amounts / Logistics / Custom fields for a
     20-column demo; this list is 44, so two more groups earn their place —
     stuffing eleven address fields into "Basic" would put the drawer back to
     the flat scroll the grouping exists to end. Custom fields is automatic
     (every UDF column joins it). Finance columns are only DECLARED for a
     finance viewer, so that group simply doesn't exist for anyone else. */
  const columns: Column<SoRow>[] = [
    {
      key: "doc_no",
      group: "Basic",
      label: "Doc No.",
      // 156 + font-docno (owner 2026-07-31): 132 clipped a full doc no by a
      // couple of px — see the measured DO No. note in MfgDeliveryOrdersListV2.
      width: "156px",
      alwaysVisible: true,
      getValue: (r) => r.doc_no,
      render: (r) => (
        <span
          className={cn(
            "font-docno text-[12.5px] font-semibold text-ink",
            isCancelledDocStatus(r.status) && "dt-cancel-strike",
          )}
        >
          {r.doc_no}
        </span>
      ),
    },
    {
      key: "so_date",
      group: "Basic",
      label: "Date",
      width: "108px",
      getValue: (r) => r.so_date,
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{fmtDate(r.so_date)}</span>
      ),
    },
    {
      key: "debtor_name",
      group: "Basic",
      label: "Customer",
      getValue: (r) => r.debtor_name,
      render: (r) => (
        <span className="text-[13px] font-semibold text-ink">
          {r.debtor_name || "—"}
        </span>
      ),
    },
    {
      key: "salesperson",
      group: "Basic",
      label: "Salesperson",
      width: "148px",
      // Not in the backend sort whitelist — keep getValue for CSV export but
      // disable the header sort so we never send an unsupported sort key.
      disableSort: true,
      getValue: (r) => salespersonNameOf(r.agent, r.salesperson_id, ""),
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">
          {salespersonNameOf(r.agent, r.salesperson_id, "—")}
        </span>
      ),
    },
    {
      key: "sales_location",
      group: "Logistics",
      label: "Location",
      width: "132px",
      disableSort: true,
      getValue: (r) => resolveSoLocation(r).label ?? "",
      render: (r) => <LocationText row={r} className="text-[12.5px]" />,
    },
    {
      key: "reference",
      group: "Basic",
      label: "Reference",
      width: "132px",
      disableSort: true,
      getValue: (r) => refOf(r),
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">{refOf(r)}</span>
      ),
    },
    {
      key: "branding",
      group: "Basic",
      label: "Branding",
      width: "112px",
      disableSort: true,
      getValue: (r) => brandOf(r),
      render: (r) => {
        const b = brandOf(r);
        return (
          <Badge tone={brandTone(r)} variant="soft" size="xs">
            {b}
          </Badge>
        );
      },
    },
    {
      key: "status",
      group: "Basic",
      label: "Status",
      width: "108px",
      // Exempt from the cancelled-row fade — the pill is WHY the row is grey.
      className: "dt-cancel-keep",
      getValue: (r) => r.status,
      render: (r) => {
        /* THE ONE RULE (soRowStatus -> soStatusDisplay), the same one the SO
           detail's editor renders, so this cell and the Delivered column beside
           it can no longer answer "has it gone out?" two different ways. When
           the derived answer disagrees with the STORED status — which is what
           the tab strip still counts this row under — the disagreement is shown,
           never quietly resolved. 0619. */
        const st = soRowStatus(r, soStatusDisplay);
        /* mig 0324 — the Hold marker sits BESIDE the real status pill. */
        return (
          <span className="inline-flex items-center gap-1">
            <StatusWithHold tone={st.tone} label={st.label} row={r} />
            {st.storedLabel && (
              <span
                title={`This order's own delivery records say ${st.label}, but its stored status is still ${st.storedLabel} — which is the tab it is counted under. The stored status is only rewritten when a delivery order changes through the app, so an imported or scripted delivery leaves it behind.`}
                className="rounded border border-warning-text/40 bg-warning-bg px-1 text-[10px] font-semibold text-warning-text"
              >
                {st.storedLabel}
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: "amount",
      group: "Amounts",
      label: "Amount",
      width: "128px",
      align: "right",
      getValue: (r) => r.local_total_sen,
      render: (r) => (
        <span className="font-money text-[13px] font-semibold text-ink">
          {fmtRm(r.local_total_sen)}
        </span>
      ),
    },
    // ── Re-added columns (Phase 1) — data already on the SoRow payload, ported
    //    from the legacy MfgSalesOrdersList buildColumns (labels/widths). All
    //    default-hidden so the column chooser exposes them without changing the
    //    slim default view. disableSort because the SO list is server-sorted
    //    and these keys aren't in the backend sort whitelist.
    {
      /* NB: the key stays "po_doc_no" for historical reasons — it is what
         users (incl. the owner) already have persisted as a shown/ordered
         column, so keeping it means this now-populated column lands where they
         left it. The CONTENT changed twice:
         · owner 2026-07-24 — from the customer's hand-typed PO # (never filled
           for 2990) to the SYSTEM PO(s) the SO was converted into.
         · owner 2026-08-02 — from the convert-time raise-link to the UNION of
           per-line SOURCE-PO chips the drill shows (`source_po_union`: shipped
           consumed batches ∪ READY projections, the shared resolver). The
           convert-link lied by omission: accessories/CS SOs fulfilled from
           stock bought under other POs showed "—" while their drill named the
           source PO.
         · 2026-08-11 — the raise-link came BACK as a visible chip, because
           demoting it to a tooltip on an em-dash reintroduced the same lie
           from the other side. Both goods-source arms need execution: SHIPPED
           needs a DO line, READY needs an open lot that resolves to a PO.
           A CONFIRMED order that has not shipped and whose stock is not yet
           allocated satisfies NEITHER, so the cell said "no purchase order"
           for documents whose own Relationship Map named one (HC-SO-011733 →
           HC-PO-008783 → HC-GR-004863). Across the 2,723 Houzs Century SOs
           only ~53 could ever light the union arms, while 277 carry a real
           non-cancelled PO on `purchase_order_items.so_item_id`. The raised
           PO is now rendered as a MUTED provenance chip — visually distinct
           from the solid goods-source chip and carrying its own tooltip — so
           the cell answers "是谁的货" and "叫了什么单" without conflating them.
           A tooltip is not an answer: if a link exists, a chip must show. */
      key: "po_doc_no",
      group: "Logistics",
      label: "PO No.",
      width: "150px",
      disableSort: true,
      getValue: (r) => poCellChips(r).all.join(", "),
      render: (r) => <SoListPoCell row={r} />,
    },
    {
      key: "phone",
      group: "Customer",
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
      key: "email",
      group: "Customer",
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
      key: "debtor_code",
      group: "Customer",
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
      key: "address1",
      group: "Customer",
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
      key: "address2",
      group: "Customer",
      label: "Address 2",
      width: "180px",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.address2 ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.address2 || "—"}</span>
      ),
    },
    {
      key: "city",
      group: "Customer",
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
      group: "Customer",
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
      group: "Customer",
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
      key: "payment_method",
      group: "Amounts",
      label: "Payment Method",
      width: "150px",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) =>
        r.payment_methods_summary ||
        (r.payment_method ? r.payment_method.toUpperCase() : ""),
      render: (r) => {
        const pm =
          r.payment_methods_summary ||
          (r.payment_method ? r.payment_method.toUpperCase() : "");
        return <span className="text-[12.5px] text-ink-secondary">{pm || "—"}</span>;
      },
    },
    {
      key: "paid",
      group: "Amounts",
      label: "Paid",
      width: "110px",
      align: "right",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.paid_total_sen ?? r.paid_sen ?? 0,
      render: (r) => (
        <span className="font-money text-[13px] text-ink">{fmtRm(r.paid_total_sen ?? r.paid_sen ?? 0)}</span>
      ),
    },
    {
      key: "balance",
      group: "Amounts",
      label: "Balance",
      width: "110px",
      align: "right",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.balance_sen_live ?? r.balance_sen, // `?? 0` was dead: balance_sen is `number`, never nullish
      render: (r) => ( // negative = over-collected → text-err, the app's negative-money convention (owner 2026-08-16)
        <span className={cn("font-money text-[13px]", (r.balance_sen_live ?? r.balance_sen) < 0 ? "text-err" : "text-ink")}>{fmtRm(r.balance_sen_live ?? r.balance_sen)}</span>
      ),
    },
    // ── Re-added columns (Phase 2) — NON-finance fields that already travel on
    //    the SO list payload (HEADER + server-computed) but were untyped, so no
    //    column existed. All default-hidden + disableSort (server-sorted list;
    //    these keys aren't in the backend sort whitelist). Safe for everyone.
    {
      // Was "Current Doc No." until 2026-08-14 — why it changed: SoListDoCell.
      key: "do_no",
      group: "Logistics",
      label: "DO No.",
      width: "150px",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => (r.do_nos ?? []).join(", "),
      render: (r) => <SoListDoCell doNos={r.do_nos} />,
    },
    {
      key: "venue",
      group: "Logistics",
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
      key: "stock_status",
      group: "Logistics",
      label: "Stock Status",
      width: "170px",
      defaultHidden: true,
      disableSort: true,                       // client-side; sortValue orders it
      getValue: (r) => r.stock_remark ?? "",   // raw remark for CSV + the funnel
      sortValue: (r) => stockRemarkSortScore(r.stock_remark),  // fullest first
      render: (r) => <StockRemarkPill remark={r.stock_remark} />,  // was grey text
    },
    shippedProgressColumn<SoRow>(),
    {
      key: "processing_date",
      group: "Logistics",
      label: "Processing Date",
      width: "140px",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.processing_date ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">
          {fmtDate(r.processing_date)}
        </span>
      ),
    },
    {
      key: "customer_delivery_date",
      group: "Logistics",
      label: "Delivery Date",
      width: "160px",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.customer_delivery_date ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">
          {fmtDate(r.customer_delivery_date)}
        </span>
      ),
    },
    {
      key: "note",
      group: "Basic",
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
      group: "Customer",
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
      group: "Customer",
      label: "Building Type",
      width: "130px",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.building_type ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.building_type || "—"}</span>
      ),
    },
    {
      key: "customer_country",
      group: "Customer",
      label: "Country",
      width: "120px",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.customer_country ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.customer_country || "—"}</span>
      ),
    },
    // ── Phase 2 FINANCE columns — cost / margin / per-category subtotals +
    //    deposit. DECLARED ONLY for a finance-viewer so the column chooser never
    //    lists an always-empty finance column for a non-finance user; the
    //    backend also omits these keys from the payload (canViewScmFinance).
    ...(canFinance
      ? ([
          {
            key: "mattress_sofa_sen",
            group: "Finance",
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
            group: "Finance",
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
            group: "Finance",
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
            group: "Finance",
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
            key: "service_sen",
            group: "Finance",
            label: "Service",
            width: "110px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.service_sen ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink">{fmtRm(r.service_sen ?? 0)}</span>
            ),
          },
          {
            key: "mattress_sofa_cost_sen",
            group: "Finance",
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
            group: "Finance",
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
            group: "Finance",
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
            group: "Finance",
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
            key: "service_cost_sen",
            group: "Finance",
            label: "Service Cost",
            width: "130px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.service_cost_sen ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink-secondary">{fmtRm(r.service_cost_sen ?? 0)}</span>
            ),
          },
          {
            key: "total_cost_sen",
            group: "Finance",
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
            group: "Finance",
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
            group: "Finance",
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
          {
            key: "deposit_sen",
            group: "Amounts",
            label: "Deposit",
            width: "110px",
            align: "right",
            defaultHidden: true,
            disableSort: true,
            getValue: (r) => r.deposit_sen ?? 0,
            render: (r) => (
              <span className="font-money text-[13px] text-ink">{fmtRm(r.deposit_sen ?? 0)}</span>
            ),
          },
        ] satisfies Column<SoRow>[])
      : ([] satisfies Column<SoRow>[])),
  ];

  /* ── Column layouts ──────────────────────────────────────────────────────
     Houzs and 2990 run their sales desks off the SAME list page but read it for
     different things — 2990 works the production/delivery pipeline (balance,
     stock status, the two dates), Houzs works the sale itself (location,
     reference). Rather than pick one and make the other company re-tick eleven
     boxes on every new browser, each company gets its own DEFAULT layout and
     BOTH are offered in the Columns panel, so anyone can take the other's view
     (owner 2026-08-01). `alwaysVisible` Doc No. is implicit and never listed.

     SEEDS, not the final word: once an admin saves a default from the Columns
     panel it is stored per company (table_layouts) and takes the matching entry
     here out of play — moving a column for everyone in 2990 stopped being a
     deploy. Either way it is a baseline that applies only while a user has no
     column prefs of their own, so nobody's arrangement is touched. */
  const layoutPresets = useMemo<ColumnLayoutPreset[]>(() => {
    const is2990 = branding.companyCode === "2990";
    return [
      {
        id: "so-2990",
        label: "2990 Layout",
        hint: "Production & delivery",
        companyCode: "2990",
        isDefault: is2990,
        columns: [
          "so_date",
          "debtor_name",
          "salesperson",
          "branding",
          "amount",
          "balance",
          "status",
          "stock_status",
          "po_doc_no",
          "processing_date",
          "customer_delivery_date",
        ],
      },
      {
        id: "so-houzs",
        label: "Houzs Layout",
        hint: "Sales desk",
        companyCode: "HOUZS",
        isDefault: !is2990,
        columns: [
          "so_date",
          "debtor_name",
          "salesperson",
          "sales_location",
          "reference",
          "branding",
          "status",
          "amount",
          "po_doc_no",
        ],
      },
    ];
  }, [branding.companyCode]);

  /* One pill per vocabulary status, each carrying its FULL-set count (see
     SO_STATUS_TABS) via FilterPills' count badge — these are the SERVER's
     statusCounts, never a count of the loaded page. "Other" (legacy/unknown
     status spellings) appears only when the server reports a non-zero count
     for it — or while it is the active filter, so the selected pill can never
     vanish from under the user. */
  const statusPillOptions: Array<{ value: StatusTab; label: string; count: number }> = [
    ...SO_STATUS_TABS.map(({ value, label }) => ({
      value,
      label,
      count: counts[value] ?? 0,
    })),
    ...((counts.other ?? 0) > 0 || status === "other"
      ? [{ value: "other" as StatusTab, label: "Other", count: counts.other ?? 0 }]
      : []),
  ];

  const onPullToRefresh = async () => {
    // Wipe the SO list cache for every status tab so the pull's spinner
    // reflects a real network round-trip. Detail queries stay warm.
    await queryClient.invalidateQueries({ queryKey: ["mfg-sales-orders"] });
  };

  return (
    <PullToRefresh onRefresh={onPullToRefresh}>
      {/* When the drawer is open the desktop shell reflows into the left
          520 + gutter, so stats/table are cleanly visible next to it instead
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
            Sales Orders
          </h1>
          <div className="mt-0.5 text-[12.5px] text-ink-muted">
            {total} order{total === 1 ? "" : "s"} ·{" "}
            <span className="font-money">{fmtRm(stats.revenueSen)}</span>
          </div>
        </div>
      </div>

      {/* Page chrome — owner 2026-07-24 reversed the 2026-07-09 "pin KPIs +
          filter pills" ruling: like Service Cases, the cards and pills now
          SCROLL AWAY and only the DataTable's own toolbar + header + pager
          freeze under the (self-sticky) PageHeader. The old page-local
          `sticky top-0 z-20` here also sat ABOVE the freeze box's z-10 and
          occluded its toolbar/header, and its height was invisible to
          --page-header-offset (published by PageHeader alone), so the freeze
          geometry could never account for it. Mobile flow keeps its own
          sticky search below. */}
      <div className="-mx-4 hidden pb-3 sm:-mx-6 md:block">
        <div className="px-4 sm:px-6">
          <PageHeader
            eyebrow="Supply Chain"
            title="Sales Orders"
            description={`Every ${shortCompanyName(branding.companyName)} sales order — Draft to Delivered. Click any row for the quick view; open the full page to edit.`}
            primaryAction={
              <div className="flex items-stretch">
                <Button
                  variant="primary"
                  icon={<Plus size={14} />}
                  onClick={goNewSo}
                  className="rounded-r-none"
                >
                  New Sales Order
                </Button>
                <SplitDropdown
                  onFromQuotation={goFromQuotation}
                  onImport={goImport}
                  onDuplicate={goDuplicate}
                  canMaintain={canMaintain}
                />
              </div>
            }
            secondaryActions={[
              { label: "Scan Order", icon: ScanLine, onClick: goScanOrder },
              ...(canMaintain
                ? [{ label: "SO Maintenance", icon: Wrench, onClick: goSoMaintenance }]
                : []),
            ]}
          />

          {/* No data-freeze-anchor here: the owner revised the SO ruling to
              match Service Cases — cards + status pills scroll away, and the
              freeze keeps only the DataTable's own toolbar + header + pager
              (the component-root default). */}
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              pending={statsPending}
              label="Total Orders"
              value={total.toLocaleString("en-MY")}
              subtitle="All matching orders"
              rail="bg-primary"
              active
            />
            <StatCard
              pending={statsPending}
              label="Revenue"
              value={fmtRm(stats.revenueSen)}
              subtitle={stats.fullSet ? "All matching orders" : "Sum on this page"}
              rail="bg-accent"
            />
            <StatCard
              pending={statsPending}
              label="Outstanding"
              value={fmtRm(stats.outstandingSen)}
              subtitle={stats.fullSet ? "Balance due" : "Balance on this page"}
              tone="error"
              rail="bg-err"
            />
            <StatCard
              pending={statsPending}
              label="Paid"
              value={fmtRm(stats.paidSen)}
              subtitle={stats.fullSet ? "Receipts to date" : "Receipts on this page"}
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

      {/* Mobile-only sticky search — sits above the pill row on phones. */}
      <div className="sticky top-0 z-10 -mx-4 mb-3 bg-bg/95 px-4 py-2 backdrop-blur-sm md:hidden">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search SO, customer, phone, ref…"
          className="h-10 w-full rounded-lg border border-border bg-surface px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
        <SearchProgress
          active={searchTransition.isSearching}
          label={searchTransition.statusText}
          className="mt-1.5"
        />
        <SearchScopeHint scope="server" searching={searchTransition.isSearching} countPending={isLoading || isPlaceholderData || Boolean(error) || searchTransition.resultsAreStale} resultCount={total} term={search} className="mt-1" />
      </div>

      {/* Mobile filter row — desktop pills live inside the sticky chrome above. */}
      <div className="mb-4 flex flex-wrap items-center gap-3 md:hidden">
        <FilterPills
          options={statusPillOptions}
          value={status}
          onChange={(v) => setStatusChip(v)}
        />
      </div>

      {/* Phone → CardsGrid ALWAYS. Desktop → the view toggle decides. */}
      <div className="md:hidden">
        {error ? (
          <ListErrorPanel message={(error as Error).message} />
        ) : searchTransition.resultsAreStale ? (
          <SearchPendingPanel label={searchTransition.statusText} />
        ) : (
          <CardsGrid rows={rows} onOpen={(r) => setSelected(r)} />
        )}
        {!searchTransition.resultsAreStale && <div className="pb-24">
          <ListPager
            page={page}
            pageSize={pageSize}
            total={total}
            noun="orders"
            onPageChange={setPageParam}
            onPageSizeChange={(n) => { setPageSize(n); setPageParam(0); }}
          />
        </div>}
      </div>

      {/* Table / Cards (md+) */}
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
                docTitle="Sales Orders"
                docNos={rows.filter((r) => selectedIds.has(r.doc_no)).map((r) => r.doc_no)}
                {...batchPrint.handlers}
              />
              <Button variant="ghost" disabled={printingDocs} onClick={clearSelection}>
                Clear
              </Button>
            </div>
          )}
          <DataTable<SoRow>
            tableId="sales-orders-v2"
            documentLabel="Sales Orders"
            layoutPresets={layoutPresets}
            rows={rows}
            loading={listLoading}
            error={error ? (error as Error).message ?? "Failed to load" : null}
            columns={columns}
            getRowKey={(r) => r.doc_no}
            getRowClassName={(r) =>
              isCancelledDocStatus(r.status) ? "dt-row-cancelled" : undefined
            }
            onRowClick={(r) => setSelected(r)}
            expandable={{
              render: (r) => <SoLinesExpansion docNo={r.doc_no} />,
              rowKey: (r) => r.doc_no,
            }}
            selection={{
              selectedIds,
              onToggle: toggleSelect,
              onToggleAll: toggleSelectAll,
            }}
            contextMenu={soContextMenu}
            exportName="sales-orders"
            serverSort
            onSortChange={setSortAndReset}
            emptyLabel={
              filtersActive
                ? "No sales orders match — try Reset layout to clear filters."
                : "No sales orders yet."
            }
            search={{
              value: search,
              onChange: setSearch,
              placeholder: "Search doc no, customer, phone, ref…",
              debounceMs: 0,
              searching: searchTransition.isSearching,
              countPending: isLoading || isPlaceholderData || Boolean(error) || searchTransition.resultsAreStale,
              searchingLabel: "Searching…",
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
            noun="orders"
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
                placeholder="Search doc no, customer, phone, ref…"
                className="h-9 max-w-[320px] flex-1 rounded-md border border-border bg-surface px-3.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
              <SearchProgress active={searchTransition.isSearching} label="Searching…" />
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
          {error ? (
            <ListErrorPanel message={(error as Error).message} />
          ) : searchTransition.resultsAreStale ? (
            <SearchPendingPanel label={searchTransition.statusText} />
          ) : <><CardsGrid rows={rows} onOpen={(r) => setSelected(r)} />
          <ListPager
            page={page}
            pageSize={pageSize}
            total={total}
            noun="orders"
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
        onPrint={() => selected && printDocument(salesOrderPrintChain(selected).own)}
        onConfirm={() => selected && doConfirm(selected)}
        onDeliver={() => selected && doDeliver(selected)}
        onReopen={() => selected && void doReopen(selected)}
        canDeliver={canDeliver}
        salespersonName={
          selected
            ? salespersonNameOf(selected.agent, selected.salesperson_id)
            : "—"
        }
      />

      {showScan && <ScanOrderModal onClose={() => setShowScan(false)} />}
    </PullToRefresh>
  );
}

export default MfgSalesOrdersListV2;
