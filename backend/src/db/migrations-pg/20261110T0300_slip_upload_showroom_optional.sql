-- 20261110T0300_slip_upload_showroom_optional.sql
-- A photo upload (driver proof-of-delivery, run-sheet job photo, payment slip)
-- opens a scm.pending_slip_uploads row first, and that row demanded a showroom:
-- /slips/init answered 400 "no_active_showroom" for a company with no active
-- showroom, and the receipt scan dropped its slip with no word. Nothing reads
-- showroom_id back (the consumers read r2_key + status; the reaper reads
-- status + expires_at), so the column becomes optional. The FK stays: a
-- showroom is still stamped when the company has one.
--
-- Verified against prod with dump-scm-schema.yml run 42635335025 (2026-11-09):
-- showroom_id uuid NOT NULL, FK pending_slip_uploads_showroom_id_showrooms_id_fk.
-- No view, trigger or function reads the column.
--
-- REVERSAL: ALTER TABLE scm.pending_slip_uploads ALTER COLUMN showroom_id SET NOT NULL;
--   only once every row has one (UPDATE the NULL rows to a showroom first, or
--   delete expired NULL rows; the reaper removes unpromoted ones within a day).
-- RE-CHECK THE NUMBER AT MERGE.

ALTER TABLE scm.pending_slip_uploads ALTER COLUMN showroom_id DROP NOT NULL;
