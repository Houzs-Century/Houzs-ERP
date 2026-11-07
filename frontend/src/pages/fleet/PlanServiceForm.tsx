// Record a service that was actually done against a preventive-maintenance plan.
// Owner, 2026-10-15: the plan is the RULE (every 10,000 km / every 6 months);
// this is the RECORD — the day it went in, the odometer, what it cost, where.
// Saved as a completed work order (so it counts in the lorry's repair spend) and
// it moves the plan's last-done, from which the next due is worked out.
// Backend: scm/routes/fleet-plan-service.ts.
import { useState } from "react";
import { Button } from "../../components/Button";
import { api } from "../../api/client";
import { DateField } from "../../vendor/scm/components/DateField";
import { LABEL } from "./FleetUi";

const CLS = "h-10 w-full rounded-lg border border-[#d9d3c6] bg-surface px-3 text-[13.5px] text-ink focus:border-primary focus:outline-none";

export function PlanServiceForm({ planId, componentLabel, currentKm, onCancel, onSaved }: {
  planId: string;
  componentLabel: string;
  currentKm: number | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [doneDate, setDoneDate] = useState(new Date().toISOString().slice(0, 10));
  const [km, setKm] = useState(currentKm != null ? String(currentKm) : "");
  const [cost, setCost] = useState("");
  const [workshop, setWorkshop] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (busy) return;
    const kmN = km.trim() === "" ? null : Number(km);
    const rm = cost.trim() === "" ? 0 : Number(cost);
    if (!doneDate) { setErr("Pick the day the lorry was serviced."); return; }
    if (kmN != null && !(Number.isFinite(kmN) && kmN >= 0)) { setErr("Odometer must be a number of km."); return; }
    if (!(Number.isFinite(rm) && rm >= 0)) { setErr("Cost must be an amount in RM, 0 or more."); return; }
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/fleet-maintenance/plans/${planId}/service`, {
        doneDate,
        odometerKm: kmN != null ? Math.round(kmN) : null,
        costSen: Math.round(rm * 100),
        workshop: workshop.trim() || null,
        notes: notes.trim() || null,
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the service. Try again.");
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-[14px] border border-primary/30 bg-surface p-4">
      <div className="mb-3 text-[14px] font-semibold text-ink">Record a {componentLabel} service</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL}>Service date *</label>
          <DateField fullWidth className={CLS} value={doneDate} onChange={(iso) => setDoneDate(iso)} />
        </div>
        <div>
          <label className={LABEL}>Odometer (km)</label>
          <input className={CLS} inputMode="numeric" value={km} onChange={(e) => setKm(e.target.value)} placeholder="e.g. 120345" />
        </div>
        <div>
          <label className={LABEL}>Cost (RM)</label>
          <input className={CLS} inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0.00" />
        </div>
        <div>
          <label className={LABEL}>Workshop</label>
          <input className={CLS} value={workshop} onChange={(e) => setWorkshop(e.target.value)} placeholder="Optional" />
        </div>
        <div className="sm:col-span-2">
          <label className={LABEL}>Notes</label>
          <input className={CLS} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </div>
      </div>
      {err && <div role="alert" className="mt-2 text-[12.5px] font-semibold text-err">{err}</div>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save service"}</Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
