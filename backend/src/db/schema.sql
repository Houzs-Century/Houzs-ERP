DROP TABLE IF EXISTS sales_orders;
CREATE TABLE sales_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT UNIQUE NOT NULL,
  region TEXT NOT NULL CHECK(region IN ('WEST','EAST','SG')),
  transfer_to TEXT,
  doc_date TEXT,
  ref TEXT,
  branding TEXT,
  debtor_name TEXT,
  phone TEXT,
  sales_location TEXT,
  sales_agent TEXT,
  local_total REAL DEFAULT 0,
  balance REAL DEFAULT 0,
  remark2 TEXT,
  remark3 TEXT,
  remark4 TEXT,
  -- AutoCount's own SO.UDF_PDate, mirrored verbatim by services/pull.ts. NOT the
  -- ERP's Processing Date (that is scm.mfg_sales_orders.internal_expected_dd —
  -- one column, different table, different document). Renamed from
  -- `processing_date` alongside mig 0285, which renames it on Postgres; this
  -- baseline is what the D1 test tree is built from, so the two must agree.
  ac_udf_pdate TEXT,
  expiry_date TEXT,
  note TEXT,
  po_doc_no TEXT,
  inv_addr1 TEXT,
  inv_addr2 TEXT,
  inv_addr3 TEXT,
  inv_addr4 TEXT,
  venue TEXT,
  attention TEXT,
  sync_status TEXT DEFAULT 'SYNCED' CHECK(sync_status IN ('SYNCED','ERROR')),
  sync_error TEXT,
  last_modified TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════
-- All editable fields (manual + transporter)
-- One row per order. Covers all regions.
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS order_details;
CREATE TABLE order_details (
  doc_no TEXT PRIMARY KEY,
  -- Delivery logistics (all regions)
  delivery_date TEXT,
  time_range TEXT,
  time_confirmed TEXT,
  lorry_plate TEXT,
  driver_name TEXT,
  driver_contact TEXT,
  days_left TEXT,
  internal_purchasing TEXT,
  -- West/SG specific
  property_type TEXT,
  new_house_replacement TEXT,
  -- East specific
  item_details TEXT,
  done_delivery TEXT,
  consignment_no TEXT,
  -- East: transporter fields
  eta_port TEXT,
  estimate_delivery TEXT,
  m3 TEXT,
  vessel_voyage TEXT,
  etd_port_klang TEXT,
  eta_destination TEXT,
  transporter_remarks TEXT,
  -- East: financials
  seafreight REAL,
  local_charges REAL,
  inland REAL,
  agent_fee REAL,
  insurance REAL,
  total_cost REAL,
  -- SG specific
  shipout_date TEXT,
  -- Trip / planner additions (Phase 1)
  order_type TEXT,
  state TEXT,
  warehouse TEXT,
  proposed_delivery_date TEXT,
  lat REAL,
  lng REAL,
  geocoded_at TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (doc_no) REFERENCES sales_orders(doc_no)
);

CREATE INDEX idx_od_warehouse ON order_details(warehouse);
CREATE INDEX idx_od_state ON order_details(state);
CREATE INDEX idx_od_proposed_date ON order_details(proposed_delivery_date);

-- ═══════════════════════════════════════
-- Outstanding PO line items
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS purchase_orders;
CREATE TABLE purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL,
  so_doc_no TEXT,
  creditor_code TEXT,
  creditor_name TEXT,
  item_code TEXT NOT NULL,
  item_description TEXT,
  location TEXT,
  doc_date TEXT,
  remaining_qty REAL,
  delivery_date TEXT,
  supplier_date1 TEXT,
  supplier_date2 TEXT,
  supplier_date3 TEXT,
  overdue_days TEXT,       -- manual, never overwritten by pull
  UNIQUE(doc_no, item_code)
);

