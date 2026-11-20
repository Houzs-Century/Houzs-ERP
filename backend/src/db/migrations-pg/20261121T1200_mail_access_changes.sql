-- Mail Center access change log (owner 2026-11-21): every view-level change and
-- every mailbox grant / revoke, with who made it and for whom, so the access page
-- can show "Lim shared anthony@ with Bernard on 21 Nov".
-- REVERSAL: DROP TABLE IF EXISTS mail_access_changes;
CREATE TABLE IF NOT EXISTS mail_access_changes (
  id          text PRIMARY KEY,
  company_id  integer,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  by_user_id  integer,
  user_id     integer NOT NULL,
  change      text NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_access_changes_company_at_idx ON mail_access_changes (company_id, changed_at DESC);
