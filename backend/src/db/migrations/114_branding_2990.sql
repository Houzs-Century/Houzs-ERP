-- 114_branding_2990.sql
-- D1 test mirror of migrations-pg/0094 — per-company branding.
-- 2990's branding row (blank placeholders the owner fills in Settings →
-- Branding) + the outbox column that lets a cron-drained retry re-resolve
-- the sending company's identity (NULL = legacy row -> HOUZS).
INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('branding:2990', '{"companyName":"2990''s Home","registrationNo":"","address":"","phone":"","email":"","website":"","logoR2Key":""}');

ALTER TABLE email_outbox ADD COLUMN company_code TEXT;
