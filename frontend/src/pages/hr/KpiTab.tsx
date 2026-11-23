/* HR · KPI (v3 design — monthly scorecard overview). One row per active
 * employee: their position, each KPI metric as a progress bar, the final score
 * (0-100, the real 1-5 weighted score / 5), and the payout grade (tier). Four
 * stat cards summarise the month. A row opens the scoring drawer, where the real
 * weekly 1-5 scoring, save / confirm / reopen are unchanged — the score, tier and
 * RM it shows are exactly what the server books (computeKpi). "Edit KPI weights"
 * opens the metric/tier settings. Scores come from the real KPI config + reviews. */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useToast } from "../../hooks/useToast";
import { ResizableDrawer } from "../../components/ResizableDrawer";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { computeKpi, finalScoreX100, KPI_WEEKS, resolveTier, type KpiMetricDef, type KpiRating, type KpiRole, type KpiTierDef } from "../../vendor/shared/hr-kpi";
import { errText } from "../pos-admin/posAdminUi";
import { HrPageHeader, hrPrimaryBtn, hrSecondaryBtn } from "./HrPageHeader";
import { Bar, HrTablePage, Person, Tag, type HrCol, type HrStat } from "./HrTablePage";
import { KpiSettings } from "./KpiSettings";
import { confirmKpiReview, saveKpiReview, seedKpiDefault, unconfirmKpiReview, useEmployees, useKpiConfig, useKpiReview, useKpiReviews, type KpiMetric, type KpiReviewRow, type KpiTier } from "./hrApi";

