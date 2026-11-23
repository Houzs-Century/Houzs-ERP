import { describe, expect, it } from "vitest";
import type { MailAddress } from "./mail-actions";
import { UNASSIGNED_DEPT, mailboxDept, mailboxOrder } from "./mail-groups";

const box = (p: Partial<MailAddress>): MailAddress => ({ id: p.address ?? "x", address: "x@h.com", label: "", active: true, ...p });
const operation = box({ address: "operation@h.com", assignedDept: "Operation", departmentId: 3 });
const akter = box({ address: "akter@h.com", assignedUserId: 9, assignedUserName: "Akter", ownerDepartmentId: 3, ownerDepartmentName: "Operation Department" });
const laphii = box({ address: "laphii@h.com", assignedUserId: 4, assignedUserName: "Laphii", ownerDepartmentId: 7, ownerDepartmentName: "IT Department" });
const carres = box({ address: "carres.operation@h.com", assignedUserId: 5, assignedUserName: "Carres Operation", ownerDepartmentId: null });
const all = [operation, akter, laphii, carres];

describe("Mail Center sidebar groups", () => {
  it("a person's mailbox goes under their department, the same heading as its shared mailbox", () => {
    expect(mailboxDept(operation, all)).toBe("Operation");
    expect(mailboxDept(akter, all)).toBe("Operation");
  });
  it("a department with no shared mailbox shows its name without 'Department'", () => {
    expect(mailboxDept(laphii, all)).toBe("IT");
  });
  it("no department stays under Other", () => {
    expect(mailboxDept(carres, all)).toBe(UNASSIGNED_DEPT);
  });
  it("the shared mailbox comes first, then people by name", () => {
    expect([akter, operation].sort(mailboxOrder).map((a) => a.address)).toEqual(["operation@h.com", "akter@h.com"]);
  });
});