-- ═══════════════════════════════════════
-- ASSR cases
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS assr_cases;
CREATE TABLE assr_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_no TEXT UNIQUE NOT NULL,  -- ASSR/YYMM-NNN
  status TEXT DEFAULT 'Open',
  doc_no TEXT NOT NULL,
  complained_date TEXT,
  customer_name TEXT,
  phone TEXT,
  location TEXT,
  sales_agent TEXT,
  item_code TEXT,
  complaint_issue TEXT,
  action_remark TEXT,
  service_category TEXT,
  supplier TEXT,
  completion_date TEXT,
  po_no TEXT,
  addr1 TEXT,
  addr2 TEXT,
  addr3 TEXT,
  addr4 TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════
-- Overdue history (append-only audit log)
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS overdue_history;
CREATE TABLE overdue_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pull_date TEXT NOT NULL,
  doc_no TEXT NOT NULL,
  debtor_name TEXT,
  phone TEXT,
  location TEXT,
  balance REAL,
  original_expiry_date TEXT,
  extended_to TEXT
);

-- ═══════════════════════════════════════
-- Execution logs
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS execution_logs;
CREATE TABLE execution_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('SYNCED','FAILED','SKIPPED')),
  message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════
-- System settings (key-value)
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS system_settings;
CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO system_settings VALUES ('pull_checkpoint', '2000-01-01 00:00:00');

-- ═══════════════════════════════════════
-- User-defined fields (per-table custom columns)
-- Local only — never synced back to AutoCount.
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS udf_fields;
CREATE TABLE udf_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,        -- 'sales_orders', 'delivery_orders', 'purchase_orders', 'assr', 'overdue', 'logs', 'balance'
  field_key TEXT NOT NULL,          -- snake_case identifier
  label TEXT NOT NULL,              -- display name
  field_type TEXT NOT NULL DEFAULT 'text' CHECK(field_type IN ('text','number','date','select','checkbox')),
  options TEXT,                     -- JSON array of strings for select type
  position INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(table_name, field_key)
);

-- ═══════════════════════════════════════
-- Roles & permissions
-- Permissions are stored as a JSON string array of permission keys
-- (e.g. ["sales_orders.read","users.manage"]). Special key "*" = all.
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS roles;
CREATE TABLE roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  permissions TEXT NOT NULL DEFAULT '[]',
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO roles (name, description, permissions, is_system) VALUES
  ('Owner', 'Full access to everything, including team and roles', '["*"]', 1),
  ('Member', 'Read-only access to operational data', '["sales_orders.read","delivery_orders.read","purchase_orders.read","service_cases.read","balance.read","overdue.read","logs.read","fleet.read"]', 1),
  ('Dispatcher', 'Trip planning, fleet management, and delivery tracking', '["sales_orders.read","sales_orders.write","delivery_orders.read","delivery_orders.write","purchase_orders.read","service_cases.read","balance.read","overdue.read","logs.read","trips.read.all","trips.write","trips.manage","planner.run","fleet.read","fleet.manage","sync.run"]', 1),
  ('Driver', 'Driver mobile app — own trips, clock, inspection, salary', '["trips.read.own","trips.write","fleet.salary"]', 1),
  ('Helper', 'Helper mobile app — clock and salary view', '["trips.read.own","fleet.salary"]', 1);

-- ═══════════════════════════════════════
-- Users
-- Status: invited (no password yet) → active → disabled
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS users;
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT,
  role_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited' CHECK(status IN ('invited','active','disabled')),
  invited_by INTEGER,
  invited_at TEXT,
  joined_at TEXT,
  last_login_at TEXT,
  last_seen_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (role_id) REFERENCES roles(id)
);

CREATE INDEX idx_users_role ON users(role_id);
CREATE INDEX idx_users_last_seen ON users(last_seen_at);
CREATE INDEX idx_users_status ON users(status);

