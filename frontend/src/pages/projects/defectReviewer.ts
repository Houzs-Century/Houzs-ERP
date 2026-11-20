/* Defect review loop — the ONE source for who may act on a defect photo and
 * what each timeline status is called on screen. The desktop (Projects.tsx),
 * mobile (MobilePMS / MobilePmsDefectActions) and the cross-project Defect List
 * all import from here, so the region split, the reviewer/purchaser gates and
 * the button/badge labels never drift between surfaces (CLAUDE.md: a shared PMS
 * vocabulary has one home).
 *
 * The STORED timeline status values stay `done` / `replace`; only the on-screen
 * LABEL of `replace` changed to "Exchange" (owner 2026-11-20) — no data
 * migration, the backend state machine is untouched.
 */

/** Region states reviewed by the Ops Exec (Nancy); everything else by the
 *  Storekeeper Supervisor (Shukor). Lower-cased for comparison. Mirrors the
 *  backend DEFECT_REVIEW_REGION_STATES. */
export const DEFECT_REGION_STATES = [
  "pulau pinang",
  "kelantan",
  "terengganu",
  "perak",
] as const;

export interface DefectReviewUser {
  permissions?: string[] | null;
  position_name?: string | null;
  role_name?: string | null;
  capabilities?: Record<string, unknown> | null;
}

export function isDefectRegionState(state: string | null | undefined): boolean {
  return (DEFECT_REGION_STATES as readonly string[]).includes(
    (state ?? "").trim().toLowerCase(),
  );
}

/** The fresh-defect triager for THIS project's state: Ops Exec (Nancy) for the
 *  region states, Storekeeper Supervisor (Shukor) for the rest; a wildcard /
 *  projects.manage admin always. Done = cleaned, Exchange = escalate. */
export function canReviewDefect(
  user: DefectReviewUser | null | undefined,
  state: string | null | undefined,
): boolean {
  if (!user) return false;
  const perms = user.permissions ?? [];
  if (perms.includes("*") || perms.includes("projects.manage")) return true;
  const inRegion = isDefectRegionState(state);
  const isShukor = user.capabilities
    ? user.capabilities["org.defect.reviewer"] === true
    : /^storekeeper supervisor$/i.test((user.position_name ?? "").trim());
  const isNancy = /^ops exec$/i.test((user.role_name ?? "").trim());
  return (isShukor && !inRegion) || (isNancy && inRegion);
}

/** Closes an escalated (Exchange) defect with Done: purchaser / BD, or an
 *  admin. */
export function canPurchaseDefect(user: DefectReviewUser | null | undefined): boolean {
  return (
    !!user &&
    ((user.permissions?.includes("*") ?? false) ||
      (user.permissions?.includes("projects.manage") ?? false) ||
      /purchaser|bd/i.test(user.role_name ?? ""))
  );
}

/** On-screen label for a timeline status. Stored `replace` reads as "Exchange"
 *  (owner 2026-11-20); a fresh / legacy entry reads "Ongoing". */
export function defectActionLabel(status: string | null | undefined): string {
  if (status === "done") return "Done";
  if (status === "replace") return "Exchange";
  return "Ongoing";
}
