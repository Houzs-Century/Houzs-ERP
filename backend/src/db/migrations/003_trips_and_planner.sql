-- ═══════════════════════════════════════
-- Migration 003 — Trips, lorries, warehouses, planner proposals
--
-- Adds the full HC Delivery trip-tracking + scheduling-agent stack.
-- All delivery-domain fields live on order_details (local only) so
-- nothing leaks back to AutoCount.
--
-- Idempotent: ALTERs ignore duplicate-column errors when re-run via the
-- migration runner; CREATE TABLE uses IF NOT EXISTS.
-- ═══════════════════════════════════════

-- ── order_details additions ────────────────────────────────────────
ALTER TABLE order_details ADD COLUMN order_type TEXT;            -- delivery|service|pickup|setup|dismantle
ALTER TABLE order_details ADD COLUMN state TEXT;                  -- parsed Malaysian/SG state
ALTER TABLE order_details ADD COLUMN warehouse TEXT;              -- KL|PG|EAST|SABAH|SARAWAK|SG
ALTER TABLE order_details ADD COLUMN proposed_delivery_date TEXT; -- planner output
ALTER TABLE order_details ADD COLUMN lat REAL;
ALTER TABLE order_details ADD COLUMN lng REAL;
ALTER TABLE order_details ADD COLUMN geocoded_at TEXT;

CREATE INDEX IF NOT EXISTS idx_od_warehouse ON order_details(warehouse);
CREATE INDEX IF NOT EXISTS idx_od_state ON order_details(state);
CREATE INDEX IF NOT EXISTS idx_od_proposed_date ON order_details(proposed_delivery_date);

