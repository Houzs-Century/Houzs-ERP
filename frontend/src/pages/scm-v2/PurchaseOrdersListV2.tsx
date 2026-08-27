// PurchaseOrdersListV2 — Theme C redesign of the Purchase Orders listing.
// Twin of the SO/DO/SI/DR listing V2 template, but flipped for the procurement
// side of the ERP: money moves OUT to suppliers, and the star of the show is
// what's still on order + committed but not yet received.
//
// Route: /scm/purchase-orders (App.tsx flips ScmPurchaseOrdersV2 here).
// Data: usePurchaseOrders (vendored suppliers-queries slice).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { purchaseOrderRowMenu } from "./row-menus";
import { useNavigate, useSearchParams } from "react-router-dom";
import { buildVariantSummary, fmtSen, fmtDate, orderLineIdentity } from "@2990s/shared";
import { formatPhone } from "@2990s/shared/phone";
import {
  Plus,
  ChevronDown,
  Users,
  Truck,
  LayoutGrid,
  Table as TableIcon,
  X as XIcon,
  ExternalLink,
  Edit3,
  Printer,
  CheckCircle2,
  Package,
  ArrowRightLeft,
  CalendarClock,
} from "lucide-react";
import {
  PoBulkSupplierDateModal,
  type BulkSupplierDateResult,
} from "../../components/scm-v2/PoBulkSupplierDateModal";
import { PageHeader } from "../../components/Layout";
import { StatCard } from "../../components/StatCard";
import { FilterPills } from "../../components/FilterPills";
import { DataTable, type Column } from "../../components/DataTable";
import { poDisplayNumber } from "../../vendor/scm/lib/po-status";
import { warehouseLabel } from "../../vendor/scm/lib/warehouse-label";
import {
  DocumentLinesExpansion,
  AssignedSoCell,
  DeliveredCell,
  type DocumentDrillLine,
  type DrillItemFields,
} from "../../components/DocumentLinesExpansion";
import { usePoSoCoverage, originsByCode, provenanceByCode, storedLinkSkus, deliveredByCode } from "../../vendor/scm/lib/flow-queries";
import { ListPager } from "../../components/ListPager";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useVisibleRows } from "../../hooks/useVisibleRows";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { PullToRefresh } from "../../components/PullToRefresh";
import { ListErrorPanel, SearchPendingPanel, SearchProgress } from "../../components/SearchProgress";
import { SearchScopeHint } from "../../components/SearchScopeHint";
import { useDebouncedSearchTerm, useSearchResultTransition } from "../../hooks/useServerSearch";
import {
  usePurchaseOrdersPaged,
  useEnrichedPoListRows,
  usePurchaseOrderDetail,
  useCancelPurchaseOrder,
  fetchPurchaseOrderDetail,
  type PoHeaderRow,
  type PoItemRow,
} from "../../vendor/scm/lib/suppliers-queries";
import { useWarehouses } from "../../vendor/scm/lib/inventory-queries";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { useChoice } from "../../vendor/scm/components/ChoiceDialog";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "../../lib/utils";
import { convertToLink, transferToLabel, transferFromLabel } from "../../lib/convertScope";
import { isCancelledDocStatus } from "../../lib/scm";
import { ResizableDetailDrawer } from "../../components/ResizableDetailDrawer";
import { useHoldAction } from "./use-hold-action";
import { StatusWithHold, rowIsHeld } from "../../vendor/scm/components/HoldChip";
import { usePrintDocument } from "../../components/scm-v2/PrintChainProvider";
import { purchaseOrderPrintChain } from "../../lib/printChain";

// ─── Types ──────────────────────────────────────────────────────────────────

// Filter-pill buckets. Five map 1:1 onto a raw purchase_orders.status;
// "outstanding" is a ROLL-UP over open + partial (raised, not yet fully
// received) — the pill twin of the Outstanding stat card. Because it overlaps,
// the pill counts no longer sum to All; that is intended.
type StatusTab =
  | "all"
  | "outstanding"
  | "draft"
  | "open"
  | "partial"
  | "received"
  | "cancelled"
  | "on_hold";

// ─── Helpers ────────────────────────────────────────────────────────────────

const fmtRm = (centi: number): string => fmtSen(centi);

const supplierNameOf = (r: PoHeaderRow): string =>
  r.supplier?.name || r.supplier_id || "—";

const supplierCodeOf = (r: PoHeaderRow): string => r.supplier?.code || "—";

/* Items summary for the list column + Excel export (owner 2026-08-05) — the
   list embed already carries (item_code, qty) per line; render the same
   compact "CODE×qty · CODE×qty" the expansion details. */
const itemsSummaryOf = (r: PoHeaderRow): string =>
  (r.items ?? []).map((it) => `${it.item_code}×${it.qty}`).join(" · ");

/* Purchase Location display — the ONE warehouse rule, code first then name
   (vendor/scm/lib/warehouse-label.ts). This column printed the NAME first and
   the grid truncated it to "BALAKONG WAREHO…", while the same page's PDF
   export already printed the CODE — one page, two answers for one warehouse. */
const locationOf = (r: PoHeaderRow): string =>
  warehouseLabel(r.purchase_location) ?? "";

/* Supplier-SKU summary (owner 2026-08-05) — the SUPPLIER's own codes, aligned
   with the Items column line-for-line ("—" holds the slot for an unbound
   line so the two columns stay readable side by side). */
const supplierSkusOf = (r: PoHeaderRow): string =>
  (r.items ?? []).map((it) => it.supplier_sku?.trim() || "—").join(" · ");

