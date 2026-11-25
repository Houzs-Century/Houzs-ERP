-- 20261125T0100_clear_review_flag_on_completed_items.sql
-- Data repair. Some checklist items are already completed (status done / na) yet
-- still carry a review flag (review_status 'pending_review' or 'amended'). That
-- happened because ticking an item done/N/A went through setChecklistStatus,
-- which set status but never cleared review_status. A completed item is not
-- awaiting anyone's approval, but the Inbox Review Queue (routes/inbox.ts
-- loadReviewQueue) lists purely on review_status, so these stale rows sat in
-- every approver's queue (~46 at the time, mostly Stock In Transfer Record).
-- The code path is fixed in the same change; this clears the rows already wrong.
--
-- No seed here.
--
-- IRREVERSIBLE -- a stale review flag carries no information to restore (the row
-- is already done/na), so there is nothing to put back.

UPDATE public.project_checklist
   SET review_status = NULL,
       rejection_reason = NULL,
       updated_at = to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
 WHERE review_status IN ('pending_review', 'amended')
   AND status IN ('done', 'na');
