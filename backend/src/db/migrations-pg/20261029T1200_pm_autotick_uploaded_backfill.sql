-- Backfill: auto-tick already-uploaded evidence rows as done.
--
-- Owner (repeated ask, latest 2026-10-29): "once an image/file is ALREADY
-- uploaded, make it auto-tick the bullet as done — mobile and PC." The upload
-- handler (backend/src/routes/projects.ts) now flips NEW uploads to done, but
-- rows that already carried a file before that shipped stayed pending. This
-- one-off backfill brings the existing data in line so past and future match.
--
-- SCOPE — identical to the upload hook, on purpose:
--   * plain evidence rows only. Skips gated rows (required_perm set, whose
--     "done" is the approver's call, not the upload) and the review-document
--     titles (Agreement / Quotation, Stock Out/In Transfer Record, Display
--     Floor Plan, 3D/2D Design, Exchange List). The regex below is the exact
--     one the app uses in frontend/src/vendor/scm/lib/pms-reviewable-titles.ts.
--   * only status = 'pending' rows that have at least one live (non-archived)
--     attachment. N/A, blocked and already-done rows are left untouched.
--
-- completed_by is filled from the latest live attachment's uploader so the
-- history reads like a normal tick; completed_at/updated_at use the same UTC
-- text format as the rest of the table.
--
-- REVERSAL: no safe blanket undo. Once ticked, a backfilled row is
-- indistinguishable from one a user completed by hand (same status/
-- completed_at/completed_by shape), and both this migration and the live
-- upload hook now tick on the same condition, so reverting would also undo
-- genuine completions. If a specific project was ticked in error, hand-revert
-- its rows: UPDATE project_checklist SET status='pending', completed_at=NULL,
-- completed_by=NULL WHERE project_id = <id> AND id IN (<the rows>).
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
 WHERE pc.status = 'pending'
   AND (pc.required_perm IS NULL OR pc.required_perm = '')
   AND pc.title !~* '^(agreement|stock\s*(out|in)\s*transfer|display\s*floor\s*plan|3d\s*design|2d\s*design|exchange\s*list)'
   AND EXISTS (
     SELECT 1
       FROM project_checklist_attachments a
      WHERE a.item_id = pc.id AND a.archived_at IS NULL
   );

-- Second path: crew Setup/Dismantle photos. Driver/helper uploads land in
-- project_phase_photos (the Driver App + mobile setup/dismantle card), NOT in
-- the task's attachments, so the "Setup Image" / "Dismantle Image" rows that
-- already carry a crew photo also sat pending. Tick the DRIVER-badged row (the
-- one the desktop merges those photos into); the SALES PIC "Setup Image" is
-- ticked by its own task attachment above, not by the driver's photo.
UPDATE project_checklist pc
   SET status       = 'done',
       completed_at = COALESCE(
         pc.completed_at,
         to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
       ),
       completed_by = COALESCE(
         pc.completed_by,
         (SELECT pp.uploaded_by
            FROM project_phase_photos pp
           WHERE pp.project_id = pc.project_id
             AND pp.phase = CASE
                   WHEN lower(trim(pc.title)) LIKE 'setup image%' THEN 'setup'
                   ELSE 'dismantle'
                 END
           ORDER BY pp.id DESC
           LIMIT 1)
       ),
       updated_at   = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
 WHERE pc.status = 'pending'
   AND (pc.required_perm IS NULL OR pc.required_perm = '')
   AND upper(coalesce(pc.role_label, '')) LIKE '%DRIVER%'
   AND (
         (lower(trim(pc.title)) LIKE 'setup image%'
            AND EXISTS (SELECT 1 FROM project_phase_photos pp
                         WHERE pp.project_id = pc.project_id AND pp.phase = 'setup'))
      OR (lower(trim(pc.title)) LIKE 'dismantle image%'
            AND EXISTS (SELECT 1 FROM project_phase_photos pp
                         WHERE pp.project_id = pc.project_id AND pp.phase = 'dismantle'))
   );
