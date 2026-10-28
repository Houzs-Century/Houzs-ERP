-- 026_payment_and_stock.sql
-- Two additions from the v2.0 architecture gap audit:
--   • Payment workflow — a named state machine distinct from the
--     finance ledger. Tracks the rental payment lifecycle that
--     actually blocks an event from progressing in real life.
--   • Stock Transfer as a first-class record — OUT at setup,
--     RETURN at teardown, with explicit confirmation. Today it's
--     only a vague attachment category.

-- ── Payment workflow ──────────────────────────────────────────
-- Status vocabulary:
--   not_started      — no payment action yet (default)
--   deposit_paid     — security deposit paid to organizer
--   paid             — full rental paid
--   refund_pending   — event done, waiting on deposit refund
--   refunded         — deposit refunded to us
-- Transitions are open (any → any) because real life is messy; the
-- UI surfaces the happy path but accepts corrections.

ALTER TABLE projects ADD COLUMN payment_status TEXT DEFAULT 'not_started';
ALTER TABLE projects ADD COLUMN payment_proof_r2_key TEXT;          -- optional rental-proof image
ALTER TABLE projects ADD COLUMN payment_proof_file_name TEXT;
ALTER TABLE projects ADD COLUMN payment_notes TEXT;
ALTER TABLE projects ADD COLUMN payment_updated_at TEXT;
ALTER TABLE projects ADD COLUMN payment_updated_by INTEGER;

CREATE INDEX IF NOT EXISTS idx_projects_payment ON projects(payment_status);

-- Backfill: existing rows default to not_started, which matches the
-- column default and requires no data touch-up.

-- ── Stock transfers ───────────────────────────────────────────
-- One row per physical transfer. `direction` separates OUT (to the
-- venue before setup) from RETURN (back to warehouse after
-- dismantle). `confirmed_at` nulls out until someone verifies the
-- count — that's what turns the row from a claim into a record.

CREATE TABLE IF NOT EXISTS project_stock_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('out', 'return')),
  transferred_at TEXT,                   -- ISO datetime when the move happened
  record_r2_key TEXT,                    -- optional photo/PDF of the transfer sheet
  file_name TEXT,
  mime_type TEXT,
  notes TEXT,
  -- Confirmation = "someone verified this actually happened".
  confirmed_at TEXT,
  confirmed_by INTEGER,                  -- users.id
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  archived_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pst_project ON project_stock_transfers(project_id, direction);
