-- D1 test mirror of migrations-pg/0120_session_origin.sql.
ALTER TABLE sessions ADD COLUMN origin TEXT;
