import { hasPermission, hasPermissionLiterally } from "./permissions";

/**
 * Who may open the IT pages (System Health, AI usage): holders of `it.view`.
 *
 * DEV-35 testing switch: while it is false the `*` wildcard does NOT pass, so
 * Owner and Super Admin (system roles, uneditable, always `*`) do not see the
 * pages while the IT Admin role tries them. Set it true at launch and the gate
 * behaves like every other permission gate.
 */
// ponytail: temporary launch switch; delete it and call hasPermission directly once the IT pages open to Owner.
export const IT_PAGES_WILDCARD_PASSES: boolean = false;

export function canViewItPages(granted: ReadonlyArray<string> | ReadonlySet<string>): boolean {
  return IT_PAGES_WILDCARD_PASSES
    ? hasPermission(granted, "it.view")
    : hasPermissionLiterally(granted, "it.view");
}
