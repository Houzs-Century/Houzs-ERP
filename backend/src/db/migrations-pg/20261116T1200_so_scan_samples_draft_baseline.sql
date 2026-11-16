-- 20261116T1200_so_scan_samples_draft_baseline.sql
-- The draft as the scan pipeline left it (after phone/postcode/catalog fixes), kept beside the raw read,
-- so a later confirm can tell what a person changed from what the pipeline changed.
-- REVERSAL: ALTER TABLE scm.so_scan_samples DROP COLUMN draft_baseline;

ALTER TABLE scm.so_scan_samples ADD COLUMN IF NOT EXISTS draft_baseline jsonb;
