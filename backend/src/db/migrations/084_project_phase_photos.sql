-- 084_project_phase_photos.sql
--
-- Crew-uploaded evidence photos for project setup / dismantle phases
-- (decided 2026-05-28).
--
-- Drivers / helpers assigned to a project phase open the Driver App's
-- new "My Projects" surface and upload photos that prove the booth
-- was set up / torn down correctly. The office side shows the photos
-- in a read-only panel on the project detail page.
--
-- Separate table (not project_attachments, which CLAUDE.md flags as
-- legacy-only) because the access model is different: crew may
-- upload to *their* phase even without projects.write, scoped by
-- crew membership (mig 083 columns).

CREATE TABLE project_phase_photos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase         TEXT    NOT NULL CHECK (phase IN ('setup','dismantle')),
  r2_key        TEXT    NOT NULL,
  content_type  TEXT,
  caption       TEXT,
  uploaded_by   INTEGER REFERENCES users(id),
  uploaded_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_project_phase_photos_proj_phase
  ON project_phase_photos(project_id, phase, uploaded_at DESC);