// Committed value = total_sen (subtotal + tax); the PO's face value.
const totalOf = (r: PoHeaderRow): number =>
  r.total_sen ?? r.subtotal_sen ?? 0;

// PO lifecycle: DRAFT → SUBMITTED → PARTIALLY_RECEIVED → RECEIVED, plus
// CANCELLED. Bucket them for the pills; the raw status still surfaces in
// the row Badge.
const STATUS_TONE: Record<
  string,
  { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab }
> = {
  DRAFT:              { tone: "warning", label: "Draft",              bucket: "draft" },
  SUBMITTED:          { tone: "warning", label: "Submitted",          bucket: "open" },
  PARTIALLY_RECEIVED: { tone: "warning", label: "Partially received", bucket: "partial" },
  RECEIVED:           { tone: "success", label: "Received",           bucket: "received" },
  CANCELLED:          { tone: "error",   label: "Cancelled",          bucket: "cancelled" },
  /* ON_HOLD (mig 0318, owner 2026-08-21) — the REVERSIBLE stop the purchase
     side never had. A held PO is not receivable: grns.ts filters receivable
     POs through an allow-list, so the block needs no code here. */
  ON_HOLD:            { tone: "warning", label: "On Hold",            bucket: "on_hold" },
};

const statusFor = (
  s: string
): { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab } =>
  STATUS_TONE[(s || "").toUpperCase()] ?? {
    tone: "neutral",
    label: s || "—",
    bucket: "open",
  };

// ─── GRN No cell ────────────────────────────────────────────────────────────

/* A worker predating 2026-07-31 sends bare doc-number strings; the current one
   sends { id, grnNumber }. Normalise both, and let `id` stay null for the old
   shape — a chip with nowhere to go should not pretend to be a link. */
const grnRefsOf = (
  raw: PoHeaderRow["transfer_to_grns"]
): Array<{ id: string | null; grnNumber: string }> =>
  (raw ?? []).map((g) =>
    typeof g === "string" ? { id: null, grnNumber: g } : { id: g.id, grnNumber: g.grnNumber }
  );

/* The Goods Received doc(s) this PO was received into. Styled as the sibling of
   AssignedSoCell one column over — same chip, same one-per-line stacking — so
   the two "where did this PO go" columns read as one pair. A PO with nothing
   received yet is the normal case, not a gap: it shows a dash.

   Every GRN is listed. A partially-received PO having more than one GRN is the
   whole point of the column — 2990-PO-2606-024 has two, and showing one of them
   plus a "+1" is exactly the view that let its second receipt go unnoticed. */
function GrnNoCell({
  grns,
  onOpenGrn,
}: {
  grns: PoHeaderRow["transfer_to_grns"];
  onOpenGrn: (grnId: string) => void;
}) {
  const list = grnRefsOf(grns);
  if (list.length === 0) return <span className="text-[12px] text-ink-muted">—</span>;
  /* font-docno — IBM Plex Sans, the brand face #1445 gave the primary doc-number
     columns. Owner 2026-08-01 ruled it applies to the CHIPS too, so every
     doc-number chip in DocumentLinesExpansion (Assigned SO, Delivered, Source PO)
     moved with this one. Dates and eyebrow labels stay on font-mono. */
  const chip =
    "w-fit rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-docno text-[11px] font-semibold text-accent-ink";
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      {list.map((g) =>
        g.id ? (
          <button
            key={g.grnNumber}
            type="button"
            title={`Open ${g.grnNumber}`}
            onClick={(e) => {
              e.stopPropagation();
              onOpenGrn(g.id as string);
            }}
            className={cn(chip, "hover:border-accent hover:text-accent")}
          >
            {g.grnNumber}
          </button>
        ) : (
          <span key={g.grnNumber} className={chip}>
            {g.grnNumber}
          </span>
        ),
      )}
    </span>
  );
}

// ─── Split-menu dropdown ───────────────────────────────────────────────────

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
              onClick={() => { setOpen(false); onFromSo(); }}
            >
              New from Sales Order
            </button>
            <button
              type="button"
              className="block w-full px-3.5 py-2 text-left text-[12.5px] text-ink hover:bg-primary-soft"
              onClick={() => { setOpen(false); onImport(); }}
            >
              Import from file
            </button>
            <button
              type="button"
              className="block w-full px-3.5 py-2 text-left text-[12.5px] text-ink hover:bg-primary-soft"
              onClick={() => { setOpen(false); onDuplicate(); }}
            >
              Duplicate last PO
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

