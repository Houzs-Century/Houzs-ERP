-- 20261014T1800_scm_pos_logins.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.pos_logins;
--   Revert the code first (routes/pos.ts /pin-login writes a row, services/auth.ts
--   deleteSession stamps logged_out_at). GRANTS: the one GRANT below goes with
--   the table.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- empty table and its indexes; no existing row is written or altered.
--
-- WHY (owner 2026-10-14, part-time sales pay): a part-timer's days at the booth
-- are counted from their POS logins, and the first login of the day is their
-- arrival time (they come 30 minutes to an hour early on the first day to set
-- up). The sessions table cannot answer this — a row is deleted on logout and
-- swept on expiry — so every PIN login is written here, once, by the server at
-- the moment the session is minted, and the logout stamps the matching row.
-- session_sid is the non-reversible session id (services/session-revocation.ts
-- sidFor), never the token.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.pos_logins (
  id            bigserial   PRIMARY KEY,
  company_id    bigint,
  staff_id      uuid        NOT NULL REFERENCES scm.staff(id) ON DELETE CASCADE,
  user_id       bigint      NOT NULL,
  session_sid   text        NOT NULL,
  logged_in_at  timestamptz NOT NULL DEFAULT now(),
  logged_out_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_pos_logins_staff_time ON scm.pos_logins (staff_id, logged_in_at);
CREATE INDEX IF NOT EXISTS idx_pos_logins_company_time ON scm.pos_logins (company_id, logged_in_at);
CREATE INDEX IF NOT EXISTS idx_pos_logins_open_sid ON scm.pos_logins (session_sid) WHERE logged_out_at IS NULL;

-- Same as 0061: RLS on, no policies — anon/authenticated see nothing; the Worker's
-- service_role bypasses RLS.
ALTER TABLE scm.pos_logins ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scm.pos_logins TO service_role;
GRANT USAGE, SELECT ON SEQUENCE scm.pos_logins_id_seq TO service_role;

NOTIFY pgrst, 'reload schema';
