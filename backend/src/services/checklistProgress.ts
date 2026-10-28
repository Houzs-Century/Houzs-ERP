// Progress counting for a project's checklist.
//
// A row is DONE when its status is 'done' OR it has been APPROVED. A gated
// document is completed by approval and keeps status='pending', so counting
// status alone under-reported progress and left the desktop stage tracker
// showing an approved task as overdue (owner 2026-09-23). This mirrors the
// My-Pending SQL, which already gates on `status='done' OR
// review_status='approved'`. N/A is counted separately (it is excluded from the
// denominator, not treated as done).

export function checklistRowDone(r: { status?: string | null; review_status?: string | null }): boolean {
  return r.status === "done" || r.review_status === "approved";
}
