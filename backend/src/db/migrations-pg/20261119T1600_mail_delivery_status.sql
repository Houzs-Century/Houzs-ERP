-- 20261119T1600_mail_delivery_status.sql
-- DID THE EMAIL ARRIVE (HC-0247).
--
-- A Mail Center send to a mistyped address bounced and nobody knew, so the
-- order behind it stalled. The 5-minute cron now asks Resend for each recent
-- outbound message's last event and stores it here; the thread shows
-- "Delivered" or "Bounced", and the sender gets a bell notice on a bounce.
--
-- delivery_status holds Resend's last_event as given (sent, delivered,
-- delivery_delayed, bounced, complained, ...); NULL = not asked yet. The cron
-- stops asking once it is final (lib/mail-delivery.ts FINAL_DELIVERY_EVENTS).
--
-- HOUSE STYLE. Additive, nullable, idempotent. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL: DROP INDEX IF EXISTS ix_email_messages_outbound_created;
--           ALTER TABLE email_messages DROP COLUMN IF EXISTS delivery_status_at;
--           ALTER TABLE email_messages DROP COLUMN IF EXISTS delivery_status;
--   Only together with the code that reads them (lib/mail-delivery.ts, routes/mail-center.ts).

ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS delivery_status text NULL,
  ADD COLUMN IF NOT EXISTS delivery_status_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS ix_email_messages_outbound_created
  ON email_messages (created_at)
  WHERE direction = 'outbound';

COMMENT ON COLUMN email_messages.delivery_status IS
  'Resend last_event for an outbound message (delivered, bounced, ...), NULL until the cron has asked. Read by deliveryStatus() in lib/mail-delivery.ts.';
