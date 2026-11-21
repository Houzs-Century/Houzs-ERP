/* HR · Attendance (step-2 re-skin). Today's status as four cards, then the
 * whole month as a grid (sticky employee column + day header), built from the
 * working-hours range read (present / absent / leave / rest per day) and the
 * attendance day read for today. Per-day "late" is shown in today's cards; the
 * month grid marks it in a later pass (needs a per-day lateMin month read). */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { HrPageHeader } from "./HrPageHeader";
import { avatarColor, initials } from "./hrAvatar";
import { punchOf, type PunchState } from "./attendanceToday";
import { useAttendance, useWorkingHours, type WorkDay } from "./hrApi";
import { todayMY } from "../../vendor/shared/format";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const WD = ["S", "M", "T", "W", "T", "F", "S"];
const pad2 = (n: number) => String(n).padStart(2, "0");

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

type Cell = "present" | "absent" | "leave" | "rest" | "notin" | "future";
const LEAVE_STATUSES = new Set(["MEDICAL_LEAVE", "ANNUAL_LEAVE", "UNPAID_LEAVE"]);
function cellOf(day: WorkDay | undefined, future: boolean): Cell {
  if (future) return "future";
  if (!day) return "notin";
  if (day.status === "REST_DAY") return "rest";
  if (LEAVE_STATUSES.has(day.status)) return "leave";
  if (day.status === "ABSENT") return "absent";
  return "present";
}
const CELL: Record<Cell, { bg: string; letter: string; color: string }> = {
  present: { bg: "bg-synced-bg", letter: "", color: "" },
  absent: { bg: "bg-err-bg", letter: "A", color: "text-err" },
  leave: { bg: "bg-surface-dim", letter: "V", color: "text-ink-muted" },
  rest: { bg: "", letter: "·", color: "text-ink-soft" },
  notin: { bg: "bg-surface-2", letter: "?", color: "text-ink-muted" },
  future: { bg: "", letter: "", color: "" },
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

  const totalsOf = (empId: number) => {
    let pres = 0, abs = 0, lv = 0;
    for (const d of dayList) {
      const future = isCurrentMonth && d > todayDay;
      const c = cellOf(byDay.get(`${empId}-${month}-${pad2(d)}`), future);
      if (c === "present") pres++;
      else if (c === "absent") abs++;
      else if (c === "leave") lv++;
    }
    return { pres, abs, lv };
  };

  return (
    <>
      <HrPageHeader title="Attendance" subtitle="Today at the top, the whole month below" />
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
              <Legend bg="bg-synced-bg" label="Present" /><Legend bg="bg-err-bg" label="Absent" /><Legend bg="bg-surface-dim" label="Leave" /><Legend bg="bg-surface-2" label="No punch" />
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
                        <th key={d} className={cx("sticky top-0 z-20 min-w-[26px] border-b border-border-subtle px-0 py-1 text-center font-semibold", isToday ? "bg-primary-soft" : "bg-surface")}>
                          <div className="text-[9px] text-ink-muted">{weekdayLetter(y, m, d)}</div>
                          <div className={cx("text-[10px]", isToday ? "text-primary-ink" : "text-ink-secondary")}>{d}</div>
                        </th>
                      );
                    })}
                    {["PRES", "ABS", "LV"].map((t) => <th key={t} className="sticky top-0 z-20 min-w-[34px] border-b border-l border-border-subtle bg-surface-2 px-1 py-1.5 text-center text-[9px] font-bold text-ink-muted">{t}</th>)}
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
                          return (
                            <td key={d} className={cx("border-b border-r border-border-subtle p-0.5 text-center", isToday && "bg-primary-soft/30")}>
                              <div className={cx("mx-auto flex h-6 w-6 items-center justify-center rounded text-[9px] font-bold", s.bg, s.color)}>{s.letter}</div>
                            </td>
                          );
                        })}
                        <td className="border-b border-l border-border-subtle text-center font-semibold text-synced">{t.pres}</td>
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
    </>
  );
}

function Legend({ bg, label }: { bg: string; label: string }) {
  return <span className="flex items-center gap-1"><span className={cx("h-3 w-3 rounded-sm border border-border-subtle", bg)} />{label}</span>;
}
