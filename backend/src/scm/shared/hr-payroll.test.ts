// Monthly pay (ported from Hookka's computeMonthlyLabor / calcStatutory) and
// PCB, checked against figures worked by hand.
import { describe, expect, test } from "vitest";
import { DEFAULT_PAY_RULES } from "./hr-pay-rules";
import { absenceCutoffDay, computeMonthlyPay, effectiveSalaryForMonth, statutoryFor, type PayEmployee } from "./hr-payroll";
import { residentPcbSen, resolvePcb } from "./hr-pcb";

const deepavali = new Set(["2026-10-20"]);
const monthly: PayEmployee = { payMode: "MONTHLY", salarySen: 260000, dailyRateSen: 0, workingDaysPerMonth: 26, workingHoursPerDay: 9, otMultiplier: 1.5, resignedOn: "" };

/** Every Oct 2026 working day at 9h except those listed, plus extras. */
function october(skip: string[], extra: Record<string, number>) {
  const days: { date: string; hours: number }[] = [];
  for (let d = 1; d <= 31; d++) {
    const ymd = `2026-10-${String(d).padStart(2, "0")}`;
    const sunday = new Date(`${ymd}T00:00:00Z`).getUTCDay() === 0;
    if (!sunday && !deepavali.has(ymd) && !skip.includes(ymd)) days.push({ date: ymd, hours: 9 });
  }
  for (const [date, hours] of Object.entries(extra)) days.push({ date, hours });
  return days;
}

describe("absenceCutoffDay", () => {
  test("today walked back by the grace working days, skipping Sundays and holidays", () => {
    expect(absenceCutoffDay(2026, 10, "2026-10-22", 2, new Set())).toBe(20);
    expect(absenceCutoffDay(2026, 10, "2026-10-22", 2, deepavali)).toBe(19);
  });
  test("a finished month counts whole; a month not reached counts none", () => {
    expect(absenceCutoffDay(2026, 9, "2026-10-22", 2, new Set())).toBe(30);
    expect(absenceCutoffDay(2026, 11, "2026-10-22", 2, new Set())).toBe(0);
  });
});

describe("computeMonthlyPay", () => {
  test("RM2,600: 2 absent days, 1.5 h docked, 1.5 h weekday OT, 4 h on a Sunday", () => {
    const p = computeMonthlyPay({
      employee: monthly,
      year: 2026,
      month: 10,
      days: october(["2026-10-05", "2026-10-06"], { "2026-10-07": 1.5, "2026-10-11": 4 }),
      holidays: deepavali,
      absenceThroughDay: 31,
      shortHours: 1.5,
      rulesOn: () => DEFAULT_PAY_RULES,
    });
    // day rate 2600/26 = RM100; hour rate 100 / (9 + 1 lunch) = RM10.
    expect(p.dayRateSen).toBe(10000);
    expect(p.hourRateSen).toBe(1000);
    expect(p.absentDates).toEqual(["2026-10-05", "2026-10-06"]);
    expect(p.absenceDeductionSen).toBe(20000);
    expect(p.shortHourDeductionSen).toBe(1500);
    expect(p.basicEarnedSen).toBe(238500);
    expect(p.otWeekdayPaySen).toBe(2250);
    expect(p.otSundayPaySen).toBe(8000);
    expect(p.grossSen).toBe(248750);
  });

  test("absences wait for the cutoff; days after resigning dock at once", () => {
    const base = { employee: monthly, year: 2026, month: 10, holidays: deepavali, shortHours: 0, rulesOn: () => DEFAULT_PAY_RULES };
    const early = computeMonthlyPay({ ...base, days: october(["2026-10-21"], {}), absenceThroughDay: 19 });
    expect(early.absentDays).toBe(0);
    const resigned = computeMonthlyPay({
      ...base,
      employee: { ...monthly, resignedOn: "2026-10-28" },
      days: october(["2026-10-29", "2026-10-30", "2026-10-31"], {}),
      absenceThroughDay: 19,
    });
    expect(resigned.absentDates).toEqual(["2026-10-29", "2026-10-30", "2026-10-31"]);
  });

  test("weekday OT under 15 minutes earns nothing; a public holiday pays every hour x3", () => {
    const p = computeMonthlyPay({
      employee: monthly,
      year: 2026,
      month: 10,
      days: [{ date: "2026-10-22", hours: 9.2 }, { date: "2026-10-20", hours: 5 }],
      holidays: deepavali,
      absenceThroughDay: 0,
      shortHours: 0,
      rulesOn: () => DEFAULT_PAY_RULES,
    });
    expect(p.otWeekdayHours).toBe(0);
    expect(p.otHolidayPaySen).toBe(5 * 1000 * 3);
    expect(p.daysWorked).toBe(1);
  });

  test("daily-paid: days worked at the day rate, never absent", () => {
    const p = computeMonthlyPay({
      employee: { ...monthly, payMode: "DAILY", salarySen: 0, dailyRateSen: 12000 },
      year: 2026,
      month: 10,
      days: [{ date: "2026-10-21", hours: 9 }, { date: "2026-10-22", hours: 9 }],
      holidays: deepavali,
      absenceThroughDay: 31,
      shortHours: 0,
      rulesOn: () => DEFAULT_PAY_RULES,
    });
    expect(p).toMatchObject({ absentDays: 0, basicEarnedSen: 24000, fullSalarySen: 0 });
  });
});

