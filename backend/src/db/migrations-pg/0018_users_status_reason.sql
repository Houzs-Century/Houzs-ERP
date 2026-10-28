-- User Management: optional note recording WHY an account was disabled.
-- Additive + nullable so applying to the live DB is always safe. Cleared
-- automatically by the app when an account is re-enabled.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_reason text;
