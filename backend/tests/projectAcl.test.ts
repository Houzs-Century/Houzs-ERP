import { describe, expect, test } from "vitest";
import { canSeeProject, withinPicGrace, PIC_GRACE_DAYS } from "../src/services/projectAcl";
import type { AuthUser } from "../src/services/auth";

// PIC visibility expires PIC_GRACE_DAYS after a project ends (owner:
// "完了的四天之后"). Scoped users lose it; unscoped (admin) keep it.

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const daysAhead = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

function scopedUser(over: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 5,
    email: "s@x",
    name: "s",
    role_id: 1,
    role_name: "Sales Person",
    position_id: null,
    position_name: null,
    status: "active",
    permissions: [],
    permissions_set: new Set<string>(),
    manager_id: null,
    scope_to_pic: true,
    department_id: 1,
    brand_scope: ["AKEMI"],
    page_access: {},
    ...over,
  } as AuthUser;
}

describe("projectAcl — PIC visibility grace window", () => {
  test("withinPicGrace: no end date or ended ≤ grace → visible; older → expired", () => {
    expect(withinPicGrace({})).toBe(true);
    expect(withinPicGrace({ end_date: null })).toBe(true);
    expect(withinPicGrace({ end_date: daysAgo(2) })).toBe(true);
    expect(withinPicGrace({ end_date: daysAgo(PIC_GRACE_DAYS + 3) })).toBe(false);
    expect(withinPicGrace({ end_date: daysAhead(3) })).toBe(true);
  });

  test("scoped PIC loses an over project after the grace window", () => {
    const u = scopedUser();
    const base = { pic_id: 5, brand: "AKEMI" };
    expect(canSeeProject(u, { ...base, end_date: daysAgo(2) })).toBe(true);
    expect(canSeeProject(u, { ...base, end_date: daysAgo(PIC_GRACE_DAYS + 3) })).toBe(false);
    expect(canSeeProject(u, { ...base, end_date: null })).toBe(true);
  });

  test("unscoped (admin) is unaffected by the grace window", () => {
    const admin = scopedUser({ scope_to_pic: false });
    expect(canSeeProject(admin, { pic_id: 999, brand: "OTHER", end_date: daysAgo(100) })).toBe(true);
  });

  test("grace does not override the PIC-line or brand gates", () => {
    const u = scopedUser();
    // recent end but not their PIC line → still hidden
    expect(canSeeProject(u, { pic_id: 999, brand: "AKEMI", end_date: daysAgo(1) })).toBe(false);
    // recent + their PIC but brand not in scope → hidden
    expect(canSeeProject(u, { pic_id: 5, brand: "OTHER", end_date: daysAgo(1) })).toBe(false);
  });
});
