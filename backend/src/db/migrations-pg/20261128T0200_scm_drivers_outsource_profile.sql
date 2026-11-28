-- 20261128T0200_scm_drivers_outsource_profile.sql
--
-- WHY. Outsource / 3PL drivers log in to upload POD from the Last Mile phone
-- app (position "Outsource Transporter", slug outsource_transporter, linked to
-- an scm.drivers row by the sync_user_to_tms trigger). The OFFICE maintains a
-- small profile for each of them (owner 2026-11-28): a photo, licence number
-- and expiry, home address, and an emergency contact. name / phone / IC already
-- live on scm.drivers; this adds the rest.
--
-- Every column is NULLABLE with no default and no backfill: an existing driver
-- simply has a blank profile until the office fills it in. The photo itself is
-- an object in POD_BUCKET (R2); the column holds only its key, the same shape
-- as users.profile_pic_r2_key.
--
-- These are plain profile fields on the shared, cross-company fleet roster, so
-- there is no company-scope or grant consequence to restore. RE-CHECK THE
-- NUMBER AT MERGE.
--
-- REVERSAL:
--   ALTER TABLE scm.drivers
--     DROP COLUMN IF EXISTS photo_r2_key,
--     DROP COLUMN IF EXISTS license_no,
--     DROP COLUMN IF EXISTS license_expiry,
--     DROP COLUMN IF EXISTS address,
--     DROP COLUMN IF EXISTS emergency_contact_name,
--     DROP COLUMN IF EXISTS emergency_contact_phone;
--   Dropping them erases every outsource-driver profile the office has entered
--   (photos stay in R2 but become unreferenced); there is no other copy.

ALTER TABLE scm.drivers
  ADD COLUMN IF NOT EXISTS photo_r2_key            text,
  ADD COLUMN IF NOT EXISTS license_no              text,
  ADD COLUMN IF NOT EXISTS license_expiry          date,
  ADD COLUMN IF NOT EXISTS address                 text,
  ADD COLUMN IF NOT EXISTS emergency_contact_name  text,
  ADD COLUMN IF NOT EXISTS emergency_contact_phone text;
