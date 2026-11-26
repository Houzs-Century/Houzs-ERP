import { APPROVED_LEAVE_STATUSES } from "../../vendor/shared/hr-attendance";
import type { AttendanceDay, AttendanceResponse } from "./hrApi";

export type PunchState = "on" | "late" | "out" | "leave";

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
