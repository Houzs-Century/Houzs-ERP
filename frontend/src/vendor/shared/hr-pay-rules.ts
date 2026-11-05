/* HR pay rules — EFFECTIVE-DATED configuration, ported from Hookka
 * (src/lib/pay-rules.ts) for HC-0125.
 *
 * A version is a full snapshot of every knob plus the date it takes effect.
 * Versions are append-only; the rules for a DATE are those of the newest
 * version whose effectiveFrom <= date, else DEFAULT_PAY_RULES. So a mid-month
 * change applies from its exact day and never re-prices an earlier one.
 *
 * NOT configurable here (per employee, Employee Master): the day-rate divisor
 * when it is "fixed26" (the employee's working days / month), the employee's
 * own hours / day, and the weekday OT multiplier.
 *
 * ONE home. backend/src/scm/shared/hr-pay-rules.ts is the original and
 * frontend/src/vendor/shared/hr-pay-rules.ts its byte-identical copy
 * (check-shared-mirrors.mjs), so the editor, the API and the payroll engine
 * read the same defaults.
 */

/** Day rate = monthly salary ÷ … */
export type DayRateDivisorMode = "fixed26" | "calendarDays" | "workingDays";
/** Hour rate = day rate ÷ … */
export type HourRateDivisorMode = "hoursPlusLunch" | "hoursOnly" | "fixed";

export type PayRulesConfig = {
  /** "fixed26": the employee's working days / month (26). "calendarDays": the
   *  month's 28-31. "workingDays": the month's Mon-Sat minus public holidays. */
  dayRateDivisorMode: DayRateDivisorMode;
  /** "hoursPlusLunch": hours / day + lunch (9h + 1h = ÷10). "hoursOnly": ÷9.
   *  "fixed": rateHoursPerDay for everyone. No hours set = rateHoursPerDay. */
  hourRateDivisorMode: HourRateDivisorMode;
  /** Minutes since midnight (480 = 08:00). */
  shiftStartMin: number;
  /** Shift end and the OT boundary, minutes since midnight (1080 = 18:00). */
  shiftEndMin: number;
  /** Unpaid lunch, minutes. */
  lunchMin: number;
  /** Lateness forgiven up to this many minutes. */
  lateGraceMin: number;
  /** Penal lateness rounds UP to blocks of this many minutes (1 = actual minutes). */
  lateBlockMin: number;
  /** OT floors to whole blocks of this many minutes; less than one block earns nothing. */
  otBlockMin: number;
  /** Fallback / fixed hour divisor. */
  rateHoursPerDay: number;
  sundayOtMultiplier: number;
  holidayOtMultiplier: number;
  /** A working day with no hours stays "Pending" this many working days before it counts as absent. */
  absenceGraceWorkingDays: number;
  /** Tapped in and out in the same minute at knock-off: true = credit a normal
   *  shift, false = the day is an absence (charged once, never also hour-docked). */
  brokenPunchCreditsFullDay: boolean;
  epfEmployeePct: number;
  epfEmployerPct: number;
  socsoEmployeeSen: number;
  socsoEmployerSen: number;
  eisEmployeeSen: number;
  eisEmployerSen: number;
};

export type PayRuleVersion = {
  id: number;
  /** YYYY-MM-DD, the first date these rules apply to. */
  effectiveFrom: string;
  rules: PayRulesConfig;
  note: string | null;
  createdAt: string | null;
  createdBy: number | null;
};

export const DEFAULT_PAY_RULES: PayRulesConfig = {
  dayRateDivisorMode: "fixed26",
  hourRateDivisorMode: "hoursPlusLunch",
  shiftStartMin: 8 * 60,
  shiftEndMin: 18 * 60,
  lunchMin: 60,
  lateGraceMin: 15,
  lateBlockMin: 1,
  otBlockMin: 15,
  rateHoursPerDay: 10,
  sundayOtMultiplier: 2,
  holidayOtMultiplier: 3,
  absenceGraceWorkingDays: 2,
  brokenPunchCreditsFullDay: true,
  epfEmployeePct: 11,
  epfEmployerPct: 13,
  socsoEmployeeSen: 745,
  socsoEmployerSen: 2615,
  eisEmployeeSen: 390,
  eisEmployerSen: 390,
};

/** Coerce a half-trusted stored object onto the defaults, field by field, so
 *  an older version keeps working after a knob is added. */
