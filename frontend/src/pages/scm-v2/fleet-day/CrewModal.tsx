import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Wand2, AlertTriangle } from 'lucide-react';
import { Button } from '../../../components/Button';
import { useNotify } from '../../../vendor/scm/components/NotifyDialog';
import { useUpdateTrip } from '../../../vendor/scm/lib/trips-queries';
import { useAssignDoCrew } from '../../../vendor/scm/lib/delivery-planning-queries';
import { useUpdateDriver, type DriverRow } from '../../../vendor/scm/lib/drivers-queries';
import type { FleetDayTrip } from '../../../vendor/scm/lib/fleet-day-queries';
import type { DriverLeaveRow } from '../../../vendor/scm/lib/delivery-zones-queries';
import { findCrewLeave, crewLeaveLabel } from '../../../vendor/shared/crew-leave';
import { isoToMytTime, mytTimeToIso, type LorryRunVM } from './vm';

type Named = { id: string; name: string };
type Lorry = { id: string; plate: string };

type Draft = {
  lorryId: string; driver1Id: string; driver2Id: string; helper1Id: string; helper2Id: string;
  driver1Ic: string; driver1Phone: string; plannedDepart: string;
};

/** Which trips THIS day already carry a given driver (for the double-book
 *  warning), excluding the run being edited. */
function doubleBookedPlates(trips: readonly FleetDayTrip[], driverId: string, exceptTripId: string): string[] {
  if (!driverId) return [];
  return trips.filter((t) => t.id !== exceptTripId && t.driver?.id === driverId).map((t) => t.lorry?.plate ?? t.trip_no ?? t.id);
}

