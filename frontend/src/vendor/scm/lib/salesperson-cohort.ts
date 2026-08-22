/* ----------------------------------------------------------------------------
   salesperson-cohort — who belongs to Sales/Management, decided ONCE.

   WHY THIS FILE EXISTS. Two dropdowns on the Sales Order form ask the same
   question and answered it differently, and the looser one is the money field.

     Salesperson       filteredStaffList          user_id FIRST, email fallback
     Collected By      paymentsCollectedByAllowedIds   EMAIL ONLY

   EMAIL IS NOT A KEY THAT EXISTS ON THIS DATA. Measured on production
   2026-08-12 and recorded in SalesOrderNew.tsx: of 140 `scm.staff` rows only
   18 carry an email at all, while 102 carry `user_id`; of the 102 ACTIVE rows,
   **98 have no email**. Cross-referencing `staff.email` against the
   Sales/Management users' emails therefore matches almost nothing. That is
   exactly why the salesperson picker was moved onto `user_id` — and its sibling
   was left behind, so "Collected By" could offer at most a handful of the
   hundred-odd people who should be in it.

   THE SECOND HALF IS WORSE THAN THE FIRST. The old Collected By memo bailed to
   `null` — meaning NO RESTRICTION — when the email set was empty, while the
   salesperson picker went on narrowing correctly off `user_id`. So the field
   that records WHO TOOK THE MONEY was the one that fell open. A filter that
   fails open has to fail open for a reason the reader can see, not because the
   key it happened to use was absent.

   One predicate, two consumers.
   -------------------------------------------------------------------------- */

/** The fields of a staff row this decision reads. Structural, so both the
 *  vendored StaffRow and any caller's narrower shape satisfy it. */
export interface CohortStaff {
  id: string;
  userId?: number | string | null;
  email?: string | null;
}

export interface CohortInput {
  /** Houzs user ids in Sales/Management. `null` = not resolved yet. */
  allowedUserIds: Set<number> | null | undefined;
  /** Lowercased emails of the same cohort. `null` = not resolved yet. */
  allowedEmails: Set<string> | null | undefined;
  /** The signed-in Houzs user, who is ALWAYS in their own roster. */
  selfUserId?: number | string | null;
  selfEmail?: string | null;
  /** A staff id to keep whatever the cohort says — the row a document already
   *  names. Dropping it would blank a stored value on open. */
  keepStaffId?: string | null;
}

const norm = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase();
const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Has either key set been resolved? Neither means "still loading", and a
 *  filter that hides everyone while loading is worse than one that waits. */
export function cohortIsResolved(input: CohortInput): boolean {
  return (
    (!!input.allowedUserIds && input.allowedUserIds.size > 0) ||
    (!!input.allowedEmails && input.allowedEmails.size > 0)
  );
}

/**
 * Is this staff row in the cohort?
 *
 * Order is the rule: the document's own row, then the caller themselves, then
 * `user_id`, then email. `user_id` before email because it is the key that
 * exists — see the header. Email stays only for the 18 rows that carry one and
 * no user_id.
 */
export function isInSalespersonCohort(s: CohortStaff, input: CohortInput): boolean {
  if (input.keepStaffId && s.id === input.keepStaffId) return true;

  const sUser = num(s.userId);
  const selfUser = num(input.selfUserId);
  if (selfUser !== null && sUser !== null && sUser === selfUser) return true;

  const sEmail = norm(s.email);
  const selfEmail = norm(input.selfEmail);
  if (sEmail && selfEmail && sEmail === selfEmail) return true;

  if (input.allowedUserIds && input.allowedUserIds.size > 0 && sUser !== null
      && input.allowedUserIds.has(sUser)) return true;

  return !!input.allowedEmails && input.allowedEmails.size > 0
    && !!sEmail && input.allowedEmails.has(sEmail);
}

/**
 * The cohort as staff ids, for a consumer that wants a set rather than a
 * filtered list.
 *
 * Returns `null` — meaning DO NOT RESTRICT — only when neither key set has
 * resolved yet. It must never return null merely because one of the two keys
 * was absent from the data; that is the failure this module exists to remove.
 */
export function cohortStaffIds(
  staff: readonly CohortStaff[],
  input: CohortInput,
): Set<string> | null {
  if (!cohortIsResolved(input)) return null;
  const out = new Set<string>();
  for (const s of staff) if (isInSalespersonCohort(s, input)) out.add(s.id);
  return out;
}
