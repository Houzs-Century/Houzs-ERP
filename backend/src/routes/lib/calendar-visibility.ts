import type { Context } from "hono";
import type { Env } from "../../types";
import { hasPermission } from "../../services/permissions";
import { isCrewScopedUser } from "../../services/projectGates";
import type { AuthUser } from "../../services/auth";

/**
 * Who sees which events on the Projects calendar — shared by the month feed
 * (GET /api/projects/calendar/events) and the all-dates search
 * (GET /api/projects/calendar/search) so the two can never disagree.
 *
 * Returns ONLY the crew-assignment arm. The company predicate is NOT in here on
 * purpose: each handler writes `activeCompanySql(c, "p.company_id")` itself, so
 * the company boundary stays visible in the statement that reads `projects`.
 *
 * Rules (owner decisions):
 *   - 2026-08-19: PIC/brand row ACL removed — every non-crew caller sees the
 *     whole company calendar.
 *   - 2026-07-21: helpers/storekeepers are crew-scoped (isCrewScopedUser).
 *   - 2026-07-23: drivers join the crew lane ON THE CALENDAR only, unless they
 *     hold projects.write (an admin holding the Driver position is not caged).
 *   - 2026-07-23: scoped staff see only events assigned to them, whatever the
 *     status. A crew member on a project's Sales Attending list (mig 087) still
 *     sees that event.
 *   - A scoped caller with no resolvable arm (no session id) fails closed.
 *
 * `scopeWhere` uses positional `?` placeholders; append `scopeBinds` after any
 * binds that precede it in the statement. `p` must alias `projects`.
 */
export function calendarCrewScope(c: Context<{ Bindings: Env }>): {
  scopeWhere: string;
  scopeBinds: unknown[];
} {
  // Typed as possibly absent on purpose: no session must fail closed, not open.
  const user = c.get("user") as AuthUser | undefined;
  if (!user) return { scopeWhere: " AND 1 = 0", scopeBinds: [] };
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tests and scripts build AuthUser without permissions_set
  const granted = user.permissions_set ?? user.permissions;
  const isScopedDriver =
    !hasPermission(granted, "*") &&
    !hasPermission(granted, "projects.write") &&
    ((user.position_name ?? "").trim().toLowerCase() === "driver" ||
      /^drivers?$/i.test(String(user.role_name).trim()));
  const crewScoped = isCrewScopedUser(user) || isScopedDriver;
  if (!crewScoped) return { scopeWhere: "", scopeBinds: [] };

  const assignArms: string[] = [];
  const scopeBinds: unknown[] = [];
  if (user.id) {
    // Crew arm — FK slots + per-lorry crew JSON exact-name containment (same
    // match listProjects' assigned_user arm uses).
    const idArms = [
      "p.setup_driver_user_id = ?", "p.dismantle_driver_user_id = ?",
      "p.setup_helper_1_id = ?", "p.setup_helper_2_id = ?",
      "p.dismantle_helper_1_id = ?", "p.dismantle_helper_2_id = ?",
    ];
    let arm = idArms.join(" OR ");
    for (const _ of idArms) scopeBinds.push(user.id);
    const nm = (user.name ?? "").trim().toLowerCase();
    if (nm) {
      arm += " OR lower(COALESCE(p.setup_crew,'')) LIKE ? OR lower(COALESCE(p.dismantle_crew,'')) LIKE ?";
      scopeBinds.push(`%"${nm}"%`, `%"${nm}"%`);
    }
    assignArms.push(`(${arm})`);
    // A crew member on a project's Sales Attending list still sees that event.
    assignArms.push(
      `EXISTS (SELECT 1 FROM project_sales_attendees psa` +
      ` JOIN sales_reps sr ON sr.id = psa.sales_rep_id` +
      ` WHERE psa.project_id = p.id AND sr.user_id = ?)`
    );
    scopeBinds.push(user.id);
  }
  const scopeWhere = assignArms.length ? ` AND (${assignArms.join(" OR ")})` : ` AND 1 = 0`;
  return { scopeWhere, scopeBinds };
}
