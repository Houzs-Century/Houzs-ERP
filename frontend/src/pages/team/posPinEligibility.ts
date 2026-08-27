/* Who may hold a 2990 POS PIN — the ONE copy of the rule, shared by the member
 * profile and the invite modal so the two screens cannot drift apart.
 *
 * A PIN is a tablet login credential, and the tablet's own picker
 * (`GET /api/pos/sales-staff`) lists a member only when FOUR things hold:
 * the member is in that company, their position slug starts with "sales",
 * their scm.staff row is active, and it is linked to a Houzs user. The first
 * two are decided by what the admin is editing on screen — that is what this
 * file answers. The last two come from the server
 * (`GET /api/pos/admin-pin-status/:userId`), because the screen cannot see them.
 *
 * The company is matched on CODE, never on a hard-coded id: `2990` is the
 * companies-master code seeded by mig 0083, and ids differ between prod and a
 * fresh test database. */

/** Company code of 2990's Home in `public.companies` (mig 0083). */
export const POS_COMPANY_CODE = "2990";

/** Mirrors the backend's `isPosPinPosition` (backend/src/services/posPin.ts)
 *  and the slug gate in `/pin-login`. A non-sales title cannot PIN-login, so a
 *  PIN issued to one is a credential that can never be used. */
export function isPosPinPosition(slug: string | null | undefined): boolean {
  return !!slug && slug.startsWith("sales");
}

/** Is this member in the company whose POS uses PIN login? */
export function inPosCompany(
  companyIds: readonly number[],
  companies: readonly { id: number; code: string }[],
): boolean {
  return companies.some(
    (c) => c.code === POS_COMPANY_CODE && companyIds.includes(c.id),
  );
}

/** Should the POS Access card be offered for the assignment currently on
 *  screen? Both halves are REQUIRED arguments rather than optional: an
 *  omitted one would silently mean "not eligible" and the card would just
 *  never appear, which is the bug this whole change exists to fix. */
export function showsPosPinCard(args: {
  companyIds: readonly number[];
  companies: readonly { id: number; code: string }[];
  positionSlug: string | null;
}): boolean {
  return inPosCompany(args.companyIds, args.companies) && isPosPinPosition(args.positionSlug);
}

