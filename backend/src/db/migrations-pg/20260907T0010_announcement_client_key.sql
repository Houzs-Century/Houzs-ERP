-- 20260907T0010_announcement_client_key.sql
-- REVERSAL: DROP INDEX IF EXISTS public.announcements_client_key_uq;
--           ALTER TABLE public.announcements DROP COLUMN IF EXISTS client_key;
-- Verified against: staging (minnapsemfzjmtvnnvdd) through the normal
--           migrate-before-deploy path on merge; prod (anogrigyjbduyzclzjgn)
--           carries the same 0058 + 20260905T1125 + 20260906T0639/0833/0921 shape.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   One additive nullable column on public.announcements and one partial
--   unique index over it. Nothing that shipped before this migration reads or
--   writes the column; the create route appends it only when the client sent
--   a key, so the pre-migration window inserts exactly as before.
--
-- WHY (owner, 2026-09-06, docs/bugs/0650 and 0651):
--   Posting a rich notice hung for a minute (the route awaited the translation,
--   fixed in #3016). The owner clicked Schedule post again and again, and each
--   click INSERTed — nine copies of one notice. The composer's draft survives
--   a closed modal and a reload (localStorage), so the retry that made the
--   copies was the SAME draft every time. The draft now carries a client key
--   minted when it is first written and cleared with it on success; the create
--   route stores it and answers a repeat with the row it already made instead
--   of a second one. The unique index is the last line of defence for two
--   requests racing past the lookup.
--
-- Scoped per author (created_by, client_key): a key is meaningful only to the
-- browser that minted it, and scoping it keeps one user's stray key from ever
-- colliding with another's. Partial (client_key IS NOT NULL) so the existing
-- rows and every post from a client that sends no key are untouched.
-- Additive + idempotent: IF NOT EXISTS on both statements. Plain statements,
-- no plpgsql, so the pg-migrate `;\n` splitter runs each one cleanly.

ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS client_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS announcements_client_key_uq
  ON public.announcements (created_by, client_key)
  WHERE client_key IS NOT NULL;
