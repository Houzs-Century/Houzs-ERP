/* The monthly pay of one employee (HC-0125 phase 4), ported from Hookka's
 * src/lib/labor-engine.ts computeMonthlyLabor (the payroll half; the
 * production-costing half is not ported) and payslips.ts calcStatutory.
 *
 *   basic earned  = salary - absent days x day rate - docked hours x hour rate
 *                   (daily-paid: days worked x day rate - docked hours)
 *   OT            = per day, on that day's pay rules: Sunday every hour x2,
 *                   public holiday every hour x3, weekday hours above the
 *                   standard day x the employee's multiplier (15 min minimum)
 *   gross         = basic earned + OT
 *   statutory     = EPF % of the month's salary, SOCSO / EIS flat (Pay Rules),
 *                   each only when the employee's toggle is on
 *   net           = gross - statutory - PCB - advances - penalties (may go below 0)
 *
 * Hookka's choices kept on purpose (the owner: "migrate first, then adjust";
 * Samuel 2026-10-22: statutory as Hookka for now):
 *   - EPF / SOCSO / EIS are flat rates, not the KWSP / PERKESO wage bands.
 *   - No proration on joining: working days before the join date count as
 *     absent (the unified salary / 26 rule). Days after a resignation dock too.
 *   - An absence is confirmed only after a grace of N working days.
 *
 * ONE home. backend/src/scm/shared/hr-payroll.ts is the original and
 * frontend/src/vendor/shared/hr-payroll.ts its byte-identical copy
 * (check-shared-mirrors.mjs).
 */
import type { PayRulesConfig } from "./hr-pay-rules";
import { payrollDayRateSen, payrollHourRateSen } from "./hr-pay-rules";
import { countWorkingDays, isWorkingDay } from "./hr-labor";

/** Weekday OT shorter than this earns nothing. */
export const OT_MIN_MINUTES = 15;

const round2 = (h: number) => Math.round((Number(h) || 0) * 100) / 100;
const countableOt = (surplus: number) => (round2(surplus) * 60 >= OT_MIN_MINUTES ? round2(surplus) : 0);
const ymdOf = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/* The last day of the month whose absences are confirmed: today walked back
 * by `graceWorkingDays` working days. A finished month counts whole; a month
 * the cutoff has not reached counts none. */
export function absenceCutoffDay(year: number, month: number, todayYmd: string, graceWorkingDays: number, holidays: ReadonlySet<string>): number {
  const cutoff = new Date(`${todayYmd}T00:00:00Z`);
  let remaining = Math.max(0, Math.floor(graceWorkingDays));
  while (remaining > 0) {
    cutoff.setUTCDate(cutoff.getUTCDate() - 1);
    if (isWorkingDay(cutoff.toISOString().slice(0, 10), holidays)) remaining--;
  }
  const cutoffYm = cutoff.getUTCFullYear() * 12 + cutoff.getUTCMonth();
  const periodYm = year * 12 + (month - 1);
  if (periodYm < cutoffYm) return lastDayOf(year, month);
  if (periodYm > cutoffYm) return 0;
  return cutoff.getUTCDate();
}

/** Salary in force on a date: the newest row on or before it, else the fallback. */
export function salaryOn(history: ReadonlyArray<{ effectiveFrom: string; basicSalarySen: number }>, fallbackSen: number, ymd: string): number {
  let best: { effectiveFrom: string; basicSalarySen: number } | null = null;
  for (const r of history) if (r.effectiveFrom <= ymd && (!best || r.effectiveFrom > best.effectiveFrom)) best = r;
  return Math.max(0, best ? best.basicSalarySen : fallbackSen);
}

