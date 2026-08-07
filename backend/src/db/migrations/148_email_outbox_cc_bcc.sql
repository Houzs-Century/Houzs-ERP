-- 144 — email_outbox gains cc/bcc (D1 TEST tree).
--
-- The production counterpart is migrations-pg/0269_email_outbox_cc_bcc.sql.
-- This tree is test-only (CLAUDE.md), but the outbox tests exercise the real
-- INSERT, so without these columns every send in the suite fails on an unknown
-- column and the failure reads as "no outbox row" rather than "schema drift".
--
-- Kept in step by hand because the two trees have separate numbering; a change
-- to a table the tests touch has to land in both.

ALTER TABLE email_outbox ADD COLUMN cc_address text;
ALTER TABLE email_outbox ADD COLUMN bcc_address text;
