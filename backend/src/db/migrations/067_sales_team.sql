-- 067_sales_team.sql
--
-- Sales Team module — retail rep org chart, separate from the
-- workspace `users` directory. A workspace user may or may not be a
-- sales rep, and a sales rep may or may not have a workspace login.
-- The optional `sales_reps.user_id` link covers the overlap; most
-- reps will have it as NULL.
--
-- Tables:
--   sales_positions          — Director / Executive / Sub-Executive
--   sales_commission_tiers   — named rate cards (Standard 5%, etc.)
--   sales_reps               — the rep roster
--   sales_rep_brands         — junction (rep × brand)
--   sales_team_activity      — audit log (mirrors project_activity)
--
-- Plus an additive column on sales_entries:
--   sales_rep_id INTEGER     — new typed reference; legacy
--                              sales_person_id stays for old data.

CREATE TABLE IF NOT EXISTS sales_positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL,
  level       INTEGER NOT NULL DEFAULT 20,    -- 10=Director, 20=Executive, 30=Sub
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_positions_active ON sales_positions(active);

CREATE TABLE IF NOT EXISTS sales_commission_tiers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL,
  rate        REAL NOT NULL DEFAULT 0,        -- percent
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_tiers_active ON sales_commission_tiers(active);

CREATE TABLE IF NOT EXISTS sales_reps (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  code                TEXT NOT NULL UNIQUE,    -- "SR-001" via nextSalesRepCode
  name                TEXT NOT NULL,
  phone               TEXT,
  email               TEXT,                     -- not unique; reps without logins may share / be missing
  position_id         INTEGER REFERENCES sales_positions(id) ON DELETE SET NULL,
  upline_id           INTEGER REFERENCES sales_reps(id) ON DELETE SET NULL,
  -- Optional 1:1 link to a workspace user. Some reps have a login,
  -- most don't. UNIQUE so a workspace user can be at most one rep.
  user_id             INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','inactive')),
  is_admin            INTEGER NOT NULL DEFAULT 0,
  commission_rate     REAL,                     -- per-rep override (% as 5.0 = 5%)
  commission_tier_id  INTEGER REFERENCES sales_commission_tiers(id) ON DELETE SET NULL,
  joined_on           TEXT,                     -- ISO date
  notes               TEXT,
  created_at          TEXT DEFAULT (datetime('now')),
  updated_at          TEXT DEFAULT (datetime('now')),
  archived_at         TEXT,
  archived_by         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sales_reps_status   ON sales_reps(status);
CREATE INDEX IF NOT EXISTS idx_sales_reps_position ON sales_reps(position_id);
CREATE INDEX IF NOT EXISTS idx_sales_reps_upline   ON sales_reps(upline_id);
CREATE INDEX IF NOT EXISTS idx_sales_reps_user     ON sales_reps(user_id);
CREATE INDEX IF NOT EXISTS idx_sales_reps_archived ON sales_reps(archived_at);

CREATE TABLE IF NOT EXISTS sales_rep_brands (
  rep_id      INTEGER NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  brand       TEXT NOT NULL,                   -- FK by name to project_brands.name
  PRIMARY KEY (rep_id, brand)
);
CREATE INDEX IF NOT EXISTS idx_sales_rep_brands_brand ON sales_rep_brands(brand);

-- Audit log mirrors project_activity / assr_activity row shape.
CREATE TABLE IF NOT EXISTS sales_team_activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rep_id      INTEGER NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,                   -- 'created' | 'position_change' | 'upline_change' | 'brand_change' | 'admin_toggle' | 'note' | 'status_change' | 'deleted'
  from_value  TEXT,
  to_value    TEXT,
  note        TEXT,
  user_id     INTEGER,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_team_activity_rep ON sales_team_activity(rep_id, created_at);

-- Additive column on sales_entries — new typed reference. Legacy
-- sales_person_id stays for backward-compat display of old rows.
ALTER TABLE sales_entries ADD COLUMN sales_rep_id INTEGER
  REFERENCES sales_reps(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sales_entries_rep ON sales_entries(sales_rep_id);

-- ── Seed positions ───────────────────────────────────────────
INSERT OR IGNORE INTO sales_positions (slug, name, level, sort_order) VALUES
  ('director',     'Sales Director',   10, 10),
  ('executive',    'Sales Executive',  20, 20),
  ('sub_executive','Sub-Executive',    30, 30);

-- ── Seed one commission tier ─────────────────────────────────
INSERT OR IGNORE INTO sales_commission_tiers (slug, name, rate) VALUES
  ('standard_5', 'Standard 5%', 5.0);

-- ── Seed 12 demo reps + brand assignments ────────────────────
-- Placeholder data spanning all positions + brands. Boss can replace
-- any of these via the register flow; SR-011 is seeded as inactive
-- so the status filter exercises both states.
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-001', 'Lim Wei Jian',     '+60123456001', 'lim.weijian@example.my',
         (SELECT id FROM sales_positions WHERE slug='director'), NULL, 'active',   1, 8.0, '2024-01-15';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-002', 'Tan Mei Ling',     '+60123456002', 'tan.meiling@example.my',
         (SELECT id FROM sales_positions WHERE slug='director'), NULL, 'active',   1, 8.0, '2024-02-01';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-003', 'Aaron Goh',        '+60123456003', 'aaron.goh@example.my',
         (SELECT id FROM sales_positions WHERE slug='executive'),
         (SELECT id FROM sales_reps      WHERE code='SR-001'), 'active', 0, 6.0, '2024-03-12';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-004', 'Priya Raj',        '+60123456004', 'priya.raj@example.my',
         (SELECT id FROM sales_positions WHERE slug='executive'),
         (SELECT id FROM sales_reps      WHERE code='SR-001'), 'active', 0, 6.0, '2024-04-20';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-005', 'Faiz Hashim',      '+60123456005', 'faiz.hashim@example.my',
         (SELECT id FROM sales_positions WHERE slug='executive'),
         (SELECT id FROM sales_reps      WHERE code='SR-002'), 'active', 0, 6.0, '2024-05-05';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-006', 'Lee Hong Wei',     '+60123456006', 'lee.hongwei@example.my',
         (SELECT id FROM sales_positions WHERE slug='sub_executive'),
         (SELECT id FROM sales_reps      WHERE code='SR-003'), 'active', 0, 5.0, '2024-06-18';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-007', 'Nadia Salleh',     '+60123456007', 'nadia.salleh@example.my',
         (SELECT id FROM sales_positions WHERE slug='sub_executive'),
         (SELECT id FROM sales_reps      WHERE code='SR-004'), 'active', 0, 5.0, '2024-07-10';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-008', 'Chong Hui Ying',   '+60123456008', 'chong.huiying@example.my',
         (SELECT id FROM sales_positions WHERE slug='sub_executive'),
         (SELECT id FROM sales_reps      WHERE code='SR-005'), 'active', 0, 5.0, '2024-08-22';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-009', 'Vincent Tan',      '+60123456009', 'vincent.tan@example.my',
         (SELECT id FROM sales_positions WHERE slug='executive'),
         (SELECT id FROM sales_reps      WHERE code='SR-001'), 'active', 0, 6.0, '2024-09-03';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-010', 'Sarah Lim',        '+60123456010', 'sarah.lim@example.my',
         (SELECT id FROM sales_positions WHERE slug='sub_executive'),
         (SELECT id FROM sales_reps      WHERE code='SR-002'), 'active', 0, 5.0, '2024-10-14';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-011', 'Daniel Wong',      '+60123456011', 'daniel.wong@example.my',
         (SELECT id FROM sales_positions WHERE slug='sub_executive'),
         (SELECT id FROM sales_reps      WHERE code='SR-003'), 'inactive', 0, 5.0, '2024-11-02';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-012', 'Amir Bin Yusof',   '+60123456012', 'amir.yusof@example.my',
         (SELECT id FROM sales_positions WHERE slug='sub_executive'),
         (SELECT id FROM sales_reps      WHERE code='SR-005'), 'active', 0, 5.0, '2024-12-08';

-- Brand assignments per the plan's seed shape.
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'AKEMI'           FROM sales_reps WHERE code='SR-001';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'ZANOTTI'         FROM sales_reps WHERE code='SR-001';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'DUNLOPILLO'      FROM sales_reps WHERE code='SR-002';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'MY SOFA FACTORY' FROM sales_reps WHERE code='SR-002';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'AKEMI'           FROM sales_reps WHERE code='SR-003';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'ZANOTTI'         FROM sales_reps WHERE code='SR-004';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'ERGOTEX'         FROM sales_reps WHERE code='SR-005';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'AKEMI'           FROM sales_reps WHERE code='SR-006';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'ZANOTTI'         FROM sales_reps WHERE code='SR-007';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'DUNLOPILLO'      FROM sales_reps WHERE code='SR-008';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'AKEMI'           FROM sales_reps WHERE code='SR-009';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'ZANOTTI'         FROM sales_reps WHERE code='SR-009';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'MY SOFA FACTORY' FROM sales_reps WHERE code='SR-010';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'AKEMI C&C'       FROM sales_reps WHERE code='SR-011';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'ERGOTEX'         FROM sales_reps WHERE code='SR-012';

-- Audit row for the seed so the UI shows a "created" entry on each.
INSERT INTO sales_team_activity (rep_id, action, to_value, note, user_id)
  SELECT id, 'created', code, 'Seeded by mig 067', NULL FROM sales_reps;