function CardsGrid({ rows, onOpen }: { rows: PoHeaderRow[]; onOpen: (r: PoHeaderRow) => void }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-16 text-center shadow-stone">
        <div className="text-[13px] font-semibold text-ink">No purchase orders</div>
        <div className="mt-1 text-[12px] text-ink-muted">
          No POs match the current filters. Try Reset layout to clear the search
          and status tabs.
        </div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {rows.map((r) => {
        const st = statusFor(r.status);
        const supplier = supplierNameOf(r);
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpen(r)}
            className="group relative overflow-hidden rounded-lg border border-border bg-surface px-4 py-4 text-left shadow-stone transition-all duration-200 hover:-translate-y-px hover:border-primary/40 hover:shadow-slab focus:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-docno text-[12.5px] font-semibold text-ink">
                {r.po_number}
              </span>
              <StatusWithHold tone={st.tone} label={st.label} row={r} />
            </div>
            <div className="mt-2 truncate text-[15px] font-semibold text-ink">
              {supplier}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-[11.5px] text-ink-muted">{fmtDate(r.po_date)}</span>
              {r.expected_at && (
                <span className="text-[11.5px] text-ink-muted">
                  · Expected {fmtDate(r.expected_at)}
                </span>
              )}
            </div>
            <div className="mt-3.5 flex items-end justify-between border-t border-border-subtle pt-3">
              <div className="min-w-0">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  Supplier
                </div>
                <div className="mt-0.5 truncate font-mono text-[12px] font-semibold text-ink-secondary">
                  {supplierCodeOf(r)}
                </div>
              </div>
              <span className="font-money text-[15px] font-bold text-ink">
                {fmtRm(totalOf(r))}
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
  onCancel,
  onConvertGrn,
}: {
  row: PoHeaderRow | null;
  onClose: () => void;
  onOpenFull: () => void;
  onEdit: () => void;
  onPrint: () => void;
  onCancel: () => void;
  onConvertGrn: () => void;
}) {
  const detailQ = usePurchaseOrderDetail(row?.id ?? null);
  const items: PoItemRow[] =
    ((detailQ.data as { items?: PoItemRow[] } | undefined)?.items ?? []);

  const open = !!row;
  const st = row ? statusFor(row.status) : null;
  const total = row ? totalOf(row) : 0;
  /* SO→PO drift (owner 2026-07-27) — surface the pending SO change in the peek
     drawer too, not only the full page. Actionable pre-receipt only. */
  const showDrift =
    row?.status === "SUBMITTED" || row?.status === "PARTIALLY_RECEIVED";
  const driftCount = showDrift ? items.filter((l) => l.so_drift).length : 0;

  return (
    <ResizableDetailDrawer
      open={open}
      onClose={onClose}
      ariaLabel={row ? `Purchase order ${row.po_number}` : "Purchase order details"}
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
                  {row.po_number}
                </div>
                <div className="mt-0.5 text-[11px] text-sidebar-ink-muted">Purchase Order</div>
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
              <div className="text-[19px] font-bold text-ink">{supplierNameOf(row)}</div>
              <div className="mt-1.5 flex items-center gap-2.5">
                <span className="font-mono text-[11.5px] text-ink-muted">
                  {supplierCodeOf(row)}
                </span>
                <span className="text-[12.5px] text-ink-muted">
                  Ordered {fmtDate(row.po_date)}
                </span>
              </div>

              <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2 px-4 py-4">
                <MetaItem k="PO date" v={fmtDate(row.po_date)} />
                <MetaItem
                  k="Expected"
                  v={row.expected_at ? fmtDate(row.expected_at) : "—"}
                />
                <MetaItem k="Currency" v={row.currency} />
                <MetaItem k="Lines" v={row.items?.length ?? "—"} />
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
                    <div className="text-[14px] font-bold text-ink">
                      {supplierNameOf(row)}
                    </div>
                    <div className="mt-0.5 font-mono text-[11.5px] text-ink-muted">
                      {supplierCodeOf(row)}
                    </div>
                  </div>
                </div>
                <RowKV k="Contact" v={row.supplier?.contact_person || "—"} />
                <RowKV k="Phone" v={formatPhone(row.supplier?.phone) || "—"} />
                <RowKV k="Email" v={row.supplier?.email || "—"} />
                <RowKV k="Address" v={row.supplier?.address || "—"} />
              </div>

              <SectionHeading>Line items</SectionHeading>
              {driftCount > 0 && (
                <div className="mb-2 rounded-lg border border-accent-bright/40 bg-accent-bright/10 px-3 py-2 text-[11.5px] text-ink">
                  ⚠ <strong>{driftCount}</strong> line{driftCount === 1 ? "'s" : "s"} source SO changed after this PO
                  was raised — see the red notes below and re-send the corrected PO.
                </div>
              )}
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="grid grid-cols-[1fr_44px_44px_44px_92px] gap-2 border-b border-border-subtle bg-surface-2 px-4 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  <span>Item</span>
                  <span className="text-right">Ord</span>
                  <span className="text-right">Rcv</span>
                  <span className="text-right">Bal</span>
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
                {items.map((l) => {
                  // #1110 (variant summary in the item cell) + #1108 (Ord/Rcv/Bal
                  // fulfillment cols) merged: a PO drawer needs both the fabric/
                  // colour line AND the received-vs-ordered progress.
                  const { primary, secondary } = orderLineIdentity({
                    code: l.item_code,
                    description: l.description || l.material_name,
                    variant:
                      buildVariantSummary(l.item_group ?? "others", l.variants ?? null) ||
                      (l.description2 ?? ""),
                  });
                  const received = Number(l.received_qty ?? 0);
                  const ordered = Number(l.qty ?? 0);
                  const balance = Math.max(0, ordered - received);
                  const fullyReceived = ordered > 0 && received >= ordered;
                  return (
                    <div
                      key={l.id}
                      className="grid grid-cols-[1fr_44px_44px_44px_92px] items-start gap-2 border-b border-border-subtle px-4 py-3 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <div className="text-[12.5px] font-medium leading-snug text-ink">
                          {primary}
                        </div>
                        {secondary && (
                          <div className="mt-0.5 text-[11.5px] leading-snug text-ink-secondary">
                            {secondary}
                          </div>
                        )}
                        {showDrift && l.so_drift && (
                          <div className="mt-1 grid gap-0.5 rounded border border-err/30 bg-err/5 px-1.5 py-1 text-[10.5px] font-semibold text-err">
                            {l.so_drift.itemChanged && (
                              <span>⚠ SO now: {l.so_drift.itemSo} (PO still: {l.so_drift.itemPo})</span>
                            )}
                            {!l.so_drift.itemChanged && l.so_drift.specSo !== l.so_drift.specPo && (
                              <span>⚠ SO spec now: {l.so_drift.specSo || "—"} (PO still: {l.so_drift.specPo || "—"})</span>
                            )}
                            {l.so_drift.warehouseChanged && <span>⚠ SO warehouse moved.</span>}
                          </div>
                        )}
                      </div>
                      <span className="text-right font-money text-[12.5px] text-ink-secondary">
                        {ordered}
                      </span>
                      <span className={cn("text-right font-money text-[12.5px] font-semibold", fullyReceived ? "text-synced" : "text-ink-secondary")}>
                        {received}
                      </span>
                      <span className={cn("text-right font-money text-[12.5px] font-semibold", balance > 0 ? "text-accent-bright" : "text-ink-muted")}>
                        {balance > 0 ? balance : "—"}
                      </span>
                      <span className="text-right font-money text-[12.5px] font-semibold text-ink">
                        {fmtRm(l.line_total_sen ?? 0)}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 rounded-lg border border-border bg-surface px-5 py-4">
                <TotalRow k="PO total" v={fmtRm(total)} strong />
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
                const s = (row.status || "").toUpperCase();
                const canCancel =
                  s === "DRAFT" || s === "SUBMITTED" || s === "PARTIALLY_RECEIVED";
                const canConvert =
                  s === "SUBMITTED" || s === "PARTIALLY_RECEIVED";
                return (
                  <>
                    {canCancel && (
                      <Button
                        variant="danger"
                        icon={<XIcon size={14} />}
                        onClick={onCancel}
                      >
                        Cancel PO
                      </Button>
                    )}
                    {canConvert && (
                      <Button
                        variant="primary"
                        icon={<CheckCircle2 size={14} />}
                        onClick={onConvertGrn}
                      >
                        {transferToLabel('grn')}
                      </Button>
                    )}
                  </>
                );
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
      <dd className={cn("mt-0.5 text-[13px] font-semibold text-ink", mono && "font-mono")}>
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

function TotalRow({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className={cn("text-[12px] text-ink-muted", strong && "text-[13px] font-semibold text-ink")}>
        {k}
      </span>
      <span className={cn("font-money text-[13px] font-semibold", strong && "text-[15px] font-bold text-ink")}>
        {v}
      </span>
    </div>
  );
}

// Table column key → backend sort-whitelist column. PO backend whitelist is
// { po_date, po_number, status, total_sen }; only `total` differs from its
// backend name. Non-whitelisted columns (supplier / expected) carry `disableSort`.
const SORT_COL_MAP: Record<string, string> = {
  total: "total_sen",
};

// ─── Row drill-down (DataTable `expandable`) ──────────────────────────────────
// Inline per-line breakdown for one PO, rendered under its parent row when the
// chevron is toggled. Lazy-fetches via the SAME usePurchaseOrderDetail hook the
// drawer uses — TanStack caches it, so expanding a row the drawer already opened
// (or re-expanding) is instant. Group + item code/variant + Qty (ordered) +
// Amount, via the shared DocumentLinesExpansion. A PO is a purchase-side doc
// with no MRP coverage on its lines, so the SO/DO-only Stock + Incoming PO
// columns are correctly absent.
function PoLinesExpansion({ id }: { id: string }) {
  const navigate = useNavigate();
  const detailQ = usePurchaseOrderDetail(id);
  const covQ = usePoSoCoverage("po", id);
  const byCode = originsByCode(covQ.data);
  // PR-3: the parallel stored-origin "bought for" slot, per SKU.
  const provByCode = provenanceByCode(covQ.data);
  const linkedSkus = storedLinkSkus(covQ.data);
  const deliveredMap = deliveredByCode(covQ.data);
  const items =
    ((detailQ.data as { items?: DrillItemFields[] } | undefined)?.items ?? []);
  const lines: DocumentDrillLine[] = items.map((l) => ({
    itemGroup: l.item_group ?? null,
    code: l.item_code ?? null,
    description: l.description || l.material_name || null,
    description2: l.description2 ?? null,
    variants: l.variants ?? null,
    qty: Number(l.qty ?? 0),
    amountSen: l.line_total_sen ?? 0,
    assignedSos: byCode.get((l.item_code ?? "").trim()) ?? [],
    sourceLinked: linkedSkus.has((l.item_code ?? "").trim()),
    provenance: provByCode.get((l.item_code ?? "").trim()) ?? [],
    deliveredDos: deliveredMap.get((l.item_code ?? "").trim()) ?? [],
  }));
  return (
    <div className="flex flex-col gap-2">
      <DocumentLinesExpansion
        isLoading={detailQ.isLoading}
        isError={Boolean(detailQ.error)}
        errorMessage={detailQ.error instanceof Error ? detailQ.error.message : null}
        lines={lines}
        emptyLabel="No lines on this purchase order."
        showAssignment
        showDelivered
        onOpenSo={(soDocNo) => navigate(`/scm/sales-orders/${encodeURIComponent(soDocNo)}`)}
        onOpenDo={(doNo) => navigate(`/scm/delivery-orders?q=${encodeURIComponent(doNo)}`)}
      />
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export function PurchaseOrdersListV2() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const notify = useNotify();
  const askChoice = useChoice();
  const askConfirm = useConfirm();
  const warehousesQ = useWarehouses({ includeInactive: true });

  const status = (params.get("status") ?? "all") as StatusTab;
  const view = (params.get("view") ?? "table") as "table" | "cards";
  const search = params.get("q") ?? "";
  const page = Math.max(0, parseInt(params.get("page") ?? "0", 10) || 0);
  const [pageSize, setPageSize] = useLocalStorage<number>("scm:perpage:purchase-orders", 50);

  const [selected, setSelected] = useState<PoHeaderRow | null>(null);
  const [sort, setSort] = useState<string | undefined>(undefined);
  // Multi-select → batch-convert N POs into one GRN. State is owned here (the
  // DataTable `selection` prop only renders the checkboxes + reports toggles).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [printingDocs, setPrintingDocs] = useState(false);
  const { requestTerm: debouncedSearch } = useDebouncedSearchTerm(search);

  // Send the active tab's BUCKET NAME as `status`; the backend resolves each
  // bucket to the raw status it covers (open→SUBMITTED, partial→PARTIALLY_RECEIVED,
  // received→RECEIVED, draft/cancelled 1:1, outstanding→SUBMITTED +
  // PARTIALLY_RECEIVED). `all` omits the filter.
  const apiStatus = status === "all" ? undefined : status;

  const { data, isLoading, isFetching, isPlaceholderData, error } = usePurchaseOrdersPaged({
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
  const cancelPo = useCancelPurchaseOrder();
  const holdAction = useHoldAction("po");

  // Server already filtered + sorted this page — render verbatim. The MRP-derived
  // columns (Assigned SO / Delivered) arrive from the deferred enrichment endpoint
  // a beat later and are merged in here, so opening the list no longer waits on a
  // company-wide computeMrp (perf/po-grn-list-mrp-off-load).
  const serverRows = (data?.purchaseOrders ?? []) as PoHeaderRow[];
  const rows = useEnrichedPoListRows(serverRows, !listLoading);
  const total = data?.total ?? 0;
  const counts = data?.statusCounts ?? {
    all: 0,
    draft: 0,
    outstanding: 0,
    open: 0,
    partial: 0,
    received: 0,
    cancelled: 0,
    on_hold: 0,
  };

  /* The rows the TABLE is actually showing — the page rows minus whatever the
     per-column funnels are hiding. This page is where the problem was found
     (owner 2026-08-12); the rationale, and why the "is a funnel active" test
     compares LENGTH rather than array identity, now live once in the hook. */
  const visible = useVisibleRows(rows);

  // Money-out KPIs sum the rows ON SCREEN (the paginated contract has no
  // full-set money sums), so the cards and the table can never disagree.
  const money = useMemo(() => {
    let committed = 0;
    let outstanding = 0;
    let received = 0;
    for (const r of visible.rows) {
      const t = totalOf(r);
      committed += t;
      const b = statusFor(r.status).bucket;
      if (b === "open" || b === "partial") outstanding += t;
      if (b === "received") received += t;
    }
    return { committed, outstanding, received };
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
    await queryClient.invalidateQueries({ queryKey: ["mfg-purchase-orders"] });
  };

  const goNewPo = () => navigate("/scm/purchase-orders/new");
  const goFromSo = () => navigate("/scm/purchase-orders/from-so");
  const goImport = () => navigate("/scm/purchase-orders?import=1");
  const goDuplicate = () => navigate("/scm/purchase-orders?duplicate=1");
  const goSuppliers = () => navigate("/scm/suppliers");
  const goGrn = () => navigate("/scm/grns");
  const goEdit = (r: PoHeaderRow) => navigate(`/scm/purchase-orders/${r.id}?edit=1`);
  const printDocument = usePrintDocument();
  const goFullPage = (r: PoHeaderRow) => navigate(`/scm/purchase-orders/${r.id}`);
  // Transfer to Goods Received routes to the reviewable From-PO picker pre-scoped to this
  // PO (?poId=<id>); the picker pre-ticks the PO's outstanding lines so the
  // operator reviews a ready draft and only Save creates the GRN.
  const goGrnFromPo = (r: PoHeaderRow) =>
    navigate(convertToLink('poToGrn', r.id));

  // ── Multi-select bulk convert ──────────────────────────────────────────────
  const toggleSelect = (id: string) =>
    setSelectedIds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
  // Batch convert → the From-PO picker accepts a comma-separated poId list and
  // pre-ticks each PO's outstanding lines (honouring its one-warehouse lock).
  const convertSelectedToGrn = () => {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    clearSelection();
    navigate(convertToLink('poToGrn', ids));
  };

  /* Batch supplier-revised date (owner 2026-08-03) — a supplier who pushes a
     date pushes it for every order in flight, so the operator picks the POs
     here and sets the slot + date once. The server skips locked / other-company
     POs per-PO, and the report below names them rather than claiming a clean
     sweep. */
  const [bulkDateOpen, setBulkDateOpen] = useState(false);
  const onBulkDateDone = async (res: BulkSupplierDateResult) => {
    await queryClient.invalidateQueries({ queryKey: ["mfg-purchase-orders"] });
    clearSelection();
    const n = res.updated.length;
    const scope = res.applyToLines ? "and every line" : "(header only)";
    const skippedNote = res.skipped.length
      ? ` ${res.skipped.length} skipped — ${res.skipped
          .map((s) => `${s.poNumber ?? s.id}: ${s.reason}`)
          .join('; ')}`
      : "";
    notify({
      title: n > 0
        ? `Supplier Date ${res.slot} set on ${n} ${n === 1 ? "PO" : "POs"}`
        : "No purchase orders were updated",
      body: `${n > 0 ? `Header ${scope} now reads ${res.date}.` : ""}${skippedNote}`.trim()
        || "Nothing matched — check the picked purchase orders.",
      tone: res.skipped.length > 0 ? "error" : "info",
    });
  };

  // Batch "Print all" — fetch each selected PO's full detail, resolve its bound
  // warehouse name (the PDF can't hit the API), then render into one combined
  // file or one file per PO. Mirrors the V1 PurchaseOrders list handler.
  const printSelectedPos = async () => {
    if (printingDocs) return;
    const chosen = rows.filter((r) => selectedIds.has(r.id));
    if (chosen.length === 0) return;
    const warehouses = warehousesQ.data ?? [];
    const toPo = (d: { purchaseOrder: PoHeaderRow; items: PoItemRow[] }) => {
      const wh = warehouses.find(
        (w) => w.id === d.purchaseOrder.purchase_location_id
      );
      return {
        header: {
          ...d.purchaseOrder,
          // Owner 2026-07-24: DELIVER TO shows the warehouse CODE only (was the
          // dual "code · name", which read as a duplicated warehouse name).
          purchase_location_name: wh ? wh.code : null,
          delivery_address: wh?.location ?? null,
          your_ref_no:
            (d.purchaseOrder as { your_ref_no?: string | null }).your_ref_no ??
            null,
          source_so_doc_no:
            (d.purchaseOrder as { source_so_doc_no?: string | null })
              .source_so_doc_no ?? null,
        },
        items: d.items,
      };
    };
    try {
      const pdf = await import("../../vendor/scm/lib/purchase-order-pdf");
      if (chosen.length === 1) {
        setPrintingDocs(true);
        const d = await queryClient.fetchQuery({
          queryKey: ["mfg-purchase-order-detail", chosen[0]!.id],
          queryFn: () => fetchPurchaseOrderDetail(chosen[0]!.id),
          staleTime: 30_000,
        });
        const po = toPo(d);
        await pdf.generatePurchaseOrderPdf(po.header as never, po.items as never);
        clearSelection();
        return;
      }
      const how = await askChoice({
        title: `Print ${chosen.length} purchase orders`,
        options: [
          { value: "one", label: "One combined PDF" },
          { value: "many", label: "Separate files", detail: "One PDF per document" },
        ],
      });
      if (how == null) return;
      setPrintingDocs(true);
      const pos: Array<{ header: unknown; items: unknown[] }> = [];
      for (const r of chosen) {
        const d = await queryClient.fetchQuery({
          queryKey: ["mfg-purchase-order-detail", r.id],
          queryFn: () => fetchPurchaseOrderDetail(r.id),
          staleTime: 30_000,
        });
        pos.push(toPo(d));
      }
      if (how === "one") {
        await pdf.generateCombinedPurchaseOrderPdf(pos as never, {
          fileName: `purchase-orders-${new Date().toISOString().slice(0, 10)}.pdf`,
        });
      } else {
        for (const po of pos)
          await pdf.generatePurchaseOrderPdf(
            po.header as never,
            po.items as never
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

  /* RECEIVABLE is the server's own allow-list (grns.ts RECEIVABLE_PO_STATUSES)
     — SUBMITTED or PARTIALLY_RECEIVED.

     THE HOLD USED TO RIDE ALONG FOR FREE AND NO LONGER DOES. This comment said
     "a held or cancelled PO is excluded by being absent from it, which is why
     ON_HOLD needed no line here", and that was true only while a hold OVERWROTE
     the status. Since mig 0324 a held PO still reads SUBMITTED, so `rowIsHeld`
     is checked explicitly — on the server too (grns.ts `isReceivablePo`), which
     is the half that actually protects the stock. */
  /* Put On Hold / Take Off Hold — the mig-0324 MARKER, never the status.
     The prompt wording and the write live in ./use-hold-action.ts. */
  const setPoHold = (r: PoHeaderRow, onHold: boolean) => holdAction(r.id, r.po_number, onHold);
  const poContextMenu = purchaseOrderRowMenu<PoHeaderRow>({
    open: goFullPage, edit: goEdit, print: printDocument,
    transferToGrn: goGrnFromPo, cancel: (r) => doCancel(r), setHold: setPoHold,
    canReceive: (r) => !rowIsHeld(r) && ["SUBMITTED", "PARTIALLY_RECEIVED"].includes(r.status.toUpperCase()),
    canCancel: (r) => !["CANCELLED", "RECEIVED"].includes(r.status.toUpperCase()),
  });
  const doCancel = async (r: PoHeaderRow) => {
    if (await askConfirm({
      title: `Cancel PO ${r.po_number}?`,
      body: "This can only be undone if no GRN has been raised.",
      confirmLabel: "Cancel PO",
      danger: true,
    })) {
      cancelPo.mutate(r.id, { onSuccess: () => setSelected(null) });
    }
  };

  const columns: Column<PoHeaderRow>[] = [
    {
      key: "po_number",
      label: "PO No.",
      // 180 + font-docno (owner 2026-07-31): 132 clipped a full doc no (see
      // the measured DO No. note in MfgDeliveryOrdersListV2). Wider than the
      // 156 used elsewhere because this cell also carries the "_R1" revision
      // suffix — "2990-PO-2607-001_R12" measures 145px, i.e. 169 with the
      // px-3 padding.
      width: "180px",
      alwaysVisible: true,
      // _R suffix (owner 2026-07-27) — a revised PO reads PO-xxx_R1 everywhere.
      getValue: (r) => poDisplayNumber(r.po_number, r.revision),
      render: (r) => (
        <span
          className={cn(
            "font-docno text-[12.5px] font-semibold text-ink",
            isCancelledDocStatus(r.status) && "dt-cancel-strike",
          )}
        >
          {poDisplayNumber(r.po_number, r.revision)}
        </span>
      ),
    },
    {
      key: "po_date",
      label: "Date",
      width: "108px",
      getValue: (r) => r.po_date,
      render: (r) => <span className="text-[12.5px] text-ink-secondary">{fmtDate(r.po_date)}</span>,
    },
    {
      // Owner 2026-07-23: supplier NAME and CODE are separate columns, not a
      // stacked cell — a purchaser filters/sorts by code, so it needs to be its
      // own field.
      key: "supplier",
      label: "Supplier",
      disableSort: true,
      getValue: (r) => supplierNameOf(r),
      render: (r) => (
        <div className="min-w-0 truncate text-[13px] font-semibold text-ink">
          {supplierNameOf(r)}
        </div>
      ),
    },
    {
      /* Owner 2026-08-05 (PO-outstanding Excel uplift) — the per-row items
         summary, so the export carries WHAT was ordered. Supplier "Code"
         column removed in the same pass ("Supplier code - 删掉"); the code
         still shows in the cards view + quick-view drawer. */
      key: "items",
      label: "Items",
      width: "240px",
      disableSort: true,
      getValue: (r) => itemsSummaryOf(r),
      render: (r) => (
        <span
          title={(r.items ?? []).map((it) => `${it.item_code} × ${it.qty}`).join("\n")}
          className="block min-w-0 truncate font-mono text-[11.5px] text-ink-secondary"
        >
          {itemsSummaryOf(r) || "—"}
        </span>
      ),
    },
    {
      /* Owner 2026-08-05 — the SUPPLIER's own SKU per line, aligned with the
         Items column ("—" holds unbound lines' slots). */
      key: "supplier_sku",
      label: "Supplier SKU",
      width: "200px",
      disableSort: true,
      getValue: (r) => supplierSkusOf(r),
      render: (r) => (
        <span
          title={(r.items ?? []).map((it) => `${it.item_code} → ${it.supplier_sku?.trim() || "—"}`).join("\n")}
          className="block min-w-0 truncate font-mono text-[11.5px] text-ink-secondary"
        >
          {supplierSkusOf(r) || "—"}
        </span>
      ),
    },
    {
      key: "expected",
      label: "Expected",
      width: "128px",
      disableSort: true,
      getValue: (r) => r.expected_at ?? "",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{fmtDate(r.expected_at)}</span>
      ),
    },
    {
      /* Owner 2026-08-05 — ship-to warehouse (list embed purchase_location). */
      key: "purchase_location",
      label: "Purchase Location",
      width: "160px",
      disableSort: true,
      getValue: (r) => locationOf(r),
      render: (r) => (
        <span className="min-w-0 truncate text-[12.5px] text-ink-secondary">
          {locationOf(r) || "—"}
        </span>
      ),
    },
    {
      /* Owner 2026-08-05 — currency unit for the Total column (export reads
         both, so a foreign-currency PO totals correctly in Excel). */
      key: "currency",
      label: "Currency",
      width: "96px",
      disableSort: true,
      getValue: (r) => r.currency ?? "MYR",
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">{r.currency ?? "MYR"}</span>
      ),
    },
    {
      // Owner 2026-07-31: the Sales Order(s) this PO's supply is assigned to, at
      // a glance. Resolved server-side (one pass, same precedence as the drill-
      // down); a dashed chip with "~" flags an MRP guess vs a stored link.
      key: "assigned_so",
      label: "Assigned SO",
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
    {
      // Owner 2026-07-31 — the RECEIPT side: which GRN(s) this PO actually
      // landed in. Server-side, deduped, cancelled GRNs excluded. Sits before
      // Delivered because that is the order the goods move: assigned to an SO,
      // received on a GRN, then shipped out on a DO.
      key: "grn_no",
      label: "GRN No",
      width: "150px",
      disableSort: true,
      getValue: (r) => grnRefsOf(r.transfer_to_grns).map((g) => g.grnNumber).join(", "),
      render: (r) => (
        <GrnNoCell
          grns={r.transfer_to_grns}
          onOpenGrn={(grnId) => navigate(`/scm/grns/${grnId}`)}
        />
      ),
    },
    {
      // Owner 2026-07-31: what has been DELIVERED against this PO — the DO(s) that
      // shipped its goods (batch_no = this PO) + qty per DO. EVERY DO renders
      // (no collapse); "—" when nothing has shipped yet.
      key: "delivered",
      label: "Delivered",
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
    {
      key: "status",
      label: "Status",
      width: "144px",
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
      key: "total",
      label: "Total",
      width: "128px",
      align: "right",
      getValue: (r) => totalOf(r),
      render: (r) => (
        <span className="font-money text-[13px] font-semibold text-ink">
          {fmtRm(totalOf(r))}
        </span>
      ),
    },
  ];

  const statusPillOptions: Array<{ value: StatusTab; label: string }> = [
    { value: "all", label: `All · ${counts.all}` },
    // Roll-up first: "what's still on order" is the working view of this page,
    // and it reads as a summary of the 1:1 pills that follow it. A worker
    // predating the bucket omits the key — open + partial IS the same number
    // off the same server-side aggregate, so derive rather than show nothing.
    {
      value: "outstanding",
      label: `Outstanding · ${counts.outstanding ?? counts.open + counts.partial}`,
    },
    { value: "draft", label: `Draft · ${counts.draft}` },
    { value: "open", label: `Submitted · ${counts.open}` },
    { value: "partial", label: `Partial · ${counts.partial}` },
    { value: "received", label: `Received · ${counts.received}` },
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
        {/* Mobile-only compact header */}
        <div className="mb-3 flex items-start justify-between gap-3 md:hidden">
          <div className="min-w-0">
            <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">
              Purchase Orders
            </h1>
            <div className="mt-0.5 text-[12.5px] text-ink-muted">
              {total} PO{total === 1 ? "" : "s"} · {fmtRm(money.committed)} committed
            </div>
          </div>
        </div>

        {/* Desktop chrome */}
        <div className="hidden md:block">
          <PageHeader
            eyebrow="Procurement"
            eyebrowMeta={`${total.toLocaleString("en-MY")} orders`}
            title="Purchase Orders"
            description="Every PO raised to a supplier — Draft through Received. Click any row for the quick view; open the full page to edit or receive."
            primaryAction={
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
                    onClick={goNewPo}
                    className="rounded-r-none"
                  >
                    New Purchase Order
                  </Button>
                  <SplitDropdown onFromSo={goFromSo} onImport={goImport} onDuplicate={goDuplicate} />
                </div>
              </div>
            }
            secondaryActions={[
              { label: "Suppliers", icon: Users, onClick: goSuppliers },
              { label: "Goods Received", icon: Package, onClick: goGrn },
            ]}
          />
        </div>

        {/* Stat strip */}
        <div className="mb-5 hidden grid-cols-2 gap-3 md:grid lg:grid-cols-4">
          {/* Owner 2026-08-12 — every tile now describes the rows ON SCREEN, and
              says so when a column funnel is narrowing them. The count tile is
              the one that has to switch source: `total` is the server's full
              match count and is right until a client-side funnel hides part of
              the page, at which point it contradicts the table underneath. */}
          <StatCard
            pending={statsPending}
            label="Total POs"
            value={(visible.filtered ? visible.rows.length : total).toLocaleString("en-MY")}
            subtitle={visible.filtered ? "Filtered · shown below" : "All matching POs"}
            rail="bg-primary"
            active
          />
          <StatCard
            pending={statsPending}
            label="Committed"
            value={fmtRm(money.committed)}
            subtitle={visible.filtered ? "Filtered · sum shown below" : "Sum on this page"}
            rail="bg-accent"
          />
          <StatCard
            pending={statsPending}
            label="Outstanding"
            value={fmtRm(money.outstanding)}
            subtitle={
              visible.filtered
                ? "Submitted + partial · filtered"
                : "Submitted + partial · on this page"
            }
            tone="warning"
            rail="bg-accent-bright"
          />
          <StatCard
            pending={statsPending}
            label="Received"
            value={fmtRm(money.received)}
            subtitle={
              visible.filtered ? "Fully received · filtered" : "Fully received · on this page"
            }
            tone="success"
            rail="bg-synced"
          />
        </div>

        {/* Mobile sticky search */}
        <div className="sticky top-0 z-10 -mx-4 mb-3 bg-bg/95 px-4 py-2 backdrop-blur-sm md:hidden">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search PO no or notes…"
            className="h-10 w-full rounded-lg border border-border bg-surface px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          <SearchProgress active={searchTransition.isSearching} label={searchTransition.statusText} className="mt-1.5" />
          <SearchScopeHint scope="server" searching={searchTransition.isSearching} countPending={isLoading || isPlaceholderData || Boolean(error) || searchTransition.resultsAreStale} resultCount={total} term={search} className="mt-1" />
        </div>

        {/* Filter row */}
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

        {/* Phone → Cards */}
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

        {/* Desktop → Table / Cards */}
        <div className="hidden md:block">
          {view === "table" ? (
            <>
              {selectedIds.size > 0 && !searchTransition.resultsAreStale && (
                <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/10 px-4 py-2.5">
                  <span className="text-[13px] font-semibold text-primary">
                    {selectedIds.size} selected
                  </span>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" onClick={clearSelection}>
                      Clear
                    </Button>
                    <Button
                      variant="secondary"
                      icon={<CalendarClock size={14} />}
                      onClick={() => setBulkDateOpen(true)}
                    >
                      Supplier date ({selectedIds.size})
                    </Button>
                    <Button
                      variant="secondary"
                      icon={<Printer size={14} />}
                      disabled={printingDocs}
                      onClick={() => void printSelectedPos()}
                    >
                      {printingDocs
                        ? "Printing…"
                        : `Print all (${selectedIds.size})`}
                    </Button>
                    <Button
                      variant="primary"
                      icon={<Package size={14} />}
                      onClick={convertSelectedToGrn}
                    >
                      To Goods Receipt ({selectedIds.size})
                    </Button>
                  </div>
                </div>
              )}
              <DataTable<PoHeaderRow>
                tableId="purchase-orders-v2"
                rows={rows}
                /* Feeds the stat strip so the tiles describe what is on screen
                   rather than what the server matched (owner 2026-08-12). */
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
                  render: (r) => <PoLinesExpansion id={r.id} />,
                  rowKey: (r) => r.id,
                }}
                selection={{
                  selectedIds,
                  onToggle: toggleSelect,
                  onToggleAll: toggleSelectAll,
                }}
                contextMenu={poContextMenu}
            exportName="purchase-orders"
                serverSort
                onSortChange={setSortAndReset}
                emptyLabel={
                  filtersActive
                    ? "No purchase orders match — try Reset layout to clear filters."
                    : "No purchase orders yet."
                }
                search={{
                  value: search,
                  onChange: setSearch,
                  placeholder: "Search PO no or notes…",
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
                    placeholder="Search PO no or notes…"
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
        onPrint={() => selected && printDocument(purchaseOrderPrintChain(selected).own)}
        onCancel={() => selected && doCancel(selected)}
        onConvertGrn={() => selected && goGrnFromPo(selected)}
      />

      <PoBulkSupplierDateModal
        open={bulkDateOpen}
        poIds={[...selectedIds]}
        onClose={() => setBulkDateOpen(false)}
        onDone={(res) => void onBulkDateDone(res)}
      />
    </PullToRefresh>
  );
}

export default PurchaseOrdersListV2;
