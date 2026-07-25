// ----------------------------------------------------------------------------
// StockAdjustments — list of past manual stock adjustments (write-offs,
// found stock, damage, recount fixes). Read-only ledger at
// /scm/stock-adjustments. + New Adjustment routes to /scm/stock-adjustments/new.
//
// 2026-07-09 REDESIGN per Nick's design_handoff_stock_adjustments handoff —
// Theme C "Ink & Petrol" with real DS components (PageHeader, StatCard,
// DataTable, Badge, Button). Wire preserved: useInventoryMovements(docType:
// 'ADJUSTMENT') + useWarehouses; warehouse pill filter replaces the ugly
// oval strip; StatStrip surfaces at-a-glance metrics (Adjustments · 30d,
// Net qty delta, Damage/loss, Supplier returns).
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, X } from "lucide-react";
import { adjustmentReasonLabel, fmtDate as fmtDateShared, fmtQty } from "@2990s/shared";
import { useWarehouses } from "../../vendor/scm/lib/inventory-queries";
import {
  useInventoryMovements,
  type InventoryMovement,
} from "../../vendor/scm/lib/stock-queries";
import { Button } from "../../components/Button";
import { PageHeader } from "../../components/Layout";
import { StatCard } from "../../components/StatCard";
import { Badge } from "../../components/Badge";
import { DataTable, type Column } from "../../components/DataTable";
import { useSetBreadcrumbs } from "../../hooks/useBreadcrumbs";
import { useStaffLookup } from "../../hooks/useStaffLookup";
import { cn } from "../../lib/utils";

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

