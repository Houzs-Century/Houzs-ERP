// HR labour maths: working days, a punch's hours and dock, day-typed OT, and
// what a logged day costs (ported from Hookka's labor-day-cost / attendance-deduct).
import { describe, expect, test } from "vitest";
import { DEFAULT_PAY_RULES } from "./hr-pay-rules";
import { toAttendanceRules } from "./hr-attendance";
import { NO_CLOCKOUT_HALF_DAY_FROM, countWorkingDays, dayEntryCostsSen, dayTypedOt, isWorkingDay, noClockoutDockHours, punchDayHours, punchLateMinutes, punchShortfallHours, rulesForEmployeeHours, type CostEmployee } from "./hr-labor";

const rules = toAttendanceRules(DEFAULT_PAY_RULES);
const none = new Set<string>();

describe("working days", () => {
  test("Monday to Saturday, not Sunday, not a public holiday", () => {
    expect(isWorkingDay("2026-10-24", none)).toBe(true); // Saturday
    expect(isWorkingDay("2026-10-25", none)).toBe(false); // Sunday
    expect(isWorkingDay("2026-10-20", new Set(["2026-10-20"]))).toBe(false);
  });
  test("October 2026 has 27 working days, 26 with Deepavali", () => {
    expect(countWorkingDays(2026, 10, 31, none)).toBe(27);
    expect(countWorkingDays(2026, 10, 31, new Set(["2026-10-20"]))).toBe(26);
    expect(countWorkingDays(2026, 10, 3, none)).toBe(3);
  });
});

describe("a punch on Working Hours", () => {
  test("08:00 to 18:00 is 9 hours; to 19:30 adds 1.5 OT", () => {
    expect(punchDayHours(480, 1080, rules, true)).toEqual({ hours: 9, broken: false });
    expect(punchDayHours(480, 1170, rules, true)).toEqual({ hours: 10.5, broken: false });
  });
  test("a broken punch credits the standard day only when the rule says so", () => {
    expect(punchDayHours(1081, 1082, rules, true)).toEqual({ hours: 9, broken: true });
    expect(punchDayHours(1081, 1082, rules, false)).toEqual({ hours: 0, broken: true });
  });
  test("the employee's own hours / day is the standard", () => {
    const r = rulesForEmployeeHours(rules, 7.5);
    expect(r.standardWorkMin).toBe(450);
    expect(punchDayHours(480, 1080, r, true).hours).toBe(9);
  });
});

describe("a punch's dock", () => {
  test("late past the grace and leaving early are short hours; OT offsets them first", () => {
    expect(punchShortfallHours(510, 1080, rules)).toBe(0.5);
    expect(punchShortfallHours(480, 960, rules)).toBe(2);
    expect(punchShortfallHours(510, 1110, rules)).toBe(0);
  });
  test("a broken punch never docks", () => {
    expect(punchShortfallHours(1081, 1082, rules)).toBe(0);
  });
});

describe("no-clock-out half-day dock", () => {
  test("a working day auto-closed with no clock-out, on/after the start date, docks half the standard day", () => {
    expect(noClockoutDockHours({ forgotten: true, workingDay: true, workDate: "2026-11-23", standardWorkMin: 450 })).toBe(3.75);
    expect(noClockoutDockHours({ forgotten: true, workingDay: true, workDate: "2026-11-25", standardWorkMin: 540 })).toBe(4.5);
  });
  test("before the start date, a real clock-out, or a non-working day: no dock", () => {
    expect(noClockoutDockHours({ forgotten: true, workingDay: true, workDate: "2026-11-22", standardWorkMin: 450 })).toBe(0);
    expect(noClockoutDockHours({ forgotten: false, workingDay: true, workDate: "2026-11-25", standardWorkMin: 450 })).toBe(0);
    expect(noClockoutDockHours({ forgotten: true, workingDay: false, workDate: "2026-11-25", standardWorkMin: 450 })).toBe(0);
  });
  test("the rule starts 2026-11-23 (attendance go-live)", () => {
    expect(NO_CLOCKOUT_HALF_DAY_FROM).toBe("2026-11-23");
  });
});

describe("a punch's lateness", () => {
  const grace = rules.lateGraceMin;
  test("on time is never late; within the grace is none; past it counts in full from shift start", () => {
    expect(punchLateMinutes(rules.startMin, 1080, rules)).toBe(0);
    expect(punchLateMinutes(rules.startMin + grace, 1080, rules)).toBe(0);
    expect(punchLateMinutes(rules.startMin + grace + 1, 1080, rules)).toBe(grace + 1);
  });
  test("the clock-out does not change lateness, so an open day still reads late", () => {
    const inMin = rules.startMin + grace + 10;
    expect(punchLateMinutes(inMin, inMin, rules)).toBe(grace + 10);
  });
});

describe("day-typed OT", () => {
  const cfg = { sundayOtMultiplier: 2, holidayOtMultiplier: 3 };
  test("weekday: hours above the standard day at the employee's multiplier", () => {
    expect(dayTypedOt("2026-10-22", none, 10.5, 9, 1.5, cfg)).toEqual({ otHours: 1.5, multiplier: 1.5, kind: "WEEKDAY" });
  });
  test("Sunday and public holiday: every hour", () => {
    expect(dayTypedOt("2026-10-25", none, 6, 9, 1.5, cfg)).toEqual({ otHours: 6, multiplier: 2, kind: "SUNDAY" });
    expect(dayTypedOt("2026-10-20", new Set(["2026-10-20"]), 6, 9, 1.5, cfg)).toEqual({ otHours: 6, multiplier: 3, kind: "HOLIDAY" });
  });
});

describe("what a day costs", () => {
  const monthly: CostEmployee = { payMode: "MONTHLY", dailyRateSen: 0, workingHoursPerDay: 9, workingDaysPerMonth: 26, otMultiplier: 1.5, resignedOn: "" };
  const cfg = { sundayOtMultiplier: 2, holidayOtMultiplier: 3 };
  test("a normal day: regular hours at salary / month working days / 9", () => {
    const r = dayEntryCostsSen({ employee: monthly, salarySen: 270000, ymd: "2026-10-22", entryHours: [9], monthWorkingDays: 27, holidays: none, cfg });
    expect(Math.round(r.costs[0])).toBe(10000);
  });
  test("weekday OT at salary / 26 / 9 x 1.5", () => {
    const r = dayEntryCostsSen({ employee: monthly, salarySen: 234000, ymd: "2026-10-22", entryHours: [10], monthWorkingDays: 26, holidays: none, cfg });
    expect(r.otHours).toBe(1);
    expect(Math.round(r.costs[0])).toBe(9000 + 1500);
  });
  test("daily-paid: the day rate split by hours; nothing after resigning", () => {
    const daily: CostEmployee = { ...monthly, payMode: "DAILY", dailyRateSen: 12000 };
    expect(dayEntryCostsSen({ employee: daily, salarySen: 0, ymd: "2026-10-22", entryHours: [6, 3], monthWorkingDays: 26, holidays: none, cfg }).costs).toEqual([8000, 4000]);
    expect(dayEntryCostsSen({ employee: { ...monthly, resignedOn: "2026-10-21" }, salarySen: 270000, ymd: "2026-10-22", entryHours: [9], monthWorkingDays: 27, holidays: none, cfg }).costs).toEqual([0]);
  });
});
