// ----------------------------------------------------------------------------
// memberPageAccess — the ONE resolver for a member's page_access, fed from the
// persistent role_page_access rows (RBAC rebuild, Option A).
//
// WHY THIS EXISTS AS ONE FUNCTION. Three callers must agree exactly or the
// cutover is not a no-op: hydrateAuthUser (login), the seed script
// (scripts/seed-role-page-access.mjs, which writes the rows), and the
// differential test (which proves NEW == OLD). A second implementation of this
// branch is the one thing that must not exist — the same reasoning
// resolvePositionAccessFromRows carries. So the "rows, else fall back" rule
// lives here exactly once.
//
// THE RULE.
//   - `*` wildcard            -> fullAccessMap() (UNCHANGED — never narrowed).
//   - any non-`*` member      -> the role's role_page_access rows when the role
//                                HAS them (resolvePositionAccessFromRows does the
//                                parent/child cascade + isValidPageKey filter);
//                                when the role has NO rows, fall back to exactly
//                                the previous resolution — the position policy
//                                for a titled member, the permission backfill for
//                                a title-less one. The fallback makes an UNSEEDED
//                                table a byte-for-byte no-op, so the cutover does
//                                not depend on the seed running before the deploy.
//
// scm_l2_configured IS A NON-PAGE OUTPUT and stays with the position policy for a
// titled member — it is NOT re-derived from the seeded rows. If it were, the
// whole FULL cohort (whose seed is fullAccessMap, i.e. explicit scm* rows) would
// flip scm_l2_configured TRUE and scmAreaGuard would start enforcing per-area on
// them — the z1 mass lockout positionPolicy.ts warns about. A title-less member
// has no position policy, so its scm_l2 comes from whether the rows explicitly
// configure an scm* area (none when unseeded) — matching how an explicit scm row
// flips a titled member today.
//
// applySalesJdOverride is NOT applied here. hydrateAuthUser applies it to the
// returned map exactly as it did before (idempotent for the positioned sales
// cohort, load-bearing only for a title-less Sales-department member), so the
// end-to-end result is byte-identical.
// ----------------------------------------------------------------------------

import {
  fullAccessMap,
  pageAccessFromPermissions,
  resolvePositionAccessFromRows,
  type AccessLevel,
  type PageAccessMeta,
} from "./pageAccess";
import { resolvePositionPolicy } from "./positionPolicy";
import type { PositionPolicyRow } from "./positionPolicyRows";

export interface MemberPageAccessInput {
  /** The member's resolved permission set (after any position '*' injection). */
  permissionsSet: ReadonlySet<string>;
  /** users.position_id — null for a title-less member. */
  positionId: number | null;
  positionName: string | null;
  /** The member's OWN department name (users.department_id), the field the Sales
   *  cohort detection keys off — not the position's department. */
  departmentName: string | null;
  /** The Title's stored position_policy row, or null for the name-rule fallback. */
  positionPolicy: PositionPolicyRow | null;
  /** The role's role_page_access rows ({page_key, level}); empty when unseeded. */
  roleRows: ReadonlyArray<{ page_key: string; level: string }>;
}

export interface MemberPageAccessResult {
  /** Page access BEFORE applySalesJdOverride (hydrate applies that on top). */
  pageAccess: Record<string, AccessLevel>;
  /** AuthUser.scm_l2_configured — see the header note on why it is kept off the
   *  position policy for a titled member rather than re-derived from the rows. */
  scmL2Configured: boolean;
}

export function resolveMemberPageAccess(input: MemberPageAccessInput): MemberPageAccessResult {
  if (input.permissionsSet.has("*")) {
    // Owner / IT / god position — full, and never read the rows.
    return { pageAccess: fullAccessMap(), scmL2Configured: false };
  }

  const hasRows = input.roleRows.length > 0;

  if (input.positionId != null) {
    // Titled member: the position policy still owns the non-page outputs
    // (scmConfigured here; crew scope / sales filter / money-write are read from
    // the policy at their own gates). Its page-access output is used only as the
    // fallback when the role has no rows yet.
    const policy = resolvePositionPolicy(
      { position_name: input.positionName, department_name: input.departmentName },
      input.positionPolicy,
    );
    return {
      pageAccess: hasRows ? resolvePositionAccessFromRows(input.roleRows) : policy.pageAccess,
      scmL2Configured: policy.scmConfigured,
    };
  }

  // Title-less member: pages from the role's rows when present, else the
  // permission backfill (today's behavior). scm_l2 only when the rows explicitly
  // configure an scm* area.
  if (hasRows) {
    const meta: PageAccessMeta = { explicitScm: false };
    const pageAccess = resolvePositionAccessFromRows(input.roleRows, meta);
    return { pageAccess, scmL2Configured: meta.explicitScm };
  }
  return { pageAccess: pageAccessFromPermissions(input.permissionsSet), scmL2Configured: false };
}
