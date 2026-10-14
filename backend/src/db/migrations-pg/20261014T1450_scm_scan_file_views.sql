-- 20261014T1450_scm_scan_file_views.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.scan_file_views;
--   Revert the code first (scm/routes/scan-files.ts writes this table on every
--   open, and refuses to serve a scan when the write fails).
--   GRANTS: the one GRANT below goes with the table.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new empty
-- table and its index; no existing row is written or altered.
--
-- WHY (HC-0006 T7): each document opens the original scan it was read from, and
-- every open is recorded — who and when — one row per open.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.scan_file_views (
  id            uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id    bigint      NOT NULL,
  scan_file_id  uuid        NOT NULL REFERENCES scm.scan_files(id) ON DELETE CASCADE,
  viewed_by     text,
  viewed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scan_file_views_file ON scm.scan_file_views (company_id, scan_file_id, viewed_at DESC);

-- Same as scan_files: RLS on, no policies — the Worker's service_role bypasses RLS.
ALTER TABLE scm.scan_file_views ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scm.scan_file_views TO service_role;

NOTIFY pgrst, 'reload schema';
