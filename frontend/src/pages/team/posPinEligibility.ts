
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

