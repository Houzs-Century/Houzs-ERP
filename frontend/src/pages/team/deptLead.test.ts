// buildDeptNodes' lead resolution (mig-pg 0331). A department's lead is now a
// REAL, settable field; the derived-from-manager_id inference is only the
// fallback. These pin that an explicit choice wins, that the fallback still
// works when none is set, and that a stale choice (person left the roster)
// degrades to the derived lead rather than showing a ghost.
import { describe, expect, it } from "vitest";
import type { TeamMember, Department } from "../../types";
import { buildDeptNodes } from "./teamShared";

const m = (
  id: number,
  name: string,
  deptId: number | null,
  managerId: number | null = null,
  status: TeamMember["status"] = "active",
): TeamMember =>
  ({
    id,
    name,
    email: `${name.toLowerCase()}@example.my`,
    status,
    manager_id: managerId,
    department_id: deptId,
  }) as unknown as TeamMember;

const dept = (id: number, name: string, extra: Partial<Department> = {}): Department =>
  ({
    id,
    name,
    description: null,
    color: "64748b",
    sort_order: id,
    member_count: 0,
    ...extra,
  }) as Department;

describe("buildDeptNodes — real lead vs derived", () => {
  it("a chosen lead_user_id wins over the derived lead", () => {
    // Carol reports to Alice, so Alice is the DERIVED lead — but the department
    // explicitly names Bob, so Bob leads and the node is marked chosen.
    const members = [m(1, "Alice", 10), m(2, "Bob", 10), m(3, "Carol", 10, 1)];
    const { nodes } = buildDeptNodes(members, [dept(10, "Ops", { lead_user_id: 2 })]);
    expect(nodes[0].lead?.id).toBe(2);
    expect(nodes[0].leadIsChosen).toBe(true);
  });

  it("falls back to the derived lead when no lead is set", () => {
    const members = [m(1, "Alice", 10), m(3, "Carol", 10, 1)];
    const { nodes } = buildDeptNodes(members, [dept(10, "Ops")]);
    expect(nodes[0].lead?.id).toBe(1); // Alice, derived
    expect(nodes[0].leadIsChosen).toBe(false);
  });

  it("falls back to derived when the chosen lead has left the roster", () => {
    const members = [m(1, "Alice", 10), m(3, "Carol", 10, 1)];
    const { nodes } = buildDeptNodes(members, [dept(10, "Ops", { lead_user_id: 999 })]);
    expect(nodes[0].lead?.id).toBe(1); // 999 is nobody → derived
    expect(nodes[0].leadIsChosen).toBe(false);
  });

  it("no lead at all (no reports, none chosen) stays null", () => {
    const members = [m(1, "Alice", 10), m(2, "Bob", 10)];
    const { nodes } = buildDeptNodes(members, [dept(10, "Ops")]);
    expect(nodes[0].lead).toBeNull();
    expect(nodes[0].leadIsChosen).toBe(false);
  });

  it("carries headcount_target through on the dept", () => {
    const { nodes } = buildDeptNodes([m(1, "Alice", 10)], [dept(10, "Ops", { headcount_target: 45 })]);
    expect(nodes[0].dept.headcount_target).toBe(45);
  });
});
