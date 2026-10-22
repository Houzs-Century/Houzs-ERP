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
  isValidPageKey,
  isValidAccessLevel,
  type AccessLevel,
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
  // permission backfill (today's behavior).
  if (hasRows) {
    const pageAccess = resolvePositionAccessFromRows(input.roleRows);
    // scm_l2 must NOT come from resolvePositionAccessFromRows's `meta` on THIS
    // path. That flag turns TRUE for ANY scm* row with a valid level — including
    // the `scm.*=none` rows the no-op seed writes for every page — which would
    // flip a title-less member from the pre-seed `false` (pageAccessFromPermissions
    // never set it) to `true`, making scmAreaGuard start enforcing per-area and
    // 403 a member whose pageAccess map did not change. The honest signal here is
    // "the role actually GRANTS an scm sub-area", i.e. an scm* row whose level is
    // not `none`. (The positioned restricted cohort deliberately KEEPS the meta
    // rule — there an explicit `scm.*=none` is a hand-authored DENY that must be
    // enforced — so the fix is confined to this branch and the shared rule in
    // resolvePositionAccessFromRows is untouched.)
    const scmL2Configured = input.roleRows.some(
      (r) => r.page_key.startsWith("scm")
        && r.level !== "none"
        && isValidPageKey(r.page_key)
        && isValidAccessLevel(r.level),
    );
    return { pageAccess, scmL2Configured };
  }
  return { pageAccess: pageAccessFromPermissions(input.permissionsSet), scmL2Configured: false };
}
