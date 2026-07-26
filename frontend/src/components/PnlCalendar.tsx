import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  TrendingUp,
  TrendingDown,
  Info,
  ExternalLink,
  ShoppingCart,
  Layers,
  Wrench,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Panel, PanelSection } from "./Panel";
import { ListSkeleton } from "./Skeleton";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { formatCurrency, formatDate, cn } from "../lib/utils";

/**
 * Cross-module P&L calendar — 12 month cards for a given year with
 * month-level drilldown into the contributing rows.
 *
 * Cash-basis Gross Profit (revenue − direct cost). OpEx is excluded
 * (documented under the grid).
 *
 * Scope filter narrows the data source for per-module views:
 *   • all      — sales_orders revenue + project cost + service cost + PO cost
 *   • sales    — sales_orders revenue only (no cost)
 *   • projects — project_finance_lines cost only (no revenue)
 *   • service  — assr_cases po_amount cost only (no revenue)
 *   • po       — purchase_orders.amount cost only (no revenue)
 */

export type PnlScope = "all" | "sales" | "projects" | "service" | "po";
// "weekly" was supported but rarely used and made the grid noisy at 53
// columns; the backend still accepts it for direct callers but the UI
// only exposes yearly + monthly.
export type PnlGranularity = "yearly" | "monthly";

interface PnlBucket {
  key: string;            // "2024" | "2024-03" | "2024-W12"
  label: string;          // display label
  start: string;          // ISO YYYY-MM-DD
  endExclusive: string;   // ISO YYYY-MM-DD
  revenue: number;
  cost: number;
  gross: number;
  by_source: {
    sales_revenue: number;
    project_cost: number;
    service_cost: number;
    po_cost: number;
  };
}

interface PnlResponse {
  year: number;
  granularity: PnlGranularity;
  scope: PnlScope;
  buckets: PnlBucket[];
  totals: {
    revenue: number;
    cost: number;
    gross: number;
    margin_pct: number | null;
    by_source: {
      sales_revenue: number;
      project_cost: number;
      service_cost: number;
      po_cost: number;
    };
  };
  notes: { excludes: string[]; basis: string; po_missing_price_count?: number };
}

interface PnlBucketDetail {
  start: string;
  end: string;
  sales: Array<{
    doc_no: string;
    debtor_name: string | null;
    doc_date: string;
    local_total: number;
    sales_agent: string | null;
    region: string;
  }>;
  project_cost_lines: Array<{
    id: number;
    project_id: number;
    project_code: string;
    project_name: string;
    category: string;
    description: string | null;
    amount: number;
    anchor_date: string;
  }>;
  service_cases: Array<{
    id: number;
    assr_no: string;
    customer_name: string | null;
    po_amount: number;
    anchor_date: string;
    supplier_name: string | null;
  }>;
  po_lines: Array<{
    doc_no: string;
    item_code: string;
    item_description: string | null;
    creditor_name: string | null;
    anchor_date: string;
    remaining_qty: number | null;
    unit_price: number | null;
    amount: number;
    amount_source: string | null;
  }>;
}

interface Props {
  scope?: PnlScope;
  title?: string;
  subtitle?: string;
  defaultYear?: number;
  defaultGranularity?: PnlGranularity;
  /** Compact mode drops the big header strip (for embedding inside a page tab). */
  compact?: boolean;
}

// Project COGS family (owner's Financial Snapshot model): the legacy `cogs`
// slug plus the three product sub-categories. Used to split project cost into
// COGS vs other cost in the drill-down breakdown — mirrors the backend set in
// routes/projects.ts (/analytics/profitability) and /finance/by-project.
const PROJECT_COGS_CATEGORIES = new Set([
  "cogs",
  "cogs_matt_sofa",
  "cogs_bedframe",
  "cogs_accessories",
]);

