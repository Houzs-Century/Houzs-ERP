// PurchaseReturnsListV2 — Theme C redesign of the Purchase Return listing.
// Procurement-side mirror of DR (Delivery Return): goods flow BACK to the
// supplier and money is expected back from them (usually via a credit note
// booked on Complete). Money-IN framing — a rare thing on the procurement
// side where every other doc is money-out.

import { useMemo, useState, type ReactNode } from "react";
import { buildVariantSummary, fmtSen, fmtDate, orderLineIdentity } from "@2990s/shared";
import { formatPhone } from "@2990s/shared/phone";
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
  CheckCircle2,
  Send,
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
import {
  usePurchaseReturns,
  usePurchaseReturnDetail,
  usePostPurchaseReturn,
  useCancelPurchaseReturn,
} from "../../vendor/scm/lib/purchase-return-queries";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { useChoice } from "../../vendor/scm/components/ChoiceDialog";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "../../lib/utils";
import { ResizableDetailDrawer } from "../../components/ResizableDetailDrawer";
import { transferFromColumnLabel } from "../../lib/convertScope";
import { purchaseReturnRowMenu } from "./row-menus";
import { usePrintDocument } from "../../components/scm-v2/PrintChainProvider";
import { purchaseReturnPrintChain } from "../../lib/printChain";

type PrRow = {
  id: string;
  return_number: string;
  status: string;
  return_date: string | null;
  refund_sen?: number;
  reason?: string | null;
  notes?: string | null;
  currency?: string;
  supplier?: { id: string; code: string; name: string; contact_person?: string | null; phone?: string | null; email?: string | null; address?: string | null } | null;
  purchase_order?: { id: string; po_number: string } | null;
  grn?: { id: string; grn_number: string } | null;
  line_count?: number;
};

type PrItem = {
  id: string;
  item_code?: string | null;
  description?: string | null;
  description2?: string | null;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
  uom?: string;
  qty?: number;
  qty_returned?: number;
  condition?: string | null;
  /* Per-line reason (backend purchase_return_items.reason) — nullable; when
     unset the header-level reason (shown as a callout above) is the fallback. */
  reason?: string | null;
  unit_price_sen?: number;
  line_total_sen?: number;
};

type StatusTab = "all" | "draft" | "posted" | "completed" | "cancelled";

const fmtRm = (centi: number): string => fmtSen(centi);

const supplierNameOf = (r: PrRow): string => r.supplier?.name || "—";
const supplierCodeOf = (r: PrRow): string => r.supplier?.code || "—";
const sourceOf = (r: PrRow): string => r.grn?.grn_number || r.purchase_order?.po_number || "—";
const refundOf = (r: PrRow): number => r.refund_sen ?? 0;

const STATUS_TONE: Record<string, { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab }> = {
  DRAFT:     { tone: "warning", label: "Draft",     bucket: "draft" },
  POSTED:    { tone: "warning", label: "Confirmed", bucket: "posted" },
  COMPLETED: { tone: "success", label: "Completed", bucket: "completed" },
  CANCELLED: { tone: "error",   label: "Cancelled", bucket: "cancelled" },
};

const statusFor = (s: string) =>
  STATUS_TONE[(s || "").toUpperCase()] ?? { tone: "neutral" as const, label: s || "—", bucket: "posted" as StatusTab };

function SplitDropdown({ onImport, onDuplicate }: { onImport: () => void; onDuplicate: () => void }) {
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
            <button type="button" className="block w-full px-3.5 py-2 text-left text-[12.5px] text-ink hover:bg-primary-soft" onClick={() => { setOpen(false); onImport(); }}>
              Import from file
            </button>
            <button type="button" className="block w-full px-3.5 py-2 text-left text-[12.5px] text-ink hover:bg-primary-soft" onClick={() => { setOpen(false); onDuplicate(); }}>
              Duplicate last return
            </button>
          </div>
        </>
      )}
    </div>
  );
}

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

