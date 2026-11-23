/* One place to read "where is this employee right now" from the attendance
 * day read, shared by Employee Master and Overview so the mapping lives once.
 * There is no LATE status (lateness is a per-day lateMin), so a present punch
 * past the shift start reads as "late". */
import { APPROVED_LEAVE_STATUSES } from "../../vendor/shared/hr-attendance";
import type { AttendanceDay, AttendanceResponse } from "./hrApi";

export type PunchState = "on" | "late" | "out" | "leave";

// The statuses that mean "on approved leave today" — one home, in the shared
// attendance module (medical / annual / rest / unpaid).
const LEAVE_STATUSES = new Set<string>(APPROVED_LEAVE_STATUSES);

export function punchOf(day: AttendanceDay | null): { state: PunchState; time: string | null; lateMin: number } {
  if (!day) return { state: "out", time: null, lateMin: 0 };
  if (LEAVE_STATUSES.has(day.status)) return { state: "leave", time: null, lateMin: 0 };
  if (day.status === "PRESENT" || day.status === "HALF_DAY") return { state: day.lateMin > 0 ? "late" : "on", time: day.in?.clock ?? null, lateMin: day.lateMin };
  return { state: "out", time: null, lateMin: 0 };
}

export function dayByEmployee(res: AttendanceResponse | null): Map<number, AttendanceDay | null> {
  const m = new Map<number, AttendanceDay | null>();
  for (const row of res?.rows ?? []) m.set(row.employee.id, row.day);
  return m;
}
