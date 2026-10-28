-- ═══════════════════════════════════════
-- Migration 005 — Fleet management
--
-- Extends users (driver/helper profiles, salary), lorries (capacity,
-- compliance, maintenance), and trips (helpers, clock). Adds tables
-- for clock records, daily inspections, maintenance, compliance,
-- incidents, and salary computation.
--
-- Idempotent: ALTERs ignore duplicate-column errors on re-run.
-- ═══════════════════════════════════════

-- ── Users: driver/helper profile fields ──────────────────────────
ALTER TABLE users ADD COLUMN user_type TEXT DEFAULT 'staff'
  CHECK(user_type IN ('staff','driver','helper','dispatcher','admin'));
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN ic_number TEXT;
ALTER TABLE users ADD COLUMN license_no TEXT;
ALTER TABLE users ADD COLUMN license_expiry TEXT;
ALTER TABLE users ADD COLUMN emergency_contact_name TEXT;
ALTER TABLE users ADD COLUMN emergency_contact_phone TEXT;
ALTER TABLE users ADD COLUMN base_salary REAL DEFAULT 0;
ALTER TABLE users ADD COLUMN trip_allowance_rate REAL DEFAULT 0;
ALTER TABLE users ADD COLUMN ot_rate REAL DEFAULT 0;
ALTER TABLE users ADD COLUMN max_continuous_hours REAL DEFAULT 8;

CREATE INDEX IF NOT EXISTS idx_users_type ON users(user_type);

-- ── Lorries: capacity + compliance ───────────────────────────────
ALTER TABLE lorries ADD COLUMN model TEXT;
ALTER TABLE lorries ADD COLUMN purchase_date TEXT;
ALTER TABLE lorries ADD COLUMN capacity_m3 REAL;
ALTER TABLE lorries ADD COLUMN capacity_kg REAL;
ALTER TABLE lorries ADD COLUMN road_tax_expiry TEXT;
ALTER TABLE lorries ADD COLUMN insurance_expiry TEXT;
ALTER TABLE lorries ADD COLUMN puspakom_expiry TEXT;
ALTER TABLE lorries ADD COLUMN status TEXT DEFAULT 'active'
  CHECK(status IN ('active','maintenance','retired'));

-- ── Trips: helpers + clock ───────────────────────────────────────
ALTER TABLE trips ADD COLUMN helper_1_id INTEGER REFERENCES users(id);
ALTER TABLE trips ADD COLUMN helper_2_id INTEGER REFERENCES users(id);
ALTER TABLE trips ADD COLUMN helper_outsourced INTEGER DEFAULT 0;
ALTER TABLE trips ADD COLUMN clock_in_at TEXT;
ALTER TABLE trips ADD COLUMN clock_out_at TEXT;

-- ── Driver clock records (per day, independent of trips) ─────────
CREATE TABLE IF NOT EXISTS driver_clock_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  clock_date TEXT NOT NULL,
  clock_in TEXT NOT NULL,
  clock_out TEXT,
  total_hours REAL,
  rest_minutes REAL DEFAULT 0,
  is_overtime INTEGER DEFAULT 0,
  fatigue_alert INTEGER DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, clock_date),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_clock_user ON driver_clock_records(user_id);
CREATE INDEX IF NOT EXISTS idx_clock_date ON driver_clock_records(clock_date);

