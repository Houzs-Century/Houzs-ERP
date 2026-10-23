// One payslip end to end (statutory, PCB, advances, penalties, net) and the
// month a penalty lands in.
import { describe, expect, test } from "vitest";
import { DEFAULT_PAY_RULES } from "../../scm/shared/hr-pay-rules";
import { buildPayslip, onPayroll, penaltyPeriod, type PayslipEmployee } from "./hr-payslip";

const emp: PayslipEmployee = {
  id: 1, empNo: "EMP-001", name: "Ali", departmentName: "Logistics", payMode: "MONTHLY", basicSalarySen: 260000, dailyRateSen: 0,
  workingDaysPerMonth: 26, workingHoursPerDay: 9, otMultiplier: 1.5, resignedOn: "", joinDate: "2025-01-01",
  paymentMethod: "TRANSFER", bankName: "Maybank", bankAccount: "1140", epf: true, socso: true, eis: true, pcb: true,
  taxResidency: "RESIDENT", taxCategory: "SINGLE", taxChildReliefSen: 0,
};
const fullMonth = () => {
  const days: { date: string; hours: number }[] = [];
  for (let d = 1; d <= 30; d++) {
    const ymd = `2026-09-${String(d).padStart(2, "0")}`;
    if (new Date(`${ymd}T00:00:00Z`).getUTCDay() !== 0) days.push({ date: ymd, hours: 9 });
  }
  return days;
};

