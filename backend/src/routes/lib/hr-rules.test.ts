// routes/hr.ts pure pieces: salary in force on a date, the columns written
// (salary never written directly), and the audit diff hiding personal numbers.
import { describe, expect, test } from "vitest";
import { emptyEmployeeInput } from "../../scm/shared/hr-employee";
import { employeeColumns, employeeDiff, planBulkImport, planBulkLink, salaryAsOf, type BulkAccount, type ImportRowIn } from "./hr-rules";

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

describe("planBulkLink", () => {
  const acc = (over: Partial<BulkAccount> & { userId: number; email: string }): BulkAccount => ({
    name: null, phone: null, departmentId: null, position: null, ...over,
  });
  test("runs the Emp No on from the book, copies the account, skips linked and nameless", () => {
    const plan = planBulkLink(
      [
        acc({ userId: 1, name: "Ali", email: "ali@x.com", phone: "012", departmentId: 5, position: "Driver" }),
        acc({ userId: 2, name: null, email: "bob@x.com" }),
        acc({ userId: 3, name: "Already", email: "c@x.com" }),
        acc({ userId: 4, name: null, email: "" }),
      ],
      new Set([3]),
      ["EMP-003"],
      false,
      "2026-11-17",
    );
    expect(plan.create.map((r) => r.input.empNo)).toEqual(["EMP-004", "EMP-005"]);
    expect(plan.create[0].input).toMatchObject({ empNo: "EMP-004", name: "Ali", userId: 1, phone: "012", departmentId: 5, position: "Driver", payMode: "MONTHLY", basicSalarySen: 180000, isOutsource: false });
    // a null account name falls back to the email, so the row is still usable
    expect(plan.create[1].input).toMatchObject({ empNo: "EMP-005", name: "bob@x.com", userId: 2, phone: "", departmentId: null, position: "" });
    expect(plan.skipped).toEqual([
      { userId: 3, name: "Already", reason: "already has an employee record" },
      { userId: 4, name: "", reason: "the ERP account has no name" },
    ]);
  });
  test("the outsource toggle only switches the number series", () => {
    const plan = planBulkLink([acc({ userId: 7, name: "Z", email: "z@x.com" })], new Set(), ["EMP-003"], true, "2026-11-17");
    expect(plan.create[0].input.empNo).toBe("OSC-001");
    expect(plan.create[0].input.isOutsource).toBe(true);
  });
});

describe("planBulkImport", () => {
  const row = (over: Partial<ReturnType<typeof emptyEmployeeInput>>, accountEmail: string | null = null): ImportRowIn => ({
    input: { ...emptyEmployeeInput("2026-11-17"), ...over },
    accountEmail,
  });
  test("auto-numbers blanks gaplessly, refuses dup numbers, bad links and bad rows", () => {
    const plan = planBulkImport(
      [
        row({ name: "A", empNo: "" }),                       // 0 -> EMP-011
        row({ name: "B", empNo: "EMP-010" }),                // 1 -> dup number
        row({ name: "", empNo: "" }),                        // 2 -> no name (consumes no number)
        row({ name: "C", empNo: "" }, "ali@x.com"),          // 3 -> EMP-012, linked to user 1
        row({ name: "D", empNo: "" }, "linked@x.com"),       // 4 -> account already an employee
        row({ name: "E", empNo: "" }, "ghost@x.com"),        // 5 -> no such account
      ],
      {
        existingEmpNos: ["EMP-010"],
        linkedUserIds: new Set([99]),
        userIdByEmail: new Map([["ali@x.com", 1], ["linked@x.com", 99]]),
      },
    );
    expect(plan.create.map((r) => ({ index: r.index, empNo: r.input.empNo }))).toEqual([
      { index: 0, empNo: "EMP-011" },
      { index: 3, empNo: "EMP-012" },
    ]);
    expect(plan.create[1].input.userId).toBe(1);
    expect(plan.errors).toEqual([
      { index: 1, message: "Employee No EMP-010 is already in use." },
      { index: 2, message: "Name is required." },
      { index: 4, message: "That ERP account already has an employee record." },
      { index: 5, message: "No active ERP account has the email ghost@x.com." },
    ]);
  });
});
