// Org-chart reporting helpers, lifted out of Team.tsx so the cycle rule and the
// picker's option list can be tested directly — and so the page stops growing.
import type { TeamMember } from "../../types";

/**
 * Returns true if `candidateId` sits somewhere in `ancestorId`'s reporting
 * subtree — i.e. appointing them as ancestor's manager would create a loop.
 * Used only to hide bad options in the picker; the backend still validates.
 */
export function isDescendantOf(
  candidateId: number,
  ancestorId: number,
  users: TeamMember[],
): boolean {
  const byId = new Map(users.map((u) => [u.id, u]));
  const seen = new Set<number>();
  let cursor: number | null = candidateId;
  while (cursor != null && !seen.has(cursor)) {
    seen.add(cursor);
    const node: TeamMember | undefined = byId.get(cursor);
    if (!node) return false;
    if (node.manager_id === ancestorId) return true;
    cursor = node.manager_id;
  }
  return false;
}

/* The org-chart card's pickers, sized to the card (32px / 11px) rather than to
   a form row. SearchableSelect applies this to its input. */
export const ORG_PICKER_CLS =
  "h-8 w-full rounded-md border border-border bg-surface px-2 text-[11px] text-ink outline-none focus:border-primary";

/* "Reports to" options: everyone the member could report to WITHOUT creating a
   cycle, A→Z, each carrying their department so two Wei Hows are tellable
   apart. Nico 2026-08-17: "这种选项需要可以搜索功能，排序A到Z".

   The empty row is an OPTION, not a placeholder, so an existing manager can be
   cleared. And a manager who is not in `users` still gets a row: the chart
   scopes the people list to ONE company's tree, so a member whose manager sits
   in the other company has a manager_id with nothing to resolve — printing the
   bare id there ("44") reads as a name and means nothing. */
export function managerOptions(
  user: TeamMember,
  users: TeamMember[],
): Array<{ value: string; label: string }> {
  const rows = users
    .filter((m) => m.id !== user.id && !isDescendantOf(m.id, user.id, users))
    .map((m) => ({
      value: String(m.id),
      label: m.department_name
        ? `${m.name || m.email} · ${m.department_name}`
        : m.name || m.email,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  const missing =
    user.manager_id != null && !users.some((m) => m.id === user.manager_id)
      ? [{ value: String(user.manager_id), label: "(not in this list)" }]
      : [];
  return [{ value: "", label: "— No manager —" }, ...missing, ...rows];
}
