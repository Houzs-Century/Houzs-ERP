-- TOTP two-factor auth (Postgres / prod). Mirror of D1 mig 097.
--
-- Opt-in second factor (RFC 6238 / authenticator apps) for high-privilege
-- accounts. Deliberately NOT forced — the sole-Owner / no-IT setup makes a
-- hard lockout the bigger risk, so a user enables it for themselves and an
-- admin (users.manage) can clear it as the recovery path. Backup codes are a
-- second recovery path the user keeps themselves.
--
--   totp_secret        base32 shared secret (NULL until enrolled)
--   totp_enabled       1 once a code has been verified -> required at login
--   totp_enrolled_at   when it was switched on
--   totp_backup_codes  JSON array of SHA-256 hashes; entries removed as used
--
-- Idempotent (pg-migrate requirement).
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret       text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled      integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enrolled_at  timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backup_codes text;
