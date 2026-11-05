/* HR attendance: the day maths and the punch-location check, ported from
 * Hookka (src/lib/attendance-rules.ts, src/api/lib/geofence.ts) for HC-0125
 * phase 2. Nothing derived is stored on a punch: late, regular and OT minutes
 * are computed from the two times and the pay rules in force on the work
 * date, so a rule change or a corrected punch never leaves a stale figure.
 *
 * Times are minutes from MIDNIGHT OF THE WORK DATE (Malaysia). A clock-out
 * after midnight is > 1440: drivers come back from outstation runs after
 * twelve, which Hookka's same-date rule refused.
 *
 * ONE home. backend/src/scm/shared/hr-attendance.ts is the original and
 * frontend/src/vendor/shared/hr-attendance.ts its byte-identical copy
 * (check-shared-mirrors.mjs).
 */
import type { PayRulesConfig } from "./hr-pay-rules";

export type AttendanceStatus = "PRESENT" | "ABSENT" | "HALF_DAY" | "MEDICAL_LEAVE" | "ANNUAL_LEAVE" | "REST_DAY" | "UNPAID_LEAVE";
export const ATTENDANCE_STATUSES: ReadonlyArray<{ value: AttendanceStatus; label: string }> = [
  { value: "PRESENT", label: "Present" },
  { value: "ABSENT", label: "Absent" },
  { value: "HALF_DAY", label: "Half day" },
  { value: "MEDICAL_LEAVE", label: "Medical leave" },
  { value: "ANNUAL_LEAVE", label: "Annual leave" },
  { value: "REST_DAY", label: "Rest day" },
  { value: "UNPAID_LEAVE", label: "Unpaid leave" },
];

/* Leave HR approved (phase 5): never a missed day for the driver's commission.
 * The first three are paid, so payroll does not count them absent either. */
export const PAID_LEAVE_STATUSES: ReadonlyArray<AttendanceStatus> = ["MEDICAL_LEAVE", "ANNUAL_LEAVE", "REST_DAY"];
export const APPROVED_LEAVE_STATUSES: ReadonlyArray<AttendanceStatus> = [...PAID_LEAVE_STATUSES, "UNPAID_LEAVE"];

export type PunchSource = "PHONE" | "MANUAL" | "AUTO";
export type GeoResult = "IN" | "OUT" | "NONE";

export type AttendanceRules = {
  startMin: number;
  endMin: number;
  lunchMin: number;
  lunchStartMin: number;
  lunchEndMin: number;
  standardWorkMin: number;
  lateGraceMin: number;
  lateBlockMin: number;
  otBlockMin: number;
};

/** The day rules for a pay-rules snapshot. Lunch sits at 12:00 for its
 *  configured length; the maths deducts only its overlap with the worked
 *  window, so arriving after lunch drops none. */
export function toAttendanceRules(cfg: PayRulesConfig): AttendanceRules {
  const lunchStartMin = 12 * 60;
  return {
    startMin: cfg.shiftStartMin,
    endMin: cfg.shiftEndMin,
    lunchMin: cfg.lunchMin,
    lunchStartMin,
    lunchEndMin: lunchStartMin + cfg.lunchMin,
    standardWorkMin: Math.max(0, cfg.shiftEndMin - cfg.shiftStartMin - cfg.lunchMin),
    lateGraceMin: cfg.lateGraceMin,
    lateBlockMin: Math.max(1, cfg.lateBlockMin),
    otBlockMin: Math.max(1, cfg.otBlockMin),
  };
}

export type AttendanceDay = {
  lateMin: number;
  isLate: boolean;
  regularWorkMin: number;
  shortfallMin: number;
  otMin: number;
};

/* Lateness past the grace counts from shift start in full and rounds UP to
 * the late block; lunch is the overlap with the worked window; OT only after
 * shift end, floored to whole OT blocks, less than one block is none; OT
 * offsets a shortfall minute for minute. */
