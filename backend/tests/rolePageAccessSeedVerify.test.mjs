// scripts/seed-role-page-access.mjs verifies its own write on a FRESH connection.
// On the 2026-10-20 production apply that check reported 116 failures against a
// table that was exactly right: the re-read's role_id -> rows lookup found
// nothing, every role resolved to "none", and the per-member old-vs-new step
// "passed" only because both sides were computed from the same empty rows.
// These tests pin the three rules that make the self-check trustworthy:
//   - a short / empty re-read fails LOUDLY with counts (after a retry), and
//   - role_id is compared as a Number on both sides of every lookup, and
//   - a role or member with NO stored rows is a failure, not a vacuous pass.
import { describe, expect, it, vi } from "vitest";
import {
  PAGE_KEYS,
  baseWithRows,
  checkStoredAgainstPlan,
  expectedRowCount,
  memberCtx,
  readStoredRows,
} from "../scripts/lib/role-page-access-seed.mjs";

// Three real-shaped roles: a '*' role with no title, a title-less role resolved
// by the permission backfill, and a titled finance member (position policy row).
const NO_POLICY = { cohort: null, profile: null, can_move_money: null, can_write_config: null, is_fleet: null, duty: null };
const USERS = [
  { id: 1, role_id: 1, role_permissions: '["*"]', position_id: null, position_name: null, user_department_name: null, ...NO_POLICY },
  { id: 2, role_id: 2, role_permissions: '["projects.read","sales.read"]', position_id: null, position_name: null, user_department_name: "Sales Department", ...NO_POLICY },
  {
    id: 3, role_id: 3, role_permissions: '["projects.finance.view","scm.access","scm.payment_voucher.post"]',
    position_id: 28, position_name: "Finance Executive", user_department_name: "Finance Department",
    cohort: "full", profile: null, can_move_money: 1, can_write_config: 0, is_fleet: 0, duty: "finance",
  },
];

const plans = USERS.map((u) => ({
  role: { id: u.role_id, name: `role-${u.role_id}` },
  base: baseWithRows(memberCtx(u), []),
}));

/** What the seed writes for one plan: one row per catalogue page. */
const rowsOf = (pl, roleId = pl.role.id) =>
  PAGE_KEYS.map((k) => ({ role_id: roleId, page_key: k, level: pl.base[k] ?? "none" }));
const allRows = (roleId = (pl) => pl.role.id) => plans.flatMap((pl) => rowsOf(pl, roleId(pl)));

