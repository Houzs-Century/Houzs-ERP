import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { ResizableDrawer } from "../../components/ResizableDrawer";
import { useToast } from "../../hooks/useToast";
import { formatDate } from "../../lib/utils";
import { todayMY } from "../../../../shared/src/vendor/shared/format";
import { DateField } from "../../vendor/scm/components/DateField";
import { Field, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { hrPrimaryBtn } from "./HrPageHeader";
import { Bar, HrTablePage, Person, Tag, type HrCol, type HrStat } from "./HrTablePage";
import { HR, useEmployees, useWorkingHours, type WorkingHoursResponse } from "./hrApi";

const h2 = (n: number) => (Math.round(n * 100) / 100).toString();
const r2 = (n: number) => Math.round(n * 100) / 100;
const pad2 = (n: number) => String(n).padStart(2, "0");
const monthStart = (ym: string) => `${ym}-01`;
const monthEnd = (ym: string) => { const [y, m] = ym.split("-").map(Number); return `${ym}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
const shiftMonth = (ym: string, by: number) => { const [y, m] = ym.split("-").map(Number); const i = y * 12 + (m - 1) + by; return `${Math.floor(i / 12)}-${pad2((i % 12) + 1)}`; };

type EmpRow = { id: number; empNo: string; name: string; position: string; days: number; regular: number; ot: number; lateMin: number; total: number };

export function WorkingHoursTab() {
  const [params, setParams] = useSearchParams();
  const today = todayMY().slice(0, 10);
  const thisMonth = today.slice(0, 7);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(params.get("from") ?? "") ? (params.get("from") as string) : monthStart(thisMonth);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(params.get("to") ?? "") ? (params.get("to") as string) : today;
  const setRange = (f: string, t: string) => setParams((p) => { const n = new URLSearchParams(p); n.set("from", f); n.set("to", t); return n; }, { replace: true });

  const q = useWorkingHours(from, to);
  const employees = useEmployees();
  const [drill, setDrill] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const data = q.data;

  const lastMonth = shiftMonth(thisMonth, -1);
  const period = from === monthStart(thisMonth) && to === today ? "This month" : from === monthStart(lastMonth) && to === monthEnd(lastMonth) ? "Last month" : "Custom";
  const setPeriod = (p: string) => {
    if (p === "This month") setRange(monthStart(thisMonth), today);
    else if (p === "Last month") setRange(monthStart(lastMonth), monthEnd(lastMonth));
  };

  const posOf = useMemo(() => new Map((employees.data?.employees ?? []).map((e) => [e.id, e.position])), [employees.data]);

  const rows = useMemo<EmpRow[]>(() => {
    if (!data) return [];
    const emp = new Map(data.employees.map((e) => [e.id, e]));
    const lateByEmp = new Map<number, number>();
    for (const d of data.days) lateByEmp.set(d.employeeId, (lateByEmp.get(d.employeeId) ?? 0) + d.lateMin);
    const dayTotals = new Map<string, number>();
    for (const e of data.entries) dayTotals.set(`${e.employeeId}|${e.workDate}`, (dayTotals.get(`${e.employeeId}|${e.workDate}`) ?? 0) + e.hours);
    const agg = new Map<number, { days: number; total: number; ot: number }>();
    for (const [k, hrs] of dayTotals) {
      if (hrs <= 0) continue;
      const eid = Number(k.split("|")[0]);
      const std = emp.get(eid)?.hoursPerDay ?? 9;
      const a = agg.get(eid) ?? { days: 0, total: 0, ot: 0 };
      a.days += 1;
      a.total += hrs;
      a.ot += Math.max(0, hrs - std);
      agg.set(eid, a);
    }
    return data.employees
      .map((e) => {
        const a = agg.get(e.id) ?? { days: 0, total: 0, ot: 0 };
        return { id: e.id, empNo: e.empNo, name: e.name, position: posOf.get(e.id) || "—", days: a.days, regular: r2(a.total - a.ot), ot: r2(a.ot), lateMin: lateByEmp.get(e.id) ?? 0, total: r2(a.total) };
      })
      .filter((r) => r.days > 0 || r.lateMin > 0)
      .sort((a, b) => b.total - a.total);
  }, [data, posOf]);

  const sum = (f: (r: EmpRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const totRegular = r2(sum((r) => r.regular));
  const totOt = r2(sum((r) => r.ot));
  const totLate = sum((r) => r.lateMin);
  const totDays = sum((r) => r.days);
  const totHours = r2(sum((r) => r.total));
  const maxOt = Math.max(1, ...rows.map((r) => r.ot));

  const stats: HrStat[] = [
    { label: "Regular hours", value: () => `${h2(totRegular)} h`, sub: `${formatDate(from)} – ${formatDate(to)}`, bar: "bg-primary" },
    { label: "Overtime", value: () => `${h2(totOt)} h`, sub: "over the standard day", bar: "bg-accent" },
    { label: "Late minutes", value: () => `${totLate} min`, sub: "per the punch", bar: "bg-time" },
    { label: "Avg per day", value: () => (totDays ? `${h2(r2(totHours / totDays))} h` : "—"), sub: "per worked day", bar: "bg-synced" },
  ];

  const columns: HrCol<EmpRow>[] = [
    { key: "emp", label: "Employee", getValue: (r) => `${r.name} ${r.empNo}`, render: (r) => <Person name={r.name} sub={r.empNo} /> },
    { key: "pos", label: "Position", getValue: (r) => r.position, render: (r) => <Tag tone="info">{r.position}</Tag> },
    { key: "days", label: "Days", align: "right", filterType: "number", getValue: (r) => r.days, render: (r) => r.days },
    { key: "regular", label: "Regular", align: "right", filterType: "number", getValue: (r) => r.regular, render: (r) => <span className="font-mono">{h2(r.regular)} h</span> },
    { key: "ot", label: "Overtime", align: "right", filterType: "number", getValue: (r) => r.ot, render: (r) => (r.ot > 0 ? <span className="flex items-center gap-2"><Bar pct={(r.ot / maxOt) * 100} tone="bg-accent" w="w-16" /><span className="w-10 text-right font-mono text-[11px] text-ink-secondary">{h2(r.ot)} h</span></span> : <span className="text-ink-muted">—</span>) },
    { key: "late", label: "Late", align: "right", filterType: "number", getValue: (r) => r.lateMin, render: (r) => (r.lateMin > 0 ? <span className="font-mono text-time">{r.lateMin} min</span> : <span className="text-ink-muted">—</span>) },
    { key: "total", label: "Total", align: "right", filterType: "number", getValue: (r) => r.total, render: (r) => <span className="font-mono font-semibold text-ink">{h2(r.total)} h</span> },
  ];

  return (
    <>
      <HrTablePage<EmpRow>
        title="Working Hours"
        subtitle="Hours worked per employee"
        actions={data?.canManage ? <button type="button" className={hrPrimaryBtn} onClick={() => setAdding(true)}>+ Log hours</button> : undefined}
        stats={stats}
        periods={["This month", "Last month", "Custom"]}
        period={period}
        onPeriod={setPeriod}
        rows={rows}
        columns={columns}
        searchOf={(r) => `${r.name} ${r.empNo} ${r.position}`}
        searchPlaceholder="Search employee"
        loading={q.loading && !data}
        error={q.error}
        emptyLabel="No hours in this range."
        onRowClick={(r) => setDrill(r.id)}
        toolbarExtra={period === "Custom" ? (
          <span className="flex items-center gap-1">
            <span className="w-[120px]"><DateField value={from} onChange={(iso) => iso && setRange(iso, iso > to ? iso : to)} aria-label="From date" /></span>
            <span className="text-ink-muted">–</span>
            <span className="w-[120px]"><DateField value={to} onChange={(iso) => iso && setRange(iso < from ? iso : from, iso)} aria-label="To date" /></span>
          </span>
        ) : undefined}
        footer={() => <>Total hours <span className="font-semibold text-ink">{h2(totHours)} h</span> · {totDays} days</>}
      />
      {data && drill != null && <EmployeeDaysDrawer data={data} employeeId={drill} onClose={() => setDrill(null)} onChanged={() => q.reload()} />}
      {data && adding && <PickDayDrawer data={data} onClose={() => setAdding(false)} onPick={(employeeId) => { setAdding(false); setDrill(employeeId); }} />}
    </>
  );
}

function EmployeeDaysDrawer({ data, employeeId, onClose, onChanged }: { data: WorkingHoursResponse; employeeId: number; onClose: () => void; onChanged: () => void }) {
  const emp = data.employees.find((e) => e.id === employeeId);
  const [day, setDay] = useState<string | null>(null);
  const deptName = useMemo(() => new Map(data.departments.map((d) => [d.id, d.name])), [data]);
  const dates = useMemo(() => {
    const s = new Set<string>();
    for (const d of data.days) if (d.employeeId === employeeId) s.add(d.workDate);
    for (const e of data.entries) if (e.employeeId === employeeId) s.add(e.workDate);
    return [...s].sort((a, b) => b.localeCompare(a));
  }, [data, employeeId]);
  const dayOf = (wd: string) => data.days.find((d) => d.employeeId === employeeId && d.workDate === wd) ?? null;
  const loggedOf = (wd: string) => data.entries.filter((e) => e.employeeId === employeeId && e.workDate === wd);

  return (
    <>
      <ResizableDrawer
        onClose={onClose}
        title={<span><span className="font-mono">{emp?.empNo}</span> {emp?.name}</span>}
        subtitle={`${data.from} – ${data.to} · standard ${emp?.hoursPerDay ?? 9}h/day`}
        storageKey="hr-emp-days-drawer"
        defaultWidth={560}
        footer={<div className="flex justify-between"><button type="button" className={ghostBtn} onClick={() => setDay(todayMY())}>+ Log / edit a day</button><button type="button" className={ghostBtn} onClick={onClose}>Close</button></div>}
      >
        <div className="flex flex-col p-2">
          {dates.map((wd) => {
            const d = dayOf(wd);
            const entries = loggedOf(wd);
            const logged = entries.reduce((s, e) => s + e.hours, 0);
            return (
              <button key={wd} type="button" onClick={() => setDay(wd)} className="flex items-center gap-3 rounded-lg border-b border-border-subtle px-3 py-2 text-left hover:bg-row-hover">
                <span className="w-[86px] shrink-0 font-mono text-[12px] text-ink">{formatDate(wd)}</span>
                <span className="w-[120px] shrink-0 font-mono text-[11px] text-ink-secondary">{d?.clockIn ? `${d.clockIn}–${d.clockOut ?? "…"}` : "no punch"}</span>
                <span className="flex-1 text-[11px] text-ink-muted">{entries.map((e, i) => <span key={e.id} className="mr-2 whitespace-nowrap">{e.departmentId != null ? deptName.get(e.departmentId) ?? "?" : "No dept"} {h2(e.hours)}h{e.source === "MANUAL" && <span className="ml-0.5 text-[9px] font-bold text-learning">HR</span>}{i < entries.length - 1 ? "," : ""}</span>)}</span>
                <span className="shrink-0 font-mono text-[12px] font-semibold text-ink">{logged > 0 ? `${h2(logged)} h` : "—"}</span>
              </button>
            );
          })}
          {dates.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-ink-muted">No days with a punch or hours in this range.</div>}
        </div>
      </ResizableDrawer>
      {day && <DayHoursDrawer data={data} employeeId={employeeId} workDate={day} onClose={() => setDay(null)} onChanged={onChanged} />}
    </>
  );
}

function PickDayDrawer({ data, onClose, onPick }: { data: WorkingHoursResponse; onClose: () => void; onPick: (employeeId: number) => void }) {
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  return (
    <ResizableDrawer
      onClose={onClose}
      title="Log hours"
      subtitle="Pick the employee; open their days to log or edit."
      storageKey="hr-log-hours-pick"
      defaultWidth={420}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="button" className={primaryBtn} disabled={employeeId == null} onClick={() => employeeId != null && onPick(employeeId)}>Open days</button>
        </div>
      }
    >
      <div className="space-y-3 p-3">
        <Field label="Employee">
          <select className={inputCls} value={employeeId ?? ""} onChange={(e) => setEmployeeId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">--</option>
            {data.employees.filter((e) => e.status === "ACTIVE").map((e) => <option key={e.id} value={e.id}>{e.empNo} {e.name}</option>)}
          </select>
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
    try { await fn(); toast.success(ok); onChanged(); } catch (e) { toast.error(errText(e, "Could not save the hours.")); } finally { setBusy(false); }
  };
  const body = (d: { departmentId: string; hours: string; notes: string }) => ({ departmentId: d.departmentId ? Number(d.departmentId) : null, hours: Number(d.hours), notes: d.notes });
  const deptSelect = (value: string, onChange: (v: string) => void) => (
    <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">No department</option>
      {data.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
    </select>
  );

  return (
    <ResizableDrawer
      onClose={onClose}
      title={<span><span className="font-mono">{emp?.empNo}</span> {emp?.name}</span>}
      subtitle={`${formatDate(workDate)} · ${day?.clockIn ? `punch ${day.clockIn} to ${day.clockOut ?? "..."}${day.punchHours != null ? ` = ${h2(day.punchHours)}h` : ""}` : "no punch"} · standard ${emp?.hoursPerDay ?? 9}h`}
      storageKey="hr-day-hours-drawer"
      defaultWidth={560}
      footer={<div className="flex justify-end"><button type="button" className={ghostBtn} onClick={onClose}>Close</button></div>}
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
                <Field label="Hours"><input className={inputCls} value={d.hours} onChange={(ev) => set({ hours: ev.target.value })} inputMode="decimal" /></Field>
              </div>
              <Field label="Note" className="mt-2"><input className={inputCls} value={d.notes} onChange={(ev) => set({ notes: ev.target.value })} /></Field>
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" className={ghostBtn} disabled={busy} onClick={() => void run(() => api.del(`${HR}/working-hours/${e.id}`), "Hours removed")}><Trash2 size={11} /> Remove</button>
                <button type="button" className={primaryBtn} disabled={busy} onClick={() => void run(() => api.patch(`${HR}/working-hours/${e.id}`, body(d)), "Hours saved")}>Save</button>
              </div>
            </div>
          );
        })}
        <div className="rounded-md border border-dashed border-border p-2">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-brand text-ink-muted">{entries.length ? "Add a split (another department)" : "Log hours"}</div>
          <div className="grid grid-cols-[1fr_90px] gap-2">
            <Field label="Department">{deptSelect(fresh.departmentId, (v) => setFresh({ ...fresh, departmentId: v }))}</Field>
            <Field label="Hours"><input className={inputCls} value={fresh.hours} onChange={(ev) => setFresh({ ...fresh, hours: ev.target.value })} inputMode="decimal" /></Field>
          </div>
          <Field label="Note" className="mt-2"><input className={inputCls} value={fresh.notes} onChange={(ev) => setFresh({ ...fresh, notes: ev.target.value })} placeholder="e.g. forgot to punch, helped at KL WAREHOUSE" /></Field>
          <div className="mt-2 flex justify-end">
            <button type="button" className={primaryBtn} disabled={busy || !(Number(fresh.hours) > 0)} onClick={() => void run(() => api.post(`${HR}/working-hours`, { employeeId, date: workDate, ...body(fresh) }), "Hours logged").then(() => setFresh({ ...fresh, hours: "", notes: "" }))}><Plus size={11} /> Add</button>
          </div>
        </div>
        <p className="text-[10.5px] text-ink-muted">Hours HR saves here are kept: a later punch change never writes over them. The day&apos;s short-hour dock is re-checked on every save.</p>
      </div>
    </ResizableDrawer>
  );
}