export function computeAttendanceDay(clockInMin: number, clockOutMin: number, rules: AttendanceRules): AttendanceDay {
  const rawLate = Math.max(0, clockInMin - rules.startMin);
  const isLate = rawLate > rules.lateGraceMin;
  const lateMin = isLate ? rawLate : 0;
  const penalLateMin = isLate ? Math.ceil(rawLate / rules.lateBlockMin) * rules.lateBlockMin : 0;
  const effectiveIn = rules.startMin + penalLateMin;
  const regularEnd = Math.min(clockOutMin, rules.endMin);
  const lunchOverlap = Math.min(rules.lunchMin, Math.max(0, Math.min(regularEnd, rules.lunchEndMin) - Math.max(effectiveIn, rules.lunchStartMin)));
  const regularWorkMin = Math.max(0, regularEnd - effectiveIn - lunchOverlap);
  let otMin = 0;
  if (clockOutMin > rules.endMin) {
    const block = rules.otBlockMin;
    const roundedOut = Math.floor(clockOutMin / 60) * 60 + Math.floor((clockOutMin % 60) / block) * block;
    otMin = Math.max(0, roundedOut - rules.endMin);
    if (otMin < block) otMin = 0;
  }
  const shortfallMin = Math.max(0, rules.standardWorkMin - regularWorkMin - otMin);
  return { lateMin, isLate, regularWorkMin, shortfallMin, otMin };
}

const MY_OFFSET_MS = 8 * 60 * 60 * 1000;

/** The Malaysia calendar date (YYYY-MM-DD) of an instant. */
export function mytDate(instant: Date): string {
  return new Date(instant.getTime() + MY_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutes from Malaysia midnight of workDate to the instant (> 1440 after midnight). */
export function minutesFromWorkDate(workDate: string, instant: Date): number {
  const midnightUtc = Date.parse(`${workDate}T00:00:00Z`) - MY_OFFSET_MS;
  return Math.floor((instant.getTime() - midnightUtc) / 60000);
}

/** The instant that is `minutes` after Malaysia midnight of workDate. */
export function instantOnWorkDate(workDate: string, minutes: number): Date {
  return new Date(Date.parse(`${workDate}T00:00:00Z`) - MY_OFFSET_MS + minutes * 60000);
}

/** "HH:MM" for minutes from the work date's midnight; "+1" past midnight. */
export function workClock(minutes: number): string {
  const day = Math.floor(minutes / 1440);
  const m = minutes - day * 1440;
  const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return day > 0 ? `${hhmm} (+${day})` : hhmm;
}

/** An open punch older than this is a forgotten clock-out, not a long shift. */
export const AUTO_CLOSE_AFTER_HOURS = 16;

/* Where a forgotten clock-out is closed: the shift end of the work date, so
 * the day counts as a normal shift and earns no OT. Someone who clocked in
 * after the shift end gets a standard day's length from their clock-in. */
export function autoCloseMinute(clockInMin: number, rules: AttendanceRules): number {
  return clockInMin < rules.endMin ? rules.endMin : clockInMin + rules.standardWorkMin + rules.lunchMin;
}

export type PunchSite = { id: number; name: string; lat: number; lng: number; radiusM: number };

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* The punch-location check. Soft, like Hookka: it is recorded and shown to
 * HR, never a reason to refuse the punch. The nearest site is named either
 * way, so HR sees "1.2 km from KL WAREHOUSE" rather than a bare "off-site". */
export function checkPunchLocation(
  lat: number | null,
  lng: number | null,
  sites: ReadonlyArray<PunchSite>,
): { geo: GeoResult; siteId: number | null; siteName: string | null; distanceM: number | null } {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng) || sites.length === 0) {
    return { geo: "NONE", siteId: null, siteName: null, distanceM: null };
  }
  let best: { site: PunchSite; d: number } | null = null;
  for (const site of sites) {
    const d = haversineMeters(lat, lng, site.lat, site.lng);
    if (!best || d < best.d) best = { site, d };
  }
  if (!best) return { geo: "NONE", siteId: null, siteName: null, distanceM: null };
  return { geo: best.d <= best.site.radiusM ? "IN" : "OUT", siteId: best.site.id, siteName: best.site.name, distanceM: Math.round(best.d) };
}

/** "350 m" / "1.2 km". */
export function distanceLabel(m: number): string {
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
}
