// StockTakesListV2 — Theme C redesign of the Stock Takes listing.
// Physical-count reconciliation doc: OPEN (counting) → POSTED (variance
// booked as ADJUSTMENT movements) → CANCELLED. Variance-forward framing
// because the number that drives action is the delta between counted and
// system qty.

import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Plus,
  Warehouse,
  ClipboardList,
  LayoutGrid,
  Table as TableIcon,
} from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { StatCard } from "../../components/StatCard";
import { FilterPills } from "../../components/FilterPills";
import { DataTable, type Column } from "../../components/DataTable";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { PullToRefresh } from "../../components/PullToRefresh";
import {
  useStockTakes,
  useCancelStockTake,
  type StockTakeRow,
} from "../../vendor/scm/lib/stock-queries";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "../../lib/utils";
import { useStaffLookup } from "../../hooks/useStaffLookup";
import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { fmtDate } from "../../vendor/shared/format";
import { warehouseLabel } from "../../vendor/scm/lib/warehouse-label";
import { stockTakeRowMenu } from "./row-menus";

type StatusTab = "all" | "open" | "posted" | "cancelled";

/* Code first, then name — the one warehouse rule (vendor/scm/lib/warehouse-label.ts). */
const warehouseOf = (r: StockTakeRow): string =>
  warehouseLabel(r.warehouse) || r.warehouse_id || "—";

const STATUS_TONE: Record<
  string,
  { tone: "success" | "warning" | "error" | "neutral"; label: string; bucket: StatusTab }
> = {
  OPEN:      { tone: "warning", label: "Open",      bucket: "open" },
  POSTED:    { tone: "success", label: "Confirmed", bucket: "posted" },
  CANCELLED: { tone: "error",   label: "Cancelled", bucket: "cancelled" },
};
const statusFor = (s: string) =>
  STATUS_TONE[(s || "").toUpperCase()] ?? { tone: "neutral" as const, label: s || "—", bucket: "open" as StatusTab };

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

