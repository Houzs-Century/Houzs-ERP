
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
  permissionsSet: ReadonlySet<string>;
  positionId: number | null;
  positionName: string | null;
  departmentName: string | null;
  positionPolicy: PositionPolicyRow | null;
  roleRows: ReadonlyArray<{ page_key: string; level: string }>;
}

export interface MemberPageAccessResult {
  pageAccess: Record<string, AccessLevel>;
  scmL2Configured: boolean;
}

export function resolveMemberPageAccess(input: MemberPageAccessInput): MemberPageAccessResult {
  if (input.permissionsSet.has("*")) {
    return { pageAccess: fullAccessMap(), scmL2Configured: false };
  }

  const hasRows = input.roleRows.length > 0;

  if (input.positionId != null) {
    const policy = resolvePositionPolicy(
      { position_name: input.positionName, department_name: input.departmentName },
      input.positionPolicy,
    );
    return {
      pageAccess: hasRows ? resolvePositionAccessFromRows(input.roleRows) : policy.pageAccess,
      scmL2Configured: policy.scmConfigured,
    };
  }

  if (hasRows) {
    const pageAccess = resolvePositionAccessFromRows(input.roleRows);
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
