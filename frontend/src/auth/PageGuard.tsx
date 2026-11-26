import type { ReactNode } from "react";
import { useAuth } from "./AuthContext";
import { Forbidden } from "../pages/Forbidden";
import { ACCESS_RANK, type AccessLevel } from "../types";
import { capability } from "./capabilities";

/**
 * Read the current user's access level for a page (mig 073).
 * Thin wrapper over `useAuth().pageAccess(page)` for ergonomic use
 * inside page components. The `*` wildcard short-circuits to "full"
 * so admins always pass.
 *
 * Usage:
 *   const level = usePageAccess("sales");
 *   if (level === "partial") // show own-only view
 */
export function usePageAccess(page: string): AccessLevel {
  return useAuth().pageAccess(page);
}

/**
 * Route guard for per-page access. Replaces the legacy
 * `<Guard perm="<resource>.read">` for migrated pages.
 *
 * `minLevel` defaults to "partial" — i.e. the user needs at least
 * partial access to enter. Pass `"full"` for admin-only routes where
 * the partial view doesn't make sense.
 *
 * On denial, renders the <Forbidden> page **inline** (URL is
 * preserved). This is better UX than silently bouncing to home — the
 * user sees what they tried, why it failed, and how to fix it. They
 * can refresh later (e.g. after an admin updates their role) without
 * navigating back.
 */
export function PageGuard({
  page,
  minLevel = "partial",
  allowSales = false,
  allowSalesDirector = false,
  children,
}: {
  page: string;
  minLevel?: AccessLevel;
  allowSales?: boolean;
  allowSalesDirector?: boolean;
  children: ReactNode;
}) {
  const { user } = useAuth();
  const level = usePageAccess(page);
  if (ACCESS_RANK[level] < ACCESS_RANK[minLevel]) {
    if (allowSales && capability(user, "org.sales.staff")) return <>{children}</>;
    if (allowSalesDirector && capability(user, "org.salesDirector")) return <>{children}</>;
    return <Forbidden page={page} />;
  }
  return <>{children}</>;
}
