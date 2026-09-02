// GoodsReceivedListV2 — Theme C redesign of the GRN listing. Stock-in doc:
// goods land at a warehouse, PO's received_qty rolls up. Not a money doc,
// so the framing is stock-in (received value + line count) rather than
// outstanding/owed.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { grnRowMenu } from "./row-menus";
import { buildVariantSummary, fmtSen, fmtDate, orderLineIdentity } from "@2990s/shared";
import { formatPhone } from "@2990s/shared/phone";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Plus,
  ChevronDown,
  Users,
  ClipboardList,
  LayoutGrid,
  Table as TableIcon,
  X as XIcon,
  ExternalLink,
  Edit3,
  Printer,
  CheckCircle2,
  Receipt,
  RotateCcw,
  Send,
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
  AssignedSoCell,
  DeliveredCell,
  type DocumentDrillLine,
  type DrillItemFields,
} from "../../components/DocumentLinesExpansion";
import { coverageStateOf } from "../../components/coverage-state";
import { usePoSoCoverage, originsByCode, provenanceByCode, storedLinkSkus, deliveredByCode, type OriginAssignment } from "../../vendor/scm/lib/flow-queries";
import { ListPager } from "../../components/ListPager";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { PullToRefresh } from "../../components/PullToRefresh";
import { ListErrorPanel, SearchPendingPanel, SearchProgress } from "../../components/SearchProgress";
import { SearchScopeHint } from "../../components/SearchScopeHint";
import { useDebouncedSearchTerm, useSearchResultTransition } from "../../hooks/useServerSearch";
import {
  useGrnsPaged,
  useEnrichedGrnListRows,
  useGrnDetail,
  usePostGrn,
  useCancelGrn,
} from "../../vendor/scm/lib/grn-queries";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { useChoice } from "../../vendor/scm/components/ChoiceDialog";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "../../lib/utils";
import { convertToLink, transferToLabel, transferFromLabel, transferFromColumnLabel } from "../../lib/convertScope";
import { isCancelledDocStatus } from "../../lib/scm";
import { ResizableDetailDrawer } from "../../components/ResizableDetailDrawer";
import { useHoldAction } from "./use-hold-action";
import { StatusWithHold, rowIsHeld, type HoldFields } from "../../vendor/scm/components/HoldChip";
import { usePrintDocument } from "../../components/scm-v2/PrintChainProvider";
import { grnPrintChain } from "../../lib/printChain";

type GrnRow = HoldFields & {
  id: string;
  grn_number: string;
  status: string;
  received_at: string | null;
  delivery_note_ref: string | null;
  total_sen?: number;
  currency?: string;
  notes?: string | null;
  supplier?: { id: string; code: string; name: string; contact_person?: string | null; phone?: string | null; email?: string | null; address?: string | null } | null;
  purchase_order?: { id: string; po_number: string } | null;
  fully_invoiced?: boolean;
  fully_returned?: boolean;
  line_count?: number;
  /** Collapsed "Assigned SO" column (owner 2026-07-31) — inherited from the
      parent PO's coverage, resolved server-side for the whole page. */
  assigned_sos?: OriginAssignment[];
  assigned_so_linked?: boolean;
  /** PR-3 (2026-08-07) — the parallel stored-origin "bought for" SO(s),
      rendered muted beside the precedence chips. Optional: older backend. */
  assigned_so_provenance?: OriginAssignment[];
  /** "Delivered" column (owner 2026-07-31) — the DO(s) that shipped the parent
      PO's goods + qty per DO. EVERY DO renders; empty when nothing shipped. */
  delivered_dos?: Array<{ doNo: string; qty: number }>;
};

type GrnItem = {
  id: string;
  item_code?: string | null;
  description?: string | null;
  description2?: string | null;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
  uom?: string;
  qty?: number;
  received_qty?: number;
  unit_price_sen?: number;
  line_total_sen?: number;
  warehouse_code?: string | null;
};

type StatusTab = "all" | "draft" | "posted" | "cancelled" | "on_hold";

const fmtRm = (centi: number): string => fmtSen(centi);

