import type { ReactNode } from "react";
import { SCOPED_DIRECTOR_EDITABLE_MEMBER_FIELDS } from "../../mobile/member-invite-form";

/**
 * What the classic Edit Member panel (`EditMemberPanel` in pages/Team.tsx,
 * /team?tab=members) offers THIS caller. A department-scoped Sales Director
 * (the Sales Director position without users.manage) has one write there that
 * works: PATCH /api/users/:id with the keys in
 * SCOPED_DIRECTOR_EDITABLE_MEMBER_FIELDS. The handler deletes every other key
 * that caller sends and still answers ok, and the panel's other writes (photo,
 * showroom parking, reset link, resend invite, delete) require users.manage, so
 * anything else offered to them saved nothing or was refused
 * (docs/bugs/0928-a-sales-director-s-desktop-classic-edit-member-panel-offered.md).
 *
 * `write` is the PATCH key a field saves, or a name for one of the other writes.
 * Only listed keys pass for that caller, so a name added later stays hidden
 * from them until the server applies it. Everyone else is offered everything.
 */
export function editMemberOffers(write: string, scopedSalesDirector: boolean): boolean {
  return !scopedSalesDirector || SCOPED_DIRECTOR_EDITABLE_MEMBER_FIELDS.includes(write);
}

export function EditMemberField({
  write,
  scoped,
  children,
}: {
  write: string;
  scoped: boolean;
  children: ReactNode;
}) {
  return editMemberOffers(write, scoped) ? <div>{children}</div> : null;
}

/* The save diffs normalised state against the stored member, so a field the
   caller never saw can still land in the body (a stored alias of "" goes out as
   null). A scoped caller's body keeps the listed keys only. */
export function editMemberPatchFor(
  patch: Record<string, unknown>,
  scopedSalesDirector: boolean,
): Record<string, unknown> {
  if (!scopedSalesDirector) return patch;
  return Object.fromEntries(Object.entries(patch).filter(([key]) => editMemberOffers(key, true)));
}
