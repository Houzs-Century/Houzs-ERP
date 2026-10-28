// ─────────────────────────────────────────────────────────────────────────
// pos-staff-role.ts — derive the 2990-POS role vocabulary from the member's
// Houzs POSITION, so POS permissions follow User Management directly.
//
// WHY (owner ruling 2026-07-24, closing HANDOFF item #104): the 2990 POS
// front-end gates everything on the `role` field of its own GET /api/scm/staff
// row (canViewAllSales / isGlobalCurator / isPasscodeLoginRole in the POS
// repo's lib/staff.ts). But scm.staff.role is stamped 'sales' on EVERY member
// by the sync_user_to_staff trigger (migration 0066) — so the 4 Sales-Director
// -position members, Sales Managers, and even the owner's own account were all
// demoted to plain-salesperson POS behaviour after the cutover.
//
// The server already treats the stored column as non-authoritative — the PIN
// login gate and /pos/sales-staff both key on the position slug, not the role
// (routes/pos.ts). This module extends the same stance to the /staff READ
// surface: the role the POS sees is DERIVED from the position at read time.
// Nothing is written back to scm.staff.role, so every DB-level consumer of the
// stored column (none gate on it today) and the trigger are untouched, and a
// position change in User Management takes effect on the POS immediately.
//
// THE MAPPING (owner 2026-07-24, in-chat):
//   Super Admin      → super_admin      (full POS: view-all, curator)
//   Sales Director   → sales_director   (view-all + curator — exact 2990 parity)
//   Sales Manager    → outlet_manager   ("管理级" — view-all + passcode login,
//                                        the 2990 store-manager tier)
//   Sales Executive  → sales_executive  (own orders, passcode login)
//   Sales Person     → sales            (own orders, passcode login)
//   Sales Trainee    → sales            (sales-side; PIN issuance stays the
//                                        real gate — no PIN, no tablet login)
//   anything else / no position → the STORED scm.staff.role, unchanged. The
//   owner's ruling for non-sales positions (Finance / HR / Ops / Purchasing…)
//   is "他们根本不用 POS" — they get no derived POS tier, and since they hold
//   no POS PIN and the POS pickers filter on sales positions, the stored value
//   is inert for them.
//
// Keyed on positions.SLUG (stable, seed-owned: seed-user-management.mjs), not
// the display name — renaming a position in the UI must not silently strip a
// tier. Slugs and the POS role strings are both lowercase snake_case already.
// ─────────────────────────────────────────────────────────────────────────

/** positions.slug → 2990 POS role string (the scm.staff_role vocabulary). */
export const POSITION_SLUG_TO_POS_ROLE: Readonly<Record<string, string>> = {
  super_admin: 'super_admin',
  sales_director: 'sales_director',
  sales_manager: 'outlet_manager',
  sales_executive: 'sales_executive',
  sales_person: 'sales',
  sales_trainee: 'sales',
};

/**
 * The role the POS should see for a staff row: the position-derived tier when
 * the member's position is one of the mapped (sales-side + super-admin) slugs,
 * otherwise the stored scm.staff.role as-is (covers unlinked 2990 mirror rows,
 * the system row, and every non-sales position per the owner's ruling).
 */
export function derivePosRole(
  positionSlug: string | null | undefined,
  storedRole: unknown,
): unknown {
  if (positionSlug) {
    const mapped = POSITION_SLUG_TO_POS_ROLE[positionSlug];
    if (mapped) return mapped;
  }
  return storedRole;
}
