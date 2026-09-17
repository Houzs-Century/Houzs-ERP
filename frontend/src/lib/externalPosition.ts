/* A Title that names an OUTSOURCED role — an external 3PL driver / transporter,
 * not a staff member. Such crew belong in the Fleet module (an scm.drivers row
 * under a 3PL company), NOT in the member directory: creating one as a member
 * also spawns a duplicate Fleet driver row, because a Driver-position member is
 * auto-synced into scm.drivers (mig 0060 trigger). Owner rule 2026-09-17:
 * 「不想 Outsource 的混进我自己的 member 里面」.
 *
 * This is a member-creation UI HINT, not an authz decision. It only nudges the
 * admin toward the right place, so keying it on the Title name is safe — a miss
 * just means the nudge does not show. It never blocks. */

export const EXTERNAL_POSITION_MESSAGE =
  "Outsourced transport belongs in Fleet, not Members. Add this driver in the Fleet module under a 3PL company — creating them here also duplicates them in the fleet.";

export function isExternalPosition(
  position: { name?: string | null; slug?: string | null } | null | undefined,
): boolean {
  const name = (position?.name ?? "").toLowerCase();
  const slug = (position?.slug ?? "").toLowerCase();
  return /\boutsource/.test(name) || slug.includes("outsource");
}