function CardsGrid({ rows, onOpen }: { rows: PrRow[]; onOpen: (r: PrRow) => void }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-16 text-center shadow-stone">
        <div className="text-[13px] font-semibold text-ink">No purchase returns</div>
        <div className="mt-1 text-[12px] text-ink-muted">
          No returns match the current filters. Try Reset layout to clear the search and status tabs.
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
              <span className="font-docno text-[12.5px] font-semibold text-ink">{r.return_number}</span>
              <Badge tone={st.tone} size="xs">{st.label}</Badge>
            </div>
            <div className="mt-2 truncate text-[15px] font-semibold text-ink">{supplierNameOf(r)}</div>
            {/* Owner 2026-07-23: supplier code on its own line. */}
            <div className="truncate font-mono text-[11px] text-ink-muted">{supplierCodeOf(r)}</div>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-[11.5px] text-ink-muted">{fmtDate(r.return_date)}</span>
            </div>
            {r.reason && (
              <div className="mt-2.5 truncate text-[12.5px] italic text-ink-secondary">
                “{r.reason}”
              </div>
            )}
            <div className="mt-3.5 flex items-end justify-between border-t border-border-subtle pt-3">
              <div className="min-w-0">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{transferFromColumnLabel('grn')}</div>
                <div className="mt-0.5 truncate font-mono text-[12px] font-semibold text-ink-secondary">{sourceOf(r)}</div>
              </div>
              <div className="text-right">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">Credit</div>
                <div className="mt-0.5 font-money text-[15px] font-bold text-synced">{fmtRm(refundOf(r))}</div>
              </div>
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
  onComplete,
  onCancel,
}: {
  row: PrRow | null;
  onClose: () => void;
  onOpenFull: () => void;
  onEdit: () => void;
  onPrint: () => void;
  onPost: () => void;
  onComplete: () => void;
  onCancel: () => void;
}) {
  const detailQ = usePurchaseReturnDetail(row?.id ?? null);
  const items: PrItem[] = ((detailQ.data as { items?: PrItem[] } | undefined)?.items ?? []);
  const open = !!row;
  const st = row ? statusFor(row.status) : null;
  const refund = row ? refundOf(row) : 0;

  return (
    <ResizableDetailDrawer
      open={open}
      onClose={onClose}
      ariaLabel={row ? `Purchase return ${row.return_number}` : "Purchase return details"}
    >
        {row && st && (
          <>
            <div className="flex h-[60px] shrink-0 items-center gap-3 bg-sidebar px-5 text-sidebar-ink">
              <button type="button" onClick={onClose} className="text-sidebar-ink-muted hover:text-sidebar-ink" aria-label="Close details">
                <XIcon size={18} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[14px] font-bold tracking-wide">{row.return_number}</div>
                <div className="mt-0.5 text-[11px] text-sidebar-ink-muted">Purchase Return</div>
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
                <span className="text-[12.5px] text-ink-muted">Returned {fmtDate(row.return_date)}</span>
              </div>

              {row.reason && (
                <div className="mt-4 rounded-lg border-l-4 border-primary bg-primary-soft px-4 py-3">
                  <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">Return reason</div>
                  <div className="mt-1 text-[13.5px] font-semibold italic text-ink">“{row.reason}”</div>
                </div>
              )}

              <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2 px-4 py-4">
                <MetaItem k={transferFromColumnLabel('grn')} v={sourceOf(row)} mono />
                <MetaItem k="Return date" v={fmtDate(row.return_date)} />
                <MetaItem k="Supplier code" v={supplierCodeOf(row)} mono />
                <MetaItem k="Line count" v={row.line_count ?? items.length ?? "—"} />
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

              <SectionHeading>Returned items</SectionHeading>
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="grid grid-cols-[1fr_52px_1fr_92px] gap-2 border-b border-border-subtle bg-surface-2 px-4 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  <span>Item</span>
                  <span className="text-right">Qty</span>
                  <span>Reason</span>
                  <span className="text-right">Credit</span>
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
                  <div key={l.id ?? i} className="grid grid-cols-[1fr_52px_1fr_92px] items-start gap-2 border-b border-border-subtle px-4 py-3 last:border-b-0">
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
                          <Badge tone="warning" variant="soft" size="xs">{l.condition}</Badge>
                        </div>
                      )}
                    </div>
                    <span className="text-right font-money text-[12.5px] text-ink-secondary">{l.qty_returned ?? l.qty ?? 0}</span>
                    <span className="truncate text-[12px] italic text-ink-secondary" title={l.reason ?? ''}>
                      {l.reason ? l.reason : <span className="not-italic text-ink-muted">—</span>}
                    </span>
                    <span className="text-right font-money text-[12.5px] font-semibold text-synced">{fmtRm(l.line_total_sen ?? 0)}</span>
                  </div>
                  );
                })}
              </div>

              <div className="mt-4 rounded-lg border-l-4 border-synced bg-primary-soft px-5 py-4">
                <TotalRow k="Credit expected" v={fmtRm(refund)} strong tone="success" />
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
                  return (
                    <Button variant="primary" icon={<CheckCircle2 size={14} />} onClick={onComplete}>
                      Complete
                    </Button>
                  );
                }
                if (s !== "COMPLETED" && s !== "CANCELLED") {
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

function TotalRow({ k, v, strong, tone }: { k: string; v: string; strong?: boolean; tone?: "success" }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className={cn("text-[12px] text-ink-muted", strong && "text-[13px] font-semibold text-ink")}>{k}</span>
      <span className={cn("font-money text-[13px] font-semibold", strong && "text-[15px] font-bold", tone === "success" ? "text-synced" : "text-ink")}>
        {v}
      </span>
    </div>
  );
}

