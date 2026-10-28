// ----------------------------------------------------------------------------
// self-staff — "which staff row is the signed-in person?", answered ONCE.
//
// WHY THIS FILE EXISTS. Three surfaces resolved the creator against the staff
// roster and each wrote its own ladder, so the answer depended on which screen
// you were standing on. Desktop `SalesOrderNew` was corrected in #2049 to match
// on `user_id` FIRST — measured on production 2026-08-12, 102 of 140 scm.staff
// rows carry `user_id` while only 18 carry an email, and `user_id` is the key
// the BACKEND itself joins on (`resolveOwnerStaffId`). Mobile `MobileNewSO` was
// left on email-then-name (the string `userId` appeared nowhere in the file)
// while its comment claimed "(by id / email / name)", so the majority of
// salespeople were not recognised as themselves on the phone: they fell through
// to the UI-only `__self__` placeholder and could be refused outright by the
// confirm gate ("Pick a salesperson before confirming this order").
//
// Matching the frontend to the backend's own key is what stops the two
// disagreeing about whether the caller has a staff row at all: the IT Admin HAS
// one (user_id 4, email NULL), yet id/email/name all missed it, so the page
// offered a synthesized self-option the create path then discarded.
//
// PURE — no React, no I/O. Every input is passed in.
// ----------------------------------------------------------------------------

/** The subset of a staff row this resolution reads. `StaffRow` (admin-queries)
 *  satisfies it structurally, so callers pass their list straight in. */
export interface SelfStaffCandidate {
  id: string;
  name?: string | null;
  email?: string | null;
  /** The Houzs auth user this staff row belongs to (scm.staff.user_id). */
  userId?: number | null;
}

/** Who is asking. `userId` / `email` / `name` come from the Houzs auth user;
 *  `staffId` / `staffName` from the 2990 auth bridge's own staff row, which is
 *  null or role-only for a Houzs user without one (e.g. the owner). */
export interface SelfStaffIdentity {
  userId?: number | string | null;
  email?: string | null;
  name?: string | null;
  staffId?: string | null;
  staffName?: string | null;
}

const lower = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase();

/**
 * Resolve the signed-in person to their row on `staffList`, or `undefined` when
 * the roster genuinely does not hold them (the caller then synthesizes its
 * UI-only "self" option so their NAME is still shown, never a blank field).
 *
 * Order — user_id, then the bridge's staff id, then email, then name:
 *   · `user_id` is the only link that actually exists on this data, and it is
 *     what the backend resolves the caller by.
 *   · the remaining three are kept as fallbacks so a roster row that predates
 *     the user link is still found.
 * A null/absent caller id never matches a null `userId` — "we both have no id"
 * is not "that is me".
 */
export function resolveSelfStaff<T extends SelfStaffCandidate>(
  staffList: readonly T[],
  me: SelfStaffIdentity,
): T | undefined {
  const selfUserId = me.userId != null && String(me.userId).trim() !== ''
    ? Number(me.userId)
    : null;
  const byUserId = selfUserId != null && Number.isFinite(selfUserId)
    ? staffList.find((s) => s.userId != null && Number(s.userId) === selfUserId)
    : undefined;
  if (byUserId) return byUserId;

  const staffId = (me.staffId ?? '').trim();
  const byId = staffId ? staffList.find((s) => s.id === staffId) : undefined;
  if (byId) return byId;

  const email = lower(me.email);
  const byEmail = email ? staffList.find((s) => lower(s.email) === email) : undefined;
  if (byEmail) return byEmail;

  const name = lower(me.name) || lower(me.staffName);
  return name ? staffList.find((s) => lower(s.name) === name) : undefined;
}
