import type { AuthUser } from "./auth";
import { getPmsRole, isSalesUser, isDirectorUser } from "./pmsAccess";

/* Owner 2026-07-05 — a DIRECTOR-level user (Owner/IT `*`, Super Admin, Sales
   Director, Finance Manager — pmsAccess getPmsRole) sees EVERY project's full
   details, not just their assigned line. Mirrors the /calendar/events see-all
   rule so the calendar and the project detail stay consistent. The DIRECTOR
   branch of getPmsRole is project-independent, so a throwaway shape is fine. */
function isProjectDirector(user: AuthUser | null | undefined): boolean {
  return !!user && getPmsRole(user, { pic_id: null }) === "DIRECTOR";
}

/**
 * SINGLE source of truth for "is this user row-scoped on projects" — the
 * predicate every project read-ACL below keys off (getProjectScope /
 * projectAccessLevel / canSeeProject), so the list, detail, calendar and
 * notifications all agree.
 *
 * Two ways to be scoped:
 *   1. The role carries the `scope_to_pic` flag (the original mechanism).
 *   2. Owner 2026-07-15 — the caller is a NON-director Sales user by STABLE ORG
 *      FIELDS (pmsAccess.isSalesUser && !isDirectorUser). Some Sales positions
 *      (e.g. "Test Sales Executive") have roles WITHOUT the scope_to_pic flag,
 *      so getProjectScope returned null and the list query applied no ACL —
 *      fail-OPENING a non-PIC, non-director rep to EVERY project. Keying the
 *      scope off the code-driven Sales classification (the owner's model, not
 *      the configurable matrix) closes that hole while leaving directors
 *      (see-all) and non-Sales staff untouched.
 */
export function isScopedProjectUser(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  if (user.scope_to_pic) return true;
  return isSalesUser(user) && !isDirectorUser(user);
}

export interface ProjectScope {
  /** PIC allow-list as today: [user.id, user.manager_id] (nulls dropped). */
  pic_ids: number[];
  /**
   * Brand allow-list from the user's department (department_brands).
   * Empty array means the scoped user belongs to a department with no
   * brands assigned (or no department at all) — they should see no
   * projects.
   */
  brands: string[];
}

/**
 * Combined scope for the current user, or null when the role isn't
 * scope_to_pic (admins / ops / finance run unfiltered queries).
 *
 * One-hop PIC rule: scoped user sees projects where pic_id is them or
 * their manager. Brand rule (added 048): the project's brand must be
 * in the user's department's brand allow-list.
 */
export function getProjectScope(user: AuthUser): ProjectScope | null {
  if (!isScopedProjectUser(user)) return null;
  const pic_ids: number[] = [];
  if (user.id) pic_ids.push(user.id);
  if (user.manager_id) pic_ids.push(user.manager_id);
  const brands = user.brand_scope ?? [];
  return { pic_ids, brands };
}

/** Effective PIC id — falls back to the creator when pic_id is unset.
 *  Keeps legacy projects (created before migration 039) visible to
 *  their creator's team, without requiring a full backfill. */
function effectivePicId(project: { pic_id: number | null; created_by?: number | null }): number | null {
  if (project.pic_id != null) return project.pic_id;
  return project.created_by ?? null;
}

/** PIC visibility expiry: a scoped PIC keeps a project until this many days
 *  AFTER it ends (was 4 — owner: "完了的四天之后"). Widened to 30 on 2026-07-31
 *  ("karjiun cannot see project, fix it"): the post-event work added this week
 *  — Defect List Dismantle uploads + the purchaser/BD defect actioning loop —
 *  runs well past 4 days, and the PIC must stay on the event while it does.
 *  Matches the 30-day teardown window the purchaser pending lane uses.
 *  Unscoped roles (admins/finance/ops) are unaffected. */
export const PIC_GRACE_DAYS = 30;

/** SQL predicate (D1/PG via the shim) for "still visible to a scoped PIC":
 *  no end date, or it ended within the last PIC_GRACE_DAYS. Used in the list
 *  query for scoped users. */
export const scopeNotExpiredSql = `(p.end_date IS NULL OR substr(p.end_date,1,10) >= date('now','-${PIC_GRACE_DAYS} days'))`;

/** Is a project still within a scoped PIC's visibility window? True when there
 *  is no end date or it ended ≤ PIC_GRACE_DAYS ago (or is upcoming). */
export function withinPicGrace(project: { end_date?: string | null }): boolean {
  if (!project.end_date) return true;
  const end = new Date(project.end_date);
  if (isNaN(end.getTime())) return true;
  const cutoff = Date.now() - PIC_GRACE_DAYS * 86_400_000;
  return end.getTime() >= cutoff;
}

/**
 * Per-project access tier for rendering decisions. "full" = PIC or
 * unscoped role — can see finances, logistics, POs. "limited" =
 * scoped user viewing a project where they aren't the PIC.
 */
export function projectAccessLevel(
  user: AuthUser,
  project: { pic_id: number | null; created_by?: number | null }
): "full" | "limited" {
  if (!isScopedProjectUser(user) || isProjectDirector(user)) return "full";
  if (effectivePicId(project) === user.id) return "full";
  return "limited";
}

/**
 * Hard gate: can this user see this project at all? Returns false for
 * scoped users viewing a project outside their PIC line OR outside
 * their department's brand list.
 */
export function canSeeProject(
  user: AuthUser,
  project: {
    pic_id: number | null;
    created_by?: number | null;
    brand?: string | null;
    end_date?: string | null;
  }
): boolean {
  if (!isScopedProjectUser(user) || isProjectDirector(user)) return true;
  // PIC visibility expires PIC_GRACE_DAYS after the project ends.
  if (!withinPicGrace(project)) return false;
  const pic = effectivePicId(project);
  if (pic == null) return false;
  const inPicLine = pic === user.id || (user.manager_id != null && pic === user.manager_id);
  if (!inPicLine) return false;
  // Brand gate. A scoped user with an empty brand list sees nothing
  // (forces admins to configure dept brands explicitly). Projects with
  // no brand are likewise invisible to scoped users — set the brand to
  // make them appear.
  const brands = user.brand_scope ?? [];
  if (brands.length === 0) return false;
  if (!project.brand) return false;
  return brands.includes(project.brand);
}
