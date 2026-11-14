// ----------------------------------------------------------------------------
// endpointAccess — "will the server let this person READ that endpoint?", for
// the side reads (pickers, badges, side panels) that used to fire for everyone
// and treat the 403 as "nothing to show".
//
// Production, 7 days: 2,632 "[rbac 403]" reports from those reads. Each one is
// a wasted request and a report; none of them showed the user anything. These
// helpers MIRROR the backend gates so the read is simply not made. They are not
// the boundary — the server still is — so a mirror that drifts costs a 403, not
// a leak.
// ----------------------------------------------------------------------------

import type { AccessLevel, AuthUser } from "../types";
import { useAuth } from "./AuthContext";
import { hasAnyScmPageAccess, isSalesDirectorUser } from "./salesAccess";

export interface EndpointAccessAuth {
  user: AuthUser | null;
  can: (perm: string) => boolean;
  pageAccess: (page: string) => AccessLevel;
}

/**
 * May a GET under `scmAreaGuard(area)` pass? Mirrors backend
 * scmAreaReadable (backend/src/scm/middleware/area-guard.ts): wildcard; the
 * /api/scm umbrella (scm.access or any scm.* page grant); then a caller with no
 * SCM L2 configuration falls through, and an L2-configured one needs view on
 * the area.
 */
export function scmAreaReadable(auth: EndpointAccessAuth, area: string): boolean {
  if (auth.user === null) return false;
  if (auth.can("*")) return true;
  if (!auth.can("scm.access") && !hasAnyScmPageAccess(auth.user)) return false;
  if (!auth.user.scm_l2_configured) return true;
  return auth.pageAccess(area) !== "none";
}

/** GET /api/users — requirePermissionOrSalesDirector("users.read") in routes/users.ts. */
export function canListUsers(auth: EndpointAccessAuth): boolean {
  return auth.user !== null && (auth.can("users.read") || isSalesDirectorUser(auth.user));
}

/* Outside an AuthProvider (a component rendered on its own) there is nobody to
   decide for, so the read is left to the server, exactly as before these gates. */
function useAuthForGate(): EndpointAccessAuth | null {
  let ctx: ReturnType<typeof useAuth> | null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- one context read, made on every render in the same order; the try only catches its "no provider" throw
    ctx = useAuth();
  } catch {
    ctx = null;
  }
  if (!ctx || typeof ctx.can !== "function" || typeof ctx.pageAccess !== "function") return null;
  return { user: ctx.user, can: ctx.can, pageAccess: ctx.pageAccess };
}

/** canListUsers for the signed-in user. */
export function useCanListUsers(): boolean {
  const auth = useAuthForGate();
  return auth === null || canListUsers(auth);
}

/** scmAreaReadable for the signed-in user. */
export function useScmAreaReadable(area: string): boolean {
  const auth = useAuthForGate();
  return auth === null || scmAreaReadable(auth, area);
}
