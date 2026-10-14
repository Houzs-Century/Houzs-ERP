-- 20261014T1320_scm_scan_files.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.scan_files;
--   Revert the code first (scm/lib/scan-files.ts and its four callers write this
--   table). The bytes under scan-jobs/ and scan-files/ in the SO_ITEM_PHOTOS R2
--   bucket are not SQL's to remove; nothing reads a scan-files/ key without its row.
--   GRANTS: the one GRANT below goes with the table.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new empty
-- table and its indexes; no existing row is written or altered.
--
-- WHY (HC-0006, Mr Lim, IT Hub, 7 Sep 2026: keep every original). One row per
-- original scan file — sales slip (so), payment receipt (payment), supplier bill
-- (pv), workshop invoice (workshop) — written on upload, BEFORE the model reads
-- it, so a failed read still leaves the file and its row. document_id is the
-- resulting document when one is linked later (nullable; text because the four
-- documents do not share an id type).

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.scan_files (
  id           uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id   bigint      NOT NULL,
  kind         text        NOT NULL CHECK (kind IN ('so', 'payment', 'pv', 'workshop')),
  storage_key  text        NOT NULL UNIQUE,
  sha256       text        NOT NULL,
  mime         text        NOT NULL,
  size_bytes   bigint      NOT NULL,
  uploaded_by  text,
  document_id  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scan_files_company_kind ON scm.scan_files (company_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_files_sha ON scm.scan_files (company_id, sha256);
CREATE INDEX IF NOT EXISTS idx_scan_files_document ON scm.scan_files (document_id) WHERE document_id IS NOT NULL;

-- Same as 0061: RLS on, no policies — anon/authenticated see nothing; the Worker's
-- service_role bypasses RLS.
ALTER TABLE scm.scan_files ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scm.scan_files TO service_role;

NOTIFY pgrst, 'reload schema';
