// ----------------------------------------------------------------------------
// StockAdjustments — list of manual stock adjustment DOCUMENTS (write-offs,
// found stock, damage, recount fixes) at /scm/stock-adjustments, one row per
// numbered document (BUG-66 — it used to list raw movement rows with no number
// and nothing to open). A row opens /scm/stock-adjustments/:id.
// + New Adjustment routes to /scm/stock-adjustments/new.
//
// 2026-07-09 REDESIGN per Nick's design_handoff_stock_adjustments handoff —
// Theme C "Ink & Petrol" with real DS components (PageHeader, StatCard,
// DataTable, Badge, Button). Reads useStockAdjustments + useWarehouses;
// warehouse pill filter; StatStrip surfaces at-a-glance metrics (Adjustments
// · 30d, Net qty delta, Damage/loss, Supplier returns).
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, X } from "lucide-react";
import { adjustmentReasonLabel, fmtDateTime, fmtQty } from "@2990s/shared";
import { useWarehouses } from "../../vendor/scm/lib/inventory-queries";
import {
  useStockAdjustments,
  type StockAdjustmentDoc,
} from "../../vendor/scm/lib/stock-queries";
import { Button } from "../../components/Button";
import { PageHeader } from "../../components/Layout";
import { StatCard } from "../../components/StatCard";
import { Badge } from "../../components/Badge";
import { DataTable, type Column } from "../../components/DataTable";
import { useSetBreadcrumbs } from "../../hooks/useBreadcrumbs";
import { useStaffLookup } from "../../hooks/useStaffLookup";
import { cn } from "../../lib/utils";
import { DateField } from "../../vendor/scm/components/DateField";

/* Warehouse pill tone — the handoff prescribes a coloured status dot per
   warehouse role: petrol for a real fulfilment warehouse (HQ / KL WH /
   Kelana showroom), brass for a Cash & Carry / Display face, red for a
   service-return staging pad (goods heading back to a supplier). Derived
   from the warehouse code / name so we don't need a per-row column. */
function warehouseToneOf(w: { code: string; name: string }): "petrol" | "brass" | "red" {
  const s = `${w.code} ${w.name}`.toLowerCase();
  if (s.includes("return") || s.includes("service")) return "red";
  if (s.includes("display") || s.includes("c&c") || s.includes("cash & carry")) return "brass";
  return "petrol";
}
const TONE_HEX = { petrol: "#16695f", brass: "#a16a2e", red: "#b23a3a" } as const;

/* Reason → Badge tone. Design: warning for damage / loss / give-away,
   neutral for returns, success for corrections. Fall back to neutral. */
function reasonTone(reasonCode: string | null): "warning" | "neutral" | "success" | "accent" {
  if (!reasonCode) return "neutral";
  const s = reasonCode.toLowerCase();
  if (/damag|loss|give|lost|expir|writ/.test(s)) return "warning";
  if (/return/.test(s)) return "neutral";
  if (/correct|recount|found/.test(s)) return "success";
  return "accent";
}

type AdjustmentRow = StockAdjustmentDoc & { netQty: number; reasons: string[]; notesText: string };

/* Per-document figures the table shows: net of the signed line qtys, the
   distinct reasons, and the header notes (else the line notes). */
const toRow = (d: StockAdjustmentDoc): AdjustmentRow => ({
  ...d,
  netQty: d.lines.reduce((s, l) => s + l.qty, 0),
  reasons: [...new Set(d.lines.map((l) => l.reason_code).filter((r): r is string => Boolean(r)))],
  notesText: d.notes || d.lines.map((l) => l.notes).filter(Boolean).join("; "),
});

