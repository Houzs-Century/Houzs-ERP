import type { AuthUser } from "./auth";
import { hasPermission } from "./permissions";

/** The first pass conditions of requireScmAccess (middleware/auth.ts), free of
 *  the request path, so a caller outside `/api/scm` (global search) asks the
 *  same question: wildcard, `scm.access`, or any SCM page-access area granted. */
export function hasScmUmbrella(user: AuthUser): boolean {
  // Kept exactly as requireScmAccess read it before this was lifted out: a user
  // object built by hand (tests, the service user) may carry only `permissions`.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see above
  const granted = user.permissions_set ?? user.permissions;
  if (hasPermission(granted, "*") || hasPermission(granted, "scm.access")) return true;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- same reason
  const pa = user.page_access ?? {};
  return Object.entries(pa).some(([key, level]) => key.startsWith("scm") && level !== "none");
}
