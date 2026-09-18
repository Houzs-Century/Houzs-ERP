-- 20260907T1030_announcement_void_no_hard_delete.sql
-- REVERSAL: DROP TRIGGER IF EXISTS trg_announcements_no_hard_delete ON public.announcements; DROP FUNCTION IF EXISTS public.announcements_no_hard_delete(); ALTER TABLE public.announcements DROP COLUMN IF EXISTS voided_by, DROP COLUMN IF EXISTS voided_at, DROP COLUMN IF EXISTS void_reason;
-- Verified against: staging (minnapsemfzjmtvnnvdd) through the normal
--           migrate-before-deploy path on merge; prod (anogrigyjbduyzclzjgn)
--           carries the same announcements shape (0058 … 20260907T0715).
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   Three additive nullable columns (voided_by / voided_at / void_reason) and
--   ONE trigger: BEFORE DELETE on public.announcements refuses the row unless
--   it is still a DRAFT (approval_status = 'DRAFT', mig 20260906T1509). Every
--   row that exists today is APPROVED (the column's DEFAULT), so from this
--   migration on no existing notice can be deleted — by the app, by a script,
--   or by hand — only voided. The app's DELETE route already refuses the same
--   thing at the door (it deletes drafts only); the trigger is the floor
--   under it. The system notices (source IS NOT NULL: scan / service-case /
--   escalation / approval bell items) are APPROVED rows too and are equally
--   protected; nothing in the code deletes them.
--
-- WHY (owner, 2026-09-06, "标准化编号与文档管理" — 禁止物理删除 / 作废须写原因):
--   The owner's rule for documents is 不可以删只可以 cancel
--   (docs/hard-delete-inventory.md). A voided announcement keeps its row, its
--   reference number (document_refs.status = VOID, the number is never
--   re-issued) and its read receipts; deliverableNow() (lib/announcementAudience.ts)
--   stops serving it. A draft — never submitted, nothing committed to — may
--   still be discarded, the same reading the SCM Sales Order draft discard has.
ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS voided_by integer;
ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS voided_at text;
ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS void_reason text;

CREATE OR REPLACE FUNCTION public.announcements_no_hard_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.approval_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'announcements: % is not a draft — a submitted announcement must be voided, not deleted', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_announcements_no_hard_delete ON public.announcements;
CREATE TRIGGER trg_announcements_no_hard_delete
  BEFORE DELETE ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION public.announcements_no_hard_delete();
