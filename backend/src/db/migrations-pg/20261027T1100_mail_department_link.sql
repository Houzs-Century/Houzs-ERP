-- 20261027T1100_mail_department_link.sql
-- REVERSAL: DROP INDEX IF EXISTS ix_email_addresses_department;
--           ALTER TABLE email_addresses DROP COLUMN IF EXISTS department_id;
--   Revert the code first: routes/mail-center.ts (getMailScope, /addresses)
--   and routes/mail-personal.ts (/directory) read this column. Dropping it
--   leaves every department mailbox reachable by explicit grant only.
--   GRANTS: none to re-apply.
--
-- WHAT THIS CHANGES (HC-0157 B):
--   A department mailbox (no owner) is tied to an Org Chart department by id.
--   Before this, the link was the free-text assigned_dept ("Sales") compared
--   with the person's department name ("Sales Department"), which never
--   matched, so department-level access reached nothing.
--   Personal mailboxes keep department_id NULL; the code clears it whenever
--   a mailbox is given an owner, so a department never reaches personal mail.
--
-- Backfill: an unowned mailbox whose assigned_dept is contained in exactly one
-- department name gets that department (finance -> Finance Department). No
-- match or several matches stay NULL for an admin to pick on Team, Mailboxes.

ALTER TABLE email_addresses
  ADD COLUMN IF NOT EXISTS department_id integer NULL
    REFERENCES departments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_email_addresses_department
  ON email_addresses (department_id) WHERE department_id IS NOT NULL;

UPDATE email_addresses ea
   SET department_id = m.department_id
  FROM (
    SELECT e.id, min(d.id) AS department_id, count(*) AS matches
      FROM email_addresses e
      JOIN departments d
        ON strpos(lower(d.name), lower(trim(e.assigned_dept))) > 0
     WHERE e.assigned_user_id IS NULL
       AND trim(COALESCE(e.assigned_dept, '')) <> ''
     GROUP BY e.id
  ) m
 WHERE ea.id = m.id
   AND m.matches = 1
   AND ea.department_id IS NULL;
