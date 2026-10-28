-- 027_password_resets.sql
-- Admin-initiated password reset flow for staff users.
--
-- Distinct from `invitations` because:
--   • Invitations promote a placeholder user to active; resets work on
--     an already-active account.
--   • Reset tokens should be short-lived (1 hour) vs invitations (14d).
--   • A reset leaves role/permissions untouched — only the password
--     hash + session state changes.

CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  -- Who kicked off the reset — an admin, or the user themselves via
  -- a future "forgot password" self-service link.
  requested_by INTEGER,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pr_user ON password_resets(user_id, consumed_at);
CREATE INDEX IF NOT EXISTS idx_pr_token ON password_resets(token);

-- Seed a toggle for the new email channel so admins can mute it.
INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('email.password_reset', '{"value":true}');
