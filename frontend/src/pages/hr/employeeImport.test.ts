import { describe, expect, test } from "vitest";
import { mapImportGrid } from "./employeeImport";

const DEPTS = new Map<string, number>([["sales", 5]]);
const TODAY = "2026-11-17";

describe("mapImportGrid", () => {
  test("maps a good row to the wire shape and resolves headers loosely", () => {
    const grid = [
      ["Name", "Emp No", "ERP Account Email", "Phone", "Department", "Pay Basis", "Basic Salary (RM)", "EPF", "Join Date", "Random"],
      ["Ali", "", "ali@x.com", "012", "Sales", "Monthly", "1,800.00", "Yes", "2026-11-17", "ignore me"],
    ];
    const { rows, ignoredHeaders } = mapImportGrid(grid, DEPTS, TODAY);
    expect(ignoredHeaders).toEqual(["Random"]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.problem).toBeNull();
    expect(r.rowNumber).toBe(2);
    expect(r.display.empNo).toBe("(auto)");
    expect(r.row).toMatchObject({
      name: "Ali",
      empNo: "",
      accountEmail: "ali@x.com",
      phone: "012",
      departmentId: 5,
      payMode: "MONTHLY",
      basicSalarySen: 180000,
      epfEnabled: true,
      joinDate: "2026-11-17",
    });
  });

  test("normalises DD/MM/YYYY join dates", () => {
    const { rows } = mapImportGrid(
      [["Name", "Join Date"], ["Siti", "05/02/2026"]],
      DEPTS,
      TODAY,
    );
    expect(rows[0].row.joinDate).toBe("2026-02-05");
    expect(rows[0].problem).toBeNull();
  });

  test("flags a missing name, an unknown department, a bad salary and a daily row with no rate", () => {
    const grid = [
      ["Name", "Department", "Pay Basis", "Basic Salary (RM)", "Daily Rate (RM)"],
      ["", "Sales", "Monthly", "1800", ""],        // no name
      ["Bob", "Marketing", "Monthly", "1800", ""],  // unknown dept
      ["Cat", "Sales", "Monthly", "abc", ""],       // bad salary
      ["Dee", "Sales", "Daily", "", ""],            // daily, no rate
      ["", "", "", "", ""],                          // blank -> skipped
    ];
    const { rows } = mapImportGrid(grid, DEPTS, TODAY);
    expect(rows.map((r) => r.problem)).toEqual([
      "Name is required.",
      'Unknown department "Marketing". Create it first or leave the column blank.',
      "Basic Salary must be a number in RM.",
      "A daily-paid employee needs a rate per day.",
    ]);
  });
});
