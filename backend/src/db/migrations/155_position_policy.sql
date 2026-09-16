-- 155_position_policy — D1 test mirror of migrations-pg/20260916T1600.
-- Per-Title policy row keyed by position_id (cohort / profile / flags). See
-- the PG migration for the rationale. Seeds are one INSERT per slug: the
-- replay harness runs under D1's compound-SELECT limit.

CREATE TABLE IF NOT EXISTS position_policy (
  position_id      INTEGER PRIMARY KEY REFERENCES positions(id) ON DELETE CASCADE,
  cohort           TEXT    NOT NULL CHECK (cohort IN ('god', 'full', 'restricted', 'sales')),
  profile          TEXT    NULL CHECK (profile IS NULL OR profile IN (
                     'driver_helper', 'storekeeper', 'storekeeper_supervisor', 'calendar_viewer',
                     'director', 'rep')),
  can_move_money   INTEGER NOT NULL DEFAULT 0 CHECK (can_move_money IN (0, 1)),
  can_write_config INTEGER NOT NULL DEFAULT 0 CHECK (can_write_config IN (0, 1)),
  is_fleet         INTEGER NOT NULL DEFAULT 0 CHECK (is_fleet IN (0, 1)),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_by       INTEGER
);

INSERT OR IGNORE INTO position_policy (position_id, cohort, profile, can_move_money, can_write_config, is_fleet)
SELECT id, 'god', NULL, 1, 1, 0 FROM positions WHERE slug IN ('super_admin', 'owner', 'managing_director');

INSERT OR IGNORE INTO position_policy (position_id, cohort, profile, can_move_money, can_write_config, is_fleet)
SELECT id, 'full', NULL, 0, 0, 0 FROM positions WHERE slug IN ('hr_manager', 'it_developer_executive', 'service_admin', 'pg_wh_assistant');

INSERT OR IGNORE INTO position_policy (position_id, cohort, profile, can_move_money, can_write_config, is_fleet)
SELECT id, 'full', NULL, 1, 0, 0 FROM positions WHERE slug IN ('finance_manager');

INSERT OR IGNORE INTO position_policy (position_id, cohort, profile, can_move_money, can_write_config, is_fleet)
SELECT id, 'full', NULL, 0, 1, 0 FROM positions WHERE slug IN ('ops_director', 'ops_executive', 'purchasing', 'logistic');

INSERT OR IGNORE INTO position_policy (position_id, cohort, profile, can_move_money, can_write_config, is_fleet)
SELECT id, 'sales', 'director', 0, 0, 0 FROM positions WHERE slug IN ('sales_director');

INSERT OR IGNORE INTO position_policy (position_id, cohort, profile, can_move_money, can_write_config, is_fleet)
SELECT id, 'sales', 'rep', 0, 0, 0 FROM positions WHERE slug IN ('sales_manager', 'sales_executive', 'sales_person');

INSERT OR IGNORE INTO position_policy (position_id, cohort, profile, can_move_money, can_write_config, is_fleet)
SELECT id, 'restricted', 'storekeeper', 0, 0, 0 FROM positions WHERE slug IN ('storekeeper', 'warehouse_crew_kl');

INSERT OR IGNORE INTO position_policy (position_id, cohort, profile, can_move_money, can_write_config, is_fleet)
SELECT id, 'restricted', 'storekeeper_supervisor', 0, 0, 0 FROM positions WHERE slug IN ('storekeeper_supervisor');

INSERT OR IGNORE INTO position_policy (position_id, cohort, profile, can_move_money, can_write_config, is_fleet)
SELECT id, 'restricted', 'driver_helper', 0, 0, 1 FROM positions WHERE slug IN ('driver', 'helper');

INSERT OR IGNORE INTO position_policy (position_id, cohort, profile, can_move_money, can_write_config, is_fleet)
SELECT id, 'restricted', 'driver_helper', 0, 0, 0 FROM positions WHERE slug IN ('outsource_transporter');

INSERT OR IGNORE INTO position_policy (position_id, cohort, profile, can_move_money, can_write_config, is_fleet)
SELECT id, 'restricted', 'calendar_viewer', 0, 0, 0 FROM positions WHERE slug IN ('calendar-viewer');
