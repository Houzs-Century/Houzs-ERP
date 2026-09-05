import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AudiencePicker, EMPTY_AUDIENCE, audienceSummary, membersOf, type AudienceValue } from "./AudiencePicker";
import type { Department, TeamMember } from "../../types";

/* The composer's three-column audience (design handoff 2026-09-04). Pins the
   summary line, the department checkbox / focus split, the people column and
   the explicit All staff choice. */

const DEPTS = [
  { id: 1, name: "Sales" },
  { id: 2, name: "Warehouse" },
] as Department[];

function member(id: number, name: string, dept: number, position: string): TeamMember {
  return {
    id,
    email: `${id}@x`,
    name,
    status: "active",
    role_id: 1,
    role_name: "Staff",
    manager_id: null,
    manager_name: null,
    manager_email: null,
    department_id: dept,
    department_name: null,
    department_color: null,
    position_id: null,
    position_name: position,
  } as TeamMember;
}
const USERS = [
  member(11, "Siti Aminah", 2, "Storekeeper"),
  member(12, "Ravi Kumaran", 2, "Storekeeper"),
  member(13, "Cheah Mei Ling", 1, "Sales Executive"),
  { ...member(14, "Gone", 2, "Storekeeper"), status: "disabled" } as TeamMember,
];
const COMPANIES = [
  { id: 1, code: "HC", name: "Houzs Century" },
  { id: 2, code: "2990", name: "2990" },
];

describe("audienceSummary", () => {
  it("reads departments + people + company; All staff overrides; empty is honest", () => {
    expect(audienceSummary(EMPTY_AUDIENCE, COMPANIES, DEPTS, USERS)).toBe("No recipients yet · All companies");
    expect(audienceSummary({ ...EMPTY_AUDIENCE, deptIds: [2, 1], companyId: 1 }, COMPANIES, DEPTS, USERS)).toBe(
      "Warehouse + Sales · Houzs Century",
    );
    expect(audienceSummary({ ...EMPTY_AUDIENCE, userIds: [11, 13] }, COMPANIES, DEPTS, USERS)).toBe(
      "Siti Aminah, Cheah Mei Ling · All companies",
    );
    expect(audienceSummary({ ...EMPTY_AUDIENCE, allStaff: true, deptIds: [1] }, [], DEPTS, USERS)).toBe("All staff");
  });

  it("membersOf lists active members of the department only", () => {
    expect(membersOf(USERS, 2).map((u) => u.id)).toEqual([11, 12]);
    expect(membersOf(USERS, null)).toEqual([]);
  });
});

describe("AudiencePicker", () => {
  function setup(value: AudienceValue = EMPTY_AUDIENCE, salesDirOnly = false) {
    const onChange = vi.fn();
    const onFocusDept = vi.fn();
    render(
      <AudiencePicker
        value={value}
        onChange={onChange}
        focusDeptId={null}
        onFocusDept={onFocusDept}
        companies={COMPANIES}
        departments={DEPTS}
        users={USERS}
        salesDirOnly={salesDirOnly}
      />,
    );
    return { onChange, onFocusDept };
  }

  it("company single-select, department checkbox adds the id and focuses column three", () => {
    const { onChange, onFocusDept } = setup();
    fireEvent.click(screen.getByRole("button", { name: "2990" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: 2 }));
    fireEvent.click(screen.getByRole("button", { name: /Warehouse/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ deptIds: [2] }));
    expect(onFocusDept).toHaveBeenCalledWith(2);
    // Column three lists the first department (Sales) until a focus is chosen.
    expect(screen.getByText("People · Sales")).toBeTruthy();
    expect(screen.getByText("Cheah Mei Ling")).toBeTruthy();
    expect(screen.queryByText("Gone")).toBeNull();
  });

  it("a person's checkbox includes them individually; All staff switches the rest off", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Cheah Mei Ling/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ userIds: [13] }));
    fireEvent.click(screen.getByRole("button", { name: "All staff" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ allStaff: true }));
  });

  it("with All staff on, departments and people are disabled", () => {
    setup({ ...EMPTY_AUDIENCE, allStaff: true });
    expect((screen.getByRole("button", { name: /Warehouse/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Cheah Mei Ling/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a Sales-Director-only composer has no company column and no All staff", () => {
    setup(EMPTY_AUDIENCE, true);
    expect(screen.queryByText("Company")).toBeNull();
    expect(screen.queryByRole("button", { name: "All staff" })).toBeNull();
    expect(screen.getByText("Dept / Role")).toBeTruthy();
  });
});
