-- 20261014T1440_scm_scan_field_aliases.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.scan_field_aliases;
--   Revert the code first (scm/lib/scan-field-aliases.ts reads and writes this
--   table; both are best-effort, so a missing table only stops the learning).
--   GRANTS: the one GRANT below goes with the table.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new empty
-- table and its index; no existing row is written or altered.
--
-- WHY (HC-0006 T8, Mr Lim, IT Hub, 7 Sep 2026: scanning should learn). One row
-- per field an operator corrected on a scanned sales slip: what the model read
-- (raw) -> what the operator confirmed (value), per company. The next scan of
-- that company reads these before calling the model and applies exact hits.
-- raw_key is raw upper-cased with spaces collapsed, the match key.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.scan_field_aliases (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  bigint      NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('so')),
  field       text        NOT NULL CHECK (field IN ('customerName', 'phone', 'itemCode')),
  raw_key     text        NOT NULL,
  raw         text        NOT NULL,
  value       text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, kind, field, raw_key)
);
CREATE INDEX IF NOT EXISTS idx_scan_field_aliases_company ON scm.scan_field_aliases (company_id, kind, updated_at DESC);

-- Same as scan_files: RLS on, no policies; the Worker's service_role bypasses RLS.
ALTER TABLE scm.scan_field_aliases ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scm.scan_field_aliases TO service_role;

NOTIFY pgrst, 'reload schema';
