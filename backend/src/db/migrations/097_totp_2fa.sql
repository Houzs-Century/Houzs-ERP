-- 097_totp_2fa.sql (D1/SQLite — vitest + parity). Mirror of
-- migrations-pg/0007_totp_2fa.sql. Opt-in TOTP second factor for
-- high-privilege accounts. NOT forced (sole-Owner lockout risk); an admin
-- with users.manage clears it as recovery, plus per-user backup codes.
--   totp_secret        base32 shared secret (NULL until enrolled)
--   totp_enabled       1 once verified -> required at login
--   totp_enrolled_at   when switched on
--   totp_backup_codes  JSON array of SHA-256 hashes; removed as used
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_enrolled_at TEXT;
ALTER TABLE users ADD COLUMN totp_backup_codes TEXT;
