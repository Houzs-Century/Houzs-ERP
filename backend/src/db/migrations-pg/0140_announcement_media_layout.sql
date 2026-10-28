-- 0140_announcement_media_layout.sql (Postgres).
-- Rich-media LAYOUT hint for announcements (owner 2026-07-18). The composer now
-- lets the author choose how the attached media renders: photos as a 1 / 2 / 3 /
-- 4 arrangement, and a video as a 1x1 (square) or 1x2 (portrait) block. The hint
-- rides on a single JSON column so the three renderers (desktop pop-up, desktop
-- page row, mobile detail) lay the SAME media out identically everywhere.
--
-- Storage: TEXT holding a small JSON object, e.g. '{"photo":"3","video":"1x1"}'.
-- Both keys are optional; an absent key — or a NULL column — means "derive a
-- default from the attachment count". That is exactly why this is safe on
-- EXISTING rows: every text-only or pre-layout media announcement keeps a NULL
-- media_layout and renders precisely as it did before (back-compat). Read /
-- written via the same JSON-string pattern as the sibling `attachments` /
-- `translations` columns (mig 0058), so no new serialization path is introduced.
--
-- Additive + idempotent + NO backfill (NULL is the intended legacy value):
-- ADD COLUMN IF NOT EXISTS is a no-op on re-run and cannot fail a deploy.
-- Single-statement (no plpgsql) so the pg-migrate `;\n` splitter runs it
-- cleanly. announcements is org-wide, lives in public.

SET search_path = public, scm;

ALTER TABLE announcements ADD COLUMN IF NOT EXISTS media_layout text;