-- ═══════════════════════════════════════
-- Invitations — pending users
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS invitations;
CREATE TABLE invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  role_id INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL,
  invited_by INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (role_id) REFERENCES roles(id),
  FOREIGN KEY (invited_by) REFERENCES users(id)
);

CREATE INDEX idx_invitations_token ON invitations(token);
CREATE INDEX idx_invitations_email ON invitations(email);

-- ═══════════════════════════════════════
-- Sessions — bearer tokens, server-side stored
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS sessions;
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

DROP TABLE IF EXISTS udf_values;
CREATE TABLE udf_values (
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,            -- whatever the table's getRowKey returns (doc_no, assr_no, etc.)
  field_key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (table_name, row_key, field_key)
);

CREATE INDEX idx_udf_values_table ON udf_values(table_name);
CREATE INDEX idx_udf_fields_table ON udf_fields(table_name);

-- ═══════════════════════════════════════
-- Indexes
-- ═══════════════════════════════════════
CREATE INDEX idx_so_region ON sales_orders(region);
CREATE INDEX idx_so_sync ON sales_orders(sync_status);
CREATE INDEX idx_so_balance ON sales_orders(balance);
CREATE INDEX idx_po_doc ON purchase_orders(doc_no);
CREATE INDEX idx_assr_status ON assr_cases(status);
CREATE INDEX idx_overdue_date ON overdue_history(pull_date);

-- ═══════════════════════════════════════
-- Trips, lorries, warehouses, planner proposals (Phase 1)
-- All delivery-domain. Local only — never pushed to AutoCount.
-- ═══════════════════════════════════════

DROP TABLE IF EXISTS warehouses;
CREATE TABLE warehouses (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  lat REAL,
  lng REAL,
  is_active INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO warehouses (code, name, address, lat, lng, is_active) VALUES
  ('KL',         'KL Warehouse',                       'Semenyih, Selangor',     3.0264, 101.7340, 1),
  ('PG',         'PG Warehouse',                       'Simpang Ampat, Penang',  5.3007, 100.4273, 1),
  ('SBH',        'Sabah Warehouse',                    'Putatan, Sabah',         5.8784, 116.0103, 1),
  ('SRW',        'Sarawak Warehouse',                  'Kuching, Sarawak',       1.5806, 110.3762, 1),
  ('PORT_KLANG', 'Port Klang (East Malaysia transit)', 'Port Klang, Selangor',   3.0042, 101.3933, 1),
  ('SG',         'SG / JB Outsource Hub',              'Johor Bahru',            1.4927, 103.7414, 1);

DROP TABLE IF EXISTS state_warehouse_map;
CREATE TABLE state_warehouse_map (
  state TEXT PRIMARY KEY,
  warehouse TEXT NOT NULL,
  FOREIGN KEY (warehouse) REFERENCES warehouses(code)
);

-- KL covers central + south. PG covers north + east coast.
-- EM/SG ship from KL to transit points regardless of state.
INSERT OR IGNORE INTO state_warehouse_map (state, warehouse) VALUES
  -- KL warehouse
  ('Kuala Lumpur',    'KL'),
  ('Selangor',        'KL'),
  ('Putrajaya',       'KL'),
  ('Negeri Sembilan', 'KL'),
  ('Melaka',          'KL'),
  ('Johor',           'KL'),
  -- PG warehouse
  ('Penang',          'PG'),
  ('Pulau Pinang',    'PG'),
  ('Kedah',           'PG'),
  ('Perlis',          'PG'),
  ('Perak',           'PG'),
  ('Pahang',          'PG'),
  ('Terengganu',      'PG'),
  ('Kelantan',        'PG'),
  -- EM (local warehouse for last-mile delivery)
  ('Sabah',           'SBH'),
  ('Labuan',          'SBH'),
  ('Sarawak',         'SRW'),
  ('Singapore',       'KL');

DROP TABLE IF EXISTS lorries;
CREATE TABLE lorries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plate TEXT UNIQUE NOT NULL,
  size TEXT,
  warehouse TEXT NOT NULL,
  is_internal INTEGER NOT NULL DEFAULT 1,
  default_driver_user_id INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (warehouse) REFERENCES warehouses(code),
  FOREIGN KEY (default_driver_user_id) REFERENCES users(id)
);

