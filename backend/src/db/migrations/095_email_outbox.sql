-- 095_email_outbox.sql (D1/SQLite — vitest + parity). Mirror of
-- migrations-pg/0005_email_outbox.sql. Durable email queue: sendEmail enqueues
-- + tries immediately; the */5 cron drains pending rows (≤3 attempts) so a
-- transient Resend failure no longer silently drops invites/resets/surveys.
CREATE TABLE IF NOT EXISTS email_outbox (
  id          TEXT PRIMARY KEY,
  to_address  TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body_html   TEXT,
  body_text   TEXT,
  purpose     TEXT,
  ref_type    TEXT,
  ref_id      INTEGER,
  reply_to    TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  sent_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_outbox_pending ON email_outbox (created_at) WHERE status = 'pending';