export function PnlCalendar({
  scope = "all",
  title,
  subtitle,
  defaultYear,
  defaultGranularity = "monthly",
  compact,
}: Props) {
  const [year, setYear] = useState<number>(defaultYear ?? new Date().getUTCFullYear());
  const [granularity, setGranularity] = useState<PnlGranularity>(defaultGranularity);
  const [openBucket, setOpenBucket] = useState<PnlBucket | null>(null);

  const q = useQuery<PnlResponse>("/api/finance/pnl?year=:&scope=:&granularity=:",
    () => api.get(`/api/finance/pnl?year=${year}&scope=${scope}&granularity=${granularity}`),
    [year, scope, granularity]
  );

  const d = q.data;
  const showRevenue = scope === "all" || scope === "sales";
  const showCost =
    scope === "all" || scope === "projects" || scope === "service" || scope === "po";

  // Scale each bucket's fill bar against the max of whatever metric the
  // scope emphasises — profit for "all", revenue for sales, cost for
  // the cost-only scopes.
  const metric = (b: PnlBucket): number => {
    if (scope === "sales") return b.revenue;
    if (scope === "projects" || scope === "service" || scope === "po") return b.cost;
    return b.gross;
  };
  const maxAbsMetric = d
    ? Math.max(1, ...d.buckets.map((b) => Math.abs(metric(b))))
    : 1;

  // Yearly anchors a 5-year span ending at `year`, no need to navigate
  // by individual year inside that view. Monthly stays year-scoped.
  const totalsLabel = granularity === "yearly" ? "Total" : "YTD";
  const gridClass =
    granularity === "yearly"
      ? "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5"
      : "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4";
  const skeletonCount = granularity === "yearly" ? 5 : 12;

  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-surface shadow-stone",
        compact ? "p-3" : "p-4"
      )}
    >
      {/* Header row */}
      <header className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            P&L ·{" "}
            {showRevenue && showCost
              ? "Gross Profit"
              : showCost
              ? "Cost"
              : "Revenue"}{" "}
            · {scope === "all" ? "All sources" : labelForScope(scope)}
          </div>
          <h3 className="font-display text-[15px] font-bold leading-tight tracking-tight text-ink">
            {title ?? "Profit & Loss"}
          </h3>
          {subtitle && (
            <div className="text-[11px] text-ink-muted">{subtitle}</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Granularity toggle */}
          <div className="inline-flex rounded-md border border-border bg-surface p-0.5">
            {(["yearly", "monthly"] as PnlGranularity[]).map((g) => (
              <button
                key={g}
                onClick={() => setGranularity(g)}
                className={cn(
                  "rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors",
                  granularity === g
                    ? "bg-accent text-white"
                    : "text-ink-secondary hover:text-accent"
                )}
              >
                {g}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setYear((y) => y - 1)}
              className="rounded-md border border-border bg-surface p-1.5 text-ink-secondary hover:border-accent/40 hover:text-accent"
              title={granularity === "yearly" ? "Shift back 1 year" : "Previous year"}
            >
              <ChevronLeft size={14} />
            </button>
            <div className="min-w-[72px] text-center font-mono text-[13px] font-bold">
              {granularity === "yearly" ? `${year - 4}–${year}` : year}
            </div>
            <button
              onClick={() => setYear((y) => y + 1)}
              className="rounded-md border border-border bg-surface p-1.5 text-ink-secondary hover:border-accent/40 hover:text-accent"
              title={granularity === "yearly" ? "Shift forward 1 year" : "Next year"}
            >
              <ChevronRight size={14} />
            </button>
            <button
              onClick={() => setYear(new Date().getUTCFullYear())}
              className="ml-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
            >
              This year
            </button>
          </div>
        </div>
      </header>

      {/* Totals strip */}
      {d && !compact && (
        <div className="mb-3 grid grid-cols-2 gap-2 rounded-md border border-border bg-bg/60 px-3 py-2 sm:grid-cols-4">
          {showRevenue && (
            <TotalCell
              label={`${totalsLabel} Revenue`}
              value={formatCurrency(d.totals.revenue, { compact: true })}
            />
          )}
          {showCost && (
            <TotalCell
              label={`${totalsLabel} Cost`}
              value={formatCurrency(d.totals.cost, { compact: true })}
              tone="err"
            />
          )}
          {showRevenue && showCost && (
            <TotalCell
              label={`${totalsLabel} Gross Profit`}
              value={formatCurrency(d.totals.gross, { compact: true })}
              tone={d.totals.gross >= 0 ? "synced" : "err"}
            />
          )}
          {showRevenue && showCost && (
            <TotalCell
              label={`${totalsLabel} Margin`}
              value={
                d.totals.margin_pct != null
                  ? `${d.totals.margin_pct.toFixed(1)}%`
                  : "—"
              }
              tone={d.totals.margin_pct != null && d.totals.margin_pct >= 0 ? "synced" : "err"}
            />
          )}
        </div>
      )}

      {/* Bucket grid */}
      {q.loading && (
        <div className={gridClass}>
          {Array.from({ length: skeletonCount }, (_, i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-md border border-border bg-surface-dim/40"
            />
          ))}
        </div>
      )}
      {q.error && (
        <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12px] text-err">
          Failed to load P&L: {q.error}
        </div>
      )}
      {d && (
        <div className={gridClass}>
          {d.buckets.map((b) => (
            <BucketCard
              key={b.key}
              bucket={b}
              maxAbs={maxAbsMetric}
              scope={scope}
              onOpen={() => setOpenBucket(b)}
            />
          ))}
        </div>
      )}

      {/* Disclaimers */}
      <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-50/70 px-3 py-2 text-[11px] text-amber-900">
        <Info size={12} className="mt-0.5 shrink-0" />
        <div>
          {showRevenue && showCost ? (
            <>
              <strong>Cash-basis gross profit.</strong>{" "}
              Cost already includes COGS (cost of goods sold) alongside every
              other project cost line, plus service and PO cost. Operating
              expenses (payroll, rent, utilities) are not included.
            </>
          ) : showCost ? (
            <>
              <strong>Total cost — COGS included.</strong>{" "}
              This is every cost line booked to the period: COGS (cost of goods
              sold) plus all other cost categories. Revenue is booked in Sales,
              so no gross profit is shown here.
            </>
          ) : (
            <>
              <strong>Revenue only.</strong>{" "}
              No cost is applied in this view.
            </>
          )}
          {d?.notes?.po_missing_price_count
            ? ` ${d.notes.po_missing_price_count} PO line${d.notes.po_missing_price_count === 1 ? "" : "s"} have no price set — totals may understate cost. Edit on the PO page to fill them in.`
            : ""}
        </div>
      </div>

      {openBucket && (
        <BucketDetailPanel
          bucket={openBucket}
          scope={scope}
          granularity={granularity}
          onClose={() => setOpenBucket(null)}
        />
      )}
    </section>
  );
}

