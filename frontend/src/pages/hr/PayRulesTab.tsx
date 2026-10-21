/* Employees & Attendance > Pay Rules (from Hookka's "Pay Rules (Maintenance)"
 * panel): the rules in force today, the dated changes, and the editor that
 * schedules one, with a worked example that recomputes as you type. */
import { useState } from "react";
import { api } from "../../api/client";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { formatDate } from "../../lib/utils";
import { DateField } from "../../vendor/scm/components/DateField";
import { DEFAULT_PAY_RULES, hhmmToMin, minToHhmm, normalizePayRules, payRulesProblem, type PayRulesConfig } from "../../vendor/shared/hr-pay-rules";
import { Empty, Field, Toggle, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { HR, useEmployees, usePayRules } from "./hrApi";

type Draft = Record<string, string>;

const draftOf = (c: PayRulesConfig): Draft => ({
  effectiveFrom: "",
  dayRateDivisorMode: c.dayRateDivisorMode,
  hourRateDivisorMode: c.hourRateDivisorMode,
  shiftStart: minToHhmm(c.shiftStartMin),
  shiftEnd: minToHhmm(c.shiftEndMin),
  lunchMin: String(c.lunchMin),
  lateGraceMin: String(c.lateGraceMin),
  lateBlockMin: String(c.lateBlockMin),
  otBlockMin: String(c.otBlockMin),
  rateHoursPerDay: String(c.rateHoursPerDay),
  sundayOtMultiplier: String(c.sundayOtMultiplier),
  holidayOtMultiplier: String(c.holidayOtMultiplier),
  absenceGraceWorkingDays: String(c.absenceGraceWorkingDays),
  brokenPunchCreditsFullDay: c.brokenPunchCreditsFullDay ? "true" : "false",
  epfEmployeePct: String(c.epfEmployeePct),
  epfEmployerPct: String(c.epfEmployerPct),
  socsoEmployee: (c.socsoEmployeeSen / 100).toFixed(2),
  socsoEmployer: (c.socsoEmployerSen / 100).toFixed(2),
  eisEmployee: (c.eisEmployeeSen / 100).toFixed(2),
  eisEmployer: (c.eisEmployerSen / 100).toFixed(2),
  note: "",
});

const rulesOf = (d: Draft): PayRulesConfig =>
  normalizePayRules({
    dayRateDivisorMode: d.dayRateDivisorMode,
    hourRateDivisorMode: d.hourRateDivisorMode,
    shiftStartMin: hhmmToMin(d.shiftStart) ?? Number.NaN,
    shiftEndMin: hhmmToMin(d.shiftEnd) ?? Number.NaN,
    lunchMin: d.lunchMin,
    lateGraceMin: d.lateGraceMin,
    lateBlockMin: d.lateBlockMin,
    otBlockMin: d.otBlockMin,
    rateHoursPerDay: d.rateHoursPerDay,
    sundayOtMultiplier: d.sundayOtMultiplier,
    holidayOtMultiplier: d.holidayOtMultiplier,
    absenceGraceWorkingDays: d.absenceGraceWorkingDays,
    brokenPunchCreditsFullDay: d.brokenPunchCreditsFullDay !== "false",
    epfEmployeePct: d.epfEmployeePct,
    epfEmployerPct: d.epfEmployerPct,
    socsoEmployeeSen: Math.round(Number(d.socsoEmployee) * 100),
    socsoEmployerSen: Math.round(Number(d.socsoEmployer) * 100),
    eisEmployeeSen: Math.round(Number(d.eisEmployee) * 100),
    eisEmployerSen: Math.round(Number(d.eisEmployer) * 100),
  });

const dayLabel = (r: PayRulesConfig) => (r.dayRateDivisorMode === "calendarDays" ? "calendar days (28 to 31)" : r.dayRateDivisorMode === "workingDays" ? "the month's working days" : "26 (Days / month)");
const hourLabel = (r: PayRulesConfig) =>
  r.hourRateDivisorMode === "fixed" ? `${r.rateHoursPerDay} (fixed)` : r.hourRateDivisorMode === "hoursOnly" ? "the employee's hours" : `(hours + ${r.lunchMin / 60}h lunch)`;
const rm = (v: number) => `RM${v.toFixed(2)}`;

/* Worked example, RM2,050 on a 9h day in the current month, recomputed from
 * the draft on every keystroke so the effect of a setting is seen before saving. */
function Explainer({ r }: { r: PayRulesConfig }) {
  const S = 2050;
  const now = new Date();
  const calDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  let monSat = 0;
  for (let i = 1; i <= calDays; i++) if (new Date(now.getFullYear(), now.getMonth(), i).getDay() !== 0) monSat++;
  const dayDiv = r.dayRateDivisorMode === "calendarDays" ? calDays : r.dayRateDivisorMode === "workingDays" ? monSat : 26;
  const dayRate = S / dayDiv;
  const hourDiv = r.hourRateDivisorMode === "fixed" ? r.rateHoursPerDay : r.hourRateDivisorMode === "hoursOnly" ? 9 : 9 + r.lunchMin / 60;
  const hourRate = Math.round((dayRate / Math.max(1, hourDiv)) * 100) / 100;
  const lateIn = Number.isFinite(r.shiftStartMin) ? minToHhmm(r.shiftStartMin + r.lateGraceMin + 1) : "--";
  return (
    <div className="rounded-md border border-border bg-bg/50 p-3 text-[11px] leading-relaxed text-ink-secondary">
      <p className="mb-1 font-semibold text-ink">What these settings mean (example: RM2,050 salary, 9h day)</p>
      <p>
        <b>Day rate</b> = 2,050 / {dayDiv} = <b>{rm(dayRate)} a day</b>. Each confirmed absent day deducts this, confirmed after {r.absenceGraceWorkingDays} working day
        {r.absenceGraceWorkingDays === 1 ? "" : "s"}; filling in the hours removes it.
      </p>
      <p className="mt-1">
        <b>Hour rate</b> = {rm(dayRate)} / {hourDiv} = <b>{rm(hourRate)} an hour</b>. It prices lateness, short hours and the OT base.
      </p>
      <p className="mt-1">
        <b>Lateness</b>: in at {lateIn} (1 min past the {r.lateGraceMin}-min grace) is charged {r.lateBlockMin} min = <b>-{rm((r.lateBlockMin / 60) * hourRate)}</b>. Same-day OT
        covers the gap first.
      </p>
      <p className="mt-1">
        <b>Overtime</b> after {Number.isFinite(r.shiftEndMin) ? minToHhmm(r.shiftEndMin) : "--"}, in whole {r.otBlockMin}-min blocks: weekday x1.5 = <b>{rm(hourRate * 1.5)}/h</b>, Sunday x
        {r.sundayOtMultiplier} = <b>{rm(hourRate * r.sundayOtMultiplier)}/h</b>, public holiday x{r.holidayOtMultiplier} = <b>{rm(hourRate * r.holidayOtMultiplier)}/h</b>. Sunday and
        public holiday count every hour of the day.
      </p>
      <p className="mt-1 text-ink-muted">Each employee's own salary, Days / month, Hours / day and weekday OT multiplier come from Employee Master.</p>
    </div>
  );
}

function Summary({ r }: { r: PayRulesConfig }) {
  const box = (title: string, body: React.ReactNode) => (
    <div>
      <p className="mb-1 font-semibold text-ink">{title}</p>
      <p>{body}</p>
    </div>
  );
  const standard = (r.shiftEndMin - r.shiftStartMin - r.lunchMin) / 60;
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-4 text-[11.5px] leading-relaxed text-ink-secondary md:grid-cols-2 lg:grid-cols-3">
      {box("Daily & hourly rate", <>Daily = salary / {dayLabel(r)}. Hourly = daily / {hourLabel(r)}. Absence uses the daily rate; lateness and OT use the hourly rate.</>)}
      {box(
        "Shift & working hours",
        <>
          Shift {minToHhmm(r.shiftStartMin)} to {minToHhmm(r.shiftEndMin)}, {r.lunchMin} min unpaid lunch = <b>{standard.toFixed(1)}h standard day</b>. Working days Mon to Sat, excluding
          public holidays.
        </>,
      )}
      {box("Lateness", <>Up to {r.lateGraceMin} min forgiven. Beyond that, lateness rounds up in {r.lateBlockMin}-min blocks at the hourly rate; same-day OT offsets it first.</>)}
      {box(
        "Overtime",
        <>
          After {minToHhmm(r.shiftEndMin)} only, whole {r.otBlockMin}-min blocks. Weekday x the employee's multiplier; <b>Sunday {r.sundayOtMultiplier}x</b> and{" "}
          <b>public holiday {r.holidayOtMultiplier}x</b> on every hour of the day.
        </>,
      )}
      {box(
        "Absence & forgotten punch",
        <>
          An absent working day = - day rate, confirmed after {r.absenceGraceWorkingDays} working days. Tapped in and out at knock-off:{" "}
          {r.brokenPunchCreditsFullDay ? "counted as a normal day" : "counted as absent"}.
        </>,
      )}
      {box(
        "Statutory",
        <>
          EPF {r.epfEmployeePct}% / {r.epfEmployerPct}%, SOCSO RM{(r.socsoEmployeeSen / 100).toFixed(2)} / {(r.socsoEmployerSen / 100).toFixed(2)}, EIS RM
          {(r.eisEmployeeSen / 100).toFixed(2)} / {(r.eisEmployerSen / 100).toFixed(2)} (employee / employer), for employees with the toggle on.
        </>,
      )}
    </div>
  );
}