const supplierNameOf = (r: GrnRow): string => r.supplier?.name || "—";
const supplierCodeOf = (r: GrnRow): string => r.supplier?.code || "—";
const poOf = (r: GrnRow): string => r.purchase_order?.po_number || "—";
const totalOf = (r: GrnRow): number => r.total_sen ?? 0;

// grns.status → filter bucket. Must match GRN_STATUS_BUCKETS server-side
// (backend/src/scm/routes/grns.ts), which is what the tab COUNTS are computed
// from — a row bucketed differently here is shown in one tab and counted in
// another. CLOSED is spelled out rather than left to the fallback below: it is
// a real enum member (grn_status = DRAFT / POSTED / CLOSED / CANCELLED) and it
// files under `posted` because its stock IN stands — only CANCELLED had its
// receipt reversed.
const STATUS_TONE: Record<string, { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab }> = {
  DRAFT:     { tone: "warning", label: "Draft",     bucket: "draft" },
  POSTED:    { tone: "success", label: "Confirmed", bucket: "posted" },
  CLOSED:    { tone: "neutral", label: "Closed",    bucket: "posted" },
  CANCELLED: { tone: "error",   label: "Cancelled", bucket: "cancelled" },
  /* ON_HOLD (mig 0319) — a paperwork pause, NOT a stock event: the inventory
     IN fired at POSTED and a hold moves nothing. A held GRN cannot be
     invoiced, because the billable-GRN read is .eq(status, POSTED). */
  ON_HOLD:   { tone: "warning", label: "On Hold",   bucket: "on_hold" },
};

const statusFor = (s: string) =>
  STATUS_TONE[(s || "").toUpperCase()] ?? { tone: "neutral" as const, label: s || "—", bucket: "posted" as StatusTab };

