-- 20260906T0921_announcement_reminders.sql
-- REVERSAL: DROP TABLE IF EXISTS public.announcement_reminders;
-- Verified against: staging (minnapsemfzjmtvnnvdd) through the normal
--           migrate-before-deploy path on merge; prod (anogrigyjbduyzclzjgn)
--           carries the same 0058 + 20260905T1125 + 20260906T0639/0833 shape.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   One new table, no change to any existing table. Nothing that shipped
--   before this migration reads it; every reader added with it tolerates the
--   table being absent (empty map), so the pre-migration window is inert.
--
-- WHY (owner, 2026-09-06, "做抽屉按部门 Remind"):
--   A reminder used to be notice-level (announcements.reminded_at): "Remind
--   pending" re-popped the notice for EVERY reader who had postponed it and
--   painted every pending person "reminded". The Manage drawer's per-
--   department reminder needs the reminder to be per PERSON: one row per
--   (notice, person) reminded, upserted with the latest instant and who
--   sent it. The banner's re-pop gate and the drawer's per-person state read
--   the later of the notice-level stamp and the person's own row, so a
--   whole-notice reminder still behaves exactly as before.
CREATE TABLE IF NOT EXISTS public.announcement_reminders (
  announcement_id text NOT NULL,
  user_id integer NOT NULL,
  reminded_at text NOT NULL,
  reminded_by integer,
  PRIMARY KEY (announcement_id, user_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_announcement_reminders_user ON public.announcement_reminders (user_id);
