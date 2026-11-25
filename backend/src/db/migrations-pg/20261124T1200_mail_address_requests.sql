-- 20261124T1200_mail_address_requests.sql
-- REVERSAL: DROP TABLE IF EXISTS mail_address_requests;
--   Revert the code first (routes/mail-claim.ts reads and writes it). Dropping
--   loses the open and decided address requests; no mailbox is touched.
--   GRANTS: none to re-apply.
--
-- WHAT THIS CHANGES (owner 2026-11-24): every company address is a free alias of
-- hello@ in Google Workspace, and one account holds a limited number, so a
-- member's claim of their own address becomes a request a Mail Center admin
-- approves (the mailbox is made then) or rejects with a reason.
--   status  requested | approved | rejected

CREATE TABLE IF NOT EXISTS mail_address_requests (
  id                      text PRIMARY KEY,
  company_id              integer NOT NULL,
  user_id                 integer NOT NULL,
  address                 text NOT NULL,
  requested_department_id integer NULL,
  status                  text NOT NULL DEFAULT 'requested'
                            CHECK (status IN ('requested', 'approved', 'rejected')),
  reason                  text NULL,
  decided_by              integer NULL,
  decided_at              text NULL,
  created_at              text NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_mail_address_requests_open
  ON mail_address_requests (company_id, created_at) WHERE status = 'requested';
CREATE INDEX IF NOT EXISTS ix_mail_address_requests_user
  ON mail_address_requests (user_id, created_at);
-- One open request per person.
CREATE UNIQUE INDEX IF NOT EXISTS ux_mail_address_requests_open_user
  ON mail_address_requests (user_id) WHERE status = 'requested';
