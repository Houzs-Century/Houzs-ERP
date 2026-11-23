/* HR · Shifts (v3 design). The shift templates assigned to employees: a list of
 * shift groups with their hours (and a delivery-day window), how many people are
 * on each, and whether it is active. A row — or "New shift" — opens a drawer to
 * set the times and manage who is on the shift. Lateness and OT are judged against
 * each employee's group shift. Real data and all editing (save / delete / assign)
 * are unchanged. */
import { useMemo, useState } from "react";
import { ResizableDrawer } from "../../components/ResizableDrawer";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { errText } from "../pos-admin/posAdminUi";
import { HrPageHeader, hrPrimaryBtn, hrSecondaryBtn } from "./HrPageHeader";
import { HrTablePage, Tag, TimeSpan, type HrCol, type HrStat } from "./HrTablePage";
import { deleteShiftGroup, saveShiftGroup, seedShiftDefault, setEmployeeShiftGroup, useShiftGroups, type ShiftGroup, type ShiftGroupAssignee } from "./hrApi";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const inp = "h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[12px] text-ink focus:border-primary focus:outline-none";
const minToHhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const hhmmToMin = (s: string): number => { const m = /^(\d{2}):(\d{2})$/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const codeOf = (name: string) => "SH-" + (name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "GRP");
const hoursOf = (g: ShiftGroup) => Math.round(((g.endMin - g.startMin) / 60) * 10) / 10;

export function ShiftsTab() {
  const toast = useToast();
  const q = useShiftGroups();
  const [tab, setTab] = useState("Active");
  const [edit, setEdit] = useState<ShiftGroup | "new" | null>(null);
  const canManage = q.data?.canManage ?? false;
  const groups = useMemo(() => q.data?.groups ?? [], [q.data]);
  const assignees = useMemo(() => q.data?.employees ?? [], [q.data]);
  const countOf = (gid: number) => assignees.filter((e) => e.shiftGroupId === gid).length;

  const rows = useMemo(() => groups.filter((g) => (tab === "Archived" ? !g.active : g.active)), [groups, tab]);
  const active = groups.filter((g) => g.active);
  const assigned = assignees.filter((e) => e.shiftGroupId != null).length;
  const withDelivery = groups.filter((g) => g.deliveryStartMin != null).length;
  const avgDay = active.length ? Math.round((active.reduce((s, g) => s + hoursOf(g), 0) / active.length) * 10) / 10 : null;

  const reload = () => q.reload();
  const seedDefault = () =>
    void (async () => {
      try { await seedShiftDefault(); toast.success("Default shift groups loaded"); reload(); } catch (e) { toast.error(errText(e, "Could not load the groups.")); }
    })();

  const stats: HrStat[] = [
    { label: "Active shifts", value: () => active.length, sub: `${groups.length} in total`, bar: "bg-primary" },
    { label: "Assigned", value: () => assigned, sub: `${assignees.length - assigned} on the global shift`, bar: "bg-synced" },
    { label: "Delivery shifts", value: () => withDelivery, sub: "own delivery-day hours", bar: "bg-learning" },
    { label: "Avg day", value: () => (avgDay === null ? "—" : `${avgDay} h`), sub: "shift window", bar: "bg-time" },
  ];

  const columns: HrCol<ShiftGroup>[] = [
    { key: "name", label: "Shift", render: (g) => <span className="font-semibold text-ink">{g.name}</span> },
    { key: "code", label: "Code", render: (g) => <span className="font-mono text-[11px] text-accent">{codeOf(g.name)}</span> },
    { key: "hours", label: "Hours (06:00 – 22:00)", render: (g) => (
      <span className="flex items-center gap-2"><TimeSpan startMin={g.startMin} endMin={g.endMin} /><span className="w-[86px] shrink-0 font-mono text-[11px] text-ink-secondary">{minToHhmm(g.startMin)}–{minToHhmm(g.endMin)}</span></span>
    ) },
    { key: "delivery", label: "Delivery day", render: (g) => (g.deliveryStartMin != null && g.deliveryEndMin != null
      ? <span className="flex items-center gap-2"><TimeSpan startMin={g.deliveryStartMin} endMin={g.deliveryEndMin} tone="bg-accent" /><span className="w-[86px] shrink-0 font-mono text-[11px] text-ink-secondary">{minToHhmm(g.deliveryStartMin)}–{minToHhmm(g.deliveryEndMin)}</span></span>
      : <span className="text-ink-muted">same as shift</span>) },
    { key: "assigned", label: "Assigned", align: "right", render: (g) => <span className="font-semibold text-ink">{countOf(g.id)}</span> },
    { key: "status", label: "Status", align: "center", render: (g) => (g.active ? <Tag tone="ok">Active</Tag> : <Tag tone="muted">Archived</Tag>) },
  ];

  const noGroups = groups.length === 0;
  if (noGroups && q.data) {
    return (
      <>
        <HrPageHeader title="Shifts" subtitle="Working-time templates assigned to employees" />
        <div className="px-6 py-4">
          <div className="rounded-xl border border-border bg-surface p-5">
            <p className="text-[13px] text-ink">No shift groups yet. Load the defaults (Local, Foreign worker, Driver — with their delivery-day shifts), then assign each employee a shift.</p>
            {canManage && <button type="button" className={hrPrimaryBtn + " mt-3"} onClick={seedDefault}>Load default shifts</button>}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <HrTablePage<ShiftGroup>
        title="Shifts"
        subtitle="Working-time templates assigned to employees"
        actions={canManage ? <button type="button" className={hrPrimaryBtn} onClick={() => setEdit("new")}>+ New shift</button> : undefined}
        stats={stats}
        periods={["Active", "Archived"]}
        period={tab}
        onPeriod={setTab}
        rows={rows}
        columns={columns}
        searchOf={(g) => `${g.name} ${codeOf(g.name)}`}
        searchPlaceholder="Search shift"
        onRowClick={canManage ? (g) => setEdit(g) : undefined}
        loading={q.loading}
        error={q.error}
        emptyLabel={tab === "Archived" ? "No archived shifts." : "No active shifts."}
        footer={() => <>Total assigned <span className="font-semibold text-ink">{assigned} people</span></>}
      />
      {edit !== null && (
        <ShiftDrawer group={edit === "new" ? null : edit} assignees={assignees} count={edit === "new" ? 0 : countOf(edit.id)} canManage={canManage} onClose={() => setEdit(null)} onSaved={reload} />
      )}
    </>
  );
}

type Draft = { name: string; start: string; end: string; delivery: boolean; dStart: string; dEnd: string; active: boolean };
const toDraft = (g: ShiftGroup | null): Draft =>
  g
    ? { name: g.name, start: minToHhmm(g.startMin), end: minToHhmm(g.endMin), delivery: g.deliveryStartMin != null && g.deliveryEndMin != null, dStart: g.deliveryStartMin != null ? minToHhmm(g.deliveryStartMin) : "08:30", dEnd: g.deliveryEndMin != null ? minToHhmm(g.deliveryEndMin) : "18:30", active: g.active }
    : { name: "", start: "09:00", end: "19:00", delivery: false, dStart: "08:30", dEnd: "18:30", active: true };

function ShiftDrawer({ group, assignees, count, canManage, onClose, onSaved }: { group: ShiftGroup | null; assignees: ShiftGroupAssignee[]; count: number; canManage: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const dialog = useDialog();
  const [d, setD] = useState<Draft>(() => toDraft(group));
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  async function save() {
    const startMin = hhmmToMin(d.start);
    const endMin = hhmmToMin(d.end);
    if (!d.name.trim()) { toast.error("Give the shift a name."); return; }
    if (!(endMin > startMin)) { toast.error("Shift end must be after shift start."); return; }
    setBusy(true);
    try {
      await saveShiftGroup(group?.id ?? null, { name: d.name.trim(), startMin, endMin, deliveryStartMin: d.delivery ? hhmmToMin(d.dStart) : null, deliveryEndMin: d.delivery ? hhmmToMin(d.dEnd) : null, sortOrder: group?.sortOrder ?? 0, active: d.active });
      toast.success("Shift saved");
      onSaved();
      onClose();
    } catch (e) { toast.error(errText(e, "Could not save the shift.")); } finally { setBusy(false); }
  }
  async function remove() {
    if (!group) return;
    if (!(await dialog.confirm({ title: `Remove the "${group.name}" shift?`, message: "Employees on it fall back to the global shift.", confirmLabel: "Remove", tone: "danger" }))) return;
    setBusy(true);
    try { await deleteShiftGroup(group.id); toast.success("Shift removed"); onSaved(); onClose(); } catch (e) { toast.error(errText(e, "Could not remove the shift.")); } finally { setBusy(false); }
  }
  async function toggleAssign(employeeId: number, on: boolean) {
    try { await setEmployeeShiftGroup(employeeId, on ? (group?.id ?? null) : null); onSaved(); } catch (e) { toast.error(errText(e, "Could not set the shift.")); }
  }

  const field = "flex flex-col gap-1";
  const lbl = "text-[10px] font-semibold uppercase tracking-wide text-ink-muted";
  return (
    <ResizableDrawer
      onClose={onClose}
      title={group ? group.name : "New shift"}
      subtitle={group ? `${codeOf(group.name)} · ${count} assigned` : "A working-time template you can assign to employees"}
      storageKey="hr-shift-drawer"
      defaultWidth={520}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          {group && canManage && <button type="button" className="flex h-8 items-center rounded-md border border-border px-3 text-[12px] text-ink-muted hover:border-err/40 hover:text-err" disabled={busy} onClick={() => void remove()}>Remove</button>}
          <span className="ml-auto" />
          <button type="button" className={hrSecondaryBtn} onClick={onClose}>Close</button>
          {canManage && <button type="button" className={hrPrimaryBtn} disabled={busy} onClick={() => void save()}>Save shift</button>}
        </div>
      }
    >
      <div className="flex flex-col gap-4 p-4">
        <label className={field}><span className={lbl}>Shift name</span><input className={inp} value={d.name} disabled={!canManage} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Driver day" /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className={field}><span className={lbl}>Shift start</span><input type="time" className={inp} value={d.start} disabled={!canManage} onChange={(e) => e.target.value && set({ start: e.target.value })} /></label>
          <label className={field}><span className={lbl}>Shift end</span><input type="time" className={inp} value={d.end} disabled={!canManage} onChange={(e) => e.target.value && set({ end: e.target.value })} /></label>
        </div>
        <label className="flex items-center gap-2 text-[12px] text-ink-secondary"><input type="checkbox" checked={d.delivery} disabled={!canManage} onChange={(e) => set({ delivery: e.target.checked })} /> Different hours on a delivery day</label>
        {d.delivery && (
          <div className="grid grid-cols-2 gap-3">
            <label className={field}><span className={lbl}>Delivery start</span><input type="time" className={inp} value={d.dStart} disabled={!canManage} onChange={(e) => e.target.value && set({ dStart: e.target.value })} /></label>
            <label className={field}><span className={lbl}>Delivery end</span><input type="time" className={inp} value={d.dEnd} disabled={!canManage} onChange={(e) => e.target.value && set({ dEnd: e.target.value })} /></label>
          </div>
        )}
        <label className="flex items-center gap-2 text-[12px] text-ink-secondary"><input type="checkbox" checked={d.active} disabled={!canManage} onChange={(e) => set({ active: e.target.checked })} /> Active</label>

        {group && (
          <section className="rounded-xl border border-border-subtle">
            <div className="border-b border-border-subtle px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-ink-muted">On this shift</div>
            <div className="thin-scroll max-h-72 overflow-auto">
              {assignees.map((e) => {
                const on = e.shiftGroupId === group.id;
                return (
                  <label key={e.id} className="flex cursor-pointer items-center gap-2.5 border-b border-border-subtle px-3 py-2 last:border-0 hover:bg-row-hover">
                    <input type="checkbox" checked={on} disabled={!canManage} onChange={(ev) => void toggleAssign(e.id, ev.target.checked)} />
                    <span className="min-w-0 flex-1"><span className="block truncate text-[12px] text-ink">{e.name}</span><span className="block font-mono text-[10px] text-accent">{e.empNo}</span></span>
                    {!on && e.shiftGroupId != null && <span className="shrink-0 text-[10px] text-ink-muted">on another shift</span>}
                  </label>
                );
              })}
              {assignees.length === 0 && <div className="px-3 py-4 text-center text-[12px] text-ink-muted">No employees.</div>}
            </div>
          </section>
        )}
      </div>
    </ResizableDrawer>
  );
}
