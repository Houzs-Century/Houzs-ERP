/* Pure pieces of the self-service leave flow (HC-0125). The leave types a worker
 * can apply for ARE the hr_attendance leave statuses payroll already prices, so
 * an approval just stamps those days onto attendance — there is no separate
 * leave vocabulary to keep in sync. Tested without a database. */
import type { AttendanceStatus } from "../../scm/shared/hr-attendance";

export const APPLICABLE_LEAVE_TYPES: ReadonlyArray<{ value: AttendanceStatus; label: string; paid: boolean }> = [
  { value: "ANNUAL_LEAVE", label: "Annual leave", paid: true },
  { value: "MEDICAL_LEAVE", label: "Medical leave", paid: true },
  { value: "UNPAID_LEAVE", label: "Unpaid leave", paid: false },
];
const TYPES = new Set<string>(APPLICABLE_LEAVE_TYPES.map((t) => t.value));

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LEAVE_DAYS = 60;

export type LeaveParse = { ok: true; leaveStatus: AttendanceStatus; days: string[] } | { ok: false; message: string };

/** Validate a leave request and expand it to the inclusive list of ISO dates it
 *  covers. Leave can be filed for a past day (recording a sick day), so there is
 *  no future-only rule; capped at MAX_LEAVE_DAYS so one request cannot stamp a
 *  year of attendance. */
export function parseLeaveRequest(leaveType: string, startDate: string, endDate: string): LeaveParse {
  if (!TYPES.has(leaveType)) return { ok: false, message: "Pick the kind of leave." };
  if (!YMD.test(startDate) || !YMD.test(endDate)) return { ok: false, message: "Pick the first and last day." };
  if (endDate < startDate) return { ok: false, message: "The last day is before the first day." };
  const days = eachDate(startDate, endDate);
  if (days.length > MAX_LEAVE_DAYS) return { ok: false, message: `One request covers at most ${MAX_LEAVE_DAYS} days.` };
  return { ok: true, leaveStatus: leaveType as AttendanceStatus, days };
}

/** Inclusive list of YYYY-MM-DD dates from start to end (UTC, so no TZ drift). */
export function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