describe("effectiveSalaryForMonth", () => {
  test("a raise mid-month is weighted by working days", () => {
    const s = effectiveSalaryForMonth([{ effectiveFrom: "2026-01-01", basicSalarySen: 260000 }, { effectiveFrom: "2026-10-16", basicSalarySen: 286000 }], 0, 2026, 10, deepavali);
    // 26 working days: 13 before the 16th at 2600, 13 from it at 2860.
    expect(s).toBe(273000);
  });
});

describe("statutoryFor (Hookka flat rates)", () => {
  test("EPF 11% / 13% of salary, SOCSO and EIS flat, only when on", () => {
    expect(statutoryFor(260000, { epf: true, socso: true, eis: true }, DEFAULT_PAY_RULES)).toEqual({
      epfEmployeeSen: 28600,
      epfEmployerSen: 33800,
      socsoEmployeeSen: 745,
      socsoEmployerSen: 2615,
      eisEmployeeSen: 390,
      eisEmployerSen: 390,
    });
    expect(statutoryFor(260000, { epf: false, socso: false, eis: false }, DEFAULT_PAY_RULES).epfEmployeeSen).toBe(0);
  });
});

describe("PCB", () => {
  test("resident single RM6,000 in January: RM207.50", () => {
    expect(residentPcbSen({ monthIndex: 1, currentRemunerationSen: 600000, currentEpfSen: 66000, ytdRemunerationSen: 0, ytdEpfSen: 0, ytdPcbSen: 0, category: "SINGLE", childReliefSen: 0 })).toBe(20750);
  });
  test("RM3,000 owes nothing once the rebate is applied", () => {
    expect(residentPcbSen({ monthIndex: 1, currentRemunerationSen: 300000, currentEpfSen: 33000, ytdRemunerationSen: 0, ytdEpfSen: 0, ytdPcbSen: 0, category: "SINGLE", childReliefSen: 0 })).toBe(0);
  });
  const base = { year: 2026, monthIndex: 10, currentEpfSen: 66000, ytdRemunerationSen: 5400000, ytdEpfSen: 594000, ytdPcbSen: 186750 };
  test("a missing profile is UNKNOWN, not RM0, unless nil under every profile", () => {
    expect(resolvePcb({ ...base, pcbEnabled: true, residency: null, category: null, childReliefSen: null, currentRemunerationSen: 600000 }).status).toBe("UNKNOWN");
    expect(resolvePcb({ ...base, pcbEnabled: true, residency: "RESIDENT", category: null, childReliefSen: null, currentRemunerationSen: 600000 }).status).toBe("UNKNOWN");
    expect(resolvePcb({ ...base, ytdRemunerationSen: 0, ytdEpfSen: 0, ytdPcbSen: 0, pcbEnabled: true, residency: "RESIDENT", category: null, childReliefSen: null, currentRemunerationSen: 200000 }).status).toBe("ZERO_PROVEN");
  });
  test("off is DISABLED; non-resident is a flat 30%", () => {
    expect(resolvePcb({ ...base, pcbEnabled: false, residency: "RESIDENT", category: "SINGLE", childReliefSen: 0, currentRemunerationSen: 600000 }).status).toBe("DISABLED");
    expect(resolvePcb({ ...base, pcbEnabled: true, residency: "NON_RESIDENT", category: null, childReliefSen: null, currentRemunerationSen: 200000 })).toMatchObject({ status: "COMPUTED", pcbSen: 60000 });
  });
});