// ─── Row drill-down (DataTable `expandable`) ──────────────────────────────────
// Inline per-line breakdown for one PR, lazy-fetched via the SAME
// usePurchaseReturnDetail hook the drawer uses (TanStack-cached). Group + item
// code/variant + Qty (returned) + Amount, via the shared DocumentLinesExpansion.
// A purchase return is a purchase-side doc with no MRP coverage on its lines, so
// the SO/DO-only Stock + Incoming PO columns are absent.
function PrLinesExpansion({ id }: { id: string }) {
  const detailQ = usePurchaseReturnDetail(id);
  const items =
    ((detailQ.data as { items?: DrillItemFields[] } | undefined)?.items ?? []);
  const lines: DocumentDrillLine[] = items.map((l) => ({
    itemGroup: l.item_group ?? null,
    code: l.item_code || l.item_code || null,
    description: l.description ?? null,
    description2: l.description2 ?? null,
    variants: l.variants ?? null,
    qty: Number(l.qty_returned ?? l.qty ?? 0),
    amountSen: l.line_total_sen ?? 0,
  }));
  return (
    <DocumentLinesExpansion
      isLoading={detailQ.isLoading}
      coverage="ready" /* one query fills this drill-down — coverage-state.tsx */
      isError={Boolean(detailQ.error)}
      errorMessage={detailQ.error instanceof Error ? detailQ.error.message : null}
      lines={lines}
      emptyLabel="No lines on this purchase return."
    />
  );
}

