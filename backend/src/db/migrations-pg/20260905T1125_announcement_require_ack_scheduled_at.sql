-- 20260905T1125_announcement_require_ack_scheduled_at.sql
-- REVERSAL: ALTER TABLE public.announcements DROP COLUMN IF EXISTS require_ack;
--           ALTER TABLE public.announcements DROP COLUMN IF EXISTS scheduled_at;
-- Verified against: staging (minnapsemfzjmtvnnvdd) before the PR merges; prod
--           (anogrigyjbduyzclzjgn) carries the same 0058 shape.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   Two additive columns on public.announcements plus one backfill UPDATE.
--   Nothing that shipped before this migration reads either column, and the
--   backfill only sets the new flag on rows whose category already implied it.
--
-- WHY (Announcements redesign, design handoff 2026-09-04):
--   · require_ack — "this notice must be acknowledged" as a PER-NOTICE flag.
--     Until now the rule was hard-coded by category (WARNING / SOP block,
--     GENERAL / LEARNING do not); the composer now carries a "Require
--     acknowledgement" checkbox that defaults ON for those two categories and
--     can be flipped either way. The mandatory modal, the inbox's pinned group,
--     the dashboard stack and the bell all key off this one flag. The backfill
--     writes the category default into every existing HUMAN post so nothing
--     changes for a notice already out there; system notices (source NOT NULL)
--     stay 0 — they never blocked and never will.
--   · scheduled_at — an ISO instant before which the notice is not delivered
--     (list, banner, ack all treat it as not yet posted). NULL = posted at once,
--     which is every existing row.
--
-- Timestamps stay TEXT and the flag stays integer 0/1, matching the rest of
-- this table (mig 0058). Additive + idempotent: ADD COLUMN IF NOT EXISTS is a
-- no-op on re-run, and the UPDATE is a no-op once applied (require_ack = 1
-- already). Plain statements, no plpgsql, so the pg-migrate `;\n` splitter runs
-- each one cleanly. announcements is org-wide and lives in public.

SET search_path = public, scm;

ALTER TABLE announcements ADD COLUMN IF NOT EXISTS require_ack integer NOT NULL DEFAULT 0;

ALTER TABLE announcements ADD COLUMN IF NOT EXISTS scheduled_at text;

UPDATE announcements SET require_ack = 1
 WHERE category IN ('WARNING', 'SOP') AND source IS NULL AND require_ack = 0;
