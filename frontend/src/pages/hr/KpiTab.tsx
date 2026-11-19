/* Employees & Attendance > KPI (HC-0125): the monthly KPI appraisal. Pick a
 * person and month, rate each weighted KPI 1-5 for each week; the final score
 * (the average of the fully rated weeks) lands in a payout tier and the RM it
 * pays (by role) is booked as that month's KPI allowance when you Confirm.
 * Settings (the KPI lines and the payout amounts) are editable below. */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Settings2 } from "lucide-react";
import { useToast } from "../../hooks/useToast";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { computeKpi, KPI_WEEKS, type KpiMetricDef, type KpiRating, type KpiRole, type KpiTierDef } from "../../vendor/shared/hr-kpi";
import { Field, Pill, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { KpiSettings } from "./KpiSettings";
import { confirmKpiReview, saveKpiReview, seedKpiDefault, unconfirmKpiReview, useEmployees, useKpiConfig, useKpiReview } from "./hrApi";

const keyOf = (week: number, metricId: number) => `${week}-${metricId}`;
const fmtScore = (x: number | null) => (x === null ? "—" : (x / 100).toFixed(2));
const WEEKS = Array.from({ length: KPI_WEEKS }, (_, i) => i + 1);

export function KpiTab() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const period = /^\d{4}-\d{2}$/.test(params.get("period") ?? "") ? (params.get("period") as string) : todayMY().slice(0, 7);
  const config = useKpiConfig();
  const employees = useEmployees();
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [role, setRole] = useState<KpiRole>("SUPERVISOR");
  const [ratings, setRatings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const review = useKpiReview(employeeId, period);

  const canManage = config.data?.canManage ?? false;
  const metrics = (config.data?.metrics ?? []).filter((m) => m.active);
  const tiers = config.data?.tiers ?? [];
  const current = review.data?.review ?? null;
  const confirmed = current?.status === "CONFIRMED";
  const locked = review.data?.locked ?? false;
  const readOnly = confirmed || locked || !canManage;

  // Load the picked person's saved grid (or clear it for a fresh month).
  useEffect(() => {
    if (employeeId === null) return;
    const r = review.data?.review;
    if (r) {
      const next: Record<string, string> = {};
      for (const s of r.scores) next[keyOf(s.week, s.metricId)] = String(s.ratingX100 / 100);
      setRatings(next);
      setRole(r.role);
    } else {
      setRatings({});
    }
  }, [review.data, employeeId]);

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

  const setPeriod = (next: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set("period", next);
        return n;
      },
      { replace: true },
    );

  async function save(): Promise<number | null> {
    if (employeeId === null) {
      toast.error("Pick the employee.");
      return null;
    }
    const res = await saveKpiReview({ employeeId, period, role, scores: ratingList });
    return res.id;
  }
  async function onSave() {
    setBusy(true);
    try {
      await save();
      toast.success("KPI draft saved");
      review.reload();
    } catch (e) {
      toast.error(errText(e, "Could not save the KPI."));
    } finally {
      setBusy(false);
    }
  }
  async function onConfirm() {
    setBusy(true);
    try {
      const id = await save();
      if (id === null) return;
      const r = await confirmKpiReview(id);
      toast.success(r.amountSen > 0 ? `Confirmed: ${r.tierLabel ?? ""} ${fmtSen(r.amountSen)}` : `Confirmed: ${r.tierLabel ?? "no payout"}`);
      review.reload();
    } catch (e) {
      toast.error(errText(e, "Could not confirm the KPI."));
    } finally {
      setBusy(false);
    }
  }
  async function onReopen() {
    if (!current) return;
    setBusy(true);
    try {
      await unconfirmKpiReview(current.id);
      toast.success("Reopened");
      review.reload();
    } catch (e) {
      toast.error(errText(e, "Could not reopen the KPI."));
    } finally {
      setBusy(false);
    }
  }

  if (config.loading) return <p className="text-sm text-ink-muted">Loading...</p>;
  if (metrics.length === 0 && tiers.length === 0) {
    return (
      <div className="space-y-3 rounded-md border border-border bg-surface p-4">
        <p className="text-sm">No KPI template yet. Load the default storekeeper-supervisor template (8 KPIs and the payout tiers), then set the RM amounts.</p>
        {canManage && (
          <button
            type="button"
            className={primaryBtn}
            onClick={() => {
              void (async () => {
                try {
                  await seedKpiDefault();
                  toast.success("Default template loaded");
                  config.reload();
                } catch (e) {
                  toast.error(errText(e, "Could not load the template."));
                }
              })();
            }}
          >
            Load default template
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Month" className="w-40">
          <input type="month" className={inputCls} value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} />
        </Field>
        <Field label="Employee" className="w-64">
          <select className={inputCls} value={employeeId ?? ""} onChange={(e) => setEmployeeId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">--</option>
            {(employees.data?.employees ?? [])
              .filter((e) => e.status === "ACTIVE" || e.id === employeeId)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.empNo} {e.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Pay scale" className="w-40">
          <select className={inputCls} value={role} disabled={readOnly} onChange={(e) => setRole(e.target.value === "STAFF" ? "STAFF" : "SUPERVISOR")}>
            <option value="SUPERVISOR">Supervisor</option>
            <option value="STAFF">Storekeeper</option>
          </select>
        </Field>
        {confirmed && <Pill tone="ok">Confirmed</Pill>}
        {locked && <Pill tone="warn">Payroll locked</Pill>}
        {canManage && (
          <button type="button" className={`${ghostBtn} ml-auto`} onClick={() => setShowSettings((s) => !s)}>
            <Settings2 size={12} /> {showSettings ? "Hide settings" : "Settings"}
          </button>
        )}
      </div>

      {showSettings && config.data && <KpiSettings metrics={config.data.metrics} tiers={config.data.tiers} onChanged={() => config.reload()} />}

      {employeeId === null ? (
        <p className="text-sm text-ink-muted">Pick an employee to score their month.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-surface-2 text-left text-[11px] uppercase text-ink-secondary">
                <th className="p-2">KPI</th>
                <th className="p-2">Target</th>
                {WEEKS.map((w) => (
                  <th key={w} className="p-2 text-center">
                    Week {w}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metrics.map((m) => (
                <tr key={m.id} className="border-t border-border">
                  <td className="p-2 align-top">
                    <span className="font-medium">{m.name}</span>
                    <span className="ml-1 text-[11px] text-ink-muted">({Math.round(m.weightBp / 100)}%)</span>
                  </td>
                  <td className="p-2 align-top text-[11px] text-ink-muted">{m.target}</td>
                  {WEEKS.map((w) => (
                    <td key={w} className="p-1 text-center">
                      <input
                        type="number"
                        min={1}
                        max={5}
                        step={0.5}
                        className="w-16 rounded border border-border bg-bg px-1 py-1 text-center"
                        value={ratings[keyOf(w, m.id)] ?? ""}
                        disabled={readOnly}
                        onChange={(e) => setRatings((r) => ({ ...r, [keyOf(w, m.id)]: e.target.value }))}
                        aria-label={`${m.name} week ${w}`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-surface-2 text-[12px]">
                <td className="p-2 font-semibold" colSpan={2}>
                  Weekly score
                </td>
                {computed.weekScores.map((s, i) => (
                  <td key={i} className="p-2 text-center font-mono">
                    {fmtScore(s)}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {employeeId !== null && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface p-3">
          <span className="text-sm">
            Final score <span className="font-mono font-semibold">{fmtScore(computed.finalX100)}</span>
          </span>
          <span className="text-sm">
            Tier <span className="font-semibold">{computed.tierLabel ?? "—"}</span>
          </span>
          <span className="text-sm">
            This month <span className="font-mono font-semibold text-accent">{fmtSen(computed.amountSen)}</span>
          </span>
          <span className="ml-auto flex gap-2">
            {confirmed ? (
              <button type="button" className={ghostBtn} disabled={busy || locked || !canManage} onClick={() => void onReopen()}>
                Reopen
              </button>
            ) : (
              <>
                <button type="button" className={ghostBtn} disabled={busy || readOnly} onClick={() => void onSave()}>
                  Save draft
                </button>
                <button type="button" className={primaryBtn} disabled={busy || readOnly || computed.finalX100 === null} onClick={() => void onConfirm()}>
                  Confirm & pay
                </button>
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
