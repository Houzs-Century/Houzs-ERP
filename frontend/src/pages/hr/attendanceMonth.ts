import type { WorkDay } from "./hrApi";

/** What one employee-day reads as. "notin" is a day with no punch; "future" a
 *  day later than today in the current month. */
export type Cell = "present" | "late" | "absent" | "leave" | "rest" | "notin" | "future";

const LEAVE_STATUSES = new Set(["MEDICAL_LEAVE", "ANNUAL_LEAVE", "UNPAID_LEAVE"]);

export function cellOf(day: WorkDay | undefined, future: boolean): Cell {
  if (future) return "future";
  if (!day) return "notin";
  if (day.status === "REST_DAY") return "rest";
  if (LEAVE_STATUSES.has(day.status)) return "leave";
  if (day.status === "ABSENT") return "absent";
  return day.lateMin > 0 ? "late" : "present";
}

export const pad2 = (n: number): string => String(n).padStart(2, "0");

export function monthBounds(month: string): { y: number; m: number; days: number } {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { y, m, days };
}

/** On-time / late / absent for one work date; rate is on-time over those three,
 *  or null for a date that carries only leave or rest (nothing to grade). */
export type DayStat = { date: string; onTime: number; late: number; absent: number; rate: number | null };

/** A month of the working-hours `days` read, rolled up two ways:
 *  - perDay: on-time / late / absent per work date, date order, only dates that
 *    carry at least one graded record.
 *  - lateByEmp: how many days each employee was late.
 *  Leave and rest count as neither on-time, late nor absent. */
export function monthAttendanceStats(days: ReadonlyArray<WorkDay>): { perDay: DayStat[]; lateByEmp: Map<number, number> } {
  const byDate = new Map<string, { onTime: number; late: number; absent: number }>();
  const lateByEmp = new Map<number, number>();
  for (const d of days) {
    const c = cellOf(d, false);
    if (c !== "present" && c !== "late" && c !== "absent") continue;
    const cur = byDate.get(d.workDate) ?? { onTime: 0, late: 0, absent: 0 };
    if (c === "present") cur.onTime++;
    else if (c === "late") {
      cur.late++;
      lateByEmp.set(d.employeeId, (lateByEmp.get(d.employeeId) ?? 0) + 1);
    } else cur.absent++;
    byDate.set(d.workDate, cur);
  }
  const perDay = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]): DayStat => {
      const total = v.onTime + v.late + v.absent;
      return { date, onTime: v.onTime, late: v.late, absent: v.absent, rate: total > 0 ? v.onTime / total : null };
    });
  return { perDay, lateByEmp };
}

/** The employee names behind one day, split by state, for the chart's hover
 *  card. Rest and no-punch days carry nobody. */
export type DayDetail = { onTime: string[]; late: string[]; absent: string[]; leave: string[] };

/** Per work date, the names on time / late / absent / on leave — built from the
 *  working-hours `days` and the employee list. Only dates with a real record
 *  appear. */
export function monthDayDetail(
  days: ReadonlyArray<WorkDay>,
  employees: ReadonlyArray<{ id: number; name: string }>,
): Map<string, DayDetail> {
  const nameOf = new Map(employees.map((e) => [e.id, e.name]));
  const m = new Map<string, DayDetail>();
  for (const d of days) {
    const c = cellOf(d, false);
    if (c !== "present" && c !== "late" && c !== "absent" && c !== "leave") continue;
    const cur = m.get(d.workDate) ?? { onTime: [], late: [], absent: [], leave: [] };
    const name = nameOf.get(d.employeeId) ?? `#${d.employeeId}`;
    if (c === "present") cur.onTime.push(name);
    else if (c === "late") cur.late.push(name);
    else if (c === "absent") cur.absent.push(name);
    else cur.leave.push(name);
    m.set(d.workDate, cur);
  }
  return m;
}
