// Labor Cost tab arithmetic: hours -> cost by department and employee, salary
// as of the month, OT split out, daily-paid by the day.
import { describe, expect, test } from "vitest";
import { DEFAULT_PAY_RULES } from "../../scm/shared/hr-pay-rules";
import { laborCost, type CostEmployeeIn } from "./hr-labor-cost";

const emp = (over: Partial<CostEmployeeIn>): CostEmployeeIn => ({
  id: 1, empNo: "EMP-001", name: "Ali", departmentId: 10,
  payMode: "MONTHLY", dailyRateSen: 0, workingHoursPerDay: 9, workingDaysPerMonth: 26, otMultiplier: 1.5, resignedOn: "", ...over,
});

describe("laborCost", () => {
  const holidays = new Set(["2026-10-20"]);
  const names = new Map([[10, "Logistics"], [20, "Warehouse"]]);
  test("cost by department and employee, OT kept apart", () => {
    const r = laborCost({
      employees: [emp({}), emp({ id: 2, empNo: "EMP-002", name: "Siti", departmentId: 20, payMode: "DAILY", dailyRateSen: 12000 })],
      salaryHistory: new Map([[1, [{ effective_from: "2026-01-01", basic_salary_sen: 260000 }]]]),
      entries: [
        { employeeId: 1, workDate: "2026-10-22", departmentId: 10, hours: 10 },
        { employeeId: 1, workDate: "2026-10-23", departmentId: 10, hours: 9 },
        { employeeId: 2, workDate: "2026-10-22", departmentId: 20, hours: 9 },
      ],
      holidays,
      cfgFor: () => DEFAULT_PAY_RULES,
      departmentNames: names,
    });
    // 26 working days in Oct 2026 with Deepavali: regular RM2,600 / 26 / 9 per hour.
    // Day 1: 9 regular + 1 OT at 2600/26/9 x 1.5; day 2: 9 regular.
    const regularHour = 260000 / 26 / 9;
    expect(r.byEmployee[0]).toMatchObject({ empNo: "EMP-001", days: 2, hours: 19, otHours: 1, salaryMissing: false });
    expect(r.byEmployee[0].costSen).toBe(Math.round(18 * regularHour + regularHour * 1.5));
    expect(r.byEmployee[0].otCostSen).toBe(Math.round(regularHour * 1.5));
    expect(r.byEmployee[1]).toMatchObject({ empNo: "EMP-002", costSen: 12000, otHours: 0 });
    expect(r.byDepartment.map((d) => [d.name, d.headcount])).toEqual([["Logistics", 1], ["Warehouse", 1]]);
    expect(r.totals).toMatchObject({ hours: 28, employees: 2 });
  });

  test("a monthly employee with no salary on record costs nothing and is flagged", () => {
    const r = laborCost({
      employees: [emp({})],
      salaryHistory: new Map(),
      entries: [{ employeeId: 1, workDate: "2026-10-22", departmentId: null, hours: 9 }],
      holidays,
      cfgFor: () => DEFAULT_PAY_RULES,
      departmentNames: names,
    });
    expect(r.byEmployee[0]).toMatchObject({ costSen: 0, salaryMissing: true });
    expect(r.byDepartment[0].name).toBe("No department");
  });

  test("a raise mid-year prices each month at its own salary", () => {
    const history = new Map([[1, [{ effective_from: "2026-01-01", basic_salary_sen: 260000 }, { effective_from: "2026-11-01", basic_salary_sen: 520000 }]]]);
    const one = (workDate: string) =>
      laborCost({ employees: [emp({})], salaryHistory: history, entries: [{ employeeId: 1, workDate, departmentId: 10, hours: 9 }], holidays, cfgFor: () => DEFAULT_PAY_RULES, departmentNames: names }).totals.costSen;
    expect(one("2026-11-02") / one("2026-10-22")).toBeGreaterThan(1.9);
  });
});
