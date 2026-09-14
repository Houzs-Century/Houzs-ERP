/**
 * Holding a permission LITERALLY — the `*` wildcard does NOT satisfy this.
 *
 * `can()` on the auth context is the ACCESS question, and the wildcard is its
 * whole point: Owner and Super Admin can do anything. This answers the other
 * question, the one the server asks with `hasPermissionLiterally`
 * (backend/src/services/permissions.ts): whose desk a rule sits on. The first
 * caller is the payment screens' reason rule (owner 2026-09-14,
 * docs/bugs/0888): a ROLE that carries `scm.so_payment.amend` in its own list
 * gives a reason for every payment action it makes and is listed on
 * Accounting › Corrections; the Owner's wildcard alone is not a holder. The
 * server reads the key the same way (`holdsHouzsPermLiterally`), so a screen
 * that reads it through this asks exactly when the route would refuse.
 *
 * `user.permissions` is the role's own list plus the wildcard a god position
 * injects at hydration — so a Super Admin on a custom role that names the key
 * holds it literally AND keeps the wildcard, which is how the owner puts
 * himself under the rule without giving anything up.
 */
export type PermissionHolder = { permissions?: readonly string[] | null } | null | undefined;

export function holdsPermissionLiterally(user: PermissionHolder, perm: string): boolean {
  return (user?.permissions ?? []).includes(perm);
}
