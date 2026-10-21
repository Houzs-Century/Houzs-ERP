// HR pay rules: effective-dated resolution, the per-field fallback on stored
// rows, the save checks, and the rate arithmetic the payroll phase prices with.
import { describe, expect, test } from "vitest";
import {
  DEFAULT_PAY_RULES,
  hhmmToMin,
  minToHhmm,
  normalizePayRules,
  payRulesProblem,
  payrollDayRateSen,
  payrollHourDivisor,
  payrollHourRateSen,
  resolvePayRulesAsOf,
} from "./hr-pay-rules";

const v = (effectiveFrom: string, lunchMin: number) => ({ effectiveFrom, rules: { ...DEFAULT_PAY_RULES, lunchMin } });

describe("resolvePayRulesAsOf", () => {
  test("no versions means the defaults", () => {
    expect(resolvePayRulesAsOf([], "2026-10-21")).toEqual(DEFAULT_PAY_RULES);
    expect(resolvePayRulesAsOf(null, "2026-10-21")).toEqual(DEFAULT_PAY_RULES);
  });

  test("the newest version on or before the date wins, whatever order they arrive in", () => {
    const versions = [v("2026-11-01", 45), v("2026-09-01", 30), v("2026-10-15", 50)];
    expect(resolvePayRulesAsOf(versions, "2026-08-31").lunchMin).toBe(60);
    expect(resolvePayRulesAsOf(versions, "2026-09-01").lunchMin).toBe(30);
    expect(resolvePayRulesAsOf(versions, "2026-10-14").lunchMin).toBe(30);
    expect(resolvePayRulesAsOf(versions, "2026-10-15").lunchMin).toBe(50);
    expect(resolvePayRulesAsOf(versions, "2026-12-01").lunchMin).toBe(45);
  });
});

describe("normalizePayRules", () => {
  test("a missing or broken field falls back to its default, the rest is kept", () => {
    const r = normalizePayRules({ lunchMin: 30, lateGraceMin: "x", sundayOtMultiplier: -1, dayRateDivisorMode: "weekly" });
    expect(r.lunchMin).toBe(30);
    expect(r.lateGraceMin).toBe(15);
    expect(r.sundayOtMultiplier).toBe(2);
    expect(r.dayRateDivisorMode).toBe("fixed26");
  });

  test("only an explicit false turns the forgotten punch-in leniency off", () => {
    expect(normalizePayRules({}).brokenPunchCreditsFullDay).toBe(true);
    expect(normalizePayRules({ brokenPunchCreditsFullDay: false }).brokenPunchCreditsFullDay).toBe(false);
  });

  test("blocks and the fallback divisor never go below 1", () => {
    const r = normalizePayRules({ lateBlockMin: 0, otBlockMin: 0, rateHoursPerDay: 0 });
    expect(r.lateBlockMin).toBe(1);
    expect(r.otBlockMin).toBe(1);
    expect(r.rateHoursPerDay).toBe(1);
  });
});

describe("payRulesProblem", () => {
  test("the defaults can be saved", () => {
    expect(payRulesProblem(DEFAULT_PAY_RULES)).toBeNull();
  });
  test("a shift that ends before it starts, or is all lunch, is refused", () => {
    expect(payRulesProblem({ ...DEFAULT_PAY_RULES, shiftEndMin: 480 })).toMatch(/after shift start/);
    expect(payRulesProblem({ ...DEFAULT_PAY_RULES, shiftStartMin: 720, shiftEndMin: 780, lunchMin: 60 })).toMatch(/Lunch/);
    expect(payRulesProblem({ ...DEFAULT_PAY_RULES, epfEmployeePct: 110 })).toMatch(/EPF/);
  });
});

describe("rates", () => {
  test("RM2,050 on 26 days, 9h + 1h lunch: RM78.85 a day, RM7.88 an hour", () => {
    const day = payrollDayRateSen(205000, { workingDaysPerMonth: 26, calendarDays: 31, workingDaysInMonth: 26 }, DEFAULT_PAY_RULES);
    expect(Math.round(day)).toBe(7885);
    expect(payrollHourRateSen(day, 9, DEFAULT_PAY_RULES)).toBe(788);
  });

  test("each divisor mode", () => {
    const divisors = { workingDaysPerMonth: 26, calendarDays: 31, workingDaysInMonth: 25 };
    expect(payrollDayRateSen(310000, divisors, { ...DEFAULT_PAY_RULES, dayRateDivisorMode: "calendarDays" })).toBe(10000);
    expect(payrollDayRateSen(250000, divisors, { ...DEFAULT_PAY_RULES, dayRateDivisorMode: "workingDays" })).toBe(10000);
    expect(payrollHourDivisor(9, { ...DEFAULT_PAY_RULES, hourRateDivisorMode: "hoursOnly" })).toBe(9);
    expect(payrollHourDivisor(9, { ...DEFAULT_PAY_RULES, hourRateDivisorMode: "fixed", rateHoursPerDay: 8 })).toBe(8);
    expect(payrollHourDivisor(7.5, DEFAULT_PAY_RULES)).toBe(8.5);
    expect(payrollHourDivisor(null, DEFAULT_PAY_RULES)).toBe(10);
  });
});

describe("HH:MM", () => {
  test("round trip", () => {
    expect(minToHhmm(480)).toBe("08:00");
    expect(minToHhmm(1080)).toBe("18:00");
    expect(hhmmToMin("8:30")).toBe(510);
    expect(hhmmToMin("18:00")).toBe(1080);
    expect(hhmmToMin("25:00")).toBeNull();
    expect(hhmmToMin("8.30")).toBeNull();
  });
});
