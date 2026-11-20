/* Owner 2026-11-21: the access page shows what the Org Chart gives each person,
   Management reads everything, and the rail tags a mailbox that is shared or a
   colleague's. */
import { describe, expect, it } from "vitest";
import { autoReason, departmentIdsOf, effectiveLevel, isManagement } from "./mail-access-parts";
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
    expect(effectiveLevel(member(20), DEPTS, "personal")).toBe("company");
    expect(effectiveLevel(member(1), DEPTS, "department")).toBe("department");
  });

  it("a department mailbox ticks itself for its department from L2 up, never at L1", () => {
    const elvis = member(2, [2, 1]);
    expect(autoReason(box(1), elvis, "department")).toBe("department");
    expect(autoReason(box(1), elvis, "department_all")).toBe("department");
    expect(autoReason(box(1), elvis, "personal")).toBeNull();
    expect(autoReason(box(3), elvis, "department")).toBeNull();
    expect(autoReason(box(3), elvis, "company")).toBe("company");
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
