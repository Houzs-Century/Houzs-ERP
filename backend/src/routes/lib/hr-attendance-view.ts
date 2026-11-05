/* Pure pieces of the punch clock (routes/attendance.ts) and the Attendance
 * tab (routes/hr-attendance.ts), HC-0125 phase 2: the wire shape of a day,
 * what a punch should do given what is already stored, and the times an HR
 * correction resolves to. Tested without a database. */
import {
  AUTO_CLOSE_AFTER_HOURS,
  autoCloseMinute,
  computeAttendanceDay,
  minutesFromWorkDate,
  workClock,
  type AttendanceRules,
  type AttendanceStatus,
  type GeoResult,
  type PunchSource,
} from "../../scm/shared/hr-attendance";
import { hhmmToMin } from "../../scm/shared/hr-pay-rules";

export type AttendanceRow = {
  id: number;
  employee_id: number;
  work_date: string;
  status: string;
  clock_in_at: string | null;
  clock_out_at: string | null;
  in_source: string | null;
  out_source: string | null;
  in_lat: number | null;
  in_lng: number | null;
  in_accuracy_m: number | null;
  in_geo: string | null;
  in_site_id: number | null;
  in_distance_m: number | null;
  in_photo_key: string | null;
  out_lat: number | null;
  out_lng: number | null;
  out_accuracy_m: number | null;
  out_geo: string | null;
  out_site_id: number | null;
  out_distance_m: number | null;
  out_photo_key: string | null;
  notes: string | null;
};

export type PunchSide = {
  at: string;
  clock: string;
  source: PunchSource | null;
  geo: GeoResult | null;
  siteName: string | null;
  distanceM: number | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  hasPhoto: boolean;
};

export type AttendanceView = {
  id: number;
  employeeId: number;
  workDate: string;
  status: AttendanceStatus;
  in: PunchSide | null;
  out: PunchSide | null;
  open: boolean;
  lateMin: number;
  regularMin: number;
  otMin: number;
  shortfallMin: number;
  /** Minutes on site so far (open punch) or in total (closed), lunch not deducted. */
  spanMin: number | null;
  notes: string | null;
};

/** Postgres hands timestamptz back as "2026-10-22 08:01:00.12+08" (a bare
 *  "+08" offset JS will not parse) or as ISO; normalise both. */
export const asDate = (v: string): Date => new Date(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));

function side(row: AttendanceRow, which: "in" | "out", siteNames: ReadonlyMap<number, string>): PunchSide | null {
  const at = which === "in" ? row.clock_in_at : row.clock_out_at;
  if (!at) return null;
  const siteId = which === "in" ? row.in_site_id : row.out_site_id;
  return {
    at: asDate(at).toISOString(),
    clock: workClock(minutesFromWorkDate(row.work_date, asDate(at))),
    source: (which === "in" ? row.in_source : row.out_source) as PunchSource | null,
    geo: (which === "in" ? row.in_geo : row.out_geo) as GeoResult | null,
    siteName: siteId != null ? siteNames.get(siteId) ?? null : null,
    distanceM: which === "in" ? row.in_distance_m : row.out_distance_m,
    lat: which === "in" ? row.in_lat : row.out_lat,
    lng: which === "in" ? row.in_lng : row.out_lng,
    accuracyM: which === "in" ? row.in_accuracy_m : row.out_accuracy_m,
    hasPhoto: !!(which === "in" ? row.in_photo_key : row.out_photo_key),
  };
}

export function attendanceView(row: AttendanceRow, rules: AttendanceRules, siteNames: ReadonlyMap<number, string>, now: Date): AttendanceView {
  const inMin = row.clock_in_at ? minutesFromWorkDate(row.work_date, asDate(row.clock_in_at)) : null;
  const outMin = row.clock_out_at ? minutesFromWorkDate(row.work_date, asDate(row.clock_out_at)) : null;
  const open = inMin != null && outMin == null;
  /* An open day is judged up to now, so the phone and the tab show late and
     hours so far; a day with no clock-in has no times to judge. */
  const day = inMin != null ? computeAttendanceDay(inMin, outMin ?? minutesFromWorkDate(row.work_date, now), rules) : null;
  return {
    id: row.id,
    employeeId: row.employee_id,
    workDate: row.work_date,
    status: row.status as AttendanceStatus,
    in: side(row, "in", siteNames),
    out: side(row, "out", siteNames),
    open,
    lateMin: day?.lateMin ?? 0,
    regularMin: day?.regularWorkMin ?? 0,
    otMin: open ? 0 : day?.otMin ?? 0,
    shortfallMin: open || !day ? 0 : day.shortfallMin,
    spanMin: inMin != null ? Math.max(0, (outMin ?? minutesFromWorkDate(row.work_date, now)) - inMin) : null,
    notes: row.notes,
  };
}

