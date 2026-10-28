-- 055_houzs_points.sql
--
-- Houzs Points — gamification foundation (Phase 1).
--
-- Two pools per user:
--   • points_balance   — earned, accumulating, spendable in the future
--                        award shop and never sendable to others.
--   • gifting_balance  — monthly allowance, non-accumulating. Sendable
--                        to peers only. Resets on the 1st of each month
--                        via a dedicated cron tick.
--
-- All balance changes go through `point_transactions` (append-only
-- ledger). The two columns on `users` are derived/cached for fast
-- reads — never written directly outside services/points.ts.
--
-- Streaks are weekly (ISO week). One row per user per week records the
-- raw upvotes/gift-receipts that count toward the threshold; the
-- nightly cron computes the user's current consecutive-qualified-week
-- run and stamps it on `users.current_streak`.
--
-- Migrations are immutable: fix forward in a new file if anything
-- here turns out wrong.

-- ── Per-user balances (cached on users) ──────────────────────────
ALTER TABLE users ADD COLUMN points_balance   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN gifting_balance  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN gifting_reset_at TEXT;
ALTER TABLE users ADD COLUMN current_streak   INTEGER NOT NULL DEFAULT 0;

-- ── Append-only ledger ──────────────────────────────────────────
CREATE TABLE point_transactions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              INTEGER NOT NULL REFERENCES users(id),
  pool                 TEXT NOT NULL CHECK (pool IN ('earned','gifting')),
  delta                INTEGER NOT NULL,
  reason               TEXT NOT NULL,
  ref_type             TEXT,
  ref_id               INTEGER,
  counterparty_user_id INTEGER REFERENCES users(id),
  note                 TEXT,
  created_at           TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_point_tx_user_created ON point_transactions(user_id, created_at DESC);
CREATE INDEX idx_point_tx_reason       ON point_transactions(reason, created_at DESC);

-- ── Weekly streak tally (one row per user per ISO week) ─────────
CREATE TABLE user_streak_weeks (
  user_id        INTEGER NOT NULL REFERENCES users(id),
  iso_week       TEXT    NOT NULL,
  upvotes_count  INTEGER NOT NULL DEFAULT 0,
  qualified      INTEGER NOT NULL DEFAULT 0,
  computed_at    TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, iso_week)
);

-- ── Cached leaderboard rows ─────────────────────────────────────
-- Keyed by (scope, period). `scope` is 'company' or 'department:{id}';
-- `period` is 'week' | 'month' | 'all'. The cached row is a JSON
-- payload of the top N ranks; refreshed by the daily cron.
CREATE TABLE leaderboard_cache (
  scope        TEXT NOT NULL,
  period       TEXT NOT NULL,
  computed_at  TEXT NOT NULL,
  rows_json    TEXT NOT NULL,
  PRIMARY KEY (scope, period)
);

-- ── Admin-tunable settings ──────────────────────────────────────
-- Single key/value table so HR can change point values + thresholds
-- without a deploy. Values are stored as TEXT and parsed on read.
CREATE TABLE gamify_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO gamify_settings(key, value) VALUES
  ('monthly_gifting_amount',       '100'),
  ('streak_weekly_threshold',      '5'),
  ('points.innovation_shipped',    '500'),
  ('points.suggestion_approved',   '50'),
  ('points.upvote_received',       '5'),
  ('points.gift_min',              '5'),
  ('points.gift_max',              '100');

-- ── Seed: grant every existing user the current month's gifting pool ─
-- New users get this on first login (or via the monthly cron). Keying
-- gifting_reset_at to the current YYYY-MM keeps the monthly cron
-- idempotent — re-runs in the same month no-op.
UPDATE users
   SET gifting_balance  = 100,
       gifting_reset_at = strftime('%Y-%m', datetime('now')) || '-01';
