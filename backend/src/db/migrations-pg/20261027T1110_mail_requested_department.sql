-- 20261027T1110_mail_requested_department.sql
-- REVERSAL: ALTER TABLE email_addresses DROP COLUMN IF EXISTS requested_department_id;
--   Revert the code first: routes/mail-personal.ts (/claim, /mail-host/pending)
--   reads this column. Dropping it loses which department each person asked
--   for when they claimed their address.
--   GRANTS: none to re-apply.
--
-- WHAT THIS CHANGES (HC-0157 A):
--   A member with no company address claims one in Mail Center and, when the
--   Org Chart has no department for them yet, says which department they work
--   in. The request is kept here and shown to the admin on Team, Mailboxes
--   next to "Mark added"; the admin puts the person in the department through
--   the member screen. Nothing reads it for access.
-- No backfill.

ALTER TABLE email_addresses
  ADD COLUMN IF NOT EXISTS requested_department_id integer NULL
    REFERENCES departments(id) ON DELETE SET NULL;
