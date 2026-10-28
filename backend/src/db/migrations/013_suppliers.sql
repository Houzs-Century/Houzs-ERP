-- 013_suppliers.sql
-- Supplier master table + link to service cases.
--
-- Performance metrics are rolled up lazily on the detail read — keeping
-- them as computed aggregates instead of denormalized columns avoids
-- stale counters when cases move. If rollup cost becomes an issue we can
-- materialize `rating_on_time`, `rating_quality` etc. later.

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,                  -- short internal code, optional
  name TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  category TEXT,                     -- e.g. 'upholstery', 'mattress', 'woodwork'
  -- SLA agreement (nullable → use global defaults)
  sla_response_hours INTEGER,        -- expected acknowledgement time
  sla_completion_hours INTEGER,      -- expected end-to-end service time
  -- Status
  active INTEGER NOT NULL DEFAULT 1, -- 0/1
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers(active);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name);

-- Link ASSR cases to a supplier record. The free-text `supplier` column
-- stays for legacy rows; new assignments should use supplier_id.
ALTER TABLE assr_cases ADD COLUMN supplier_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_assr_supplier_id ON assr_cases(supplier_id);

-- Communication history (anything worth remembering for the relationship:
-- calls, emails, meeting notes). Case-scoped rows link to assr_cases;
-- supplier-scoped rows have assr_id = NULL.
CREATE TABLE IF NOT EXISTS supplier_communications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL,
  assr_id INTEGER,
  channel TEXT,                      -- 'phone' | 'email' | 'visit' | 'other'
  direction TEXT,                    -- 'inbound' | 'outbound'
  subject TEXT,
  body TEXT,
  user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
  FOREIGN KEY (assr_id) REFERENCES assr_cases(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_sc_supplier ON supplier_communications(supplier_id);
CREATE INDEX IF NOT EXISTS idx_sc_assr ON supplier_communications(assr_id);
