// routes/hr.ts pure pieces: salary in force on a date, the columns written
// (salary never written directly), and the audit diff hiding personal numbers.
import { describe, expect, test } from "vitest";
import { emptyEmployeeInput, type EmployeeInput } from "../../scm/shared/hr-employee";
import { employeeColumns, employeeDiff, employeeUpdateColumns, planBulkImport, planBulkLink, salaryAsOf, type BulkAccount, type ImportRowIn } from "./hr-rules";

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
  const row = (
    over: Partial<EmployeeInput>,
    opts: { accountEmail?: string | null; provided?: Array<keyof EmployeeInput> } = {},
  ): ImportRowIn => ({
    input: { ...emptyEmployeeInput("2026-11-17"), ...over },
    provided: new Set(opts.provided ?? []),
    accountEmail: opts.accountEmail ?? null,
  });

  test("auto-numbers blanks gaplessly, refuses a within-file dup number and bad rows", () => {
    const plan = planBulkImport(
      [
        row({ name: "A", empNo: "" }),                                  // 0 -> EMP-011 (existing EMP-010)
        row({ name: "B", empNo: "EMP-011" }),                           // 1 -> collides with row 0's new number
        row({ name: "", empNo: "" }),                                   // 2 -> no name (consumes no number)
        row({ name: "C", empNo: "" }, { accountEmail: "ali@x.com" }),   // 3 -> EMP-012, linked to user 1
        row({ name: "E", empNo: "" }, { accountEmail: "ghost@x.com" }), // 4 -> no such account
      ],
      {
        existing: [{ id: 50, empNo: "EMP-010", userId: 99 }],
        userIdByEmail: new Map([["ali@x.com", 1]]),
      },
    );
    expect(plan.create.map((r) => ({ index: r.index, empNo: r.input.empNo }))).toEqual([
      { index: 0, empNo: "EMP-011" },
      { index: 3, empNo: "EMP-012" },
    ]);
    expect(plan.create[1].input.userId).toBe(1);
    expect(plan.update).toEqual([]);
    expect(plan.errors).toEqual([
      { index: 1, message: "Employee No EMP-011 is already in use." },
      { index: 2, message: "Name is required." },
      { index: 4, message: "No active ERP account has the email ghost@x.com." },
    ]);
  });

  test("matches an existing person by ERP account or by Emp No and patches only the filled cells", () => {
    const plan = planBulkImport(
      [
        row(
          { name: "Khalid", empNo: "HC0009", icNumber: "660120-08-5365", bankName: "Maybank", bankAccount: "164", epfEnabled: true },
          { accountEmail: "khalid@x.com", provided: ["name", "icNumber", "bankName", "bankAccount", "epfEnabled"] },
        ), // by account -> EMP-001, HC0009 ignored
        row(
          { name: "Sagor", empNo: "EMP-002", passportNumber: "B00381966", nationality: "Bangladeshi" },
          { provided: ["name", "passportNumber", "nationality"] },
        ), // by Emp No -> EMP-002
      ],
      {
        existing: [
          { id: 1, empNo: "EMP-001", userId: 7 },
          { id: 2, empNo: "EMP-002", userId: null },
        ],
        userIdByEmail: new Map([["khalid@x.com", 7]]),
      },
    );
    expect(plan.create).toEqual([]);
    expect(plan.errors).toEqual([]);
    expect(plan.update).toEqual([
      { index: 0, employeeId: 1, empNo: "EMP-001", name: "Khalid", patch: { name: "Khalid", icNumber: "660120-08-5365", bankName: "Maybank", bankAccount: "164", epfEnabled: true } },
      { index: 1, employeeId: 2, empNo: "EMP-002", name: "Sagor", patch: { name: "Sagor", passportNumber: "B00381966", nationality: "Bangladeshi" } },
    ]);
  });

  test("a blank cell stays out of the patch, so an import never clears a field or the salary", () => {
    const plan = planBulkImport(
      [row({ name: "", empNo: "", icNumber: "900101-07-5501" }, { accountEmail: "a@x.com", provided: ["icNumber"] })],
      { existing: [{ id: 9, empNo: "EMP-009", userId: 3 }], userIdByEmail: new Map([["a@x.com", 3]]) },
    );
    expect(plan.update).toEqual([{ index: 0, employeeId: 9, empNo: "EMP-009", name: "EMP-009", patch: { icNumber: "900101-07-5501" } }]);
    expect(plan.create).toEqual([]);
  });

  test("two rows that resolve to the same person — the second is refused, not applied twice", () => {
    const plan = planBulkImport(
      [
        row({ name: "x", empNo: "EMP-001" }, { provided: ["name"] }),
        row({ name: "y", empNo: "" }, { accountEmail: "u@x.com", provided: ["name"] }),
      ],
      { existing: [{ id: 1, empNo: "EMP-001", userId: 7 }], userIdByEmail: new Map([["u@x.com", 7]]) },
    );
    expect(plan.update.map((u) => u.index)).toEqual([0]);
    expect(plan.errors).toEqual([{ index: 1, message: "Two rows change the same employee (EMP-001)." }]);
  });
});

describe("employeeUpdateColumns", () => {
  test("maps only the patched keys to columns; blank text becomes NULL", () => {
    expect(employeeUpdateColumns({ icNumber: "900101", bankName: "Maybank", epfEnabled: true, departmentId: 5 })).toEqual({
      ic_number: "900101",
      bank_name: "Maybank",
      epf_enabled: true,
      department_id: 5,
    });
    expect(employeeUpdateColumns({ phone: "" })).toEqual({ phone: null });
    expect(employeeUpdateColumns({})).toEqual({});
  });
});
