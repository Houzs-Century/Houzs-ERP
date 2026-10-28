-- ═══════════════════════════════════════
-- Migration 004 — Region simplification + Events table
--
-- The dispatcher confirmed the operation runs from a single origin
-- warehouse (KL) for now. Trips fan out by destination region:
--
--   WEST  → door-to-door multi-drop (existing logic)
--   EAST  → bundle to Port Klang, sea freight handles last mile
--   SG    → bundle to Johor hub (existing)
--
-- The state_warehouse_map is rewritten so geocoding always lands at
-- KL. The PG / EAST / SABAH / SARAWAK warehouse rows stay in the table
-- but are deactivated, so the dropdowns and existing trip references
-- keep working. A new "PORT_KLANG" row is added as the EAST drop point.
--
-- An `events` table is added for setup / dismantle calendar entries.
-- These are not tied to sales orders and are free-form (title, date,
-- address, status text, notes). Status validation is intentionally
-- absent until the dispatcher finalizes the lifecycle.
-- ═══════════════════════════════════════

-- ── All warehouses active (KL, PG, SBH, SRW, SG) ────────────────

-- ── Add Port Klang as the EAST transit drop ───────────────────────
INSERT OR IGNORE INTO warehouses (code, name, address, lat, lng, is_active) VALUES
  ('PORT_KLANG', 'Port Klang (East Malaysia transit)', 'Port Klang, Selangor', 3.0042, 101.3933, 1);

-- ── Rewrite state map: KL covers south/central, PG covers north/east coast
DELETE FROM state_warehouse_map;
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
  -- SG
  ('Singapore',       'KL');

-- ── Events (setup / dismantle calendar) ───────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('setup','dismantle')),
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,           -- YYYY-MM-DD
  address TEXT,
  status TEXT,                         -- free text for now (lifecycle TBD)
  notes TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
