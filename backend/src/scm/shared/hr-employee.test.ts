// HR Employee Master: the Emp No series, reading a request body, and the save
// checks the form and the API share.
import { describe, expect, test } from "vitest";
import { emptyEmployeeInput, employeeInputProblem, nextEmpNo, parseEmployeeInput } from "./hr-employee";

const TODAY = "2026-10-21";
const valid = () => ({ ...emptyEmployeeInput(TODAY), empNo: "EMP-001", name: "Ali bin Abu" });

describe("nextEmpNo", () => {
  test("staff and outsourced run separate series from the highest existing number", () => {
    const existing = ["EMP-001", "EMP-007", "OSC-002", "DRIVER-A", null];
    expect(nextEmpNo(existing, false)).toBe("EMP-008");
    expect(nextEmpNo(existing, true)).toBe("OSC-003");
    expect(nextEmpNo([], false)).toBe("EMP-001");
  });
});

describe("parseEmployeeInput", () => {
  test("trims, upper-cases the Emp No and falls back to the defaults", () => {
    const e = parseEmployeeInput({ empNo: " emp-002 ", name: "  Siti  " }, TODAY);
    expect(e.empNo).toBe("EMP-002");
    expect(e.name).toBe("Siti");
    expect(e.workingDaysPerMonth).toBe(26);
    expect(e.paymentMethod).toBe("TRANSFER");
    expect(e.status).toBe("ACTIVE");
  });

  test("cash clears the bank fields and PCB off clears the tax declaration", () => {
    const e = parseEmployeeInput(
      { empNo: "EMP-1", name: "A", paymentMethod: "CASH", bankName: "Maybank", bankAccount: "123", pcbEnabled: false, taxResidency: "RESIDENT", taxChildReliefSen: 200000 },
      TODAY,
    );
    expect(e.bankName).toBe("");
    expect(e.bankAccount).toBe("");
    expect(e.taxResidency).toBeNull();
    expect(e.taxChildReliefSen).toBeNull();
  });

  test("a non-numeric amount is kept as NaN so the check refuses it", () => {
    const e = parseEmployeeInput({ empNo: "EMP-1", name: "A", basicSalarySen: "abc" }, TODAY);
    expect(employeeInputProblem(e)).toMatch(/Salary/);
  });
});

describe("employeeInputProblem", () => {
  test("a complete record passes", () => {
    expect(employeeInputProblem(valid())).toBeNull();
  });

  test("Emp No and name are required", () => {
    expect(employeeInputProblem({ ...valid(), empNo: "" })).toMatch(/Employee No/);
    expect(employeeInputProblem({ ...valid(), empNo: "EMP 1" })).toMatch(/letters, digits/);
    expect(employeeInputProblem({ ...valid(), name: "" })).toMatch(/Name/);
  });

  test("resigned needs a date on or after joining, and only resigned has one", () => {
    expect(employeeInputProblem({ ...valid(), status: "RESIGNED" })).toMatch(/resigned/);
    expect(employeeInputProblem({ ...valid(), status: "RESIGNED", resignedOn: "2026-01-01", joinDate: "2026-02-01" })).toMatch(/before the join/);
    expect(employeeInputProblem({ ...valid(), status: "RESIGNED", resignedOn: "2026-11-30" })).toBeNull();
    expect(employeeInputProblem({ ...valid(), resignedOn: "2026-11-30" })).toMatch(/Only a resigned/);
  });

  test("pay basis limits", () => {
    expect(employeeInputProblem({ ...valid(), basicSalarySen: -1 })).toMatch(/Salary/);
    expect(employeeInputProblem({ ...valid(), payMode: "DAILY", dailyRateSen: 0 })).toMatch(/rate per day/);
    expect(employeeInputProblem({ ...valid(), workingHoursPerDay: 7.5 })).toBeNull();
    expect(employeeInputProblem({ ...valid(), workingHoursPerDay: 7.25 })).toMatch(/one decimal/);
    expect(employeeInputProblem({ ...valid(), workingHoursPerDay: 0 })).toMatch(/Hours/);
    expect(employeeInputProblem({ ...valid(), workingDaysPerMonth: 32 })).toMatch(/Days/);
    expect(employeeInputProblem({ ...valid(), otMultiplier: 11 })).toMatch(/OT/);
  });
});
