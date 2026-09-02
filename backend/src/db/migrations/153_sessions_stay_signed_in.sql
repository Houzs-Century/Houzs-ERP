-- 153_sessions_stay_signed_in — D1 test mirror of migrations-pg/0332.
-- The session's own renewal window in seconds ("Remember me on this device"):
-- NULL = a fixed session that expires, >0 = a rolling one the auth path pushes
-- forward on use. Additive; NULL means today's 7-day behaviour.

ALTER TABLE sessions ADD COLUMN renew_seconds INTEGER;