export function StockAdjustments() {
  const navigate = useNavigate();
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");

  useSetBreadcrumbs([
    { label: "Inventory", to: "/scm/inventory" },
    { label: "Stock Adjustments" },
  ]);

  const warehouses = useWarehouses();
  // performed_by is a scm.staff uuid — resolve it, never print the id.
  const { actorNameOf } = useStaffLookup();
  const { data, isLoading, error } = useStockAdjustments({
    warehouseId: warehouseId ?? undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  });

  const wmap = useMemo(
    () => new Map((warehouses.data ?? []).map((w) => [w.id, w])),
    [warehouses.data],
  );

  /* Row filter — server already applied warehouse + date, so we only
     need to whittle by the search query client-side: the document number, or
     any of its lines' SKU / product name. */
  const rows: AdjustmentRow[] = useMemo(() => {
    const all = (data ?? []).map(toRow);
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (d) =>
        d.adjustment_no.toLowerCase().includes(q) ||
        d.lines.some((l) =>
          l.item_code.toLowerCase().includes(q) ||
          (l.product_name ?? "").toLowerCase().includes(q)),
    );
  }, [data, search]);

  /* Warehouse pill counts — how many adjustments fall under each warehouse
     over the current date-filtered ledger. Uses the pre-search `data` so a
     warehouse doesn't visually empty out as the operator types. */
  const countsByWarehouse = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of data ?? []) {
      m.set(row.warehouse_id, (m.get(row.warehouse_id) ?? 0) + 1);
    }
    return m;
  }, [data]);

  /* Stats — computed off the FULL ledger, not the SKU-filtered view, so the
     KPIs stay stable while the operator narrows the table.
       · Adjustments · 30d — count of rows in the last 30 days
       · Net qty delta     — sum(qty); coloured red when negative (more out
                             than in)
       · Damage / loss     — count where reason indicates damage/loss/give
       · Supplier returns  — count where reason indicates a return */
  const stats = useMemo(() => {
    const all = data ?? [];
    const now = new Date();
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    let count30d = 0;
    let netDelta = 0;
    let damage = 0;
    let returns = 0;
    for (const r of all) {
      const created = new Date(r.created_at);
      if (created >= cutoff) count30d += 1;
      for (const l of r.lines) {
        netDelta += l.qty;
        const rc = (l.reason_code ?? "").toLowerCase();
        if (/damag|loss|give|expir|writ/.test(rc)) damage += 1;
        if (/return/.test(rc)) returns += 1;
      }
    }
    return { count30d, netDelta, damage, returns };
  }, [data]);

  const columns: Column<AdjustmentRow>[] = [
    {
      key: "docNo",
      label: "Adjustment No",
      alwaysVisible: true,
      getValue: (d) => d.adjustment_no,
      render: (d) => (
        <span className="font-mono text-[12px] font-semibold text-primary-ink whitespace-nowrap">
          {d.adjustment_no}
        </span>
      ),
    },
    {
      key: "date",
      label: "Date",
      getValue: (d) => d.created_at,
      render: (d) => (
        <span className="font-mono text-[12px] text-ink-secondary whitespace-nowrap">
          {fmtDateTime(d.created_at)}
        </span>
      ),
    },
    {
      key: "warehouse",
      label: "Warehouse",
      getValue: (d) => wmap.get(d.warehouse_id)?.code ?? "—",
      render: (d) => {
        const w = wmap.get(d.warehouse_id);
        if (!w) return <span className="text-ink-muted">—</span>;
        const tone = warehouseToneOf(w);
        return (
          <span className="inline-flex items-center gap-2 whitespace-nowrap text-[12.5px] text-ink-secondary">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: TONE_HEX[tone] }}
            />
            {w.code}
          </span>
        );
      },
    },
    {
      key: "items",
      label: "Items",
      alwaysVisible: true,
      getValue: (d) => d.lines.map((l) => l.item_code).join(", "),
      render: (d) => {
        if (d.lines.length === 0) return <span className="text-ink-muted">—</span>;
        const first = d.lines[0];
        return (
          <span className="text-[13px] text-ink">
            <span className="font-mono text-[12px] font-semibold">{first.item_code}</span>
            {first.product_name ? <span className="text-ink-secondary"> · {first.product_name}</span> : null}
            {d.lines.length > 1 && (
              <span className="ml-1.5 rounded-full bg-surface-2 px-1.5 font-mono text-[10.5px] text-ink-muted">
                +{d.lines.length - 1} more
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: "qty",
      label: "Net Qty",
      align: "right",
      getValue: (d) => d.netQty,
      render: (d) => (
        <span
          className={cn(
            "font-money text-[13px] font-bold whitespace-nowrap",
            d.netQty > 0 ? "text-synced" : d.netQty < 0 ? "text-err" : "text-ink-muted",
          )}
        >
          {d.netQty > 0 ? "+" : ""}
          {fmtQty(d.netQty)}
        </span>
      ),
    },
    {
      key: "reason",
      label: "Reason",
      getValue: (d) => d.reasons.map((r) => adjustmentReasonLabel(r)).join(", "),
      render: (d) => {
        if (d.reasons.length === 0) return <span className="text-ink-muted">—</span>;
        return (
          <span className="inline-flex flex-wrap gap-1">
            {d.reasons.map((r) => (
              <Badge key={r} tone={reasonTone(r)} variant="soft" caseless>
                {adjustmentReasonLabel(r)}
              </Badge>
            ))}
          </span>
        );
      },
    },
    {
      key: "notes",
      label: "Notes",
      getValue: (d) => d.notesText,
      render: (d) => (
        <span className="text-[12px] text-ink-muted">{d.notesText || "—"}</span>
      ),
    },
    {
      key: "performedBy",
      label: "Performed By",
      getValue: (d) => actorNameOf(d.created_by, ""),
      render: (d) => (
        <span className="text-[11px] text-ink-secondary">
          {actorNameOf(d.created_by)}
        </span>
      ),
    },
  ];

  const hasFilter = warehouseId !== null || Boolean(dateFrom) || Boolean(dateTo) || Boolean(search);
  const resetFilters = () => {
    setWarehouseId(null);
    setSearch("");
    setDateFrom("");
    setDateTo("");
  };

  const activeWarehouseList = warehouses.data ?? [];

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Stock Adjustments"
        description="Manual stock corrections across every warehouse — damage, recounts, transfers and supplier returns, fully audit-logged."
        primaryAction={
          <Button
            variant="primary"
            icon={<Plus size={14} strokeWidth={2} />}
            onClick={() => navigate("/scm/stock-adjustments/new")}
          >
            New Adjustment
          </Button>
        }
      />

      {/* KPI strip — Adjustments 30d · Net qty delta · Damage/loss · Supplier returns */}
      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Adjustments · 30d"
          value={String(stats.count30d)}
          subtitle={`across ${activeWarehouseList.length} location${activeWarehouseList.length === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Net qty delta"
          value={
            <span className={cn(stats.netDelta < 0 ? "text-err" : "text-synced")}>
              {stats.netDelta > 0 ? "+" : ""}
              {fmtQty(stats.netDelta)}
            </span>
          }
          subtitle={stats.netDelta < 0 ? "more out than in" : stats.netDelta > 0 ? "more in than out" : "balanced"}
          tone={stats.netDelta < 0 ? "error" : "default"}
        />
        <StatCard
          label="Damage / loss"
          value={String(stats.damage)}
          subtitle="units written off"
          tone="warning"
        />
        <StatCard
          label="Supplier returns"
          value={String(stats.returns)}
          subtitle="pending QC"
        />
      </div>

      {/* Warehouse filter — compact pills, wrap onto multiple rows if needed.
          Each pill: coloured tone dot · name/sub stack · count badge. Active
          state paints dark ink (#13201c) per handoff. */}
      <div className="mt-6">
        <div className="mb-2.5 flex items-center justify-between">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Warehouse · location
          </span>
          <span className="text-[11.5px] text-ink-muted">
            {activeWarehouseList.length} location{activeWarehouseList.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {/* Compact pill rail (owner 2026-08-08: the two-line cards sprawled
              over two ragged rows — same chip idiom as the delivery pages;
              the warehouse NAME moves into the tooltip). */}
          <button
            type="button"
            onClick={() => setWarehouseId(null)}
            title="Every location"
            className={cn(
              "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-[12px] font-semibold transition-colors",
              warehouseId === null
                ? "border-sidebar bg-sidebar text-white"
                : "border-border bg-surface text-ink hover:border-primary/40",
            )}
          >
            All warehouses
            <span className={cn("rounded-full px-1.5 font-mono text-[10.5px]", warehouseId === null ? "bg-white/15" : "bg-surface-2 text-ink-muted")}>
              {(data ?? []).length}
            </span>
          </button>
          {activeWarehouseList.map((w) => {
            const tone = warehouseToneOf(w);
            const active = warehouseId === w.id;
            const count = countsByWarehouse.get(w.id) ?? 0;
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => setWarehouseId(w.id)}
                title={w.name}
                className={cn(
                  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-[12px] font-semibold transition-colors",
                  active
                    ? "border-sidebar bg-sidebar text-white"
                    : "border-border bg-surface text-ink hover:border-primary/40",
                )}
              >
                <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: TONE_HEX[tone] }} />
                {w.code}
                <span className={cn("rounded-full px-1.5 font-mono text-[10.5px]", active ? "bg-white/15" : "bg-surface-2 text-ink-muted")}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Filter row — SKU search + From/To dates + Clear (only when a filter is active). */}
      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <div className="flex h-10 min-w-[280px] flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-3.5">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-ink-muted"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="search"
            className="flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-muted"
            placeholder="Search adjustment no / SKU / description…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label className="inline-flex items-center gap-2">
          <span className="text-[12px] font-semibold text-ink-secondary">From</span>
          <DateField
            fullWidth
            value={dateFrom}
            onChange={(iso) => setDateFrom(iso)}
            className="h-10 w-[150px] rounded-lg border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </label>
        <label className="inline-flex items-center gap-2">
          <span className="text-[12px] font-semibold text-ink-secondary">To</span>
          <DateField
            fullWidth
            value={dateTo}
            onChange={(iso) => setDateTo(iso)}
            className="h-10 w-[150px] rounded-lg border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </label>
        {hasFilter && (
          <button
            type="button"
            onClick={resetFilters}
            className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-border bg-surface px-3.5 text-[12.5px] font-semibold text-ink-secondary hover:border-primary/40 hover:text-primary"
          >
            <X size={14} strokeWidth={2} />
            Clear
          </button>
        )}
      </div>

      {/* Count line — petrol tick + label. */}
      <div className="mt-4 mb-3 flex items-center gap-2.5">
        <span className="inline-block h-4 w-[3px] rounded-sm bg-primary" />
        <span className="text-[12.5px] font-bold uppercase tracking-wider text-ink">
          {isLoading
            ? "Loading…"
            : `${rows.length} adjustment${rows.length === 1 ? "" : "s"} (latest first)`}
        </span>
      </div>

      {error && !isLoading && (
        <div className="mb-4 rounded-lg border border-err/30 bg-err-bg px-3.5 py-2.5 text-[12px] text-err">
          <strong>Failed to load.</strong>{" "}
          {/* authedFetch already humanised `message`; fallback for a non-Error throw. */}
          {error instanceof Error ? error.message : "Something went wrong."}
        </div>
      )}

      {/* Table — DS DataTable with column chooser, CSV export, per-column
          filters and search built-in. */}
      <DataTable<AdjustmentRow>
        tableId="stock-adjustment-docs"
        exportName="stock-adjustments"
        columns={columns}
        rows={rows}
        loading={isLoading}
        getRowKey={(d) => d.id}
        onRowClick={(d) => navigate(`/scm/stock-adjustments/${d.id}`)}
        emptyLabel='No stock adjustments yet — click "+ New Adjustment" to create one.'
      />
    </div>
  );
}
