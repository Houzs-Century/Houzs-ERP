-- Stock In Transfer Record is no longer a reviewable document.
--
-- Owner (2026-11-24): drop the approve/reject round on "Stock In Transfer
-- Record" — the stock returning to the warehouse after dismantle should be a
-- plain upload (or N/A) by the purchaser, like Exchange List, with no approver
-- in the loop. Stock OUT keeps its approval. The code side of this change:
--   * frontend/src/vendor/scm/lib/pms-reviewable-titles.ts — title removed from
--     the reviewable set / regex (no submit/approve/reject/"gated" controls,
--     no upload-auto-submit, on desktop and mobile),
--   * backend/src/services/checklistAutoTick.ts — same regex, so uploading a
--     Stock In row now auto-ticks it DONE instead of being held for review,
--   * backend/src/routes/projects.ts + services/projects.ts — the approver
--     "My Pending" lane no longer surfaces Stock In by title.
--
-- This migration brings EXISTING data in line so nothing is left stranded in
-- the old review workflow. Two paths, both scoped to the Stock In title (prefix,
-- case-insensitive — the exact rule the frontend used to decide reviewability,
-- so any hand-typed suffix like "Stock In Transfer Record FINAL" is caught too):
--
--   1. Clear leftover review state (review_status / rejection_reason) on every
--      Stock In row. Approved rows are already status='done' with their
--      completed_at/by stamped (approveChecklistItem), so clearing the flag just
--      drops the "APPROVED"/"IN REVIEW" badge and renders them as ordinary
--      completed uploads. Rows that were mid-review ('pending_review'/'amended')
--      or rejected fall back to plain 'pending' here, then path 2 ticks the ones
--      that already carry a file.
--
--   2. Auto-tick DONE any Stock In row that is still 'pending' but already has a
--      live (non-archived) attachment — the same rule the upload hook now
--      applies going forward, and the same shape as the 2026-10-29 auto-tick
--      backfill (20261029T1200). completed_by comes from the latest live
--      attachment's uploader; timestamps use the table's UTC text format. N/A,
--      blocked and already-done rows are untouched.
--
-- Idempotent: path 1 only touches rows that still carry review state; path 2
-- only touches pending rows with an attachment and COALESCEs existing stamps.
-- Safe to re-run.

-- Path 1 — strip the review workflow state.
UPDATE project_checklist
   SET review_status    = NULL,
       rejection_reason = NULL,
       updated_at       = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
 WHERE title ~* '^stock\s*in\s*transfer'
   AND (review_status IS NOT NULL OR rejection_reason IS NOT NULL);

-- Path 2 — tick already-uploaded Stock In rows as done (the new plain-upload rule).
UPDATE project_checklist pc
   SET status       = 'done',
       completed_at = COALESCE(
         pc.completed_at,
         to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
       ),
       completed_by = COALESCE(
         pc.completed_by,
         (SELECT a.uploaded_by
            FROM project_checklist_attachments a
           WHERE a.item_id = pc.id AND a.archived_at IS NULL
           ORDER BY a.id DESC
           LIMIT 1)
       ),
       updated_at   = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
 WHERE pc.title ~* '^stock\s*in\s*transfer'
   AND pc.status = 'pending'
   AND EXISTS (
     SELECT 1
       FROM project_checklist_attachments a
      WHERE a.item_id = pc.id AND a.archived_at IS NULL
   );