function CardsGrid({ rows, onOpen }: { rows: StockTakeRow[]; onOpen: (r: StockTakeRow) => void }) {
  const { actorNameOf } = useStaffLookup();
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-16 text-center shadow-stone">
        <div className="text-[13px] font-semibold text-ink">No stock takes</div>
        <div className="mt-1 text-[12px] text-ink-muted">No takes match the current filters.</div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {rows.map((r) => {
        const st = statusFor(r.status);
        /* null = a blind OPEN take viewed without the supervise permission —
           the server withholds the figure (it would un-blind the count). */
        const varianceHidden = r.variance_total == null && r.blind === true;
        const variance = Number(r.variance_total ?? 0);
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpen(r)}
            className="group relative overflow-hidden rounded-lg border border-border bg-surface px-4 py-4 text-left shadow-stone transition-all duration-200 hover:-translate-y-px hover:border-primary/40 hover:shadow-slab focus:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[12.5px] font-semibold text-ink">{r.take_no}</span>
              <Badge tone={st.tone} size="xs">{st.label}</Badge>
            </div>
            <div className="mt-2 flex items-center gap-2 text-[13.5px] font-semibold text-ink">
              <Warehouse size={13} className="text-ink-muted" />
              <span className="truncate">{warehouseOf(r)}</span>
            </div>
            <div className="mt-1 text-[11.5px] text-ink-muted">
              {fmtDate(r.take_date)}
              {r.assignee_staff_id ? ` · ${actorNameOf(r.assignee_staff_id)}` : ""}
            </div>
            <div className="mt-3.5 flex items-end justify-between border-t border-border-subtle pt-3">
              <div>
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">Lines</div>
                <div className="mt-0.5 font-money text-[13px] font-semibold text-ink">{r.line_count ?? "—"}</div>
              </div>
              <div className="text-right">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">Variance</div>
                <div className={cn("mt-0.5 font-money text-[15px] font-bold", varianceHidden ? "text-ink-muted" : variance < 0 ? "text-err" : variance > 0 ? "text-synced" : "text-ink")}>
                  {varianceHidden ? "Hidden" : `${variance > 0 ? "+" : ""}${variance}`}
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function StockTakesListV2() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { actorNameOf } = useStaffLookup();
  const askConfirm = useConfirm();

  const status = (params.get("status") ?? "all") as StatusTab;
  const view = (params.get("view") ?? "table") as "table" | "cards";
  const search = params.get("q") ?? "";

  const { data, isLoading, error } = useStockTakes();
  const cancelTake = useCancelStockTake();

  const allRows = useMemo<StockTakeRow[]>(() => data ?? [], [data]);

  const scopedByBucket = useMemo(() => {
    if (status === "all") return allRows;
    return allRows.filter((r) => statusFor(r.status).bucket === status);
  }, [allRows, status]);

  const filtered = useMemo(() => {
    if (!search.trim()) return scopedByBucket;
    const q = search.toLowerCase();
    return scopedByBucket.filter((r) => {
      const hay = [r.take_no, warehouseOf(r), r.notes, r.scope_value]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [scopedByBucket, search]);

  const counts = useMemo(() => {
    const acc = { all: allRows.length, open: 0, posted: 0, cancelled: 0 };
    for (const r of allRows) {
      const b = statusFor(r.status).bucket;
      if (b === "open") acc.open += 1;
      else if (b === "posted") acc.posted += 1;
      else if (b === "cancelled") acc.cancelled += 1;
    }
    return acc;
  }, [allRows]);

  const stats = useMemo(() => {
    let variance = 0;
    let lines = 0;
    for (const r of filtered) {
      variance += Number(r.variance_total ?? 0);
      lines += Number(r.line_count ?? 0);
    }
    return { total: filtered.length, lines, variance, open: counts.open };
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
    await queryClient.invalidateQueries({ queryKey: ["stock-takes"] });
  };

  const goNew = () => navigate("/scm/stock-takes/new");
  const goInventory = () => navigate("/scm/inventory");
  const goDetail = (r: StockTakeRow) => navigate(`/scm/stock-takes/${r.id}`);
  /* Print opens the detail page's preview via ?print=1 — the same contract the
     other documents' row menus use, and it works because the detail page now
     consumes the param (useOpenPrintPreviewFromUrl). It could not be rendered
     from a list row in any case: the row carries a line COUNT and a variance
     TOTAL, never the count sheet itself. */
  const goPrint = (r: StockTakeRow) => navigate(`/scm/stock-takes/${r.id}?print=1`);
  const doCancel = async (r: StockTakeRow) => {
    if (await askConfirm({
      title: `Cancel take ${r.take_no}?`,
      confirmLabel: "Cancel take",
      danger: true,
    })) {
      cancelTake.mutate(r.id);
    }
  };

  /* Right-click (owner 2026-08-22). Cancel is the handler directly above, which
     until now was written and called from nowhere. OPEN only, because that is
     the only transition this route accepts — undoing a POSTED take is
     /stock-takes/:id/reverse, a different action with different words, and it
     stays on the detail page. Posting stays there too: the confirmation shows
     the variance about to be booked, and the row carries no such number. */
  const takeContextMenu = stockTakeRowMenu<StockTakeRow>({
    open: goDetail,
    print: goPrint,
    cancel: doCancel,
    canCancel: (r) => r.status.toUpperCase() === "OPEN",
  });

  const columns: Column<StockTakeRow>[] = [
    {
      key: "take_no",
      label: "Take No.",
      width: "140px",
      alwaysVisible: true,
      getValue: (r) => r.take_no,
      render: (r) => <span className="font-mono text-[12.5px] font-semibold text-ink">{r.take_no}</span>,
    },
    {
      key: "take_date",
      label: "Date",
      width: "108px",
      getValue: (r) => r.take_date,
      render: (r) => <span className="text-[12.5px] text-ink-secondary">{fmtDate(r.take_date)}</span>,
    },
    {
      key: "warehouse",
      label: "Warehouse",
      getValue: (r) => warehouseOf(r),
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <Warehouse size={12} className="text-ink-muted" />
          <span className="truncate text-[13px] font-semibold text-ink">{warehouseOf(r)}</span>
        </div>
      ),
    },
    {
      key: "scope",
      label: "Scope",
      width: "132px",
      getValue: (r) => r.scope_type,
      render: (r) => (
        <span className="text-[12.5px] text-ink-secondary">
          {r.scope_type === "ALL"
            ? "All items"
            : `${r.scope_type === "CATEGORY" ? "Category" : "Prefix"}: ${r.scope_value ?? "—"}`}
        </span>
      ),
    },
    {
      key: "assignee",
      label: "Assignee",
      width: "140px",
      getValue: (r) => (r.assignee_staff_id ? actorNameOf(r.assignee_staff_id, "") : ""),
      render: (r) => (
        <span className="truncate text-[12.5px] text-ink-secondary">
          {r.assignee_staff_id ? actorNameOf(r.assignee_staff_id) : "—"}
        </span>
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
      key: "variance",
      label: "Variance",
      width: "100px",
      align: "right",
      getValue: (r) => r.variance_total ?? 0,
      render: (r) => {
        /* null on a blind OPEN take for non-supervisors (server-stripped). */
        if (r.variance_total == null && r.blind === true) {
          return <span className="text-[12px] text-ink-muted">Hidden</span>;
        }
        const v = Number(r.variance_total ?? 0);
        return (
          <span className={cn("font-money text-[13px] font-semibold", v < 0 ? "text-err" : v > 0 ? "text-synced" : "text-ink-muted")}>
            {v > 0 ? "+" : ""}{v}
          </span>
        );
      },
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
  ];

  const statusPillOptions: Array<{ value: StatusTab; label: string }> = [
    { value: "all", label: `All · ${counts.all}` },
    { value: "open", label: `Open · ${counts.open}` },
    { value: "posted", label: `Confirmed · ${counts.posted}` },
    { value: "cancelled", label: `Cancelled · ${counts.cancelled}` },
  ];

  return (
    <PullToRefresh onRefresh={onPullToRefresh}>
      <div className="mb-3 flex items-start justify-between gap-3 md:hidden">
        <div className="min-w-0">
          <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">Stock Takes</h1>
          <div className="mt-0.5 text-[12.5px] text-ink-muted">
            {stats.total} take{stats.total === 1 ? "" : "s"} · {stats.open} open
          </div>
        </div>
      </div>

      <div className="hidden md:block">
        <PageHeader
          eyebrow="Warehouse"
          title="Stock Takes"
          description="Physical-count reconciliation — OPEN (counting) → POSTED (variance booked as ADJUSTMENT movements) → CANCELLED."
          primaryAction={
            <Button variant="primary" icon={<Plus size={14} />} onClick={goNew}>
              New Take
            </Button>
          }
          secondaryActions={[
            { label: "Inventory", icon: ClipboardList, onClick: goInventory },
          ]}
        />
      </div>

      <div className="mb-5 hidden grid-cols-2 gap-3 md:grid lg:grid-cols-4">
        <StatCard label="Total Takes" value={stats.total.toLocaleString("en-MY")} subtitle="Scoped to current filter" rail="bg-primary" active />
        <StatCard label="Open" value={stats.open.toLocaleString("en-MY")} subtitle="Currently counting" tone="warning" rail="bg-accent-bright" />
        <StatCard label="Lines counted" value={stats.lines.toLocaleString("en-MY")} subtitle="Sum across takes" rail="bg-accent" />
        <StatCard
          label="Net variance"
          value={`${stats.variance > 0 ? "+" : ""}${stats.variance.toLocaleString("en-MY")}`}
          subtitle="Counted − system"
          tone={stats.variance < 0 ? "error" : stats.variance > 0 ? "success" : undefined}
          rail={stats.variance < 0 ? "bg-err" : "bg-synced"}
        />
      </div>

      <div className="sticky top-0 z-10 -mx-4 mb-3 bg-bg/95 px-4 py-2 backdrop-blur-sm md:hidden">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search take, warehouse…"
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
          <DataTable<StockTakeRow>
            tableId="stock-takes-v2"
            rows={filtered}
            loading={isLoading}
            error={error ? (error as Error).message ?? "Failed to load" : null}
            columns={columns}
            getRowKey={(r) => r.id}
            onRowClick={goDetail}
            contextMenu={takeContextMenu}
            exportName="stock-takes"
            emptyLabel={filtersActive ? "No takes match — try Reset layout." : "No stock takes yet."}
            search={{ value: search, onChange: setSearch, placeholder: "Search take, warehouse, scope, notes…", scope: "server", totalRecords: filtered.length }}
            resetFilters={{ active: filtersActive, onReset: resetLayout, label: "Reset layout" }}
          />
        ) : (
          <CardsGrid rows={filtered} onOpen={goDetail} />
        )}
      </div>
    </PullToRefresh>
  );
}

export default StockTakesListV2;