CREATE INDEX idx_lorries_warehouse ON lorries(warehouse);

-- All internal lorries operate from KL while we run a single origin.
-- Outsourced PG lorries stay flagged for the PG warehouse so they're
-- only used when the dispatcher explicitly assigns them.
INSERT OR IGNORE INTO lorries (plate, size, warehouse, is_internal) VALUES
  ('KL-21A',     '21ft', 'KL', 1),
  ('KL-21B',     '21ft', 'KL', 1),
  ('KL-17A',     '17ft', 'KL', 1),
  ('PG-17A',     '17ft', 'KL', 1),
  ('PG-17B',     '17ft', 'KL', 1),
  ('W 1591 T',   '17ft', 'PG', 0),
  ('MCF 3084',   '17ft', 'PG', 0);

DROP TABLE IF EXISTS trips;
CREATE TABLE trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_no TEXT UNIQUE NOT NULL,
  warehouse TEXT NOT NULL,
  trip_date TEXT NOT NULL,
  lorry_id INTEGER,
  driver_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'assigned'
    CHECK(status IN ('assigned','started','in_progress','completed','cancelled')),
  trip_type TEXT NOT NULL DEFAULT 'delivery'
    CHECK(trip_type IN ('delivery','setup','dismantle','sg','mixed')),
  is_outsourced INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual'
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

CREATE INDEX idx_trips_date ON trips(trip_date);
CREATE INDEX idx_trips_driver ON trips(driver_user_id);
CREATE INDEX idx_trips_warehouse ON trips(warehouse);
CREATE INDEX idx_trips_status ON trips(status);

DROP TABLE IF EXISTS trip_stops;
CREATE TABLE trip_stops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL,
  doc_no TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  stop_type TEXT NOT NULL DEFAULT 'delivery'
    CHECK(stop_type IN ('delivery','service','pickup','setup','dismantle')),
  dismantle_session TEXT
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

CREATE INDEX idx_trip_stops_trip ON trip_stops(trip_id);
CREATE INDEX idx_trip_stops_doc ON trip_stops(doc_no);

DROP TABLE IF EXISTS trip_locations;
CREATE TABLE trip_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy REAL,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

CREATE INDEX idx_trip_locations_trip ON trip_locations(trip_id, recorded_at);

DROP TABLE IF EXISTS trip_proposals;
CREATE TABLE trip_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT NOT NULL,
  generated_by INTEGER,
  horizon_days INTEGER NOT NULL DEFAULT 7,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','confirmed','discarded')),
  summary_json TEXT,
  notes TEXT,
  FOREIGN KEY (generated_by) REFERENCES users(id)
);

DROP TABLE IF EXISTS trip_proposal_trips;
CREATE TABLE trip_proposal_trips (
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
  payload_json TEXT NOT NULL,
  FOREIGN KEY (proposal_id) REFERENCES trip_proposals(id) ON DELETE CASCADE
);

CREATE INDEX idx_proposal_trips_proposal ON trip_proposal_trips(proposal_id);

INSERT OR IGNORE INTO system_settings (key, value) VALUES ('trip_no_counter', '{}');

-- ═══════════════════════════════════════
-- Events — manual setup / dismantle calendar entries.
-- Not tied to sales orders; created by the dispatcher.
-- Status is intentionally free-form until the lifecycle is finalized.
-- ═══════════════════════════════════════
DROP TABLE IF EXISTS events;
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('setup','dismantle')),
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,
  address TEXT,
  status TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_events_date ON events(event_date);
CREATE INDEX idx_events_type ON events(type);
