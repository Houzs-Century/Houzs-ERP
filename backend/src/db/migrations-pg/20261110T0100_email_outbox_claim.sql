-- 20261110T0100_email_outbox_claim.sql
-- WHO IS SENDING THIS EMAIL RIGHT NOW (same shape as 0315 for the AutoCount outbox).
--
-- THE HOLE. sendEmail() writes the email_outbox row as 'pending' BEFORE it calls
-- Resend, and the 5-minute drain (drainEmailOutbox) took every 'pending' row with
-- no claim and no age filter. A cron tick landing while a request was still
-- sending re-sent that same DO / PO / invoice email, so the customer or supplier
-- could get it twice. Two drains at once had the same race.
--
-- THE FIX. A lease column: sendEmail() writes the row claimed, the drain skips a
-- claim younger than EMAIL_CLAIM_LEASE_MS (services/email.ts) and claims each row
-- with a conditional UPDATE before sending; every outcome clears it. A claim
-- older than the lease is treated as abandoned (Worker killed mid-send) so a row
-- can never be wedged. NULL is the normal state. Not a status: 0005's CHECK keeps
-- its three values and the row stays 'pending' while claimed.
--
-- HOUSE STYLE. Additive, nullable, idempotent. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL: DROP INDEX IF EXISTS email_outbox_claimed_idx;
--           ALTER TABLE email_outbox DROP COLUMN IF EXISTS claimed_at;
--   Only together with the code that reads it (services/email.ts).

ALTER TABLE email_outbox
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz NULL;

COMMENT ON COLUMN email_outbox.claimed_at IS
  'When a sender took this row (sendEmail on insert, or the drain''s conditional claim), NULL when nobody holds it. A LEASE: older than EMAIL_CLAIM_LEASE_MS in services/email.ts means abandoned and it may be taken again. Cleared on every outcome. Not a status.';

CREATE INDEX IF NOT EXISTS email_outbox_claimed_idx
  ON email_outbox (claimed_at)
  WHERE claimed_at IS NOT NULL;
