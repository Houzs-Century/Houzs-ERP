-- 179_users_totp_last_step -- D1 test mirror of
-- migrations-pg/20261110T2100_users_totp_last_step.
-- The 30-second step of the last accepted two-step code; NULL = none yet.

ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
