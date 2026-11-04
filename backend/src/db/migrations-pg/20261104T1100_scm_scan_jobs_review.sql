-- 20261104T1100_scm_scan_jobs_review.sql
-- REVERSAL:
--   DROP INDEX IF EXISTS scm.scan_jobs_review_idx;
--   DROP INDEX IF EXISTS scm.scan_jobs_file_hash_idx;
--   ALTER TABLE scm.scan_jobs DROP COLUMN IF EXISTS batch_id, DROP COLUMN IF EXISTS review,
--     DROP COLUMN IF EXISTS review_state, DROP COLUMN IF EXISTS file_name,
--     DROP COLUMN IF EXISTS page_from, DROP COLUMN IF EXISTS page_to, DROP COLUMN IF EXISTS file_hash;
--   GRANTS: none touched — columns and two indexes on an existing table.
--
-- Scan, check, then create (owner 2026-11-03, after Hookka's scan modal): drop
-- any number of files, the server splits a PDF into its documents, reads each
-- in the background, and keeps what it read here for the operator to check and
-- edit before anything is created. Coming back later finds the same batch.
--   batch_id      one upload; every document split out of it shares it
--   review        the operator's working copy (supplier, D.O. no, date, lines
--                 with the PO line each receives) — saved on every edit
--   review_state  NULL = the old scan-straight-to-draft job; otherwise
--                 'reading' -> 'pending' -> 'created' | 'discarded'
--   file_name, page_from, page_to   which file and pages this document is
--   file_hash     SHA-256 of the document's bytes: the same file uploaded again
--                 reuses the earlier read instead of paying for a new one
ALTER TABLE scm.scan_jobs
  ADD COLUMN IF NOT EXISTS batch_id uuid,
  ADD COLUMN IF NOT EXISTS review jsonb,
  ADD COLUMN IF NOT EXISTS review_state text,
  ADD COLUMN IF NOT EXISTS file_name text,
  ADD COLUMN IF NOT EXISTS page_from integer,
  ADD COLUMN IF NOT EXISTS page_to integer,
  ADD COLUMN IF NOT EXISTS file_hash text;

CREATE INDEX IF NOT EXISTS scan_jobs_review_idx
  ON scm.scan_jobs (company_id, document_type, review_state, created_at DESC)
  WHERE review_state IS NOT NULL;

CREATE INDEX IF NOT EXISTS scan_jobs_file_hash_idx
  ON scm.scan_jobs (company_id, document_type, file_hash)
  WHERE file_hash IS NOT NULL;
