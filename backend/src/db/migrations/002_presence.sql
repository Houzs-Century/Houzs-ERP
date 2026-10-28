-- ═══════════════════════════════════════
-- Migration 002 — User presence (last_seen_at)
-- Idempotent: ignores the duplicate-column error if re-run.
-- ═══════════════════════════════════════

ALTER TABLE users ADD COLUMN last_seen_at TEXT;
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at);
