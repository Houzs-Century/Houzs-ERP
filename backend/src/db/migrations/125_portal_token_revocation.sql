-- D1 test mirror of migrations-pg/0126_portal_token_revocation.sql.
-- The reasoning lives in that file; this only keeps the vitest D1 schema in
-- step so the revocation + survey-expiry suites exercise the real columns.
--
-- No `IF NOT EXISTS` on the column adds and no expires_at add: D1 here is a
-- from-scratch schema built by replaying these files in order (vitest.config
-- readD1Migrations), not a live database with drift to defend against.
-- case_track_tokens is rebuilt by 111 without revoked_at, and 015 already
-- declares assr_survey_tokens.expires_at.
ALTER TABLE case_track_tokens ADD COLUMN revoked_at TEXT;

-- Mirrors the prod backfill. Matches nothing on a fresh test DB (no rows), and
-- exists so the D1 replay and the Postgres tree cannot silently disagree about
-- what this migration number means.
UPDATE assr_survey_tokens
   SET expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+90 days')
 WHERE expires_at IS NULL
   AND submitted_at IS NULL
   AND created_at IS NOT NULL;
