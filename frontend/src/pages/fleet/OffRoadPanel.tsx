// Off the road, from the lorry (backlog #5459): staff take a lorry out of service and
// put it back. The window lands in the same table Fleet Health's status, the delivery
// planning fleet board and Lorry Capacity read, so the lorry stops being offered there.
// Dates only: the table stores days, not times. Errors and the confirm are inline,
// not dialogs: /fleet-health/:lorryId is not inside the SCM shell that provides them.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import { DateField } from "../../vendor/scm/components/DateField";
import { todayMyt } from "../../vendor/scm/lib/dates";
import { OffRoadList } from "./OffRoadList";
import type { OffRoadRow, OffRoadWindow } from "./fleetHealthModel";

type Payload = { today: string; windows: OffRoadWindow[] };
export const offRoadKey = (lorryId: string) => ["fleet-off-road", lorryId] as const;

/** Null when the form can be saved, else what to fix. */
export function offRoadProblem(f: { from: string; back: string; reason: string }): string | null {
  if (!f.from) return "Enter the day it goes off the road.";
  if (f.back && f.back < f.from) return "The expected return cannot be before the day it goes off the road.";
  if (!f.reason.trim()) return "Say why it is off the road.";
  return null;
}

export function OffRoadPanel({ lorryId, plate, onChanged }: { lorryId: string; plate: string; onChanged: (() => void) | null }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: offRoadKey(lorryId), queryFn: () => api.get<Payload>(`/api/fleet-maintenance/vehicles/${lorryId}/off-road`) });
  const [form, setForm] = useState<{ from: string; back: string; reason: string } | null>(null);
  const [asking, setAsking] = useState<OffRoadRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const failed = (title: string) => (e: unknown) => setErr(`${title}. ${e instanceof Error ? e.message : "Please try again."}`);
  const done = async () => {
    await qc.invalidateQueries({ queryKey: offRoadKey(lorryId) });
    await qc.invalidateQueries({ queryKey: ["lorries"] });
    onChanged?.();
  };
  const add = useMutation({
    mutationFn: (f: { from: string; back: string; reason: string }) =>
      api.post(`/api/fleet-maintenance/vehicles/${lorryId}/off-road`, { from: f.from, expectedReturn: f.back || null, reason: f.reason.trim() }),
    onSuccess: async () => { setForm(null); setErr(null); await done(); },
    onError: failed("The lorry was not taken off the road"),
  });
  const end = useMutation({
    mutationFn: (id: string) => api.patch(`/api/fleet-maintenance/off-road/${id}/end`, {}),
    onSuccess: async () => { setAsking(null); setErr(null); await done(); },
    onError: failed("The lorry was not put back on the road"),
  });
  const today = q.data?.today ?? todayMyt();
  const problem = form ? offRoadProblem(form) : null;
  const lbl = "text-[11px] text-ink-muted";
  const inputCls = "min-h-[40px] w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink";

  return (
    <div className="space-y-3">
      {!form && (
        <button type="button" onClick={() => setForm({ from: todayMyt(), back: "", reason: "" })}
          className="min-h-[40px] rounded-md border border-[#e3b4b4] px-3 text-[12.5px] font-semibold text-[color:var(--hz-dk-err,#8a2c2c)]">
          Take off the road
        </button>
      )}
      {form && (
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-surface-2 p-3">
          <label className={lbl}>Off the road from<DateField value={form.from} onChange={(v) => setForm({ ...form, from: v })} fullWidth aria-label="Off the road from" /></label>
          <label className={lbl}>Expected back (optional)<DateField value={form.back} onChange={(v) => setForm({ ...form, back: v })} fullWidth aria-label="Expected back" /></label>
          <label className={`col-span-2 ${lbl}`}>Why<input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className={inputCls} placeholder="Accident, gearbox, waiting for parts" /></label>
          {problem && form.reason !== "" && <p className="col-span-2 text-[12px] text-[color:var(--hz-dk-err,#8a2c2c)]">{problem}</p>}
          <p className="col-span-2 text-[11.5px] text-ink-muted">No expected date keeps it off the road until someone puts it back.</p>
          <div className="col-span-2 flex gap-2">
            <button type="button" disabled={problem !== null || add.isPending} onClick={() => add.mutate(form)}
              className="min-h-[40px] rounded-md bg-primary px-3 text-[12.5px] font-semibold text-white disabled:opacity-50">Save</button>
            <button type="button" onClick={() => setForm(null)} className="min-h-[40px] px-2 text-[12.5px] text-ink">Cancel</button>
          </div>
        </div>
      )}
      {err && <p role="alert" className="rounded-md bg-[#f6dcdc] px-3 py-2 text-[12.5px] font-semibold text-[color:var(--hz-dk-err,#8a2c2c)]">{err}</p>}
      {asking && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 p-3 text-[12.5px] text-ink">
          <span className="flex-1">{asking.state === "planned" ? `Cancel this off-the-road plan for ${plate}?` : `Put ${plate} back on the road? It can be planned for deliveries from today.`}</span>
          <button type="button" disabled={end.isPending} onClick={() => { if (asking.id) end.mutate(asking.id); }}
            className="min-h-[36px] rounded-md bg-primary px-3 font-semibold text-white disabled:opacity-50">{asking.state === "planned" ? "Cancel the plan" : "Yes, back on the road"}</button>
          <button type="button" onClick={() => setAsking(null)} className="min-h-[36px] px-2">Keep it</button>
        </div>
      )}
      {q.isError ? <p role="alert" className="text-[12.5px] text-[color:var(--hz-dk-err,#8a2c2c)]">Off-the-road days could not be loaded.</p>
        : q.isLoading ? <p className="text-[12.5px] text-ink-muted">Loading…</p>
        : <OffRoadList windows={q.data?.windows ?? []} today={today} endingId={end.isPending ? end.variables : null} onEnd={setAsking} />}
    </div>
  );
}
