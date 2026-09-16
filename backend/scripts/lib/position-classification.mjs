// position-classification — which code cohort and which position-keyed flags a
// LIVE position name lands in, asked of the modules that ENFORCE them.
//
// WHY THIS EXISTS (docs/bugs/0894). audit-permission-grants.mjs held its own
// copies of the position-name lists in services/positionPolicy.ts and
// services/pmsAccess.ts, and they drifted: it printed Managing Director
// (a wildcard position since 2026-09-07), Warehouse Crew KL (restricted since
// 2026-09-01) and Calendar Viewer (restricted since 2026-08-26) as "FULL", so its cohort totals
// were wrong while its per-position counts were right. A diagnostic that
// restates a rule is the duplicated-list bug with a report attached; this
// module calls the rule instead, so it cannot drift from it.
//
// Imports TypeScript from src/, so callers run under tsx
// (`npx tsx scripts/audit-permission-grants.mjs`). No shebang: a test imports it.

import { positionGrantsWildcard, resolvePositionPolicy } from "../../src/services/positionPolicy.ts";
import { policyRowFromDb } from "../../src/services/positionPolicyRows.ts";
import {
  getPmsRole,
  isDirectorUser,
  isProductCostViewer,
  isSalesDirectorUser,
} from "../../src/services/pmsAccess.ts";

/** The caller shape the rules read, built the way auth hydration builds it: a
 *  god position carries the `*` wildcard, everyone else starts with none (role
 *  grants are counted separately by the audit). */
function callerFor(positionName, departmentName, god) {
  return {
    id: 0,
    position_name: positionName,
    department_name: departmentName,
    permissions: god ? ["*"] : [],
    permissions_set: new Set(god ? ["*"] : []),
  };
}

const COHORT_LABEL = {
  god: "god(*)",
  restricted: "restricted (L2 ENFORCED)",
  sales: "sales (L2 ENFORCED)",
  full: "FULL (L2 inert)",
  positionless: "positionless (role matrix)",
};

/**
 * @param {string | null | undefined} positionName
 * @param {string | null | undefined} departmentName
 * @returns {{ cohort: "god" | "restricted" | "sales" | "full" | "positionless", label: string, flags: string[], pmsRole: string }}
 */
export function classifyPosition(positionName, departmentName, policyRow = null) {
  const pos = (positionName ?? "").trim();
  if (!pos) return { cohort: "positionless", label: COHORT_LABEL.positionless, flags: [], pmsRole: "OTHER" };
  const dept = departmentName ?? null;
  // The Title's stored policy row (position_policy) decides first, as it does
  // at hydration; null keeps the name rule. Pass the raw DB row — the coercion
  // is the same one auth.ts applies.
  const row = policyRow ? policyRowFromDb({ position_id: policyRow.position_id ?? 0, ...policyRow }) : null;
  const god = positionGrantsWildcard(pos, row);
  const policy = resolvePositionPolicy({ position_name: pos, department_name: dept }, row);
  const cohort = god ? "god" : policy.cohort;
  const caller = callerFor(pos, dept, god);

  const flags = [];
  flags.push(row ? "policy:row" : "policy:name");
  if (god) flags.push("WILDCARD*");
  if (god || policy.flags.canMoveMoney) flags.push("money-write");
  if (god || policy.flags.canWriteConfig) flags.push("config-write");
  if (isDirectorUser(caller)) flags.push("pms-DIRECTOR");
  if (isSalesDirectorUser(caller)) flags.push("sales-director-admin");
  if (isProductCostViewer(caller)) flags.push("cost-viewer");

  const role = getPmsRole(caller, { pic_id: null });
  return { cohort, label: COHORT_LABEL[cohort], flags, pmsRole: role === "SALES" ? "PIC/SALES" : role };
}
