-- 176_users_password_change_required -- D1 test mirror of
-- migrations-pg/20261110T1500_users_password_change_required.
-- NULL = no change required (today's behaviour); set = the next password
-- sign-in opens a session restricted to the change-password screen.

ALTER TABLE users ADD COLUMN password_change_required_at TEXT;
