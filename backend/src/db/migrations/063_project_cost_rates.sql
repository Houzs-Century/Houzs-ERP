-- 063_project_cost_rates.sql
--
-- Per-brand cost-rate engine. Three derived costs land on every
-- project automatically based on its brand and sales:
--
--   transport_pct       — % of sales (default 4)
--   merchandise_pct     — % of sales (default 2)
--   commission_pct      — % of sales, with a brand-specific tier
--
-- Commission tier rule: commission_normal_pct applies unless BOTH
-- gp_pct ≥ boost_min_gp_pct AND sales ≥ boost_min_sales (NULL means
-- "no minimum" — that gate is skipped). When both gates pass, the
-- boost rate replaces the normal rate.
--
-- The recompute service in services/projectCostRates.ts inserts /
-- updates / removes 3 rows per project tagged with auto_source
-- ('auto:transport' | 'auto:merchandise' | 'auto:commission'). The
-- new auto_source column on project_finance_lines is the marker the
-- UI uses to lock those rows from manual edit / delete.

CREATE TABLE IF NOT EXISTS project_cost_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL UNIQUE,
  transport_pct REAL NOT NULL DEFAULT 0,
  merchandise_pct REAL NOT NULL DEFAULT 0,
  commission_normal_pct REAL NOT NULL DEFAULT 0,
  commission_boost_pct REAL,
  boost_min_gp_pct REAL,         -- NULL = no GP gate; just sales
  boost_min_sales REAL,          -- NULL = no sales gate; just GP
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by INTEGER
);

ALTER TABLE project_finance_lines ADD COLUMN auto_source TEXT;
CREATE INDEX IF NOT EXISTS idx_pfl_auto_source
  ON project_finance_lines(project_id, auto_source);

-- MYLATEX gets seeded into the brand picker so it shows up in the
-- new-project form. Other brands are unchanged.
INSERT OR IGNORE INTO project_brands (name, color, sort_order, active)
VALUES ('MYLATEX', '64748b', 30, 1);

-- Seed the rate cards the team gave on 2026-05.
--   AKEMI / MYLATEX / ERGOTEX: 14 → 17 when GP ≥ 57% AND sales ≥ 130k
--   DUNLOPILLO:                13 → 15 when GP ≥ 55%
--   ZANOTTI:                   13 → 15 when GP ≥ 56%
--   MY SOFA FACTORY / AKEMI C&C: 13 normal, no boost defined yet
INSERT OR REPLACE INTO project_cost_rates
  (brand, transport_pct, merchandise_pct, commission_normal_pct,
   commission_boost_pct, boost_min_gp_pct, boost_min_sales)
VALUES
  ('AKEMI',           4, 2, 14, 17, 57, 130000),
  ('MYLATEX',         4, 2, 14, 17, 57, 130000),
  ('ERGOTEX',         4, 2, 14, 17, 57, 130000),
  ('DUNLOPILLO',      4, 2, 13, 15, 55, NULL),
  ('ZANOTTI',         4, 2, 13, 15, 56, NULL),
  ('MY SOFA FACTORY', 4, 2, 13, NULL, NULL, NULL),
  ('AKEMI C&C',       4, 2, 13, NULL, NULL, NULL);
