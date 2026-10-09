-- 20261009T1600_mail_threading_outbox_retry.sql
-- REVERSAL: ALTER TABLE email_outbox DROP COLUMN IF EXISTS from_address,
--             DROP COLUMN IF EXISTS headers, DROP COLUMN IF EXISTS attachments,
--             DROP COLUMN IF EXISTS provider_id;
--           DROP INDEX IF EXISTS ix_email_messages_outbound_no_msgid;
--           ALTER TABLE email_messages DROP COLUMN IF EXISTS outbox_id;
--   Revert the code first: services/email.ts writes and drains the four outbox
--   columns, lib/mail-threading.ts reads outbox_id and provider_id. Dropping
--   them only loses retry payloads still pending and the queued-message link.
--   GRANTS: none to re-apply — columns and an index ride their table's grants.
--
-- WHAT THIS CHANGES (DEV-03 / PRD T-011 P1):
--   email_outbox.from_address  the Mail Center mailbox a message was sent from.
--                              A cron retry used to go out from no-reply@.
--   email_outbox.headers       JSON object of In-Reply-To / References, so a
--                              retried reply still threads at the customer.
--   email_outbox.attachments   JSON list of {filename, key}; the bytes sit in
--                              R2 (POD_BUCKET) under mail-outbox/<id>/. Written
--                              only when the immediate send failed. A retry
--                              used to deliver the body without the files.
--   email_outbox.provider_id   Resend's id once delivered (also on email_log).
--   email_messages.outbox_id   the outbox row behind a queued Mail Center send,
--                              so the thread can say "queued" / "not delivered"
--                              and pick up Resend's Message-ID after the retry.
--   Partial index for the */5 job that copies Resend's Message-ID onto outbound
--   rows still missing one; without that id a customer's reply opens a new
--   thread.
--
-- Additive, nullable, idempotent. Existing rows read NULL = old behaviour.

ALTER TABLE email_outbox
  ADD COLUMN IF NOT EXISTS from_address text NULL,
  ADD COLUMN IF NOT EXISTS headers      text NULL,
  ADD COLUMN IF NOT EXISTS attachments  text NULL,
  ADD COLUMN IF NOT EXISTS provider_id  text NULL;

ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS outbox_id text NULL;

CREATE INDEX IF NOT EXISTS ix_email_messages_outbound_no_msgid
  ON email_messages (created_at)
  WHERE direction = 'outbound' AND message_id IS NULL;
