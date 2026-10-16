-- 20261016T0910_auth_failed_logins.sql
-- REVERSAL: DROP TABLE IF EXISTS public.auth_failed_logins;
--   Revert the code first: services/failedLogins.ts writes it (from
--   routes/auth.ts /login and /totp/login) and routes/systemHealthLogins.ts
--   reads it. Dropping it loses only the failed-login history; sign-in itself
--   never reads this table. GRANTS: none to restore (this file only revokes
--   anon / authenticated; service_role keeps the schema default).
--
-- WHAT THIS CHANGES: one new empty table and two indexes; nothing altered.
--
-- WHY (DEV-35, IT System Health). Failed sign-ins were not saved anywhere, so IT
-- could not see a password-guessing run against one account or from one
-- address. One row per failed attempt: who was tried (email, and the account
-- when the email matched one), from which IP, and which check failed. The
-- attempted password and 2FA code are never stored. Rows older than 90 days are
-- deleted by pruneFailedLogins (daily cron).
--
-- email is NULL for 2FA-step failures that happen before the account is known
-- (expired challenge, 2FA rate limit). user_id has no foreign key on purpose:
-- the history must outlive a deleted user.
-- Houzs conventions: additive, IF NOT EXISTS, re-runnable; no inner BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS public.auth_failed_logins (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  email       text,
  user_id     bigint,
  ip          text,
  reason      text        NOT NULL CHECK (reason IN (
                'rate_limited', 'unknown_email', 'no_password', 'wrong_password', 'disabled',
                'totp_rate_limited', 'totp_expired', 'totp_unavailable', 'totp_failed'))
);
CREATE INDEX IF NOT EXISTS idx_auth_failed_logins_created_at ON public.auth_failed_logins (created_at);
CREATE INDEX IF NOT EXISTS idx_auth_failed_logins_email ON public.auth_failed_logins (email);

-- Emails and IPs: never readable through the PostgREST anon / authenticated
-- roles. RLS is deliberately not enabled, same as ai_usage_events and
-- client_errors: the prod Hyperdrive role is not named in this repo (see 0191),
-- and an RLS table with no policy would silently refuse it if it is not the
-- owner, losing every row.
REVOKE ALL ON public.auth_failed_logins FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON public.auth_failed_logins FROM anon; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON public.auth_failed_logins FROM authenticated; END IF; END $$;