/** A month's salary when it changed mid-month: each working day at the salary in force that day, averaged. */
export function effectiveSalaryForMonth(
  history: ReadonlyArray<{ effectiveFrom: string; basicSalarySen: number }>,
  fallbackSen: number,
  year: number,
  month: number,
  holidays: ReadonlySet<string>,
): number {
  let days = 0;
  let sum = 0;
  for (let d = 1; d <= lastDayOf(year, month); d++) {
    const ymd = ymdOf(year, month, d);
    if (!isWorkingDay(ymd, holidays)) continue;
    days++;
    sum += salaryOn(history, fallbackSen, ymd);
  }
  return days > 0 ? Math.round(sum / days) : Math.max(0, fallbackSen);
}

export type PayEmployee = {
  payMode: "MONTHLY" | "DAILY";
  salarySen: number;
  dailyRateSen: number;
  workingDaysPerMonth: number;
  workingHoursPerDay: number;
  otMultiplier: number;
  resignedOn: string;
};

export type MonthlyPay = {
  daysWorked: number;
  absentDays: number;
  absentDates: string[];
  /** Working days with no hours that HR marked as paid leave: not absences. */
  paidLeaveDates: string[];
  otDays: { date: string; hours: number; kind: "WEEKDAY" | "SUNDAY" | "HOLIDAY" }[];
  otWeekdayHours: number;
  otSundayHours: number;
  otHolidayHours: number;
  dayRateSen: number;
  hourRateSen: number;
  fullSalarySen: number;
  absenceDeductionSen: number;
  shortHours: number;
  shortHourDeductionSen: number;
  basicEarnedSen: number;
  otWeekdayPaySen: number;
  otSundayPaySen: number;
  otHolidayPaySen: number;
  otPaySen: number;
  grossSen: number;
};