const WEEKS = Array.from({ length: KPI_WEEKS }, (_, i) => i + 1);
const keyOf = (week: number, metricId: number) => `${week}-${metricId}`;
const fmtScore = (x: number | null) => (x === null ? "—" : (x / 100).toFixed(2));
// The real final/metric score is 1-5 x100 (100-500); the scorecard shows it 0-100.
const to100 = (x100: number | null) => (x100 === null ? null : Math.round(x100 / 5));
const METRIC_TONES = ["bg-synced", "bg-time", "bg-learning", "bg-primary", "bg-accent"];
const barTone = (v: number | null): string => (v === null ? "bg-surface-2" : v >= 80 ? "bg-synced" : v >= 70 ? "bg-time" : "bg-err");
const gradeTone = (v: number | null): "ok" | "warn" | "bad" | "muted" => (v === null ? "muted" : v >= 80 ? "ok" : v >= 70 ? "warn" : "bad");
const monthLabel = (ym: string): string => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
};
function metricAvgX100(scores: KpiRating[], metricId: number): number | null {
  const vals = scores.filter((s) => s.metricId === metricId).map((s) => s.ratingX100);
  if (vals.length === 0) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

type Row = { id: number; name: string; empNo: string; position: string; final100: number | null; tierLabel: string | null; metric100: Map<number, number | null> };

export function KpiTab() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const period = /^\d{4}-\d{2}$/.test(params.get("period") ?? "") ? (params.get("period") as string) : todayMY().slice(0, 7);
  const setPeriod = (next: string) => setParams((p) => { const n = new URLSearchParams(p); n.set("period", next); return n; }, { replace: true });

  const config = useKpiConfig();
  const employees = useEmployees();
  const reviews = useKpiReviews(period);
  const [editEmp, setEditEmp] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const canManage = config.data?.canManage ?? false;
  const metrics = (config.data?.metrics ?? []).filter((m) => m.active);
  const tiers = config.data?.tiers ?? [];
  const noTemplate = (config.data?.metrics.length ?? 0) === 0 && tiers.length === 0;
  const metricDefs: KpiMetricDef[] = metrics.map((m) => ({ id: m.id, weightBp: m.weightBp }));
  const tierDefs: KpiTierDef[] = tiers.map((t) => ({ minScoreX100: t.minScoreX100, maxScoreX100: t.maxScoreX100, label: t.label, supervisorAmountSen: t.supervisorAmountSen, staffAmountSen: t.staffAmountSen }));
  const topTier = useMemo(() => [...tiers].sort((a, b) => b.minScoreX100 - a.minScoreX100).at(0) ?? null, [tiers]);

  const reviewByEmp = useMemo(() => {
    const m = new Map<number, KpiReviewRow>();
    for (const r of reviews.data?.reviews ?? []) m.set(r.employeeId, r);
    return m;
  }, [reviews.data]);

  const rows: Row[] = useMemo(() => {
    const active = (employees.data?.employees ?? []).filter((e) => e.status === "ACTIVE");
    return active.map((e) => {
      const scores = reviewByEmp.get(e.id)?.scores ?? [];
      const tier = resolveTier(finalScoreX100(metricDefs, scores), tierDefs);
      const metric100 = new Map<number, number | null>();
      for (const m of metrics) metric100.set(m.id, to100(metricAvgX100(scores, m.id)));
      return { id: e.id, name: e.name, empNo: e.empNo, position: e.position || "—", final100: to100(finalScoreX100(metricDefs, scores)), tierLabel: tier?.label ?? null, metric100 };
    });
  }, [employees.data, reviewByEmp, metrics, metricDefs, tierDefs]);

  const scored = rows.filter((r) => r.final100 !== null);
  const avg = scored.length ? Math.round(scored.reduce((s, r) => s + (r.final100 ?? 0), 0) / scored.length) : null;
  const topCount = topTier ? rows.filter((r) => r.tierLabel === topTier.label).length : 0;
  const attention = scored.filter((r) => (r.final100 ?? 0) < 70).length;
  const metric0 = metrics.at(0) ?? null;
  const metric0Avg = useMemo(() => {
    if (!metric0) return null;
    const vs = rows.map((r) => r.metric100.get(metric0.id)).filter((v): v is number => v != null);
    return vs.length ? Math.round(vs.reduce((a, b) => a + b, 0) / vs.length) : null;
  }, [rows, metric0]);

  const stats: HrStat[] = [
    { label: "Average score", value: () => (avg === null ? "—" : `${avg}`), sub: `${scored.length} of ${rows.length} scored`, bar: "bg-primary" },
    { label: topTier ? `Grade ${topTier.label}` : "Top grade", value: () => topCount, sub: topTier ? `Score ${to100(topTier.minScoreX100)}+` : "—", bar: "bg-synced" },
    { label: "Needs attention", value: () => attention, sub: "Score below 70", bar: "bg-err" },
    { label: metric0 ? metric0.name : "Scored", value: () => (metric0 ? (metric0Avg === null ? "—" : `${metric0Avg}%`) : `${scored.length}/${rows.length}`), sub: metric0 ? "team average" : "have a KPI", bar: "bg-time" },
  ];

  const columns: HrCol<Row>[] = [
    { key: "emp", label: "Employee", render: (r) => <Person name={r.name} sub={r.empNo} /> },
    { key: "pos", label: "Position", render: (r) => <Tag tone="info">{r.position}</Tag> },
    ...metrics.map((m, i) => ({
      key: `m${m.id}`,
      label: m.name,
      render: (r: Row) => {
        const v = r.metric100.get(m.id) ?? null;
        return (
          <span className="flex items-center gap-2">
            <Bar pct={v ?? 0} tone={v == null ? "bg-surface-2" : METRIC_TONES[i % METRIC_TONES.length]} w="w-16" />
            <span className="w-8 text-right font-mono text-[11px] text-ink-secondary">{v == null ? "—" : `${v}%`}</span>
          </span>
        );
      },
    })),
    {
      key: "score",
      label: "Score",
      render: (r) => (
        <span className="flex items-center gap-2">
          <Bar pct={r.final100 ?? 0} tone={barTone(r.final100)} w="w-16" />
          <span className="w-7 text-right font-mono text-[12px] font-semibold text-ink">{r.final100 ?? "—"}</span>
        </span>
      ),
    },
    { key: "grade", label: "Grade", align: "center", render: (r) => (r.tierLabel ? <Tag tone={gradeTone(r.final100)}>{r.tierLabel}</Tag> : <span className="text-ink-muted">—</span>) },
  ];

  const seedDefault = () =>
    void (async () => {
      try { await seedKpiDefault(); toast.success("Default template loaded"); config.reload(); } catch (e) { toast.error(errText(e, "Could not load the template.")); }
    })();

  if (noTemplate && config.data) {
    return (
      <>
        <HrPageHeader title="KPI" subtitle="Monthly scorecard and the KPI-allowance tier it pays" />
        <div className="px-6 py-4">
          <div className="rounded-xl border border-border bg-surface p-5">
            <p className="text-[13px] text-ink">No KPI template yet. Load the default storekeeper-supervisor template (the KPIs and the payout tiers), then set the RM amounts.</p>
            {canManage && <button type="button" className={hrPrimaryBtn + " mt-3"} onClick={seedDefault}>Load default template</button>}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <HrTablePage<Row>
        title="KPI"
        subtitle={`Monthly scorecard · ${monthLabel(period)}`}
        actions={canManage ? <button type="button" className={hrSecondaryBtn} onClick={() => setShowSettings(true)}>Edit KPI weights</button> : undefined}
        stats={stats}
        rows={rows}
        columns={columns}
        searchOf={(r) => `${r.name} ${r.empNo} ${r.position}`}
        searchPlaceholder="Search employee"
        onRowClick={canManage ? (r) => setEditEmp(r.id) : undefined}
        loading={config.loading || employees.loading || reviews.loading}
        error={config.error ?? employees.error ?? reviews.error ?? null}
        emptyLabel="No employees."
        toolbarExtra={<input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} className="h-8 rounded-md border border-border bg-surface-2 px-2 text-[12px] text-ink focus:border-primary focus:outline-none" aria-label="Month" />}
        footer={() => <>Team average <span className="font-semibold text-ink">{avg ?? "—"}</span> / 100</>}
      />
      {editEmp !== null && config.data && (
        <KpiScoreDrawer employeeId={editEmp} period={period} metrics={metrics} tiers={tiers} canManage={canManage} onClose={() => setEditEmp(null)} onSaved={() => reviews.reload()} />
      )}
      {showSettings && config.data && (
        <ResizableDrawer onClose={() => setShowSettings(false)} title="KPI weights & tiers" subtitle="The metrics, their weights, and the payout tiers" storageKey="hr-kpi-settings" defaultWidth={600}>
          <div className="p-4"><KpiSettings metrics={config.data.metrics} tiers={config.data.tiers} onChanged={() => config.reload()} /></div>
        </ResizableDrawer>
      )}
    </>
  );
}

