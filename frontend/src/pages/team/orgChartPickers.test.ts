// The org chart's "Reports to" picker writes a real reporting line, and two of
// its option rules are not obvious from the call site: a manager who would
// create a cycle must not be offerable, and a manager the current view cannot
// resolve must still render as words rather than a bare id.
import { describe, expect, it } from "vitest";
import type { TeamMember } from "../../types";
import { isDescendantOf, managerOptions } from "./orgChartPickers";

const member = (
  id: number,
  name: string,
  managerId: number | null,
  department?: string,
): TeamMember =>
  ({
    id,
    name,
    email: `${name.toLowerCase()}@example.my`,
    manager_id: managerId,
    department_name: department ?? null,
    status: "active",
  }) as unknown as TeamMember;

//  boss ← mid ← junior
const boss = member(1, "Boss", null);
const mid = member(2, "alicia", 1, "Sales");
const junior = member(3, "Bernard", 2, "Logistics");
const outsider = member(4, "Sim", null, "Operation");
const users = [boss, mid, junior, outsider];

describe("isDescendantOf", () => {
  it("finds direct and indirect reports", () => {
    expect(isDescendantOf(mid.id, boss.id, users)).toBe(true);
    expect(isDescendantOf(junior.id, boss.id, users)).toBe(true);
  });

  it("is false upward and sideways", () => {
    expect(isDescendantOf(boss.id, junior.id, users)).toBe(false);
    expect(isDescendantOf(junior.id, junior.id, users)).toBe(false);
  });

  it("terminates on a cycle in the stored data instead of hanging", () => {
    const a = member(10, "A", 11);
    const b = member(11, "B", 10);
    expect(isDescendantOf(a.id, 99, [a, b])).toBe(false);
  });
});

describe("managerOptions", () => {
  it("leads with the clear row, then everyone else A→Z with their department", () => {
    // Case-insensitive collation: "alicia" sorts before "Bernard", not after
    // every capitalised name the way a raw code-point sort would put it.
    expect(managerOptions(junior, users)).toEqual([
      { value: "", label: "— No manager —" },
      { value: "2", label: "alicia · Sales" },
      { value: "1", label: "Boss" },
      { value: "4", label: "Sim · Operation" },
    ]);
  });

  it("never offers the member themselves, nor anyone below them", () => {
    const values = managerOptions(mid, users).map((o) => o.value);
    expect(values).not.toContain("2"); // self
    expect(values).not.toContain("3"); // own report — would be a cycle
    expect(values).toContain("1");
    // The top of the tree can only be re-parented outside its own subtree.
    expect(managerOptions(boss, users).map((o) => o.value)).toEqual(["", "4"]);
  });

  it("names an unresolvable manager instead of printing the raw id", () => {
    // The chart scopes the people list per COMPANY, so a manager in the other
    // company's tree has an id with no row here.
    const orphan = member(4, "Sim", 44);
    const opts = managerOptions(orphan, [orphan, mid]);
    expect(opts).toContainEqual({ value: "44", label: "(not in this list)" });
    expect(opts.map((o) => o.label).join()).not.toContain("44 ");
  });
});
