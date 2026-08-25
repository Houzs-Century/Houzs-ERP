// MfgDeliveryOrdersListV2 — Theme C redesign of the Delivery Orders listing.
// Mirrors the SO V2 template (MfgSalesOrdersListV2): PageHeader + StatCard
// grid + FilterPills + Table/Cards toggle + right slide-over detail drawer.
// See MfgSalesOrdersListV2.tsx for the deep dive on primitives + Theme C
// conventions — this file is deliberately structured the same way so the
// three-headed sales chain (DO / SI / DR) can share the template.
//
// Route: /scm/delivery-orders (App.tsx flips ScmDeliveryOrdersV2 here).
// Data: useMfgDeliveryOrders / useMfgDeliveryOrderDetail /
//       useUpdateMfgDeliveryOrderStatus (all live in the vendored SCM lib —
//       we don't re-derive them; the Theme C paint is chrome-only).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { statusFor, doCancellableStatus, type StatusTab } from "./do-list-status";
import { deliveryOrderRowMenu } from "./row-menus";
import { doCountsAsInvoiceable, doCountsAsDelivered } from "../../vendor/shared/do-shipped-states";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { brandingToneForLabel } from "../../lib/brandingTone";
import { canViewScmCosting, canOperateDeliveryOrders } from "../../auth/salesAccess";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Plus,
  ChevronDown,
  Truck,
  Wrench,
  LayoutGrid,
  Table as TableIcon,
  X as XIcon,
  ExternalLink,
  Edit3,
  Printer,
  CheckCircle2,
  Receipt,
  ArrowRightLeft,
} from "lucide-react";
import { PrintPreviewBatchModal, usePrintPreview } from "../../components/scm-v2/PrintPreviewModal";
import { usePrintDocument } from "../../components/scm-v2/PrintChainProvider";
import { deliveryOrderPrintChain } from "../../lib/printChain";
import { fetchPrintBundle } from "../../lib/printDocumentPdf";
import type { PdfAction } from "../../vendor/scm/lib/pdf-common";
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
} from "../../components/DocumentLinesExpansion";
import { ListPager } from "../../components/ListPager";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useVisibleRows } from "../../hooks/useVisibleRows";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { NextStepNote } from "../../components/NextStepNote";
import {
  doAdvanceBlockReason,
  doAdvanceStep,
  siTransferBlockReason,
} from "../../vendor/scm/lib/do-next-step";
import { PullToRefresh } from "../../components/PullToRefresh";
import { ListErrorPanel, SearchPendingPanel, SearchProgress } from "../../components/SearchProgress";
import { SearchScopeHint } from "../../components/SearchScopeHint";
import { useStaffLookup } from "../../hooks/useStaffLookup";
import { useBranding } from "../../hooks/useBranding";
import { shortCompanyName } from "../../lib/branding";
import { useDebouncedSearchTerm, useSearchResultTransition } from "../../hooks/useServerSearch";
import {
  useMfgDeliveryOrdersPaged,
  useMfgDeliveryOrderDetail,
  useUpdateMfgDeliveryOrderStatus,
} from "../../vendor/scm/lib/delivery-order-queries";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { useChoice } from "../../vendor/scm/components/ChoiceDialog";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "../../lib/utils";
import { convertToLink, transferToLabel, transferFromLabel, transferFromColumnLabel } from "../../lib/convertScope";
import { isCancelledDocStatus } from "../../lib/scm";
import { ResizableDetailDrawer } from "../../components/ResizableDetailDrawer";
import { useAuth } from "../../auth/AuthContext";
import { buildVariantSummary, fmtSen, fmtDate, orderLineIdentity } from "@2990s/shared";
import { formatPhone } from "@2990s/shared/phone";
import { useHoldAction } from "./use-hold-action";
import { StatusWithHold, rowIsHeld, type HoldFields } from "../../vendor/scm/components/HoldChip";

// ─── Types ──────────────────────────────────────────────────────────────────
// Subset of the full DoRow (see MfgDeliveryOrdersList.tsx for the 40-field
// shape). Fields not listed here still exist on the API payload — they just
// aren't rendered by this V2 chrome.

