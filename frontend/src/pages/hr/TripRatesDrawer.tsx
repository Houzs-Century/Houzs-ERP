import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../../api/client";
import { ResizableDrawer } from "../../components/ResizableDrawer";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { formatDate } from "../../lib/utils";
import { clock12 } from "../../lib/clock12";
import { todayMY } from "../../../../shared/src/vendor/shared/format";
import { DateField } from "../../vendor/scm/components/DateField";
import {
  TRIP_EVENT_LABEL,
  TRIP_EVENT_TYPES,
  TRIP_JOB_LABEL,
  TRIP_JOB_TYPES,
  TRIP_STATES,
  isFairJob,
  normalizeTripRates,
  tripRatesProblem,
  type TripEventType,
  type TripJobType,
  type TripRates,
} from "../../vendor/shared/hr-trip-pay";
import { Field, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { HR, rmFromSen, senFromRm, useTripRates } from "./hrApi";
import { TripStatePicker } from "./TripStatePicker";

type Draft = {
  commission2: string;
  commission3: string;
  cuts: string[];
  cutAfter: string;
  jobs: { jobType: TripJobType; eventType: TripEventType | null; perTrip: string; second: string }[];
  groups: { states: string[]; driver: string; helper: string }[];
  tiers: { after: string; driver: string; helper: string }[];
  nightJobs: TripJobType[];
  minHours: string;
};

const pctText = (bps: number) => String(bps / 100);
const bpsOf = (pct: string) => Math.round(Number(pct) * 100);
const NIGHT_TIMES = Array.from({ length: 13 }, (_, i) => {
  const m = (22 * 60 + i * 30) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
});
const PAYING_JOBS = TRIP_JOB_TYPES.filter((j) => j !== "NONE");

const draftOf = (r: TripRates): Draft => ({
  commission2: pctText(r.commission2Bps),
  commission3: pctText(r.commission3Bps),
  cuts: r.leaveCutBps.map(pctText),
  cutAfter: pctText(r.leaveCutAfterBps),
  jobs: r.jobAllowances.map((a) => ({ jobType: a.jobType, eventType: a.eventType, perTrip: rmFromSen(a.perTripSen), second: a.secondTripSen == null ? "" : rmFromSen(a.secondTripSen) })),
  groups: r.outstation.map((g) => ({ states: [...g.states], driver: rmFromSen(g.driverSen), helper: rmFromSen(g.helperSen) })),
  tiers: r.overnight.tiers.map((t) => ({ after: t.after, driver: rmFromSen(t.driverSen), helper: rmFromSen(t.helperSen) })),
  nightJobs: [...r.overnight.jobTypes],
  minHours: String(r.overnight.minHours),
});

const ratesOf = (d: Draft): TripRates =>
  normalizeTripRates({
    schema: 2,
    commission2Bps: bpsOf(d.commission2),
    commission3Bps: bpsOf(d.commission3),
    leaveCutBps: d.cuts.filter((c) => c.trim() !== "").map(bpsOf),
    leaveCutAfterBps: bpsOf(d.cutAfter),
    jobAllowances: d.jobs.map((j) => ({ jobType: j.jobType, eventType: j.eventType, perTripSen: senFromRm(j.perTrip), secondTripSen: j.second.trim() === "" ? null : senFromRm(j.second) })),
    outstation: d.groups.map((g) => ({ states: g.states, driverSen: senFromRm(g.driver), helperSen: senFromRm(g.helper) })),
    overnight: { tiers: d.tiers.map((t) => ({ after: t.after, driverSen: senFromRm(t.driver), helperSen: senFromRm(t.helper) })), jobTypes: d.nightJobs, minHours: Number(d.minHours) || 0 },
  });

const H3 = ({ n, children }: { n: number; children: string }) => (
  <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">
    {n} {children}
  </h3>
);
const cell = "h-7 w-full rounded border border-border bg-surface px-1.5 text-[11.5px] disabled:opacity-60";
const removeBtn = "text-ink-muted hover:text-err disabled:opacity-40";

export function TripRatesDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const dialog = useDialog();
  const q = useTripRates();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [from, setFrom] = useState(todayMY());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const d = q.data;
  const current = d?.effectiveToday;
  const form = draft ?? (current ? draftOf(current) : null);
  const ro = !d?.canManage;
  const edit = (fn: (f: Draft) => Draft) => setDraft((p) => {
    const base = p ?? form;
    return base ? fn(base) : p;
  });

  const save = async () => {
    if (!form) return;
    const rates = ratesOf(form);
    const problem = tripRatesProblem(rates);
    if (problem) {
      toast.error(problem);
      return;
    }
    setBusy(true);
    try {
      await api.post(`${HR}/trip-rates`, { effectiveFrom: from, rates, note });
      toast.success(`Rates from ${formatDate(from)} saved`);
      setDraft(null);
      q.reload();
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not save the rates."));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: number, effectiveFrom: string) => {
    if (!(await dialog.confirm({ title: `Remove the rates from ${formatDate(effectiveFrom)}?`, confirmLabel: "Remove", tone: "danger" }))) return;
    try {
      await api.del(`${HR}/trip-rates/${id}`);
      toast.success("Rates removed");
      q.reload();
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not remove the rates."));
    }
  };

  const used = new Set(form?.groups.flatMap((g) => g.states) ?? []);
  const free = TRIP_STATES.filter((s) => !used.has(s));
  return (
    <ResizableDrawer
      onClose={onClose}
      title="Trip pay rates"
      subtitle={d ? `In force today; ${d.versions.length ? `${d.versions.length} dated version(s)` : "the defaults"}${current?.legacy ? " (saved before the new rules: computed as before until a new version is saved)" : ""}` : "Loading..."}
      storageKey="hr-trip-rates-drawer"
      defaultWidth={640}
      footer={
        d?.canManage ? (
          <div className="flex flex-wrap items-end justify-end gap-2">
            <Field label="Takes effect" className="w-40">
              <DateField fullWidth value={from} onChange={setFrom} aria-label="Takes effect" />
            </Field>
            <Field label="Note" className="w-48">
              <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <button type="button" className={ghostBtn} onClick={onClose}>
              Close
            </button>
            <button type="button" className={primaryBtn} disabled={busy || !form} onClick={() => void save()}>
              Save rates
            </button>
          </div>
        ) : undefined
      }
    >
      {form && (
        <div className="space-y-4 p-3">
          <section>
            <H3 n={1}>Commission (Delivery orders, % of Local Total)</H3>
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              <Field label="Crew of 2 (%)" hint="1 driver + 1 helper">
                <input className={inputCls} value={form.commission2} disabled={ro} onChange={(e) => edit((f) => ({ ...f, commission2: e.target.value }))} inputMode="decimal" />
              </Field>
              <Field label="Crew of 3 (%)" hint="1 driver + 2 helpers, or 2 drivers + 1 helper">
                <input className={inputCls} value={form.commission3} disabled={ro} onChange={(e) => edit((f) => ({ ...f, commission3: e.target.value }))} inputMode="decimal" />
              </Field>
            </div>
            <div className="mt-2 text-[11px] text-ink-secondary">Missed working day (no punch, no leave): the rate drops by these percentage points, added up.</div>
            <div className="mt-1 flex flex-wrap items-end gap-2">
              {form.cuts.map((c, i) => (
                <Field key={i} label={`Day ${i + 1}`} className="w-24">
                  <span className="flex items-center gap-1">
                    <input className={cell} value={c} disabled={ro} inputMode="decimal" onChange={(e) => edit((f) => ({ ...f, cuts: f.cuts.map((x, j) => (j === i ? e.target.value : x)) }))} />
                    {!ro && (
                      <button type="button" className={removeBtn} aria-label={`Remove day ${i + 1}`} onClick={() => edit((f) => ({ ...f, cuts: f.cuts.filter((_, j) => j !== i) }))}>
                        <Trash2 size={11} />
                      </button>
                    )}
                  </span>
                </Field>
              ))}
              <Field label="Each later day" className="w-24">
                <input className={cell} value={form.cutAfter} disabled={ro} inputMode="decimal" onChange={(e) => edit((f) => ({ ...f, cutAfter: e.target.value }))} />
              </Field>
              {!ro && (
                <button type="button" className={ghostBtn} onClick={() => edit((f) => ({ ...f, cuts: [...f.cuts, f.cutAfter] }))}>
                  <Plus size={11} /> Add day
                </button>
              )}
            </div>
          </section>

          <section>
            <H3 n={2}>Allowance per job (driver)</H3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-[11.5px]">
                <thead className="text-left text-[10px] uppercase tracking-brand text-ink-muted">
                  <tr>
                    <th className="pb-1 font-semibold">Job type</th>
                    <th className="pb-1 font-semibold">Event type</th>
                    <th className="pb-1 font-semibold">Per trip (RM)</th>
                    <th className="pb-1 font-semibold" title="Setup / Dismantle: the 2nd trip of the same driver and lorry that day, or a 2nd venue on the same trip">
                      2nd trip same day (RM)
                    </th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {form.jobs.map((j, i) => {
                    const setJob = (patch: Partial<Draft["jobs"][number]>) => edit((f) => ({ ...f, jobs: f.jobs.map((x, k) => (k === i ? { ...x, ...patch } : x)) }));
                    const fairRow = isFairJob(j.jobType);
                    return (
                      <tr key={i}>
                        <td className="py-0.5 pr-1">
                          <select className={cell} value={j.jobType} disabled={ro} aria-label="Job type" onChange={(e) => {
                            const jobType = e.target.value as TripJobType;
                            setJob({ jobType, eventType: isFairJob(jobType) ? (j.eventType ?? "EXHIBITION") : null, second: isFairJob(jobType) ? j.second : "" });
                          }}>
                            {PAYING_JOBS.map((t) => (
                              <option key={t} value={t}>
                                {TRIP_JOB_LABEL[t]}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-0.5 pr-1">
                          {fairRow ? (
                            <select className={cell} value={j.eventType ?? "EXHIBITION"} disabled={ro} aria-label="Event type" onChange={(e) => setJob({ eventType: e.target.value as TripEventType })}>
                              {TRIP_EVENT_TYPES.map((t) => (
                                <option key={t} value={t}>
                                  {TRIP_EVENT_LABEL[t]}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-ink-muted">-</span>
                          )}
                        </td>
                        <td className="py-0.5 pr-1">
                          <input className={cell} value={j.perTrip} disabled={ro} inputMode="decimal" aria-label="Per trip" onChange={(e) => setJob({ perTrip: e.target.value })} />
                        </td>
                        <td className="py-0.5 pr-1">
                          {fairRow ? (
                            <input className={cell} value={j.second} disabled={ro} inputMode="decimal" placeholder="same" aria-label="2nd trip" onChange={(e) => setJob({ second: e.target.value })} />
                          ) : (
                            <span className="text-ink-muted">-</span>
                          )}
                        </td>
                        <td className="py-0.5 text-right">
                          {!ro && (
                            <button type="button" className={removeBtn} aria-label="Remove job rate" onClick={() => edit((f) => ({ ...f, jobs: f.jobs.filter((_, k) => k !== i) }))}>
                              <Trash2 size={11} />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!ro && (
              <button type="button" className={`${ghostBtn} mt-1`} onClick={() => edit((f) => ({ ...f, jobs: [...f.jobs, { jobType: "SETUP", eventType: "EXHIBITION", perTrip: "", second: "" }] }))}>
                <Plus size={11} /> Add job rate
              </button>
            )}
            <div className="mt-1 text-[10.5px] text-ink-muted">A job type with no row pays no allowance. Helpers earn no job allowance.</div>
          </section>

          <section>
            <H3 n={3}>Outstation (once per person per day, farthest state)</H3>
            <div className="space-y-2">
              {form.groups.map((g, i) => {
                const setGroup = (patch: Partial<Draft["groups"][number]>) => edit((f) => ({ ...f, groups: f.groups.map((x, k) => (k === i ? { ...x, ...patch } : x)) }));
                return (
                  <div key={i} className="grid grid-cols-[1fr_90px_90px_20px] items-start gap-2 rounded-md border border-border p-2 max-sm:grid-cols-2">
                    <div className="max-sm:col-span-2">
                      <TripStatePicker states={g.states} free={free} disabled={ro} onChange={(states) => setGroup({ states })} />
                    </div>
                    <Field label="Driver (RM)">
                      <input className={cell} value={g.driver} disabled={ro} inputMode="decimal" onChange={(e) => setGroup({ driver: e.target.value })} />
                    </Field>
                    <Field label="Helper (RM)">
                      <input className={cell} value={g.helper} disabled={ro} inputMode="decimal" onChange={(e) => setGroup({ helper: e.target.value })} />
                    </Field>
                    {!ro ? (
                      <button type="button" className={`${removeBtn} mt-5`} aria-label={`Remove outstation group ${i + 1}`} onClick={() => edit((f) => ({ ...f, groups: f.groups.filter((_, k) => k !== i) }))}>
                        <Trash2 size={11} />
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                );
              })}
            </div>
            {!ro && (
              <button type="button" className={`${ghostBtn} mt-1`} onClick={() => edit((f) => ({ ...f, groups: [...f.groups, { states: [], driver: "", helper: "" }] }))}>
                <Plus size={11} /> Add group
              </button>
            )}
            <div className="mt-1 text-[11px] text-ink-secondary">Home area (no outstation): {free.length ? free.join(", ") : "none"}</div>
          </section>

          <section>
            <H3 n={4}>Overnight (once per night, highest tier reached)</H3>
            <div className="text-[11px] text-ink-secondary">Applies to a night after a day on which the person ran:</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {PAYING_JOBS.map((j) => {
                const on = form.nightJobs.includes(j);
                return (
                  <button
                    key={j}
                    type="button"
                    disabled={ro}
                    aria-pressed={on}
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${on ? "border-accent bg-accent/10 text-accent" : "border-border text-ink-secondary"}`}
                    onClick={() => edit((f) => ({ ...f, nightJobs: on ? f.nightJobs.filter((x) => x !== j) : [...f.nightJobs, j] }))}
                  >
                    {TRIP_JOB_LABEL[j]}
                  </button>
                );
              })}
            </div>
            <div className="mt-1 text-[10.5px] text-ink-muted">None ticked: every night counts, with or without a trip.</div>
            <div className="mt-2 space-y-1">
              {form.tiers.map((t, i) => {
                const setTier = (patch: Partial<Draft["tiers"][number]>) => edit((f) => ({ ...f, tiers: f.tiers.map((x, k) => (k === i ? { ...x, ...patch } : x)) }));
                return (
                  <div key={i} className="grid grid-cols-[96px_90px_90px_20px] items-end justify-start gap-2 max-sm:grid-cols-2">
                    <Field label="Clock-out after">
                      <select className={cell} value={t.after} disabled={ro} onChange={(e) => setTier({ after: e.target.value })}>
                        {NIGHT_TIMES.map((x) => (
                          <option key={x} value={x}>
                            {clock12(x)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Driver (RM)">
                      <input className={cell} value={t.driver} disabled={ro} inputMode="decimal" onChange={(e) => setTier({ driver: e.target.value })} />
                    </Field>
                    <Field label="Helper (RM)">
                      <input className={cell} value={t.helper} disabled={ro} inputMode="decimal" onChange={(e) => setTier({ helper: e.target.value })} />
                    </Field>
                    {!ro ? (
                      <button type="button" className={`${removeBtn} mb-1.5`} aria-label={`Remove tier ${clock12(t.after)}`} onClick={() => edit((f) => ({ ...f, tiers: f.tiers.filter((_, k) => k !== i) }))}>
                        <Trash2 size={11} />
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                );
              })}
            </div>
            {!ro && (
              <button type="button" className={`${ghostBtn} mt-1`} onClick={() => edit((f) => ({ ...f, tiers: [...f.tiers, { after: NIGHT_TIMES.find((x) => !f.tiers.some((t) => t.after === x)) ?? "22:00", driver: "", helper: "" }] }))}>
                <Plus size={11} /> Add tier
              </button>
            )}
            <Field label="Only if the shift lasted over (hours; 0 = no condition)" className="mt-2 w-64">
              <input className={inputCls} value={form.minHours} disabled={ro} inputMode="decimal" onChange={(e) => edit((f) => ({ ...f, minHours: e.target.value }))} />
            </Field>
          </section>

          {d && d.versions.length > 0 && (
            <section>
              <h3 className="mb-1 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">Dated versions</h3>
              {d.versions.map((v) => (
                <div key={v.id} className="flex items-center justify-between py-0.5 text-[12px]">
                  <span>
                    From <span className="font-mono">{formatDate(v.effectiveFrom)}</span>
                    {v.rates.legacy ? " · old rules" : ""}
                    {v.note ? ` · ${v.note}` : ""}
                  </span>
                  {d.canManage && (
                    <button type="button" className="text-ink-muted hover:text-err" aria-label={`Remove rates from ${v.effectiveFrom}`} onClick={() => void remove(v.id, v.effectiveFrom)}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </ResizableDrawer>
  );
}
