import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Star, TrendingUp, AlertTriangle, Clock, CheckCircle2, Activity, Smile, Hourglass, ExternalLink, Gauge, LineChart, PieChart } from "lucide-react";
import { FilterPills } from "../components/FilterPills";
import { DataTable, type Column } from "../components/DataTable";
import { StatCard } from "../components/StatCard";
import { DashboardGrid, DashboardPanels, DashboardBreakdown } from "../components/Dashboard";
import { Panel } from "../components/Panel";
import { ListSkeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { cn, formatDate } from "../lib/utils";
import { resolutionLabel } from "../components/StatusDot";
import type { AssrMetrics } from "../types";

// v3.1 enriched summary (mig 074 stage names + new aggregates)
type AssrSummaryV31 = {
  total: number;
  by_stage: { stage: string; count: number }[];
  pending_review_count: number;
  aging_count: number;
  breach_count: number;
  avg_e2e_days: number | null;
  stage_funnel: { stage: string; total: number; breached: number }[];
  csat_trend: { week: string; avg_rating: number; n: number }[];
};

const STAGE_FUNNEL_ORDER = [
  "pending_review",
  "under_verification",
  "pending_solution",
  "pending_supplier_pickup",
  "pending_item_ready",
  "pending_delivery_service",
  "completed",
] as const;

const STAGE_FUNNEL_LABEL: Record<string, string> = {
  pending_review: "Review",
  under_verification: "Verification",
  pending_solution: "Solution",
  pending_supplier_pickup: "Pickup / Return",
  pending_item_ready: "Pending Item Ready",
  pending_delivery_service: "Delivery / Service",
  completed: "Completed",
};

const NCR_LABEL: Record<string, string> = {
  material_defect: "Material Defect",
  workmanship: "Workmanship",
  transit_damage: "Transit Damage",
  design: "Design",
  installation: "Installation",
  customer_misuse: "Customer Misuse",
  other: "Other",
  unclassified: "Unclassified",
};

function ncrLabel(k: string) {
  return NCR_LABEL[k] ?? k;
}

// Drill metric → user-facing panel title. Only metrics listed here
// (and accepted by the backend /metrics/drill endpoint) are clickable.
const DRILL_LABELS: Record<string, string> = {
  pending_review: "Pending Review — cases",
  aging: "Aging > 3 days — cases stuck in a stage",
  breach_now: "SLA Breached now — open cases past deadline",
  open_now: "Open — cases still in progress",
  total_period: "Total cases in period",
  closed_period: "Closed cases in period",
  breach_period: "SLA Breached in period",
  qa_passed: "QA Passed — manager-signed-off cases",
  opening_count: "Opening cases — all open",
  over_1_month: "Open ≥ 30 days",
  over_3_weeks: "Open 21–29 days",
  over_2_weeks: "Open 14–20 days",
};

// Drill state — for metric-only drills (e.g. "pending_review") just the
// metric name is enough. For row-driven drills (Repeat Customers /
// Items) we also carry the row identity + an override title so the
// panel header reads the customer's name instead of a generic label.
type DrillState =
  | { metric: string; title?: string; extra?: Record<string, string> };

// Period filter — calendar-style buckets. Values stay as `since_days`
// (the API contract) so the labels are just the human framing of each
// rolling window: 1 month / 1 quarter / half a year / a year.
const PERIOD_OPTIONS: { value: "30" | "90" | "180" | "365"; label: string }[] = [
  { value: "30", label: "Monthly" },
  { value: "90", label: "Quarterly" },
  { value: "180", label: "Half-year" },
  { value: "365", label: "Yearly" },
];
const PERIOD_LABEL: Record<string, string> = {
  "30": "Monthly",
  "90": "Quarterly",
  "180": "Half-year",
  "365": "Yearly",
};

// Full-width section divider — bold uppercase title + trailing rule.
// Groups the dashboard into scannable bands (Live / Period / Trends …)
// instead of one long flat scroll.
function SectionHeader({
  icon,
  title,
  hint,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div className="mb-3 mt-9 flex items-center gap-2.5 first:mt-0">
      <span className="text-accent">{icon}</span>
      <h2 className="text-[12.5px] font-bold uppercase tracking-wide text-ink">
        {title}
      </h2>
      {hint && (
        <span className="text-[11px] font-medium text-ink-muted">· {hint}</span>
      )}
      <div className="ml-2 h-px flex-1 bg-gradient-to-r from-border to-transparent" />
    </div>
  );
}

// Bordered surface card with a bold icon-led header — the shared chrome
// for every chart / table panel on this page so they read as one family.
// `flush` = header gets a bottom border and the body owns its own padding
// (for tables/lists). `flat` = drop the bottom margin (when laid out in a
// DashboardPanels grid that supplies its own gap).
function MetricCard({
  icon,
  title,
  children,
  flush,
  flat,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  flush?: boolean;
  flat?: boolean;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-surface shadow-stone",
        !flat && "mb-3"
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 px-5",
          flush ? "border-b border-border py-3" : "pt-4"
        )}
      >
        <span className="text-accent">{icon}</span>
        <div className="text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">
          {title}
        </div>
      </div>
      <div className={flush ? "" : "px-5 pb-5 pt-3"}>{children}</div>
    </div>
  );
}

