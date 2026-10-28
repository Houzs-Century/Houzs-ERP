-- 022_email_log.sql
-- Append-only log of every outbound transactional email. Written
-- regardless of whether the underlying Resend call succeeded so you
-- can still trace a missing email to "we tried, it 4xx'd" vs "we never
-- tried in the first place".

CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- What the email is *about* (e.g. 'assr_survey', 'supplier_invite',
  -- 'sla_escalation', 'project_due_reminder'). Free-text so we don't
  -- need a migration for a new purpose.
  purpose TEXT NOT NULL,
  -- Optional link back to the domain row that triggered it.
  ref_type TEXT,                     -- 'assr' | 'supplier' | 'project' | ...
  ref_id   INTEGER,
  to_addr TEXT NOT NULL,
  subject TEXT,
  -- Result bookkeeping. status ∈ 'queued' | 'sent' | 'skipped' | 'error'.
  -- 'skipped' is used when emails are disabled or recipient is missing
  -- an address — not a failure, but still worth logging.
  status TEXT NOT NULL,
  provider_id TEXT,                  -- Resend message id when available
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_log_purpose ON email_log(purpose, created_at);
CREATE INDEX IF NOT EXISTS idx_email_log_ref ON email_log(ref_type, ref_id);

-- ── App settings (key/value) ─────────────────────────────────
-- Generic k/v store for runtime toggles the UI wants to flip without
-- a code change. First use: per-channel email toggles. Admins can
-- disable outbound email by purpose (e.g. turn off SLA alerts during
-- a holiday) without having to unset the secret.

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,                        -- JSON-encoded value
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by INTEGER
);

-- Seed default email-enabled flags. Writing them explicitly (rather
-- than defaulting to "on" in code) lets admins see and toggle them
-- straight away in the Settings UI.
INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('email.enabled',                 '{"value":true}'),
  ('email.assr_survey',              '{"value":true}'),
  ('email.assr_sla_escalation',      '{"value":true}'),
  ('email.supplier_invite',          '{"value":true}'),
  ('email.project_due_reminder',     '{"value":true}');
