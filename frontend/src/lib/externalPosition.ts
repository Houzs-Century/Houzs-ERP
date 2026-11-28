/**
 * The note shown when an admin picks an outsourced Title (a 3PL driver /
 * transporter) in Team invite or on a member profile.
 *
 * Owner decision 2026-11-28 (PR #6146, #6148): an outsourced driver who uploads
 * POD gets a login created from Team. It stays out of the member directory, and
 * the sync_user_to_tms trigger gives the exact Title "Outsource Transporter" its
 * Fleet driver row. POD itself is gated on the position's scm.do.dispatch
 * capability (Roles & Permissions > Actions), not on the role.
 *
 * This is a UI hint, not an authz decision: it keys on the Title name and never
 * blocks.
 */
export const EXTERNAL_POSITION_MESSAGE =
  "Outsource Transporter login: stays out of the Team Member list (Show outsource reveals it) and appears in Fleet as a driver automatically, so do not add them in Fleet by hand (that makes a duplicate). Set a password and give the Driver role. Uploading POD on the phone also needs Dispatch ticked for this position in Roles & Permissions > Actions.";

export function isExternalPosition(
  position: { name?: string | null; slug?: string | null } | null | undefined,
): boolean {
  const name = (position?.name ?? "").toLowerCase();
  const slug = (position?.slug ?? "").toLowerCase();
  return /\boutsource/.test(name) || slug.includes("outsource");
}
