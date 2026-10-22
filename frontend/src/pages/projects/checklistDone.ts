// One rule for "is this checklist item complete", shared by the stage tracker
// and any progress read on the desktop project page.
//
// Complete = done, N/A, or APPROVED. APPROVED matters because a gated document
// (3D Design, Display Floor Plan, Stock In/Out records, …) has no separate
// "mark done" control — approving it IS its completion — so its `status` stays
// 'pending' while `review_status` becomes 'approved'. Reading status alone left
// an approved task's stage bullet red/overdue for months (owner 2026-09-23, KL
// ZANOTTI REX). The backend already treats approved as done in My Pending
// (`status='done' OR review_status='approved'`); this is the frontend twin.

export function itemComplete(i: { status?: string | null; review_status?: string | null }): boolean {
  return i.status === "done" || i.status === "na" || i.review_status === "approved";
}
