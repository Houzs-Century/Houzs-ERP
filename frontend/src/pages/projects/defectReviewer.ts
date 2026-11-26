/* Defect review loop — the ONE source for who may act on a defect photo, which
 * buttons each actor sees, and what each timeline status is called on screen.
 * The desktop (Projects.tsx), mobile (MobilePMS / MobilePmsDefectActions) and
 * the cross-project Defect List all import from here, so the region split, the
 * reviewer/purchaser gates, the stage machine and the labels never drift between
 * surfaces (CLAUDE.md: a shared PMS vocabulary has one home).
 *
 * FIVE-STATE timeline (owner 2026-11-20): the reviewer (Shukor/Nancy) triages a
 * fresh defect with done_clean (cleaned — resolved), exchange or service (both
 * escalate to the purchaser). The purchaser (Farra) then works the escalation:
 * in_progress, then done (resolved). The stored status strings are these values;
 * legacy rows ('replace' = escalated, 'done' = resolved, 'ongoing' = fresh) read
 * correctly through defectStage. No data migration — the column is free text.
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

/** Owner 2026-11-26: the all-state defect finaliser (Farra, Service Exec) reviews
 *  fresh defects in EVERY state, on top of the region split. Keyed on her ACCOUNT
 *  ID because her role "Purchaser" and position "Operation Executive" are both
 *  shared (an id, not her email, so no staff PII ships in the bundle). MIRRORS the
 *  backend ALL_STATE_DEFECT_REVIEWER_IDS in backend/src/services/projectGates.ts —
 *  keep the two in sync. */
export const ALL_STATE_DEFECT_REVIEWER_IDS = [83] as const;

export interface DefectReviewUser {
  id?: number | null;
  permissions?: string[] | null;
  position_name?: string | null;
  role_name?: string | null;
  capabilities?: Record<string, unknown> | null;
}

/** True when this user finalises the whole defect list — reviews every state,
 *  not just one side of the region split. Mirrors the backend predicate. */
export function isAllStateDefectReviewer(user: DefectReviewUser | null | undefined): boolean {
  return user?.id != null && (ALL_STATE_DEFECT_REVIEWER_IDS as readonly number[]).includes(user.id);
}

export function isDefectRegionState(state: string | null | undefined): boolean {
  return (DEFECT_REGION_STATES as readonly string[]).includes(
    (state ?? "").trim().toLowerCase(),
  );
}

/** The fresh-defect triager for THIS project's state: Ops Exec (Nancy) for the
 *  region states, Storekeeper Supervisor (Shukor) for the rest; a wildcard /
 *  projects.manage admin always. Triages with Done Clean / Exchange / Service. */
export function canReviewDefect(
  user: DefectReviewUser | null | undefined,
  state: string | null | undefined,
): boolean {
  if (!user) return false;
  const perms = user.permissions ?? [];
  if (perms.includes("*") || perms.includes("projects.manage")) return true;
  if (isAllStateDefectReviewer(user)) return true;
  const inRegion = isDefectRegionState(state);
  const isShukor = user.capabilities
    ? user.capabilities["org.defect.reviewer"] === true
    : /^storekeeper supervisor$/i.test((user.position_name ?? "").trim());
  const isNancy = /^ops exec$/i.test((user.role_name ?? "").trim());
  return (isShukor && !inRegion) || (isNancy && inRegion);
}

/** Works an escalated (Exchange / Service) defect: the purchaser (Farra) / BD,
 *  or an admin. Marks In Progress, then Done. */
export function canPurchaseDefect(user: DefectReviewUser | null | undefined): boolean {
  return (
    !!user &&
    ((user.permissions?.includes("*") ?? false) ||
      (user.permissions?.includes("projects.manage") ?? false) ||
      /purchaser|bd/i.test(user.role_name ?? ""))
  );
}


export type DefectStage = "fresh" | "purchaser" | "resolved";

const RESOLVED_STATUSES = new Set(["done", "done_clean"]);
const PURCHASER_STATUSES = new Set(["exchange", "service", "in_progress", "replace"]);

/** Which lane a defect photo is in, from its LATEST timeline status. Anything
 *  not resolved and not escalated (no action yet, or legacy 'ongoing') is a fresh
 *  upload awaiting the reviewer. */
export function defectStage(latest: string | null | undefined): DefectStage {
  const s = (latest ?? "").toLowerCase();
  if (RESOLVED_STATUSES.has(s)) return "resolved";
  if (PURCHASER_STATUSES.has(s)) return "purchaser";
  return "fresh";
}

export function defectIsResolved(latest: string | null | undefined): boolean {
  return defectStage(latest) === "resolved";
}


export type DefectActionTone = "done" | "escalate" | "progress";
export interface DefectAction {
  status: string;
  label: string;
  tone: DefectActionTone;
}

/** A FRESH defect's buttons (reviewer: Shukor / Nancy). Every click opens a
 *  remark box before it saves (owner 2026-11-20). */
export const REVIEWER_DEFECT_ACTIONS: readonly DefectAction[] = [
  { status: "done_clean", label: "Done Clean", tone: "done" },
  { status: "exchange", label: "Exchange", tone: "escalate" },
  { status: "service", label: "Service", tone: "escalate" },
];

/** An escalated defect's buttons (purchaser: Farra). Each opens a remark box. */
export const PURCHASER_DEFECT_ACTIONS: readonly DefectAction[] = [
  { status: "in_progress", label: "In Progress", tone: "progress" },
  { status: "done", label: "Done", tone: "done" },
];

/** On-screen label for a timeline status. Legacy 'replace' reads as "Exchange";
 *  anything unknown (fresh / legacy 'ongoing') reads "Ongoing". */
export function defectActionLabel(status: string | null | undefined): string {
  switch ((status ?? "").toLowerCase()) {
    case "done":
      return "Done";
    case "done_clean":
      return "Done Clean";
    case "exchange":
      return "Exchange";
    case "service":
      return "Service";
    case "in_progress":
      return "In Progress";
    case "replace":
      return "Exchange";
    default:
      return "Ongoing";
  }
}
