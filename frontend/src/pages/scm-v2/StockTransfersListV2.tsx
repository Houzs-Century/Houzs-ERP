// StockTransfersListV2 — Theme C redesign of the Stock Transfers listing.
// Stock movement doc: qty moves warehouse-to-warehouse. Atomic (POSTED on
// create), so filter buckets collapse to Posted / Cancelled only. Not a
// money doc — the framing is line-count + warehouse pairings.

import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Plus,
  Warehouse,
  ArrowRight,
  LayoutGrid,
  Table as TableIcon,
  X as XIcon,
} from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { StatCard } from "../../components/StatCard";
import { FilterPills } from "../../components/FilterPills";
import { DataTable, type Column } from "../../components/DataTable";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { PullToRefresh } from "../../components/PullToRefresh";
import { useStaffLookup } from "../../hooks/useStaffLookup";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import {
  useStockTransfers,
  useCancelStockTransfer,
  type StockTransferRow,
} from "../../vendor/scm/lib/stock-queries";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "../../lib/utils";
import { fmtDate } from "../../vendor/shared/format";
import { warehouseLabel } from "../../vendor/scm/lib/warehouse-label";
import { stockTransferRowMenu } from "./row-menus";

type StatusTab = "all" | "posted" | "cancelled";

/* Code first, then name — the one warehouse rule (vendor/scm/lib/warehouse-label.ts).
   The raw id stays as the last resort so an unresolved embed still says something. */
const fromWarehouseOf = (r: StockTransferRow): string =>
  warehouseLabel(r.from_warehouse) || r.from_warehouse_id || "—";
const toWarehouseOf = (r: StockTransferRow): string =>
  warehouseLabel(r.to_warehouse) || r.to_warehouse_id || "—";

const STATUS_TONE: Record<
  string,
  { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab }
