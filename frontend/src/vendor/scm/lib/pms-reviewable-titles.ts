// ----------------------------------------------------------------------------
// pms-reviewable-titles — CANONICAL "does this checklist row carry the
// submit / approve / reject workflow?" rule. NO React, no I/O. Imported by
// desktop `Projects.tsx` and mobile `MobilePMS.tsx`.
//
// WHY IT EXISTS. Desktop was a Set of seven EXACT titles tested with `.has()`.
// Mobile was a PREFIX regex whose comment claimed it "mirrors" that set. It is
// strictly broader, so a row titled "3D Design (Revision 2)" or
// "Agreement — signed copy" got the full approve/reject workflow on the phone
// and showed NO review controls at all on the PC. Neither list was DB-backed.
//
// == THE RULE CHOSEN, AND WHAT IT CHANGES ==
// PREFIX wins. Stated as a choice, not discovered:
//
//   1. The owner's standing philosophy for this system is to LOOSEN rather than
//      restrict — small company, speed over strictness, never a hard wall.
//   2. The prefix rule is a strict SUPERSET of the exact set: all seven exact
//      titles match their own prefix, proved in this module's test. So adopting
//      it REMOVES review controls from nobody.
//   3. Staff type these titles by hand and add suffixes ("(Revision 2)",
//      "— signed copy", "FINAL"). Exact-matching silently withholds the
//      workflow from a row that is plainly the same document, and the failure
//      is invisible: the row simply renders without buttons.
//
// WHO SEES A CHANGE: desktop users, on suffixed rows only — those now show the
// submit/approve/reject controls they already showed on the phone. Mobile
// behaviour is unchanged. No row loses a control on either surface.
//
// THIS IS AN OWNER-FACING CHOICE, flagged in the PR rather than decided
// silently. If he wants exactness instead, swap the matcher here and both
// surfaces follow — which is the point of there being one of it.
// ----------------------------------------------------------------------------

/** The seven documents the review workflow applies to, as the tasklist
 *  templates spell them. Kept as data so the test can PROVE the prefix rule is
 *  a superset of the exact set rather than asserting it by hand. */
export const REVIEWABLE_TITLES = [
  "Agreement / Quotation",
  "Stock Out Transfer Record",
  "Stock In Transfer Record",
  "Display Floor Plan",
  "3D Design",
  "2D Design",
  "Exchange List",
];

/** Prefix match, case-insensitive, tolerant of the spacing staff actually
 *  type ("3D  Design", "Stock  Out Transfer"). */
const REVIEWABLE_TITLE_RE =
  /^(agreement|stock\s*(out|in)\s*transfer|display\s*floor\s*plan|3d\s*design|2d\s*design|exchange\s*list)/i;

export function isReviewableTitle(title: string | null | undefined): boolean {
  return REVIEWABLE_TITLE_RE.test((title ?? "").trim());
}
