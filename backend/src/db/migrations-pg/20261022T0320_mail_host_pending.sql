-- 20261022T0320_mail_host_pending.sql
-- REVERSAL: ALTER TABLE email_addresses DROP COLUMN IF EXISTS mail_host_status,
--             DROP COLUMN IF EXISTS mail_host_confirmed_at,
--             DROP COLUMN IF EXISTS mail_host_confirmed_by;
--   Revert the code first: lib/mail-provision.ts, routes/mail-personal.ts and
--   the inbound ingest read these columns. Dropping loses which personal
--   addresses are still waiting to be added in Google Workspace.
--   GRANTS: none to re-apply.
--
-- WHAT THIS CHANGES (DEV-03 / PRD T-011 P3, R2):
--   A personal address the ERP provisions (invite, accept-invite, user edit)
--   only receives mail once someone adds it in Google Workspace as an alias of
--   an account mail-sync already reads. The ERP records that step:
--     mail_host_status   NULL     not tracked (the shared mailboxes, and
--                                 personal rows from before this change)
--                        pending  provisioned in the ERP, not yet seen at the host
--                        live     confirmed by an admin, or the first inbound
--                                 mail to the address arrived
--     mail_host_confirmed_at / _by   who marked it, or when mail first arrived
--                                    (by = NULL).
-- No backfill: existing rows stay NULL so nothing appears on the pending list
-- that was set up before the list existed.

ALTER TABLE email_addresses
  ADD COLUMN IF NOT EXISTS mail_host_status text NULL,
  ADD COLUMN IF NOT EXISTS mail_host_confirmed_at text NULL,
  ADD COLUMN IF NOT EXISTS mail_host_confirmed_by integer NULL;

CREATE INDEX IF NOT EXISTS ix_email_addresses_mail_host_pending
  ON email_addresses (created_at) WHERE mail_host_status = 'pending';
