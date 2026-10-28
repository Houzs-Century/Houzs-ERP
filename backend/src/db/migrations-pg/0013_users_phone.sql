-- Add a contact phone number to workspace users (owner ask: capture phone on
-- invite, alongside name/email/department/position/report-to). Nullable text;
-- no backfill. Idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;
