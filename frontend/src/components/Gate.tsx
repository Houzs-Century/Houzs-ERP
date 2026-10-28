import type { ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";

/**
 * Conditional render wrapper gated on permission(s). Renders `children`
 * only if the current user satisfies the supplied check; otherwise
 * renders `fallback` (defaults to nothing).
 *
 * Adoption is voluntary — the inline `{can("X") && <Foo />}` pattern
 * still works. Use `<Gate>` when the JSX gets noisy or when a fallback
 * placeholder makes more sense than nothing.
 *
 * @example
 *   <Gate perm="projects.write">
 *     <Button>Edit</Button>
 *   </Gate>
 *
 *   <Gate
 *     anyPerm={["projects.write", "projects.chat"]}
 *     fallback={<span className="text-ink-muted">Read-only</span>}
 *   >
 *     <ChatComposer />
 *   </Gate>
 */
export function Gate({
  perm,
  anyPerm,
  allPerm,
  fallback = null,
  children,
}: {
  /** Single permission required. */
  perm?: string;
  /** Any one of these permissions unlocks the gate. */
  anyPerm?: readonly string[];
  /** Every listed permission required. */
  allPerm?: readonly string[];
  /** Rendered when the gate is closed. Defaults to nothing. */
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const { can, canAny, canAll } = useAuth();
  if (perm && !can(perm)) return <>{fallback}</>;
  if (anyPerm && !canAny(anyPerm)) return <>{fallback}</>;
  if (allPerm && !canAll(allPerm)) return <>{fallback}</>;
  return <>{children}</>;
}
