/* HR · Attendance (v3 design). Today's status as four cards, then the whole
 * month as a grid (sticky employee column + day header), built from the
 * working-hours range read (present / late / absent / leave / rest per day) and
 * the attendance day read for today. Lateness comes from each day's lateMin on
 * the working-hours read, shown in today's cards and marked in the month grid.
 * "Record attendance" and clicking a day open a form to set / correct that day
 * (status + clock-in / out); Export downloads the month grid as CSV. */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { DateField } from "../../vendor/scm/components/DateField";
import { errText, inputCls, ghostBtn, primaryBtn, dangerBtn } from "../pos-admin/posAdminUi";
import { HrPageHeader, hrPrimaryBtn, hrSecondaryBtn } from "./HrPageHeader";
import { avatarColor, initials } from "./hrAvatar";
import { punchOf, type PunchState } from "./attendanceToday";
import { HR, useAttendance, useWorkingHours, type WorkDay } from "./hrApi";
import { todayMY } from "../../vendor/shared/format";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const WD = ["S", "M", "T", "W", "T", "F", "S"];
const pad2 = (n: number) => String(n).padStart(2, "0");

const STATUSES: { value: string; label: string }[] = [
  { value: "PRESENT", label: "Present" },
  { value: "HALF_DAY", label: "Half day" },
  { value: "ABSENT", label: "Absent" },
  { value: "ANNUAL_LEAVE", label: "Annual leave" },
  { value: "MEDICAL_LEAVE", label: "Medical leave" },
  { value: "UNPAID_LEAVE", label: "Unpaid leave" },
  { value: "REST_DAY", label: "Rest day" },
];
const hasTimes = (s: string) => s === "PRESENT" || s === "HALF_DAY";

