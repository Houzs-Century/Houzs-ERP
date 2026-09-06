import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AudiencePicker,
  EMPTY_AUDIENCE,
  activeExclusions,
  audienceSummary,
  divisionsOf,
  groupByDivision,
  membersOf,
  membersOfDivision,
  personMatches,
  type AudienceValue,
} from "./AudiencePicker";
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
  { ...member(11, "Siti Aminah", 2, "Storekeeper"), division: "Inbound" } as TeamMember,
  { ...member(12, "Ravi Kumaran", 2, "Storekeeper"), division: "Outbound" } as TeamMember,
  member(13, "Cheah Mei Ling", 1, "Sales Executive"),
  { ...member(14, "Gone", 2, "Storekeeper"), status: "disabled" } as TeamMember,
  member(15, "Tan Ah Kow", 2, "Forklift Driver"),
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
    expect(membersOf(USERS, 2).map((u) => u.id)).toEqual([11, 12, 15]);
    expect(membersOf(USERS, null)).toEqual([]);
  });
});

describe("AudiencePicker", () => {
  function setup(value: AudienceValue = EMPTY_AUDIENCE, salesDirOnly = false, focusDeptId: number | null = null) {
    const onChange = vi.fn();
    const onFocusDept = vi.fn();
    render(
      <AudiencePicker
        value={value}
        onChange={onChange}
        focusDeptId={focusDeptId}
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
    fireEvent.click(screen.getByRole("button", { name: /^Warehouse/ }));
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
    expect((screen.getByRole("button", { name: /^Warehouse/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Cheah Mei Ling/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  // ---- owner feedback 2026-09-05: divisions, search, untick under a department

  it("groups the people column by division, unnamed last, with a tick-all per group", () => {
    const { onChange } = setup(EMPTY_AUDIENCE);
    // Focus Warehouse (column three follows the focus, not the tick).
    fireEvent.click(screen.getByRole("button", { name: /^Warehouse/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ deptIds: [2] }));
    const groups = groupByDivision(membersOf(USERS, 2));
    expect(groups.map((g) => g.division)).toEqual(["Inbound", "Outbound", ""]);
    expect(groups[2].members.map((m) => m.name)).toEqual(["Tan Ah Kow"]);
  });

  it("the search box filters people by name / position / division", () => {
    expect(personMatches(USERS[0], "siti")).toBe(true);
    expect(personMatches(USERS[0], "INBOUND")).toBe(true);
    expect(personMatches(USERS[0], "forklift")).toBe(false);
    expect(personMatches(USERS[4], "forklift")).toBe(true);
    expect(personMatches(USERS[4], "")).toBe(true);
  });

  it("under a SELECTED department a person can be unticked, and ticked back", () => {
    const value: AudienceValue = { ...EMPTY_AUDIENCE, deptIds: [1] };
    const { onChange } = setup(value);
    // Sales is both the first (focused) department and selected: Cheah shows ticked.
    const row = screen.getByRole("button", { name: /Cheah Mei Ling/ }) as HTMLButtonElement;
    expect(row.disabled).toBe(false);
    expect(row.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(row);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ excludedUserIds: [13], userIds: [] }),
    );
  });

  it("re-ticking an unticked person clears the exclusion; unticking the department forgets it", () => {
    const value: AudienceValue = { ...EMPTY_AUDIENCE, deptIds: [1], excludedUserIds: [13] };
    const { onChange } = setup(value);
    const row = screen.getByRole("button", { name: /Cheah Mei Ling/ });
    expect(row.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(row);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ excludedUserIds: [] }));
    fireEvent.click(screen.getByRole("button", { name: /^Sales/ }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ deptIds: [], excludedUserIds: [] }),
    );
  });

  it("an exclusion counts only while a selected department or division reaches the person", () => {
    const plain: AudienceValue = { ...EMPTY_AUDIENCE, deptIds: [2], userIds: [13] };
    expect(activeExclusions(plain, USERS)).toEqual([]);
    const withUntick: AudienceValue = { ...plain, excludedUserIds: [12, 13] };
    // 13 is not a Warehouse member, so that exclusion is inert; 12 counts.
    expect(activeExclusions(withUntick, USERS)).toEqual([12]);
    expect(audienceSummary(withUntick, COMPANIES, DEPTS, USERS)).toBe(
      "Warehouse · 1 unticked · All companies",
    );
    // Reached through a division alone.
    const viaDivision: AudienceValue = {
      ...EMPTY_AUDIENCE,
      divisions: [{ deptId: 2, division: "Outbound" }],
      excludedUserIds: [11, 12],
    };
    expect(activeExclusions(viaDivision, USERS)).toEqual([12]);
    expect(audienceSummary(viaDivision, COMPANIES, DEPTS, USERS)).toBe(
      "Warehouse › Outbound · 1 unticked · All companies",
    );
  });

  it("the department tree lists its divisions; a division row is a target of its own", () => {
    expect(divisionsOf(USERS, 2)).toEqual(["Inbound", "Outbound"]);
    expect(divisionsOf(USERS, 1)).toEqual([]);
    expect(membersOfDivision(USERS, 2, "outbound").map((u) => u.id)).toEqual([12]);
    const { onChange } = setup(EMPTY_AUDIENCE);
    // Sales is focused first; open Warehouse's tree and tick Outbound.
    fireEvent.click(screen.getByRole("button", { name: "Expand Warehouse divisions" }));
    fireEvent.click(screen.getByRole("button", { name: "Warehouse › Outbound" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ divisions: [{ deptId: 2, division: "Outbound" }], deptIds: [] }),
    );
  });

  it("with the whole department selected its division rows are implied and cannot be toggled", () => {
    setup({ ...EMPTY_AUDIENCE, deptIds: [2] });
    fireEvent.click(screen.getByRole("button", { name: "Expand Warehouse divisions" }));
    const row = screen.getByRole("button", { name: "Warehouse › Inbound" }) as HTMLButtonElement;
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(row.disabled).toBe(true);
  });

  it("a person reached through a selected DIVISION can be unticked too; the group row is the division", () => {
    const value: AudienceValue = { ...EMPTY_AUDIENCE, divisions: [{ deptId: 2, division: "Inbound" }] };
    const { onChange } = setup(value, false, 2);
    // Siti (Inbound) shows ticked through the division; Ravi (Outbound) does not.
    const siti = screen.getByRole("button", { name: /Siti Aminah/ });
    expect(siti.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Ravi Kumaran/ }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(siti);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ excludedUserIds: [11] }));
    // The Outbound group's tick-all targets the division itself.
    fireEvent.click(screen.getByRole("button", { name: "Outbound — everyone" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        divisions: [
          { deptId: 2, division: "Inbound" },
          { deptId: 2, division: "Outbound" },
        ],
      }),
    );
    // The unnamed group can only be picked person by person (explicit ids).
    fireEvent.click(screen.getByRole("button", { name: "No division — everyone" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ userIds: [15] }));
  });

  it("a Sales-Director-only composer has no company column and no All staff", () => {
    setup(EMPTY_AUDIENCE, true);
    expect(screen.queryByText("Company")).toBeNull();
    expect(screen.queryByRole("button", { name: "All staff" })).toBeNull();
    expect(screen.getByText("Dept / Division")).toBeTruthy();
  });
});
