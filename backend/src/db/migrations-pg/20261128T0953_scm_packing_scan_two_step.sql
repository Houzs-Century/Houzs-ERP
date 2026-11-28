-- 20261128T0953_scm_packing_scan_two_step.sql
--
-- WHY. Owner, 2026-11-28: the packing list QR is scanned TWICE. The first scan
-- records that the sheet is prepared (picked, ready); the second records that it
-- is loaded, and marks every delivery order on it Loaded. Prepared lives only on
-- the sheet, never on a DO. The office needs the prepared time and the loaded
-- time of every lorry AND of every region for a day, so the region sheet gets a
-- QR too (it printed none: a region is not a lorry, and the table required a
-- plate).
--
-- WHAT CHANGES on scm.packing_scan_sets (one row = one printed sheet):
--   sheet_kind       'lorry' (the existing rows) or 'region'
--   region           the Delivery Planning region key a region sheet was printed for
--   prepared_at      first scan; set once, never cleared by the scan
--   prepared_by_scan true when prepared_at came from the public scan
--   loaded_at        second scan; set once, after the whole-lorry load ran
--   lorry_plate      now NULL for a region sheet; a lorry sheet still needs one
-- A sheet cannot be loaded before it is prepared (CHECK), matching the scan.
--
-- SAFE ON PRODUCTION: columns are added with constant defaults (no rewrite), the
-- old non-blank plate rule is replaced by one every existing row passes (they
-- are all 'lorry' with a non-blank plate). No data is written.
-- RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   DELETE FROM scm.packing_scan_sets WHERE sheet_kind = 'region';
--   ALTER TABLE scm.packing_scan_sets DROP CONSTRAINT IF EXISTS packing_scan_sets_sheet_key;
--   ALTER TABLE scm.packing_scan_sets DROP CONSTRAINT IF EXISTS packing_scan_sets_loaded_after_prepared;
--   DROP INDEX IF EXISTS scm.idx_packing_scan_sets_day_kind;
--   ALTER TABLE scm.packing_scan_sets
--     DROP COLUMN IF EXISTS loaded_at, DROP COLUMN IF EXISTS prepared_by_scan,
--     DROP COLUMN IF EXISTS prepared_at, DROP COLUMN IF EXISTS region,
--     DROP COLUMN IF EXISTS sheet_kind;
--   ALTER TABLE scm.packing_scan_sets ALTER COLUMN lorry_plate SET NOT NULL;
--   ALTER TABLE scm.packing_scan_sets
--     ADD CONSTRAINT packing_scan_sets_plate_nonblank CHECK (btrim(lorry_plate) <> '');
--   Reverting loses every recorded prepared / loaded time and kills the QR on
--   every printed region sheet (recovery for the QR is to re-print).

ALTER TABLE scm.packing_scan_sets
  ADD COLUMN IF NOT EXISTS sheet_kind       TEXT NOT NULL DEFAULT 'lorry',
  ADD COLUMN IF NOT EXISTS region           TEXT NULL,
  ADD COLUMN IF NOT EXISTS prepared_at      TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS prepared_by_scan BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS loaded_at        TIMESTAMPTZ NULL;

ALTER TABLE scm.packing_scan_sets ALTER COLUMN lorry_plate DROP NOT NULL;

ALTER TABLE scm.packing_scan_sets DROP CONSTRAINT IF EXISTS packing_scan_sets_plate_nonblank;
ALTER TABLE scm.packing_scan_sets DROP CONSTRAINT IF EXISTS packing_scan_sets_sheet_key;
ALTER TABLE scm.packing_scan_sets ADD CONSTRAINT packing_scan_sets_sheet_key CHECK (
  (sheet_kind = 'lorry' AND lorry_plate IS NOT NULL AND btrim(lorry_plate) <> '')
  OR (sheet_kind = 'region' AND region IS NOT NULL AND btrim(region) <> '')
);

ALTER TABLE scm.packing_scan_sets DROP CONSTRAINT IF EXISTS packing_scan_sets_loaded_after_prepared;
ALTER TABLE scm.packing_scan_sets ADD CONSTRAINT packing_scan_sets_loaded_after_prepared
  CHECK (loaded_at IS NULL OR prepared_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_packing_scan_sets_day_kind
  ON scm.packing_scan_sets (company_id, delivery_date, sheet_kind);

COMMENT ON COLUMN scm.packing_scan_sets.prepared_at IS
  'First scan of the packing list QR: the sheet is prepared. Recorded only here, never on a DO.';
COMMENT ON COLUMN scm.packing_scan_sets.loaded_at IS
  'Second scan: the whole-lorry load ran (every DO on the sheet decided). Set once.';

NOTIFY pgrst, 'reload schema';
