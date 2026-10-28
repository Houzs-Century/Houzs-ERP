-- 088_project_status.sql
--
-- Project lifecycle status (decided 2026-06-04).
--
-- Replaces the brand-coloured calendar with a status-coloured one.
-- A project moves through three states:
--   confirmed (blue)   — booked, going ahead
--   pending   (orange) — tentative, not yet committed
--   cancelled (red)    — called off
--
-- Separate from `stage` (draft/setup/live/dismantle/completed) which
-- continues to drive the internal workflow + section tracker. Status
-- is the boss-facing lifecycle indicator and the new calendar tint.
--
-- New projects default to 'pending'. Every row that exists before this
-- migration ran is treated as 'confirmed' — the assumption is they're
-- already in the books.

ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';

UPDATE projects SET status = 'confirmed';

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