describe("readStoredRows — the re-read must be whole before it is trusted", () => {
  it("expects one row per catalogue page for every planned role", () => {
    expect(expectedRowCount(plans)).toBe(plans.length * PAGE_KEYS.length);
  });

  it("returns a whole read at once, without waiting", async () => {
    const sleep = vi.fn(async () => {});
    const read = vi.fn(async () => allRows());
    const rows = await readStoredRows({ read, plans, sleep });
    expect(rows).toHaveLength(expectedRowCount(plans));
    expect(read).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a read that has not seen the commit yet, then accepts the whole one", async () => {
    const sleep = vi.fn(async () => {});
    const read = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(allRows().slice(0, 10))
      .mockResolvedValueOnce(allRows());
    const rows = await readStoredRows({ read, plans, sleep });
    expect(rows).toHaveLength(expectedRowCount(plans));
    expect(read).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("fails an empty read loudly, with the count it saw and the count it expected", async () => {
    const sleep = vi.fn(async () => {});
    const read = vi.fn(async () => []);
    await expect(readStoredRows({ read, plans, attempts: 4, sleep })).rejects.toThrow(
      new RegExp(`saw 0 role_page_access row\\(s\\).*expected ${expectedRowCount(plans)}`),
    );
    expect(read).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("fails a short read, naming how many seeded rows it did see", async () => {
    const short = allRows().slice(0, expectedRowCount(plans) - 1);
    await expect(readStoredRows({ read: async () => short, plans, attempts: 2, sleep: async () => {} }))
      .rejects.toThrow(new RegExp(`\\(${short.length} of them seeded rows\\), expected ${expectedRowCount(plans)}`));
  });

  it("does not let rows of other roles or retired page keys pad out a short read", async () => {
    const padding = Array.from({ length: 200 }, (_, i) => ({ role_id: 99, page_key: `retired.${i}`, level: "full" }));
    const short = [...allRows().slice(0, 5), ...padding];
    await expect(readStoredRows({ read: async () => short, plans, attempts: 1, sleep: async () => {} }))
      .rejects.toThrow(/5 of them seeded rows/);
  });

  it("names the role_id type of the first row, so a key-type mismatch is visible in the failure", async () => {
    const strings = [{ role_id: "1", page_key: "retired.x", level: "full" }];
    await expect(readStoredRows({ read: async () => strings, plans, attempts: 1, sleep: async () => {} }))
      .rejects.toThrow(/role_id="1" \(string\)/);
  });
});

describe("checkStoredAgainstPlan — a missing lookup is a failure, never a pass", () => {
  it("passes a correctly seeded table, with every active member checked", () => {
    const { problems, checked } = checkStoredAgainstPlan({ plans, stored: allRows(), members: USERS });
    expect(problems).toEqual([]);
    expect(checked).toBe(USERS.length);
  });

  it("passes when the driver hands role_id back as a string (Number coercion on both sides)", () => {
    const stored = allRows((pl) => String(pl.role.id));
    const members = USERS.map((u) => ({ ...u, role_id: String(u.role_id) }));
    const { problems, checked } = checkStoredAgainstPlan({ plans, stored, members });
    expect(problems).toEqual([]);
    expect(checked).toBe(USERS.length);
  });

  it("fails every role and every member when the lookup finds nothing — the 2026-10-20 false pass", () => {
    const { problems, checked } = checkStoredAgainstPlan({ plans, stored: [], members: USERS });
    expect(checked).toBe(0);
    for (const pl of plans) {
      expect(problems.some((x) => x.startsWith(`role ${pl.role.id} `) && x.includes("found 0 stored row(s)"))).toBe(true);
    }
    for (const u of USERS) {
      expect(problems.some((x) => x.startsWith(`member #${u.id} `) && x.includes("no stored rows found"))).toBe(true);
    }
  });

  it("fails only the role whose rows are missing, and its members", () => {
    const stored = plans.filter((pl) => pl.role.id !== 3).flatMap((pl) => rowsOf(pl));
    const { problems, checked } = checkStoredAgainstPlan({ plans, stored, members: USERS });
    expect(checked).toBe(2);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^role 3 /);
    expect(problems[1]).toMatch(/^member #3 \(role 3\): no stored rows found/);
  });

  it("flags a money page whose stored level differs from the plan", () => {
    const finance = plans.find((pl) => pl.role.id === 3);
    const planned = finance.base["scm.finance"] ?? "none";
    const flipped = planned === "none" ? "full" : "none";
    const stored = allRows().map((r) =>
      r.role_id === 3 && r.page_key === "scm.finance" ? { ...r, level: flipped } : r,
    );
    const { problems } = checkStoredAgainstPlan({ plans, stored, members: USERS });
    expect(problems.some((x) => x.includes('role 3 "role-3": money/stock page scm.finance'))).toBe(true);
    expect(problems.some((x) => x.startsWith("member #3 ") && x.includes("NEW page access differs from OLD"))).toBe(true);
  });

  it("fails a member whose role is not in the seed at all", () => {
    const stray = { ...USERS[0], id: 77, role_id: 42 };
    const { problems } = checkStoredAgainstPlan({ plans, stored: allRows(), members: [...USERS, stray] });
    expect(problems).toEqual([`member #77 (role 42): no stored rows found for the member's role — cannot compare OLD with NEW`]);
  });
});
