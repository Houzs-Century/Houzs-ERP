/* Employees & Attendance > Shifts (HC-0125): the shift groups that give each
 * employee their own shift for lateness and OT, with a delivery-day shift used
 * on a day DP sent a warehouse member on a delivery. Edit the groups, then
 * assign each employee a group below. No group falls back to the global Pay
 * Rules shift. */
import { useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { DataTable, type Column } from "../../components/DataTable";
import { Field, Pill, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { deleteShiftGroup, saveShiftGroup, seedShiftDefault, setEmployeeShiftGroup, useShiftGroups, type ShiftGroup, type ShiftGroupAssignee } from "./hrApi";

const minToHhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const hhmmToMin = (s: string): number => {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

type Draft = { id: number | null; name: string; start: string; end: string; delivery: boolean; dStart: string; dEnd: string; active: boolean };

const toDraft = (g: ShiftGroup): Draft => ({
  id: g.id,
  name: g.name,
  start: minToHhmm(g.startMin),
  end: minToHhmm(g.endMin),
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

  // Edit the groups off a local copy, seeded from the server the first time.
  const rows = drafts ?? (q.data ? q.data.groups.map(toDraft) : []);
  const setRow = (i: number, patch: Partial<Draft>) => setDrafts(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function save(d: Draft) {
    const startMin = hhmmToMin(d.start);
    const endMin = hhmmToMin(d.end);
    if (!d.name.trim()) {
      toast.error("Give the shift group a name.");
      return;
    }
    if (!(endMin > startMin)) {
      toast.error("Shift end must be after shift start.");
      return;
    }
    setBusy(true);
    try {
      await saveShiftGroup(d.id, {
        name: d.name.trim(),
        startMin,
        endMin,
        deliveryStartMin: d.delivery ? hhmmToMin(d.dStart) : null,
        deliveryEndMin: d.delivery ? hhmmToMin(d.dEnd) : null,
        sortOrder: rows.indexOf(d),
        active: d.active,
      });
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
    if (d.id === null) {
      setDrafts(rows.filter((_, j) => j !== i));
      return;
    }
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
  const columns: Column<ShiftGroupAssignee>[] = [
    { key: "empNo", label: "Emp No", getValue: (e) => e.empNo, render: (e) => <span className="font-mono text-[11px] font-semibold text-accent">{e.empNo}</span> },
    { key: "name", label: "Name", getValue: (e) => e.name, render: (e) => e.name },
    {
      key: "group",
      label: "Shift group",
      getValue: (e) => groupName(e.shiftGroupId),
      render: (e) =>
        canManage ? (
          <select className={`${inputCls} w-48`} value={e.shiftGroupId ?? ""} onChange={(ev) => void assign(e.id, ev.target.value ? Number(ev.target.value) : null)}>
            <option value="">-- global shift --</option>
            {(q.data?.groups ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        ) : (
          groupName(e.shiftGroupId) || <span className="text-ink-muted">global shift</span>
        ),
    },
  ];

  if (q.loading) return <p className="text-sm text-ink-muted">Loading...</p>;
  if ((q.data?.groups.length ?? 0) === 0 && drafts === null) {
    return (
      <div className="space-y-3 rounded-md border border-border bg-surface p-4">
        <p className="text-sm">No shift groups yet. Load the default groups (Local 9:00-17:30, Foreign worker 9:00-19:00, Driver 8:30-17:00, with their delivery-day shifts), then assign each employee a group.</p>
        {canManage && (
          <button
            type="button"
            className={primaryBtn}
            onClick={() => {
              void (async () => {
                try {
                  await seedShiftDefault();
                  toast.success("Default shift groups loaded");
                  q.reload();
                } catch (e) {
                  toast.error(errText(e, "Could not load the groups."));
                }
              })();
            }}
          >
            Load default groups
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="space-y-2 rounded-md border border-border bg-surface p-4">
        <h3 className="text-sm font-semibold">Shift groups</h3>
        <p className="text-[11px] text-ink-muted">Lateness and OT are judged against each employee&rsquo;s group shift. The delivery-day shift applies on a day DP sent the member on a delivery.</p>
        <div className="space-y-2">
          {rows.map((d, i) => (
            <div key={d.id ?? `new-${i}`} className="grid grid-cols-[1.3fr_100px_100px_60px_100px_100px_60px_auto] items-end gap-2 max-md:grid-cols-1">
              <Field label="Name">
                <input className={inputCls} value={d.name} onChange={(e) => setRow(i, { name: e.target.value })} />
              </Field>
              <Field label="Start">
                <input type="time" className={inputCls} value={d.start} onChange={(e) => e.target.value && setRow(i, { start: e.target.value })} />
              </Field>
              <Field label="End">
                <input type="time" className={inputCls} value={d.end} onChange={(e) => e.target.value && setRow(i, { end: e.target.value })} />
              </Field>
              <Field label="Delivery?">
                <input type="checkbox" className="h-4 w-4" checked={d.delivery} onChange={(e) => setRow(i, { delivery: e.target.checked })} aria-label="Different on delivery days" />
              </Field>
              <Field label="Deliv. start">
                <input type="time" className={inputCls} value={d.dStart} disabled={!d.delivery} onChange={(e) => setRow(i, { dStart: e.target.value })} />
              </Field>
              <Field label="Deliv. end">
                <input type="time" className={inputCls} value={d.dEnd} disabled={!d.delivery} onChange={(e) => setRow(i, { dEnd: e.target.value })} />
              </Field>
              <Field label="Active">
                <input type="checkbox" className="h-4 w-4" checked={d.active} onChange={(e) => setRow(i, { active: e.target.checked })} aria-label="Active" />
              </Field>
              {canManage && (
                <span className="flex gap-1 pb-1">
                  <button type="button" className={ghostBtn} disabled={busy} onClick={() => void save(d)} aria-label="Save shift group">
                    <Save size={12} />
                  </button>
                  <button type="button" className="text-ink-muted hover:text-err" onClick={() => void remove(i, d)} aria-label="Remove shift group">
                    <Trash2 size={14} />
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
        {canManage && (
          <button type="button" className={ghostBtn} onClick={() => setDrafts([...rows, { id: null, name: "", start: "09:00", end: "19:00", delivery: false, dStart: "08:30", dEnd: "18:30", active: true }])}>
            <Plus size={11} /> Add group
          </button>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Employees</h3>
          <Pill tone="muted">assign a group</Pill>
        </div>
        <DataTable<ShiftGroupAssignee>
          tableId="hr-shift-assignees"
          columns={columns}
          rows={q.data ? q.data.employees : null}
          loading={q.loading}
          error={q.error}
          emptyLabel="No employees."
          getRowKey={(e) => e.id}
        />
      </section>
    </div>
  );
}