export function CrewModal({
  run, trips, drivers, helpers, lorries, leave, date, onClose, onApplied,
}: {
  run: LorryRunVM | null;
  trips: readonly FleetDayTrip[];
  drivers: DriverRow[];
  helpers: Named[];
  lorries: Lorry[];
  leave: DriverLeaveRow[] | undefined;
  date: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const notify = useNotify();
  const updateTrip = useUpdateTrip();
  const doCrew = useAssignDoCrew();
  const updateDriver = useUpdateDriver();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  // (Re)seed the draft whenever a different run opens.
  useEffect(() => {
    if (!run) { setDraft(null); return; }
    const master = run.trip.driver?.id ? drivers.find((d) => d.id === run.trip.driver!.id) : undefined;
    setDraft({
      lorryId: run.trip.lorry?.id ?? '',
      driver1Id: run.trip.driver?.id ?? '',
      driver2Id: '',
      helper1Id: run.trip.helpers[0]?.id ?? '',
      helper2Id: run.trip.helpers[1]?.id ?? '',
      driver1Ic: master?.ic_number ?? '',
      driver1Phone: master?.phone ?? '',
      plannedDepart: isoToMytTime(run.trip.planned_depart_at),
    });
  }, [run, drivers]);

  if (!run || !draft) return null;

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const leaveNote = (kind: 'driver' | 'helper', id: string) => (id ? crewLeaveLabel(findCrewLeave(leave, kind, id, date)) : null);
  const master1 = draft.driver1Id ? drivers.find((d) => d.id === draft.driver1Id) : undefined;
  const icDirty = !!master1 && (draft.driver1Ic !== (master1.ic_number ?? '') || draft.driver1Phone !== master1.phone);
  const dbl = doubleBookedPlates(trips, draft.driver1Id, run.trip.id);

  // Propose: fill empty seats with the first active, not-on-leave person not
  // already used on another run today.
  const propose = () => {
    const usedDrivers = new Set(trips.filter((t) => t.id !== run.trip.id).map((t) => t.driver?.id).filter(Boolean) as string[]);
    const freeDriver = drivers.find((d) => d.active && !usedDrivers.has(d.id) && !leaveNote('driver', d.id));
    const freeHelper = (exclude: string[]) => helpers.find((h) => !exclude.includes(h.id) && !leaveNote('helper', h.id));
    const patch: Partial<Draft> = {};
    if (!draft.driver1Id && freeDriver) { patch.driver1Id = freeDriver.id; patch.driver1Ic = freeDriver.ic_number ?? ''; patch.driver1Phone = freeDriver.phone; }
    if (!draft.helper1Id) { const h = freeHelper([draft.helper2Id]); if (h) patch.helper1Id = h.id; }
    if (!draft.helper2Id) { const h = freeHelper([patch.helper1Id ?? draft.helper1Id]); if (h) patch.helper2Id = h.id; }
    set(patch);
  };

  const apply = async () => {
    if (!draft.lorryId) { void notify({ title: 'Pick a lorry', body: 'Choose a lorry before applying the crew.', tone: 'error' }); return; }
    setSaving(true);
    let doOk = 0; let doFailed = 0; let noDo = 0; let tripFailed: string | null = null;
    try {
      await updateTrip.mutateAsync({ id: run.trip.id, lorryId: draft.lorryId, driverId: draft.driver1Id || null, helper1Id: draft.helper1Id || null, helper2Id: draft.helper2Id || null, plannedDepartAt: mytTimeToIso(date, draft.plannedDepart) });
    } catch (e) { tripFailed = e instanceof Error ? e.message : 'trip update failed'; }

    for (const d of run.docs) {
      const doId = d.latestLiveDoId;
      if (!doId) { noDo += 1; continue; }
      try {
        await doCrew.mutateAsync({
          doId,
          driver1Id: draft.driver1Id || null, driver2Id: draft.driver2Id || null,
          helper1Id: draft.helper1Id || null, helper2Id: draft.helper2Id || null,
          lorryId: draft.lorryId,
        });
        doOk += 1;
      } catch { doFailed += 1; }
    }

    // Driver-master write-back (owner decision 5): editing IC/phone updates the
    // driver everywhere.
    let driverSaved = false;
    if (icDirty && draft.driver1Id) {
      try { await updateDriver.mutateAsync({ id: draft.driver1Id, icNumber: draft.driver1Ic, phone: draft.driver1Phone }); driverSaved = true; }
      catch { /* surfaced in the summary below */ }
    }
    setSaving(false);
    void notify({
      title: tripFailed || doFailed ? 'Crew applied with problems' : 'Crew applied',
      body: [
        tripFailed ? `Trip row failed: ${tripFailed}.` : 'Trip crew saved.',
        `${doOk} order(s) labelled${doFailed ? `, ${doFailed} failed` : ''}.`,
        noDo > 0 ? `${noDo} order(s) have no DO yet — crew saved on the trip only.` : '',
        driverSaved ? "Driver's profile updated." : '',
      ].filter(Boolean).join(' '),
      tone: tripFailed || doFailed ? 'error' : 'info',
    });
    onApplied();
    onClose();
  };

  const selectCls = 'h-9 w-full rounded-md border border-border bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-primary';
  const inputCls = 'h-9 w-full rounded-md border border-border bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-primary';

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-ink/20 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-slab" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-border p-4">
          <div>
            <div className="text-[15px] font-bold text-ink">Crew · {run.plate}</div>
            <div className="font-mono text-[11px] text-ink-muted">{run.tripNo ?? '—'} · {date} · {run.rollup.drops} drops</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-ink-muted hover:bg-surface-2 hover:text-ink"><X size={18} /></button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <label className="block">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Lorry</span>
            <select className={selectCls} value={draft.lorryId} onChange={(e) => set({ lorryId: e.target.value })}>
              <option value="">— pick a lorry —</option>
              {lorries.map((l) => <option key={l.id} value={l.id}>{l.plate}</option>)}
            </select>
          </label>

          <label className="block">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Planned departure</span>
            <input type="time" className={inputCls} value={draft.plannedDepart} onChange={(e) => set({ plannedDepart: e.target.value })} />
            <span className="mt-0.5 block text-[11px] text-ink-muted">The card flags a run that leaves more than 15 min after this.</span>
          </label>

          {/* Driver 1 + editable IC / phone */}
          <div className="rounded-lg border border-border p-3">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Driver 1</div>
            <select
              className={`${selectCls} mt-1`}
              value={draft.driver1Id}
              onChange={(e) => { const id = e.target.value; const m = drivers.find((d) => d.id === id); set({ driver1Id: id, driver1Ic: m?.ic_number ?? '', driver1Phone: m?.phone ?? '' }); }}
            >
              <option value="">— none —</option>
              {drivers.filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}{leaveNote('driver', d.id) ? ` — ${leaveNote('driver', d.id)}` : ''}</option>)}
            </select>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="block"><span className="text-[11px] text-ink-muted">IC no.</span><input className={inputCls} value={draft.driver1Ic} onChange={(e) => set({ driver1Ic: e.target.value })} disabled={!draft.driver1Id} /></label>
              <label className="block"><span className="text-[11px] text-ink-muted">Phone</span><input className={inputCls} value={draft.driver1Phone} onChange={(e) => set({ driver1Phone: e.target.value })} disabled={!draft.driver1Id} /></label>
            </div>
            {icDirty && <div className="mt-1 text-[11px] text-warning-text">Saving will update this driver's profile everywhere.</div>}
            {leaveNote('driver', draft.driver1Id) && <div className="mt-1 flex items-center gap-1 text-[11px] text-warning-text"><AlertTriangle size={12} /> On leave: {leaveNote('driver', draft.driver1Id)}</div>}
            {dbl.length > 0 && <div className="mt-1 flex items-center gap-1 text-[11px] text-warning-text"><AlertTriangle size={12} /> Already driving {dbl.join(', ')} today</div>}
          </div>

          <label className="block">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Driver 2</span>
            <select className={selectCls} value={draft.driver2Id} onChange={(e) => set({ driver2Id: e.target.value })}>
              <option value="">— none —</option>
              {drivers.filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-2">
            {(['helper1Id', 'helper2Id'] as const).map((seat, i) => (
              <label key={seat} className="block">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Helper {i + 1}</span>
                <select className={selectCls} value={draft[seat]} onChange={(e) => set({ [seat]: e.target.value } as Partial<Draft>)}>
                  <option value="">— none —</option>
                  {helpers.map((h) => <option key={h.id} value={h.id}>{h.name}{leaveNote('helper', h.id) ? ` — ${leaveNote('helper', h.id)}` : ''}</option>)}
                </select>
              </label>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-border p-3">
          <Button variant="ghost" icon={<Wand2 size={14} strokeWidth={1.75} />} onClick={propose}>Propose crew</Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => void apply()} disabled={saving || !draft.lorryId}>{saving ? 'Applying…' : 'Apply crew'}</Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