-- ── Warehouses (5 internal + 1 SG hub) ─────────────────────────────
CREATE TABLE IF NOT EXISTS warehouses (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  lat REAL,
  lng REAL,
  is_active INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO warehouses (code, name, address, lat, lng) VALUES
  ('KL',      'KL Warehouse',            'Semenyih, Selangor',        3.0264, 101.7340),
  ('PG',      'PG Warehouse',          'Simpang Ampat, Penang',      5.3007, 100.4273),
  ('SBH',     'Sabah Warehouse',       'Putatan, Sabah',             5.8784, 116.0103),
  ('SRW',     'Sarawak Warehouse',     'Kuching, Sarawak',           1.5806, 110.3762),
  ('SG',      'SG / JB Outsource Hub', 'Johor Bahru',                1.4927, 103.7414);

-- ── State → Warehouse mapping ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS state_warehouse_map (
  state TEXT PRIMARY KEY,
  warehouse TEXT NOT NULL,
  FOREIGN KEY (warehouse) REFERENCES warehouses(code)
);

INSERT OR IGNORE INTO state_warehouse_map (state, warehouse) VALUES
  -- KL warehouse covers central + south + SG transit
  ('Kuala Lumpur',     'KL'),
  ('Selangor',         'KL'),
  ('Putrajaya',        'KL'),
  ('Negeri Sembilan',  'KL'),
  ('Melaka',           'KL'),
  ('Johor',            'KL'),
  -- PG warehouse covers north
  ('Penang',           'PG'),
  ('Pulau Pinang',     'PG'),
  ('Kedah',            'PG'),
  ('Perlis',           'PG'),
  ('Perak',            'PG'),
  -- East coast (ships from KL to Port Klang)
  ('Kelantan',         'KL'),
  ('Terengganu',       'KL'),
  ('Pahang',           'KL'),
  -- Borneo (on hold — ships from KL for now)
  ('Sabah',            'SBH'),
  ('Labuan',           'SBH'),
  ('Sarawak',          'SRW'),
  -- Singapore
  ('Singapore',        'SG');

-- ── Lorries ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lorries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plate TEXT UNIQUE NOT NULL,
  size TEXT,                                  -- 17ft / 21ft / outsource
  warehouse TEXT NOT NULL,
  is_internal INTEGER NOT NULL DEFAULT 1,
  default_driver_user_id INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (warehouse) REFERENCES warehouses(code),
  FOREIGN KEY (default_driver_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_lorries_warehouse ON lorries(warehouse);

-- Seed: 5 internal lorries + 2 outsourced PG lorries
INSERT OR IGNORE INTO lorries (plate, size, warehouse, is_internal) VALUES
  ('KL-21A',     '21ft', 'KL', 1),
  ('KL-21B',     '21ft', 'KL', 1),
  ('KL-17A',     '17ft', 'KL', 1),
  ('PG-17A',     '17ft', 'PG', 1),
  ('PG-17B',     '17ft', 'PG', 1),
  ('W 1591 T',   '17ft', 'PG', 0),
  ('MCF 3084',   '17ft', 'PG', 0);

-- ── Trips ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_no TEXT UNIQUE NOT NULL,                -- TRIP/YYMM-NNN
  warehouse TEXT NOT NULL,
  trip_date TEXT NOT NULL,
  lorry_id INTEGER,
  driver_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'assigned'
    CHECK(status IN ('assigned','started','in_progress','completed','cancelled')),
  trip_type TEXT NOT NULL DEFAULT 'delivery'
    CHECK(trip_type IN ('delivery','setup','dismantle','sg','mixed')),
  is_outsourced INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual'        -- manual | proposal
    CHECK(source IN ('manual','proposal')),
  proposal_id INTEGER,
  started_at TEXT,
  completed_at TEXT,
  start_odometer REAL,
  end_odometer REAL,
  fuel_litres REAL,
  fuel_cost REAL,
  total_revenue REAL DEFAULT 0,
  total_distance_km REAL DEFAULT 0,
  stop_count INTEGER DEFAULT 0,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (warehouse) REFERENCES warehouses(code),
  FOREIGN KEY (lorry_id) REFERENCES lorries(id),
  FOREIGN KEY (driver_user_id) REFERENCES users(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_trips_date ON trips(trip_date);
CREATE INDEX IF NOT EXISTS idx_trips_driver ON trips(driver_user_id);
CREATE INDEX IF NOT EXISTS idx_trips_warehouse ON trips(warehouse);
CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);

-- ── Trip stops ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trip_stops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL,
  doc_no TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  stop_type TEXT NOT NULL DEFAULT 'delivery'
    CHECK(stop_type IN ('delivery','service','pickup','setup','dismantle')),
  dismantle_session TEXT                       -- morning|night, set at scheduling
    CHECK(dismantle_session IS NULL OR dismantle_session IN ('morning','night')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','arrived','delivered','failed')),
  arrived_at TEXT,
  completed_at TEXT,
  recipient_name TEXT,
  signature_r2_key TEXT,
  pod_photo_r2_key TEXT,
  failure_reason TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(trip_id, doc_no),
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trip_stops_trip ON trip_stops(trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_stops_doc ON trip_stops(doc_no);

-- ── Trip GPS pings (append-only) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS trip_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy REAL,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trip_locations_trip ON trip_locations(trip_id, recorded_at);

-- ── Planner proposals ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trip_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT NOT NULL,
  generated_by INTEGER,
  horizon_days INTEGER NOT NULL DEFAULT 7,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','confirmed','discarded')),
  summary_json TEXT,                           -- aggregate metrics
  notes TEXT,
  FOREIGN KEY (generated_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS trip_proposal_trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL,
  warehouse TEXT NOT NULL,
  trip_date TEXT NOT NULL,
  suggested_lorry_id INTEGER,
  suggested_driver_user_id INTEGER,
  trip_type TEXT NOT NULL DEFAULT 'delivery',
  total_revenue REAL DEFAULT 0,
  total_distance_km REAL DEFAULT 0,
  stop_count INTEGER DEFAULT 0,
  is_outsourced INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,                  -- ordered doc_nos + reasoning
  FOREIGN KEY (proposal_id) REFERENCES trip_proposals(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_proposal_trips_proposal ON trip_proposal_trips(proposal_id);

-- ── Trip number counter (per YYMM) ──────────────────────────────────
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('trip_no_counter', '{}');