/** Is an open punch a forgotten clock-out rather than a long day? */
export function isForgottenOpenPunch(clockInAt: Date, now: Date): boolean {
  return now.getTime() - clockInAt.getTime() >= AUTO_CLOSE_AFTER_HOURS * 3600_000;
}

/** Where a forgotten punch is closed, as an instant, never before its clock-in. */
export function autoCloseAt(workDate: string, clockInAt: Date, rules: AttendanceRules): Date {
  const inMin = minutesFromWorkDate(workDate, clockInAt);
  const outMin = autoCloseMinute(inMin, rules);
  return new Date(clockInAt.getTime() + (outMin - inMin) * 60000);
}

export type PunchPlan =
  | { kind: "insert" }
  | { kind: "stamp-in"; rowId: number }
  | { kind: "already-in"; rowId: number }
  | { kind: "already-out"; rowId: number; clock: string }
  | { kind: "stamp-out"; rowId: number }
  | { kind: "no-open-punch" };

/* What a phone punch does. `today` is the employee's row for today's work
 * date; `open` is their newest row with a clock-in and no clock-out that is
 * NOT forgotten (forgotten ones are closed before this is asked).
 *   CLOCK_IN : a second tap is a no-op; a day already clocked out is refused
 *              (HR corrects it), not silently reopened.
 *   CLOCK_OUT: closes the open punch even when it started yesterday, which is
 *              the driver back after midnight. */
export function planPunch(
  action: "CLOCK_IN" | "CLOCK_OUT",
  today: { id: number; clock_in_at: string | null; clock_out_at: string | null; work_date: string } | null,
  open: { id: number } | null,
): PunchPlan {
  if (action === "CLOCK_IN") {
    if (open) return { kind: "already-in", rowId: open.id };
    if (!today) return { kind: "insert" };
    if (!today.clock_in_at) return { kind: "stamp-in", rowId: today.id };
    if (today.clock_out_at) {
      return { kind: "already-out", rowId: today.id, clock: workClock(minutesFromWorkDate(today.work_date, asDate(today.clock_out_at))) };
    }
    return { kind: "already-in", rowId: today.id };
  }
  if (open) return { kind: "stamp-out", rowId: open.id };
  if (today?.clock_out_at) {
    return { kind: "already-out", rowId: today.id, clock: workClock(minutesFromWorkDate(today.work_date, asDate(today.clock_out_at))) };
  }
  return { kind: "no-open-punch" };
}

/* An HR correction gives times as "HH:MM" on the work date. A clock-out
 * earlier than the clock-in is the next morning. Blank = no punch. */
export function correctionTimes(
  workDate: string,
  clockIn: string,
  clockOut: string,
): { ok: true; inMin: number | null; outMin: number | null } | { ok: false; message: string } {
  const inMin = clockIn.trim() ? hhmmToMin(clockIn) : null;
  const outRaw = clockOut.trim() ? hhmmToMin(clockOut) : null;
  if (clockIn.trim() && inMin == null) return { ok: false, message: "Clock-in time is HH:MM, e.g. 08:05." };
  if (clockOut.trim() && outRaw == null) return { ok: false, message: "Clock-out time is HH:MM, e.g. 18:10." };
  if (inMin != null && inMin >= 1440) return { ok: false, message: "Clock-in must be on the work date." };
  if (outRaw != null && inMin == null) return { ok: false, message: "A clock-out needs a clock-in." };
  const outMin = outRaw == null || inMin == null ? outRaw : outRaw < inMin ? outRaw + 1440 : outRaw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return { ok: false, message: "Pick the work date." };
  return { ok: true, inMin, outMin };
}
