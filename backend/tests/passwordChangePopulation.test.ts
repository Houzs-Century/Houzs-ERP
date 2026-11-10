import { describe, expect, test } from "vitest";
import {
  ADMIN_KEYS,
  FINANCE_KEYS,
  GOD_POSITION_NAMES,
  classifyMember,
  selectPopulation,
  summarise,
} from "../scripts/lib/password-change-population.mjs";
import { isValidPermission } from "../src/services/permissions";
import { positionGrantsWildcard } from "../src/services/positionPolicy";

const base = {
  role_permissions: "[]",
  position_name: null as string | null,
  has_policy_row: false,
  policy_cohort: null as string | null,
  policy_duty: null as string | null,
  policy_money: null as unknown,
};

describe("the population follows the permission model the app enforces", () => {
  test("every key named is a real catalogue key (an undeclared one confers nothing)", () => {
    for (const k of [...ADMIN_KEYS, ...FINANCE_KEYS]) expect(isValidPermission(k), k).toBe(true);
  });

  test("the god-title names match positionGrantsWildcard for a Title with no row", () => {
    for (const n of GOD_POSITION_NAMES) expect(positionGrantsWildcard(n, null), n).toBe(true);
    expect(positionGrantsWildcard("Sales Executive", null)).toBe(false);
  });
});

describe("classifyMember", () => {
  test("a wildcard role is admin", () => {
    expect(classifyMember({ ...base, role_permissions: '["*"]' }).admin).toEqual(["wildcard-role"]);
  });

  test("a god Title is admin by row, and by name only when there is no row", () => {
    expect(classifyMember({ ...base, has_policy_row: true, policy_cohort: "god" }).admin).toEqual(["god-title"]);
    expect(classifyMember({ ...base, position_name: "  Managing   Director " }).admin).toEqual(["god-title"]);
    // A row that says otherwise wins over the name, as in positionGrantsWildcard.
    expect(classifyMember({ ...base, position_name: "Owner", has_policy_row: true, policy_cohort: "full" }).admin).toEqual([]);
  });

  test("users.manage / roles.manage are admin", () => {
    expect(classifyMember({ ...base, role_permissions: '["users.manage","roles.manage"]' }).admin).toEqual([
      "users.manage",
      "roles.manage",
    ]);
  });

  test("finance by Title duty, by the money flag, or by a money key", () => {
    expect(classifyMember({ ...base, has_policy_row: true, policy_duty: "finance" }).finance).toEqual(["finance-duty"]);
    expect(classifyMember({ ...base, has_policy_row: true, policy_money: true }).finance).toEqual(["money-title"]);
    expect(classifyMember({ ...base, role_permissions: '["scm.payment_voucher.approve"]' }).finance).toEqual([
      "scm.payment_voucher.approve",
    ]);
  });

  test("an ordinary member is neither", () => {
    const c = classifyMember({ ...base, role_permissions: '["projects.read","scm.payment_request.create"]' });
    expect(c).toEqual({ admin: [], finance: [] });
  });

  test("a malformed permissions value is no permissions, not a crash", () => {
    expect(classifyMember({ ...base, role_permissions: "not json" })).toEqual({ admin: [], finance: [] });
  });
});

describe("selectPopulation / summarise", () => {
  test("only active members with a password, and counts carry no identity", () => {
    const rows = [
      { ...base, id: 1, status: "active", has_password: true, role_permissions: '["*"]' },
      { ...base, id: 2, status: "active", has_password: true, has_policy_row: true, policy_duty: "finance" },
      { ...base, id: 3, status: "disabled", has_password: true, role_permissions: '["*"]' },
      { ...base, id: 4, status: "active", has_password: false, role_permissions: '["*"]' },
      { ...base, id: 5, status: "active", has_password: true, role_permissions: '["projects.read"]' },
      { ...base, id: 6, status: "active", has_password: true, role_permissions: '["users.manage","hr.payroll.approve"]' },
    ];
    const pop = selectPopulation(rows);
    expect(pop.map((p) => p.id)).toEqual([1, 2, 6]);
    const s = summarise(pop);
    expect(s).toMatchObject({ total: 3, admin: 2, finance: 2, both: 1 });
    expect(JSON.stringify(s)).not.toMatch(/@/);
  });
});