type DoRow = HoldFields & {
  id: string;
  do_number: string;
  so_doc_no: string | null;
  do_date: string;
  expected_delivery_at: string | null;
  customer_delivery_date: string | null;
  /** Linked SO's Processing date (mfg_sales_orders.processing_date),
   *  stamped server-side onto every list row for the quick-view drawer. */
  so_processing_date?: string | null;
  debtor_name: string;
  debtor_code: string | null;
  salesperson_id: string | null;
  sales_location: string | null;
  customer_so_no: string | null;
  po_doc_no: string | null;
  /** Source PO(s) this DO's shipped goods came from (batch_no = source PO on the
   *  OUT movements ∪ consumed FIFO lots). "—" for un-batched (plain-FIFO /
   *  pre-batch) stock. A DO is a sales-side doc, so it shows Source PO, not an
   *  Assigned SO (owner 2026-07-31). */
  source_pos?: string[] | null;
  /* The SOs this DO's LINES draw on. so_doc_no above is only the header LABEL
     (from-sos copies the first pick's SO), so a merged DO named one source and
     hid the rest. */
  source_sos?: string[] | null;
  /** Shipped (at least partly) from a PO-less stock ADJUSTMENT lot — renders a
   *  "STOCK ADJ" chip so the cell is explained, never blank (owner 2026-08-01). */
  source_adj?: boolean;
  ref: string | null;
  /** POD, as stored — the list select is HEADER, which carries both. */
  signature_data?: string | null; pod_r2_key?: string | null;
  branding: string | null;
  driver_name: string | null;
  vehicle: string | null;
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
  lifecycle_state?: "shipped" | "invoiced" | "returned";
  /** Transfer-to relations (display-only, audit R8): the SI number(s) this DO
   *  was invoiced into, and the DR number(s) returned against it. */
  invoiced_si_nos?: string[] | null;
  return_nos?: string[] | null;
  is_dropship?: boolean;
  isDropship?: boolean;
  // ── Phase 2: NON-finance fields already on the DO list payload (HEADER).
  venue: string | null;
  note: string | null;
  customer_type: string | null;
  building_type: string | null;
  // ── Phase 2 FINANCE: backend OMITS these keys for non-finance callers
  //    (canViewScmFinance), so each is optional. margin_pct_basis = basis points.
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


// ─── Helpers ────────────────────────────────────────────────────────────────

const fmtRm = (centi: number): string => fmtSen(centi);

// margin_pct_basis is basis points (margin/total x 10000) → percent string.
const fmtPctBasis = (basis: number | null | undefined): string =>
  basis == null ? "—" : `${(basis / 100).toFixed(1)}%`;

// Customer's PO / Ref. Same fallback chain as the SO V2 template.
const refOf = (r: DoRow): string =>
  r.po_doc_no || r.customer_so_no || r.ref || "—";

// Origin SO number for the "SO Ref" column — the Delivery Order's most useful
// cross-doc anchor. Falls back to a dash for direct-issue DOs.
const soOf = (r: DoRow): string => r.so_doc_no || "—";

const brandOf = (r: DoRow): string => r.branding || "—";
/* Colour says WHAT THE LINE IS; the label says whose brand it is.
   ../../lib/brandingTone is the one home. This copy had lost the BEDFRAME
   arm too. */
const brandTone = brandingToneForLabel;


// ─── Split-menu dropdown (mirrors SO V2) ───────────────────────────────────

function SplitDropdown({
  onFromSo,
  onImport,
  onDuplicate,
}: {
  onFromSo: () => void;
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
            <button
              type="button"
              className="block w-full px-3.5 py-2 text-left text-[12.5px] text-ink hover:bg-primary-soft"
              onClick={() => {
                setOpen(false);
                onDuplicate();
              }}
            >
              Duplicate last DO
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

// ─── Cards grid (shared shape with SO V2 — only fields differ) ─────────────

function CardsGrid({ rows, onOpen }: { rows: DoRow[]; onOpen: (r: DoRow) => void }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-16 text-center shadow-stone">
        <div className="text-[13px] font-semibold text-ink">No delivery orders</div>
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
            key={r.id}
            type="button"
            onClick={() => onOpen(r)}
            className="group relative overflow-hidden rounded-lg border border-border bg-surface px-4 py-4 text-left shadow-stone transition-all duration-200 hover:-translate-y-px hover:border-primary/40 hover:shadow-slab focus:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-docno text-[12.5px] font-semibold text-ink">
                {r.do_number}
              </span>
              <StatusWithHold tone={st.tone} label={st.label} row={r} />
            </div>
            <div className="mt-2 truncate text-[15px] font-semibold text-ink">
              {r.debtor_name || "—"}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <Badge tone={brandTone(brand)} variant="soft" size="xs">
                {brand}
              </Badge>
              <span className="text-[11.5px] text-ink-muted">{fmtDate(r.do_date)}</span>
            </div>
            <div className="mt-3.5 flex items-end justify-between border-t border-border-subtle pt-3">
              <div className="min-w-0">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  {transferFromColumnLabel('so')}
                </div>
                <div className="mt-0.5 truncate font-mono text-[12px] font-semibold text-ink-secondary">
                  {soOf(r)}
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

// ─── Detail drawer ─────────────────────────────────────────────────────────

function DetailDrawer({
  row,
  onClose,
  onOpenFull,
  onEdit,
  onPrint,
  onAdvance,
  onConvertToSi,
  salespersonName,
  canWrite,
}: {
  row: DoRow | null;
  onClose: () => void;
  onOpenFull: () => void;
  onEdit: () => void;
  onPrint: () => void;
  /** Advance THIS document one status step — see do-next-step.ts for the verb. */
  onAdvance: () => void;
  onConvertToSi: () => void;
  canWrite: boolean;
  salespersonName: string;
}) {
  const detailQ = useMfgDeliveryOrderDetail(row?.id ?? null);
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

  /* Both status questions come from the SAME module the detail page and the
     mobile shell import, so this drawer and the page it opens can no longer
     answer them differently. See vendor/scm/lib/do-next-step.ts. */
  const advanceStep = doAdvanceStep(row?.status);
  const advanceReason = doAdvanceBlockReason(row?.status);
  const siReason = siTransferBlockReason(row?.status);
  const canConvertToSi = siReason === null;

  const totalSen = row?.local_total_sen ?? 0;

  return (
    <ResizableDetailDrawer
      open={open}
      onClose={onClose}
      ariaLabel={row ? `Delivery order ${row.do_number}` : "Delivery order details"}
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
                  {row.do_number}
                </div>
                <div className="mt-0.5 text-[11px] text-sidebar-ink-muted">Delivery Order</div>
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
                  Issued {fmtDate(row.do_date)}
                </span>
              </div>

              <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2 px-4 py-4">
                <MetaItem k={transferFromColumnLabel('so')} v={soOf(row)} mono />
                <MetaItem k="Customer ref" v={refOf(row)} mono />
                {/* Owner 2026-07-24 — Processing date (linked SO's
                    processing_date) must be visible in every quick view. */}
                <MetaItem k="Processing" v={fmtDate(row.so_processing_date ?? null)} />
                <MetaItem k="Delivery Date" v={fmtDate(row.customer_delivery_date)} />
                <MetaItem k="Expected at" v={fmtDate(row.expected_delivery_at)} />
                <MetaItem k="Driver" v={row.driver_name || "—"} />
                <MetaItem k="Vehicle" v={row.vehicle || "—"} />
                <MetaItem k="Location" v={row.sales_location || "—"} />
                <MetaItem k="Salesperson" v={salespersonName} />
              </dl>

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
                        {fmtRm(l.unit_price_sen ?? 0)}
                      </span>
                      <span className="text-right font-money text-[12.5px] font-semibold text-ink">
                        {fmtRm(amt)}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 rounded-lg border border-border bg-surface px-5 py-4">
                <TotalRow k="DO total" v={fmtRm(totalSen)} strong />
              </div>
            </div>

            <div className="shrink-0 border-t border-border bg-surface px-5 py-3">
            {canWrite && (
              <div className="mb-2 flex flex-col gap-0.5">
                <NextStepNote id="do-drawer-advance-reason" reason={advanceReason} />
                <NextStepNote id="do-drawer-si-reason" reason={siReason} />
              </div>
            )}
            <div className="flex items-center gap-2">
              {canWrite && (
                <Button variant="ghost" icon={<Edit3 size={14} />} onClick={onEdit}>
                  Edit
                </Button>
              )}
              <Button variant="ghost" icon={<Printer size={14} />} onClick={onPrint}>
                Print
              </Button>
              <div className="flex-1" />
              {/* TWO FIXED SLOTS, NEVER ONE SLOT WITH THREE VERBS. This footer
                  is the screen the owner was looking at on 2026-08-18: one green
                  button said "Mark signed" on a dispatched row and "Transfer to
                  Sales Invoice" on a signed one — same pixels, different action,
                  status badge the only clue. Advance and transfer now each keep
                  one meaning, disabled with a reason rather than swapped out.
                  The third verb, "Reopen", is gone entirely: the server refuses
                  every transition out of CANCELLED (`do_cancelled_final`), so it
                  could not once have worked. Full account: do-next-step.ts. */}
              {canWrite && advanceStep && (
                <Button
                  variant="secondary"
                  icon={<CheckCircle2 size={14} />}
                  onClick={onAdvance}
                >
                  {advanceStep.label}
                </Button>
              )}
              {canWrite && (
                <Button
                  variant="primary"
                  icon={<Receipt size={14} />}
                  onClick={onConvertToSi}
                  disabled={!canConvertToSi}
                  title={siReason ?? undefined}
                  aria-describedby={siReason ? "do-drawer-si-reason" : undefined}
                >
                  {transferToLabel('si')}
                </Button>
              )}
            </div>
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
}: {
  k: string;
  v: string;
  strong?: boolean;
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
          strong && "text-[15px] font-bold text-ink"
        )}
      >
        {v}
      </span>
    </div>
  );
}

// Table column key → backend sort-whitelist column. The DO backend whitelist is
// { do_date, do_number, debtor_name, status, customer_delivery_date } — only the
// delivery_date column key differs from its backend name; every other sortable
// column matches 1:1. Columns absent from the whitelist carry `disableSort`.
const SORT_COL_MAP: Record<string, string> = {
  delivery_date: "customer_delivery_date",
};

// ─── Row drill-down (DataTable `expandable`) ──────────────────────────────────
// Inline per-line breakdown for one DO under its parent row when the chevron is
// toggled (2990 MfgDeliveryOrdersList drill-down parity). Lazy-fetches the DO
// detail via the same useMfgDeliveryOrderDetail hook the drawer uses — TanStack
// caches it, so re-expanding (or expanding a row the drawer already opened) is
// instant.

type DoDrillItem = {
  item_code?: string;
  product_name?: string;
  description?: string;
  /* Variant fields — the SAME payload the quick-view drawer above already
     renders; the drill-down previously dropped them and showed the bare
     name + code (owner 2026-07-24, "为什么没有这个 description 的呢？全部文件
     by right 都要一样的啦"). */
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
  description2?: string | null;
  qty?: number;
  unit_price_sen?: number;
  amount_sen?: number;
  total_sen?: number;
  /* Source PO(s) this DO line's shipped goods came from (owner 2026-07-31) — the
     durable batch_no = source-PO hard link resolved by the DO detail endpoint
     from the OUT movements ∪ consumed FIFO lots. A DO is a sales-side doc, so it
     shows Source PO, not an Assigned SO. */
  source_pos?: string[] | null;
  /* The SOs this DO's LINES draw on. so_doc_no above is only the header LABEL
     (from-sos copies the first pick's SO), so a merged DO named one source and
     hid the rest. */
  source_sos?: string[] | null;
  /* Shipped (at least partly) from a PO-less stock ADJUSTMENT lot — renders a
     "STOCK ADJ" chip so the cell is explained, never blank (owner 2026-08-01). */
  source_adj?: boolean;
};

function DoLinesExpansion({ doId }: { doId: string }) {
  const navigate = useNavigate();
  const detailQ = useMfgDeliveryOrderDetail(doId);
  const items =
    ((detailQ.data as { items?: unknown[] } | undefined)?.items as DoDrillItem[]) ??
    [];
  const lines: DocumentDrillLine[] = items.map((l) => ({
    itemGroup: l.item_group ?? null,
    code: l.item_code || l.item_code || null,
    description: l.description || l.product_name || null,
    description2: l.description2 ?? null,
    variants: l.variants ?? null,
    qty: Number(l.qty ?? 0),
    amountSen: l.amount_sen ?? l.total_sen ?? (l.qty ?? 0) * (l.unit_price_sen ?? 0),
    sourcePos: l.source_pos ?? [],
    sourceAdj: l.source_adj ?? false,
  }));
  return (
    <div className="flex flex-col gap-2">
      <DocumentLinesExpansion
        isLoading={detailQ.isLoading}
        isError={Boolean(detailQ.error)}
        errorMessage={detailQ.error instanceof Error ? detailQ.error.message : null}
        lines={lines}
        emptyLabel="No lines on this delivery order."
        showSourcePo
      />
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export function MfgDeliveryOrdersListV2() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { nameOf: salespersonNameOf } = useStaffLookup();
  const notify = useNotify();
  const holdAction = useHoldAction("do");
  const askConfirm = useConfirm();
  const askChoice = useChoice();
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
  // cannot create/edit/convert a DO. Hide the create + row mutation actions
  // rather than render-then-deny (owner off-not-hide rule).
  // ONE gate, shared with the detail page, the SO drawer and mobile.
  const canWriteDo = canOperateDeliveryOrders(user, can, pageAccess);

  const status = (params.get("status") ?? "all") as StatusTab;
  const view = (params.get("view") ?? "table") as "table" | "cards";
  const search = params.get("q") ?? "";
  // URL is state — the 0-based page index lives in `?page=`. pageSize is a
  // fixed 50 (backend caps at 100). Server-side paging + search + counts + sort
  // span the FULL scoped set, not just the visible page.
  const page = Math.max(0, parseInt(params.get("page") ?? "0", 10) || 0);
  const [pageSize, setPageSize] = useLocalStorage<number>("scm:perpage:delivery-orders", 50);

  const [selected, setSelected] = useState<DoRow | null>(null);
  // Multi-select for batch PDF export. The Set owns the ticked DO ids; the
  // DataTable `selection` prop below drives the leading checkbox column and a
  // bulk-action bar renders once ≥1 row is ticked. `exporting` guards the
  // Export button against double-clicks while PDFs generate.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [sort, setSort] = useState<string | undefined>(undefined);
  const { requestTerm: debouncedSearch } = useDebouncedSearchTerm(search);

  // Send the active tab's BUCKET NAME as `status`; the backend resolves each
  // bucket to the raw statuses it covers (open = DRAFT+LOADED, in_transit =
  // DISPATCHED+IN_TRANSIT, delivered = SIGNED+DELIVERED+INVOICED+COMPLETED,
  // cancelled = CANCELLED). `all` omits the filter.
  const apiStatus = status === "all" ? undefined : status;

  const { data, isLoading, isFetching, isPlaceholderData, error } = useMfgDeliveryOrdersPaged({
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
  const updateStatus = useUpdateMfgDeliveryOrderStatus();

  // Server already filtered + sorted this page — render verbatim, no client
  // re-filter / re-sort (wrong on a partial page).
  const rows = (data?.deliveryOrders ?? []) as DoRow[];
  const total = data?.total ?? 0;
  // Full-set status-tab counts from the server (stable while paging / searching).
  const counts: Record<string, number> = data?.statusCounts ?? {};

  /* The rows the TABLE is showing — the server page minus whatever the
     per-column funnels hide (owner 2026-08-13, following the Purchase Orders
     fix). See hooks/useVisibleRows for why summarising the server page put two
     contradictory numbers on one screen. */
  const visible = useVisibleRows(rows);

  // Revenue sums the rows ON SCREEN (the paginated contract returns counts but
  // not full-set money sums), so the card and the table can never disagree.
  const revenueSen = useMemo(() => {
    let sum = 0;
    for (const r of visible.rows) sum += r.local_total_sen ?? 0;
    return sum;
  }, [visible.rows]);

  /* In-transit / Delivered normally read the server's FULL-set statusCounts —
     right, and deliberately unaffected by paging. But under an active column
     funnel they would state a whole-dataset count beside a table showing a
     handful of rows, which is the exact contradiction this change exists to
     remove. So while a funnel is narrowing the page, they describe the visible
     set instead; with no funnel they are byte-identical to before. */
  /* The TABS split one-per-status; these two cards must NOT — an invoiced
     delivery was delivered, and en-route is dispatched + in transit. */
  const visibleBucketCounts = useMemo(() => {
    let inTransit = 0;
    let delivered = 0;
    for (const r of visible.rows) {
      const b = statusFor(r.status).bucket;
      if (b === "dispatched" || b === "in_transit") inTransit += 1;
      if (b === "delivered" || b === "invoiced") delivered += 1;
    }
    return { inTransit, delivered };
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
  const sortSyncedRef = useRef(false);
  const setSortAndReset = (s: { key: string; dir: "asc" | "desc" } | null) => {
    setSort(s ? `${SORT_COL_MAP[s.key] ?? s.key}:${s.dir}` : undefined);
    if (!sortSyncedRef.current) {
      sortSyncedRef.current = true;
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

  const onPullToRefresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["mfg-delivery-orders"] });
  };

  // Wired actions
  const goNewDo = () => navigate("/scm/delivery-orders/new");
  const goFromSo = () => navigate("/scm/delivery-orders/from-so");
  const goImport = () => navigate("/scm/delivery-orders?import=1");
  const goDuplicate = () => navigate("/scm/delivery-orders?duplicate=1");
  const goSoList = () => navigate("/scm/sales-orders");
  const goPlanning = () => navigate("/scm/delivery-planning");
  const goEdit = (r: DoRow) => navigate(`/scm/delivery-orders/${r.id}?edit=1`);
  const printDocument = usePrintDocument();
  const goFullPage = (r: DoRow) => navigate(`/scm/delivery-orders/${r.id}`);
  /* One advance handler, target status supplied by do-next-step.ts — so this
     drawer walks the same ladder as the detail page and the mobile shell. */
  const doAdvance = (r: DoRow) => {
    const step = doAdvanceStep(r.status);
    if (!step) return;
    /* Only DRAFT → Confirm remains (owner 2026-08-21 removed "Mark signed"), so
       there is no delivery-close to warn about here — the driver's Proof-of-
       Delivery screen is what closes a delivery with its signature. */
    updateStatus.mutate(
      { id: r.id, status: step.status },
      { onSuccess: () => setSelected(null) }
    );
  };
  const doConvertToSi = (r: DoRow) => navigate(convertToLink('doToSi', r.id));
  const doConvertToDr = (r: DoRow) => navigate(convertToLink('doToDr', r.id));
  /* Cancel REVERSES STOCK, so it asks first — the same in-app confirm the Sales
     Order list's cancel uses, and the same endpoint the detail page posts. */
  const doCancelDo = async (r: DoRow) => {
    if (!(await askConfirm({
      title: `Cancel ${r.do_number}?`,
      body: "Stock allocated to this delivery order is released back to the Sales Order, and a cancelled delivery order cannot be reactivated — raise a new one to deliver again.",
      confirmLabel: "Cancel Delivery Order",
      danger: true,
    }))) return;
    updateStatus.mutate({ id: r.id, status: "CANCELLED" });
  };
  // Put On Hold / Take Off Hold — the mig-0324 MARKER, never the status. Wording in ./use-hold-action.ts.
  const setDoHold = (r: DoRow, onHold: boolean) => holdAction(r.id, r.do_number, onHold);
  /* Every predicate here is a SHARED one, not a status list typed at this call
     site. doCountsAsInvoiceable carries the owner's 2026-08-20 ruling that a
     LOADED delivery may be invoiced (「不要拦 —— 人自己知道」);
     doCountsAsDelivered is the same rule the server's returnable-DO picker
     applies (do-line-remaining.ts) — goods still on the lorry never left, so
     nothing can come back; doAdvanceStep supplies the one DRAFT rung.
     THE HOLD IS A SECOND AXIS (mig 0324), ANDed with them rather than folded in:
     those answer "where has this delivery got to", the marker answers "did
     somebody stop it". A held DO's stage is still its real stage. */
  const doContextMenu = deliveryOrderRowMenu<DoRow>({
    open: goFullPage, edit: goEdit, print: printDocument,
    transferToSi: doConvertToSi, transferToDr: doConvertToDr,
    confirm: doAdvance, cancel: doCancelDo, setHold: setDoHold,
    setStatus: (r, status) => updateStatus.mutate({ id: r.id, status }, { onSuccess: () => setSelected(null) }),
    canInvoice: (r) => canWriteDo && !rowIsHeld(r) && doCountsAsInvoiceable(r.status),
    canReturn: (r) => canWriteDo && !rowIsHeld(r) && doCountsAsDelivered(r.status),
    canConfirm: (r) => canWriteDo && !rowIsHeld(r) && doAdvanceStep(r.status) !== null,
    canSetStatus: (r) => canWriteDo && !rowIsHeld(r),
    canCancel: (r) => canWriteDo && doCancellableStatus(r.status),
  });
  /* `doReopen` (cancelled DO → LOADED) was REMOVED, not disabled. It could
     never succeed: PATCH /:id/status refuses every transition out of CANCELLED
     with `do_cancelled_final` (delivery-orders-mfg.ts:5401), because
     un-cancelling leaves the cancel's stock add-back standing while the
     re-deduct no-ops — the DO's whole quantity is then permanently added to
     stock. The drawer showed it as the green PRIMARY action on every cancelled
     row. A control whose only possible outcome is a 409 is not a capability to
     explain, so do-next-step.ts states the real next step instead: raise a new
     delivery order. */

  // ─── Batch PDF export (ported from MfgDeliveryOrdersList) ─────────────────
  /* Delegated to lib/printDocumentPdf, which is now the ONE place that knows a
     DO's detail endpoint and that its header must carry `loadScanId` to arm the
     print's "scan to mark loaded" QR. The row menu's print reads the same
     function, so batch and single cannot drift apart. */
  const fetchDoBundle = (row: DoRow): Promise<{ header: unknown; items: unknown[] }> =>
    fetchPrintBundle({ doc: "do", docNo: row.do_number, key: row.id });

  const clearSelection = () => setSelectedIds(new Set());

  // Batch "Export PDF" — one ticked DO downloads straight; several prompt
  // "One combined PDF" vs "Separate files", then fetch each bundle and render
  // into one merged file or one file per DO. Combined filename is date-stamped.
  const deliverSelectedDos = async (action: PdfAction) => {
    if (exporting) return;
    const chosen = rows.filter((r) => selectedIds.has(r.id));
    if (chosen.length === 0) return;
    try {
      const { generateDeliveryOrderPdf, generateCombinedDeliveryOrderPdf } =
        await import("../../vendor/scm/lib/delivery-order-pdf");
      if (chosen.length === 1) {
        setExporting(true);
        const bundle = await fetchDoBundle(chosen[0]!);
        await generateDeliveryOrderPdf(bundle.header as never, bundle.items as never, { action });
        clearSelection();
        return;
      }
      /* View / Print always render ONE document — a preview or a print run
         is about the stack, not N separate files. Only the download exit
         still asks combined-vs-separate. */
      const how = action !== "save" ? "one" : await askChoice({
        title: `Download ${chosen.length} delivery orders`,
        options: [
          { value: "one", label: "One combined PDF" },
          { value: "many", label: "Separate files", detail: "One PDF per document" },
        ],
      });
      if (how == null) return;
      setExporting(true);
      const bundles: Array<{ header: unknown; items: unknown[] }> = [];
      for (const r of chosen) bundles.push(await fetchDoBundle(r));
      if (how === "one") {
        await generateCombinedDeliveryOrderPdf(bundles as never, {
          fileName: `delivery-orders-${new Date().toISOString().slice(0, 10)}.pdf`,
          action,
        });
      } else {
        for (const b of bundles)
          await generateDeliveryOrderPdf(b.header as never, b.items as never, { action });
      }
      clearSelection();
    } catch (e) {
      notify({
        title: "PDF generation failed",
        body: e instanceof Error ? e.message : "Something went wrong.",
        tone: "error",
      });
    } finally {
      setExporting(false);
    }
  };
  const batchPrint = usePrintPreview(deliverSelectedDos);

  // Table columns
  const columns: Column<DoRow>[] = [
    {
      key: "do_number",
      label: "DO No.",
      // 156, not 132 (owner 2026-07-31, "每次都看不完整"). A px width is a
      // hard cap here — DataTable pins min/max to it and clips with an
      // ellipsis — and "2990-DO-2607-001" measured 109.6px at the old
      // 12.5px/600 system stack, which lands on 133.6 once px-3 adds 24px of
      // padding: 1.6px over the old 132, so EVERY row truncated. Same owner
      // call moved doc numbers to `font-docno` (Plex Sans), which measures
      // 115.3px — 122.8 with a 4-digit tail → 146.8 with padding. 156 clears it.
      // Widening costs no other column: every column pins its own min/max, so
      // the table just scrolls 24px further. Houzs numbers are bare
      // ("DO-2607-001" — companyDocPrefix returns '' for HOUZS), so the 2990
      // prefix is the worst case.
      width: "156px",
      alwaysVisible: true,
      getValue: (r) => r.do_number,
      render: (r) => (
        <span
          className={cn(
            "font-docno text-[12.5px] font-semibold text-ink",
            isCancelledDocStatus(r.status) && "dt-cancel-strike",
          )}
        >
          {r.do_number}
        </span>
      ),
    },
    {
      key: "do_date",
      label: "Date",
      width: "108px",
      getValue: (r) => r.do_date,
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{fmtDate(r.do_date)}</span>
      ),
    },
    {
      // Owner 2026-07-31: a DO is BORN FROM a Sales Order, so "Assigned SO" is
      // redundant here — restore the document-flow "From SO" anchor (clickable to
      // the parent SO). The useful cross-doc fact for a shipped DO is its Source
      // PO, in the next column.
      key: "so_doc_no",
      label: transferFromColumnLabel('so'),
      width: "150px",
      disableSort: true,
      /* 2026-08-04: show the SOs this DO's LINES actually draw on, not the
         header label. so_doc_no is set by from-sos to the FIRST pick's SO, so a
         DO merging several SOs displayed one and hid the rest — and two DOs
         then looked like they shipped the same Sales Order while sharing no
         quantity at all. Owner: "为什么一张SO可以开两张DO？？"; the read-only
         split check proved that SO was delivered exactly once.

         Falls back to the header label when a DO has no linked lines (an ad-hoc
         DO legitimately has only the header), so no cell goes blank. */
      getValue: (r) => (r.source_sos?.length ? r.source_sos.join(" ") : r.so_doc_no ?? ""),
      render: (r) => {
        const sos = r.source_sos?.length ? r.source_sos : (r.so_doc_no ? [r.so_doc_no] : []);
        return sos.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {sos.map((no: string) => (
              <button
                key={no}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/scm/sales-orders/${encodeURIComponent(no)}`);
                }}
                className="font-mono text-[12px] font-semibold text-ink-secondary hover:text-accent hover:underline"
              >
                {no}
              </button>
            ))}
          </span>
        ) : (
          <span className="text-[12px] text-ink-muted">—</span>
        );
      },
    },
    {
      // Owner 2026-07-31: which PO the shipped goods actually came from — the
      // durable batch_no = source-PO hard link (GRN-healed), not a guess.
      // "STOCK ADJ" when the goods entered via a PO-less adjustment; "—" only
      // when the ledger says nothing. List cells overflow past a few chips
      // into an in-place "+N" toggle (owner 2026-08-01 scale ruling).
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
      /* Transfer-to (audit R8): the SI(s) this DO was invoiced into, mirroring
         the SO list's "PO No." (converted_po_nos) convert-to column. Server-
         derived (invoiced_si_nos); DR returns share the tooltip via return_nos. */
      key: "invoiced_si_nos",
      label: "Invoiced to",
      width: "150px",
      disableSort: true,
      getValue: (r) => (r.invoiced_si_nos ?? []).join(", "),
      render: (r) => {
        const sis = r.invoiced_si_nos ?? [];
        const returns = r.return_nos ?? [];
        if (sis.length === 0 && returns.length === 0)
          return <span className="text-ink-muted">—</span>;
        return (
          <div className="flex flex-wrap gap-1">
            {sis.map((n) => (
              <span
                key={n}
                className="rounded bg-primary-soft px-1.5 py-0.5 font-docno text-[11px] font-semibold text-primary-ink"
              >
                {n}
              </span>
            ))}
            {returns.map((n) => (
              <span
                key={n}
                className="rounded bg-warning-bg px-1.5 py-0.5 font-docno text-[11px] font-semibold text-warning-text"
                title="Delivery return"
              >
                {n}
              </span>
            ))}
          </div>
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
      key: "delivery_date",
      label: "Delivery Date",
      width: "128px",
      getValue: (r) => r.customer_delivery_date ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">
          {fmtDate(r.customer_delivery_date)}
        </span>
      ),
    },
    {
      key: "driver",
      label: "Driver",
      width: "128px",
      disableSort: true,
      getValue: (r) => r.driver_name ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">
          {r.driver_name || "—"}
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
      // Exempt from the cancelled-row fade — the pill is WHY the row is grey.
      className: "dt-cancel-keep",
      getValue: (r) => r.status,
      render: (r) => {
        const st = statusFor(r.status);
        /* mig 0324 — the Hold marker sits BESIDE the real status pill. */
        return <StatusWithHold tone={st.tone} label={st.label} row={r} />;
      },
    },
    {
      key: "amount",
      label: "Amount",
      width: "128px",
      align: "right",
      // DO backend sort whitelist has no total column — keep for CSV export but
      // disable the header sort so we never send an unsupported sort key.
      disableSort: true,
      getValue: (r) => r.local_total_sen,
      render: (r) => (
        <span className="font-money text-[13px] font-semibold text-ink">
          {fmtRm(r.local_total_sen)}
        </span>
      ),
    },
    // ── Re-added columns (Phase 1) — data already on the DoRow payload, ported
    //    from the legacy MfgDeliveryOrdersList buildColumns (labels/widths). All
    //    default-hidden so the column chooser exposes them without changing the
    //    slim default view. disableSort because the DO list is server-sorted and
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
      key: "expected_delivery_at",
      label: "Expected",
      width: "128px",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.expected_delivery_at ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">
          {fmtDate(r.expected_delivery_at)}
        </span>
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
      key: "vehicle",
      label: "Vehicle",
      width: "120px",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.vehicle ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.vehicle || "—"}</span>
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
      key: "address2",
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
    // ── Re-added columns (Phase 2) — NON-finance fields already on the DO
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
            key: "service_sen",
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
            key: "service_cost_sen",
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
        ] satisfies Column<DoRow>[])
      : ([] satisfies Column<DoRow>[])),
  ];

  const statusPillOptions: Array<{ value: StatusTab; label: string }> = (
    // `on_hold` sits before Cancelled, as on the other four lists. Mig 0324.
    [["all", "All"], ["draft", "Draft"], ["loaded", "Confirmed"], ["dispatched", "Loaded"],
     ["in_transit", "In transit"], ["delivered", "Delivered"], ["invoiced", "Invoiced"],
     ["on_hold", "On Hold"], ["cancelled", "Cancelled"]] as Array<[StatusTab, string]>
  ).map(([value, label]) => ({ value, label: `${label} · ${counts[value] ?? 0}` }));

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
            Delivery Orders
          </h1>
          <div className="mt-0.5 text-[12.5px] text-ink-muted">
            {total} order{total === 1 ? "" : "s"} ·{" "}
            <span className="font-money">{fmtRm(revenueSen)}</span>
          </div>
        </div>
      </div>

      {/* Desktop sticky page chrome — pinned PageHeader + KPIs + FilterPills
          + ViewToggle. Matches SO listing V2 pattern. */}
      <div className="-mx-4 hidden pb-3 sm:-mx-6 md:block">
        <div className="px-4 sm:px-6">
          <PageHeader
            eyebrow="Supply Chain"
            title="Delivery Orders"
            description={`Every ${shortCompanyName(branding.companyName)} delivery order — Loaded to Delivered. Click any row for the quick view; open the full page to edit.`}
            primaryAction={
              canWriteDo ? (
                <div className="flex items-stretch gap-2">
                  <Button
                    variant="secondary"
                    icon={<ArrowRightLeft size={14} />}
                    onClick={goFromSo}
                  >
                    {transferFromLabel('so')}
                  </Button>
                  <div className="flex items-stretch">
                    <Button
                      variant="primary"
                      icon={<Plus size={14} />}
                      onClick={goNewDo}
                      className="rounded-r-none"
                    >
                      New Delivery Order
                    </Button>
                    <SplitDropdown
                      onFromSo={goFromSo}
                      onImport={goImport}
                      onDuplicate={goDuplicate}
                    />
                  </div>
                </div>
              ) : undefined
            }
            secondaryActions={[
              { label: "Sales Orders", icon: Wrench, onClick: goSoList },
              { label: "Delivery Planning", icon: Truck, onClick: goPlanning },
            ]}
          />

          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {/* Every tile describes the rows ON SCREEN and says so while a
                column funnel narrows them (owner 2026-08-13). The count tiles
                switch SOURCE, not just wording: the server's counts are right
                until a client-side funnel hides part of the page, at which
                point they contradict the table beneath them. */}
            <StatCard
              pending={statsPending}
              label="Total DOs"
              value={(visible.filtered ? visible.rows.length : total).toLocaleString("en-MY")}
              subtitle={visible.filtered ? "Filtered · shown below" : "All matching orders"}
              rail="bg-primary"
              active
            />
            <StatCard
              pending={statsPending}
              label="Revenue"
              value={fmtRm(revenueSen)}
              subtitle={visible.filtered ? "Filtered · sum shown below" : "Sum on this page"}
              rail="bg-accent"
            />
            <StatCard
              pending={statsPending}
              label="In transit"
              value={(visible.filtered
                ? visibleBucketCounts.inTransit
                : counts.dispatched + counts.in_transit
              ).toLocaleString("en-MY")}
              subtitle={visible.filtered ? "En route · filtered" : "Loaded · en route"}
              tone="warning"
              rail="bg-accent-bright"
            />
            <StatCard
              pending={statsPending}
              label="Delivered"
              value={(visible.filtered
                ? visibleBucketCounts.delivered
                : counts.delivered + counts.invoiced
              ).toLocaleString("en-MY")}
              subtitle={
                visible.filtered ? "Delivered · filtered" : "Delivered · including invoiced"
              }
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
          placeholder="Search DO, customer, phone, driver…"
          className="h-10 w-full rounded-lg border border-border bg-surface px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
        <SearchProgress active={searchTransition.isSearching} label={searchTransition.statusText} className="mt-1.5" />
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

      {/* Phone → Cards */}
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
            onPageChange={setPageParam}
            onPageSizeChange={(n) => { setPageSize(n); setPageParam(0); }}
          />
        </div>}
      </div>

      {/* Desktop → Table / Cards */}
      <div className="hidden md:block">
        {view === "table" ? (
          <>
            {/* Bulk-action bar — appears once ≥1 row is ticked. Mirrors the
                DeliveryPlanning "Convert N to DO" bar's look/placement (count
                on the left, primary action + Clear on the right), rendered in
                Theme C Tailwind instead of the vendored CSS module. */}
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
                  disabled={exporting}
                  onClick={batchPrint.openPreview}
                >
                  {exporting ? "Exporting…" : "Export PDF"}
                </Button>
                <PrintPreviewBatchModal
                  open={batchPrint.open}
                  onClose={batchPrint.close}
                  docTitle="Delivery Orders"
                  docNos={rows.filter((r) => selectedIds.has(r.id)).map((r) => r.do_number)}
                  {...batchPrint.handlers}
                />
                <Button
                  variant="ghost"
                  disabled={exporting}
                  onClick={clearSelection}
                >
                  Clear
                </Button>
              </div>
            )}
            <DataTable<DoRow>
              tableId="delivery-orders-v2"
              rows={rows}
              /* Feeds the stat strip so the tiles describe what is on screen. */
              onFilteredRowsChange={visible.onFilteredRowsChange}
              loading={listLoading}
              error={error ? (error as Error).message ?? "Failed to load" : null}
              columns={columns}
              getRowKey={(r) => r.id}
              getRowClassName={(r) =>
                isCancelledDocStatus(r.status) ? "dt-row-cancelled" : undefined
              }
              onRowClick={(r) => setSelected(r)}
              expandable={{
                render: (r) => <DoLinesExpansion doId={r.id} />,
                rowKey: (r) => r.id,
              }}
              selection={{
                selectedIds,
                onToggle: (id) =>
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  }),
                onToggleAll: (keys, allSelected) =>
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (allSelected) for (const k of keys) next.delete(k);
                    else for (const k of keys) next.add(k);
                    return next;
                  }),
              }}
              contextMenu={doContextMenu}
            exportName="delivery-orders"
              serverSort
              onSortChange={setSortAndReset}
              emptyLabel={
                filtersActive
                  ? "No delivery orders match — try Reset layout to clear filters."
                  : "No delivery orders yet."
              }
              search={{
                value: search,
                onChange: setSearch,
                placeholder: "Search DO no, customer, phone, driver, ref…",
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
                  placeholder="Search DO no, customer, phone, driver, ref…"
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
            {error ? (
              <ListErrorPanel message={(error as Error).message} />
            ) : searchTransition.resultsAreStale ? (
              <SearchPendingPanel label={searchTransition.statusText} />
            ) : <><CardsGrid rows={rows} onOpen={(r) => setSelected(r)} />
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
        onPrint={() => selected && printDocument(deliveryOrderPrintChain(selected).own)}
        onAdvance={() => selected && doAdvance(selected)}
        onConvertToSi={() => selected && doConvertToSi(selected)}
        canWrite={canWriteDo}
        salespersonName={
          selected ? salespersonNameOf(null, selected.salesperson_id) : "—"
        }
      />
    </PullToRefresh>
  );
}

export default MfgDeliveryOrdersListV2;
