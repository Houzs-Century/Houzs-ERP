import { describe, expect, test } from "vitest";
import { autoOtWindow, confirmedOtMinutes, parseOtSegment, planAutoOtClaim, punchOtMinutes, segmentMinutes } from "./hr-ot";
import { toAttendanceRules } from "../../scm/shared/hr-attendance";
import { DEFAULT_PAY_RULES } from "../../scm/shared/hr-pay-rules";
import { computeMonthlyPay, type PayEmployee } from "../../scm/shared/hr-payroll";

describe("parseOtSegment", () => {
  test("a normal after-shift window: 20:30-21:30 is one hour", () => {
    expect(parseOtSegment("20:30", "21:30")).toEqual({ ok: true, startMin: 1230, endMin: 1290 });
  });
  test("before the shift: 08:00-09:00", () => {
    expect(parseOtSegment("08:00", "09:00")).toEqual({ ok: true, startMin: 480, endMin: 540 });
  });
  test("a window crossing midnight rolls the end past 1440", () => {
    const r = parseOtSegment("23:30", "00:30");
    expect(r).toEqual({ ok: true, startMin: 1410, endMin: 1470 });
    if (r.ok) expect(segmentMinutes({ start_min: r.startMin, end_min: r.endMin })).toBe(60);
  });
  test("bad shapes and a zero-length window are refused", () => {
    expect(parseOtSegment("8am", "9").ok).toBe(false);
    expect(parseOtSegment("20:00", "20:00").ok).toBe(false);
  });
  test("a block over 16 hours is refused", () => {
    expect(parseOtSegment("06:00", "23:00").ok).toBe(false);
  });
});

describe("confirmedOtMinutes", () => {
  test("sums only CONFIRMED rows", () => {
    const rows = [
      { status: "CONFIRMED", start_min: 480, end_min: 540 }, // 60
      { status: "PENDING", start_min: 1230, end_min: 1290 }, // ignored
      { status: "CONFIRMED", start_min: 1410, end_min: 1470 }, // 60
      { status: "REJECTED", start_min: 0, end_min: 600 }, // ignored
    ];
    expect(confirmedOtMinutes(rows)).toBe(120);
  });
});

describe("punchOtMinutes (HC-0125 hybrid)", () => {
  const r = toAttendanceRules(DEFAULT_PAY_RULES);
  const shiftLen = r.standardWorkMin + r.lunchMin; // span of a plain full day
  test("staying one hour past a full day earns 60 minutes", () => {
    expect(punchOtMinutes(shiftLen + 60, r.standardWorkMin, r.lunchMin)).toBe(60);
  });
  test("a plain full day earns nothing", () => {
    expect(punchOtMinutes(shiftLen, r.standardWorkMin, r.lunchMin)).toBe(0);
  });
  test("a late start nets the overtime down, never below zero", () => {
    // present only as long as a full day, but it started late, so no net OT.
    expect(punchOtMinutes(shiftLen, r.standardWorkMin, r.lunchMin)).toBe(0);
    expect(punchOtMinutes(shiftLen - 30, r.standardWorkMin, r.lunchMin)).toBe(0);
  });
  test("rounds to the minute", () => {
    expect(punchOtMinutes(shiftLen + 90.4, r.standardWorkMin, r.lunchMin)).toBe(90);
    expect(punchOtMinutes(shiftLen + 90.6, r.standardWorkMin, r.lunchMin)).toBe(91);
  });
});

describe("autoOtWindow", () => {
  test("carries exactly the earned minutes from the shift end", () => {
    const w = autoOtWindow(1080, 90);
    expect(w).toEqual({ startMin: 1080, endMin: 1170 });
    expect(w.endMin - w.startMin).toBe(90);
  });
});

describe("planAutoOtClaim", () => {
  const SHIFT_END = 1080;
  test("inserts a fresh claim when overtime appears and none exists", () => {
    expect(planAutoOtClaim({ existingAuto: null, reportedOwnsDay: false, shiftEndMin: SHIFT_END, otMin: 90 })).toEqual({ kind: "insert", startMin: 1080, endMin: 1170 });
  });
  test("refreshes a still-pending auto claim", () => {
    expect(planAutoOtClaim({ existingAuto: { id: 7, status: "PENDING" }, reportedOwnsDay: false, shiftEndMin: SHIFT_END, otMin: 120 })).toEqual({ kind: "update", id: 7, startMin: 1080, endMin: 1200 });
  });
  test("removes a pending auto claim once the punch no longer earns any", () => {
    expect(planAutoOtClaim({ existingAuto: { id: 7, status: "PENDING" }, reportedOwnsDay: false, shiftEndMin: SHIFT_END, otMin: 0 })).toEqual({ kind: "delete", id: 7 });
  });
  test("does nothing when there is no overtime and no auto claim", () => {
    expect(planAutoOtClaim({ existingAuto: null, reportedOwnsDay: false, shiftEndMin: SHIFT_END, otMin: 0 })).toEqual({ kind: "none" });
  });
  test("never re-raises or overwrites a supervisor's confirm or reject", () => {
    for (const status of ["CONFIRMED", "REJECTED"]) {
      expect(planAutoOtClaim({ existingAuto: { id: 7, status }, reportedOwnsDay: false, shiftEndMin: SHIFT_END, otMin: 120 })).toEqual({ kind: "none" });
    }
  });
  test("steps aside when a human reported the day: a pending auto claim is removed, none is created", () => {
    expect(planAutoOtClaim({ existingAuto: { id: 7, status: "PENDING" }, reportedOwnsDay: true, shiftEndMin: SHIFT_END, otMin: 120 })).toEqual({ kind: "delete", id: 7 });
    expect(planAutoOtClaim({ existingAuto: null, reportedOwnsDay: true, shiftEndMin: SHIFT_END, otMin: 120 })).toEqual({ kind: "none" });
  });
});

describe("a confirmed AUTO claim pays exactly like a reported claim of the same minutes", () => {
  const monthly: PayEmployee = { payMode: "MONTHLY", salarySen: 260000, dailyRateSen: 0, workingDaysPerMonth: 26, workingHoursPerDay: 9, otMultiplier: 1.5, resignedOn: "" };
  const r = toAttendanceRules(DEFAULT_PAY_RULES);
  test("same window minutes -> same weekday OT pay", () => {
    // A punch 90 minutes past a full day yields an AUTO window of 90 minutes.
    const otMin = punchOtMinutes(r.standardWorkMin + r.lunchMin + 90, r.standardWorkMin, r.lunchMin);
    const win = autoOtWindow(r.endMin, otMin);
    const autoHours = (win.endMin - win.startMin) / 60; // exactly what computePeriod derives for a CONFIRMED claim
    expect(autoHours).toBe(1.5);
    const pay = (hoursByDate: Map<string, number>) =>
      computeMonthlyPay({
        employee: monthly,
        year: 2026,
        month: 10,
        days: [{ date: "2026-10-22", hours: 9 }],
        holidays: new Set(),
        absenceThroughDay: 0,
        shortHours: 0,
        rulesOn: () => DEFAULT_PAY_RULES,
        confirmedOtHoursByDate: hoursByDate,
      }).otWeekdayPaySen;
    expect(pay(new Map([["2026-10-22", autoHours]]))).toBe(pay(new Map([["2026-10-22", 1.5]])));
  });
});
