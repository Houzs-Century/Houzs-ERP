
/** Owner 2026-07-21. Matched on the EXACT position name, never a substring —
 *  position names are owner-editable free text, so `/storekeeper/i` would also
 *  claim "Assistant Storekeeper", "Warehouse Storekeeper" and anything else an
 *  admin types. Mirrors CREW_SCOPED_POSITIONS in backend projectGates.ts. */
export const CREW_SCOPED_POSITIONS: readonly string[] = [
  "helper",
  "storekeeper",
];

export type CrewScopeCarrier = {
  position_name?: string | null;
  permissions?: readonly string[] | null;
  capabilities?: Partial<Record<string, boolean>>;
};

/** Is this user force-scoped to the events they are crewed on?
 *
 *  The permission escape comes FIRST and matches the backend's `hasPermission`
 *  for an array grant exactly (`includes("*") || includes(required)`): an
 *  admin or anyone who can write projects is never caged, whatever position
 *  they happen to hold. */
export function isCrewScopedUser(user: CrewScopeCarrier | null | undefined): boolean {
  if (!user) return false;
  if (user.capabilities) return user.capabilities["org.crew.scoped"] === true;
  const granted = user.permissions ?? [];
  if (granted.includes("*") || granted.includes("projects.write")) return false;
  const pos = (user.position_name ?? "").trim().toLowerCase();
  // Owner 2026-08-28: the admin-created regional warehouse-crew positions
  // ("Warehouse Crew KL", …) carry the whole helper/storekeeper cohort now.
  // PREFIX match (name STARTS with "warehouse crew"), not a substring — an
  // office position merely mentioning warehouse cannot be caged. Mirrors
  // backend projectGates.ts.
  return CREW_SCOPED_POSITIONS.includes(pos) || pos.startsWith("warehouse crew");
}
