-- 20261128T1600_scm_packing_scan_parts.sql
--
-- WHY. Owner, 2026-11-28: a lorry or region sheet with more than 60 delivery
-- orders (the scan's cap) is printed as several parts, each with its own QR,
-- instead of one sheet with no QR. The office's Prepared / Loaded columns must
-- only show a time once EVERY part has been scanned, so each printed sheet
-- records which part it is.
--
-- WHAT CHANGES on scm.packing_scan_sets (one row = one printed sheet):
--   part_no     1-based part of a split sheet; NULL for a whole sheet
--   part_count  how many parts the sheet was split into; NULL for a whole sheet
--
-- SAFE ON PRODUCTION: two nullable columns, no default, no rewrite, no data
-- written; every existing row is a whole sheet (both NULL) and passes the CHECK.
-- RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   ALTER TABLE scm.packing_scan_sets DROP CONSTRAINT IF EXISTS packing_scan_sets_part_shape;
--   ALTER TABLE scm.packing_scan_sets DROP COLUMN IF EXISTS part_count, DROP COLUMN IF EXISTS part_no;
--   Reverting makes split sheets read as whole sheets in the Prepared / Loaded columns.

ALTER TABLE scm.packing_scan_sets
  ADD COLUMN IF NOT EXISTS part_no    SMALLINT NULL,
  ADD COLUMN IF NOT EXISTS part_count SMALLINT NULL;

ALTER TABLE scm.packing_scan_sets DROP CONSTRAINT IF EXISTS packing_scan_sets_part_shape;
ALTER TABLE scm.packing_scan_sets ADD CONSTRAINT packing_scan_sets_part_shape CHECK (
  (part_no IS NULL AND part_count IS NULL)
  OR (part_count BETWEEN 2 AND 50 AND part_no BETWEEN 1 AND part_count)
);

COMMENT ON COLUMN scm.packing_scan_sets.part_no IS
  'Which part of a split packing list (over 60 DOs) this sheet is; NULL for a whole sheet.';

NOTIFY pgrst, 'reload schema';