function ViewToggle({ value, onChange }: { value: "table" | "cards"; onChange: (v: "table" | "cards") => void }) {
  const btn = (which: "table" | "cards", label: string, Icon: typeof TableIcon) => {
    const active = value === which;
    return (
      <button
        type="button"
        onClick={() => onChange(which)}
        aria-pressed={active}
        className={cn(
          "inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors",
          active ? "bg-primary text-white shadow-sm" : "text-ink-secondary hover:bg-primary-soft hover:text-primary"
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

function SplitDropdown({ onFromPo }: { onFromPo: () => void }) {
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
            <button type="button" className="block w-full px-3.5 py-2 text-left text-[12.5px] text-ink hover:bg-primary-soft" onClick={() => { setOpen(false); onFromPo(); }}>
              New from Purchase Order
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function CardsGrid({ rows, onOpen }: { rows: GrnRow[]; onOpen: (r: GrnRow) => void }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-16 text-center shadow-stone">
        <div className="text-[13px] font-semibold text-ink">No goods received notes</div>
        <div className="mt-1 text-[12px] text-ink-muted">
          No GRNs match the current filters. Try Reset layout to clear the search and status tabs.
        </div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {rows.map((r) => {
        const st = statusFor(r.status);
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpen(r)}
            className="group relative overflow-hidden rounded-lg border border-border bg-surface px-4 py-4 text-left shadow-stone transition-all duration-200 hover:-translate-y-px hover:border-primary/40 hover:shadow-slab focus:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-docno text-[12.5px] font-semibold text-ink">{r.grn_number}</span>
              <StatusWithHold tone={st.tone} label={st.label} row={r} />
            </div>
            <div className="mt-2 truncate text-[15px] font-semibold text-ink">{supplierNameOf(r)}</div>
            {/* Owner 2026-07-23: supplier code on its own line. */}
            <div className="truncate font-mono text-[11px] text-ink-muted">{supplierCodeOf(r)}</div>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-[11.5px] text-ink-muted">{fmtDate(r.received_at)}</span>
              {r.delivery_note_ref && (
                <span className="text-[11.5px] text-ink-muted">· DN {r.delivery_note_ref}</span>
              )}
            </div>
            <div className="mt-3.5 flex items-end justify-between border-t border-border-subtle pt-3">
              <div className="min-w-0">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{transferFromColumnLabel('po')}</div>
                <div className="mt-0.5 truncate font-mono text-[12px] font-semibold text-ink-secondary">{poOf(r)}</div>
              </div>
              <span className="font-money text-[15px] font-bold text-ink">{fmtRm(totalOf(r))}</span>
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
  onPost,
  onCancel,
  onConvertToPi,
  onConvertToPr,
}: {
  row: GrnRow | null;
  onClose: () => void;
  onOpenFull: () => void;
  onEdit: () => void;
  onPrint: () => void;
  onPost: () => void;
  onCancel: () => void;
  onConvertToPi: () => void;
  onConvertToPr: () => void;
}) {
  const detailQ = useGrnDetail(row?.id ?? null);
  const items: GrnItem[] = ((detailQ.data as { items?: GrnItem[] } | undefined)?.items ?? []);
  const open = !!row;
  const st = row ? statusFor(row.status) : null;
  const total = row ? totalOf(row) : 0;

  return (
    <ResizableDetailDrawer
      open={open}
      onClose={onClose}
      ariaLabel={row ? `GRN ${row.grn_number}` : "GRN details"}
    >
        {row && st && (
          <>
            <div className="flex h-[60px] shrink-0 items-center gap-3 bg-sidebar px-5 text-sidebar-ink">
              <button type="button" onClick={onClose} className="text-sidebar-ink-muted hover:text-sidebar-ink" aria-label="Close details">
                <XIcon size={18} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[14px] font-bold tracking-wide">{row.grn_number}</div>
                <div className="mt-0.5 text-[11px] text-sidebar-ink-muted">Goods Received Note</div>
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
                <span className="text-[12.5px] text-ink-muted">Received {fmtDate(row.received_at)}</span>
              </div>

              <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2 px-4 py-4">
                <MetaItem k={transferFromColumnLabel('po')} v={poOf(row)} mono />
                <MetaItem k="Received at" v={fmtDate(row.received_at)} />
                <MetaItem k="Delivery note" v={row.delivery_note_ref || "—"} mono={!!row.delivery_note_ref} />
                <MetaItem k="Currency" v={row.currency || "MYR"} />
              </dl>

              <SectionHeading>Supplier</SectionHeading>
              <div className="overflow-hidden rounded-lg border border-border bg-surface">
                <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3.5">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[13px] font-bold text-accent-ink">
                    {(supplierNameOf(row) || "S")
                      .split(/\s+/).filter(Boolean).slice(0, 2)
                      .map((w) => w[0]?.toUpperCase()).join("") || "S"}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[14px] font-bold text-ink">{supplierNameOf(row)}</div>
                    <div className="mt-0.5 font-mono text-[11.5px] text-ink-muted">{supplierCodeOf(row)}</div>
                  </div>
                </div>
                <RowKV k="Contact" v={row.supplier?.contact_person || "—"} />
                <RowKV k="Phone" v={formatPhone(row.supplier?.phone) || "—"} />
                <RowKV k="Email" v={row.supplier?.email || "—"} />
                <RowKV k="Address" v={row.supplier?.address || "—"} />
              </div>

              <SectionHeading>Line items</SectionHeading>
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="grid grid-cols-[1fr_52px_82px_92px] gap-2 border-b border-border-subtle bg-surface-2 px-4 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  <span>Item</span>
                  <span className="text-right">Qty</span>
                  <span className="text-right">Unit</span>
                  <span className="text-right">Received value</span>
                </div>
                {detailQ.isLoading && <div className="px-4 py-8 text-center text-[12px] text-ink-muted">Loading lines…</div>}
                {!detailQ.isLoading && items.length === 0 && <div className="px-4 py-8 text-center text-[12px] text-ink-muted">No lines</div>}
                {items.map((l, i) => {
                  const { primary, secondary } = orderLineIdentity({
                    code: l.item_code || l.item_code,
                    description: l.description,
                    variant:
                      buildVariantSummary(l.item_group ?? "others", l.variants ?? null) ||
                      (l.description2 ?? ""),
                  });
                  return (
                  <div key={l.id ?? i} className="grid grid-cols-[1fr_52px_82px_92px] items-start gap-2 border-b border-border-subtle px-4 py-3 last:border-b-0">
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
                    <span className="text-right font-money text-[12.5px] text-ink-secondary">{l.received_qty ?? l.qty ?? 0}</span>
                    <span className="text-right font-money text-[12.5px] text-ink-secondary">{fmtRm(l.unit_price_sen ?? 0)}</span>
                    <span className="text-right font-money text-[12.5px] font-semibold text-ink">{fmtRm(l.line_total_sen ?? 0)}</span>
                  </div>
                  );
                })}
              </div>

              <div className="mt-4 rounded-lg border border-border bg-surface px-5 py-4">
                <TotalRow k="Received value" v={fmtRm(total)} strong />
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-5 py-3">
              <Button variant="ghost" icon={<Edit3 size={14} />} onClick={onEdit}>Edit</Button>
              <Button variant="ghost" icon={<Printer size={14} />} onClick={onPrint}>Print</Button>
              <div className="flex-1" />
              {(() => {
                const s = (row.status || "").toUpperCase();
                if (s === "DRAFT") {
                  return (
                    <Button variant="primary" icon={<Send size={14} />} onClick={onPost}>
                      Post
                    </Button>
                  );
                }
                if (s === "POSTED") {
                  if (!row.fully_invoiced) {
                    return (
                      <Button variant="primary" icon={<Receipt size={14} />} onClick={onConvertToPi}>
                        {transferToLabel('pi')}
                      </Button>
                    );
                  }
                  if (!row.fully_returned) {
                    return (
                      <Button variant="secondary" icon={<RotateCcw size={14} />} onClick={onConvertToPr}>
                        {transferToLabel('pr')}
                      </Button>
                    );
                  }
                }
                if (s !== "CANCELLED") {
                  return (
                    <Button variant="danger" icon={<XIcon size={14} />} onClick={onCancel}>
                      Cancel
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
      <dt className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{k}</dt>
      <dd className={cn("mt-0.5 text-[13px] font-semibold text-ink", mono && "font-mono")}>{v}</dd>
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <div className="mb-2.5 mt-6 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{children}</div>;
}

function RowKV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-border-subtle px-4 py-2.5 last:border-b-0">
      <span className="w-20 shrink-0 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{k}</span>
      <span className="flex-1 text-[13px] font-semibold leading-relaxed text-ink">{v}</span>
    </div>
  );
}

function TotalRow({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className={cn("text-[12px] text-ink-muted", strong && "text-[13px] font-semibold text-ink")}>{k}</span>
      <span className={cn("font-money text-[13px] font-semibold", strong && "text-[15px] font-bold text-ink")}>{v}</span>
    </div>
  );
}

// Table column key → backend sort-whitelist column. GRN backend whitelist is
// { received_at, grn_number, status, total_sen }; only `total` differs from
// its backend name. Non-whitelisted columns carry `disableSort`.
const SORT_COL_MAP: Record<string, string> = {
  total: "total_sen",
};

// ─── Row drill-down (DataTable `expandable`) ──────────────────────────────────
// Inline per-line breakdown for one GRN, lazy-fetched via the SAME useGrnDetail
// hook the drawer uses (TanStack-cached, so re-expanding is instant). Group +
// item code/variant + Qty (received) + Amount (received value), via the shared
// DocumentLinesExpansion. A GRN is a warehouse-receipt doc with no MRP coverage
// on its lines, so the SO/DO-only Stock + Incoming PO columns are absent.
function GrnLinesExpansion({ id }: { id: string }) {
  const navigate = useNavigate();
  const detailQ = useGrnDetail(id);
  const covQ = usePoSoCoverage("grn", id);
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
      qty: Number(l.received_qty ?? l.qty ?? 0),
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
        emptyLabel="No lines on this goods receipt."
        showAssignment
        showDelivered
        onOpenSo={(soDocNo) => navigate(`/scm/sales-orders/${encodeURIComponent(soDocNo)}`)}
        onOpenDo={(doNo) => navigate(`/scm/delivery-orders?q=${encodeURIComponent(doNo)}`)}
      />
    </div>
  );
}

export function GoodsReceivedListV2() {
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
  const [pageSize, setPageSize] = useLocalStorage<number>("scm:perpage:grns", 50);

  const [selected, setSelected] = useState<GrnRow | null>(null);
  const [sort, setSort] = useState<string | undefined>(undefined);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [printingDocs, setPrintingDocs] = useState(false);
  const { requestTerm: debouncedSearch } = useDebouncedSearchTerm(search);

  // Send the active tab's BUCKET NAME as `status`; the backend resolves it to
  // the raw statuses it covers (draft/posted/cancelled are 1:1). `all` omits it.
  const apiStatus = status === "all" ? undefined : status;

  const { data, isLoading, isFetching, isPlaceholderData, error } = useGrnsPaged({
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
  const postGrn = usePostGrn();
  const cancelGrn = useCancelGrn();
  const holdAction = useHoldAction("grn");

  // Server already filtered + sorted this page — render verbatim. The MRP-derived
  // columns (Assigned SO / Delivered) arrive from the deferred enrichment endpoint
  // a beat later and are merged in here, so opening the list no longer waits on a
  // company-wide computeMrp (perf/po-grn-list-mrp-off-load).
  const serverRows = (data?.grns ?? []) as GrnRow[];
  const rows = useEnrichedGrnListRows(serverRows, !listLoading);
  const total = data?.total ?? 0;
  const counts = data?.statusCounts ?? { all: 0, draft: 0, posted: 0, cancelled: 0, on_hold: 0 };

  // Money KPIs are summed over the CURRENT page only (paginated contract has no
  // full-set money sums), so their cards are labelled "on this page".
  const money = useMemo(() => {
    let received = 0;
    let draft = 0;
    let awaitingPi = 0;
    for (const r of rows) {
      received += totalOf(r);
      const b = statusFor(r.status).bucket;
      if (b === "draft") draft += totalOf(r);
      if (b === "posted" && !r.fully_invoiced) awaitingPi += totalOf(r);
    }
    return { received, draft, awaitingPi };
  }, [rows]);

  const setPageParam = (p: number) => {
    const next = new URLSearchParams(params);
    if (p <= 0) next.delete("page"); else next.set("page", String(p));
    setParams(next, { replace: true });
  };
  const setStatusChip = (s: StatusTab) => {
    const next = new URLSearchParams(params);
    if (s === "all") next.delete("status"); else next.set("status", s);
    next.delete("page");
    setParams(next, { replace: true });
  };
  const setView = (v: "table" | "cards") => {
    const next = new URLSearchParams(params);
    if (v === "table") next.delete("view"); else next.set("view", v);
    setParams(next, { replace: true });
  };
  const setSearch = (q: string) => {
    const next = new URLSearchParams(params);
    if (!q.trim()) next.delete("q"); else next.set("q", q);
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
  const filtersActive = status !== "all" || view !== "table" || search.trim().length > 0;

  const onPullToRefresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["grns"] });
  };

  const goNewGrn = () => navigate("/scm/grns/new");
  const goFromPo = () => navigate("/scm/grns/from-po");
  const goPos = () => navigate("/scm/purchase-orders");
  const goSuppliers = () => navigate("/scm/suppliers");
  const goEdit = (r: GrnRow) => navigate(`/scm/grns/${r.id}?edit=1`);
  const printDocument = usePrintDocument();
  const goFullPage = (r: GrnRow) => navigate(`/scm/grns/${r.id}`);
  const goConvertToPi = (r: GrnRow) => navigate(convertToLink('grnToPi', r.id));
  const goConvertToPr = (r: GrnRow) => navigate(convertToLink('grnToPr', r.id));

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

  // One GRN's full detail for the PDF generator, via the vendored authedFetch
  // (→ /api/scm); same endpoint + shape as the single-row detail page.
  const fetchGrnBundle = async (
    row: GrnRow
  ): Promise<{ header: unknown; items: unknown[] }> => {
    const json = await authedFetch<{ grn: unknown; items: unknown[] }>(
      `/grns/${row.id}`
    );
    return { header: json.grn, items: json.items };
  };

  // Batch "Print all" — one ticked GRN downloads straight; several prompt
  // combined-vs-separate, then render into one merged file or one per GRN.
  const deliverSelectedGrns = async (action: PdfAction) => {
    if (printingDocs) return;
    const chosen = rows.filter((r) => selectedIds.has(r.id));
    if (chosen.length === 0) return;
    try {
      const { generateGrnPdf, generateCombinedGrnPdf } = await import(
        "../../vendor/scm/lib/grn-pdf"
      );
      if (chosen.length === 1) {
        setPrintingDocs(true);
        const b = await fetchGrnBundle(chosen[0]!);
        await generateGrnPdf(b.header as never, b.items as never, { action });
        clearSelection();
        return;
      }
      /* View / Print always render ONE document — a preview or a print run
         is about the stack, not N separate files. Only the download exit
         still asks combined-vs-separate. */
      const how = action !== "save" ? "one" : await askChoice({
        title: `Print ${chosen.length} goods-received notes`,
        options: [
          { value: "one", label: "One combined PDF" },
          { value: "many", label: "Separate files", detail: "One PDF per document" },
        ],
      });
      if (how == null) return;
      setPrintingDocs(true);
      const bundles: Array<{ header: unknown; items: unknown[] }> = [];
      for (const r of chosen) bundles.push(await fetchGrnBundle(r));
      if (how === "one") {
        await generateCombinedGrnPdf(bundles as never, {
          fileName: `goods-received-${new Date().toISOString().slice(0, 10)}.pdf`,
          action,
        });
      } else {
        for (const b of bundles)
          await generateGrnPdf(b.header as never, b.items as never, { action });
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
  const batchPrint = usePrintPreview(deliverSelectedGrns);

  /* POSTED is the only billable state (the billable-GRN read is
     .eq(status, POSTED)).

     THE HOLD USED TO RIDE ALONG FOR FREE AND NO LONGER DOES. Since mig 0324 a
     held GRN still reads POSTED, so the marker is checked explicitly — and on
     the server too (purchase-invoices.ts), which is the half that decides
     whether a supplier actually gets billed. */
  /* Put On Hold / Take Off Hold — the mig-0324 MARKER, never the status.
     The prompt wording and the write live in ./use-hold-action.ts. */
  const setGrnHold = (r: GrnRow, onHold: boolean) => holdAction(r.id, r.grn_number, onHold);
  const grnContextMenu = grnRowMenu<GrnRow>({
    open: goFullPage, edit: goEdit, print: printDocument,
    transferToPi: goConvertToPi, transferToPr: goConvertToPr,
    post: (r) => doPost(r), cancel: (r) => doCancel(r), setHold: setGrnHold,
    canBill: (r) => !rowIsHeld(r) && r.status.toUpperCase() === "POSTED",
    canPost: (r) => r.status.toUpperCase() === "DRAFT",
    canCancel: (r) => r.status.toUpperCase() !== "CANCELLED",
  });
  const doPost = async (r: GrnRow) => {
    if (await askConfirm({
      title: `Post GRN ${r.grn_number}?`,
      body: "Inventory will be received into the warehouse.",
      confirmLabel: "Post GRN",
    })) {
      postGrn.mutate(r.id, { onSuccess: () => setSelected(null) });
    }
  };
  const doCancel = async (r: GrnRow) => {
    if (await askConfirm({
      title: `Cancel GRN ${r.grn_number}?`,
      body: "Inventory receipt will be reversed.",
      confirmLabel: "Cancel GRN",
      danger: true,
    })) {
      cancelGrn.mutate(r.id, { onSuccess: () => setSelected(null) });
    }
  };

  const columns: Column<GrnRow>[] = [
    {
      key: "grn_number",
      label: "GRN No.",
      // 166 + font-docno (owner 2026-07-31): a GRN no is one char longer than
      // the DO/SO shape ("2990-GRN-2607-0001" = 131.5px, i.e. 155.5 with the
      // px-3 padding), so 140 clipped it — see the
      // measured DO No. note in MfgDeliveryOrdersListV2.
      width: "166px",
      alwaysVisible: true,
      getValue: (r) => r.grn_number,
      render: (r) => (
        <span
          className={cn(
            "font-docno text-[12.5px] font-semibold text-ink",
            isCancelledDocStatus(r.status) && "dt-cancel-strike",
          )}
        >
          {r.grn_number}
        </span>
      ),
    },
    {
      key: "received_at",
      label: "Received",
      width: "108px",
      getValue: (r) => r.received_at ?? "",
      render: (r) => <span className="text-[12.5px] text-ink-secondary">{fmtDate(r.received_at)}</span>,
    },
    {
      key: "po",
      label: transferFromColumnLabel('po'),
      width: "128px",
      disableSort: true,
      getValue: (r) => poOf(r),
      render: (r) => <span className="font-mono text-[12px] text-ink-secondary">{poOf(r)}</span>,
    },
    {
      // Owner 2026-07-31: the Sales Order(s) the parent PO's supply is assigned
      // to, inherited onto the GRN. Server-resolved (one pass, same precedence
      // as the drill-down); dashed "~" chip flags an MRP guess vs a stored link.
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
      // Owner 2026-07-31: what has been DELIVERED against this GRN's parent PO —
      // the DO(s) that shipped its goods + qty. EVERY DO renders (no collapse).
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
      // Owner 2026-07-24: supplier NAME and CODE are separate columns on every
      // procurement table, not a stacked cell — code must be scannable on its
      // own (same split as the PO list, 2026-07-23).
      key: "supplier",
      label: "Supplier",
      disableSort: true,
      getValue: (r) => supplierNameOf(r),
      render: (r) => (
        <div className="min-w-0 truncate text-[13px] font-semibold text-ink">{supplierNameOf(r)}</div>
      ),
    },
    {
      key: "supplier_code",
      label: "Code",
      width: "108px",
      disableSort: true,
      getValue: (r) => supplierCodeOf(r),
      render: (r) => (
        <span className="font-mono text-[11.5px] text-ink-secondary">{supplierCodeOf(r)}</span>
      ),
    },
    {
      key: "dn",
      label: "Delivery note",
      width: "128px",
      disableSort: true,
      getValue: (r) => r.delivery_note_ref ?? "",
      render: (r) => <span className="font-mono text-[12px] text-ink-secondary">{r.delivery_note_ref || "—"}</span>,
    },
    {
      key: "status",
      label: "Status",
      width: "120px",
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
      label: "Value",
      width: "128px",
      align: "right",
      getValue: (r) => totalOf(r),
      render: (r) => <span className="font-money text-[13px] font-semibold text-ink">{fmtRm(totalOf(r))}</span>,
    },
  ];

  const statusPillOptions: Array<{ value: StatusTab; label: string }> = [
    { value: "all", label: `All · ${counts.all}` },
    { value: "draft", label: `Draft · ${counts.draft}` },
    { value: "posted", label: `Confirmed · ${counts.posted}` },
    { value: "cancelled", label: `Cancelled · ${counts.cancelled}` },
    { value: "on_hold", label: `On Hold · ${counts.on_hold ?? 0}` },
  ];

  return (
    <PullToRefresh onRefresh={onPullToRefresh}>
      <div className={cn("transition-[padding] duration-200", selected ? "md:pr-[540px]" : "")}>
        <div className="mb-3 flex items-start justify-between gap-3 md:hidden">
          <div className="min-w-0">
            <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">Goods Received</h1>
            <div className="mt-0.5 text-[12.5px] text-ink-muted">
              {total} GRN{total === 1 ? "" : "s"} · {fmtRm(money.received)}
            </div>
          </div>
        </div>

        <div className="hidden md:block">
          <PageHeader
            eyebrow="Procurement"
            title="Goods Received"
            description="Every GRN raised on incoming supplier shipments — Draft through Posted. Click any row for the quick view."
            primaryAction={
              <div className="flex items-stretch gap-2">
                <Button variant="secondary" icon={<ArrowRightLeft size={14} />} onClick={goFromPo}>
                  {transferFromLabel('po')}
                </Button>
                <div className="flex items-stretch">
                  <Button variant="primary" icon={<Plus size={14} />} onClick={goNewGrn} className="rounded-r-none">
                    New GRN
                  </Button>
                  <SplitDropdown onFromPo={goFromPo} />
                </div>
              </div>
            }
            secondaryActions={[
              { label: "Purchase Orders", icon: ClipboardList, onClick: goPos },
              { label: "Suppliers", icon: Users, onClick: goSuppliers },
            ]}
          />
        </div>

        <div className="mb-5 hidden grid-cols-2 gap-3 md:grid lg:grid-cols-4">
          <StatCard pending={statsPending} label="Total GRNs" value={total.toLocaleString("en-MY")} subtitle="All matching GRNs" rail="bg-primary" active />
          <StatCard pending={statsPending} label="Received Value" value={fmtRm(money.received)} subtitle="Value on this page" tone="success" rail="bg-synced" />
          <StatCard pending={statsPending} label="Awaiting PI" value={fmtRm(money.awaitingPi)} subtitle="Not yet invoiced · on this page" tone="warning" rail="bg-accent-bright" />
          <StatCard pending={statsPending} label="Draft" value={fmtRm(money.draft)} subtitle="Not yet posted · on this page" rail="bg-accent" />
        </div>

        <div className="sticky top-0 z-10 -mx-4 mb-3 bg-bg/95 px-4 py-2 backdrop-blur-sm md:hidden">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search GRN no, delivery note or notes…"
            className="h-10 w-full rounded-lg border border-border bg-surface px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          <SearchProgress active={searchTransition.isSearching} label={searchTransition.statusText} className="mt-1.5" />
          <SearchScopeHint scope="server" searching={searchTransition.isSearching} countPending={isLoading || isPlaceholderData || Boolean(error) || searchTransition.resultsAreStale} resultCount={total} term={search} className="mt-1" />
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <FilterPills options={statusPillOptions} value={status} onChange={(v) => setStatusChip(v)} />
          <div className="flex-1" />
          <div className="hidden md:block"><ViewToggle value={view} onChange={setView} /></div>
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
                    docTitle="Goods Received Notes"
                    docNos={rows.filter((r) => selectedIds.has(r.id)).map((r) => r.grn_number)}
                    {...batchPrint.handlers}
                  />
                  <Button variant="ghost" disabled={printingDocs} onClick={clearSelection}>
                    Clear
                  </Button>
                </div>
              )}
              <DataTable<GrnRow>
                tableId="grns-v2"
                rows={rows}
                loading={listLoading}
                error={error ? (error as Error).message ?? "Failed to load" : null}
                columns={columns}
                getRowKey={(r) => r.id}
                getRowClassName={(r) =>
                  isCancelledDocStatus(r.status) ? "dt-row-cancelled" : undefined
                }
                onRowClick={(r) => setSelected(r)}
                expandable={{
                  render: (r) => <GrnLinesExpansion id={r.id} />,
                  rowKey: (r) => r.id,
                }}
                selection={{
                  selectedIds,
                  onToggle: toggleSelect,
                  onToggleAll: toggleSelectAll,
                }}
                contextMenu={grnContextMenu}
            exportName="grns"
                serverSort
                onSortChange={setSortAndReset}
                emptyLabel={filtersActive ? "No GRNs match — try Reset layout to clear filters." : "No GRNs yet."}
                search={{ value: search, onChange: setSearch, placeholder: "Search GRN no, delivery note or notes…", debounceMs: 0, searching: searchTransition.isSearching, countPending: isLoading || isPlaceholderData || Boolean(error) || searchTransition.resultsAreStale, scope: "server", totalRecords: total }}
                resetFilters={{ active: filtersActive, onReset: resetLayout, label: "Reset layout" }}
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
                    placeholder="Search GRN no, delivery note or notes…"
                    className="h-9 max-w-[320px] flex-1 rounded-md border border-border bg-surface px-3.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
                  />
                  <SearchProgress active={searchTransition.isSearching} />
                  <SearchScopeHint scope="server" searching={searchTransition.isSearching} countPending={isLoading || isPlaceholderData || Boolean(error) || searchTransition.resultsAreStale} resultCount={total} term={search} />
                  {filtersActive && (
                    <button type="button" onClick={resetLayout} className="text-[12px] font-semibold text-primary hover:underline">Reset layout</button>
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
        onPrint={() => selected && printDocument(grnPrintChain(selected).own)}
        onPost={() => selected && doPost(selected)}
        onCancel={() => selected && doCancel(selected)}
        onConvertToPi={() => selected && goConvertToPi(selected)}
        onConvertToPr={() => selected && goConvertToPr(selected)}
      />
    </PullToRefresh>
  );
}

export default GoodsReceivedListV2;
