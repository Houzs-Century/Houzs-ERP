/* The attendance allowance (HC-0125): a per-DAY amount a worker earns for the
 * days they actually attend, forfeited for the WHOLE month when they are late
 * too often or take any unpaid leave. Pure, tested without a database.
 *
 * It is modelled as an ordinary monthly allowance of kind "ATTENDANCE" whose
 * stored amount is the PER-DAY rate; payroll (hr-payroll-store) turns that rate
 * and the month's attendance into the one computed line this returns, so the
 * rest of the payslip treats it like any other allowance.
 *
 * The rule is the owner's (2026-11-18): RM10/day, forfeited if late on more
 * than 3 days OR any unpaid-leave day in the month. The thresholds are policy
 * constants here, not per-row config, so every attendance allowance reads the
 * same way. */
import type { AttendanceStatus } from "../../scm/shared/hr-attendance";

/** Late on strictly more than this many days in the month forfeits it. */
export const ATTENDANCE_LATE_FORFEIT_OVER = 3;

/** One day of the month as the allowance sees it: its attendance status, whether
 *  the punch was late, and how much of a day it counts for the per-day amount. */
export type AttendanceAllowanceDay = { status: AttendanceStatus; isLate: boolean; fraction: number };

export type AttendanceAllowanceResult = {
  amountSen: number;
  /** Sum of the day fractions the rate was paid on (0 when forfeited stays the real count). */
  presentDays: number;
  lateDays: number;
  forfeited: boolean;
  /** A short English line for the payslip explaining the figure. */
  note: string;
};

const rm = (sen: number): string => (sen / 100).toFixed(2);

/** The month's attendance allowance: rate x attended-day fractions, or zero for
 *  the whole month when the forfeit rule trips. `ratePerDaySen` is the stored
 *  allowance amount (the per-day rate). */
export function attendanceAllowance(ratePerDaySen: number, days: ReadonlyArray<AttendanceAllowanceDay>): AttendanceAllowanceResult {
  const lateDays = days.filter((d) => d.isLate).length;
  const hasUnpaid = days.some((d) => d.status === "UNPAID_LEAVE");
  const presentDays = days.reduce((s, d) => s + d.fraction, 0);
  if (hasUnpaid) {
    return { amountSen: 0, presentDays, lateDays, forfeited: true, note: "Forfeited: unpaid leave this month" };
  }
  if (lateDays > ATTENDANCE_LATE_FORFEIT_OVER) {
    return { amountSen: 0, presentDays, lateDays, forfeited: true, note: `Forfeited: late on ${lateDays} days` };
  }
  const amountSen = Math.round(ratePerDaySen * presentDays);
  return { amountSen, presentDays, lateDays, forfeited: false, note: `RM${rm(ratePerDaySen)}/day x ${presentDays} day${presentDays === 1 ? "" : "s"}` };
}

/** The day-fraction a status earns the per-day rate: a full day present, half a
 *  day for a half day, nothing otherwise (absence and leave do not earn it). */
export function attendanceDayFraction(status: AttendanceStatus): number {
  return status === "PRESENT" ? 1 : status === "HALF_DAY" ? 0.5 : 0;
}
