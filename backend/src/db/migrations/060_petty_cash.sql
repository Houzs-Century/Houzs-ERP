-- 060_petty_cash.sql
--
-- Petty cash ledger. Single global float for v1 — every entry is
-- either an inflow ('in', e.g. monthly top-up) or an outflow ('out',
-- e.g. parking, courier). Running balance = SUM(signed amount).
--
-- amount_cents is always positive; the sign comes from `direction`.
-- This keeps reports honest ("total in / total out / net") without
-- having to filter on negative numbers.
--
-- Receipt photo lives in R2 under petty-cash/{id}/{ts}-{name}.
--
-- Soft delete via archived_at preserves audit trail. Edits are not
-- versioned in v1 — admin reasons are captured in `note` if needed.
--
-- Migrations are immutable.

CREATE TABLE IF NOT EXISTS petty_cash_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  category        TEXT,
  counterparty    TEXT,
  note            TEXT,
  receipt_r2_key  TEXT,
  posted_by       INTEGER NOT NULL REFERENCES users(id),
  occurred_on     TEXT NOT NULL,
  archived_at     TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_petty_cash_occurred
  ON petty_cash_entries(occurred_on DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_petty_cash_archived
  ON petty_cash_entries(archived_at);
CREATE INDEX IF NOT EXISTS idx_petty_cash_category
  ON petty_cash_entries(category);
