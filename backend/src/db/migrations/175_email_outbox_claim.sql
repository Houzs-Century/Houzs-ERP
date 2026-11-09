-- 175 — email_outbox.claimed_at, the send lease (D1 TEST tree).
--
-- The production counterpart is migrations-pg/20261110T0100_email_outbox_claim.sql.
-- SQLite stores the lease as ISO text; services/email.ts writes and compares ISO strings.

ALTER TABLE email_outbox ADD COLUMN claimed_at text;
