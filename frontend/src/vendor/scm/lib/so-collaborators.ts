// so-collaborators — who ELSE can see and edit a Sales Order.
//
// Owner 2026-09-09: an order may be shared with several salespeople
// ("可以让接手的几位 sales person 都有权限"), and then, on the detail screen:
// "SO 详情页也要能看到共享给了谁". State a user cannot see is state they cannot
// correct — the grants were only visible on the maintenance panel and in the
// audit log until this shipped.
//
// LOGIC ONLY, deliberately. Desktop renders a `Field`, mobile renders a
// `RoField`, and neither is the other's component; what they must NOT each
// re-derive is WHICH names to show and what an unresolvable id means. Same
// split as useStaffLookup, whose `actorNameOf` this follows: an id that
// resolves to nobody is "Unknown user", never a raw uuid on screen.
//
// The header parameter takes `collaborator_staff_ids` as OPTIONAL on purpose.
// Mobile's SoHeader type does not declare the column (the file is at its
// file-size ceiling and may not grow), and an optional field accepts that type
// structurally — so this reads the value the backend really sends without a
// cast and without either surface lying about its own shape.

export type CollaboratorHeader = {
  collaborator_staff_ids?: readonly (string | null)[] | null;
};

export type CollaboratorStaff = {
  id?: string;
  name?: string;
  staffCode?: string;
};

/**
 * Display names for the people an order is shared with, A→Z.
 *
 * Returns [] when nothing is shared, which is the common case — both call
 * sites render nothing at all rather than an empty "Shared with —" field,
 * because a field that is blank on almost every order teaches people to stop
 * reading it.
 */
export function collaboratorNames(
  header: CollaboratorHeader | null | undefined,
  staff: readonly CollaboratorStaff[] | null | undefined,
): string[] {
  const ids = (header?.collaborator_staff_ids ?? []).filter(
    (id): id is string => typeof id === "string" && id.trim() !== "",
  );
  if (ids.length === 0) return [];

  const byId = new Map<string, string>();
  for (const s of staff ?? []) {
    if (s.id) byId.set(s.id, (s.name || s.staffCode || "").trim());
  }

  /* Deduped because the array is a set on the server but nothing forces that
     on the wire, and a name printed twice reads as two different people. */
  const seen = new Set<string>();
  const names: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const looked = byId.get(id);
    names.push(looked && looked !== "" ? looked : "Unknown user");
  }
  return names.sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

/**
 * The one-line form, for a surface that has room for a value but not a list.
 * `null` when nothing is shared, so a caller can skip the field entirely.
 */
export function collaboratorLabel(
  header: CollaboratorHeader | null | undefined,
  staff: readonly CollaboratorStaff[] | null | undefined,
): string | null {
  const names = collaboratorNames(header, staff);
  return names.length === 0 ? null : names.join(", ");
}