> = {
  POSTED:    { tone: "success", label: "Confirmed", bucket: "posted" },
  CANCELLED: { tone: "error",   label: "Cancelled", bucket: "cancelled" },
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

function CardsGrid({ rows, onOpen }: { rows: StockTransferRow[]; onOpen: (r: StockTransferRow) => void }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-16 text-center shadow-stone">
        <div className="text-[13px] font-semibold text-ink">No stock transfers</div>
        <div className="mt-1 text-[12px] text-ink-muted">
          No transfers match the current filters. Try Reset layout to clear.
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
              <span className="font-mono text-[12.5px] font-semibold text-ink">{r.transfer_no}</span>
              <Badge tone={st.tone} size="xs">{st.label}</Badge>
            </div>
            <div className="mt-2 flex items-center gap-2 text-[13.5px] font-semibold text-ink">
              <Warehouse size={13} className="text-ink-muted" />
              <span className="truncate">{fromWarehouseOf(r)}</span>
              <ArrowRight size={12} className="shrink-0 text-primary" />
              <span className="truncate">{toWarehouseOf(r)}</span>
            </div>
            <div className="mt-1 text-[11.5px] text-ink-muted">{fmtDate(r.transfer_date)}</div>
            <div className="mt-3.5 flex items-end justify-between border-t border-border-subtle pt-3">
              <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">Lines</div>
              <span className="font-money text-[15px] font-bold text-ink">{r.line_count ?? "—"}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function StockTransfersListV2() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const askConfirm = useConfirm();

  const status = (params.get("status") ?? "all") as StatusTab;
  const view = (params.get("view") ?? "table") as "table" | "cards";
  const search = params.get("q") ?? "";

  const { data, isLoading, error } = useStockTransfers();
  const cancelTransfer = useCancelStockTransfer();
  // created_by is a scm.staff uuid — resolve it, never print the id.
  const { actorNameOf } = useStaffLookup();

  const allRows = useMemo<StockTransferRow[]>(() => data ?? [], [data]);

  const scopedByBucket = useMemo(() => {
    if (status === "all") return allRows;
    return allRows.filter((r) => statusFor(r.status).bucket === status);
  }, [allRows, status]);

  const filtered = useMemo(() => {
    if (!search.trim()) return scopedByBucket;
    const q = search.toLowerCase();
    return scopedByBucket.filter((r) => {
      const hay = [r.transfer_no, fromWarehouseOf(r), toWarehouseOf(r), r.notes]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [scopedByBucket, search]);

  const counts = useMemo(() => {
    const acc = { all: allRows.length, posted: 0, cancelled: 0 };
    for (const r of allRows) {
      const b = statusFor(r.status).bucket;
      if (b === "posted") acc.posted += 1;
      else if (b === "cancelled") acc.cancelled += 1;
    }
    return acc;
  }, [allRows]);

  const stats = useMemo(() => {
    let lines = 0;
    for (const r of filtered) lines += Number(r.line_count ?? 0);
    return { total: filtered.length, lines, posted: counts.posted, cancelled: counts.cancelled };
  }, [filtered, counts]);

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
    await queryClient.invalidateQueries({ queryKey: ["stock-transfers"] });
  };

  const goNew = () => navigate("/scm/stock-transfers/new");
  const goWarehouses = () => navigate("/scm/warehouses");
  const goDetail = (r: StockTransferRow) => navigate(`/scm/stock-transfers/${r.id}`);
  /* Print opens the detail page's preview via ?print=1 — the same contract the
     other eight documents' row menus use, and the reason it works is that the
     detail page now consumes the param (useOpenPrintPreviewFromUrl). Rendering
     the PDF from a LIST row is not possible here anyway: the row carries the
     warehouse pair and a line COUNT, never the lines. */
  const goPrint = (r: StockTransferRow) => navigate(`/scm/stock-transfers/${r.id}?print=1`);
  const doCancel = async (r: StockTransferRow) => {
    if (await askConfirm({
      title: `Cancel transfer ${r.transfer_no}?`,
      body: "Stock movements will be reversed.",
      confirmLabel: "Cancel transfer",
      danger: true,
    })) {
      cancelTransfer.mutate(r.id);
    }
  };

  /* Right-click (owner 2026-08-22). Cancel is the handler directly above, which
     until now was written and called from nowhere — the capability was in the
     page and unreachable. POSTED only: the server gates the flip on
     POSTED -> CANCELLED, so offering it on a cancelled row would be an entry
     that can only fail. */
  const transferContextMenu = stockTransferRowMenu<StockTransferRow>({
    open: goDetail,
    print: goPrint,
    cancel: doCancel,
    canCancel: (r) => r.status.toUpperCase() === "POSTED",
  });

  const columns: Column<StockTransferRow>[] = [
    {
      key: "transfer_no",
      label: "Transfer No.",
      width: "140px",
      alwaysVisible: true,
      getValue: (r) => r.transfer_no,
      render: (r) => <span className="font-mono text-[12.5px] font-semibold text-ink">{r.transfer_no}</span>,
    },
    {
      key: "transfer_date",
      label: "Date",
      width: "108px",
      getValue: (r) => r.transfer_date,
      render: (r) => <span className="text-[12.5px] text-ink-secondary">{fmtDate(r.transfer_date)}</span>,
    },
    {
      key: "from",
      label: "From",
      getValue: (r) => fromWarehouseOf(r),
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <Warehouse size={12} className="text-ink-muted" />
          <span className="truncate text-[13px] font-semibold text-ink">{fromWarehouseOf(r)}</span>
        </div>
      ),
    },
    {
      key: "arrow",
      label: "",
      width: "36px",
      getValue: () => "",
      render: () => <ArrowRight size={12} className="text-primary" />,
    },
    {
      key: "to",
      label: "To",
      getValue: (r) => toWarehouseOf(r),
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <Warehouse size={12} className="text-ink-muted" />
          <span className="truncate text-[13px] font-semibold text-ink">{toWarehouseOf(r)}</span>
        </div>
      ),
    },
    {
      key: "lines",
      label: "Lines",
      width: "80px",
      align: "right",
      getValue: (r) => r.line_count ?? 0,
      render: (r) => <span className="font-money text-[13px] text-ink">{r.line_count ?? "—"}</span>,
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
    // Re-added from the legacy StockTransfers list (data already on the row).
    // Default-hidden so the chooser exposes it without changing the default view.
    {
      key: "created_by",
      label: "Created By",
      width: "120px",
      defaultHidden: true,
      getValue: (r) => actorNameOf(r.created_by, ""),
      render: (r) => (
        <span className="text-[12px] text-ink-secondary">
          {actorNameOf(r.created_by)}
        </span>
      ),
    },
  ];

  const statusPillOptions: Array<{ value: StatusTab; label: string }> = [
    { value: "all", label: `All · ${counts.all}` },
    { value: "posted", label: `Confirmed · ${counts.posted}` },
    { value: "cancelled", label: `Cancelled · ${counts.cancelled}` },
  ];

  return (
    <PullToRefresh onRefresh={onPullToRefresh}>
      <div className="mb-3 flex items-start justify-between gap-3 md:hidden">
        <div className="min-w-0">
          <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">Stock Transfers</h1>
          <div className="mt-0.5 text-[12.5px] text-ink-muted">
            {stats.total} transfer{stats.total === 1 ? "" : "s"} · {stats.lines} lines
          </div>
        </div>
      </div>

      <div className="hidden md:block">
        <PageHeader
          eyebrow="Warehouse"
          title="Stock Transfers"
          description="Every warehouse-to-warehouse stock movement. Atomic: posted on create, cancel reverses the movement."
          primaryAction={
            <Button variant="primary" icon={<Plus size={14} />} onClick={goNew}>
              New Transfer
            </Button>
          }
          secondaryActions={[
            { label: "Warehouses", icon: Warehouse, onClick: goWarehouses },
          ]}
        />
      </div>

      <div className="mb-5 hidden grid-cols-2 gap-3 md:grid lg:grid-cols-3">
        <StatCard label="Total Transfers" value={stats.total.toLocaleString("en-MY")} subtitle="Scoped to current filter" rail="bg-primary" active />
        <StatCard label="Line count" value={stats.lines.toLocaleString("en-MY")} subtitle="Total lines moved" rail="bg-accent" />
        <StatCard label="Posted" value={counts.posted.toLocaleString("en-MY")} subtitle="Movements written" tone="success" rail="bg-synced" />
      </div>

      <div className="sticky top-0 z-10 -mx-4 mb-3 bg-bg/95 px-4 py-2 backdrop-blur-sm md:hidden">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search transfer, warehouse…"
          className="h-10 w-full rounded-lg border border-border bg-surface px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <FilterPills options={statusPillOptions} value={status} onChange={(v) => setStatusChip(v)} />
        <div className="flex-1" />
        <div className="hidden md:block"><ViewToggle value={view} onChange={setView} /></div>
      </div>

      <div className="md:hidden">
        <CardsGrid rows={filtered} onOpen={goDetail} />
      </div>

      <div className="hidden md:block">
        {view === "table" ? (
          <DataTable<StockTransferRow>
            tableId="stock-transfers-v2"
            rows={filtered}
            loading={isLoading}
            error={error ? (error as Error).message ?? "Failed to load" : null}
            columns={columns}
            getRowKey={(r) => r.id}
            onRowClick={goDetail}
            contextMenu={transferContextMenu}
            exportName="stock-transfers"
            emptyLabel={filtersActive ? "No transfers match — try Reset layout." : "No stock transfers yet."}
            search={{ value: search, onChange: setSearch, placeholder: "Search transfer no, warehouse, notes…", scope: "server", totalRecords: filtered.length }}
            resetFilters={{ active: filtersActive, onReset: resetLayout, label: "Reset layout" }}
          />
        ) : (
          <CardsGrid rows={filtered} onOpen={goDetail} />
        )}
      </div>
    </PullToRefresh>
  );
}

export default StockTransfersListV2;
