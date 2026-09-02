// ----------------------------------------------------------------------------
// isCrewScopedUser — the FRONTEND half of "may this user see only the events
// they are crewed on?"
//
// WHY THIS FILE EXISTS AT ALL. The rule genuinely needs two homes: the projects
// filter bar has to render before any round-trip, so the client cannot wait to
// be told. That is not the problem. The problem was that the second home had
// already DRIFTED, in two ways at once, and nothing compared them:
//
//   · SUBSTRING vs EXACT NAME. Projects.tsx tested `/\bhelper\b/i` and
//     `/storekeeper/i` against the position name. backend/src/services/
//     projectGates.ts matches the EXACT lowercased name against a three-entry
//     set, and its own comment forbids substrings because position names are
//     owner-editable free text. So an owner-created position like "Warehouse
//     Helper" caged the UI — slimmed filter bar, "You see your own events" —
//     while the server happily returned every event.
//   · THE MISSING PERMISSION ESCAPE. projectGates.ts returns false for anyone
//     holding `*` or `projects.write`. The desktop copy had no escape at all:
//     `permissions.includes("*")` fed only `_isDirector`, which gates
//     `_isSalesExec` and NOT the crew arm. So an admin who happens to hold the
//     Storekeeper position lost controls the server would have allowed.
//
// Neither of those is a crash and neither errors, which is why they survived:
// the failure of this whole class is a rule enforced at N-1 of N places where
// the missing one is invisible.
//
// KEEP IN LOCKSTEP WITH backend/src/services/projectGates.ts. The pair is
// refereed by backend/tests/duplicatedDecisionPins.test.ts, which imports BOTH
// implementations and runs one shared corpus of (position, permissions) pairs
// through them, asserting the same answer for every case. Change one side and
// that test goes red — which is the entire point of extracting this from a JSX
// expression into a module that can be imported.
//
// Deliberately NOT the same question as MobilePMS's `_isCrew` or the desktop
// `_isCrew`: those fold DRIVERS in, because both surfaces give drivers the same
// slimmed filter bar. Drivers are NOT force-scoped (projectGates.ts: "Drivers
// intentionally stay unscoped (owner kept them see-all)"), so they must not
// reach this predicate.
// ----------------------------------------------------------------------------

/** Owner 2026-07-21. Matched on the EXACT position name, never a substring —
 *  position names are owner-editable free text, so `/storekeeper/i` would also
 *  claim "Assistant Storekeeper", "Warehouse Storekeeper" and anything else an
 *  admin types. Mirrors CREW_SCOPED_POSITIONS in backend projectGates.ts. */
export const CREW_SCOPED_POSITIONS: readonly string[] = [
  "helper",
  "storekeeper",
  "storekeeper supervisor",
];

export type CrewScopeCarrier = {
  position_name?: string | null;
  permissions?: readonly string[] | null;
};

/** Is this user force-scoped to the events they are crewed on?
 *
 *  The permission escape comes FIRST and matches the backend's `hasPermission`
 *  for an array grant exactly (`includes("*") || includes(required)`): an
 *  admin or anyone who can write projects is never caged, whatever position
 *  they happen to hold. */
export function isCrewScopedUser(user: CrewScopeCarrier | null | undefined): boolean {
  if (!user) return false;
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
