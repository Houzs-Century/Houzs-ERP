// Which department heading a mailbox sits under in the Mail Center sidebar (owner 2026-11-23:
// personal mailboxes go under their owner's Org Chart department, not "Other").
/** The fields the grouping reads; both address shapes (mail-actions and Inbox) have them. */
export type GroupedMailbox = {
  address: string;
  assignedDept?: string | null;
  assignedUserName?: string | null;
  departmentId?: number | null;
  ownerDepartmentId?: number | null;
  ownerDepartmentName?: string | null;
};

export const UNASSIGNED_DEPT = "Other";

const shortName = (name: string) => name.trim().replace(/\s+department$/i, "").trim();

/**
 * A department mailbox keeps its own label (operation@ -> "Operation"). A personal mailbox goes under its
 * owner's department: the label of that department's shared mailbox when there is one, else the
 * department's name without "Department". No department -> "Other".
 */
export function mailboxDept(a: GroupedMailbox, all: readonly GroupedMailbox[]): string {
  const own = (a.assignedDept ?? "").trim();
  if (own) return own;
  if (!a.ownerDepartmentId) return UNASSIGNED_DEPT;
  const shared = all.find((x) => x.departmentId === a.ownerDepartmentId && (x.assignedDept ?? "").trim());
  if (shared) return (shared.assignedDept ?? "").trim();
  return shortName(a.ownerDepartmentName ?? "") || UNASSIGNED_DEPT;
}

/** Inside a heading: the shared department mailbox first, then people by name. */
export function mailboxOrder(x: GroupedMailbox, y: GroupedMailbox): number {
  const sx = (x.assignedUserName ?? "").trim() ? 1 : 0;
  const sy = (y.assignedUserName ?? "").trim() ? 1 : 0;
  if (sx !== sy) return sx - sy;
  return (x.assignedUserName || x.address || "").localeCompare(y.assignedUserName || y.address || "");
}
