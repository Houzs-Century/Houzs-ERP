-- 019_supplier_portal.sql
-- Supplier Portal — separate auth realm for 3PL / service supplier
-- partners. Each supplier_accounts row is ONE person at a supplier;
-- several accounts can belong to one supplier (e.g. owner + workshop
-- manager). Sessions + invitations follow the same pattern as the
-- staff realm. Supplier users authenticate with email + password and
-- receive a bearer token with 30-day TTL.

CREATE TABLE IF NOT EXISTS supplier_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL,      -- FK → suppliers.id
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  password_hash TEXT,                -- NULL until invite accepted
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK(status IN ('invited','active','disabled')),
  last_login_at TEXT,
  created_by INTEGER,                -- staff user_id
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_supplier_accounts_supplier ON supplier_accounts(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_accounts_status   ON supplier_accounts(status);

CREATE TABLE IF NOT EXISTS supplier_sessions (
  token TEXT PRIMARY KEY,
  supplier_account_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (supplier_account_id) REFERENCES supplier_accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_supplier_sessions_exp ON supplier_sessions(expires_at);

CREATE TABLE IF NOT EXISTS supplier_invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  supplier_account_id INTEGER NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'setup'
    CHECK(purpose IN ('setup','reset')),
  created_by INTEGER,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (supplier_account_id) REFERENCES supplier_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_supplier_invitations_account
  ON supplier_invitations(supplier_account_id);

-- Supplier-facing status workflow on a case. Parallel to the internal
-- `stage` column — staff track the overall case lifecycle, supplier
-- tracks what they're doing with the unit.
--
-- Workflow (from QMS spec §6.3):
--   NULL / 'pending' → supplier assigned, hasn't picked up yet
--   'picked_up'      → unit collected
--   'in_repair'      → work in progress
--   'ready'          → ready for pickup / delivery back
--   'delivered'      → returned to Houzs / customer
--   'cannot_repair'  → escalation path
ALTER TABLE assr_cases ADD COLUMN supplier_job_status TEXT
  CHECK(supplier_job_status IS NULL OR supplier_job_status IN
    ('pending','picked_up','in_repair','ready','delivered','cannot_repair'));
ALTER TABLE assr_cases ADD COLUMN supplier_job_updated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_assr_supplier_job_status
  ON assr_cases(supplier_job_status);
