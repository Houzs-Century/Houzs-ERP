-- Email outbox (reliability layer). Today every Resend call is fire-and-forget
-- inside the request; a transient 5xx silently drops the invite/reset/survey.
-- The outbox decouples WRITE from SEND: sendEmail() inserts a row + attempts an
-- immediate delivery; on failure the row stays 'pending' and the */5 cron drains
-- it with up to 3 attempts, then 'failed'. email_log stays the per-attempt audit.
-- Idempotent (pg-migrate requirement).
CREATE TABLE IF NOT EXISTS email_outbox (
  id          text PRIMARY KEY,
  to_address  text NOT NULL,
  subject     text NOT NULL,
  body_html   text,
  body_text   text,
  purpose     text,
  ref_type    text,
  ref_id      integer,
  reply_to    text,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);

-- Partial index keeps the cron's "next batch" lookup tiny (only pending rows).
CREATE INDEX IF NOT EXISTS idx_email_outbox_pending ON email_outbox (created_at) WHERE status = 'pending';