export function PayRulesTab() {
  const toast = useToast();
  const dialog = useDialog();
  const rules = usePayRules();
  const canManage = useEmployees().data?.canManage ?? false;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const today = rules.data?.today ?? "";
  const inForce = rules.data?.effectiveToday ?? DEFAULT_PAY_RULES;
  const versions = rules.data?.versions ?? [];
  const field = (k: string, v: string) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const draftRules = draft ? rulesOf(draft) : null;
  const timesOk = !!draft && hhmmToMin(draft.shiftStart) != null && hhmmToMin(draft.shiftEnd) != null;
  const problem = !draft
    ? null
    : !/^\d{4}-\d{2}-\d{2}$/.test(draft.effectiveFrom)
      ? "Pick the date the change takes effect."
      : !timesOk
        ? "Shift times are HH:MM, e.g. 08:00."
        : payRulesProblem(draftRules as PayRulesConfig);

  async function save() {
    if (!draft || problem || !draftRules) return;
    setSaving(true);
    try {
      await api.post(`${HR}/pay-rules`, { effectiveFrom: draft.effectiveFrom, note: draft.note, rules: draftRules });
      toast.success(`Pay rules scheduled from ${formatDate(draft.effectiveFrom)}`);
      setDraft(null);
      rules.reload();
    } catch (e) {
      toast.error(errText(e, "Could not save the pay rules."));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number, from: string) {
    const ok = await dialog.confirm({
      title: `Remove the change from ${formatDate(from)}?`,
      message: "It has not started yet. The rules before it carry on past that date.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`${HR}/pay-rules/${id}`);
      toast.success("Scheduled change removed");
      rules.reload();
    } catch (e) {
      toast.error(errText(e, "Could not remove the change."));
    }
  }

  const num = (k: string, label: string) => (
    <Field key={k} label={label}>
      <input className={inputCls} value={draft?.[k] ?? ""} onChange={(e) => field(k, e.target.value)} inputMode="decimal" />
    </Field>
  );

  return (
    <div className="space-y-4">
      {rules.error && <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">{rules.error}</div>}
      <div className="rounded-md border border-border bg-surface p-3">
        <p className="mb-3 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">In force today{today ? `, ${formatDate(today)}` : ""}</p>
        <Summary r={inForce} />
        <p className="mt-3 border-t border-border-subtle pt-2 text-[11px] text-ink-secondary">
          <b className="text-ink">Where to adjust</b>: per employee (salary with its effective date, Days / month, Hours / day, OT multiplier, statutory toggles) in Employee Master;
          public holidays in Public Holidays; everything else by scheduling a change below. A change takes effect ON its date.
        </p>
      </div>

      <div className="rounded-md border border-border bg-surface p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">Scheduled changes</p>
          {canManage && !draft && (
            <button type="button" className={primaryBtn} onClick={() => setDraft(draftOf(inForce))}>
              Schedule a change
            </button>
          )}
        </div>
        {rules.data && versions.length === 0 && !draft && <Empty>No changes scheduled. The built-in defaults above apply.</Empty>}
        {versions.length > 0 && (
          <ul className="mt-2 space-y-1">
            {versions.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-2 rounded bg-bg/50 px-2 py-1 text-[11px]">
                <span>
                  <b>From {formatDate(v.effectiveFrom)}</b>: day / {v.rules.dayRateDivisorMode === "fixed26" ? "26" : v.rules.dayRateDivisorMode === "calendarDays" ? "calendar" : "working days"},
                  hour / {v.rules.hourRateDivisorMode === "fixed" ? v.rules.rateHoursPerDay : v.rules.hourRateDivisorMode === "hoursOnly" ? "hours" : "hours + lunch"}, Sun{" "}
                  {v.rules.sundayOtMultiplier}x, PH {v.rules.holidayOtMultiplier}x, grace {v.rules.lateGraceMin}m, lunch {v.rules.lunchMin}m, {minToHhmm(v.rules.shiftStartMin)} to{" "}
                  {minToHhmm(v.rules.shiftEndMin)}
                  {v.note ? <span className="text-ink-muted">, {v.note}</span> : null}
                  {v.effectiveFrom > today && <span className="ml-1 text-accent">(starts later)</span>}
                </span>
                {canManage && v.effectiveFrom > today && (
                  <button type="button" className={ghostBtn} onClick={() => void remove(v.id, v.effectiveFrom)}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {draft && draftRules && (
          <div className="mt-3 grid gap-3 rounded-md border border-border p-3 xl:grid-cols-[1fr_340px]">
            <div className="space-y-3">
              <Field label="Effective from" className="max-w-[220px]">
                <DateField fullWidth value={draft.effectiveFrom} onChange={(iso) => field("effectiveFrom", iso)} aria-label="Effective from" />
              </Field>
              <div>
                <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-accent">1 · Day and hour rate</p>
                <div className="grid grid-cols-3 gap-2 max-md:grid-cols-1">
                  <Field label="Day rate = salary / ...">
                    <select className={inputCls} value={draft.dayRateDivisorMode} onChange={(e) => field("dayRateDivisorMode", e.target.value)}>
                      <option value="fixed26">26: Days / month (fixed)</option>
                      <option value="calendarDays">Calendar days (28 to 31)</option>
                      <option value="workingDays">Actual working days of the month</option>
                    </select>
                  </Field>
                  <Field label="Hour rate = day rate / ...">
                    <select className={inputCls} value={draft.hourRateDivisorMode} onChange={(e) => field("hourRateDivisorMode", e.target.value)}>
                      <option value="hoursPlusLunch">Hours + lunch (9 + 1 = 10)</option>
                      <option value="hoursOnly">Hours only (9)</option>
                      <option value="fixed">Fixed number (next box)</option>
                    </select>
                  </Field>
                  {num("rateHoursPerDay", "Fixed / fallback divisor")}
                </div>
              </div>
              <div>
                <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-accent">2 · Shift and lateness</p>
                <div className="grid grid-cols-5 gap-2 max-md:grid-cols-2 max-sm:grid-cols-1">
                  <Field label="Shift start">
                    <input className={inputCls} value={draft.shiftStart} onChange={(e) => field("shiftStart", e.target.value)} placeholder="08:00" />
                  </Field>
                  <Field label="Shift end">
                    <input className={inputCls} value={draft.shiftEnd} onChange={(e) => field("shiftEnd", e.target.value)} placeholder="18:00" />
                  </Field>
                  {num("lunchMin", "Lunch (min)")}
                  {num("lateGraceMin", "Late grace (min)")}
                  {num("lateBlockMin", "Late block (min)")}
                </div>
              </div>
              <div>
                <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-accent">3 · Overtime and absence</p>
                <div className="grid grid-cols-4 gap-2 max-md:grid-cols-2 max-sm:grid-cols-1">
                  {num("otBlockMin", "OT block (min)")}
                  {num("sundayOtMultiplier", "Sunday OT x")}
                  {num("holidayOtMultiplier", "Holiday OT x")}
                  {num("absenceGraceWorkingDays", "Absence grace (working days)")}
                </div>
                <Toggle
                  checked={draft.brokenPunchCreditsFullDay !== "false"}
                  onChange={(v) => field("brokenPunchCreditsFullDay", v ? "true" : "false")}
                  label="Forgot to punch IN: still count the day"
                  hint="Tapped in and out in the same minute at knock-off gets a normal shift instead of an absence. Off = the day is an absence (charged once)."
                />
              </div>
              <details className="rounded-md border border-border bg-bg/50 px-2 py-1.5">
                <summary className="cursor-pointer text-[11px] font-semibold text-ink-secondary">4 · Statutory (EPF / SOCSO / EIS): follows the law, usually leave as is</summary>
                <div className="mt-2 grid grid-cols-3 gap-2 max-md:grid-cols-1">
                  {num("epfEmployeePct", "EPF employee %")}
                  {num("epfEmployerPct", "EPF employer %")}
                  {num("socsoEmployee", "SOCSO employee (RM)")}
                  {num("socsoEmployer", "SOCSO employer (RM)")}
                  {num("eisEmployee", "EIS employee (RM)")}
                  {num("eisEmployer", "EIS employer (RM)")}
                </div>
              </details>
              <Field label="Note (optional)">
                <input className={inputCls} value={draft.note} onChange={(e) => field("note", e.target.value)} />
              </Field>
              <div className="flex items-center gap-2">
                <button type="button" className={primaryBtn} disabled={!!problem || saving} onClick={() => void save()}>
                  {saving ? "Saving..." : "Save scheduled change"}
                </button>
                <button type="button" className={ghostBtn} disabled={saving} onClick={() => setDraft(null)}>
                  Cancel
                </button>
                {problem && <span className="text-[10.5px] text-err">{problem}</span>}
              </div>
              <p className="text-[10.5px] text-ink-muted">Takes effect ON the chosen date for punches, working hours and payroll.</p>
            </div>
            <Explainer r={draftRules} />
          </div>
        )}
      </div>
    </div>
  );
}
