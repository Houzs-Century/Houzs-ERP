-- 20260904T1700_announcement_body_html.sql
-- REVERSAL: ALTER TABLE public.announcements DROP COLUMN IF EXISTS body_html;
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   One nullable text column on public.announcements. Nothing is read from it
--   by any code that shipped before this migration, and nothing is written to
--   it by the migration itself — no backfill, no default.
--
-- WHY. The owner asked (2026-09-04) for bold / text size / numbered lists in
-- announcements. The composer now stores the formatted body as a strictly
-- canonicalised HTML fragment (backend/src/lib/announcementRichText.ts —
-- allow-list of p/br/b/i/u/s/ol/ul/li and span[data-size]) in this column,
-- while `body` keeps the PLAIN-TEXT shadow derived from it. Every reader that
-- only knows plain text (the bell excerpt, search, the translation fallback,
-- a phone still on an older build) keeps working off `body` unchanged.
--
-- NULL is the meaningful legacy value: every existing row, every system
-- notice, and every notice posted without any formatting stays NULL and
-- renders exactly as it did before (whitespace-preserved plain text).
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS is a no-op on re-run).
-- Single statement, no plpgsql, so the pg-migrate `;\n` splitter runs it
-- cleanly. announcements is org-wide and lives in public — same home as its
-- sibling JSON-ish text columns (translations / attachments / media_layout).

SET search_path = public, scm;

ALTER TABLE announcements ADD COLUMN IF NOT EXISTS body_html text;
