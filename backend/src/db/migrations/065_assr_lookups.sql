-- 065_assr_lookups.sql
--
-- Per the boss: every dropdown in the QMS module should be admin-
-- editable from Service Maintenance, not hardcoded in the SPA. Four
-- new lookup tables, each modelled on project_organizers / venues:
--   slug   — stable machine value, what the case row stores
--   name   — display label
--   active — soft-delete; existing cases keep their value
--
-- Tables (with seed data from the previously-hardcoded constants in
-- frontend/src/pages/ServiceCases.tsx):
--   assr_issue_categories     — was free text on assr_cases.issue_category
--   assr_resolution_methods   — was the 5-value hardcoded list
--   assr_priorities           — was low/normal/high/urgent
--   assr_ncr_categories       — was the 7-value NCR list

CREATE TABLE IF NOT EXISTS assr_issue_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assr_issue_cat_active ON assr_issue_categories(active);

CREATE TABLE IF NOT EXISTS assr_resolution_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assr_resolution_active ON assr_resolution_methods(active);

CREATE TABLE IF NOT EXISTS assr_priorities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  sla_hours INTEGER,                          -- optional override of slaHoursFor()
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assr_priorities_active ON assr_priorities(active);

CREATE TABLE IF NOT EXISTS assr_ncr_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assr_ncr_active ON assr_ncr_categories(active);

-- ── Seed: resolution methods ───────────────────────────────────
INSERT OR IGNORE INTO assr_resolution_methods (slug, name, sort_order) VALUES
  ('replace_unit',           'Replace unit',                10),
  ('supplier_repair',        'Send to supplier for repair', 20),
  ('field_service_own',      'On-site service (in-house)',  30),
  ('field_service_supplier', 'On-site service (supplier)',  40),
  ('return_visit',           'Customer return visit',       50);

-- ── Seed: priorities (with default SLA windows) ────────────────
-- These mirror the values in slaHoursFor(); editing here doesn't
-- recompute existing deadlines, only new cases pick up the change.
INSERT OR IGNORE INTO assr_priorities (slug, name, sort_order, sla_hours) VALUES
  ('low',     'Low',     10, 336),
  ('normal',  'Normal',  20, 168),
  ('high',    'High',    30, 72),
  ('urgent',  'Urgent',  40, 24);

-- ── Seed: NCR categories ───────────────────────────────────────
INSERT OR IGNORE INTO assr_ncr_categories (slug, name, sort_order) VALUES
  ('material_defect',  'Material defect',  10),
  ('workmanship',      'Workmanship',      20),
  ('transit_damage',   'Transit damage',   30),
  ('design',           'Design',           40),
  ('installation',     'Installation',     50),
  ('customer_misuse',  'Customer misuse',  60),
  ('other',            'Other',            70);

-- ── Seed: issue categories ─────────────────────────────────────
-- Distinct values currently observed on assr_cases.issue_category
-- get rolled in so the picker isn't empty on day one.
INSERT OR IGNORE INTO assr_issue_categories (slug, name, sort_order)
SELECT
  LOWER(REPLACE(REPLACE(TRIM(issue_category), ' ', '_'), '/', '_')) AS slug,
  TRIM(issue_category) AS name,
  10
  FROM assr_cases
 WHERE issue_category IS NOT NULL AND TRIM(issue_category) != ''
 GROUP BY LOWER(TRIM(issue_category));