const fmtDateTime = (iso: string): string => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const date = fmtDateShared(d);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
};

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
  const { data, isLoading, error } = useInventoryMovements({
    docType: "ADJUSTMENT",
    warehouseId: warehouseId ?? undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  });

  const wmap = useMemo(
    () => new Map((warehouses.data ?? []).map((w) => [w.id, w])),
    [warehouses.data],
  );

  /* Row filter — server already applied warehouse + date, so we only
     need to whittle by the SKU search query client-side. */
  const rows: InventoryMovement[] = useMemo(() => {
    const all = data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (m) =>
        m.product_code.toLowerCase().includes(q) ||
        (m.product_name ?? "").toLowerCase().includes(q),
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
      netDelta += r.qty;
      const rc = (r.reason_code ?? "").toLowerCase();
      if (/damag|loss|give|expir|writ/.test(rc)) damage += 1;
      if (/return/.test(rc)) returns += 1;
    }
    return { count30d, netDelta, damage, returns };
  }, [data]);

  const columns: Column<InventoryMovement>[] = [
    {
      key: "date",
      label: "Date",
      alwaysVisible: true,
      getValue: (m) => m.created_at,
      render: (m) => (
        <span className="font-mono text-[12px] text-ink-secondary whitespace-nowrap">
          {fmtDateTime(m.created_at)}
        </span>
      ),
    },
    {
      key: "warehouse",
      label: "Warehouse",
      getValue: (m) => {
        const w = wmap.get(m.warehouse_id);
        return w ? w.code : "—";
      },
      render: (m) => {
        const w = wmap.get(m.warehouse_id);
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
      key: "sku",
      label: "SKU",
      alwaysVisible: true,
      getValue: (m) => m.product_code,
      render: (m) => (
        <span className="font-mono text-[12px] font-semibold text-primary-ink">
          {m.product_code}
        </span>
      ),
    },
    {
      key: "product",
      label: "Product Name",
      alwaysVisible: true,
      getValue: (m) => m.product_name ?? "",
      render: (m) => (
        <span className="text-[13px] font-medium text-ink">
          {m.product_name ?? "—"}
        </span>
      ),
    },
    {
      key: "qty",
      label: "Qty Delta",
      align: "right",
      getValue: (m) => m.qty,
      render: (m) => (
        <span
          className={cn(
            "font-money text-[13px] font-bold whitespace-nowrap",
            m.qty > 0 ? "text-synced" : m.qty < 0 ? "text-err" : "text-ink-muted",
          )}
        >
          {m.qty > 0 ? "+" : ""}
          {fmtQty(m.qty)}
        </span>
      ),
    },
    {
      key: "reason",
      label: "Reason",
      getValue: (m) => (m.reason_code ? adjustmentReasonLabel(m.reason_code) : ""),
      render: (m) => {
        if (!m.reason_code) return <span className="text-ink-muted">—</span>;
        return (
          <Badge tone={reasonTone(m.reason_code)} variant="soft" caseless>
            {adjustmentReasonLabel(m.reason_code)}
          </Badge>
        );
      },
    },
    {
      key: "notes",
      label: "Notes",
      getValue: (m) => m.notes ?? "",
      render: (m) => (
        <span className="text-[12px] text-ink-muted">{m.notes ?? "—"}</span>
      ),
    },
    {
      key: "performedBy",
      label: "Performed By",
      getValue: (m) => actorNameOf(m.performed_by, ""),
      render: (m) => (
        <span className="text-[11px] text-ink-secondary">
          {actorNameOf(m.performed_by)}
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
        <div className="flex flex-wrap gap-2">
          {/* "All warehouses" default pill */}
          <button
            type="button"
            onClick={() => setWarehouseId(null)}
            className={cn(
              "group inline-flex h-14 shrink-0 items-center gap-2.5 rounded-xl px-3.5 transition-all duration-150",
              warehouseId === null
                ? "border border-sidebar bg-sidebar text-white shadow-slab"
                : "border border-border bg-surface hover:border-primary/40",
            )}
          >
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: TONE_HEX.petrol }}
            />
            <span className="flex flex-col items-start leading-tight">
              <span
                className={cn(
                  "whitespace-nowrap text-[13px] font-bold",
                  warehouseId === null ? "text-white" : "text-ink",
                )}
              >
                All warehouses
              </span>
              <span
                className={cn(
                  "whitespace-nowrap text-[10.5px]",
                  warehouseId === null ? "text-sidebar-ink-muted" : "text-ink-muted",
                )}
              >
                Every location
              </span>
            </span>
            <span
              className={cn(
                "ml-0.5 rounded-full px-2 py-0.5 font-mono text-[11px] font-bold",
                warehouseId === null
                  ? "bg-white/10 text-sidebar-ink"
                  : "bg-surface-2 text-ink-muted",
              )}
            >
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
                className={cn(
                  "group inline-flex h-14 shrink-0 items-center gap-2.5 rounded-xl px-3.5 transition-all duration-150",
                  active
                    ? "border border-sidebar bg-sidebar text-white shadow-slab"
                    : "border border-border bg-surface hover:border-primary/40",
                )}
              >
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: TONE_HEX[tone] }}
                />
                <span className="flex flex-col items-start leading-tight">
                  <span
                    className={cn(
                      "whitespace-nowrap text-[13px] font-bold",
                      active ? "text-white" : "text-ink",
                    )}
                  >
                    {w.code}
                  </span>
                  <span
                    className={cn(
                      "whitespace-nowrap text-[10.5px]",
                      active ? "text-sidebar-ink-muted" : "text-ink-muted",
                    )}
                  >
                    {w.name}
                  </span>
                </span>
                <span
                  className={cn(
                    "ml-0.5 rounded-full px-2 py-0.5 font-mono text-[11px] font-bold",
                    active
                      ? "bg-white/10 text-sidebar-ink"
                      : "bg-surface-2 text-ink-muted",
                  )}
                >
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
            placeholder="Search SKU code / description…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label className="inline-flex items-center gap-2">
          <span className="text-[12px] font-semibold text-ink-secondary">From</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-10 w-[150px] rounded-lg border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </label>
        <label className="inline-flex items-center gap-2">
          <span className="text-[12px] font-semibold text-ink-secondary">To</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
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
      <DataTable<InventoryMovement>
        tableId="stock-adjustments"
        exportName="stock-adjustments"
        columns={columns}
        rows={rows}
        loading={isLoading}
        getRowKey={(m) => m.id}
        emptyLabel='No stock adjustments yet — click "+ New Adjustment" to create one.'
      />
    </div>
  );
}
