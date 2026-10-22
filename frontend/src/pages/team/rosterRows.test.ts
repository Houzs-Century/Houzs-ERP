import { describe, expect, test } from "vitest";
import { rosterRows } from "./rosterRows";
import type { TeamMember } from "../../types";

const base = {
  id: 1,
  email: "a@example.test",
  name: "A",
  status: "active",
  role_id: 1,
  role_name: "Role",
  manager_id: null,
  manager_name: null,
  manager_email: null,
  department_id: null,
  department_name: null,
  department_color: null,
  division: null,
  position_id: null,
  position_name: null,
  brands: [],
  company_ids: [],
  invited_at: null,
  joined_at: null,
  last_login_at: null,
  created_at: "2026-10-22T00:00:00Z",
  profile_pic_r2_key: null,
  phone: null,
} satisfies TeamMember;

const m = (id: number, status: TeamMember["status"]): TeamMember => ({ ...base, id, status });

const people: TeamMember[] = [m(1, "active"), m(2, "invited"), m(3, "disabled")];

describe("rosterRows", () => {
  test("the default 'all' roster excludes removed (disabled) members", () => {
    expect(rosterRows(people, "all", false).map((u) => u.id)).toEqual([1, 2]);
  });

  test("the Disabled attention node still shows its removed members under 'all'", () => {
    // Its scope is already disabled-only; onDisabledView keeps the exclusion off.
    const removedOnly = [m(3, "disabled")];
    expect(rosterRows(removedOnly, "all", true).map((u) => u.id)).toEqual([3]);
  });

  test("the Disabled pill shows only removed members", () => {
    expect(rosterRows(people, "disabled", true).map((u) => u.id)).toEqual([3]);
  });

  test("the Active pill shows only active members", () => {
    expect(rosterRows(people, "active", false).map((u) => u.id)).toEqual([1]);
  });

  test("the Pending pill shows only invited members", () => {
    expect(rosterRows(people, "invited", false).map((u) => u.id)).toEqual([2]);
  });
});
