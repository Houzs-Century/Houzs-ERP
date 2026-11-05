/* Employees & Attendance > Working Hours (HC-0125 phase 3, from Hookka's
 * WorkingHoursTab). One line per employee per day: the punch, the hours it
 * gives, and the hours logged for pay. A clock-out logs them by itself (AUTO,
 * in the employee's department); HR edits, splits or adds hours (MANUAL), and
 * an AUTO row is never written over HR's. A changed day re-judges its dock. */
import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { DataTable, type Column } from "../../components/DataTable";
import { ResizableDrawer } from "../../components/ResizableDrawer";
import { useToast } from "../../hooks/useToast";
import { formatDate } from "../../lib/utils";
import { todayMY } from "../../vendor/shared/format";
import { DateField } from "../../vendor/scm/components/DateField";
import { Field, Pill, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { HR, useWorkingHours, type HoursEntry, type WorkDay, type WorkingHoursResponse } from "./hrApi";

type Line = {
  key: string;
  employeeId: number;
  empNo: string;
  name: string;
  workDate: string;
  hoursPerDay: number;
  day: WorkDay | null;
  entries: HoursEntry[];
  logged: number;
};

const h2 = (n: number) => (Math.round(n * 100) / 100).toString();

function chip(l: Line) {
  if (l.logged <= 0) return <Pill tone="muted">No hours</Pill>;
  if (l.logged > l.hoursPerDay + 0.001) return <Pill tone="warn">{h2(l.logged)}h · OT</Pill>;
  const base = l.day?.punchHours ?? l.logged;
  if (base < l.hoursPerDay - 0.001) return <Pill tone="bad">{h2(l.logged)}h · short</Pill>;
  return <Pill tone="ok">{h2(l.logged)}h</Pill>;
}

export function WorkingHoursTab() {
  const [params, setParams] = useSearchParams();
  const today = todayMY();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(params.get("from") ?? "") ? (params.get("from") as string) : `${today.slice(0, 7)}-01`;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(params.get("to") ?? "") ? (params.get("to") as string) : today;
  const setRange = (f: string, t: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set("from", f);
        n.set("to", t);
        return n;
      },
      { replace: true },
    );
  const q = useWorkingHours(from, to);
  const [open, setOpen] = useState<{ employeeId: number; workDate: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const data = q.data;
  const deptName = useMemo(() => new Map((data?.departments ?? []).map((d) => [d.id, d.name])), [data]);

  const lines = useMemo<Line[]>(() => {
    if (!data) return [];
    const emp = new Map(data.employees.map((e) => [e.id, e]));
    const map = new Map<string, Line>();
    const get = (employeeId: number, workDate: string) => {
      const k = `${employeeId}|${workDate}`;
      let l = map.get(k);
      if (!l) {
        const e = emp.get(employeeId);
        l = { key: k, employeeId, empNo: e?.empNo ?? "", name: e?.name ?? "", workDate, hoursPerDay: e?.hoursPerDay ?? 9, day: null, entries: [], logged: 0 };
        map.set(k, l);
      }
      return l;
    };
    for (const d of data.days) get(d.employeeId, d.workDate).day = d;
    for (const e of data.entries) {
      const l = get(e.employeeId, e.workDate);
      l.entries.push(e);
      l.logged += e.hours;
    }
    return [...map.values()].sort((a, b) => (a.workDate === b.workDate ? a.empNo.localeCompare(b.empNo) : b.workDate.localeCompare(a.workDate)));
  }, [data]);

  const totals = useMemo(() => ({ logged: lines.reduce((s, l) => s + l.logged, 0), days: lines.filter((l) => l.logged > 0).length }), [lines]);

  const columns: Column<Line>[] = [
    { key: "date", label: "Date", filterType: "date", dateValue: (l) => l.workDate, getValue: (l) => l.workDate, render: (l) => <span className="font-mono">{formatDate(l.workDate)}</span> },
    { key: "empNo", label: "Emp No", getValue: (l) => l.empNo, render: (l) => <span className="font-mono text-[11px] font-semibold text-accent">{l.empNo}</span> },
    { key: "name", label: "Name", getValue: (l) => l.name, render: (l) => l.name },
    {
      key: "punch",
      label: "Punch",
      getValue: (l) => l.day?.clockIn ?? "",
      render: (l) =>
        l.day?.clockIn ? (
          <span className="font-mono text-[11px]">
            {l.day.clockIn} to {l.day.clockOut ?? "..."}
            {l.day.outSource === "AUTO" && <span className="ml-1 text-amber-800">(no punch-out)</span>}
          </span>
        ) : (
          <span className="text-ink-muted">--</span>
        ),
    },
    {
      key: "punchHours",
      label: "Punch Hours",
      align: "right",
      description: "Regular + OT hours the punch gives, lunch taken off, on the pay rules of that day.",
      getValue: (l) => l.day?.punchHours ?? 0,
      render: (l) => (l.day?.punchHours != null ? <span className="font-mono">{h2(l.day.punchHours)}</span> : null),
    },
    {
      key: "logged",
      label: "Logged",
      description: "The hours pay reads. OT = more than the employee's hours / day; short = the punch gave less.",
      getValue: (l) => l.logged,
      render: chip,
    },
    {
      key: "split",
      label: "Department",
      getValue: (l) => l.entries.map((e) => (e.departmentId != null ? deptName.get(e.departmentId) ?? "" : "")).join(", "),
      render: (l) =>
        l.entries.length ? (
          <span className="text-[11px]">
            {l.entries.map((e) => (
              <span key={e.id} className="mr-2 whitespace-nowrap">
                {e.departmentId != null ? deptName.get(e.departmentId) ?? "?" : "No department"} {h2(e.hours)}h
                {e.source === "MANUAL" && <span className="ml-0.5 text-[9px] font-bold text-sky-700">HR</span>}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-ink-muted">--</span>
        ),
    },
    { key: "notes", label: "Notes", defaultHidden: true, getValue: (l) => l.entries.map((e) => e.notes ?? "").filter(Boolean).join("; "), render: (l) => <span className="text-[11px]">{l.entries.map((e) => e.notes ?? "").filter(Boolean).join("; ")}</span> },
  ];

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <Field label="From" className="w-36">
          <DateField fullWidth value={from} onChange={(iso) => iso && setRange(iso, iso > to ? iso : to)} aria-label="From date" />
        </Field>
        <Field label="To" className="w-36">
          <DateField fullWidth value={to} onChange={(iso) => iso && setRange(iso < from ? iso : from, iso)} aria-label="To date" />
        </Field>
        {data && (
          <span className="pb-2 text-[11px] text-ink-secondary">
            {totals.days} days logged · {h2(totals.logged)} hours
          </span>
        )}
        {data?.canManage && (
          <span className="ml-auto pb-1">
            <button type="button" className={primaryBtn} onClick={() => setAdding(true)}>
              <Plus size={11} /> Log hours
            </button>
          </span>
        )}
      </div>
      <DataTable<Line>
        tableId="hr-working-hours"
        columns={columns}
        rows={data ? lines : null}
        loading={q.loading}
        error={q.error}
        emptyLabel="No punches or hours in this range."
        getRowKey={(l) => l.key}
        onRowClick={data?.canManage ? (l) => setOpen({ employeeId: l.employeeId, workDate: l.workDate }) : undefined}
        exportName={`working-hours-${from}-${to}`}
      />
      {data && open && (
        <DayHoursDrawer
          key={data.entries
            .filter((e) => e.employeeId === open.employeeId && e.workDate === open.workDate)
            .map((e) => `${e.id}:${e.hours}:${e.departmentId}`)
            .join(",")}
          data={data}
          employeeId={open.employeeId}
          workDate={open.workDate}
          onClose={() => setOpen(null)}
          onChanged={() => q.reload()}
        />
      )}
      {data && adding && (
        <PickDayDrawer
          data={data}
          onClose={() => setAdding(false)}
          onPick={(employeeId, workDate) => {
            setAdding(false);
            setOpen({ employeeId, workDate });
          }}
        />
      )}
    </div>
  );
}


function PickDayDrawer({ data, onClose, onPick }: { data: WorkingHoursResponse; onClose: () => void; onPick: (employeeId: number, workDate: string) => void }) {
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [date, setDate] = useState(todayMY());
  return (
    <ResizableDrawer
      onClose={onClose}
      title="Log hours"
      subtitle="Pick who and which day; the hours come next."
      storageKey="hr-log-hours-pick"
      defaultWidth={420}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className={ghostBtn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={primaryBtn} disabled={employeeId == null || !date} onClick={() => employeeId != null && onPick(employeeId, date)}>
            Next
          </button>
        </div>
      }
    >
      <div className="space-y-3 p-3">
        <Field label="Employee">
          <select className={inputCls} value={employeeId ?? ""} onChange={(e) => setEmployeeId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">--</option>
            {data.employees
              .filter((e) => e.status === "ACTIVE")
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.empNo} {e.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Day">
          <DateField fullWidth value={date} onChange={setDate} aria-label="Day" />
        </Field>
      </div>
    </ResizableDrawer>
  );
}

function DayHoursDrawer({ data, employeeId, workDate, onClose, onChanged }: { data: WorkingHoursResponse; employeeId: number; workDate: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const emp = data.employees.find((e) => e.id === employeeId);
  const day = data.days.find((d) => d.employeeId === employeeId && d.workDate === workDate) ?? null;
  const entries = data.entries.filter((e) => e.employeeId === employeeId && e.workDate === workDate);
  const [drafts, setDrafts] = useState<Record<number, { departmentId: string; hours: string; notes: string }>>(() =>
    Object.fromEntries(entries.map((e) => [e.id, { departmentId: e.departmentId == null ? "" : String(e.departmentId), hours: h2(e.hours), notes: e.notes ?? "" }])),
  );
  const [fresh, setFresh] = useState({ departmentId: emp?.departmentId == null ? "" : String(emp.departmentId), hours: entries.length ? "" : day?.punchHours != null ? h2(day.punchHours) : String(emp?.hoursPerDay ?? 9), notes: "" });
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      onChanged();
    } catch (e) {
      toast.error(errText(e, "Could not save the hours."));
    } finally {
      setBusy(false);
    }
  };
  const body = (d: { departmentId: string; hours: string; notes: string }) => ({ departmentId: d.departmentId ? Number(d.departmentId) : null, hours: Number(d.hours), notes: d.notes });
  const deptSelect = (value: string, onChange: (v: string) => void) => (
    <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">No department</option>
      {data.departments.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </select>
  );

  return (
    <ResizableDrawer
      onClose={onClose}
      title={
        <span>
          <span className="font-mono">{emp?.empNo}</span> {emp?.name}
        </span>
      }
      subtitle={`${formatDate(workDate)} · ${day?.clockIn ? `punch ${day.clockIn} to ${day.clockOut ?? "..."}${day.punchHours != null ? ` = ${h2(day.punchHours)}h` : ""}` : "no punch"} · standard ${emp?.hoursPerDay ?? 9}h`}
      storageKey="hr-day-hours-drawer"
      defaultWidth={560}
      footer={
        <div className="flex justify-end">
          <button type="button" className={ghostBtn} onClick={onClose}>
            Close
          </button>
        </div>
      }
    >
      <div className="space-y-3 p-3">
        {entries.map((e) => {
          const d = drafts[e.id] ?? { departmentId: "", hours: "", notes: "" };
          const set = (patch: Partial<typeof d>) => setDrafts((all) => ({ ...all, [e.id]: { ...d, ...patch } }));
          return (
            <div key={e.id} className="rounded-md border border-border-subtle p-2">
              <div className="mb-1 text-[10px] font-bold uppercase tracking-brand text-ink-muted">{e.source === "AUTO" ? "From the punch" : "Logged by HR"}</div>
              <div className="grid grid-cols-[1fr_90px] gap-2">
                <Field label="Department">{deptSelect(d.departmentId, (v) => set({ departmentId: v }))}</Field>
                <Field label="Hours">
                  <input className={inputCls} value={d.hours} onChange={(ev) => set({ hours: ev.target.value })} inputMode="decimal" />
                </Field>
              </div>
              <Field label="Note" className="mt-2">
                <input className={inputCls} value={d.notes} onChange={(ev) => set({ notes: ev.target.value })} />
              </Field>
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" className={ghostBtn} disabled={busy} onClick={() => void run(() => api.del(`${HR}/working-hours/${e.id}`), "Hours removed")}>
                  <Trash2 size={11} /> Remove
                </button>
                <button type="button" className={primaryBtn} disabled={busy} onClick={() => void run(() => api.patch(`${HR}/working-hours/${e.id}`, body(d)), "Hours saved")}>
                  Save
                </button>
              </div>
            </div>
          );
        })}
        <div className="rounded-md border border-dashed border-border p-2">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-brand text-ink-muted">{entries.length ? "Add a split (another department)" : "Log hours"}</div>
          <div className="grid grid-cols-[1fr_90px] gap-2">
            <Field label="Department">{deptSelect(fresh.departmentId, (v) => setFresh({ ...fresh, departmentId: v }))}</Field>
            <Field label="Hours">
              <input className={inputCls} value={fresh.hours} onChange={(ev) => setFresh({ ...fresh, hours: ev.target.value })} inputMode="decimal" />
            </Field>
          </div>
          <Field label="Note" className="mt-2">
            <input className={inputCls} value={fresh.notes} onChange={(ev) => setFresh({ ...fresh, notes: ev.target.value })} placeholder="e.g. forgot to punch, helped at KL WAREHOUSE" />
          </Field>
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              className={primaryBtn}
              disabled={busy || !(Number(fresh.hours) > 0)}
              onClick={() => void run(() => api.post(`${HR}/working-hours`, { employeeId, date: workDate, ...body(fresh) }), "Hours logged").then(() => setFresh({ ...fresh, hours: "", notes: "" }))}
            >
              <Plus size={11} /> Add
            </button>
          </div>
        </div>
        <p className="text-[10.5px] text-ink-muted">Hours HR saves here are kept: a later punch change never writes over them. The day&apos;s short-hour dock is re-checked on every save.</p>
      </div>
    </ResizableDrawer>
  );
}