-- ── Daily inspections ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lorry_id INTEGER NOT NULL,
  driver_user_id INTEGER NOT NULL,
  inspection_date TEXT NOT NULL,
  checklist_json TEXT NOT NULL DEFAULT '{}',
  passed INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  photo_r2_keys TEXT DEFAULT '[]',
  submitted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(lorry_id, inspection_date),
  FOREIGN KEY (lorry_id) REFERENCES lorries(id),
  FOREIGN KEY (driver_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_inspection_lorry ON daily_inspections(lorry_id);
CREATE INDEX IF NOT EXISTS idx_inspection_date ON daily_inspections(inspection_date);

-- ── Lorry maintenance / service records ──────────────────────────
CREATE TABLE IF NOT EXISTS lorry_maintenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lorry_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('service','repair','inspection','other')),
  description TEXT,
  cost REAL DEFAULT 0,
  vendor_name TEXT,
  invoice_r2_key TEXT,
  maintenance_date TEXT NOT NULL,
  unavailable_from TEXT,
  unavailable_to TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (lorry_id) REFERENCES lorries(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_maint_lorry ON lorry_maintenance(lorry_id);
CREATE INDEX IF NOT EXISTS idx_maint_unavail ON lorry_maintenance(unavailable_from, unavailable_to);

-- ── Lorry compliance documents (PUSPAKOM, road tax, insurance) ───
CREATE TABLE IF NOT EXISTS lorry_compliance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lorry_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL CHECK(doc_type IN ('puspakom','road_tax','insurance')),
  expiry_date TEXT NOT NULL,
  renewal_date TEXT,
  document_r2_key TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (lorry_id) REFERENCES lorries(id)
);

CREATE INDEX IF NOT EXISTS idx_compliance_lorry ON lorry_compliance(lorry_id);
CREATE INDEX IF NOT EXISTS idx_compliance_expiry ON lorry_compliance(expiry_date);

-- ── Lorry incidents & claims ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS lorry_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lorry_id INTEGER NOT NULL,
  trip_id INTEGER,
  incident_date TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('damage','accident','claim','other')),
  description TEXT,
  cost_estimate REAL DEFAULT 0,
  photo_r2_keys TEXT DEFAULT '[]',
  insurance_claim_ref TEXT,
  claim_status TEXT DEFAULT 'none'
    CHECK(claim_status IN ('none','filed','approved','rejected','settled')),
  liability TEXT DEFAULT 'houzs'
    CHECK(liability IN ('houzs','vendor','driver','shared')),
  resolved_at TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (lorry_id) REFERENCES lorries(id),
  FOREIGN KEY (trip_id) REFERENCES trips(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_incident_lorry ON lorry_incidents(lorry_id);
CREATE INDEX IF NOT EXISTS idx_incident_date ON lorry_incidents(incident_date);

-- ── Salary records (monthly aggregate per user) ──────────────────
CREATE TABLE IF NOT EXISTS salary_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  period TEXT NOT NULL,                -- YYYY-MM
  base_pay REAL DEFAULT 0,
  trip_count INTEGER DEFAULT 0,
  trip_allowance_total REAL DEFAULT 0,
  ot_hours REAL DEFAULT 0,
  ot_amount REAL DEFAULT 0,
  deductions_json TEXT DEFAULT '[]',
  deductions_total REAL DEFAULT 0,
  gross REAL DEFAULT 0,
  net REAL DEFAULT 0,
  status TEXT DEFAULT 'draft'
    CHECK(status IN ('draft','confirmed','paid')),
  confirmed_by INTEGER,
  confirmed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, period),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (confirmed_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_salary_user ON salary_records(user_id);
CREATE INDEX IF NOT EXISTS idx_salary_period ON salary_records(period);

-- ── Salary trip lines (per-trip breakdown) ───────────────────────
CREATE TABLE IF NOT EXISTS salary_trip_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  salary_record_id INTEGER,
  user_id INTEGER NOT NULL,
  trip_id INTEGER NOT NULL,
  trip_date TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('driver','helper')),
  trip_allowance REAL DEFAULT 0,
  ot_hours REAL DEFAULT 0,
  ot_amount REAL DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, trip_id),
  FOREIGN KEY (salary_record_id) REFERENCES salary_records(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (trip_id) REFERENCES trips(id)
);

CREATE INDEX IF NOT EXISTS idx_salary_line_user ON salary_trip_lines(user_id);
CREATE INDEX IF NOT EXISTS idx_salary_line_trip ON salary_trip_lines(trip_id);

-- ── Default inspection checklist (configurable) ──────────────────
INSERT OR IGNORE INTO system_settings (key, value) VALUES
  ('inspection_checklist', '["Tyres","Brakes","Lights","Mirrors","Horn","Wipers","Fuel level","Body condition","Load secured"]'),
  ('logistics_budget_pct', '3'),
  ('fatigue_max_hours', '8');
