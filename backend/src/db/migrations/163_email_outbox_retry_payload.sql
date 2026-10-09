-- 163 — email_outbox keeps what a retry needs (D1 TEST tree).
--
-- The production counterpart is migrations-pg/20261009T1600_mail_threading_outbox_retry.sql.
-- email_messages is PG-only here (the Mail Center tests create it inline), so
-- only the outbox half is mirrored.

ALTER TABLE email_outbox ADD COLUMN from_address text;
ALTER TABLE email_outbox ADD COLUMN headers text;
ALTER TABLE email_outbox ADD COLUMN attachments text;
ALTER TABLE email_outbox ADD COLUMN provider_id text;
