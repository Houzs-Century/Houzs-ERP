import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { TrendingUp, AlertTriangle, Activity, Smile, Hourglass, ExternalLink, Gauge, LineChart, PieChart } from "lucide-react";
import { StatCard } from "../components/StatCard";
import { DashboardGrid, DashboardPanels, DashboardBreakdown } from "../components/Dashboard";
import { Panel } from "../components/Panel";
import { ListSkeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { useQuery } from "../hooks/useQuery";
import { QualitySummary } from "./QualitySummary";
import { DashboardPeriodPicker, useDashboardPeriod } from "../components/scm-v2/DashboardPeriod";
import { todayMY } from "../vendor/shared/format";
import { Donut, type Slice } from "../components/scm-v2/Charts";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { cn, formatDate } from "../lib/utils";
import { resolutionLabel, stageLabel } from "../components/StatusDot";
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


// Full-width section divider — bold uppercase title + trailing rule.
// Groups the dashboard into scannable bands (Live / Period / Trends …)
// instead of one long flat scroll.
/** Categories typed in different case ("Product defect" / "Product Defect")
 *  are one category. The first spelling seen names it. */
export function mergeByLabel(rows: Slice[]): Slice[] {
  const out = new Map<string, Slice>();
  for (const r of rows) {
    const k = r.label.trim().toLowerCase();
    const cur = out.get(k);
    out.set(k, cur ? { ...cur, value: cur.value + r.value } : { ...r, label: r.label.trim() });
  }
  return [...out.values()];
}

/** A breakdown as a donut, in the same frame as DashboardBreakdown. */
function DonutPanel({ title, data, onPick, picked }: { title: string; data: Slice[]; onPick: (label: string) => void; picked: string | null }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  return (
    <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-stone">
      <div className="mb-4 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{title} <span className="font-normal normal-case tracking-normal">· click one to list its cases below</span></div>
      <Donut size={112} format={(n) => n.toLocaleString()} center={{ value: total.toLocaleString(), label: "cases" }}
        data={data.slice().sort((a, b) => b.value - a.value)} onPick={onPick} picked={picked} />
    </div>
  );
}

/** The cases behind the slice picked on a "What the cases are about" donut,
 *  listed under the donuts (owner 2026-10-20, like Project Overview's breakdown
 *  filtering its project list). */
type WhyPick = { kind: "category" | "resolution"; label: string; value: string };
function WhyCases({ pick, from, to, onClear }: { pick: WhyPick; from: string; to: string; onClear: () => void }) {
  const navigate = useNavigate();
  const [data, setData] = useState<{ cases: DrillCase[]; limited: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setData(null); setErr(null);
    const params = new URLSearchParams({ metric: pick.kind === "category" ? "category_cases" : "resolution_cases", from, to, limit: "500" });
    params.set(pick.kind === "category" ? "category" : "method", pick.value);
    api.get<{ cases: DrillCase[]; limited: boolean }>(`/api/assr/metrics/drill?${params.toString()}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e: unknown) => { if (!cancelled) setErr(e instanceof Error ? e.message : "Could not load the cases"); });
    return () => { cancelled = true; };
  }, [pick.kind, pick.value, from, to]);
  return (
    <div className="mt-3 rounded-lg border border-border bg-surface px-5 py-4 shadow-stone">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-[13px] font-semibold text-ink">{pick.kind === "category" ? "Issue category" : "Resolution method"} · {pick.label}
          <span className="ml-2 text-[11.5px] font-normal text-ink-muted">{data ? `${data.cases.length} case${data.cases.length === 1 ? "" : "s"}${data.limited ? " (first 500)" : ""}` : "Loading…"} · click one to open it</span></div>
        <button type="button" onClick={onClear} className="text-[12px] text-primary hover:underline">Show none</button>
      </div>
      {err ? <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">{err}</div> : !data ? <ListSkeleton rows={4} /> : (
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 bg-surface text-left text-[10.5px] uppercase tracking-wide text-ink-muted">
              <tr><th className="py-1.5 pr-3">ASSR</th><th className="pr-3">Customer</th><th className="pr-3">Supplier</th><th className="pr-3">Stage</th><th className="pr-3">Complaint</th><th className="pr-3">Opened</th><th className="text-right">Age</th></tr>
            </thead>
            <tbody>{data.cases.map((cs) => (
              <tr key={cs.id} className="cursor-pointer border-t border-border-subtle hover:bg-surface-2/50" onClick={() => navigate(`/assr/${cs.id}`)}>
                <td className="whitespace-nowrap py-1.5 pr-3 font-mono font-semibold text-primary">{cs.assr_no}</td>
                <td className="max-w-[180px] truncate pr-3">{cs.customer_name ?? "—"}</td>
                <td className="max-w-[180px] truncate pr-3 text-ink-secondary">{cs.creditor_name ?? cs.creditor_code ?? "—"}</td>
                <td className="whitespace-nowrap pr-3">{stageLabel(cs.stage)}</td>
                <td className="max-w-[320px] truncate pr-3 text-ink-secondary"><span title={cs.complaint_issue ?? ""}>{cs.complaint_issue ?? "—"}</span></td>
                <td className="whitespace-nowrap pr-3 tabular-nums">{cs.complained_date?.slice(0, 10) ?? "—"}</td>
                <td className="whitespace-nowrap text-right tabular-nums">{cs.age_days != null ? `${Math.floor(cs.age_days)} d` : "—"}</td>
              </tr>
            ))}
              {data.cases.length === 0 && <tr><td className="py-2 text-ink-muted" colSpan={7}>No cases.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

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
  const today = todayMY();
  /* This month / quarter / year or a date range, as on every dashboard (owner 2026-10-17). */
  const [period, setPeriod] = useDashboardPeriod(today, "from", "to", []);
  const [drill, setDrill] = useState<DrillState | null>(null);
  const [why, setWhy] = useState<WhyPick | null>(null);

  // OFF-NOT-HIDE: both /metrics and /summary are ORG aggregates gated behind
  // `service_cases.read`. This view is reachable via the Service Cases board
  // (/assr?view=metrics), which a non-director Sales user can open (allowSales
  // route), so firing these would 403 → "Forbidden" toast for them. Gate the
  // fetches so they never fire without the permission; the dashboard renders
  // its empty state instead.
  const canReadMetrics = can("service_cases.read");
  const metrics = useQuery<AssrMetrics>("/api/assr/metrics?from=:&to=:",
    () => api.get(`/api/assr/metrics?from=${period.from}&to=${period.to}`),
    [period.from, period.to],
    { enabled: canReadMetrics }
  );
  // v3.1 — pull the enriched /summary alongside the legacy metrics
  // payload. Both share the same since_days filter so the pulse row
  // and Stage Funnel narrow with the dropdown. CSAT trend on the
  // summary is still a fixed 13-week rolling window (it's a trend
  // chart, not a window-aware stat).
  const summary = useQuery<AssrSummaryV31>("/api/assr/summary?from=:&to=:",
    () => api.get(`/api/assr/summary?from=${period.from}&to=${period.to}`),
    [period.from, period.to],
    { enabled: canReadMetrics }
  );
  /* "Where the cases are" shows EVERY open case, whenever it was opened (owner
     2026-10-17), so the open stages come from an unbounded read; Completed
     stays the period's own count. */
  const summaryAll = useQuery<AssrSummaryV31>("/api/assr/summary?from=:&to=:#all",
    () => api.get(`/api/assr/summary?from=2000-01-01&to=${today}`),
    [today],
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
        <DashboardPeriodPicker period={period} today={today} onChange={setPeriod} />
      </div>

      <QualitySummary from={period.from} to={period.to} periodLabel={period.label} breachNow={s?.breach_count ?? null}
        onDrill={(metric) => setDrill({ metric })}
        funnel={summaryAll.data && summaryAll.data.stage_funnel.length > 0
          ? <StageFunnel data={summaryAll.data.stage_funnel.map((r) => r.stage === "completed" ? (s?.stage_funnel.find((x) => x.stage === "completed") ?? { ...r, total: 0, breached: 0 }) : r)} />
          : <div className="py-4 text-[12px] text-ink-muted">No open cases right now.</div>}
        breakdowns={<>
          <DashboardPanels cols={2}>
            <DonutPanel
              title="Service Issue Categories"
              data={mergeByLabel(m?.issue_categories?.map((r) => ({ label: r.category || "Other", value: r.count, color: null })) ?? [])}
              picked={why?.kind === "category" ? why.label : null}
              onPick={(label) => setWhy(why?.kind === "category" && why.label === label ? null : { kind: "category", label, value: label })}
            />
            <DonutPanel
              title="Resolution Method Mix"
              data={m?.resolutions.map((r) => ({ label: r.method === "unset" ? "Not recorded" : resolutionLabel(r.method), value: r.count, color: r.method === "unset" ? "#c9cdc4" : null })) ?? []}
              picked={why?.kind === "resolution" ? why.label : null}
              onPick={(label) => {
                const method = m?.resolutions.find((r) => (r.method === "unset" ? "Not recorded" : resolutionLabel(r.method)) === label)?.method ?? "unset";
                setWhy(why?.kind === "resolution" && why.label === label ? null : { kind: "resolution", label, value: method });
              }}
            />
          </DashboardPanels>
          {why && <WhyCases pick={why} from={period.from} to={period.to} onClear={() => setWhy(null)} />}
          {s && s.csat_trend.length > 0 && (
            <MetricCard icon={<Smile size={13} />} title="CSAT — 13-week rolling" flat>
              <CsatTrend data={s.csat_trend} />
            </MetricCard>
          )}
        </>}
        repeats={<div className="grid gap-3 lg:grid-cols-2">
          <RepeatList title="Items with 2 or more cases" empty="No item came back twice in this period."
            rows={(m?.repeat_items ?? []).map((r) => ({ key: r.item_code, label: r.item_code, cases: r.cases, latest: r.latest, onClick: () => setDrill({ metric: "item_cases", title: `${r.item_code} — ${r.cases} cases in period`, extra: { item_code: r.item_code } }) }))} />
          <RepeatList title="Customers with 2 or more cases" empty="No customer opened two cases in this period."
            rows={(m?.repeat_customers ?? []).map((r, i) => ({ key: `${r.customer_name}-${i}`, label: r.customer_name, cases: r.cases, latest: r.latest, onClick: () => {
              const extra: Record<string, string> = { customer_name: r.customer_name };
              if (r.phone) extra.phone = r.phone;
              setDrill({ metric: "customer_cases", title: `${r.customer_name} — ${r.cases} cases in period`, extra });
            } }))} />
        </div>} />

      {drill && (
        <DrillPanel
          drill={drill}
          from={period.from}
          to={period.to}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

function RepeatList({ title, empty, rows }: { title: string; empty: string; rows: Array<{ key: string; label: string; cases: number; latest: string; onClick: () => void }> }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
      <div className="border-b border-border px-5 py-3 text-[12.5px] font-semibold text-ink">{title} <span className="font-normal text-ink-muted">· {rows.length} · click to list the cases</span></div>
      {rows.length === 0 ? <div className="px-5 py-4 text-[12px] text-ink-muted">{empty}</div> : (
        <div className="max-h-[320px] overflow-y-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 bg-surface text-[10.5px] uppercase tracking-wide text-ink-muted"><tr><th className="px-5 py-1.5 text-left font-semibold">Name</th><th className="px-3 py-1.5 text-right font-semibold">Cases</th><th className="px-5 py-1.5 text-right font-semibold">Last case</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.key} onClick={r.onClick} className="cursor-pointer border-t border-border hover:bg-bg/60">
                <td className="max-w-[260px] truncate px-5 py-1.5 font-semibold">{r.label}</td>
                <td className="px-3 py-1.5 text-right font-mono font-bold text-err">{r.cases}</td>
                <td className="px-5 py-1.5 text-right text-ink-muted">{formatDate(r.latest)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
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
  complaint_issue?: string | null;
  resolution_method?: string | null;
  creditor_code: string | null;
  creditor_name: string | null;
  age_days: number | null;
  is_breached: number;
};

function DrillPanel({
  drill,
  from,
  to,
  onClose,
}: {
  drill: DrillState;
  from: string;
  to: string;
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
      from,
      to,
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
  }, [drill.metric, from, to, extraKey]);

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
  /* Completed is the end of the pipe, not a place cases wait: it is drawn for
     scale but counts in neither "open", the shares, nor the bottleneck. */
  const openRows = rows.filter((r) => r.stage !== "completed");
  const max = Math.max(...openRows.map((r) => r.total), 1);
  const totalOpen = openRows.reduce((acc, r) => acc + r.total, 0);
  const totalBreached = openRows.reduce((acc, r) => acc + r.breached, 0);

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
          const done = r.stage === "completed";
          const widthPct = Math.min(100, (r.total / max) * 100);
          const breachShare = r.total > 0 ? (r.breached / r.total) * 100 : 0;
          const sharePct = totalOpen > 0 ? Math.round((r.total / totalOpen) * 100) : 0;
          const isPeak = !done && r.total > 0 && r.total === max;
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
                {done ? "done" : r.total > 0 ? `${sharePct}%` : "—"}
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
