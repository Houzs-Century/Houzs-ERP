-- 016_customer_portal.sql
-- Customer Portal — separate identity realm from staff. Customers log
-- in, see only their own ASSR cases, add comments and photos. All
-- portal auth lives in its own tables so there is no way a staff token
-- resolves to a customer or vice versa.

-- ── Customer accounts ─────────────────────────────────────────
-- Distinct from `users` (staff) so permission checks and joins never
-- accidentally cross-contaminate. `phone` is kept as a separate column
-- (not a FK) because the same number can legitimately appear on
-- multiple historic sales orders, and we also rely on phone match for
-- auto-linking existing cases on invite-accept.
CREATE TABLE IF NOT EXISTS customer_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  name TEXT,
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK(status IN ('invited','active','disabled')),
  last_login_at TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_customer_accounts_phone ON customer_accounts(phone);
CREATE INDEX IF NOT EXISTS idx_customer_accounts_status ON customer_accounts(status);

-- ── Customer sessions ────────────────────────────────────────
-- Separate from staff `sessions`. A portal bearer token cannot resolve
-- to a staff user because the server only looks here for portal routes.
CREATE TABLE IF NOT EXISTS customer_sessions (
  token TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (customer_id) REFERENCES customer_accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_exp ON customer_sessions(expires_at);

-- ── Invitations / password reset ─────────────────────────────
-- Dispatcher generates a token, sends the URL to the customer via
-- WhatsApp / SMS. Customer clicks, chooses a password, account becomes
-- active. Reset uses the same table with purpose='reset'.
CREATE TABLE IF NOT EXISTS customer_invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'setup'
    CHECK(purpose IN ('setup','reset')),
  created_by INTEGER,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (customer_id) REFERENCES customer_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_customer_invitations_customer
  ON customer_invitations(customer_id);

-- ── Link cases to customers ──────────────────────────────────
-- Authoritative foreign key. Kept NULL-able because historic cases
-- created before a customer signed up have no account; phone-match
-- auto-link fills this in when the customer accepts their invite.
ALTER TABLE assr_cases ADD COLUMN customer_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_assr_cases_customer ON assr_cases(customer_id);

-- ── Mark activity + attachments that originated from the portal ──
-- `assr_activity.user_id` continues to point at staff `users`; we add
-- a parallel `customer_id` so we don't overload the existing column
-- with two different identity namespaces. `source` makes the staff
-- timeline render a "Posted by customer" badge. `visible_to_customer`
-- on attachments lets staff hide internal photos from portal view.
ALTER TABLE assr_activity ADD COLUMN customer_id INTEGER;
ALTER TABLE assr_activity ADD COLUMN source TEXT DEFAULT 'staff'
  CHECK(source IN ('staff','customer','system'));

ALTER TABLE assr_attachments ADD COLUMN customer_id INTEGER;
ALTER TABLE assr_attachments ADD COLUMN source TEXT DEFAULT 'staff'
  CHECK(source IN ('staff','customer','system'));
ALTER TABLE assr_attachments ADD COLUMN visible_to_customer INTEGER DEFAULT 1;
