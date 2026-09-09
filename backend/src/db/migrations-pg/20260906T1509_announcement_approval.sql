-- 20260906T1509_announcement_approval.sql
-- REVERSAL: DROP INDEX IF EXISTS public.idx_announcements_ref_no; DROP INDEX IF EXISTS public.idx_announcements_approval_open; ALTER TABLE public.announcements DROP COLUMN IF EXISTS approval_status, DROP COLUMN IF EXISTS submitted_by, DROP COLUMN IF EXISTS submitted_at, DROP COLUMN IF EXISTS reviewed_by, DROP COLUMN IF EXISTS reviewed_at, DROP COLUMN IF EXISTS reject_reason, DROP COLUMN IF EXISTS ref_no;
-- Verified against: staging (minnapsemfzjmtvnnvdd) through the normal
--           migrate-before-deploy path on merge; prod (anogrigyjbduyzclzjgn)
--           carries the same 0058 + 20260905T1125 + 20260906T0639 +
--           20260906T0833 + 20260906T1417 shape.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   Seven additive columns on public.announcements plus two partial indexes.
--   approval_status is NOT NULL DEFAULT 'APPROVED', so every row that exists
--   today — all of them posted under the old "post = live" rule — stays
--   exactly as visible as it is now; the previous build never reads any of
--   these columns. Only rows created by the new build start life in
--   PENDING_APPROVAL (or DRAFT).
--
-- WHY (owner, 2026-09-06, "通告审批流"):
--   An announcement is now Draft → Pending approval → Approved & published /
--   Rejected. The reader feed, the pop-up banner, the bell, the ack endpoint
--   and the overdue-escalation cron all go through deliverableNow()
--   (lib/announcementAudience.ts), which requires APPROVED — so a pending or
--   rejected notice is invisible to its audience until an approver
--   (permission announcements.approve) acts. reviewed_* + reject_reason are
--   the audit on the row itself (audit_events carries the trail);
--   ref_no is the document reference number [DEPT]-ANN-[YYMM]-[NNNN] minted
--   on approval through services/documentRefs.ts (mig 20260906T1417) — the
--   registry (document_refs) is the index, the row carries the number too.
ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'APPROVED';
ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS submitted_by integer;
ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS submitted_at text;
ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS reviewed_by integer;
ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS reviewed_at text;
ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS reject_reason text;
ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS ref_no text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_announcements_ref_no
  ON public.announcements (ref_no) WHERE ref_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_announcements_approval_open
  ON public.announcements (approval_status) WHERE approval_status <> 'APPROVED';