export function normalizePayRules(raw: unknown): PayRulesConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const num = (k: keyof PayRulesConfig): number => {
    const v = Number(r[k]);
    return r[k] !== null && r[k] !== "" && Number.isFinite(v) && v >= 0 ? v : (DEFAULT_PAY_RULES[k] as number);
  };
  const dayMode: DayRateDivisorMode =
    r.dayRateDivisorMode === "calendarDays" || r.dayRateDivisorMode === "workingDays" ? r.dayRateDivisorMode : "fixed26";
  const hourMode: HourRateDivisorMode =
    r.hourRateDivisorMode === "hoursOnly" || r.hourRateDivisorMode === "fixed" ? r.hourRateDivisorMode : "hoursPlusLunch";
  return {
    dayRateDivisorMode: dayMode,
    hourRateDivisorMode: hourMode,
    shiftStartMin: num("shiftStartMin"),
    shiftEndMin: num("shiftEndMin"),
    lunchMin: num("lunchMin"),
    lateGraceMin: num("lateGraceMin"),
    lateBlockMin: Math.max(1, num("lateBlockMin")),
    otBlockMin: Math.max(1, num("otBlockMin")),
    rateHoursPerDay: Math.max(1, num("rateHoursPerDay")),
    sundayOtMultiplier: num("sundayOtMultiplier"),
    holidayOtMultiplier: num("holidayOtMultiplier"),
    absenceGraceWorkingDays: num("absenceGraceWorkingDays"),
    brokenPunchCreditsFullDay: r.brokenPunchCreditsFullDay !== false,
    epfEmployeePct: num("epfEmployeePct"),
    epfEmployerPct: num("epfEmployerPct"),
    socsoEmployeeSen: num("socsoEmployeeSen"),
    socsoEmployerSen: num("socsoEmployerSen"),
    eisEmployeeSen: num("eisEmployeeSen"),
    eisEmployerSen: num("eisEmployerSen"),
  };
}

/** Why a rules snapshot cannot be saved, or null when it can. */
export function payRulesProblem(rules: PayRulesConfig): string | null {
  if (rules.shiftStartMin >= 24 * 60 || rules.shiftEndMin > 24 * 60) return "Shift times must be within the day (00:00 to 24:00).";
  if (rules.shiftEndMin <= rules.shiftStartMin) return "Shift end must be after shift start.";
  if (rules.shiftEndMin - rules.shiftStartMin <= rules.lunchMin) return "Lunch cannot take up the whole shift.";
  if (rules.epfEmployeePct > 100 || rules.epfEmployerPct > 100) return "EPF is a percentage: 0 to 100.";
  return null;
}

/** The rules in force on dateYmd (YYYY-MM-DD). Versions may arrive unsorted. */
export function resolvePayRulesAsOf(
  versions: ReadonlyArray<Pick<PayRuleVersion, "effectiveFrom" | "rules">> | null,
  dateYmd: string,
): PayRulesConfig {
  let best: Pick<PayRuleVersion, "effectiveFrom" | "rules"> | null = null;
  for (const v of versions ?? []) {
    if (typeof v.effectiveFrom !== "string" || v.effectiveFrom > dateYmd) continue;
    if (!best || v.effectiveFrom > best.effectiveFrom) best = v;
  }
  return best ? normalizePayRules(best.rules) : DEFAULT_PAY_RULES;
}

/** The payroll DAY rate (sen) for a month under the configured divisor. */
export function payrollDayRateSen(
  basicSalarySen: number,
  divisors: { workingDaysPerMonth: number; calendarDays: number; workingDaysInMonth: number },
  cfg: PayRulesConfig,
): number {
  switch (cfg.dayRateDivisorMode) {
    case "calendarDays":
      return basicSalarySen / Math.max(1, divisors.calendarDays);
    case "workingDays":
      return basicSalarySen / Math.max(1, divisors.workingDaysInMonth);
    default:
      return basicSalarySen / Math.max(1, divisors.workingDaysPerMonth);
  }
}

/** The HOUR-rate divisor for an employee under the configured mode. */
export function payrollHourDivisor(workingHoursPerDay: number | null, cfg: PayRulesConfig): number {
  if (cfg.hourRateDivisorMode === "fixed") return Math.max(1, cfg.rateHoursPerDay);
  const h = Number(workingHoursPerDay) || 0;
  if (h <= 0) return Math.max(1, cfg.rateHoursPerDay);
  return Math.max(1, cfg.hourRateDivisorMode === "hoursOnly" ? h : h + cfg.lunchMin / 60);
}

/** The HOUR rate in whole sen, rounded BEFORE it multiplies any hours, so a
 *  payslip adds up on a calculator (RM85 ÷ 9 = 9.44; 9.44 × 1.5 × 4 = 56.64). */
export function payrollHourRateSen(dayRateSen: number, workingHoursPerDay: number | null, cfg: PayRulesConfig): number {
  return Math.round(dayRateSen / payrollHourDivisor(workingHoursPerDay, cfg));
}

/** "HH:MM" for a minutes-since-midnight value. */
export function minToHhmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Minutes since midnight for "H:MM" / "HH:MM", or null. */
export function hhmmToMin(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h <= 24 && mm < 60 ? h * 60 + mm : null;
}