describe("buildPayslip", () => {
  test("a full month: gross, statutory, nil PCB at RM2,600, advance and penalty off net", () => {
    const s = buildPayslip({
      employee: emp,
      period: "2026-09",
      salaryHistory: [{ effectiveFrom: "2025-01-01", basicSalarySen: 260000 }],
      days: fullMonth(),
      holidays: new Set(["2026-09-16"]),
      absenceThroughDay: 30,
      shortHours: 0,
      rulesOn: () => DEFAULT_PAY_RULES,
      advances: [{ date: "2026-09-10", amountSen: 20000 }],
      penaltySen: 5000,
      ytd: { remunerationSen: 0, epfSen: 0, pcbSen: 0 },
    });
    expect(s.grossSen).toBe(260000 + s.pay.otPaySen);
    expect(s.pay.otHolidayHours).toBe(9);
    expect(s.statutory.epfEmployeeSen).toBe(28600);
    expect(s.pcbStatus).toBe("COMPUTED");
    expect(s.pcbSen).toBe(0);
    expect(s.statutoryEmployeeSen).toBe(28600 + 745 + 390);
    expect(s.netSen).toBe(s.grossSen - s.statutoryEmployeeSen - 20000 - 5000);
    expect(s.advanceDates).toEqual(["2026-09-10"]);
  });

  test("cash pay drops the bank; a missing tax profile leaves PCB unknown, not RM0", () => {
    const s = buildPayslip({
      employee: { ...emp, paymentMethod: "CASH", basicSalarySen: 800000, taxResidency: null },
      period: "2026-09",
      salaryHistory: [],
      days: fullMonth(),
      holidays: new Set(),
      absenceThroughDay: 30,
      shortHours: 0,
      rulesOn: () => DEFAULT_PAY_RULES,
      advances: [],
      penaltySen: 0,
      ytd: { remunerationSen: 0, epfSen: 0, pcbSen: 0 },
    });
    expect(s).toMatchObject({ bankName: null, bankAccount: null, pcbStatus: "UNKNOWN", pcbSen: 0 });
  });

  test("trip pay and allowances add to gross, backpay comes off net, paid leave is not absent", () => {
    const days = fullMonth().filter((d) => d.date !== "2026-09-08" && d.date !== "2026-09-09");
    const base = {
      employee: { ...emp, epf: false, socso: false, eis: false, pcb: false },
      period: "2026-09",
      salaryHistory: [],
      days,
      holidays: new Set<string>(),
      absenceThroughDay: 30,
      shortHours: 0,
      rulesOn: () => DEFAULT_PAY_RULES,
      advances: [],
      penaltySen: 0,
      ytd: { remunerationSen: 0, epfSen: 0, pcbSen: 0 },
    };
    const trip = {
      employeeId: 1,
      drove: true,
      helped: false,
      commission: { lines: [{ crew: 3 as const, baseSen: 16502600, rateBps: 40, amountSen: 66010 }], baseSen: 16502600, missedDays: 0, cutBps: 0, amountSen: 66010 },
      lines: [{ key: "FAIR", label: "Fair", count: 4, unitSen: 10000, amountSen: 40000, dates: [] }],
      allowanceSen: 40000,
      totalSen: 106010,
    };
    const s = buildPayslip({
      ...base,
      paidLeave: new Set(["2026-09-08"]),
      trip,
      allowances: [
        { kind: "LEADERSHIP", amountSen: 20000, note: null },
        { kind: "BACKPAY", amountSen: 15000, note: "company advance" },
      ],
    });
    expect(s.pay.absentDates).toEqual(["2026-09-09"]);
    expect(s.pay.paidLeaveDates).toEqual(["2026-09-08"]);
    expect(s).toMatchObject({ commissionSen: 66010, tripAllowanceSen: 40000, allowancesSen: 20000, backpaySen: 15000 });
    expect(s.grossSen).toBe(s.pay.grossSen + 66010 + 40000 + 20000);
    expect(s.netSen).toBe(s.grossSen - 15000);
    expect(buildPayslip(base).pay.absentDays).toBe(2);
  });

  test("EPF is worked out on salary plus commission (Nico 2026-10-23)", () => {
    const s = buildPayslip({
      employee: { ...emp, socso: false, eis: false, pcb: false },
      period: "2026-09",
      salaryHistory: [],
      days: fullMonth(),
      holidays: new Set<string>(),
      absenceThroughDay: 30,
      shortHours: 0,
      rulesOn: () => DEFAULT_PAY_RULES,
      advances: [],
      penaltySen: 0,
      ytd: { remunerationSen: 0, epfSen: 0, pcbSen: 0 },
      trip: {
        employeeId: 1,
        drove: true,
        helped: false,
        commission: { lines: [], baseSen: 0, missedDays: 0, cutBps: 0, amountSen: 66010 },
        lines: [{ key: "FAIR", label: "Fair", count: 4, unitSen: 10000, amountSen: 40000, dates: [] }],
        allowanceSen: 40000,
        totalSen: 106010,
      },
    });
    expect(s.statutory.epfEmployeeSen).toBe(Math.round(((260000 + 66010) * 11) / 100));
    expect(s.statutory.epfEmployerSen).toBe(Math.round(((260000 + 66010) * 13) / 100));
  });
});

describe("onPayroll", () => {
  test("active, or resigned on or after the month starts; not before joining", () => {
    expect(onPayroll({ joinDate: "2026-09-15", resignedOn: "" }, "ACTIVE", "2026-09")).toBe(true);
    expect(onPayroll({ joinDate: "2026-10-01", resignedOn: "" }, "ACTIVE", "2026-09")).toBe(false);
    expect(onPayroll({ joinDate: "", resignedOn: "2026-09-10" }, "RESIGNED", "2026-09")).toBe(true);
    expect(onPayroll({ joinDate: "", resignedOn: "2026-08-31" }, "RESIGNED", "2026-09")).toBe(false);
    expect(onPayroll({ joinDate: "", resignedOn: "" }, "INACTIVE", "2026-09")).toBe(false);
  });
});

describe("penaltyPeriod", () => {
  test("the approval month, rolled past approved months", () => {
    expect(penaltyPeriod("2026-10-22", new Set())).toBe("2026-10");
    expect(penaltyPeriod("2026-10-22", new Set(["2026-10"]))).toBe("2026-11");
    expect(penaltyPeriod("2026-12-30", new Set(["2026-12"]))).toBe("2027-01");
  });
});
