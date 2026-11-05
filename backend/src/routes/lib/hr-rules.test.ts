// routes/hr.ts pure pieces: salary in force on a date, the columns written
// (salary never written directly), and the audit diff hiding personal numbers.
import { describe, expect, test } from "vitest";
import { emptyEmployeeInput } from "../../scm/shared/hr-employee";
import { employeeColumns, employeeDiff, salaryAsOf } from "./hr-rules";

describe("salaryAsOf", () => {
  const history = [
    { effective_from: "2026-11-01", basic_salary_sen: 250000 },
    { effective_from: "2026-01-01", basic_salary_sen: 200000 },
  ];
  test("the newest row on or before the date", () => {
    expect(salaryAsOf(history, "2026-10-31")).toBe(200000);
    expect(salaryAsOf(history, "2026-11-01")).toBe(250000);
  });
  test("before the first row, the first row; no rows, null", () => {
    expect(salaryAsOf(history, "2025-12-01")).toBe(200000);
    expect(salaryAsOf([], "2026-10-21")).toBeNull();
  });
});

describe("employeeColumns", () => {
  test("blank text is stored as NULL, resigned date only when resigned, no salary column", () => {
    const cols = employeeColumns({ ...emptyEmployeeInput("2026-10-21"), empNo: "EMP-001", name: "A", resignedOn: "2026-10-01" });
    expect(cols.phone).toBeNull();
    expect(cols.resigned_on).toBeNull();
    expect("basic_salary_sen" in cols).toBe(false);
    expect(cols.working_hours_per_day).toBe("9");
  });
});

describe("employeeDiff", () => {
  test("records changed fields and hides bank account and IC values", () => {
    const before = { ...emptyEmployeeInput("2026-10-21"), empNo: "EMP-001", name: "A", bankAccount: "111", icNumber: "900101" };
    const after = { ...before, name: "B", bankAccount: "222", icNumber: "900102", basicSalarySen: 1 };
    expect(employeeDiff(before, after)).toEqual({
      name: { from: "A", to: "B" },
      bankAccount: { from: "(hidden)", to: "(hidden)" },
      icNumber: { from: "(hidden)", to: "(hidden)" },
    });
  });
});