function monthBounds(month: string): { y: number; m: number; days: number } {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { y, m, days };
}
const weekdayLetter = (y: number, m: number, day: number) => WD[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
const shiftMonth = (month: string, by: number): string => {
  const [y, m] = month.split("-").map(Number);
  const idx = (y * 12 + (m - 1)) + by;
  return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`;
};

type Cell = "present" | "late" | "absent" | "leave" | "rest" | "notin" | "future";
const LEAVE_STATUSES = new Set(["MEDICAL_LEAVE", "ANNUAL_LEAVE", "UNPAID_LEAVE"]);
function cellOf(day: WorkDay | undefined, future: boolean): Cell {
  if (future) return "future";
  if (!day) return "notin";
  if (day.status === "REST_DAY") return "rest";
  if (LEAVE_STATUSES.has(day.status)) return "leave";
  if (day.status === "ABSENT") return "absent";
  return day.lateMin > 0 ? "late" : "present";
}
const CELL: Record<Cell, { bg: string; letter: string; color: string; dot: boolean }> = {
  present: { bg: "bg-synced-bg", letter: "", color: "text-synced", dot: true },
  late: { bg: "bg-time/15", letter: "L", color: "text-time", dot: false },
  absent: { bg: "bg-err-bg", letter: "A", color: "text-err", dot: false },
  leave: { bg: "bg-surface-dim", letter: "V", color: "text-ink-secondary", dot: false },
  // Rest days and days with no punch stay blank, so the month reads calm and
  // only real exceptions (late / absent / leave) draw the eye. Before go-live
  // every past day has no punch; a grid full of grey "?" was the eye-strain.
  rest: { bg: "", letter: "", color: "", dot: false },
  notin: { bg: "", letter: "", color: "", dot: false },
  future: { bg: "", letter: "", color: "", dot: false },
};

const STATUS: { key: PunchState; label: string; dot: string }[] = [
  { key: "on", label: "On duty", dot: "bg-synced" },
  { key: "late", label: "Late", dot: "bg-time" },
  { key: "out", label: "Not in yet", dot: "bg-err" },
  { key: "leave", label: "On leave", dot: "bg-ink-muted" },
];

function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  return <span className={cx("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white", avatarColor(name))} style={{ width: size, height: size, fontSize: size * 0.38 }} title={name}>{initials(name)}</span>;
}

type EditInit = { employeeId: number | null; date: string; status: string; clockIn: string; clockOut: string; attendanceId: number | null };

export function AttendancePage() {
  const today = todayMY().slice(0, 10);
  const [params, setParams] = useSearchParams();
  const month = /^\d{4}-\d{2}$/.test(params.get("month") ?? "") ? (params.get("month") as string) : today.slice(0, 7);
  const setMonth = (next: string) => setParams((p) => { const n = new URLSearchParams(p); n.set("month", next); return n; }, { replace: true });

  const { y, m, days } = monthBounds(month);
  const first = `${month}-01`;
  const last = `${month}-${pad2(days)}`;
  const to = last < today ? last : today;
  const grid = useWorkingHours(first, to < first ? first : to);
  const att = useAttendance(today);
  const [edit, setEdit] = useState<EditInit | null>(null);

  const canManage = grid.data?.canManage ?? false;

  // Today's four status cards, from the attendance day read.
  const todayRows = useMemo(() => (att.data?.rows ?? []).map((r) => ({ name: r.employee.name, state: punchOf(r.day).state })), [att.data]);
  const countOf = (s: PunchState) => todayRows.filter((r) => r.state === s).length;

  // Month grid, from the working-hours range read.
  const employees = grid.data?.employees ?? [];
  const byDay = useMemo(() => {
    const m2 = new Map<string, WorkDay>();
    for (const d of grid.data?.days ?? []) m2.set(`${d.employeeId}-${d.workDate}`, d);
    return m2;
  }, [grid.data]);
  const isCurrentMonth = month === today.slice(0, 7);
  const todayDay = Number(today.slice(8, 10));
  const dayList = Array.from({ length: days }, (_, i) => i + 1);
  const isWeekend = (day: number) => { const dow = new Date(Date.UTC(y, m - 1, day)).getUTCDay(); return dow === 0 || dow === 6; };

  const totalsOf = (empId: number) => {
    let pres = 0, late = 0, abs = 0, lv = 0;
    for (const d of dayList) {
      const future = isCurrentMonth && d > todayDay;
      const c = cellOf(byDay.get(`${empId}-${month}-${pad2(d)}`), future);
      if (c === "present" || c === "late") { pres++; if (c === "late") late++; }
      else if (c === "absent") abs++;
      else if (c === "leave") lv++;
    }
    return { pres, late, abs, lv };
  };

  const openCell = (empId: number, d: number) => {
    const date = `${month}-${pad2(d)}`;
    const wd = byDay.get(`${empId}-${date}`);
    setEdit({ employeeId: empId, date, status: wd?.status ?? "PRESENT", clockIn: wd?.clockIn ?? "", clockOut: wd?.clockOut ?? "", attendanceId: wd?.attendanceId ?? null });
  };

  const exportCsv = () => {
    const head = ["Emp No", "Employee", ...dayList.map((d) => String(d))].join(",");
    const lines = employees.map((e) => {
      const cells = dayList.map((d) => {
        const future = isCurrentMonth && d > todayDay;
        const c = cellOf(byDay.get(`${e.id}-${month}-${pad2(d)}`), future);
        return c === "present" ? "P" : c === "late" ? "L" : c === "absent" ? "A" : c === "leave" ? "V" : c === "rest" ? "R" : "";
      });
      return [e.empNo, `"${e.name}"`, ...cells].join(",");
    });
    const blob = new Blob([[head, ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `attendance-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <HrPageHeader
        title="Attendance"
        subtitle="Today at the top, the whole month below"
        actions={
          <span className="flex gap-2">
            <button type="button" className={hrSecondaryBtn} onClick={exportCsv} disabled={!grid.data}>Export</button>
            {canManage && <button type="button" className={hrPrimaryBtn} onClick={() => setEdit({ employeeId: null, date: today, status: "PRESENT", clockIn: "", clockOut: "", attendanceId: null })}>Record attendance</button>}
          </span>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
        {/* today's status cards */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {STATUS.map((s) => {
            const list = todayRows.filter((r) => r.state === s.key);
            return (
              <div key={s.key} className="rounded-xl border border-border bg-surface px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className={cx("h-2 w-2 rounded-full", s.dot)} />
                  <span className="text-[12.5px] font-semibold text-ink-secondary">{s.label}</span>
                  <span className="ml-auto text-[20px] font-bold leading-none text-ink">{att.data ? countOf(s.key) : "—"}</span>
                </div>
                <div className="mt-2.5 flex">
                  {list.slice(0, 8).map((r, i) => <span key={i} className="-ml-1.5 rounded-full ring-2 ring-surface first:ml-0"><Avatar name={r.name} size={24} /></span>)}
                </div>
              </div>
            );
          })}
        </div>

        {/* month grid */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
          <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-3 py-2.5">
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => setMonth(shiftMonth(month, -1))} className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2">‹</button>
              <span className="min-w-[90px] text-center font-mono text-[13px] font-semibold text-ink">{month}</span>
              <button type="button" disabled={isCurrentMonth} onClick={() => setMonth(shiftMonth(month, 1))} className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 disabled:opacity-40">›</button>
            </div>
            <div className="ml-auto flex items-center gap-3 text-[11px] text-ink-muted">
              <Legend bg="bg-synced-bg" label="Present" /><Legend bg="bg-time/15" label="Late" /><Legend bg="bg-err-bg" label="Absent" /><Legend bg="bg-surface-dim" label="Leave" />
            </div>
          </div>

          <div className="thin-scroll min-h-0 flex-1 overflow-auto">
            {grid.loading && !grid.data && <div className="px-4 py-10 text-center text-[12px] text-ink-muted">Loading…</div>}
            {grid.error && <div className="px-4 py-10 text-center text-[12px] text-err">{grid.error}</div>}
            {grid.data && (
              <table className="border-separate border-spacing-0 text-[11px]">
                <thead>
                  <tr>
                    <th className="sticky left-0 top-0 z-30 w-[220px] min-w-[220px] border-b border-border-subtle bg-surface-2 px-3 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-ink-muted">Employee</th>
                    {dayList.map((d) => {
                      const isToday = isCurrentMonth && d === todayDay;
                      return (
                        <th key={d} className={cx("sticky top-0 z-20 min-w-[26px] border-b border-border-subtle px-0 py-1 text-center font-semibold", isToday ? "bg-primary-soft" : isWeekend(d) ? "bg-surface-dim" : "bg-surface")}>
                          <div className="text-[9px] text-ink-muted">{weekdayLetter(y, m, d)}</div>
                          <div className={cx("text-[10px]", isToday ? "text-primary-ink" : "text-ink-secondary")}>{d}</div>
                        </th>
                      );
                    })}
                    {["PRES", "LATE", "ABS", "LV"].map((t) => <th key={t} className="sticky top-0 z-20 min-w-[34px] border-b border-l border-border-subtle bg-surface-2 px-1 py-1.5 text-center text-[9px] font-bold text-ink-muted">{t}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {employees.map((e) => {
                    const t = totalsOf(e.id);
                    return (
                      <tr key={e.id} className="group">
                        <th className="sticky left-0 z-10 w-[220px] min-w-[220px] border-b border-border-subtle bg-surface px-3 py-1 text-left group-hover:bg-row-hover">
                          <span className="flex items-center gap-2">
                            <Avatar name={e.name} size={24} />
                            <span className="min-w-0"><span className="block truncate text-[12px] font-semibold text-ink">{e.name}</span><span className="block font-mono text-[10px] text-accent">{e.empNo}</span></span>
                          </span>
                        </th>
                        {dayList.map((d) => {
                          const future = isCurrentMonth && d > todayDay;
                          const isToday = isCurrentMonth && d === todayDay;
                          const c = cellOf(byDay.get(`${e.id}-${month}-${pad2(d)}`), future);
                          const s = CELL[c];
                          const editable = canManage && !future;
                          return (
                            <td key={d} className={cx("border-b border-border-subtle px-0.5 py-1 text-center", isToday ? "bg-primary-soft/30" : isWeekend(d) && "bg-surface-dim/40")}>
                              {editable ? (
                                <button type="button" onClick={() => openCell(e.id, d)} aria-label={`${e.name} ${month}-${pad2(d)}`} className={cx("mx-auto flex h-6 w-6 items-center justify-center rounded-md text-[9px] font-bold hover:ring-1 hover:ring-primary", s.bg, s.color)}>{s.dot ? <span className="h-1.5 w-1.5 rounded-full bg-synced/70" /> : s.letter}</button>
                              ) : (
                                <div className={cx("mx-auto flex h-6 w-6 items-center justify-center rounded-md text-[9px] font-bold", s.bg, s.color)}>{s.dot ? <span className="h-1.5 w-1.5 rounded-full bg-synced/70" /> : s.letter}</div>
                              )}
                            </td>
                          );
                        })}
                        <td className="border-b border-l border-border-subtle text-center font-semibold text-synced">{t.pres}</td>
                        <td className="border-b border-border-subtle text-center font-semibold text-time">{t.late}</td>
                        <td className="border-b border-border-subtle text-center font-semibold text-err">{t.abs}</td>
                        <td className="border-b border-border-subtle text-center font-semibold text-ink-muted">{t.lv}</td>
                      </tr>
                    );
                  })}
                  {employees.length === 0 && <tr><td className="px-4 py-10 text-center text-[12px] text-ink-muted">No attendance in this month.</td></tr>}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
      {edit && grid.data && (
        <RecordModal
          employees={grid.data.employees.map((e) => ({ id: e.id, empNo: e.empNo, name: e.name }))}
          init={edit}
          maxDate={today}
          onClose={() => setEdit(null)}
          onSaved={() => { setEdit(null); grid.reload(); att.reload(); }}
        />
      )}
    </>
  );
}

function Legend({ bg, label }: { bg: string; label: string }) {
  return <span className="flex items-center gap-1"><span className={cx("h-3 w-3 rounded-sm border border-border-subtle", bg)} />{label}</span>;
}

function RecordModal({ employees, init, maxDate, onClose, onSaved }: { employees: { id: number; empNo: string; name: string }[]; init: EditInit; maxDate: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const dialog = useDialog();
  const [employeeId, setEmployeeId] = useState<number | null>(init.employeeId);
  const [date, setDate] = useState(init.date);
  const [status, setStatus] = useState(init.status);
  const [clockIn, setClockIn] = useState(init.clockIn);
  const [clockOut, setClockOut] = useState(init.clockOut);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const lbl = "mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-muted";

  async function save() {
    if (employeeId == null) { toast.error("Pick the employee."); return; }
    if (hasTimes(status) && status === "PRESENT" && !clockIn) { toast.error("Present needs a clock-in time."); return; }
    setBusy(true);
    try {
      await api.put(`${HR}/attendance`, { employeeId, date, status, clockIn: hasTimes(status) ? clockIn : "", clockOut: hasTimes(status) ? clockOut : "", notes });
      toast.success("Attendance saved");
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not save the attendance."));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (init.attendanceId == null) return;
    const ok = await dialog.confirm({
      title: "Remove this day's attendance?",
      message: "The punches, their photos and GPS are removed from this day. Use it for a test punch or a punch on the wrong day.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.del(`${HR}/attendance/${init.attendanceId}`);
      toast.success("Day removed");
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not remove the day."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4" onMouseDown={onClose}>
      <div className="my-10 w-full max-w-[440px] rounded-2xl bg-surface shadow-[0_24px_64px_-16px_rgba(17,20,15,.35)]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="border-b border-border-subtle px-5 py-3">
          <h3 className="text-[15px] font-bold text-ink">Record attendance</h3>
          <p className="text-[11.5px] text-ink-muted">Set or correct a day. A time you change becomes a manual correction.</p>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4">
          <label className="block"><span className={lbl}>Employee</span>
            <select className={inputCls} value={employeeId ?? ""} disabled={init.employeeId != null} onChange={(e) => setEmployeeId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">--</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.empNo} {e.name}</option>)}
            </select>
          </label>
          <label className="block"><span className={lbl}>Day</span><DateField fullWidth value={date} max={maxDate} onChange={(iso) => iso && setDate(iso)} aria-label="Day" /></label>
          <label className="block"><span className={lbl}>Status</span>
            <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          {hasTimes(status) && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><span className={lbl}>Clock in</span><input type="time" className={inputCls} value={clockIn} onChange={(e) => setClockIn(e.target.value)} /></label>
              <label className="block"><span className={lbl}>Clock out</span><input type="time" className={inputCls} value={clockOut} onChange={(e) => setClockOut(e.target.value)} /></label>
            </div>
          )}
          <label className="block"><span className={lbl}>Note (optional)</span><input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. forgot to punch, on MC" /></label>
        </div>
        <div className="flex items-center gap-2 border-t border-border-subtle px-5 py-3">
          {init.attendanceId != null && <button type="button" className={dangerBtn} disabled={busy} onClick={() => void remove()}>Remove day</button>}
          <span className="ml-auto" />
          <button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="button" className={primaryBtn} disabled={busy} onClick={() => void save()}>Save</button>
        </div>
      </div>
    </div>
  );
}