const inp = "w-14 rounded-md border border-border bg-surface-2 px-1 py-1 text-center text-[12px] text-ink focus:border-primary focus:outline-none";
const sel = "h-8 rounded-md border border-border bg-surface-2 px-2 text-[12px] text-ink focus:border-primary focus:outline-none";

function KpiScoreDrawer({ employeeId, period, metrics, tiers, canManage, onClose, onSaved }: {
  employeeId: number;
  period: string;
  metrics: KpiMetric[];
  tiers: KpiTier[];
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const employees = useEmployees();
  const review = useKpiReview(employeeId, period);
  const [role, setRole] = useState<KpiRole>("SUPERVISOR");
  const [ratings, setRatings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const current = review.data?.review ?? null;
  const confirmed = current?.status === "CONFIRMED";
  const locked = review.data?.locked ?? false;
  const readOnly = confirmed || locked || !canManage;

  useEffect(() => {
    const r = review.data?.review;
    if (r) {
      const next: Record<string, string> = {};
      for (const s of r.scores) next[keyOf(s.week, s.metricId)] = String(s.ratingX100 / 100);
      setRatings(next);
      setRole(r.role);
    } else {
      setRatings({});
    }
  }, [review.data]);

  const metricDefs: KpiMetricDef[] = metrics.map((m) => ({ id: m.id, weightBp: m.weightBp }));
  const tierDefs: KpiTierDef[] = tiers.map((t) => ({ minScoreX100: t.minScoreX100, maxScoreX100: t.maxScoreX100, label: t.label, supervisorAmountSen: t.supervisorAmountSen, staffAmountSen: t.staffAmountSen }));
  const ratingList: KpiRating[] = [];
  for (const m of metrics) {
    for (const w of WEEKS) {
      const v = ratings[keyOf(w, m.id)];
      const n = v ? parseFloat(v) : NaN;
      if (Number.isFinite(n)) ratingList.push({ week: w, metricId: m.id, ratingX100: Math.round(n * 100) });
    }
  }
  const computed = computeKpi(metricDefs, ratingList, tierDefs, role);
  const emp = (employees.data?.employees ?? []).find((e) => e.id === employeeId);

  async function save(): Promise<number | null> {
    const res = await saveKpiReview({ employeeId, period, role, scores: ratingList });
    return res.id;
  }
  async function onSaveDraft() {
    setBusy(true);
    try { await save(); toast.success("KPI draft saved"); review.reload(); onSaved(); } catch (e) { toast.error(errText(e, "Could not save the KPI.")); } finally { setBusy(false); }
  }
  async function onConfirm() {
    setBusy(true);
    try {
      const id = await save();
      if (id === null) return;
      const r = await confirmKpiReview(id);
      toast.success(r.amountSen > 0 ? `Confirmed: ${r.tierLabel ?? ""} ${fmtSen(r.amountSen)}` : `Confirmed: ${r.tierLabel ?? "no payout"}`);
      review.reload();
      onSaved();
    } catch (e) { toast.error(errText(e, "Could not confirm the KPI.")); } finally { setBusy(false); }
  }
  async function onReopen() {
    if (!current) return;
    setBusy(true);
    try { await unconfirmKpiReview(current.id); toast.success("Reopened"); review.reload(); onSaved(); } catch (e) { toast.error(errText(e, "Could not reopen the KPI.")); } finally { setBusy(false); }
  }

  return (
    <ResizableDrawer
      onClose={onClose}
      title={emp ? emp.name : "Score KPI"}
      subtitle={`${emp ? `${emp.empNo} · ` : ""}${monthLabel(period)} · rate each KPI 1-5 per week`}
      storageKey="hr-kpi-score-drawer"
      defaultWidth={640}
      footer={
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[12px] text-ink-secondary">Score <span className="font-mono font-semibold text-ink">{fmtScore(computed.finalX100)}</span></span>
          <span className="text-[12px] text-ink-secondary">Grade <span className="font-semibold text-ink">{computed.tierLabel ?? "—"}</span></span>
          <span className="text-[12px] text-ink-secondary">Pays <span className="font-money font-semibold text-accent">{fmtSen(computed.amountSen)}</span></span>
          <span className="ml-auto flex gap-2">
            {confirmed ? (
              <button type="button" className={hrSecondaryBtn} disabled={busy || locked || !canManage} onClick={() => void onReopen()}>Reopen</button>
            ) : (
              <>
                <button type="button" className={hrSecondaryBtn} disabled={busy || readOnly} onClick={() => void onSaveDraft()}>Save draft</button>
                <button type="button" className={hrPrimaryBtn} disabled={busy || readOnly || computed.finalX100 === null} onClick={() => void onConfirm()}>Confirm &amp; pay</button>
              </>
            )}
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[12px] text-ink-secondary">Pay scale
            <select className={sel} value={role} disabled={readOnly} onChange={(e) => setRole(e.target.value === "STAFF" ? "STAFF" : "SUPERVISOR")}>
              <option value="SUPERVISOR">Supervisor</option>
              <option value="STAFF">Storekeeper</option>
            </select>
          </label>
          {confirmed && <Tag tone="ok">Confirmed</Tag>}
          {locked && <Tag tone="warn">Payroll locked</Tag>}
        </div>

        <div className="thin-scroll overflow-x-auto rounded-xl border border-border">
          <table className="w-full border-separate border-spacing-0 text-[12px]">
            <thead>
              <tr className="text-[10px] font-bold uppercase tracking-wide text-ink-muted">
                <th className="border-b border-border-subtle bg-surface-2 px-3 py-2 text-left">KPI</th>
                {WEEKS.map((w) => <th key={w} className="border-b border-border-subtle bg-surface-2 px-2 py-2 text-center">Week {w}</th>)}
              </tr>
            </thead>
            <tbody>
              {metrics.map((m) => (
                <tr key={m.id} className="hover:bg-row-hover">
                  <td className="border-b border-border-subtle px-3 py-2 align-top">
                    <span className="font-semibold text-ink">{m.name}</span> <span className="text-[11px] text-ink-muted">({Math.round(m.weightBp / 100)}%)</span>
                    <span className="block text-[11px] text-ink-muted">{m.target}</span>
                  </td>
                  {WEEKS.map((w) => (
                    <td key={w} className="border-b border-border-subtle px-1 py-1 text-center">
                      <input type="number" min={1} max={5} step={0.5} className={inp} value={ratings[keyOf(w, m.id)] ?? ""} disabled={readOnly} onChange={(e) => setRatings((r) => ({ ...r, [keyOf(w, m.id)]: e.target.value }))} aria-label={`${m.name} week ${w}`} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-surface-2 text-[12px]">
                <td className="border-t border-border-subtle px-3 py-2 font-semibold text-ink">Weekly score</td>
                {computed.weekScores.map((s, i) => <td key={i} className="border-t border-border-subtle px-2 py-2 text-center font-mono text-ink">{fmtScore(s)}</td>)}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </ResizableDrawer>
  );
}