export function ServiceMetrics() {
  const { can } = useAuth();
  const [since, setSince] = useState<"30" | "90" | "180" | "365">("90");
  const [drill, setDrill] = useState<DrillState | null>(null);

  // OFF-NOT-HIDE: both /metrics and /summary are ORG aggregates gated behind
  // `service_cases.read`. This view is reachable via the Service Cases board
  // (/assr?view=metrics), which a non-director Sales user can open (allowSales
  // route), so firing these would 403 → "Forbidden" toast for them. Gate the
  // fetches so they never fire without the permission; the dashboard renders
  // its empty state instead.
  const canReadMetrics = can("service_cases.read");
  const metrics = useQuery<AssrMetrics>("/api/assr/metrics?since_days=:",
    () => api.get(`/api/assr/metrics?since_days=${since}`),
    [since],
    { enabled: canReadMetrics }
  );
  // v3.1 — pull the enriched /summary alongside the legacy metrics
  // payload. Both share the same since_days filter so the pulse row
  // and Stage Funnel narrow with the dropdown. CSAT trend on the
  // summary is still a fixed 13-week rolling window (it's a trend
  // chart, not a window-aware stat).
  const summary = useQuery<AssrSummaryV31>("/api/assr/summary?since_days=:",
    () => api.get(`/api/assr/summary?since_days=${since}`),
    [since],
    { enabled: canReadMetrics }
  );

  const m = metrics.data;
  const h = m?.headline;
  const s = summary.data;

  const completionRate = useMemo(() => {
    if (!h || !h.total) return null;
    return Math.round((h.closed / h.total) * 100);
  }, [h]);

  return (
    <div>
      <div className="mb-5">
        <FilterPills value={since} onChange={setSince} options={PERIOD_OPTIONS} />
      </div>

      {/* ── Live Status — real-time pulse. "What's wrong NOW" sits above
          the windowed period aggregates so dispatchers triage first. ── */}
      <SectionHeader
        icon={<Activity size={15} />}
        title="Live Status"
        hint="Now · all open cases"
      />
      <DashboardGrid cols={4}>
        <StatCard
          label="Review"
          value={s?.pending_review_count != null ? s.pending_review_count.toLocaleString() : "—"}
          subtitle="Cases awaiting triage"
          tone={(s?.pending_review_count ?? 0) > 0 ? "warning" : "default"}
          onClick={() => setDrill({ metric: "pending_review" })}
        />
        <StatCard
          label="Aging > 3 days"
          value={s?.aging_count != null ? s.aging_count.toLocaleString() : "—"}
          subtitle="Open cases stuck in a stage"
          tone={(s?.aging_count ?? 0) > 0 ? "warning" : "default"}
          onClick={() => setDrill({ metric: "aging" })}
        />
        <StatCard
          label="SLA Breached (now)"
          value={s?.breach_count != null ? s.breach_count.toLocaleString() : "—"}
          subtitle="Past deadline, not yet closed"
          tone={(s?.breach_count ?? 0) > 0 ? "error" : "default"}
          onClick={() => setDrill({ metric: "breach_now" })}
        />
        <StatCard
          label="Open"
          value={h?.open_count != null ? h.open_count.toLocaleString() : "—"}
          subtitle="Still in progress"
          onClick={() => setDrill({ metric: "open_now" })}
        />
      </DashboardGrid>

      <MetricCard icon={<Activity size={13} />} title="Stage Funnel">
        {s && s.stage_funnel.length > 0 ? (
          <StageFunnel data={s.stage_funnel} />
        ) : (
          <div className="py-4 text-[12px] text-ink-muted">No open cases right now.</div>
        )}
      </MetricCard>

      {/* ── This Period — windowed aggregates over the selected range. ── */}
      <SectionHeader
        icon={<Gauge size={15} />}
        title="This Period"
        hint={`${PERIOD_LABEL[since]} · ${since}d window`}
      />
      <DashboardGrid cols={4}>
        <StatCard
          label="Total Cases"
          value={h?.total != null ? h.total.toLocaleString() : "—"}
          subtitle={`Period: ${m?.since_days ?? since} days`}
          onClick={() => setDrill({ metric: "total_period" })}
        />
        <StatCard
          label="Completion Rate"
          value={completionRate != null ? `${completionRate}%` : "—"}
          subtitle={h && h.closed != null && h.total != null ? `${h.closed.toLocaleString()} of ${h.total.toLocaleString()} closed` : " "}
          tone={completionRate != null && completionRate >= 80 ? "success" : "default"}
          onClick={() => setDrill({ metric: "closed_period" })}
        />
        <StatCard
          label="SLA Breached"
          value={h?.breached != null ? h.breached.toLocaleString() : "—"}
          subtitle="Open cases past deadline"
          tone={(h?.breached ?? 0) > 0 ? "error" : "default"}
          onClick={() => setDrill({ metric: "breach_period" })}
        />
        <StatCard
          label="Avg Satisfaction"
          value={h?.avg_satisfaction != null ? `${h.avg_satisfaction.toFixed(2)} / 5` : "—"}
          subtitle="Customer rating on close"
        />
      </DashboardGrid>

      <DashboardGrid cols={3}>
        <StatCard
          label="QA Passed"
          value={h?.qa_passed != null ? h.qa_passed.toLocaleString() : "—"}
          subtitle="Cases with manager sign-off"
          onClick={() => setDrill({ metric: "qa_passed" })}
        />
        <StatCard
          label="Avg Resolution"
          value={
            h?.avg_resolution_hours != null
              ? h.avg_resolution_hours >= 24
                ? `${(h.avg_resolution_hours / 24).toFixed(1)}d`
                : `${Math.round(h.avg_resolution_hours)}h`
              : "—"
          }
          subtitle="Created → closed"
        />
        <StatCard
          label="Avg E2E Lead Time"
          value={s?.avg_e2e_days != null ? `${s.avg_e2e_days.toFixed(1)}d` : "—"}
          subtitle="Created → closed (all stages)"
        />
      </DashboardGrid>

      {/* ── Case Duration — mirrors the legacy Excel "Case Duration" tile.
          Bucketed by age of OPEN cases since complained_date. ── */}
      <SectionHeader
        icon={<Hourglass size={15} />}
        title="Case Duration"
        hint="Age of open cases"
      />
      <div className="mb-3">
        <DashboardGrid cols={5}>
          <StatCard
            label="Opening Cases"
            value={m?.case_duration?.opening_count != null
              ? m.case_duration.opening_count.toLocaleString()
              : "—"}
            subtitle="Currently open"
            onClick={() => setDrill({ metric: "opening_count" })}
          />
          <StatCard
            label="Over 1 month"
            value={m?.case_duration?.over_1_month != null
              ? m.case_duration.over_1_month.toLocaleString()
              : "—"}
            subtitle="Aged ≥ 30 days"
            tone={(m?.case_duration?.over_1_month ?? 0) > 0 ? "error" : "default"}
            onClick={() => setDrill({ metric: "over_1_month" })}
          />
          <StatCard
            label="Over 3 weeks"
            value={m?.case_duration?.over_3_weeks != null
              ? m.case_duration.over_3_weeks.toLocaleString()
              : "—"}
            subtitle="21–29 days old"
            tone={(m?.case_duration?.over_3_weeks ?? 0) > 0 ? "warning" : "default"}
            onClick={() => setDrill({ metric: "over_3_weeks" })}
          />
          <StatCard
            label="Over 2 weeks"
            value={m?.case_duration?.over_2_weeks != null
              ? m.case_duration.over_2_weeks.toLocaleString()
              : "—"}
            subtitle="14–20 days old"
            tone={(m?.case_duration?.over_2_weeks ?? 0) > 0 ? "warning" : "default"}
            onClick={() => setDrill({ metric: "over_2_weeks" })}
          />
          <StatCard
            label="Avg / month"
            value={
              m?.case_duration?.avg_per_month != null
                ? m.case_duration.avg_per_month.toFixed(2)
                : "—"
            }
            subtitle="Last 4 months"
          />
        </DashboardGrid>
      </div>

      {/* ── Trends ── */}
      <SectionHeader icon={<LineChart size={15} />} title="Trends" />
      <DashboardPanels cols={2}>
        <MetricCard icon={<Smile size={13} />} title="CSAT — 13-week rolling" flat>
          {s && s.csat_trend.length > 0 ? (
            <CsatTrend data={s.csat_trend} />
          ) : (
            <div className="py-4 text-[12px] text-ink-muted">
              No survey responses in the last 13 weeks.
            </div>
          )}
        </MetricCard>
        <MetricCard icon={<TrendingUp size={13} />} title="Monthly Trend" flat>
          {m && m.monthly_trend.length > 0 ? (
            <Trend data={m.monthly_trend} />
          ) : (
            <div className="py-4 text-[12px] text-ink-muted">Not enough data</div>
          )}
        </MetricCard>
      </DashboardPanels>

      {/* ── Breakdowns ── */}
      <SectionHeader icon={<PieChart size={15} />} title="Breakdowns" />
      <DashboardPanels cols={3}>
        <DashboardBreakdown
          title="Service Issue Categories"
          items={
            m?.issue_categories?.map((r) => ({
              label: r.category || "Other",
              count: r.count,
            })) ?? []
          }
        />
        <DashboardBreakdown
          title="Resolution Method Mix"
          items={m?.resolutions.map((r) => ({ label: resolutionLabel(r.method === "unset" ? null : r.method), count: r.count })) ?? []}
        />
        <DashboardBreakdown
          title="NCR Categories (root-cause)"
          items={m?.ncr.map((r) => ({ label: ncrLabel(r.category), count: r.count })) ?? []}
        />
      </DashboardPanels>

      {/* ── Suppliers & Repeat Issues ── */}
      <SectionHeader
        icon={<AlertTriangle size={15} />}
        title="Suppliers & Repeat Issues"
      />

      {/* Creditor performance */}
      <div className="mb-3 overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <CheckCircle2 size={13} className="text-accent" />
          <div className="text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">
            Creditor Performance
          </div>
        </div>
        {/* Batch 4: pure-display report table → DataTable (sort + column
            show/hide + export on a read-only metrics table). */}
        <DataTable<AssrMetrics["creditor_performance"][number]>
          tableId="service-metrics-creditor"
          layoutFamily="service-metrics-creditor"
          exportName="creditor-performance"
          rows={m ? m.creditor_performance : null}
          loading={!m}
          emptyLabel="No creditor assignments in this period"
          getRowKey={(s) => s.creditor_code}
          columns={[
            {
              key: "creditor", label: "Creditor", getValue: (s) => s.name || s.creditor_code,
              render: (s) => (
                <>
                  <div className="font-semibold">{s.name || s.creditor_code}</div>
                  <div className="font-mono text-[10px] text-ink-muted">{s.creditor_code}</div>
                </>
              ),
            },
            { key: "cases", label: "Cases", align: "right", width: "90px", getValue: (s) => s.total_cases, render: (s) => <span className="font-mono">{s.total_cases}</span> },
            { key: "closed", label: "Closed", align: "right", width: "90px", getValue: (s) => s.closed_cases, render: (s) => <span className="font-mono text-synced">{s.closed_cases}</span> },
            { key: "breached", label: "Breached", align: "right", width: "100px", getValue: (s) => s.breached, render: (s) => <span className={cn("font-mono", s.breached > 0 ? "font-bold text-err" : "text-ink-muted")}>{s.breached}</span> },
            {
              key: "avg", label: "Avg Resolution", align: "right", width: "130px",
              getValue: (s) => s.avg_resolution_hours ?? -1,
              render: (s) => (
                <span className="font-mono">
                  {s.avg_resolution_hours != null
                    ? s.avg_resolution_hours >= 24
                      ? `${(s.avg_resolution_hours / 24).toFixed(1)}d`
                      : `${Math.round(s.avg_resolution_hours)}h`
                    : "—"}
                </span>
              ),
            },
            {
              key: "rating", label: "Rating", align: "right", width: "90px",
              getValue: (s) => s.avg_rating ?? -1,
              render: (s) => s.avg_rating != null ? (
                <span className="inline-flex items-center gap-1">
                  <Star size={10} className="fill-amber-400 text-amber-400" />
                  <span className="font-mono">{s.avg_rating.toFixed(1)}</span>
                </span>
              ) : (
                <span className="text-ink-muted">—</span>
              ),
            },
          ] satisfies Column<AssrMetrics["creditor_performance"][number]>[]}
        />
      </div>

      <DashboardPanels cols={2}>
        {/* Repeat items */}
        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3">
            <AlertTriangle size={13} className="text-err" />
            <div className="text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">
              Repeat-Issue Items (≥ 2 cases)
            </div>
          </div>
          {m && m.repeat_items.length > 0 ? (
            <ul>
              {m.repeat_items.map((r) => (
                <li key={r.item_code} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() =>
                      setDrill({
                        metric: "item_cases",
                        title: `${r.item_code} — ${r.cases} cases in period`,
                        extra: { item_code: r.item_code },
                      })
                    }
                    className="flex w-full items-center gap-3 px-5 py-2 text-left text-[12px] transition-colors hover:bg-bg/60"
                  >
                    <span className="font-mono text-[11px] font-semibold">{r.item_code}</span>
                    <span className="ml-auto text-ink-muted">last: {formatDate(r.latest)}</span>
                    <span className="rounded-full bg-err/10 px-2 py-0.5 text-[11px] font-bold text-err">
                      {r.cases}×
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 py-4 text-[12px] text-ink-muted">No repeat items in this period</div>
          )}
        </div>

        {/* Repeat customers */}
        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3">
            <Clock size={13} className="text-err" />
            <div className="text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">
              Repeat Customers (≥ 2 cases)
            </div>
          </div>
          {m && m.repeat_customers.length > 0 ? (
            <ul>
              {m.repeat_customers.map((r, i) => (
                <li key={i} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() => {
                      const extra: Record<string, string> = { customer_name: r.customer_name };
                      if (r.phone) extra.phone = r.phone;
                      setDrill({
                        metric: "customer_cases",
                        title: `${r.customer_name} — ${r.cases} cases in period`,
                        extra,
                      });
                    }}
                    className="flex w-full items-center gap-3 px-5 py-2 text-left text-[12px] transition-colors hover:bg-bg/60"
                  >
                    <span className="flex-1 truncate font-semibold">{r.customer_name}</span>
                    <span className="text-[11px] text-ink-muted">last: {formatDate(r.latest)}</span>
                    <span className="rounded-full bg-err/10 px-2 py-0.5 text-[11px] font-bold text-err">
                      {r.cases}×
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 py-4 text-[12px] text-ink-muted">No repeat customers in this period</div>
          )}
        </div>
      </DashboardPanels>

      {drill && (
        <DrillPanel
          drill={drill}
          sinceDays={parseInt(since, 10)}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

// ── Metric drill-down panel ────────────────────────────────────
//
// Fetches `/api/assr/metrics/drill?metric=…` and renders the matching
// cases. Mounted only when `drill` is set so the fetch fires once per
// open instead of on every render.

type DrillCase = {
  id: number;
  assr_no: string;
  customer_name: string | null;
  stage: string;
  priority: string | null;
  complained_date: string | null;
  deadline_at: string | null;
  issue_category: string | null;
  creditor_code: string | null;
  creditor_name: string | null;
  age_days: number | null;
  is_breached: number;
};

function DrillPanel({
  drill,
  sinceDays,
  onClose,
}: {
  drill: DrillState;
  sinceDays: number;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [data, setData] = useState<{ cases: DrillCase[]; limited: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Serialise `extra` so the effect re-runs when its values change.
  // String-key form keeps the equality check stable across re-renders.
  const extraKey = drill.extra
    ? Object.entries(drill.extra)
        .map(([k, v]) => `${k}=${v}`)
        .join("&")
    : "";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    const params = new URLSearchParams({
      metric: drill.metric,
      since_days: String(sinceDays),
    });
    if (drill.extra) {
      for (const [k, v] of Object.entries(drill.extra)) params.set(k, v);
    }
    api
      .get<{ cases: DrillCase[]; limited: boolean }>(
        `/api/assr/metrics/drill?${params.toString()}`
      )
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: any) => {
        if (!cancelled) setErr(e?.message || "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [drill.metric, sinceDays, extraKey]);

  const title = drill.title ?? DRILL_LABELS[drill.metric] ?? drill.metric;
  const count = data?.cases.length ?? 0;

  return (
    <Panel
      open
      onClose={onClose}
      title={title}
      subtitle={loading ? "Loading…" : `${count} case${count === 1 ? "" : "s"}${data?.limited ? " (showing first 100)" : ""}`}
      width={560}
    >
      {loading ? (
        <ListSkeleton rows={6} />
      ) : err ? (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          {err}
        </div>
      ) : !data || data.cases.length === 0 ? (
        <EmptyState compact message="No cases match this metric." />
      ) : (
        <ul className="divide-y divide-border">
          {data.cases.map((cs) => (
            <li key={cs.id}>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  navigate(`/assr/${cs.id}`);
                }}
                className="group flex w-full items-start gap-3 px-1 py-2.5 text-left transition-colors hover:bg-bg/60"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] font-semibold text-ink">
                      {cs.assr_no}
                    </span>
                    {cs.is_breached === 1 && (
                      <span className="rounded bg-err/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-err">
                        Breached
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-ink">
                    {cs.customer_name || "—"}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-ink-muted">
                    <span>{STAGE_FUNNEL_LABEL[cs.stage] ?? cs.stage}</span>
                    {cs.complained_date && (
                      <>
                        <span>·</span>
                        <span>{formatDate(cs.complained_date)}</span>
                      </>
                    )}
                    {cs.age_days != null && (
                      <>
                        <span>·</span>
                        <span>{Math.floor(cs.age_days)}d old</span>
                      </>
                    )}
                    {(cs.creditor_name || cs.creditor_code) && (
                      <>
                        <span>·</span>
                        <span className="truncate">{cs.creditor_name || cs.creditor_code}</span>
                      </>
                    )}
                  </div>
                </div>
                <ExternalLink
                  size={12}
                  className="mt-1 shrink-0 text-ink-muted opacity-0 transition-opacity group-hover:opacity-100"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ── Simple trend chart (CSS bar chart, no deps) ─────────────

function Trend({ data }: { data: AssrMetrics["monthly_trend"] }) {
  const max = Math.max(...data.map((d) => Math.max(d.opened, d.closed)), 1);
  return (
    <div className="flex gap-1.5 h-40">
      {/* Columns: stretched to full parent height (default `items-stretch`)
          so the bars area below can use `flex-1` to consume all space minus
          the month label. The earlier `items-end` + child `h-full` combo
          collapsed bars to 0 because the column had no height to inherit. */}
      {data.map((d) => {
        const openedH = (d.opened / max) * 100;
        const closedH = (d.closed / max) * 100;
        return (
          <div
            key={d.month}
            className="flex flex-1 flex-col items-center gap-1"
            title={`${d.month}: ${d.opened} opened, ${d.closed} closed`}
          >
            <div className="flex w-full flex-1 items-end gap-0.5">
              <div
                className="flex-1 rounded-t-sm bg-accent/60 transition-all"
                style={{ height: `${openedH}%`, minHeight: d.opened > 0 ? 2 : 0 }}
              />
              <div
                className="flex-1 rounded-t-sm bg-synced/70 transition-all"
                style={{ height: `${closedH}%`, minHeight: d.closed > 0 ? 2 : 0 }}
              />
            </div>
            <div className="text-[9px] font-mono text-ink-muted">{d.month.slice(5)}</div>
          </div>
        );
      })}
      <div className="ml-3 flex shrink-0 flex-col justify-end gap-1 pb-4 text-[10px] text-ink-muted">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 bg-accent/60" /> Opened</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 bg-synced/70" /> Closed</span>
      </div>
    </div>
  );
}

// ── Stage funnel — where open cases sit in the pipeline ─────────
//
// Each workflow stage is one row. The bar length is the stage's share
// of the busiest stage (so the fullest stage anchors the scale); within
// it the on-track vs SLA-breached split is STACKED (not overlaid) so the
// red segment reads as "of these, N are late". The busiest stage gets a
// subtle brass tint as the at-a-glance bottleneck marker.

function StageFunnel({ data }: { data: AssrSummaryV31["stage_funnel"] }) {
  const byStage = new Map(data.map((d) => [d.stage, d]));
  const rows = STAGE_FUNNEL_ORDER.map((stage, idx) => {
    const row = byStage.get(stage);
    return {
      stage,
      idx,
      label: STAGE_FUNNEL_LABEL[stage],
      total: row?.total ?? 0,
      breached: row?.breached ?? 0,
    };
  });
  const max = Math.max(...rows.map((r) => r.total), 1);
  const totalOpen = rows.reduce((acc, r) => acc + r.total, 0);
  const totalBreached = rows.reduce((acc, r) => acc + r.breached, 0);

  return (
    <div>
      {/* Summary strip — the takeaway before scanning rows. */}
      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-[11px] text-ink-muted">
          <b className="text-[17px] font-bold text-ink">{totalOpen}</b> open in pipeline
        </span>
        {totalBreached > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-err/10 px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wider text-err">
            {totalBreached} breached
          </span>
        )}
      </div>

      <div className="space-y-1">
        {rows.map((r) => {
          const widthPct = (r.total / max) * 100;
          const breachShare = r.total > 0 ? (r.breached / r.total) * 100 : 0;
          const sharePct = totalOpen > 0 ? Math.round((r.total / totalOpen) * 100) : 0;
          const isPeak = r.total > 0 && r.total === max;
          return (
            <div
              key={r.stage}
              className={cn(
                "grid grid-cols-[150px_1fr_44px_38px] items-center gap-3 rounded-md py-1 pl-1.5 pr-1 text-[11px] transition-colors",
                isPeak ? "bg-[#3f6b53]/[0.08]" : "hover:bg-bg/50"
              )}
              title={
                r.total > 0
                  ? `${r.label}: ${r.total} open (${sharePct}%)${r.breached > 0 ? `, ${r.breached} breached` : ""}`
                  : `${r.label}: no open cases`
              }
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-surface-dim font-mono text-[9px] font-bold text-ink-muted">
                  {r.idx + 1}
                </span>
                <span className="truncate font-semibold text-ink">{r.label}</span>
              </div>

              <div className="relative h-[22px] w-full overflow-hidden rounded bg-border/25">
                {r.total > 0 && (
                  <div className="flex h-full" style={{ width: `${widthPct}%` }}>
                    <div
                      className="h-full bg-[#3f6b53]/75 transition-all duration-500"
                      style={{ width: `${100 - breachShare}%` }}
                    />
                    <div
                      className="h-full bg-err/75 transition-all duration-500"
                      style={{ width: `${breachShare}%` }}
                    />
                  </div>
                )}
                {isPeak && (
                  <span className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full bg-surface/90 px-1.5 py-[1px] text-[8px] font-bold uppercase tracking-wider text-[#3f6b53] ring-1 ring-[#3f6b53]/40">
                    Bottleneck
                  </span>
                )}
              </div>

              <div className="flex items-baseline justify-end gap-1 font-mono">
                <span
                  className={cn(
                    "text-[13px] font-bold",
                    r.total > 0 ? "text-ink" : "text-ink-muted/40"
                  )}
                >
                  {r.total}
                </span>
                {r.breached > 0 && (
                  <span className="text-[10px] font-semibold text-err">·{r.breached}</span>
                )}
              </div>

              <div className="text-right font-mono text-[10px] text-ink-muted">
                {r.total > 0 ? `${sharePct}%` : "—"}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] text-ink-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-[#3f6b53]/75" /> On track
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-err/75" /> SLA breached
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="rounded-full bg-surface px-1 text-[8px] font-bold uppercase tracking-wider text-[#3f6b53] ring-1 ring-[#3f6b53]/40">
            Bottleneck
          </span>
          busiest stage
        </span>
        <span className="ml-auto">% = share of all open</span>
      </div>
    </div>
  );
}

// ── CSAT 13-week rolling trend (line chart) ────────────────────

function CsatTrend({ data }: { data: AssrSummaryV31["csat_trend"] }) {
  const max = 5;
  const min = 1;
  const w = 100; // SVG width %; will scale via viewBox
  const h = 60;
  const last13 = data.slice(-13);
  const xStep = last13.length > 1 ? w / (last13.length - 1) : 0;
  const points = last13.map((d, i) => {
    const y = h - ((d.avg_rating - min) / (max - min)) * h;
    return `${i * xStep},${isFinite(y) ? y : h}`;
  });
  const avg = last13.length
    ? last13.reduce((s, d) => s + d.avg_rating, 0) / last13.length
    : null;
  return (
    <div>
      <div className="mb-2 flex items-center gap-3 text-[11px] text-ink-muted">
        <span>Avg: <b className="text-ink">{avg != null ? avg.toFixed(2) : "—"}</b> / 5</span>
        <span>·</span>
        <span>{last13.length} week(s)</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-32 w-full" preserveAspectRatio="none">
        <line x1={0} y1={h} x2={w} y2={h} stroke="currentColor" strokeOpacity={0.1} />
        <polyline
          points={points.join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth={0.6}
          className="text-accent"
        />
        {last13.map((d, i) => {
          const y = h - ((d.avg_rating - min) / (max - min)) * h;
          return (
            <circle
              key={d.week}
              cx={i * xStep}
              cy={isFinite(y) ? y : h}
              r={0.8}
              className="fill-accent"
            >
              <title>{`${d.week}: ${d.avg_rating != null ? d.avg_rating.toFixed(2) : "—"} avg (n=${d.n})`}</title>
            </circle>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[9px] font-mono text-ink-muted">
        {last13.length > 0 && (
          <>
            <span>{last13[0]?.week}</span>
            <span>{last13[last13.length - 1]?.week}</span>
          </>
        )}
      </div>
    </div>
  );
}