export function computeMonthlyPay(input: {
  employee: PayEmployee;
  year: number;
  month: number;
  /** Logged hours of the month; several rows a day are summed. */
  days: ReadonlyArray<{ date: string; hours: number }>;
  holidays: ReadonlySet<string>;
  /** Absences are counted through this day (absenceCutoffDay). */
  absenceThroughDay: number;
  /** Total short hours docked this month. */
  shortHours: number;
  rulesOn: (ymd: string) => PayRulesConfig;
  /** Days HR marked as paid leave (phase 5). */
  paidLeave?: ReadonlySet<string>;
}): MonthlyPay {
  const { employee: e, year, month, holidays } = input;
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  const last = lastDayOf(year, month);
  const std = Math.max(0, e.workingHoursPerDay || 0);
  const wdpm = e.workingDaysPerMonth > 0 ? e.workingDaysPerMonth : 26;
  const mult = e.otMultiplier > 0 ? e.otMultiplier : 1;
  const daily = e.payMode === "DAILY" && e.dailyRateSen > 0;

  const hoursByDate = new Map<string, number>();
  for (const r of input.days) if (r.date.startsWith(prefix)) hoursByDate.set(r.date, (hoursByDate.get(r.date) ?? 0) + (Number(r.hours) || 0));

  const monthEnd = ymdOf(year, month, last);
  const cfgEnd = input.rulesOn(monthEnd);
  const dayRateSen = daily
    ? e.dailyRateSen
    : payrollDayRateSen(e.salarySen, { workingDaysPerMonth: wdpm, calendarDays: last, workingDaysInMonth: Math.max(1, countWorkingDays(year, month, last, holidays)) }, cfgEnd);
  const hourRateOn = (cfg: PayRulesConfig) => payrollHourRateSen(dayRateSen, std, cfg);
  const hourRateSen = hourRateOn(cfgEnd);

  let daysWorked = 0;
  let otWeekdayHours = 0;
  let otSundayHours = 0;
  let otHolidayHours = 0;
  let wk = 0;
  let sun = 0;
  let hol = 0;
  const otDays: MonthlyPay["otDays"] = [];
  for (const [date, h] of [...hoursByDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (h <= 0) continue;
    const sunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
    const holiday = !sunday && holidays.has(date);
    if (!sunday && !holiday) daysWorked++;
    const cfg = input.rulesOn(date);
    const base = hourRateOn(cfg);
    if (sunday) {
      otSundayHours += h;
      sun += h * base * cfg.sundayOtMultiplier;
      otDays.push({ date, hours: round2(h), kind: "SUNDAY" });
    } else if (holiday) {
      otHolidayHours += h;
      hol += h * base * cfg.holidayOtMultiplier;
      otDays.push({ date, hours: round2(h), kind: "HOLIDAY" });
    } else if (std > 0) {
      const ot = countableOt(h - std);
      if (ot > 0) {
        otWeekdayHours += ot;
        wk += ot * base * mult;
        otDays.push({ date, hours: ot, kind: "WEEKDAY" });
      }
    }
  }

  const through = Math.min(input.absenceThroughDay, last);
  const absentDates: string[] = [];
  const paidLeaveDates: string[] = [];
  if (!daily) {
    for (let d = 1; d <= last; d++) {
      const ymd = ymdOf(year, month, d);
      if (!isWorkingDay(ymd, holidays) || (hoursByDate.get(ymd) ?? 0) > 0) continue;
      const afterResign = e.resignedOn !== "" && ymd > e.resignedOn;
      if (!afterResign && input.paidLeave?.has(ymd)) paidLeaveDates.push(ymd);
      else if (d <= through || afterResign) absentDates.push(ymd);
    }
  }
  const absentDays = absentDates.length;
  const absenceDeductionSen = daily ? 0 : Math.round(absentDays * dayRateSen);
  const shortHours = Math.max(0, input.shortHours || 0);
  const shortHourDeductionSen = Math.round(shortHours * hourRateSen);
  const basicEarnedSen = daily
    ? Math.max(0, Math.round(daysWorked * e.dailyRateSen) - shortHourDeductionSen)
    : Math.max(0, Math.max(0, e.salarySen - absenceDeductionSen) - shortHourDeductionSen);
  const otWeekdayPaySen = Math.round(wk);
  const otSundayPaySen = Math.round(sun);
  const otHolidayPaySen = Math.round(hol);
  const otPaySen = otWeekdayPaySen + otSundayPaySen + otHolidayPaySen;
  return {
    daysWorked,
    absentDays,
    absentDates,
    paidLeaveDates,
    otDays,
    otWeekdayHours: round2(otWeekdayHours),
    otSundayHours: round2(otSundayHours),
    otHolidayHours: round2(otHolidayHours),
    dayRateSen: Math.round(dayRateSen),
    hourRateSen,
    fullSalarySen: daily ? 0 : e.salarySen,
    absenceDeductionSen,
    shortHours: round2(shortHours),
    shortHourDeductionSen,
    basicEarnedSen,
    otWeekdayPaySen,
    otSundayPaySen,
    otHolidayPaySen,
    otPaySen,
    grossSen: basicEarnedSen + otPaySen,
  };
}

export type Statutory = { epfEmployeeSen: number; epfEmployerSen: number; socsoEmployeeSen: number; socsoEmployerSen: number; eisEmployeeSen: number; eisEmployerSen: number };

/* Hookka's calcStatutory: EPF a percentage of the month's full salary (not
 * reduced by absences; a daily-paid employee's salary is 0, so no EPF);
 * SOCSO and EIS the flat amounts in Pay Rules. Each only when on. */
export function statutoryFor(salarySen: number, flags: { epf: boolean; socso: boolean; eis: boolean }, cfg: PayRulesConfig): Statutory {
  return {
    epfEmployeeSen: flags.epf ? Math.round((salarySen * cfg.epfEmployeePct) / 100) : 0,
    epfEmployerSen: flags.epf ? Math.round((salarySen * cfg.epfEmployerPct) / 100) : 0,
    socsoEmployeeSen: flags.socso ? cfg.socsoEmployeeSen : 0,
    socsoEmployerSen: flags.socso ? cfg.socsoEmployerSen : 0,
    eisEmployeeSen: flags.eis ? cfg.eisEmployeeSen : 0,
    eisEmployerSen: flags.eis ? cfg.eisEmployerSen : 0,
  };
}