export function PurchaseReturnsListV2() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const notify = useNotify();
  const askChoice = useChoice();
  const askConfirm = useConfirm();

  const status = (params.get("status") ?? "all") as StatusTab;
  const view = (params.get("view") ?? "table") as "table" | "cards";
  const search = params.get("q") ?? "";

  const [selected, setSelected] = useState<PrRow | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [printingDocs, setPrintingDocs] = useState(false);

  const { data, isLoading, error } = usePurchaseReturns();
  // These tiles are reduces over a row set that is [] until the fetch lands (and
  // stays [] if it fails), so a settled-looking "Refund Value RM 0.00" would
  // describe a list nobody has read yet.
  const statsPending = isLoading || Boolean(error);
  const postPr = usePostPurchaseReturn();
  const cancelPr = useCancelPurchaseReturn();

  const allRows = useMemo<PrRow[]>(
    () => ((data?.purchaseReturns ?? []) as PrRow[]),
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
      const hay = [r.return_number, supplierNameOf(r), supplierCodeOf(r), sourceOf(r), r.reason, r.notes]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [scopedByBucket, search]);

  const counts = useMemo(() => {
    const acc = { all: allRows.length, draft: 0, posted: 0, completed: 0, cancelled: 0 };
    for (const r of allRows) {
      const b = statusFor(r.status).bucket;
      if (b === "draft") acc.draft += 1;
      else if (b === "posted") acc.posted += 1;
      else if (b === "completed") acc.completed += 1;
      else if (b === "cancelled") acc.cancelled += 1;
    }
    return acc;
  }, [allRows]);

  const stats = useMemo(() => {
    let credit = 0;
    let pending = 0;
    let settled = 0;
    for (const r of filtered) {
      const amt = refundOf(r);
      credit += amt;
      const b = statusFor(r.status).bucket;
      if (b === "draft" || b === "posted") pending += amt;
      if (b === "completed") settled += amt;
    }
    return { total: filtered.length, credit, pending, settled };
  }, [filtered]);

  const setStatusChip = (s: StatusTab) => {
    const next = new URLSearchParams(params);
    if (s === "all") next.delete("status"); else next.set("status", s);
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
    setParams(next, { replace: true });
  };
  const resetLayout = () => setParams(new URLSearchParams(), { replace: true });
  const filtersActive = status !== "all" || view !== "table" || search.trim().length > 0;

  const onPullToRefresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["purchase-returns"] });
  };

  const goNewPr = () => navigate("/scm/purchase-returns/new");
  const goImport = () => navigate("/scm/purchase-returns?import=1");
  const goDuplicate = () => navigate("/scm/purchase-returns?duplicate=1");
  const goGrns = () => navigate("/scm/grns");
  const goSuppliers = () => navigate("/scm/suppliers");
  const goEdit = (r: PrRow) => navigate(`/scm/purchase-returns/${r.id}?edit=1`);
  const printDocument = usePrintDocument();
  const goFullPage = (r: PrRow) => navigate(`/scm/purchase-returns/${r.id}`);

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

  // One PR's full detail for the PDF generator, via the vendored authedFetch
  // (→ /api/scm); same endpoint + shape as the single-row detail page.
  const fetchPrBundle = async (
    row: PrRow
  ): Promise<{ header: unknown; items: unknown[] }> => {
    const json = await authedFetch<{ purchaseReturn: unknown; items: unknown[] }>(
      `/purchase-returns/${row.id}`
    );
    return { header: json.purchaseReturn, items: json.items };
  };

  // Batch "Print all" — one ticked PR downloads straight; several prompt
  // combined-vs-separate.
  const deliverSelectedPrs = async (action: PdfAction) => {
    if (printingDocs) return;
    const chosen = filtered.filter((r) => selectedIds.has(r.id));
    if (chosen.length === 0) return;
    try {
      const { generatePurchaseReturnPdf, generateCombinedPurchaseReturnPdf } =
        await import("../../vendor/scm/lib/purchase-return-pdf");
      if (chosen.length === 1) {
        setPrintingDocs(true);
        const b = await fetchPrBundle(chosen[0]!);
        await generatePurchaseReturnPdf(b.header as never, b.items as never, { action });
        clearSelection();
        return;
      }
      /* View / Print always render ONE document — a preview or a print run
         is about the stack, not N separate files. Only the download exit
         still asks combined-vs-separate. */
      const how = action !== "save" ? "one" : await askChoice({
        title: `Print ${chosen.length} purchase returns`,
        options: [
          { value: "one", label: "One combined PDF" },
          { value: "many", label: "Separate files", detail: "One PDF per document" },
        ],
      });
      if (how == null) return;
      setPrintingDocs(true);
      const bundles: Array<{ header: unknown; items: unknown[] }> = [];
      for (const r of chosen) bundles.push(await fetchPrBundle(r));
      if (how === "one") {
        await generateCombinedPurchaseReturnPdf(bundles as never, {
          fileName: `purchase-returns-${new Date().toISOString().slice(0, 10)}.pdf`,
          action,
        });
      } else {
        for (const b of bundles)
          await generatePurchaseReturnPdf(b.header as never, b.items as never, { action });
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
  const batchPrint = usePrintPreview(deliverSelectedPrs);
  const doPost = async (r: PrRow) => {
    if (await askConfirm({
      title: `Post return ${r.return_number}?`,
      body: "A credit-owed entry will be booked against the supplier.",
      confirmLabel: "Post return",
    })) {
      postPr.mutate(r.id, { onSuccess: () => setSelected(null) });
    }
  };
  const doComplete = (r: PrRow) => navigate(`/scm/purchase-returns/${r.id}?tab=complete`);
  const doCancel = async (r: PrRow) => {
    if (await askConfirm({
      title: `Cancel return ${r.return_number}?`,
      body: "Stock will be reversed.",
      confirmLabel: "Cancel return",
      danger: true,
    })) {
      cancelPr.mutate(r.id, { onSuccess: () => setSelected(null) });
    }
  };

  /* Right-click (owner 2026-08-22). Every entry is a handler the drawer above
     already calls; nothing new happens here.

     Cancel is offered WIDER than the drawer shows it. The drawer's action slot
     is an if/else chain, so a DRAFT renders Post and a POSTED renders Complete
     and neither ever renders Cancel — yet the server accepts a cancel from
     both (`cancelPurchaseReturnHandler` refuses only COMPLETED and an already
     cancelled return). The menu is a separate group, so it can offer what the
     server actually allows. */
  const prContextMenu = purchaseReturnRowMenu<PrRow>({
    open: goFullPage,
    edit: goEdit,
    print: printDocument,
    confirm: doPost,
    cancel: doCancel,
    canConfirm: (r) => (r.status || "").toUpperCase() === "DRAFT",
    canCancel: (r) => !["COMPLETED", "CANCELLED"].includes((r.status || "").toUpperCase()),
  });

  const columns: Column<PrRow>[] = [
    {
      key: "return_number",
      label: "Return No.",
      // 156 + font-docno (owner 2026-07-31): 140 sat on the clip threshold for
      // a full doc no — see the measured DO No. note in MfgDeliveryOrdersListV2.
      width: "156px",
      alwaysVisible: true,
      getValue: (r) => r.return_number,
      render: (r) => <span className="font-docno text-[12.5px] font-semibold text-ink">{r.return_number}</span>,
    },
    {
      key: "return_date",
      label: "Date",
      width: "108px",
      getValue: (r) => r.return_date ?? "",
      render: (r) => <span className="text-[12.5px] text-ink-secondary">{fmtDate(r.return_date)}</span>,
    },
    {
      key: "source",
      label: transferFromColumnLabel('grn'),
      width: "132px",
      getValue: (r) => sourceOf(r),
      render: (r) => <span className="font-mono text-[12px] text-ink-secondary">{sourceOf(r)}</span>,
    },
    {
      // Owner 2026-07-24: supplier NAME and CODE are separate columns on every
      // procurement table, not a stacked cell — code must be scannable on its
      // own (same split as the PO list, 2026-07-23).
      key: "supplier",
      label: "Supplier",
      getValue: (r) => supplierNameOf(r),
      render: (r) => (
        <div className="min-w-0 truncate text-[13px] font-semibold text-ink">{supplierNameOf(r)}</div>
      ),
    },
    {
      key: "supplier_code",
      label: "Code",
      width: "108px",
      getValue: (r) => supplierCodeOf(r),
      render: (r) => (
        <span className="font-mono text-[11.5px] text-ink-secondary">{supplierCodeOf(r)}</span>
      ),
    },
    {
      key: "reason",
      label: "Reason",
      width: "180px",
      getValue: (r) => r.reason ?? "",
      render: (r) =>
        r.reason
          ? <span className="truncate text-[12.5px] italic text-ink-secondary">{r.reason}</span>
          : <span className="text-[12.5px] text-ink-muted">—</span>,
    },
    {
      key: "status",
      label: "Status",
      width: "120px",
      getValue: (r) => r.status,
      render: (r) => {
        const st = statusFor(r.status);
        return <Badge tone={st.tone} size="xs">{st.label}</Badge>;
      },
    },
    {
      key: "credit",
      label: "Credit",
      width: "128px",
      align: "right",
      getValue: (r) => refundOf(r),
      render: (r) => <span className="font-money text-[13px] font-semibold text-synced">{fmtRm(refundOf(r))}</span>,
    },
  ];

  const statusPillOptions: Array<{ value: StatusTab; label: string }> = [
    { value: "all", label: `All · ${counts.all}` },
    { value: "draft", label: `Draft · ${counts.draft}` },
    { value: "posted", label: `Confirmed · ${counts.posted}` },
    { value: "completed", label: `Completed · ${counts.completed}` },
    { value: "cancelled", label: `Cancelled · ${counts.cancelled}` },
  ];

  return (
    <PullToRefresh onRefresh={onPullToRefresh}>
      <div className={cn("transition-[padding] duration-200", selected ? "md:pr-[540px]" : "")}>
        <div className="mb-3 flex items-start justify-between gap-3 md:hidden">
          <div className="min-w-0">
            <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">Purchase Returns</h1>
            <div className="mt-0.5 text-[12.5px] text-ink-muted">
              {stats.total} return{stats.total === 1 ? "" : "s"} · <span className="font-money text-synced">{fmtRm(stats.credit)}</span> credit
            </div>
          </div>
        </div>

        <div className="hidden md:block">
          <PageHeader
            eyebrow="Procurement"
            title="Purchase Returns"
            description="Goods returned to suppliers — Draft through Completed. Click any row for the quick view; open the full page to edit."
            primaryAction={
              <div className="flex items-stretch">
                <Button variant="primary" icon={<Plus size={14} />} onClick={goNewPr} className="rounded-r-none">
                  New Purchase Return
                </Button>
                <SplitDropdown onImport={goImport} onDuplicate={goDuplicate} />
              </div>
            }
            secondaryActions={[
              { label: "Goods Received", icon: Package, onClick: goGrns },
              { label: "Suppliers", icon: Users, onClick: goSuppliers },
            ]}
          />
        </div>

        <div className="mb-5 hidden grid-cols-2 gap-3 md:grid lg:grid-cols-4">
          <StatCard pending={statsPending} label="Total Returns" value={stats.total.toLocaleString("en-MY")} subtitle="Scoped to current filter" rail="bg-primary" active />
          <StatCard pending={statsPending} label="Credit Value" value={fmtRm(stats.credit)} subtitle="Money owed back to us" tone="success" rail="bg-synced" />
          <StatCard pending={statsPending} label="Pending" value={fmtRm(stats.pending)} subtitle="Draft + Posted · awaiting credit note" tone="warning" rail="bg-accent-bright" />
          <StatCard pending={statsPending} label="Settled" value={fmtRm(stats.settled)} subtitle="Completed · loop closed" rail="bg-accent" />
        </div>

        <div className="sticky top-0 z-10 -mx-4 mb-3 bg-bg/95 px-4 py-2 backdrop-blur-sm md:hidden">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search return, supplier, reason…"
            className="h-10 w-full rounded-lg border border-border bg-surface px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          <SearchScopeHint scope="loaded" loadedLimit={300} resultCount={filtered.length} term={search} className="mt-1 px-1" />
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <FilterPills options={statusPillOptions} value={status} onChange={(v) => setStatusChip(v)} />
          <div className="flex-1" />
          <div className="hidden md:block"><ViewToggle value={view} onChange={setView} /></div>
        </div>

        <div className="md:hidden">
          <CardsGrid rows={filtered} onOpen={(r) => setSelected(r)} />
          {filtered.length > 0 && (
            <div className="mt-4 pb-24 text-center text-[11.5px] text-ink-muted">
              {filtered.length} return{filtered.length === 1 ? "" : "s"}
            </div>
          )}
        </div>

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
                    docTitle="Purchase Returns"
                    docNos={filtered.filter((r) => selectedIds.has(r.id)).map((r) => r.return_number)}
                    {...batchPrint.handlers}
                  />
                  <Button variant="ghost" disabled={printingDocs} onClick={clearSelection}>
                    Clear
                  </Button>
                </div>
              )}
              <DataTable<PrRow>
                tableId="purchase-returns-v2"
                rows={filtered}
                loading={isLoading}
                error={error ? (error as Error).message ?? "Failed to load" : null}
                columns={columns}
                getRowKey={(r) => r.id}
                onRowClick={(r) => setSelected(r)}
                contextMenu={prContextMenu}
                expandable={{
                  render: (r) => <PrLinesExpansion id={r.id} />,
                  rowKey: (r) => r.id,
                }}
                selection={{
                  selectedIds,
                  onToggle: toggleSelect,
                  onToggleAll: toggleSelectAll,
                }}
                exportName="purchase-returns"
                emptyLabel={filtersActive ? "No purchase returns match — try Reset layout to clear filters." : "No purchase returns yet."}
                search={{ value: search, onChange: setSearch, placeholder: "Search return, supplier, reason, source…", loadedLimit: 300 }}
                resetFilters={{ active: filtersActive, onReset: resetLayout, label: "Reset layout" }}
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
                    placeholder="Search return, supplier, reason, source…"
                    className="h-9 max-w-[320px] flex-1 rounded-md border border-border bg-surface px-3.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
                  />
                  <SearchScopeHint scope="loaded" loadedLimit={300} resultCount={filtered.length} term={search} />
                  {filtersActive && (
                    <button type="button" onClick={resetLayout} className="text-[12px] font-semibold text-primary hover:underline">Reset layout</button>
                  )}
                </div>
                <span className="text-[12px] text-ink-muted">{filtered.length} return{filtered.length === 1 ? "" : "s"}</span>
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
        onPrint={() => selected && printDocument(purchaseReturnPrintChain(selected).own)}
        onPost={() => selected && doPost(selected)}
        onComplete={() => selected && doComplete(selected)}
        onCancel={() => selected && doCancel(selected)}
      />
    </PullToRefresh>
  );
}

export default PurchaseReturnsListV2;
