/* Owner 2026-11-21: the access page shows what the Org Chart gives each person,
   Management reads everything, and the rail tags a mailbox that is shared or a
   colleague's. */
import { describe, expect, it } from "vitest";
import { departmentIdsOf, isManagement, syncState } from "./mail-access-parts";
import { isRedundantGrant, colleagueMailboxes, levelGroup, levelLabel, ownDepartmentMailboxes, planAccessSave } from "./mail-access-levels";
import { reachTagOf } from "./MailCenter/mail-sidebar";
import type { Department, TeamMember } from "../types";
import type { MailAddress } from "./MailCenter/mail-actions";

const dept = (id: number, name: string) => ({ id, name }) as Department;
const DEPTS = [dept(1, "Sales"), dept(2, "Operation"), dept(20, " Management ")];
const member = (department_id: number | null, department_ids?: number[]) => ({ id: 9, department_id, department_ids }) as TeamMember;
const box = (departmentId: number | null) => ({ id: "b", address: "x@houzscentury.com", label: "", active: true, departmentId }) as MailAddress;

describe("mail access on the Org Chart", () => {
  it("counts the primary and every extra department once", () => {
    expect(departmentIdsOf(member(2, [2, 1]))).toEqual([2, 1]);
    expect(departmentIdsOf(member(2))).toEqual([2]);
    expect(departmentIdsOf(member(null))).toEqual([]);
  });

  it("a Management member always reads the whole company", () => {
    expect(isManagement(member(20), DEPTS)).toBe(true);
    expect(isManagement(member(1), DEPTS)).toBe(false);
  });

  it("three levels; the older own-only setting shows as L1", () => {
    expect(levelGroup("personal")).toBe("department");
    expect(levelLabel("department")).toBe("L1 · Personal");
    expect(levelLabel("department_all")).toBe("L2 · Department");
    expect(levelLabel("company")).toBe("L3 · Company");
  });

  it("L1 offers only colleagues who share a department; their department mailbox is included", () => {
    const u = (id: number, d: number[]) => ({ id, department_id: d[0], department_ids: d, status: "active" }) as TeamMember;
    const elvis = u(1, [2, 1]);
    const users = [elvis, u(2, [2]), u(3, [1]), u(4, [5])];
    const own = (id: string, owner: number) => ({ id, address: `${id}@x.com`, label: "", active: true, assignedUserId: owner }) as MailAddress;
    const addresses = [own("me", 1), own("ops-mate", 2), own("sales-mate", 3), own("other", 4), { ...box(2), id: "ops" }, { ...box(5), id: "far" }];
    expect(colleagueMailboxes(elvis, users, addresses).map((a) => a.id)).toEqual(["ops-mate", "sales-mate"]);
    expect(ownDepartmentMailboxes(elvis, addresses).map((a) => a.id)).toEqual(["ops"]);
  });

  it("a grant to their own mailbox or own department mailbox is not shown as extra", () => {
    const sales = { id: 4, department_id: 1, department_ids: [1] } as TeamMember;
    expect(isRedundantGrant({ ...box(1), id: "sales" }, sales)).toBe(true);
    expect(isRedundantGrant({ ...box(2), id: "ops" }, sales)).toBe(false);
    expect(isRedundantGrant({ id: "me", address: "me@x.com", label: "", active: true, assignedUserId: 4 } as MailAddress, sales)).toBe(true);
    expect(isRedundantGrant({ id: "mate", address: "mate@x.com", label: "", active: true, assignedUserId: 5 } as MailAddress, sales)).toBe(false);
  });

  it("Save sends only differences, and leaving L2 clears its department ticks", () => {
    const before = { level: "department_all" as const, grants: new Set(["a"]), departments: new Set([3]) };
    expect(planAccessSave(before, { ...before, departments: new Set([3, 4]) })).toEqual({ level: null, grant: [], revoke: [], departments: [3, 4] });
    expect(planAccessSave(before, { level: "department", grants: new Set(["a", "b"]), departments: new Set([3]) })).toEqual({
      level: "department", grant: ["b"], revoke: [], departments: [],
    });
    const legacy = { level: "personal" as const, grants: new Set<string>(), departments: new Set<number>() };
    expect(planAccessSave(legacy, { ...legacy, level: "department" }).level).toBeNull();
  });

  it("a mailbox is quiet after 3 days without mail, waiting while Google has not added it", () => {
    const now = Date.parse("2026-11-21T00:00:00Z");
    const row = (lastInboundAt: string | null, pending = false) => ({ address: "a@x.com", pending, lastInboundAt, threads: 1 });
    expect(syncState(row("2026-11-20T00:00:00Z"), now)).toBe("live");
    expect(syncState(row("2026-11-17T00:00:00Z"), now)).toBe("quiet");
    expect(syncState(row(null), now)).toBe("never");
    expect(syncState(row(null, true), now)).toBe("waiting");
  });

  it("the rail tags a shared mailbox and a colleague's mailbox, not a department mailbox", () => {
    const vis = {
      level: "department_all", manage: false, myAddress: "a@x.com", sendFrom: [],
      mailboxes: [
        { address: "ops@x.com", label: "", reach: "granted" as const },
        { address: "bob@x.com", label: "", reach: "department" as const },
        { address: "sales@x.com", label: "", reach: "department" as const },
      ],
    };
    expect(reachTagOf(vis, "OPS@x.com", false)).toBe("Shared");
    expect(reachTagOf(vis, "bob@x.com", true)).toBe("Team");
    expect(reachTagOf(vis, "sales@x.com", false)).toBeNull();
    expect(reachTagOf(null, "ops@x.com", false)).toBeNull();
  });
});
