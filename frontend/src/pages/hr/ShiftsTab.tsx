/* HR · Shifts (step-2 re-skin). Shift groups that give each employee their own
 * shift for lateness and OT (plus a delivery-day shift), and the per-employee
 * assignment below. New design; real data and all editing unchanged. */
import { useState } from "react";
import { Save, Trash2 } from "lucide-react";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { errText } from "../pos-admin/posAdminUi";
import { HrPageHeader, hrPrimaryBtn, hrSecondaryBtn } from "./HrPageHeader";
import { deleteShiftGroup, saveShiftGroup, seedShiftDefault, setEmployeeShiftGroup, useShiftGroups, type ShiftGroup, type ShiftGroupAssignee } from "./hrApi";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const inp = "h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[12px] text-ink focus:border-primary focus:outline-none";
const minToHhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const hhmmToMin = (s: string): number => {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

type Draft = { id: number | null; name: string; start: string; end: string; delivery: boolean; dStart: string; dEnd: string; active: boolean };
const toDraft = (g: ShiftGroup): Draft => ({
  id: g.id, name: g.name, start: minToHhmm(g.startMin), end: minToHhmm(g.endMin),
  delivery: g.deliveryStartMin != null && g.deliveryEndMin != null,
  dStart: g.deliveryStartMin != null ? minToHhmm(g.deliveryStartMin) : "",
  dEnd: g.deliveryEndMin != null ? minToHhmm(g.deliveryEndMin) : "",
  active: g.active,
});

export function ShiftsTab() {
  const toast = useToast();
  const dialog = useDialog();
  const q = useShiftGroups();
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [busy, setBusy] = useState(false);
  const canManage = q.data?.canManage ?? false;

  const rows = drafts ?? (q.data ? q.data.groups.map(toDraft) : []);
  const setRow = (i: number, patch: Partial<Draft>) => setDrafts(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const groups = q.data?.groups ?? [];
  const assignees = q.data?.employees ?? [];

  async function save(d: Draft) {
    const startMin = hhmmToMin(d.start);
    const endMin = hhmmToMin(d.end);
    if (!d.name.trim()) { toast.error("Give the shift group a name."); return; }
    if (!(endMin > startMin)) { toast.error("Shift end must be after shift start."); return; }
    setBusy(true);
    try {
      await saveShiftGroup(d.id, { name: d.name.trim(), startMin, endMin, deliveryStartMin: d.delivery ? hhmmToMin(d.dStart) : null, deliveryEndMin: d.delivery ? hhmmToMin(d.dEnd) : null, sortOrder: rows.indexOf(d), active: d.active });
      toast.success("Shift group saved");
      setDrafts(null);
      q.reload();
    } catch (e) {
      toast.error(errText(e, "Could not save the shift group."));
    } finally {
      setBusy(false);
    }
  }
  async function remove(i: number, d: Draft) {
    if (d.id === null) { setDrafts(rows.filter((_, j) => j !== i)); return; }
    if (!(await dialog.confirm({ title: `Remove the "${d.name}" shift group?`, message: "Employees in it fall back to the global shift.", confirmLabel: "Remove", tone: "danger" }))) return;
    try {
      await deleteShiftGroup(d.id);
      toast.success("Shift group removed");
      setDrafts(null);
      q.reload();
    } catch (e) {
      toast.error(errText(e, "Could not remove the shift group."));
    }
  }
  async function assign(employeeId: number, shiftGroupId: number | null) {
    try {
      await setEmployeeShiftGroup(employeeId, shiftGroupId);
      q.reload();
    } catch (e) {
      toast.error(errText(e, "Could not set the shift group."));
    }
  }
  const groupName = (id: number | null) => q.data?.groups.find((g) => g.id === id)?.name ?? "";

  const seedDefault = () =>
    void (async () => {
      try {
        await seedShiftDefault();
        toast.success("Default shift groups loaded");
        q.reload();
      } catch (e) {
        toast.error(errText(e, "Could not load the groups."));
      }
    })();

  const empty = (q.data?.groups.length ?? 0) === 0 && drafts === null;

  return (
    <>
      <HrPageHeader
        title="Shifts"
        subtitle="Shift groups for lateness and overtime, assigned per employee"
        actions={canManage && !empty ? <button type="button" className={hrPrimaryBtn} onClick={() => setDrafts([...rows, { id: null, name: "", start: "09:00", end: "19:00", delivery: false, dStart: "08:30", dEnd: "18:30", active: true }])}>+ Add group</button> : undefined}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-4">
        {q.loading && !q.data && <div className="text-[12px] text-ink-muted">Loading…</div>}
        {empty && q.data && (
          <div className="rounded-xl border border-border bg-surface p-5">
            <p className="text-[13px] text-ink">No shift groups yet. Load the defaults (Local 9:00–17:30, Foreign worker 9:00–19:00, Driver 8:30–17:00, with their delivery-day shifts), then assign each employee a group.</p>
            {canManage && <button type="button" className={cx(hrPrimaryBtn, "mt-3")} onClick={seedDefault}>Load default groups</button>}
          </div>
        )}

        {!empty && q.data && (
          <>
            <section className="rounded-xl border border-border bg-surface p-4">
              <h3 className="text-[13px] font-bold text-ink">Shift groups</h3>
              <p className="mt-0.5 text-[11px] text-ink-muted">Lateness and OT are judged against each employee&rsquo;s group shift. The delivery-day shift applies on a day DP sent the member on a delivery.</p>
              <div className="mt-3 flex flex-col gap-2">
                <div className="grid grid-cols-[1.4fr_90px_90px_70px_90px_90px_60px_auto] gap-2 px-1 text-[10px] font-bold uppercase tracking-wide text-ink-muted max-md:hidden">
                  <span>Name</span><span>Start</span><span>End</span><span>Delivery</span><span>Deliv. start</span><span>Deliv. end</span><span>Active</span><span />
                </div>
                {rows.map((d, i) => (
                  <div key={d.id ?? `new-${i}`} className="grid grid-cols-[1.4fr_90px_90px_70px_90px_90px_60px_auto] items-center gap-2 rounded-lg border border-border-subtle bg-surface-2/40 p-2 max-md:grid-cols-2">
                    <input className={inp} value={d.name} onChange={(e) => setRow(i, { name: e.target.value })} placeholder="Group name" />
                    <input type="time" className={inp} value={d.start} onChange={(e) => e.target.value && setRow(i, { start: e.target.value })} />
                    <input type="time" className={inp} value={d.end} onChange={(e) => e.target.value && setRow(i, { end: e.target.value })} />
                    <label className="flex items-center justify-center"><input type="checkbox" checked={d.delivery} onChange={(e) => setRow(i, { delivery: e.target.checked })} aria-label="Different on delivery days" /></label>
                    <input type="time" className={inp} value={d.dStart} disabled={!d.delivery} onChange={(e) => setRow(i, { dStart: e.target.value })} />
                    <input type="time" className={inp} value={d.dEnd} disabled={!d.delivery} onChange={(e) => setRow(i, { dEnd: e.target.value })} />
                    <label className="flex items-center justify-center"><input type="checkbox" checked={d.active} onChange={(e) => setRow(i, { active: e.target.checked })} aria-label="Active" /></label>
                    {canManage && (
                      <span className="flex gap-1">
                        <button type="button" className={hrSecondaryBtn} disabled={busy} onClick={() => void save(d)} aria-label="Save shift group"><Save size={12} /></button>
                        <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-ink-muted hover:border-err/40 hover:text-err" onClick={() => void remove(i, d)} aria-label="Remove shift group"><Trash2 size={13} /></button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
              <div className="border-b border-border-subtle px-4 py-2 text-[12px] font-bold text-ink">Employees · assign a group</div>
              <div className="thin-scroll min-h-0 flex-1 overflow-auto">
                <table className="w-full border-separate border-spacing-0 text-[12px]">
                  <thead>
                    <tr className="text-[10px] font-bold uppercase tracking-wide text-ink-muted">
                      <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-4 py-2 text-left">Emp No</th>
                      <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-3 py-2 text-left">Name</th>
                      <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-3 py-2 text-left">Shift group</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assignees.map((e: ShiftGroupAssignee) => (
                      <tr key={e.id} className="hover:bg-row-hover">
                        <td className="border-b border-border-subtle px-4 py-2 font-mono text-[11px] font-semibold text-accent">{e.empNo}</td>
                        <td className="border-b border-border-subtle px-3 py-2 text-ink">{e.name}</td>
                        <td className="border-b border-border-subtle px-3 py-2">
                          {canManage ? (
                            <select className={cx(inp, "w-56")} value={e.shiftGroupId ?? ""} onChange={(ev) => void assign(e.id, ev.target.value ? Number(ev.target.value) : null)}>
                              <option value="">— global shift —</option>
                              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                            </select>
                          ) : (
                            <span className="text-ink-secondary">{groupName(e.shiftGroupId) || "global shift"}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {assignees.length === 0 && <tr><td colSpan={3} className="px-4 py-8 text-center text-[12px] text-ink-muted">No employees.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
