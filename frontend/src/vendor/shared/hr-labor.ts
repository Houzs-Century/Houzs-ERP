/* HR labour maths, HC-0125 phase 3, ported from Hookka (src/lib/labor-engine.ts
 * countElapsedWorkingDays / daily-paid cost, src/lib/labor-day-cost.ts,
 * src/api/lib/attendance-deduct.ts, src/api/lib/punch-autofill.ts):
 *   - the hours a punch puts on Working Hours,
 *   - the short hours a punch docks,
 *   - what a logged day costs.
 * Hookka's production pieces (SOFA / BEDFRAME categories, line-scan splits,
 * production revenue) are not here: Century logs a day to the employee's own
 * department.
 *
 * ONE home. backend/src/scm/shared/hr-labor.ts is the original and
 * frontend/src/vendor/shared/hr-labor.ts its byte-identical copy
 * (check-shared-mirrors.mjs).
 */
import { computeAttendanceDay, type AttendanceRules } from "./hr-attendance";
import type { PayRulesConfig } from "./hr-pay-rules";

/** Working days are Monday to Saturday; Sunday and public holidays are not. */
export function isWorkingDay(ymd: string, holidays: ReadonlySet<string>): boolean {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay() !== 0 && !holidays.has(ymd);
}

/** Working days of a month from the 1st through `throughDay`. */
export function countWorkingDays(year: number, month: number, throughDay: number, holidays: ReadonlySet<string>): number {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = Math.min(Math.max(Math.floor(throughDay), 0), last);
  const mm = String(month).padStart(2, "0");
  let n = 0;
  for (let d = 1; d <= end; d++) if (isWorkingDay(`${year}-${mm}-${String(d).padStart(2, "0")}`, holidays)) n++;
  return n;
}

/** The day rules with the employee's own hours / day as the standard day. */
export function rulesForEmployeeHours(rules: AttendanceRules, hoursPerDay: number): AttendanceRules {
  const std = Math.round(hoursPerDay * 60);
  return hoursPerDay > 0 && std !== rules.standardWorkMin ? { ...rules, standardWorkMin: std } : rules;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/* The hours a punch puts on Working Hours: regular + OT as one figure (the
 * day type decides later what part is OT). A broken punch (tapped in and out
 * at knock-off, less than one OT block of work) credits the standard day when
 * the pay rules say so, else nothing. */
export function punchDayHours(
  inMin: number,
  outMin: number,
  rules: AttendanceRules,
  brokenPunchCreditsFullDay: boolean,
): { hours: number; broken: boolean } {
  const day = computeAttendanceDay(inMin, outMin, rules);
  const broken = outMin <= inMin || (day.regularWorkMin < rules.otBlockMin && day.otMin <= 0);
  if (broken) return { hours: brokenPunchCreditsFullDay ? round2(rules.standardWorkMin / 60) : 0, broken: true };
  return { hours: round2((day.regularWorkMin + day.otMin) / 60), broken: false };
}

/* The hours a punch docks: the shortfall against the standard day after
 * same-day OT has offset lateness (Hookka folds late into short; there is no
 * separate late dock). A broken punch never docks. */
export function punchShortfallHours(inMin: number, outMin: number, rules: AttendanceRules): number {
  if (outMin <= inMin) return 0;
  const day = computeAttendanceDay(inMin, outMin, rules);
  if (day.regularWorkMin < rules.otBlockMin && day.otMin <= 0) return 0;
  return round2(day.shortfallMin / 60);
}

/** Less than this is rounding, not a shortfall. */
export const MIN_DOCK_HOURS = 0.05;

/* OT of a logged day by day type: Sunday and public holidays pay every hour
 * at their multiplier; a weekday pays the hours above the standard day at
 * the employee's own multiplier. */
export function dayTypedOt(
  ymd: string,
  holidays: ReadonlySet<string>,
  totalHours: number,
  stdHours: number,
  weekdayMultiplier: number,
  cfg: Pick<PayRulesConfig, "sundayOtMultiplier" | "holidayOtMultiplier">,
): { otHours: number; multiplier: number; kind: "SUNDAY" | "HOLIDAY" | "WEEKDAY" } {
  if (new Date(`${ymd}T00:00:00Z`).getUTCDay() === 0) return { otHours: totalHours, multiplier: cfg.sundayOtMultiplier, kind: "SUNDAY" };
  if (holidays.has(ymd)) return { otHours: totalHours, multiplier: cfg.holidayOtMultiplier, kind: "HOLIDAY" };
  return { otHours: Math.max(0, totalHours - stdHours), multiplier: weekdayMultiplier, kind: "WEEKDAY" };
}

export type CostEmployee = {
  payMode: "MONTHLY" | "DAILY";
  dailyRateSen: number;
  workingHoursPerDay: number;
  workingDaysPerMonth: number;
  otMultiplier: number;
  resignedOn: string;
};

/* What each of one day's entries cost, in sen (Hookka's
 * workerDayEntryCostsSen). Monthly-paid: regular hours at salary / the
 * month's actual working days / standard hours; OT hours at salary / days per
 * month / standard hours x the day's multiplier, OT spread pro rata over the
 * day's entries. Daily-paid: the day rate split by hours. Nothing after a
 * resignation. */
export function dayEntryCostsSen(args: {
  employee: CostEmployee;
  salarySen: number;
  ymd: string;
  entryHours: number[];
  monthWorkingDays: number;
  holidays: ReadonlySet<string>;
  cfg: Pick<PayRulesConfig, "sundayOtMultiplier" | "holidayOtMultiplier">;
}): { costs: number[]; otCosts: number[]; otHours: number } {
  const { employee: e, salarySen, ymd, entryHours, monthWorkingDays, holidays, cfg } = args;
  const dayHours = entryHours.reduce((s, h) => s + h, 0);
  const zero = entryHours.map(() => 0);
  if (e.resignedOn && ymd > e.resignedOn) return { costs: zero, otCosts: zero, otHours: 0 };
  if (e.payMode === "DAILY") {
    return { costs: entryHours.map((h) => (dayHours > 0 && e.dailyRateSen > 0 ? (e.dailyRateSen * h) / dayHours : 0)), otCosts: zero, otHours: 0 };
  }
  const std = e.workingHoursPerDay > 0 ? e.workingHoursPerDay : 9;
  const ot = dayTypedOt(ymd, holidays, dayHours, std, e.otMultiplier, cfg);
  if (salarySen <= 0) return { costs: zero, otCosts: zero, otHours: ot.otHours };
  const regularRate = salarySen / Math.max(1, monthWorkingDays) / std;
  const otBase = salarySen / Math.max(1, e.workingDaysPerMonth || 26) / std;
  const otShare = dayHours > 0 ? ot.otHours / dayHours : 0;
  const otCosts = entryHours.map((h) => h * otShare * otBase * ot.multiplier);
  return {
    costs: entryHours.map((h, i) => h * (1 - otShare) * regularRate + otCosts[i]),
    otCosts,
    otHours: ot.otHours,
  };
}
