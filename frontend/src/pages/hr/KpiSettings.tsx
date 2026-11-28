/* KPI settings (HC-0125): the owner tunes the KPI lines (name, target, weight)
 * and the payout tiers (score range, and the RM a supervisor vs a storekeeper
 * earns). Weights are a share; a week's score is their weighted average, so
 * they need not add to 100%. Scores are on the 1-5 rating scale. */
import { useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { fmtSen } from "../../../../shared/src/vendor/shared/format";
import { Field, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { deleteKpiMetric, deleteKpiTier, rmFromSen, saveKpiMetric, saveKpiTier, senFromRm, type KpiMetric, type KpiTier } from "./hrApi";

type MetricDraft = { id: number | null; name: string; target: string; weightPct: string; active: boolean };
type TierDraft = { id: number | null; label: string; min: string; max: string; supervisorRm: string; staffRm: string };

const num = (s: string) => (Number.isFinite(parseFloat(s)) ? parseFloat(s) : 0);
const toMetricDraft = (m: KpiMetric): MetricDraft => ({ id: m.id, name: m.name, target: m.target, weightPct: String(m.weightBp / 100), active: m.active });
const toTierDraft = (t: KpiTier): TierDraft => ({ id: t.id, label: t.label, min: String(t.minScoreX100 / 100), max: String(t.maxScoreX100 / 100), supervisorRm: rmFromSen(t.supervisorAmountSen), staffRm: rmFromSen(t.staffAmountSen) });

export function KpiSettings({ metrics, tiers, onChanged }: { metrics: KpiMetric[]; tiers: KpiTier[]; onChanged: () => void }) {
  const toast = useToast();
  const dialog = useDialog();
  const [metricDrafts, setMetricDrafts] = useState<MetricDraft[]>(() => metrics.map(toMetricDraft));
  const [tierDrafts, setTierDrafts] = useState<TierDraft[]>(() => tiers.map(toTierDraft));
  const [busy, setBusy] = useState(false);

  const setMetric = (i: number, patch: Partial<MetricDraft>) => setMetricDrafts((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const setTier = (i: number, patch: Partial<TierDraft>) => setTierDrafts((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function saveMetric(d: MetricDraft) {
    if (!d.name.trim()) {
      toast.error("Give the KPI a name.");
      return;
    }
    setBusy(true);
    try {
      await saveKpiMetric(d.id, { name: d.name.trim(), target: d.target.trim(), weightBp: Math.round(num(d.weightPct) * 100), sortOrder: metricDrafts.indexOf(d), active: d.active });
      toast.success("KPI saved");
      onChanged();
    } catch (e) {
      toast.error(errText(e, "Could not save the KPI."));
    } finally {
      setBusy(false);
    }
  }
  async function removeMetric(i: number, d: MetricDraft) {
    if (d.id === null) {
      setMetricDrafts((xs) => xs.filter((_, j) => j !== i));
      return;
    }
    if (!(await dialog.confirm({ title: `Remove "${d.name}"?`, confirmLabel: "Remove", tone: "danger" }))) return;
    try {
      await deleteKpiMetric(d.id);
      toast.success("KPI removed");
      onChanged();
    } catch (e) {
      toast.error(errText(e, "Could not remove the KPI."));
    }
  }
  async function saveTier(d: TierDraft) {
    setBusy(true);
    try {
      await saveKpiTier(d.id, { label: d.label.trim(), minScoreX100: Math.round(num(d.min) * 100), maxScoreX100: Math.round(num(d.max) * 100), supervisorAmountSen: senFromRm(d.supervisorRm), staffAmountSen: senFromRm(d.staffRm), sortOrder: tierDrafts.indexOf(d) });
      toast.success("Tier saved");
      onChanged();
    } catch (e) {
      toast.error(errText(e, "Could not save the tier."));
    } finally {
      setBusy(false);
    }
  }
  async function removeTier(i: number, d: TierDraft) {
    if (d.id === null) {
      setTierDrafts((xs) => xs.filter((_, j) => j !== i));
      return;
    }
    if (!(await dialog.confirm({ title: `Remove the "${d.label}" tier?`, confirmLabel: "Remove", tone: "danger" }))) return;
    try {
      await deleteKpiTier(d.id);
      toast.success("Tier removed");
      onChanged();
    } catch (e) {
      toast.error(errText(e, "Could not remove the tier."));
    }
  }

  const totalWeight = metricDrafts.reduce((s, m) => s + num(m.weightPct), 0);

  return (
    <div className="space-y-6 rounded-md border border-border bg-surface p-4">
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">KPI lines</h3>
          <span className="text-[11px] text-ink-muted">Weights total {totalWeight.toFixed(0)}% (a week's score is their weighted average; equal weights give a plain average).</span>
        </div>
        <div className="space-y-2">
          {metricDrafts.map((d, i) => (
            <div key={d.id ?? `new-${i}`} className="grid grid-cols-[1.4fr_1.8fr_90px_70px_auto] items-end gap-2 max-md:grid-cols-1">
              <Field label="KPI">
                <input className={inputCls} value={d.name} onChange={(e) => setMetric(i, { name: e.target.value })} />
              </Field>
              <Field label="Target / benchmark">
                <input className={inputCls} value={d.target} onChange={(e) => setMetric(i, { target: e.target.value })} />
              </Field>
              <Field label="Weight %">
                <input className={inputCls} value={d.weightPct} inputMode="decimal" onChange={(e) => setMetric(i, { weightPct: e.target.value })} />
              </Field>
              <Field label="Active">
                <input type="checkbox" className="h-4 w-4" checked={d.active} onChange={(e) => setMetric(i, { active: e.target.checked })} aria-label="Active" />
              </Field>
              <span className="flex gap-1 pb-1">
                <button type="button" className={ghostBtn} disabled={busy} onClick={() => void saveMetric(d)} aria-label="Save KPI">
                  <Save size={12} />
                </button>
                <button type="button" className="text-ink-muted hover:text-err" onClick={() => void removeMetric(i, d)} aria-label="Remove KPI">
                  <Trash2 size={14} />
                </button>
              </span>
            </div>
          ))}
        </div>
        <button type="button" className={ghostBtn} onClick={() => setMetricDrafts((xs) => [...xs, { id: null, name: "", target: "", weightPct: "10", active: true }])}>
          <Plus size={11} /> Add KPI
        </button>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Payout tiers</h3>
        <div className="space-y-2">
          {tierDrafts.map((d, i) => (
            <div key={d.id ?? `new-${i}`} className="grid grid-cols-[1.3fr_80px_80px_120px_120px_auto] items-end gap-2 max-md:grid-cols-1">
              <Field label="Tier">
                <input className={inputCls} value={d.label} onChange={(e) => setTier(i, { label: e.target.value })} />
              </Field>
              <Field label="From score">
                <input className={inputCls} value={d.min} inputMode="decimal" onChange={(e) => setTier(i, { min: e.target.value })} />
              </Field>
              <Field label="To score">
                <input className={inputCls} value={d.max} inputMode="decimal" onChange={(e) => setTier(i, { max: e.target.value })} />
              </Field>
              <Field label="Supervisor (RM)">
                <input className={inputCls} value={d.supervisorRm} inputMode="decimal" onChange={(e) => setTier(i, { supervisorRm: e.target.value })} />
              </Field>
              <Field label="Storekeeper (RM)">
                <input className={inputCls} value={d.staffRm} inputMode="decimal" onChange={(e) => setTier(i, { staffRm: e.target.value })} />
              </Field>
              <span className="flex gap-1 pb-1">
                <button type="button" className={ghostBtn} disabled={busy} onClick={() => void saveTier(d)} aria-label="Save tier">
                  <Save size={12} />
                </button>
                <button type="button" className="text-ink-muted hover:text-err" onClick={() => void removeTier(i, d)} aria-label="Remove tier">
                  <Trash2 size={14} />
                </button>
              </span>
            </div>
          ))}
        </div>
        <button type="button" className={ghostBtn} onClick={() => setTierDrafts((xs) => [...xs, { id: null, label: "", min: "0", max: "5", supervisorRm: "0", staffRm: "0" }])}>
          <Plus size={11} /> Add tier
        </button>
        <p className="text-[11px] text-ink-muted">Scores are on the 1.00-5.00 scale. Example: a supervisor at 4.00-4.49 earns {fmtSen(50000)}.</p>
      </section>
    </div>
  );
}
