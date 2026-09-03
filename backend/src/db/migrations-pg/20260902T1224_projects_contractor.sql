-- 20260902T1224_projects_contractor.sql
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   Adds a free-text `contractor` column to `projects` (the booth setup/dismantle
--   contractor, chosen on the Project Detail page), plus a picker-backed lookup
--   table `project_contractors` modelled exactly on `project_organizers`
--   (id/name/notes/active/created_by/created_at). Seeds the four current
--   contractors. All statements are idempotent (IF NOT EXISTS / WHERE NOT EXISTS),
--   so re-running is a no-op and no existing row is touched.
--
-- Reversal: ALTER TABLE projects DROP COLUMN IF EXISTS contractor; DROP TABLE IF EXISTS project_contractors;
-- Verified against: prod Supabase anogrigyjbduyzclzjgn (project_organizers column shape copied 1:1)

-- 1. The per-project contractor (free text, mirrors projects.organizer).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS contractor text;

-- 2. Picker lookup table — same shape as project_organizers so the routes,
--    hook and Maintenance manager clone cleanly.
CREATE TABLE IF NOT EXISTS project_contractors (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  notes text,
  active bigint NOT NULL DEFAULT 1,
  created_by bigint,
  created_at text DEFAULT to_char(timezone('UTC'::text, now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'::text)
);

CREATE INDEX IF NOT EXISTS idx_contractors_active ON project_contractors(active);

-- 3. Seed the current contractors (idempotent on case-insensitive name).
INSERT INTO project_contractors (name)
SELECT v.name FROM (VALUES
  ('DREAM ART (M) SDN BHD'),
  ('BAND OF GORILLA SDN BHD'),
  ('YEN CREATIVE SDN BHD'),
  ('JH CONTRACTOR')
) AS v(name)
WHERE NOT EXISTS (
  SELECT 1 FROM project_contractors pc WHERE LOWER(pc.name) = LOWER(v.name)
);
