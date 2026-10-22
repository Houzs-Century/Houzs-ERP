import type { TeamMember } from "../../types";

export type StatusPill = "all" | "active" | "invited" | "disabled";

/* The directory's status pills decide which members the roster shows. The "all"
   pill means "everyone on the team" and deliberately EXCLUDES removed (disabled)
   members — owner 2026-10-22: a removed member belongs in their own list, not
   mixed into the active roster. Removed members stay reachable (and restorable)
   through the Disabled pill and the "Disabled" attention node; pass
   onDisabledView=true for both so the exclusion does not hide the very list that
   is meant to show them. */
export function rosterRows(
  scoped: TeamMember[],
  statusPill: StatusPill,
  onDisabledView: boolean,
): TeamMember[] {
  if (statusPill !== "all") return scoped.filter((u) => u.status === statusPill);
  if (onDisabledView) return scoped;
  return scoped.filter((u) => u.status !== "disabled");
}
