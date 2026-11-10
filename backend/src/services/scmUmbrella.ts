import type { AuthUser } from "./auth";
import { hasPermission } from "./permissions";

/** The first pass conditions of requireScmAccess (middleware/auth.ts), free of
 *  the request path, so a caller outside `/api/scm` (global search) asks the
 *  same question: wildcard, `scm.access`, or any SCM page-access area granted. */
export function hasScmUmbrella(user: AuthUser): boolean {
  const granted = user.permissions_set ?? user.permissions;
  if (hasPermission(granted, "*") || hasPermission(granted, "scm.access")) return true;
  const pa = user.page_access ?? {};
  return Object.entries(pa).some(([key, level]) => key.startsWith("scm") && level !== "none");
}