function labelForScope(scope: PnlScope): string {
  switch (scope) {
    case "sales":
      return "Sales revenue";
    case "projects":
      return "Project cost";
    case "service":
      return "Service cost";
    case "po":
      return "Purchase Order cost";
    default:
      return "All sources";
  }
}

function TotalCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "synced" | "err";
}) {
  return (
    <div>
      <div className="text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </div>
      <div
        className={cn(
          "font-mono text-[13px] font-bold",
          tone === "synced" && "text-synced",
          tone === "err" && "text-err",
          !tone && "text-ink"
        )}
      >
        {value}
      </div>
    </div>
  );
}

function BucketCard({
  bucket,
  maxAbs,
  scope,
  onOpen,
}: {
  bucket: PnlBucket;
  maxAbs: number;
  scope: PnlScope;
  onOpen: () => void;
}) {
  const hasAny = bucket.revenue !== 0 || bucket.cost !== 0 || bucket.gross !== 0;
  const isCostScope = scope === "projects" || scope === "service" || scope === "po";
  const metricValue =
    scope === "sales" ? bucket.revenue : isCostScope ? bucket.cost : bucket.gross;
  const barPct = Math.round((Math.abs(metricValue) / maxAbs) * 100);
  const headline =
    scope === "sales" ? bucket.revenue : isCostScope ? -bucket.cost : bucket.gross;
  const toneClass =
    scope === "sales"
      ? "text-synced"
      : isCostScope
      ? "text-err"
      : headline >= 0
      ? "text-synced"
      : "text-err";
  const barClass =
    scope === "sales"
      ? "bg-synced"
      : isCostScope
      ? "bg-err"
      : headline >= 0
      ? "bg-synced"
      : "bg-err";

  return (
    <button
      onClick={onOpen}
      className={cn(
        "group flex flex-col gap-1 rounded-md border border-border bg-surface px-3 py-2 text-left transition-colors",
        hasAny
          ? "hover:border-accent/40 hover:bg-accent-soft/20"
          : "opacity-60 hover:opacity-100"
      )}
    >
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-bold uppercase tracking-brand text-ink-muted">
          {bucket.label}
        </div>
        {hasAny && (
          <span className="text-ink-muted group-hover:text-accent">
            {headline >= 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
          </span>
        )}
      </div>
      {hasAny ? (
        <>
          <div className={cn("font-mono text-[14px] font-extrabold leading-tight", toneClass)}>
            {formatCurrency(headline, { compact: true })}
          </div>
          <div className="h-[3px] w-full overflow-hidden rounded-full bg-bg">
            <div
              className={cn("h-full rounded-full", barClass)}
              style={{ width: `${barPct}%` }}
            />
          </div>
          {scope === "all" ? (
            <div className="text-[9.5px] text-ink-muted">
              <span>Rev {formatCurrency(bucket.revenue, { compact: true })}</span>
              {" · "}
              <span>Cost {formatCurrency(bucket.cost, { compact: true })}</span>
            </div>
          ) : (
            <div className="text-[9.5px] text-ink-muted">click to see breakdown</div>
          )}
        </>
      ) : (
        <div className="font-mono text-[12px] text-ink-muted">—</div>
      )}
    </button>
  );
}

// ── Bucket drill-down side panel ──────────────────────────────

function BucketDetailPanel({
  bucket,
  scope,
  granularity,
  onClose,
}: {
  bucket: PnlBucket;
  scope: PnlScope;
  granularity: PnlGranularity;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const q = useQuery<PnlBucketDetail>("/api/finance/pnl/bucket?start=:&end=:",
    () =>
      api.get(
        `/api/finance/pnl/bucket?start=${bucket.start}&end=${bucket.endExclusive}`
      ),
    [bucket.start, bucket.endExclusive]
  );
  const d = q.data;
  // Common click handler for drill rows — close the panel first then
  // navigate so the back button returns to the page that opened the
  // panel, not back inside the panel.
  function open(href: string) {
    onClose();
    navigate(href);
  }
  const periodLabel =
    granularity === "yearly"
      ? bucket.label
      : `${bucket.label} ${bucket.start.slice(0, 4)}`;

  const showSales = scope === "all" || scope === "sales";
  const showProjects = scope === "all" || scope === "projects";
  const showService = scope === "all" || scope === "service";
  const showPo = scope === "all" || scope === "po";

  const salesTotal = (d?.sales ?? []).reduce((s, r) => s + (r.local_total || 0), 0);
  const projectCostTotal = (d?.project_cost_lines ?? []).reduce(
    (s, r) => s + (r.amount || 0),
    0
  );
  // Split the project cost into COGS vs everything else so the owner's P&L
  // model (Revenue − COGS = GP) is legible in the breakdown. project_cost
  // already INCLUDES the COGS lines — this only partitions the same total.
  const projectCogsTotal = (d?.project_cost_lines ?? [])
    .filter((r) => PROJECT_COGS_CATEGORIES.has(r.category))
    .reduce((s, r) => s + (r.amount || 0), 0);
  const projectOtherCostTotal = projectCostTotal - projectCogsTotal;
  const serviceCostTotal = (d?.service_cases ?? []).reduce(
    (s, r) => s + (r.po_amount || 0),
    0
  );
  const poCostTotal = (d?.po_lines ?? []).reduce((s, r) => s + (r.amount || 0), 0);
  const totalCost = projectCostTotal + serviceCostTotal + poCostTotal;

  return (
    <Panel open onClose={onClose} title={periodLabel} subtitle="P&L breakdown" width={560}>
      {q.loading && <ListSkeleton rows={5} />}
      {q.error && (
        <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12px] text-err">
          {q.error}
        </div>
      )}
      {d && (
        <>
          <div className="mb-4 grid grid-cols-3 gap-3 rounded-md border border-border bg-bg/60 px-3 py-2 text-[11px]">
            <TotalCell label="Revenue" value={formatCurrency(salesTotal, { compact: true })} />
            <TotalCell
              label="Cost"
              value={formatCurrency(totalCost, { compact: true })}
              tone="err"
            />
            <TotalCell
              label="Gross"
              value={formatCurrency(salesTotal - totalCost, { compact: true })}
              tone={salesTotal - totalCost >= 0 ? "synced" : "err"}
            />
          </div>

          {showSales && (
            <PanelSection title={`Sales Orders (${d.sales.length})`}>
              {d.sales.length === 0 ? (
                <div className="text-[11px] text-ink-muted">No sales orders this month.</div>
              ) : (
                <div className="max-h-[280px] overflow-y-auto">
                  <table className="w-full text-[11px]">
                    <thead className="bg-bg/40 text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
                      <tr>
                        <th className="px-2 py-1 text-left">Doc No</th>
                        <th className="px-2 py-1 text-left">Customer</th>
                        <th className="px-2 py-1 text-left">Date</th>
                        <th className="px-2 py-1 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.sales.map((r) => (
                        <tr
                          key={r.doc_no}
                          className="group cursor-pointer border-t border-border-subtle hover:bg-bg/60"
                          onClick={() => open(`/orders/${encodeURIComponent(r.doc_no)}`)}
                          title="Open order"
                        >
                          <td className="px-2 py-1 font-mono text-[10px] text-ink group-hover:text-accent">
                            {r.doc_no}
                          </td>
                          <td className="px-2 py-1 truncate">{r.debtor_name || "—"}</td>
                          <td className="px-2 py-1">{formatDate(r.doc_date)}</td>
                          <td className="px-2 py-1 text-right font-mono font-bold text-synced">
                            {formatCurrency(r.local_total, { compact: true })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="mt-2 text-right text-[11px] font-semibold">
                Subtotal: <span className="font-mono text-synced">{formatCurrency(salesTotal)}</span>
              </div>
            </PanelSection>
          )}

          {showProjects && (
            <PanelSection title={`Project Cost Lines (${d.project_cost_lines.length})`}>
              {d.project_cost_lines.length === 0 ? (
                <div className="text-[11px] text-ink-muted">No project costs this month.</div>
              ) : (
                <div className="max-h-[240px] overflow-y-auto">
                  <ul className="space-y-1">
                    {d.project_cost_lines.map((l) => (
                      <li
                        key={l.id}
                        onClick={() => open(`/projects/${l.project_id}`)}
                        className="group flex cursor-pointer items-start gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] hover:border-accent/40 hover:bg-accent-soft/20"
                        title="Open project"
                      >
                        <Layers size={11} className="mt-0.5 shrink-0 text-accent" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="truncate group-hover:text-accent">{l.project_name}</span>
                          </div>
                          <div className="mt-0.5 text-[10px] text-ink-muted">
                            {l.category}
                            {l.description ? ` · ${l.description}` : ""}
                            {" · "}
                            {formatDate(l.anchor_date)}
                          </div>
                        </div>
                        <span className="shrink-0 font-mono text-[11px] font-bold text-err">
                          −{formatCurrency(l.amount, { compact: true })}
                        </span>
                        <ExternalLink size={11} className="shrink-0 text-ink-muted group-hover:text-accent" />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {/* COGS vs other-cost split — makes the owner's model visible:
                  project cost = COGS + all other project cost lines. */}
              <div className="mt-2 flex flex-wrap items-center justify-end gap-x-3 gap-y-0.5 text-[11px] font-semibold">
                <span className="text-ink-muted">
                  COGS:{" "}
                  <span className="font-mono text-err">{formatCurrency(projectCogsTotal)}</span>
                </span>
                <span className="text-ink-muted">
                  Other:{" "}
                  <span className="font-mono text-err">{formatCurrency(projectOtherCostTotal)}</span>
                </span>
                <span>
                  Subtotal:{" "}
                  <span className="font-mono text-err">{formatCurrency(projectCostTotal)}</span>
                </span>
              </div>
            </PanelSection>
          )}

          {showPo && (
            <PanelSection title={`Purchase Orders (${d.po_lines.length})`}>
              {d.po_lines.length === 0 ? (
                <div className="text-[11px] text-ink-muted">
                  No PO costs this month{d.po_lines.length === 0 && scope === "po" ? " — make sure PO lines have a price set on the PO tab." : "."}
                </div>
              ) : (
                <div className="max-h-[240px] overflow-y-auto">
                  <ul className="space-y-1">
                    {d.po_lines.map((p) => (
                      <li
                        key={`${p.doc_no}|${p.item_code}`}
                        onClick={() => open(`/po/${encodeURIComponent(p.doc_no)}`)}
                        className="group flex cursor-pointer items-start gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] hover:border-accent/40 hover:bg-accent-soft/20"
                        title="Open PO"
                      >
                        <ShoppingCart size={11} className="mt-0.5 shrink-0 text-accent" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="font-mono text-[10px] text-ink-muted">{p.doc_no}</span>
                            <span className="truncate group-hover:text-accent">{p.item_code}</span>
                            {p.amount_source === "manual" && (
                              <span className="rounded bg-accent-soft/60 px-1 text-[8.5px] font-bold uppercase tracking-wider text-accent">
                                manual
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-ink-muted">
                            {p.creditor_name || "no supplier"}
                            {p.item_description ? ` · ${p.item_description}` : ""}
                            {" · "}
                            {formatDate(p.anchor_date)}
                          </div>
                        </div>
                        <span className="shrink-0 font-mono text-[11px] font-bold text-err">
                          −{formatCurrency(p.amount, { compact: true })}
                        </span>
                        <ExternalLink size={11} className="shrink-0 text-ink-muted group-hover:text-accent" />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-2 text-right text-[11px] font-semibold">
                Subtotal: <span className="font-mono text-err">{formatCurrency(poCostTotal)}</span>
              </div>
            </PanelSection>
          )}

          {showService && (
            <PanelSection title={`Service Cases (${d.service_cases.length})`}>
              {d.service_cases.length === 0 ? (
                <div className="text-[11px] text-ink-muted">No service PO costs this month.</div>
              ) : (
                <div className="max-h-[240px] overflow-y-auto">
                  <ul className="space-y-1">
                    {d.service_cases.map((c) => (
                      <li
                        key={c.id}
                        onClick={() => open(`/assr/${c.id}`)}
                        className="group flex cursor-pointer items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] hover:border-accent/40 hover:bg-accent-soft/20"
                        title="Open case"
                      >
                        <Wrench size={11} className="shrink-0 text-accent" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="font-mono text-[10px] text-ink-muted">{c.assr_no}</span>
                            <span className="truncate group-hover:text-accent">{c.customer_name || "—"}</span>
                          </div>
                          <div className="text-[10px] text-ink-muted">
                            {c.supplier_name || "no supplier"} · {formatDate(c.anchor_date)}
                          </div>
                        </div>
                        <span className="shrink-0 font-mono text-[11px] font-bold text-err">
                          −{formatCurrency(c.po_amount, { compact: true })}
                        </span>
                        <ExternalLink size={11} className="shrink-0 text-ink-muted group-hover:text-accent" />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-2 text-right text-[11px] font-semibold">
                Subtotal: <span className="font-mono text-err">{formatCurrency(serviceCostTotal)}</span>
              </div>
            </PanelSection>
          )}
        </>
      )}
    </Panel>
  );
}

// Re-export icons in case pages want to build custom headers around
// the calendar with matching iconography.
export { ShoppingCart, Layers, Wrench };
